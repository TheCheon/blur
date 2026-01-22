from flask import Flask, request, jsonify
from flask_cors import CORS
import cv2
import numpy as np
import base64
from io import BytesIO
from PIL import Image
from retinaface import RetinaFace

# blur faces backend: flask api that detects faces and returns masked images.
# comments added in lowercase as requested; these do not affect runtime.
app = Flask(__name__)
CORS(app)


def strip_image_metadata(pil_image):
    """Remove all metadata from PIL Image: EXIF, ICC profile, XMP, timestamps, etc.
    Returns a new PIL Image with no metadata."""
    try:
        # Create a new image without any metadata
        if pil_image.mode == 'RGBA' or pil_image.mode == 'LA':
            # Preserve alpha channel
            new_img = Image.new(pil_image.mode, pil_image.size)
            new_img.putdata(pil_image.getdata())
        else:
            # Convert to RGB (no transparency/metadata)
            rgb_img = pil_image.convert('RGB')
            new_img = Image.new('RGB', rgb_img.size)
            new_img.putdata(rgb_img.getdata())
        return new_img
    except Exception as e:
        print(f'[warn] strip_image_metadata failed: {e}; returning original')
        return pil_image



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


def encode_jpeg_target(pil_im, target_bytes=None, min_q=30, max_q=95, tol_pct=0.05):
    """Encode PIL image to JPEG attempting to match target_bytes within tolerance.
    Uses binary search over quality and returns the best result found.
    - If target_bytes is None: returns high-quality JPEG at max_q.
    - tol_pct: acceptable relative tolerance (e.g. 0.05 for ±5%).
    """
    # quick path: no target -> high quality
    if target_bytes is None:
        bio = BytesIO()
        try:
            pil_im.save(bio, format='JPEG', quality=max_q, optimize=True, progressive=True)
        except Exception:
            pil_im.save(bio, format='JPEG', quality=max_q)
        return bio.getvalue()

    target = int(target_bytes)
    if target <= 0:
        return encode_jpeg_target(pil_im, None, min_q=min_q, max_q=max_q, tol_pct=tol_pct)

    lower = max(1, int(target * (1.0 - tol_pct)))
    upper = int(target * (1.0 + tol_pct))

    # try highest quality first and see if it fits within upper bound
    bio = BytesIO()
    try:
        pil_im.save(bio, format='JPEG', quality=max_q, optimize=True, progressive=True)
    except Exception:
        pil_im.save(bio, format='JPEG', quality=max_q)
    data = bio.getvalue(); size = len(data)
    if lower <= size <= upper:
        return data

    # perform binary search over quality to find candidate closest to target
    lo = min_q; hi = max_q
    best = data; best_q = max_q; best_diff = abs(size - target)

    while lo <= hi:
        mid = (lo + hi) // 2
        bio = BytesIO()
        try:
            pil_im.save(bio, format='JPEG', quality=mid, optimize=True, progressive=True)
        except Exception:
            pil_im.save(bio, format='JPEG', quality=mid)
        data_mid = bio.getvalue(); size_mid = len(data_mid)
        diff = abs(size_mid - target)
        # track best candidate (closest to target)
        if diff < best_diff:
            best = data_mid; best_q = mid; best_diff = diff
            # if within tolerance, we can return early
            if lower <= size_mid <= upper:
                return data_mid
        # adjust binary search direction
        if size_mid > target:
            # size too large -> decrease quality
            hi = mid - 1
        else:
            # size smaller than target -> increase quality
            lo = mid + 1

    # final: if best within tolerance window, return it; otherwise return best found
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
    print(f'[mask] original file size: {orig_size_bytes} bytes')
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
    
    # Check if metadata stripping is requested
    strip_metadata = request.form.get('strip_metadata', 'false').lower() == 'true'
    
    # Use Pillow to re-encode with sensible settings and try to keep output size similar to original
    try:
        from PIL import Image
        im = Image.fromarray(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))
        
        # Strip metadata if requested
        if strip_metadata:
            print(f'[mask] stripping all metadata')
            im = strip_image_metadata(im)
        
        buf = None
        out_mime = 'image/png'
        # If image has alpha channel, keep PNG
        has_alpha = (im.mode in ('LA', 'RGBA') or ('transparency' in im.info))
        # Determine aggressive target behavior
        if not has_alpha:
            # prefer JPEG output to preserve original filesize
            # target the original size if available (no artificial clamp)
            target = None
            if orig_size_bytes:
                target = int(orig_size_bytes)
            print(f'[mask] targeting {target} bytes with ±5% tolerance')
            try:
                buf = encode_jpeg_target(im, target_bytes=target, min_q=30, max_q=90, tol_pct=0.05)
                print(f'[mask] encoded JPEG: {len(buf)} bytes')
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
    print(f'[retina_mask] original file size: {orig_size_bytes} bytes')
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

    # Check if metadata stripping is requested
    strip_metadata = request.form.get('strip_metadata', 'false').lower() == 'true'

    try:
        from PIL import Image
        im = Image.fromarray(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))
        
        # Strip metadata if requested
        if strip_metadata:
            print(f'[retina_mask] stripping all metadata')
            im = strip_image_metadata(im)
        
        buf = None; out_mime = 'image/png'
        # If image has alpha channel, keep PNG
        has_alpha = (im.mode in ('LA', 'RGBA') or ('transparency' in im.info))
        if not has_alpha:
            # prefer JPEG; compute target equal to original size when available
            target = None
            if orig_size_bytes:
                target = int(orig_size_bytes)
            print(f'[retina_mask] targeting {target} bytes with ±5% tolerance')
            try:
                buf = encode_jpeg_target(im, target_bytes=target, min_q=30, max_q=90, tol_pct=0.05)
                print(f'[retina_mask] encoded JPEG: {len(buf)} bytes')
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
