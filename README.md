
<!-- blur faces readme: basic usage and notes -->

# Blur Faces v1.2

**Blur Faces** is a privacy-first desktop app (Electron + Flask + RetinaFace) for local batch face anonymization.

## Features
- Step-by-step workflow: Import -> Detect -> Library/Edit -> Export
- Automatic RetinaFace detection right after import with progress and logs
- Click-to-edit library cards for quick mask adjustments
- Export options: output folder, suffix, forced format, JPEG quality, metadata stripping
- Fully local processing (images are not uploaded to a cloud service)

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
1. **Import:** choose one or many photos.
2. **Detect:** starts automatically and shows per-image progress.
3. **Library/Edit (optional):** click any image to open the editor and adjust masks.
4. **Export:** pick output options and export all files in one run.

## Tips
- For best detection, install `retinaface` in your Python environment (may require TensorFlow).
- Exported JPEGs use adaptive quality to keep file sizes close to original.
- No session persistence: edits are per-session for privacy and simplicity.

## Editor Basics
- Drag on the image to create a new mask.
- Drag inside a mask to move it.
- Press `Delete` (or click **Delete Selected**) to remove a selected mask.
- Press `Esc` to close the editor.

## Troubleshooting
- If Electron doesn't start, run `npm install` first.
- If detection fails, check Python dependencies and backend terminal output.
- Open DevTools (View → Toggle Developer Tools) for logs.

## License
AGPL
