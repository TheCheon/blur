// blur faces electron main: creates window and exposes ipc handlers to renderer
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { nativeImage } = require('electron');
const crypto = require('crypto');

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: process.platform !== 'linux'
    }
  });

  win.loadFile('index.html');
  // remove default application menu (File/Edit/View...) for a cleaner single-window UI
  try { win.removeMenu(); } catch (e) {}
}

console.log('main: starting Electron app');
app.whenReady().then(() => {
  console.log('main: app.whenReady');
  const t0 = Date.now();
  createWindow();
  console.log('main: window created in', Date.now() - t0, 'ms');
  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('open-files', async () => {
  const res = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'bmp'] }]
  });
  if (res.canceled) return [];
  return res.filePaths;
});

ipcMain.handle('read-file-base64', async (event, filePath) => {
  try {
    const data = fs.readFileSync(filePath);
    return data.toString('base64');
  } catch (err) {
    return null;
  }
});

function guessMime(p) {
  const ext = (path.extname(p) || '').toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.bmp') return 'image/bmp';
  return 'application/octet-stream';
}

ipcMain.handle('detect-file', async (event, filePath, route = 'detect', timeoutMs = 60000) => {
  try {
    const stats = fs.statSync(filePath);
    const fileSize = stats.size;
    const boundary = '----electronform' + Date.now();
    const filename = path.basename(filePath);
    const mime = guessMime(filePath);
    const pre = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`);
    const post = Buffer.from(`\r\n--${boundary}--\r\n`);
    const contentLength = pre.length + fileSize + post.length;

    const opts = {
      method: 'POST',
      hostname: '127.0.0.1',
      port: 5000,
      path: '/' + route,
      headers: {
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
        'Content-Length': contentLength
      }
    };

    return await new Promise((resolve) => {
      const req = http.request(opts, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve({ ok: true, json: parsed, fileSize });
          } catch (e) {
            resolve({ ok: false, error: 'invalid-json', raw: data, statusCode: res.statusCode, fileSize });
          }
        });
      });
      req.on('error', (err) => resolve({ ok: false, error: String(err), fileSize }));
      req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ ok: false, error: 'timeout', fileSize }); });
      req.write(pre);
      const stream = fs.createReadStream(filePath);
      stream.on('end', () => { req.end(post); });
      stream.on('error', (err) => { req.destroy(); resolve({ ok: false, error: String(err), fileSize }); });
      stream.pipe(req, { end: false });
    });
  } catch (err) {
    return { ok: false, error: String(err), fileSize: 0 };
  }
});

// accept a base64 image payload (data URL or bare base64) and POST to detect endpoint
ipcMain.handle('detect-data', async (event, dataUrlOrBase64, route = 'detect', timeoutMs = 60000) => {
  try {
    // normalize to Buffer
    let base64 = dataUrlOrBase64;
    if (base64.startsWith('data:')) base64 = base64.split(',')[1];
    const buf = Buffer.from(base64, 'base64');
    const fileSize = buf.length;
    console.log('detect-data: payload size', fileSize, 'route=', route);
    const boundary = '----electronform' + Date.now();
    const filename = 'upload.png';
    const pre = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`);
    const post = Buffer.from(`\r\n--${boundary}--\r\n`);
    const contentLength = pre.length + buf.length + post.length;
    const opts = {
      method: 'POST',
      hostname: '127.0.0.1',
      port: 5000,
      path: '/' + route,
      headers: {
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
        'Content-Length': contentLength
      }
    };
    return await new Promise((resolve) => {
      const req = http.request(opts, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try { resolve({ ok: true, json: JSON.parse(data), fileSize }); }
          catch (e) { resolve({ ok: false, error: 'invalid-json', raw: data, statusCode: res.statusCode, fileSize }); }
        });
      });
      req.on('error', (err) => resolve({ ok: false, error: String(err), fileSize }));
      req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ ok: false, error: 'timeout', fileSize }); });
      req.write(pre);
      req.write(buf);
      req.end(post);
    });
  } catch (err) {
    console.error('detect-data: handler error', String(err));
    return { ok: false, error: String(err), fileSize: 0 };
  }
});

