'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

/** 只暴露渲染层需要的最小 API，路径与事件都在这一层收口 */
const api = {
  getState: () => ipcRenderer.invoke('state:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),

  openDialog: () => ipcRenderer.invoke('book:dialog'),
  openBook: (filePath) => ipcRenderer.invoke('book:open', { path: filePath }),
  openDroppedFile: (file) => {
    const real = webUtils.getPathForFile(file);
    return real ? ipcRenderer.invoke('book:drop', real) : Promise.reject(new Error('无法读取文件路径'));
  },
  readPage: (index) => ipcRenderer.invoke('book:page', index),

  saveProgress: (pageIndex, offset) => ipcRenderer.invoke('progress:save', { pageIndex, offset }),
  getProgress: (bookPath) => ipcRenderer.invoke('progress:get', bookPath),

  resizeStart: (edge) => ipcRenderer.invoke('win:resize-start', edge),
  resizeStop: () => ipcRenderer.invoke('win:resize-stop'),
  setAlwaysOnTop: (flag) => ipcRenderer.invoke('win:always-on-top', flag),
  setOpacity: (value) => ipcRenderer.invoke('win:opacity', value),
  toggleVisible: () => ipcRenderer.invoke('win:toggle-visible'),
  quit: () => ipcRenderer.invoke('app:quit'),

  on: (channel, handler) => {
    const allowed = ['book:opened', 'book:error'];
    if (!allowed.includes(channel)) return () => {};
    const listener = (_event, payload, extra) => handler(payload, extra);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  }
};

contextBridge.exposeInMainWorld('fish', api);
