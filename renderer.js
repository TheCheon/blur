// guided workflow renderer: import -> detect -> library/edit -> export

const state = {
  step: 'import',
  items: [],
  isDetecting: false,
  isExporting: false,
  outputDir: '',
  detectMaxDim: 1200,
  previewMaxDim: 360,
  requestTimeoutMs: 60000
};

const dom = {
  stepButtons: Array.from(document.querySelectorAll('.stepBtn')),
  panes: {
    import: document.getElementById('step-import'),
    detect: document.getElementById('step-detect'),
    library: document.getElementById('step-library'),
    export: document.getElementById('step-export')
  },
  importBtn: document.getElementById('importBtn'),
  importSummary: document.getElementById('importSummary'),
  importProgress: document.getElementById('importProgress'),
  importProgressLabel: document.getElementById('importProgressLabel'),
  detectNowBtn: document.getElementById('detectNowBtn'),
  detectSummary: document.getElementById('detectSummary'),
  detectProgress: document.getElementById('detectProgress'),
  detectProgressLabel: document.getElementById('detectProgressLabel'),
  detectLog: document.getElementById('detectLog'),
  libraryGrid: document.getElementById('libraryGrid'),
  toExportBtn: document.getElementById('toExportBtn'),
  chooseDirBtn: document.getElementById('chooseDirBtn'),
  outputDirInput: document.getElementById('outputDirInput'),
  suffixInput: document.getElementById('suffixInput'),
  formatSelect: document.getElementById('formatSelect'),
  jpegQualityInput: document.getElementById('jpegQualityInput'),
  jpegQualityLabel: document.getElementById('jpegQualityLabel'),
  stripMetadataCheckbox: document.getElementById('stripMetadataCheckbox'),
  exportBtn: document.getElementById('exportBtn'),
  exportSummary: document.getElementById('exportSummary'),
  exportProgress: document.getElementById('exportProgress'),
  exportProgressLabel: document.getElementById('exportProgressLabel'),
  exportLog: document.getElementById('exportLog'),
  editorModal: document.getElementById('editorModal'),
  editorTitle: document.getElementById('editorTitle'),
  editorCanvasWrap: document.getElementById('editorCanvasWrap'),
  editorCanvas: document.getElementById('editorCanvas'),
  deleteMaskBtn: document.getElementById('deleteMaskBtn'),
  resetMasksBtn: document.getElementById('resetMasksBtn'),
  cancelEditBtn: document.getElementById('cancelEditBtn'),
  saveEditBtn: document.getElementById('saveEditBtn')
};

const editorState = {
  item: null,
  imageDataUrl: null,
  imageEl: null,
  displayScale: 1,
  rectsDisp: [],
  selected: -1,
  dragMode: 'none',
  dragStartX: 0,
  dragStartY: 0,
  lastX: 0,
  lastY: 0,
  draftRect: null
};

const editorCtx = dom.editorCanvas.getContext('2d');

function setStep(step) {
  state.step = step;
  Object.entries(dom.panes).forEach(([name, pane]) => {
    pane.classList.toggle('hidden', name !== step);
  });
  dom.stepButtons.forEach((btn) => {
    const active = btn.dataset.step === step;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });
}

function appendLog(el, line) {
  const row = document.createElement('div');
  row.textContent = line;
  el.appendChild(row);
  el.scrollTop = el.scrollHeight;
}

function basename(p) {
  return p.split(/\\|\//).pop() || p;
}

function withoutExt(name) {
  return name.replace(/\.[^.]+$/, '');
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function pointInRect(x, y, r) {
  return x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3];
}

function dataUrlMime(dataUrl) {
  const m = /^data:(.*?);base64,/.exec(dataUrl || '');
  return m ? m[1] : 'image/png';
}

function getDataUrlSize(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.width, h: img.height });
    img.onerror = reject;
    img.src = dataUrl;
  });
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
}

function getItemByPath(path) {
  return state.items.find((it) => it.path === path) || null;
}

async function makePreview(path, maxDim) {
  const thumb = await window.api.makeThumbnail(path, maxDim);
  if (thumb && thumb.ok && thumb.dataUrl) {
    return {
      dataUrl: thumb.dataUrl,
      originalSize: thumb.originalSize ? { w: thumb.originalSize.width, h: thumb.originalSize.height } : null
    };
  }
  const b64 = await window.api.readFileBase64(path);
  if (!b64) return { dataUrl: null, originalSize: null };
  const dataUrl = `data:image/png;base64,${b64}`;
  const size = await getDataUrlSize(dataUrl);
  return { dataUrl, originalSize: size };
}

