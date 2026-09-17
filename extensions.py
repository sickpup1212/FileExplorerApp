"""Shared extension objects.

These live here rather than in ``app.py`` so that ``api.py`` and ``models.py``
can use them without importing ``app``.  Importing ``app`` from a module that
``app`` itself imports creates a cycle, which raises::

    ImportError: cannot import name 'api' from partially initialized module 'api'

That failure only appeared when ``api`` was the entry point (for example when
running ``python api.py`` or starting the server from a different working
directory), because starting from ``app`` happened to resolve the names in a
workable order.  A separate module removes the cycle entirely.
"""

from flask_sqlalchemy import SQLAlchemy
from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    pass


db = SQLAlchemy(model_class=Base)
