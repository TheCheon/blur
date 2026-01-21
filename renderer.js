const importBtn = document.getElementById('importBtn');
const gallery = document.getElementById('gallery');
const editor = document.getElementById('editor');
const backBtn = document.getElementById('backBtn');
const detectBtn = document.getElementById('detectBtn');
const saveBtn = document.getElementById('saveBtn');
const canvas = document.getElementById('editorCanvas');
const ctx = canvas.getContext('2d');
const canvasWrap = document.getElementById('canvasWrap');

const detectionGrid = document.getElementById('detectionGrid');
const editGrid = document.getElementById('editGrid');
const tabButtons = document.querySelectorAll('#tabs .tab');

let images = []; // {path, thumbSrc}
let items = [];  // {path, preview, boxes, status, previewScale}
let current = null; // currently open image path
let rects = [];
let baseDataUrl = null; // current base image shown on canvas (original or masked)
let originalDataUrl = null; // original image without baked masks
// zoom state
let zoomScale = 1.0;
const ZOOM_MIN = 0.1, ZOOM_MAX = 4.0;
// Preferences / resource limits (changeable later via a Preferences UI)
const PREFS = {
  maxConcurrency: 1,       // number of parallel detect requests
  previewMaxSize: 320,     // thumbnail max size
  requestTimeoutMs: 60000, // per-request timeout
  detectMaxDim: 1024      // downscale large images to this max dimension before RetinaFace
};

const __startup_ts = performance.now();

function setItemStatus(it, status, gridIdPrefer = 'detectionGrid') {
  it.status = status;
  if (it._refs) {
    if (gridIdPrefer && it._refs[gridIdPrefer] && it._refs[gridIdPrefer]._status) it._refs[gridIdPrefer]._status.textContent = status;
    else Object.values(it._refs).forEach(r => r._status && (r._status.textContent = status));
  }
}

// interaction state for editing rects
let dragMode = 'none'; // 'none' | 'draw' | 'move' | 'resize'
let selectedIndex = -1;
let handleIndex = -1; // which handle is active for resize
let startX = 0, startY = 0; // reuse for drawing/move/resize
let prevMouseX = 0, prevMouseY = 0;
const HANDLE_SIZE = 8; // pixels

// Tab switching
tabButtons.forEach(b => b.addEventListener('click', (e) => {
  const t = e.target.dataset.tab;
  // if editor open and we have a current image, persist any edits before switching tabs
  try { if (!document.getElementById('editor').classList.contains('hidden') && typeof persistCurrentEdits === 'function') persistCurrentEdits(); } catch (e) {}
  tabButtons.forEach(x => x.classList.remove('active'));
  e.target.classList.add('active');
  document.getElementById('import').classList.toggle('hidden', t !== 'import');
  document.getElementById('detection').classList.toggle('hidden', t !== 'detection');
  document.getElementById('edit').classList.toggle('hidden', t !== 'edit');
  document.getElementById('export').classList.toggle('hidden', t !== 'export');
  // always hide single-image editor when switching tabs so its overlay/filmstrip doesn't persist
  try { const ed = document.getElementById('editor'); if (ed) ed.classList.add('hidden'); } catch (e) {}
  updateTabVisibility(t);
}));

function updateTabVisibility(activeTab) {
  // show gallery only on Import tab
  try { const galleryEl = document.getElementById('gallery'); if (galleryEl) galleryEl.classList.toggle('hidden', activeTab !== 'import'); } catch (e) {}
  const detectionToolbar = document.getElementById('detectionToolbar');
  const editToolbar = document.getElementById('editToolbar');
  // Editor toolbar buttons (in the separate editor section)
  const editorBack = backBtn;
  const editorDetect = detectBtn;
  const editorSave = saveBtn;

  // Default: hide toolbars and editor buttons
  if (detectionToolbar) detectionToolbar.classList.add('hidden');
  if (editToolbar) editToolbar.classList.add('hidden');
  if (editorBack) editorBack.style.display = 'none';
  if (editorDetect) editorDetect.style.display = 'none';
  if (editorSave) editorSave.style.display = 'none';

  // Show only what we need per tab
  // detection: show only the Detect All button
  if (activeTab === 'detection') {
    if (detectionToolbar) detectionToolbar.classList.remove('hidden');
    const dt = document.getElementById('detectAllBtn'); if (dt) dt.style.display = 'inline-block';
    const ap = document.getElementById('applyAllBtn'); if (ap) ap.style.display = 'none';
    const db = document.getElementById('detectBackBtn'); if (db) db.style.display = 'none';
  } else if (activeTab === 'edit') {
    // edit tab: show edit toolbar with Export button (create if missing)
    if (editToolbar) editToolbar.classList.remove('hidden');
    let exportBtn = document.getElementById('exportBtn');
    if (!exportBtn) {
      exportBtn = document.createElement('button'); exportBtn.id = 'exportBtn'; exportBtn.textContent = 'Export';
      exportBtn.addEventListener('click', async () => {
        // reuse batch export logic
        if (typeof applyAllBtn !== 'undefined' && applyAllBtn) applyAllBtn.click();
      });
      editToolbar.appendChild(exportBtn);
    }
    exportBtn.style.display = 'inline-block';
    // hide the edit tab's Back button per user request
    const editBack = document.getElementById('editBackBtn'); if (editBack) editBack.style.display = 'none';
    // hide global detect button when on edit tab
    if (detectBtn) detectBtn.style.display = 'none';
    // build filmstrip for the edit tab so user sees it immediately
    try { buildFilmstrip(current || null, 'filmstripEdit'); } catch (e) {}
    // open single-image editor automatically when entering the Edit tab
    try {
      const ed = document.getElementById('editor');
      // open editor only if not already visible and we have items
      if (ed && ed.classList.contains('hidden') && items && items.length) {
        const pathToOpen = current || items[0].path;
        if (pathToOpen) openEditor(pathToOpen, findItemByPath(pathToOpen).boxesOriginal || findItemByPath(pathToOpen).boxes || []);
      }
    } catch (e) {}
  } else {
    // import or other: keep detection/edit toolbars hidden
  }
}

// operation lock to prevent navigating away while long-running tasks execute
let _opCount = 0;
function beginOperation(name) { _opCount++; document.body.classList.add('busy'); updateTabButtons(); }
function endOperation(name) { _opCount = Math.max(0, _opCount - 1); if (_opCount === 0) document.body.classList.remove('busy'); updateTabButtons(); }
function updateTabButtons() {
  const tabs = document.querySelectorAll('#tabs .tab');
  tabs.forEach(t => { t.disabled = (_opCount > 0); t.classList.toggle('disabled', _opCount > 0); });
}

