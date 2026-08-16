import { inflateRawSync, inflateSync } from 'node:zlib';

export const MAX_PDF_BYTES = 20 * 1024 * 1024;
export const PDF_TEXT_PAGE = 1;

const WHITESPACE = new Set([0, 9, 10, 12, 13, 32]);
const TJ_SPACE_THRESHOLD = -120;
const MAX_TEXT_CHARS = 100_000;

export function extractPdfPageText(input, options = {}) {
  try {
    const bytes = asBuffer(input);
    if (bytes.length < 5 || bytes.subarray(0, 5).toString('latin1') !== '%PDF-') return '';
    const doc = parsePdfDocument(bytes);
    const page = pageAt(doc, options.page == null ? PDF_TEXT_PAGE : options.page);
    if (!page) return '';
    const streams = pageContentStreams(doc, page);
    const pieces = [];
    for (const stream of streams) {
      const decoded = decodeStream(doc, stream);
      if (decoded && decoded.length) pieces.push(interpretContent(decoded));
    }
    return normalizePdfText(pieces.join('\n'));
  } catch (error) {
    if (process.env.PDF_TEXT_DEBUG) console.error(error);
    return '';
  }
}

export function pdfPageFetchExpression(url, maxBytes = MAX_PDF_BYTES) {
  const bounded = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : MAX_PDF_BYTES;
  return `(async () => {
    const response = await fetch(${JSON.stringify(String(url || ''))}, { credentials: "include", cache: "force-cache" });
    if (!response.ok) throw new Error("pdf http " + response.status);
    const buf = await response.arrayBuffer();
    if (buf.byteLength > ${bounded}) throw new Error("pdf too large");
    const bytes = new Uint8Array(buf);
    let bin = "";
    const step = 0x8000;
    for (let i = 0; i < bytes.length; i += step) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + step, bytes.length)));
    }
    return btoa(bin);
  })()`;
}

export function bufferFromPdfBase64(value) {
  try {
    const buf = Buffer.from(String(value || ''), 'base64');
    if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return buf;
    return Buffer.alloc(0);
  } catch {
    return Buffer.alloc(0);
  }
}

function asBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input);
  if (typeof input === 'string') return Buffer.from(input, 'latin1');
  throw new Error('pdf bytes required');
}

function parsePdfDocument(bytes) {
  const xrefAt = readStartXref(bytes);
  const doc = {
    bytes,
    entries: new Map(),
    cache: new Map(),
    objStmLoaded: new Set(),
    root: null,
  };
  loadXrefSection(doc, xrefAt);
  for (const [num, entry] of doc.entries) {
    if (entry.type !== 1) continue;
    try {
      const obj = getObject(doc, num);
      if (dictName(obj, 'Type') === 'ObjStm') loadObjectStream(doc, num, obj);
    } catch {
      // Keep page-tree extraction available if one object stream is malformed.
    }
  }
  if (!doc.root) {
    const catalog = [...doc.entries.keys()]
      .map((num) => getObject(doc, num))
      .find((obj) => dictName(obj, 'Type') === 'Catalog');
    if (catalog) doc.root = catalog;
  }
  return doc;
}

function readStartXref(bytes) {
  const needle = Buffer.from('startxref', 'latin1');
  const at = bytes.lastIndexOf(needle);
  if (at < 0) throw new Error('startxref missing');
  const tail = bytes.subarray(at + needle.length).toString('latin1');
  const match = tail.match(/\s+(\d+)/);
  if (!match) throw new Error('startxref offset missing');
  return Number(match[1]);
}