async function applyMasksToDataUrl(dataUrl, boxes) {
  const img = await loadImage(dataUrl);
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  g.fillStyle = 'black';
  for (const b of boxes || []) {
    g.fillRect(Math.round(b[0]), Math.round(b[1]), Math.round(b[2] - b[0]), Math.round(b[3] - b[1]));
  }
  return c.toDataURL('image/png');
}

async function refreshItemPreview(item) {
  const thumb = await makePreview(item.path, state.previewMaxDim);
  if (!thumb.dataUrl) return;
  item.previewOriginal = thumb.dataUrl;
  item.originalSize = thumb.originalSize || item.originalSize;
  if (!item.boxesOriginal || !item.boxesOriginal.length || !item.originalSize || !item.originalSize.w) {
    item.previewMasked = item.previewOriginal;
    return;
  }
  const pSize = await getDataUrlSize(item.previewOriginal);
  const scaleX = pSize.w / item.originalSize.w;
  const scaleY = pSize.h / item.originalSize.h;
  const boxesPreview = item.boxesOriginal.map((b) => [
    Math.round(b[0] * scaleX),
    Math.round(b[1] * scaleY),
    Math.round(b[2] * scaleX),
    Math.round(b[3] * scaleY)
  ]);
  item.previewMasked = await applyMasksToDataUrl(item.previewOriginal, boxesPreview);
}

function renderLibrary() {
  dom.libraryGrid.innerHTML = '';
  if (!state.items.length) {
    const empty = document.createElement('div');
    empty.className = 'mutedText';
    empty.textContent = 'No images imported yet.';
    dom.libraryGrid.appendChild(empty);
    return;
  }

  for (const item of state.items) {
    const card = document.createElement('div');
    card.className = 'imageCard';

    const img = document.createElement('img');
    img.src = item.previewMasked || item.previewOriginal || '';
    img.alt = item.name;
    img.addEventListener('click', () => openEditor(item.path));

    const meta = document.createElement('div');
    meta.className = 'imageMeta';

    const name = document.createElement('div');
    name.className = 'imageName';
    name.textContent = item.name;

    const status = document.createElement('div');
    status.className = 'imageStatus';
    status.textContent = `${item.status} | masks: ${item.boxesOriginal.length}`;

    const editBtn = document.createElement('button');
    editBtn.className = 'secondaryBtn';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => openEditor(item.path));

    meta.appendChild(name);
    meta.appendChild(status);

    card.appendChild(img);
    card.appendChild(meta);
    card.appendChild(editBtn);
    dom.libraryGrid.appendChild(card);
  }
}

async function importImages() {
  const files = await window.api.openFiles();
  if (!files || !files.length) return;

  const allowed = ['.png', '.jpg', '.jpeg', '.bmp', '.gif', '.webp', '.tif', '.tiff'];
  state.items = [];
  dom.importProgress.max = files.length;
  dom.importProgress.value = 0;
  dom.importProgressLabel.textContent = `0 / ${files.length}`;

  let skipped = 0;
  for (let i = 0; i < files.length; i++) {
    const path = files[i];
    const isAllowed = allowed.some((ext) => path.toLowerCase().endsWith(ext));
    if (!isAllowed) {
      skipped += 1;
    } else {
      const preview = await makePreview(path, state.previewMaxDim);
      state.items.push({
        path,
        name: basename(path),
        previewOriginal: preview.dataUrl,
        previewMasked: preview.dataUrl,
        boxesOriginal: [],
        status: 'imported',
        originalSize: preview.originalSize
      });
    }
    dom.importProgress.value = i + 1;
    dom.importProgressLabel.textContent = `${i + 1} / ${files.length}`;
  }

  dom.importSummary.textContent = `Imported ${state.items.length} image(s)${skipped ? `, skipped ${skipped}` : ''}.`;
  renderLibrary();
  setStep('detect');
  await runDetectionAll(true);
}

