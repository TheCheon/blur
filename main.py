import sys
import os
import argparse
import cv2
import numpy as np
import subprocess
import importlib
import json

def ensure_retinaface_module():
    """Return the imported `retinaface` package module or None.

    This package historically exposes different APIs depending on
    installation source. We prefer to return the package module and
    resolve the concrete detection function later.
    """
    try:
        return importlib.import_module("retinaface")
    except Exception:
        return None

# Do not import or attempt to install third-party packages at module import
# time. Importing this module should be safe for helper scripts that import
# detector utilities. The retinaface package will be resolved lazily inside
# the detection function.
RETINAFACE_PKG = None

"""
main.py

Detect and mark faces on an image using RetinaFace (WIDER FACE weights)
with the MobileNet backbone (mobilenet0.25) suitable for CPU use.

Requires:
    pip install retinaface opencv-python numpy

Usage:
    python main.py input.jpg [--out out.jpg] [--min-conf 0.5]
"""

def detect_with_mobilenet(path_or_img, min_conf=0.5):
    """
    Try common RetinaFace.detect_faces signatures and fallback to passing a cv2 image.
    Accepts either a filesystem path (str) or a numpy image.
    """
    # Determine if input is a filesystem path
    is_path = isinstance(path_or_img, str) and os.path.isfile(path_or_img)

    # Resolve a detect function from the installed package. There are a few
    # common shapes: package-level `detect_faces`, a `RetinaFace` attribute
    # with `detect_faces`, or the module `retinaface.RetinaFace` which defines
    # `detect_faces`.
    # lazily import the retinaface package to avoid side-effects at module
    # import time. Other scripts import this module to reuse helpers and
    # should not trigger package installation attempts.
    global RETINAFACE_PKG
    if RETINAFACE_PKG is None:
        RETINAFACE_PKG = ensure_retinaface_module()
    if RETINAFACE_PKG is None:
        raise RuntimeError('retinaface package not found. Install with: pip install retinaface')

    detect_candidates = []
    pkg = RETINAFACE_PKG
    if pkg is not None:
        if hasattr(pkg, "detect_faces"):
            detect_candidates.append(getattr(pkg, "detect_faces"))
        if hasattr(pkg, "RetinaFace"):
            RF = getattr(pkg, "RetinaFace")
            if hasattr(RF, "detect_faces"):
                detect_candidates.append(getattr(RF, "detect_faces"))
        try:
            impl = importlib.import_module("retinaface.RetinaFace")
            if hasattr(impl, "detect_faces"):
                detect_candidates.append(getattr(impl, "detect_faces"))
        except Exception:
            pass

    # Remove duplicates while preserving order
    seen = set()
    detect_funcs = []
    for f in detect_candidates:
        if f in seen:
            continue
        seen.add(f)
        detect_funcs.append(f)

    # Try calling each detect function with a few plausible signatures
    for detect in detect_funcs:
        try:
            return detect(path_or_img, threshold=float(min_conf))
        except TypeError:
            try:
                return detect(path_or_img, float(min_conf))
            except Exception:
                pass
        except Exception:
            continue

    # If nothing worked, and input is a path, try with an OpenCV image
    if is_path:
        img = cv2.imread(path_or_img)
        if img is None:
            raise RuntimeError("Failed to read image for RetinaFace fallback")
        for detect in detect_funcs:
            try:
                return detect(img, threshold=float(min_conf))
            except Exception:
                try:
                    return detect(img, float(min_conf))
                except Exception:
                    continue

    raise RuntimeError("RetinaFace.detect_faces failed with all attempted signatures")

