#!/usr/bin/env node
// cdp - lightweight Chrome DevTools Protocol CLI
// Uses raw CDP over WebSocket, no Puppeteer dependency.
// Requires Node 22+ (built-in WebSocket).
//
// Per-tab persistent daemon: page commands go through a daemon that holds
// the CDP session open. Chrome's "Allow debugging" modal fires once per
// daemon (= once per tab). Daemons auto-exit after 20min idle.

import { readFileSync, writeFileSync, unlinkSync, existsSync, readdirSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { resolve } from 'path';
import { spawn } from 'child_process';
import net from 'net';

const TIMEOUT = 15000;
const SCREENSHOT_TIMEOUT = 30000;
const NAVIGATION_TIMEOUT = 30000;
const IDLE_TIMEOUT = 20 * 60 * 1000;
const DAEMON_CONNECT_RETRIES = 20;
const DAEMON_CONNECT_DELAY = 300;
const DAEMON_ALLOW_RETRIES = 200;  // For open --attach: 200 * 300ms = 60s
const DAEMON_ALLOW_DELAY = 300;
const MIN_TARGET_PREFIX_LEN = 8;
const IS_WINDOWS = process.platform === 'win32';
if (!IS_WINDOWS) process.umask(0o077);
const RUNTIME_DIR = IS_WINDOWS
  ? resolve(process.env.LOCALAPPDATA || resolve(homedir(), 'AppData', 'Local'), 'cdp')
  : process.env.XDG_RUNTIME_DIR
    ? resolve(process.env.XDG_RUNTIME_DIR, 'cdp')
    : resolve(homedir(), '.cache', 'cdp');
try { mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 }); } catch {}
const SOCK_PREFIX = resolve(RUNTIME_DIR, 'cdp-');
const PAGES_CACHE = resolve(RUNTIME_DIR, 'pages.json');

class RingBuffer {
  constructor(capacity) { this.buf = []; this.capacity = capacity; this.seq = 0; }
  push(entry) { entry._seq = ++this.seq; this.buf.push(entry); if (this.buf.length > this.capacity) this.buf.shift(); }
  since(seq) { return this.buf.filter(e => e._seq > seq); }
  all() { return [...this.buf]; }
  latest() { return this.seq; }
  clear() { this.buf.length = 0; }
}

function sockPath(targetId) {
  if (IS_WINDOWS) return `\\\\.\\pipe\\cdp-${targetId}`;
  return `${SOCK_PREFIX}${targetId}.sock`;
}

// Browser metadata from /json/version — set when connecting via CDP_PORT
let _browserInfo = null;

async function getWsUrl() {
  const host = process.env.CDP_HOST || '127.0.0.1';

  // CDP_PORT: explicit port (e.g. Electron with --remote-debugging-port=9222)
  if (process.env.CDP_PORT) {
    const port = process.env.CDP_PORT;
    let res;
    try {
      res = await fetch(`http://${host}:${port}/json/version`, { signal: AbortSignal.timeout(3000) });
    } catch {
      throw new Error(`Cannot reach CDP on ${host}:${port} — is the app running with --remote-debugging-port=${port}?`);
    }
    const info = await res.json();
    if (!info.webSocketDebuggerUrl) throw new Error(`CDP on port ${port}: /json/version has no webSocketDebuggerUrl`);
    _browserInfo = info;
    // Extract path only — don't trust the hostname in the response (may be "localhost"
    // while CDP_HOST points elsewhere, e.g. WSL2→Windows)
    const wsPath = new URL(info.webSocketDebuggerUrl).pathname;
    return `ws://${host}:${port}${wsPath}`;
  }

  // DevToolsActivePort file discovery (Chrome, Edge, Brave, etc.)
  const home = homedir();
  // macOS: ~/Library/Application Support/<name>/DevToolsActivePort
  const macBrowsers = [
    'Google/Chrome', 'Google/Chrome Beta', 'Google/Chrome for Testing',
    'Chromium', 'BraveSoftware/Brave-Browser', 'Microsoft Edge',
  ];
  // Linux: ~/.config/<name>/DevToolsActivePort
  const linuxBrowsers = [
    'google-chrome', 'google-chrome-beta', 'chromium',
    'vivaldi', 'vivaldi-snapshot',
    'BraveSoftware/Brave-Browser', 'microsoft-edge',
  ];
  // Windows: %LOCALAPPDATA%\<name>\User Data\DevToolsActivePort
  const winBrowsers = [
    'Google\\Chrome', 'Google\\Chrome Beta', 'Google\\Chrome for Testing',
    'Chromium', 'BraveSoftware\\Brave-Browser', 'Microsoft\\Edge',
  ];
  const localAppData = process.env.LOCALAPPDATA || '';
  const candidates = [
    process.env.CDP_PORT_FILE,
    ...winBrowsers.flatMap(b => [
      resolve(localAppData, b, 'User Data', 'DevToolsActivePort'),
      resolve(localAppData, b, 'User Data', 'Default', 'DevToolsActivePort'),
    ]),
    ...macBrowsers.flatMap(b => [
      resolve(home, 'Library/Application Support', b, 'DevToolsActivePort'),
      resolve(home, 'Library/Application Support', b, 'Default/DevToolsActivePort'),
    ]),
    ...linuxBrowsers.flatMap(b => [
      resolve(home, '.config', b, 'DevToolsActivePort'),
      resolve(home, '.config', b, 'Default/DevToolsActivePort'),
    ]),
    // Linux Flatpak: ~/.var/app/<app-id>/config/<name>/DevToolsActivePort
    ...([
      ['org.chromium.Chromium', 'chromium'],
      ['com.google.Chrome', 'google-chrome'],
      ['com.brave.Browser', 'BraveSoftware/Brave-Browser'],
      ['com.microsoft.Edge', 'microsoft-edge'],
      ['com.vivaldi.Vivaldi', 'vivaldi'],
    ]).flatMap(([appId, name]) => [
      resolve(home, '.var/app', appId, 'config', name, 'DevToolsActivePort'),
      resolve(home, '.var/app', appId, 'config', name, 'Default/DevToolsActivePort'),
    ]),
  ].filter(Boolean);
  const portFile = candidates.find(p => existsSync(p));
  if (!portFile) throw new Error('No DevToolsActivePort found and no CDP_PORT set.\n  Chrome: enable at chrome://inspect/#remote-debugging\n  Electron: set CDP_PORT=<port> (app must use --remote-debugging-port)');
  const lines = readFileSync(portFile, 'utf8').trim().split('\n');
  if (lines.length < 2 || !lines[0] || !lines[1]) throw new Error(`Invalid DevToolsActivePort file: ${portFile}`);
  return `ws://${host}:${lines[0]}${lines[1]}`;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function listDaemonSockets() {
  if (IS_WINDOWS) {
    // Named pipes aren't in filesystem; probe pipes for known targets from pages cache
    try {
      const cached = JSON.parse(readFileSync(PAGES_CACHE, 'utf8'));
      return (Array.isArray(cached) ? cached : cached.pages || []).map(p => ({
        targetId: p.targetId,
        socketPath: sockPath(p.targetId),
      }));
    } catch { return []; }
  }
  try {
    return readdirSync(RUNTIME_DIR)
      .filter(f => f.startsWith('cdp-') && f.endsWith('.sock'))
      .map(f => ({
        targetId: f.slice(4, -5),
        socketPath: resolve(RUNTIME_DIR, f),
      }));
  } catch { return []; }
}

function resolvePrefix(prefix, candidates, noun = 'target', missingHint = '') {
  const upper = prefix.toUpperCase();
  const matches = candidates.filter(candidate => candidate.toUpperCase().startsWith(upper));
  if (matches.length === 0) {
    const hint = missingHint ? ` ${missingHint}` : '';
    throw new Error(`No ${noun} matching prefix "${prefix}".${hint}`);
  }
  if (matches.length > 1) {
    throw new Error(`Ambiguous prefix "${prefix}" — matches ${matches.length} ${noun}s. Use more characters.`);
  }
  return matches[0];
}

function getDisplayPrefixLength(targetIds) {
  if (targetIds.length === 0) return MIN_TARGET_PREFIX_LEN;
  const maxLen = Math.max(...targetIds.map(id => id.length));
  for (let len = MIN_TARGET_PREFIX_LEN; len <= maxLen; len++) {
    const prefixes = new Set(targetIds.map(id => id.slice(0, len).toUpperCase()));
    if (prefixes.size === targetIds.length) return len;
  }
  return maxLen;
}

// ---------------------------------------------------------------------------
// CDP WebSocket client
// ---------------------------------------------------------------------------

class CDP {
  #ws; #id = 0; #pending = new Map(); #eventHandlers = new Map(); #closeHandlers = [];

  async connect(wsUrl) {
    return new Promise((res, rej) => {
      this.#ws = new WebSocket(wsUrl);
      this.#ws.onopen = () => res();
      this.#ws.onerror = (e) => rej(new Error('WebSocket error: ' + (e.message || e.type)));
      this.#ws.onclose = () => this.#closeHandlers.forEach(h => h());
      this.#ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && this.#pending.has(msg.id)) {
          const { resolve, reject } = this.#pending.get(msg.id);
          this.#pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message));
          else resolve(msg.result);
        } else if (msg.method && this.#eventHandlers.has(msg.method)) {
          for (const handler of [...this.#eventHandlers.get(msg.method)]) {
            handler(msg.params || {}, msg);
          }
        }
      };
    });
  }

  send(method, params = {}, sessionId, timeoutMs = TIMEOUT) {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      const msg = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      this.#ws.send(JSON.stringify(msg));
      setTimeout(() => {
        if (this.#pending.has(id)) {
          this.#pending.delete(id);
          reject(new Error(`Timeout: ${method}`));
        }
      }, timeoutMs);
    });
  }

  onEvent(method, handler) {
    if (!this.#eventHandlers.has(method)) this.#eventHandlers.set(method, new Set());
    const handlers = this.#eventHandlers.get(method);
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.#eventHandlers.delete(method);
    };
  }

  waitForEvent(method, timeout = TIMEOUT) {
    let settled = false;
    let off;
    let timer;
    const promise = new Promise((resolve, reject) => {
      off = this.onEvent(method, (params) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off();
        resolve(params);
      });
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        off();
        reject(new Error(`Timeout waiting for event: ${method}`));
      }, timeout);
    });
    return {
      promise,
      cancel() {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off?.();
      },
    };
  }

  onClose(handler) { this.#closeHandlers.push(handler); }
  close() { this.#ws.close(); }
}

// ---------------------------------------------------------------------------
// Command implementations — return strings, take (cdp, sessionId)
// ---------------------------------------------------------------------------

async function getPages(cdp) {
  const { targetInfos } = await cdp.send('Target.getTargets');
  return targetInfos.filter(t => t.type === 'page' && !t.url.startsWith('chrome://') && !t.url.startsWith('edge://'));
}

function formatPageList(pages, browserInfo = null) {
  const lines = [];
  if (browserInfo) {
    const ua = browserInfo['User-Agent'] || '';
    const m = ua.match(/Electron\/([\d.]+)/);
    if (m) lines.push(`[Electron ${m[1]}]`);
  }
  const prefixLen = getDisplayPrefixLength(pages.map(p => p.targetId));
  lines.push(...pages.map(p => {
    const id = p.targetId.slice(0, prefixLen).padEnd(prefixLen);
    const title = p.title.substring(0, 54).padEnd(54);
    return `${id}  ${title}  ${p.url}`;
  }));
  return lines.join('\n');
}

function shouldShowAxNode(node, compact = false, parentNode = null) {
  const role = node.role?.value || '';
  const name = node.name?.value ?? '';
  const value = node.value?.value;
  if (compact && role === 'InlineTextBox') return false;
  // In compact mode, filter StaticText that duplicates parent's name
  if (compact && role === 'StaticText' && parentNode) {
    const parentName = parentNode.name?.value ?? '';
    if (parentName && parentName.includes(name)) return false;
  }
  return role !== 'none' && role !== 'generic' && !(name === '' && (value === '' || value == null));
}

function formatAxNode(node, depth) {
  const role = node.role?.value || '';
  const name = node.name?.value ?? '';
  const value = node.value?.value;
  const indent = '  '.repeat(Math.min(depth, 10));
  let line = `${indent}[${role}]`;
  if (name !== '') line += ` ${name}`;
  if (!(value === '' || value == null)) line += ` = ${JSON.stringify(value)}`;
  return line;
}

function orderedAxChildren(node, nodesById, childrenByParent) {
  const children = [];
  const seen = new Set();
  for (const childId of node.childIds || []) {
    const child = nodesById.get(childId);
    if (child && !seen.has(child.nodeId)) {
      seen.add(child.nodeId);
      children.push(child);
    }
  }
  for (const child of childrenByParent.get(node.nodeId) || []) {
    if (!seen.has(child.nodeId)) {
      seen.add(child.nodeId);
      children.push(child);
    }
  }
  return children;
}

async function snapshotStr(cdp, sid, compact = false) {
  const { nodes } = await cdp.send('Accessibility.getFullAXTree', {}, sid);
  const nodesById = new Map(nodes.map(node => [node.nodeId, node]));
  const childrenByParent = new Map();
  for (const node of nodes) {
    if (!node.parentId) continue;
    if (!childrenByParent.has(node.parentId)) childrenByParent.set(node.parentId, []);
    childrenByParent.get(node.parentId).push(node);
  }

  const lines = [];
  const visited = new Set();
  function visit(node, depth, parentNode = null) {
    if (!node || visited.has(node.nodeId)) return;
    visited.add(node.nodeId);
    if (shouldShowAxNode(node, compact, parentNode)) lines.push(formatAxNode(node, depth));
    for (const child of orderedAxChildren(node, nodesById, childrenByParent)) {
      visit(child, depth + 1, node);
    }
  }

  const roots = nodes.filter(node => !node.parentId || !nodesById.has(node.parentId));
  for (const root of roots) visit(root, 0);
  for (const node of nodes) visit(node, 0);

  lines.push('');
  lines.push('(Hint: `snap` gives only the raw AX tree. Use `perceive` instead for layout, @refs, style hints, and console health — it is the recommended starting command.)');
  return lines.join('\n');
}

async function evalStr(cdp, sid, expression, autoWrap = false) {
  // Auto-wrap: if expression contains `await`, wrap in async IIFE
  let expr = expression;
  if (autoWrap && /\bawait\b/.test(expr)) {
    // Multi-statement or has semicolons → block body; otherwise expression body
    expr = expr.includes(';') || expr.includes('\n')
      ? `(async()=>{${expr}})()`
      : `(async()=>(${expr}))()`;
  }
  const result = await cdp.send('Runtime.evaluate', {
    expression: expr, returnByValue: true, awaitPromise: true,
  }, sid);
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || result.exceptionDetails.exception?.description);
  }
  const val = result.result.value;
  return typeof val === 'object' ? JSON.stringify(val, null, 2) : String(val ?? '');
}

