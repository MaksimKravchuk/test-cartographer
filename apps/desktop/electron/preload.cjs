// The only bridge from the page to the app: the native folder picker. The GUI
// falls back to its own folder browser when this isn't there (a web browser).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cartographer', {
  pickFolder: (start) => ipcRenderer.invoke('pick-folder', start),
});
