// Maps console and exception stack frames from a production bundle back to source files (#470).
// Zero-dependency Source Map v3 support: base64 VLQ decoding, a lazy `mappings` scan for one
// generated (line, column), and `sources`/`sourceRoot` resolution. `sourcesContent` is ignored.
// The resolver never throws to its caller: a missing, oversized, slow or malformed map leaves the
// generated frame unchanged. Network access is injected (`loadText`) so this module stays pure.

export const SOURCE_MAP_LIMITS = Object.freeze({
  // Frames kept per console entry / exception and rewritten in output.
  maxFrames: 3,
  maxMapBytes: 5 * 1024 * 1024,
  // A dev server inlines its map as a base64 data: URL inside the script, so the script may
  // legitimately be larger than the map cap.
  maxScriptBytes: 12 * 1024 * 1024,
  // Wall-clock budget for one output (console, status, action receipt) to wait on map loads.
  budgetMs: 1500,
  // Per-load cap. Longer than the output budget so a slow map can finish in the background and
  // serve the next output instead of timing out on every attempt.
  loadTimeoutMs: 10_000,
  maxCachedScripts: 32,
  maxLookupMemo: 256,
  maxDisplayPath: 100,
  maxDisplayFile: 60,
  maxFrameUrl: 2048,
});

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_VALUE = new Int8Array(128).fill(-1);
for (let i = 0; i < BASE64_CHARS.length; i += 1) BASE64_VALUE[BASE64_CHARS.charCodeAt(i)] = i;

const COMMA = 44; // ','
const SEMICOLON = 59; // ';'

// Reads one VLQ value starting at `state.pos`; returns null on an invalid or truncated digit.
function readVlq(text, state) {
  let result = 0;
  let shift = 0;
  for (;;) {
    if (state.pos >= text.length) return null;
    const code = text.charCodeAt(state.pos);
    const digit = code < 128 ? BASE64_VALUE[code] : -1;
    if (digit < 0) return null;
    state.pos += 1;
    result += (digit & 31) * 2 ** shift;
    shift += 5;
    if ((digit & 32) === 0) break;
    if (shift > 35) return null;
  }
  const negative = result % 2 === 1;
  const value = Math.floor(result / 2);
  return negative ? -value : value;
}

/** Decodes one base64 VLQ segment ("AAgBC") into its signed integers, or null when malformed. */
export function decodeVlq(segment) {
  const text = String(segment ?? '');
  const state = { pos: 0 };
  const values = [];
  while (state.pos < text.length) {
    const value = readVlq(text, state);
    if (value === null) return null;
    values.push(value);
  }
  return values;
}

function urlOrNull(value, base) {
  try {
    return base === undefined ? new URL(value) : new URL(value, base);
  } catch {
    return null;
  }
}

/**
 * Resolves a `sources[i]` entry per the Source Map v3 spec: prefix `sourceRoot`, then resolve
 * relative to the map URL. Unresolvable entries come back unchanged.
 */
export function resolveSourceUrl(source, sourceRoot, baseUrl) {
  let path = String(source ?? '');
  const root = typeof sourceRoot === 'string' ? sourceRoot : '';
  if (root && !urlOrNull(path)) path = `${root.replace(/\/?$/, '/')}${path}`;
  const resolved = urlOrNull(path, baseUrl || undefined) || urlOrNull(path);
  return resolved ? resolved.href : path;
}

function tailBounded(text, max) {
  return text.length <= max ? text : `…${text.slice(text.length - (max - 1))}`;
}

/** Short, human path for a resolved source URL: `src/components/Foo.tsx`. */
export function displaySourcePath(resolved, max = SOURCE_MAP_LIMITS.maxDisplayPath) {
  const raw = String(resolved ?? '');
  const url = urlOrNull(raw);
  let path = raw;
  if (url && url.pathname && url.pathname !== '/') {
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      path = url.pathname;
    }
  }
  path = path.replace(/^\/+/, '').replace(/^\.\//, '');
  return tailBounded(path || raw, max);
}

