"""Access control for storage paths.

Every filesystem access is checked against a :class:`Principal`.  The check is
mandatory inside :meth:`storage.Storage.resolve`, so a new API route cannot
accidentally skip authorization by forgetting to call a guard.

The model is deliberately simple: a principal has a set of *regions* it may
read, a set it may write, and a mode.  A region is a path prefix.

Realms
------
``shared``
    Visible to every account, read/write.
``users/<name>``
    Private to that account, read/write for its owner and invisible to others.
Root-level files
    Legacy imports (files placed directly in the storage root).  Visible to
    every account, read/write, since they have no recorded owner.  Note that
    this is *not* the same as granting the root as a region: an empty region
    would mean "everything", which would expose every other user's home.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from models import SHARED_PREFIX, USERS_PREFIX

# Access levels, ordered from most to least privileged.
MODE_ADMIN = "admin"          # API token: full access to everything
MODE_USER = "user"            # logged-in account
MODE_UNLOCKED = "unlocked"    # guest holding a directory PIN
MODE_NONE = "none"            # anonymous

# Names hidden from listings in the normal user mode. 'users' is a container
# for everyone's private spaces, so exposing it would reveal other accounts.
SYSTEM_NAMES = {USERS_PREFIX}


class AccessDenied(Exception):
    """Raised when a principal may not touch a path."""

    status_code = 403


def normalize(path: str | None) -> str:
    """Canonicalise an API path: no leading/trailing slashes, no dot segments."""
    if not path:
        return ""
    parts = [
        p for p in path.replace("\\", "/").strip("/").split("/") if p not in ("", ".")
    ]
    return "/".join(parts)


def _within_region(path: str, region: str) -> bool:
    """True when ``path`` is ``region`` itself or lies beneath it.

    An empty region means the entire tree, so callers must only use ``""`` when
    that is genuinely intended (the API token).
    """
    if region == "":
        return True
    return path == region or path.startswith(region + "/")


def _is_legacy_root_path(path: str) -> bool:
    """True for a path directly in the storage root, excluding system entries.

    These are files placed in the storage root before accounts existed. They
    have no owner, so every account may use them. The check is one level deep
    on purpose: ``users/alice/...`` must never qualify.
    """
    if not path or "/" in path:
        return False
    return path not in SYSTEM_NAMES


def _is_user_home(path: str) -> bool:
    """True when ``path`` is inside the ``users/`` area at all.

    Used as a hard exclusion so a grant that includes the storage root cannot
    be used to reach another account's private folder.
    """
    return path == USERS_PREFIX or path.startswith(USERS_PREFIX + "/")


@dataclass
class Principal:
    """Who is asking, and what they may reach."""

    mode: str = MODE_NONE
    user_id: int | None = None
    username: str | None = None
    is_admin: bool = False
    # Regions this principal may read.
    readable: list[str] = field(default_factory=list)
    # Regions this principal may write. Always a subset of ``readable``.
    writable: list[str] = field(default_factory=list)
    # Directory this guest unlocked, for reference.
    unlocked_path: str | None = None

    # ------------------------------------------------------------------
    # Construction
    # ------------------------------------------------------------------
    @classmethod
    def anonymous(cls) -> "Principal":
        return cls(mode=MODE_NONE)

    @classmethod
    def for_token(cls) -> "Principal":
        """Full access, for the optional shared API token."""
        return cls(mode=MODE_ADMIN, readable=[""], writable=[""])

    @classmethod
    def for_user(cls, user) -> "Principal":
        """A logged-in account: its own home, plus the shared areas.

        The storage root is writable too, so an operator can place a welcome
        document or tidy loose files there. It is not listed as a writable
        *root* for display purposes (see ``to_dict``), so the UI still steers
        new content into Shared or the user's own space rather than inviting
        people to dump files at the top level.
        """
        return cls(
            mode=MODE_USER,
            user_id=user.id,
            username=user.username,
            is_admin=user.is_admin,
            readable=[user.home, SHARED_PREFIX],
            writable=[user.home, SHARED_PREFIX, ""],
        )

    @classmethod
    def for_unlocked(cls, path: str, token: str = "") -> "Principal":
        """A guest who presented a directory PIN.

        Read-only, confined to that directory and its descendants. The root is
        intentionally not readable, so the guest cannot navigate upwards, list
        siblings, or discover anything outside the folder they were given.
        """
        region = normalize(path)
        if not region:
            # A PIN on the storage root would expose everything; refuse it.
            return cls(mode=MODE_NONE)
        return cls(
            mode=MODE_UNLOCKED,
            readable=[region],
            writable=[],
            unlocked_path=region,
        )

    # ------------------------------------------------------------------
    # Checks
    # ------------------------------------------------------------------
    @property
    def authenticated(self) -> bool:
        return self.mode != MODE_NONE

    @property
    def is_guest(self) -> bool:
        return self.mode == MODE_UNLOCKED

    def _in_regions(self, path: str, regions: list[str]) -> bool:
        return any(_within_region(path, region) for region in regions)

    def can_read(self, path: str | None) -> bool:
        if self.mode == MODE_NONE:
            return False
        target = normalize(path)

        if self._in_regions(target, self.readable):
            return True

        # Legacy root-level files are readable by account holders so they can
        # be recognised and moved into a proper space.
        if self.mode == MODE_USER and _is_legacy_root_path(target):
            return True

        return False

    def can_write(self, path: str | None) -> bool:
        """Whether this principal may create, rename or delete at ``path``.

        The storage root is writable for account holders so a welcome document
        can live there and loose files can be tidied. That is expressed by
        including ``""`` in ``writable``, which in region terms means "the whole
        tree" - so it MUST be paired with the explicit exclusion below, or one
        account could write into another's private folder.
        """
        if self.mode == MODE_NONE:
            return False
        target = normalize(path)

        # Nobody may write inside another account's private space, whatever
        # other regions they hold.
        if _is_user_home(target) and not self._owns_home(target):
            return False

        return self._in_regions(target, self.writable)

    def _owns_home(self, target: str) -> bool:
        """True when ``target`` is under this principal's own home."""
        if not self.username:
            return False
        own = f"{USERS_PREFIX}/{self.username}"
        return target == own or target.startswith(own + "/")

    def visible_children(self, listing: list[str]) -> list[str]:
        """Filter directory entries for this principal, by **full path**.

        Paths are required rather than bare names: a guest's region is a full
        path (``users/alice/diary``), so comparing it against a bare name like
        ``inside.txt`` would match nothing and hide the entire folder. System
        container names are matched on the final segment.
        """
        visible = []
        for path in listing:
            name = path.rsplit("/", 1)[-1]
            if self.mode == MODE_USER and name in SYSTEM_NAMES:
                continue
            if not self.can_read(path):
                continue
            visible.append(path)
        return visible

    def require_read(self, path: str | None) -> None:
        if not self.can_read(path):
            raise AccessDenied("You do not have access to this location")

    def require_write(self, path: str | None) -> None:
        if not self.can_write(path):
            raise AccessDenied("This location is read-only for you")

    @property
    def min_readable_depth(self) -> int:
        """Depth of the shallowest readable region, in path segments.

        Ancestors at or above this depth are container levels implied by the
        grant itself. A user granted ``users/alice`` must be allowed to address
        it without separately being able to read ``users``; a guest granted
        ``users/alice/diary`` must not be able to read ``users/alice``.
        """
        depths = [len(r.split("/")) for r in self.readable if r]
        return min(depths) if depths else 0

    def to_dict(self) -> dict:
        return {
            "mode": self.mode,
            "authenticated": self.authenticated,
            "username": self.username,
            "is_admin": self.is_admin,
            "is_guest": self.is_guest,
            "readable": self.readable,
            "writable": self.writable,
            # The regions a user should put content in. The storage root is
            # excluded even though accounts may write there for housekeeping
            # (placing a welcome document, tidying loose files): advertising it
            # would invite people to dump files at the top level.
            "writable_roots": [r for r in self.writable if r],
            # Whether new folders may be created at the root. False keeps the
            # root a landing area with a welcome document, rather than a place
            # to organise content into folders.
            "can_create_folder_at_root": False,
        }
