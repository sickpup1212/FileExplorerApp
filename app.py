"""Application entry point.

Serves the single-page explorer UI and mounts the REST API defined in
``api.py``.  File bytes live on disk under ``STORAGE_ROOT``; nothing about the
user's files is kept in the browser any more.
"""

from __future__ import annotations

import importlib.util
import os
import secrets
from datetime import timedelta

from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request, send_from_directory
from werkzeug.security import generate_password_hash

from extensions import Base, db

load_dotenv()

BASE_DIR = os.path.dirname(os.path.abspath(__file__))


def _resolve_path(value: str, default: str) -> str:
    """Resolve a configured directory to an absolute path."""
    path = value or default
    if not os.path.isabs(path):
        path = os.path.join(BASE_DIR, path)
    return os.path.abspath(path)


def _upload_limit() -> int | None:
    """Per-file upload ceiling, or None for unlimited."""
    megabytes = int(os.environ.get("MAX_UPLOAD_MB", "0") or 0)
    return megabytes * 1024 * 1024 if megabytes > 0 else None


def _load_pin_hash() -> tuple[str | None, str | None]:
    """Return (hash, plaintext-if-generated) for the access PIN."""
    plain = os.environ.get("FILE_EXPLORER_PIN")
    if plain:
        return generate_password_hash(plain), None

    existing_hash = os.environ.get("FILE_EXPLORER_PIN_HASH")
    if existing_hash:
        return existing_hash, None

    # No PIN configured: generate one and print it so the first run is not
    # silently unprotected.
    generated = f"{secrets.randbelow(10**6):06d}"
    return generate_password_hash(generated), generated


def _secret_key() -> str:
    """A session key that survives restarts, so logins are not lost on reboot.

    A random key per process would silently invalidate every existing session
    every time the server restarts, which is a confusing failure mode.
    """
    configured = os.environ.get("FLASK_SECRET_KEY")
    if configured:
        return configured

    key_file = os.path.join(BASE_DIR, ".secret_key")
    try:
        if os.path.exists(key_file):
            with open(key_file, "r", encoding="utf-8") as handle:
                stored = handle.read().strip()
            if stored:
                return stored

        generated = secrets.token_hex(32)
        with open(key_file, "w", encoding="utf-8") as handle:
            handle.write(generated)
        os.chmod(key_file, 0o600)
        return generated
    except OSError:
        # Read-only filesystem: fall back to an ephemeral key.
        return secrets.token_hex(32)


def _database_uri(app: Flask) -> str:
    """Pick a database URL, degrading gracefully when a driver is missing.

    A ``DATABASE_URL`` pointing at Postgres is intended for deployment.  If the
    driver for it is not installed, falling back to local SQLite keeps the app
    usable instead of failing at startup: the database only stores share-link
    metadata, so losing it costs nothing but those links.
    """
    configured = os.environ.get("DATABASE_URL", "").strip()
    sqlite_default = f"sqlite:///{os.path.join(BASE_DIR, 'file_explorer.db').replace(os.sep, '/')}"

    if not configured:
        return sqlite_default
    if configured.startswith("sqlite"):
        return configured

    module = "psycopg2" if configured.startswith("postgres") else None
    if module and importlib.util.find_spec(module) is None:
        app.logger.warning(
            "DATABASE_URL is set but '%s' is not installed; using local SQLite "
            "instead. Install it (pip install psycopg2-binary) to use that "
            "database. Do not log DATABASE_URL itself - it contains credentials "
            "if it is a hosted database.",
            module,
        )
        return sqlite_default

    return configured


def _is_sqlite_connection(dbapi_connection) -> bool:
    """True when the DBAPI connection is a sqlite3 connection.

    Checked by capability rather than module name, which varies across builds
    and wrappers.
    """
    cursor = dbapi_connection.cursor()
    try:
        cursor.execute("PRAGMA journal_mode")
        cursor.fetchone()
        return True
    except Exception:  # noqa: BLE001 - any failure means "not SQLite"
        return False
    finally:
        cursor.close()


