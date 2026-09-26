"""Report which UI mutation methods refresh the listing afterwards.

A mutation that does not refresh leaves the user staring at a stale folder and
believing the action failed.

A method counts as refreshing if it either calls ``refreshContent`` directly or
routes the mutation through ``this.run(...)``, which re-renders on success
unless it is explicitly called with ``{ refresh: false }``.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

path = Path(sys.argv[1] if len(sys.argv) > 1 else "static/js/uiManager.js")
lines = path.read_text(encoding="utf-8").splitlines()

MUTATORS = (
    "createItem",
    "uploadFile",
    "deleteItem",
    "renameItem",
    "moveItem",
    "copyItem",
    "paste(",
    "protectFolder",
    "unprotectFolder",
)

# Methods that delegate their refresh to a caller, so they are fine on their
# own. 'deleteSelected' and friends are not here because they are entry points.
DELEGATES_REFRESH = {"uploadWithProgress", "createItemElement", "bindEvents"}


def refreshes(body: str) -> bool:
    if "refreshContent" in body:
        return True
    # A run(...) call refreshes unless it is opted out.
    for match in re.finditer(r"this\.run\(", body):
        tail = body[match.end():match.end() + 80]
        if "refresh: false" not in tail:
            return True
    return False


methods: list[dict] = []
current: dict | None = None

for number, line in enumerate(lines, 1):
    match = re.match(r"\s{4}(?:async\s+)?([a-zA-Z_][\w]*)\s*\(", line)
    if match:
        if current:
            methods.append(current)
        current = {"name": match.group(1), "start": number, "body": []}
    if current:
        current["body"].append(line)

if current:
    methods.append(current)

stale = []
print(f"{'method':<26} {'mutates':<8} refreshes")
print("-" * 50)
for method in methods:
    body = "\n".join(method["body"])
    if not any(key in body for key in MUTATORS):
        continue
    ok = refreshes(body) or method["name"] in DELEGATES_REFRESH
    if not ok:
        stale.append(method["name"])
    print(f"{method['name']:<26} {'yes':<8} {'yes' if ok else 'NO'}")

print()
if stale:
    print(f"{len(stale)} method(s) mutate without refreshing:")
    for name in stale:
        print(f"  - {name}")
    sys.exit(1)

print("Every mutation refreshes the listing.")