/** Basename of a script URL without query or hash: `index-3fa9c2.js`. */
export function displayScriptFile(scriptUrl, max = SOURCE_MAP_LIMITS.maxDisplayFile) {
  const raw = String(scriptUrl ?? '');
  const url = urlOrNull(raw);
  const path = url ? url.pathname : raw.split(/[?#]/)[0];
  const file = path.split('/').filter(Boolean).pop() || (url ? url.host : '') || '';
  return tailBounded(file, max);
}

/**
 * Parses a Source Map v3 document. `baseUrl` is the URL relative sources resolve against (the map
 * URL, or the script URL for an inline data: map). Index maps (`sections`) and invalid JSON return
 * null so the caller keeps the generated frame.
 */
export function parseSourceMap(text, baseUrl = '') {
  let json;
  try {
    json = JSON.parse(String(text ?? '').replace(/^\)\]\}'[^\n]*\n/, ''));
  } catch {
    return null;
  }
  if (!json || typeof json !== 'object' || json.version !== 3) return null;
  if (typeof json.mappings !== 'string' || !Array.isArray(json.sources)) return null;
  return {
    sources: json.sources.map(source => (source == null ? null : resolveSourceUrl(source, json.sourceRoot, baseUrl))),
    names: Array.isArray(json.names) ? json.names : [],
    mappings: json.mappings,
    memo: new Map(),
  };
}

function scanOriginalPosition(map, line, column) {
  const text = map.mappings;
  const state = { pos: 0 };
  let genLine = 0;
  let genColumn = 0;
  let sourceIndex = 0;
  let sourceLine = 0;
  let sourceColumn = 0;
  let nameIndex = 0;
  let best = null;
  while (state.pos < text.length && genLine <= line) {
    const code = text.charCodeAt(state.pos);
    if (code === SEMICOLON) {
      if (genLine === line) break;
      genLine += 1;
      genColumn = 0; // the generated column resets per line; other fields are relative map-wide
      state.pos += 1;
      continue;
    }
    if (code === COMMA) {
      state.pos += 1;
      continue;
    }
    const values = [];
    while (state.pos < text.length) {
      const next = text.charCodeAt(state.pos);
      if (next === COMMA || next === SEMICOLON) break;
      const value = readVlq(text, state);
      if (value === null) return null;
      values.push(value);
    }
    if (values.length === 0) continue;
    genColumn += values[0];
    if (values.length >= 4) {
      sourceIndex += values[1];
      sourceLine += values[2];
      sourceColumn += values[3];
      if (values.length >= 5) nameIndex += values[4];
    }
    if (genLine !== line) continue;
    if (genColumn > column) break;
    best = values.length >= 4
      ? { sourceIndex, sourceLine, sourceColumn, nameIndex: values.length >= 5 ? nameIndex : -1 }
      : null; // a 1-field segment marks generated code with no original
  }
  if (!best) return null;
  const source = map.sources[best.sourceIndex];
  if (typeof source !== 'string' || !source) return null;
  return {
    source,
    line: best.sourceLine + 1,
    column: best.sourceColumn + 1,
    name: best.nameIndex >= 0 && typeof map.names[best.nameIndex] === 'string' ? map.names[best.nameIndex] : null,
  };
}

/**
 * Original position for a 0-based generated (line, column), using the greatest mapped segment at
 * or before `column` on that line. Returns 1-based line/column, or null when unmapped.
 */
export function lookupOriginalPosition(map, line, column, limits = SOURCE_MAP_LIMITS) {
  if (!map || !Number.isInteger(line) || !Number.isInteger(column) || line < 0 || column < 0) return null;
  const key = `${line}:${column}`;
  if (map.memo.has(key)) return map.memo.get(key);
  const result = scanOriginalPosition(map, line, column);
  if (map.memo.size >= limits.maxLookupMemo) map.memo.delete(map.memo.keys().next().value);
  map.memo.set(key, result);
  return result;
}

/**
 * Returns the `//# sourceMappingURL=` reference from the end of a script, or null. Only the last
 * comment counts, and only when nothing but whitespace or further line comments follows it.
 */
export function extractSourceMappingUrl(script) {
  const text = String(script ?? '');
  const index = Math.max(text.lastIndexOf('//# sourceMappingURL='), text.lastIndexOf('//@ sourceMappingURL='));
  if (index < 0) return null;
  const start = index + '//# sourceMappingURL='.length;
  let end = start;
  while (end < text.length && !/[\s'"]/.test(text[end])) end += 1;
  if (end === start) return null;
  const rest = text.slice(end).trim();
  if (rest && !rest.startsWith('//')) return null;
  return text.slice(start, end);
}

/** Decodes a `data:` URL body as UTF-8 text, or null when malformed or larger than `maxBytes`. */
export function decodeDataUrl(url, maxBytes = SOURCE_MAP_LIMITS.maxMapBytes) {
  const text = String(url ?? '');
  if (!/^data:/i.test(text)) return null;
  const comma = text.indexOf(',');
  if (comma < 0) return null;
  const meta = text.slice(5, comma);
  const body = text.slice(comma + 1);
  try {
    if (/;base64$/i.test(meta)) {
      if (Math.floor(body.length * 3 / 4) > maxBytes) return null;
      return Buffer.from(body, 'base64').toString('utf8');
    }
    if (body.length > maxBytes * 3) return null;
    const decoded = decodeURIComponent(body);
    return Buffer.byteLength(decoded, 'utf8') > maxBytes ? null : decoded;
  } catch {
    return null;
  }
}

function frameNumber(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

/**
 * Keeps up to `maxFrames` CDP call frames that name a script URL. `fallback` is the
 * exceptionDetails location used when no stack trace was captured. Line/column stay 0-based.
 */
export function captureStackFrames(stackTrace, fallback = null, limits = SOURCE_MAP_LIMITS) {
  const frames = [];
  const push = (frame) => {
    const url = typeof frame?.url === 'string' ? frame.url : '';
    if (!url || frames.length >= limits.maxFrames) return;
    frames.push({
      url: url.slice(0, limits.maxFrameUrl),
      line: frameNumber(frame.lineNumber),
      column: frameNumber(frame.columnNumber),
    });
  };
  for (const frame of Array.isArray(stackTrace?.callFrames) ? stackTrace.callFrames : []) push(frame);
  if (frames.length === 0 && fallback) push(fallback);
  return frames;
}

/** `index-3fa9c2.js:1:48213` (1-based) for a captured frame, or '' when it has no script name. */
export function formatGeneratedFrame(frame) {
  const file = displayScriptFile(frame?.url);
  if (!file) return '';
  return `${file}:${frameNumber(frame.line) + 1}:${frameNumber(frame.column) + 1}`;
}

/** `src/components/Foo.tsx:42:7 (index-3fa9c2.js:1:48213)`, or the generated frame alone. */
export function formatMappedFrame(frame, original) {
  const generated = formatGeneratedFrame(frame);
  if (!original) return generated;
  const mapped = `${displaySourcePath(original.source)}:${original.line}:${original.column}`;
  return generated ? `${mapped} (${generated})` : mapped;
}

function cacheKey(scriptUrl) {
  const url = urlOrNull(scriptUrl);
  if (!url || !['http:', 'https:', 'file:'].includes(url.protocol)) return null;
  url.hash = '';
  return url.href;
}

function byteLength(text) {
  return Buffer.byteLength(String(text ?? ''), 'utf8');
}

/**
 * Per-daemon resolver. `loadText(url, { kind: 'script' | 'map', maxBytes, timeoutMs })` returns
 * the resource text, null when the resource is definitively unavailable (HTTP error, too large),
 * or throws on a transient failure (CDP timeout, frame mid-navigation). It is only called for
 * http(s)/file URLs. Maps and definitive misses are cached per script URL until `clear()`; a
 * transient failure is dropped from the cache so the next output tries again.
 */
export function createSourceMapResolver({ loadText, now = Date.now, limits = SOURCE_MAP_LIMITS } = {}) {
  const cache = new Map();

  async function loadMap(scriptUrl) {
    const script = await loadText(scriptUrl, {
      kind: 'script',
      maxBytes: limits.maxScriptBytes,
      timeoutMs: limits.loadTimeoutMs,
    });
    if (typeof script !== 'string' || byteLength(script) > limits.maxScriptBytes) return null;
    const reference = extractSourceMappingUrl(script);
    if (!reference) return null;
    const mapUrl = urlOrNull(reference, scriptUrl);
    if (!mapUrl) return null;
    if (mapUrl.protocol === 'data:') {
      const inline = decodeDataUrl(mapUrl.href, limits.maxMapBytes);
      return inline === null ? null : parseSourceMap(inline, scriptUrl);
    }
    if (!['http:', 'https:', 'file:'].includes(mapUrl.protocol)) return null;
    const text = await loadText(mapUrl.href, {
      kind: 'map',
      maxBytes: limits.maxMapBytes,
      timeoutMs: limits.loadTimeoutMs,
    });
    if (typeof text !== 'string' || byteLength(text) > limits.maxMapBytes) return null;
    return parseSourceMap(text, mapUrl.href);
  }

  function mapFor(scriptUrl) {
    const key = cacheKey(scriptUrl);
    if (!key) return Promise.resolve(null);
    if (cache.has(key)) {
      const hit = cache.get(key);
      cache.delete(key);
      cache.set(key, hit);
      return hit;
    }
    const pending = Promise.resolve()
      .then(() => loadMap(key))
      .catch(() => {
        if (cache.get(key) === pending) cache.delete(key);
        return null;
      });
    cache.set(key, pending);
    while (cache.size > limits.maxCachedScripts) cache.delete(cache.keys().next().value);
    return pending;
  }

  async function withinDeadline(promise, deadline) {
    const remaining = deadline - now();
    if (remaining <= 0) return { timedOut: true, value: null };
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ timedOut: true, value: null }), remaining);
      timer.unref?.();
    });
    try {
      return await Promise.race([promise.then(value => ({ timedOut: false, value })), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Display strings for each frame: mapped when a map resolves in time, generated otherwise. */
  async function resolveFrames(frames, { deadline = now() + limits.budgetMs } = {}) {
    const list = (Array.isArray(frames) ? frames : []).slice(0, limits.maxFrames);
    return Promise.all(list.map(async (frame) => {
      try {
        const { value: map } = await withinDeadline(mapFor(frame.url), deadline);
        return formatMappedFrame(frame, map ? lookupOriginalPosition(map, frame.line, frame.column, limits) : null);
      } catch {
        return formatGeneratedFrame(frame);
      }
    }));
  }

  /**
   * Resolves the frames of many buffer entries under one shared deadline. Returns a Map from
   * entry to `{ loc, stack }`; entries without captured frames are absent.
   */
  async function locateEntries(entries, { budgetMs = limits.budgetMs } = {}) {
    const deadline = now() + budgetMs;
    const located = new Map();
    await Promise.all((Array.isArray(entries) ? entries : []).map(async (entry) => {
      if (!Array.isArray(entry?.frames) || entry.frames.length === 0) return;
      const stack = (await resolveFrames(entry.frames, { deadline })).filter(Boolean);
      if (stack.length) located.set(entry, { loc: stack[0], stack });
    }));
    return located;
  }

  return {
    resolveFrames,
    locateEntries,
    clear: () => cache.clear(),
    get size() {
      return cache.size;
    },
  };
}