function loadXrefSection(doc, offset, seen = new Set()) {
  if (!Number.isFinite(offset) || offset < 0 || offset >= doc.bytes.length || seen.has(offset)) return;
  seen.add(offset);
  const reader = new Reader(doc.bytes, offset);
  reader.skipWsAndComments();
  if (reader.startsWith('xref')) {
    reader.consume('xref');
    while (true) {
      reader.skipWsAndComments();
      if (reader.startsWith('trailer')) break;
      const start = reader.readNumber();
      const count = reader.readNumber();
      for (let i = 0; i < count; i += 1) {
        reader.skipWsAndComments();
        const off = Number(reader.readTokenText(10));
        reader.skipWsAndComments();
        const gen = Number(reader.readTokenText(5));
        reader.skipWsAndComments();
        const flag = String.fromCharCode(reader.buf[reader.i] || 0);
        reader.i += 1;
        if (reader.buf[reader.i] === 32 || reader.buf[reader.i] === 13 || reader.buf[reader.i] === 10) reader.i += 1;
        const num = start + i;
        if (!doc.entries.has(num)) {
          doc.entries.set(num, {
            type: flag === 'n' ? 1 : 0,
            offset: off,
            gen,
            stm: 0,
            index: 0,
          });
        }
      }
    }
    reader.consume('trailer');
    const trailer = reader.readValue(doc);
    if (!doc.root && trailer && trailer.kind === 'dict') doc.root = trailer.get('Root');
    const prev = trailer && trailer.kind === 'dict' ? asNumber(trailer.get('Prev')) : null;
    if (prev != null) loadXrefSection(doc, prev, seen);
    return;
  }
  const obj = reader.readIndirectObject(doc);
  if (!obj || dictName(obj.value, 'Type') !== 'XRef') throw new Error('xref stream missing');
  ingestXrefStream(doc, obj.num, obj.value);
  const prev = asNumber(asDict(obj.value)?.get('Prev'));
  if (prev != null) loadXrefSection(doc, prev, seen);
}

function ingestXrefStream(doc, num, obj) {
  const dict = asDict(obj);
  if (!dict) throw new Error('xref stream missing');
  if (!doc.root) doc.root = dict.get('Root');
  const decoded = decodeStream(doc, obj);
  const widths = asNumberArray(dict.get('W')) || [1, 2, 1];
  const size = asNumber(dict.get('Size')) || 0;
  let index = asNumberArray(dict.get('Index'));
  if (!index || index.length === 0) index = [0, size];
  const columns = widths.reduce((sum, w) => sum + w, 0);
  const predictor = asNumber(dictLookup(dict, 'DecodeParms', 'Predictor'));
  const predictorColumns = asNumber(dictLookup(dict, 'DecodeParms', 'Columns')) || columns;
  const table = predictor ? decodePredictor(decoded, predictorColumns, predictor) : decoded;
  let cursor = 0;
  const readField = (width) => {
    if (width <= 0) return 0;
    let value = 0;
    for (let i = 0; i < width; i += 1) {
      value = (value << 8) | (table[cursor] || 0);
      cursor += 1;
    }
    return value;
  };
  for (let range = 0; range < index.length; range += 2) {
    const start = index[range];
    const count = index[range + 1];
    for (let i = 0; i < count; i += 1) {
      const typeWidth = widths[0] || 0;
      const type = typeWidth === 0 ? 1 : readField(typeWidth);
      const field2 = readField(widths[1] || 0);
      const field3 = readField(widths[2] || 0);
      const objNum = start + i;
      if (doc.entries.has(objNum)) continue;
      if (type === 1) {
        doc.entries.set(objNum, { type: 1, offset: field2, gen: field3, stm: 0, index: 0 });
      } else if (type === 2) {
        doc.entries.set(objNum, { type: 2, offset: 0, gen: 0, stm: field2, index: field3 });
      } else {
        doc.entries.set(objNum, { type: 0, offset: 0, gen: field3, stm: 0, index: 0 });
      }
    }
  }
  doc.entries.set(num, { type: 1, offset: 0, gen: 0, stm: 0, index: 0 });
  doc.cache.set(objKey(num, 0), obj.kind === 'stream' ? obj : dict);
}

function decodePredictor(data, columns, predictor) {
  if (!data || !columns || predictor !== 12) return data;
  const rowSize = columns + 1;
  if (data.length % rowSize !== 0) return data;
  const rows = data.length / rowSize;
  const out = Buffer.alloc(rows * columns);
  let prev = Buffer.alloc(columns);
  for (let row = 0; row < rows; row += 1) {
    const tag = data[row * rowSize];
    const src = data.subarray(row * rowSize + 1, row * rowSize + 1 + columns);
    const decoded = Buffer.alloc(columns);
    if (tag === 2) {
      for (let i = 0; i < columns; i += 1) decoded[i] = ((src[i] || 0) + (prev[i] || 0)) & 255;
    } else if (tag === 1) {
      for (let i = 0; i < columns; i += 1) decoded[i] = ((src[i] || 0) + (i ? decoded[i - 1] : 0)) & 255;
    } else if (tag === 3) {
      for (let i = 0; i < columns; i += 1) {
        const left = i ? decoded[i - 1] : 0;
        const up = prev[i] || 0;
        decoded[i] = ((src[i] || 0) + ((left + up) >> 1)) & 255;
      }
    } else {
      src.copy(decoded);
    }
    decoded.copy(out, row * columns);
    prev = decoded;
  }
  return out;
}

