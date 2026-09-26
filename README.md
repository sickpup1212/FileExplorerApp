# File System Explorer

A self-hosted file explorer for moving media between your phone and your PC.

Files are stored **on the server's disk**, so the same library is visible from
every device at once. Nothing lives in the browser any more, which was the
original limitation: the app used to keep every byte in browser IndexedDB, so
your files existed only in one browser on one device and vanished when site
data was cleared.

## What changed

| | Before | Now |
|---|---|---|
| Storage | Browser IndexedDB | Server disk (`storage/`) |
| Visible on phone + PC | No | Yes |
| Size limit | 50 MB | No limit by default |
| File size shown | ~33% too large (base64 length) | Exact bytes from `stat` |
| Video playback | Whole file into memory as base64 | HTTP Range streaming |
| Access control | One shared PIN | Accounts, private spaces, per-folder PINs |
| Thumbnails | None | Pillow (images), ffmpeg (video) |
| Share links | Local-only, never worked | Real expiring public links |
| Long folder listings | No scrollbar, items unreachable | Scrollable content area |

## Quick start (Windows)

```powershell
.\start.ps1
```

On first run this creates the virtual environment, installs dependencies, and
copies `.env.example` to `.env`.

**Then edit `.env` and change `FILE_EXPLORER_PIN`.** The default is `123456`,
which is fine for trying it out and wrong for anything else.

Open <http://localhost:8080>. Use port **8080**, not 5000 — 5000 is commonly
claimed by another service on Windows (it failed here with `WinError 10013`).

On Linux/macOS use `./start.sh` instead.

### Manual setup

```powershell
uv venv --python 3.13 .venv
uv pip install --python .venv\Scripts\python.exe flask flask-sqlalchemy pillow python-dotenv waitress
copy .env.example .env
.venv\Scripts\python.exe main.py
```

## Layout

```
app.py           Flask app factory, config, SQLite pragmas
extensions.py    shared SQLAlchemy instance (breaks the app<->api cycle)
api.py           REST API: files, auth, streaming, thumbnails, shares
pages.py         public HTML pages: /login, /unlock/<token>, /explorer
storage.py       disk storage + path safety
permissions.py   access control (regions, modes, guest confinement)
models.py        accounts, directory PINs, share links
main.py          waitress entry point
start.ps1/.sh    one-command setup and launch

static/js/       frontend (app, fileManager, uiManager, dragDrop)
static/css/      styles
templates/       index.html, login.html, unlock.html

tests/           smoke_test.py, auth_test.py, live_check.py, ui_check.py
scripts/         manage_users.py, migrate_db.py
old/             superseded files, kept for reference only
```

Runtime modules stay flat next to `app.py` on purpose: they are imported as
top-level modules (`import storage`), which keeps `python main.py` working
without an install step and avoids a package/`app.py` name collision.

`extensions.py` exists for a specific reason: `api.py` needs the `db` object,
and if it imported that from `app.py`, then importing `api` before `app` would
fail with `ImportError: cannot import name 'api' from partially initialized
module 'api'`. Keeping the shared extension in its own module removes the
cycle, so `python main.py`, `import app`, and `import api` all work.

### Running the tests and scripts

Run them **from the project root**, as shown below. The test files insert the
project root on `sys.path` themselves, so they work from any directory, but the
paths in the examples assume the root.

```powershell
.venv\Scripts\python.exe tests\smoke_test.py
.venv\Scripts\python.exe scripts\manage_users.py list
```

### `old/`

Nothing here is used by the running app:

| File | Why it is archived |
|---|---|
| `auth.py` | An abandoned early auth attempt. Its `User(email=...)` call does not match the current model and no module imports it. |
| `uv.lock` | Produced by the original Replit environment; it still lists the old dependency set (`psycopg2`, `gunicorn`, no Pillow). `requirements.txt` is the source of truth. |
| `attached_assets/` | Design mockups and screenshots from earlier iterations. |
| `css/`, `js/` | Empty directories left over from before assets moved under `static/`. |

`scripts/migrate_db.py` is **not** archived: it still has a real job. The
legacy `files` table from the very first version is still present in the
database and that script drops it.

## Accounts and sharing

The app supports a handful of accounts, each with a private space, plus a
shared area everyone can use.

```
<STORAGE_ROOT>/shared/            visible to every account, read/write
<STORAGE_ROOT>/users/<name>/      private to that account
<STORAGE_ROOT>/...                read-only legacy area
```

**The root is a landing area, not a working directory.** When you sign in you
land on a panel offering **Shared** and **My files**, and the root holds a
`WELCOME.txt` explaining the app.

You *can* upload files to the root and delete or rename them there — that is
how the welcome document gets placed, and how loose leftovers get tidied. What
you cannot do is **create folders** at the root, so it never turns into a
second place to organise content. Folders belong in Shared or your own space.

