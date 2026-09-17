"""REST API for the file explorer.

All routes live under ``/api``.  Errors are returned as ``{"error": "..."}``
with a meaningful status code so the frontend can surface them directly.
"""

from __future__ import annotations

import functools
import os
import re
import shutil
import subprocess
import tempfile
import threading
from datetime import datetime, timedelta

from flask import (
    Blueprint,
    current_app,
    jsonify,
    request,
    send_file,
    session,
)
from werkzeug.security import check_password_hash

from extensions import db
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
# Helpers
# ----------------------------------------------------------------------
def get_storage() -> Storage:
    return current_app.extensions["storage"]


def error_response(message: str, status: int):
    return jsonify({"error": message}), status


@api.errorhandler(StorageError)
def handle_storage_error(exc: StorageError):
    return error_response(str(exc), getattr(exc, "status_code", 400))


def login_required(view):
    """Reject unauthenticated API calls.

    The PIN modal uses this to decide whether to show itself, so the failure
    carries ``auth_required`` rather than looking like a generic error.
    """

    @functools.wraps(view)
    def wrapped(*args, **kwargs):
        if session.get("authenticated"):
            return view(*args, **kwargs)

        # Allow scripted/CLI access with a shared token instead of a session.
        token = current_app.config.get("API_TOKEN")
        if token and request.headers.get("X-Auth-Token") == token:
            return view(*args, **kwargs)

        return jsonify({"error": "Authentication required", "auth_required": True}), 401

    return wrapped


def _ext(filename: str) -> str:
    return filename.rsplit(".", 1)[-1].lower() if "." in filename else ""


# ----------------------------------------------------------------------
# Auth
# ----------------------------------------------------------------------
@api.get("/auth/status")
def auth_status():
    configured = bool(current_app.config.get("PIN_HASH"))
    return jsonify(
        {
            "authenticated": bool(session.get("authenticated")),
            "pin_configured": configured,
        }
    )


@api.post("/auth/login")
def login():
    payload = request.get_json(silent=True) or {}
    pin = str(payload.get("pin", ""))

    pin_hash = current_app.config.get("PIN_HASH")
    if not pin_hash:
        return error_response(
            "No PIN is configured on the server. Set FILE_EXPLORER_PIN in .env.", 500
        )

    if not pin:
        return error_response("PIN is required", 400)

    if not check_password_hash(pin_hash, pin):
        current_app.logger.warning("Failed login attempt from %s", request.remote_addr)
        return error_response("Incorrect PIN", 401)

    session.permanent = True
    session["authenticated"] = True
    return jsonify({"authenticated": True})


@api.post("/auth/logout")
def logout():
    session.clear()
    return jsonify({"authenticated": False})


# ----------------------------------------------------------------------
# Listing and metadata
# ----------------------------------------------------------------------
@api.get("/files")
@login_required
def list_files():
    """List a folder's contents. ``?path=`` is relative to the storage root."""
    path = request.args.get("path", "")
    storage = get_storage()
    return jsonify(
        {
            "path": storage.to_rel(storage.resolve(path)),
            "items": [item.to_dict() for item in storage.list_dir(path)],
        }
    )


@api.get("/stat")
@login_required
def stat_item():
    path = request.args.get("path", "")
    return jsonify(get_storage().stat(path).to_dict())


# ----------------------------------------------------------------------
# Creating items
# ----------------------------------------------------------------------
@api.post("/folder")
@login_required
def create_folder():
    payload = request.get_json(silent=True) or {}
    item = get_storage().create_folder(payload.get("path", ""), payload.get("name", ""))
    return jsonify(item.to_dict()), 201


@api.post("/file")
@login_required
def create_file():
    payload = request.get_json(silent=True) or {}
    item = get_storage().create_file(payload.get("path", ""), payload.get("name", ""))
    return jsonify(item.to_dict()), 201


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
        # Raw body upload (used by the chunked/resumable path).
        stream = request.stream

    if not name:
        return error_response("A filename is required", 400)

    max_bytes = current_app.config.get("MAX_UPLOAD_BYTES") or None
    item = get_storage().write_stream(
        path, os.path.basename(name), stream, overwrite=overwrite, max_bytes=max_bytes
    )
    return jsonify(item.to_dict()), 201


