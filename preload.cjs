// preload.cjs — Electron 安全桥接脚本
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  setTitleBarTheme: (theme) => {
    ipcRenderer.send('set-title-bar-theme', theme);
  },
  openFolder: (folderPath) => {
    return ipcRenderer.invoke('open-folder', folderPath);
  },
  selectFolder: (defaultPath) => {
    return ipcRenderer.invoke('select-folder', defaultPath);
  },
  windowMinimize: () => {
    ipcRenderer.send('window-minimize');
  },
  windowMaximize: () => {
    ipcRenderer.send('window-maximize');
  },
  windowClose: () => {
    ipcRenderer.send('window-close');
  },
  windowIsMaximized: () => {
    return ipcRenderer.invoke('window-is-maximized');
  },
  onWindowMaximizeChanged: (callback) => {
    ipcRenderer.on('window-maximize-changed', (event, isMaximized) => {
      callback(isMaximized);
    });
  }
});
