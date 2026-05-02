#!/usr/bin/env python3
"""Run RetinaFace detector on images in ./img and report results.

Saves annotated outputs to ./img/out for visual inspection and prints summary.
"""
import os
import time
import cv2
try:
    from retinaface import RetinaFace
except Exception:
    RetinaFace = None

IMG_DIR = os.path.join(os.path.dirname(__file__), 'img')
OUT_DIR = os.path.join(IMG_DIR, 'out')
os.makedirs(OUT_DIR, exist_ok=True)

def detect_with_retina(path):
    if RetinaFace is None:
        raise RuntimeError('retinaface package not importable')
    # RetinaFace.detect_faces returns dict keyed by face id
    return RetinaFace.detect_faces(path)

def annotate_and_save(path, faces, out_path):
    img = cv2.imread(path)
    if img is None:
        return False
    for k, v in (faces or {}).items():
        try:
            box = v.get('facial_area') or v.get('bbox')
            score = v.get('score') or v.get('score', 0)
            if box is None:
                continue
            x1, y1, x2, y2 = map(int, box)
            cv2.rectangle(img, (x1, y1), (x2, y2), (0, 255, 0), 2)
            cv2.putText(img, f'{score:.2f}', (x1, max(12, y1-6)), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0,255,0), 1)
        except Exception:
            continue
    cv2.imwrite(out_path, img, [int(cv2.IMWRITE_JPEG_QUALITY), 85])
    return True

def main():
    imgs = []
    if not os.path.isdir(IMG_DIR):
        print('No img directory found at', IMG_DIR)
        return
    for fn in sorted(os.listdir(IMG_DIR)):
        if fn.lower().endswith(('.jpg', '.jpeg', '.png')):
            imgs.append(os.path.join(IMG_DIR, fn))
    if not imgs:
        print('No images to test in', IMG_DIR)
        return

    summary = []
    for p in imgs:
        print('Testing', p)
        t0 = time.time()
        try:
            faces = detect_with_retina(p)
        except Exception as e:
            print('RetinaFace error:', e)
            faces = None
        dt = time.time() - t0
        n = len(faces) if faces else 0
        print(f'  -> detected {n} face(s) in {dt:.2f}s')
        out_p = os.path.join(OUT_DIR, os.path.basename(p))
        annotated = annotate_and_save(p, faces, out_p)
        print('  -> annotated saved to', out_p if annotated else 'failed')
        summary.append((p, n, dt))

    print('\nSummary:')
    for p, n, dt in summary:
        print(f'  {os.path.basename(p)}: {n} faces, {dt:.2f}s')

if __name__ == '__main__':
    main()
