// guided workflow renderer: import -> detect -> library/edit -> export

const state = {
  step: 'import',
  items: [],
  isDetecting: false,
  isExporting: false,
  outputDir: '',
  detectMaxDim: 1200,
  previewMaxDim: 360,
  requestTimeoutMs: 60000,
  theme: localStorage.getItem('blurFacesTheme') || 'dark-modern'
};

// --- App state persistence (must be defined before setTheme) ---
let _saveTimer = null;
function scheduleSave(delay = 800) {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => { _saveTimer = null; saveAppState(); }, delay);
}

async function saveAppState() {
  try {
    const payload = getStatePayload();
    if (window.api && window.api.saveAppState) {
      await window.api.saveAppState(payload);
      console.log('App state saved');
    }
    await saveAutoSession();
  } catch (err) { console.error('saveAppState error', err); }
}

// Theme Management
function setTheme(themeName) {
  state.theme = themeName;
  document.documentElement.setAttribute('data-theme', themeName);
  localStorage.setItem('blurFacesTheme', themeName);
  console.log(`Theme switched to: ${themeName}`);
  // persist theme change
  scheduleSave();
}

// Initialize theme
setTheme(state.theme);

// All DOM operations must wait for page load
let dom = {}; // will be populated in DOMContentLoaded
let editorCtx = null;
let editorState = {
  item: null,
  imageDataUrl: null,
  imageEl: null,
  baseScale: 1,
  displayScale: 1,
  currentScale: 1,
  rectsDisp: [],
  selected: -1,
  dragMode: 'none',
  dragStartX: 0,
  dragStartY: 0,
  lastX: 0,
  lastY: 0,
  draftRect: null,
  dirty: false
};

let _editorSaveTimer = null;

function getStatePayload() {
  return {
    items: state.items.map((it) => ({ path: it.path, boxesOriginal: it.boxesOriginal || [], selectedMaskIndex: Number.isInteger(it.selectedMaskIndex) ? it.selectedMaskIndex : -1, name: it.name, status: it.status || 'imported' })),
    outputDir: state.outputDir || '',
    theme: state.theme || 'dark-modern',
    savedAt: Date.now()
  };
}

async function saveAutoSession() {
  try {
    if (window.api && window.api.saveSessionAs) {
      await window.api.saveSessionAs('autosave', getStatePayload());
    }
  } catch (err) {
    console.warn('saveAutoSession error', err);
  }
}

function scheduleEditorAutoSave(delay = 700) {
  if (_editorSaveTimer) clearTimeout(_editorSaveTimer);
  _editorSaveTimer = setTimeout(async () => {
    _editorSaveTimer = null;
    if (!editorState.item || !editorState.dirty) return;
    await saveEditor({ closeAfterSave: false, silent: true });
  }, delay);
}

function markEditorDirty() {
  editorState.dirty = true;
  scheduleEditorAutoSave();
}

function syncOutputDirFromInput() {
  if (!dom.outputDirInput) return;
  const typed = (dom.outputDirInput.value || '').trim();
  if (typed !== state.outputDir) {
    state.outputDir = typed;
    scheduleSave();
  }
}

function updateJpegSliderUI() {
  if (!dom.jpegQualityInput || !dom.jpegQualityLabel) return;
  const min = Number(dom.jpegQualityInput.min || 1);
  const max = Number(dom.jpegQualityInput.max || 100);
  const val = Number(dom.jpegQualityInput.value || max);
  dom.jpegQualityLabel.textContent = String(val);
  const pct = ((val - min) / Math.max(1, max - min)) * 100;
  dom.jpegQualityInput.style.background = `linear-gradient(to right, var(--accent) 0%, var(--accent) ${pct}%, var(--line) ${pct}%, var(--line) 100%)`;
}

