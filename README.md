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
| Access control | None | PIN + session cookie |
| Thumbnails | None | Pillow (images), ffmpeg (video) |
| Share links | Local-only, never worked | Real expiring public links |

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
app.py          Flask app factory, config, SQLite pragmas
extensions.py   shared SQLAlchemy instance (breaks the app<->api cycle)
api.py          REST API: files, auth, streaming, thumbnails, shares
storage.py      disk storage + path safety
models.py       Share-link table
main.py         waitress entry point
static/js/      frontend (FileManager, UIManager, DragDrop, app)
templates/      index.html shell
```

`extensions.py` exists for a specific reason: `api.py` needs the `db` object,
and if it imported that from `app.py`, then importing `api` before `app` would
fail with `ImportError: cannot import name 'api' from partially initialized
module 'api'`. Keeping the shared extension in its own module removes the
cycle, so `python main.py`, `import app`, and `import api` all work.

## Configuration (`.env`)

| Variable | Default | Purpose |
|---|---|---|
| `FILE_EXPLORER_PIN` | generated + printed at startup | PIN required to open the app |
| `FLASK_SECRET_KEY` | auto-generated to `.secret_key` | Signs session cookies |
| `STORAGE_ROOT` | `storage` | Where files are saved; point at a media drive |
| `THUMBNAIL_CACHE_DIR` | `.thumbs` | Generated thumbnail cache |
| `MAX_UPLOAD_MB` | `0` (unlimited) | Per-file upload ceiling |
| `FILE_EXPLORER_TOKEN` | unset | Optional `X-Auth-Token` for scripts |
| `HOST` / `PORT` | `0.0.0.0` / `8080` | Listen address |
| `COOKIE_SECURE` | `0` | Set to `1` when serving over HTTPS |
| `DATABASE_URL` | local SQLite | Optional; stores share links only |

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

`migrate_db.py` removes the unused legacy `files` table (the original model
stored file content in the database; files now live on disk). It refuses to
drop the table if it contains any rows.

```powershell
.venv\Scripts\python.exe migrate_db.py --dry-run   # show what would happen
.venv\Scripts\python.exe migrate_db.py            # apply
```

## Tests

```powershell
.venv\Scripts\python.exe smoke_test.py        # 46 checks, in-process
.venv\Scripts\python.exe live_check.py        # 21 checks over real HTTP
```

`smoke_test.py` uses Flask's test client against a scratch directory.
`live_check.py` needs a running server and exercises real sockets, waitress
streaming, and byte-exact Range responses.

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