// ---------------------------------------------------------------------------
// Screenshot with multi-tier fallback (handles Electron CDP limitations)
// ---------------------------------------------------------------------------
// Tier 1: Page.captureScreenshot (standard)
// Tier 2: Page.captureScreenshot with fromSurface:false (view-based capture)
// Tier 3: Page.startScreencast single-frame grab (different rendering pipeline)
//
// Once a tier fails for a session, it is skipped on subsequent calls to avoid
// repeated 30s timeouts (critical for scanshot which captures multiple segments).
// State is per-module (one daemon = one tab session, so this is correct).
let _screenshotTier = 1; // start at tier 1; advances on failure
function resetScreenshotTier() { _screenshotTier = 1; }
function getScreenshotTier() { return _screenshotTier; }

async function screencastFallback(cdp, sid) {
  const frame = cdp.waitForEvent('Page.screencastFrame', SCREENSHOT_TIMEOUT);
  try {
    await cdp.send('Page.startScreencast', { format: 'png', quality: 100, everyNthFrame: 1 }, sid);
    const result = await frame.promise;
    // Acknowledge so the screencast doesn't stall
    cdp.send('Page.screencastFrameAck', { sessionId: result.sessionId }, sid).catch(() => {});
    return result.data;
  } finally {
    frame.cancel();
    cdp.send('Page.stopScreencast', {}, sid).catch(() => {});
  }
}

// Returns { data: base64string, fallback: boolean }.
// `params` is passed to Page.captureScreenshot (format, clip, etc.).
async function captureScreenshot(cdp, sid, params = { format: 'png' }) {
  // Tier 1: standard captureScreenshot
  if (_screenshotTier <= 1) {
    try {
      const result = await cdp.send('Page.captureScreenshot', params, sid, SCREENSHOT_TIMEOUT);
      return { data: result.data, fallback: false };
    } catch (err) {
      if (!err.message?.startsWith('Timeout:')) throw err;
      _screenshotTier = 2;
    }
  }

  // Tier 2: captureScreenshot with fromSurface:false (captures from view, not compositor)
  if (_screenshotTier <= 2) {
    try {
      const result = await cdp.send('Page.captureScreenshot',
        { ...params, fromSurface: false }, sid, SCREENSHOT_TIMEOUT);
      return { data: result.data, fallback: true };
    } catch (err) {
      if (!err.message?.startsWith('Timeout:')) throw err;
      _screenshotTier = 3;
    }
  }

  // Tier 3: screencast single-frame grab
  try {
    const data = await screencastFallback(cdp, sid);
    return { data, fallback: true };
  } catch {
    throw new Error(
      'Screenshot failed: all methods timed out (Page.captureScreenshot, fromSurface:false, screencast).\n' +
      'This Electron app may not support CDP screenshots. Use `perceive` for structural analysis instead.'
    );
  }
}

async function shotStr(cdp, sid, filePath, targetId) {
  const dpr = await getDpr(cdp, sid);
  const { data, fallback } = await captureScreenshot(cdp, sid, { format: 'png' });
  const out = filePath || resolve(RUNTIME_DIR, `screenshot-${(targetId || 'unknown').slice(0, 8)}.png`);
  writeFileSync(out, Buffer.from(data, 'base64'));

  const lines = [out];
  if (fallback) lines.push(`(screenshot fallback — Page.captureScreenshot timed out)`);
  lines.push(`Screenshot saved. Device pixel ratio (DPR): ${dpr}`);
  lines.push(`Coordinate mapping:`);
  lines.push(`  Screenshot pixels → CSS pixels (for CDP Input events): divide by ${dpr}`);
  lines.push(`  e.g. screenshot point (${Math.round(100 * dpr)}, ${Math.round(200 * dpr)}) → CSS (100, 200) → use clickxy <target> 100 200`);
  if (dpr !== 1) {
    lines.push(`  On this ${dpr}x display: CSS px = screenshot px / ${dpr} ≈ screenshot px × ${Math.round(100/dpr)/100}`);
  }
  return lines.join('\n');
}

async function htmlStr(cdp, sid, selector) {
  const expr = selector
    ? `document.querySelector(${JSON.stringify(selector)})?.outerHTML || 'Element not found'`
    : `document.documentElement.outerHTML`;
  return evalStr(cdp, sid, expr);
}

async function waitForDocumentReady(cdp, sid, timeoutMs = NAVIGATION_TIMEOUT) {
  const deadline = Date.now() + timeoutMs;
  let lastState = '';
  let lastError;
  while (Date.now() < deadline) {
    try {
      const state = await evalStr(cdp, sid, 'document.readyState');
      lastState = state;
      if (state === 'complete') return;
    } catch (e) {
      lastError = e;
    }
    await sleep(200);
  }

  if (lastState) {
    throw new Error(`Timed out waiting for navigation to finish (last readyState: ${lastState})`);
  }
  if (lastError) {
    throw new Error(`Timed out waiting for navigation to finish (${lastError.message})`);
  }
  throw new Error('Timed out waiting for navigation to finish');
}

async function navStr(cdp, sid, url) {
  validateUrl(url);
  await cdp.send('Page.enable', {}, sid);
  const loadEvent = cdp.waitForEvent('Page.loadEventFired', NAVIGATION_TIMEOUT);
  const result = await cdp.send('Page.navigate', { url }, sid);
  if (result.errorText) {
    loadEvent.cancel();
    throw new Error(result.errorText);
  }
  if (result.loaderId) {
    await loadEvent.promise;
  } else {
    loadEvent.cancel();
  }
  await waitForDocumentReady(cdp, sid, 5000);
  return `Navigated to ${url}`;
}

async function netStr(cdp, sid) {
  const raw = await evalStr(cdp, sid, `JSON.stringify(performance.getEntriesByType('resource').map(e => ({
    name: e.name.substring(0, 120), type: e.initiatorType,
    duration: Math.round(e.duration), size: e.transferSize
  })))`);
  return JSON.parse(raw).map(e =>
    `${String(e.duration).padStart(5)}ms  ${String(e.size || '?').padStart(8)}B  ${e.type.padEnd(8)}  ${e.name}`
  ).join('\n');
}

async function statusStr(cdp, sid, consoleBuf, exceptionBuf, navBuf, lastReadSeq) {
  let title = '', url = '';
  try {
    const info = JSON.parse(await evalStr(cdp, sid, 'JSON.stringify({ title: document.title, url: window.location.href })'));
    title = info.title;
    url = info.url;
  } catch {}

  const lines = [];
  lines.push(`URL: ${url}`);
  lines.push(`Title: ${title}`);

  const navs = navBuf.all();
  if (navs.length > 0) {
    const last = navs[navs.length - 1];
    const ago = Math.round((Date.now() - last.ts) / 1000);
    lines.push(`Navigations: ${navs.length} (last ${ago}s ago)`);
  }

  const newConsole = consoleBuf.since(lastReadSeq.console);
  const newExceptions = exceptionBuf.since(lastReadSeq.exception);

  if (newConsole.length > 0) {
    lines.push(`Console (${newConsole.length} new):`);
    for (const e of newConsole.slice(-20)) {
      const loc = e.loc ? ` (${e.loc})` : '';
      lines.push(`  [${e.level}] ${e.text.substring(0, 200)}${loc}`);
    }
    if (newConsole.length > 20) lines.push(`  ... and ${newConsole.length - 20} more (use 'console --all')`);
  } else {
    lines.push('Console: (no new entries)');
  }

  if (newExceptions.length > 0) {
    lines.push(`Exceptions (${newExceptions.length} new):`);
    for (const e of newExceptions.slice(-10)) {
      const loc = e.loc ? ` at ${e.loc}` : '';
      lines.push(`  ${e.msg.substring(0, 200)}${loc}`);
    }
  }

  lastReadSeq.console = consoleBuf.latest();
  lastReadSeq.exception = exceptionBuf.latest();

  return lines.join('\n');
}

async function consoleStr(consoleBuf, exceptionBuf, lastReadSeq, flag) {
  let entries;
  let exceptions = [];
  const showErrors = flag === '--errors';
  const showAll = flag === '--all';

  if (showAll) {
    entries = consoleBuf.all();
    exceptions = exceptionBuf.all();
  } else if (showErrors) {
    entries = consoleBuf.all().filter(e => e.level === 'error' || e.level === 'warning');
    exceptions = exceptionBuf.all();
  } else {
    entries = consoleBuf.since(lastReadSeq.console);
    exceptions = exceptionBuf.since(lastReadSeq.exception);
    lastReadSeq.console = consoleBuf.latest();
    lastReadSeq.exception = exceptionBuf.latest();
  }

  const lines = [];
  if (entries.length === 0 && exceptions.length === 0) {
    return showAll ? 'Console buffer is empty' : 'No new console entries';
  }

  for (const e of entries) {
    const loc = e.loc ? ` (${e.loc})` : '';
    lines.push(`[${e.level}] ${e.text.substring(0, 300)}${loc}`);
  }
  if (exceptions.length > 0) {
    lines.push('--- Uncaught Exceptions ---');
    for (const e of exceptions) {
      const loc = e.loc ? ` at ${e.loc}` : '';
      lines.push(`[exception] ${e.msg.substring(0, 300)}${loc}`);
    }
  }
  return lines.join('\n');
}

async function summaryStr(cdp, sid, consoleBuf, exceptionBuf) {
  const expr = `
    (function() {
      const counts = {};
      const interactive = document.querySelectorAll('a, button, input, select, textarea, [role="button"], [tabindex]');
      for (const el of interactive) {
        const tag = el.tagName.toLowerCase();
        const type = tag === 'input' ? 'input[' + (el.type || 'text') + ']' : tag;
        counts[type] = (counts[type] || 0) + 1;
      }
      const focused = document.activeElement;
      const focusDesc = focused && focused !== document.body
        ? '<' + focused.tagName.toLowerCase() + (focused.id ? '#' + focused.id : '') + (focused.className ? '.' + focused.className.toString().split(' ')[0] : '') + '>'
        : 'none';
      return {
        title: document.title,
        url: window.location.href,
        viewport: window.innerWidth + 'x' + window.innerHeight,
        scrollY: Math.round(window.scrollY),
        scrollMax: Math.round(document.documentElement.scrollHeight - window.innerHeight),
        counts,
        focused: focusDesc,
      };
    })()
  `;
  const result = await evalStr(cdp, sid, expr);
  const r = JSON.parse(result);
  const lines = [];
  lines.push(`Title: ${r.title}`);
  lines.push(`URL: ${r.url}`);
  lines.push(`Viewport: ${r.viewport}`);

  const countParts = Object.entries(r.counts).map(([k, v]) => `${v} ${k}`);
  lines.push(`Interactive: ${countParts.length > 0 ? countParts.join(', ') : 'none found'}`);

  lines.push(`Focused: ${r.focused}`);

  if (r.scrollMax > 0) {
    const pct = Math.round(r.scrollY / r.scrollMax * 100);
    lines.push(`Scroll: ${r.scrollY} / ${r.scrollMax} max (${pct}%)`);
  } else {
    lines.push('Scroll: no scroll');
  }

  const allConsole = consoleBuf.all();
  let errors = 0, warnings = 0;
  for (const e of allConsole) {
    if (e.level === 'error') errors++;
    else if (e.level === 'warning' || e.level === 'warn') warnings++;
  }
  const exceptions = exceptionBuf.all().length;
  const parts = [];
  if (errors > 0) parts.push(`${errors} error${errors > 1 ? 's' : ''}`);
  if (warnings > 0) parts.push(`${warnings} warning${warnings > 1 ? 's' : ''}`);
  if (exceptions > 0) parts.push(`${exceptions} exception${exceptions > 1 ? 's' : ''}`);
  lines.push(`Console: ${parts.length > 0 ? parts.join(', ') : 'clean'}`);

  return lines.join('\n');
}

// Roles that get visual layout annotations in perceive output
const ENRICHED_ROLES = new Set([
  'banner', 'navigation', 'main', 'contentinfo', 'complementary',
  'heading', 'img', 'image', 'video', 'form', 'table', 'dialog',
  'region', 'article', 'alert',
]);

// Roles that get @ref indices in perceive output (interactive elements)
const INTERACTIVE_ROLES = new Set([
  'link', 'button', 'menuitem', 'tab', 'checkbox', 'radio', 'switch',
  'textbox', 'searchbox', 'combobox', 'spinbutton', 'slider',
  'menuitemcheckbox', 'menuitemradio', 'option', 'treeitem',
]);

async function resolveRefNode(cdp, sid, refMap, ref) {
  const num = parseInt(ref.slice(1));
  if (isNaN(num) || !refMap.has(num)) {
    throw new Error(`Unknown ref: ${ref}. Run "perceive" first to assign refs.`);
  }
  const backendNodeId = refMap.get(num);
  const { object } = await cdp.send('DOM.resolveNode', { backendNodeId }, sid);
  return object.objectId;
}

async function resolveRef(cdp, sid, refMap, ref) {
  const objectId = await resolveRefNode(cdp, sid, refMap, ref);
  const result = await cdp.send('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: `function() {
      this.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = this.getBoundingClientRect();
      return { x: rect.x, y: rect.y, w: rect.width, h: rect.height, tag: this.tagName, text: this.textContent.trim().substring(0, 80) };
    }`,
    returnByValue: true,
  }, sid);
  return result.result.value;
}

function isRef(s) { return /^@\d+$/.test(s); }

// Wait for DOM mutations to stop after an action (350ms of silence = settled)
async function waitForSettle(cdp, sid, timeoutMs = 3000) {
  await evalStr(cdp, sid, `new Promise(resolve => {
    let timer;
    const done = () => { obs.disconnect(); resolve(); };
    const reset = () => { clearTimeout(timer); timer = setTimeout(done, 350); };
    const obs = new MutationObserver(reset);
    obs.observe(document.body || document.documentElement, { childList: true, subtree: true, attributes: true });
    timer = setTimeout(done, 350);
    setTimeout(() => { clearTimeout(timer); obs.disconnect(); resolve(); }, ${timeoutMs});
  })`);
}

function validateUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error(`Invalid URL: ${url}`); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Only http/https URLs allowed, got: ${parsed.protocol}`);
  }
  // Block cloud metadata endpoints (AWS/GCP/Azure IMDS)
  const host = parsed.hostname;
  const metadataIPs = ['169.254.169.254', '169.254.170.2', 'fd00:ec2::254'];
  const metadataHosts = ['metadata.google.internal', 'metadata.gke.internal'];
  if (metadataIPs.includes(host) || metadataHosts.includes(host)) {
    throw new Error(`Blocked: cloud metadata endpoint (${host})`);
  }
  // Block link-local range (169.254.x.x)
  if (/^169\.254\.\d+\.\d+$/.test(host)) {
    throw new Error(`Blocked: link-local address (${host})`);
  }
}

