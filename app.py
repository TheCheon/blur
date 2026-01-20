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
    return img


@app.route('/detect', methods=['POST'])
def detect():
    if 'image' not in request.files:
        return jsonify({'error': 'no image'}), 400
    img = read_image_from_file_storage(request.files['image'])
    if img is None:
        return jsonify({'error': 'invalid image'}), 400
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
    img = read_image_from_file_storage(request.files['image'])
    if img is None:
        return jsonify({'error': 'invalid image'}), 400
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
    if ext in ('.jpg', '.jpeg'):
        encode_ext = '.jpg'
        params = [int(cv2.IMWRITE_JPEG_QUALITY), 95]
    elif ext == '.png':
        encode_ext = '.png'
        params = []
    else:
        encode_ext = '.png'
        params = []
    success, buf = cv2.imencode(encode_ext, img, params) if params else cv2.imencode(encode_ext, img)
    if not success:
        _, buf = cv2.imencode('.png', img)
        out_mime = 'image/png'
    else:
        out_mime = 'image/jpeg' if encode_ext in ('.jpg', '.jpeg') else 'image/png'
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
    img = read_image_from_file_storage(request.files['image'])
    if img is None:
        return jsonify({'error': 'invalid image'}), 400

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
    if ext in ('.jpg', '.jpeg'):
        encode_ext = '.jpg'
        params = [int(cv2.IMWRITE_JPEG_QUALITY), 95]
    elif ext == '.png':
        encode_ext = '.png'
        params = []
    else:
        encode_ext = '.png'
        params = []
    try:
        success, buf = (cv2.imencode(encode_ext, img, params) if params else cv2.imencode(encode_ext, img))
        if success:
            out_mime = 'image/jpeg' if encode_ext in ('.jpg', '.jpeg') else 'image/png'
            b64 = base64.b64encode(buf).decode('ascii')
            return jsonify({'image': f'data:{out_mime};base64,' + b64, 'boxes': boxes})
    except Exception:
        pass
    _, buf = cv2.imencode('.png', img)
    b64 = base64.b64encode(buf).decode('ascii')
    return jsonify({'image': 'data:image/png;base64,' + b64, 'boxes': boxes})


if __name__ == '__main__':
    app.run(host='127.0.0.1', port=5000)
