"""Development / production entry point.

Threaded rather than forking, because uploads and downloads are long-lived
streams: each active transfer occupies one thread for its duration.
"""

import os

from waitress import serve

from app import app

if __name__ == "__main__":
    host = os.environ.get("HOST", "0.0.0.0")
    # 8080 rather than 5000: on Windows, 5000 is frequently claimed by another
    # service or reserved by Hyper-V/WSL, which fails with WinError 10013.
    port = int(os.environ.get("PORT", "8080"))

    print(f"File Explorer serving on http://{host}:{port}")
    print(f"Storage root: {app.config['STORAGE_ROOT']}")
    print("Press Ctrl+C to stop.")

    serve(
        app,
        host=host,
        port=port,
        # Media transfers are large and slow; the default 1 GB ceiling would
        # reject multi-gigabyte video uploads.
        max_request_body_size=100 * 1024**3,
        channel_timeout=900,
        threads=8,
        # Stream request bodies instead of buffering them in memory.
        inbuf_overflow=1024 * 1024,
        outbuf_overflow=1024 * 1024,
        asyncore_use_poll=True,
        ident="FileExplorer",
    )