// Perceive: enriched accessibility tree with inline visual layout annotations
// Options parsed from args: --diff, --selector <sel>, --interactive/-i, --depth <N>, --cursor-interactive/-C
function parsePerceiveArgs(args) {
  const opts = { diff: false, selector: null, exclude: null, interactive: false, maxDepth: Infinity, cursorInteractive: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--diff') opts.diff = true;
    else if (a === '-s' || a === '--selector') opts.selector = args[++i];
    else if (a === '-x' || a === '--exclude') opts.exclude = args[++i];
    else if (a === '-i' || a === '--interactive') opts.interactive = true;
    else if (a === '-d' || a === '--depth') opts.maxDepth = parseInt(args[++i]) || Infinity;
    else if (a === '-C' || a === '--cursor-interactive') opts.cursorInteractive = true;
  }
  return opts;
}

// Pure tree-building logic extracted from perceiveStr for testability.
// Takes raw AX nodes + page metadata, returns enriched tree lines and ref node IDs.
function buildPerceiveTree(nodes, meta, refMap, opts = {}) {
  const { maxDepth = Infinity, interactiveOnly = false } = opts;

  const nodesById = new Map(nodes.map(n => [n.nodeId, n]));
  const childrenByParent = new Map();
  for (const n of nodes) {
    if (!n.parentId) continue;
    if (!childrenByParent.has(n.parentId)) childrenByParent.set(n.parentId, []);
    childrenByParent.get(n.parentId).push(n);
  }

  // Layout consumption cursors (each role's entries are consumed in document order)
  const layoutCursors = {};
  for (const [role, entries] of Object.entries(meta.layoutMap || {})) {
    layoutCursors[role] = { entries, idx: 0 };
  }
  function consumeLayout(role) {
    const cursor = layoutCursors[role];
    if (!cursor || cursor.idx >= cursor.entries.length) return null;
    return cursor.entries[cursor.idx++];
  }

  // Track table rows to cap output
  const TABLE_ROW_LIMIT = 5;
  const tableRowCounts = new Map();
  const tableIdxMap = new Map();
  let nextTableIdx = 0;
  const rowCellIdx = new Map();
  const dataRowIdx = new Map();

  // Clear and rebuild ref map
  refMap.clear();
  let refCounter = 0;
  const refNodeIds = [];

  const treeLines = [];
  const visited = new Set();

  function markSubtreeVisited(nodeId) {
    visited.add(nodeId);
    for (const child of (childrenByParent.get(nodeId) || [])) {
      markSubtreeVisited(child.nodeId);
    }
  }

  function visit(node, depth, parentNode = null, tableAncestorId = null) {
    if (!node || visited.has(node.nodeId)) return;
    visited.add(node.nodeId);

    const role = node.role?.value || '';
    const name = node.name?.value ?? '';

    // Depth limit: still assign refs but don't output deeper nodes
    if (depth > maxDepth) {
      if (INTERACTIVE_ROLES.has(role) && node.backendDOMNodeId) {
        refCounter++;
        refMap.set(refCounter, node.backendDOMNodeId);
        refNodeIds.push({ ref: refCounter, backendDOMNodeId: node.backendDOMNodeId });
      }
      for (const child of orderedAxChildren(node, nodesById, childrenByParent)) {
        visit(child, depth + 1, node, tableAncestorId);
      }
      return;
    }

    // Detect table context: track row counts per table ancestor
    if (role === 'table' || role === 'grid' || role === 'treegrid') {
      tableAncestorId = node.nodeId;
      tableRowCounts.set(tableAncestorId, 0);
      dataRowIdx.set(tableAncestorId, -1);
      if (!tableIdxMap.has(tableAncestorId)) {
        tableIdxMap.set(tableAncestorId, nextTableIdx++);
      }
    }
    if (tableAncestorId && role === 'row') {
      const count = tableRowCounts.get(tableAncestorId) || 0;
      tableRowCounts.set(tableAncestorId, count + 1);
      rowCellIdx.set(tableAncestorId, 0);
      if (count >= TABLE_ROW_LIMIT) {
        if (count === TABLE_ROW_LIMIT) {
          treeLines.push(formatAxNode({ role: { value: 'note' }, name: { value: '... more rows truncated' } }, depth));
        }
        markSubtreeVisited(node.nodeId);
        return;
      }
    }

    // Filter decorative icon images (short lowercase names like "thunderbolt", "check-circle")
    if (role === 'image') {
      if (name.length < 25 && name === name.toLowerCase() && !name.includes(' ')) {
        markSubtreeVisited(node.nodeId);
        return;
      }
    }

    // Track cell index unconditionally (even for filtered nodes) to stay aligned with browser-side
    const isCellRole = tableAncestorId && (role === 'cell' || role === 'gridcell' || role === 'columnheader' || role === 'rowheader');
    let cellColIdx = -1;
    if (isCellRole) {
      cellColIdx = rowCellIdx.get(tableAncestorId) || 0;
      rowCellIdx.set(tableAncestorId, cellColIdx + 1);
      if ((role === 'cell' || role === 'gridcell') && cellColIdx === 0) {
        dataRowIdx.set(tableAncestorId, (dataRowIdx.get(tableAncestorId) ?? -1) + 1);
      }
    }

    const isInteractive = INTERACTIVE_ROLES.has(role);

    // --interactive mode: only show interactive elements and their immediate structural parents
    if (interactiveOnly && !isInteractive && !ENRICHED_ROLES.has(role)) {
      for (const child of orderedAxChildren(node, nodesById, childrenByParent)) {
        visit(child, depth, node, tableAncestorId);
      }
      return;
    }

    if (shouldShowAxNode(node, true, parentNode)) {
      let line = formatAxNode(node, depth);

      // Assign @ref to interactive elements
      if (isInteractive && node.backendDOMNodeId) {
        refCounter++;
        refMap.set(refCounter, node.backendDOMNodeId);
        refNodeIds.push({ ref: refCounter, backendDOMNodeId: node.backendDOMNodeId });
        line += `  @${refCounter}`;
      }

      // Enrich landmark/structural nodes with layout annotations
      if (ENRICHED_ROLES.has(role)) {
        const layout = consumeLayout(role);
        if (layout) {
          const parts = [];
          if (layout.w) parts.push(`${layout.w}×${layout.h}px`);
          else if (layout.h >= 40) parts.push(`↕${layout.h}px`);
          if (layout.bg) parts.push(`bg:${layout.bg}`);
          if (layout.font) parts.push(layout.font);
          if (layout.color) parts.push(`color:${layout.color}`);
          if (layout.display) {
            let d = layout.display;
            if (layout.gap) d += ` gap:${layout.gap}`;
            parts.push(d);
          }
          if (layout.opacity) parts.push(`opacity:${layout.opacity}`);
          if (layout.vis === 'above') parts.push('↑above fold');
          else if (layout.vis === 'below') parts.push('↓below fold');
          if (parts.length > 0) line += '  ' + parts.join('  ');
        }
      }

      // Enrich table cells with style hints (positional key: tableIdx:rowIdx:colIdx)
      if (isCellRole && meta.styleHints) {
        const ti = tableIdxMap.get(tableAncestorId);
        const ri = dataRowIdx.get(tableAncestorId) ?? -1;
        if (ti != null && ri >= 0) {
          const hint = meta.styleHints[ti + ':' + ri + ':' + cellColIdx];
          if (hint) line += '  ' + hint;
        }
      }
      treeLines.push(line);
    }
    for (const child of orderedAxChildren(node, nodesById, childrenByParent)) {
      visit(child, depth + 1, node, tableAncestorId);
    }
  }

  const roots = nodes.filter(n => !n.parentId || !nodesById.has(n.parentId));
  for (const root of roots) visit(root, 0);
  for (const node of nodes) visit(node, 0);

  return { treeLines, refNodeIds };
}

// Browser-side script for perceiveStr — extracted for readability and testability.
// Collects page metadata, layout map, style hints, and cursor-interactive elements.
function perceivePageScript(cursorInteractive) {
  return `(function() {
      const vw = window.innerWidth, vh = window.innerHeight;
      const scrollY = Math.round(window.scrollY);
      const scrollMax = Math.round(document.documentElement.scrollHeight - window.innerHeight);

      // Interactive element counts
      const counts = {};
      for (const el of document.querySelectorAll('a, button, input, select, textarea, [role="button"], [tabindex]')) {
        const tag = el.tagName.toLowerCase();
        const type = tag === 'input' ? 'input[' + (el.type || 'text') + ']' : tag;
        counts[type] = (counts[type] || 0) + 1;
      }

      // Build layout map keyed by ARIA role (matching AX tree roles)
      const TAG_ROLE = {
        header:'banner', nav:'navigation', main:'main', footer:'contentinfo',
        aside:'complementary', form:'form', table:'table', dialog:'dialog',
        article:'article', section:'region', img:'img', video:'video',
        h1:'heading', h2:'heading', h3:'heading', h4:'heading', h5:'heading', h6:'heading'
      };
      const selectors = 'header,nav,main,footer,aside,section,article,form,h1,h2,h3,h4,h5,h6,img,video,table,dialog,[role="banner"],[role="navigation"],[role="main"],[role="contentinfo"],[role="dialog"],[role="alert"],[role="region"],[role="complementary"]';
      const layoutMap = {};
      let count = 0;
      for (const el of document.querySelectorAll(selectors)) {
        const rect = el.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) continue;
        const cs = window.getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;

        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute('role') || TAG_ROLE[tag] || tag;
        const info = { h: Math.round(rect.height) };

        // Only include width if element is significantly narrower than viewport
        const w = Math.round(rect.width);
        if (w < vw * 0.9) info.w = w;

        // Key visual properties (only non-defaults)
        const bg = cs.backgroundColor;
        if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') info.bg = bg;
        if (tag.match(/^h[1-6]$/)) {
          info.font = cs.fontSize + ' ' + cs.fontWeight;
          if (cs.color && cs.color !== 'rgb(0, 0, 0)') info.color = cs.color;
        }
        if (cs.display === 'flex' || cs.display === 'grid') {
          info.display = cs.display;
          if (cs.gap && cs.gap !== 'normal' && cs.gap !== '0px') info.gap = cs.gap;
        }
        if (cs.opacity !== '1') info.opacity = cs.opacity;

        // Viewport visibility
        const top = rect.top, bot = rect.bottom;
        if (bot < 0) info.vis = 'above';
        else if (top > vh) info.vis = 'below';
        // else: in viewport (default, no annotation needed)

        if (!layoutMap[role]) layoutMap[role] = [];
        layoutMap[role].push(info);
        if (++count >= 150) break;
      }

      // === Style hints: detect visual anomalies on table cells ===
      const styleHints = {};
      let styleHintCount = 0;
      const CELL_SEL = 'td, th, [role="cell"], [role="gridcell"], [role="columnheader"], [role="rowheader"]';
      const BASELINE_ROW_CAP = 20; // enough rows for reliable baseline, avoids scanning huge tables
      function majority(counts) {
        let best = null, bestN = 0;
        for (const [v, n] of Object.entries(counts)) { if (n > bestN) { best = v; bestN = n; } }
        return best;
      }
      const allTables = document.querySelectorAll('table, [role="grid"], [role="treegrid"]');
      // Filter out presentation/hidden tables to match AX tree traversal order
      const visTables = [];
      for (const t of allTables) {
        const r = t.getAttribute('role');
        if (r === 'presentation' || r === 'none') continue;
        if (t.getAttribute('aria-hidden') === 'true') continue;
        const cs = window.getComputedStyle(t);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        visTables.push(t);
      }
      for (let ti = 0; ti < visTables.length && styleHintCount < 100; ti++) {
        const tbl = visTables[ti];
        const rows = tbl.querySelectorAll('tr, [role="row"]');
        const dataRows = [];
        for (const row of rows) {
          const firstCell = row.querySelector('td, [role="cell"], [role="gridcell"]');
          if (firstCell) dataRows.push(row);
        }
        if (dataRows.length === 0) continue;
        const smallTable = dataRows.length < 4;
        const scanRows = dataRows.slice(0, BASELINE_ROW_CAP);

        // Single pass: collect styles, build baselines, cache per-cell data
        const colBgs = {}, colWeights = {}, colColors = {};
        const cellCache = []; // [{cells: [{bg, fw, clr, ci}]}] per row
        for (const row of scanRows) {
          const cells = row.querySelectorAll(CELL_SEL);
          const rowData = [];
          let ci = 0;
          for (const cell of cells) {
            if (cell.colSpan > 1) { ci += cell.colSpan; continue; }
            const cs = window.getComputedStyle(cell);
            const bg = cs.backgroundColor;
            const fw = parseInt(cs.fontWeight) || 400;
            const clr = cs.color;
            if (!colBgs[ci]) { colBgs[ci] = {}; colWeights[ci] = {}; colColors[ci] = {}; }
            colBgs[ci][bg] = (colBgs[ci][bg] || 0) + 1;
            colWeights[ci][fw] = (colWeights[ci][fw] || 0) + 1;
            colColors[ci][clr] = (colColors[ci][clr] || 0) + 1;
            rowData.push({ bg, fw, clr, ci });
            ci++;
          }
          cellCache.push(rowData);
        }

        // Compute baselines from collected data
        const baseBg = {}, baseWeight = {}, baseColor = {};
        for (const ci of Object.keys(colBgs)) {
          baseBg[ci] = majority(colBgs[ci]);
          baseWeight[ci] = parseInt(majority(colWeights[ci])) || 400;
          baseColor[ci] = majority(colColors[ci]);
        }

        // Emit hints from cached styles (no second getComputedStyle pass)
        for (let ri = 0; ri < cellCache.length; ri++) {
          for (const { bg, fw, clr, ci } of cellCache[ri]) {
            const hints = [];
            if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
              if (smallTable || bg !== baseBg[ci]) hints.push('bg:' + bg);
            }
            if (fw > 400 && (smallTable || fw !== baseWeight[ci])) hints.push('bold');
            if (clr && clr !== 'rgb(0, 0, 0)') {
              if (smallTable || clr !== baseColor[ci]) hints.push('color:' + clr);
            }
            if (hints.length > 0) {
              styleHints[ti + ':' + ri + ':' + ci] = hints.join(' ');
              if (++styleHintCount >= 100) break;
            }
          }
          if (styleHintCount >= 100) break;
        }
      }

      // Focused element
      const focused = document.activeElement;
      const focusDesc = focused && focused !== document.body
        ? '<' + focused.tagName.toLowerCase() + (focused.id ? '#' + focused.id : '') + '>'
        : 'none';

      // Cursor-interactive scan: find non-ARIA clickable elements (cursor:pointer, onclick, tabindex)
      const cursorInteractives = [];
      if (${cursorInteractive}) {
        const ARIA_INTERACTIVE = new Set(['A','BUTTON','INPUT','SELECT','TEXTAREA']);
        const seen = new Set();
        const candidates = document.querySelectorAll('div, span, li, td, tr, label, img, svg, i, p, section, article, [onclick], [tabindex]:not(a):not(button):not(input):not(select):not(textarea)');
        for (const el of candidates) {
          if (ARIA_INTERACTIVE.has(el.tagName)) continue;
          if (el.getAttribute('role')) continue;
          if (el.closest('a, button, input, select, textarea, [role]')) continue;
          const cs = window.getComputedStyle(el);
          const clickable = cs.cursor === 'pointer' || el.hasAttribute('onclick') || (el.hasAttribute('tabindex') && el.tabIndex >= 0);
          if (!clickable) continue;
          if (cs.display === 'none' || cs.visibility === 'hidden') continue;
          const rect = el.getBoundingClientRect();
          if (rect.width < 5 || rect.height < 5) continue;
          // Build a CSS selector path for this element
          let sel = el.tagName.toLowerCase();
          if (el.id) sel += '#' + CSS.escape(el.id);
          else if (el.className && typeof el.className === 'string') {
            const cls = el.className.trim().split(/\\s+/).slice(0, 2).map(c => '.' + CSS.escape(c)).join('');
            sel += cls;
          }
          const key = sel + '|' + Math.round(rect.x) + ',' + Math.round(rect.y);
          if (seen.has(key)) continue;
          seen.add(key);
          const text = el.textContent.trim().substring(0, 60);
          cursorInteractives.push({ sel, text, x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) });
          if (cursorInteractives.length >= 50) break;
        }
      }

      return JSON.stringify({
        title: document.title, url: window.location.href,
        vw, vh, scrollY, scrollMax,
        counts, focused: focusDesc, layoutMap, styleHints, cursorInteractives
      });
    })()`;
}