function loadObjectStream(doc, num, obj) {
  if (doc.objStmLoaded.has(num)) return;
  doc.objStmLoaded.add(num);
  const dict = asDict(obj);
  if (!dict) return;
  const count = asNumber(dict.get('N')) || 0;
  const first = asNumber(dict.get('First')) || 0;
  const decoded = decodeStream(doc, obj);
  if (!decoded || count < 1) return;
  const header = decoded.subarray(0, first).toString('latin1').trim().split(/\s+/);
  const pairs = [];
  for (let i = 0; i + 1 < header.length && pairs.length < count; i += 2) {
    pairs.push({ num: Number(header[i]), offset: Number(header[i + 1]) });
  }
  for (let i = 0; i < pairs.length; i += 1) {
    const start = first + pairs[i].offset;
    const end = i + 1 < pairs.length ? first + pairs[i + 1].offset : decoded.length;
    const reader = new Reader(decoded.subarray(start, end), 0);
    const value = reader.readValue(doc);
    doc.entries.set(pairs[i].num, { type: 2, offset: 0, gen: 0, stm: num, index: i });
    doc.cache.set(objKey(pairs[i].num, 0), value);
  }
}

function pageAt(doc, pageNumber) {
  const wanted = Number(pageNumber);
  if (!Number.isFinite(wanted) || wanted < 1) return null;
  const root = deref(doc, doc.root);
  const pages = deref(doc, dictGet(root, 'Pages'));
  const list = [];
  collectPages(doc, pages, list);
  return list[wanted - 1] || null;
}

function collectPages(doc, node, out) {
  const obj = deref(doc, node);
  if (!obj) return;
  const type = dictName(obj, 'Type');
  if (type === 'Page') {
    out.push(obj);
    return;
  }
  const kids = deref(doc, dictGet(obj, 'Kids'));
  const items = kids && kids.kind === 'array' ? kids.value : [];
  for (const kid of items) collectPages(doc, kid, out);
}

function pageContentStreams(doc, page) {
  const contents = deref(doc, dictGet(page, 'Contents'));
  if (!contents) return [];
  if (contents.kind === 'stream' || (contents.kind === 'dict' && contents.stream)) return [contents];
  if (contents.kind === 'array') {
    return contents.value.map((item) => deref(doc, item)).filter(Boolean);
  }
  return [];
}

function asDict(obj) {
  if (!obj) return null;
  if (obj.kind === 'stream') return obj.dict;
  if (obj.kind === 'dict') return obj;
  return null;
}

function decodeStream(doc, obj) {
  const dict = asDict(obj);
  const data = obj && obj.kind === 'stream' ? obj.data : obj && obj.stream;
  if (!dict || !data) return Buffer.alloc(0);
  const filters = filterNames(dict.get('Filter'));
  let out = Buffer.from(data);
  for (const filter of filters) {
    if (filter === 'FlateDecode' || filter === 'Fl') out = inflatePdf(out);
    else return Buffer.alloc(0);
  }
  const predictor = asNumber(dictLookup(dict, 'DecodeParms', 'Predictor'))
    || asNumber(dictLookup(dict, 'DP', 'Predictor'));
  const columns = asNumber(dictLookup(dict, 'DecodeParms', 'Columns'))
    || asNumber(dictLookup(dict, 'DP', 'Columns'));
  if (predictor && columns) out = decodePredictor(out, columns, predictor);
  return out;
}

function inflatePdf(data) {
  try {
    return inflateSync(data);
  } catch {
    try {
      return inflateRawSync(data);
    } catch {
      return Buffer.alloc(0);
    }
  }
}

function filterNames(value) {
  if (!value) return [];
  if (value.kind === 'name') return [value.value];
  if (value.kind === 'array') return value.value.filter((item) => item.kind === 'name').map((item) => item.value);
  return [];
}

function interpretContent(bytes) {
  const reader = new Reader(bytes, 0, { content: true });
  const stack = [];
  const pieces = [];
  const state = { fontSize: 12 };
  while (!reader.eof()) {
    reader.skipWsAndComments();
    if (reader.eof()) break;
    const token = reader.readContentToken();
    if (!token) break;
    if (token.kind === 'op') {
      applyOperator(token.value, stack, pieces, state);
      stack.length = 0;
    } else {
      stack.push(token);
    }
  }
  return pieces.join('');
}