### Creating accounts

On a **fresh install you do not need an invite code.** Open `/login`, pick
**Create account**, choose a username and password, and leave the invite field
blank — it is not even shown. The first account becomes the administrator.

To let *other* people create accounts afterwards, set a code:

```bash
FILE_EXPLORER_INVITE_CODE=pick-something-long
```

Only then does the login page ask for one. Without a code set, no additional
accounts can be created — the first-run exemption applies only while zero
accounts exist. This is deliberate: it removes the chicken-and-egg problem of
needing a secret to perform initial setup, while still preventing strangers
from self-registering on a server that is already configured.

Accounts can also be managed from the command line:

```powershell
.venv\Scripts\python.exe scripts\manage_users.py list
.venv\Scripts\python.exe scripts\manage_users.py add dana
.venv\Scripts\python.exe scripts\manage_users.py passwd dana
.venv\Scripts\python.exe scripts\manage_users.py delete dana
```

### Sharing one folder with a PIN

You do not need to give anyone an account to let them see a single folder.

1. Right-click a folder → **Set folder PIN**, choose a PIN.
2. The app shows a link like `http://host/unlock/AbC123` plus the PIN.
3. Send both to the person.

They open the link, enter the PIN, and land *inside* that folder — read-only.
They cannot navigate up, list the containing folders, see sibling files, or
reach anything outside it. Remove the PIN with **Remove folder PIN**; the link
stops working immediately.

This is a capability: anyone with the link **and** the PIN gets read-only
access to exactly that folder. Treat the pair like a password.

### Sharing a single file

Right-click a file → **Share file link**. That produces a browser download page
that needs no login and expires after 7 days.

Open `/login` to sign in, or `/signup` to go straight to the Create account tab.

**The shared PIN stops working once an account exists.** It is only a way in on
a deployment with no accounts at all. Leaving it active afterwards would be a
second, unattributable route to the entire storage root that bypasses accounts
— it cannot be scoped or revoked per person. After the first account, sign-in
is by account only.

### If you forget your password

There is no email and no reset link, so there are exactly two ways back in.

**1. From the login page — "Forgot your password?"**

Enter your username, a new password, and the recovery code:

```bash
FILE_EXPLORER_RECOVERY_CODE=pick-something-long
```

Set this before you need it. If it is unset it falls back to
`FILE_EXPLORER_INVITE_CODE`, so a deployment that already has an invite code
has a way back in with no extra configuration.

**2. On the server, from a terminal** — always works, needs no config:

```powershell
.venv\Scripts\python.exe scripts\manage_users.py passwd edubbleu_admin
```

Treat the recovery code like a master key: anyone holding it can take over any
account. That is why it is a server-side secret from `.env` rather than a public
reset form — an unauthenticated reset with no shared secret would be a way in
for anyone who can reach the server.

If neither code is set and you are away from the machine, there is no way in.
That is the trade-off for having no email.

### If someone else needs an account

Either add it yourself:

```powershell
.venv\Scripts\python.exe scripts\manage_users.py add dana
```

Or set an invite code so they can self-register:

```bash
FILE_EXPLORER_INVITE_CODE=share-this-with-them
```

With no invite code and at least one account, registration is closed. The login
page says so explicitly and tells the visitor to ask you, rather than showing a
Create account tab that cannot work.

## Using the interface

- **Double-click** a folder to open it, a file to preview it. A single click
  selects.
- The **preview panel** on the right can be resized by dragging its left edge,
  or with arrow keys once the handle has focus (Shift for larger steps, Home
  for the minimum). The chosen width is remembered in the browser.
- **Right-click** any item for rename, copy, cut, delete, and sharing.
- Drag items onto a folder to move them, or drop files from your desktop to
  upload.
- Where you lack permission, the relevant toolbar buttons are disabled rather
  than failing later.
- Creating, uploading, renaming, moving and deleting all update the listing
  immediately. There is no need to refresh the page.

## Permissions

Every filesystem request resolves a principal server-side and authorises the
path before touching disk, inside `Storage.resolve`. Access is granted by
*region* (a path prefix), never by bare name:

| Who | Can read | Can write |
|---|---|---|
| Account holder | own home, `shared`, legacy root files | same |
| Guest with a folder PIN | that folder and below, read-only | nothing |
| API token (`FILE_EXPLORER_TOKEN`) | everything | everything |

`users/` is hidden from listings so one account cannot discover another, and a
guest never sees the folders above the one they were given.

## Configuration (`.env`)

