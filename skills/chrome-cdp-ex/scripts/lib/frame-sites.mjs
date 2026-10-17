// CDP_FRAME_SITES: which cross-site frame origins implicit perceive may read.
// An allowlisted https or loopback origin is eligible to inline. The read itself
// still has to pass the commit checks in perceive.
// The public-suffix set is a floor: a wildcard whose base is on it is rejected.
// An entry that is not on the list is not thereby trusted.
import { randomBytes } from 'node:crypto';

export const FRAME_SITES_ENV = 'CDP_FRAME_SITES';

export const FRAME_SITE_PUBLIC_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk',
  'com.au', 'net.au', 'org.au',
  'co.nz', 'com.br', 'co.kr', 'com.hk', 'com.sg', 'com.tr', 'co.za',
  'com.mx', 'co.in', 'com.tw', 'com.cn', 'com.ar', 'co.jp',
  'github.io', 'gitlab.io', 'pages.dev',
]);

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

// WHATWG URL.hostname keeps the brackets on an IPv6 address in this Node (`[::1]`).
// Comparisons use the address without brackets (`::1`).
function normalizeHost(hostname) {
  let host = String(hostname || '').replace(/\.$/, '');
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  return host;
}
// A block line that looks like a marker or a receipt control line (Next:, Kind:, Error:, Recovery:)
// is escaped, so no reader takes frame text for the CLI's own line.
const MARKER_LINE = /^\s*(?:--- (?:FRAME CONTENT|END FRAME CONTENT)|(?:Next|Kind|Error|Recovery):)/;
const LISTED_FRAMES = new WeakMap();

function policyConfigError(message) {
  const error = new Error(`policy config: ${message}`);
  error.code = 'policy_config';
  return error;
}

function rejectBad(text, detail) {
  throw policyConfigError(`CDP_FRAME_SITES entry "${text}" ${detail}`);
}

// A leading `*.` is stripped and checked on its own, before the URL parser.
function splitWildcard(text) {
  if (!text.includes('*')) return { wildcard: false, body: text };
  const wild = /^([a-z][a-z0-9+.-]*:\/\/)\*\.(.+)$/i.exec(text);
  if (!wild) rejectBad(text, 'is not an origin. A * is only allowed as a leading *. label (https://*.example.com).');
  return { wildcard: true, body: `${wild[1]}${wild[2]}` };
}

function rejectUnbracketedIpv6(text, body) {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(body);
  if (!match) return;
  let authority = match[1];
  const at = authority.lastIndexOf('@');
  if (at >= 0) authority = authority.slice(at + 1);
  if (!authority || authority.startsWith('[')) return;
  const colon = authority.indexOf(':');
  if (colon === -1) return;
  const host = authority.slice(0, colon);
  const port = authority.slice(colon + 1);
  if (/^\d+$/.test(port) && host && !host.includes(':')) return;
  rejectBad(text, 'has an IPv6 host without brackets. Write http://[::1].');
}

