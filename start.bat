@echo off
cd /d "%~dp0"
rem blur faces starter for windows: activates venv and starts backend + electron
if exist .venv\Scripts\activate (
  call .venv\Scripts\activate
)
start /b python app.py
timeout /t 1 /nobreak >nul
where npm >nul 2>&1
if errorlevel 1 (
  echo npm not found — please start the Electron app manually (npm start)
) else (
  npm start
)
