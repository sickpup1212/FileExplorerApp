"""REST API for the file explorer.

All routes live under ``/api``.  Errors are returned as ``{"error": "..."}``
with a meaningful status code so the frontend can surface them directly.

Every filesystem route resolves a :class:`~permissions.Principal` from the
session and passes it to ``Storage``, which enforces access on the path itself.
"""

from __future__ import annotations

import functools
import os
import re
import secrets
import shutil
import subprocess
import tempfile
import threading
from datetime import datetime

from flask import (
    Blueprint,
    current_app,
    jsonify,
    render_template_string,
    request,
    send_file,
    session,
)

from extensions import db
from models import (
    SHARED_PREFIX,
    USERS_PREFIX,
    DirectoryPin,
    Share,
    User,
    validate_password,
    validate_username,
)
from permissions import (
    AccessDenied,
    MODE_ADMIN,
    MODE_NONE,
    MODE_UNLOCKED,
    MODE_USER,
    Principal,
    normalize,
)
from storage import (
    AlreadyExists,
    InvalidName,
    InvalidPath,
    NotFound,
    Storage,
    StorageError,
    human_size,
)

api = Blueprint("api", __name__, url_prefix="/api")

# Thumbnails are cached on disk; this guards against two requests racing to
# generate the same one.
_thumb_lock = threading.Lock()

_VIDEO_EXTENSIONS = {"mp4", "webm", "mkv", "mov", "avi", "m4v", "ogv", "3gp"}
_IMAGE_EXTENSIONS = {"jpg", "jpeg", "png", "gif", "webp", "bmp", "tiff", "tif", "avif"}


# ----------------------------------------------------------------------
# Principal resolution
# ----------------------------------------------------------------------
def get_storage() -> Storage:
    return current_app.extensions["storage"]


def current_principal() -> Principal:
    """Resolve who is making this request.

    Tokens are checked first so a script can use the same routes without a
    session. Otherwise the session either holds an account, or a set of
    directory-PIN unlocks.
    """
    token = current_app.config.get("API_TOKEN")
    if token and request.headers.get("X-Auth-Token") == token:
        return Principal.for_token()

    user_id = session.get("user_id")
    if user_id:
        user = db.session.get(User, user_id)
        if user is not None:
            return Principal.for_user(user)

        # The session names an account that no longer exists (the account was
        # deleted, or the database was swapped). End the session outright
        # rather than quietly falling through: falling through left a
        # half-broken state where the UI looked signed in but every action
        # failed, and the user was labelled 'unknown'.
        session.clear()
        return Principal.anonymous()

    unlocks = session.get("unlocks") or []
    if unlocks:
        # A session may hold several unlocks; the most recently added wins, so
        # presenting a second PIN switches which directory you are inside.
        path = unlocks[-1].get("path")
        if path:
            return Principal.for_unlocked(path, unlocks[-1].get("token", ""))

    # Legacy single-PIN mode. Only meaningful on a deployment that has not
    # moved to accounts: once one exists, a leftover 'authenticated' flag in an
    # old cookie must not keep granting full access to the storage root.
    if session.get("authenticated") and not User.query.count():
        return Principal.for_token()

    return Principal.anonymous()


def login_required(view):
    @functools.wraps(view)
    def wrapped(*args, **kwargs):
        principal = current_principal()
        if not principal.authenticated:
            return (
                jsonify(
                    {
                        "error": "Authentication required",
                        "auth_required": True,
                        "login_url": "/login",
                    }
                ),
                401,
            )
        request.principal = principal  # type: ignore[attr-defined]
        return view(*args, **kwargs)

    return wrapped


def error_response(message: str, status: int):
    return jsonify({"error": message}), status


@api.errorhandler(StorageError)
def handle_storage_error(exc: StorageError):
    return error_response(str(exc), getattr(exc, "status_code", 400))


@api.errorhandler(AccessDenied)
def handle_access_denied(exc: AccessDenied):
    return error_response(str(exc), 403)


def principal() -> Principal:
    return request.principal  # type: ignore[attr-defined]


def _ext(filename: str) -> str:
    return filename.rsplit(".", 1)[-1].lower() if "." in filename else ""


def _base_url() -> str:
    return request.host_url.rstrip("/")


