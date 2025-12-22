#!/usr/bin/env python3
"""Add ellipse drawn-masks for detected faces into a Darktable XMP file.

Usage: python add_face_masks_to_xmp.py input.jpg

This script:
- runs the face detector from `main.py` to get bounding boxes
- backs up the original XMP (`.xmp.bak`)
- inserts ellipse mask entries into `darktable:masks_history`
- appends a `censorize` history entry referencing the new mask_num

Notes: ellipse parameters are encoded as little-endian floats and hexified
to match Darktable's `mask_points` format (center_x, center_y, rx, ry,
rotation_deg, feather, reserved).
"""
import sys
import os
import shutil
import struct
import random
import xml.etree.ElementTree as ET

from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))
import main as detector_module
import cv2

NS = {
    'rdf': 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
    'darktable': 'http://darktable.sf.net/'
}

def float_list_to_hex(floats):
    b = b''.join(struct.pack('<f', float(x)) for x in floats)
    return b.hex()

def make_mask_points(cx, cy, rx, ry, rotation_deg=0.0, feather=0.001):
    # pack as [cx, cy, rx, ry, rotation_deg, feather, 0.0]
    return float_list_to_hex([cx, cy, rx, ry, rotation_deg, feather, 0.0])

def find_next_history_num(root):
    # find max darktable:num in history entries
    desc = root.find('.//rdf:Description', NS)
    hist = desc.find('darktable:history', NS)
    seq = hist.find('rdf:Seq', NS)
    maxn = -1
    for li in seq.findall('rdf:li', NS):
        n = li.get('{%s}num' % NS['darktable'])
        if n is not None:
            try:
                maxn = max(maxn, int(n))
            except Exception:
                pass
    return maxn + 1

def add_history_censorize(seq_elem, num):
    # Copy parameters from existing censorize if present, else create a minimal entry
    li = ET.SubElement(seq_elem, '{%s}li' % NS['rdf'])
    li.set('{%s}num' % NS['darktable'], str(num))
    li.set('{%s}operation' % NS['darktable'], 'censorize')
    li.set('{%s}enabled' % NS['darktable'], '1')
    li.set('{%s}modversion' % NS['darktable'], '1')
    # params here are tolerant; Darktable uses the masks_history to find masks
    li.set('{%s}params' % NS['darktable'], '00000000000000000000000000000000')
    li.set('{%s}multi_name' % NS['darktable'], '')
    li.set('{%s}multi_name_hand_edited' % NS['darktable'], '0')
    li.set('{%s}multi_priority' % NS['darktable'], '0')
    li.set('{%s}blendop_version' % NS['darktable'], '14')
    li.set('{%s}blendop_params' % NS['darktable'], '')
    return li

def add_mask_history_entry(seq_elem, mask_num, cx, cy, rx, ry, idx):
    li = ET.SubElement(seq_elem, '{%s}li' % NS['rdf'])
    li.set('{%s}mask_num' % NS['darktable'], str(mask_num))
    li.set('{%s}mask_id' % NS['darktable'], str(random.getrandbits(31)))
    li.set('{%s}mask_type' % NS['darktable'], '32')
    li.set('{%s}mask_name' % NS['darktable'], f'ellipse #{idx}')
    li.set('{%s}mask_version' % NS['darktable'], '6')
    li.set('{%s}mask_points' % NS['darktable'], make_mask_points(cx, cy, rx, ry))
    li.set('{%s}mask_nb' % NS['darktable'], '1')
    li.set('{%s}mask_src' % NS['darktable'], '0000000000000000')
    return li

def backup_xmp(xmp_path):
    bak = xmp_path.with_suffix(xmp_path.suffix + '.bak')
    shutil.copy2(xmp_path, bak)
    return bak

def process(image_path, margin=0.30):
    img_p = Path(image_path)
    if not img_p.exists():
        print('input not found:', image_path)
        return 1

    xmp_path = img_p.with_suffix(img_p.suffix + '.xmp')
    if not xmp_path.exists():
        print('xmp file not found:', xmp_path)
        return 1

    # run detector
    raw = detector_module.detect_with_mobilenet(str(img_p), min_conf=0.3)
    dets = detector_module.parse_detections(raw)
    if not dets:
        print('no faces detected')
        return 0

    img = cv2.imread(str(img_p))
    h, w = img.shape[:2]

    # parse xmp
    tree = ET.parse(str(xmp_path))
    root = tree.getroot()

    desc = root.find('.//rdf:Description', NS)
    masks_hist = desc.find('darktable:masks_history', NS)
    if masks_hist is None:
        # create it
        masks_hist = ET.SubElement(desc, '{%s}masks_history' % NS['darktable'])
        seq = ET.SubElement(masks_hist, '{%s}Seq' % NS['rdf'])
    else:
        seq = masks_hist.find('rdf:Seq', NS)

    # find history seq to append censorize entry
    hist = desc.find('darktable:history', NS)
    hist_seq = hist.find('rdf:Seq', NS)

    next_num = find_next_history_num(root)
    # backup
    bak = backup_xmp(xmp_path)
    print('backed up', xmp_path, '->', bak)

    # add censorize history entry
    add_history_censorize(hist_seq, next_num)

    # add ellipse masks
    for i, d in enumerate(dets, 1):
        x1, y1, x2, y2 = d['bbox']
        cx = (x1 + x2) / 2.0 / w
        cy = (y1 + y2) / 2.0 / h
        rx = (x2 - x1) / 2.0 / w * (1.0 + margin)
        ry = (y2 - y1) / 2.0 / h * (1.0 + margin)
        add_mask_history_entry(seq, next_num, cx, cy, rx, ry, i)

    # write back
    tree.write(str(xmp_path), encoding='utf-8', xml_declaration=True)
    print('wrote masks to', xmp_path)
    return 0

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print('usage: add_face_masks_to_xmp.py image.jpg')
        sys.exit(1)
    sys.exit(process(sys.argv[1]))
