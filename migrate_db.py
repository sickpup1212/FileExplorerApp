"""One-off database maintenance.

The original ``models.py`` defined a ``files`` table (with a ``content`` BLOB)
for a virtual filesystem that was never used, because files were really kept in
browser IndexedDB. Files now live on disk under ``STORAGE_ROOT``, and the
database only stores share links.

This drops the leftover ``files`` table, but only when it is empty - if it
somehow holds rows, nothing is deleted and you are told about it instead.

    .venv\\Scripts\\python.exe migrate_db.py --dry-run
    .venv\\Scripts\\python.exe migrate_db.py
"""

from __future__ import annotations

import re
import sys

from app import app
from extensions import db
from sqlalchemy import inspect, text

LEGACY_TABLE = "files"


def redact(uri: str) -> str:
    return re.sub(r"://[^:]+:[^@]+@", "://***:***@", uri)


def main() -> int:
    dry_run = "--dry-run" in sys.argv

    with app.app_context():
        print(f"Database: {redact(app.config['SQLALCHEMY_DATABASE_URI'])}")

        inspector = inspect(db.engine)
        tables = inspector.get_table_names()
        print(f"Tables: {', '.join(tables) or '(none)'}")

        if LEGACY_TABLE not in tables:
            print(f"\nNothing to do: no '{LEGACY_TABLE}' table.")
            return 0

        row_count = db.session.execute(
            text(f"SELECT COUNT(*) FROM {LEGACY_TABLE}")
        ).scalar()

        if row_count:
            print(
                f"\nRefusing to drop '{LEGACY_TABLE}': it holds {row_count} row(s).\n"
                "Those bytes are not on disk, so export them before removing the table."
            )
            return 1

        if dry_run:
            print(f"\n[dry run] Would DROP TABLE {LEGACY_TABLE} (0 rows).")
            return 0

        db.session.execute(text(f"DROP TABLE {LEGACY_TABLE}"))
        db.session.commit()
        print(f"\nDropped unused '{LEGACY_TABLE}' table.")
        print(f"Tables now: {', '.join(inspect(db.engine).get_table_names())}")
        return 0


if __name__ == "__main__":
    sys.exit(main())
