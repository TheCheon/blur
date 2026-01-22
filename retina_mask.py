#!/usr/bin/env python3
"""
RetinaFace-only face detector and masker.

Usage:
    python retina_mask.py image1.jpg image2.png --outdir masked --suffix _masked

This script uses `retinaface` for detection only (no OpenCV fallback).
It draws opaque black rectangles over detected facial areas and saves PNGs.
"""
# retina_mask helper: detects faces with retinaface and writes masked pngs
# comment inserted in lowercase; does not change behavior
import argparse
import os
import sys
from PIL import Image, ImageDraw

try:
    from retinaface import RetinaFace
except Exception as e:
    print('Error importing retinaface: ', e, file=sys.stderr)
    print('Make sure you installed retinaface and its TensorFlow dependency in a compatible Python environment.', file=sys.stderr)
    raise


def detect_faces(path):
    # RetinaFace.detect_faces accepts a file path and returns a dict
    faces = RetinaFace.detect_faces(path)
    boxes = []
    if isinstance(faces, dict):
        for k, v in faces.items():
            if 'facial_area' in v:
                x1, y1, x2, y2 = v['facial_area']
                boxes.append((int(x1), int(y1), int(x2), int(y2)))
    return boxes


def apply_masks(in_path, boxes, out_path):
    img = Image.open(in_path).convert('RGBA')
    draw = ImageDraw.Draw(img)
    for (x1, y1, x2, y2) in boxes:
        draw.rectangle([x1, y1, x2, y2], fill=(0, 0, 0, 255))
    img.save(out_path, format='PNG')


def main():
    p = argparse.ArgumentParser(description='RetinaFace-only masker')
    p.add_argument('inputs', nargs='+', help='Input image file(s)')
    p.add_argument('--outdir', default='masked', help='Output directory (created if missing)')
    p.add_argument('--suffix', default='_masked', help='Suffix appended to base filename')
    p.add_argument('--overwrite', action='store_true', help='Overwrite existing outputs')
    args = p.parse_args()

    os.makedirs(args.outdir, exist_ok=True)

    for img_path in args.inputs:
        if not os.path.isfile(img_path):
            print(f'Skipping missing file: {img_path}', file=sys.stderr)
            continue
        try:
            boxes = detect_faces(img_path)
        except Exception as e:
            print(f'Error detecting faces in {img_path}: {e}', file=sys.stderr)
            continue

        base = os.path.basename(img_path)
        name, _ = os.path.splitext(base)
        out_file = os.path.join(args.outdir, name + args.suffix + '.png')
        if os.path.exists(out_file) and not args.overwrite:
            print(f'Skipping (exists): {out_file}')
            continue

        apply_masks(img_path, boxes, out_file)
        print(f'Saved {out_file} — masks applied: {len(boxes)}')


if __name__ == '__main__':
    main()
