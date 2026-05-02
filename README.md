
# Blur Faces v2.0

**Blur Faces** is a privacy-first desktop application for batch face anonymization using local processing. Built with Electron, Flask, and RetinaFace, it provides a smooth workflow from image import through face detection to final export.

## ✨ Key Features

### Workflow
- **Step 1 - Import:** Select one or multiple images (PNG, JPG, BMP, GIF, WebP, TIFF)
- **Step 2 - Detect:** Automatic RetinaFace detection with real-time progress and detailed logs
- **Step 3 - Library/Edit (Optional):** Click-to-edit library cards for precise mask adjustments
- **Step 4 - Export:** Batch export with customizable options

### Privacy & Security
- ✓ **100% Local Processing** - No image uploads, no cloud services
- ✓ **Metadata Stripping** - Remove EXIF, ICC profiles, XMP, and timestamps
- ✓ **Offline Mode** - Works completely offline after initial setup
- ✓ **No Telemetry** - Open source, auditable codebase

### Performance
- 🎨 **GPU Acceleration** - Full support for NVIDIA CUDA and AMD ROCm (Vulkan-based 5700XT)
- ⚡ **Smart JPEG Encoding** - Adaptive quality to maintain original file sizes
- 🖼️ **Thumbnail Caching** - Fast preview generation with smart caching
- ⏱️ **Efficient Batch Processing** - Process entire folders in one operation

### Design & UX
- 🎯 **4 Professional Themes:**
  - **Dark Modern** (default) - Sleek dark interface with emerald accents
  - **Vintage Pink Cherry** - Warm, retro aesthetic with rose tones
  - **Light Minimal** - Clean, bright interface for daytime use
  - **High Contrast** - Accessibility-focused with maximum contrast
- 🎮 **Intuitive Editor** - Drag to create masks, drag inside to move, delete to remove
- 📱 **Responsive Design** - Works on desktop and tablet displays
- ♿ **Accessible** - Keyboard shortcuts, ARIA labels, semantic HTML

## 🚀 Quick Start

### Requirements
- **System:** Linux, macOS, or Windows
- **Python:** 3.8+ (installed automatically)
- **Node.js:** 14+ (for Electron)
- **GPU (Optional):** NVIDIA CUDA or AMD ROCm

### Installation

```bash
# Clone or download the repository
cd blur

# Run the installer (automatically sets up Python venv and npm dependencies)
./install.sh      # macOS/Linux
install.bat       # Windows
```

### Running the Application

```bash
./start.sh        # macOS/Linux
start.bat         # Windows
```

The application will:
1. Activate the Python virtual environment
2. Start the Flask backend (port 5000)
3. Launch the Electron frontend

## 🎮 Usage Guide

### Import Step
1. Click **Import Photos** to select image files
2. Multiple files are supported
3. Progress shows number of imported images

### Detection Step
- Runs automatically after import
- Shows per-image progress with face count
- Detailed logs show detection results or errors
- Can re-run detection if needed

### Library/Edit Step (Optional)
- Click any image to open the **Editor**
- **Keyboard Controls:**
  - `Escape` - Close editor
  - `Delete` / `Backspace` - Remove selected mask
- **Mouse Controls:**
  - Drag to create rectangular mask
  - Drag inside mask to move it
  - Click to select/deselect mask
- Click **Save** to keep changes or **Cancel** to discard

### Export Step
1. Select output folder
2. Configure options:
   - **Filename Suffix:** Append to original filenames (default: `_masked`)
   - **Output Format:** Keep original, force JPEG, or force PNG
   - **JPEG Quality:** 60-100 (higher = better quality)
   - **Strip Metadata:** Remove all EXIF and other metadata for privacy
3. Click **Export All** to process and save all images

## 🖥️ System Requirements

### Recommended (GPU Acceleration)
- **GPU:** NVIDIA RTX 2060+ or AMD 5700XT+
- **RAM:** 8GB+ (16GB+ for large batches)
- **Storage:** 2GB for application + model files

### Minimum (CPU Mode)
- **RAM:** 4GB (8GB+ recommended)
- **CPU:** Modern multi-core processor
- **Storage:** 2GB for application

## 🔧 Advanced Configuration

### GPU Support

#### NVIDIA CUDA (GPU Acceleration)
```bash
# Requires NVIDIA GPU drivers and CUDA Toolkit
pip install tensorflow[and-cuda]
```

#### AMD ROCm (Vulkan on 5700XT)
```bash
# For AMD GPUs on Linux:
pip install tensorflow-rocm
# Requires ROCm drivers to be installed
```

#### CPU Only Mode
If no GPU is available, the application automatically uses CPU mode (slightly slower but still efficient).

### Environment Variables
```bash
# Enable verbose logging
export DEBUG=1

# Set custom port for Flask backend
export FLASK_PORT=5001

# GPU configuration
export ROCM_VERSION=6.0  # For ROCm systems
```

### Backend API

The Flask backend exposes REST endpoints:

