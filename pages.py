"""Public HTML pages outside the /api prefix.

Keeping these in their own blueprint means share and unlock links look like
normal URLs (``/s/<token>``, ``/unlock/<token>``) instead of API paths.
"""

from __future__ import annotations

from flask import Blueprint, redirect, render_template, request, session, url_for

from models import DirectoryPin

pages = Blueprint("pages", __name__)

# Shared styling so the login and unlock screens look like one product.
CARD_STYLE = """
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
         background:#f1f3f5; display:flex; align-items:center;
         justify-content:center; min-height:100vh; margin:0; padding:1rem; }
  .card { background:#fff; border-radius:12px; padding:2rem; width:100%;
          max-width:360px; box-shadow:0 10px 30px rgba(0,0,0,.12); }
  h1 { font-size:1.15rem; margin:0 0 .25rem; }
  p.sub { color:#6c757d; font-size:.875rem; margin:0 0 1.25rem; }
  label { display:block; font-size:.8rem; color:#495057; margin:.75rem 0 .25rem; }
  input { width:100%; box-sizing:border-box; padding:.6rem .75rem;
          border:1px solid #ced4da; border-radius:8px; font-size:1rem; }
  input:focus { outline:2px solid #a5c8ff; border-color:#0d6efd; }
  button { width:100%; margin-top:1.25rem; padding:.7rem 1rem; border:none;
           border-radius:8px; background:#0d6efd; color:#fff;
           font-size:1rem; font-weight:500; cursor:pointer; }
  button:hover { background:#0b5ed7; }
  .error { color:#dc3545; font-size:.85rem; min-height:1.2rem; margin-top:.75rem; }
  .center { text-align:center; }
  .icon { font-size:1.75rem; margin-bottom:.5rem; }
"""


@pages.get("/login")
def login_page():
    """Login and registration screen."""
    return render_template("login.html")


@pages.get("/signup")
def signup_page():
    """Same screen, opened on the Create account tab.

    Exists so /signup is a real URL: the form always had a register tab, but
    there was no page to link anyone to.
    """
    return redirect(url_for("pages.login_page", mode="register"))


def safe_next(target: str | None) -> str | None:
    """Only allow same-site relative redirects, so 'next' cannot be abused.

    Rejects absolute URLs and protocol-relative forms like ``//evil.example``.
    """
    if not target or not target.startswith("/") or target.startswith("//"):
        return None
    return target


@pages.get("/unlock/<token>")
def unlock_page(token: str):
    """PIN prompt for a protected directory.

    The token identifies the folder; the PIN is the capability. Nothing about
    the folder's contents is revealed before the PIN is accepted.
    """
    record = DirectoryPin.query.filter_by(token=token).first()
    name = record.path.rsplit("/", 1)[-1] if record else ""
    owner = record.owner.username if record and record.owner else None
    return render_template(
        "unlock.html",
        token=token,
        name=name,
        owner=owner,
        valid=record is not None,
    )


@pages.get("/explorer")
@pages.get("/explorer/<path:subpath>")
def explorer(subpath: str = ""):
    """The explorer itself.

    Also reachable under a path prefix, which is how a guest who unlocked a
    folder lands directly inside it without being able to navigate upwards.

    This route serves the app shell, so it must be gated: without the check an
    anonymous visitor would receive the full interface and see it fail request
    by request, rather than being sent to the login screen.
    """
    from api import current_principal

    who = current_principal()
    if who.authenticated:
        return render_template("index.html")

    # Send them back to this exact page after signing in.
    session["next"] = request.full_path if request.query_string else request.path
    return redirect(url_for("pages.login_page"))