// Wait for DOM to be ready before accessing elements
document.addEventListener('DOMContentLoaded', function() {
  console.log('DOM Content Loaded - initializing UI');
  
  // Initialize DOM references
  dom = {
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
    saveEditBtn: document.getElementById('saveEditBtn'),
    sessionsBtn: document.getElementById('sessionsBtn'),
    sessionsModal: document.getElementById('sessionsModal'),
    sessionNameInput: document.getElementById('sessionNameInput'),
    saveSessionBtn: document.getElementById('saveSessionBtn'),
    sessionsList: document.getElementById('sessionsList')
  };

  // Validate critical DOM elements exist
  if (!dom.editorCanvas || !dom.importBtn || !dom.sessionsBtn) {
    console.error('ERROR: Critical DOM elements not found. Check HTML structure.');
    console.log('DOM check:', {
      editorCanvas: !!dom.editorCanvas,
      importBtn: !!dom.importBtn,
      sessionsBtn: !!dom.sessionsBtn,
      detectNowBtn: !!dom.detectNowBtn,
      exportBtn: !!dom.exportBtn
    });
    return; // exit if DOM is broken
  }

  // Initialize editor context
  editorCtx = dom.editorCanvas.getContext('2d');
  
  // Attach all event listeners here
  initializeEventListeners();
  
  // Set initial step and load previous session
  setStep('import');
  updateJpegSliderUI();
  if (dom.outputDirInput) dom.outputDirInput.value = '';

  // Theme selector setup
  document.querySelectorAll('.themeBtn').forEach((btn) => {
    const theme = btn.dataset.themeOption;
    if (theme === state.theme) {
      btn.classList.add('active');
    }
    btn.addEventListener('click', () => {
      document.querySelectorAll('.themeBtn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      setTheme(theme);
    });
  });

  // Attempt to restore previous app state
  loadAppStateOnStart();
  
  // Save on process exit / window close
  window.addEventListener('beforeunload', () => { try { saveAppState(); } catch (e) {} });
  
  console.log('UI initialization complete');
});

function initializeEventListeners() {
  dom.stepButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.step === 'library' && !state.items.length) return;
      if (btn.dataset.step === 'detect' && !state.items.length) return;
      if (btn.dataset.step === 'export' && !state.items.length) return;
      setStep(btn.dataset.step);
    });
  });

  if (dom.importBtn) dom.importBtn.addEventListener('click', async () => {
    try {
      await importImages();
    } catch (err) {
      alert(`Import failed: ${err.message || err}`);
    }
  });

  if (dom.detectNowBtn) dom.detectNowBtn.addEventListener('click', async () => {
    await runDetectionAll(false);
  });

  if (dom.toExportBtn) dom.toExportBtn.addEventListener('click', () => {
    setStep('export');
  });

  if (dom.chooseDirBtn) dom.chooseDirBtn.addEventListener('click', async () => {
    const dir = await window.batchApi.selectDirectory();
    if (dir) {
      state.outputDir = dir;
      dom.outputDirInput.value = dir;
      scheduleSave();
    }
  });

  if (dom.outputDirInput) dom.outputDirInput.addEventListener('change', () => {
    syncOutputDirFromInput();
  });

  if (dom.outputDirInput) dom.outputDirInput.addEventListener('input', () => {
    syncOutputDirFromInput();
  });

  if (dom.jpegQualityInput) dom.jpegQualityInput.addEventListener('input', () => {
    updateJpegSliderUI();
  });

  if (dom.exportBtn) dom.exportBtn.addEventListener('click', async () => {
    await runExport();
  });

  if (dom.cancelEditBtn) dom.cancelEditBtn.addEventListener('click', () => {
    closeEditor();
  });

  if (dom.saveEditBtn) dom.saveEditBtn.addEventListener('click', async () => {
    await saveEditor();
  });

  if (dom.deleteMaskBtn) dom.deleteMaskBtn.addEventListener('click', () => {
    if (editorState.selected >= 0 && editorState.selected < editorState.rectsDisp.length) {
      editorState.rectsDisp.splice(editorState.selected, 1);
      editorState.selected = -1;
      if (editorState.item) editorState.item.selectedMaskIndex = -1;
      drawEditor();
      markEditorDirty();
    }
  });

  if (dom.resetMasksBtn) dom.resetMasksBtn.addEventListener('click', () => {
    if (!editorState.item) return;
    editorState.rectsDisp = [];
    editorState.selected = -1;
    editorState.item.selectedMaskIndex = -1;
    drawEditor();
    markEditorDirty();
  });

  // Sessions modal
  if (dom.sessionsBtn) dom.sessionsBtn.addEventListener('click', () => {
    openSessionsModal();
  });

  const sessionsCloseBtn = dom.sessionsModal?.querySelector('.closeBtn');
  if (sessionsCloseBtn) {
    sessionsCloseBtn.addEventListener('click', () => {
      closeSessionsModal();
    });
  }

  if (dom.sessionsModal) dom.sessionsModal.addEventListener('click', (e) => {
    if (e.target === dom.sessionsModal) closeSessionsModal();
  });

  if (dom.saveSessionBtn) dom.saveSessionBtn.addEventListener('click', async () => {
    const name = dom.sessionNameInput.value.trim();
    await saveCurrentSessionAs(name);
  });

  if (dom.sessionNameInput) dom.sessionNameInput.addEventListener('keypress', async (e) => {
    if (e.key === 'Enter') {
      const name = dom.sessionNameInput.value.trim();
      await saveCurrentSessionAs(name);
    }
  });

  // Canvas mouse events
  if (dom.editorCanvas) dom.editorCanvas.addEventListener('mousedown', (e) => {
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
      editorState.item.selectedMaskIndex = found;
      scheduleSave();
      editorState.dragMode = 'move';
    } else {
      editorState.selected = -1;
      editorState.item.selectedMaskIndex = -1;
      scheduleSave();
      editorState.dragMode = 'draw';
      editorState.draftRect = [x, y, x, y];
    }
    drawEditor();
  });

  if (dom.editorCanvas) dom.editorCanvas.addEventListener('mousemove', (e) => {
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

  // Zoom with Ctrl/Cmd + mouse wheel
  if (dom.editorCanvas) dom.editorCanvas.addEventListener('wheel', (e) => {
    if (dom.editorModal.classList.contains('hidden')) return;
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    if (e.deltaY < 0) {
      zoomIn();
    } else {
      zoomOut();
    }
  });

  window.addEventListener('mouseup', () => {
    if (!editorState.item) return;
    let changed = false;
    if (editorState.dragMode === 'draw' && editorState.draftRect) {
      const [x1, y1, x2, y2] = editorState.draftRect;
      if ((x2 - x1) > 8 && (y2 - y1) > 8) {
        editorState.rectsDisp.push([Math.round(x1), Math.round(y1), Math.round(x2), Math.round(y2)]);
        editorState.selected = editorState.rectsDisp.length - 1;
        editorState.item.selectedMaskIndex = editorState.selected;
        changed = true;
      }
    }
    if (editorState.dragMode === 'move') changed = true;
    editorState.dragMode = 'none';
    editorState.draftRect = null;
    drawEditor();
    if (changed) markEditorDirty();
  });

  window.addEventListener('keydown', (e) => {
    if (dom.editorModal.classList.contains('hidden')) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      closeEditor();
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (!editorState.item) return;
      const idx = state.items.findIndex((it) => it.path === editorState.item.path);
      openEditorByIndex(idx - 1);
      return;
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      if (!editorState.item) return;
      const idx = state.items.findIndex((it) => it.path === editorState.item.path);
      openEditorByIndex(idx + 1);
      return;
    }
    if (e.key === '+' || e.key === '=' ) {
      e.preventDefault();
      zoomIn();
      return;
    }
    if (e.key === '-') {
      e.preventDefault();
      zoomOut();
      return;
    }
    if (e.key === '0') {
      e.preventDefault();
      resetZoom();
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (editorState.selected >= 0 && editorState.selected < editorState.rectsDisp.length) {
        e.preventDefault();
        editorState.rectsDisp.splice(editorState.selected, 1);
        editorState.selected = -1;
        if (editorState.item) editorState.item.selectedMaskIndex = -1;
        drawEditor();
        markEditorDirty();
      }
    }
  });
}

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

