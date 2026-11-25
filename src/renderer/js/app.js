'use strict';

(function () {
  const util = Fish.util;
  const $ = util.$;

  const els = {
    toolbar: $('toolbar'),
    scroller: $('scroller'),
    pages: $('pages'),
    phantomTop: $('phantomTop'),
    phantomBottom: $('phantomBottom'),
    empty: $('empty'),
    loading: $('loading'),
    toc: $('toc'),
    tocList: $('tocList'),
    tocCount: $('tocCount'),
    statusbar: $('statusbar'),
    chapterName: $('chapterName'),
    percent: $('percent'),
    bookTitle: $('bookTitle')
  };

  const config = {
    theme: 'dark',
    fontSize: 17,
    lineHeight: 1.9,
    opacity: 1,
    alwaysOnTop: true,
    hotkeyToggle: 'CommandOrControl+Shift+H'
  };

  let book = null;
  let started = false;
  let pendingOpened = null;

  // 主进程可能在我们启动过程中就推送了打开事件，先挂监听避免漏掉
  const offOpened = window.fish.on('book:opened', (meta) => {
    if (started) applyBook(meta);
    else pendingOpened = meta;
  });
  const offError = window.fish.on('book:error', (message) => util.toast(message || '打开失败'));

  /* ---------------- 外观 ---------------- */

  function applyTheme(theme) {
    config.theme = theme === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.theme = config.theme;
    markButton('theme', config.theme === 'light');
  }

  function applyTypography() {
    const root = document.documentElement;
    root.style.setProperty('--read-size', `${config.fontSize}px`);
    root.style.setProperty('--read-lh', String(config.lineHeight));
  }

  function markButton(act, on) {
    const btn = els.toolbar.querySelector(`[data-act="${act}"]`);
    if (btn) btn.classList.toggle('on', !!on);
  }

  function patchConfig(patch) {
    Object.assign(config, patch);
    applyTypography();
    return window.fish.setConfig(patch).then((res) => {
      if (res && res.config) Object.assign(config, res.config);
      if (res && typeof res.hotkeyOk === 'boolean' && !res.hotkeyOk) {
        util.toast('老板键被其他程序占用了');
      }
      return res;
    });
  }

  function setOpacity(value) {
    const next = util.clamp(Math.round(value * 100) / 100, 0.35, 1);
    config.opacity = next;
    return window.fish.setConfig({ opacity: next }).then(() => {
      markButton('opacity-', next < 1);
      util.toast(`透明度 ${Math.round(next * 100)}%`, 1200);
    });
  }

  function toggleOnTop() {
    config.alwaysOnTop = !config.alwaysOnTop;
    return window.fish.setConfig({ alwaysOnTop: config.alwaysOnTop }).then(() => {
      markButton('ontop', config.alwaysOnTop);
      util.toast(config.alwaysOnTop ? '已置顶' : '取消置顶', 1000);
    });
  }

  /* ---------------- 工具条 ---------------- */

  const actions = {
    open: () => pickFile(),
    toc: () => Fish.toc.toggle(),
    'toc-close': () => Fish.toc.hide(),
    theme: () => {
      const next = config.theme === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      window.fish.setConfig({ theme: next });
    },
    'font+': () => patchConfig({ fontSize: util.clamp(config.fontSize + 1, 12, 34) }),
    'font-': () => patchConfig({ fontSize: util.clamp(config.fontSize - 1, 12, 34) }),
    'line+': () => patchConfig({ lineHeight: util.clamp(round2(config.lineHeight + 0.1), 1.3, 2.6) }),
    'line-': () => patchConfig({ lineHeight: util.clamp(round2(config.lineHeight - 0.1), 1.3, 2.6) }),
    'opacity-': () => setOpacity(config.opacity <= 0.6 ? 1 : config.opacity - 0.1),
    ontop: () => toggleOnTop(),
    hide: () => window.fish.toggleVisible(),
    quit: () => window.fish.quit()
  };

  function round2(n) {
    return Math.round(n * 100) / 100;
  }

  function bindToolbar() {
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const fn = actions[btn.dataset.act];
      if (fn) {
        e.preventDefault();
        fn();
      }
    });
  }

  /* ---------------- 悬停浮现 chrome ---------------- */

  let chromeTimer = null;
  let lastPointerY = -1;

  // 工具条和状态条只在鼠标移到它们各自那一条热区里时才浮现，
  // 免得读正文时手一抖就把菜单栏晃出来。
  const CHROME_PAD = 6;

  function inChromeZone(y) {
    const top = els.toolbar.offsetHeight + CHROME_PAD;
    const bottom = window.innerHeight - els.statusbar.offsetHeight - CHROME_PAD;
    return y <= top || y >= bottom;
  }

  function showChrome() {
    document.body.classList.add('chrome-on');
    if (chromeTimer) clearTimeout(chromeTimer);
    chromeTimer = setTimeout(hideChrome, 1600);
  }

  function hideChrome() {
    if (chromeTimer) clearTimeout(chromeTimer);
    if (Fish.toc.isOpen()) return;
    if (document.body.classList.contains('resizing')) return;
    document.body.classList.remove('chrome-on');
  }

  function bindChrome() {
    window.addEventListener('mousemove', (e) => {
      lastPointerY = e.clientY;
      if (inChromeZone(e.clientY)) showChrome();
    });
    window.addEventListener('focus', () => {
      if (lastPointerY >= 0 && inChromeZone(lastPointerY)) showChrome();
    });
    document.addEventListener('mouseleave', () => {
      if (chromeTimer) clearTimeout(chromeTimer);
      chromeTimer = setTimeout(hideChrome, 400);
    });
    els.toolbar.addEventListener('mouseenter', () => {
      if (chromeTimer) clearTimeout(chromeTimer);
    });
    els.toolbar.addEventListener('mouseleave', showChrome);
    els.scroller.addEventListener('wheel', () => {
      if (document.body.classList.contains('chrome-on')) showChrome();
    });
  }

  /* ---------------- 窗口缩放 ---------------- */

  function bindResize() {
    document.querySelectorAll('.rz').forEach((zone) => {
      const edge = zone.dataset.edge;
      zone.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        try {
          zone.setPointerCapture(e.pointerId);
        } catch {
          /* 某些情况下拿不到 capture，靠 pointerup 兜底 */
        }
        document.body.classList.add('resizing');
        window.fish.resizeStart(edge);
      });
      const stop = (e) => {
        if (!document.body.classList.contains('resizing')) return;
        try {
          zone.releasePointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
        document.body.classList.remove('resizing');
        window.fish.resizeStop();
      };
      zone.addEventListener('pointerup', stop);
      zone.addEventListener('pointercancel', stop);
    });
  }

  /* ---------------- 快捷键 ---------------- */

  function bindHotkeys() {
    window.addEventListener(
      'keydown',
      (e) => {
        const key = (e.key || '').toLowerCase();
        const ctrl = e.ctrlKey || e.metaKey;

        if (key === 'escape') {
          if (Fish.toc.isOpen()) Fish.toc.hide();
          return;
        }
        if (ctrl && key === 'q') {
          e.preventDefault();
          window.fish.quit();
          return;
        }
        if (ctrl && key === 'o') {
          e.preventDefault();
          pickFile();
          return;
        }
        if (ctrl && key === 't') {
          e.preventDefault();
          Fish.toc.toggle();
          return;
        }
        if (ctrl && (key === 'arrowright' || key === 'pagedown')) {
          e.preventDefault();
          Fish.reader.nextChapter();
          return;
        }
        if (ctrl && (key === 'arrowleft' || key === 'pageup')) {
          e.preventDefault();
          Fish.reader.prevChapter();
          return;
        }
        if (ctrl && (key === '-' || key === '_')) {
          e.preventDefault();
          setOpacity(config.opacity - 0.1);
          return;
        }
        if (ctrl && (key === '=' || key === '+')) {
          e.preventDefault();
          setOpacity(config.opacity + 0.1);
          return;
        }
        if (ctrl && key === '0') {
          e.preventDefault();
          setOpacity(1);
          return;
        }
        if (ctrl || e.altKey) return;

        switch (key) {
          case 't':
            actions.theme();
            break;
          case 'p':
            toggleOnTop();
            break;
          case '+':
          case '=':
            actions['font+']();
            break;
          case '-':
          case '_':
            actions['font-']();
            break;
          case '[':
            actions['line-']();
            break;
          case ']':
            actions['line+']();
            break;
          case 'arrowdown':
            e.preventDefault();
            Fish.reader.scrollBy(64);
            break;
          case 'arrowup':
            e.preventDefault();
            Fish.reader.scrollBy(-64);
            break;
          case 'pagedown':
            e.preventDefault();
            Fish.reader.scrollBy(els.scroller.clientHeight * 0.9);
            break;
          case 'pageup':
            e.preventDefault();
            Fish.reader.scrollBy(-els.scroller.clientHeight * 0.9);
            break;
          case 'home':
            e.preventDefault();
            els.scroller.scrollTo({ top: 0 });
            break;
          case 'end':
            e.preventDefault();
            els.scroller.scrollTo({ top: els.scroller.scrollHeight });
            break;
          default:
            break;
        }
      },
      true
    );
  }

  /* ---------------- 打开文件 ---------------- */

  function pickFile() {
    return window.fish
      .openDialog()
      .then((result) => {
        if (!result || result.canceled) return null;
        return applyBook(result.meta);
      })
      .catch((err) => util.toast(err && err.message ? err.message : '打开失败'));
  }

  function bindDrop() {
    ['dragenter', 'dragover'].forEach((type) =>
      window.addEventListener(type, (e) => {
        e.preventDefault();
        document.body.classList.add('dragover');
      })
    );
    ['dragleave', 'dragend'].forEach((type) =>
      window.addEventListener(type, (e) => {
        e.preventDefault();
        document.body.classList.remove('dragover');
      })
    );
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      document.body.classList.remove('dragover');
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!file) {
        util.toast('只能拖文件进来');
        return;
      }
      window.fish
        .openDroppedFile(file)
        .then((meta) => applyBook(meta))
        .catch((err) => util.toast(err && err.message ? err.message : '无法打开这个文件'));
    });
  }

  const saveProgress = util.debounce((bookPath, page, offset) => {
    // 防抖定时器可能在切书之后才触发，按书路径校验，避免把旧书进度写进新书
    if (book && book.path === bookPath) window.fish.saveProgress(page, offset);
  }, 700);

  function applyBook(meta) {
    saveProgress.cancel();
    book = meta;
    els.empty.hidden = true;
    els.bookTitle.textContent = meta.title;
    els.loading.classList.add('on');
    Fish.toc.render(meta);
    return window.fish
      .getProgress(meta.path)
      .then((progress) => Fish.reader.restore(meta, progress))
      .then(() => {
        util.toast(`${meta.title} · ${meta.chapters.length} 章`, 1600);
      })
      .catch((err) => util.toast(err && err.message ? err.message : '读取失败'))
      .finally(() => els.loading.classList.remove('on'));
  }

  function onReaderUpdate(state) {
    if (!state || state.empty) return;
    // 换书间隙渲染层已切到新书、reader 还持有旧书，此时的状态一律丢弃
    if (!book || !Fish.reader.book || Fish.reader.book.path !== book.path) return;
    els.chapterName.textContent = state.chapterTitle || '';
    els.percent.textContent = `${state.percent}%`;
    if (state.chapter >= 0) Fish.toc.highlight(state.chapter);
    saveProgress(book.path, state.page, state.offset);
  }

  /* ---------------- 启动 ---------------- */

  function boot() {
    Fish.toc.init({ panel: els.toc, list: els.tocList, count: els.tocCount });
    Fish.reader.init({
      scroller: els.scroller,
      pages: els.pages,
      phantomTop: els.phantomTop,
      phantomBottom: els.phantomBottom
    });
    Fish.reader.onUpdater = onReaderUpdate;
    bindToolbar();
    bindChrome();
    bindResize();
    bindHotkeys();
    bindDrop();

    return window.fish
      .getState()
      .then((state) => {
        Object.assign(config, state.config || {});
        applyTheme(config.theme);
        applyTypography();
        markButton('ontop', config.alwaysOnTop);
        markButton('opacity-', config.opacity < 1);
        started = true;

        if (pendingOpened) {
          const meta = pendingOpened;
          pendingOpened = null;
          return applyBook(meta);
        }
        if (state.book) return applyBook(state.book);
        if (config.lastBook) {
          return window.fish
            .openBook(config.lastBook)
            .then((meta) => applyBook(meta))
            .catch(() => {
              els.empty.hidden = false;
            });
        }
        els.empty.hidden = false;
        return null;
      })
      .then(() => {
        showChrome();
        if (!book) els.empty.hidden = false;
      })
      .catch((err) => {
        els.empty.hidden = false;
        util.toast(err && err.message ? err.message : '初始化失败');
      });
  }

  window.addEventListener('unload', () => {
    offOpened();
    offError();
  });

  boot();
})();