// initialize tab visibility state
updateTabButtons();
updateTabVisibility('import');

function ensureItemsFromImages() {
  items = images.map(i => ({ path: i.path, preview: (i.thumbSrc || null), boxes: [], status: 'idle', previewScale: 1 }));
}

function sidecarPathForImage(p) {
  if (!p) return null;
  try { return p.replace(/(\.[^./\\]+)?$/, '.xmp'); } catch (e) { return p + '.xmp'; }
}

async function loadSidecarForItem(it) {
  // persistence via sidecars disabled — do nothing
  return false;
}

function saveImagesListToStorage() {
  // disabled: persistence across sessions turned off
}

function loadImagesListFromStorage() {
  // disabled: do not restore image list from previous sessions
  return [];
}

function buildGrid(gridEl) {
  gridEl.innerHTML = '';
  // ensure observer exists
  if (typeof window.__thumbObserver === 'undefined') {
    if ('IntersectionObserver' in window) {
      window.__thumbObserver = new IntersectionObserver(async (entries) => {
        for (const ent of entries) {
          if (!ent.isIntersecting) continue;
          const img = ent.target;
          const it = img.__it;
          if (!it) { window.__thumbObserver.unobserve(img); continue; }
          // if preview already available, set and stop observing
          if (it.preview) {
            img.src = it.preview;
            window.__thumbObserver.unobserve(img);
            continue;
          }
          // load native thumbnail via main process
          try {
            if (it._refs) Object.values(it._refs).forEach(r => r._status && (r._status.textContent = 'previewing'));
            const res = await window.api.makeThumbnail(it.path, PREFS.previewMaxSize);
            if (res && res.ok) {
              // if there are saved masks in original coordinates, render them onto the thumbnail
              if (it.boxesOriginal && Array.isArray(it.boxesOriginal) && it.boxesOriginal.length) {
                try {
                  const previewSize = await getDataUrlSize(res.dataUrl);
                  const origSize = res.originalSize || { width: previewSize.w, height: previewSize.h };
                  const sp = (previewSize.w && origSize.width) ? (previewSize.w / origSize.width) : 1;
                  const boxesPreview = it.boxesOriginal.map(b => [Math.round(b[0] * sp), Math.round(b[1] * sp), Math.round(b[2] * sp), Math.round(b[3] * sp)]);
                  const masked = await applyMasksToDataUrl(res.dataUrl, boxesPreview, 1);
                  it.preview = masked || res.dataUrl;
                  img.src = it.preview;
                } catch (e) {
                  it.preview = res.dataUrl; img.src = res.dataUrl;
                }
              } else {
                it.preview = res.dataUrl;
                img.src = res.dataUrl;
              }
            } else {
              // fallback to base64 downscale
              try {
                const b64 = await window.api.readFileBase64(it.path);
                if (b64) {
                  const down = await downscaleDataUrl('data:image/png;base64,' + b64, PREFS.previewMaxSize);
                  it.preview = down; img.src = down;
                }
              } catch (e) {}
            }
            if (it._refs) Object.values(it._refs).forEach(r => r._status && (r._status.textContent = it.status || 'idle'));
          } catch (e) {
            if (it._refs) Object.values(it._refs).forEach(r => r._status && (r._status.textContent = 'err'));
          } finally { window.__thumbObserver.unobserve(img); }
        }
      }, { root: null, rootMargin: '200px', threshold: 0.01 });
    } else {
      window.__thumbObserver = null;
    }
  }

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const el = document.createElement('div'); el.className = 'gridItem';
    const img = document.createElement('img');
    // set src only if preview already available to avoid eager file:// loads
    if (it.preview) img.src = it.preview; else img.src = '';
    // export grid previews should be unclickable
    if (gridEl && gridEl.id === 'exportGrid') img.style.pointerEvents = 'none';
    img.__it = it;
    img.onload = () => { if (it._refs && it._refs[gridEl.id] && it._refs[gridEl.id]._status) it._refs[gridEl.id]._status.textContent = it.status || 'idle'; };
    // only allow opening the single-image editor from the Edit grid
    if (gridEl && gridEl.id === 'editGrid') {
      img.addEventListener('click', () => openEditor(it.path, it.boxesOriginal || it.boxes || [], { from: gridEl.id }));
    }
    const label = document.createElement('div'); label.className = 'label'; label.textContent = it.path.split(/\\|\//).pop();
    const status = document.createElement('div'); status.className = 'status'; status.textContent = it.status;
    el.appendChild(img); el.appendChild(label); el.appendChild(status);
    gridEl.appendChild(el);
    // store refs per grid so status updates can target the correct grid
    it._refs = it._refs || {};
    it._refs[gridEl.id] = { _el: el, _img: img, _status: status };
    // lazy-load thumbnails when they enter viewport
    try { if (window.__thumbObserver && !it.preview) window.__thumbObserver.observe(img); else if (!it.preview) { /* no observer -> load first visible set */ window.api.makeThumbnail(it.path, PREFS.previewMaxSize).then(res => { if (res && res.ok) { it.preview = res.dataUrl; img.src = res.dataUrl; } }).catch(()=>{}); } } catch (e) {}
  }
}

async function generatePreview(index, maxSize = 320) {
  const it = items[index];
  if (!it) return;
  try {
    it.status = 'previewing'; if (it._refs) Object.values(it._refs).forEach(r => r._status && (r._status.textContent = it.status));
    // request cached native thumbnail from main process (fast, C-decoded)
    const res = await window.api.makeThumbnail(it.path, maxSize);
    if (!res || !res.ok) throw new Error(res && res.error ? res.error : 'thumb failed');
    const thumb = res.dataUrl;
    it.preview = thumb;
    // file-level sizes unknown without decoding full image; leave previewScale as-is
    if (it._refs) Object.values(it._refs).forEach(r => r._img && (r._img.src = thumb));
    it.status = 'idle'; if (it._refs) Object.values(it._refs).forEach(r => r._status && (r._status.textContent = it.status));
  } catch (err) {
    // try fallback: read file as base64 and make a downscaled thumb
    // fallback: attempt base64 read+downscale if native thumbnail failed
    try {
      const b64 = await window.api.readFileBase64(it.path);
      if (b64) {
        const dataUrl = 'data:image/png;base64,' + b64;
        const thumb = await downscaleDataUrl(dataUrl, maxSize);
        it.preview = thumb;
        if (it._refs) Object.values(it._refs).forEach(r => r._img && (r._img.src = thumb));
        it.status = 'idle'; if (it._refs) Object.values(it._refs).forEach(r => r._status && (r._status.textContent = it.status));
        return;
      }
    } catch (e) {
      // ignore
    }
    // fallback to file uri so UI still shows an image (may still be broken)
    try { it.preview = 'file://' + encodeURI(it.path); if (it._refs) Object.values(it._refs).forEach(r => r._img && (r._img.src = it.preview)); } catch (e) {}
    it.status = 'err'; if (it._refs) Object.values(it._refs).forEach(r => r._status && (r._status.textContent = it.status));
    return;
  }
}

