"""Filesystem-backed storage for the file explorer.

Every user-supplied path is run through :func:`Storage.resolve`, which rejects
traversal attempts and guarantees the returned absolute path stays inside the
storage root.  Keeping that single choke point is what makes the API safe.
"""

from __future__ import annotations

import hashlib
import mimetypes
import os
import re
import shutil
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from typing import Iterator

# Imported lazily inside functions where possible to avoid an import cycle with
# permissions (which imports storage's siblings, not storage itself), but the
# exception type is needed at call time in several places.
from permissions import AccessDenied

# Characters that are illegal in Windows filenames, plus control characters.
_ILLEGAL_NAME_CHARS = re.compile(r'[\x00-\x1f<>:"|?*]')

# Windows device names cannot be used as file or directory names.
_RESERVED_NAMES = {
    "con", "prn", "aux", "nul",
    *(f"com{i}" for i in range(1, 10)),
    *(f"lpt{i}" for i in range(1, 10)),
}

CHUNK_SIZE = 1024 * 1024  # 1 MiB streaming chunk


class StorageError(Exception):
    """Base class for storage failures that map to a 4xx response."""

    status_code = 400


class InvalidPath(StorageError):
    status_code = 400


class NotFound(StorageError):
    status_code = 404


class AlreadyExists(StorageError):
    status_code = 409


class InvalidName(StorageError):
    status_code = 400


@dataclass
class Item:
    """Serialisable description of a file or folder."""

    name: str
    path: str  # POSIX-style path relative to the storage root; "" is the root
    type: str  # "file" | "folder"
    parent_path: str
    size: int
    modified: int  # epoch milliseconds, for `new Date(...)` in the browser
    created: int
    mime: str | None = None
    is_media: bool = False
    writable: bool = False
    pin_protected: bool = False
    unlocked: bool = False
    has_pin: bool = False  # PIN exists but is not unlocked in this session

    def to_dict(self) -> dict:
        return asdict(self)


def _to_millis(timestamp: float) -> int:
    return int(timestamp * 1000)


def _is_storage_root(rel_path: str) -> bool:
    return rel_path == ""


def _require_ancestors(principal, rel_path: str) -> None:
    """Deny access when a *meaningful* intermediate directory is not readable.

    Container levels implied by the principal's own grant are skipped: a user
    granted ``users/alice`` is not required to be able to read ``users``. But a
    guest granted ``users/alice/diary`` still cannot read ``users/alice``,
    because that sits below the shallowest region they hold.
    """
    parts = rel_path.split("/")
    floor = principal.min_readable_depth
    for index in range(1, len(parts)):
        if index <= floor:
            continue
        ancestor = "/".join(parts[:index])
        if not principal.can_read(ancestor):
            raise AccessDenied("You do not have access to this location")


