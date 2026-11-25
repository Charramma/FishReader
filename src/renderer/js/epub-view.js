'use strict';

window.Fish = window.Fish || {};

/**
 * epub 的 XHTML 一律不直接插入：用 DOMParser 解析后按白名单重建，
 * 丢掉所有脚本、样式、href，图片改走 book:// 协议从 zip 里取。
 */
Fish.epubView = (() => {
  const DROP = new Set([
    'script', 'style', 'link', 'meta', 'head', 'title', 'base', 'noscript', 'template', 'slot',
    'iframe', 'object', 'embed', 'applet', 'form', 'input', 'button', 'select', 'textarea',
    'option', 'optgroup', 'fieldset', 'legend', 'label', 'svg', 'math', 'video', 'audio',
    'source', 'track', 'canvas', 'map', 'area', 'nav', 'menu'
  ]);

  const BLOCK = new Set([
    'p', 'div', 'section', 'article', 'main', 'header', 'footer', 'aside', 'address',
    'figure', 'figcaption', 'blockquote', 'pre', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'table', 'thead', 'tbody', 'tfoot',
    'tr', 'td', 'th', 'caption', 'colgroup'
  ]);

  const INLINE = new Set([
    'span', 'em', 'strong', 'i', 'b', 'u', 's', 'small', 'big', 'sub', 'sup', 'code',
    'kbd', 'samp', 'var', 'cite', 'q', 'abbr', 'mark', 'time', 'font', 'tt', 'nobr', 'a'
  ]);

  const INLINE_MAP = {
    i: 'em',
    b: 'strong',
    strike: 's',
    del: 's',
    ins: 'u',
    big: 'span',
    tt: 'span',
    font: 'span',
    nobr: 'span',
    a: 'span',
    q: 'span',
    cite: 'span',
    abbr: 'span',
    time: 'span'
  };

  const BLOCK_MAP = {
    div: 'div',
    p: 'p',
    section: 'div',
    article: 'div',
    main: 'div',
    header: 'div',
    footer: 'div',
    aside: 'div',
    address: 'div',
    figure: 'div',
    figcaption: 'p',
    blockquote: 'blockquote',
    pre: 'pre',
    li: 'p',
    dl: 'div',
    dt: 'p',
    dd: 'p',
    table: 'div',
    thead: 'div',
    tbody: 'div',
    tfoot: 'div',
    tr: 'div',
    td: 'span',
    th: 'span',
    caption: 'p',
    colgroup: 'div'
  };

  // HTML5 允许 id 以数字开头，这里只排除选择器/属性里会出问题的字符
  const ID_OK = /^\w[\w:.-]{0,63}$/;

  function cleanText(value) {
    return value.replace(/[\t\r\n\f ]+/g, ' ');
  }

  function build(htmlText, bookPath, docPath) {
    const parsed = new DOMParser().parseFromString(htmlText, 'text/html');
    const source = parsed.body || parsed.documentElement;
    const baseDir = Fish.util.dir(docPath || '');
    const frag = document.createDocumentFragment();

    const ctx = { target: frag, block: null };

    const append = (el) => {
      ctx.target.appendChild(el);
      return el;
    };

    const ensurePara = () => {
      if (!ctx.block) ctx.block = append(document.createElement('p'));
      return ctx.block;
    };

    const takeId = (el, from) => {
      const id = from && typeof from.getAttribute === 'function' ? from.getAttribute('id') : '';
      if (id && ID_OK.test(id) && !el.id) el.id = id;
    };

    const addImage = (host, node) => {
      const raw =
        node.getAttribute('src') ||
        node.getAttribute('xlink:href') ||
        node.getAttribute('data-src') ||
        '';
      if (!raw) return;
      const img = document.createElement('img');
      if (/^(data:|https?:)/i.test(raw)) {
        img.src = raw;
      } else {
        img.src = Fish.util.resourceUrl(bookPath, Fish.util.resolve(raw, baseDir));
      }
      img.alt = node.getAttribute('alt') || '';
      img.loading = 'lazy';
      img.decoding = 'async';
      host.appendChild(img);
    };

    const walkInline = (node, host) => {
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === 3) {
          const t = cleanText(child.nodeValue);
          if (!t) continue;
          if (!t.trim()) {
            // 纯空白只在已有文字时保留成一个空格，避免西文粘连又不产生空段
            if (host.textContent.length) host.appendChild(document.createTextNode(' '));
            continue;
          }
          host.appendChild(document.createTextNode(t));
          continue;
        }
        if (child.nodeType !== 1) continue;
        const tag = child.tagName.toLowerCase();
        if (DROP.has(tag)) continue;
        if (tag === 'br') {
          host.appendChild(document.createElement('br'));
          continue;
        }
        if (tag === 'img') {
          addImage(host, child);
          continue;
        }
        if (BLOCK.has(tag)) {
          // 块级元素混进行内：另起一块继续处理，避免结构错乱
          ctx.block = null;
          walkBlockNode(child);
          continue;
        }
        const mapped = INLINE_MAP[tag] || (INLINE.has(tag) ? tag : 'span');
        const wrap = document.createElement(mapped);
        // 锚点 id 落在行内包装上，同段落里的多个锚点才能各自保留
        takeId(wrap, child);
        walkInline(child, wrap);
        if (wrap.textContent || wrap.children.length || wrap.id) host.appendChild(wrap);
      }
    };

    const walkBlockInto = (node, holder) => {
      const prevTarget = ctx.target;
      const prevBlock = ctx.block;
      ctx.target = holder;
      ctx.block = null;
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === 3) {
          const t = cleanText(child.nodeValue);
          if (!t || !t.trim()) continue;
          ensurePara().appendChild(document.createTextNode(t));
        } else if (child.nodeType === 1) {
          walkBlockNode(child);
        }
      }
      ctx.target = prevTarget;
      ctx.block = prevBlock;
    };

    const walkBlockNode = (node) => {
      const tag = node.tagName.toLowerCase();
      if (DROP.has(tag)) return;

      if (tag === 'hr') {
        ctx.block = null;
        append(document.createElement('hr'));
        return;
      }

      if (tag === 'img') {
        ctx.block = null;
        const holder = append(document.createElement('p'));
        addImage(holder, node);
        return;
      }

      if (tag === 'pre') {
        // 预排版内容保留原始换行与缩进，不参与空白折叠和段落拆分
        ctx.block = null;
        const pre = append(document.createElement('pre'));
        takeId(pre, node);
        pre.textContent = node.textContent;
        if (!pre.textContent.trim()) pre.remove();
        ctx.block = null;
        return;
      }

      if (/^h[1-6]$/.test(tag)) {
        ctx.block = null;
        const h = append(document.createElement(tag));
        takeId(h, node);
        walkInline(node, h);
        if (!h.textContent.trim() && !h.children.length) h.remove();
        ctx.block = null;
        return;
      }

      if (tag === 'ul' || tag === 'ol') {
        ctx.block = null;
        const list = append(document.createElement(tag));
        takeId(list, node);
        for (const li of Array.from(node.children)) {
          if (li.tagName.toLowerCase() !== 'li') continue;
          const item = document.createElement('li');
          walkBlockInto(li, item);
          if (item.textContent.trim() || item.children.length) list.appendChild(item);
        }
        if (!list.children.length) list.remove();
        ctx.block = null;
        return;
      }

      if (BLOCK.has(tag)) {
        ctx.block = null;
        const holder = append(document.createElement(BLOCK_MAP[tag] || 'div'));
        takeId(holder, node);
        // 段落直接按行内内容填充，避免造出 <p><p>…</p></p> 这种嵌套
        if (tag === 'p' || tag === 'figcaption') walkInline(node, holder);
        else walkBlockInto(node, holder);
        if (!holder.textContent.trim() && !holder.children.length) holder.remove();
        ctx.block = null;
        return;
      }

      // 行内标签出现在块级位置，就近并进当前段落
      const host = ensurePara();
      walkInline(node, host);
    };

    for (const child of Array.from(source.childNodes)) {
      if (child.nodeType === 3) {
        const t = cleanText(child.nodeValue);
        if (t && t.trim()) ensurePara().appendChild(document.createTextNode(t));
      } else if (child.nodeType === 1) {
        walkBlockNode(child);
      }
    }

    // 收尾：清掉只剩空白的块，避免撑出无意义的高度；带 id 的是锚点目标，必须保留
    for (const el of Array.from(frag.querySelectorAll('p, div, span'))) {
      if (!el.textContent.trim() && !el.querySelector('img, br') && !el.id) el.remove();
    }

    // 中文段落补首行缩进，西文段落与列表项保持原样
    for (const p of Array.from(frag.querySelectorAll('p'))) {
      if (p.closest('li')) continue;
      const text = (p.textContent || '').replace(/^\s+/, '');
      if (text && Fish.util.isCjk(text[0])) p.classList.add('ind');
      else if (text) p.classList.add('noind');
    }

    return frag;
  }

  return { build };
})();
