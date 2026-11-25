'use strict';

const path = require('path');
const { openTxt, pageParagraphs } = require('./books/txt');
const { openEpub, pageHtml, readResource } = require('./books/epub');

/** 同一时刻只驻留一本书，换书时释放旧的解码结果 */
let current = null;

function metaOf(book) {
  const meta = {
    type: book.type,
    path: book.path,
    title: book.title,
    chapters: book.chapters.map((c) => ({
      index: c.index,
      title: c.title,
      depth: c.depth || 0,
      pageIndex: c.pageIndex,
      anchor: c.anchor || ''
    })),
    pageCount: book.pages.length,
    pageLabels: book.pages.map((p) => p.label || ''),
    startPage: book.startPage || 0
  };
  if (book.type === 'txt') {
    meta.encoding = book.encoding;
    meta.strategy = book.strategy;
    meta.chars = book.totalLength;
  } else {
    meta.author = book.author;
    meta.tocSource = book.tocSource;
  }
  return meta;
}

async function open(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  let book;
  if (ext === '.epub') {
    book = await openEpub(filePath);
  } else if (ext === '.txt') {
    book = await openTxt(filePath);
  } else {
    throw new Error(`不支持的文件类型：${ext || '未知'}`);
  }
  if (current && current.zip) current.zip = null;
  current = book;
  return metaOf(book);
}

function currentBook() {
  return current;
}

async function readPage(index) {
  if (!current) throw new Error('尚未打开文件');
  if (current.type === 'txt') {
    return { index, kind: 'txt', paragraphs: pageParagraphs(current, index) };
  }
  const page = current.pages[index] || {};
  return { index, kind: 'epub', doc: page.doc || '', html: await pageHtml(current, index) };
}

/** 相对当前页文档目录解析资源路径（epub 图片常写成 ../images/x.png） */
async function resource(bookPath, relPath) {
  if (!current || current.path !== bookPath) throw new Error('文件已关闭');
  const found = await readResource(current, relPath);
  if (!found) throw new Error('资源不存在');
  return found;
}

module.exports = { open, currentBook, readPage, resource, metaOf };
