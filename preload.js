'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Catalog / detail / playback
  fetchCatalog: (pathName) => ipcRenderer.invoke('catalog:fetch', pathName),
  fetchDetail: (item) => ipcRenderer.invoke('detail:fetch', item),
  resolvePlayTarget: (episode) => ipcRenderer.invoke('play:resolve', episode),

  // Settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (partial) => ipcRenderer.invoke('settings:set', partial),
  saveRecentWatch: (item) => ipcRenderer.invoke('settings:recent-save', item),
  clearRecentWatches: () => ipcRenderer.invoke('settings:recent-clear'),
  clearCache: () => ipcRenderer.invoke('cache:clear'),

  // App
  getVersion: () => ipcRenderer.invoke('app:version'),
  getProxyBase: () => ipcRenderer.invoke('proxy:base'),
  checkUpdate: (source) => ipcRenderer.invoke('update:check', source),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),

  // m3u8 capture events
  onM3u8Captured: (callback) => {
    ipcRenderer.on('m3u8:captured', (_event, payload) => callback(payload));
  },
});
