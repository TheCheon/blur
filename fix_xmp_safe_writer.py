import os
import sys
import time
import random
import shutil
import tempfile
import copy
import struct
import xml.etree.ElementTree as ET
from pathlib import Path

# register common prefixes so output keeps them
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


def _decode_mask_points(hexstr):
    """Decode Darktable mask_points hex string into list of floats (little-endian)."""
    b = bytes.fromhex(hexstr)
    vals = []
    # unpack as little-endian floats
    for i in range(0, len(b), 4):
        vals.append(struct.unpack('<f', b[i:i+4])[0])
    return vals


def _encode_mask_points(floats):
    b = b''.join(struct.pack('<f', float(x)) for x in floats)
    return b.hex()


def make_mask_points(cx, cy, rx, ry, rotation_deg=0.0, feather=0.02):
    """Synthesize a valid Darktable mask_points hex blob from ellipse params.

    cx,cy,rx,ry are normalized in [0,1]. feather is in normalized units.
    """
    vals = [float(cx), float(cy), float(rx), float(ry), float(rotation_deg), float(feather), 0.0]
    return _encode_mask_points(vals)


def append_masks_from_detections(image_path, margin=0.30, min_conf=0.3, backup_dir=None):
    """Run face detector on image and append ellipse masks into its XMP safely.

    This function finds an existing mask_points blob to use as a template,
    decodes it, replaces the positional floats (cx,cy,rx,ry) per detection
    (normalized in [0,1]) and writes the new entries atomically after
    backing up the original XMP.
    """
    if not os.path.isfile(image_path):
        raise FileNotFoundError(image_path)
    # Darktable uses files like IMAGE.JPG.xmp (image file name + .xmp)
    xmp_path = image_path + '.xmp'

    # run detector (import main from workspace)
    try:
        import main as detector_module
    except Exception as e:
        raise RuntimeError('Failed to import detector module: ' + str(e))

    raw = detector_module.detect_with_mobilenet(image_path, min_conf=min_conf)
    dets = detector_module.parse_detections(raw)
    if not dets:
        return {'status': 'no_faces'}

    created_new = False
    if os.path.isfile(xmp_path):
        tree = ET.parse(xmp_path)
        root = tree.getroot()
    else:
        # create a minimal XMP structure when none exists
        created_new = True
        root = ET.Element('{' + 'adobe:ns:meta/' + '}xmpmeta')
        rdf = ET.SubElement(root, RDF + 'RDF')
        desc = ET.SubElement(rdf, RDF + 'Description')
        desc.set(RDF + 'about', '')
        desc.set('xmlns:darktable', DT_NS)
        # add empty history and masks_history
        masks_history = ET.SubElement(desc, DT + 'masks_history')
        ET.SubElement(masks_history, RDF + 'Seq')
        history = ET.SubElement(desc, DT + 'history')
        ET.SubElement(history, RDF + 'Seq')
        tree = ET.ElementTree(root)

    # find rdf:Description
    desc = root.find('.//' + RDF + 'Description')
    if desc is None:
        # try alternative path
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

    # we will synthesize mask_points from scratch (do not rely on existing blobs)

    # image size
    import cv2
    img = cv2.imread(image_path)
    if img is None:
        raise RuntimeError('Failed to read image for size: ' + image_path)
    h, w = img.shape[:2]

    # compute next history num
    next_num = None
    history = desc.find(DT + 'history')
    if history is not None:
        seq_h = history.find(RDF + 'Seq')
        nums = [int(li.get(DT + 'num')) for li in seq_h.findall(RDF + 'li') if li.get(DT + 'num') and li.get(DT + 'num').isdigit()]
        next_num = (max(nums) + 1) if nums else 0
    else:
        next_num = 0

    # backup original xmp (to backup_dir if provided) only if it existed
    bak = None
    if not created_new:
        bak = backup_file(xmp_path, backup_dir=backup_dir)
    # prepare text snippets for insertion so we preserve original formatting
    masks_li_texts = []
    for i, d in enumerate(dets, start=1):
        x1, y1, x2, y2 = d['bbox']
        cx = (x1 + x2) / 2.0 / w
        cy = (y1 + y2) / 2.0 / h
        rx = (x2 - x1) / 2.0 / w * (1.0 + margin)
        ry = (y2 - y1) / 2.0 / h * (1.0 + margin)
        mp = make_mask_points(cx, cy, rx, ry)
        lid = str(random.getrandbits(31))
        li = f'<rdf:li darktable:mask_num="{next_num}" darktable:mask_id="{lid}" darktable:mask_type="32" darktable:mask_name="ellipse auto {i}" darktable:mask_version="6" darktable:mask_points="{mp}" darktable:mask_nb="1" darktable:mask_src="0000000000000000"/>\n'
        masks_li_texts.append(li)

    history_li_text = None
    if history is not None:
        history_li_text = f'<rdf:li darktable:num="{next_num}" darktable:operation="censorize" darktable:enabled="1" darktable:modversion="1" darktable:params="285c8341000000000000000000000000" darktable:multi_name="" darktable:multi_name_hand_edited="0" darktable:multi_priority="0" darktable:blendop_version="14"/>\n'

    # Try text-level insertion (preserves original file as much as possible)
    inserted = _insert_into_xmp_text(xmp_path, masks_li_texts=masks_li_texts, history_li_text=history_li_text)
    if inserted:
        return {'status': 'ok', 'backup': bak, 'added': len(dets)}

    # Fallback: append via ElementTree (previous behavior)
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
        # parse the li_text into an Element and append
        try:
            elem = ET.fromstring(li_text)
            seq.append(elem)
        except Exception:
            # ignore malformed single li
            continue

    data = ET.tostring(root, encoding='utf-8', xml_declaration=True)
    atomic_write(xmp_path, data)
    ET.parse(xmp_path)
    return {'status': 'ok', 'backup': bak, 'added': len(dets)}

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
    """Insert given rdf:li text snippets into existing XMP text without reserializing the whole tree.

    Returns True if insertion happened, False otherwise.
    """
    masks_li_texts = masks_li_texts or []
    try:
        with open(xmp_path, 'r', encoding='utf-8') as f:
            text = f.read()
    except Exception:
        return False

    modified = False
    # Insert mask entries inside existing darktable:masks_history rdf:Seq
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
        # no masks_history: insert a full block before rdf:Description close
        desc_close = text.rfind('</rdf:Description>')
        if desc_close != -1 and masks_li_texts:
            block = '   <darktable:masks_history>\n    <rdf:Seq>\n'
            for li in masks_li_texts:
                block += '     ' + li
            block += '    </rdf:Seq>\n   </darktable:masks_history>\n'
            text = text[:desc_close] + block + text[desc_close:]
            modified = True

    # Insert history entry similarly
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

    # write back and validate
    atomic_write(xmp_path, text.encode('utf-8'))
    try:
        ET.parse(xmp_path)
    except Exception:
        return False
    return True

