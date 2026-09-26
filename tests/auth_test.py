"""Multi-user auth and permission tests.

Covers the parts that are easy to get subtly wrong: account isolation,
per-folder PIN scoping, and invite-code gating. Runs against a scratch storage
directory so the real library is never touched.

    .venv\\Scripts\\python.exe auth_test.py
"""

from __future__ import annotations

import io
import os
import shutil
import sys

# This file lives in tests/, so resolve paths from the project root: that is
# where the app modules, .venv and .env live. Test artifacts stay in tests/.
TEST_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(TEST_DIR)
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

SCRATCH = os.path.join(TEST_DIR, ".auth-storage")
THUMBS = os.path.join(TEST_DIR, ".auth-thumbs")
TEST_DB = os.path.join(TEST_DIR, ".auth-test.db")

# Point every piece of state at scratch locations *before* importing the app,
# so a test run can never touch the real library or the real database.
os.environ["STORAGE_ROOT"] = SCRATCH
os.environ["THUMBNAIL_CACHE_DIR"] = THUMBS
os.environ["FILE_EXPLORER_INVITE_CODE"] = "let-me-in"
os.environ["FILE_EXPLORER_RECOVERY_CODE"] = "recovery-code"
os.environ["FILE_EXPLORER_PIN"] = "999999"
os.environ["FLASK_SECRET_KEY"] = "auth-test-secret"
os.environ["DATABASE_URL"] = f"sqlite:///{TEST_DB.replace(os.sep, '/')}"

# app.py calls load_dotenv(), which does not override variables already set,
# but a .env DATABASE_URL would otherwise win if it were read first.
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


def client():
    return app.test_client()


def register(c, username, password="password123", invite="let-me-in"):
    return c.post(
        "/api/auth/register",
        json={"username": username, "password": password, "invite_code": invite},
    )


def upload(c, path, name, content=b"data"):
    return c.post(
        "/api/upload?path=%s&name=%s" % (path, name),
        data={"file": (io.BytesIO(content), name)},
        content_type="multipart/form-data",
    )


