'use strict';

window.Fish = window.Fish || {};

Fish.util = {
  $: (id) => document.getElementById(id),

  debounce(fn, wait) {
    let timer = null;
    const wrapped = (...args) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        fn(...args);
      }, wait);
    };
    wrapped.cancel = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    wrapped.flush = (...args) => {
      wrapped.cancel();
      fn(...args);
    };
    return wrapped;
  },

  raf(fn) {
    let queued = false;
    return (...args) => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        fn(...args);
      });
    };
  },

  clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
  },

  dir(p) {
    const i = p.lastIndexOf('/');
    return i === -1 ? '' : p.slice(0, i);
  },

  /** 相对路径解析成 zip 内路径，处理 ./ 与 ../ */
  resolve(rel, baseDir) {
    let clean = String(rel).split('#')[0].split('?')[0];
    try {
      clean = decodeURIComponent(clean);
    } catch {
      /* 已解码的路径直接用 */
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(clean) || clean.startsWith('/')) return clean;
    const stack = (baseDir ? baseDir.split('/') : []).concat(clean.split('/'));
    const out = [];
    for (const seg of stack) {
      if (!seg || seg === '.') continue;
      if (seg === '..') out.pop();
      else out.push(seg);
    }
    return out.join('/');
  },

  /** book://fishreader/<书路径>/<资源路径>，主机名固定避免大小写被改写 */
  resourceUrl(bookPath, zipPath) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(zipPath)) return zipPath;
    const head = encodeURIComponent(bookPath);
    const tail = String(zipPath)
      .split('/')
      .map((s) => encodeURIComponent(s))
      .join('/');
    return `book://fishreader/${head}/${tail}`;
  },

  isCjk(ch) {
    if (!ch) return false;
    const c = ch.codePointAt(0);
    return (
      (c >= 0x2e80 && c <= 0x9fff) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0x3000 && c <= 0x303f)
    );
  },

  toastTimer: null,
  toast(text, ms = 2200) {
    const el = Fish.util.$('toast');
    if (!el) return;
    el.textContent = text;
    el.classList.add('on');
    if (Fish.util.toastTimer) clearTimeout(Fish.util.toastTimer);
    Fish.util.toastTimer = setTimeout(() => el.classList.remove('on'), ms);
  }
};
