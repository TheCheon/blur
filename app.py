from flask import Flask, request, jsonify
from flask_cors import CORS
import cv2
import numpy as np
import base64
from io import BytesIO
from PIL import Image
import os
import sys
import logging

# Ensure RetinaFace compatibility: set legacy Keras before any TensorFlow import
os.environ.setdefault("TF_USE_LEGACY_KERAS", "1")

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

app = Flask(__name__)
CORS(app)

# GPU/TensorFlow initialization
gpu_available = False
rocm_available = False
use_gpu_for_cv2 = False

try:
    import tensorflow as tf
    logger.info(f"TensorFlow version: {tf.__version__}")
    
    # Check for GPU devices
    gpu_devices = tf.config.list_physical_devices('GPU')
    if gpu_devices:
        gpu_available = True
        logger.info(f"GPU detected: {len(gpu_devices)} device(s)")
        for device in gpu_devices:
            logger.info(f"  - {device}")
        # Enable memory growth to prevent OOM errors
        for device in gpu_devices:
            tf.config.experimental.set_memory_growth(device, True)
        # Enable CUDA for OpenCV (if NVIDIA GPU)
        try:
            cv2.cuda.setDevice(0)
            use_gpu_for_cv2 = True
            logger.info("GPU acceleration for OpenCV enabled")
        except:
            pass
    else:
        logger.info("No GPU devices detected, using CPU")
        
    # Check for ROCm (AMD GPU support)
    rocm_version = os.getenv('ROCM_VERSION', None)
    if rocm_version:
        rocm_available = True
        logger.info(f"ROCm detected: version {rocm_version}")
        
except ImportError as e:
    logger.warning(f"TensorFlow not available: {e}")
except Exception as e:
    logger.error(f"Error during GPU initialization: {e}")

# Face detection model loading — RetinaFace ONLY
RetinaFace = None
try:
    from retinaface import RetinaFace
    # Pre-build and preload the Keras model to avoid building inside request context
    try:
        from retinaface.model import retinaface_model as _rf_model
        logger.info("Building RetinaFace Keras model (this may take a moment)")
        _retina_model = _rf_model.build_model()
        # load pre-trained weights (will download if needed)
        _rf_model.load_weights(_retina_model)
        retina_model = _retina_model
        logger.info("RetinaFace Keras model built and weights loaded")
    except Exception as e:
        logger.warning(f"Could not prebuild RetinaFace model: {e}")
        retina_model = None

    logger.info("RetinaFace package imported (RetinaFace-only mode)")
except ImportError as e:
    logger.error(f"RetinaFace not available: {e}")
    RetinaFace = None
    retina_model = None
except Exception as e:
    logger.error(f"Error loading RetinaFace: {e}")
    RetinaFace = None
    retina_model = None


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
    gpu_status = "CUDA/ROCm GPU available" if gpu_available else "CPU only"
    rocm_status = "ROCm enabled" if rocm_available else "Not available"
    return f'''<html>
    <head><title>Blur Faces API</title></head>
    <body style="font-family: sans-serif; margin: 20px;">
        <h2>Blur Faces API</h2>
        <p><strong>GPU Status:</strong> {gpu_status}</p>
        <p><strong>ROCm:</strong> {rocm_status}</p>
        <h3>Available Endpoints:</h3>
        <ul>
            <li><strong>GET /status</strong> - System status and GPU info</li>
            <li><strong>POST /detect</strong> - RetinaFace detection</li>
            <li><strong>POST /mask</strong> - Apply masks to image</li>
            <li><strong>POST /retina_mask</strong> - Detect faces and apply masks</li>
        </ul>
        <h3>Form Fields:</h3>
        <ul>
            <li><code>image</code> - Image file (required)</li>
            <li><code>boxes</code> - JSON array of [x1,y1,x2,y2] boxes (for /mask)</li>
            <li><code>strip_metadata</code> - "true" to strip metadata</li>
        </ul>
    </body>
</html>'''


@app.route('/status', methods=['GET'])
def status():
    """Return system status and available features"""
    try:
        gpu_devices = []
        if gpu_available:
            import tensorflow as tf
            devices = tf.config.list_physical_devices('GPU')
            gpu_devices = [str(d) for d in devices]
    except:
        pass
    
    return jsonify({
        'status': 'ok',
        'gpu_available': gpu_available,
        'rocm_available': rocm_available,
        'gpu_devices': gpu_devices,
        'retinaface_available': RetinaFace is not None
    })


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


def expand_face_box(face_area, img_w, img_h):
    """Expand RetinaFace box to cover side head/ears and return a larger square box."""
    x1, y1, x2, y2 = [float(v) for v in face_area]
    w = max(1.0, x2 - x1)
    h = max(1.0, y2 - y1)

    # Expand more horizontally to better include ears/side head.
    ex1 = x1 - (0.22 * w)
    ex2 = x2 + (0.22 * w)
    ey1 = y1 - (0.12 * h)
    ey2 = y2 + (0.25 * h)

    ew = max(1.0, ex2 - ex1)
    eh = max(1.0, ey2 - ey1)
    side = max(ew, eh) * 1.10

    cx = (ex1 + ex2) / 2.0
    cy = (ey1 + ey2) / 2.0 + (0.04 * h)

    nx1 = int(round(cx - side / 2.0))
    ny1 = int(round(cy - side / 2.0))
    nx2 = int(round(cx + side / 2.0))
    ny2 = int(round(cy + side / 2.0))

    nx1 = max(0, nx1)
    ny1 = max(0, ny1)
    nx2 = min(img_w - 1, nx2)
    ny2 = min(img_h - 1, ny2)

    return [nx1, ny1, nx2, ny2]


