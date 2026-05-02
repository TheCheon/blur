#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

# Blur Faces - Complete startup script with error handling
# This script starts both the Flask backend and Electron frontend

echo "========================================="
echo "Blur Faces - Startup Script"
echo "========================================="
echo

# Activate Python virtual environment
if [ -f .venv/bin/activate ]; then
  echo "[1/3] Activating Python environment..."
  . .venv/bin/activate
  echo "      ✓ Python environment activated"
else
  echo "[!] Virtual environment not found!"
  echo "    Run './install.sh' first to set up the environment."
  exit 1
fi

echo

# Start Flask backend
echo "[2/3] Starting Flask backend (port 5000)..."
python3 app.py > /tmp/blur_backend.log 2>&1 &
PID_BG=$!
echo "      ✓ Backend started (PID: $PID_BG)"

# Wait for backend to be ready
sleep 2

# Check if backend is running
if kill -0 $PID_BG 2>/dev/null; then
  echo "      ✓ Backend is running"
else
  echo "      ✗ Backend crashed"
  cat /tmp/blur_backend.log || true
  exit 1
fi

echo

# Start Electron frontend
echo "[3/3] Starting Electron frontend..."
if command -v npm >/dev/null 2>&1; then
  if npm start; then
    echo "      ✓ Electron closed normally"
  else
    echo "      ! Electron exited with error"
  fi
else
  echo "      ✗ npm not found!"
  echo "    Please install Node.js/npm and try again"
  kill $PID_BG 2>/dev/null || true
  exit 1
fi

# Cleanup: kill background backend when Electron exits
echo
echo "Cleaning up..."
kill $PID_BG 2>/dev/null || true
sleep 1

# Force kill if still running
if kill -0 $PID_BG 2>/dev/null; then
  kill -9 $PID_BG 2>/dev/null || true
fi

echo "========================================="
echo "Blur Faces closed"
echo "========================================="
