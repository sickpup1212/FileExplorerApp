"""Database models.

The explorer's file *contents* live on disk (see ``storage.py``); the database
only holds share-link metadata.  Previously this module described a virtual
filesystem that was never actually used, because files were kept in browser
IndexedDB instead.
"""

import secrets
from datetime import datetime, timedelta

from extensions import db


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
    # Path relative to the storage root, e.g. "photos/holiday.jpg".
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
            "download_url": f"{base_url}/api/s/{self.token}",
            "created_at": int(self.created_at.timestamp() * 1000),
            "expires_at": int(self.expires_at.timestamp() * 1000) if self.expires_at else None,
            "expired": self.is_expired,
        }
