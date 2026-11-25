'use strict';

window.Fish = window.Fish || {};

/** 目录抽屉：虚拟列表渲染章节、点击跳转、跟随滚动高亮 */
Fish.toc = (() => {
  // 视口外多渲染几行，滚动时减少白屏
  const OVERSCAN = 8;

  let panel = null;
  let list = null;
  let countEl = null;
  let book = null;
  let current = -1;

  let chapters = [];
  let rowH = 0;
  let bodyEl = null;
  let winEl = null;
  let winStart = -1;
  let winEnd = -1;
  let winCurrent = -2;
  let scrollQueued = false;

  function init(nodes_) {
    panel = nodes_.panel;
    list = nodes_.list;
    countEl = nodes_.count;
    list.addEventListener('click', (e) => {
      const item = e.target.closest('[data-ch]');
      if (!item) return;
      const index = Number(item.dataset.ch);
      if (!Number.isFinite(index)) return;
      Fish.reader.gotoChapter(index).then(() => hide());
    });
    list.addEventListener('scroll', () => {
      if (scrollQueued) return;
      scrollQueued = true;
      requestAnimationFrame(() => {
        scrollQueued = false;
        renderWindow();
      });
    });
    // 抽屉本身要吃掉滚轮，避免穿透到底下正文
    panel.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
  }

  /** 行高只由 CSS 决定，量一次即可（虚拟列表按等高行计算位置） */
  function measureRowHeight() {
    const probe = document.createElement('button');
    probe.type = 'button';
    probe.className = 'toc-item';
    probe.textContent = '测';
    winEl.appendChild(probe);
    const h = probe.offsetHeight;
    probe.remove();
    return h || 30;
  }

  /** bodyEl 顶部在滚动容器内容坐标系中的位置（含列表 padding） */
  function bodyOffset() {
    return bodyEl.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
  }

  /** 只渲染视口附近的行，几万章的目录也不会一次建出全部 DOM */
  function renderWindow() {
    if (!book || !chapters.length) return;
    if (!rowH) rowH = measureRowHeight();
    const vh = list.clientHeight || 1;
    const top = list.scrollTop - bodyOffset();
    const start = Math.max(0, Math.floor(top / rowH) - OVERSCAN);
    const end = Math.min(chapters.length, Math.ceil((top + vh) / rowH) + OVERSCAN);
    bodyEl.style.height = `${chapters.length * rowH}px`;
    winEl.style.top = `${start * rowH}px`;
    if (start === winStart && end === winEnd && current === winCurrent) return;
    winStart = start;
    winEnd = end;
    winCurrent = current;

    const frag = document.createDocumentFragment();
    for (let i = start; i < end; i += 1) {
      const c = chapters[i];
      const btn = document.createElement('button');
      btn.className = 'toc-item' + (c.index === current ? ' cur' : '');
      btn.type = 'button';
      btn.dataset.ch = String(c.index);
      btn.dataset.depth = String(Math.min(3, c.depth || 0));
      btn.textContent = c.title;
      btn.title = c.title;
      frag.appendChild(btn);
    }
    winEl.textContent = '';
    winEl.appendChild(frag);
  }

  function render(meta) {
    book = meta;
    chapters = meta ? meta.chapters : [];
    current = -1;
    rowH = 0;
    winStart = -1;
    winEnd = -1;
    winCurrent = -2;
    list.textContent = '';
    if (!meta) {
      countEl.textContent = '目录';
      return;
    }
    countEl.textContent = `目录 · ${meta.chapters.length} 项`;

    bodyEl = document.createElement('div');
    bodyEl.className = 'toc-body';
    winEl = document.createElement('div');
    winEl.className = 'toc-win';
    bodyEl.appendChild(winEl);
    list.appendChild(bodyEl);

    renderWindow();
  }

  function highlight(index) {
    if (!book || index === current) return;
    current = index;
    renderWindow();
    if (panel.classList.contains('on')) scrollCurrentIntoView();
  }

  function scrollCurrentIntoView() {
    if (current < 0 || !rowH) return;
    const top = bodyOffset() + current * rowH;
    const bottom = top + rowH;
    if (top < list.scrollTop || bottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = Math.max(0, top - list.clientHeight / 2 + rowH);
      renderWindow();
    }
  }

  function show() {
    if (!book) return;
    panel.classList.add('on');
    panel.setAttribute('aria-hidden', 'false');
    if (current >= 0 && rowH) {
      list.scrollTop = Math.max(0, bodyOffset() + current * rowH - list.clientHeight / 3);
    }
    renderWindow();
  }

  function hide() {
    panel.classList.remove('on');
    panel.setAttribute('aria-hidden', 'true');
  }

  function toggle() {
    if (panel.classList.contains('on')) hide();
    else show();
  }

  return {
    init,
    render,
    highlight,
    show,
    hide,
    toggle,
    isOpen: () => !!panel && panel.classList.contains('on')
  };
})();
