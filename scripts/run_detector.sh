#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "usage: $0 image_path [--json|--json-file out.json]"
  exit 2
fi

IMG="$1"
shift

VENV_DIR=.venv
if [ ! -x "$VENV_DIR/bin/python" ]; then
  echo "Virtualenv not found. Run scripts/setup.sh first."
  exit 2
fi

source "$VENV_DIR/bin/activate"
python main.py "$IMG" "$@"
