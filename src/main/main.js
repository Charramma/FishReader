'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, protocol, globalShortcut, Menu } = require('electron');

const { ConfigStore } = require('./config');
const { ReaderWindow } = require('./window');
const library = require('./library');
const registerIpc = require('./ipc');

const SCHEME = 'book';

// 自定义协议必须在 ready 之前声明特权，否则 epub 里的图片取不到
protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: true, stream: true }
  }
]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  bootstrap();
}

function bookPathFromArgv(argv) {
  for (const arg of argv.slice(1)) {
    if (arg.startsWith('-')) continue;
    const ext = path.extname(arg).toLowerCase();
    if ((ext === '.txt' || ext === '.epub') && fs.existsSync(arg)) return path.resolve(arg);
  }
  return null;
}

function bootstrap() {
  let config = null;
  let reader = null;
  let hotkeyOk = false;

  // 无边框窗口不需要默认菜单，去掉后 Alt 系组合键不会被菜单助记键吃掉
  Menu.setApplicationMenu(null);

  const registerHotkey = (accelerator) => {
    globalShortcut.unregisterAll();
    if (!accelerator) {
      hotkeyOk = false;
      return false;
    }
    try {
      hotkeyOk = globalShortcut.register(accelerator, () => reader.toggleVisibility());
    } catch {
      hotkeyOk = false;
    }
    return hotkeyOk;
  };

  const sendBook = (win, promise) => {
    promise.then(
      (meta) => !win.isDestroyed() && win.webContents.send('book:opened', meta),
      (err) =>
        !win.isDestroyed() &&
        win.webContents.send('book:error', (err && err.message) || '打开失败')
    );
  };

  app.on('second-instance', (_event, argv) => {
    const win = reader && reader.win;
    if (win && !win.isDestroyed()) {
      if (!win.isVisible()) win.show();
      win.focus();
    }
    const target = bookPathFromArgv(argv);
    if (target && win && !win.isDestroyed()) sendBook(win, library.open(target));
  });

  app.whenReady().then(() => {
    config = new ConfigStore(app.getPath('userData'));
    reader = new ReaderWindow(config);

    protocol.handle(SCHEME, async (request) => {
      try {
        const parts = new URL(request.url).pathname.split('/').filter(Boolean);
        if (parts.length < 2) return new Response('bad request', { status: 400 });
        const bookPath = decodeURIComponent(parts[0]);
        const rel = parts.slice(1).map(decodeURIComponent).join('/');
        const found = await library.resource(bookPath, rel);
        return new Response(found.data, {
          status: 200,
          headers: { 'content-type': found.mime, 'cache-control': 'no-cache' }
        });
      } catch {
        return new Response('not found', { status: 404 });
      }
    });

    const win = reader.create();
    registerIpc({ config, reader, registerHotkey, isHotkeyOk: () => hotkeyOk });

    registerHotkey(config.get('hotkeyToggle'));

    // 从资源管理器双击txt/epub「用FishReader打开」时走这里
    const initial = bookPathFromArgv(process.argv);
    if (initial) {
      win.webContents.once('did-finish-load', () => sendBook(win, library.open(initial)));
    }
  });

  app.on('window-all-closed', () => {
    globalShortcut.unregisterAll();
    if (config) config.flush();
    app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && reader) reader.create();
  });
}
