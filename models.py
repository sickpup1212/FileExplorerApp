"""Database models.

File *contents* always live on disk (see ``storage.py``).  The database holds
accounts, per-directory PIN protection, and share links.

Storage layout::

    <STORAGE_ROOT>/shared/            visible to every account
    <STORAGE_ROOT>/users/<name>/      private to that account
    <STORAGE_ROOT>/...                legacy files, visible to every account

Per-user homes live under a ``users/`` prefix rather than at the root, so the
mapping from a username to a directory stays unambiguous and the ``users/``
listing itself can be hidden from browsing.
"""

import re
import secrets
from datetime import datetime, timedelta

from werkzeug.security import check_password_hash, generate_password_hash

from extensions import db

SHARED_PREFIX = "shared"
USERS_PREFIX = "users"

# Usernames become directory names, so they are restricted to a conservative
# character set that is safe on Windows and cannot collide with path syntax.
USERNAME_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._-]{1,31}$")

RESERVED_USERNAMES = {
    "shared", "users", "root", "admin", "administrator", "system",
    "public", "private", "null", "none", "me", "self", "api", "static",
}

MIN_PASSWORD_LENGTH = 8


def normalize_username(username: str) -> str:
    return (username or "").strip().lower()


def validate_username(username: str) -> str:
    """Return the normalised username, or raise ValueError."""
    normalized = normalize_username(username)

    if not normalized:
        raise ValueError("Username is required")
    if not USERNAME_PATTERN.match(normalized):
        raise ValueError(
            "Username must start with a letter or number, be 2-32 characters, "
            "and use only letters, numbers, dots, dashes and underscores"
        )
    if normalized in RESERVED_USERNAMES:
        raise ValueError(f"'{normalized}' is reserved")
    return normalized


def validate_password(password: str) -> str:
    if not password or len(password) < MIN_PASSWORD_LENGTH:
        raise ValueError(f"Password must be at least {MIN_PASSWORD_LENGTH} characters")
    return password


class User(db.Model):
    __tablename__ = "users"

    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(32), nullable=False, unique=True, index=True)
    display_name = db.Column(db.String(64), nullable=True)
    password_hash = db.Column(db.String(255), nullable=False)
    is_admin = db.Column(db.Boolean, default=False, nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.now, nullable=False)
    last_login_at = db.Column(db.DateTime, nullable=True)

    pins = db.relationship(
        "DirectoryPin", backref="owner", lazy=True, cascade="all, delete-orphan"
    )

    def set_password(self, password: str) -> None:
        self.password_hash = generate_password_hash(validate_password(password))

    def check_password(self, password: str) -> bool:
        return check_password_hash(self.password_hash, password or "")

    @property
    def home(self) -> str:
        """Path of this user's private space, relative to the storage root."""
        return f"{USERS_PREFIX}/{self.username}"

    def to_dict(self) -> dict:
        return {
            "username": self.username,
            "display_name": self.display_name or self.username,
            "is_admin": self.is_admin,
            "home": self.home,
            "created_at": int(self.created_at.timestamp() * 1000),
        }


class DirectoryPin(db.Model):
    """An optional PIN protecting one directory.

    Anyone presenting the PIN gets read-only access to that directory and its
    descendants, and nothing else.  The PIN is the capability; the token in the
    share URL identifies which directory without revealing the PIN itself.
    """

    __tablename__ = "directory_pins"

    id = db.Column(db.Integer, primary_key=True)
    # Path relative to the storage root, e.g. "users/alice/private".
    path = db.Column(db.String(1024), nullable=False, unique=True, index=True)
    # Random identifier used in the share URL ("/unlock/<token>").
    token = db.Column(
        db.String(64),
        nullable=False,
        unique=True,
        index=True,
        default=lambda: secrets.token_urlsafe(16),
    )
    pin_hash = db.Column(db.String(255), nullable=False)
    owner_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.now, nullable=False)

    def set_pin(self, pin: str) -> None:
        pin = (pin or "").strip()
        if not pin:
            raise ValueError("PIN is required")
        self.pin_hash = generate_password_hash(pin)

    def check_pin(self, pin: str) -> bool:
        return check_password_hash(self.pin_hash, (pin or "").strip())

    def to_dict(self, base_url: str = "") -> dict:
        return {
            "path": self.path,
            "name": self.path.rsplit("/", 1)[-1],
            "url": f"{base_url}/unlock/{self.token}",
            "created_at": int(self.created_at.timestamp() * 1000),
            "owner": self.owner.username if self.owner else None,
        }


class Share(db.Model):
    """A public, expiring link to a single file."""

    __tablename__ = "shares"

    id = db.Column(db.Integer, primary_key=True)
    token = db.Column(
        db.String(64),
        nullable=False,
        unique=True,
        default=lambda: secrets.token_urlsafe(24),
        index=True,
    )
    path = db.Column(db.String(1024), nullable=False)
    name = db.Column(db.String(255), nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.now, nullable=False)
    expires_at = db.Column(db.DateTime, nullable=True)

    @property
    def is_expired(self) -> bool:
        return self.expires_at is not None and self.expires_at < datetime.now()

    @staticmethod
    def default_expiry(days: int = 7) -> datetime:
        return datetime.now() + timedelta(days=days)

    def to_dict(self, base_url: str = "") -> dict:
        return {
            "token": self.token,
            "name": self.name,
            "url": f"{base_url}/s/{self.token}",
            "download_url": f"{base_url}/api/s/{self.token}?download=1",
            "created_at": int(self.created_at.timestamp() * 1000),
            "expires_at": int(self.expires_at.timestamp() * 1000) if self.expires_at else None,
            "expired": self.is_expired,
        }