# ----------------------------------------------------------------------
# Item decoration
# ----------------------------------------------------------------------
def decorate(items, who: Principal) -> list[dict]:
    """Add permission and PIN flags to a listing.

    Batched into one PIN query so listing a folder costs a single lookup
    rather than one per entry.
    """
    paths = [item.path for item in items]
    pinned: dict[str, DirectoryPin] = {}
    if paths:
        rows = DirectoryPin.query.filter(DirectoryPin.path.in_(paths)).all()
        pinned = {row.path: row for row in rows}

    unlocked_paths = {
        normalize(entry.get("path")) for entry in (session.get("unlocks") or [])
    }

    decorated = []
    for item in items:
        data = item.to_dict()
        data["writable"] = who.can_write(item.path)
        pin = pinned.get(item.path)
        data["pin_protected"] = pin is not None
        data["unlocked"] = item.path in unlocked_paths
        data["has_pin"] = bool(pin) and not data["unlocked"]
        decorated.append(data)
    return decorated


def decorate_one(item, who: Principal) -> dict:
    return decorate([item], who)[0]


# ----------------------------------------------------------------------
# Authentication
# ----------------------------------------------------------------------
@api.get("/auth/status")
def auth_status():
    """Report how this deployment is configured, for the login screen."""
    user_count = User.query.count()
    pin_configured = bool(current_app.config.get("PIN_HASH"))
    invite_configured = bool(current_app.config.get("INVITE_CODE"))
    principal_now = current_principal()

    # The first account is always allowed, with or without an invite code, so
    # initial setup is not a chicken-and-egg problem. After that the code is
    # mandatory.
    is_first_account = user_count == 0
    registration_open = is_first_account or invite_configured

    return jsonify(
        {
            "authenticated": principal_now.authenticated,
            "auth_required": bool(user_count or pin_configured),
            "account_count": user_count,
            # The shared PIN is only a way in on a deployment with no accounts.
            # Once one exists it is refused, so it must not be offered either.
            "pin_login_enabled": pin_configured and user_count == 0,
            "pin_configured": pin_configured,
            "registration_enabled": registration_open,
            "registration_open": registration_open,
            # Drives whether the login form shows and requires the field.
            "invite_code_required": registration_open and not is_first_account,
            "invite_code_configured": invite_configured,
            # Whether the login page should offer a password reset.
            "recovery_available": bool(current_app.config.get("RECOVERY_CODE")),
            "username": principal_now.username,
            "is_guest": principal_now.is_guest,
        }
    )


@api.get("/session")
@login_required
def get_session():
    who = principal()
    return jsonify({"principal": who.to_dict()})


@api.post("/auth/login")
def login():
    """Log in with an account, or with the legacy shared PIN.

    A JSON body with ``username`` and ``password`` is an account login. A body
    with only ``pin`` falls back to the original single-PIN behaviour.
    """
    payload = request.get_json(silent=True) or {}
    username = payload.get("username")
    password = payload.get("password")
    pin = payload.get("pin")

    if username:
        return _login_with_account(username, password)

    if pin is not None:
        return _login_with_pin(str(pin))

    return error_response("Provide username and password, or a PIN", 400)


def _log_in(user) -> None:
    """Start an account session, discarding any previous one.

    Clearing first matters: a leftover legacy PIN flag or directory unlock in
    the same cookie must not survive into an account session.
    """
    from pages import safe_next

    landing = safe_next(session.get("next"))
    session.clear()
    session.permanent = True
    session["user_id"] = user.id
    if landing:
        session["next"] = landing


def _landing_url() -> str | None:
    """Where the client should go after a successful login, if anywhere."""
    from pages import safe_next

    target = safe_next(session.pop("next", None))
    return target


def _login_with_account(username, password):
    try:
        normalized = validate_username(username)
    except ValueError:
        # Do not reveal whether the username exists.
        return error_response("Incorrect username or password", 401)

    user = User.query.filter_by(username=normalized).first()
    if user is None or not user.check_password(password or ""):
        current_app.logger.warning(
            "Failed login for '%s' from %s", normalized, request.remote_addr
        )
        return error_response("Incorrect username or password", 401)

    _ensure_user_home(user)
    _log_in(user)
    user.last_login_at = datetime.now()
    db.session.commit()

    who = Principal.for_user(user)
    return jsonify(
        {"principal": who.to_dict(), "user": user.to_dict(), "next": _landing_url()}
    )


