'use strict';
/** The window's only door to the machine: a fixed list of calls, nothing else. */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('kapok', {
  init: () => ipcRenderer.invoke('app:init'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  importConfig: (file) => ipcRenderer.invoke('config:import', file),
  chooseFolder: () => ipcRenderer.invoke('folder:choose'),
  scanFolder: (folder) => ipcRenderer.invoke('folder:scan', folder),
  pathKind: (p) => ipcRenderer.invoke('path:kind', p),
  fetchServer: (url, token) => ipcRenderer.invoke('server:fetch', url, token),
  start: (opts) => ipcRenderer.invoke('upload:start', opts),
  stop: () => ipcRenderer.invoke('upload:stop'),
  prepareFaces: (url, token) => ipcRenderer.invoke('faces:prepare', url, token),
  startNode: (opts) => ipcRenderer.invoke('node:start', opts),
  stopNode: () => ipcRenderer.invoke('node:stop'),
  reveal: (file) => ipcRenderer.invoke('shell:reveal', file),
  openUrl: (url) => ipcRenderer.invoke('shell:open', url),
  // a dropped File only carries its path through Electron's own helper
  pathFor: (file) => webUtils.getPathForFile(file),
  onEvent: (cb) => {
    const listener = (_e, ev) => cb(ev);
    ipcRenderer.on('upload:event', listener);
    return () => ipcRenderer.removeListener('upload:event', listener);
  },
});