async function downscaleFromPath(filePath, maxSize) {
  // prefer native thumbnail generation in main process (fast and cached)
  try {
    const res = await window.api.makeThumbnail(filePath, maxSize);
    if (res && res.ok) return res.dataUrl;
  } catch (e) {}
  // fallback to client-side downscale
  const img = new Image();
  await new Promise((res, rej) => { img.onload = () => res(); img.onerror = rej; img.src = 'file://' + encodeURI(filePath); });
  let w = img.width, h = img.height;
  const scale = Math.min(1, maxSize / Math.max(w, h));
  w = Math.round(w * scale); h = Math.round(h * scale);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0, w, h);
  return c.toDataURL('image/png');
}

function downscaleDataUrl(dataUrl, maxSize) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      let w = img.width, h = img.height;
      const scale = Math.min(1, maxSize / Math.max(w, h));
      w = Math.round(w * scale); h = Math.round(h * scale);
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0, w, h);
      res(c.toDataURL('image/png'));
    };
    img.onerror = rej;
    img.src = dataUrl;
  });
}

function getDataUrlSize(dataUrl) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res({ w: img.width, h: img.height });
    img.onerror = rej;
    img.src = dataUrl;
  });
}

// return thumbnail info: { ok, dataUrl, fileSize, originalSize }
async function getThumbnailInfo(filePath, maxDim) {
  try {
    const res = await window.api.makeThumbnail(filePath, maxDim);
    return res;
  } catch (e) { return null; }
}

function dataUrlToBlob(dataUrl) {
  const parts = dataUrl.split(',');
  const m = parts[0].match(/:(.*?);/);
  const bstr = atob(parts[1]);
  let n = bstr.length; const u8 = new Uint8Array(n);
  while (n--) u8[n] = bstr.charCodeAt(n);
  return new Blob([u8], { type: m ? m[1] : 'application/octet-stream' });
}

async function applyMasksToDataUrl(dataUrl, boxes, scale = 1) {
  return new Promise((res) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      g.fillStyle = 'black';
      for (const b of boxes) {
        const x = Math.round(b[0] * scale);
        const y = Math.round(b[1] * scale);
        const w = Math.round((b[2] - b[0]) * scale);
        const h = Math.round((b[3] - b[1]) * scale);
        g.fillRect(x, y, w, h);
      }
      res(c.toDataURL('image/png'));
    };
    img.src = dataUrl;
  });
}

// Detection grid actions
const detectAllBtn = document.getElementById('detectAllBtn');
const applyAllBtn = document.getElementById('applyAllBtn');