def _login_with_pin(pin: str):
    """Legacy shared-PIN login, for a deployment that has no accounts yet.

    Once an account exists this is refused. Leaving it enabled would be a
    second, much weaker way into the whole storage root, bypassing the account
    system entirely: the PIN is a single shared secret, not attributable to
    anyone, and cannot be scoped or revoked per person.
    """
    if User.query.count():
        return error_response(
            "PIN sign-in is disabled because accounts exist. Sign in with your "
            "account instead.",
            403,
        )

    pin_hash = current_app.config.get("PIN_HASH")
    if not pin_hash:
        return error_response("PIN login is not enabled on this server", 400)

    from werkzeug.security import check_password_hash

    if not check_password_hash(pin_hash, pin):
        current_app.logger.warning("Failed PIN login from %s", request.remote_addr)
        return error_response("Incorrect PIN", 401)

    session.clear()
    session.permanent = True
    session["authenticated"] = True
    return jsonify({"principal": Principal.for_token().to_dict()})


@api.post("/auth/recover")
def recover_password():
    """Set a new password using the recovery code.

    The recovery code is a server-side secret from .env, so this only helps
    someone who can already read the config: it is a way back in for the
    operator, not a public reset. Without it the only route is running
    `manage_users.py passwd` on the host. That is intentional - an
    unauthenticated password reset with no shared secret would be a way in for
    anyone who can reach the server.
    """
    payload = request.get_json(silent=True) or {}
    code = (payload.get("recovery_code") or "").strip()
    configured = current_app.config.get("RECOVERY_CODE")

    if not configured:
        return error_response(
            "Password recovery is not enabled. Set FILE_EXPLORER_RECOVERY_CODE "
            "(or FILE_EXPLORER_INVITE_CODE) in .env, or run "
            "'manage_users.py passwd <name>' on the server.",
            403,
        )

    if not secrets.compare_digest(code, configured):
        current_app.logger.warning(
            "Failed password recovery attempt from %s", request.remote_addr
        )
        return error_response("Incorrect recovery code", 401)

    try:
        username = validate_username(payload.get("username", ""))
    except ValueError:
        return error_response("Enter your username and a new password", 400)

    try:
        new_password = validate_password(payload.get("password", ""))
    except ValueError as exc:
        return error_response(str(exc), 400)

    user = User.query.filter_by(username=username).first()
    if user is None:
        # Same message either way, so this cannot be used to enumerate accounts.
        return error_response("Incorrect recovery code", 401)

    user.set_password(new_password)
    db.session.commit()

    session.clear()
    session.permanent = True
    session["user_id"] = user.id
    _ensure_user_home(user)

    current_app.logger.warning("Password reset for '%s' via recovery code", username)
    who = Principal.for_user(user)
    return jsonify({"principal": who.to_dict(), "user": user.to_dict(), "next": None})


@api.post("/auth/register")
def register():
    """Create an account.

    The very first account is exempt from the invite code: there is nothing to
    protect yet, and requiring a secret for initial setup is a chicken-and-egg
    problem. Once an account exists, the invite code gates every later signup.
    """
    payload = request.get_json(silent=True) or {}
    invite = current_app.config.get("INVITE_CODE")
    is_first_account = User.query.count() == 0

    if not is_first_account:
        if not invite:
            return error_response(
                "Registration is closed. Set FILE_EXPLORER_INVITE_CODE to "
                "enable it, or log in with an existing account.",
                403,
            )

        if (payload.get("invite_code") or "").strip() != invite:
            current_app.logger.warning(
                "Registration attempt with a bad invite code from %s", request.remote_addr
            )
            return error_response(
                "Invalid invite code. Use the value of FILE_EXPLORER_INVITE_CODE "
                "from the server's .env file.",
                403,
            )

    try:
        username = validate_username(payload.get("username", ""))
        validate_password(payload.get("password", ""))
    except ValueError as exc:
        return error_response(str(exc), 400)

    if User.query.filter_by(username=username).first() is not None:
        return error_response("That username is taken", 409)

    user = User(username=username, display_name=(payload.get("display_name") or "").strip() or None)
    user.set_password(payload["password"])
    # The first account to exist becomes an admin, which is what makes the
    # first-run experience work without any manual database editing.
    user.is_admin = User.query.count() == 0

    db.session.add(user)
    db.session.commit()

    _ensure_user_home(user)

    _log_in(user)
    who = Principal.for_user(user)
    return (
        jsonify(
            {"principal": who.to_dict(), "user": user.to_dict(), "next": _landing_url()}
        ),
        201,
    )


def _ensure_user_home(user) -> None:
    """Create the standard folders for a new account.

    Called on login and registration so an account always has somewhere to
    put things; ``shared`` is created once for the whole deployment.
    """
    storage = get_storage()
    for path in (SHARED_PREFIX, user.home):
        try:
            # Internal call: the directories must exist before the principal
            # can be authorised against them.
            os.makedirs(storage.resolve(path, must_exist=False), exist_ok=True)
        except (StorageError, OSError):
            current_app.logger.warning("Could not create '%s'", path)