async function perceiveStr(cdp, sid, consoleBuf, exceptionBuf, refMap, lastPerceiveStore, opts = {}) {
  const { diff: diffMode = false, selector: scopeSelector = null, exclude: excludeSelector = null, interactive: interactiveOnly = false, maxDepth = Infinity, cursorInteractive = false } = opts;
  // Get AX tree nodes and page metadata + layout map in parallel
  // Hoist DOM.getDocument so scope and exclude can share it
  const needsDocument = scopeSelector || excludeSelector;
  const docRootPromise = needsDocument ? cdp.send('DOM.getDocument', {}, sid) : null;
  const axPromise = scopeSelector
    ? (async () => {
        const { root } = await docRootPromise;
        const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: scopeSelector }, sid);
        if (!nodeId) throw new Error(`Scope selector not found: ${scopeSelector}`);
        const { node } = await cdp.send('DOM.describeNode', { nodeId }, sid);
        return cdp.send('Accessibility.getFullAXTree', { backendNodeId: node.backendNodeId }, sid);
      })()
    : cdp.send('Accessibility.getFullAXTree', {}, sid);
  const [axResult, metaJson] = await Promise.all([
    axPromise,
    evalStr(cdp, sid, perceivePageScript(cursorInteractive))
  ]);

  const meta = JSON.parse(metaJson);

  // Console health
  const allConsole = consoleBuf.all();
  let errors = 0, warnings = 0;
  for (const e of allConsole) {
    if (e.level === 'error') errors++;
    else if (e.level === 'warning' || e.level === 'warn') warnings++;
  }
  const exceptions = exceptionBuf.all().length;

  // Exclude filtering: remove AX subtrees rooted at excluded DOM nodes
  let axNodes = axResult.nodes;
  if (excludeSelector) {
    const { root } = await docRootPromise;
    const excludedBackendNodeIds = new Set();
    const exNodes = await cdp.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: excludeSelector }, sid);
    if (exNodes.nodeIds) {
      const results = await Promise.allSettled(
        exNodes.nodeIds.map(nid => cdp.send('DOM.describeNode', { nodeId: nid }, sid))
      );
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value.node.backendNodeId)
          excludedBackendNodeIds.add(r.value.node.backendNodeId);
      }
    }
    if (excludedBackendNodeIds.size > 0) {
      const excludedAxIds = new Set();
      for (const n of axNodes) {
        if (n.backendDOMNodeId && excludedBackendNodeIds.has(n.backendDOMNodeId)) excludedAxIds.add(n.nodeId);
      }
      if (excludedAxIds.size > 0) {
        const childMap = new Map();
        for (const n of axNodes) {
          if (n.parentId) {
            if (!childMap.has(n.parentId)) childMap.set(n.parentId, []);
            childMap.get(n.parentId).push(n.nodeId);
          }
        }
        const queue = [...excludedAxIds];
        while (queue.length) {
          const id = queue.pop();
          for (const child of (childMap.get(id) || [])) {
            excludedAxIds.add(child);
            queue.push(child);
          }
        }
        axNodes = axNodes.filter(n => !excludedAxIds.has(n.nodeId));
      }
    }
  }

  const { treeLines, refNodeIds } = buildPerceiveTree(axNodes, meta, refMap, { maxDepth, interactiveOnly });

  // === Batch-resolve @ref bounding rects (parallel, non-scrolling) ===
  const refRects = new Map(); // ref number → {x, y, w, h}
  if (refNodeIds.length > 0) {
    const results = await Promise.allSettled(refNodeIds.map(async ({ ref, backendDOMNodeId }) => {
      const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: backendDOMNodeId }, sid);
      const res = await cdp.send('Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: `function() { const r = this.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; }`,
        returnByValue: true,
      }, sid);
      return { ref, rect: res.result.value };
    }));
    for (const r of results) {
      if (r.status === 'fulfilled') refRects.set(r.value.ref, r.value.rect);
    }
  }

  // Inject @ref coordinates into treeLines
  for (let i = 0; i < treeLines.length; i++) {
    const m = treeLines[i].match(/@(\d+)$/);
    if (m) {
      const rect = refRects.get(parseInt(m[1]));
      if (rect) treeLines[i] += `  (${rect.x},${rect.y} ${rect.w}×${rect.h})`;
    }
  }

  // === Cursor-interactive @c refs ===
  let cRefCounter = 0;
  if (cursorInteractive && meta.cursorInteractives?.length > 0) {
    treeLines.push('');
    treeLines.push('[Cursor-interactive elements] (non-ARIA clickable)');
    for (const ci of meta.cursorInteractives) {
      cRefCounter++;
      treeLines.push(`  [clickable] ${ci.text || ci.sel}  @c${cRefCounter}  (${ci.x},${ci.y} ${ci.w}×${ci.h})`);
    }
  }

  // === Assemble output ===
  const lines = [];
  lines.push(`Page: ${meta.title} — ${meta.url}`);

  const scrollPct = meta.scrollMax > 0 ? Math.round(meta.scrollY / meta.scrollMax * 100) : 0;
  lines.push(`Viewport: ${meta.vw}×${meta.vh} | Scroll: ${meta.scrollY}/${meta.scrollMax > 0 ? meta.scrollMax : 0} (${scrollPct}%) | Focused: ${meta.focused}`);

  const countParts = Object.entries(meta.counts).map(([k, v]) => `${v} ${k}`);
  lines.push(`Interactive: ${countParts.length > 0 ? countParts.join(', ') : 'none'}`);

  const healthParts = [];
  if (errors > 0) healthParts.push(`${errors} error${errors > 1 ? 's' : ''}`);
  if (warnings > 0) healthParts.push(`${warnings} warning${warnings > 1 ? 's' : ''}`);
  if (exceptions > 0) healthParts.push(`${exceptions} exception${exceptions > 1 ? 's' : ''}`);
  lines.push(`Console: ${healthParts.length > 0 ? healthParts.join(', ') : 'clean'}`);

  lines.push('');
  lines.push(...treeLines);

  const output = lines.join('\n');

  // Diff mode: compare with previous perceive output
  if (diffMode && lastPerceiveStore.output) {
    const prev = lastPerceiveStore.output.split('\n');
    const curr = output.split('\n');
    const diffLines = [];
    // Skip header lines (first 4), diff the tree
    const headerEnd = 4;
    const prevTree = prev.slice(headerEnd);
    const currTree = curr.slice(headerEnd);
    // Line-level diff with StaticText noise filtering
    const prevSet = new Set(prevTree);
    const currSet = new Set(currTree);
    const removed = prevTree.filter(l => !currSet.has(l));
    const added = currTree.filter(l => !prevSet.has(l));
    // Separate structural changes from text-only noise
    const isTextOnly = l => /^\s*\[StaticText\]/.test(l);
    const removedStructural = removed.filter(l => !isTextOnly(l));
    const addedStructural = added.filter(l => !isTextOnly(l));
    const removedText = removed.length - removedStructural.length;
    const addedText = added.length - addedStructural.length;
    if (removedStructural.length === 0 && addedStructural.length === 0 && removedText === 0 && addedText === 0) {
      diffLines.push('(no changes detected in AX tree)');
    } else {
      if (removedStructural.length > 0) {
        diffLines.push(`--- Removed (${removedStructural.length}):`);
        for (const l of removedStructural.slice(0, 20)) diffLines.push(`- ${l}`);
        if (removedStructural.length > 20) diffLines.push(`  ... and ${removedStructural.length - 20} more`);
      }
      if (addedStructural.length > 0) {
        diffLines.push(`+++ Added (${addedStructural.length}):`);
        for (const l of addedStructural.slice(0, 20)) diffLines.push(`+ ${l}`);
        if (addedStructural.length > 20) diffLines.push(`  ... and ${addedStructural.length - 20} more`);
      }
      // Summarize text-only changes in one line instead of listing each
      if (removedText > 0 || addedText > 0) {
        const parts = [];
        if (removedText > 0) parts.push(`${removedText} removed`);
        if (addedText > 0) parts.push(`${addedText} added`);
        diffLines.push(`~~~ Text nodes updated (${parts.join(', ')})`);
      }
    }
    // Include current header + diff
    lastPerceiveStore.output = output;
    return curr.slice(0, headerEnd).join('\n') + '\n\n' + diffLines.join('\n');
  }

  lastPerceiveStore.output = output;
  // Hint when perceive returns many interactive elements without exclude
  if (interactiveOnly && !excludeSelector && refNodeIds.length > 50) {
    return output + `\n\n(Hint: ${refNodeIds.length} interactive elements found — most may be sidebar/nav noise. Use \`perceive -x "nav, aside"\` to exclude, or \`perceive -s "main"\` to scope.)`;
  }
  return output;
}

// Element screenshot: targeted capture of a specific element by CSS selector or @ref
async function elshotStr(cdp, sid, selector, targetId, refMap) {
  if (!selector) throw new Error('CSS selector or @ref required');
  if (isRef(selector)) {
    const r = await resolveRef(cdp, sid, refMap, selector);
    const pad = 8;
    const clipX = Math.max(0, r.x - pad);
    const clipY = Math.max(0, r.y - pad);
    const clipW = r.w + pad * 2;
    const clipH = r.h + pad * 2;
    await sleep(100);
    const clip = { x: clipX, y: clipY, width: clipW, height: clipH, scale: 1 };
    const { data, fallback } = await captureScreenshot(cdp, sid, { format: 'png', clip });
    const prefix = (targetId || 'unknown').slice(0, 8);
    const out = resolve(RUNTIME_DIR, `elshot-${prefix}-ref${selector.slice(1)}.png`);
    writeFileSync(out, Buffer.from(data, 'base64'));
    const fb = fallback ? ' (fallback)' : '';
    return `${out}\nElement screenshot of <${r.tag}> "${r.text}" (${selector}) — ${Math.round(r.w)}×${Math.round(r.h)} CSS px${fb}`;
  }
  // Scroll element into view and get its bounding rect
  const expr = `
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, error: 'Element not found: ' + ${JSON.stringify(selector)} };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = el.getBoundingClientRect();
      return {
        ok: true,
        x: rect.x, y: rect.y, w: rect.width, h: rect.height,
        tag: el.tagName, id: el.id,
        text: el.textContent.trim().substring(0, 60)
      };
    })()
  `;
  const result = await evalStr(cdp, sid, expr);
  const r = JSON.parse(result);
  if (!r.ok) throw new Error(r.error);

  // Small padding around the element (clamped to viewport)
  const pad = 8;
  const clipX = Math.max(0, r.x - pad);
  const clipY = Math.max(0, r.y - pad);
  const clipW = r.w + pad * 2;
  const clipH = r.h + pad * 2;

  await sleep(100); // let scroll settle

  const clip = { x: clipX, y: clipY, width: clipW, height: clipH, scale: 1 };
  const { data, fallback } = await captureScreenshot(cdp, sid, { format: 'png', clip });

  const prefix = (targetId || 'unknown').slice(0, 8);
  const selSafe = selector.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 30);
  const out = resolve(RUNTIME_DIR, `elshot-${prefix}-${selSafe}.png`);
  writeFileSync(out, Buffer.from(data, 'base64'));

  const desc = `<${r.tag}>${r.id ? '#' + r.id : ''} "${r.text}"`;
  const fb = fallback ? ' (fallback)' : '';
  return `${out}\nElement screenshot of ${desc} — ${Math.round(r.w)}×${Math.round(r.h)} CSS px (clip: ${Math.round(clipW)}×${Math.round(clipH)} with padding)${fb}`;
}

// Shared: dispatch a realistic mouse click at CSS pixel coordinates
async function dispatchClick(cdp, sid, x, y) {
  const base = { x, y, button: 'left', clickCount: 1, modifiers: 0 };
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseMoved' }, sid);
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' }, sid);
  await sleep(50);
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' }, sid);
}

// Shared: get device pixel ratio
async function getDpr(cdp, sid) {
  try {
    const raw = await evalStr(cdp, sid, 'window.devicePixelRatio');
    const parsed = parseFloat(raw);
    if (parsed > 0) return parsed;
  } catch {}
  return 1;
}

// Click element by CSS selector or @ref
async function clickStr(cdp, sid, selector, refMap) {
  if (!selector) throw new Error('CSS selector or @ref required');
  if (isRef(selector)) {
    const r = await resolveRef(cdp, sid, refMap, selector);
    await dispatchClick(cdp, sid, r.x + r.w / 2, r.y + r.h / 2);
    return `Clicked <${r.tag}> "${r.text}" (${selector})`;
  }
  const expr = `
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, error: 'Element not found: ' + ${JSON.stringify(selector)} };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = el.getBoundingClientRect();
      return { ok: true, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, tag: el.tagName, text: el.textContent.trim().substring(0, 80) };
    })()
  `;
  const result = await evalStr(cdp, sid, expr);
  const r = JSON.parse(result);
  if (!r.ok) throw new Error(r.error);
  await dispatchClick(cdp, sid, r.x, r.y);
  return `Clicked <${r.tag}> "${r.text}"`;
}

// Click at CSS pixel coordinates using Input.dispatchMouseEvent
async function clickXyStr(cdp, sid, x, y) {
  const cx = parseFloat(x);
  const cy = parseFloat(y);
  if (isNaN(cx) || isNaN(cy)) throw new Error('x and y must be numbers (CSS pixels)');
  await dispatchClick(cdp, sid, cx, cy);
  return `Clicked at CSS (${cx}, ${cy})`;
}

// Type text using Input.insertText (works in cross-origin iframes, unlike eval)
async function typeStr(cdp, sid, text) {
  if (text == null || text === '') throw new Error('text required');
  await cdp.send('Input.insertText', { text }, sid);
  return `Typed ${text.length} characters`;
}

