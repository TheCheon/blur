@echo off
cd /d "%~dp0"
rem blur faces installer for windows: creates virtualenv and installs dependencies (lowercase comment)
python -m venv .venv
.venv\Scripts\activate
pip install --upgrade pip
if exist requirements.txt (
  pip install -r requirements.txt
)
if exist package.json (
  where npm >nul 2>&1
  if errorlevel 1 (
    echo npm not found — install Node.js/npm and run "npm ci"
  ) else (
    npm ci
  )
)
echo Install complete. Activate venv with: .venv\Scripts\activate