async function runDetectionAll(autoSwitchToLibrary) {
  if (!state.items.length) {
    dom.detectSummary.textContent = 'No images available. Import photos first.';
    return;
  }
  if (state.isDetecting) return;

  state.isDetecting = true;
  dom.detectNowBtn.disabled = true;
  dom.detectProgress.max = state.items.length;
  dom.detectProgress.value = 0;
  dom.detectProgressLabel.textContent = `0 / ${state.items.length}`;
  dom.detectSummary.textContent = 'Detection running...';
  dom.detectLog.innerHTML = '';

  for (let i = 0; i < state.items.length; i++) {
    const item = state.items[i];
    item.status = 'detecting';
    appendLog(dom.detectLog, `Detecting ${item.name}`);

    try {
      const detectThumb = await makePreview(item.path, state.detectMaxDim);
      if (!detectThumb.dataUrl) throw new Error('cannot create detect thumbnail');
      if (!item.originalSize && detectThumb.originalSize) item.originalSize = detectThumb.originalSize;

      const detectSize = await getDataUrlSize(detectThumb.dataUrl);
      const res = await window.api.detectData(detectThumb.dataUrl, 'detect', state.requestTimeoutMs);

      if (!res || !res.ok) {
        throw new Error(res && res.error ? String(res.error) : 'detection request failed');
      }

      const rawBoxes = (res.json && Array.isArray(res.json.boxes)) ? res.json.boxes : [];
      const orig = item.originalSize || detectSize;
      const sx = orig.w / detectSize.w;
      const sy = orig.h / detectSize.h;

      item.boxesOriginal = rawBoxes.map((b) => [
        Math.round(b[0] * sx),
        Math.round(b[1] * sy),
        Math.round(b[2] * sx),
        Math.round(b[3] * sy)
      ]);
      item.status = 'detected';
      await refreshItemPreview(item);
      appendLog(dom.detectLog, `OK ${item.name}: ${item.boxesOriginal.length} face(s)`);
    } catch (err) {
      item.status = `error`;
      appendLog(dom.detectLog, `ERROR ${item.name}: ${err.message || String(err)}`);
    }

    dom.detectProgress.value = i + 1;
    dom.detectProgressLabel.textContent = `${i + 1} / ${state.items.length}`;
  }

  state.isDetecting = false;
  dom.detectNowBtn.disabled = false;
  dom.detectSummary.textContent = 'Detection finished.';
  renderLibrary();
  if (autoSwitchToLibrary) setStep('library');
}

function clientToCanvas(e) {
  const rect = dom.editorCanvas.getBoundingClientRect();
  const x = (e.clientX - rect.left) * (dom.editorCanvas.width / rect.width);
  const y = (e.clientY - rect.top) * (dom.editorCanvas.height / rect.height);
  return [x, y];
}

function drawEditor() {
  if (!editorState.imageEl) return;
  const c = dom.editorCanvas;
  const g = editorCtx;
  g.clearRect(0, 0, c.width, c.height);
  g.drawImage(editorState.imageEl, 0, 0, c.width, c.height);

  g.fillStyle = 'black';
  for (let i = 0; i < editorState.rectsDisp.length; i++) {
    const r = editorState.rectsDisp[i];
    g.fillRect(r[0], r[1], r[2] - r[0], r[3] - r[1]);
    if (i === editorState.selected) {
      g.strokeStyle = '#32d2a6';
      g.lineWidth = 2;
      g.strokeRect(r[0], r[1], r[2] - r[0], r[3] - r[1]);
    }
  }

  if (editorState.draftRect) {
    const d = editorState.draftRect;
    g.strokeStyle = '#2f9ef8';
    g.lineWidth = 2;
    g.strokeRect(d[0], d[1], d[2] - d[0], d[3] - d[1]);
  }
}

async function openEditor(path) {
  const item = getItemByPath(path);
  if (!item) return;

  const b64 = await window.api.readFileBase64(path);
  if (!b64) {
    alert(`Unable to read ${item.name}`);
    return;
  }

  const dataUrl = `data:image/png;base64,${b64}`;
  const img = await loadImage(dataUrl);
  const wrapRect = dom.editorCanvasWrap.getBoundingClientRect();
  const maxW = Math.max(300, wrapRect.width - 24);
  const maxH = Math.max(220, wrapRect.height - 24);
  const scale = Math.min(maxW / img.width, maxH / img.height, 1);
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));

  dom.editorCanvas.width = w;
  dom.editorCanvas.height = h;

  editorState.item = item;
  editorState.imageDataUrl = dataUrl;
  editorState.imageEl = img;
  editorState.displayScale = scale;
  editorState.rectsDisp = (item.boxesOriginal || []).map((b) => [
    Math.round(b[0] * scale),
    Math.round(b[1] * scale),
    Math.round(b[2] * scale),
    Math.round(b[3] * scale)
  ]);
  editorState.selected = -1;
  editorState.dragMode = 'none';
  editorState.draftRect = null;

  dom.editorTitle.textContent = `Editor: ${item.name}`;
  dom.editorModal.classList.remove('hidden');
  drawEditor();
}