def append_ellipse_mask_by_copying(xmp_path, mask_name="ellipse auto", backup_dir=None):
    if not os.path.isfile(xmp_path):
        raise FileNotFoundError(xmp_path)
    # parse and find masks_history
    tree = ET.parse(xmp_path)
    root = tree.getroot()
    # <rdf:Description ...>
    desc = root.find(".//" + RDF + "Description")
    if desc is None:
        raise RuntimeError("Could not find rdf:Description in XMP")
    masks_history = desc.find(DT + "masks_history")
    if masks_history is None:
        # create masks_history if missing
        masks_history = ET.SubElement(desc, DT + 'masks_history')
        seq = ET.SubElement(masks_history, RDF + 'Seq')
    else:
        seq = masks_history.find(RDF + "Seq")
        if seq is None:
            seq = ET.SubElement(masks_history, RDF + 'Seq')

    # compute next history num for mask_num
    history = desc.find(DT + 'history')
    next_num = 0
    if history is not None:
        seq_h = history.find(RDF + 'Seq')
        if seq_h is not None:
            nums = [int(li.get(DT + 'num')) for li in seq_h.findall(RDF + 'li') if li.get(DT + 'num') and li.get(DT + 'num').isdigit()]
            next_num = (max(nums) + 1) if nums else 0

    # synthesize a default centered ellipse
    cx, cy, rx, ry = 0.5, 0.5, 0.1, 0.1
    mp = make_mask_points(cx, cy, rx, ry)
    lid = str(random.getrandbits(31))
    li_text = f'<rdf:li darktable:mask_num="{next_num}" darktable:mask_id="{lid}" darktable:mask_type="32" darktable:mask_name="{mask_name}" darktable:mask_version="6" darktable:mask_points="{mp}" darktable:mask_nb="1" darktable:mask_src="0000000000000000"/>\n'


    # append a basic censorize history entry (only if history present)
    history = desc.find(DT + "history")
    if history is not None:
        hseq = history.find(RDF + "Seq")
        if hseq is not None:
            # create a new history li element similar to others
            new_hist = ET.Element(RDF + "li")
            new_hist.set(DT + "num", str( int(time.time()) % 100000 ))
            new_hist.set(DT + "operation", "censorize")
            new_hist.set(DT + "enabled", "1")
            new_hist.set(DT + "modversion", "1")
            # params is a placeholder; darktable may accept it and you can tweak inside DT
            new_hist.set(DT + "params", "285c8341000000000000000000000000")
            new_hist.set(DT + "multi_name", "")
            new_hist.set(DT + "multi_name_hand_edited", "0")
            new_hist.set(DT + "multi_priority", "0")
            new_hist.set(DT + "blendop_version", "14")
            hseq.append(new_hist)
    # Backup original (to backup_dir if provided)
    bak = backup_file(xmp_path, backup_dir=backup_dir)

    # Try text-level insertion first
    history_li_text = None
    if history is not None and hseq is not None:
        history_li_text = f'<rdf:li darktable:num="{int(time.time()) % 100000}" darktable:operation="censorize" darktable:enabled="1" darktable:modversion="1" darktable:params="285c8341000000000000000000000000" darktable:multi_name="" darktable:multi_name_hand_edited="0" darktable:multi_priority="0" darktable:blendop_version="14"/>\n'

    inserted = _insert_into_xmp_text(xmp_path, masks_li_texts=[li_text], history_li_text=history_li_text)
    if inserted:
        return bak

    # Fallback: write using ElementTree (previous behavior)
    data = ET.tostring(root, encoding="utf-8", xml_declaration=True)
    atomic_write(xmp_path, data)
    ET.parse(xmp_path)
    return bak

