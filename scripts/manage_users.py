"""Account management from the command line.

Useful for removing accounts created in error, or for checking who exists.

Run from the project root:

    .venv\\Scripts\\python.exe scripts\\manage_users.py list
    .venv\\Scripts\\python.exe scripts\\manage_users.py add <name> [password]
    .venv\\Scripts\\python.exe scripts\\manage_users.py delete <name> [--keep-files]
    .venv\\Scripts\\python.exe scripts\\manage_users.py passwd <name>

Deleting an account removes its database row; its home directory under
``users/<name>`` is removed too unless ``--keep-files`` is given.
"""

from __future__ import annotations

import getpass
import os
import re
import shutil
import sys

# Python puts this script's own directory (scripts/) on sys.path, not the
# project root, so add the root before importing the app modules.
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from app import app
from extensions import db
from models import User, validate_password, validate_username


def redact(uri: str) -> str:
    return re.sub(r"://[^:]+:[^@]+@", "://***:***@", uri)


def cmd_list() -> int:
    users = User.query.order_by(User.username).all()
    if not users:
        print("No accounts exist.")
        return 0

    print(f"{len(users)} account(s):\n")
    for user in users:
        print(f"  {user.username:<20} admin={str(user.is_admin):<5} home={user.home}")
    return 0


def cmd_add(username: str, password: str | None) -> int:
    try:
        name = validate_username(username)
    except ValueError as exc:
        print(f"error: {exc}")
        return 1

    if User.query.filter_by(username=name).first():
        print(f"error: '{name}' already exists")
        return 1

    if not password:
        password = getpass.getpass(f"Password for {name}: ")
        if password != getpass.getpass("Repeat: "):
            print("error: passwords did not match")
            return 1

    try:
        validate_password(password)
    except ValueError as exc:
        print(f"error: {exc}")
        return 1

    user = User(username=name)
    user.set_password(password)
    user.is_admin = User.query.count() == 0
    db.session.add(user)
    db.session.commit()

    storage = app.extensions["storage"]
    for path in ("shared", user.home):
        try:
            import os

            os.makedirs(storage.resolve(path, must_exist=False), exist_ok=True)
        except OSError:
            pass

    print(f"Created '{name}'{' (admin)' if user.is_admin else ''}.")
    return 0


def cmd_delete(username: str, keep_files: bool) -> int:
    name = validate_username(username)
    user = User.query.filter_by(username=name).first()
    if user is None:
        print(f"error: no such account '{name}'")
        return 1

    remaining = User.query.count() - 1
    if remaining == 0:
        print(
            "warning: this is the last account. With none left, only the shared "
            "PIN protects the app."
        )

    home = user.home
    db.session.delete(user)
    db.session.commit()
    print(f"Deleted account '{name}'.")

    if not keep_files:
        storage = app.extensions["storage"]
        try:
            storage.delete(home)
            print(f"Removed files at '{home}'.")
        except Exception as exc:  # noqa: BLE001
            print(f"Could not remove '{home}': {exc}")
    else:
        print(f"Kept files at '{home}'.")

    return 0


def cmd_passwd(username: str) -> int:
    name = validate_username(username)
    user = User.query.filter_by(username=name).first()
    if user is None:
        print(f"error: no such account '{name}'")
        return 1

    password = getpass.getpass(f"New password for {name}: ")
    if password != getpass.getpass("Repeat: "):
        print("error: passwords did not match")
        return 1
    try:
        user.set_password(password)
    except ValueError as exc:
        print(f"error: {exc}")
        return 1

    db.session.commit()
    print("Password updated.")
    return 0


def main() -> int:
    argv = sys.argv[1:]
    if not argv:
        print(__doc__)
        return 1

    command, rest = argv[0], argv[1:]

    with app.app_context():
        print(f"Database: {redact(app.config['SQLALCHEMY_DATABASE_URI'])}\n")

        if command == "list":
            return cmd_list()
        if command == "add":
            if not rest:
                print("usage: manage_users.py add <name> [password]")
                return 1
            return cmd_add(rest[0], rest[1] if len(rest) > 1 else None)
        if command == "delete":
            if not rest:
                print("usage: manage_users.py delete <name> [--keep-files]")
                return 1
            return cmd_delete(rest[0], "--keep-files" in rest)
        if command == "passwd":
            if not rest:
                print("usage: manage_users.py passwd <name>")
                return 1
            return cmd_passwd(rest[0])

        print(f"unknown command '{command}'")
        print(__doc__)
        return 1


if __name__ == "__main__":
    sys.exit(main())
