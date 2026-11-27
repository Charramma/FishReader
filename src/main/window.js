'use strict';

const { BrowserWindow, screen } = require('electron');
const path = require('path');

const MIN_WIDTH = 300;
const MIN_HEIGHT = 320;
const DEFAULT_WIDTH = 380;
const DEFAULT_HEIGHT = 560;
const SCREEN_MARGIN = 16;

const RESIZE_INTERVAL = 16;

/** 判断保存下来的窗口位置是否还落在某个显示器的工作区内（换过屏幕/分辨率时防跑飞） */
function isBoundsVisible(bounds) {
  if (!bounds) return false;
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return (
      bounds.x + bounds.width - 40 > a.x &&
      bounds.x + 40 < a.x + a.width &&
      bounds.y + bounds.height - 40 > a.y &&
      bounds.y + 40 < a.y + a.height
    );
  });
}

/** 屏幕右下角的默认位置 */
function defaultBounds() {
  const { workArea } = screen.getPrimaryDisplay();
  return {
    x: Math.round(workArea.x + workArea.width - DEFAULT_WIDTH - SCREEN_MARGIN),
    y: Math.round(workArea.y + workArea.height - DEFAULT_HEIGHT - SCREEN_MARGIN),
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT
  };
}

class ReaderWindow {
  constructor(config) {
    this.config = config;
    this.win = null;
    this.resizeTimer = null;
    this.dragTimer = null;
    this.moveTimer = null;
  }

  create() {
    const saved = this.config.get('bounds');
    const bounds = isBoundsVisible(saved) ? saved : defaultBounds();

    this.win = new BrowserWindow({
      ...bounds,
      frame: false,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      minimizable: true,
      movable: true,
      hasShadow: true,
      backgroundColor: this.config.get('theme') === 'light' ? '#fafafa' : '#141414',
      icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
      show: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
        devTools: !this.isPackaged()
      }
    });

    this.win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

    this.win.once('ready-to-show', () => {
      if (this.config.get('alwaysOnTop')) {
        this.win.setAlwaysOnTop(true, 'floating');
      }
      const opacity = this.clampOpacity(this.config.get('opacity'));
      if (opacity < 1) this.win.setOpacity(opacity);
      this.win.show();
      this.win.focus();
    });

    // 拖动、缩放结束后统一落盘窗口位置尺寸
    const persist = () => this.persistBounds();
    this.win.on('moved', persist);
    this.win.on('resized', persist);
    this.win.on('close', () => {
      this.persistBounds(true);
      this.config.flush();
    });

    return this.win;
  }

  isPackaged() {
    return require('electron').app.isPackaged;
  }

  clampOpacity(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 1;
    return Math.min(1, Math.max(0.35, n));
  }

  setOpacity(value) {
    const n = this.clampOpacity(value);
    this.win.setOpacity(n);
    this.config.set({ opacity: n });
    return n;
  }

  setAlwaysOnTop(flag) {
    const on = !!flag;
    // 关掉再开可以确保窗口重新压到最上层
    this.win.setAlwaysOnTop(false);
    if (on) this.win.setAlwaysOnTop(true, 'floating');
    this.config.set({ alwaysOnTop: on });
    return on;
  }

  /** 主题切换时同步窗口底色，避免透明区域露出错误颜色 */
  setBackgroundColor(theme) {
    if (!this.win || this.win.isDestroyed()) return;
    this.win.setBackgroundColor(theme === 'light' ? '#fafafa' : '#141414');
  }

  persistBounds(immediate = false) {
    if (immediate) {
      if (this.moveTimer) clearTimeout(this.moveTimer);
      this.moveTimer = null;
    } else if (this.moveTimer) {
      return;
    }
    const write = () => {
      this.moveTimer = null;
      if (!this.win || this.win.isDestroyed()) return;
      if (this.win.isMinimized()) return;
      const b = this.win.getBounds();
      // 最小化/异常状态下的尺寸不保存
      if (b.width < 100 || b.height < 100) return;
      this.config.set({ bounds: b });
    };
    if (immediate) write();
    else this.moveTimer = setTimeout(write, 300);
  }

  /**
   * 拖动窗口。不用 CSS 的 app-region: drag —— 那会把工具条变成系统标题栏，
   * 鼠标在上面收不到 mousemove，悬停显示/隐藏就会来回抖。
   * 这里和缩放一样轮询光标位置，网页事件保持完整。
   */
  startDrag() {
    this.stopDrag();
    if (!this.win) return;
    const origin = screen.getCursorScreenPoint();
    const start = this.win.getBounds();
    let last = { x: start.x, y: start.y };

    this.dragTimer = setInterval(() => {
      const cur = screen.getCursorScreenPoint();
      const next = { x: start.x + (cur.x - origin.x), y: start.y + (cur.y - origin.y) };
      if (next.x === last.x && next.y === last.y) return;
      last = next;
      this.win.setPosition(next.x, next.y);
    }, RESIZE_INTERVAL);
  }

  stopDrag() {
    if (this.dragTimer) {
      clearInterval(this.dragTimer);
      this.dragTimer = null;
    }
  }

  startResize(edge) {
    this.stopResize();
    if (!this.win) return;
    const start = this.win.getBounds();
    const origin = screen.getCursorScreenPoint();
    let last = { ...start };

    this.resizeTimer = setInterval(() => {
      const cur = screen.getCursorScreenPoint();
      const dx = cur.x - origin.x;
      const dy = cur.y - origin.y;
      const next = { ...start };

      if (edge.includes('e')) next.width = start.width + dx;
      if (edge.includes('s')) next.height = start.height + dy;
      if (edge.includes('w')) {
        next.width = start.width - dx;
        next.x = start.x + dx;
      }
      if (edge.includes('n')) {
        next.height = start.height - dy;
        next.y = start.y + dy;
      }

      // 超出最小尺寸时回推窗口原点，保证被拖的那条边跟手
      if (next.width < MIN_WIDTH) {
        if (edge.includes('w')) next.x -= MIN_WIDTH - next.width;
        next.width = MIN_WIDTH;
      }
      if (next.height < MIN_HEIGHT) {
        if (edge.includes('n')) next.y -= MIN_HEIGHT - next.height;
        next.height = MIN_HEIGHT;
      }

      if (
        next.x === last.x &&
        next.y === last.y &&
        next.width === last.width &&
        next.height === last.height
      ) {
        return;
      }
      last = next;
      this.win.setBounds(next);
    }, RESIZE_INTERVAL);
  }

  stopResize() {
    if (this.resizeTimer) {
      clearInterval(this.resizeTimer);
      this.resizeTimer = null;
    }
  }

  /** 老板键：在当前状态与隐藏之间切换 */
  toggleVisibility() {
    if (!this.win) return false;
    if (this.win.isVisible()) {
      this.win.hide();
      return false;
    }
    this.win.show();
    // 隐藏后再唤回时补一次置顶，避免被其他窗口盖住
    if (this.config.get('alwaysOnTop')) {
      this.win.setAlwaysOnTop(false);
      this.win.setAlwaysOnTop(true, 'floating');
    }
    this.win.focus();
    return true;
  }

  showFilePicker() {
    const { dialog } = require('electron');
    return dialog.showOpenDialog(this.win, {
      title: '打开小说文件',
      properties: ['openFile'],
      filters: [{ name: '小说文件', extensions: ['txt', 'epub'] }]
    });
  }
}

module.exports = { ReaderWindow };
