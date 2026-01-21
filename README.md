# Blur Faces

Blur Faces is a small desktop app (Electron frontend + Flask backend) that detects faces and applies black-square masks. You can import images, run automatic face detection, adjust or draw masks per-image, and export masked images in batch.

Quick Start

1) Python backend

Create and activate a virtualenv, install Python deps, and start the backend:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python app.py
```

The Flask API listens on http://127.0.0.1:5000 and exposes `/detect`, `/mask`, and `/retina_mask`.

2) Electron frontend

Install node deps once, then run the app:

```bash
npm install
npm start
```

Workflow Overview

- Import: pick images to add to the project.
- Detection: run automatic detection for all images (uses the backend). Progress and ETA are shown.
- Edit: open an image (filmstrip + canvas), tweak or add masks. Edits persist per-image when switching tabs.
- Export: choose an output folder and export masked images in batch. The exporter preserves the original format and applies light compression to keep file sizes similar to the originals.

Notes & Tips

- For best detection results install `retinaface` in the Python environment used by the backend (it may require a compatible TensorFlow wheel).
- Exported JPEGs use sensible quality settings to avoid bloated file sizes; PNG output uses maximal compression (lossless).
- If the Electron app seems to hang on first run, run `npm install` beforehand to download Electron (the electron binary is large).

If you run into issues, open DevTools in the Electron window (View → Toggle Developer Tools) and check the Console for messages.
1. Python backend (recommended to run in your existing `.venv`):
