from flask import Flask, request, jsonify
from flask_cors import CORS
import cv2
import numpy as np
import base64
from io import BytesIO
from PIL import Image
from retinaface import RetinaFace

app = Flask(__name__)
CORS(app)


@app.route('/')
def index():
    return '''<html><body><h3>Blur Faces API</h3>
<p>Available endpoints:</p>
<ul>
<li>/retina_mask (POST) - run RetinaFace and return masked image + boxes</li>
<li>/mask (POST) - apply provided boxes and return masked image</li>
</ul>
<p>Send POST with form field `image` (file).</p>
</body></html>'''


def read_image_from_file_storage(fs):
    data = fs.read()
    arr = np.frombuffer(data, np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    return img, data


def encode_jpeg_target(pil_im, target_bytes=None, min_q=30, max_q=95, allow_increase_ratio=1.05):
    """Encode PIL image to JPEG trying to meet target_bytes using binary search on quality.
    Returns bytes.
    If target_bytes is None, returns a high-quality encoding (max_q).
    """
    # quick path: no target
    if target_bytes is None:
        bio = BytesIO()
        try:
            pil_im.save(bio, format='JPEG', quality=max_q, optimize=True, progressive=True)
        except Exception:
            pil_im.save(bio, format='JPEG', quality=max_q)
        return bio.getvalue()

    # clamp target
    target = int(target_bytes)
    lo = min_q
    hi = max_q
    best = None
    best_q = lo
    # binary search for quality that produces size <= target*allow_increase_ratio
    allowed = int(target * allow_increase_ratio)
    # try hi first to preserve quality
    try_q = hi
    bio = BytesIO()
    try:
        pil_im.save(bio, format='JPEG', quality=try_q, optimize=True, progressive=True)
    except Exception:
        pil_im.save(bio, format='JPEG', quality=try_q)
    data = bio.getvalue(); size = len(data)
    if size <= allowed:
        return data
    # otherwise binary search downwards
    best = data; best_q = try_q
    while lo <= hi:
        mid = (lo + hi) // 2
        bio = BytesIO()
        try:
            pil_im.save(bio, format='JPEG', quality=mid, optimize=True, progressive=True)
        except Exception:
            pil_im.save(bio, format='JPEG', quality=mid)
        data_mid = bio.getvalue(); size_mid = len(data_mid)
        # if fits, try higher quality
        if size_mid <= allowed:
            best = data_mid; best_q = mid
            lo = mid + 1
        else:
            # too large, decrease quality
            hi = mid - 1
        # track smallest seen
        if best is None or size_mid < len(best):
            best = data_mid; best_q = mid
    # return best we found
    return best


@app.route('/detect', methods=['POST'])
def detect():
    if 'image' not in request.files:
        return jsonify({'error': 'no image'}), 400
    img_res = read_image_from_file_storage(request.files['image'])
    if not img_res:
        return jsonify({'error': 'invalid image'}), 400
    img, _raw = img_res
    # RetinaFace expects RGB
    rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    try:
        faces = RetinaFace.detect_faces(rgb)
    except Exception as e:
        return jsonify({'error': str(e)}), 500
    boxes = []
    if isinstance(faces, dict):
        for k, v in faces.items():
            if 'facial_area' in v:
                x1, y1, x2, y2 = v['facial_area']
                boxes.append([int(x1), int(y1), int(x2), int(y2)])
    return jsonify({'boxes': boxes})


@app.route('/mask', methods=['POST'])
def mask():
    if 'image' not in request.files:
        return jsonify({'error': 'no image'}), 400
    img_res = read_image_from_file_storage(request.files['image'])
    if not img_res:
        return jsonify({'error': 'invalid image'}), 400
    img, raw = img_res
    orig_size_bytes = len(raw) if raw is not None else None
    boxes = []
    if 'boxes' in request.form:
        import json
        try:
            boxes = json.loads(request.form['boxes'])
        except Exception:
            boxes = []
    # apply black rectangles
    for b in boxes:
        try:
            x1, y1, x2, y2 = map(int, b)
            x1 = max(0, x1); y1 = max(0, y1)
            x2 = min(img.shape[1]-1, x2); y2 = min(img.shape[0]-1, y2)
            cv2.rectangle(img, (x1, y1), (x2, y2), (0, 0, 0), thickness=-1)
        except Exception:
            continue
    # return image as base64 in the same format as uploaded (preserve extension when possible)
    try:
        filename = request.files['image'].filename or ''
    except Exception:
        filename = ''
    ext = ('.' + filename.split('.')[-1].lower()) if '.' in filename else '.png'
    # Use Pillow to re-encode with sensible settings and try to keep output size similar to original
    try:
        from PIL import Image
        im = Image.fromarray(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))
        buf = None
        out_mime = 'image/png'
        # If image has alpha channel, keep PNG
        has_alpha = (im.mode in ('LA', 'RGBA') or ('transparency' in im.info))
        # Determine aggressive target behavior
        if not has_alpha:
            # prefer JPEG output to save size — determine a reasonable target
            # target the original size if available, clamp to sensible max (1.5MB)
            target = None
            if orig_size_bytes:
                target = int(min(orig_size_bytes, 1_500_000))
            try:
                buf = encode_jpeg_target(im, target_bytes=target, min_q=30, max_q=90, allow_increase_ratio=1.0)
                out_mime = 'image/jpeg'
            except Exception:
                bio = BytesIO();
                try:
                    im.save(bio, format='JPEG', quality=85, optimize=True)
                except Exception:
                    im.save(bio, format='JPEG', quality=85)
                buf = bio.getvalue(); out_mime = 'image/jpeg'
        else:
            # has alpha — fall back to compressed PNG
            bio = BytesIO(); im.save(bio, format='PNG', optimize=True, compress_level=9); buf = bio.getvalue(); out_mime = 'image/png'
        b64 = base64.b64encode(buf).decode('ascii')
        return jsonify({'image': f'data:{out_mime};base64,' + b64})
    except Exception:
        # fallback to OpenCV encode
        if ext in ('.jpg', '.jpeg'):
            success, buf = cv2.imencode('.jpg', img, [int(cv2.IMWRITE_JPEG_QUALITY), 85])
            out_mime = 'image/jpeg'
        else:
            success, buf = cv2.imencode('.png', img, [int(cv2.IMWRITE_PNG_COMPRESSION), 9])
            out_mime = 'image/png'
        if not success:
            _, buf = cv2.imencode('.png', img)
            out_mime = 'image/png'
        b64 = base64.b64encode(buf).decode('ascii')
        return jsonify({'image': f'data:{out_mime};base64,' + b64})