const KEY_MAP = {
  enter:      { key: 'Enter',      code: 'Enter',      keyCode: 13 },
  tab:        { key: 'Tab',        code: 'Tab',        keyCode: 9 },
  escape:     { key: 'Escape',     code: 'Escape',     keyCode: 27 },
  backspace:  { key: 'Backspace',  code: 'Backspace',  keyCode: 8 },
  delete:     { key: 'Delete',     code: 'Delete',     keyCode: 46 },
  space:      { key: ' ',          code: 'Space',      keyCode: 32 },
  arrowup:    { key: 'ArrowUp',    code: 'ArrowUp',    keyCode: 38 },
  arrowdown:  { key: 'ArrowDown',  code: 'ArrowDown',  keyCode: 40 },
  arrowleft:  { key: 'ArrowLeft',  code: 'ArrowLeft',  keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
};

async function pressStr(cdp, sid, keyName) {
  if (!keyName) throw new Error('Key name required (Enter, Tab, Escape, Backspace, Space, Arrow*)');
  const mapped = KEY_MAP[keyName.toLowerCase()];
  if (!mapped) throw new Error(`Unknown key: ${keyName}. Supported: ${Object.keys(KEY_MAP).join(', ')}`);
  const base = { key: mapped.key, code: mapped.code, windowsVirtualKeyCode: mapped.keyCode, nativeVirtualKeyCode: mapped.keyCode };
  await cdp.send('Input.dispatchKeyEvent', { ...base, type: 'keyDown' }, sid);
  await cdp.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' }, sid);
  return `Pressed ${mapped.key}`;
}

async function scrollStr(cdp, sid, direction, amount) {
  const px = parseInt(amount) || 500;
  const dirMap = { down: [0, px], up: [0, -px], left: [-px, 0], right: [px, 0] };
  let dx, dy;
  if (dirMap[direction?.toLowerCase()]) {
    [dx, dy] = dirMap[direction.toLowerCase()];
  } else if (direction?.includes(',')) {
    [dx, dy] = direction.split(',').map(Number);
    if (isNaN(dx) || isNaN(dy)) throw new Error('Invalid coordinates. Use "down", "up", or "x,y"');
  } else {
    throw new Error('Direction required: down, up, left, right, or x,y');
  }
  const result = await evalStr(cdp, sid, `(window.scrollBy(${dx}, ${dy}), JSON.stringify({ x: Math.round(window.scrollX), y: Math.round(window.scrollY) }))`);
  const pos = JSON.parse(result);
  return `Scrolled by (${dx}, ${dy}). Position: (${pos.x}, ${pos.y})`;
}

async function hoverStr(cdp, sid, selector, refMap) {
  if (!selector) throw new Error('CSS selector or @ref required');
  if (isRef(selector)) {
    const r = await resolveRef(cdp, sid, refMap, selector);
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    await cdp.send('Input.dispatchMouseEvent', { x: cx, y: cy, type: 'mouseMoved', button: 'none', modifiers: 0 }, sid);
    return `Hovering over <${r.tag}> at CSS (${Math.round(cx)}, ${Math.round(cy)}) (${selector})`;
  }
  const expr = `
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, error: 'Element not found: ' + ${JSON.stringify(selector)} };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = el.getBoundingClientRect();
      return { ok: true, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, tag: el.tagName };
    })()
  `;
  const result = await evalStr(cdp, sid, expr);
  const r = JSON.parse(result);
  if (!r.ok) throw new Error(r.error);
  await cdp.send('Input.dispatchMouseEvent', { x: r.x, y: r.y, type: 'mouseMoved', button: 'none', modifiers: 0 }, sid);
  return `Hovering over <${r.tag}> at CSS (${Math.round(r.x)}, ${Math.round(r.y)})`;
}

async function waitForStr(cdp, sid, args, refMap) {
  // Shared polling loop
  async function poll(jsExpr, formatResult, interval, timeoutMs, label) {
    const timeout = Math.min(Math.max(timeoutMs, 500), 300000);
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const found = await evalStr(cdp, sid, jsExpr);
      if (found !== 'null' && found !== '') return formatResult(JSON.parse(found));
      await sleep(interval);
    }
    throw new Error(`Timeout: ${label} not found within ${timeout}ms`);
  }

  // --gone: wait for element to DISAPPEAR (e.g. stop button after streaming)
  if (args[0] === '--gone') {
    const selector = args[1];
    if (!selector) throw new Error('CSS selector or @ref required after --gone');
    const timeoutMs = parseInt(args[2]) || 30000;
    const timeout = Math.min(Math.max(timeoutMs, 500), 300000);
    const deadline = Date.now() + timeout;

    // Resolve @ref to a JS check via backendNodeId
    if (isRef(selector) && refMap) {
      const num = parseInt(selector.slice(1));
      const backendNodeId = refMap.get(num);
      if (!backendNodeId) throw new Error(`Unknown ref: ${selector}. Run "perceive" first.`);
      while (Date.now() < deadline) {
        try {
          const { object } = await cdp.send('DOM.resolveNode', { backendNodeId }, sid);
          // Node still exists — check if it's connected and visible
          const res = await cdp.send('Runtime.callFunctionOn', {
            objectId: object.objectId,
            functionDeclaration: `function() { return this.isConnected && this.offsetParent !== null; }`,
            returnByValue: true,
          }, sid);
          if (!res.result.value) return `Element ${selector} is gone (disconnected or hidden)`;
        } catch {
          return `Element ${selector} is gone (removed from DOM)`;
        }
        await sleep(300);
      }
      throw new Error(`Timeout: ${selector} still present after ${timeout}ms`);
    }

    // CSS selector mode
    while (Date.now() < deadline) {
      const found = await evalStr(cdp, sid, `document.querySelector(${JSON.stringify(selector)}) ? 'yes' : null`);
      if (found === 'null' || found === '') return `Element "${selector}" is gone`;
      await sleep(300);
    }
    throw new Error(`Timeout: "${selector}" still present after ${timeout}ms`);
  }

  // Parse args: waitfor <selector> [timeout] OR waitfor --text <text> [--scope <sel>] [timeout]
  if (args[0] === '--text') {
    const text = args[1];
    if (!text) throw new Error('Text string required after --text');
    let scope = 'body';
    let timeoutMs = 30000;
    for (let i = 2; i < args.length; i++) {
      if (args[i] === '--scope' || args[i] === '-s') scope = args[++i];
      else timeoutMs = parseInt(args[i]) || 30000;
    }
    return poll(
      `(function() {
        const el = document.querySelector(${JSON.stringify(scope)});
        if (!el) return null;
        const t = el.innerText;
        const idx = t.indexOf(${JSON.stringify(text)});
        if (idx === -1) return null;
        return { len: t.length, snippet: t.substring(Math.max(0, idx - 20), idx + ${text.length} + 80).trim() };
      })()`,
      r => `Found text (page has ${r.len} chars): "...${r.snippet}..."`,
      500, timeoutMs, `text "${text}"`
    );
  }
  // CSS selector mode
  const selector = args[0];
  if (!selector) throw new Error('CSS selector or --text required');
  const timeoutMs = parseInt(args[1]) || 10000;
  try {
    return await poll(
      `(function() {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        return { tag: el.tagName, text: el.textContent.trim().substring(0, 80) };
      })()`,
      r => `Found <${r.tag}> "${r.text}"`,
      200, timeoutMs, `"${selector}"`
    );
  } catch (e) {
    throw new Error(e.message + ' — to wait for specific text content instead, use: waitfor --text "expected text" 120000');
  }
}

