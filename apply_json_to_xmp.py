#!/usr/bin/env python3
import sys
import os
import json
import time
import random
import shutil
import tempfile
import struct
import xml.etree.ElementTree as ET
from pathlib import Path

ET.register_namespace("x", "adobe:ns:meta/")
ET.register_namespace("rdf", "http://www.w3.org/1999/02/22-rdf-syntax-ns#")
ET.register_namespace("darktable", "http://darktable.sf.net/")

DT_NS = "http://darktable.sf.net/"
RDF_NS = "http://www.w3.org/1999/02/22-rdf-syntax-ns#"
DT = "{%s}" % DT_NS
RDF = "{%s}" % RDF_NS

def backup_file(path, backup_dir=None):
    p = Path(path)
    ts = int(time.time())
    if backup_dir:
        Path(backup_dir).mkdir(parents=True, exist_ok=True)
        bak_name = f"{p.name}.bak.{ts}"
        bak = str(Path(backup_dir) / bak_name)
    else:
        bak = f"{path}.bak.{ts}"
    shutil.copy2(path, bak)
    return bak

def _encode_mask_points(floats):
    b = b''.join(struct.pack('<f', float(x)) for x in floats)
    return b.hex()

def make_mask_points(cx, cy, rx, ry, rotation_deg=0.0, feather=0.02):
    vals = [float(cx), float(cy), float(rx), float(ry), float(rotation_deg), float(feather), 0.0]
    return _encode_mask_points(vals)

def atomic_write(path, data_bytes):
    dirn = os.path.dirname(path) or "."
    fd, tmp = tempfile.mkstemp(prefix="._xmp_write_", dir=dirn)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data_bytes)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)

def _insert_into_xmp_text(xmp_path, masks_li_texts=None, history_li_text=None):
    masks_li_texts = masks_li_texts or []
    try:
        with open(xmp_path, 'r', encoding='utf-8') as f:
            text = f.read()
    except Exception:
        return False
    modified = False
    if '<darktable:masks_history' in text:
        start = text.find('<darktable:masks_history')
        seq_open = text.find('<rdf:Seq', start)
        if seq_open != -1:
            seq_close = text.find('</rdf:Seq>', seq_open)
            if seq_close != -1:
                insertion = ''.join(masks_li_texts)
                text = text[:seq_close] + insertion + text[seq_close:]
                modified = True
    else:
        desc_close = text.rfind('</rdf:Description>')
        if desc_close != -1 and masks_li_texts:
            block = '   <darktable:masks_history>\n    <rdf:Seq>\n'
            for li in masks_li_texts:
                block += '     ' + li
            block += '    </rdf:Seq>\n   </darktable:masks_history>\n'
            text = text[:desc_close] + block + text[desc_close:]
            modified = True
    if history_li_text:
        if '<darktable:history' in text:
            start = text.find('<darktable:history')
            seq_open = text.find('<rdf:Seq', start)
            if seq_open != -1:
                seq_close = text.find('</rdf:Seq>', seq_open)
                if seq_close != -1:
                    text = text[:seq_close] + history_li_text + text[seq_close:]
                    modified = True
        else:
            desc_close = text.rfind('</rdf:Description>')
            if desc_close != -1:
                block = '   <darktable:history>\n    <rdf:Seq>\n' + history_li_text + '    </rdf:Seq>\n   </darktable:history>\n'
                text = text[:desc_close] + block + text[desc_close:]
                modified = True
    if not modified:
        return False
    atomic_write(xmp_path, text.encode('utf-8'))
    try:
        ET.parse(xmp_path)
    except Exception:
        return False
    return True