async function loadAppStateOnStart() {
  try {
    if (!window.api || !window.api.loadAppState) return;
    const res = await window.api.loadAppState();
    if (!res || !res.ok) return;
    const st = res.state;
    if (!st) return;
    console.log('Loaded app state from disk', st);
    // restore theme
    if (st.theme) setTheme(st.theme);
    if (st.outputDir) { state.outputDir = st.outputDir; dom.outputDirInput.value = st.outputDir; }
    if (Array.isArray(st.items) && st.items.length) {
      state.items = st.items.map((it) => ({ path: it.path, name: it.name || basename(it.path), previewOriginal: null, previewMasked: null, boxesOriginal: it.boxesOriginal || [], selectedMaskIndex: Number.isInteger(it.selectedMaskIndex) ? it.selectedMaskIndex : -1, status: it.status || 'imported', originalSize: null }));
      // refresh previews for each item
      for (const item of state.items) {
        try { await refreshItemPreview(item); } catch (e) { console.warn('preview refresh failed', e); }
      }
      renderLibrary();
      setStep('library');
    }
  } catch (err) { console.error('loadAppStateOnStart error', err); }
}

// --- Session Management ---
async function openSessionsModal() {
  dom.sessionsModal.classList.remove('hidden');
  await loadSessionsList();
}

function closeSessionsModal() {
  dom.sessionsModal.classList.add('hidden');
  dom.sessionNameInput.value = '';
}