| Variable | Default | Purpose |
|---|---|---|
| `FILE_EXPLORER_PIN` | generated + printed at startup | Shared PIN. Only usable while **no accounts exist**; then it is refused. |
| `FILE_EXPLORER_INVITE_CODE` | unset | Required to create an account once one exists; unset disables registration |
| `FILE_EXPLORER_RECOVERY_CODE` | unset | Lets a locked-out user set a new password from the login page. Falls back to the invite code. |
| `FLASK_SECRET_KEY` | auto-generated to `.secret_key` | Signs session cookies |
| `STORAGE_ROOT` | `storage` | Where files are saved; point at a media drive |
| `THUMBNAIL_CACHE_DIR` | `.thumbs` | Generated thumbnail cache |
| `MAX_UPLOAD_MB` | `0` (unlimited) | Per-file upload ceiling |
| `FILE_EXPLORER_TOKEN` | unset | Optional `X-Auth-Token` for scripts (full access) |
| `HOST` / `PORT` | `0.0.0.0` / `8080` | Listen address |
| `COOKIE_SECURE` | `0` | Set to `1` when serving over HTTPS |
| `DATABASE_URL` | local SQLite | Optional; stores accounts, PINs and share links |

`DATABASE_URL` is optional and only holds share-link metadata — **your files
always live on disk** under `STORAGE_ROOT`, never in the database. If it points
at Postgres but `psycopg2` is not installed, the app logs a warning and falls
back to SQLite rather than refusing to start.

If you do not set a PIN, one is generated and printed to the console on each
run — that keeps an unprotected instance from being exposed by accident.

## Docker

```bash
docker build -t file-explorer .
docker run -p 8080:8080 \
  -e FILE_EXPLORER_PIN=changeme \
  -v /path/to/your/media:/data \
  file-explorer
```

Mount a volume at `/data` (where `STORAGE_ROOT` points). Without it, uploads
are lost when the container is replaced. The image includes ffmpeg for video
thumbnails.

## Reaching it from your phone

### Same Wi-Fi (simplest)

Find your PC's LAN address:

```powershell
Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.PrefixOrigin -eq 'Dhcp' } | Select-Object IPAddress
```

Then browse to `http://<that-ip>:8080` on your phone. If it does not connect,
allow Python through the Windows firewall:

```powershell
New-NetFirewallRule -DisplayName "File Explorer 8080" -Direction Inbound -LocalPort 8080 -Protocol TCP -Action Allow
```

This only works on your home network. Note that plain HTTP means the PIN
crosses the network unencrypted — acceptable on a trusted home LAN, but use a
tunnel (below) for anything else.

### From anywhere — Tailscale

Tailscale gives every device a private address with real TLS, with no
port-forwarding and nothing exposed to the public internet.

1. Install Tailscale on the PC and the phone, sign both into the same account.
2. Start the server as usual (`.\start.ps1`).
3. On the phone, open `http://<pc-tailscale-name>:8080`
   (e.g. `http://desktop-abc123:8080`).

Optional HTTPS: `tailscale cert <name>.ts.net` then serve behind TLS, and set
`COOKIE_SECURE=1`. Plain HTTP over Tailscale is already encrypted in transit,
so `COOKIE_SECURE=0` is correct there.

### From anywhere — Cloudflare Tunnel

Good if you prefer a normal `https://` URL and do not want an app on the phone.

```powershell
winget install Cloudflare.cloudflared
cloudflared tunnel login
cloudflared tunnel --url http://localhost:8080
```

The quick-tunnel form prints a random `https://*.trycloudflare.com` URL. With
HTTPS active, set `COOKIE_SECURE=1` so the session cookie is marked Secure.

**A tunnel exposes this to the internet.** The PIN is the only thing protecting
your files, so use a long one, and prefer Tailscale if you do not specifically
need a public URL.

## Adding media from your phone

Without a sync client, uploads go through the browser:

1. Open the app on the phone.
2. **Upload**, or drag files onto the window.
3. Large videos stream to disk with a progress bar — the file is never held in
   memory, so multi-gigabyte transfers work.

To pull files the other way, select items and use **Download** (or share a link
and open it). Downloads stream with Range support, so a video can be scrubbed
while it plays rather than fully buffered.

If you would rather have automatic two-way sync of the whole folder, point
`STORAGE_ROOT` at a Syncthing or Nextcloud folder and let that tool handle
replication — this app is a browser over a directory, not a sync engine.

## API

