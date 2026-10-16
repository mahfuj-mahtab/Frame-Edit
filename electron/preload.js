const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('frameedit', {
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
  },
  importMedia() {
    return ipcRenderer.invoke('media:import');
  },
});
