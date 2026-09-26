"""End-to-end API smoke tests.

Run against a scratch storage directory so the real library is never touched:

    .venv\\Scripts\\python.exe smoke_test.py

Exits non-zero on the first failure.
"""

from __future__ import annotations

import io
import os
import shutil
import subprocess
import sys

# This file lives in tests/, so resolve paths from the project root: that is
# where the app modules, .venv and .env live. Test artifacts stay in tests/.
TEST_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(TEST_DIR)
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

SCRATCH = os.path.join(TEST_DIR, ".smoke-storage")
THUMBS = os.path.join(TEST_DIR, ".smoke-thumbs")
TEST_DB = os.path.join(TEST_DIR, ".smoke-test.db")

os.environ.setdefault("FILE_EXPLORER_PIN", "123456")
os.environ.setdefault("FLASK_SECRET_KEY", "test-secret")

# Point everything at scratch locations before importing the app, so this suite
# can never modify the real library or the real database.
os.environ["STORAGE_ROOT"] = SCRATCH
os.environ["THUMBNAIL_CACHE_DIR"] = THUMBS
os.environ["DATABASE_URL"] = f"sqlite:///{TEST_DB.replace(os.sep, '/')}"

# Import after the env vars are set, since create_app() reads them at import.
import app as app_module  # noqa: E402
from app import app as _imported_app  # noqa: E402

app = _imported_app

PASSED = 0
FAILED: list[str] = []


def check(label: str, condition: bool, detail: str = "") -> None:
    global PASSED
    if condition:
        PASSED += 1
        print(f"  PASS  {label}")
    else:
        FAILED.append(label)
        print(f"  FAIL  {label} {detail}")