@app.route('/retina_mask', methods=['POST'])
def retina_mask():
    """Run RetinaFace detection and apply black masks in one request.
    Returns JSON with `image` (base64 PNG) and `boxes` list.
    This endpoint requires `retinaface`/TensorFlow available in the environment.
    """
    # require retinaface
    try:
        from retinaface import RetinaFace
    except Exception as e:
        return jsonify({'error': 'retinaface not available: ' + str(e)}), 500

    if 'image' not in request.files:
        return jsonify({'error': 'no image'}), 400
    img_res = read_image_from_file_storage(request.files['image'])
    if not img_res:
        return jsonify({'error': 'invalid image'}), 400
    img, raw = img_res
    orig_size_bytes = len(raw) if raw is not None else None
    rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    try:
        faces = RetinaFace.detect_faces(rgb)
    except Exception as e:
        return jsonify({'error': str(e)}), 500

    boxes = []
    if isinstance(faces, dict):
        for k, v in faces.items():
            if 'facial_area' in v:
                x1, y1, x2, y2 = v['facial_area']
                boxes.append([int(x1), int(y1), int(x2), int(y2)])

    # apply black rectangles
    for b in boxes:
        try:
            x1, y1, x2, y2 = map(int, b)
            x1 = max(0, x1); y1 = max(0, y1)
            x2 = min(img.shape[1]-1, x2); y2 = min(img.shape[0]-1, y2)
            cv2.rectangle(img, (x1, y1), (x2, y2), (0, 0, 0), thickness=-1)
        except Exception:
            continue

    try:
        filename = request.files['image'].filename or ''
    except Exception:
        filename = ''
    ext = ('.' + filename.split('.')[-1].lower()) if '.' in filename else '.png'
    try:
        from PIL import Image
        im = Image.fromarray(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))
        buf = None; out_mime = 'image/png'
        # If image has alpha channel, keep PNG
        has_alpha = (im.mode in ('LA', 'RGBA') or ('transparency' in im.info))
        if not has_alpha:
            # prefer JPEG; compute target (clamp to 1.5MB)
            target = None
            if orig_size_bytes:
                target = int(min(orig_size_bytes, 1_500_000))
            try:
                buf = encode_jpeg_target(im, target_bytes=target, min_q=30, max_q=90, allow_increase_ratio=1.0)
                out_mime = 'image/jpeg'
            except Exception:
                bio = BytesIO();
                try:
                    im.save(bio, format='JPEG', quality=80, optimize=True)
                except Exception:
                    im.save(bio, format='JPEG', quality=80)
                buf = bio.getvalue(); out_mime = 'image/jpeg'
        else:
            bio = BytesIO(); im.save(bio, format='PNG', optimize=True, compress_level=9); buf = bio.getvalue(); out_mime = 'image/png'
        b64 = base64.b64encode(buf).decode('ascii')
        return jsonify({'image': f'data:{out_mime};base64,' + b64, 'boxes': boxes})
    except Exception:
        _, buf = cv2.imencode('.png', img)
        b64 = base64.b64encode(buf).decode('ascii')
        return jsonify({'image': 'data:image/png;base64,' + b64, 'boxes': boxes})


if __name__ == '__main__':
    app.run(host='127.0.0.1', port=5000)
