#!/usr/bin/env bash
set -euo pipefail

# Create virtualenv in .venv and install requirements
PY3=${PY3:-python3}
VENV_DIR=.venv

echo "Creating virtualenv in $VENV_DIR using $PY3"
$PY3 -m venv "$VENV_DIR"
source "$VENV_DIR/bin/activate"
python -m pip install --upgrade pip
if [ -f requirements.txt ]; then
  pip install -r requirements.txt
else
  echo "No requirements.txt found; skipping pip install"
fi

echo "Setup complete. Activate with: source $VENV_DIR/bin/activate" 
