'use strict';
/** The window's only door to the machine: a fixed list of calls, nothing else. */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('kapok', {
  init: () => ipcRenderer.invoke('app:init'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  importConfig: (file) => ipcRenderer.invoke('config:import', file),
  pasteConfig: (text) => ipcRenderer.invoke('config:paste', text),
  copyConfig: (conf) => ipcRenderer.invoke('config:copy', conf),
  exportConfig: (conf) => ipcRenderer.invoke('config:export', conf),
  chooseFolder: () => ipcRenderer.invoke('folder:choose'),
  scanFolder: (folder, skip) => ipcRenderer.invoke('folder:scan', folder, skip),
  pathKind: (p) => ipcRenderer.invoke('path:kind', p),
  fetchServer: (url, token) => ipcRenderer.invoke('server:fetch', url, token),
  createAlbum: (url, token, name) => ipcRenderer.invoke('album:create', url, token, name),
  renameAlbum: (url, token, id, name) => ipcRenderer.invoke('album:rename', url, token, id, name),
  deleteAlbum: (url, token, id) => ipcRenderer.invoke('album:delete', url, token, id),
  deletePhotos: (url, token, ids) => ipcRenderer.invoke('photos:delete', url, token, ids),
  listPhotos: (url, token, query) => ipcRenderer.invoke('photos:list', url, token, query),
  movePhotos: (url, token, ids, album) => ipcRenderer.invoke('photos:move', url, token, ids, album),
  start: (opts) => ipcRenderer.invoke('upload:start', opts),
  stop: () => ipcRenderer.invoke('upload:stop'),
  prepareFaces: (url, token) => ipcRenderer.invoke('faces:prepare', url, token),
  startNode: (opts) => ipcRenderer.invoke('node:start', opts),
  stopNode: () => ipcRenderer.invoke('node:stop'),
  reveal: (file) => ipcRenderer.invoke('shell:reveal', file),
  openFile: (file) => ipcRenderer.invoke('shell:openFile', file),
  preview: (file) => ipcRenderer.invoke('photo:preview', file),
  faceCrops: (file, boxes, w, h) => ipcRenderer.invoke('photo:faces', file, boxes, w, h),
  openUrl: (url) => ipcRenderer.invoke('shell:open', url),
  // a dropped File only carries its path through Electron's own helper
  pathFor: (file) => webUtils.getPathForFile(file),
  onEvent: (cb) => {
    const listener = (_e, ev) => cb(ev);
    ipcRenderer.on('upload:event', listener);
    return () => ipcRenderer.removeListener('upload:event', listener);
  },
});
