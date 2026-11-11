// The one thing the page may ask of its window: to fit the panel (at the height its screen needs), or to be given its room back.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('localAiWindow', { compact: (on, height) => ipcRenderer.invoke('compact', !!on, +height || 0) });