function applyOperator(op, stack, pieces, state) {
  if (op === 'Tf') {
    const size = asTokenNumber(stack[stack.length - 1]);
    if (size) state.fontSize = size;
    return;
  }
  if (op === 'Td' || op === 'TD') {
    const ty = asTokenNumber(stack[stack.length - 1]);
    const tx = asTokenNumber(stack[stack.length - 2]);
    if (Number.isFinite(ty) && Math.abs(ty) > 2) pieces.push('\n');
    else if (Number.isFinite(tx) && tx > state.fontSize * 0.3) pieces.push(' ');
    return;
  }
  if (op === 'T*') {
    pieces.push('\n');
    return;
  }
  if (op === 'Tj' || op === "'") {
    if (op === "'") pieces.push('\n');
    pieces.push(tokenString(stack[stack.length - 1]));
    return;
  }
  if (op === '"') {
    pieces.push('\n', tokenString(stack[stack.length - 1]));
    return;
  }
  if (op === 'TJ') pieces.push(showTjArray(stack[stack.length - 1]));
}

function showTjArray(token) {
  if (!token || token.kind !== 'array') return tokenString(token);
  let out = '';
  for (const item of token.value) {
    if (item.kind === 'string') out += tokenString(item);
    else if (item.kind === 'number' && item.value <= TJ_SPACE_THRESHOLD) out += ' ';
  }
  return out;
}

function tokenString(token) {
  if (!token) return '';
  if (token.kind === 'string') return token.value;
  return '';
}

function asTokenNumber(token) {
  return token && token.kind === 'number' ? token.value : NaN;
}

function normalizePdfText(text) {
  const normalized = String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  if (normalized.length <= MAX_TEXT_CHARS) return normalized;
  return normalized.slice(0, MAX_TEXT_CHARS);
}

function getObject(doc, num, gen = 0) {
  const key = objKey(num, gen);
  if (doc.cache.has(key)) return deref(doc, doc.cache.get(key));
  const entry = doc.entries.get(num);
  if (!entry || entry.type === 0) return null;
  if (entry.type === 2) {
    const stm = getObject(doc, entry.stm);
    if (stm && dictName(stm, 'Type') === 'ObjStm') loadObjectStream(doc, entry.stm, stm);
    return doc.cache.get(key) || null;
  }
  const reader = new Reader(doc.bytes, entry.offset);
  const parsed = reader.readIndirectObject(doc);
  const value = parsed ? parsed.value : null;
  doc.cache.set(key, value);
  if (value && dictName(value, 'Type') === 'ObjStm') loadObjectStream(doc, num, value);
  return value;
}

function deref(doc, value) {
  let current = value;
  const seen = new Set();
  while (current && current.kind === 'ref') {
    const key = objKey(current.num, current.gen);
    if (seen.has(key)) return null;
    seen.add(key);
    current = getObject(doc, current.num, current.gen);
  }
  return current;
}

function dictGet(obj, name) {
  if (!obj) return undefined;
  if (obj.kind === 'stream') return obj.dict.get(name);
  if (obj.kind === 'dict') return obj.get(name);
  return undefined;
}

function dictName(obj, name) {
  const value = dictGet(obj, name);
  return value && value.kind === 'name' ? value.value : '';
}

function dictLookup(dict, child, name) {
  if (!dict || dict.kind !== 'dict') return undefined;
  const inner = dict.get(child);
  if (!inner || inner.kind !== 'dict') return undefined;
  return inner.get(name);
}

function asNumber(value) {
  if (value == null) return null;
  if (typeof value === 'number') return value;
  if (value.kind === 'number') return value.value;
  return null;
}

function asNumberArray(value) {
  if (!value || value.kind !== 'array') return null;
  return value.value.map((item) => asNumber(item)).filter((item) => item != null);
}

function objKey(num, gen) {
  return `${num} ${gen}`;
}

class PdfDict {
  constructor(entries) {
    this.kind = 'dict';
    this.entries = entries;
    this.stream = null;
  }

  get(name) {
    return this.entries.get(name);
  }
}

class Reader {
  constructor(buf, offset = 0, { content = false } = {}) {
    this.buf = buf;
    this.i = offset;
    this.content = content;
  }

  eof() {
    return this.i >= this.buf.length;
  }

  skipWsAndComments() {
    while (!this.eof()) {
      const c = this.buf[this.i];
      if (WHITESPACE.has(c)) {
        this.i += 1;
        continue;
      }
      if (c === 37) {
        while (!this.eof() && this.buf[this.i] !== 10 && this.buf[this.i] !== 13) this.i += 1;
        continue;
      }
      break;
    }
  }

