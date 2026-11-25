'use strict';

const fs = require('fs');
const path = require('path');

/** 进度记录保留上限，防止用久了无限膨胀 */
const MAX_PROGRESS_ENTRIES = 60;

const DEFAULTS = {
  theme: 'dark',
  fontSize: 17,
  lineHeight: 1.9,
  opacity: 1,
  alwaysOnTop: true,
  bounds: null,
  lastBook: null,
  hotkeyToggle: 'Alt+`',
  progress: {}
};

/**
 * 极简 JSON 配置存储，直接落在 userData/config.json，
 * 免安装绿色版也只在 %APPDATA% 下留一个文件。
 */
class ConfigStore {
  constructor(userDataDir) {
    this.file = path.join(userDataDir, 'config.json');
    this.cache = { ...DEFAULTS };
    this.writeTimer = null;
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.cache = { ...DEFAULTS, ...parsed };
      this.cache.progress = { ...(parsed.progress || {}) };
      // 老版本的默认老板键要两只手，遇到未被用户改过的旧默认值就升级掉
      if (this.cache.hotkeyToggle === 'CommandOrControl+Shift+H') {
        this.cache.hotkeyToggle = DEFAULTS.hotkeyToggle;
      }
    } catch {
      this.cache = { ...DEFAULTS };
    }
  }

  get(key) {
    return this.cache[key];
  }

  getAll() {
    return JSON.parse(JSON.stringify(this.cache));
  }

  /** 合并写入，200ms 内的连续修改合并成一次落盘 */
  set(patch) {
    Object.assign(this.cache, patch);
    this.scheduleWrite();
  }

  /** 记录某本书的阅读位置（页 + 页内偏移） */
  saveProgress(bookPath, pageIndex, offset) {
    if (!bookPath) return;
    const progress = this.cache.progress;
    progress[bookPath] = { pageIndex, offset, updatedAt: Date.now() };
    const keys = Object.keys(progress);
    if (keys.length > MAX_PROGRESS_ENTRIES) {
      keys
        .sort((a, b) => progress[a].updatedAt - progress[b].updatedAt)
        .slice(0, keys.length - MAX_PROGRESS_ENTRIES)
        .forEach((k) => delete progress[k]);
    }
    this.scheduleWrite();
  }

  scheduleWrite() {
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.flush();
    }, 200);
  }

  flush() {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      // 先写临时文件再改名，避免崩溃时留下半截 JSON
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.cache, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('[config] 写入失败', err);
    }
  }
}

module.exports = { ConfigStore };