@api.post("/auth/logout")
def logout():
    session.clear()
    return jsonify({"authenticated": False})


# ----------------------------------------------------------------------
# Directory PINs
# ----------------------------------------------------------------------
@api.post("/pin/unlock")
def unlock_directory():
    """Exchange a share token plus PIN for read-only access to that folder."""
    payload = request.get_json(silent=True) or {}
    token = (payload.get("token") or "").strip()
    pin = (payload.get("pin") or "").strip()

    if not token or not pin:
        return error_response("A token and PIN are required", 400)

    record = DirectoryPin.query.filter_by(token=token).first()
    if record is None:
        return error_response("That link is not valid", 404)

    if not record.check_pin(pin):
        current_app.logger.warning(
            "Failed PIN unlock for '%s' from %s", record.path, request.remote_addr
        )
        return error_response("Incorrect PIN", 401)

    unlocks = [u for u in (session.get("unlocks") or []) if u.get("token") != token]
    unlocks.append({"token": token, "path": normalize(record.path)})
    session["unlocks"] = unlocks
    session.permanent = True

    return jsonify(
        {
            "path": normalize(record.path),
            "principal": Principal.for_unlocked(record.path, token).to_dict(),
        }
    )


@api.get("/pin/<token>")
def pin_info(token: str):
    """Public description of a protected folder, for the unlock page."""
    record = DirectoryPin.query.filter_by(token=token).first()
    if record is None:
        return error_response("That link is not valid", 404)

    storage = get_storage()
    exists = True
    try:
        storage.resolve(record.path)
    except StorageError:
        exists = False

    return jsonify(
        {
            "token": record.token,
            "name": record.path.rsplit("/", 1)[-1],
            "owner": record.owner.username if record.owner else None,
            "available": exists,
        }
    )


@api.post("/pin")
@login_required
def set_directory_pin():
    """Protect a directory with a PIN, returning the share URL."""
    payload = request.get_json(silent=True) or {}
    path = normalize(payload.get("path"))
    pin = (payload.get("pin") or "").strip()

    if not path:
        return error_response("A folder is required", 400)
    if not pin:
        return error_response("A PIN is required", 400)

    who = principal()
    who.require_write(path)

    storage = get_storage()
    item = storage.stat(path, who)
    if item.type != "folder":
        return error_response("Only folders can be protected with a PIN", 400)

    # A root-level PIN would expose everything, so refuse it explicitly.
    if not path:
        return error_response("The storage root cannot be PIN protected", 400)

    record = DirectoryPin.query.filter_by(path=path).first()
    if record is None:
        record = DirectoryPin(path=path, owner_id=who.user_id)
        db.session.add(record)

    record.set_pin(pin)
    if who.user_id:
        record.owner_id = who.user_id
    db.session.commit()

    return jsonify(record.to_dict(_base_url())), 201


@api.delete("/pin")
@login_required
def remove_directory_pin():
    path = normalize(request.args.get("path"))
    record = DirectoryPin.query.filter_by(path=path).first()
    if record is None:
        return error_response("That folder is not PIN protected", 404)

    who = principal()
    # The owner, an admin, or anyone with write access to the folder may
    # remove its protection.
    if not (who.is_admin or (record.owner_id and record.owner_id == who.user_id)
            or who.can_write(path)):
        raise AccessDenied("You cannot change this folder's protection")

    db.session.delete(record)
    db.session.commit()
    return jsonify({"removed": path})


@api.get("/pins")
@login_required
def list_pins():
    """PIN protected folders this principal owns or can write to."""
    who = principal()
    rows = DirectoryPin.query.order_by(DirectoryPin.created_at.desc()).all()
    visible = [r for r in rows if who.can_write(r.path)]
    return jsonify({"pins": [r.to_dict(_base_url()) for r in visible]})


