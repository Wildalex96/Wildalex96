const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('localmind', {
  chat: (payload) => ipcRenderer.invoke('chat', payload),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (value) => ipcRenderer.invoke('settings:set', value),
  getMemory: () => ipcRenderer.invoke('memory:get'),
  clearMemory: () => ipcRenderer.invoke('memory:clear'),
  test: () => ipcRenderer.invoke('test'),
  bootstrapStatus: () => ipcRenderer.invoke('bootstrap:status'),
  startBootstrap: () => ipcRenderer.invoke('bootstrap:start'),
  onBootstrapProgress: (callback) => ipcRenderer.on('bootstrap:progress', (_, message) => callback(message))
});