@app.route('/detect', methods=['POST'])
def detect():
    """Run face detection on uploaded image using GPU-accelerated methods"""
    try:
        if 'image' not in request.files:
            logger.warning("Detect request missing image file")
            return jsonify({'error': 'no image'}), 400
        
        img_res = read_image_from_file_storage(request.files['image'])
        if not img_res:
            logger.warning("Failed to read image file")
            return jsonify({'error': 'invalid image'}), 400
        
        img, _raw = img_res
        logger.info(f"Detecting faces in {img.shape[0]}x{img.shape[1]} image")
        
        # RetinaFace-only mode
        if RetinaFace is None:
            logger.error("RetinaFace not available — detection disabled")
            return jsonify({'error': 'RetinaFace not available'}), 500

        try:
            rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
            # prefer passing a prebuilt Keras model to avoid runtime build issues
            if 'retina_model' in globals() and retina_model is not None:
                faces = RetinaFace.detect_faces(rgb, model=retina_model)
            else:
                faces = RetinaFace.detect_faces(rgb)
            boxes = []
            if isinstance(faces, dict):
                for k, v in faces.items():
                    if 'facial_area' in v:
                        x1, y1, x2, y2 = v['facial_area']
                        boxes.append(expand_face_box([x1, y1, x2, y2], img.shape[1], img.shape[0]))
            detection_method = 'RetinaFace'
            logger.info(f"RetinaFace detection: {len(boxes)} face(s)")
            return jsonify({'boxes': boxes, 'method': detection_method})
        except Exception as e:
            logger.error(f"RetinaFace detection failed: {e}", exc_info=True)
            return jsonify({'error': 'RetinaFace detection failed', 'detail': str(e)}), 500
        
    except Exception as e:
        logger.error(f"Detection error: {str(e)}", exc_info=True)
        return jsonify({'error': str(e)}), 500


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

    # Use Pillow to re-encode with explicit quality controls
    try:
        from PIL import Image
        im = Image.fromarray(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))
        jpeg_quality = request.form.get('jpeg_quality', '100')
        try:
            jpeg_quality = int(jpeg_quality)
        except Exception:
            jpeg_quality = 100
        jpeg_quality = max(1, min(100, jpeg_quality))
        
        # Strip metadata if requested
        if strip_metadata:
            print(f'[mask] stripping all metadata')
            im = strip_image_metadata(im)
        
        buf = None
        out_mime = 'image/png'
        # If image has alpha channel, keep PNG
        has_alpha = (im.mode in ('LA', 'RGBA') or ('transparency' in im.info))
        # Determine output behavior
        if not has_alpha:
            try:
                # Keep chroma detail at high quality levels and avoid aggressive optimization.
                if jpeg_quality >= 95:
                    bio = BytesIO()
                    im.save(bio, format='JPEG', quality=jpeg_quality, subsampling=0, optimize=False)
                    buf = bio.getvalue()
                else:
                    buf = encode_jpeg_target(im, target_bytes=None, min_q=30, max_q=jpeg_quality, tol_pct=0.05)
                print(f'[mask] encoded JPEG: {len(buf)} bytes')
                out_mime = 'image/jpeg'
            except Exception:
                bio = BytesIO();
                try:
                    im.save(bio, format='JPEG', quality=jpeg_quality)
                except Exception:
                    im.save(bio, format='JPEG', quality=95)
                buf = bio.getvalue(); out_mime = 'image/jpeg'
        else:
            # has alpha — fall back to compressed PNG
            bio = BytesIO(); im.save(bio, format='PNG', optimize=True, compress_level=9); buf = bio.getvalue(); out_mime = 'image/png'
        b64 = base64.b64encode(buf).decode('ascii')
        return jsonify({'image': f'data:{out_mime};base64,' + b64})
    except Exception:
        # fallback to OpenCV encode
        if ext in ('.jpg', '.jpeg'):
            try:
                jq = int(request.form.get('jpeg_quality', '100'))
            except Exception:
                jq = 100
            jq = max(1, min(100, jq))
            success, buf = cv2.imencode('.jpg', img, [int(cv2.IMWRITE_JPEG_QUALITY), jq])
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
                boxes.append(expand_face_box([x1, y1, x2, y2], img.shape[1], img.shape[0]))

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
        jpeg_quality = request.form.get('jpeg_quality', '100')
        try:
            jpeg_quality = int(jpeg_quality)
        except Exception:
            jpeg_quality = 100
        jpeg_quality = max(1, min(100, jpeg_quality))
        
        # Strip metadata if requested
        if strip_metadata:
            print(f'[retina_mask] stripping all metadata')
            im = strip_image_metadata(im)
        
        buf = None; out_mime = 'image/png'
        # If image has alpha channel, keep PNG
        has_alpha = (im.mode in ('LA', 'RGBA') or ('transparency' in im.info))
        if not has_alpha:
            try:
                if jpeg_quality >= 95:
                    bio = BytesIO()
                    im.save(bio, format='JPEG', quality=jpeg_quality, subsampling=0, optimize=False)
                    buf = bio.getvalue()
                else:
                    buf = encode_jpeg_target(im, target_bytes=None, min_q=30, max_q=jpeg_quality, tol_pct=0.05)
                print(f'[retina_mask] encoded JPEG: {len(buf)} bytes')
                out_mime = 'image/jpeg'
            except Exception:
                bio = BytesIO();
                try:
                    im.save(bio, format='JPEG', quality=jpeg_quality)
                except Exception:
                    im.save(bio, format='JPEG', quality=95)
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