All endpoints are under `/api` and require the session cookie (except
`/api/health`, `/api/auth/*`, and `/api/s/<token>`).

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/health` | Status, free disk, ffmpeg availability |
| `POST` | `/api/auth/login` | `{"pin": "..."}` → session cookie |
| `GET` | `/api/files?path=` | List a folder |
| `GET` | `/api/stat?path=` | Metadata for one item |
| `POST` | `/api/folder` | `{"path": "...", "name": "..."}` |
| `POST` | `/api/file` | Create an empty file |
| `POST` | `/api/upload?path=&name=` | Stream an upload (multipart or raw body) |
| `GET` | `/api/raw?path=&download=1` | Download / stream (Range-aware) |
| `GET` | `/api/thumbnail?path=&size=` | JPEG thumbnail |
| `POST` | `/api/move` | `{"from": "...", "to": "..."}` |
| `POST` | `/api/copy` | Copy to an explicit path |
| `POST` | `/api/duplicate` | Copy, auto-picking a free name |
| `DELETE` | `/api/files?path=` | Delete (recursive for folders) |
| `POST` | `/api/share` | `{"path": "...", "days": 7}` → public link |
| `GET` | `/s/<token>` | Public share page (no login) |
| `GET` | `/api/s/<token>?download=1` | Public raw download (no login) |

Paths are always relative to `STORAGE_ROOT` and use forward slashes. `""` is
the root. Share links are handed out as `/s/<token>` (no `/api` prefix) so they
are short and pasteable; that page previews the file and links to the raw
download, which supports Range requests too.

## Troubleshooting

**`DATABASE_URL is set but 'psycopg2' is not installed` even though it is in
`requirements.txt`**
A venv created by `uv venv` does **not** contain pip, so `python -m pip install
-r requirements.txt` fails with `No module named pip`, and a plain `pip
install` may target your global Python instead. The package is then listed but
absent from the interpreter the app runs on. Install with:

```powershell
uv pip install --python .venv\Scripts\python.exe -r requirements.txt
```

`.\start.ps1` now checks every requirement against the venv and installs
anything missing, so this should not recur. Verify by hand with:

```powershell
uv pip list --python .venv\Scripts\python.exe
```

**`ImportError: cannot import name 'api' from partially initialized module`**
Fixed by moving the shared `db` object into `extensions.py`. If you see it
again, something has reintroduced `from app import ...` inside `api.py` or
`models.py`.

**`PermissionError: [WinError 10013]` on startup**
Port 5000 is taken or reserved. Use `PORT=8080` (the default).

**Changes do not seem to take effect after restarting**
Check for an old server still holding the port:

```powershell
netstat -ano | Select-String ":8080\s+.*LISTENING"
Get-Process python | Select-Object Id, StartTime
```

Two entries for port 8080 means a stale process is still serving requests.

**Video thumbnails missing**
`ffmpeg` must be on `PATH`. Check `GET /api/health`, which reports
`"ffmpeg": true/false`. Install with `winget install Gyan.FFmpeg`.

## Database maintenance

`scripts/migrate_db.py` removes the unused legacy `files` table (the original
model stored file content in the database; files now live on disk). It refuses
to drop the table if it contains any rows. This has already been applied to
this deployment; the script is kept in case an older database is restored.

```powershell
.venv\Scripts\python.exe scripts\migrate_db.py --dry-run   # show what would happen
.venv\Scripts\python.exe scripts\migrate_db.py            # apply
```

## Tests

```powershell
.venv\Scripts\python.exe tests\smoke_test.py        # 50 checks, core API
.venv\Scripts\python.exe tests\auth_test.py         # 43 checks, accounts + permissions
.venv\Scripts\python.exe tests\live_check.py        # 21 checks over real HTTP
.venv\Scripts\python.exe tests\ui_check.py --account <user> <password> [url]
```

`scripts/audit_refresh.py` is a static check, not a test: it fails if any UI
method that mutates the listing forgets to re-render it, which is the class of
bug that leaves a newly created folder invisible until the page is refreshed.

Each suite points `STORAGE_ROOT` and `DATABASE_URL` at its own scratch files
before importing the app, so a test run cannot touch the real library or the
real database.

- `smoke_test.py` — the single-user PIN path: upload, download, Range
  streaming, thumbnails, share links.
- `auth_test.py` — account isolation, invite gating, per-folder PIN scoping,
  and guest confinement.
- `live_check.py` — same as smoke but over a real socket, exercising waitress
  streaming and byte-exact Range responses. Needs a running server.
- `ui_check.py` — drives a real Chrome/Edge to verify layout, directory
  scrolling, lock badges, and permission state. Needs a running server.

## Notes on safety

- Path traversal is rejected in `Storage.resolve`, with a containment check as
  a second layer so symlinks cannot escape the storage root.
- Filenames are validated against Windows-reserved names and illegal
  characters.
- Uploads land in a temporary `.part` file and are renamed into place only on
  success, so an interrupted transfer never leaves a truncated file visible.
- File and folder names are inserted into the DOM as text, never as HTML, so a
  filename cannot inject markup.
- Share tokens are the capability; revoked or expired tokens return 404.

## Requirements

- Python 3.11+
- `ffmpeg` on `PATH` for video thumbnails (optional; images work without it).
  Install with `winget install Gyan.FFmpeg`.