async function fillStr(cdp, sid, selector, text, refMap) {
  if (!selector) throw new Error('CSS selector or @ref required');
  if (text == null) throw new Error('Text required');
  if (isRef(selector)) {
    const objectId = await resolveRefNode(cdp, sid, refMap, selector);
    await cdp.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function() { this.scrollIntoView({block:'center'}); this.focus(); this.value=''; this.dispatchEvent(new Event('input',{bubbles:true})); }`,
      returnByValue: true,
    }, sid);
    await cdp.send('Input.insertText', { text }, sid);
    return `Filled ${selector} with "${text.substring(0, 40)}${text.length > 40 ? '...' : ''}"`;
  }
  // Focus via JS (more reliable than mouse events for input focus) + get element info
  const expr = `
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, error: 'Element not found: ' + ${JSON.stringify(selector)} };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.focus();
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return { ok: true, tag: el.tagName };
    })()
  `;
  const result = await evalStr(cdp, sid, expr);
  const r = JSON.parse(result);
  if (!r.ok) throw new Error(r.error);
  // Insert text into the now-focused, cleared field
  await cdp.send('Input.insertText', { text }, sid);
  return `Filled <${r.tag}> with "${text.substring(0, 40)}${text.length > 40 ? '...' : ''}"`;
}

async function selectStr(cdp, sid, selector, value) {
  if (!selector) throw new Error('CSS selector required');
  if (value == null) throw new Error('Value required');
  const expr = `
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, error: 'Element not found: ' + ${JSON.stringify(selector)} };
      if (el.tagName !== 'SELECT') return { ok: false, error: 'Not a <select>: ' + el.tagName };
      el.value = ${JSON.stringify(value)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      const opt = el.options[el.selectedIndex];
      return { ok: true, text: opt ? opt.textContent.trim() : value };
    })()
  `;
  const result = await evalStr(cdp, sid, expr);
  const r = JSON.parse(result);
  if (!r.ok) throw new Error(r.error);
  return `Selected "${r.text}"`;
}

async function fullshotStr(cdp, sid, filePath, targetId) {
  const dpr = await getDpr(cdp, sid);
  const metrics = await cdp.send('Page.getLayoutMetrics', {}, sid);
  const width = metrics.cssContentSize?.width || metrics.contentSize?.width || 1280;
  const height = metrics.cssContentSize?.height || metrics.contentSize?.height || 800;

  const clip = { x: 0, y: 0, width, height, scale: 1 };
  const { data, fallback } = await captureScreenshot(cdp, sid, {
    format: 'png', captureBeyondViewport: true, clip,
  }, clip);

  const out = filePath || resolve(RUNTIME_DIR, `fullshot-${(targetId || 'unknown').slice(0, 8)}.png`);
  writeFileSync(out, Buffer.from(data, 'base64'));

  const fb = fallback ? ' (screenshot fallback — Page.captureScreenshot not available)' : '';
  return `${out}\nFull-page screenshot saved. Size: ${width}x${height} CSS px, DPR: ${dpr}${fb}\nNote: large pages produce tiny text. Use 'scanshot' for readable segmented capture.`;
}

async function scanshotStr(cdp, sid, targetId) {
  // Get viewport and page dimensions
  const dims = await evalStr(cdp, sid, `JSON.stringify({
    vw: window.innerWidth, vh: window.innerHeight,
    scrollH: document.documentElement.scrollHeight,
    scrollY: Math.round(window.scrollY)
  })`);
  const { vw, vh, scrollH, scrollY: originalY } = JSON.parse(dims);

  // Calculate segments (overlap by 10% to avoid cutting content at boundaries)
  const overlap = Math.round(vh * 0.1);
  const step = vh - overlap;
  const segments = [];
  for (let y = 0; y < scrollH; y += step) {
    segments.push(y);
  }
  // If the last segment is tiny (< 30% viewport), replace it with a
  // bottom-aligned capture so no content is clipped
  if (segments.length > 1) {
    const lastY = segments[segments.length - 1];
    const lastH = scrollH - lastY;
    if (lastH < vh * 0.3) {
      segments.pop();
      // Scroll the last capture so the viewport's bottom edge aligns with page bottom
      const bottomY = Math.max(0, scrollH - vh);
      if (bottomY > segments[segments.length - 1]) {
        segments.push(bottomY);
      }
    }
  }

  const files = [];
  const prefix = (targetId || 'unknown').slice(0, 8);

  let usedFallback = false;
  for (let i = 0; i < segments.length; i++) {
    const y = segments[i];
    // Scroll to segment
    await evalStr(cdp, sid, `window.scrollTo(0, ${y})`);
    await sleep(150); // let rendering settle

    const { data, fallback } = await captureScreenshot(cdp, sid, { format: 'png' });
    if (fallback) usedFallback = true;
    const out = resolve(RUNTIME_DIR, `scanshot-${prefix}-${i + 1}.png`);
    writeFileSync(out, Buffer.from(data, 'base64'));
    files.push(out);
  }

  // Restore original scroll position
  await evalStr(cdp, sid, `window.scrollTo(0, ${originalY})`);

  const lines = [`Captured ${files.length} segment(s) of ${vw}x${vh} viewport (page height: ${scrollH}px)`];
  if (usedFallback) lines.push(`(screenshot fallback — Page.captureScreenshot not available)`);
  for (let i = 0; i < files.length; i++) {
    lines.push(`  [${i + 1}/${files.length}] ${files[i]}`);
  }
  lines.push(`Use the Read tool to view each segment image.`);
  return lines.join('\n');
}

async function stylesStr(cdp, sid, selector) {
  if (!selector) throw new Error('CSS selector required');
  const expr = `
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const cs = window.getComputedStyle(el);
      const props = {};
      const keep = [
        'display','visibility','opacity','position','top','right','bottom','left',
        'width','height','min-width','min-height','max-width','max-height',
        'margin','padding','border','box-sizing','overflow','z-index',
        'flex','flex-direction','flex-wrap','align-items','justify-content','gap',
        'grid-template-columns','grid-template-rows',
        'color','background-color','background','font-size','font-weight','font-family',
        'line-height','text-align','text-decoration','text-overflow','white-space',
        'transform','transition','animation','cursor','pointer-events','user-select',
        'box-shadow','border-radius','outline',
      ];
      const skip = new Set([
        'none','normal','auto','0px','0','visible','static','content-box',
        'start','baseline','inherit','default','clip','row','nowrap',
        'rgb(0, 0, 0)','rgba(0, 0, 0, 0)',
      ]);
      const skipPatterns = [
        /^0px /,              // 0px none rgb(...)  — default border etc.
        /^rgba\\(0, ?0, ?0, ?0\\)/, // transparent backgrounds
        /^0 [01]+ auto$/,     // flex: 0 1 auto
        /none 0px$/,          // outline: rgb(...) none 0px — no outline
        /^all$/,              // transition: all — browser default
      ];
      for (const p of keep) {
        const v = cs.getPropertyValue(p);
        if (!v || skip.has(v)) continue;
        if (skipPatterns.some(re => re.test(v))) continue;
        props[p] = v;
      }
      return { tag: el.tagName, id: el.id, cls: el.className?.toString().substring(0, 80), props };
    })()
  `;
  const result = await evalStr(cdp, sid, expr);
  if (result === 'null') throw new Error('Element not found: ' + selector);
  const r = JSON.parse(result);
  const header = '<' + r.tag + '>' + (r.id ? '#' + r.id : '') + (r.cls ? '.' + r.cls.split(' ').join('.') : '');
  const lines = [header];
  for (const [k, v] of Object.entries(r.props)) {
    lines.push('  ' + k + ': ' + v);
  }
  return lines.join('\n');
}

async function cookiesStr(cdp, sid) {
  const { cookies } = await cdp.send('Network.getCookies', {}, sid);
  if (!cookies || cookies.length === 0) return 'No cookies';
  // Dynamic column width based on actual cookie names
  const nameW = Math.min(Math.max(...cookies.map(c => c.name.length)) + 2, 32);
  const lines = [];
  for (const c of cookies) {
    const val = c.value.length > 30 ? c.value.substring(0, 30) + '...' : c.value;
    const flags = [c.httpOnly && 'HttpOnly', c.secure && 'Secure', c.sameSite].filter(Boolean).join(' ');
    const exp = c.expires > 0 ? new Date(c.expires * 1000).toISOString().slice(0, 19) : 'session';
    lines.push(`${c.name.padEnd(nameW)} ${val.padEnd(34)} ${c.domain.padEnd(20)} ${exp.padEnd(20)} ${flags}`);
  }
  return lines.join('\n');
}

// Load-more: repeatedly click a button/selector until it disappears
async function loadAllStr(cdp, sid, selector, intervalMs = 1500) {
  if (!selector) throw new Error('CSS selector required');
  let clicks = 0;
  const deadline = Date.now() + 5 * 60 * 1000; // 5-minute hard cap
  while (Date.now() < deadline) {
    const expr = `
      (function() {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const rect = el.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      })()
    `;
    const result = await evalStr(cdp, sid, expr);
    if (result === 'null' || result === '') break;
    const r = JSON.parse(result);
    await dispatchClick(cdp, sid, r.x, r.y);
    clicks++;
    await sleep(intervalMs);
  }
  return `Clicked "${selector}" ${clicks} time(s) until it disappeared`;
}

async function annotshotStr(cdp, sid, targetId, refMap) {
  if (refMap.size === 0) throw new Error('No refs available. Run "perceive" first.');

  // Resolve all refs in parallel to get bounding rects
  const refEntries = [...refMap.entries()];
  const settled = await Promise.allSettled(refEntries.map(async ([num, backendNodeId]) => {
    const { object } = await cdp.send('DOM.resolveNode', { backendNodeId }, sid);
    const result = await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: `function() { const r = this.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }`,
      returnByValue: true,
    }, sid);
    return { num, ...result.result.value };
  }));
  const entries = settled.filter(s => s.status === 'fulfilled').map(s => s.value);

  // Inject overlay + draw labels + screenshot + cleanup in try/finally
  await evalStr(cdp, sid, `(function() {
    const overlay = document.createElement('div');
    overlay.id = '__cdp_annot_overlay__';
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:2147483647;';
    document.body.appendChild(overlay);
  })()`);

  try {
    await evalStr(cdp, sid, `(function() {
      const overlay = document.getElementById('__cdp_annot_overlay__');
      if (!overlay) return;
      const entries = ${JSON.stringify(entries)};
      for (const e of entries) {
        const box = document.createElement('div');
        box.style.cssText = 'position:fixed;border:2px solid red;pointer-events:none;' +
          'left:' + e.x + 'px;top:' + e.y + 'px;width:' + e.w + 'px;height:' + e.h + 'px;';
        const label = document.createElement('span');
        label.textContent = '@' + e.num;
        label.style.cssText = 'position:absolute;top:-16px;left:0;background:red;color:white;font:bold 11px monospace;padding:1px 3px;border-radius:2px;line-height:14px;';
        box.appendChild(label);
        overlay.appendChild(box);
      }
    })()`);

    await sleep(100);

    const { data, fallback } = await captureScreenshot(cdp, sid, { format: 'png' });
    const prefix = (targetId || 'unknown').slice(0, 8);
    const out = resolve(RUNTIME_DIR, `annotshot-${prefix}.png`);
    writeFileSync(out, Buffer.from(data, 'base64'));

    const fb = fallback ? ' (fallback)' : '';
    return `${out}\nAnnotated screenshot with ${entries.length} ref labels. Use refs (@1, @2...) from perceive output to identify elements.${fb}`;
  } finally {
    await evalStr(cdp, sid, `(function() { const el = document.getElementById('__cdp_annot_overlay__'); if (el) el.remove(); })()`).catch(() => {});
  }
}

// Send a raw CDP command and return the result as JSON
async function evalRawStr(cdp, sid, method, paramsJson) {
  if (!method) throw new Error('CDP method required (e.g. "DOM.getDocument")');
  let params = {};
  if (paramsJson) {
    try { params = JSON.parse(paramsJson); }
    catch { throw new Error(`Invalid JSON params: ${paramsJson}`); }
  }
  const result = await cdp.send(method, params, sid);
  return JSON.stringify(result, null, 2);
}

function dialogStr(dialogBuf, dialogAutoAcceptRef, flag) {
  if (flag === 'accept') { dialogAutoAcceptRef.value = true; return 'Dialog auto-accept: ON (default)'; }
  if (flag === 'dismiss') { dialogAutoAcceptRef.value = false; return 'Dialog auto-accept: OFF (dialogs will be dismissed/rejected)'; }
  if (flag) throw new Error(`Unknown dialog flag: "${flag}". Use "accept" or "dismiss".`);
  const mode = dialogAutoAcceptRef.value ? 'ON' : 'OFF';
  const entries = dialogBuf.all();
  if (entries.length === 0) return `No dialogs recorded. Auto-accept: ${mode}`;
  const lines = [`Dialogs (${entries.length}, auto-accept: ${mode}):`];
  for (const e of entries) {
    const ago = Math.round((Date.now() - e.ts) / 1000);
    lines.push(`  [${e.type}] "${e.message}" (${ago}s ago)`);
  }
  return lines.join('\n');
}

function netlogStr(netReqBuf, flag) {
  if (flag === '--clear') { netReqBuf.clear(); return 'Network log cleared'; }
  const entries = netReqBuf.all();
  if (entries.length === 0) return 'No network requests captured (tracking XHR/Fetch/Document only)';
  const lines = [`Network requests (${entries.length}):`];
  for (const e of entries) {
    const ago = Math.round((Date.now() - e.ts) / 1000);
    const size = e.size > 1024 ? `${(e.size / 1024).toFixed(1)}KB` : `${e.size}B`;
    lines.push(`  ${e.method} ${e.url} → ${e.status} (${e.duration}ms, ${size}) ${ago}s ago`);
  }
  return lines.join('\n');
}

async function viewportStr(cdp, sid, size) {
  if (!size) {
    const dims = await evalStr(cdp, sid, `JSON.stringify({w:window.innerWidth,h:window.innerHeight,dpr:window.devicePixelRatio})`);
    const d = JSON.parse(dims);
    return `Viewport: ${d.w}×${d.h} (DPR: ${d.dpr})`;
  }
  const match = size.match(/^(\d+)[x×](\d+)$/);
  if (!match) throw new Error('Format: <width>x<height> (e.g. 375x812, 1280x720)');
  const width = parseInt(match[1]), height = parseInt(match[2]);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 0, mobile: width <= 768,
  }, sid);
  return `Viewport resized to ${width}×${height}${width <= 768 ? ' (mobile mode)' : ''}`;
}

async function cookieSetStr(cdp, sid, cookieStr) {
  if (!cookieStr) throw new Error('Cookie string required: "name=value" or "name=value; domain=.example.com"');
  const parts = cookieStr.split(';').map(s => s.trim());
  const [name, ...valParts] = parts[0].split('=');
  const value = valParts.join('='); // handle values with = in them
  if (!name) throw new Error('Cookie name required');

  const cookie = { name: name.trim(), value };
  for (const part of parts.slice(1)) {
    const [k, ...v] = part.split('=');
    const key = k.trim().toLowerCase();
    const val = v.join('=').trim();
    if (key === 'domain') cookie.domain = val;
    else if (key === 'path') cookie.path = val;
    else if (key === 'secure') cookie.secure = true;
    else if (key === 'httponly') cookie.httpOnly = true;
    else if (key === 'samesite') cookie.sameSite = val;
  }

  // Batch location queries into a single eval round-trip
  const loc = JSON.parse(await evalStr(cdp, sid, 'JSON.stringify({hostname:location.hostname,href:location.href})'));
  if (!cookie.domain) cookie.domain = loc.hostname;
  cookie.url = loc.href;

  const { success } = await cdp.send('Network.setCookie', cookie, sid);
  if (!success) throw new Error(`Failed to set cookie: ${name}`);
  return `Cookie set: ${name}=${value.substring(0, 30)}${value.length > 30 ? '...' : ''} (domain: ${cookie.domain})`;
}

async function cookieDelStr(cdp, sid, name) {
  if (!name) throw new Error('Cookie name required');
  const url = await evalStr(cdp, sid, 'window.location.href');
  await cdp.send('Network.deleteCookies', { name, url }, sid);
  return `Cookie deleted: ${name}`;
}

async function uploadStr(cdp, sid, selector, filePaths) {
  if (!selector) throw new Error('CSS selector for <input type="file"> required');
  if (!filePaths) throw new Error('File path(s) required (comma-separated for multiple)');
  const files = filePaths.split(',').map(f => f.trim());
  const { root } = await cdp.send('DOM.getDocument', {}, sid);
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector }, sid);
  if (!nodeId) throw new Error('Element not found: ' + selector);
  // Validate it's a file input — attributes is a flat [name, value, name, value, ...] array
  const { node } = await cdp.send('DOM.describeNode', { nodeId }, sid);
  const attrs = node.attributes || [];
  const typeIdx = attrs.indexOf('type');
  if (node.nodeName !== 'INPUT' || typeIdx === -1 || attrs[typeIdx + 1] !== 'file')
    throw new Error('Element is not an <input type="file">');
  await cdp.send('DOM.setFileInputFiles', { files, nodeId }, sid);
  return `Uploaded ${files.length} file(s) to ${selector}: ${files.join(', ')}`;
}

// --- Clean text extraction ---
async function textStr(cdp, sid, selector) {
  const sel = selector || 'body';
  const result = await evalStr(cdp, sid, `(function() {
    const root = document.querySelector(${JSON.stringify(sel)});
    if (!root) return 'No element found matching ' + ${JSON.stringify(sel)};
    const clone = root.cloneNode(true);
    for (const el of clone.querySelectorAll('script,style,noscript,svg,link,meta')) el.remove();
    return clone.textContent.replace(/[ \\t]+/g, ' ').replace(/(\\n\\s*){3,}/g, '\\n\\n').trim();
  })()`);
  if (!selector && result.length > 2000) {
    return result + '\n\n(Hint: output is large — use `text <target> "main"` or `text <target> ".content"` to scope to a specific area)';
  }
  return result;
}

// --- Full table data extraction ---
async function tableStr(cdp, sid, selector) {
  const sel = selector || 'table';
  return evalStr(cdp, sid, `(function() {
    const tables = document.querySelectorAll(${JSON.stringify(sel)});
    if (tables.length === 0) return 'No tables found' + (${JSON.stringify(sel)} !== 'table' ? ' matching ' + ${JSON.stringify(sel)} : '');
    const results = [];
    for (let ti = 0; ti < tables.length && ti < 10; ti++) {
      const tbl = tables[ti];
      const caption = tbl.querySelector('caption')?.textContent?.trim() || tbl.getAttribute('aria-label') || 'Table ' + (ti + 1);
      const rows = [];
      for (const tr of tbl.querySelectorAll('tr')) {
        const cells = [];
        for (const cell of tr.querySelectorAll('th, td')) {
          cells.push(cell.textContent.trim().replace(/\\s+/g, ' '));
        }
        if (cells.length > 0) rows.push(cells.join('\\t'));
      }
      results.push(caption + ':\\n' + rows.join('\\n'));
    }
    return results.join('\\n\\n');
  })()`);
}

// --- Navigation history ---
async function historyNavStr(cdp, sid, direction) {
  const { currentIndex, entries } = await cdp.send('Page.getNavigationHistory', {}, sid);
  const targetIdx = currentIndex + direction;
  if (targetIdx < 0) throw new Error('No previous page in history');
  if (targetIdx >= entries.length) throw new Error('No forward page in history');
  await cdp.send('Page.navigateToHistoryEntry', { entryId: entries[targetIdx].id }, sid);
  await sleep(500);
  const url = await evalStr(cdp, sid, 'window.location.href');
  return `Navigated ${direction < 0 ? 'back' : 'forward'} to: ${url}`;
}

async function reloadStr(cdp, sid) {
  const loadEvent = cdp.waitForEvent('Page.loadEventFired', NAVIGATION_TIMEOUT);
  await cdp.send('Page.reload', {}, sid);
  try { await loadEvent.promise; } catch {}
  return 'Page reloaded';
}

// --- Tab close ---
async function closetabStr(cdp, targetId) {
  await cdp.send('Target.closeTarget', { targetId });
  return `Closed tab: ${targetId.slice(0, 8)}`;
}

// ---------------------------------------------------------------------------
// Per-tab daemon
// ---------------------------------------------------------------------------

async function runDaemon(targetId) {
  resetScreenshotTier();
  const sp = sockPath(targetId);

  const cdp = new CDP();
  try {
    await cdp.connect(await getWsUrl());
  } catch (e) {
    process.stderr.write(`Daemon: cannot connect to Chrome: ${e.message}\n`);
    process.exit(1);
  }

  let sessionId;
  try {
    const res = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    sessionId = res.sessionId;
  } catch (e) {
    process.stderr.write(`Daemon: attach failed: ${e.message}\n`);
    cdp.close();
    process.exit(1);
  }

  // --- Background observation ---
  const consoleBuf = new RingBuffer(200);
  const exceptionBuf = new RingBuffer(50);
  const navBuf = new RingBuffer(10);
  const netReqBuf = new RingBuffer(100); // network request/response pairs
  const pendingReqs = new Map(); // requestId → {method, url, ts}
  let lastReadSeq = { console: 0, exception: 0 };

  // --- Ref system & perceive diff state ---
  const refMap = new Map();               // ref number → backendDOMNodeId
  const lastPerceiveStore = { output: null }; // stores last perceive output for diff

  // Enable domains for background collection and ref resolution
  try { await cdp.send('Runtime.enable', {}, sessionId); } catch {}
  try { await cdp.send('Page.enable', {}, sessionId); } catch {}
  try { await cdp.send('DOM.enable', {}, sessionId); } catch {}
  try { await cdp.send('Network.enable', {}, sessionId); } catch {}

  cdp.onEvent('Runtime.consoleAPICalled', (params) => {
    const level = params.type || 'log';
    const text = (params.args || []).map(a => a.value ?? a.description ?? JSON.stringify(a)).join(' ');
    const stack = params.stackTrace?.callFrames?.[0];
    const file = stack?.url?.split('/').pop() || '';
    const loc = file && stack.lineNumber > 0 ? `${file}:${stack.lineNumber}` : '';
    consoleBuf.push({ level, text, loc, ts: Date.now() });
  });

  cdp.onEvent('Runtime.exceptionThrown', (params) => {
    const detail = params.exceptionDetails;
    // exception.description has full message (e.g. "Error: foo"); text is just "Uncaught"
    const msg = detail?.exception?.description || detail?.text || 'Unknown error';
    const stack = detail?.stackTrace?.callFrames?.[0];
    const file = stack?.url?.split('/').pop() || '';
    const loc = file && stack.lineNumber > 0 ? `${file}:${stack.lineNumber}` : '';
    exceptionBuf.push({ msg, loc, ts: Date.now() });
  });

  cdp.onEvent('Page.frameNavigated', (params) => {
    if (!params.frame.parentId) { // main frame only
      navBuf.push({ url: params.frame.url, ts: Date.now() });
    }
  });

  // --- Network request/response tracking ---
  cdp.onEvent('Network.requestWillBeSent', (params) => {
    // Only track XHR/Fetch, skip images/scripts/stylesheets for noise reduction
    if (params.type === 'XHR' || params.type === 'Fetch' || params.type === 'Document') {
      pendingReqs.set(params.requestId, {
        method: params.request.method,
        url: params.request.url.substring(0, 200),
        ts: Date.now(),
      });
    }
  });
  cdp.onEvent('Network.responseReceived', (params) => {
    const req = pendingReqs.get(params.requestId);
    if (!req) return;
    pendingReqs.delete(params.requestId);
    netReqBuf.push({
      method: req.method,
      url: req.url,
      status: params.response.status,
      type: params.type,
      duration: Date.now() - req.ts,
      size: params.response.encodedDataLength || 0,
      ts: req.ts,
    });
  });

  cdp.onEvent('Network.loadingFailed', (params) => {
    pendingReqs.delete(params.requestId);
  });

  // --- Dialog handling (alert/confirm/prompt/beforeunload) ---
  const dialogBuf = new RingBuffer(20);
  const dialogAutoAcceptRef = { value: true }; // auto-dismiss by default to prevent page lockups
  cdp.onEvent('Page.javascriptDialogOpening', (params) => {
    dialogBuf.push({ type: params.type, message: params.message, ts: Date.now() });
    cdp.send('Page.handleJavaScriptDialog', {
      accept: dialogAutoAcceptRef.value,
      promptText: dialogAutoAcceptRef.value ? params.defaultPrompt || '' : undefined,
    }, sessionId).catch(() => {});
  });

  // Shutdown helpers
  let alive = true;
  function shutdown() {
    if (!alive) return;
    alive = false;
    server.close();
    if (!IS_WINDOWS) try { unlinkSync(sp); } catch {}
    cdp.close();
    process.exit(0);
  }

  // Exit if target goes away or Chrome disconnects
  cdp.onEvent('Target.targetDestroyed', (params) => {
    if (params.targetId === targetId) shutdown();
  });
  cdp.onEvent('Target.detachedFromTarget', (params) => {
    if (params.sessionId === sessionId) shutdown();
  });
  cdp.onClose(() => shutdown());
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Idle timer
  let idleTimer = setTimeout(shutdown, IDLE_TIMEOUT);
  function resetIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(shutdown, IDLE_TIMEOUT);
  }

  // Action feedback: wait for DOM to settle, then return perceive diff
  const OBSERVE_KEYS = new Set(['enter', 'escape', 'tab']);
  const BATCH_BLOCKED = new Set(['batch', 'stop']);
  // Commands that mutate shared state (refMap, lastPerceiveStore) — unsafe for parallel execution
  const BATCH_NO_PARALLEL = new Set(['click', 'clickxy', 'select', 'press', 'scroll', 'nav', 'navigate', 'viewport', 'perceive', 'snap', 'snapshot']);
  async function actionFeedback(actionResult) {
    await waitForSettle(cdp, sessionId);
    const diff = await perceiveStr(cdp, sessionId, consoleBuf, exceptionBuf, refMap, lastPerceiveStore, { diff: true });
    return actionResult + '\n---\n' + diff;
  }

  // Handle a command
  async function handleCommand({ cmd, args }) {
    resetIdle();
    try {
      let result;
      switch (cmd) {
        case 'list': {
          const pages = await getPages(cdp);
          result = formatPageList(pages, _browserInfo);
          break;
        }
        case 'list_raw': {
          const pages = await getPages(cdp);
          result = JSON.stringify(pages);
          break;
        }
        case 'snap': case 'snapshot': result = await snapshotStr(cdp, sessionId, args[0] !== '--full'); break;
        case 'eval': result = await evalStr(cdp, sessionId, args[0], true); break;
        case 'shot': case 'screenshot': {
          if (args[0] === '--annotate' || args[0] === '-a') {
            result = await annotshotStr(cdp, sessionId, targetId, refMap);
          } else {
            result = await shotStr(cdp, sessionId, args[0], targetId);
          }
          break;
        }
        case 'html': result = await htmlStr(cdp, sessionId, args[0]); break;
        case 'nav': case 'navigate': {
          const navResult = await navStr(cdp, sessionId, args[0]);
          const p = await perceiveStr(cdp, sessionId, consoleBuf, exceptionBuf, refMap, lastPerceiveStore, {});
          result = navResult + '\n---\n' + p;
          break;
        }
        case 'net': case 'network': result = await netStr(cdp, sessionId); break;
        case 'status': result = await statusStr(cdp, sessionId, consoleBuf, exceptionBuf, navBuf, lastReadSeq); break;
        case 'console': result = await consoleStr(consoleBuf, exceptionBuf, lastReadSeq, args[0]); break;
        case 'summary': result = await summaryStr(cdp, sessionId, consoleBuf, exceptionBuf); break;
        case 'perceive': {
          const popts = parsePerceiveArgs(args);
          result = await perceiveStr(cdp, sessionId, consoleBuf, exceptionBuf, refMap, lastPerceiveStore, popts);
          break;
        }
        case 'elshot': result = await elshotStr(cdp, sessionId, args[0], targetId, refMap); break;
        case 'click': result = await actionFeedback(await clickStr(cdp, sessionId, args[0], refMap)); break;
        case 'clickxy': result = await actionFeedback(await clickXyStr(cdp, sessionId, args[0], args[1])); break;
        case 'type': result = await typeStr(cdp, sessionId, args[0]); break;
        case 'press': {
          result = await pressStr(cdp, sessionId, args[0]);
          if (OBSERVE_KEYS.has(args[0]?.toLowerCase())) result = await actionFeedback(result);
          break;
        }
        case 'scroll': {
          const scrollResult = await scrollStr(cdp, sessionId, args[0], args[1]);
          const diff = await perceiveStr(cdp, sessionId, consoleBuf, exceptionBuf, refMap, lastPerceiveStore, { diff: true });
          result = scrollResult + '\n---\n' + diff;
          break;
        }
        case 'hover': result = await hoverStr(cdp, sessionId, args[0], refMap); break;
        case 'waitfor': result = await waitForStr(cdp, sessionId, args, refMap); break;
        case 'loadall': result = await loadAllStr(cdp, sessionId, args[0], args[1] ? parseInt(args[1]) : 1500); break;
        case 'fill': result = await fillStr(cdp, sessionId, args[0], args[1], refMap); break;
        case 'select': result = await actionFeedback(await selectStr(cdp, sessionId, args[0], args[1])); break;
        case 'fullshot': result = await fullshotStr(cdp, sessionId, args[0], targetId); break;
        case 'scanshot': result = await scanshotStr(cdp, sessionId, targetId); break;
        case 'styles': result = await stylesStr(cdp, sessionId, args[0]); break;
        case 'cookies': result = await cookiesStr(cdp, sessionId); break;
        case 'cookieset': result = await cookieSetStr(cdp, sessionId, args[0]); break;
        case 'cookiedel': result = await cookieDelStr(cdp, sessionId, args[0]); break;
        case 'dialog': result = dialogStr(dialogBuf, dialogAutoAcceptRef, args[0]); break;
        case 'viewport': {
          result = await viewportStr(cdp, sessionId, args[0]);
          if (args[0]) result = await actionFeedback(result); // auto-diff when resizing
          break;
        }
        case 'upload': result = await uploadStr(cdp, sessionId, args[0], args[1]); break;
        case 'text': result = await textStr(cdp, sessionId, args[0]); break;
        case 'table': result = await tableStr(cdp, sessionId, args[0]); break;
        case 'back': result = await historyNavStr(cdp, sessionId, -1); break;
        case 'forward': result = await historyNavStr(cdp, sessionId, +1); break;
        case 'reload': result = await reloadStr(cdp, sessionId); break;
        case 'closetab': result = await closetabStr(cdp, targetId); break;
        case 'netlog': result = netlogStr(netReqBuf, args[0]); break;
        case 'evalraw': result = await evalRawStr(cdp, sessionId, args[0], args[1]); break;
        case 'batch': {
          let commands;
          const parallel = args.includes('--parallel');
          const input = args.filter(a => a !== '--parallel').join(' ') || '';
          if (input.startsWith('[')) {
            try { commands = JSON.parse(input); } catch { return { ok: false, error: 'batch: invalid JSON array' }; }
            if (!Array.isArray(commands)) return { ok: false, error: 'batch argument must be a JSON array' };
          } else {
            commands = input.split('|').map(segment => {
              const parts = segment.trim().split(/\s+/);
              return { cmd: parts[0], args: parts.slice(1) };
            }).filter(c => c.cmd);
          }
          if (!commands.length) return { ok: false, error: 'batch: no commands provided' };
          const blocked = commands.filter(c => BATCH_BLOCKED.has(c.cmd));
          if (blocked.length) return { ok: false, error: `batch: ${blocked.map(c => c.cmd).join(', ')} not allowed inside batch` };
          if (parallel) {
            const unsafe = commands.filter(c => BATCH_NO_PARALLEL.has(c.cmd));
            if (unsafe.length) return { ok: false, error: `batch --parallel: ${[...new Set(unsafe.map(c => c.cmd))].join(', ')} mutate shared state — use sequential batch` };
          }
          const runOne = async (c) => {
            const sub = await handleCommand({ cmd: c.cmd, args: c.args || [] });
            return { cmd: c.cmd, ok: sub.ok, result: sub.result, error: sub.error };
          };
          let results;
          if (parallel) {
            results = await Promise.all(commands.map(runOne));
          } else {
            results = [];
            for (const c of commands) results.push(await runOne(c));
          }
          result = JSON.stringify(results, null, 2);
          break;
        }
        case 'stop': return { ok: true, result: '', stopAfter: true };
        default: return { ok: false, error: `Unknown command: ${cmd}` };
      }
      return { ok: true, result: result ?? '' };
    } catch (e) {
      let error = e.message;
      // Enhance common errors with actionable hints
      if (error.includes('No node with given id') || error.includes('Could not find node'))
        error += ' — element may have been removed from DOM. Run "perceive" to refresh refs.';
      else if (error.includes('Cannot find context'))
        error += ' — page may have navigated. Run "perceive" on the current page.';
      else if (error.includes('Element not found'))
        error += ' — check your selector or run "perceive" to see available elements.';
      return { ok: false, error };
    }
  }

  // Unix socket server — NDJSON protocol
  // Wire format: each message is one JSON object followed by \n (newline-delimited JSON).
  // Request:  { "id": <number>, "cmd": "<command>", "args": ["arg1", "arg2", ...] }
  // Response: { "id": <number>, "ok": <boolean>, "result": "<string>" }
  //           or { "id": <number>, "ok": false, "error": "<message>" }
  const server = net.createServer((conn) => {
    let buf = '';
    conn.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop(); // keep incomplete last line
      for (const line of lines) {
        if (!line.trim()) continue;
        let req;
        try {
          req = JSON.parse(line);
        } catch {
          conn.write(JSON.stringify({ ok: false, error: 'Invalid JSON request', id: null }) + '\n');
          continue;
        }
        handleCommand(req).then((res) => {
          const payload = JSON.stringify({ ...res, id: req.id }) + '\n';
          if (res.stopAfter) conn.end(payload, shutdown);
          else conn.write(payload);
        });
      }
    });
  });

  server.on('error', (e) => {
    process.stderr.write(`Daemon server listen failed: ${e.message}\n`);
    process.exit(1);
  });

  if (!IS_WINDOWS) try { unlinkSync(sp); } catch {}
  server.listen(sp);
}

// ---------------------------------------------------------------------------
// CLI ↔ daemon communication
// ---------------------------------------------------------------------------

function connectToSocket(sp) {
  return new Promise((resolve, reject) => {
    const conn = net.connect(sp);
    conn.on('connect', () => resolve(conn));
    conn.on('error', reject);
  });
}

async function getOrStartTabDaemon(targetId) {
  const sp = sockPath(targetId);
  // Try existing daemon
  try { return await connectToSocket(sp); } catch {}

  // Clean stale socket
  if (!IS_WINDOWS) try { unlinkSync(sp); } catch {}

  // Spawn daemon
  const child = spawn(process.execPath, [process.argv[1], '_daemon', targetId], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  // Wait for socket (includes time for user to click Allow)
  for (let i = 0; i < DAEMON_CONNECT_RETRIES; i++) {
    await sleep(DAEMON_CONNECT_DELAY);
    try { return await connectToSocket(sp); } catch {}
  }
  throw new Error('Daemon failed to start — did you click Allow in Chrome?');
}

const IPC_TIMEOUT = 120000; // 2 minutes — generous for slow commands like scanshot

function sendCommand(conn, req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    let settled = false;

    const settle = (fn) => { if (settled) return; settled = true; cleanup(); clearTimeout(timer); fn(); };

    const cleanup = () => {
      conn.off('data', onData);
      conn.off('error', onError);
      conn.off('end', onEnd);
      conn.off('close', onClose);
    };

    const onData = (chunk) => {
      buf += chunk.toString();
      const idx = buf.indexOf('\n');
      if (idx === -1) return;
      settle(() => { resolve(JSON.parse(buf.slice(0, idx))); conn.end(); });
    };

    const onError = (error) => settle(() => reject(error));
    const onEnd = () => settle(() => reject(new Error('Connection closed before response')));
    const onClose = () => settle(() => reject(new Error('Connection closed before response')));

    const timer = setTimeout(() => {
      settle(() => { conn.destroy(); reject(new Error(`IPC timeout: command "${req.cmd}" took longer than ${IPC_TIMEOUT / 1000}s`)); });
    }, IPC_TIMEOUT);

    conn.on('data', onData);
    conn.on('error', onError);
    conn.on('end', onEnd);
    conn.on('close', onClose);
    req.id = 1;
    conn.write(JSON.stringify(req) + '\n');
  });
}

// Find any running daemon socket to reuse for list
function findAnyDaemonSocket() {
  return listDaemonSockets()[0]?.socketPath || null;
}

// ---------------------------------------------------------------------------
// Stop daemons
// ---------------------------------------------------------------------------

async function stopDaemons(targetPrefix) {
  const daemons = listDaemonSockets();

  if (targetPrefix) {
    const targetId = resolvePrefix(targetPrefix, daemons.map(d => d.targetId), 'daemon');
    const daemon = daemons.find(d => d.targetId === targetId);
    try {
      const conn = await connectToSocket(daemon.socketPath);
      await sendCommand(conn, { cmd: 'stop' });
    } catch {
      if (!IS_WINDOWS) try { unlinkSync(daemon.socketPath); } catch {}
    }
    return;
  }

  for (const daemon of daemons) {
    try {
      const conn = await connectToSocket(daemon.socketPath);
      await sendCommand(conn, { cmd: 'stop' });
    } catch {
      if (!IS_WINDOWS) try { unlinkSync(daemon.socketPath); } catch {}
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const USAGE = `cdp - lightweight Chrome DevTools Protocol CLI (no Puppeteer)

