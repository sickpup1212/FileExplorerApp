# Starts the file explorer, creating the virtual environment on first run.
#
#   .\start.ps1
#
# If Windows blocks the script, run once:
#   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

$python = ".venv\Scripts\python.exe"
$requirements = "requirements.txt"

function Install-Dependencies {
    param([string]$Reason)

    Write-Host $Reason -ForegroundColor Cyan

    # uv is preferred: venvs created by `uv venv` do not include pip, so
    # "python -m pip install" fails inside them with "No module named pip".
    if (Get-Command uv -ErrorAction SilentlyContinue) {
        $env:UV_CACHE_DIR = Join-Path $PSScriptRoot ".cache\uv-local"
        uv pip install --python $python -r $requirements
    } else {
        & $python -m pip install --upgrade pip
        & $python -m pip install -r $requirements
    }
}

if (-not (Test-Path $python)) {
    Write-Host "Creating virtual environment..." -ForegroundColor Cyan
    $env:UV_CACHE_DIR = Join-Path $PSScriptRoot ".cache\uv-local"
    if (Get-Command uv -ErrorAction SilentlyContinue) {
        uv venv --python 3.13 .venv
    } else {
        python -m venv .venv
    }
    Install-Dependencies "Installing dependencies..."
}

# Keep the environment in sync with requirements.txt. Guards against the
# confusing case where a package is listed but was never actually installed
# into this interpreter.
$missing = & $python -c @"
import importlib.util, sys, re, pathlib
spec = pathlib.Path('requirements.txt')
if not spec.exists():
    sys.exit(0)
missing = []
for line in spec.read_text().splitlines():
    line = line.split('#')[0].strip()
    if not line or line.startswith('-'):
        continue
    name = re.split(r'[<>=!\[;]', line)[0].strip().replace('-', '_')
    if name and importlib.util.find_spec(name) is None:
        missing.append(name)
print(' '.join(missing))
"@

if ($missing) {
    Install-Dependencies "Missing from the virtual environment: $missing"
}

if (-not (Test-Path ".env")) {
    Write-Host ""
    Write-Host "No .env found. Creating one from .env.example." -ForegroundColor Yellow
    Copy-Item ".env.example" ".env"
    Write-Host "IMPORTANT: edit .env and change FILE_EXPLORER_PIN." -ForegroundColor Yellow
    Write-Host ""
}

Write-Host "Starting server on http://localhost:8080" -ForegroundColor Green
& $python main.py
