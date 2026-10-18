const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('files', {
  save: (opts) => ipcRenderer.invoke('save-file', opts),
  open: () => ipcRenderer.invoke('open-file'),
  setDirty: (d) => ipcRenderer.send('dirty', d),
  write: (path, data) => ipcRenderer.invoke('write-file', { path, data }),
});