Usage: cdp <command> [args]

  list                              List open pages (shows unique target prefixes)
  perceive <target> [flags]          Full page perception with @ref indices + coordinates
                                    --diff: show only changes since last perceive
                                    -s <sel> / --selector: scope to CSS selector subtree
                                    -i / --interactive: only show interactive elements
                                    -d N / --depth N: limit tree depth
                                    -C / --cursor-interactive: include non-ARIA clickable elements (@c refs)
  snap  <target> [--full]           Accessibility tree snapshot (compact by default, --full for complete)
  eval  <target> <expr>             Evaluate JS expression
  elshot <target> <sel|@ref>        Element screenshot: captures element by CSS selector or @ref
  shot  <target> [file|--annotate]  Viewport screenshot; --annotate (-a) overlays @ref labels
  html  <target> [selector]         Get HTML (full page or CSS selector)
  nav   <target> <url>              Navigate to URL and wait for load completion
  status <target>                    Page state + new console/exception entries (primary debug entry point)
  console <target> [--all|--errors] Console buffer (default: new entries only; --all: last 200; --errors: errors+exceptions)
  summary <target>                  Token-efficient page overview (interactive elements, scroll, console health)
  net   <target>                    Network performance entries
  click   <target> <sel|@ref>       Click element by CSS selector or @ref
  clickxy <target> <x> <y>          Click at CSS pixel coordinates (see coordinate note below)
  type    <target> <text>           Type text at current focus via Input.insertText
                                    Works in cross-origin iframes unlike eval-based approaches
  press   <target> <key>           Press key (Enter, Tab, Escape, Backspace, Space, Arrow*)
  scroll  <target> <dir|x,y> [px]  Scroll page (down/up/left/right or x,y offset; default 500px)
  hover   <target> <sel|@ref>       Hover over element (triggers :hover, tooltips, dropdowns)
  waitfor <target> <selector> [ms]  Wait for element (default 10s, max 5min)
  waitfor <target> --gone <sel|@ref> [ms]  Wait for element to DISAPPEAR (streaming end)
  waitfor <target> --text "str" [--scope sel] [ms]  Wait for text to appear on page
  loadall <target> <selector> [ms]  Repeatedly click a "load more" button until it disappears
                                    Optional interval in ms between clicks (default 1500)
  fill    <target> <sel|@ref> <txt> Clear field and type text (for form filling)
  select  <target> <selector> <val> Select an option in a <select> element by value
  fullshot <target> [file]          Full-page screenshot (single image — may be hard to read)
  scanshot <target>                 Segmented full-page capture (viewport-sized images, readable)
  styles  <target> <selector>       Get computed styles for element (filtered to meaningful props)
  cookies <target>                  List cookies for current page
  cookieset <target> <cookie>       Set a cookie: "name=value" or "name=value; domain=.example.com; secure"
  cookiedel <target> <name>         Delete a cookie by name
  dialog  <target> [accept|dismiss] Show dialog history; set auto-accept (default) or auto-dismiss
  viewport <target> [WxH]           Show or set viewport size (e.g. 375x812, 1280x720)
  upload  <target> <selector> <paths>  Upload file(s) to <input type="file"> (comma-separated paths)
  text    <target> [selector]       Clean text content — optional CSS selector to scope
  table   <target> [selector]       Full table data extraction (tab-separated, no row limit)
  back    <target>                  Navigate back in browser history
  forward <target>                  Navigate forward in browser history
  reload  <target>                  Reload current page
  closetab <target>                 Close a browser tab
  netlog  <target> [--clear]        Network request log (XHR/Fetch/Document with status + timing)
  evalraw <target> <method> [json]  Send a raw CDP command; returns JSON result
                                    e.g. evalraw <t> "DOM.getDocument" '{}'
  batch <target> <cmds> [--parallel] Execute multiple commands in one call (reduces IPC overhead)
                                    Pipe syntax: 'fill @3 hello | fill @5 world | click @7'
                                    JSON syntax: '[{"cmd":"click","args":["@1"]},{"cmd":"perceive","args":["--diff"]}]'
                                    --parallel  Run commands concurrently (for independent ops like multiple elshots)
  open  [url]                       Open a new tab (default: about:blank)
                                    Note: each new tab triggers a fresh "Allow debugging?" prompt
  stop  [target]                    Stop daemon(s)

