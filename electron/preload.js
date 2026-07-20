const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('stemapp', {
  sidecarUrl: process.env.STEMAPP_SIDECAR_URL || 'http://127.0.0.1:8756',
  sidecarToken: ipcRenderer.sendSync('auth:token'),
  openAudioDialog: () => ipcRenderer.invoke('dialog:openAudio'),
});
