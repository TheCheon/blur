#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
# blur faces starter: runs backend in background and launches electron
# start backend then start electron app
if [ -f .venv/bin/activate ]; then
  . .venv/bin/activate
fi
# run backend in background
python3 app.py &
PID_BG=$!
# give backend a moment to start
sleep 1
# start electron
if command -v npm >/dev/null 2>&1; then
  npm start
else
  echo "npm not found — please start the Electron app manually (npm start)"
fi
# cleanup background backend when npm exits
kill $PID_BG 2>/dev/null || true