// Cached native thumbnail generation using Electron nativeImage
ipcMain.handle('make-thumbnail', async (event, filePath, maxDim = 320) => {
  try {
    console.log('make-thumbnail: request', filePath, 'maxDim=', maxDim);
    const stats = fs.statSync(filePath);
    const mtime = String(Math.floor(stats.mtimeMs));
    const key = crypto.createHash('md5').update(filePath + '|' + mtime + '|' + String(maxDim)).digest('hex');
    const cacheDir = path.join(app.getPath('userData'), 'thumbs');
    const cachePath = path.join(cacheDir, key + '.png');
    if (fs.existsSync(cachePath)) {
      const buf = fs.readFileSync(cachePath);
      console.log('make-thumbnail: cache hit', cachePath);
      // still report original size by reading from path
      const img2 = nativeImage.createFromPath(filePath);
      const origSize = img2.isEmpty() ? { width: 0, height: 0 } : img2.getSize();
      return { ok: true, dataUrl: 'data:image/png;base64,' + buf.toString('base64'), fileSize: buf.length, originalSize: origSize };
    }
    // create thumbnail via nativeImage
    const img = nativeImage.createFromPath(filePath);
    if (img.isEmpty()) return { ok: false, error: 'invalid-image' };
    const size = img.getSize();
    const origSize = size;
    console.log('make-thumbnail: image size', size);
    const scale = Math.min(1, maxDim / Math.max(size.width || 1, size.height || 1));
    const w = Math.max(1, Math.round((size.width || 1) * scale));
    const h = Math.max(1, Math.round((size.height || 1) * scale));
    const resized = img.resize({ width: w, height: h });
    const png = resized.toPNG();
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cachePath, png);
    console.log('make-thumbnail: wrote cache', cachePath, 'size', png.length);
    return { ok: true, dataUrl: 'data:image/png;base64,' + png.toString('base64'), fileSize: png.length, originalSize: origSize };
  } catch (err) {
    console.error('make-thumbnail: error', String(err));
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle('mask-file', async (event, filePath, boxes, timeoutMs = 60000, stripMetadata = false, jpegQuality = 100) => {
  try {
    const stats = fs.statSync(filePath);
    const fileSize = stats.size;
    const boundary = '----electronform' + Date.now();
    const filename = path.basename(filePath);
    const mime = guessMime(filePath);
    const boxesStr = JSON.stringify(boxes || []);
    const stripStr = stripMetadata ? 'true' : 'false';
    const jpegQualityStr = String(Math.max(1, Math.min(100, Number(jpegQuality) || 100)));
    const pre = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`);
    const mid = Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="boxes"\r\n\r\n${boxesStr}\r\n--${boundary}\r\nContent-Disposition: form-data; name="strip_metadata"\r\n\r\n${stripStr}\r\n--${boundary}\r\nContent-Disposition: form-data; name="jpeg_quality"\r\n\r\n${jpegQualityStr}\r\n`);
    const post = Buffer.from(`--${boundary}--\r\n`);
    const contentLength = pre.length + fileSize + mid.length + post.length;

    const opts = {
      method: 'POST',
      hostname: '127.0.0.1',
      port: 5000,
      path: '/mask',
      headers: {
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
        'Content-Length': contentLength
      }
    };

    return await new Promise((resolve) => {
      const req = http.request(opts, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve({ ok: true, json: parsed, fileSize });
          } catch (e) {
            resolve({ ok: false, error: 'invalid-json', raw: data, statusCode: res.statusCode, fileSize });
          }
        });
      });
      req.on('error', (err) => resolve({ ok: false, error: String(err), fileSize }));
      req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ ok: false, error: 'timeout', fileSize }); });
      req.write(pre);
      const stream = fs.createReadStream(filePath);
      stream.on('end', () => {
        req.write(mid);
        req.end(post);
      });
      stream.on('error', (err) => { req.destroy(); resolve({ ok: false, error: String(err), fileSize }); });
      stream.pipe(req, { end: false });
    });
  } catch (err) {
    return { ok: false, error: String(err), fileSize: 0 };
  }
});

ipcMain.handle('save-image', async (event, dataUrl, defaultName) => {
  try {
    const defaultPath = path.join(app.getPath('home'), defaultName || 'masked.png');
    const res = await dialog.showSaveDialog({
      defaultPath,
      filters: [{ name: 'PNG Image', extensions: ['png'] }]
    });
    if (res.canceled || !res.filePath) return { saved: false };
    let base64 = dataUrl;
    const m = /^data:(image\/\w+);base64,(.*)$/.exec(base64);
    if (m) base64 = m[2];
    const buf = Buffer.from(base64, 'base64');
    fs.writeFileSync(res.filePath, buf);
    return { saved: true, path: res.filePath };
  } catch (err) {
    return { saved: false, error: String(err) };
  }
});

ipcMain.handle('select-directory', async () => {
  const res = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  if (res.canceled || !res.filePaths || res.filePaths.length === 0) return null;
  return res.filePaths[0];
});

ipcMain.handle('write-file', async (event, filePath, base64Data) => {
  try {
    const buf = Buffer.from(base64Data, 'base64');
    fs.writeFileSync(filePath, buf);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

// Persist app state to a JSON file in userData
ipcMain.handle('save-app-state', async (event, stateObj) => {
  try {
    const p = path.join(app.getPath('userData'), 'app_state.json');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(stateObj, null, 2), 'utf8');
    return { ok: true, path: p };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle('load-app-state', async () => {
  try {
    const p = path.join(app.getPath('userData'), 'app_state.json');
    if (!fs.existsSync(p)) return { ok: true, state: null };
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    return { ok: true, state: parsed };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

// Session management: persist sessions to dedicated directory
function getSessionsDir() {
  return path.join(app.getPath('userData'), 'sessions');
}

ipcMain.handle('list-sessions', async () => {
  try {
    const dir = getSessionsDir();
    if (!fs.existsSync(dir)) return { ok: true, sessions: [] };
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    const sessions = files.map((f) => {
      const p = path.join(dir, f);
      const stat = fs.statSync(p);
      return { name: f.replace(/\.json$/, ''), modified: stat.mtimeMs, size: stat.size };
    }).sort((a, b) => b.modified - a.modified);
    return { ok: true, sessions };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle('delete-session', async (event, sessionName) => {
  try {
    const dir = getSessionsDir();
    const p = path.join(dir, sessionName + '.json');
    if (!fs.existsSync(p)) return { ok: false, error: 'session not found' };
    fs.unlinkSync(p);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle('load-session', async (event, sessionName) => {
  try {
    const dir = getSessionsDir();
    const p = path.join(dir, sessionName + '.json');
    if (!fs.existsSync(p)) return { ok: false, error: 'session not found' };
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    return { ok: true, state: parsed };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle('save-session-as', async (event, sessionName, stateObj) => {
  try {
    const dir = getSessionsDir();
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, sessionName + '.json');
    fs.writeFileSync(p, JSON.stringify(stateObj, null, 2), 'utf8');
    return { ok: true, path: p };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});
