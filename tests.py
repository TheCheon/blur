#!/usr/bin/env python3
"""
Comprehensive test suite for Blur Faces application
Tests backend API endpoints and core functionality
"""

import unittest
import json
import base64
import os
from io import BytesIO
from PIL import Image
import numpy as np
import cv2

# Import Flask app for testing
from app import app, logger


class BlurFacesTestCase(unittest.TestCase):
    """Test suite for Blur Faces API"""
    
    def setUp(self):
        """Set up test client"""
        self.app = app
        self.app.config['TESTING'] = True
        self.client = self.app.test_client()
    
    def create_test_image(self, width=400, height=300):
        """Create a simple test image with some colored regions"""
        # Create a PIL image with some content
        img = Image.new('RGB', (width, height), color='blue')
        pixels = img.load()
        
        # Add a white rectangle in the middle (simulating a face region)
        for x in range(150, 250):
            for y in range(100, 200):
                pixels[x, y] = (255, 255, 255)
        
        # Convert to bytes
        bio = BytesIO()
        img.save(bio, format='PNG')
        bio.seek(0)
        return bio.getvalue()
    
    def test_index_endpoint(self):
        """Test that index endpoint returns HTML with status info"""
        response = self.client.get('/')
        self.assertEqual(response.status_code, 200)
        self.assertIn(b'Blur Faces API', response.data)
        self.assertIn(b'GPU Status', response.data)
        self.assertIn(b'Endpoints', response.data)
    
    def test_status_endpoint(self):
        """Test status endpoint returns JSON with system info"""
        response = self.client.get('/status')
        self.assertEqual(response.status_code, 200)
        data = json.loads(response.data)
        self.assertEqual(data['status'], 'ok')
        self.assertIn('gpu_available', data)
        self.assertIn('rocm_available', data)
        self.assertIn('retinaface_available', data)
    
    def test_detect_no_image(self):
        """Test detect endpoint returns error when no image provided"""
        response = self.client.post('/detect')
        self.assertEqual(response.status_code, 400)
        data = json.loads(response.data)
        self.assertEqual(data['error'], 'no image')
    
    def test_detect_with_image(self):
        """Test detect endpoint with valid image"""
        img_data = self.create_test_image()
        response = self.client.post(
            '/detect',
            data={'image': (BytesIO(img_data), 'test.png')},
            content_type='multipart/form-data'
        )
        
        # Should either succeed or fail gracefully depending on retinaface availability
        if response.status_code == 200:
            data = json.loads(response.data)
            self.assertIn('boxes', data)
            self.assertIsInstance(data['boxes'], list)
        else:
            # If retinaface not available, should get appropriate error
            data = json.loads(response.data)
            self.assertIn('error', data)
    
    def test_mask_no_image(self):
        """Test mask endpoint returns error when no image provided"""
        response = self.client.post('/mask')
        self.assertEqual(response.status_code, 400)
        data = json.loads(response.data)
        self.assertEqual(data['error'], 'no image')
    
    def test_mask_with_image_and_boxes(self):
        """Test mask endpoint with image and boxes"""
        img_data = self.create_test_image()
        boxes = json.dumps([[100, 80, 200, 180]])
        
        response = self.client.post(
            '/mask',
            data={
                'image': (BytesIO(img_data), 'test.png'),
                'boxes': boxes,
                'strip_metadata': 'false'
            },
            content_type='multipart/form-data'
        )
        
        self.assertEqual(response.status_code, 200)
        data = json.loads(response.data)
        self.assertIn('image', data)
        self.assertTrue(data['image'].startswith('data:image/'))
    
    def test_mask_with_metadata_stripping(self):
        """Test mask endpoint with metadata stripping"""
        img_data = self.create_test_image()
        boxes = json.dumps([[100, 80, 200, 180]])
        
        response = self.client.post(
            '/mask',
            data={
                'image': (BytesIO(img_data), 'test.png'),
                'boxes': boxes,
                'strip_metadata': 'true'
            },
            content_type='multipart/form-data'
        )
        
        self.assertEqual(response.status_code, 200)
        data = json.loads(response.data)
        self.assertIn('image', data)
    
    def test_retina_mask_with_image(self):
        """Test retina_mask endpoint"""
        img_data = self.create_test_image()
        
        response = self.client.post(
            '/retina_mask',
            data={
                'image': (BytesIO(img_data), 'test.png'),
                'strip_metadata': 'false'
            },
            content_type='multipart/form-data'
        )
        
        if response.status_code == 200:
            data = json.loads(response.data)
            self.assertIn('image', data)
            self.assertIn('boxes', data)
            self.assertIsInstance(data['boxes'], list)
        else:
            # Graceful error handling
            data = json.loads(response.data)
            self.assertIn('error', data)
    
    def test_mask_output_format(self):
        """Test that masked image output is valid base64"""
        img_data = self.create_test_image()
        boxes = json.dumps([[100, 80, 200, 180]])
        
        response = self.client.post(
            '/mask',
            data={
                'image': (BytesIO(img_data), 'test.png'),
                'boxes': boxes
            },
            content_type='multipart/form-data'
        )
        
        self.assertEqual(response.status_code, 200)
        data = json.loads(response.data)
        
        # Extract and verify base64
        image_str = data['image']
        self.assertTrue(image_str.startswith('data:image/'))
        
        # Extract base64 content
        _, b64_data = image_str.split(',', 1)
        try:
            decoded = base64.b64decode(b64_data)
            # Should be valid image data
            self.assertGreater(len(decoded), 0)
        except Exception as e:
            self.fail(f"Failed to decode base64: {e}")
    
    def test_multiple_boxes(self):
        """Test mask endpoint with multiple boxes"""
        img_data = self.create_test_image()
        boxes = json.dumps([
            [50, 50, 150, 150],
            [200, 100, 300, 200]
        ])
        
        response = self.client.post(
            '/mask',
            data={
                'image': (BytesIO(img_data), 'test.png'),
                'boxes': boxes
            },
            content_type='multipart/form-data'
        )
        
        self.assertEqual(response.status_code, 200)
        data = json.loads(response.data)
        self.assertIn('image', data)
    
    def test_empty_boxes(self):
        """Test mask endpoint with empty boxes list"""
        img_data = self.create_test_image()
        boxes = json.dumps([])
        
        response = self.client.post(
            '/mask',
            data={
                'image': (BytesIO(img_data), 'test.png'),
                'boxes': boxes
            },
            content_type='multipart/form-data'
        )
        
        self.assertEqual(response.status_code, 200)
        data = json.loads(response.data)
        self.assertIn('image', data)
    
    def test_invalid_boxes_format(self):
        """Test mask endpoint with invalid boxes JSON"""
        img_data = self.create_test_image()
        
        response = self.client.post(
            '/mask',
            data={
                'image': (BytesIO(img_data), 'test.png'),
                'boxes': 'invalid json',
            },
            content_type='multipart/form-data'
        )
        
        # Should handle gracefully
        self.assertEqual(response.status_code, 200)
        data = json.loads(response.data)
        self.assertIn('image', data)
    
    def test_different_image_formats(self):
        """Test mask endpoint with different image formats"""
        # Create JPEG image
        img = Image.new('RGB', (400, 300), color='green')
        bio = BytesIO()
        img.save(bio, format='JPEG')
        bio.seek(0)
        jpeg_data = bio.getvalue()
        
        boxes = json.dumps([[100, 80, 200, 180]])
        
        response = self.client.post(
            '/mask',
            data={
                'image': (BytesIO(jpeg_data), 'test.jpg'),
                'boxes': boxes
            },
            content_type='multipart/form-data'
        )
        
        self.assertEqual(response.status_code, 200)
        data = json.loads(response.data)
        self.assertIn('image', data)


def run_tests():
    """Run all tests and report results"""
    loader = unittest.TestLoader()
    suite = loader.loadTestsFromTestCase(BlurFacesTestCase)
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)
    return result.wasSuccessful()


if __name__ == '__main__':
    print("=" * 70)
    print("Blur Faces - Comprehensive Test Suite")
    print("=" * 70)
    print()
    
    success = run_tests()
    
    print()
    print("=" * 70)
    if success:
        print("✓ All tests passed!")
    else:
        print("✗ Some tests failed")
    print("=" * 70)
    
    exit(0 if success else 1)
