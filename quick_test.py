#!/usr/bin/env python3
"""Quick test of face detection methods"""

import sys
import cv2
import numpy as np
from PIL import Image
from io import BytesIO

print("=" * 60)
print("Testing Face Detection Methods")
print("=" * 60)
print()

# Create a test image with a white square (simulating a face)
print("[1/5] Creating test image...")
img = cv2.imread('/home/fick-dich-weg/things/PROJECTS/blur/index.html'.replace('index.html', 'README.md'))
if img is None:
    print("  Creating synthetic test image...")
    img = np.zeros((400, 400, 3), dtype=np.uint8)
    cv2.rectangle(img, (100, 100), (250, 280), (200, 200, 200), -1)
    cv2.rectangle(img, (320, 120), (380, 200), (200, 200, 200), -1)
print(f"  ✓ Test image ready: {img.shape}")
print()

# Test GPU availability
print("[2/5] Checking GPU availability...")
try:
    import tensorflow as tf
    gpu_devices = tf.config.list_physical_devices('GPU')
    if gpu_devices:
        print(f"  ✓ GPU found: {len(gpu_devices)} device(s)")
    else:
        print("  ✓ GPU not available (using CPU)")
except Exception as e:
    print(f"  ℹ TensorFlow not available: {e}")
print()

# Test Haar Cascade
print("[3/5] Testing OpenCV Haar Cascade...")
try:
    cascade_path = cv2.data.haarcascades + 'haarcascade_frontalface_default.xml'
    face_cascade = cv2.CascadeClassifier(cascade_path)
    if face_cascade.empty():
        print("  ✗ Cascade failed to load")
    else:
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        faces = face_cascade.detectMultiScale(gray, 1.3, 5, minSize=(30, 30))
        print(f"  ✓ Cascade detection: {len(faces)} face(s) found")
except Exception as e:
    print(f"  ✗ Cascade error: {e}")
print()

# Test CSS changes
print("[4/5] Checking CSS design changes...")
try:
    with open('/home/fick-dich-weg/things/PROJECTS/blur/style.css', 'r') as f:
        css_content = f.read()
    
    has_gradients = 'linear-gradient' in css_content or 'radial-gradient' in css_content
    has_rounded = 'border-radius' in css_content and 'border-radius: 0' not in css_content
    has_vintage = 'vintage-pink-cherry' in css_content
    
    if has_gradients:
        print("  ✗ ERROR: CSS still has gradients!")
    else:
        print("  ✓ No gradients found")
    
    if has_rounded:
        print("  ✗ ERROR: CSS still has rounded corners!")
    else:
        print("  ✓ No rounded corners")
    
    if has_vintage:
        print("  ✓ Vintage theme defined")
    else:
        print("  ✗ Vintage theme missing!")
        
except Exception as e:
    print(f"  ✗ CSS check error: {e}")
print()

# Test Flask backend import
print("[5/5] Testing Flask backend import...")
try:
    sys.path.insert(0, '/home/fick-dich-weg/things/PROJECTS/blur')
    from app import app, gpu_available, use_gpu_for_cv2, face_cascade, dnn_net
    print(f"  ✓ Backend loaded successfully")
    print(f"    - GPU available: {gpu_available}")
    print(f"    - GPU for OpenCV: {use_gpu_for_cv2}")
    print(f"    - Haar Cascade: {'loaded' if face_cascade is not None else 'not loaded'}")
    print(f"    - DNN detector: {'loaded' if dnn_net is not None else 'not loaded'}")
except Exception as e:
    print(f"  ✗ Backend import error: {e}")
    import traceback
    traceback.print_exc()

print()
print("=" * 60)
print("✓ All checks complete!")
print("=" * 60)
