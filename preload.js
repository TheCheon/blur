// preload bridge: exposes safe ipc helpers to renderer
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openFiles: () => ipcRenderer.invoke('open-files'),
  readFileBase64: (p) => ipcRenderer.invoke('read-file-base64', p)
  ,detectFilePath: (p, route, timeoutMs) => ipcRenderer.invoke('detect-file', p, route, timeoutMs)
  ,detectData: (base64, route, timeoutMs) => ipcRenderer.invoke('detect-data', base64, route, timeoutMs)
  ,makeThumbnail: (p, maxDim) => ipcRenderer.invoke('make-thumbnail', p, maxDim)
});

contextBridge.exposeInMainWorld('fsApi', {
  saveImage: (dataUrl, defaultName) => ipcRenderer.invoke('save-image', dataUrl, defaultName)
});

contextBridge.exposeInMainWorld('batchApi', {
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  writeFile: (filePath, base64) => ipcRenderer.invoke('write-file', filePath, base64)
  ,maskFilePath: (p, boxes, timeoutMs, stripMetadata) => ipcRenderer.invoke('mask-file', p, boxes, timeoutMs, stripMetadata)
});
