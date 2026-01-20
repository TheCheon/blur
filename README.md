# Blur Faces

Electron + Flask app to detect faces and apply black-square masks. Frontend is an Electron renderer with a simple canvas editor; backend is a Flask server exposing `/detect`, `/mask`, and `/retina_mask` endpoints.

How to run

1. Create a Python virtualenv and install requirements:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

2. Start the Flask backend (if not run by the Electron main process):

```bash
python app.py
```

3. Run the Electron app:

```bash
npx electron .
```

Git

This repository was initialized locally. To push to GitHub:

```bash
git remote add origin <git-URL>
git push -u origin main
```

If you want me to create a GitHub repo and push automatically, provide a Personal Access Token (repo scope) and desired repo name/visibility.
# Blur Faces Electron App

This project is a minimal Electron GUI that lets you import images, detect faces using RetinaFace (Python), and apply black-square masks. You can edit automatic masks (remove or draw your own) per image.

Setup

1. Python backend (recommended to run in your existing `.venv`):

```bash
python3 -m pip install -r requirements.txt
python3 app.py
```

This will start a Flask server on `http://127.0.0.1:5000`.

2. Electron frontend

```bash
npm install
npm start
```

Usage

- Click `Import Images` to pick images.
- Click a thumbnail to open the editor.
- Click `Detect Faces` to run RetinaFace on the image (requires backend running).
- Click `Apply & Save Masks` to send masks to backend and receive masked image.
- Click inside an automatic mask to remove it. Click-drag on the canvas to draw your own mask rectangle.

Notes

- The backend uses `retinaface`, `opencv-python`, and `Pillow` — ensure they are installed in your Python environment.
- The app returns masked images as base64 and displays them in the editor; saving to disk is not implemented but can be added easily.
