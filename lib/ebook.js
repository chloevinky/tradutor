// Ebook text extraction: EPUB, MOBI (non-DRM), FB2, HTML and plain text.
// Output shape for every format: { title, author, chapters: [{ title, paragraphs: [] }] }
import { readZip } from './zip.js';

const MAX_PARAGRAPHS_PER_CHAPTER = 400;

// ---------- shared HTML/text helpers ----------

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', laquo: '«', raquo: '»',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  agrave: 'à', aacute: 'á', acirc: 'â', atilde: 'ã', auml: 'ä',
  egrave: 'è', eacute: 'é', ecirc: 'ê', igrave: 'ì', iacute: 'í',
  ograve: 'ò', oacute: 'ó', ocirc: 'ô', otilde: 'õ', ouml: 'ö',
  ugrave: 'ù', uacute: 'ú', ucirc: 'û', uuml: 'ü', ccedil: 'ç', ntilde: 'ñ',
  Agrave: 'À', Aacute: 'Á', Acirc: 'Â', Atilde: 'Ã', Eacute: 'É', Ecirc: 'Ê',
  Iacute: 'Í', Oacute: 'Ó', Ocirc: 'Ô', Otilde: 'Õ', Uacute: 'Ú', Ccedil: 'Ç',
  copy: '©', reg: '®', trade: '™', sect: '§', deg: '°',
};

export function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => NAMED_ENTITIES[name] ?? m);
}

function safeCodePoint(cp) {
  try { return String.fromCodePoint(cp); } catch { return ''; }
}

