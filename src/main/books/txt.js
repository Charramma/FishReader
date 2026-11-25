'use strict';

const fs = require('fs/promises');
const path = require('path');
const iconv = require('iconv-lite');
const jschardet = require('jschardet');

/** 单文件上限，超过直接拒绝，避免主进程被撑爆 */
const MAX_BYTES = 80 * 1024 * 1024;
/** 兜底分段时每段的目标字数 */
const FALLBACK_SEGMENT = 2000;

const CHAPTER_PATTERNS = [
  // 第一章 / 第 1 回 / 第三十二节
  {
    name: 'cn',
    re: /^\s*第\s*[0-9０-９〇零一二三四五六七八九十百千万两]{1,12}\s*[章回节卷折篇幕]\s*(?:[\u4e00-\u9fa5A-Za-z0-9、，。：:·\-—_！？!?「」『』“”()\s]{0,30})\s*$/
  },
  // Chapter 1 / 正文 第十一章
  { name: 'en', re: /^\s*(?:chapter|part|section|canto)\s+[0-9ivxlcdmIVXLCDM]{1,10}\b.{0,40}$/i },
  // 楔子 / 后记 / 番外一 等独立标题
  { name: 'misc', re: /^\s*(?:楔子|序言|序章|前言|引子|绪论|后记|尾声|终章|番外|大结局|跋|致谢)\s*[\u4e00-\u9fa5A-Za-z0-9、：:_\-—·]{0,20}$/ }
];

/** 低优先级：纯数字编号标题，只在前面几种都识别不出来时启用 */
const NUMBERED_RE = /^\s*[0-9]{1,4}\s*[、.．\-—]\s*[\u4e00-\u9fa5A-Za-z0-9]{1,24}\s*$/;

const MAX_TITLE_LEN = 50;

function decodeBuffer(buffer) {
  const bom = (() => {
    if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
      return { encoding: 'utf-8', offset: 3 };
    }
    if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
      return { encoding: 'utf-16le', offset: 2 };
    }
    if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
      return { encoding: 'utf-16be', offset: 2 };
    }
    return null;
  })();

  if (bom) {
    return { text: iconv.decode(buffer.subarray(bom.offset), bom.encoding), encoding: bom.encoding };
  }

  const sample = buffer.subarray(0, Math.min(buffer.length, 1024 * 1024));
  const detected = jschardet.detect(sample);
  const candidates = [];
  const push = (enc) => {
    if (enc && !candidates.includes(enc)) candidates.push(enc);
  };

  const guess = (detected && detected.encoding) || '';
  const normalized = guess.toUpperCase();
  if (normalized === 'GB2312' || normalized === 'GBK' || normalized === 'ANSI_1252') push('GB18030');
  else if (normalized === 'BIG5') push('Big5');
  else if (normalized === 'UTF-8' || normalized === 'ASCII') push('utf-8');
  else push(guess || 'utf-8');

  push('utf-8');
  push('GB18030');
  push('Big5');

  let best = null;
  for (const enc of candidates) {
    let text;
    try {
      text = iconv.decode(buffer, enc);
    } catch {
      continue;
    }
    const bad = (text.match(/\uFFFD/g) || []).length;
    if (!best || bad < best.bad) best = { text, encoding: enc, bad };
    if (bad === 0) break;
  }

  if (!best) best = { text: buffer.toString('utf8'), encoding: 'utf-8', bad: 0 };
  return { text: best.text, encoding: best.encoding };
}

/**
 * 按行扫描章节标题，返回 [{title, start}]，start 是该章正文（标题行之后）的字符偏移。
 */
function splitChapters(text, patterns) {
  const found = [];
  let cursor = 0;
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && trimmed.length <= MAX_TITLE_LEN) {
      const hit = patterns.some((p) => p.re.test(trimmed));
      if (hit) {
        found.push({ title: trimmed, lineStart: cursor, start: cursor + line.length + 1 });
      }
    }
    cursor += line.length + 1;
  }
  return found;
}

