
# Blur Faces v1.0

**Blur Faces** is a fast, privacy-focused desktop app (Electron + Flask) for batch face anonymization with a Lightroom-style workflow.

## Features
- Import images and view them in a full-window lighttable grid
- Automatic face detection (RetinaFace, if available)
- Per-image editor: draw, move, resize, or delete black-square masks
- Filmstrip navigation and keyboard shortcuts (arrow keys, zoom, undo/redo)
- Batch export with sensible JPEG/PNG compression (no file bloat)

## Quick Start

### 1. Install (Linux/macOS/Windows)

```bash
./install.sh   # or install.bat on Windows
```

### 2. Run

```bash
./start.sh     # or start.bat on Windows
```

### Manual setup (if needed)
Python backend:
```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python app.py
```
Electron frontend:
```bash
npm install
npm start
```

## Workflow
- **Import:** Add images (JPG/PNG/TIFF/etc) to the project. Images are shown in a centered, full-window grid.
- **Detection:** Run face detection on all images. Masks are auto-applied.
- **Edit:** Check for missed faces. Use the filmstrip or arrow keys to navigate. Draw, move, resize, or delete masks. Zoom with Ctrl+scroll or +/- keys.
- **Export:** Choose a folder and export all masked images. Exported files are sligthly compressed without visible quality changes to avoid bloat.

## Tips
- For best detection, install `retinaface` in your Python environment (may require TensorFlow).
- Exported JPEGs use adaptive quality to keep file sizes close to original.
- No session persistence: edits are per-session for privacy and simplicity.

## Keyboard Shortcuts
- **Left/Right:** Switch images in editor
- **Ctrl+Z / Ctrl+Y:** Undo/Redo
- **Ctrl+Scroll or +/-:** Zoom in/out

## Troubleshooting
- If Electron doesn't start, run `npm install` first.
- If detection fails, check Python dependencies and backend terminal output.
- Open DevTools (View → Toggle Developer Tools) for logs.

## License
AGPL