# ----------------------------------------------------------------------
# Listing
# ----------------------------------------------------------------------
@api.get("/files")
@login_required
def list_files():
    """List a folder. ``?path=`` is relative to the storage root."""
    who = principal()
    path = normalize(request.args.get("path", ""))
    storage = get_storage()

    # 'users' is a container for everyone's private space. Give a clear message
    # rather than a confusing "not found".
    if path == USERS_PREFIX and who.mode == MODE_USER:
        raise AccessDenied("Private user folders are not listed here")

    items = storage.list_dir(path, who)

    # Filter by full path: hides system containers and anything the principal
    # cannot read, so the directory layout never leaks other accounts.
    allowed = set(who.visible_children([item.path for item in items]))
    items = [item for item in items if item.path in allowed]

    payload = {
        "path": path,
        "items": decorate(items, who),
        "principal": who.to_dict(),
    }

    # A guest needs to know the top of their world on every response, not just
    # when listing it, so the UI can build a breadcrumb that never shows the
    # folders above the one they were given.
    if who.is_guest:
        payload["guest_root"] = who.readable[0] if who.readable else ""

    # At the root, describe where the user's own space and the shared space
    # are, so the UI does not have to hardcode the layout. These are full
    # storage-relative paths, not bare names: the home directory lives under
    # the 'users/' prefix, and navigating to the bare username would 404.
    if path == "" and who.mode == MODE_USER:
        payload["personal"] = f"{USERS_PREFIX}/{who.username}"
        payload["shared"] = SHARED_PREFIX

    return jsonify(payload)


@api.get("/stat")
@login_required
def stat_item():
    who = principal()
    storage = get_storage()
    item = storage.stat(request.args.get("path", ""), who)
    return jsonify(decorate_one(item, who))


# ----------------------------------------------------------------------
# Creating items
# ----------------------------------------------------------------------
@api.post("/folder")
@login_required
def create_folder():
    payload = request.get_json(silent=True) or {}
    who = principal()
    item = get_storage().create_folder(payload.get("path", ""), payload.get("name", ""), who)
    return jsonify(decorate_one(item, who)), 201


@api.post("/file")
@login_required
def create_file():
    payload = request.get_json(silent=True) or {}
    who = principal()
    item = get_storage().create_file(payload.get("path", ""), payload.get("name", ""), who)
    return jsonify(decorate_one(item, who)), 201


# ----------------------------------------------------------------------
# Upload
# ----------------------------------------------------------------------
@api.post("/upload")
@login_required
def upload():
    """Stream one uploaded file to disk.

    The body is read in chunks straight onto disk, so a multi-gigabyte video
    never has to fit in memory.  ``path`` and ``name`` come from the query
    string or form fields so the request body stays a pure byte stream.
    """
    who = principal()
    path = request.args.get("path") or request.form.get("path", "")
    name = request.args.get("name") or request.form.get("name", "")
    overwrite = (request.args.get("overwrite") or request.form.get("overwrite", "")) in (
        "1",
        "true",
        "yes",
    )

    upload_stream = request.files.get("file")
    if upload_stream is not None:
        stream = upload_stream.stream
        name = name or upload_stream.filename or ""
    else:
        stream = request.stream

    if not name:
        return error_response("A filename is required", 400)

    max_bytes = current_app.config.get("MAX_UPLOAD_BYTES") or None
    item = get_storage().write_stream(
        path,
        os.path.basename(name),
        stream,
        overwrite=overwrite,
        max_bytes=max_bytes,
        principal=who,
    )
    return jsonify(decorate_one(item, who)), 201


# ----------------------------------------------------------------------
# Moving, copying, deleting
# ----------------------------------------------------------------------
@api.post("/move")
@login_required
def move():
    payload = request.get_json(silent=True) or {}
    who = principal()
    item = get_storage().move(payload.get("from"), payload.get("to"), who)
    return jsonify(decorate_one(item, who))


@api.post("/copy")
@login_required
def copy():
    payload = request.get_json(silent=True) or {}
    who = principal()
    item = get_storage().copy(payload.get("from"), payload.get("to"), who)
    return jsonify(decorate_one(item, who))


@api.delete("/files")
@login_required
def delete():
    who = principal()
    path = request.args.get("path", "")
    get_storage().delete(path, who)
    return jsonify({"deleted": path})


@api.post("/duplicate")
@login_required
def duplicate():
    """Copy an item, auto-picking a free name (used by paste)."""
    payload = request.get_json(silent=True) or {}
    who = principal()
    storage = get_storage()
    src = payload.get("path")
    parent = payload.get("parent", "")
    src_item = storage.stat(src, who)
    dest = storage.unique_destination(parent, src_item.name, who)
    return jsonify(decorate_one(storage.copy(src, dest, who), who))


