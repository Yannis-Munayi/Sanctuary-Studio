const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('outputBridge', {
  onState: (fn) => ipcRenderer.on('output:state', (e, s) => fn(s)),
  onMedia: (fn) => ipcRenderer.on('output:media', (e, c) => fn(c)),
  onRole: (fn) => ipcRenderer.on('output:role', (e, r) => fn(r)),
  mediaStatus: (st) => ipcRenderer.send('output:mediaStatus', st),
});
