// netlog request detail (#467): a short stable id per tracked request, bounded
// per-request detail captured from Network events, list filters, and the
// redacted list/detail models. CDP calls (Network.getResponseBody) stay in
// cdp.mjs; this module only sees event params and the body payload.

import { closeSync, constants as FS_CONSTANTS, fchmodSync, lstatSync, openSync, writeSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import {
  REDACTED_VALUE,
  isSensitiveKey,
  redactJsonText,
  redactJwts,
  redactMarkupSecrets,
  redactSensitiveString,
  redactUrl,
  sensitiveKeyTokens,
} from './redaction.mjs';

export const NETLOG_SCHEMA = 'chrome-cdp-ex.netlog.v1';
export const NETLOG_REQUEST_SCHEMA = 'chrome-cdp-ex.netlog-request.v1';
export const NETLOG_BODY_PREVIEW_BYTES = 4096;

const DETAIL_CAPACITY = 150;
const EARLY_EXTRA_CAPACITY = 200;
const IGNORED_REQUEST_CAPACITY = 1000;
const MAX_URL_CHARS = 2048;
const MAX_HEADERS = 64;
const MAX_HEADER_VALUE_CHARS = 1024;
const MAX_REDIRECTS = 10;
const MAX_ERROR_CHARS = 300;

// Network.ResourceType values, lower-cased, for --type validation.
const RESOURCE_TYPES = new Set([
  'document', 'stylesheet', 'image', 'media', 'font', 'script', 'texttrack', 'xhr', 'fetch',
  'prefetch', 'eventsource', 'websocket', 'manifest', 'signedexchange', 'ping',
  'cspviolationreport', 'preflight', 'fedcm', 'other',
]);
const STATUS_FILTER_RE = /^(?:[1-5]xx|[1-5]\d\d|failed|pending)$/;
const URL_VALUED_HEADERS = new Set(['location', 'content-location', 'referer', 'referrer', 'origin']);
// Policy headers hold directives, not secrets: `identity-credentials-get=()` must
// stay readable. Only URLs and JWTs inside them are redacted.
const POLICY_HEADERS = new Set([
  'permissions-policy', 'feature-policy', 'document-policy', 'content-security-policy',
  'content-security-policy-report-only', 'report-to', 'reporting-endpoints', 'nel', 'accept-ch',
]);
const URL_IN_TEXT_RE = /\bhttps?:\/\/[^\s"'<>;,)]+/gi;
const JSON_MIME_RE = /[/+]json\b/i;
const TEXT_MIME_RE = /^text\/|[/+](?:json|xml|javascript|ecmascript|x-www-form-urlencoded|graphql|csv|yaml|x-yaml)\b/i;

function clip(value, max) {
  const text = String(value ?? '');
  return text.length > max ? { text: text.slice(0, max), truncated: true } : { text, truncated: false };
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function captureHeaders(headers) {
  const out = {};
  let truncated = false;
  let count = 0;
  for (const [name, value] of Object.entries(headers && typeof headers === 'object' ? headers : {})) {
    count += 1;
    if (count > MAX_HEADERS) { truncated = true; continue; }
    const clipped = clip(value, MAX_HEADER_VALUE_CHARS);
    if (clipped.truncated) truncated = true;
    out[String(name)] = clipped.text;
  }
  return { headers: out, count, truncated };
}

function initiatorOf(initiator) {
  if (!initiator || typeof initiator !== 'object') return null;
  const frame = initiator.stack?.callFrames?.find(callFrame => callFrame?.url);
  const url = initiator.url || frame?.url || '';
  return { type: String(initiator.type || 'other'), url: clip(url, MAX_URL_CHARS).text };
}

function statusTextFromHeadersText(headersText) {
  const firstLine = String(headersText || '').split(/\r?\n/, 1)[0];
  const match = firstLine.match(/^HTTP\/[\d.]+\s+\d{3}\s+(.*)$/i);
  return match ? match[1].trim() : '';
}

function timingPhase(start, end) {
  return Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end >= start ? round1(end - start) : null;
}

function timingOf(timing) {
  if (!timing || typeof timing !== 'object') return null;
  return {
    dnsMs: timingPhase(timing.dnsStart, timing.dnsEnd),
    connectMs: timingPhase(timing.connectStart, timing.connectEnd),
    sslMs: timingPhase(timing.sslStart, timing.sslEnd),
    sendMs: timingPhase(timing.sendStart, timing.sendEnd),
    waitMs: timingPhase(timing.sendEnd, timing.receiveHeadersEnd),
    receiveHeadersEndMs: Number.isFinite(timing.receiveHeadersEnd) && timing.receiveHeadersEnd >= 0
      ? round1(timing.receiveHeadersEnd)
      : null,
  };
}

// One store per daemon. Ids grow monotonically and are never reused (also not
// after clear()), so an id printed by `netlog` keeps naming the same request.
export function createNetlogRequestStore({ capacity = DETAIL_CAPACITY, shouldTrack = () => true, now = Date.now } = {}) {
  let seq = 0;
  const byId = new Map();
  const idByRequestId = new Map();
  // ExtraInfo events can arrive before requestWillBeSent for the same request.
  // They are held clipped (headers, status code and text only; no
  // associatedCookies or raw headersText) until their request shows up.
  const earlyExtra = new Map();
  // Requests that shouldTrack rejected: their late ExtraInfo is dropped.
  const ignored = new Set();

  function detailFor(requestId) {
    const id = idByRequestId.get(requestId);
    return id === undefined ? null : byId.get(id) || null;
  }

  function evict() {
    while (byId.size > capacity) {
      const [oldestId, oldest] = byId.entries().next().value;
      byId.delete(oldestId);
      if (idByRequestId.get(oldest.requestId) === oldestId) idByRequestId.delete(oldest.requestId);
    }
  }

  function rememberEarly(requestId, patch) {
    const current = earlyExtra.get(requestId) || {};
    earlyExtra.delete(requestId);
    earlyExtra.set(requestId, { ...current, ...patch });
    while (earlyExtra.size > EARLY_EXTRA_CAPACITY) earlyExtra.delete(earlyExtra.keys().next().value);
  }

  function rememberIgnored(requestId) {
    earlyExtra.delete(requestId);
    ignored.delete(requestId);
    ignored.add(requestId);
    while (ignored.size > IGNORED_REQUEST_CAPACITY) ignored.delete(ignored.values().next().value);
  }

  function clipRequestExtra(params) {
    return { captured: captureHeaders(params.headers) };
  }

  function clipResponseExtra(params) {
    return {
      captured: captureHeaders(params.headers),
      statusCode: Number.isFinite(Number(params.statusCode)) ? Number(params.statusCode) : null,
      statusText: statusTextFromHeadersText(params.headersText),
    };
  }

  function applyRequestExtra(detail, { captured }) {
    detail.requestHeaders = captured.headers;
    detail.requestHeaderCount = captured.count;
    detail.requestHeadersTruncated = captured.truncated;
    detail.requestHeadersSource = 'extra-info';
  }

  function applyResponseExtra(detail, { captured, statusCode, statusText }) {
    detail.responseHeaders = captured.headers;
    detail.responseHeaderCount = captured.count;
    detail.responseHeadersTruncated = captured.truncated;
    detail.responseHeadersSource = 'extra-info';
    if (detail.status == null && statusCode != null) detail.status = statusCode;
    if (!detail.statusText) detail.statusText = statusText;
  }

  function resetResponse(detail) {
    Object.assign(detail, {
      status: null,
      statusText: '',
      mimeType: '',
      protocol: '',
      fromCache: false,
      fromServiceWorker: false,
      responseHeaders: null,
      responseHeaderCount: 0,
      responseHeadersTruncated: false,
      responseHeadersSource: null,
      timing: null,
    });
  }

  const handlers = {
    'Network.requestWillBeSent': (params = {}) => {
      const requestId = params.requestId;
      if (!requestId || !params.request) return;
      const request = params.request;
      const url = clip(request.url, MAX_URL_CHARS);
      const captured = captureHeaders(request.headers);
      const existing = detailFor(requestId);
      if (existing && params.redirectResponse) {
        // Same requestId across a redirect: keep the id, record the hop.
        if (existing.redirects.length < MAX_REDIRECTS) {
          existing.redirects.push({ status: params.redirectResponse.status ?? null, url: existing.url });
        }
        resetResponse(existing);
        Object.assign(existing, {
          method: String(request.method || 'GET'),
          url: url.text,
          urlTruncated: url.truncated,
          requestHeaders: captured.headers,
          requestHeaderCount: captured.count,
          requestHeadersTruncated: captured.truncated,
          requestHeadersSource: 'request',
        });
        return;
      }
      if (!shouldTrack(params.type)) {
        rememberIgnored(requestId);
        return;
      }
      const id = ++seq;
      const detail = {
        id,
        requestId,
        method: String(request.method || 'GET'),
        url: url.text,
        urlTruncated: url.truncated,
        resourceType: String(params.type || 'Other'),
        initiator: initiatorOf(params.initiator),
        hasPostData: request.hasPostData === true,
        startedAt: Number.isFinite(params.wallTime) ? Math.round(params.wallTime * 1000) : now(),
        startTimestamp: Number.isFinite(params.timestamp) ? params.timestamp : null,
        endTimestamp: null,
        requestHeaders: captured.headers,
        requestHeaderCount: captured.count,
        requestHeadersTruncated: captured.truncated,
        requestHeadersSource: 'request',
        state: 'pending',
        encodedDataLength: null,
        errorText: null,
        canceled: false,
        blockedReason: null,
        corsError: null,
        redirects: [],
      };
      resetResponse(detail);
      byId.set(id, detail);
      idByRequestId.set(requestId, id);
      const early = earlyExtra.get(requestId);
      if (early) {
        earlyExtra.delete(requestId);
        if (early.request) applyRequestExtra(detail, early.request);
        if (early.response) applyResponseExtra(detail, early.response);
      }
      evict();
    },
    'Network.requestWillBeSentExtraInfo': (params = {}) => {
      if (!params.requestId || ignored.has(params.requestId)) return;
      const detail = detailFor(params.requestId);
      if (detail) applyRequestExtra(detail, clipRequestExtra(params));
      else rememberEarly(params.requestId, { request: clipRequestExtra(params) });
    },
    'Network.responseReceived': (params = {}) => {
      const detail = detailFor(params.requestId);
      const response = params.response;
      if (!detail || !response) return;
      if (Number.isFinite(Number(response.status))) detail.status = Number(response.status);
      if (response.statusText) detail.statusText = String(response.statusText);
      detail.mimeType = String(response.mimeType || '');
      detail.protocol = String(response.protocol || '');
      detail.fromCache = response.fromDiskCache === true || response.fromPrefetchCache === true;
      detail.fromServiceWorker = response.fromServiceWorker === true;
      detail.timing = timingOf(response.timing);
      if (params.type) detail.resourceType = String(params.type);
      // ExtraInfo carries the raw headers (Set-Cookie included); keep them when they came first.
      if (detail.responseHeadersSource !== 'extra-info') {
        const captured = captureHeaders(response.headers);
        detail.responseHeaders = captured.headers;
        detail.responseHeaderCount = captured.count;
        detail.responseHeadersTruncated = captured.truncated;
        detail.responseHeadersSource = 'response';
      }
    },
    'Network.responseReceivedExtraInfo': (params = {}) => {
      if (!params.requestId || ignored.has(params.requestId)) return;
      const detail = detailFor(params.requestId);
      if (detail) applyResponseExtra(detail, clipResponseExtra(params));
      else rememberEarly(params.requestId, { response: clipResponseExtra(params) });
    },
    'Network.loadingFinished': (params = {}) => {
      const detail = detailFor(params.requestId);
      if (!detail) return;
      detail.state = 'complete';
      detail.encodedDataLength = Number.isFinite(params.encodedDataLength) ? params.encodedDataLength : null;
      detail.endTimestamp = Number.isFinite(params.timestamp) ? params.timestamp : null;
    },
    'Network.loadingFailed': (params = {}) => {
      const detail = detailFor(params.requestId);
      if (!detail) return;
      detail.state = 'failed';
      detail.errorText = clip(params.errorText || 'loadingFailed', MAX_ERROR_CHARS).text;
      detail.canceled = params.canceled === true;
      detail.blockedReason = params.blockedReason ? String(params.blockedReason) : null;
      detail.corsError = params.corsErrorStatus?.corsError ? String(params.corsErrorStatus.corsError) : null;
      detail.endTimestamp = Number.isFinite(params.timestamp) ? params.timestamp : null;
      if (params.type) detail.resourceType = String(params.type);
    },
  };

  return {
    handlers,
    idFor: requestId => idByRequestId.get(requestId) ?? null,
    get: id => byId.get(Number(id)) || null,
    clear() {
      byId.clear();
      idByRequestId.clear();
      earlyExtra.clear();
      ignored.clear();
    },
    get size() { return byId.size; },
    get pendingExtraInfo() { return earlyExtra.size; },
  };
}

// --- Arguments and filters ---

function splitList(value) {
  return String(value ?? '').split(',').map(part => part.trim()).filter(Boolean);
}

function requireValue(args, index, flag) {
  const value = args[index];
  if (value === undefined || String(value).startsWith('--')) throw new Error(`netlog: ${flag} requires a value`);
  return String(value);
}

export function parseNetlogRequestId(value) {
  const raw = String(value ?? '').trim().replace(/^#/, '');
  if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new Error(`netlog: --id requires a request number such as 12 or #12 (got ${value ?? 'nothing'})`);
  return Number(raw);
}

export function parseNetlogArgs(args = []) {
  const opts = {
    clear: false,
    unsafeFull: false,
    includeBody: false,
    format: 'text',
    id: null,
    out: null,
    overwrite: false,
    types: [],
    url: null,
    status: [],
  };
  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i]);
    if (arg === '--clear') opts.clear = true;
    else if (arg === '--body') opts.includeBody = true;
    else if (arg === '--unsafe-full') opts.unsafeFull = true;
    else if (arg === '--format') {
      const value = requireValue(args, ++i, '--format');
      if (value !== 'text' && value !== 'json') throw new Error('netlog: --format must be text or json');
      opts.format = value;
    } else if (arg === '--id') opts.id = parseNetlogRequestId(requireValue(args, ++i, '--id'));
    else if (arg === '--out') opts.out = requireValue(args, ++i, '--out');
    else if (arg === '--overwrite') opts.overwrite = true;
    else if (arg === '--type') {
      for (const type of splitList(requireValue(args, ++i, '--type'))) {
        const lower = type.toLowerCase();
        if (!RESOURCE_TYPES.has(lower)) throw new Error(`netlog: --type ${type} is not a resource type (use xhr, fetch, document, script, …)`);
        if (!opts.types.includes(lower)) opts.types.push(lower);
      }
    } else if (arg === '--url') opts.url = requireValue(args, ++i, '--url');
    else if (arg === '--status') {
      for (const status of splitList(requireValue(args, ++i, '--status'))) {
        const lower = status.toLowerCase();
        if (!STATUS_FILTER_RE.test(lower)) throw new Error(`netlog: --status ${status} must be 4xx, 5xx, failed, pending or an HTTP code`);
        if (!opts.status.includes(lower)) opts.status.push(lower);
      }
    } else throw new Error(`netlog: unknown argument ${arg}. Use --id N, --body, --type, --url, --status, --format json, --out FILE, --overwrite, --clear or --unsafe-full.`);
  }
  const listFilters = opts.types.length || opts.url != null || opts.status.length;
  if (opts.clear && (opts.id != null || listFilters || opts.out || opts.includeBody)) throw new Error('netlog: --clear cannot be combined with --id, --out, --body or filters');
  if (opts.id != null && listFilters) throw new Error('netlog: --id cannot be combined with --type, --url or --status');
  if (opts.includeBody && opts.id == null) throw new Error('netlog: --body requires --id N');
  if (opts.out && opts.id == null) throw new Error('netlog: --out requires --id N (it saves one response body)');
  if (opts.overwrite && !opts.out) throw new Error('netlog: --overwrite only applies to --out FILE');
  return opts;
}

function entryFailed(entry) {
  return entry?.failed === true || Boolean(entry?.errorText);
}

function statusMatches(entry, token) {
  if (token === 'failed') return entryFailed(entry);
  if (token === 'pending') return entry?.pending === true || entry?.status === 'pending';
  const status = Number(entry?.status);
  if (!Number.isInteger(status)) return false;
  if (/^[1-5]xx$/.test(token)) return Math.floor(status / 100) === Number(token[0]);
  return status === Number(token);
}

// `url` is matched against the URL as displayed (redacted unless unsafeFull),
// so a filter cannot be used to probe a redacted secret value.
export function netlogEntryMatches(entry, { types = [], url = null, status = [] } = {}, { unsafeFull = false } = {}) {
  if (types.length && !types.includes(String(entry?.type || '').toLowerCase())) return false;
  if (url != null) {
    const shown = unsafeFull ? String(entry?.url || '') : redactUrl(entry?.url || '');
    if (!shown.toLowerCase().includes(String(url).toLowerCase())) return false;
  }
  if (status.length && !status.some(token => statusMatches(entry, token))) return false;
  return true;
}

// --- List model ---

function formatSize(size) {
  const bytes = Number(size) || 0;
  return bytes > 1024 ? `${(bytes / 1024).toFixed(1)}KB` : `${bytes}B`;
}

function listStatus(entry) {
  if (entry.pending === true || entry.status === 'pending') return 'pending';
  if (entryFailed(entry)) return 'failed';
  return Number.isFinite(Number(entry.status)) && entry.status !== null ? Number(entry.status) : null;
}

function hasFilters(filters = {}) {
  return Boolean(filters.types?.length || filters.url != null || filters.status?.length);
}

// `entries` are netReqBuf entries (already cut to the current navigation). A
// request seen as `pending` and later finished appears once, as its last entry.
// The buffer entry is written at responseReceived, before the body arrives, so
// the transferred size comes from the stored detail once loadingFinished fired.
export function buildNetlogListModel(entries = [], { idFor = () => null, detailFor = () => null, filters = {}, unsafeFull = false, targetId = '', now = Date.now() } = {}) {
  const byKey = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const id = entry?.requestId != null ? idFor(entry.requestId) : null;
    const key = id != null ? `id:${id}` : `seq:${byKey.size}:${entry?._seq ?? ''}`;
    if (byKey.has(key)) byKey.delete(key);
    byKey.set(key, { entry, id });
  }
  const all = [...byKey.values()];
  const shown = all.filter(({ entry }) => netlogEntryMatches(entry, filters, { unsafeFull }));
  const requests = shown.map(({ entry, id }) => {
    const detail = id != null ? detailFor(id) : null;
    return {
      id,
      method: String(entry.method || 'GET'),
      url: unsafeFull ? String(entry.url || '') : redactUrl(entry.url || ''),
      type: String(entry.type || ''),
      status: listStatus(entry),
      errorText: entry.errorText ? String(entry.errorText) : null,
      durationMs: Number.isFinite(entry.duration) ? entry.duration : null,
      size: Number(detail?.encodedDataLength) || Number(entry.size) || 0,
      // #648: a response whose body never finished (for example a no-store body the page did
      // not read) has no transferred size yet; 0B would read as an empty body.
      ...(detail?.state === 'pending' && detail.status != null ? { bodyFinished: false } : {}),
      ageMs: Number.isFinite(entry.ts) ? Math.max(0, now - entry.ts) : null,
    };
  });
  const target = targetId || '<target>';
  const newestFirst = [...requests].reverse();
  const pick = newestFirst.find(request => request.id != null && (request.status === 'failed' || Number(request.status) >= 400))
    || newestFirst.find(request => request.id != null);
  return {
    schema: NETLOG_SCHEMA,
    targetId: targetId || null,
    redacted: !unsafeFull,
    filters: {
      types: [...(filters.types || [])],
      url: filters.url ?? null,
      status: [...(filters.status || [])],
    },
    total: all.length,
    count: requests.length,
    requests,
    nextSteps: pick ? [`cdp netlog ${target} --id ${pick.id}`] : [],
  };
}