def _configure_sqlite(app: Flask) -> None:
    """Make SQLite safe for a multi-threaded server.

    Waitress serves requests on several threads, and SQLite's default rollback
    journal returns "database is locked" under concurrent writers.  WAL mode
    plus a busy timeout avoids spurious failures on share-link creation.
    """
    if not app.config["SQLALCHEMY_DATABASE_URI"].startswith("sqlite"):
        return

    from sqlalchemy import event
    from sqlalchemy.engine import Engine

    @event.listens_for(Engine, "connect")
    def _set_sqlite_pragmas(dbapi_connection, _connection_record):
        if not _is_sqlite_connection(dbapi_connection):
            return
        cursor = dbapi_connection.cursor()
        try:
            cursor.execute("PRAGMA journal_mode=WAL")
            cursor.execute("PRAGMA synchronous=NORMAL")
            cursor.execute("PRAGMA busy_timeout=5000")
        finally:
            cursor.close()


def create_app() -> Flask:
    from api import api, register_share_routes
    from storage import Storage

    app = Flask(__name__, static_folder="static", template_folder="templates")

    storage_root = _resolve_path(os.environ.get("STORAGE_ROOT", ""), "storage")
    thumb_cache = _resolve_path(os.environ.get("THUMBNAIL_CACHE_DIR", ""), ".thumbs")

    pin_hash, generated_pin = _load_pin_hash()

    app.config.update(
        SECRET_KEY=_secret_key(),
        # Sessions survive a restart only with a fixed key; 30 days keeps a
        # phone logged in without re-entering the PIN constantly.
        PERMANENT_SESSION_LIFETIME=timedelta(days=30),
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Lax",
        # Required once the app is served over HTTPS via a tunnel; harmless on
        # plain HTTP LAN access, where the cookie is still sent.
        SESSION_COOKIE_SECURE=os.environ.get("COOKIE_SECURE", "0") == "1",
        MAX_CONTENT_LENGTH=None,  # enforced per-upload instead, so errors are JSON
        # 0 means "no limit"; useful for multi-gigabyte media transfers.
        MAX_UPLOAD_BYTES=_upload_limit(),
        THUMBNAIL_CACHE_DIR=thumb_cache,
        THUMBNAIL_TIMEOUT=int(os.environ.get("THUMBNAIL_TIMEOUT", "20")),
        PIN_HASH=pin_hash,
        API_TOKEN=os.environ.get("FILE_EXPLORER_TOKEN"),
        SQLALCHEMY_DATABASE_URI=_database_uri(app),
        SQLALCHEMY_ENGINE_OPTIONS={"pool_recycle": 300, "pool_pre_ping": True},
        STORAGE_ROOT=storage_root,
    )

    app.extensions["storage"] = Storage(storage_root)

    db.init_app(app)
    _configure_sqlite(app)

    with app.app_context():
        import models  # noqa: F401  (registers tables)

        db.create_all()

    app.register_blueprint(api)
    # Share links are pasted into chat apps as "/s/<token>", outside /api.
    register_share_routes(app)

    if generated_pin:
        app.logger.warning(
            "No FILE_EXPLORER_PIN set - generated PIN for this run: %s\n"
            "Set FILE_EXPLORER_PIN in .env to make it permanent.",
            generated_pin,
        )

    @app.route("/")
    def index():
        return render_template("index.html")

    @app.route("/static/<path:path>")
    def serve_static(path):
        return send_from_directory("static", path)

    @app.errorhandler(404)
    def not_found(_error):
        # Return an honest 404. Previously every unknown path rendered the SPA
        # shell with a 200 status, which hid broken links and confused clients.
        if request.path.startswith("/api/") or request.accept_mimetypes.best == "application/json":
            return jsonify({"error": "Not found"}), 404
        return (
            "<!doctype html><title>404</title>"
            "<h1>404 - Not found</h1><p><a href='/'>Back to the file explorer</a></p>",
            404,
            {"Content-Type": "text/html; charset=utf-8"},
        )

    @app.errorhandler(500)
    def server_error(error):  # pragma: no cover - defensive
        app.logger.exception("Unhandled error: %s", error)
        return jsonify({"error": "Internal server error"}), 500

    return app


app = create_app()