async function loadSessionsList() {
  try {
    const res = await window.api.listSessions();
    if (!res || !res.ok) return;
    const sessions = res.sessions || [];
    dom.sessionsList.innerHTML = '';
    if (!sessions.length) {
      const empty = document.createElement('p');
      empty.className = 'mutedText';
      empty.textContent = 'No saved sessions yet.';
      dom.sessionsList.appendChild(empty);
      return;
    }
    for (const sess of sessions) {
      const row = document.createElement('div');
      row.className = 'sessionItem';
      const info = document.createElement('div');
      info.className = 'sessionItemInfo';
      const name = document.createElement('div');
      name.className = 'sessionItemName';
      name.textContent = sess.name;
      const meta = document.createElement('div');
      meta.className = 'sessionItemMeta';
      const date = new Date(sess.modified).toLocaleString();
      meta.textContent = `Modified: ${date}`;
      info.appendChild(name);
      info.appendChild(meta);
      const btns = document.createElement('div');
      btns.className = 'sessionItemButtons';
      const loadBtn = document.createElement('button');
      loadBtn.className = 'sessionBtn';
      loadBtn.textContent = 'Load';
      loadBtn.addEventListener('click', () => loadSessionByName(sess.name));
      const delBtn = document.createElement('button');
      delBtn.className = 'sessionBtn danger';
      delBtn.textContent = 'Delete';
      delBtn.addEventListener('click', () => deleteSessionByName(sess.name));
      btns.appendChild(loadBtn);
      btns.appendChild(delBtn);
      row.appendChild(info);
      row.appendChild(btns);
      dom.sessionsList.appendChild(row);
    }
  } catch (err) { console.error('loadSessionsList error', err); }
}

async function loadSessionByName(name) {
  try {
    const res = await window.api.loadSession(name);
    if (!res || !res.ok) { alert('Failed to load session: ' + (res?.error || 'unknown')); return; }
    const st = res.state;
    if (!st) return;
    // restore state like loadAppStateOnStart does
    if (st.theme) setTheme(st.theme);
    if (st.outputDir) { state.outputDir = st.outputDir; dom.outputDirInput.value = st.outputDir; }
    state.items = [];
    if (Array.isArray(st.items) && st.items.length) {
      state.items = st.items.map((it) => ({ path: it.path, name: it.name || basename(it.path), previewOriginal: null, previewMasked: null, boxesOriginal: it.boxesOriginal || [], selectedMaskIndex: Number.isInteger(it.selectedMaskIndex) ? it.selectedMaskIndex : -1, status: it.status || 'imported', originalSize: null }));
      for (const item of state.items) {
        try { await refreshItemPreview(item); } catch (e) { console.warn('preview refresh failed', e); }
      }
      renderLibrary();
      setStep('library');
    }
    closeSessionsModal();
  } catch (err) { console.error('loadSessionByName error', err); alert('Error: ' + err.message); }
}

async function deleteSessionByName(name) {
  if (!confirm(`Delete session "${name}"?`)) return;
  try {
    const res = await window.api.deleteSession(name);
    if (!res || !res.ok) { alert('Failed to delete session'); return; }
    await loadSessionsList();
  } catch (err) { console.error('deleteSessionByName error', err); alert('Error: ' + err.message); }
}

async function saveCurrentSessionAs(name) {
  if (!name || !name.trim()) { alert('Session name cannot be empty'); return; }
  try {
    const payload = getStatePayload();
    const res = await window.api.saveSessionAs(name, payload);
    if (!res || !res.ok) { alert('Failed to save session'); return; }
    alert(`Session "${name}" saved!`);
    dom.sessionNameInput.value = '';
    await loadSessionsList();
  } catch (err) { console.error('saveCurrentSessionAs error', err); alert('Error: ' + err.message); }
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
        selectedMaskIndex: -1,
        status: 'imported',
        originalSize: preview.originalSize
      });
    }
    dom.importProgress.value = i + 1;
    dom.importProgressLabel.textContent = `${i + 1} / ${files.length}`;
  }

  dom.importSummary.textContent = `Imported ${state.items.length} image(s)${skipped ? `, skipped ${skipped}` : ''}.`;
  renderLibrary();
  scheduleSave();
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
  // persist detection results
  scheduleSave();
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
  const baseScale = Math.min(maxW / img.width, maxH / img.height);
  const effectiveScale = baseScale; // initial displayScale multiplier is 1

  editorState.item = item;
  editorState.imageDataUrl = dataUrl;
  editorState.imageEl = img;
  editorState.baseScale = baseScale;
  editorState.displayScale = 1;
  editorState.currentScale = effectiveScale;
  editorState.dirty = false;
  // compute canvas physical size based on combined scale
  const w = Math.max(1, Math.round(img.width * effectiveScale));
  const h = Math.max(1, Math.round(img.height * effectiveScale));

  dom.editorCanvas.width = w;
  dom.editorCanvas.height = h;

  // recompute rects display from original boxes
  editorState.rectsDisp = (item.boxesOriginal || []).map((b) => [
    Math.round(b[0] * effectiveScale),
    Math.round(b[1] * effectiveScale),
    Math.round(b[2] * effectiveScale),
    Math.round(b[3] * effectiveScale)
  ]);
  editorState.selected = Number.isInteger(item.selectedMaskIndex) ? clamp(item.selectedMaskIndex, -1, editorState.rectsDisp.length - 1) : -1;
  editorState.dragMode = 'none';
  editorState.draftRect = null;

  dom.editorTitle.textContent = `Editor: ${item.name}`;
  dom.editorModal.classList.remove('hidden');
  drawEditor();
}