  startsWith(text) {
    this.skipWsAndComments();
    return this.buf.subarray(this.i, this.i + text.length).toString('latin1') === text;
  }

  consume(text) {
    this.skipWsAndComments();
    if (!this.startsWith(text)) throw new Error(`expected ${text}`);
    this.i += text.length;
  }

  readTokenText(max = 128) {
    this.skipWsAndComments();
    const start = this.i;
    while (!this.eof() && this.i - start < max && !WHITESPACE.has(this.buf[this.i])) this.i += 1;
    return this.buf.subarray(start, this.i).toString('latin1');
  }

  readNumber() {
    this.skipWsAndComments();
    const start = this.i;
    if (this.buf[this.i] === 43 || this.buf[this.i] === 45) this.i += 1;
    while (!this.eof() && this.buf[this.i] >= 48 && this.buf[this.i] <= 57) this.i += 1;
    if (this.buf[this.i] === 46) {
      this.i += 1;
      while (!this.eof() && this.buf[this.i] >= 48 && this.buf[this.i] <= 57) this.i += 1;
    }
    return Number(this.buf.subarray(start, this.i).toString('latin1'));
  }

  readIndirectObject(doc) {
    this.skipWsAndComments();
    const num = this.readNumber();
    const gen = this.readNumber();
    this.skipWsAndComments();
    if (!this.startsWith('obj')) return null;
    this.consume('obj');
    const value = this.readValue(doc);
    this.skipWsAndComments();
    if (this.startsWith('endobj')) this.consume('endobj');
    return { num, gen, value };
  }

  readValue(doc) {
    this.skipWsAndComments();
    if (this.eof()) return null;
    const c = this.buf[this.i];
    if (c === 47) return this.readName();
    if (c === 40) return this.readLiteralString();
    if (c === 60) {
      if (this.buf[this.i + 1] === 60) return this.readDict(doc);
      return this.readHexString();
    }
    if (c === 91) return this.readArray(doc);
    if (c === 43 || c === 45 || c === 46 || (c >= 48 && c <= 57)) return this.readNumberOrRef();
    const word = this.readWord();
    if (word === 'true') return { kind: 'bool', value: true };
    if (word === 'false') return { kind: 'bool', value: false };
    if (word === 'null') return { kind: 'null', value: null };
    return { kind: 'op', value: word };
  }

  readContentToken() {
    this.skipWsAndComments();
    if (this.eof()) return null;
    const c = this.buf[this.i];
    if (c === 47) return this.readName();
    if (c === 40) return this.readLiteralString();
    if (c === 60) {
      if (this.buf[this.i + 1] === 60) return this.readDict(null);
      return this.readHexString();
    }
    if (c === 91) return this.readArray(null);
    if (c === 43 || c === 45 || c === 46 || (c >= 48 && c <= 57)) {
      return { kind: 'number', value: this.readNumber() };
    }
    const word = this.readWord();
    if (!word) return null;
    if (word === 'true' || word === 'false' || word === 'null') {
      return { kind: 'op', value: word };
    }
    return { kind: 'op', value: word };
  }

  readWord() {
    this.skipWsAndComments();
    const start = this.i;
    while (!this.eof()) {
      const c = this.buf[this.i];
      if (WHITESPACE.has(c) || c === 47 || c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 || c === 123 || c === 125 || c === 37) break;
      this.i += 1;
    }
    return this.buf.subarray(start, this.i).toString('latin1');
  }

  readNumberOrRef() {
    const n = this.readNumber();
    const save = this.i;
    this.skipWsAndComments();
    if (this.buf[this.i] >= 48 && this.buf[this.i] <= 57) {
      const gen = this.readNumber();
      this.skipWsAndComments();
      if (this.buf[this.i] === 82) {
        this.i += 1;
        return { kind: 'ref', num: n, gen };
      }
    }
    this.i = save;
    return { kind: 'number', value: n };
  }

  readName() {
    this.i += 1;
    let out = '';
    while (!this.eof()) {
      const c = this.buf[this.i];
      if (WHITESPACE.has(c) || c === 47 || c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 || c === 123 || c === 125 || c === 37) break;
      if (c === 35 && this.i + 2 < this.buf.length) {
        out += String.fromCharCode(parseInt(this.buf.subarray(this.i + 1, this.i + 3).toString('latin1'), 16));
        this.i += 3;
        continue;
      }
      out += String.fromCharCode(c);
      this.i += 1;
    }
    return { kind: 'name', value: out };
  }