export function parseFrameSiteEntry(raw) {
  const text = String(raw ?? '').trim();
  if (!text || text === '*') {
    rejectBad(text || '*', 'is not an origin. Bare * is not allowed.');
  }
  const { wildcard, body } = splitWildcard(text);
  rejectUnbracketedIpv6(text, body);
  let parsed;
  try {
    parsed = new URL(body);
  } catch {
    rejectBad(text, 'is not an origin. Write https://host[:port] or https://*.host.');
  }
  if (parsed.username || parsed.password) rejectBad(text, 'must not include userinfo.');
  if ((parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) {
    rejectBad(text, 'must not include a path, query, or fragment.');
  }
  const hostname = normalizeHost(parsed.hostname);
  if (!hostname || hostname.includes('*')) rejectBad(text, 'must name a host.');
  const protocol = parsed.protocol;
  const loopbackHttp = protocol === 'http:' && LOOPBACK_HOSTS.has(hostname) && !wildcard;
  if (protocol !== 'https:' && !loopbackHttp) {
    rejectBad(text, 'must be https, or http on localhost, 127.0.0.1, or [::1].');
  }
  if (wildcard) {
    const labels = hostname.split('.').filter(Boolean);
    if (labels.length < 2 || FRAME_SITE_PUBLIC_SUFFIXES.has(hostname)) {
      rejectBad(text, 'wildcard must cover more than one label and must not cover a public suffix.');
    }
  }
  const port = parsed.port;
  const hostInOrigin = hostname.includes(':') ? `[${hostname}]` : hostname;
  const origin = `${protocol}//${hostInOrigin}${port ? `:${port}` : ''}`;
  return Object.freeze({
    source: text,
    protocol,
    hostname,
    port,
    wildcard,
    origin,
  });
}

export function parseFrameSites(raw) {
  if (raw == null) return null;
  const entries = String(raw).split(',').map(entry => entry.trim()).filter(Boolean);
  if (!entries.length) return null;
  return entries.map(parseFrameSiteEntry);
}

// WILDCARD_LABEL_BOUNDARY: the host must end with .<base> and be longer than that base.
function hostMatchesEntry(hostname, entry) {
  if (!entry.wildcard) return hostname === entry.hostname;
  const suffix = `.${entry.hostname}`;
  return hostname.length > suffix.length && hostname.endsWith(suffix);
}

// ALLOWLIST_MATCH compares scheme, host, and port. It does not widen a miss into a match.
export function frameSiteMatches(origin, entries) {
  if (!entries?.length) return false;
  let parsed;
  try {
    parsed = new URL(String(origin));
  } catch {
    return false;
  }
  const hostname = normalizeHost(parsed.hostname);
  return entries.some(entry => (
    parsed.protocol === entry.protocol
    && parsed.port === entry.port
    && hostMatchesEntry(hostname, entry)
  ));
}

function parsedOrigin(origin) {
  const text = String(origin ?? '').trim();
  if (!text || text === 'null' || text === '://' || text.startsWith('data:') || text.startsWith('blob:')) return null;
  try {
    const parsed = new URL(text);
    if (!parsed.hostname || parsed.origin === 'null') return null;
    return parsed;
  } catch {
    return null;
  }
}

// HTTPS_CHECK: http is eligible only for the exact loopback hosts, and only after opaque origins.
export function classifyFrameOrigin(origin, entries) {
  const parsed = parsedOrigin(origin);
  if (!parsed) return { read: false, reason: 'opaque-origin', origin: null };
  const hostname = normalizeHost(parsed.hostname);
  const loopbackHttp = parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(hostname);
  if (parsed.protocol !== 'https:' && !loopbackHttp) {
    return { read: false, reason: 'not-https', origin: parsed.origin };
  }
  if (entries == null) return { read: false, reason: 'unset', origin: parsed.origin };
  if (!frameSiteMatches(parsed.origin, entries)) {
    return { read: false, reason: 'not-allowlisted', origin: parsed.origin };
  }
  return { read: true, origin: parsed.origin };
}

export function originHost(origin) {
  const parsed = parsedOrigin(origin);
  return parsed ? parsed.host : '';
}

export function frameContentOrigin(origin) {
  const parsed = parsedOrigin(origin);
  return parsed ? parsed.origin : 'null';
}

export function crossSiteReadClause(classification) {
  const detail = {
    unset: 'CDP_FRAME_SITES not set',
    'not-allowlisted': `not in CDP_FRAME_SITES; the user can add ${classification?.origin || ''}`,
    'not-https': 'http, only https is read',
    'opaque-origin': 'opaque origin',
    navigated: 'frame navigated during read',
    cap: 'cap of 8 frames',
  }[classification?.reason] || String(classification?.reason || 'not read');
  return `(cross-site, not read: ${detail})`;
}

export function createFrameContentNonce(random = randomBytes) {
  return random(16).toString('hex');
}

function isFrameContentControl(code) {
  return code === 0x7F || (code <= 0x1F && code !== 0x09 && code !== 0x0A && code !== 0x0D);
}

// FRAME_CONTENT_ESCAPE: a marker or control line is prefixed; other control characters are dropped.
export function sanitizeFrameContentLine(line) {
  let text = '';
  for (const ch of String(line)) {
    if (isFrameContentControl(ch.codePointAt(0))) continue;
    text += ch;
  }
  return MARKER_LINE.test(text) ? `\\${text}` : text;
}

export function sanitizeFrameContent(text) {
  return String(text ?? '').split('\n').map(sanitizeFrameContentLine).join('\n');
}

export function wrapFrameContent(text, { nonce = createFrameContentNonce(), origin = 'null' } = {}) {
  const shown = origin == null || origin === '' ? 'null' : String(origin);
  return [
    `--- FRAME CONTENT (untrusted) origin=${shown} nonce=${nonce} ---`,
    sanitizeFrameContent(text),
    `--- END FRAME CONTENT nonce=${nonce} ---`,
  ].join('\n');
}

export function frameContentBoundary(nonce, origin) {
  return { kind: 'frame', nonce, origin: origin == null || origin === '' ? 'null' : String(origin) };
}

function frameContentNonceFromText(text) {
  const match = /--- FRAME CONTENT \(untrusted\) origin=\S+ nonce=([0-9a-f]{32}) ---/.exec(String(text || ''));
  return match ? match[1] : '';
}

export function rememberListedFrames(cdp, sid, frames) {
  if (!cdp || !sid) return;
  let byClient = LISTED_FRAMES.get(cdp);
  if (!byClient) {
    byClient = new Map();
    LISTED_FRAMES.set(cdp, byClient);
  }
  const map = new Map();
  for (const frame of frames || []) {
    if (!frame) continue;
    if (frame.id) map.set(`id:${frame.id}`, frame);
    if (frame.ref) map.set(`ref:${frame.ref}`, frame);
  }
  byClient.set(sid, map);
}

export function listedFrame(cdp, sid, refOrId) {
  const map = LISTED_FRAMES.get(cdp)?.get(sid);
  if (!map) return null;
  const key = String(refOrId || '');
  return map.get(`ref:${key}`) || map.get(`id:${key}`) || null;
}

export function actionFrameRef(selector) {
  const match = /^(@f\d+):\d+$/.exec(String(selector || '').trim());
  return match ? match[1] : '';
}

// HOST_ONLY_RECEIPT: tag, ref, and host. The accessible name is not part of this string.
export function formatCrossSiteTarget({ tag = '?', ref = '', host = '' } = {}) {
  const id = ref ? ` (${ref})` : '';
  const where = host ? ` in ${host}` : '';
  return `<${tag || '?'}>${id}${where}`;
}

export function relocateCrossSiteActionFields(target) {
  if (!target || typeof target !== 'object') return target;
  const trust = target.clickTrust;
  const fromTrust = trust?.frameContent && typeof trust.frameContent === 'object' ? trust.frameContent : null;
  if (!target.crossSiteOrigin && !fromTrust) return target;
  const origin = frameContentOrigin(target.crossSiteOrigin || fromTrust?.origin || '');
  const nonce = frameContentNonceFromText(target.dispatchText) || createFrameContentNonce();
  const frameContent = { contentBoundary: frameContentBoundary(nonce, origin) };
  if (target.crossSiteOrigin) {
    for (const key of ['name', 'label', 'text']) {
      if (target[key] != null && target[key] !== '') frameContent[key] = target[key];
      delete target[key];
    }
    delete target.crossSiteOrigin;
  }
  if (fromTrust) {
    for (const key of ['name', 'label', 'text']) {
      if (frameContent[key] == null && fromTrust[key] != null && fromTrust[key] !== '') frameContent[key] = fromTrust[key];
    }
    delete trust.frameContent;
  }
  target.frameContent = frameContent;
  return target;
}