/** 识别不到章节时按字数兜底切段，断点尽量落在空行处 */
function fallbackPages(text) {
  const total = text.length;
  const pages = [];
  let pos = 0;
  // 按位置推进而不是按固定次数循环：每页断点都可能往前提，按次数会漏掉结尾
  while (pos < total) {
    let target = Math.min(total, pos + FALLBACK_SEGMENT);
    if (target < total) {
      const nl = text.lastIndexOf('\n\n', target);
      if (nl > pos + FALLBACK_SEGMENT * 0.6) target = nl;
    }
    pages.push({ title: `第 ${pages.length + 1} 段`, start: pos, end: target });
    pos = target;
  }
  return pages;
}

/** 把整本书切成渲染单元（页），每页自带字符区间 */
function buildPages(text) {
  let marks = splitChapters(text, CHAPTER_PATTERNS);
  if (!marks.length) {
    const numbered = splitChapters(text, [{ name: 'num', re: NUMBERED_RE }]);
    if (numbered.length >= 3) marks = numbered;
  }

  // 只认出一个标题：多半是分章文件（标题就在开头），认它。
  // 藏在正文深处的单个命中更像偶然句子，当噪声丢掉，免得在莫名其妙的地方断章。
  if (marks.length === 1 && marks[0].lineStart > Math.max(1500, text.length * 0.05)) {
    marks = [];
  }

  if (!marks.length) {
    // 没有任何可识别标题：常规长度整篇一页，别造"第 N 段"这种原文里没有的名字；
    // 只有巨量无标题文本才切段，保证滚动与定位的性能。
    if (text.length <= 200000) {
      return { pages: [{ title: '全文', start: 0, end: text.length }], strategy: 'single' };
    }
    return { pages: fallbackPages(text), strategy: 'fallback' };
  }

  const pages = [];
  // 第一个标题之前往往还有书名/作者/简介，单独成页，避免丢字
  if (text.slice(0, marks[0].lineStart).trim()) {
    pages.push({ title: '开篇', start: 0, end: marks[0].lineStart });
  }
  marks.forEach((m, i) => {
    pages.push({
      title: m.title,
      start: m.start,
      end: i + 1 < marks.length ? marks[i + 1].lineStart : text.length
    });
  });
  return { pages, strategy: 'regex' };
}

async function openTxt(filePath) {
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error('不是文件');
  if (stat.size > MAX_BYTES) {
    throw new Error(`文件过大（${(stat.size / 1048576).toFixed(1)} MB），上限 ${MAX_BYTES / 1048576} MB`);
  }

  const buffer = await fs.readFile(filePath);
  const decoded = decodeBuffer(buffer);
  let text = decoded.text;
  const encoding = decoded.encoding;

  text = text.replace(/\r\n?/g, '\n').replace(/\u0000/g, '');
  const { pages, strategy } = buildPages(text);

  pages.forEach((p, i) => {
    p.index = i;
    p.label = p.title;
    p.length = p.end - p.start;
  });

  return {
    type: 'txt',
    path: filePath,
    title: path.basename(filePath, path.extname(filePath)),
    encoding,
    strategy,
    totalLength: text.length,
    text,
    startPage: 0,
    pages,
    chapters: pages.map((p, i) => ({
      index: i,
      title: p.title,
      depth: 0,
      pageIndex: i,
      anchor: ''
    }))
  };
}

/** 取一页正文并切成段落 */
function pageParagraphs(book, pageIndex) {
  const page = book.pages[pageIndex];
  if (!page) return [];
  return book.text
    .slice(page.start, page.end)
    .split('\n')
    .map((line) => line.replace(/^[\s\u3000]+|[\s\u3000]+$/g, ''))
    .filter((line) => line.length > 0);
}

module.exports = { openTxt, pageParagraphs };
