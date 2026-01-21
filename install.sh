#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
# Create Python venv
python3 -m venv .venv
. .venv/bin/activate
pip install --upgrade pip
if [ -f requirements.txt ]; then
  pip install -r requirements.txt
fi
# Node deps
if [ -f package.json ]; then
  if command -v npm >/dev/null 2>&1; then
    npm ci
  else
    echo "npm not found — please install Node.js/npm and run 'npm ci'"
  fi
fi

echo "Install complete. Activate venv with: source .venv/bin/activate"