detectAllBtn && detectAllBtn.addEventListener('click', async () => {
  beginOperation('detectAll');
  if (items.length === 0) return alert('No images for detection');
  const detectionToolbar = document.getElementById('detectionToolbar');
  if (detectionToolbar) {
    // ensure progress UI exists
    let label = document.getElementById('detectionProgressLabel');
    if (!label) { label = document.createElement('span'); label.id = 'detectionProgressLabel'; label.style.marginLeft = '12px'; detectionToolbar.appendChild(label); }
    let bar = document.getElementById('detectionProgressBar');
    if (!bar) { bar = document.createElement('progress'); bar.id = 'detectionProgressBar'; bar.max = items.length; bar.value = 0; bar.style.marginLeft = '8px'; detectionToolbar.appendChild(bar); }
    label.textContent = `0 / ${items.length}`;
    bar.value = 0;
  }

  // helper to set item status targeting the detection grid first
  function setItemStatusLocal(it, status) {
    it.status = status;
    if (it._refs && it._refs['detectionGrid'] && it._refs['detectionGrid']._status) it._refs['detectionGrid']._status.textContent = status;
    else if (it._refs) Object.values(it._refs).forEach(r => r._status && (r._status.textContent = status));
  }

  // limited concurrency worker with throughput + ETA calculation
  const concurrency = Math.max(1, PREFS.maxConcurrency || 1);
  let index = 0; let completed = 0; let totalTime = 0; let totalBytes = 0;

  async function worker() {
    while (true) {
      const i = index++;
      if (i >= items.length) break;
      const it = items[i];
      try {
        setItemStatusLocal(it, 'detecting');
        const t0 = performance.now();
        // downscale for detection to keep RetinaFace fast and memory usage low
        let detectDataUrl = null;
        let thumbInfo = null;
        try {
          // request a native thumbnail for detection (returns dataUrl and originalSize)
          thumbInfo = await getThumbnailInfo(it.path, PREFS.detectMaxDim);
          detectDataUrl = thumbInfo && thumbInfo.ok ? thumbInfo.dataUrl : null;
        } catch (e) {
          // fallback: try reading base64 then downscale
          try {
            const b64 = await window.api.readFileBase64(it.path);
            if (b64) detectDataUrl = await downscaleDataUrl('data:image/png;base64,' + b64, PREFS.detectMaxDim);
          } catch (e2) { detectDataUrl = null; }
        }
        if (!detectDataUrl) { setItemStatusLocal(it, 'error: prepare-failed'); continue; }
        // get detect image size
        let detectSize = null;
        try { detectSize = await getDataUrlSize(detectDataUrl); } catch (e) { console.warn('detect size load failed', e); }
        const res = await window.api.detectData(detectDataUrl, 'detect', PREFS.requestTimeoutMs);
        if (!res || !res.ok) {
          console.warn('detectData failed', res);
          const errMsg = res && (res.error || res.statusCode || res.raw) ? String(res.error || res.statusCode || (res.raw && (typeof res.raw === 'string' ? res.raw.slice(0,200) : JSON.stringify(res.raw)))) : 'unknown';
          setItemStatusLocal(it, 'error: ' + errMsg);
          continue;
        }
        const json = res.json || {};
        const boxes = json.boxes || [];
        // ensure we have a downscaled preview
        if (!it.preview) it.preview = await downscaleFromPath(it.path, PREFS.previewMaxSize);
        let previewSize = null; try { previewSize = await getDataUrlSize(it.preview); } catch (e) { console.warn('preview size load failed', e); }
        // compute boxes in original image coordinates if we have originalSize from thumbnail
        const origSize = (thumbInfo && thumbInfo.originalSize) ? { w: thumbInfo.originalSize.width, h: thumbInfo.originalSize.height } : null;
        let boxesOriginal = boxes.slice();
        if (origSize && detectSize && detectSize.w > 0) {
          const sx = origSize.w / detectSize.w; const sy = origSize.h / detectSize.h;
          boxesOriginal = boxes.map(b => [Math.round(b[0] * sx), Math.round(b[1] * sy), Math.round(b[2] * sx), Math.round(b[3] * sy)]);
        }
        // compute preview-space boxes from original coords
        let boxesPreview = boxes.slice();
        if (origSize && previewSize && origSize.w > 0) {
          const sp = previewSize.w / origSize.w;
          boxesPreview = boxesOriginal.map(b => [Math.round(b[0] * sp), Math.round(b[1] * sp), Math.round(b[2] * sp), Math.round(b[3] * sp)]);
        } else if (detectSize && previewSize && detectSize.w > 0) {
          const sp2 = previewSize.w / detectSize.w;
          boxesPreview = boxes.map(b => [Math.round(b[0] * sp2), Math.round(b[1] * sp2), Math.round(b[2] * sp2), Math.round(b[3] * sp2)]);
        }
        it.boxesOriginal = boxesOriginal;
        it.boxes = boxesPreview;
        console.log('detectAll: boxes original/preview counts', (it.boxesOriginal||[]).length, (it.boxes||[]).length, 'path=', it.path);
        try { it.preview = await applyMasksToDataUrl(it.preview, it.boxes, 1); } catch (e) { console.warn('applyMasksToDataUrl failed', e); }
        if (it._refs && it._refs['detectionGrid'] && it._refs['detectionGrid']._img) it._refs['detectionGrid']._img.src = it.preview;
        setItemStatusLocal(it, 'done');
        // sidecar persistence disabled
        const t1 = performance.now(); const dt = (t1 - t0);
        totalTime += dt;
        totalBytes += (res.fileSize || 0);
      } catch (err) {
        console.error('detect worker exception', err);
        setItemStatusLocal(it, 'error: ' + (err && err.message ? err.message : String(err)));
      } finally {
        completed++;
        const bar = document.getElementById('detectionProgressBar');
        const label = document.getElementById('detectionProgressLabel');
        if (bar) bar.value = completed;
        if (label) {
          let eta = '';
          if (completed > 0 && totalTime > 0) {
            const avg = totalTime / completed; const remaining = items.length - completed; const etaMs = Math.round(avg * remaining);
            const s = Math.round(etaMs/1000);
            const mbProcessed = (totalBytes/1024/1024);
            const secs = Math.max(1, Math.round(totalTime/1000));
            const mbps = (mbProcessed / secs).toFixed(2);
            eta = ` — ETA ${s}s @ ${mbps} MB/s`;
          }
          const currentName = it.path.split(/\\|\//).pop();
          label.textContent = `${completed} / ${items.length} — ${currentName}${eta}`;
        }
      }
    }
  }

  // start workers
  const workers = [];
  for (let w = 0; w < concurrency; w++) workers.push(worker());
  await Promise.all(workers);
  const dtEl = document.getElementById('detectionProgressLabel'); if (dtEl) dtEl.textContent += ' — finished';
  endOperation('detectAll');
});

applyAllBtn && applyAllBtn.addEventListener && applyAllBtn.addEventListener('click', async () => {
  beginOperation('export');
  const outdir = await window.batchApi.selectDirectory();
  if (!outdir) { endOperation('export'); return alert('Export cancelled'); }

  // progress UI in edit toolbar
  const toolbar = document.getElementById('editToolbar');
  let label = document.getElementById('exportProgressLabel');
  if (!label) { label = document.createElement('span'); label.id = 'exportProgressLabel'; label.style.marginLeft = '12px'; if (toolbar) toolbar.appendChild(label); }
  let bar = document.getElementById('exportProgressBar');
  if (!bar) { bar = document.createElement('progress'); bar.id = 'exportProgressBar'; bar.max = items.length; bar.value = 0; bar.style.marginLeft = '8px'; if (toolbar) toolbar.appendChild(bar); }
  label.textContent = `0 / ${items.length}`; bar.value = 0;

  let completed = 0; let totalTime = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    setItemStatus(it, 'exporting', 'editGrid');
    const t0 = performance.now();
    try {
      const maskBoxes = it.boxesOriginal || it.boxes || [];
      const res = await window.batchApi.maskFilePath(it.path, maskBoxes, PREFS.requestTimeoutMs);
      if (!res || !res.ok) { setItemStatus(it, 'error', 'editGrid'); continue; }
      const json = res.json || {};
      const dataurl = (json.image || '');
      const outB64 = dataurl.split(',')[1] || '';
      // derive extension from mime
      const mime = (dataurl.split(';')[0] || '').replace('data:', '') || 'image/png';
      const ext = mime.includes('jpeg') || mime.includes('jpg') ? '.jpg' : '.png';
      const baseName = it.path.split(/\\|\//).pop().replace(/\.[^.]+$/, '') + '_masked' + ext;
      const outPath = outdir + '/' + baseName;
      const writeRes = await window.batchApi.writeFile(outPath, outB64);
      if (!writeRes || !writeRes.ok) { setItemStatus(it, 'error', 'editGrid'); continue; }
      setItemStatus(it, 'exported', 'editGrid');
    } catch (err) {
      setItemStatus(it, 'error', 'editGrid');
    } finally {
      completed++; const t1 = performance.now(); totalTime += (t1 - t0);
      if (bar) bar.value = completed; if (label) label.textContent = `${completed} / ${items.length}`;
      // small yield so UI updates
      await new Promise(r => setTimeout(r, 10));
    }
  }
  if (label) label.textContent = `Exported ${completed} / ${items.length}`;
  alert('Batch export finished');
  endOperation('export');
});

// top-level export button (Export tab landing)
const exportBtnTop = document.getElementById('exportBtn');
if (exportBtnTop) exportBtnTop.addEventListener('click', async () => {
  beginOperation('export');
  const outdir = await window.batchApi.selectDirectory();
  if (!outdir) { endOperation('export'); return alert('Export cancelled'); }

  // progress UI in export landing
  const landing = document.getElementById('exportLanding');
  let label = document.getElementById('exportProgressLabel');
  if (!label) { label = document.createElement('span'); label.id = 'exportProgressLabel'; label.style.marginLeft = '12px'; if (landing) landing.appendChild(label); }
  let bar = document.getElementById('exportProgressBar');
  if (!bar) { bar = document.createElement('progress'); bar.id = 'exportProgressBar'; bar.max = items.length; bar.value = 0; bar.style.marginLeft = '8px'; if (landing) landing.appendChild(bar); }
  label.textContent = `0 / ${items.length}`; bar.value = 0;

  let completed = 0; let totalTime = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    setItemStatus(it, 'exporting', 'exportGrid');
    const t0 = performance.now();
    try {
      const maskBoxes = it.boxesOriginal || it.boxes || [];
      const res = await window.batchApi.maskFilePath(it.path, maskBoxes, PREFS.requestTimeoutMs);
      if (!res || !res.ok) { setItemStatus(it, 'error', 'exportGrid'); continue; }
      const json = res.json || {};
      const dataurl = (json.image || '');
      const outB64 = dataurl.split(',')[1] || '';
      const mime = (dataurl.split(';')[0] || '').replace('data:', '') || 'image/png';
      const ext = mime.includes('jpeg') || mime.includes('jpg') ? '.jpg' : '.png';
      const baseName = (it.path.split(/\\|\//).pop() || 'image').replace(/\.[^.]+$/, '') + '_masked' + ext;
      const outPath = outdir + '/' + baseName;
      const writeRes = await window.batchApi.writeFile(outPath, outB64);
      if (!writeRes || !writeRes.ok) { setItemStatus(it, 'error', 'exportGrid'); continue; }
      setItemStatus(it, 'exported', 'exportGrid');
    } catch (err) {
      setItemStatus(it, 'error', 'exportGrid');
    } finally {
      completed++; const t1 = performance.now(); totalTime += (t1 - t0);
      if (bar) bar.value = completed; if (label) label.textContent = `${completed} / ${items.length}`;
      await new Promise(r => setTimeout(r, 10));
    }
  }
  if (label) label.textContent = `Exported ${completed} / ${items.length}`;
  alert('Export finished');
  endOperation('export');
});

async function openEditor(path, boxes = null) {
  // if another image was open, persist its edits
  if (current && current !== path) await persistCurrentEdits();
  current = path;
  // hide all tab sections and show the single-image editor
  editor.classList.remove('hidden');
  const tabs = ['import','detection','edit','batch'];
  tabs.forEach(t => { const el = document.getElementById(t); if (el) el.classList.add('hidden'); });
  // hide the left gallery column while in single-image editor so canvas receives events
  try { document.getElementById('gallery').classList.add('hidden'); } catch (e) {}
  // load full image via main process
  const b64 = await window.api.readFileBase64(path);
  if (!b64) return alert('Failed to read file');
  const img = new Image();
  img.onload = () => {
    canvas.width = img.width;
    canvas.height = img.height;
    originalDataUrl = 'data:image/png;base64,' + b64;
    baseDataUrl = originalDataUrl;
    ctx.drawImage(img, 0, 0);
    if (boxes && Array.isArray(boxes) && boxes.length) {
      rects = boxes.map(b => [Math.max(0, Math.round(b[0])), Math.max(0, Math.round(b[1])), Math.min(img.width-1, Math.round(b[2])), Math.min(img.height-1, Math.round(b[3]))]);
    } else {
      rects = [];
    }
    drawRects();
    // initialize history for this image and filmstrip
    pushHistoryForCurrent();
    buildFilmstrip(current);
  };
  img.src = 'data:image/png;base64,' + b64;
}

async function closeEditor() {
  // save edits for the current image
  await persistCurrentEdits();
  editor.classList.add('hidden');
  // return to the edit tab by default
  document.getElementById('edit').classList.remove('hidden');
  updateTabVisibility('edit');
  try { document.getElementById('gallery').classList.remove('hidden'); } catch (e) {}
}

// back from editor -> close editor and return to Import tab
// Back button removed in UI; navigation uses tabs. No backBtn handler.

// Filmstrip + editor history (undo/redo)
function findItemByPath(p) { return items.find(it => it.path === p); }

function buildFilmstrip(activePath, containerId = 'filmstrip') {
  const strip = document.getElementById(containerId);
  if (!strip) return;
  strip.innerHTML = '';
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const thumb = document.createElement('img');
    // reuse already-generated preview when present to avoid regen
    thumb.src = it.preview || '';
    thumb.alt = it.path.split(/\\|\//).pop();
    thumb.title = it.path.split(/\\|\//).pop();
    // only request native thumbnail if we don't already have a preview
    if (!it.preview) {
      window.api.makeThumbnail(it.path, 160).then(res => { if (res && res.ok) { it.preview = res.dataUrl; thumb.src = res.dataUrl; } }).catch(()=>{});
    }
    if (it.path === activePath) thumb.classList.add('active');
    thumb.addEventListener('click', () => { openEditor(it.path, it.boxesOriginal || it.boxes || [], { from: containerId === 'filmstripEdit' ? 'edit' : 'editor' }); });
    strip.appendChild(thumb);
  }
}

function pushHistoryForCurrent() {
  const it = findItemByPath(current);
  if (!it) return;
  it.history = it.history || [];
  it.historyIndex = (typeof it.historyIndex === 'number') ? it.historyIndex : -1;
  if (it.historyIndex < it.history.length - 1) it.history = it.history.slice(0, it.historyIndex + 1);
  it.history.push(JSON.parse(JSON.stringify(rects || [])));
  it.historyIndex = it.history.length - 1;
  if (it.history.length > 100) { it.history.shift(); it.historyIndex = it.history.length - 1; }
}

// persist current edits into the item and update its preview image
async function persistCurrentEdits() {
  if (!current) return;
  const it = findItemByPath(current);
  if (!it) return;
  try {
    it.boxesOriginal = JSON.parse(JSON.stringify(rects || []));
  } catch (e) { it.boxesOriginal = (rects || []).slice(); }
  // update thumbnail preview to show masks where possible
  try {
    const fullData = originalDataUrl || baseDataUrl;
    if (!fullData) return;
    // create a downscaled preview from the full-size image (or reuse existing preview)
    let down = it.preview;
    if (!down) down = await downscaleDataUrl(fullData, PREFS.previewMaxSize);
    const ps = await getDataUrlSize(down);
    if (!ps || !ps.w || !canvas.width) { it.preview = down; return; }
    const scale = ps.w / canvas.width;
    const boxesPreview = (it.boxesOriginal || []).map(b => [Math.round(b[0] * scale), Math.round(b[1] * scale), Math.round(b[2] * scale), Math.round(b[3] * scale)]);
    const masked = await applyMasksToDataUrl(down, boxesPreview, 1);
    it.preview = masked || down;
    if (it._refs) Object.values(it._refs).forEach(r => r._img && (r._img.src = it.preview));
  } catch (e) { /* ignore preview update errors */ }
  // sidecar writing disabled
}

function undoForCurrent() {
  const it = findItemByPath(current);
  if (!it || !it.history) return;
  if (it.historyIndex > 0) {
    it.historyIndex--; rects = JSON.parse(JSON.stringify(it.history[it.historyIndex])); drawRects();
  }
}

function redoForCurrent() {
  const it = findItemByPath(current);
  if (!it || !it.history) return;
  if (it.historyIndex < it.history.length - 1) {
    it.historyIndex++; rects = JSON.parse(JSON.stringify(it.history[it.historyIndex])); drawRects();
  }
}

importBtn.addEventListener('click', async () => {
  beginOperation('import');
  const files = await window.api.openFiles();
  if (!files || files.length === 0) return;
  const allowed = ['.png', '.jpg', '.jpeg', '.bmp', '.gif', '.webp', '.tif', '.tiff'];
  let skipped = 0;
  // create import progress UI
  const importToolbar = document.getElementById('importToolbar') || gallery.parentElement;
  let impLabel = document.getElementById('importProgressLabel');
  if (!impLabel) { impLabel = document.createElement('span'); impLabel.id = 'importProgressLabel'; impLabel.style.marginLeft = '8px'; importToolbar.insertBefore(impLabel, importToolbar.firstChild); }
  let impBar = document.getElementById('importProgressBar');
  if (!impBar) { impBar = document.createElement('progress'); impBar.id = 'importProgressBar'; impBar.max = files.length; impBar.value = 0; impBar.style.marginLeft = '8px'; importToolbar.insertBefore(impBar, importToolbar.firstChild); }
  impLabel.textContent = `0 / ${files.length}`;

  // process sequentially to keep memory low and provide accurate progress
  let processed = 0; let totalTime = 0;
  for (const p of files) {
    const t0 = performance.now();
    const isImg = allowed.some(a => p.toLowerCase().endsWith(a));
    if (!isImg) { skipped++; processed++; impBar.value = processed; impLabel.textContent = `${processed} / ${files.length} (skipped)`; continue; }
    try {
      // create a downscaled thumb via file:// first
      let thumbSrc = null;
      try {
        thumbSrc = await downscaleFromPath(p, PREFS.previewMaxSize);
      } catch (err) {
        // fallback to base64 then downscale
        try {
          const b64 = await window.api.readFileBase64(p);
          if (b64) thumbSrc = await downscaleDataUrl('data:image/png;base64,' + b64, PREFS.previewMaxSize);
        } catch (e2) { thumbSrc = null; }
      }
        if (!thumbSrc) { skipped++; }
      else {
        const thumb = document.createElement('img');
        thumb.className = 'thumb';
        thumb.src = thumbSrc;
        thumb.dataset.path = p;
        // do not open single-image editor when clicking in the import landing/gallery
        gallery.appendChild(thumb);
        images.push({ path: p, thumbSrc: thumb.src });
      }
    } catch (err) {
      skipped++;
    } finally {
      const t1 = performance.now(); totalTime += (t1 - t0); processed++; impBar.value = processed;
      const avg = totalTime / processed; const remaining = files.length - processed; const etaMs = Math.round(avg * remaining); const s = Math.round(etaMs/1000);
      impLabel.textContent = `${processed} / ${files.length} — ETA ${s}s`;
      // allow GC of large images by yielding
      await new Promise(r => setTimeout(r, 10));
    }
  }
  if (skipped > 0) alert('Skipped ' + skipped + ' files that do not appear to be images');
  ensureItemsFromImages();
  buildGrid(detectionGrid);
  buildGrid(editGrid);
  const exportGridEl = document.getElementById('exportGrid'); if (exportGridEl) buildGrid(exportGridEl);
  // finalize progress UI
  impLabel.textContent = `Imported ${images.length} files${skipped?(' — skipped '+skipped):''}`;
  impBar.value = impBar.max;
  // persistence disabled: do not save image list or auto-load sidecars
  endOperation('import');
});

detectBtn && detectBtn.addEventListener('click', async () => {
  if (!current) { console.warn('No image open'); return; }
  try {
    console.log('Editor: starting detection for', current);
    // downscale the open image for detection to avoid huge TF inputs
    let detectDataUrl = null;
    try { detectDataUrl = await downscaleFromPath(current, PREFS.detectMaxDim); }
    catch (e) {
      console.warn('downscaleFromPath failed for editor detect', e);
      const b64 = await window.api.readFileBase64(current);
      if (b64) detectDataUrl = await downscaleDataUrl('data:image/png;base64,' + b64, PREFS.detectMaxDim);
    }
    if (!detectDataUrl) throw new Error('failed to prepare image for detection');
    let detectSize = null;
    try { detectSize = await getDataUrlSize(detectDataUrl); } catch (e) { console.warn('getDataUrlSize failed (editor)', e); }
    const res = await window.api.detectData(detectDataUrl, 'retina_mask', PREFS.requestTimeoutMs);
    if (!res || !res.ok) { console.warn('detectData (editor) response', res); throw new Error(res && res.error ? res.error : 'detection failed'); }
    const json = res.json || {};
    const boxes = json.boxes || [];
    console.log('Editor: raw boxes from server', boxes, 'detectSize=', detectSize, 'canvas=', { w: canvas.width, h: canvas.height });
    // scale boxes to the editor canvas (original image) coordinates
    if (detectSize && detectSize.w > 0 && canvas.width > 0) {
      const sx = canvas.width / detectSize.w;
      const sy = canvas.height / detectSize.h;
      rects = boxes.map(b => [Math.round(b[0] * sx), Math.round(b[1] * sy), Math.round(b[2] * sx), Math.round(b[3] * sy)]);
    } else {
      rects = boxes.slice();
    }
    baseDataUrl = originalDataUrl || baseDataUrl;
    drawRects();
    pushHistoryForCurrent();
    console.log('Editor: detection applied, rects=', rects.length);
  } catch (err) {
    console.error('Detection error (editor):', err);
    alert('Detection error: ' + (err.message || err));
  }
});

if (saveBtn) saveBtn.addEventListener('click', async () => {
  if (!current) return;
  try {
    const dataUrl = canvas.toDataURL('image/png');
    const defaultName = (current.split(/\\|\//).pop() || 'masked.png').replace(/\.[^.]+$/, '') + '_masked.png';
    const res = await window.fsApi.saveImage(dataUrl, defaultName);
    if (res && res.saved) {
      alert('Saved: ' + res.path);
    } else {
      alert('Save cancelled' + (res && res.error ? ': ' + res.error : ''));
    }
  } catch (err) {
    alert('Save error: ' + (err.message || err));
  }
});

function drawRects() {
  if (!baseDataUrl) {
    if (!current) return;
    window.api.readFileBase64(current).then(b64 => {
      baseDataUrl = 'data:image/png;base64,' + b64;
      const img = new Image();
      img.onload = () => {
        canvas.width = img.width; canvas.height = img.height; ctx.drawImage(img, 0, 0);
        ctx.fillStyle = 'black'; for (const r of rects) ctx.fillRect(r[0], r[1], r[2]-r[0], r[3]-r[1]);
        // draw handles for selected rect
        if (selectedIndex >= 0 && rects[selectedIndex]) {
          const handles = getHandles(rects[selectedIndex]); ctx.fillStyle = 'white'; ctx.strokeStyle = 'black'; for (const [hx, hy] of handles) { ctx.fillRect(hx - HANDLE_SIZE/2, hy - HANDLE_SIZE/2, HANDLE_SIZE, HANDLE_SIZE); ctx.strokeRect(hx - HANDLE_SIZE/2, hy - HANDLE_SIZE/2, HANDLE_SIZE, HANDLE_SIZE); }
        }
      };
      img.src = baseDataUrl;
    });
    return;
  }
  const img = new Image();
  img.onload = () => {
    canvas.width = img.width; canvas.height = img.height;
    // apply CSS transform for zooming
    canvas.style.transformOrigin = '0 0';
    canvas.style.transform = `scale(${zoomScale})`;
    ctx.drawImage(img, 0, 0);
    ctx.fillStyle = 'black';
    for (let i = 0; i < rects.length; i++) { const r = rects[i]; ctx.fillRect(r[0], r[1], r[2]-r[0], r[3]-r[1]); }
    // no visible stroke around masks per user request; only draw handles for selected rect
    for (let i = 0; i < rects.length; i++) {
      if (i === selectedIndex) {
        const r = rects[i]; const handles = getHandles(r);
        ctx.fillStyle = 'white'; ctx.strokeStyle = 'black';
        for (const [hx, hy] of handles) { ctx.fillRect(hx - HANDLE_SIZE/2, hy - HANDLE_SIZE/2, HANDLE_SIZE, HANDLE_SIZE); ctx.strokeRect(hx - HANDLE_SIZE/2, hy - HANDLE_SIZE/2, HANDLE_SIZE, HANDLE_SIZE); }
      }
    }
  };
  img.src = baseDataUrl;
}

// selection on click, double-click to remove
canvas.tabIndex = 0;
canvas.style.zIndex = 10;
canvas.style.pointerEvents = 'auto';
canvas.addEventListener('click', (e) => { e.preventDefault(); const [x, y] = clientToCanvas(e); console.log('canvas click', x, y); selectedIndex = findRectIndexAt(x, y); drawRects(); });
canvas.addEventListener('dblclick', (e) => { e.preventDefault(); const [x, y] = clientToCanvas(e); console.log('canvas dblclick', x, y); const idx = findRectIndexAt(x, y); if (idx >= 0) { rects.splice(idx, 1); selectedIndex = -1; drawRects(); pushHistoryForCurrent(); } });

function clientToCanvas(e) { const rect = canvas.getBoundingClientRect(); const x = (e.clientX - rect.left) * (canvas.width / rect.width); const y = (e.clientY - rect.top) * (canvas.height / rect.height); return [x, y]; }
function pointInRect(x, y, r) { return x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3]; }
function findRectIndexAt(x, y) { for (let i = rects.length - 1; i >= 0; i--) if (pointInRect(x, y, rects[i])) return i; return -1; }
function getHandles(r) { const [x1, y1, x2, y2] = r; const mx = (x1 + x2) / 2; const my = (y1 + y2) / 2; return [[x1, y1],[mx, y1],[x2, y1],[x2, my],[x2, y2],[mx, y2],[x1, y2],[x1, my]]; }
function getHandleIndexAt(x, y, r) { const handles = getHandles(r); for (let i = 0; i < handles.length; i++) { const [hx, hy] = handles[i]; if (Math.abs(x - hx) <= HANDLE_SIZE && Math.abs(y - hy) <= HANDLE_SIZE) return i; } return -1; }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

canvas.addEventListener('mousedown', (e) => {
  e.preventDefault();
  const [x, y] = clientToCanvas(e); console.log('canvas mousedown', x, y);
  prevMouseX = x; prevMouseY = y; const idx = findRectIndexAt(x, y);
  if (idx >= 0) { const h = getHandleIndexAt(x, y, rects[idx]); if (h >= 0) { dragMode = 'resize'; selectedIndex = idx; handleIndex = h; } else { dragMode = 'move'; selectedIndex = idx; } }
  else { dragMode = 'draw'; selectedIndex = -1; startX = x; startY = y; }
  drawRects();
  // attach window-level listeners to maintain events if pointer leaves canvas
  try { window.addEventListener('mousemove', handlePointerMove); window.addEventListener('mouseup', handlePointerUp); } catch (e) {}
});

function handlePointerMove(e) {
  e.preventDefault();
  const [x, y] = clientToCanvas(e);
  let cursor = 'default'; const idx = findRectIndexAt(x, y);
  if (idx >= 0) { const h = getHandleIndexAt(x, y, rects[idx]); cursor = (h >= 0) ? 'nw-resize' : 'move'; } else cursor = 'crosshair';
  canvas.style.cursor = cursor;
  if (dragMode === 'draw') { drawRects(); ctx.strokeStyle = 'blue'; ctx.lineWidth = 2; ctx.strokeRect(startX, startY, x - startX, y - startY); return; }
  if (dragMode === 'move' && selectedIndex >= 0) { const dx = x - prevMouseX; const dy = y - prevMouseY; const r = rects[selectedIndex]; r[0] = clamp(r[0] + dx, 0, canvas.width); r[1] = clamp(r[1] + dy, 0, canvas.height); r[2] = clamp(r[2] + dx, 0, canvas.width); r[3] = clamp(r[3] + dy, 0, canvas.height); drawRects(); prevMouseX = x; prevMouseY = y; return; }
  if (dragMode === 'resize' && selectedIndex >= 0) { const r = rects[selectedIndex]; let [x1, y1, x2, y2] = r; switch (handleIndex) { case 0: x1 = x; y1 = y; break; case 1: y1 = y; break; case 2: x2 = x; y1 = y; break; case 3: x2 = x; break; case 4: x2 = x; y2 = y; break; case 5: y2 = y; break; case 6: x1 = x; y2 = y; break; case 7: x1 = x; break; } const nx1 = Math.round(Math.min(x1, x2)); const nx2 = Math.round(Math.max(x1, x2)); const ny1 = Math.round(Math.min(y1, y2)); const ny2 = Math.round(Math.max(y1, y2)); rects[selectedIndex] = [clamp(nx1,0,canvas.width), clamp(ny1,0,canvas.height), clamp(nx2,0,canvas.width), clamp(ny2,0,canvas.height)]; drawRects(); return; }
}

canvas.addEventListener('mousemove', handlePointerMove);

// wheel to zoom when Ctrl is pressed (or meta on mac)
canvas.addEventListener('wheel', (e) => {
  if (!e.ctrlKey && !e.metaKey) return; // allow normal scroll
  e.preventDefault();
  const delta = e.deltaY;
  const factor = Math.pow(1.001, -delta); // smooth zoom multiplier
  const newScale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoomScale * factor));
  zoomAt(newScale, e.clientX, e.clientY);
});

function zoomAt(newScale, clientX, clientY) {
  if (!canvasWrap) { zoomScale = newScale; canvas.style.transform = `scale(${zoomScale})`; return; }
  const prev = zoomScale;
  // compute center point in original content coordinates
  const wrapRect = canvasWrap.getBoundingClientRect();
  const mouseX = clientX - wrapRect.left; const mouseY = clientY - wrapRect.top;
  const centerOriginalX = (canvasWrap.scrollLeft + mouseX) / prev;
  const centerOriginalY = (canvasWrap.scrollTop + mouseY) / prev;
  zoomScale = newScale;
  // apply transform
  canvas.style.transform = `scale(${zoomScale})`;
  // compute new scroll to keep the same content point under the mouse
  const newScrollLeft = Math.max(0, Math.round(centerOriginalX * zoomScale - mouseX));
  const newScrollTop = Math.max(0, Math.round(centerOriginalY * zoomScale - mouseY));
  // set scroll positions (yield to layout)
  setTimeout(() => { canvasWrap.scrollLeft = newScrollLeft; canvasWrap.scrollTop = newScrollTop; }, 0);
}

function handlePointerUp(e) {
  e.preventDefault();
  const [x, y] = clientToCanvas(e); console.log('canvas mouseup', x, y);
  const prevMode = dragMode;
  if (dragMode === 'draw') {
    const nx1 = Math.round(Math.min(startX, x)); const nx2 = Math.round(Math.max(startX, x));
    const ny1 = Math.round(Math.min(startY, y)); const ny2 = Math.round(Math.max(startY, y));
    if (Math.abs(nx2 - nx1) > 5 && Math.abs(ny2 - ny1) > 5) { rects.push([nx1, ny1, nx2, ny2]); selectedIndex = rects.length - 1; }
  }
  dragMode = 'none'; handleIndex = -1; prevMouseX = prevMouseY = 0; drawRects();
  if (prevMode === 'draw' || prevMode === 'move' || prevMode === 'resize') pushHistoryForCurrent();
  // remove window-level listeners if attached
  try { window.removeEventListener('mousemove', handlePointerMove); window.removeEventListener('mouseup', handlePointerUp); } catch (e) {}
}

canvas.addEventListener('mouseup', handlePointerUp);

function base64ToBlob(b64) { const bin = atob(b64); const len = bin.length; const bytes = new Uint8Array(len); for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i); return new Blob([bytes], { type: 'application/octet-stream' }); }

// Preferences modal handling
function loadPrefsFromStorage() {
  try {
    const raw = localStorage.getItem('blur_prefs');
    if (raw) {
      const obj = JSON.parse(raw);
      Object.assign(PREFS, obj);
    }
  } catch (e) {}
  // populate UI fields if present
  const c = document.getElementById('prefConcurrency'); if (c) c.value = PREFS.maxConcurrency;
  const p = document.getElementById('prefPreviewSize'); if (p) p.value = PREFS.previewMaxSize;
  const d = document.getElementById('prefDetectDim'); if (d) d.value = PREFS.detectMaxDim;
  const t = document.getElementById('prefTimeout'); if (t) t.value = PREFS.requestTimeoutMs;
}

function savePrefsToStorage() {
  try {
    const obj = { maxConcurrency: Number(document.getElementById('prefConcurrency').value) || PREFS.maxConcurrency,
      previewMaxSize: Number(document.getElementById('prefPreviewSize').value) || PREFS.previewMaxSize,
      detectMaxDim: Number(document.getElementById('prefDetectDim').value) || PREFS.detectMaxDim,
      requestTimeoutMs: Number(document.getElementById('prefTimeout').value) || PREFS.requestTimeoutMs };
    Object.assign(PREFS, obj);
    localStorage.setItem('blur_prefs', JSON.stringify(PREFS));
    return true;
  } catch (e) { return false; }
}

// wire modal buttons
document.addEventListener('DOMContentLoaded', () => {
  loadPrefsFromStorage();
  // restore previously-imported image list if present
  // persistence disabled: do not restore previous image list or auto-load sidecars
  // startup diagnostics
  try {
    const t = Math.round(performance.now() - __startup_ts);
    console.log(`App startup elapsed: ${t} ms — items:${items.length} images:${images.length}`);
  } catch (e) {}
});

// Keyboard shortcuts: Undo/Redo (Ctrl/Cmd+Z, Ctrl/Cmd+Y)
document.addEventListener('keydown', (e) => {
  const ctrl = e.ctrlKey || e.metaKey;
  if (!ctrl) return;
  if (e.key === 'z' || e.key === 'Z') { e.preventDefault(); undoForCurrent(); }
  if (e.key === 'y' || (e.shiftKey && (e.key === 'Z'))) { e.preventDefault(); redoForCurrent(); }
});

// additional keyboard navigation for edit tab
document.addEventListener('keydown', (e) => {
  // if user is typing in an input, ignore
  const active = document.activeElement;
  if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) return;
  // only act when Edit tab is active
  const activeTab = document.querySelector('#tabs .tab.active');
  if (!activeTab || activeTab.dataset.tab !== 'edit') return;
  // left/right to navigate filmstrip images
  if (e.key === 'ArrowLeft') {
    e.preventDefault(); navigateFilmstrip(-1);
  } else if (e.key === 'ArrowRight') {
    e.preventDefault(); navigateFilmstrip(1);
  } else if (e.key === '+' || e.key === '=' ) {
    // zoom in
    e.preventDefault(); zoomAt(Math.min(ZOOM_MAX, zoomScale * 1.25), window.innerWidth/2, window.innerHeight/2);
  } else if (e.key === '-') {
    e.preventDefault(); zoomAt(Math.max(ZOOM_MIN, zoomScale / 1.25), window.innerWidth/2, window.innerHeight/2);
  }
});

function navigateFilmstrip(delta) {
  if (!items || items.length === 0) return;
  const idx = items.findIndex(it => it.path === current);
  let next = 0;
  if (idx >= 0) next = clamp(idx + delta, 0, items.length - 1);
  else next = 0;
  if (items[next] && items[next].path) {
    openEditor(items[next].path, items[next].boxesOriginal || items[next].boxes || []);
  }
}