# ----------------------------------------------------------------------
# Moving, copying, deleting
# ----------------------------------------------------------------------
@api.post("/move")
@login_required
def move():
    payload = request.get_json(silent=True) or {}
    item = get_storage().move(payload.get("from"), payload.get("to"))
    return jsonify(item.to_dict())


@api.post("/copy")
@login_required
def copy():
    payload = request.get_json(silent=True) or {}
    item = get_storage().copy(payload.get("from"), payload.get("to"))
    return jsonify(item.to_dict())


@api.delete("/files")
@login_required
def delete():
    path = request.args.get("path", "")
    get_storage().delete(path)
    return jsonify({"deleted": path})


@api.post("/duplicate")
@login_required
def duplicate():
    """Copy an item, auto-picking a free name (used by paste)."""
    payload = request.get_json(silent=True) or {}
    storage = get_storage()
    src = payload.get("path")
    parent = payload.get("parent", "")
    src_item = storage.stat(src)
    dest = storage.unique_destination(parent, src_item.name)
    return jsonify(storage.copy(src, dest).to_dict())


# ----------------------------------------------------------------------
# Download and media streaming
# ----------------------------------------------------------------------
def _parse_range(range_header: str, file_size: int):
    """Parse a single ``bytes=`` range. Returns (start, end) or None."""
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
    path = request.args.get("path", "")
    storage = get_storage()
    abs_path = storage.resolve(path)

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
    path = request.args.get("path", "")
    storage = get_storage()
    abs_path = storage.resolve(path)

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
# Share links
# ----------------------------------------------------------------------
def _base_url() -> str:
    return request.host_url.rstrip("/")


def _find_share(token: str):
    from models import Share

    share = Share.query.filter_by(token=token).first()
    if share is None or share.is_expired:
        return None
    return share


@api.post("/share")
@login_required
def create_share():
    from models import Share

    payload = request.get_json(silent=True) or {}
    path = payload.get("path", "")
    storage = get_storage()
    item = storage.stat(path)

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
    from models import Share

    share = Share.query.filter_by(token=token).first()
    if share is None:
        return error_response("Share link not found", 404)
    db.session.delete(share)
    db.session.commit()
    return jsonify({"revoked": token})


@api.get("/s/<token>")
def public_share(token: str):
    """Share link target under the API prefix.

    Deliberately unauthenticated: the token is the capability. Renders a small
    page that previews and offers the file, because a link pasted into a chat
    app is more useful when it shows what it is about to download. Append
    ``?download=1`` to get the raw bytes (which is what the page links to).
    """
    return _serve_share(token)


# The share URL handed to users is "/s/<token>" - no /api prefix - because it
# is meant to be pasted into a chat app. The blueprint is mounted under /api,
# so the bare path is registered separately against the same view.
share_urls = Blueprint("share_urls", __name__)


@share_urls.get("/s/<token>")
def public_share_root(token: str):
    return _serve_share(token)


def register_share_routes(app) -> None:
    """Mount the public share page at the top level, outside /api."""
    app.register_blueprint(share_urls)


def _serve_share(token: str):
    """Shared implementation behind both share URLs."""
    share = _find_share(token)
    if share is None:
        return error_response("Share link not found or expired", 404)

    storage = get_storage()
    try:
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
    from flask import render_template_string

    expires = (
        share.expires_at.strftime("%Y-%m-%d %H:%M")
        if share.expires_at
        else "never"
    )

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
    from models import Share

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
            "disk": {
                "total": usage.total,
                "used": usage.used,
                "free": usage.free,
            },
            "ffmpeg": bool(_ffmpeg_path()),
            "time": datetime.now().isoformat(timespec="seconds"),
        }
    )
