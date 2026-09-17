#!/usr/bin/env bash
# Starts the file explorer on Linux/macOS (also works on Replit).
set -euo pipefail
cd "$(dirname "$0")"

PYTHON=".venv/bin/python"
REQUIREMENTS="requirements.txt"

install_dependencies() {
    echo "$1"
    # Prefer uv: venvs created by `uv venv` have no pip inside them, so
    # "python -m pip install" fails with "No module named pip".
    if command -v uv >/dev/null 2>&1; then
        uv pip install --python "$PYTHON" -r "$REQUIREMENTS"
    else
        "$PYTHON" -m pip install --upgrade pip
        "$PYTHON" -m pip install -r "$REQUIREMENTS"
    fi
}

if [ ! -x "$PYTHON" ]; then
    echo "Creating virtual environment..."
    if command -v uv >/dev/null 2>&1; then
        uv venv --python 3.11 .venv
    else
        python3 -m venv .venv
    fi
    install_dependencies "Installing dependencies..."
fi

# Keep the environment in sync with requirements.txt so a listed-but-never-
# installed package cannot silently degrade behaviour.
MISSING=$("$PYTHON" - <<'PY'
import importlib.util, re, pathlib
spec = pathlib.Path("requirements.txt")
if not spec.exists():
    raise SystemExit
missing = []
for line in spec.read_text().splitlines():
    line = line.split("#")[0].strip()
    if not line or line.startswith("-"):
        continue
    name = re.split(r"[<>=!\[;]", line)[0].strip().replace("-", "_")
    if name and importlib.util.find_spec(name) is None:
        missing.append(name)
print(" ".join(missing))
PY
)

if [ -n "$MISSING" ]; then
    install_dependencies "Missing from the virtual environment: $MISSING"
fi

if [ ! -f .env ]; then
    cp .env.example .env
    echo "Created .env - edit it to set FILE_EXPLORER_PIN."
fi

exec "$PYTHON" main.py
