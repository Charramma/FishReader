'use strict';

const fs = require('fs/promises');
const path = require('path');
const JSZip = require('jszip');
const { XMLParser } = require('fast-xml-parser');

const MAX_BYTES = 120 * 1024 * 1024;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  cdataPropName: '__cdata'
});

function toArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function textOf(node) {
  if (node === undefined || node === null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (typeof node !== 'object') return '';
  if (node.__cdata !== undefined) return String(node.__cdata);
  if (node['#text'] !== undefined) return String(node['#text']);
  return '';
}

/** 目录/资源里的 href 相对 OPF 所在目录，统一成 zip 内路径并去掉锚点 */
function resolveHref(opfDir, href) {
  if (!href) return { doc: '', fragment: '' };
  const raw = String(href);
  const hashAt = raw.indexOf('#');
  const clean = hashAt === -1 ? raw : raw.slice(0, hashAt);
  const fragment = hashAt === -1 ? '' : raw.slice(hashAt + 1);
  if (!clean) return { doc: '', fragment };
  let decoded;
  try {
    decoded = decodeURIComponent(clean);
  } catch {
    decoded = clean;
  }
  const joined = path.posix.normalize(path.posix.join(opfDir, decoded));
  return { doc: joined.replace(/^\.\//, ''), fragment };
}

function parseContainer(xml) {
  const doc = parser.parse(xml);
  const rootfile = doc?.container?.rootfiles?.[0]?.rootfile ?? doc?.container?.rootfiles?.rootfile;
  for (const rf of toArray(rootfile)) {
    const full = rf && rf['@_full-path'];
    if (full) return full;
  }
  throw new Error('epub 缺少 container.xml 或 OPF 声明');
}

function child(parentObj, name) {
  if (!parentObj) return null;
  const value = parentObj[name];
  if (value === undefined || value === null) return null;
  return Array.isArray(value) ? value[0] : value;
}

function parseOpf(xml, opfDir) {
  const doc = parser.parse(xml);
  const pkg = child(doc, 'package') || child(doc, 'opf:package') || {};
  const manifestNode = child(pkg, 'manifest') || {};
  const spineNode = child(pkg, 'spine') || {};
  const meta = child(pkg, 'metadata') || {};

  const manifest = new Map();
  for (const item of toArray(manifestNode.item)) {
    if (!item || !item['@_id']) continue;
    manifest.set(item['@_id'], {
      id: item['@_id'],
      href: item['@_href'] || '',
      mediaType: item['@_media-type'] || '',
      properties: item['@_properties'] || ''
    });
  }

  const spine = [];
  for (const ref of toArray(spineNode.itemref)) {
    const id = ref && (ref['@_idref'] || ref['@_idRef']);
    if (!id || !manifest.has(id)) continue;
    if (String(ref['@_linear'] || 'yes').toLowerCase() === 'no') continue;
    spine.push(resolveHref(opfDir, manifest.get(id).href).doc);
  }

  return {
    manifest,
    spine,
    title: textOf(child(meta, 'dc:title')) || textOf(meta.title),
    creator: textOf(child(meta, 'dc:creator')) || textOf(meta.creator)
  };
}

/** 在任意层级里找出 epub:type 含指定角色的节点 */
function findByRole(node, role, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 12) return null;
  for (const key of Object.keys(node)) {
    if (key.startsWith('@_') || key === '#text') continue;
    for (const item of toArray(node[key])) {
      if (!item || typeof item !== 'object') continue;
      const type = String(item['@_epub:type'] || item['@_class'] || '');
      if (key === 'nav' && new Set(type.split(/\s+/)).has(role)) return item;
      const hit = findByRole(item, role, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

/** EPUB3 nav.xhtml */
function parseNav(navNode, opfDir) {
  const out = [];
  const visit = (ol, depth) => {
    if (!ol) return;
    for (const li of toArray(ol.li)) {
      if (!li) continue;
      const link = toArray(li.a)[0] || toArray(li.span)[0];
      if (link) {
        const label = (typeof link === 'object' ? textOf(link) : String(link)).replace(/\s+/g, ' ').trim();
        const { doc, fragment } = resolveHref(opfDir, (link['@_href'] || '').trim());
        if (label && doc) out.push({ title: label, doc, fragment, depth });
      }
      visit(child(li, 'ol') || li.ol, depth + 1);
    }
  };
  visit(child(navNode, 'ol'), 0);
  return out;
}

/** EPUB2 NCX */
function parseNcx(ncxNode, opfDir) {
  const out = [];
  const visit = (holder, depth) => {
    if (!holder) return;
    for (const point of toArray(holder.navPoint)) {
      if (!point) continue;
      const labelNode = child(point, 'navLabel');
      const labelText = toArray(labelNode ? labelNode.text : [])
        .map(textOf)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      const content = child(point, 'content') || {};
      const { doc, fragment } = resolveHref(opfDir, content['@_src'] || '');
      if (labelText && doc) out.push({ title: labelText, doc, fragment, depth });
      // 子级 navPoint 直接嵌套在 navPoint 里（不是再套一层 navMap）
      visit(point, depth + 1);
    }
  };
  visit(ncxNode, 0);
  return out;
}

/**
 * 目录条目落到具体的渲染单元上：
 * pages 就是 spine 里的文档，目录只做 (页, 锚点) 索引，正文永远不重复渲染。
 */
function buildIndex(spine, entries) {
  const pageOf = new Map();
  spine.forEach((doc, i) => {
    if (!pageOf.has(doc)) pageOf.set(doc, i);
  });

  const chapters = [];
  for (const e of entries) {
    const pageIndex = pageOf.get(e.doc);
    if (pageIndex === undefined) continue;
    const anchor = e.fragment || '';
    const prev = chapters[chapters.length - 1];
    // 同一页同一锚点的重复条目（nav/ncx 混用、guide 冗余）只留一条
    if (prev && prev.pageIndex === pageIndex && prev.anchor === anchor) continue;
    chapters.push({ title: e.title, depth: e.depth, pageIndex, anchor });
  }
  return chapters;
}

function labelForDoc(docPath) {
  const base = path.posix.basename(docPath);
  let name;
  try {
    name = decodeURIComponent(base);
  } catch {
    // href 已在 resolveHref 里解过码，文件名里可能只剩裸 %，此时直接用原名
    name = base;
  }
  return name.replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ');
}

async function openEpub(filePath) {
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error('不是文件');
  if (stat.size > MAX_BYTES) {
    throw new Error(`文件过大（${(stat.size / 1048576).toFixed(1)} MB），上限 ${MAX_BYTES / 1048576} MB`);
  }

  const zip = await JSZip.loadAsync(await fs.readFile(filePath));

  const containerEntry = zip.file('META-INF/container.xml') || zip.file(/META-INF\/container\.xml$/i)[0];
  if (!containerEntry) throw new Error('epub 缺少 META-INF/container.xml');
  const opfPath = parseContainer(await containerEntry.async('string'));
  const opfDir = path.posix.dirname(opfPath);

  const opfEntry = zip.file(opfPath);
  if (!opfEntry) throw new Error('epub 找不到 OPF 文件');
  const { manifest, spine, title, creator } = parseOpf(await opfEntry.async('string'), opfDir);
  if (!spine.length) throw new Error('epub 的 spine 为空');

  const pages = spine.map((doc, i) => ({ index: i, doc, label: labelForDoc(doc) }));

  let navItem = null;
  let ncxItem = null;
  for (const item of manifest.values()) {
    if (item.properties.split(/\s+/).includes('nav') && !navItem) navItem = item;
    if (/x-dtbncx/i.test(item.mediaType) && !ncxItem) ncxItem = item;
  }

  let entries = [];
  let tocSource = 'none';
  if (navItem) {
    const target = resolveHref(opfDir, navItem.href);
    const entry = zip.file(target.doc);
    if (entry) {
      const navNode = findByRole(parser.parse(await entry.async('string')), 'toc');
      if (navNode) {
        entries = parseNav(navNode, opfDir);
        if (entries.length) tocSource = 'nav';
      }
    }
  }
  if (!entries.length && ncxItem) {
    const target = resolveHref(opfDir, ncxItem.href);
    const entry = zip.file(target.doc);
    if (entry) {
      const ncxNode = child(parser.parse(await entry.async('string')), 'ncx');
      entries = parseNcx(child(ncxNode, 'navMap'), opfDir);
      if (entries.length) tocSource = 'ncx';
    }
  }

  let chapters = buildIndex(spine, entries);
  if (chapters.length < 2) {
    chapters = pages.map((p) => ({ title: p.label, depth: 0, pageIndex: p.index, anchor: '' }));
    tocSource = 'spine';
  }
  chapters.forEach((c, i) => {
    c.index = i;
  });

  const firstContent = pages.find((p) => /\.(xhtml?|html?)$/i.test(p.doc)) || pages[0];

  return {
    type: 'epub',
    path: filePath,
    zip,
    opfDir,
    title: title || path.basename(filePath, path.extname(filePath)),
    author: creator,
    tocSource,
    pages,
    chapters,
    startPage: firstContent.index
  };
}

/** 取一页的原始 XHTML，清洗与图片改写交给渲染层做 */
async function pageHtml(book, pageIndex) {
  const page = book.pages[pageIndex];
  if (!page) return '';
  const entry = book.zip.file(page.doc);
  if (!entry) return '';
  return entry.async('string');
}

function guessMime(zipPath) {
  const ext = path.posix.extname(zipPath).toLowerCase();
  const types = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.css': 'text/css',
    '.otf': 'font/otf',
    '.ttf': 'font/ttf',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2'
  };
  return types[ext] || 'application/octet-stream';
}

/** book:// 协议取图片等资源，zip 内路径按相对 OPF 目录解析后再兜底直接匹配 */
async function readResource(book, relPath) {
  const raw = relPath.replace(/^\/+/, '');
  let decoded;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = raw;
  }
  const candidates = [decoded, path.posix.normalize(path.posix.join(book.opfDir, decoded))];
  for (const cand of candidates) {
    const entry = book.zip.file(cand);
    if (entry && !entry.dir) {
      return { data: await entry.async('nodebuffer'), mime: guessMime(cand) };
    }
  }
  const base = path.posix.basename(decoded);
  const fuzzy = book.zip.file(new RegExp(`(^|/)${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`))[0];
  if (fuzzy && !fuzzy.dir) {
    return { data: await fuzzy.async('nodebuffer'), mime: guessMime(base) };
  }
  return null;
}

module.exports = { openEpub, pageHtml, readResource };