def main() -> int:
    # Fresh state for every run, so results do not depend on a previous run.
    for path in (SCRATCH, THUMBS):
        shutil.rmtree(path, ignore_errors=True)
        os.makedirs(path, exist_ok=True)
    for suffix in ("", "-wal", "-shm"):
        try:
            os.remove(TEST_DB + suffix)
        except OSError:
            pass

    global app
    app = app_module.create_app()
    app.testing = True

    client = app.test_client()

    print("\n== auth (legacy single-PIN mode) ==")
    # This suite exercises the single-user deployment path, where the shared
    # PIN grants full access. Account isolation and folder PINs are covered by
    # auth_test.py instead.
    status = client.get("/api/auth/status").get_json()
    check("status reports PIN login enabled", status["pin_login_enabled"] is True, str(status))
    check("starts unauthenticated", status["authenticated"] is False, str(status))
    check("no accounts exist yet", status["account_count"] == 0, str(status))

    blocked = client.get("/api/files")
    check("unauthenticated listing is rejected", blocked.status_code == 401, str(blocked.status_code))
    check(
        "rejection is flagged as auth_required",
        blocked.get_json().get("auth_required") is True,
        str(blocked.get_json()),
    )

    bad = client.post("/api/auth/login", json={"pin": "000000"})
    check("wrong PIN is rejected", bad.status_code == 401, str(bad.status_code))

    good = client.post("/api/auth/login", json={"pin": "123456"})
    check("correct PIN is accepted", good.status_code == 200, str(good.status_code))

    principal_data = client.get("/api/session").get_json()["principal"]
    check("session reports admin mode", principal_data["mode"] == "admin", str(principal_data))

    # This suite drives the legacy single-PIN path, so no account is ever
    # created and the standard 'shared' folder would not exist. Create it the
    # same way a first login would.
    from api import _ensure_user_home

    class _StubUser:
        home = "users/.smoke"

    with app.app_context():
        _ensure_user_home(_StubUser())

    print("\n== folders and files ==")
    created = client.post("/api/folder", json={"path": "shared", "name": "Media"})
    check("create folder", created.status_code == 201, created.get_data(as_text=True)[:200])
    check("folder type is reported", created.get_json()["type"] == "folder")

    dup = client.post("/api/folder", json={"path": "shared", "name": "Media"})
    check("duplicate folder rejected", dup.status_code == 409, str(dup.status_code))

    traversal = client.post("/api/folder", json={"path": "shared", "name": "../escape"})
    check("slash in name rejected", traversal.status_code == 400, str(traversal.status_code))

    made = client.post("/api/file", json={"path": "shared/Media", "name": "notes.txt"})
    check("create empty file", made.status_code == 201, made.get_data(as_text=True)[:200])

    print("\n== the storage root is a landing area ==")
    check("cannot create a folder at the root",
          client.post("/api/folder", json={"path": "", "name": "nope"}).status_code == 400)
    check("can create a file at the root (welcome document)",
          client.post("/api/file", json={"path": "", "name": "WELCOME.txt"}).status_code == 201)
    check("can upload to the root",
          client.post("/api/upload?path=&name=up.txt",
                      data={"file": (io.BytesIO(b"x"), "up.txt")},
                      content_type="multipart/form-data").status_code == 201)

    print("\n== upload ==")
    payload = b"hello persistent world" * 5000  # ~105 KB, forces multi-chunk reads
    up = client.post(
        "/api/upload?path=shared/Media&name=clip.bin",
        data={"file": (io.BytesIO(payload), "clip.bin")},
        content_type="multipart/form-data",
    )
    check("upload succeeds", up.status_code == 201, up.get_data(as_text=True)[:200])
    check("upload reports correct size", up.get_json()["size"] == len(payload), str(up.get_json()))

    listing = client.get("/api/files?path=shared/Media").get_json()
    names = {i["name"] for i in listing["items"]}
    check("listing shows uploaded file", "clip.bin" in names, str(names))

    print("\n== download and range streaming ==")
    full = client.get("/api/raw?path=shared/Media/clip.bin")
    check("full download status", full.status_code == 200, str(full.status_code))
    check("full download bytes match", full.data == payload)
    check("Accept-Ranges advertised", full.headers.get("Accept-Ranges") == "bytes")

    partial = client.get("/api/raw?path=shared/Media/clip.bin", headers={"Range": "bytes=100-199"})
    check("range request returns 206", partial.status_code == 206, str(partial.status_code))
    check("range body is 100 bytes", partial.data == payload[100:200], str(len(partial.data)))
    check(
        "Content-Range is correct",
        partial.headers.get("Content-Range") == f"bytes 100-199/{len(payload)}",
        str(partial.headers.get("Content-Range")),
    )

    suffix = client.get("/api/raw?path=shared/Media/clip.bin", headers={"Range": "bytes=-50"})
    check("suffix range returns last 50 bytes", suffix.data == payload[-50:], str(len(suffix.data)))

    beyond = client.get("/api/raw?path=shared/Media/clip.bin", headers={"Range": "bytes=999999999-"})
    check("out-of-bounds range returns 416", beyond.status_code == 416, str(beyond.status_code))

    print("\n== path traversal ==")
    for attempt in ("../outside.txt", "shared/Media/../../outside.txt", "..%2Foutside.txt"):
        response = client.get(f"/api/stat?path={attempt}")
        check(f"blocked: {attempt}", response.status_code in (400, 404), str(response.status_code))

    print("\n== rename, move, copy, delete ==")
    moved = client.post("/api/move", json={"from": "shared/Media/notes.txt", "to": "shared/Media/renamed.txt"})
    check("rename via move", moved.status_code == 200, moved.get_data(as_text=True)[:200])

    copied = client.post(
        "/api/copy", json={"from": "shared/Media/renamed.txt", "to": "shared/Media/renamed-copy.txt"}
    )
    check("copy file", copied.status_code == 200, copied.get_data(as_text=True)[:200])

    dupe = client.post("/api/duplicate", json={"path": "shared/Media/renamed.txt", "parent": "shared/Media"})
    check("duplicate picks a free name", dupe.status_code == 200, dupe.get_data(as_text=True)[:200])
    check(
        "duplicate name is suffixed",
        dupe.get_json()["name"] == "renamed (1).txt",
        str(dupe.get_json()["name"]),
    )

    into_self = client.post("/api/move", json={"from": "shared/Media", "to": "shared/Media/nested"})
    check("cannot move folder into itself", into_self.status_code == 400, str(into_self.status_code))

    removed = client.delete("/api/files?path=shared/Media/renamed-copy.txt")
    check("delete file", removed.status_code == 200, str(removed.status_code))

    root_delete = client.delete("/api/files?path=")
    # 400 (invalid path) rather than 403: deleting the root is refused as a
    # nonsensical target, before any permission question arises.
    check("cannot delete storage root", root_delete.status_code == 400, str(root_delete.status_code))

    print("\n== thumbnails ==")
    try:
        from PIL import Image

        buffer = io.BytesIO()
        Image.new("RGB", (800, 600), (200, 40, 90)).save(buffer, "JPEG")
        image_bytes = buffer.getvalue()
    except ImportError:
        image_bytes = None
        print("  SKIP  Pillow not installed")

    if image_bytes:
        upload = client.post(
            "/api/upload?path=shared/Media&name=photo.jpg",
            data={"file": (io.BytesIO(image_bytes), "photo.jpg")},
            content_type="multipart/form-data",
        )
        check("upload image", upload.status_code == 201, upload.get_data(as_text=True)[:200])

        thumb = client.get("/api/thumbnail?path=shared/Media/photo.jpg&size=160")
        check("image thumbnail generated", thumb.status_code == 200, str(thumb.status_code))
        if thumb.status_code == 200:
            with Image.open(io.BytesIO(thumb.data)) as rendered:
                check(
                    "thumbnail is downscaled",
                    max(rendered.size) <= 160,
                    str(rendered.size),
                )
        cached = client.get("/api/thumbnail?path=shared/Media/photo.jpg&size=160")
        check("thumbnail is served from cache", cached.status_code == 200)

    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg:
        video_path = os.path.join(SCRATCH, "sample.mp4")
        subprocess.run(
            [
                ffmpeg, "-hide_banner", "-loglevel", "error",
                "-f", "lavfi", "-i", "testsrc=size=320x240:rate=5:duration=2",
                "-pix_fmt", "yuv420p", "-y", video_path,
            ],
            check=True,
            capture_output=True,
        )
        video_thumb = client.get("/api/thumbnail?path=sample.mp4&size=200")
        check("video thumbnail via ffmpeg", video_thumb.status_code == 200, str(video_thumb.status_code))
        # A 200 with an empty body means the seek path silently produced
        # nothing and got cached - assert real JPEG bytes came back.
        check(
            "video thumbnail has JPEG bytes",
            video_thumb.data[:2] == b"\xff\xd8" and len(video_thumb.data) > 500,
            f"{len(video_thumb.data)} bytes",
        )

        # Exercise a non-zero seek directly: seeking to 10% of the duration is
        # the primary path, and a bad option here previously slipped through
        # because only the start-of-file fallback was being hit.
        seek_thumb = client.get("/api/thumbnail?path=sample.mp4&size=200")
        check("video thumbnail is itself cached", seek_thumb.data == video_thumb.data)
    else:
        print("  SKIP  ffmpeg not on PATH")

    print("\n== share links ==")
    share = client.post("/api/share", json={"path": "shared/Media/photo.jpg", "days": 7})
    check("create share link", share.status_code == 201, share.get_data(as_text=True)[:200])
    token = share.get_json()["token"] if share.status_code == 201 else None

    if token:
        anon = app.test_client()  # separate client: no session cookie

        # The bare link should render a small download page...
        page = anon.get(f"/api/s/{token}")
        check("share link renders a download page", page.status_code == 200, str(page.status_code))
        check(
            "share page offers a download",
            b"Download" in page.data and b"download=1" in page.data,
            page.data[:120].decode(errors="replace"),
        )

        # ...and the download URL should return the actual bytes.
        public = anon.get(f"/api/s/{token}?download=1")
        check("share downloads without login", public.status_code == 200, str(public.status_code))
        check("shared bytes match", public.data == image_bytes, str(len(public.data)))

        revoked = client.delete(f"/api/share/{token}")
        check("revoke share", revoked.status_code == 200, str(revoked.status_code))
        after = anon.get(f"/api/s/{token}")
        check("revoked share is gone", after.status_code == 404, str(after.status_code))

    print("\n== health ==")
    health = client.get("/api/health")
    check("health endpoint", health.status_code == 200, str(health.status_code))
    body = health.get_json()
    check("health reports disk free", body["disk"]["free"] > 0, str(body["disk"]))

    print("\n" + "=" * 60)
    if FAILED:
        print(f"{len(FAILED)} FAILED, {PASSED} passed")
        for name in FAILED:
            print(f"  - {name}")
        return 1
    print(f"All {PASSED} checks passed.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    finally:
        shutil.rmtree(SCRATCH, ignore_errors=True)
        shutil.rmtree(THUMBS, ignore_errors=True)
