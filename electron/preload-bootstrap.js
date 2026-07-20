const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bootstrap', {
  onProgress: (cb) => ipcRenderer.on('bootstrap:progress', (_e, msg) => cb(msg)),
  start: () => ipcRenderer.send('bootstrap:start'),
  retry: () => ipcRenderer.send('bootstrap:retry'),
  quit: () => ipcRenderer.send('bootstrap:quit'),
});