function closeEditor() {
  dom.editorModal.classList.add('hidden');
  editorState.item = null;
  editorState.imageEl = null;
  editorState.rectsDisp = [];
  editorState.selected = -1;
  editorState.dragMode = 'none';
  editorState.draftRect = null;
}

async function saveEditor() {
  if (!editorState.item) return;
  const s = editorState.displayScale || 1;
  editorState.item.boxesOriginal = editorState.rectsDisp.map((b) => [
    Math.round(b[0] / s),
    Math.round(b[1] / s),
    Math.round(b[2] / s),
    Math.round(b[3] / s)
  ]);
  await refreshItemPreview(editorState.item);
  renderLibrary();
  closeEditor();
}

function exportExtensionFromMime(mime) {
  if ((mime || '').includes('jpeg') || (mime || '').includes('jpg')) return 'jpg';
  return 'png';
}

async function forceOutputFormat(dataUrl, format, quality) {
  if (format === 'keep') return dataUrl;
  const img = await loadImage(dataUrl);
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  if (format === 'jpg') return c.toDataURL('image/jpeg', quality);
  return c.toDataURL('image/png');
}

function joinPath(dir, file) {
  return dir.replace(/\/+$/, '') + '/' + file;
}

function sanitizeFileName(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
}

async function runExport() {
  if (state.isExporting) return;
  if (!state.items.length) {
    alert('No images available. Import first.');
    return;
  }
  if (!state.outputDir) {
    alert('Choose an output folder first.');
    return;
  }

  state.isExporting = true;
  dom.exportBtn.disabled = true;
  dom.exportProgress.max = state.items.length;
  dom.exportProgress.value = 0;
  dom.exportProgressLabel.textContent = `0 / ${state.items.length}`;
  dom.exportSummary.textContent = 'Exporting...';
  dom.exportLog.innerHTML = '';

  const format = dom.formatSelect.value;
  const stripMetadata = !!dom.stripMetadataCheckbox.checked;
  const suffix = dom.suffixInput.value || '_masked';
  const jpegQuality = Number(dom.jpegQualityInput.value) / 100;

  let success = 0;
  for (let i = 0; i < state.items.length; i++) {
    const item = state.items[i];
    item.status = 'exporting';
    appendLog(dom.exportLog, `Exporting ${item.name}`);
    try {
      const res = await window.batchApi.maskFilePath(item.path, item.boxesOriginal || [], state.requestTimeoutMs, stripMetadata);
      if (!res || !res.ok || !res.json || !res.json.image) {
        throw new Error(res && res.error ? String(res.error) : 'mask failed');
      }

      const normalizedDataUrl = await forceOutputFormat(res.json.image, format, jpegQuality);
      const mime = dataUrlMime(normalizedDataUrl);
      const ext = format === 'keep' ? exportExtensionFromMime(mime) : format;
      const outName = sanitizeFileName(`${withoutExt(item.name)}${suffix}.${ext}`);
      const outPath = joinPath(state.outputDir, outName);
      const b64 = normalizedDataUrl.split(',')[1] || '';
      const writeRes = await window.batchApi.writeFile(outPath, b64);
      if (!writeRes || !writeRes.ok) {
        throw new Error(writeRes && writeRes.error ? String(writeRes.error) : 'write failed');
      }
      item.status = 'exported';
      success += 1;
      appendLog(dom.exportLog, `OK ${outName}`);
    } catch (err) {
      item.status = 'export-error';
      appendLog(dom.exportLog, `ERROR ${item.name}: ${err.message || String(err)}`);
    }
    dom.exportProgress.value = i + 1;
    dom.exportProgressLabel.textContent = `${i + 1} / ${state.items.length}`;
  }

  state.isExporting = false;
  dom.exportBtn.disabled = false;
  dom.exportSummary.textContent = `Export finished. ${success}/${state.items.length} exported.`;
  renderLibrary();
}

dom.stepButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.dataset.step === 'library' && !state.items.length) return;
    if (btn.dataset.step === 'detect' && !state.items.length) return;
    if (btn.dataset.step === 'export' && !state.items.length) return;
    setStep(btn.dataset.step);
  });
});

dom.importBtn.addEventListener('click', async () => {
  try {
    await importImages();
  } catch (err) {
    alert(`Import failed: ${err.message || err}`);
  }
});

