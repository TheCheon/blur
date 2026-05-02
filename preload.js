// preload bridge: exposes safe ipc helpers to renderer
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openFiles: () => ipcRenderer.invoke('open-files'),
  readFileBase64: (p) => ipcRenderer.invoke('read-file-base64', p),
  detectFilePath: (p, route, timeoutMs) => ipcRenderer.invoke('detect-file', p, route, timeoutMs),
  detectData: (base64, route, timeoutMs) => ipcRenderer.invoke('detect-data', base64, route, timeoutMs),
  makeThumbnail: (p, maxDim) => ipcRenderer.invoke('make-thumbnail', p, maxDim),
  saveAppState: (obj) => ipcRenderer.invoke('save-app-state', obj),
  loadAppState: () => ipcRenderer.invoke('load-app-state'),
  listSessions: () => ipcRenderer.invoke('list-sessions'),
  deleteSession: (name) => ipcRenderer.invoke('delete-session', name),
  loadSession: (name) => ipcRenderer.invoke('load-session', name),
  saveSessionAs: (name, obj) => ipcRenderer.invoke('save-session-as', name, obj)
});

contextBridge.exposeInMainWorld('fsApi', {
  saveImage: (dataUrl, defaultName) => ipcRenderer.invoke('save-image', dataUrl, defaultName)
});

contextBridge.exposeInMainWorld('batchApi', {
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  writeFile: (filePath, base64) => ipcRenderer.invoke('write-file', filePath, base64),
  maskFilePath: (p, boxes, timeoutMs, stripMetadata, jpegQuality) => ipcRenderer.invoke('mask-file', p, boxes, timeoutMs, stripMetadata, jpegQuality)
});