# ----------------------------------------------------------------------
# Download and media streaming
# ----------------------------------------------------------------------
def _parse_range(range_header: str, file_size: int):
    """Parse a single ``bytes=`` range. Returns (start, end), None, or a marker."""
    match = re.match(r"bytes=(\d*)-(\d*)$", range_header.strip())
    if not match:
        return None

    raw_start, raw_end = match.groups()
    if raw_start == "" and raw_end == "":
        return None

    if raw_start == "":
        # Suffix range: last N bytes.
        length = int(raw_end)
        if length <= 0:
            return None
        start = max(file_size - length, 0)
        end = file_size - 1
    else:
        start = int(raw_start)
        end = int(raw_end) if raw_end else file_size - 1
        if start > end:
            return None

    if start >= file_size:
        return "unsatisfiable"
    return start, min(end, file_size - 1)


@api.get("/raw")
@login_required
def raw():
    """Serve file bytes.

    Supports HTTP Range requests, which is what lets a browser scrub through a
    video without downloading the whole thing first.
    """
    who = principal()
    path = request.args.get("path", "")
    storage = get_storage()
    abs_path = storage.resolve(path, who)

    if os.path.isdir(abs_path):
        return error_response("Cannot download a folder", 400)

    download = request.args.get("download") == "1"
    file_size = os.path.getsize(abs_path)
    mime = storage.describe(abs_path).mime or "application/octet-stream"
    filename = os.path.basename(abs_path)

    conditional = request.headers.get("If-None-Match")
    etag = f'"{storage.fingerprint(abs_path)}"'
    if conditional and conditional == etag:
        return "", 304

    range_header = request.headers.get("Range")
    if not range_header:
        response = send_file(
            abs_path,
            mimetype=mime,
            as_attachment=download,
            download_name=filename,
            conditional=True,
        )
        response.headers["Accept-Ranges"] = "bytes"
        response.headers["ETag"] = etag
        return response

    parsed = _parse_range(range_header, file_size)
    if parsed is None:
        return error_response("Malformed Range header", 416)
    if parsed == "unsatisfiable":
        response = error_response("Requested range not satisfiable", 416)
        response[0].headers["Content-Range"] = f"bytes */{file_size}"
        return response

    start, end = parsed
    length = end - start + 1

    response = current_app.response_class(
        storage.iter_file(abs_path, start, length),
        status=206,
        mimetype=mime,
        direct_passthrough=True,
    )
    response.headers["Content-Range"] = f"bytes {start}-{end}/{file_size}"
    response.headers["Accept-Ranges"] = "bytes"
    response.headers["Content-Length"] = str(length)
    response.headers["ETag"] = etag
    if download:
        response.headers["Content-Disposition"] = f'attachment; filename="{filename}"'
    return response


# ----------------------------------------------------------------------
# Thumbnails
# ----------------------------------------------------------------------
def _ffmpeg_path() -> str | None:
    return shutil.which("ffmpeg")


def _ffprobe_path() -> str | None:
    return shutil.which("ffprobe")


def _video_duration(abs_path: str) -> float | None:
    """Duration in seconds, or None if it cannot be determined."""
    ffprobe = _ffprobe_path()
    if not ffprobe:
        return None

    try:
        result = subprocess.run(
            [
                ffprobe,
                "-v", "error",
                "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1",
                abs_path,
            ],
            capture_output=True,
            timeout=10,
        )
    except (subprocess.TimeoutExpired, OSError):
        return None

    if result.returncode != 0:
        return None

    try:
        duration = float(result.stdout.decode().strip())
    except ValueError:
        return None

    return duration if duration > 0 else None


def _run_ffmpeg_thumbnail(abs_path: str, dest_path: str, size: int, seek: float | None) -> bool:
    """Grab one frame, optionally seeking to ``seek`` seconds first."""
    ffmpeg = _ffmpeg_path()
    if not ffmpeg:
        return False

    command = [ffmpeg, "-hide_banner", "-loglevel", "error"]
    if seek is not None:
        # Seeking before -i is fast; it lands on the nearest preceding keyframe.
        command += ["-ss", f"{seek:.3f}"]
    command += [
        "-i", abs_path,
        "-frames:v", "1",
        "-vf", f"scale={size}:{size}:force_original_aspect_ratio=decrease",
        "-f", "image2",
        "-y", dest_path,
    ]

    try:
        result = subprocess.run(
            command,
            capture_output=True,
            timeout=current_app.config.get("THUMBNAIL_TIMEOUT", 20),
        )
    except (subprocess.TimeoutExpired, OSError):
        return False

    return result.returncode == 0 and os.path.exists(dest_path) and os.path.getsize(dest_path) > 0


