const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('frameedit', {
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
  },
  importMedia() {
    return ipcRenderer.invoke('media:import');
  },
  importPaths(filePaths) {
    return ipcRenderer.invoke('media:import-paths', filePaths);
  },
  pathForFile(file) {
    return webUtils.getPathForFile(file);
  },
  saveProject(payload) {
    return ipcRenderer.invoke('project:save', payload);
  },
  openProject() {
    return ipcRenderer.invoke('project:open');
  },
  lastProject() {
    return ipcRenderer.invoke('project:last');
  },
  exportProject(payload) {
    return ipcRenderer.invoke('export:start', payload);
  },
  cancelExport() {
    return ipcRenderer.invoke('export:cancel');
  },
  onExportProgress(callback) {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('export:progress', listener);
    return () => ipcRenderer.removeListener('export:progress', listener);
  },
});