  readLiteralString() {
    this.i += 1;
    const bytes = [];
    let depth = 1;
    while (!this.eof() && depth > 0) {
      const c = this.buf[this.i];
      this.i += 1;
      if (c === 92) {
        if (this.eof()) break;
        const n = this.buf[this.i];
        this.i += 1;
        const map = { 110: 10, 114: 13, 116: 9, 98: 8, 102: 12, 40: 40, 41: 41, 92: 92 };
        if (n in map) bytes.push(map[n]);
        else if (n >= 48 && n <= 57) {
          let oct = String.fromCharCode(n);
          for (let k = 0; k < 2 && !this.eof() && this.buf[this.i] >= 48 && this.buf[this.i] <= 57; k += 1) {
            oct += String.fromCharCode(this.buf[this.i]);
            this.i += 1;
          }
          bytes.push(parseInt(oct, 8) & 255);
        } else if (n === 13) {
          if (this.buf[this.i] === 10) this.i += 1;
        } else if (n !== 10) {
          bytes.push(n);
        }
      } else if (c === 40) {
        depth += 1;
        bytes.push(c);
      } else if (c === 41) {
        depth -= 1;
        if (depth > 0) bytes.push(c);
      } else {
        bytes.push(c);
      }
    }
    return { kind: 'string', value: decodePdfStringBytes(Buffer.from(bytes)) };
  }

  readHexString() {
    this.i += 1;
    let hex = '';
    while (!this.eof() && this.buf[this.i] !== 62) {
      const c = this.buf[this.i];
      this.i += 1;
      if (!WHITESPACE.has(c)) hex += String.fromCharCode(c);
    }
    if (this.buf[this.i] === 62) this.i += 1;
    if (hex.length % 2 === 1) hex += '0';
    const bytes = Buffer.from(hex, 'hex');
    return { kind: 'string', value: decodePdfStringBytes(bytes) };
  }

  readArray(doc) {
    this.i += 1;
    const value = [];
    while (!this.eof()) {
      this.skipWsAndComments();
      if (this.buf[this.i] === 93) {
        this.i += 1;
        break;
      }
      value.push(this.content ? this.readContentToken() : this.readValue(doc));
    }
    return { kind: 'array', value };
  }

  readDict(doc) {
    this.i += 2;
    const entries = new Map();
    while (!this.eof()) {
      this.skipWsAndComments();
      if (this.buf[this.i] === 62 && this.buf[this.i + 1] === 62) {
        this.i += 2;
        break;
      }
      const key = this.readName();
      const value = this.readValue(doc);
      entries.set(key.value, value);
    }
    const dict = new PdfDict(entries);
    const save = this.i;
    this.skipWsAndComments();
    if (this.startsWith('stream')) {
      this.consume('stream');
      dict.stream = this.readStreamData(resolveLength(doc, dict.get('Length')));
      return { kind: 'stream', dict, data: dict.stream };
    }
    this.i = save;
    return dict;
  }

  readStreamData(length) {
    if (this.buf[this.i] === 13) {
      this.i += 1;
      if (this.buf[this.i] === 10) this.i += 1;
    } else if (this.buf[this.i] === 10) {
      this.i += 1;
    }
    if (Number.isFinite(length) && length >= 0) {
      const data = Buffer.from(this.buf.subarray(this.i, this.i + length));
      this.i += length;
      this.skipWsAndComments();
      if (this.startsWith('endstream')) this.consume('endstream');
      return data;
    }
    const end = this.buf.indexOf(Buffer.from('endstream', 'latin1'), this.i);
    let data = this.buf.subarray(this.i, end < 0 ? this.buf.length : end);
    if (data.length && data[data.length - 1] === 10) data = data.subarray(0, data.length - 1);
    if (data.length && data[data.length - 1] === 13) data = data.subarray(0, data.length - 1);
    this.i = end < 0 ? this.buf.length : end + 9;
    return Buffer.from(data);
  }
}

function resolveLength(doc, value) {
  if (!value) return null;
  if (value.kind === 'number') return value.value;
  if (value.kind === 'ref' && doc) {
    const resolved = deref(doc, value);
    return asNumber(resolved);
  }
  return asNumber(value);
}

function decodePdfStringBytes(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const copy = Buffer.from(bytes.subarray(2));
    if (copy.length % 2 === 1) return bytes.toString('latin1');
    return copy.swap16().toString('utf16le');
  }
  return bytes.toString('latin1');
}
