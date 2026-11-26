'use strict';

const path = require('path');
const { ipcMain } = require('electron');
const library = require('./library');

const WRITABLE_KEYS = [
  'theme',
  'fontSize',
  'lineHeight',
  'opacity',
  'alwaysOnTop',
  'hotkeyToggle'
];

module.exports = function registerIpc({ config, reader, registerHotkey, isHotkeyOk }) {
  const view = () => reader.win;

  ipcMain.handle('state:get', () => ({
    config: config.getAll(),
    book: library.currentBook() ? library.metaOf(library.currentBook()) : null,
    hotkeyOk: isHotkeyOk(),
    bounds: view() ? view().getBounds() : null
  }));

  ipcMain.handle('config:set', (_event, patch) => {
    const safe = {};
    for (const key of WRITABLE_KEYS) {
      if (patch && Object.prototype.hasOwnProperty.call(patch, key)) safe[key] = patch[key];
    }
    if (Object.keys(safe).length) config.set(safe);

    if ('theme' in safe) reader.setBackgroundColor(safe.theme === 'light' ? 'light' : 'dark');
    if ('opacity' in safe) safe.opacity = reader.setOpacity(safe.opacity);
    if ('alwaysOnTop' in safe) safe.alwaysOnTop = reader.setAlwaysOnTop(safe.alwaysOnTop);
    if ('hotkeyToggle' in safe) {
      const ok = registerHotkey(safe.hotkeyToggle);
      return { config: config.getAll(), hotkeyOk: ok };
    }
    return { config: config.getAll(), hotkeyOk: isHotkeyOk() };
  });

  ipcMain.handle('book:open', async (_event, target) => {
    const file = typeof target === 'string' ? target : target && target.path;
    if (!file) throw new Error('没有指定文件');
    const meta = await library.open(file);
    config.set({ lastBook: meta.path });
    reader.persistBounds();
    if (view() && !view().isDestroyed()) view().show();
    return meta;
  });

  ipcMain.handle('book:dialog', async () => {
    const result = await reader.showFilePicker();
    if (result.canceled || !result.filePaths.length) return { canceled: true };
    const meta = await library.open(result.filePaths[0]);
    config.set({ lastBook: meta.path });
    return { canceled: false, meta };
  });

  ipcMain.handle('book:page', (_event, index) => library.readPage(Number(index)));

  ipcMain.handle('progress:save', (_event, payload) => {
    const book = library.currentBook();
    if (!book || !payload) return false;
    config.saveProgress(book.path, Number(payload.pageIndex) || 0, Number(payload.offset) || 0);
    return true;
  });

  ipcMain.handle('progress:get', (_event, bookPath) => {
    const all = config.get('progress') || {};
    return all[bookPath] || null;
  });

  ipcMain.handle('win:resize-start', (_event, edge) => reader.startResize(String(edge || '')));
  ipcMain.handle('win:resize-stop', () => reader.stopResize());
  ipcMain.handle('win:drag-start', () => reader.startDrag());
  ipcMain.handle('win:drag-stop', () => reader.stopDrag());
  ipcMain.handle('win:always-on-top', (_event, flag) => reader.setAlwaysOnTop(flag));
  ipcMain.handle('win:opacity', (_event, value) => reader.setOpacity(value));
  ipcMain.handle('win:toggle-visible', () => reader.toggleVisibility());
  ipcMain.handle('app:quit', () => {
    if (view() && !view().isDestroyed()) view().close();
    else require('electron').app.quit();
  });

  // 拖进来的文件在 preload 里已经换成绝对路径，这里只做扩展名校验
  ipcMain.handle('book:drop', async (_event, file) => {
    const ext = path.extname(String(file || '')).toLowerCase();
    if (ext !== '.txt' && ext !== '.epub') throw new Error(`不支持 ${ext || '该'} 文件`);
    const meta = await library.open(file);
    config.set({ lastBook: meta.path });
    return meta;
  });
};
