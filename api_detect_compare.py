#!/usr/bin/env python3
"""Send images in ./img to local /detect endpoint and save annotated results.
"""
import os
import requests
import cv2

IMG_DIR = os.path.join(os.path.dirname(__file__), 'img')
OUT_DIR = os.path.join(IMG_DIR, 'out_api')
os.makedirs(OUT_DIR, exist_ok=True)

URL = os.getenv('BLUR_API_URL', 'http://127.0.0.1:5000/detect')

def annotate(img_path, boxes, out_path):
    img = cv2.imread(img_path)
    if img is None:
        return False
    for b in boxes:
        try:
            x1, y1, x2, y2 = map(int, b)
            cv2.rectangle(img, (x1, y1), (x2, y2), (255, 0, 0), 2)
        except Exception:
            continue
    cv2.imwrite(out_path, img, [int(cv2.IMWRITE_JPEG_QUALITY), 85])
    return True

def main():
    imgs = [os.path.join(IMG_DIR, f) for f in sorted(os.listdir(IMG_DIR)) if f.lower().endswith(('.jpg', '.jpeg', '.png'))]
    if not imgs:
        print('No images to process in', IMG_DIR)
        return
    for p in imgs:
        print('POST', p)
        with open(p, 'rb') as fh:
            files = {'image': (os.path.basename(p), fh, 'application/octet-stream')}
            try:
                r = requests.post(URL, files=files, timeout=30)
            except Exception as e:
                print('Request failed:', e)
                continue
        try:
            data = r.json()
        except Exception as e:
            print('Invalid JSON response:', r.status_code, r.text[:200])
            continue
        method = data.get('method', 'unknown')
        boxes = data.get('boxes', []) or []
        print(f'  -> method: {method}, boxes: {len(boxes)}')
        outp = os.path.join(OUT_DIR, os.path.basename(p))
        annotate(p, boxes, outp)
        print('  -> annotated saved to', outp)

if __name__ == '__main__':
    main()