export function formatNetlogListText(model) {
  if (model.total === 0) return 'No network requests captured (tracking action-relevant requests; static assets are skipped)';
  const filtered = hasFilters(model.filters);
  if (model.count === 0) return `No captured requests match the filters (${model.total} captured). Next: cdp netlog ${model.targetId || '<target>'}`;
  const header = filtered
    ? `Network requests (${model.count} of ${model.total})`
    : `Network requests (${model.count})`;
  const lines = [`${header}${model.redacted ? '' : ' [unsafe-full: URLs not redacted]'}:`];
  for (const request of model.requests) {
    const ago = request.ageMs == null ? '' : ` ${Math.round(request.ageMs / 1000)}s ago`;
    const status = request.status === 'failed'
      ? `failed${request.errorText ? ` (${request.errorText})` : ''}`
      : String(request.status ?? '?');
    const id = request.id != null ? `#${request.id}` : '#-';
    const size = request.bodyFinished === false ? 'body not finished' : formatSize(request.size);
    lines.push(`  ${id} ${request.method} ${request.url} → ${status} (${request.durationMs ?? '?'}ms, ${size})${ago}`);
  }
  if (model.nextSteps.length) lines.push(`Next: ${model.nextSteps[0]}`);
  return lines.join('\n');
}

// --- Detail model ---

