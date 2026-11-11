// The one thing the page may ask of its window: to fit the panel, or to be given its room back.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('localAiWindow', { compact: (on) => ipcRenderer.invoke('compact', !!on) });
