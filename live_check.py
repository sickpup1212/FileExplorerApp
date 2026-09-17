"""Live verification against a running server.

Unlike smoke_test.py (which uses Flask's in-process test client), this speaks
real HTTP to a real socket, so it also exercises waitress' streaming and
Range handling.

    .venv\\Scripts\\python.exe live_check.py [base_url] [pin]
"""

from __future__ import annotations

import http.client
import json
import os
import shutil
import subprocess
import sys
import urllib.parse
import urllib.request
from http.cookiejar import CookieJar

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8080"
PIN = sys.argv[2] if len(sys.argv) > 2 else "123456"

opener = urllib.request.build_opener(
    urllib.request.HTTPCookieProcessor(CookieJar())
)

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


def request(method: str, path: str, body=None, headers=None):
    url = f"{BASE}{path}"
    req = urllib.request.Request(url, data=body, method=method)
    for key, value in (headers or {}).items():
        req.add_header(key, value)
    try:
        with opener.open(req, timeout=60) as response:
            return response.status, response.read(), dict(response.headers)
    except urllib.error.HTTPError as error:
        return error.code, error.read(), dict(error.headers)


def post_json(path: str, payload: dict):
    return request(
        "POST",
        path,
        body=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )


def multipart(fields: dict, filename: str, content: bytes):
    """Build a multipart/form-data body for one file field."""
    boundary = "----LiveCheckBoundary1234567890"
    parts = []
    for name, value in fields.items():
        parts.append(
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode()
        )
    parts.append(
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'
        f"Content-Type: application/octet-stream\r\n\r\n".encode()
    )
    parts.append(content)
    parts.append(f"\r\n--{boundary}--\r\n".encode())
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


def main() -> int:
    workdir = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".live-tmp")
    shutil.rmtree(workdir, ignore_errors=True)
    os.makedirs(workdir, exist_ok=True)

    print(f"Target: {BASE}\n")

    print("== login ==")
    status, body, _ = post_json("/api/auth/login", {"pin": PIN})
    check("login succeeds", status == 200, f"{status} {body[:120]!r}")

    status, body, _ = request("GET", "/api/files?path=")
    check("can list root", status == 200, str(status))

    print("\n== folder + large upload (8 MB, multi-chunk) ==")
    post_json("/api/folder", {"path": "", "name": "livecheck"})

    # Deterministic pseudo-random bytes: compressible patterns would hide
    # corruption, so use a repeated hash block instead of zeros.
    import hashlib

    block = hashlib.sha256(b"seed").digest()
    payload = (block * ((8 * 1024 * 1024) // len(block) + 1))[: 8 * 1024 * 1024]

    body_bytes, content_type = multipart({"path": "livecheck", "name": "big.bin"}, "big.bin", payload)
    status, response_body, _ = request(
        "POST", "/api/upload", body=body_bytes, headers={"Content-Type": content_type}
    )
    check("8 MB upload accepted", status == 201, f"{status} {response_body[:160]!r}")
    if status == 201:
        info = json.loads(response_body)
        check("size reported correctly", info["size"] == len(payload), str(info.get("size")))

    print("\n== byte-exact download ==")
    status, downloaded, headers = request("GET", "/api/raw?path=livecheck/big.bin")
    check("download status 200", status == 200, str(status))
    check("downloaded bytes identical", downloaded == payload, f"{len(downloaded)} vs {len(payload)}")
    check("Accept-Ranges present", headers.get("Accept-Ranges") == "bytes", str(headers.get("Accept-Ranges")))

    print("\n== Range streaming (what video scrubbing uses) ==")
    status, chunk, headers = request(
        "GET", "/api/raw?path=livecheck/big.bin", headers={"Range": "bytes=1048576-1048775"}
    )
    check("range returns 206", status == 206, str(status))
    check("range returns exactly 200 bytes", len(chunk) == 200, str(len(chunk)))
    check("range bytes match source", chunk == payload[1048576:1048776])
    check(
        "Content-Range correct",
        headers.get("Content-Range") == f"bytes 1048576-1048775/{len(payload)}",
        str(headers.get("Content-Range")),
    )

    print("\n== real video: upload, stream, thumbnail ==")
    ffmpeg = shutil.which("ffmpeg")
    video_ok = False
    if ffmpeg:
        video_path = os.path.join(workdir, "clip.mp4")
        subprocess.run(
            [
                ffmpeg, "-hide_banner", "-loglevel", "error",
                "-f", "lavfi", "-i", "testsrc=size=640x480:rate=10:duration=3",
                "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-y", video_path,
            ],
            check=True,
            capture_output=True,
        )
        with open(video_path, "rb") as handle:
            video_bytes = handle.read()

        body_bytes, content_type = multipart(
            {"path": "livecheck", "name": "clip.mp4"}, "clip.mp4", video_bytes
        )
        status, response_body, _ = request(
            "POST", "/api/upload", body=body_bytes, headers={"Content-Type": content_type}
        )
        check("video upload accepted", status == 201, f"{status} {response_body[:160]!r}")

        status, chunk, headers = request(
            "GET", "/api/raw?path=livecheck/clip.mp4", headers={"Range": "bytes=0-2047"}
        )
        check("video range request works", status == 206 and len(chunk) == 2048, f"{status} {len(chunk)}")
        check("video mime is video/mp4", headers.get("Content-Type", "").startswith("video/mp4"), str(headers.get("Content-Type")))

        status, thumb, _ = request("GET", "/api/thumbnail?path=livecheck/clip.mp4&size=240")
        check("ffmpeg thumbnail generated", status == 200 and thumb[:2] == b"\xff\xd8", f"{status} {len(thumb)}")
        video_ok = True
    else:
        print("  SKIP  ffmpeg not found")

    print("\n== listing reflects server state ==")
    status, body, _ = request("GET", "/api/files?path=livecheck")
    items = {i["name"]: i for i in json.loads(body)["items"]}
    check("big.bin listed", "big.bin" in items)
    if video_ok:
        check("clip.mp4 listed", "clip.mp4" in items)
    for name, item in items.items():
        check(f"{name} has nonzero size", item["size"] > 0, str(item["size"]))

    print("\n== cleanup ==")
    status, _, _ = request("DELETE", "/api/files?path=livecheck")
    check("delete folder recursively", status == 200, str(status))
    status, body, _ = request("GET", "/api/files?path=livecheck")
    check("folder is gone", status == 404, str(status))

    shutil.rmtree(workdir, ignore_errors=True)

    print("\n" + "=" * 60)
    if FAILED:
        print(f"{len(FAILED)} FAILED, {PASSED} passed")
        for name in FAILED:
            print(f"  - {name}")
        return 1
    print(f"All {PASSED} live checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