const clean = (s) => decodeEntities(String(s).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

// Parse an HTML string into an ordered list of text blocks, marking headings.
function htmlToBlocks(html) {
  let h = String(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head|svg)[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(title)[\s\S]*?<\/\1\s*>/gi, '');

  const blocks = [];
  // Split on block-level boundaries, remembering heading levels.
  // Headings get control-char markers so real text like "H2O" can't be
  // mistaken for one.
  h = h.replace(/<(h[1-6])[^>]*>([\s\S]*?)<\/h[1-6]\s*>/gi,
    (_, tag, inner) => `\n\u0001${tag[1]}\u0002${inner.replace(/\n+/g, ' ')}\n`);
  h = h.replace(/<br\s*\/?>/gi, '\n');
  h = h.replace(/<\/(p|div|section|article|blockquote|li|tr|td|dd|dt|figcaption|pre)\s*>/gi, '\n');
  h = h.replace(/<(p|div|section|article|blockquote|li|ul|ol|table|hr)[^>]*>/gi, '\n');
  h = h.replace(/<[^>]*>/g, '');

  for (const line of h.split(/\n+/)) {
    const m = line.trim().match(/^\u0001(\d)\u0002([\s\S]*)$/);
    if (m) {
      const text = clean(m[2]);
      if (text) blocks.push({ heading: Number(m[1]), text });
      continue;
    }
    const text = decodeEntities(line).replace(/\s+/g, ' ').trim();
    if (text) blocks.push({ heading: 0, text });
  }
  return blocks;
}

// Turn a flat block list into chapters, splitting on h1/h2 headings.
function blocksToChapters(blocks, fallbackTitle) {
  const chapters = [];
  let current = null;
  const open = (title) => {
    current = { title: title || `Section ${chapters.length + 1}`, paragraphs: [] };
    chapters.push(current);
  };
  for (const b of blocks) {
    if (b.heading > 0 && b.heading <= 2) {
      if (current && current.paragraphs.length === 0) current.title = b.text;
      else open(b.text);
      continue;
    }
    if (!current || current.paragraphs.length >= MAX_PARAGRAPHS_PER_CHAPTER) {
      open(current ? current.title + ' (cont.)' : fallbackTitle);
    }
    current.paragraphs.push(b.text);
  }
  return chapters.filter((c) => c.paragraphs.length);
}

// ---------- EPUB ----------

function attr(tag, name) {
  const m = String(tag).match(new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'));
  return m ? decodeEntities(m[1] ?? m[2]) : null;
}

function resolvePath(baseDir, href) {
  const parts = (baseDir ? baseDir.split('/') : []).concat(decodeURIComponent(href).split('/'));
  const out = [];
  for (const p of parts) {
    if (!p || p === '.') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  return out.join('/');
}

export function parseEpub(buf) {
  const zip = readZip(buf);
  const read = (name) => {
    const get = zip.get(name);
    return get ? get().toString('utf8') : null;
  };

  const container = read('META-INF/container.xml') || '';
  const rootfileTag = (container.match(/<rootfile\b[^>]*>/i) || [''])[0];
  const opfPath = attr(rootfileTag, 'full-path')
    || [...zip.keys()].find((k) => k.toLowerCase().endsWith('.opf'));
  if (!opfPath) throw new Error('Invalid EPUB: no OPF package document found');
  const opf = read(opfPath);
  if (!opf) throw new Error('Invalid EPUB: OPF file missing from archive');
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : '';

  const title = clean((opf.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i) || [])[1] || '');
  const author = clean((opf.match(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i) || [])[1] || '');

  const manifest = new Map();
  for (const tag of opf.match(/<item\b[^>]*>/gi) || []) {
    const id = attr(tag, 'id');
    const href = attr(tag, 'href');
    const type = attr(tag, 'media-type') || '';
    if (id && href) manifest.set(id, { href, type });
  }

  const spine = [];
  for (const tag of opf.match(/<itemref\b[^>]*>/gi) || []) {
    const idref = attr(tag, 'idref');
    const item = idref && manifest.get(idref);
    if (item && /html|xml/i.test(item.type)) spine.push(item.href);
  }
  if (!spine.length) {
    for (const { href, type } of manifest.values()) {
      if (/html/i.test(type)) spine.push(href);
    }
  }

  const chapters = [];
  for (const href of spine) {
    const html = read(resolvePath(opfDir, href));
    if (!html) continue;
    const blocks = htmlToBlocks(html);
    if (!blocks.length) continue;
    const docTitle = clean((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
    const part = blocksToChapters(blocks, docTitle || `Chapter ${chapters.length + 1}`);
    if (part.length && docTitle && part[0].title.startsWith('Section ')) part[0].title = docTitle;
    chapters.push(...part);
  }
  if (!chapters.length) throw new Error('EPUB contained no readable text');
  return { title: title || null, author: author || null, chapters };
}

// ---------- MOBI (PalmDoc / non-DRM) ----------

function palmdocDecompress(data) {
  const out = [];
  let i = 0;
  while (i < data.length) {
    const c = data[i++];
    if (c === 0) out.push(0);
    else if (c <= 8) { for (let j = 0; j < c && i < data.length; j++) out.push(data[i++]); }
    else if (c <= 0x7f) out.push(c);
    else if (c <= 0xbf) {
      if (i >= data.length) break;
      const pair = ((c << 8) | data[i++]) & 0x3fff;
      const dist = pair >> 3;
      const len = (pair & 7) + 3;
      for (let j = 0; j < len; j++) {
        const at = out.length - dist;
        out.push(at >= 0 ? out[at] : 0);
      }
    } else { out.push(0x20, c ^ 0x80); }
  }
  return Buffer.from(out);
}

// Trailing per-record metadata sizes (MOBI "extra data flags").
function trailingSize(data, extraFlags) {
  let size = 0;
  let flags = extraFlags >> 1;
  while (flags) {
    if (flags & 1) {
      // Backward-encoded varint at the current end.
      let value = 0;
      for (let i = 0; i < 4; i++) {
        const b = data[data.length - size - 1 - i];
        value = (value << 7) | (b & 0x7f);
        if (b & 0x80) break;
      }
      size += value;
    }
    flags >>= 1;
  }
  if (extraFlags & 1) size += (data[data.length - size - 1] & 3) + 1;
  return size;
}

export function parseMobi(buf) {
  if (buf.length < 80) throw new Error('Not a MOBI file');
  const type = buf.toString('latin1', 60, 68);
  if (type !== 'BOOKMOBI' && type !== 'TEXtREAd') throw new Error('Not a MOBI/PalmDoc file');

  const numRecords = buf.readUInt16BE(76);
  const recOff = (n) => buf.readUInt32BE(78 + n * 8);
  const record = (n) => buf.subarray(recOff(n), n + 1 < numRecords ? recOff(n + 1) : buf.length);

  const r0 = record(0);
  const compression = r0.readUInt16BE(0);
  const textRecordCount = r0.readUInt16BE(8);
  if (compression === 17480) {
    throw new Error('This MOBI uses HUFF/CDIC compression, which is not supported. Convert it to EPUB (e.g. with Calibre) and re-upload.');
  }
  if (compression !== 1 && compression !== 2) {
    throw new Error(`Unsupported MOBI compression (${compression}). The file may be DRM-protected.`);
  }

  let encoding = 'latin1';
  let title = null;
  let extraFlags = 0;
  if (r0.length >= 24 && r0.toString('latin1', 16, 20) === 'MOBI') {
    const mobiLen = r0.readUInt32BE(20);
    const enc = r0.readUInt32BE(28);
    encoding = enc === 65001 ? 'utf8' : 'latin1';
    if (r0.length >= 0x5c + 8) {
      const tOff = r0.readUInt32BE(0x54);
      const tLen = r0.readUInt32BE(0x58);
      if (tOff + tLen <= r0.length) title = r0.toString(encoding, tOff, tOff + tLen).trim();
    }
    if (mobiLen >= 0xe4 && r0.length >= 0xf4) extraFlags = r0.readUInt16BE(0xf2);
    // DRM check: drm_offset != 0xffffffff means encrypted.
    if (r0.length >= 0xac && r0.readUInt32BE(0xa8) !== 0xffffffff) {
      throw new Error('This MOBI file is DRM-protected and cannot be read.');
    }
  }

  const pieces = [];
  for (let n = 1; n <= textRecordCount && n < numRecords; n++) {
    let data = record(n);
    const trail = trailingSize(data, extraFlags);
    data = data.subarray(0, Math.max(0, data.length - trail));
    pieces.push(compression === 2 ? palmdocDecompress(data) : Buffer.from(data));
  }
  const html = Buffer.concat(pieces).toString(encoding);
  const chapters = blocksToChapters(
    htmlToBlocks(html.replace(/<mbp:pagebreak[^>]*>/gi, '\n')),
    'Chapter 1'
  );
  if (!chapters.length) throw new Error('MOBI contained no readable text');
  return { title, author: null, chapters };
}

// ---------- FB2 ----------

export function parseFb2(text) {
  const title = clean((text.match(/<book-title[^>]*>([\s\S]*?)<\/book-title>/i) || [])[1] || '');
  const authorM = text.match(/<author[^>]*>([\s\S]*?)<\/author>/i);
  const author = authorM ? clean(authorM[1]) : '';

  let body = '';
  for (const m of text.matchAll(/<body[^>]*>([\s\S]*?)<\/body>/gi)) body += m[1] + '\n';
  if (!body) throw new Error('Invalid FB2: no <body> found');
  body = body
    .replace(/<binary[\s\S]*?<\/binary>/gi, '')
    .replace(/<title[^>]*>([\s\S]*?)<\/title>/gi, (_, inner) => `<h2>${clean(inner)}</h2>`)
    .replace(/<subtitle[^>]*>([\s\S]*?)<\/subtitle>/gi, (_, inner) => `<h3>${clean(inner)}</h3>`)
    .replace(/<(v|text-author)[^>]*>([\s\S]*?)<\/\1>/gi, '<p>$2</p>');

  const chapters = blocksToChapters(htmlToBlocks(body), title || 'Book');
  if (!chapters.length) throw new Error('FB2 contained no readable text');
  return { title: title || null, author: author || null, chapters };
}

// ---------- plain text ----------

export function parseTxt(text) {
  const paras = String(text)
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n+/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (!paras.length) throw new Error('The file contained no text');
  const chapters = [];
  for (let i = 0; i < paras.length; i += MAX_PARAGRAPHS_PER_CHAPTER) {
    chapters.push({
      title: paras.length > MAX_PARAGRAPHS_PER_CHAPTER
        ? `Part ${chapters.length + 1}` : 'Text',
      paragraphs: paras.slice(i, i + MAX_PARAGRAPHS_PER_CHAPTER),
    });
  }
  return { title: null, author: null, chapters };
}

// ---------- dispatcher ----------

export function parseBook(buf, filename) {
  const ext = String(filename || '').toLowerCase().replace(/^.*\./, '');
  const looksZip = buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50;

  if (ext === 'epub' || looksZip) return { format: 'epub', ...parseEpub(buf) };
  if (ext === 'mobi' || ext === 'azw' || ext === 'azw3' || ext === 'prc'
      || (buf.length > 68 && buf.toString('latin1', 60, 68) === 'BOOKMOBI')) {
    return { format: 'mobi', ...parseMobi(buf) };
  }
  const text = buf.toString('utf8');
  if (ext === 'fb2' || /<FictionBook/i.test(text.slice(0, 2000))) return { format: 'fb2', ...parseFb2(text) };
  if (ext === 'html' || ext === 'htm' || ext === 'xhtml' || /<html/i.test(text.slice(0, 2000))) {
    const title = clean((text.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
    const chapters = blocksToChapters(htmlToBlocks(text), title || 'Document');
    if (!chapters.length) throw new Error('HTML contained no readable text');
    return { format: 'html', title: title || null, author: null, chapters };
  }
  if (ext === 'pdf' || text.startsWith('%PDF')) {
    throw new Error('PDF is not supported. Convert it to EPUB or TXT (e.g. with Calibre) and re-upload.');
  }
  return { format: 'txt', ...parseTxt(text) };
}