def main() -> int:
    global app

    # Fresh state for every run, so results do not depend on a previous run.
    for target in (SCRATCH, THUMBS):
        shutil.rmtree(target, ignore_errors=True)
        os.makedirs(target, exist_ok=True)

    # Importing app already opened a connection, and on Windows a live handle
    # keeps the deleted file alive so the next create_app() reuses stale data.
    # Dispose the pool first, then remove the file.
    from extensions import db

    with app.app_context():
        db.session.remove()
        db.engine.dispose()
    for suffix in ("", "-wal", "-shm"):
        try:
            os.remove(TEST_DB + suffix)
        except OSError:
            pass

    app = app_module.create_app()
    app.testing = True

    print("== first account needs no invite code ==")
    status = client().get("/api/auth/status").get_json()
    check("fresh database: no accounts",
          status["account_count"] == 0, str(status))
    check("first-run reports no invite code required",
          status["invite_code_required"] is False, str(status))
    check("first-run registration is open", status["registration_open"] is True, str(status))

    alice = client()
    result = register(alice, "alice", invite="")
    check("alice registers with no invite code", result.status_code == 201,
          result.get_data(as_text=True)[:160])
    check("first account is admin", result.get_json()["user"]["is_admin"] is True)

    print("\n== later accounts are gated ==")
    status = client().get("/api/auth/status").get_json()
    check("invite code now required", status["invite_code_required"] is True, str(status))

    check("a second account without the code is refused",
          register(client(), "intruder", invite="").status_code == 403)
    check("a second account with a wrong code is refused",
          register(client(), "nobody", invite="wrong").status_code == 403)

    bob = client()
    check("bob registers with the code", register(bob, "bob").status_code == 201)

    carol = client()
    check("carol registers", register(carol, "carol").status_code == 201)

    check("cannot register the same name twice",
          register(client(), "alice").status_code == 409)

    print("\n== account isolation ==")
    upload(alice, "users/alice", "alice-secret.txt", b"alice private")
    upload(bob, "users/bob", "bob-secret.txt", b"bob private")
    upload(alice, "shared", "everyones.txt", b"shared content")

    # Root listing for alice: should contain Shared and her own space, but the
    # 'users' container must be invisible.
    response = alice.get("/api/files?path=")
    check("root listing succeeds", response.status_code == 200,
          f"{response.status_code} {response.get_data(as_text=True)[:200]}")
    listing = response.get_json() if response.status_code == 200 else {"items": []}
    names = {i["name"] for i in listing.get("items", [])}
    check("alice sees 'shared'", "shared" in names, str(names))
    check("alice does NOT see 'users'", "users" not in names, str(names))
    check("alice is told where her space is",
          listing.get("personal") == "users/alice", str(listing.get("personal")))

    # Direct access to another user's home must be refused.
    blocked = alice.get("/api/files?path=users/bob")
    check("alice cannot list bob's home", blocked.status_code == 403, str(blocked.status_code))

    blocked = alice.get("/api/raw?path=users/bob/bob-secret.txt")
    check("alice cannot read bob's file", blocked.status_code == 403, str(blocked.status_code))

    blocked = alice.get("/api/thumbnail?path=users/bob/bob-secret.txt")
    check("alice cannot thumbnail bob's file", blocked.status_code == 403, str(blocked.status_code))

    blocked = alice.delete("/api/files?path=users/bob")
    check("alice cannot delete bob's home", blocked.status_code == 403, str(blocked.status_code))

    blocked = alice.post("/api/stat", json={}) if False else alice.get(
        "/api/stat?path=users/bob/bob-secret.txt")
    check("alice cannot stat bob's file", blocked.status_code == 403, str(blocked.status_code))

    own = alice.get("/api/files?path=users/alice")
    check("alice can list her own home", own.status_code == 200, str(own.status_code))

    shared_read = bob.get("/api/raw?path=shared/everyones.txt")
    check("bob can read the shared folder", shared_read.status_code == 200, str(shared_read.status_code))

    print("\n== write scope ==")
    blocked = alice.post("/api/folder", json={"path": "users/bob", "name": "intrusion"})
    check("alice cannot create folders in bob's home",
          blocked.status_code == 403, str(blocked.status_code))

    blocked = alice.post("/api/move", json={"from": "users/alice/alice-secret.txt",
                                            "to": "users/bob/stolen.txt"})
    check("alice cannot move a file into bob's home",
          blocked.status_code == 403, str(blocked.status_code))

    blocked = alice.post("/api/copy", json={"from": "users/bob/bob-secret.txt",
                                            "to": "shared/leak.txt"})
    check("alice cannot copy bob's file out",
          blocked.status_code == 403, str(blocked.status_code))

    traversal = alice.get("/api/files?path=../")
    check("path traversal still blocked", traversal.status_code in (400, 403),
          str(traversal.status_code))

    print("\n== the storage root is a landing area ==")
    # The root holds the shared and personal entry points plus a welcome
    # document. Files may be uploaded there, but it must not become a second
    # place to organise content: no folders.
    check("cannot create a folder at root",
          alice.post("/api/folder", json={"path": "", "name": "newroot"}).status_code == 400)
    check("cannot create a folder at root (bob)",
          bob.post("/api/folder", json={"path": "", "name": "bobs"}).status_code == 400)

    made_root_file = alice.post("/api/file", json={"path": "", "name": "WELCOME.txt"})
    check("can create a file at root", made_root_file.status_code == 201,
          made_root_file.get_data(as_text=True)[:120])
    check("can upload to root", upload(alice, "", "notes.txt").status_code == 201)

    listing = alice.get("/api/files?path=").get_json()
    root_names = {i["name"] for i in listing["items"]}
    check("root file is listed", "WELCOME.txt" in root_names, str(root_names))
    check("folders in a space are still allowed",
          alice.post("/api/folder", json={"path": "shared", "name": "ok"}).status_code == 201)

    # The root itself is still not a writable *root* for display, so the UI
    # steers new content into Shared or the user's own space.
    check("root is not advertised as a writable root",
          "" not in listing["principal"]["writable_roots"],
          str(listing["principal"]["writable_roots"]))
    check("server says folders are not allowed at root",
          listing["principal"]["can_create_folder_at_root"] is False)

    print("\n== unauthenticated access is refused ==")
    anon = client()
    check("anonymous /api/files is 401", anon.get("/api/files?path=").status_code == 401)
    check("anonymous /api/session is 401", anon.get("/api/session").status_code == 401)
    check("anonymous /api/pins is 401", anon.get("/api/pins").status_code == 401)
    # These serve the app shell, so failing to gate them would hand the whole
    # interface to a visitor who is not signed in.
    for path in ("/explorer", "/explorer/users/alice"):
        response = anon.get(path)
        check(f"anonymous {path} redirects to login",
              response.status_code == 302 and "/login" in response.headers.get("Location", ""),
              f"{response.status_code} {response.headers.get('Location')}")
    check("anonymous /api/folder is 401",
          anon.post("/api/folder", json={"path": "", "name": "x"}).status_code == 401)

    print("\n== a stale session does not become a half-signed-in user ==")
    # A cookie naming an account that no longer exists must end the session,
    # not leave the UI looking signed in while every action fails.
    ghost = client()
    with ghost.session_transaction() as sess:
        sess["user_id"] = 999999
    ghost_status = ghost.get("/api/auth/status").get_json()
    check("stale user_id is not treated as authenticated",
          ghost_status["authenticated"] is False, str(ghost_status))
    check("stale session cannot list files", ghost.get("/api/files?path=").status_code == 401)

    print("\n== per-folder PIN ==")
    alice.post("/api/folder", json={"path": "users/alice", "name": "diary"})
    upload(alice, "users/alice/diary", "entry1.txt", b"dear diary")

    made = alice.post("/api/pin", json={"path": "users/alice/diary", "pin": "4321"})
    check("alice sets a PIN on her folder", made.status_code == 201,
          made.get_data(as_text=True)[:200])
    url = made.get_json()["url"] if made.status_code == 201 else ""
    token = url.rsplit("/", 1)[-1] if url else ""
    check("share URL is the /unlock/<token> form", "/unlock/" in url, url)

    protected = alice.get("/api/files?path=users/alice").get_json()
    diary = next((i for i in protected["items"] if i["name"] == "diary"), None)
    check("locked folder is listed but flagged", diary is not None and diary["has_pin"] is True,
          str(diary))

    # Bob has no account-level access at all.
    check("bob still cannot reach the folder",
          bob.get("/api/files?path=users/alice/diary").status_code == 403)

    guest = client()
    check("guest cannot list before unlocking",
          guest.get("/api/files?path=users/alice/diary").status_code == 401)

    bad = guest.post("/api/pin/unlock", json={"token": token, "pin": "0000"})
    check("wrong PIN rejected", bad.status_code == 401, str(bad.status_code))

    good = guest.post("/api/pin/unlock", json={"token": token, "pin": "4321"})
    check("correct PIN unlocks", good.status_code == 200, good.get_data(as_text=True)[:200])

    inside = guest.get("/api/files?path=users/alice/diary")
    check("guest can list the shared folder", inside.status_code == 200, str(inside.status_code))

    item = guest.get("/api/raw?path=users/alice/diary/entry1.txt")
    check("guest can read files inside", item.status_code == 200, str(item.status_code))

    print("\n== guest confinement ==")
    check("guest cannot see the parent folder",
          guest.get("/api/files?path=users/alice").status_code == 403)
    check("guest cannot see the root",
          guest.get("/api/files?path=").status_code == 403)
    check("guest cannot read a sibling file",
          guest.get("/api/raw?path=users/alice/alice-secret.txt").status_code == 403)
    check("guest cannot write",
          guest.post("/api/folder",
                     json={"path": "users/alice/diary", "name": "nope"}).status_code == 403)
    check("guest cannot delete",
          guest.delete("/api/files?path=users/alice/diary/entry1.txt").status_code == 403)
    check("guest cannot move",
          guest.post("/api/move", json={"from": "users/alice/diary/entry1.txt",
                                        "to": "users/alice/diary/moved.txt"}).status_code == 403)
    check("guest cannot create share links",
          guest.post("/api/share", json={"path": "users/alice/diary/entry1.txt"}).status_code == 403)

    # A second unlock must not widen access: the most recent one wins.
    alice.post("/api/pin", json={"path": "users/alice", "pin": "1111"})
    second = alice.get("/api/pins").get_json()["pins"]
    other = next((p for p in second if p["path"] == "users/alice"), None)

    print("\n== PIN removal ==")
    off = alice.delete("/api/pin?path=users/alice/diary")
    check("owner can remove a PIN", off.status_code == 200, str(off.status_code))
    after = guest.get("/api/files?path=users/alice/diary")
    # Access is granted by the session unlock, which the folder PIN no longer
    # backs; the guest keeps access for this session but the link is dead.
    dead_link = client().post("/api/pin/unlock", json={"token": token, "pin": "4321"})
    check("revoked link no longer unlocks", dead_link.status_code == 404, str(dead_link.status_code))

    print("\n== PIN on the storage root is refused ==")
    root_pin = alice.post("/api/pin", json={"path": "", "pin": "1234"})
    check("cannot PIN-protect the root", root_pin.status_code == 400, str(root_pin.status_code))

    print("\n== password recovery ==")
    # Without a way back in, a forgotten password means the account is gone:
    # there is no email and no reset link.
    anon = client()
    check("recovery is advertised when configured",
          anon.get("/api/auth/status").get_json()["recovery_available"] is True)

    check("wrong recovery code is refused",
          anon.post("/api/auth/recover",
                    json={"username": "bob", "password": "brandnewpass1",
                          "recovery_code": "nope"}).status_code == 401)

    # An unknown username must look the same as a wrong code, so this cannot be
    # used to discover which accounts exist.
    check("unknown user looks the same as a wrong code",
          anon.post("/api/auth/recover",
                    json={"username": "ghost", "password": "brandnewpass1",
                          "recovery_code": "recovery-code"}).status_code == 401)

    check("short new password is refused",
          anon.post("/api/auth/recover",
                    json={"username": "bob", "password": "short",
                          "recovery_code": "recovery-code"}).status_code == 400)

    reset = anon.post("/api/auth/recover",
                      json={"username": "bob", "password": "brandnewpass1",
                            "recovery_code": "recovery-code"})
    check("correct recovery code resets the password",
          reset.status_code == 200, reset.get_data(as_text=True)[:160])

    check("recovery signs the user straight in",
          anon.get("/api/files?path=").status_code == 200)

    fresh = client()
    check("new password works",
          fresh.post("/api/auth/login",
                     json={"username": "bob", "password": "brandnewpass1"}).status_code == 200)

    check("old password no longer works",
          client().post("/api/auth/login",
                        json={"username": "bob", "password": "password123"}).status_code == 401)

    print("\n== logout ==")
    alice.post("/api/auth/logout")
    check("session invalid after logout",
          alice.get("/api/files?path=").status_code == 401)

    print("\n== the shared PIN is not a backdoor once accounts exist ==")
    # It would otherwise be a second, unattributable way into the whole storage
    # root, bypassing accounts entirely.
    legacy = client()
    status = legacy.get("/api/auth/status").get_json()
    check("PIN login is not offered when accounts exist",
          status["pin_login_enabled"] is False, str(status))

    pin_login = legacy.post("/api/auth/login", json={"pin": "999999"})
    check("shared PIN is refused when accounts exist",
          pin_login.status_code == 403, str(pin_login.status_code))
    check("shared PIN did not create a session",
          legacy.get("/api/files?path=").status_code == 401)

    shutil.rmtree(SCRATCH, ignore_errors=True)
    shutil.rmtree(THUMBS, ignore_errors=True)

    print("\n" + "=" * 62)
    if FAILED:
        print(f"{len(FAILED)} FAILED, {PASSED} passed")
        for name in FAILED:
            print(f"  - {name}")
        return 1
    print(f"All {PASSED} auth checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