class Storage:
    """Reads and writes files beneath a single root directory."""

    def __init__(self, root: str):
        self.root = os.path.realpath(os.path.abspath(root))
        os.makedirs(self.root, exist_ok=True)

    # ------------------------------------------------------------------
    # Path handling
    # ------------------------------------------------------------------
    def resolve(
        self,
        rel_path: str | None,
        principal=None,
        *,
        mode: str = "read",
        must_exist: bool = True,
    ) -> str:
        """Map an API path onto an absolute path inside the storage root.

        ``principal`` is required for any real request; ``None`` is only for
        internal callers that have already authorised the path (startup checks,
        tests). Making it an explicit argument here means a new API route
        cannot forget to authorise: omitting it is a visible choice rather than
        a silent default.

        Raises :class:`InvalidPath` for anything that escapes the root,
        :class:`AccessDenied` when the principal lacks permission, and
        :class:`NotFound` when ``must_exist`` is set and the target is absent.
        """
        rel_path = (rel_path or "").strip()

        if "\x00" in rel_path:
            raise InvalidPath("Path contains a null byte")

        # Normalise Windows separators so callers may send either style.
        rel_path = rel_path.replace("\\", "/").strip("/")

        parts: list[str] = []
        for part in rel_path.split("/"):
            if part in ("", "."):
                continue
            if part == "..":
                raise InvalidPath("Path may not contain '..'")
            parts.append(part)

        if principal is not None:
            # Authorise on the normalised relative path, before touching the
            # filesystem, so an unauthorised probe cannot test existence.
            target_rel = "/".join(parts)
            if _is_storage_root(target_rel):
                # The root is a container, not content. Reading it is how a user
                # discovers their own space and the shared one. Writing is
                # allowed for account holders (so a welcome document can live
                # there and loose files can be tidied) but the decision is left
                # to the principal, whose writable regions say whether the root
                # is in scope. A guest holds no such region, so it is refused.
                if mode == "write":
                    principal.require_write(target_rel)
                elif principal.mode not in ("user", "admin"):
                    raise AccessDenied("You do not have access to this location")
            else:
                _require_ancestors(principal, target_rel)
                if mode == "write":
                    principal.require_write(target_rel)
                else:
                    principal.require_read(target_rel)

        candidate = os.path.join(self.root, *parts) if parts else self.root
        resolved = os.path.realpath(candidate)

        # Defence in depth: even after rejecting '..', confirm containment so
        # that symlinks pointing outside the root cannot be followed.
        if resolved != self.root and not self._is_inside(resolved):
            raise InvalidPath("Path escapes the storage root")

        if must_exist and not os.path.exists(resolved):
            raise NotFound(f"'{rel_path}' not found")

        return resolved

    def _is_inside(self, resolved: str) -> bool:
        try:
            return os.path.commonpath([self.root, resolved]) == self.root
        except ValueError:
            # Different drives on Windows.
            return False

    @staticmethod
    def validate_name(name: str) -> str:
        """Validate a single new file/folder name (not a path)."""
        name = (name or "").strip()
        if not name:
            raise InvalidName("Name cannot be empty")
        if name in (".", ".."):
            raise InvalidName("Invalid name")
        if len(name) > 255:
            raise InvalidName("Name is too long")
        if "/" in name or "\\" in name:
            raise InvalidName("Name may not contain slashes")
        if _ILLEGAL_NAME_CHARS.search(name):
            raise InvalidName("Name contains illegal characters")
        if name.split(".")[0].lower() in _RESERVED_NAMES:
            raise InvalidName("Name is reserved by the operating system")
        if name.endswith((" ", ".")):
            raise InvalidName("Name may not end with a space or period")
        return name

    def to_rel(self, abs_path: str) -> str:
        """Convert an absolute path back to the API's relative form."""
        if abs_path == self.root:
            return ""
        return os.path.relpath(abs_path, self.root).replace(os.sep, "/")

    # ------------------------------------------------------------------
    # Metadata
    # ------------------------------------------------------------------
    def describe(self, abs_path: str) -> Item:
        stat = os.stat(abs_path)
        is_dir = os.path.isdir(abs_path)
        rel = self.to_rel(abs_path)
        parent = os.path.dirname(rel)
        mime = None
        if not is_dir:
            mime = mimetypes.guess_type(abs_path)[0] or "application/octet-stream"

        return Item(
            name=os.path.basename(abs_path) or "Root",
            path=rel,
            type="folder" if is_dir else "file",
            parent_path=parent,
            size=0 if is_dir else stat.st_size,
            modified=_to_millis(stat.st_mtime),
            created=_to_millis(getattr(stat, "st_ctime", stat.st_mtime)),
            mime=mime,
            is_media=bool(mime and (mime.startswith("image/") or mime.startswith("video/") or mime.startswith("audio/"))),
        )

    def list_dir(self, rel_path: str | None, principal=None) -> list[Item]:
        abs_path = self.resolve(rel_path, principal)
        if not os.path.isdir(abs_path):
            raise InvalidPath("Not a folder")

        items: list[Item] = []
        with os.scandir(abs_path) as entries:
            for entry in entries:
                try:
                    item = self.describe(entry.path)
                except OSError:
                    # Broken symlink or a file removed mid-scan: skip it rather
                    # than failing the whole listing.
                    continue

                # Filter per entry rather than per directory: this is what
                # hides "users/" from a normal account while still allowing
                # "users/<self>" to be reached directly.
                if principal is not None and not principal.can_read(item.path):
                    continue

                items.append(item)

        items.sort(key=lambda i: (i.type != "folder", i.name.lower()))
        return items

    def stat(self, rel_path: str | None, principal=None) -> Item:
        return self.describe(self.resolve(rel_path, principal))

    # ------------------------------------------------------------------
    # Mutations
    # ------------------------------------------------------------------
    def create_folder(self, parent_rel: str | None, name: str, principal=None) -> Item:
        name = self.validate_name(name)

        # The root holds the shared and personal entry points plus a welcome
        # document. Creating folders there would turn it into a second place to
        # organise content, which is what Shared and the personal space are for.
        if not (parent_rel or "").strip("/"):
            raise InvalidPath(
                "Folders cannot be created in the root. Use Shared or your own folder."
            )

        parent_abs = self.resolve(parent_rel, principal, mode="write")
        if not os.path.isdir(parent_abs):
            raise InvalidPath("Parent is not a folder")

        target = os.path.join(parent_abs, name)
        self._require_target_write(parent_abs, name, principal)
        if os.path.exists(target):
            raise AlreadyExists(f"'{name}' already exists")
        os.makedirs(target, exist_ok=False)
        return self.describe(target)

    def create_file(self, parent_rel: str | None, name: str, principal=None) -> Item:
        name = self.validate_name(name)
        parent_abs = self.resolve(parent_rel, principal, mode="write")
        if not os.path.isdir(parent_abs):
            raise InvalidPath("Parent is not a folder")

        target = os.path.join(parent_abs, name)
        self._require_target_write(parent_abs, name, principal)
        if os.path.exists(target):
            raise AlreadyExists(f"'{name}' already exists")
        # 'x' mode fails if the file appeared between the check and the open.
        with open(target, "x"):
            pass
        return self.describe(target)

    def _require_target_write(self, parent_abs: str, name: str, principal) -> None:
        """Check permission on the path being created, not just its parent.

        Authorising only the parent would let a principal with write access to
        a region create entries that resolve outside their writable set once
        the new name is appended.
        """
        if principal is None:
            return
        target_rel = self.to_rel(os.path.join(parent_abs, name))
        principal.require_write(target_rel)

    def write_stream(
        self,
        parent_rel: str | None,
        name: str,
        stream,
        *,
        overwrite: bool = False,
        max_bytes: int | None = None,
        principal=None,
    ) -> Item:
        """Stream an uploaded body to disk.

        The bytes land in a sibling ``.part`` file that is renamed into place
        only after the transfer completes, so an interrupted upload never
        leaves a half-written file visible in the listing.
        """
        name = self.validate_name(name)
        parent_abs = self.resolve(parent_rel, principal, mode="write")
        if not os.path.isdir(parent_abs):
            raise InvalidPath("Parent is not a folder")

        target = os.path.join(parent_abs, name)
        self._require_target_write(parent_abs, name, principal)
        if os.path.exists(target) and not overwrite:
            raise AlreadyExists(f"'{name}' already exists")

        part_path = f"{target}.part-{os.getpid()}"
        written = 0
        try:
            with open(part_path, "wb") as handle:
                while True:
                    chunk = stream.read(CHUNK_SIZE)
                    if not chunk:
                        break
                    written += len(chunk)
                    if max_bytes is not None and written > max_bytes:
                        raise StorageError(
                            f"Upload exceeds the {max_bytes // (1024 * 1024)} MB limit"
                        )
                    handle.write(chunk)

            if overwrite and os.path.exists(target):
                os.replace(part_path, target)
            else:
                # 'x' semantics: refuse to clobber a file created concurrently.
                if os.path.exists(target):
                    raise AlreadyExists(f"'{name}' already exists")
                os.replace(part_path, target)
        except BaseException:
            # Clean up the partial file on any failure, including client
            # disconnects, which surface as exceptions from the body stream.
            try:
                if os.path.exists(part_path):
                    os.remove(part_path)
            except OSError:
                pass
            raise

        return self.describe(target)

    def delete(self, rel_path: str | None, principal=None) -> None:
        abs_path = self.resolve(rel_path, principal, mode="write")
        if abs_path == self.root:
            raise InvalidPath("Cannot delete the storage root")
        if os.path.isdir(abs_path):
            shutil.rmtree(abs_path)
        else:
            os.remove(abs_path)

    def move(self, src_rel: str | None, dest_rel: str | None, principal=None) -> Item:
        # Both ends need write permission: move is a delete plus a create.
        src_abs = self.resolve(src_rel, principal, mode="write")
        if src_abs == self.root:
            raise InvalidPath("Cannot move the storage root")

        dest_abs = self.resolve(dest_rel, principal, mode="write", must_exist=False)

        # Refuse to move a folder inside itself, which would be destructive.
        if os.path.isdir(src_abs) and self._is_inside_source(dest_abs, src_abs):
            raise InvalidPath("Cannot move a folder into itself")

        if os.path.exists(dest_abs):
            raise AlreadyExists("Destination already exists")

        os.makedirs(os.path.dirname(dest_abs), exist_ok=True)
        try:
            os.rename(src_abs, dest_abs)
        except OSError:
            # Different filesystems: fall back to a copy-and-delete.
            if os.path.isdir(src_abs):
                shutil.copytree(src_abs, dest_abs)
                shutil.rmtree(src_abs)
            else:
                shutil.copy2(src_abs, dest_abs)
                os.remove(src_abs)

        return self.describe(dest_abs)

    def _is_inside_source(self, dest_abs: str, src_abs: str) -> bool:
        try:
            return os.path.commonpath([src_abs, dest_abs]) == src_abs
        except ValueError:
            return False

    def copy(self, src_rel: str | None, dest_rel: str | None, principal=None) -> Item:
        # Read permission on the source, write permission on the destination:
        # copying is how a user would otherwise exfiltrate a file they can see
        # into somewhere they can serve from.
        src_abs = self.resolve(src_rel, principal, mode="read")
        if src_abs == self.root:
            raise InvalidPath("Cannot copy the storage root")

        dest_abs = self.resolve(dest_rel, principal, mode="write", must_exist=False)
        if self._is_inside_source(dest_abs, src_abs):
            raise InvalidPath("Cannot copy a folder into itself")
        if os.path.exists(dest_abs):
            raise AlreadyExists("Destination already exists")

        os.makedirs(os.path.dirname(dest_abs), exist_ok=True)
        if os.path.isdir(src_abs):
            shutil.copytree(src_abs, dest_abs)
        else:
            shutil.copy2(src_abs, dest_abs)

        return self.describe(dest_abs)

    def unique_destination(self, parent_rel: str | None, name: str, principal=None) -> str:
        """Return a non-colliding relative path for ``name`` in ``parent_rel``.

        Mirrors the "copy" suffix convention so paste operations do not fail
        when the target folder already holds the same name.
        """
        parent_abs = self.resolve(parent_rel, principal, mode="write")
        base, ext = os.path.splitext(name)
        candidate = name
        counter = 1
        while os.path.exists(os.path.join(parent_abs, candidate)):
            candidate = f"{base} ({counter}){ext}"
            counter += 1
        prefix = self.to_rel(parent_abs)
        return f"{prefix}/{candidate}" if prefix else candidate

    def iter_file(self, abs_path: str, start: int = 0, length: int | None = None) -> Iterator[bytes]:
        """Yield file bytes for streaming responses, optionally a byte range."""
        with open(abs_path, "rb") as handle:
            handle.seek(start)
            remaining = length
            while True:
                if remaining is not None and remaining <= 0:
                    break
                read_size = CHUNK_SIZE if remaining is None else min(CHUNK_SIZE, remaining)
                chunk = handle.read(read_size)
                if not chunk:
                    break
                if remaining is not None:
                    remaining -= len(chunk)
                yield chunk

    def fingerprint(self, abs_path: str) -> str:
        """Cheap cache key from path, size and mtime (not a content hash)."""
        stat = os.stat(abs_path)
        raw = f"{self.to_rel(abs_path)}:{stat.st_size}:{stat.st_mtime_ns}"
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32]


def human_size(num_bytes: int) -> str:
    """Format a byte count for log lines and diagnostics."""
    size = float(num_bytes)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if size < 1024 or unit == "TB":
            return f"{size:.1f} {unit}" if unit != "B" else f"{int(size)} B"
        size /= 1024
    return f"{size:.1f} TB"


def utc_stamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")