// Header names use the URL-query rules too, so `X-Hub-Signature-256` and
// `X-Signature` count as secrets; `X-Firebase-AppCheck` is a token by another name.
export function isSensitiveHeaderName(name) {
  const lower = String(name || '').toLowerCase();
  // CORS headers (`Access-Control-Allow-Credentials`) describe policy, not secrets.
  if (lower.startsWith('access-control-')) return false;
  if (isSensitiveKey(lower, { urlQuery: true })) return true;
  return sensitiveKeyTokens(lower).join('').includes('appcheck');
}

function redactUrlsInText(value) {
  return redactJwts(String(value ?? '').replace(URL_IN_TEXT_RE, url => redactUrl(url)));
}

export function redactHeaderValue(name, value) {
  if (isSensitiveHeaderName(name)) return REDACTED_VALUE;
  const lower = String(name || '').toLowerCase();
  if (URL_VALUED_HEADERS.has(lower)) return redactJwts(redactUrl(value));
  // `Link: <https://…?token=…>; rel=next` keeps its angle brackets.
  if (lower === 'link') return redactJwts(String(value ?? '').replace(/<([^<>]*)>/g, (match, url) => `<${redactUrl(url)}>`));
  if (POLICY_HEADERS.has(lower)) return redactUrlsInText(value);
  return redactSensitiveString(value);
}