def apply_json(image_path, json_path, backup_dir=None, min_conf=0.3, margin=0.30, feather=0.02):
    if not os.path.isfile(image_path):
        raise FileNotFoundError(image_path)
    with open(json_path, 'r') as f:
        dets = json.load(f)
    # filter by score
    dets = [d for d in dets if float(d.get('score', 0.0)) >= float(min_conf)]
    if not dets:
        return {'status': 'no_faces'}
    xmp_path = image_path + '.xmp'
    created_new = False
    if os.path.isfile(xmp_path):
        tree = ET.parse(xmp_path)
        root = tree.getroot()
    else:
        created_new = True
        root = ET.Element('{' + 'adobe:ns:meta/' + '}xmpmeta')
        rdf = ET.SubElement(root, RDF + 'RDF')
        desc = ET.SubElement(rdf, RDF + 'Description')
        desc.set(RDF + 'about', '')
        desc.set('xmlns:darktable', DT_NS)
        masks_history = ET.SubElement(desc, DT + 'masks_history')
        ET.SubElement(masks_history, RDF + 'Seq')
        history = ET.SubElement(desc, DT + 'history')
        ET.SubElement(history, RDF + 'Seq')
        tree = ET.ElementTree(root)
    desc = root.find('.//' + RDF + 'Description')
    if desc is None:
        desc = root.find('.//' + 'Description')
    if desc is None:
        raise RuntimeError('rdf:Description not found or created')
    masks_history = desc.find(DT + 'masks_history')
    if masks_history is None:
        masks_history = ET.SubElement(desc, DT + 'masks_history')
        ET.SubElement(masks_history, RDF + 'Seq')
    seq = masks_history.find(RDF + 'Seq')
    if seq is None:
        seq = ET.SubElement(masks_history, RDF + 'Seq')
    history = desc.find(DT + 'history')
    # read image size
    import cv2
    img = cv2.imread(image_path)
    if img is None:
        raise RuntimeError('Failed to read image for size: ' + image_path)
    h, w = img.shape[:2]
    next_num = 0
    if history is not None:
        seq_h = history.find(RDF + 'Seq')
        nums = [int(li.get(DT + 'num')) for li in seq_h.findall(RDF + 'li') if li.get(DT + 'num') and li.get(DT + 'num').isdigit()]
        next_num = (max(nums) + 1) if nums else 0
    bak = None
    if not created_new:
        bak = backup_file(xmp_path, backup_dir=backup_dir)
    masks_li_texts = []
    for i, d in enumerate(dets, start=1):
        bbox = d.get('bbox', [0,0,0,0])
        x1, y1, x2, y2 = map(int, bbox)
        cx = (x1 + x2) / 2.0 / w
        cy = (y1 + y2) / 2.0 / h
        rx = (x2 - x1) / 2.0 / w * (1.0 + float(margin))
        ry = (y2 - y1) / 2.0 / h * (1.0 + float(margin))
        mp = make_mask_points(cx, cy, rx, ry, feather=float(feather))
        lid = str(random.getrandbits(31))
        li = f'<rdf:li darktable:mask_num="{next_num}" darktable:mask_id="{lid}" darktable:mask_type="32" darktable:mask_name="ellipse auto {i}" darktable:mask_version="6" darktable:mask_points="{mp}" darktable:mask_nb="1" darktable:mask_src="0000000000000000"/>\n'
        masks_li_texts.append(li)
    history_li_text = None
    if history is not None:
        history_li_text = f'<rdf:li darktable:num="{next_num}" darktable:operation="censorize" darktable:enabled="1" darktable:modversion="1" darktable:params="285c8341000000000000000000000000" darktable:multi_name="" darktable:multi_name_hand_edited="0" darktable:multi_priority="0" darktable:blendop_version="14"/>\n'
    inserted = _insert_into_xmp_text(xmp_path, masks_li_texts=masks_li_texts, history_li_text=history_li_text)
    if inserted:
        return {'status': 'ok', 'backup': bak, 'added': len(dets)}
    # fallback ElementTree
    if history is not None and history_li_text is not None:
        add_hist = ET.Element(RDF + 'li')
        add_hist.set(DT + 'num', str(next_num))
        add_hist.set(DT + 'operation', 'censorize')
        add_hist.set(DT + 'enabled', '1')
        add_hist.set(DT + 'modversion', '1')
        add_hist.set(DT + 'params', '285c8341000000000000000000000000')
        add_hist.set(DT + 'multi_name', '')
        add_hist.set(DT + 'multi_name_hand_edited', '0')
        add_hist.set(DT + 'multi_priority', '0')
        add_hist.set(DT + 'blendop_version', '14')
        seq_h.append(add_hist)
    for li_text in masks_li_texts:
        try:
            elem = ET.fromstring(li_text)
            seq.append(elem)
        except Exception:
            continue
    data = ET.tostring(root, encoding='utf-8', xml_declaration=True)
    atomic_write(xmp_path, data)
    ET.parse(xmp_path)
    return {'status': 'ok', 'backup': bak, 'added': len(dets)}

def _cli():
    import argparse
    p = argparse.ArgumentParser(description='Apply detector JSON to Darktable XMP')
    p.add_argument('image', help='Image file path')
    p.add_argument('json', help='JSON detections file')
    p.add_argument('--backup-dir', help='backup dir')
    p.add_argument('--min-conf', type=float, default=0.3)
    p.add_argument('--margin', type=float, default=0.30)
    p.add_argument('--feather', type=float, default=0.02)
    args = p.parse_args()
    res = apply_json(args.image, args.json, backup_dir=args.backup_dir, min_conf=args.min_conf, margin=args.margin, feather=args.feather)
    print(res)

if __name__ == '__main__':
    _cli()