def _generate_thumbnail(abs_path: str, dest_path: str, size: int) -> bool:
    """Render a thumbnail to ``dest_path``. Returns False if unsupported."""
    extension = _ext(abs_path)

    if extension in _IMAGE_EXTENSIONS:
        try:
            from PIL import Image, ImageOps

            with Image.open(abs_path) as image:
                image = ImageOps.exif_transpose(image)
                image = image.convert("RGB")
                image.thumbnail((size, size))
                image.save(dest_path, "JPEG", quality=82, optimize=True)
            return os.path.getsize(dest_path) > 0
        except Exception:  # noqa: BLE001 - any decode failure means "no thumb"
            return False

    if extension in _VIDEO_EXTENSIONS:
        if not _ffmpeg_path():
            return False

        # Seek a little way in: the opening frame of a video is very often
        # black, which makes for a useless cover image.
        duration = _video_duration(abs_path)
        seek = duration * 0.1 if duration else None

        if _run_ffmpeg_thumbnail(abs_path, dest_path, size, seek):
            return True

        # A seek past the end (or into a sparse region) fails, so retry from
        # the very first frame before giving up.
        if seek is not None:
            if os.path.exists(dest_path):
                os.remove(dest_path)
            return _run_ffmpeg_thumbnail(abs_path, dest_path, size, None)
        return False

    return False


@api.get("/thumbnail")
@login_required
def thumbnail():
    """Serve a cached thumbnail, generating it on first request."""
    who = principal()
    path = request.args.get("path", "")
    storage = get_storage()
    abs_path = storage.resolve(path, who)

    if os.path.isdir(abs_path):
        return error_response("Folders have no thumbnail", 400)

    size = min(max(request.args.get("size", 320, type=int), 32), 1024)

    if _ext(abs_path) not in _IMAGE_EXTENSIONS | _VIDEO_EXTENSIONS:
        return error_response("No thumbnail available for this type", 404)

    cache_dir = current_app.config["THUMBNAIL_CACHE_DIR"]
    os.makedirs(cache_dir, exist_ok=True)
    # Key includes mtime, so editing a file naturally invalidates its thumbnail.
    cache_path = os.path.join(cache_dir, f"{storage.fingerprint(abs_path)}-{size}.jpg")

    if not os.path.exists(cache_path):
        with _thumb_lock:
            if not os.path.exists(cache_path):
                # Write to a temp file then rename, so a concurrent reader never
                # sees a partially written JPEG.
                handle, temp_path = tempfile.mkstemp(suffix=".jpg", dir=cache_dir)
                os.close(handle)
                try:
                    if not _generate_thumbnail(abs_path, temp_path, size):
                        os.remove(temp_path)
                        return error_response("Could not generate a thumbnail", 404)
                    os.replace(temp_path, cache_path)
                except Exception:  # noqa: BLE001
                    if os.path.exists(temp_path):
                        os.remove(temp_path)
                    raise

    response = send_file(cache_path, mimetype="image/jpeg", conditional=True)
    response.headers["Cache-Control"] = "public, max-age=86400"
    return response


# ----------------------------------------------------------------------
# File share links
# ----------------------------------------------------------------------
def _find_share(token: str):
    share = Share.query.filter_by(token=token).first()
    if share is None or share.is_expired:
        return None
    return share


@api.post("/share")
@login_required
def create_share():
    payload = request.get_json(silent=True) or {}
    who = principal()

    # A guest holds a capability for one folder. Letting them mint a new public
    # link would let that capability be passed on indefinitely, and the link
    # outlives the PIN session.
    if who.is_guest:
        raise AccessDenied("Guest access cannot create share links")

    path = payload.get("path", "")
    storage = get_storage()
    item = storage.stat(path, who)

    if item.type != "file":
        return error_response("Only files can be shared", 400)

    days = payload.get("days", 7)
    try:
        days = int(days)
    except (TypeError, ValueError):
        return error_response("'days' must be a number", 400)

    share = Share(
        path=item.path,
        name=item.name,
        expires_at=Share.default_expiry(days) if days > 0 else None,
    )
    db.session.add(share)
    db.session.commit()
    return jsonify(share.to_dict(_base_url())), 201


@api.get("/share/<token>")
@login_required
def share_info(token: str):
    share = _find_share(token)
    if share is None:
        return error_response("Share link not found or expired", 404)
    return jsonify(share.to_dict(_base_url()))