// Body text (#467): JSON is parsed and redacted structurally, so a secret under
// an object- or array-valued key is hidden whole and the result still parses.
// Other text gets the markup rules (csrf inputs and meta, password inputs,
// `<token>` elements) and then the string rules. Best effort, not a guarantee.
// JSON behind an anti-hijacking prefix (`)]}'`, `while(1);`, `for(;;);`) is
// redacted as JSON and keeps its prefix.
const JSON_HIJACK_PREFIX_RE = /^(?:\)\]\}',?|while\s*\(\s*1\s*\)\s*;|for\s*\(\s*;\s*;\s*\)\s*;)[ \t]*\r?\n?/;

// Also redacted as JSON (#513): a UTF-8 byte-order mark in front, JSONP
// (`cb({...});`, `/**/ jQuery123(...)`), and NDJSON (every non-blank line is a
// JSON object or array).
const JSONP_HEAD_RE = /^\s*(?:\/\*\*\/\s*)?[A-Za-z_$][\w$.]{0,128}\s*\(\s*/;

export function redactBodyText(text, { mimeType = '' } = {}) {
  const source = String(text ?? '');
  const structured = redactStructuredBody(source);
  if (structured != null) return structured;
  if (JSON_MIME_RE.test(String(mimeType || ''))) return redactSensitiveString(source);
  return redactSensitiveString(redactMarkupSecrets(source));
}

// The body redacted as JSON, or null when it is none of the JSON shapes.
function redactStructuredBody(source) {
  const bom = source.startsWith('\uFEFF') ? '\uFEFF' : '';
  const body = source.slice(bom.length);
  const prefix = body.match(JSON_HIJACK_PREFIX_RE)?.[0] || '';
  const json = redactJsonText(body.slice(prefix.length));
  if (json) return json.changed ? `${bom}${prefix}${json.text}` : source;
  const jsonp = splitJsonp(body);
  const inner = jsonp && redactJsonText(jsonp.json);
  if (inner) return inner.changed ? `${bom}${jsonp.head}${inner.text}${jsonp.tail}` : source;
  const ndjson = redactNdjson(body);
  return ndjson == null ? null : `${bom}${ndjson}`;
}

function isJsWhitespace(char) {
  return char !== undefined && char.trim() === '';
}

// `head(` JSON `)` `;`: the tail is found by walking back from the end, not by
// an end-anchored regex, which would backtrack over a long whitespace run.
function splitJsonp(body) {
  const head = body.match(JSONP_HEAD_RE)?.[0];
  if (!head) return null;
  let end = body.length;
  while (end > head.length && isJsWhitespace(body[end - 1])) end--;
  if (body[end - 1] === ';') end--;
  while (end > head.length && isJsWhitespace(body[end - 1])) end--;
  if (end <= head.length || body[end - 1] !== ')') return null;
  end--;
  while (end > head.length && isJsWhitespace(body[end - 1])) end--;
  return { head, json: body.slice(head.length, end), tail: body.slice(end) };
}

function redactNdjson(body) {
  const parts = body.split(/(\r?\n)/);
  let lines = 0;
  let changed = false;
  for (let i = 0; i < parts.length; i += 2) {
    if (parts[i].trim() === '') continue;
    const json = redactJsonText(parts[i]);
    if (!json) return null;
    lines++;
    if (json.changed) {
      parts[i] = json.text;
      changed = true;
    }
  }
  if (lines < 2) return null;
  return changed ? parts.join('') : body;
}

export function redactHeaders(headers, { unsafeFull = false } = {}) {
  const out = {};
  for (const [name, value] of Object.entries(headers || {})) {
    out[name] = unsafeFull ? String(value) : redactHeaderValue(name, value);
  }
  return out;
}

function isTextMime(mimeType) {
  return TEXT_MIME_RE.test(String(mimeType || ''));
}

function decodeUtf8Strict(buffer) {
  if (buffer.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
}

function truncateUtf8(text, maxBytes) {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return { text, truncated: false };
  // A cut multi-byte character decodes to U+FFFD; drop it.
  return { text: buffer.subarray(0, maxBytes).toString('utf8').replace(/�$/, ''), truncated: true };
}

// Classifies a Network.getResponseBody result. `text` is the full body text
// (redacted unless unsafeFull) for --out; the model carries only the preview.
export function summarizeResponseBody(result, { mimeType = '', unsafeFull = false, previewBytes = NETLOG_BODY_PREVIEW_BYTES } = {}) {
  const raw = String(result?.body ?? '');
  const buffer = result?.base64Encoded ? Buffer.from(raw, 'base64') : Buffer.from(raw, 'utf8');
  const decoded = result?.base64Encoded
    ? (isTextMime(mimeType) || !mimeType ? decodeUtf8Strict(buffer) : null)
    : raw;
  if (decoded == null) {
    return {
      model: {
        available: true,
        kind: 'binary',
        encoding: 'base64',
        bytes: buffer.length,
        shownBytes: 0,
        truncated: buffer.length > 0,
        redacted: false,
        text: null,
        summary: `binary body, ${buffer.length} bytes${mimeType ? ` (${mimeType})` : ''}`,
        error: null,
      },
      file: { data: buffer, redacted: false },
    };
  }
  const text = unsafeFull ? decoded : redactBodyText(decoded, { mimeType });
  const preview = truncateUtf8(text, previewBytes);
  return {
    model: {
      available: true,
      kind: 'text',
      encoding: result?.base64Encoded ? 'base64' : 'text',
      bytes: buffer.length,
      shownBytes: Buffer.byteLength(preview.text, 'utf8'),
      truncated: preview.truncated,
      redacted: !unsafeFull && text !== decoded,
      text: preview.text,
      summary: null,
      error: null,
    },
    file: { data: Buffer.from(text, 'utf8'), redacted: !unsafeFull && text !== decoded },
  };
}

export function unavailableBody(reason) {
  return {
    available: false,
    kind: null,
    encoding: null,
    bytes: null,
    shownBytes: 0,
    truncated: false,
    redacted: false,
    text: null,
    summary: null,
    error: clip(redactSensitiveString(reason), MAX_ERROR_CHARS).text,
  };
}

function durationMs(detail) {
  if (Number.isFinite(detail.startTimestamp) && Number.isFinite(detail.endTimestamp)) {
    return round1((detail.endTimestamp - detail.startTimestamp) * 1000);
  }
  return null;
}

export function buildNetlogRequestModel(detail, { body = null, unsafeFull = false, targetId = '', savedTo = null, includeBody = false } = {}) {
  const target = targetId || '<target>';
  const shownUrl = value => (unsafeFull ? String(value || '') : redactUrl(value || ''));
  const hasResponse = detail.status != null || detail.responseHeaders != null;
  const nextSteps = [];
  if (includeBody && body?.available && body.truncated && !savedTo) nextSteps.push(`cdp netlog ${target} --id ${detail.id} --out <file>`);
  nextSteps.push(`cdp netlog ${target}`);
  if (!includeBody) nextSteps.push(`cdp netlog ${target} --id ${detail.id} --body  # include the redacted body`);
  else if (!unsafeFull) nextSteps.push(`cdp netlog ${target} --id ${detail.id} --body --unsafe-full  # raw body, headers and URL`);
  return {
    schema: NETLOG_REQUEST_SCHEMA,
    targetId: targetId || null,
    id: detail.id,
    redacted: !unsafeFull,
    state: detail.state,
    request: {
      method: detail.method,
      url: shownUrl(detail.url),
      urlTruncated: detail.urlTruncated === true,
      resourceType: detail.resourceType,
      initiator: detail.initiator ? { type: detail.initiator.type, url: shownUrl(detail.initiator.url) || null } : null,
      hasPostData: detail.hasPostData === true,
      headers: redactHeaders(detail.requestHeaders, { unsafeFull }),
      headerCount: detail.requestHeaderCount,
      headersTruncated: detail.requestHeadersTruncated === true,
    },
    response: hasResponse ? {
      status: detail.status,
      statusText: detail.statusText || '',
      mimeType: detail.mimeType || '',
      protocol: detail.protocol || '',
      fromCache: detail.fromCache === true,
      fromServiceWorker: detail.fromServiceWorker === true,
      encodedDataLength: detail.encodedDataLength,
      headers: detail.responseHeaders ? redactHeaders(detail.responseHeaders, { unsafeFull }) : {},
      headerCount: detail.responseHeaderCount,
      headersTruncated: detail.responseHeadersTruncated === true,
    } : null,
    error: detail.state === 'failed' ? {
      errorText: detail.errorText,
      canceled: detail.canceled === true,
      blockedReason: detail.blockedReason,
      corsError: detail.corsError,
    } : null,
    timing: {
      startedAt: Number.isFinite(detail.startedAt) ? new Date(detail.startedAt).toISOString() : null,
      totalMs: durationMs(detail),
      ...(detail.timing || {}),
    },
    redirects: detail.redirects.map(hop => ({ status: hop.status, url: shownUrl(hop.url) })),
    body: includeBody && body ? {
      ...body,
      savedTo: savedTo?.path ?? null,
      savedBytes: savedTo?.bytes ?? null,
      savedRedacted: savedTo ? savedTo.redacted === true : null,
    } : {
      omitted: true,
      savedTo: savedTo?.path ?? null,
      savedBytes: savedTo?.bytes ?? null,
      savedRedacted: savedTo ? savedTo.redacted === true : null,
    },
    nextSteps,
  };
}

function formatHeaderBlock(title, headers, { count = 0, truncated = false } = {}) {
  const entries = Object.entries(headers || {});
  const lines = [`${title} (${count || entries.length}${truncated ? ', truncated' : ''}):`];
  if (!entries.length) lines.push('  (none captured)');
  for (const [name, value] of entries) lines.push(`  ${name}: ${String(value).replace(/\n/g, '\n    ')}`);
  return lines;
}

function formatTimingLine(timing) {
  const parts = [];
  if (timing.totalMs != null) parts.push(`total ${timing.totalMs}ms`);
  for (const [key, label] of [['dnsMs', 'dns'], ['connectMs', 'connect'], ['sslMs', 'ssl'], ['sendMs', 'send'], ['waitMs', 'wait (TTFB)']]) {
    if (timing[key] != null) parts.push(`${label} ${timing[key]}ms`);
  }
  return parts.length ? parts.join(' | ') : 'not reported';
}

export function formatNetlogRequestText(model) {
  const { request, response, error, timing, body } = model;
  const unsafeBanner = body?.omitted
    ? ' [unsafe-full: headers and URL not redacted]'
    : ' [unsafe-full: headers, URL and body not redacted]';
  const lines = [`Request #${model.id}${model.redacted ? '' : unsafeBanner}`];
  lines.push(`  ${request.method} ${request.url}${request.urlTruncated ? ' …(URL truncated)' : ''}`);
  if (response?.status != null) {
    lines.push(`  Status: ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`);
  } else {
    lines.push(`  Status: ${model.state === 'failed' ? 'failed' : model.state === 'pending' ? 'pending' : 'unknown'}`);
  }
  if (error) {
    const extra = [error.canceled ? 'canceled' : '', error.blockedReason ? `blocked: ${error.blockedReason}` : '', error.corsError ? `CORS: ${error.corsError}` : '']
      .filter(Boolean).join(', ');
    lines.push(`  Error: ${error.errorText}${extra ? ` (${extra})` : ''}`);
  }
  const typeParts = [`Type: ${request.resourceType}`];
  if (response?.mimeType) typeParts.push(`MIME: ${response.mimeType}`);
  if (response?.protocol) typeParts.push(`Protocol: ${response.protocol}`);
  if (response?.fromCache) typeParts.push('from cache');
  if (response?.fromServiceWorker) typeParts.push('from service worker');
  lines.push(`  ${typeParts.join(' | ')}`);
  if (request.initiator) lines.push(`  Initiator: ${request.initiator.type}${request.initiator.url ? ` ${request.initiator.url}` : ''}`);
  lines.push(`  Timing: ${formatTimingLine(timing)}`);
  for (const hop of model.redirects) lines.push(`  Redirected: ${hop.status ?? '?'} from ${hop.url}`);
  lines.push(...formatHeaderBlock('Request headers', request.headers, { count: request.headerCount, truncated: request.headersTruncated }));
  if (response) lines.push(...formatHeaderBlock('Response headers', response.headers, { count: response.headerCount, truncated: response.headersTruncated }));
  if (body?.omitted) {
    lines.push('Body: omitted (pass --body to include the redacted body)');
    if (body.savedTo) lines.push(`Saved body: ${body.savedTo} (${body.savedBytes} bytes${body.savedRedacted ? ', secrets redacted' : ''})`);
  } else if (body) {
    if (!body.available) {
      lines.push(`Body: not available (${body.error})`);
    } else if (body.kind === 'binary') {
      lines.push(`Body: ${body.summary}${body.unread ? ' (not read by the page)' : ''}`);
    } else {
      lines.push(`Body (${body.bytes} bytes${body.truncated ? `, first ${body.shownBytes} shown` : ''}${body.redacted ? ', secrets redacted' : ''}${body.unread ? ', not read by the page' : ''}):`);
      lines.push(body.text ? body.text.split('\n').map(line => `  ${line}`).join('\n') : '  (empty)');
      if (body.truncated) lines.push('  … truncated');
    }
    if (body.savedTo) lines.push(`Saved body: ${body.savedTo} (${body.savedBytes} bytes${body.savedRedacted ? ', secrets redacted' : ''})`);
  }
  if (model.nextSteps.length) lines.push(`Next: ${model.nextSteps[0]}`);
  return lines.join('\n');
}

// `--out` (#467): create the file with mode 0600 and never follow a symlink.
// An existing path is refused unless `overwrite`; then it is truncated in place
// and set to 0600. The path must be absolute: the daemon's working directory is
// not the caller's. The CLI resolves a relative path first, including inside
// batch, flow, and repeat (#577).
export function writeNetlogBodyFile(path, data, { overwrite = false, requestId = '' } = {}) {
  const label = `netlog: --out ${path} for request #${requestId}`;
  if (!isAbsolute(String(path))) {
    throw new Error(`${label}: the path must be absolute here (batch and flow run in the tab daemon, not in your directory). Pass an absolute path, or run \`cdp netlog <target> --id ${requestId} --out <file>\` directly.`);
  }
  let existing = null;
  try {
    existing = lstatSync(path);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new Error(`${label}: cannot inspect the path (${error?.code || error?.message})`);
  }
  if (existing?.isSymbolicLink()) throw new Error(`${label}: the path is a symbolic link; refusing to follow it`);
  if (existing && !overwrite) throw new Error(`${label}: the file already exists; pass --overwrite or choose a new path`);
  if (existing && !existing.isFile()) throw new Error(`${label}: the path exists and is not a regular file`);
  const nofollow = FS_CONSTANTS.O_NOFOLLOW || 0;
  const flags = existing
    ? FS_CONSTANTS.O_WRONLY | FS_CONSTANTS.O_CREAT | FS_CONSTANTS.O_TRUNC | nofollow
    : FS_CONSTANTS.O_WRONLY | FS_CONSTANTS.O_CREAT | FS_CONSTANTS.O_EXCL | nofollow;
  let fd;
  try {
    fd = openSync(path, flags, 0o600);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`${label}: the directory does not exist`);
    if (error?.code === 'EEXIST') throw new Error(`${label}: the file already exists; pass --overwrite or choose a new path`);
    if (error?.code === 'ELOOP') throw new Error(`${label}: the path is a symbolic link; refusing to follow it`);
    throw new Error(`${label}: cannot write the file (${error?.code || error?.message})`);
  }
  try {
    if (existing) {
      try { fchmodSync(fd, 0o600); } catch { /* Windows has no POSIX modes. */ }
    }
    let offset = 0;
    while (offset < data.length) offset += writeSync(fd, data, offset, data.length - offset);
  } finally {
    closeSync(fd);
  }
  return { path, bytes: data.length };
}