dom.detectNowBtn.addEventListener('click', async () => {
  await runDetectionAll(false);
});

dom.toExportBtn.addEventListener('click', () => {
  setStep('export');
});

dom.chooseDirBtn.addEventListener('click', async () => {
  const dir = await window.batchApi.selectDirectory();
  if (dir) {
    state.outputDir = dir;
    dom.outputDirInput.value = dir;
  }
});

dom.jpegQualityInput.addEventListener('input', () => {
  dom.jpegQualityLabel.textContent = String(dom.jpegQualityInput.value);
});

dom.exportBtn.addEventListener('click', async () => {
  await runExport();
});

dom.cancelEditBtn.addEventListener('click', () => {
  closeEditor();
});

dom.saveEditBtn.addEventListener('click', async () => {
  await saveEditor();
});

dom.deleteMaskBtn.addEventListener('click', () => {
  if (editorState.selected >= 0 && editorState.selected < editorState.rectsDisp.length) {
    editorState.rectsDisp.splice(editorState.selected, 1);
    editorState.selected = -1;
    drawEditor();
  }
});

dom.resetMasksBtn.addEventListener('click', () => {
  if (!editorState.item) return;
  editorState.rectsDisp = [];
  editorState.selected = -1;
  drawEditor();
});

dom.editorCanvas.addEventListener('mousedown', (e) => {
  if (!editorState.item) return;
  const [x, y] = clientToCanvas(e);
  editorState.dragStartX = x;
  editorState.dragStartY = y;
  editorState.lastX = x;
  editorState.lastY = y;

  let found = -1;
  for (let i = editorState.rectsDisp.length - 1; i >= 0; i--) {
    if (pointInRect(x, y, editorState.rectsDisp[i])) {
      found = i;
      break;
    }
  }

  if (found >= 0) {
    editorState.selected = found;
    editorState.dragMode = 'move';
  } else {
    editorState.selected = -1;
    editorState.dragMode = 'draw';
    editorState.draftRect = [x, y, x, y];
  }
  drawEditor();
});

dom.editorCanvas.addEventListener('mousemove', (e) => {
  if (!editorState.item || editorState.dragMode === 'none') return;
  const [x, y] = clientToCanvas(e);
  const c = dom.editorCanvas;

  if (editorState.dragMode === 'draw' && editorState.draftRect) {
    editorState.draftRect = [
      clamp(Math.min(editorState.dragStartX, x), 0, c.width),
      clamp(Math.min(editorState.dragStartY, y), 0, c.height),
      clamp(Math.max(editorState.dragStartX, x), 0, c.width),
      clamp(Math.max(editorState.dragStartY, y), 0, c.height)
    ];
    drawEditor();
    return;
  }

  if (editorState.dragMode === 'move' && editorState.selected >= 0) {
    const dx = x - editorState.lastX;
    const dy = y - editorState.lastY;
    const r = editorState.rectsDisp[editorState.selected];
    const w = r[2] - r[0];
    const h = r[3] - r[1];
    let nx1 = r[0] + dx;
    let ny1 = r[1] + dy;
    nx1 = clamp(nx1, 0, c.width - w);
    ny1 = clamp(ny1, 0, c.height - h);
    editorState.rectsDisp[editorState.selected] = [nx1, ny1, nx1 + w, ny1 + h];
    editorState.lastX = x;
    editorState.lastY = y;
    drawEditor();
  }
});

window.addEventListener('mouseup', () => {
  if (!editorState.item) return;
  if (editorState.dragMode === 'draw' && editorState.draftRect) {
    const [x1, y1, x2, y2] = editorState.draftRect;
    if ((x2 - x1) > 8 && (y2 - y1) > 8) {
      editorState.rectsDisp.push([Math.round(x1), Math.round(y1), Math.round(x2), Math.round(y2)]);
      editorState.selected = editorState.rectsDisp.length - 1;
    }
  }
  editorState.dragMode = 'none';
  editorState.draftRect = null;
  drawEditor();
});

window.addEventListener('keydown', (e) => {
  if (dom.editorModal.classList.contains('hidden')) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    closeEditor();
  }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (editorState.selected >= 0 && editorState.selected < editorState.rectsDisp.length) {
      e.preventDefault();
      editorState.rectsDisp.splice(editorState.selected, 1);
      editorState.selected = -1;
      drawEditor();
    }
  }
});

setStep('import');
dom.jpegQualityLabel.textContent = String(dom.jpegQualityInput.value);
dom.outputDirInput.value = '';