@api.delete("/share/<token>")
@login_required
def revoke_share(token: str):
    share = Share.query.filter_by(token=token).first()
    if share is None:
        return error_response("Share link not found", 404)
    db.session.delete(share)
    db.session.commit()
    return jsonify({"revoked": token})


@api.get("/s/<token>")
def public_share(token: str):
    """Share link target under the API prefix."""
    return _serve_share(token)


# The share URL handed to users is "/s/<token>" - no /api prefix - because it
# is meant to be pasted into a chat app. The blueprint is mounted under /api,
# so the bare path is registered separately against the same view.
share_urls = Blueprint("share_urls", __name__)


@share_urls.get("/s/<token>")
def public_share_root(token: str):
    return _serve_share(token)


def register_share_routes(app) -> None:
    """Mount the public share page and PIN unlock page outside /api."""
    app.register_blueprint(share_urls)


def _serve_share(token: str):
    share = _find_share(token)
    if share is None:
        return error_response("Share link not found or expired", 404)

    storage = get_storage()
    try:
        # Internal resolve: the token is the capability, so no principal is
        # needed. Shares are created by an authorised user in the first place.
        abs_path = storage.resolve(share.path)
    except StorageError:
        return error_response("The shared file no longer exists", 404)

    if request.args.get("download") == "1":
        return _send_shared_file(share, storage, abs_path, as_attachment=True)

    item = storage.describe(abs_path)
    return _share_page(share, item, token)


def _send_shared_file(share, storage, abs_path: str, *, as_attachment: bool):
    response = send_file(
        abs_path,
        mimetype=storage.describe(abs_path).mime or "application/octet-stream",
        as_attachment=as_attachment,
        download_name=share.name,
        conditional=True,
    )
    response.headers["Accept-Ranges"] = "bytes"
    return response


def _share_page(share, item, token: str):
    """Minimal standalone download page for a share link."""
    expires = share.expires_at.strftime("%Y-%m-%d %H:%M") if share.expires_at else "never"

    template = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{ name }}</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; background:#f1f3f5;
         display:flex; align-items:center; justify-content:center;
         min-height:100vh; margin:0; padding:1rem; }
  .card { background:#fff; border-radius:12px; padding:2rem; max-width:420px;
          width:100%; text-align:center; box-shadow:0 10px 30px rgba(0,0,0,.12); }
  h1 { font-size:1.1rem; margin:0 0 .5rem; word-break:break-word; }
  .meta { color:#6c757d; font-size:.85rem; margin-bottom:1.5rem; }
  a.button { display:block; background:#0d6efd; color:#fff; text-decoration:none;
             padding:.75rem 1rem; border-radius:8px; font-weight:500; }
  a.button:hover { background:#0b5ed7; }
  video, audio, img { max-width:100%; border-radius:8px; margin-bottom:1rem; }
</style>
</head>
<body>
  <div class="card">
    <h1>{{ name }}</h1>
    <div class="meta">{{ size }} &middot; link expires {{ expires }}</div>
    {% if kind == 'image' %}<img src="/api/s/{{ token }}?download=1" alt="">{% endif %}
    {% if kind == 'video' %}<video src="/api/s/{{ token }}?download=1" controls></video>{% endif %}
    {% if kind == 'audio' %}<audio src="/api/s/{{ token }}?download=1" controls></audio>{% endif %}
    <a class="button" href="/api/s/{{ token }}?download=1">Download</a>
  </div>
</body>
</html>"""

    mime = item.mime or ""
    if mime.startswith("image/"):
        kind = "image"
    elif mime.startswith("video/"):
        kind = "video"
    elif mime.startswith("audio/"):
        kind = "audio"
    else:
        kind = "other"

    return render_template_string(
        template,
        name=share.name,
        size=human_size(item.size),
        expires=expires,
        kind=kind,
        token=token,
    )


@api.get("/shares")
@login_required
def list_shares():
    shares = Share.query.order_by(Share.created_at.desc()).all()
    return jsonify({"shares": [s.to_dict(_base_url()) for s in shares]})


# ----------------------------------------------------------------------
# Diagnostics
# ----------------------------------------------------------------------
@api.get("/health")
def health():
    storage = get_storage()
    usage = shutil.disk_usage(storage.root)
    return jsonify(
        {
            "status": "ok",
            "storage_root": storage.root,
            "disk": {"total": usage.total, "used": usage.used, "free": usage.free},
            "ffmpeg": bool(_ffmpeg_path()),
            "accounts": User.query.count(),
            "time": datetime.now().isoformat(timespec="seconds"),
        }
    )