function closeEditor() {
  if (_editorSaveTimer) {
    clearTimeout(_editorSaveTimer);
    _editorSaveTimer = null;
  }
  // Keep edits even if the modal closes before autosave timer fires.
  if (editorState.item && editorState.dirty) {
    const combined = (editorState.baseScale || 1) * (editorState.displayScale || 1);
    const s = combined || 1;
    editorState.item.boxesOriginal = editorState.rectsDisp.map((b) => [
      Math.round(b[0] / s),
      Math.round(b[1] / s),
      Math.round(b[2] / s),
      Math.round(b[3] / s)
    ]);
    editorState.item.selectedMaskIndex = editorState.selected;
    scheduleSave(0);
  }
  dom.editorModal.classList.add('hidden');
  editorState.item = null;
  editorState.imageEl = null;
  editorState.rectsDisp = [];
  editorState.selected = -1;
  editorState.dragMode = 'none';
  editorState.draftRect = null;
  editorState.dirty = false;
}

async function saveEditor({ closeAfterSave = true, silent = false } = {}) {
  if (!editorState.item) return;
  const combined = (editorState.baseScale || 1) * (editorState.displayScale || 1);
  const s = combined || 1;
  editorState.item.boxesOriginal = editorState.rectsDisp.map((b) => [
    Math.round(b[0] / s),
    Math.round(b[1] / s),
    Math.round(b[2] / s),
    Math.round(b[3] / s)
  ]);
  editorState.item.selectedMaskIndex = editorState.selected;
  await refreshItemPreview(editorState.item);
  renderLibrary();
  editorState.dirty = false;
  scheduleSave();
  if (!silent) {
    dom.exportSummary.textContent = `Saved edits for ${editorState.item.name}`;
  }
  if (closeAfterSave) closeEditor();
}

function updateCanvasForZoom() {
  if (!editorState.imageEl || !editorState.item) return;
  const newScale = Math.max(0.1, Math.min(8, editorState.baseScale * editorState.displayScale));
  const oldScale = editorState.currentScale || newScale;
  const ratio = newScale / oldScale;
  const w = Math.max(1, Math.round(editorState.imageEl.width * newScale));
  const h = Math.max(1, Math.round(editorState.imageEl.height * newScale));
  // reset dragging state when zooming to avoid coordinate confusion
  editorState.dragMode = 'none';
  editorState.draftRect = null;
  dom.editorCanvas.width = w;
  dom.editorCanvas.height = h;
  // Scale current edits so zoom never discards unsaved changes.
  editorState.rectsDisp = (editorState.rectsDisp || []).map((b) => [
    Math.round(b[0] * ratio),
    Math.round(b[1] * ratio),
    Math.round(b[2] * ratio),
    Math.round(b[3] * ratio)
  ]);
  editorState.currentScale = newScale;
  drawEditor();
}

function zoomBy(factor) {
  editorState.displayScale = Math.max(0.1, Math.min(8, editorState.displayScale * factor));
  updateCanvasForZoom();
}

function zoomIn() { zoomBy(1.25); }
function zoomOut() { zoomBy(0.8); }
function resetZoom() { editorState.displayScale = 1; updateCanvasForZoom(); }

function openEditorByIndex(idx) {
  if (!state.items.length) return;
  const clamped = ((idx % state.items.length) + state.items.length) % state.items.length;
  openEditor(state.items[clamped].path);
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
  syncOutputDirFromInput();
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
  const backendJpegQuality = clamp(Math.round(Number(dom.jpegQualityInput.value || 100)), 1, 100);

  let success = 0;
  for (let i = 0; i < state.items.length; i++) {
    const item = state.items[i];
    item.status = 'exporting';
    appendLog(dom.exportLog, `Exporting ${item.name}`);
    try {
      const res = await window.batchApi.maskFilePath(item.path, item.boxesOriginal || [], state.requestTimeoutMs, stripMetadata, backendJpegQuality);
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
  scheduleSave();
}