- `GET /` - Web UI with status info
- `GET /status` - System status and GPU info (JSON)
- `POST /detect` - Run face detection on uploaded image
- `POST /mask` - Apply provided boxes to image
- `POST /retina_mask` - Detect and mask in one request

Example:
```bash
curl -F "image=@photo.jpg" http://127.0.0.1:5000/detect
```

## 🧪 Testing

Run the comprehensive test suite:

```bash
# Activate venv first
source .venv/bin/activate  # or: .venv\Scripts\activate on Windows

# Run tests
python tests.py
```

Tests cover:
- Image processing (PNG, JPEG, different sizes)
- Face detection and masking
- Metadata stripping
- Error handling
- API endpoints
- GPU availability detection

## 📋 Keyboard Shortcuts

**Editor Window:**
- `Escape` - Close editor without saving
- `Delete` / `Backspace` - Delete selected mask
- `Ctrl+S` / `Cmd+S` - Save (if implemented)

**Main Interface:**
- `Tab` - Navigate between workflow steps (when applicable)
- Arrow keys - Navigate buttons

## 🐛 Troubleshooting

### Electron Won't Start
```bash
# Ensure Electron is properly installed
npm ci

# Rebuild Electron (if needed)
npm rebuild
```

### Backend Connection Failed
```bash
# Check if backend is running on port 5000
lsof -i :5000  # macOS/Linux

# Clear cache and restart
rm -rf /tmp/blur_backend.log
./start.sh
```

### Face Detection Not Working
```bash
# Check if RetinaFace is properly installed
python -c "from retinaface import RetinaFace; print('OK')"

# Reinstall dependencies
pip install --force-reinstall retinaface tensorflow
```

### Memory Issues on Large Images
- Reduce **JPEG Quality** slider in export
- Process smaller batches
- Increase system RAM or enable swap
- Use **Force PNG** to reduce computation

### GPU Not Being Used
```bash
# Check GPU availability
python -c "import tensorflow as tf; print(tf.config.list_physical_devices('GPU'))"

# For AMD ROCm:
rocm-smi  # Check if ROCm is installed
```

## 🎯 Performance Tips

1. **Batch Processing:** Import multiple images at once for better efficiency
2. **Metadata Stripping:** Enable for smaller output file sizes
3. **JPEG Quality:** Lower quality = faster processing + smaller files
4. **GPU Mode:** Enable for 5-10x faster detection on compatible systems
5. **Caching:** Thumbnails are cached automatically; clearing increases first-load time

## 📦 File Structure

```
blur/
├── app.py                 # Flask backend with face detection
├── main.js               # Electron main process
├── preload.js            # IPC bridge (Electron security)
├── renderer.js           # Frontend logic
├── index.html            # UI layout
├── style.css             # 4 themes + responsive design
├── requirements.txt      # Python dependencies
├── package.json          # Node dependencies
├── tests.py             # Comprehensive test suite
├── install.sh / .bat    # Installation scripts
├── start.sh / .bat      # Startup scripts
└── README.md            # This file
```

## 🔐 Security & Privacy

- **No External Connections:** All processing is local
- **No Tracking:** No analytics, no telemetry
- **Open Source:** Code is auditable and transparent
- **Metadata Removal:** Complete EXIF/XMP/ICC profile stripping
- **Electron Sandbox:** Renderer process runs in sandbox mode
- **Context Isolation:** Secure IPC bridge between renderer and main process

## 📄 License

AGPL - See LICENSE file for details

## 🤝 Contributing

Contributions are welcome! Areas for improvement:

- [ ] Additional face detection models (MTCNN, YOLOv8)
- [ ] Batch image resizing options
- [ ] Before/after preview comparison
- [ ] Undo/redo in editor
- [ ] Dark mode auto-detection
- [ ] Custom mask shapes (circles, polygons)

## 📞 Support

For issues or questions:

1. Check the **Troubleshooting** section above
2. Review backend logs: `cat /tmp/blur_backend.log`
3. Run tests to diagnose issues: `python tests.py`
4. Check Electron DevTools: `View → Toggle Developer Tools`

## 🏆 Credits

Built with:
- **Electron** - Desktop application framework
- **Flask** - Python web framework
- **RetinaFace** - State-of-the-art face detection
- **TensorFlow** - Deep learning framework
- **OpenCV** - Image processing
- **Pillow** - Python Imaging Library

## 🎨 Themes

### Dark Modern (Default)
- Emerald accent (#32d2a6)
- Professional dark interface
- Easy on the eyes for long sessions

### Vintage Pink Cherry
- Rose gold accents (#e87b8f)
- Warm, retro aesthetic
- Inspired by vintage computing design

### Light Minimal
- Green accent (#2ecc71)
- Bright, clean interface
- Perfect for daytime use

### High Contrast
- Yellow/Green accents
- Maximum contrast ratios
- Optimized for accessibility

---

**Blur Faces** - Privacy-first face anonymization. Process locally. Stay private.

*Last updated: May 1, 2026*