def parse_detections(raw):
    """
    Normalizes detection outputs into a list of dicts:
      { "bbox": (x1,y1,x2,y2), "score": float, "landmarks": {name:(x,y),...} }
    """
    out = []
    # If retinaface returns a dict keyed by face id
    if isinstance(raw, dict):
        iterable = raw.items()
        for _, v in iterable:
            det = {}
            if isinstance(v, dict):
                if "facial_area" in v:
                    x1, y1, x2, y2 = v["facial_area"]
                    det["bbox"] = (int(x1), int(y1), int(x2), int(y2))
                elif "bbox" in v:
                    b = v["bbox"]
                    det["bbox"] = tuple(map(int, b))
                det["score"] = float(v.get("score", v.get("confidence", 0.0)))
                lm = v.get("landmarks") or v.get("keypoints")
                if isinstance(lm, dict):
                    det["landmarks"] = {k: (int(p[0]), int(p[1])) for k, p in lm.items()}
            out.append(det)
    # If retinaface returns a list (some forks)
    elif isinstance(raw, (list, tuple, np.ndarray)):
        for item in raw:
            det = {}
            if isinstance(item, dict):
                if "bbox" in item:
                    det["bbox"] = tuple(map(int, item["bbox"]))
                det["score"] = float(item.get("score", item.get("confidence", 0.0)))
                lm = item.get("landmarks") or item.get("keypoints")
                if isinstance(lm, dict):
                    det["landmarks"] = {k: (int(p[0]), int(p[1])) for k, p in lm.items()}
            elif isinstance(item, (list, tuple)) and len(item) >= 4:
                # e.g., (x1,y1,x2,y2,score, ...)
                det["bbox"] = tuple(map(int, item[:4]))
                if len(item) >= 5:
                    det["score"] = float(item[4])
            out.append(det)
    return [d for d in out if "bbox" in d]

def draw_annotations(img, detections, min_conf=0.5):
    h, w = img.shape[:2]
    for i, d in enumerate(detections, 1):
        score = d.get("score", 1.0)
        if score < min_conf:
            continue
        x1, y1, x2, y2 = d["bbox"]
        # clamp
        x1, y1, x2, y2 = max(0, x1), max(0, y1), min(w - 1, x2), min(h - 1, y2)
        # box
        cv2.rectangle(img, (x1, y1), (x2, y2), (0, 255, 0), 2)
        # label
        label = f"{score:.2f}"
        cv2.putText(img, label, (x1, max(12, y1 - 6)), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0,255,0), 1)
        # landmarks
        lm = d.get("landmarks") or {}
        for name, p in lm.items():
            cv2.circle(img, (int(p[0]), int(p[1])), 2, (0, 0, 255), -1)
    return img

def main():
    p = argparse.ArgumentParser(description="RetinaFace (mobilenet0.25) CPU face detector and annotator")
    p.add_argument("input", help="Input image path")
    p.add_argument("--out", "-o", help="Output path (default: input_faces.jpg)")
    p.add_argument("--min-conf", type=float, default=0.5, help="Minimum confidence to draw (default 0.5)")
    p.add_argument("--json", action="store_true", help="Print detections as JSON to stdout (bbox,score)")
    p.add_argument("--json-file", help="Write JSON detections to this file instead of stdout")
    args = p.parse_args()

    if not os.path.isfile(args.input):
        sys.exit("Input file not found: " + args.input)

    # Run detection (attempt to select mobilenet backbone)
    try:
        raw = detect_with_mobilenet(args.input, min_conf=args.min_conf)
    except Exception as e:
        sys.exit("Detection failed: " + str(e))

    detections = parse_detections(raw)

    # If JSON mode requested, emit simple JSON and exit
    if args.json or args.json_file:
        out = []
        for d in detections:
            bbox = list(map(int, d.get('bbox', (0,0,0,0))))
            out.append({ 'bbox': bbox, 'score': float(d.get('score', 0.0)) })
        j = json.dumps(out)
        if args.json_file:
            with open(args.json_file, 'w') as f:
                f.write(j)
            print('wrote json to', args.json_file)
        else:
            print(j)
        return

    img = cv2.imread(args.input)
    if img is None:
        sys.exit("Failed to load image with OpenCV")

    annotated = draw_annotations(img, detections, min_conf=args.min_conf)

    out_path = args.out or (os.path.splitext(args.input)[0] + "_faces" + os.path.splitext(args.input)[1])
    cv2.imwrite(out_path, annotated)
    print(f"Saved annotated image: {out_path}")
    print(f"Faces detected: {sum(1 for d in detections if d.get('score',1.0) >= args.min_conf)}")

if __name__ == "__main__":
    main()