ACTION FEEDBACK
  click, clickxy, press (Enter/Escape/Tab), select, scroll, and viewport (when
  resizing) automatically wait for DOM to settle and return a perceive diff.
  nav automatically returns a full perceive of the loaded page.
  No need to manually run perceive or perceive --diff after these actions.

<target> is a unique targetId prefix from "cdp list". If a prefix is ambiguous,
use more characters.

COORDINATE SYSTEM
  shot captures the viewport at the device's native resolution.
  The screenshot image size = CSS pixels × DPR (device pixel ratio).
  For CDP Input events (clickxy, etc.) you need CSS pixels, not image pixels.

    CSS pixels = screenshot image pixels / DPR

  shot prints the DPR and an example conversion for the current page.
  Typical Retina (DPR=2): CSS px ≈ screenshot px × 0.5
  If your viewer rescales the image further, account for that scaling too.

EVAL SAFETY NOTE
  Avoid index-based DOM selection (querySelectorAll(...)[i]) across multiple
  eval calls when the list can change between calls (e.g. after clicking
  "Ignore" buttons on a feed — indices shift). Prefer stable selectors or
  collect all data in a single eval.

DAEMON IPC (for advanced use / scripting)
  Each tab runs a persistent daemon at Unix socket in the runtime dir (see below).
  Protocol: newline-delimited JSON (one JSON object per line, UTF-8).
    Request:  {"id":<number>, "cmd":"<command>", "args":["arg1","arg2",...]}
    Response: {"id":<number>, "ok":true,  "result":"<string>"}
           or {"id":<number>, "ok":false, "error":"<message>"}
  Commands mirror the CLI: perceive, status, summary, console, snap, eval, shot, elshot,
  fullshot, scanshot, html, nav, net, click, clickxy, hover, type, press, scroll, fill,
  select, waitfor, loadall, styles, cookies, cookieset, cookiedel, dialog, viewport,
  upload, text, table, back, forward, reload, closetab, netlog, evalraw, batch, stop.
  The socket disappears after 20 min of inactivity or when the tab closes.
`;

const NEEDS_TARGET = new Set([
  'snap','snapshot','eval','shot','screenshot','html','nav','navigate',
  'net','network','click','clickxy','type','press','scroll','hover','waitfor','loadall','fill','select','fullshot','scanshot','styles','cookies','cookieset','cookiedel','evalraw','status','console','summary','perceive','elshot','batch','dialog','viewport','upload',
  'text','table','back','forward','reload','closetab','netlog',
]);

async function main() {
  const [cmd, ...args] = process.argv.slice(2);

  // Daemon mode (internal)
  if (cmd === '_daemon') { await runDaemon(args[0]); return; }

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(USAGE); process.exit(0);
  }

  // List — use existing daemon if available, otherwise direct
  if (cmd === 'list' || cmd === 'ls') {
    let pages;
    const existingSock = findAnyDaemonSocket();
    if (existingSock) {
      try {
        const conn = await connectToSocket(existingSock);
        const resp = await sendCommand(conn, { cmd: 'list_raw' });
        if (resp.ok) pages = JSON.parse(resp.result);
      } catch {}
    }
    if (!pages) {
      // No daemon running — connect directly (will trigger one Allow)
      const cdp = new CDP();
      await cdp.connect(await getWsUrl());
      pages = await getPages(cdp);
      cdp.close();
    }
    writeFileSync(PAGES_CACHE, JSON.stringify(pages), { mode: 0o600 });
    console.log(formatPageList(pages, _browserInfo));
    process.stdout.write('', () => process.exit(0));
    return;
  }

  // Open new tab
  if (cmd === 'open') {
    const url = args[0] || 'about:blank';
    if (url !== 'about:blank') validateUrl(url);
    const cdp = new CDP();
    await cdp.connect(await getWsUrl());
    const { targetId } = await cdp.send('Target.createTarget', { url });
    // Refresh cache; new tab may not appear in getTargets immediately, so add it manually
    const pages = await getPages(cdp);
    if (!pages.some(p => p.targetId === targetId)) {
      pages.push({ targetId, title: url, url });
    }
    cdp.close();
    writeFileSync(PAGES_CACHE, JSON.stringify(pages), { mode: 0o600 });
    console.log(`Opened new tab: ${targetId.slice(0, 8)}  ${url}`);

    // Auto-attach: start daemon and wait for user to click "Allow debugging?"
    console.log('Waiting for "Allow debugging?" approval in Chrome... (up to 60s)');
    const sp = sockPath(targetId);
    if (!IS_WINDOWS) try { unlinkSync(sp); } catch {}
    const child = spawn(process.execPath, [process.argv[1], '_daemon', targetId], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    let attached = false;
    for (let i = 0; i < DAEMON_ALLOW_RETRIES; i++) {
      await sleep(DAEMON_ALLOW_DELAY);
      try {
        const conn = await connectToSocket(sp);
        conn.end();
        attached = true;
        break;
      } catch {}
    }
    if (attached) {
      console.log('Tab ready — debugging approved.');
      // Auto-perceive: give agent immediate page understanding (matches nav behavior)
      try {
        const conn = await connectToSocket(sp);
        const resp = await sendCommand(conn, { cmd: 'perceive', args: [] });
        conn.end();
        if (resp.ok && resp.result) console.log('---\n' + resp.result);
      } catch (e) {
        console.error(`Auto-perceive failed: ${e.message}`);
      }
    } else {
      console.log('Timeout waiting for debugging approval. Tab created but daemon not connected.');
      console.log('Run a command against this tab to retry.');
    }
    return;
  }

  // Stop
  if (cmd === 'stop') {
    await stopDaemons(args[0]);
    return;
  }

  // Page commands — need target prefix
  if (!NEEDS_TARGET.has(cmd)) {
    console.error(`Unknown command: ${cmd}\n`);
    console.log(USAGE);
    process.exit(1);
  }

  const targetPrefix = args[0];
  if (!targetPrefix) {
    console.error('Error: target ID required. Run "cdp list" first.');
    process.exit(1);
  }

  // Resolve prefix → full targetId from cache or running daemon
  let targetId;
  const daemonTargetIds = listDaemonSockets().map(d => d.targetId);
  const daemonMatches = daemonTargetIds.filter(id => id.toUpperCase().startsWith(targetPrefix.toUpperCase()));

  if (daemonMatches.length > 0) {
    targetId = resolvePrefix(targetPrefix, daemonTargetIds, 'daemon');
  } else {
    if (!existsSync(PAGES_CACHE)) {
      console.error('No page list cached. Run "cdp list" first.');
      process.exit(1);
    }
    const pages = JSON.parse(readFileSync(PAGES_CACHE, 'utf8'));
    targetId = resolvePrefix(targetPrefix, pages.map(p => p.targetId), 'target', 'Run "cdp list".');
  }

  const conn = await getOrStartTabDaemon(targetId);

  const cmdArgs = args.slice(1);

  if (cmd === 'eval') {
    const expr = cmdArgs.join(' ');
    if (!expr) { console.error('Error: expression required'); process.exit(1); }
    cmdArgs[0] = expr;
  } else if (cmd === 'elshot') {
    if (!cmdArgs[0]) { console.error('Error: CSS selector required'); process.exit(1); }
  } else if (cmd === 'type') {
    // Join all remaining args as text (allows spaces)
    const text = cmdArgs.join(' ');
    if (!text) { console.error('Error: text required'); process.exit(1); }
    cmdArgs[0] = text;
  } else if (cmd === 'fill') {
    if (!cmdArgs[0]) { console.error('Error: selector required'); process.exit(1); }
    if (cmdArgs.length > 2) cmdArgs[1] = cmdArgs.slice(1).join(' ');
  } else if (cmd === 'evalraw') {
    // args: [method, ...jsonParts] — join json parts in case of spaces
    if (!cmdArgs[0]) { console.error('Error: CDP method required'); process.exit(1); }
    if (cmdArgs.length > 2) cmdArgs[1] = cmdArgs.slice(1).join(' ');
  } else if (cmd === 'cookieset') {
    if (!cmdArgs[0]) { console.error('Error: cookie string required (e.g. "name=value; domain=.example.com")'); process.exit(1); }
    cmdArgs[0] = cmdArgs.join(' '); // join in case of spaces in cookie string
  } else if (cmd === 'cookiedel') {
    if (!cmdArgs[0]) { console.error('Error: cookie name required'); process.exit(1); }
  } else if (cmd === 'upload') {
    if (!cmdArgs[0] || !cmdArgs[1]) { console.error('Error: selector and file path(s) required'); process.exit(1); }
    // args[0] = selector, args[1] = comma-separated file paths (no join needed)
  } else if (cmd === 'batch') {
    const filtered = cmdArgs.filter(a => a !== '--parallel');
    if (!filtered[0]) { console.error('Error: commands required (pipe syntax or JSON array)'); process.exit(1); }
  }

  if ((cmd === 'nav' || cmd === 'navigate') && !cmdArgs[0]) {
    console.error('Error: URL required');
    process.exit(1);
  }

  const response = await sendCommand(conn, { cmd, args: cmdArgs });

  if (response.ok) {
    if (response.result) console.log(response.result);
  } else {
    console.error('Error:', response.error);
    process.exitCode = 1;
  }
}

// Test exports — only available when NODE_ENV=test to avoid side effects
if (process.env.NODE_ENV !== 'test') {
  main().catch(e => { console.error(e.message); process.exit(1); });
}
export const __test__ = process.env.NODE_ENV === 'test' ? {
  // Data structures
  RingBuffer, CDP,
  // Utilities
  resolvePrefix, getDisplayPrefixLength, sockPath, isRef, validateUrl,
  // AX tree helpers
  shouldShowAxNode, formatAxNode, orderedAxChildren,
  // Perceive & snapshot
  parsePerceiveArgs, buildPerceiveTree, perceivePageScript,
  // Command implementations
  formatPageList, dialogStr, netlogStr,
  evalStr, navStr, clickStr, fillStr, waitForStr, snapshotStr,
  // Screenshot
  captureScreenshot, screencastFallback,
  resetScreenshotTier, getScreenshotTier, SCREENSHOT_TIMEOUT,
  // Constants
  KEY_MAP, ENRICHED_ROLES, INTERACTIVE_ROLES,
} : undefined;
