'use strict';

window.Fish = window.Fish || {};

/**
 * 连续滚动的阅读引擎。
 * pages 只保留当前窗口内的渲染单元，被移出的用 phantomTop / phantomBottom 占位，
 * 因此往回滚时可以按记录过的高度把页重新插回来，位置不会跳。
 */
Fish.reader = (() => {
  const util = Fish.util;

  let book = null;
  /** { byPage: Map<pageIndex, Chapter[]>, pages: number[] } 按页索引章节，避免每帧线性扫描 */
  let chapterIndexMap = null;
  let scroller = null;
  let pagesEl = null;
  let phantomTopEl = null;
  let phantomBottomEl = null;

  const loaded = new Map();
  const heights = new Map();
  const inflight = new Map();

  let first = 0;
  let last = -1;
  let phantomTop = 0;
  let phantomBottom = 0;
  let current = 0;
  let refreshing = false;
  let rerun = false;
  /** 每次换书自增，用来作废旧书仍在途的页面请求 */
  let generation = 0;

  // 距视口超过这些倍数（屏）的已渲染页会被移出 DOM，只保留占位高度
  const TRIM_ABOVE_VH = 6;
  const TRIM_BELOW_VH = 10;
  const PREFETCH = 1.2;

  const onUpdate = { fn: () => {} };

  function init(nodes) {
    scroller = nodes.scroller;
    pagesEl = nodes.pages;
    phantomTopEl = nodes.phantomTop;
    phantomBottomEl = nodes.phantomBottom;
    // 只创建一个 rAF 包装，保证连续滚动事件合并成一帧一次刷新
    const scheduleRefresh = util.raf(refresh);
    scroller.addEventListener('scroll', scheduleRefresh);
  }

  function reset() {
    pagesEl.textContent = '';
    loaded.clear();
    heights.clear();
    inflight.clear();
    phantomTop = 0;
    phantomBottom = 0;
    first = 0;
    last = -1;
    current = 0;
    applyPhantoms();
  }

  function applyPhantoms() {
    phantomTopEl.style.height = `${phantomTop}px`;
    phantomBottomEl.style.height = `${phantomBottom}px`;
  }

  function labelFor(index) {
    const bucket = chapterIndexMap && chapterIndexMap.byPage.get(index);
    if (bucket && bucket.length) return bucket[0].title;
    if (book.type === 'txt') return `第 ${index + 1} 段`;
    return (book.pageLabels && book.pageLabels[index]) || '';
  }

  function buildTxtPage(index, payload) {
    const section = document.createElement('section');
    section.className = 'page txt';
    section.dataset.index = String(index);
    section.id = `page-${index}`;

    const title = document.createElement('h2');
    title.className = 'page-title';
    title.textContent = labelFor(index);
    section.appendChild(title);

    for (const text of payload.paragraphs) {
      const p = document.createElement('p');
      p.textContent = text;
      section.appendChild(p);
    }
    if (!payload.paragraphs.length) {
      const p = document.createElement('p');
      p.className = 'noind';
      p.textContent = '（本章无正文）';
      section.appendChild(p);
    }
    return section;
  }

  function buildEpubPage(index, payload) {
    const section = document.createElement('section');
    section.className = 'page epub';
    section.dataset.index = String(index);
    section.id = `page-${index}`;

    const frag = Fish.epubView.build(payload.html, book.path, payload.doc);
    const hasHeading = !!frag.querySelector('h1,h2,h3,h4,h5,h6');
    const label = labelFor(index);
    if (!hasHeading && label) {
      const title = document.createElement('h2');
      title.className = 'page-title';
      title.textContent = label;
      section.appendChild(title);
    }
    section.appendChild(frag);
    return section;
  }

  function load(index) {
    if (loaded.has(index)) return Promise.resolve(loaded.get(index));
    if (inflight.has(index)) return inflight.get(index);

    const gen = generation;
    const task = window.fish
      .readPage(index)
      .then((payload) => {
        if (gen !== generation) return null; // 已换书，旧书的响应直接丢弃
        inflight.delete(index);
        const el =
          payload.kind === 'txt' ? buildTxtPage(index, payload) : buildEpubPage(index, payload);
        return { el, index };
      })
      .catch((err) => {
        if (gen !== generation) return null;
        inflight.delete(index);
        throw err;
      });

    inflight.set(
      index,
      task.then((res) => {
        if (!res) return null;
        const { el, index: i } = res;
        if (!loaded.has(i)) appendAtEnd(i, el);
        return loaded.get(i) || el;
      })
    );
    return inflight.get(index);
  }

  function appendAtEnd(index, el) {
    if (loaded.has(index)) return;
    if (index === last + 1) {
      push(index, el);
      return;
    }
    if (index === first - 1) {
      prepend(index, el);
      return;
    }
    // 窗口之外的页（跳转后仍在途的旧请求）直接丢弃
  }

  function prepend(index, el) {
    const known = heights.get(index) || 0;
    phantomTop -= known;
    pagesEl.insertBefore(el, pagesEl.firstChild || null);
    loaded.set(index, el);
    first = index;
    const h = el.offsetHeight;
    heights.set(index, h);
    scroller.scrollTop += h - known;
    applyPhantoms();
  }

  function push(index, el) {
    phantomBottom -= heights.get(index) || 0;
    pagesEl.appendChild(el);
    loaded.set(index, el);
    last = index;
    if (first > last) first = index;
    applyPhantoms();
    heights.set(index, el.offsetHeight);
  }

  function removeAbove() {
    const el = loaded.get(first);
    if (!el) return false;
    const h = el.offsetHeight;
    heights.set(first, h);
    el.remove();
    loaded.delete(first);
    phantomTop += h;
    scroller.scrollTop = Math.max(0, scroller.scrollTop - h);
    first += 1;
    applyPhantoms();
    return true;
  }

  function removeBelow() {
    const el = loaded.get(last);
    if (!el) return false;
    const h = el.offsetHeight;
    heights.set(last, h);
    el.remove();
    loaded.delete(last);
    phantomBottom += h;
    last -= 1;
    applyPhantoms();
    return true;
  }

  function topOf(el) {
    return el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
  }

  async function refresh() {
    if (refreshing) {
      rerun = true;
      return;
    }
    if (!book) return;
    refreshing = true;

    try {
      let guard = 0;
      while (guard++ < 40) {
        const vh = scroller.clientHeight || 1;
        const top = scroller.scrollTop;

        if (last < book.pageCount - 1) {
          const tail = loaded.get(last);
          const bottom = tail ? topOf(tail) + tail.offsetHeight : top;
          if (bottom - (top + vh) < vh * PREFETCH) {
            await loadSafe(last + 1);
            continue;
          }
        }

        if (first > 0) {
          const head = loaded.get(first);
          const headTop = head ? topOf(head) : 0;
          if (top - headTop < vh * 0.6) {
            await loadSafe(first - 1);
            continue;
          }
        }

        break;
      }

      let guardB = 0;
      while (first < last && guardB++ < 60) {
        const vh = scroller.clientHeight || 1;
        const head = loaded.get(first);
        if (!head) break;
        if (topOf(head) + head.offsetHeight < scroller.scrollTop - vh * TRIM_ABOVE_VH) {
          if (!removeAbove()) break;
        } else break;
      }

      let guardC = 0;
      while (first < last && guardC++ < 60) {
        const vh = scroller.clientHeight || 1;
        const tail = loaded.get(last);
        if (!tail) break;
        if (topOf(tail) > scroller.scrollTop + vh * TRIM_BELOW_VH) {
          if (!removeBelow()) break;
        } else break;
      }

      updateCurrent();
      onUpdate.fn(state());
    } finally {
      refreshing = false;
      if (rerun) {
        rerun = false;
        refresh();
      }
    }
  }

  async function loadSafe(index) {
    try {
      const el = await load(index);
      if (el && !loaded.has(index)) appendAtEnd(index, el);
      return el;
    } catch (err) {
      util.toast(err && err.message ? err.message : '章节读取失败');
      // 失败时把游标推过去，避免死循环重试
      if (index === last + 1) last = index;
      if (index === first - 1) first = index;
      return null;
    }
  }

  function updateCurrent() {
    if (!book) return;
    const y = scroller.scrollTop + 30;
    let best = first;
    loaded.forEach((el, i) => {
      if (i > best && topOf(el) <= y) best = i;
    });
    current = util.clamp(best, 0, book.pageCount - 1);
  }

  function buildChapterIndex() {
    const byPage = new Map();
    const pages = [];
    for (const c of book.chapters) {
      const bucket = byPage.get(c.pageIndex);
      if (bucket) bucket.push(c);
      else {
        byPage.set(c.pageIndex, [c]);
        pages.push(c.pageIndex);
      }
    }
    pages.sort((a, b) => a - b);
    chapterIndexMap = { byPage, pages };
  }

  function chapterIndex() {
    if (!book || !chapterIndexMap) return -1;
    const page = current;
    const el = loaded.get(page);
    const pageTop = el ? topOf(el) : scroller.scrollTop;
    const y = scroller.scrollTop;
    const pages = chapterIndexMap.pages;

    // 二分定位最后一个 pageIndex < page 的页，它的最后一条章节就是兜底值
    let before = -1;
    let lo = 0;
    let hi = pages.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (pages[mid] < page) {
        before = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    let res = -1;
    if (before >= 0) {
      const prev = chapterIndexMap.byPage.get(pages[before]);
      res = prev[prev.length - 1].index;
    }

    // 当前页上的章节（含锚点）才需要判断是否真的滚过了
    const same = chapterIndexMap.byPage.get(page);
    if (!same) return res;
    for (const c of same) {
      let top = pageTop;
      if (c.anchor && el) {
        const target = el.querySelector(`[id="${cssEscape(c.anchor)}"]`);
        if (target) top = topOf(target);
      }
      if (res === -1 || top - 40 <= y) res = c.index;
      if (top - 40 > y) break;
    }
    return res;
  }

  function cssEscape(value) {
    return String(value).replace(/["\\]/g, '\\$&');
  }

  function state() {
    if (!book) return { empty: true };
    const ch = chapterIndex();
    return {
      empty: false,
      page: current,
      pageCount: book.pageCount,
      chapter: ch,
      chapterTitle: ch >= 0 ? book.chapters[ch].title : labelFor(current),
      percent: Math.round(((current + 1) / book.pageCount) * 100),
      offset: (() => {
        const el = loaded.get(current);
        return el ? Math.max(0, Math.round(scroller.scrollTop - topOf(el))) : 0;
      })()
    };
  }

  /** 先把目标页前后各一页装上，否则内容不足时 scrollTop 会被浏览器夹回 0 */
  async function fillAround(target) {
    if (target > 0) await loadSafe(target - 1);
    if (target < book.pageCount - 1) await loadSafe(target + 1);
  }

  async function jump(pageIndex, anchor, offset) {
    if (!book) return;
    const target = util.clamp(pageIndex, 0, book.pageCount - 1);
    reset();
    // 标记成空窗口，让 appendAtEnd 把目标页当成「下一页」接进去
    first = target;
    last = target - 1;
    const el = await loadSafe(target);
    const node = (el && loaded.get(target)) || null;
    if (!node) return;
    await fillAround(target);
    const page = loaded.get(target);
    if (!page) return;
    let y = topOf(page);
    const found = anchor ? page.querySelector(`[id="${cssEscape(anchor)}"]`) : null;
    if (found) y = topOf(found);
    scroller.scrollTop = Math.max(0, y + (offset || 0));
    await refresh();
  }

  const api = {
    init,
    get book() {
      return book;
    },
    set onUpdater(fn) {
      onUpdate.fn = fn;
    },
    async restore(meta, progress) {
      generation += 1;
      book = meta;
      buildChapterIndex();
      reset();
      const page = progress
        ? Number(progress.pageIndex != null ? progress.pageIndex : progress.chapter) || 0
        : meta.startPage || 0;
      const offset = progress ? Number(progress.offset) || 0 : 0;
      await jump(page, '', offset);
    },
    gotoChapter(index) {
      if (!book) return Promise.resolve();
      const c = book.chapters[index];
      if (!c) return Promise.resolve();
      return jump(c.pageIndex, c.anchor, 0);
    },
    nextChapter() {
      if (!book) return Promise.resolve();
      const cur = chapterIndex();
      const next = book.chapters.find((c) => c.index > cur);
      return next ? api.gotoChapter(next.index) : Promise.resolve();
    },
    prevChapter() {
      if (!book) return Promise.resolve();
      const cur = chapterIndex();
      const prev = [...book.chapters].reverse().find((c) => c.index < cur);
      return prev ? api.gotoChapter(prev.index) : Promise.resolve();
    },
    scrollBy(px) {
      scroller.scrollBy({ top: px, behavior: 'auto' });
    },
    refresh
  };

  return api;
})();