def _process_folder(folder, backup_dir=None, detect=False, recursive=False, min_conf=0.3, margin=0.30):
    folder = Path(folder)
    image_exts = {'.jpg', '.jpeg', '.tif', '.tiff', '.png'}
    results = {'processed': 0, 'skipped': 0, 'errors': []}
    if recursive:
        it = folder.rglob('*')
    else:
        it = folder.iterdir()
    for p in it:
        if p.is_dir():
            continue
        if detect:
            if p.suffix.lower() in image_exts:
                try:
                    res = append_masks_from_detections(str(p), margin=margin, min_conf=min_conf, backup_dir=backup_dir)
                    if res.get('status') == 'ok':
                        results['processed'] += 1
                    else:
                        results['skipped'] += 1
                except Exception as e:
                    results['errors'].append((str(p), str(e)))
        else:
            # non-detect: operate on .xmp files directly
            if p.suffix.lower() == '.xmp':
                try:
                    bak = append_ellipse_mask_by_copying(str(p), backup_dir=backup_dir)
                    results['processed'] += 1
                except Exception as e:
                    results['errors'].append((str(p), str(e)))
            else:
                results['skipped'] += 1
    return results


def _cli_main():
    import argparse
    p = argparse.ArgumentParser(description='Safely append ellipse masks to Darktable XMP files (file or folder)')
    p.add_argument('path', help='File or folder to process')
    p.add_argument('--backup-dir', help='Directory to store .xmp backups')
    p.add_argument('--detect', action='store_true', help='Run face detector on images and create masks (requires detector dependencies)')
    p.add_argument('--recursive', action='store_true', help='Recurse into subfolders')
    p.add_argument('--min-conf', type=float, default=0.3, help='Min detection confidence (when --detect)')
    p.add_argument('--margin', type=float, default=0.30, help='Margin multiplier around detected bbox')
    args = p.parse_args()

    target = Path(args.path)
    if target.is_dir():
        res = _process_folder(str(target), backup_dir=args.backup_dir, detect=args.detect, recursive=args.recursive, min_conf=args.min_conf, margin=args.margin)
        print('folder result:', res)
        return 0
    else:
        # single file
        if args.detect:
            try:
                r = append_masks_from_detections(str(target), margin=args.margin, min_conf=args.min_conf, backup_dir=args.backup_dir)
                print('result:', r)
                return 0
            except Exception as e:
                print('error:', e)
                return 2
        else:
            pth = Path(args.path)
            if pth.suffix.lower() == '.xmp':
                try:
                    bak = append_ellipse_mask_by_copying(str(pth), backup_dir=args.backup_dir)
                    print('backup:', bak)
                    return 0
                except Exception as e:
                    print('error:', e)
                    return 2
            else:
                try:
                    r = append_masks_from_detections(str(pth), margin=args.margin, min_conf=args.min_conf, backup_dir=args.backup_dir)
                    print('result:', r)
                    return 0
                except Exception as e:
                    print('error:', e)
                    return 2


if __name__ == '__main__':
    sys.exit(_cli_main())