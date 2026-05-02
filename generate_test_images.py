#!/usr/bin/env python3
"""Generate low-quality, partially obstructed test images for RetinaFace.

Copies images from ~/things/Wallpapers into ./img, downsizes, adds noise
and rectangular occluders to simulate poor-quality/partially-obstructed faces.
"""
import os
import random
import cv2
import numpy as np

HOME_WALLPAPERS = os.path.expanduser('~/things/Wallpapers')
OUT_DIR = os.path.join(os.path.dirname(__file__), 'img')
os.makedirs(OUT_DIR, exist_ok=True)

def list_images(folder, exts=('.jpg', '.jpeg', '.png')):
    files = []
    for fn in os.listdir(folder):
        if fn.lower().endswith(exts):
            files.append(os.path.join(folder, fn))
    return files

def add_noise(img, amount=0.05):
    h, w = img.shape[:2]
    noise = np.random.randn(h, w, 3) * 255 * amount
    noisy = img.astype('float32') + noise
    noisy = np.clip(noisy, 0, 255).astype('uint8')
    return noisy

def add_occluder(img):
    h, w = img.shape[:2]
    # place 1-2 rectangular occluders at random positions
    n = random.choice([1, 2])
    for _ in range(n):
        rw = random.randint(int(w*0.15), int(w*0.5))
        rh = random.randint(int(h*0.06), int(h*0.2))
        x = random.randint(0, max(0, w - rw))
        y = random.randint(0, max(0, h - rh))
        color = (random.randint(0, 40),) * 3  # dark occluder
        cv2.rectangle(img, (x, y), (x+rw, y+rh), color, -1)
    return img

def process_image(src, idx):
    img = cv2.imread(src)
    if img is None:
        return None
    # resize to low resolution
    target_w = random.choice([320, 400, 480])
    h, w = img.shape[:2]
    scale = target_w / float(w)
    new_h = int(h * scale)
    img = cv2.resize(img, (target_w, new_h), interpolation=cv2.INTER_AREA)
    # add blur
    if random.random() < 0.7:
        k = random.choice([3,5,7])
        img = cv2.GaussianBlur(img, (k, k), 0)
    # add occlusion
    img = add_occluder(img)
    # add noise
    img = add_noise(img, amount=random.uniform(0.03, 0.12))
    out_path = os.path.join(OUT_DIR, f'test_{idx}.jpg')
    # write low-quality jpeg
    cv2.imwrite(out_path, img, [int(cv2.IMWRITE_JPEG_QUALITY), 30])
    return out_path

def main():
    imgs = list_images(HOME_WALLPAPERS)
    if not imgs:
        print('No images found in', HOME_WALLPAPERS)
        return
    random.shuffle(imgs)
    chosen = imgs[:8]
    out_paths = []
    for i, src in enumerate(chosen, 1):
        out = process_image(src, i)
        if out:
            out_paths.append(out)
            print('wrote', out)
    print('\nGenerated', len(out_paths), 'test images in', OUT_DIR)

if __name__ == '__main__':
    main()
