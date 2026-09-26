"""UI verification harness.

Drives a real browser against a running server to check the things an API test
cannot see: layout, scrolling, permission state, and whether the grid renders.

    .venv\\Scripts\\python.exe tests\\ui_check.py [base_url] [pin] [shot_prefix]
    .venv\\Scripts\\python.exe tests\\ui_check.py --account <user> <pass> [base_url] [prefix] [home]

Authenticates through the real login endpoint, so the login flow itself is
exercised rather than bypassed.

``home`` is the storage-relative path to open, defaulting to the account's own
space. The scrolling assertions need that folder to hold enough items to
overflow the viewport; pass a different path if you want to test another one.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

# Run from tests/, so add the project root (for the app modules) to sys.path.
_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

ACCOUNT_MODE = "--account" in sys.argv
args = [a for a in sys.argv[1:] if a != "--account"]

if ACCOUNT_MODE:
    USERNAME = args[0] if args else "uiuser"
    PASSWORD = args[1] if len(args) > 1 else "password123"
    BASE = args[2] if len(args) > 2 else "http://127.0.0.1:8098"
    PREFIX = args[3] if len(args) > 3 else "shot"
    # Default to the account's own space rather than a hardcoded name, which
    # would 403 for anyone else's account.
    HOME = args[4] if len(args) > 4 else f"users/{USERNAME}"
    PIN = ""
else:
    USERNAME = PASSWORD = ""
    HOME = ""
    BASE = args[0] if args else "http://127.0.0.1:8080"
    PIN = args[1] if len(args) > 1 else os.environ.get("FILE_EXPLORER_PIN", "")
    PREFIX = args[2] if len(args) > 2 else "shot"

CHROME_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
]

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


def login_and_get_cookie() -> str:
    """Log in via the API and return the value of the session cookie."""
    if ACCOUNT_MODE:
        payload = {"username": USERNAME, "password": PASSWORD}
    else:
        if not PIN:
            raise SystemExit(
                "No PIN given. Pass it as the second argument, or set "
                "FILE_EXPLORER_PIN in the environment."
            )
        payload = {"pin": PIN}

    request = urllib.request.Request(
        f"{BASE}/api/auth/login",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            cookies = response.headers.get_all("Set-Cookie") or []
    except urllib.error.HTTPError as error:
        raise SystemExit(f"Login failed ({error.code}): {error.read()[:200]!r}")

    for cookie in cookies:
        if cookie.startswith("session="):
            return cookie.split(";", 1)[0].split("=", 1)[1]

    raise SystemExit(f"No session cookie returned. Got: {cookies}")


def find_chrome() -> str | None:
    for path in CHROME_CANDIDATES:
        if os.path.exists(path):
            return path
    return None


def main() -> int:
    from playwright.sync_api import sync_playwright

    chrome = find_chrome()
    if not chrome:
        print("No Chrome/Edge found.")
        return 1

    cookie_value = login_and_get_cookie()
    print(f"Authenticated against {BASE}")

    with sync_playwright() as p:
        browser = p.chromium.launch(
            executable_path=chrome,
            headless=True,
            args=["--no-first-run", "--no-default-browser-check"],
        )
        context = browser.new_context(viewport={"width": 1280, "height": 800})
        context.add_cookies(
            [
                {
                    "name": "session",
                    "value": cookie_value,
                    "domain": "127.0.0.1",
                    "path": "/",
                }
            ]
        )

        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}")
                if m.type == "error" else None)

        page.goto(f"{BASE}#{HOME}", wait_until="networkidle")
        page.wait_for_timeout(2000)

        print("== session ==")
        landed = page.evaluate("window.location.pathname")
        check("authenticated session stays on the explorer", landed == "/", landed)

        explorer_visible = page.evaluate(
            "const e = document.getElementById('explorer'); !!e && !e.hidden"
        )
        check("explorer shell is visible", explorer_visible)

        print("\n== grid renders ==")
        # The #path deep link above opens the user's own space, where the
        # seeded content lives.
        item_count = page.evaluate("document.querySelectorAll('.file-item').length")
        check("file items rendered", item_count > 0, f"count={item_count}")

        locked = page.evaluate("document.querySelectorAll('.file-item.is-locked').length")
        check("PIN protected folder shows a lock badge", locked == 1, f"locked={locked}")

        thumbs = page.evaluate("document.querySelectorAll('.file-item-thumb').length")
        print(f"  info  {item_count} items, {thumbs} with thumbnails, {locked} locked")

        print("\n== directory scrolling ==")
        metrics = page.evaluate(
            """() => {
                const el = document.getElementById('contentArea');
                const cs = getComputedStyle(el);
                return {
                    overflowY: cs.overflowY,
                    flexGrow: cs.flexGrow,
                    clientHeight: el.clientHeight,
                    scrollHeight: el.scrollHeight,
                    canScroll: el.scrollHeight > el.clientHeight,
                    bodyOverflow: getComputedStyle(document.body).overflow,
                    viewport: window.innerHeight,
                };
            }"""
        )
        print(f"  info  {metrics}")
        check("content area is scrollable", metrics["overflowY"] in ("auto", "scroll"),
              metrics["overflowY"])
        check("content area fills remaining height", metrics["flexGrow"] == "1",
              metrics["flexGrow"])
        check(
            "listing overflows its viewport (so a scrollbar appears)",
            metrics["canScroll"],
            f"{metrics['scrollHeight']} vs {metrics['clientHeight']}",
        )
        check(
            "page body itself does not scroll",
            metrics["bodyOverflow"] == "hidden",
            metrics["bodyOverflow"],
        )

        # Reading the last item is the real user-visible symptom: before the
        # fix, it sat below the viewport with no way to reach it.
        if item_count == 0:
            print("  SKIP  no items rendered, cannot test reachability")
        else:
            reachable = page.evaluate(
                """() => {
                    const items = document.querySelectorAll('.file-item');
                    const last = items[items.length - 1];
                    last.scrollIntoView({block: 'end'});
                    const r = last.getBoundingClientRect();
                    return { top: r.top, bottom: r.bottom, viewport: window.innerHeight };
                }"""
            )
            check(
                "last item can be scrolled into view",
                reachable["bottom"] <= reachable["viewport"] + 2 and reachable["top"] >= -2,
                str(reachable),
            )

        page.screenshot(path=f"{PREFIX}-top.png")

        # Scroll to the bottom and capture the scrollbar.
        page.evaluate("document.getElementById('contentArea').scrollTop = 99999")
        page.wait_for_timeout(400)
        scrolled = page.evaluate("document.getElementById('contentArea').scrollTop")
        check("scrolling actually moves the content", scrolled > 0, str(scrolled))
        page.screenshot(path=f"{PREFIX}-bottom.png")

        print("\n== permission state ==")
        state = page.evaluate(
            """() => {
                const principal = window.app?.fileManager?.principal || {};
                return {
                    mode: principal.mode,
                    username: principal.username,
                    isGuest: !!principal.is_guest,
                    writableRoots: principal.writable_roots || [],
                    uploadDisabled: document.getElementById('uploadBtn')?.disabled,
                    newFolderDisabled: document.getElementById('newFolderBtn')?.disabled,
                    homeButtons: document.querySelectorAll('#homeButtons button').length,
                    sidebarUser: document.getElementById('sidebarUser')?.textContent || '',
                };
            }"""
        )
        print(f"  info  {state}")
        check("principal is reported to the UI", bool(state["mode"]), str(state))
        check("sidebar shows who is signed in", bool(state["sidebarUser"]), state["sidebarUser"])

        if not state["isGuest"]:
            check(
                "write actions enabled for a writable session",
                state["uploadDisabled"] is False,
                f"upload disabled={state['uploadDisabled']}",
            )

        print("\n== javascript errors ==")
        real_errors = [e for e in errors if "favicon" not in e.lower()]
        check("no page errors", not real_errors, "; ".join(real_errors[:3]))

        browser.close()

    print("\n" + "=" * 60)
    if FAILED:
        print(f"{len(FAILED)} FAILED, {PASSED} passed")
        for name in FAILED:
            print(f"  - {name}")
        return 1
    print(f"All {PASSED} UI checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
