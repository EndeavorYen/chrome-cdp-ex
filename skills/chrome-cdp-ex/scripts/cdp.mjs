#!/usr/bin/env node
// cdp - lightweight Chrome DevTools Protocol CLI
// Uses raw CDP over WebSocket, no Puppeteer dependency.
// Requires Node 22+ (built-in WebSocket).
//
// Per-tab persistent daemon: page commands go through a daemon that holds
// the CDP session open. Chrome's "Allow debugging" modal fires once per
// daemon (= once per tab). Daemons auto-exit after 20min idle.

import { appendFileSync, readFileSync, writeFileSync, unlinkSync, existsSync, readdirSync, mkdirSync, lstatSync } from 'fs';
import { homedir } from 'os';
import { resolve, delimiter } from 'path';
import { spawn, spawnSync } from 'child_process';
import net from 'net';

const TIMEOUT = 15000;
const SCREENSHOT_TIMEOUT = 30000;
const NAVIGATION_TIMEOUT = 30000;
const IDLE_TIMEOUT = 20 * 60 * 1000;
const FIRE_AND_FORGET_KEEPALIVE = 60 * 60 * 1000;
const DAEMON_CONNECT_RETRIES = 20;
const DAEMON_CONNECT_DELAY = 300;
const DAEMON_ALLOW_RETRIES = 200;  // For open --attach: 200 * 300ms = 60s
const DAEMON_ALLOW_DELAY = 300;
const MIN_TARGET_PREFIX_LEN = 8;
const MAX_ACTION_LOG_ENTRIES = 100;
const MAX_SCREENSHOT_ENTRIES = 100;
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

function isTimeoutError(err, methods = []) {
  const msg = err?.message || String(err || '');
  if (!msg.startsWith('Timeout:')) return false;
  return methods.length === 0 || methods.some(method => msg.includes(method));
}

function actionFailureMessage(err) {
  return err?.message || String(err || '');
}

function actionFailureTargetId(target = {}) {
  return target?.targetId || target?.id || target?.target || '<target>';
}

function actionFailureInput(target = {}) {
  return target?.input || target?.label || target?.selector || '';
}

function classifyActionFailure(err, { action = 'action', target = {} } = {}) {
  const originalMessage = actionFailureMessage(err);
  const lower = originalMessage.toLowerCase();
  const targetId = actionFailureTargetId(target);
  const input = actionFailureInput(target);
  const perceiveCommand = `cdp perceive ${targetId} -C -d 8`;
  const statusCommand = `cdp status ${targetId}`;
  const base = {
    schema: 'chrome-cdp-ex.action-failure.v1',
    action,
    target: target || null,
    originalMessage,
    kind: 'unknown',
    reason: 'The browser rejected the action for a reason chrome-cdp-ex does not classify yet.',
    nextCommand: perceiveCommand,
    hints: [`Refresh page perception with \`${perceiveCommand}\`, then choose the next action from fresh refs.`],
  };

  if (lower.includes('unknown ref') || lower.includes('refs were cleared') || lower.includes('refs were invalidated')) {
    return {
      ...base,
      kind: 'stale-ref',
      reason: 'The @ref no longer maps to the current DOM.',
      nextCommand: perceiveCommand,
      hints: [
        `Refresh refs with \`${perceiveCommand}\`.`,
        'Use a stable CSS selector instead of @ref for long loops or replayable workflows.',
      ],
    };
  }

  if (
    lower.includes('other element would receive') ||
    lower.includes('click intercepted') ||
    lower.includes('intercepted by another element') ||
    lower.includes('hit test') ||
    lower.includes('not clickable at point')
  ) {
    const jsClick = input ? `cdp jsclick ${targetId} ${input}` : null;
    return {
      ...base,
      kind: 'overlay',
      reason: 'A visible overlay or hit-test interception blocked the realistic mouse action.',
      nextCommand: `cdp dismiss-modal ${targetId}`,
      hints: [
        `Close obvious dialogs or overlays with \`cdp dismiss-modal ${targetId}\`.`,
        `Refresh refs after the overlay changes with \`${perceiveCommand}\`.`,
        ...(jsClick ? [`If the overlay is intentional and the target is still correct, try \`${jsClick}\`.`] : []),
      ],
    };
  }

  if (
    lower.includes('no frame for given id') ||
    lower.includes('frame was detached') ||
    lower.includes('target frame detached') ||
    lower.includes('wrong frame')
  ) {
    return {
      ...base,
      kind: 'wrong-frame',
      reason: 'The action targeted a frame or execution context that is no longer current.',
      nextCommand: perceiveCommand,
      hints: [
        `Refresh page and frame context with \`${perceiveCommand}\`.`,
        'If the control is inside an iframe, prefer a fresh perceive/coordinate target until frame-scoped refs are available.',
      ],
    };
  }

  if (
    lower.includes('cannot find context') ||
    lower.includes('execution context was destroyed') ||
    lower.includes('inspected target navigated') ||
    lower.includes('target closed')
  ) {
    return {
      ...base,
      kind: 'navigation',
      reason: 'The page navigated, reloaded, or recreated its JavaScript context during the action.',
      nextCommand: perceiveCommand,
      hints: [
        `Refresh the current page state with \`${perceiveCommand}\`.`,
        `Use \`cdp status ${targetId}\` if navigation or console failures may explain the change.`,
      ],
    };
  }

  if (
    lower.includes('no node with given id') ||
    lower.includes('could not find node') ||
    lower.includes('node is detached from document') ||
    lower.includes('cannot find node with given id')
  ) {
    return {
      ...base,
      kind: 'dom-rewrite',
      reason: 'The DOM node disappeared or was rewritten after it was resolved.',
      nextCommand: perceiveCommand,
      hints: [
        `Refresh refs with \`${perceiveCommand}\`.`,
        'For React/Vue rerenders or HMR, prefer a stable CSS selector over an old @ref.',
      ],
    };
  }

  if (isTimeoutError(err) || lower.includes('timed out') || lower.includes('timeout')) {
    return {
      ...base,
      kind: 'timeout',
      reason: 'The action or its CDP acknowledgement exceeded the timeout window.',
      nextCommand: statusCommand,
      hints: [
        `Check whether the tab is still responsive with \`${statusCommand}\`.`,
        `If the action may have dispatched, run \`cdp perceive ${targetId} --since-action\` before retrying.`,
      ],
    };
  }

  if (
    lower.includes('element not found') ||
    lower.includes('could not resolve selector') ||
    lower.includes('failed to find element')
  ) {
    return {
      ...base,
      kind: 'selector',
      reason: 'No current element matched the requested selector/ref.',
      nextCommand: perceiveCommand,
      hints: [
        `Refresh available controls with \`${perceiveCommand}\`.`,
        'Check whether the element is below the fold, inside a modal, or renamed by the framework.',
      ],
    };
  }

  return base;
}

function formatActionFailure(err, context = {}) {
  const message = actionFailureMessage(err);
  if (message.startsWith('Action failure:')) return message;
  const failure = classifyActionFailure(err, context);
  const lines = [
    `Action failure: ${failure.kind}`,
    `Reason: ${failure.reason}`,
    `Next: ${failure.nextCommand}`,
  ];
  for (const hint of failure.hints || []) lines.push(`Hint: ${hint}`);
  lines.push(`Original: ${failure.originalMessage}`);
  return lines.join('\n');
}

function parseDelayMs(value, { name = 'ms', min = 1, max = 24 * 60 * 60 * 1000 } = {}) {
  const raw = String(value ?? '').trim();
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a positive integer in milliseconds`);
  const ms = Number(raw);
  if (!Number.isSafeInteger(ms) || ms < min) throw new Error(`${name} must be at least ${min}ms`);
  if (ms > max) throw new Error(`${name} exceeds max ${max}ms`);
  return ms;
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${Number.isInteger(s) ? s : s.toFixed(1)}s`;
  const m = s / 60;
  if (m < 60) return `${Number.isInteger(m) ? m : m.toFixed(1)}m`;
  const h = m / 60;
  return `${Number.isInteger(h) ? h : h.toFixed(1)}h`;
}

function parseFormatArgs(args, allowed = ['text', 'json']) {
  const next = [];
  let format = 'text';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--format') {
      const value = args[++i];
      if (!allowed.includes(value)) {
        throw new Error(`format must be ${allowed.join(' or ')}`);
      }
      format = value;
    } else {
      next.push(args[i]);
    }
  }
  return { format, args: next };
}

function formatJson(model) {
  return JSON.stringify(model, null, 2);
}

async function waitStr(msArg) {
  const ms = parseDelayMs(msArg, { name: 'wait duration', max: 60 * 60 * 1000 });
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    await sleep(Math.min(250, deadline - Date.now()));
  }
  return `Waited ${formatDuration(ms)}`;
}

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
  // Keep regular page targets, including about:blank so agents always have a
  // usable handle. Skip chrome://, edge://, and devtools:// internal pages.
  return targetInfos.filter(t => t.type === 'page'
    && !t.url.startsWith('chrome://')
    && !t.url.startsWith('edge://')
    && !t.url.startsWith('devtools://'));
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
    const isBlank = !p.url || p.url === 'about:blank';
    const rawTitle = isBlank ? '(blank tab)' : (p.title || '');
    const title = rawTitle.substring(0, 54).padEnd(54);
    return `${id}  ${title}  ${p.url || ''}`;
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

const PERCEIVE_PRIORITY_TEXT_RE = /\b(error|failed?|failure|invalid|required|warning|blocked|denied|unauthori[sz]ed|forbidden|saved|success|submitted|complete)\b/i;

function isPriorityPerceiveTextLine(line) {
  return PERCEIVE_PRIORITY_TEXT_RE.test(String(line || ''));
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

// Decode a base64-encoded eval expression. Used by `eval64` and `eval --b64`
// so agents can ship CJK / Unicode / shell-hostile expressions without losing
// bytes to the surrounding shell quoting rules. We validate eagerly because a
// silently-corrupted expression would still compile and could match the wrong
// elements — better to surface a base64 error than to evaluate garbage.
function evalBase64Decode(b64) {
  if (b64 == null || b64 === '') {
    throw new Error('eval --b64: empty expression. Pass a base64-encoded JS expression.');
  }
  if (typeof b64 !== 'string') {
    throw new Error('eval --b64: expression must be a base64 string');
  }
  const cleaned = b64.replace(/\s+/g, '');
  // Charset check is intentionally loose on `=` so a misplaced pad falls
  // through to the dedicated padding check below with a clearer message.
  if (!/^[A-Za-z0-9+/=]+$/.test(cleaned)) {
    throw new Error('eval --b64: invalid base64 input (only A-Z, a-z, 0-9, +, /, = are allowed)');
  }
  // Standard base64 must be a multiple of 4 chars after padding, and `=`
  // padding may only appear at the very end. Node's Buffer base64 decoder is
  // intentionally lenient (it silently drops trailing junk), so without these
  // checks a corrupted or truncated payload would decode to a partial JS
  // expression and run as if it were the agent's intent.
  if (cleaned.length % 4 !== 0) {
    throw new Error(`eval --b64: invalid base64 length (${cleaned.length} chars; must be a multiple of 4 with = padding)`);
  }
  const padIdx = cleaned.indexOf('=');
  if (padIdx !== -1 && padIdx < cleaned.length - 2) {
    throw new Error('eval --b64: invalid base64 padding (= may only appear as the last 1-2 chars)');
  }
  if (padIdx === cleaned.length - 2 && cleaned[cleaned.length - 1] !== '=') {
    // e.g. "AB=Y" — first `=` at -2 but final char is not `=`; means body
    // starts after a single trailing pad, which is also illegal.
    throw new Error('eval --b64: invalid base64 padding (= may only appear as the last 1-2 chars)');
  }
  let decoded;
  try {
    decoded = Buffer.from(cleaned, 'base64').toString('utf8');
  } catch (e) {
    throw new Error(`eval --b64: cannot decode base64 (${e.message})`);
  }
  if (!decoded) {
    throw new Error('eval --b64: decoded expression is empty');
  }
  // Round-trip guard: re-encoding the decoded bytes must reproduce the
  // canonical input. This catches cases where the lenient Node decoder
  // accepted bytes it should not have (e.g. a tail char that does not align
  // to a 6-bit boundary), which would otherwise yield a silently-truncated
  // expression. We compare to the original `cleaned` form so legitimate
  // whitespace in the wire format is still tolerated.
  const reencoded = Buffer.from(decoded, 'utf8').toString('base64');
  if (reencoded !== cleaned) {
    throw new Error('eval --b64: input is not canonical base64 (decoder dropped bytes — payload may be truncated or corrupt)');
  }
  return decoded;
}

async function evalStr(cdp, sid, expression, autoWrap = false, options = {}) {
  // Auto-wrap: if expression contains `await`, wrap in async IIFE
  let expr = expression;
  if (autoWrap && /\bawait\b/.test(expr)) {
    // Multi-statement or has semicolons → block body; otherwise expression body
    expr = expr.includes(';') || expr.includes('\n')
      ? `(async()=>{${expr}})()`
      : `(async()=>(${expr}))()`;
  }
  const params = {
    expression: expr, returnByValue: true, awaitPromise: true,
  };
  if (options.contextId != null) params.contextId = options.contextId;
  if (options.uniqueContextId != null) params.uniqueContextId = options.uniqueContextId;
  const result = await cdp.send('Runtime.evaluate', params, sid);
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || result.exceptionDetails.exception?.description);
  }
  const val = result.result.value;
  return typeof val === 'object' ? JSON.stringify(val, null, 2) : String(val ?? '');
}

function maybeAutoWrapEval(expression, autoWrap = false) {
  let expr = expression;
  if (autoWrap && /\bawait\b/.test(expr)) {
    expr = expr.includes(';') || expr.includes('\n')
      ? `(async()=>{${expr}})()`
      : `(async()=>(${expr}))()`;
  }
  return expr;
}

async function evalFireAndForgetStr(cdp, sid, expression, autoWrap = false) {
  if (!expression) throw new Error('Expression required');
  await cdp.send('Runtime.evaluate', {
    expression: maybeAutoWrapEval(expression, autoWrap),
    returnByValue: false,
    awaitPromise: false,
  }, sid);
  return 'Dispatched fire-and-forget eval (not awaiting returned promise)';
}

function formatCallResult(remote) {
  if (!remote) return '';
  if (Object.prototype.hasOwnProperty.call(remote, 'value')) {
    if (remote.value === undefined) return 'undefined';
    const json = JSON.stringify(remote.value, null, 2);
    return json === undefined ? String(remote.value) : json;
  }
  if (remote.unserializableValue != null) return String(remote.unserializableValue);
  return remote.description ?? '';
}

async function callStr(cdp, sid, expression) {
  if (!expression) throw new Error('Expression required');
  const wrapped = `Promise.resolve().then(async () => {
    const value = (${expression});
    let result = (typeof value === 'function') ? value() : value;
    return await result;
  })()`;
  const result = await cdp.send('Runtime.evaluate', {
    expression: wrapped,
    returnByValue: true,
    awaitPromise: true,
  }, sid);
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || result.exceptionDetails.exception?.description);
  }
  return formatCallResult(result.result);
}

function parseEvalArgs(args) {
  const opts = { expression: '', fireAndForget: false };
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--fire-and-forget' || a === '--faf') opts.fireAndForget = true;
    else if (a === '--b64' || a === '-b') {
      const b64 = (args[++i] || '').trim();
      if (!b64) throw new Error('eval --b64: empty expression. Pass a base64-encoded JS expression.');
      opts.expression = evalBase64Decode(b64);
    } else {
      rest.push(a);
    }
  }
  if (!opts.expression) opts.expression = rest.join(' ');
  if (!opts.expression) throw new Error('Expression required');
  return opts;
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

// Parse `shot` arguments. Returns { filePath, quiet, verbose }.
// Recognised flags: --quiet (only the saved path), --verbose (full DPR guidance).
// Default (no flags): saved path on the first line, then a brief DPR note —
// scripts that read `head -1` get a clean path without prelude noise.
function parseShotArgs(args) {
  const opts = { filePath: null, quiet: false, verbose: false };
  const tokens = (args || []).filter(a => a !== undefined && a !== null);
  for (const t of tokens) {
    if (t === '--quiet' || t === '-q') opts.quiet = true;
    else if (t === '--verbose' || t === '-v') opts.verbose = true;
    else if (typeof t === 'string' && !t.startsWith('--')) opts.filePath = t;
  }
  return opts;
}

async function shotStr(cdp, sid, filePathOrOpts, targetId, maybeOpts) {
  let filePath = null;
  let opts = { quiet: false, verbose: false };
  if (filePathOrOpts && typeof filePathOrOpts === 'object' && !Array.isArray(filePathOrOpts)) {
    filePath = filePathOrOpts.filePath || null;
    opts = { quiet: !!filePathOrOpts.quiet, verbose: !!filePathOrOpts.verbose };
  } else {
    filePath = filePathOrOpts || null;
    if (maybeOpts && typeof maybeOpts === 'object') {
      opts = { quiet: !!maybeOpts.quiet, verbose: !!maybeOpts.verbose };
    }
  }
  const dpr = await getDpr(cdp, sid);
  const { data, fallback } = await captureScreenshot(cdp, sid, { format: 'png' });
  const out = filePath || resolve(RUNTIME_DIR, `screenshot-${(targetId || 'unknown').slice(0, 8)}.png`);
  writeFileSync(out, Buffer.from(data, 'base64'));

  // Default output: saved path FIRST so scripts grabbing `head -1` get a clean
  // path. Verbose adds full coordinate-mapping tutorial. Quiet hides hints.
  const lines = [out];
  if (fallback) lines.push(`(screenshot fallback — Page.captureScreenshot timed out)`);
  if (opts.quiet) return lines.join('\n');
  // Default: short DPR hint after the path. (`shot ... --verbose` for the long form.)
  lines.push(`Screenshot saved. DPR=${dpr}${dpr !== 1 ? ` (CSS px = image px / ${dpr})` : ''}`);
  if (opts.verbose) {
    lines.push(`Coordinate mapping:`);
    lines.push(`  Screenshot pixels → CSS pixels (for CDP Input events): divide by ${dpr}`);
    lines.push(`  e.g. screenshot point (${Math.round(100 * dpr)}, ${Math.round(200 * dpr)}) → CSS (100, 200) → use clickxy <target> 100 200`);
    if (dpr !== 1) {
      lines.push(`  On this ${dpr}x display: CSS px = screenshot px / ${dpr} ≈ screenshot px × ${Math.round(100/dpr)/100}`);
    }
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

function formatMetricValue(name, value) {
  if (name === 'JSHeapUsedSize' || name === 'JSHeapTotalSize') {
    if (!Number.isFinite(value)) return String(value);
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
  }
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}

async function runtimeMetricsStr(cdp, sid) {
  try { await cdp.send('Performance.enable', {}, sid); } catch {}
  const { metrics = [] } = await cdp.send('Performance.getMetrics', {}, sid);
  const wanted = ['Documents', 'Frames', 'JSEventListeners', 'Nodes', 'JSHeapUsedSize', 'Tasks'];
  const byName = new Map(metrics.map(m => [m.name, m.value]));
  const lines = ['Runtime metrics (Performance.getMetrics):'];
  for (const name of wanted) {
    if (!byName.has(name)) continue;
    lines.push(`  ${name}: ${formatMetricValue(name, byName.get(name))}`);
  }
  if (lines.length === 1) lines.push('  (no requested metrics returned by this target)');
  return lines.join('\n');
}

async function pageInfoModel(cdp, sid) {
  let title = '', url = '';
  try {
    const info = JSON.parse(await evalStr(cdp, sid, 'JSON.stringify({ title: document.title, url: window.location.href })'));
    title = info.title;
    url = info.url;
  } catch {}
  return { title, url };
}

function buildConsoleModel(consoleBuf, exceptionBuf, lastReadSeq, flag) {
  const showErrors = flag === '--errors';
  const showAll = flag === '--all';
  let entries;
  let exceptions = [];

  if (showAll) {
    entries = consoleBuf.all();
    exceptions = exceptionBuf.all();
  } else if (showErrors) {
    entries = consoleBuf.all().filter(e => e.level === 'error' || e.level === 'warning');
    exceptions = exceptionBuf.all();
  } else {
    entries = consoleBuf.since(lastReadSeq.console);
    exceptions = exceptionBuf.since(lastReadSeq.exception);
  }

  return {
    schema: 'chrome-cdp-ex.console.v1',
    mode: showAll ? 'all' : showErrors ? 'errors' : 'new',
    entries,
    exceptions,
  };
}

function buildStatusModel({ targetId, page, consoleBuf, exceptionBuf, navBuf, lastReadSeq, runtime = null }) {
  return {
    schema: 'chrome-cdp-ex.status.v1',
    targetId,
    page,
    console: consoleBuf.since(lastReadSeq.console),
    exceptions: exceptionBuf.since(lastReadSeq.exception),
    navigation: navBuf.since(lastReadSeq.nav || 0),
    runtime,
  };
}

async function statusStr(cdp, sid, consoleBuf, exceptionBuf, navBuf, lastReadSeq, opts = {}) {
  const { title, url } = await pageInfoModel(cdp, sid);

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

  if (opts.runtime) {
    try {
      lines.push(await runtimeMetricsStr(cdp, sid));
    } catch (e) {
      lines.push(`Runtime metrics (Performance.getMetrics): unavailable (${e.message})`);
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

async function summaryModel(cdp, sid, consoleBuf, exceptionBuf) {
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
  const allConsole = consoleBuf.all();
  let errors = 0, warnings = 0;
  for (const e of allConsole) {
    if (e.level === 'error') errors++;
    else if (e.level === 'warning' || e.level === 'warn') warnings++;
  }
  const exceptions = exceptionBuf.all().length;

  return {
    schema: 'chrome-cdp-ex.summary.v1',
    page: { title: r.title, url: r.url },
    viewport: {
      size: r.viewport,
      scrollY: r.scrollY,
      scrollMax: r.scrollMax,
    },
    interactive: r.counts,
    focused: r.focused,
    console: { errors, warnings, exceptions },
  };
}

function formatSummaryText(model) {
  const lines = [];
  lines.push(`Title: ${model.page.title}`);
  lines.push(`URL: ${model.page.url}`);
  lines.push(`Viewport: ${model.viewport.size}`);

  const countParts = Object.entries(model.interactive).map(([k, v]) => `${v} ${k}`);
  lines.push(`Interactive: ${countParts.length > 0 ? countParts.join(', ') : 'none found'}`);

  lines.push(`Focused: ${model.focused}`);

  if (model.viewport.scrollMax > 0) {
    const pct = Math.round(model.viewport.scrollY / model.viewport.scrollMax * 100);
    lines.push(`Scroll: ${model.viewport.scrollY} / ${model.viewport.scrollMax} max (${pct}%)`);
  } else {
    lines.push('Scroll: no scroll');
  }

  const parts = [];
  if (model.console.errors > 0) parts.push(`${model.console.errors} error${model.console.errors > 1 ? 's' : ''}`);
  if (model.console.warnings > 0) parts.push(`${model.console.warnings} warning${model.console.warnings > 1 ? 's' : ''}`);
  if (model.console.exceptions > 0) parts.push(`${model.console.exceptions} exception${model.console.exceptions > 1 ? 's' : ''}`);
  lines.push(`Console: ${parts.length > 0 ? parts.join(', ') : 'clean'}`);

  return lines.join('\n');
}

async function summaryStr(cdp, sid, consoleBuf, exceptionBuf) {
  return formatSummaryText(await summaryModel(cdp, sid, consoleBuf, exceptionBuf));
}

function createPerceptionModel({ page, viewport, consoleHealth, refs, nodes, limits }) {
  return {
    schema: 'chrome-cdp-ex.perceive.v1',
    page,
    viewport: {
      ...viewport,
      coordinateSpace: 'viewport-css-px',
    },
    console: consoleHealth,
    refs: {
      generation: refs.generation,
      validity: 'until-navigation-or-dom-rewrite',
    },
    nodes,
    limits,
  };
}

function formatPerceptionJson(model) {
  return formatJson(model);
}

const MAX_ACTION_DELTA_ENTRIES = 5;
const SENSITIVE_QUERY_KEY_RE = /\b(pass(word)?|secret|token|api[-_]?key|credential|otp|2fa|mfa|auth(orization)?|pin|cvv|card|ssn)\b/i;
const NOISY_ACTION_NETWORK_TYPES = new Set(['Image', 'Stylesheet', 'Script', 'Font', 'Media', 'WebSocket']);

function createActionResult({ action, target, dispatch, settle, effects, nextHint }) {
  return {
    schema: 'chrome-cdp-ex.action.v1',
    action,
    target,
    dispatch,
    settle,
    effects,
    nextHint,
  };
}

function createActionObservationBaseline({ consoleBuf = null, exceptionBuf = null, netReqBuf = null } = {}) {
  return {
    console: typeof consoleBuf?.latest === 'function' ? consoleBuf.latest() : 0,
    exception: typeof exceptionBuf?.latest === 'function' ? exceptionBuf.latest() : 0,
    network: typeof netReqBuf?.latest === 'function' ? netReqBuf.latest() : 0,
  };
}

function compactActionText(value, max = 220) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function compactActionUrl(value) {
  const raw = compactActionText(value, 240);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    const params = new URLSearchParams(url.search);
    for (const key of [...params.keys()]) {
      if (SENSITIVE_QUERY_KEY_RE.test(key)) params.set(key, '<redacted>');
    }
    const query = params.toString();
    return compactActionText(`${url.pathname}${query ? `?${query}` : ''}${url.hash || ''}`, 180);
  } catch {
    return compactActionText(raw, 180);
  }
}

function compactConsoleDeltaEntry(entry = {}) {
  return {
    level: compactActionText(entry.level || 'log', 30),
    text: compactActionText(entry.text || entry.msg || entry.message || ''),
    loc: compactActionText(entry.loc || '', 120),
  };
}

function compactExceptionDeltaEntry(entry = {}) {
  return {
    message: compactActionText(entry.msg || entry.message || entry.text || 'Unknown exception'),
    loc: compactActionText(entry.loc || '', 120),
  };
}

function isNetworkFailure(entry = {}) {
  if (entry.failed === true || entry.errorText) return true;
  const status = Number(entry.status);
  return Number.isFinite(status) && status >= 400;
}

function shouldTrackActionNetworkRequest(type) {
  return !NOISY_ACTION_NETWORK_TYPES.has(String(type || ''));
}

function compactNetworkDeltaEntry(entry = {}) {
  const status = entry.pending ? 'pending' : (entry.errorText ? 'failed' : entry.status);
  return {
    method: compactActionText(entry.method || 'GET', 20).toUpperCase(),
    url: compactActionUrl(entry.url || ''),
    status,
    type: compactActionText(entry.type || '', 40),
    duration: Number.isFinite(entry.duration) ? entry.duration : null,
    errorText: entry.errorText ? compactActionText(entry.errorText, 120) : null,
    pending: entry.pending === true,
  };
}

function buildActionObservationDelta({ consoleBuf = null, exceptionBuf = null, netReqBuf = null } = {}, baseline = {}) {
  const consoleEntries = typeof consoleBuf?.since === 'function' ? consoleBuf.since(baseline.console || 0) : [];
  const exceptionEntries = typeof exceptionBuf?.since === 'function' ? exceptionBuf.since(baseline.exception || 0) : [];
  const networkEntries = typeof netReqBuf?.since === 'function' ? netReqBuf.since(baseline.network || 0) : [];
  const consoleCompact = consoleEntries.slice(-MAX_ACTION_DELTA_ENTRIES).map(compactConsoleDeltaEntry);
  const exceptionCompact = exceptionEntries.slice(-MAX_ACTION_DELTA_ENTRIES).map(compactExceptionDeltaEntry);
  const networkCompact = networkEntries.slice(-MAX_ACTION_DELTA_ENTRIES).map(compactNetworkDeltaEntry);
  return {
    console: {
      count: consoleEntries.length,
      errors: consoleEntries.filter(entry => ['error', 'assert'].includes(String(entry.level || '').toLowerCase())).length,
      warnings: consoleEntries.filter(entry => ['warning', 'warn'].includes(String(entry.level || '').toLowerCase())).length,
      entries: consoleCompact,
    },
    exceptions: {
      count: exceptionEntries.length,
      entries: exceptionCompact,
    },
    network: {
      count: networkEntries.length,
      failures: networkEntries.filter(isNetworkFailure).length,
      pending: networkEntries.filter(entry => entry.pending === true).length,
      entries: networkCompact,
    },
  };
}

function numericDeltaCount(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeConsoleDelta(delta = {}) {
  const entries = (delta.entries || []).slice(-MAX_ACTION_DELTA_ENTRIES).map(compactConsoleDeltaEntry);
  return {
    count: numericDeltaCount(delta.count, entries.length),
    errors: numericDeltaCount(delta.errors, entries.filter(entry => ['error', 'assert'].includes(String(entry.level || '').toLowerCase())).length),
    warnings: numericDeltaCount(delta.warnings, entries.filter(entry => ['warning', 'warn'].includes(String(entry.level || '').toLowerCase())).length),
    entries,
  };
}

function normalizeExceptionDelta(delta = {}) {
  const entries = (delta.entries || []).slice(-MAX_ACTION_DELTA_ENTRIES).map(compactExceptionDeltaEntry);
  return {
    count: numericDeltaCount(delta.count, entries.length),
    entries,
  };
}

function normalizeNetworkDelta(delta = {}) {
  const entries = (delta.entries || []).slice(-MAX_ACTION_DELTA_ENTRIES).map(compactNetworkDeltaEntry);
  return {
    count: numericDeltaCount(delta.count, entries.length),
    failures: numericDeltaCount(delta.failures, entries.filter(isNetworkFailure).length),
    pending: numericDeltaCount(delta.pending, entries.filter(entry => entry.pending === true).length),
    entries,
  };
}

function applyActionObservationDelta(actionResult, delta = {}) {
  if (!actionResult.effects) actionResult.effects = {};
  const consoleDelta = normalizeConsoleDelta(delta.console || {});
  const exceptionDelta = normalizeExceptionDelta(delta.exceptions || {});
  const networkDelta = normalizeNetworkDelta(delta.network || {});
  actionResult.effects.consoleDelta = consoleDelta;
  actionResult.effects.exceptionDelta = exceptionDelta;
  actionResult.effects.networkDelta = networkDelta;
  actionResult.effects.console = consoleDelta.entries || [];
  actionResult.effects.exceptions = exceptionDelta.entries || [];
  actionResult.effects.network = networkDelta.entries || [];
  return actionResult;
}

function countLabel(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function formatConsoleDeltaSample(entry) {
  if (!entry) return null;
  const level = entry.level || 'log';
  const loc = entry.loc ? ` @ ${entry.loc}` : '';
  return `[${level}] ${entry.text || '(empty)'}${loc}`;
}

function formatExceptionDeltaSample(entry) {
  if (!entry) return null;
  const loc = entry.loc ? ` @ ${entry.loc}` : '';
  return `${entry.message || 'Unknown exception'}${loc}`;
}

function formatNetworkDeltaSample(entry) {
  if (!entry) return null;
  const status = entry.errorText || entry.status || 'pending';
  const duration = Number.isFinite(entry.duration) ? ` in ${entry.duration}ms` : '';
  return `${entry.method || 'GET'} ${entry.url || '(unknown URL)'} -> ${status}${duration}`;
}

function summarizeActionConsoleDelta(delta = {}) {
  const count = Number(delta.count || 0);
  if (count === 0) return { summary: null, sample: null };
  const parts = [];
  if (delta.errors) parts.push(countLabel(delta.errors, 'error'));
  if (delta.warnings) parts.push(countLabel(delta.warnings, 'warning'));
  const summary = `Console: ${countLabel(count, 'entry', 'entries')}${parts.length ? ` (${parts.join(', ')})` : ''}`;
  const prioritized = [...(delta.entries || [])].find(entry => ['error', 'assert'].includes(String(entry.level || '').toLowerCase()))
    || [...(delta.entries || [])].find(entry => ['warning', 'warn'].includes(String(entry.level || '').toLowerCase()))
    || (delta.entries || [])[0];
  return { summary, sample: formatConsoleDeltaSample(prioritized) };
}

function summarizeActionExceptionDelta(delta = {}) {
  const count = Number(delta.count || 0);
  if (count === 0) return { summary: null, sample: null };
  return {
    summary: `Exception: ${count} thrown`,
    sample: formatExceptionDeltaSample((delta.entries || [])[0]),
  };
}

function summarizeActionNetworkDelta(delta = {}) {
  const count = Number(delta.count || 0);
  if (count === 0) return { summary: null, sample: null };
  const failures = Number(delta.failures || 0);
  const pending = Number(delta.pending || 0);
  const parts = [];
  if (failures) parts.push(countLabel(failures, 'failed', 'failed'));
  if (pending) parts.push(countLabel(pending, 'pending', 'pending'));
  const summary = `Network: ${countLabel(count, 'request')}${parts.length ? ` (${parts.join(', ')})` : ''}`;
  const prioritized = [...(delta.entries || [])].find(isNetworkFailure) || (delta.entries || [])[0];
  return { summary, sample: formatNetworkDeltaSample(prioritized) };
}

function summarizeActionObservationEffects(effects = {}) {
  const consoleSummary = summarizeActionConsoleDelta(effects.consoleDelta);
  const exceptionSummary = summarizeActionExceptionDelta(effects.exceptionDelta);
  const networkSummary = summarizeActionNetworkDelta(effects.networkDelta);
  return {
    consoleSummary: consoleSummary.summary,
    consoleSample: consoleSummary.sample,
    exceptionSummary: exceptionSummary.summary,
    exceptionSample: exceptionSummary.sample,
    networkSummary: networkSummary.summary,
    networkSample: networkSummary.sample,
  };
}

function formatActionText(result) {
  const diagnostics = summarizeActionObservationEffects(result.effects || {});
  const lines = [
    `${result.action}: ${result.dispatch.ok ? 'dispatched' : 'failed'} via ${result.dispatch.method}`,
  ];
  if (result.target?.label) lines.push(`Target: ${result.target.label}`);
  if (result.effects?.failure?.kind) lines.push(`Failure: ${result.effects.failure.kind}`);
  if (result.settle) {
    const duration = result.settle.durationMs ? ` in ${result.settle.durationMs}ms` : '';
    lines.push(`Settle: ${result.settle.ok ? 'ok' : 'not confirmed'}${duration}`);
  }
  if (diagnostics.consoleSummary) lines.push(diagnostics.consoleSummary);
  if (diagnostics.consoleSample) lines.push(`Console sample: ${diagnostics.consoleSample}`);
  if (diagnostics.exceptionSummary) lines.push(diagnostics.exceptionSummary);
  if (diagnostics.exceptionSample) lines.push(`Exception sample: ${diagnostics.exceptionSample}`);
  if (diagnostics.networkSummary) lines.push(diagnostics.networkSummary);
  if (diagnostics.networkSample) lines.push(`Network sample: ${diagnostics.networkSample}`);
  if (result.effects?.domDiff) lines.push('---', result.effects.domDiff);
  if (result.nextHint) lines.push(`Hint: ${result.nextHint}`);
  return lines.join('\n');
}

function finalizeActionResult(result, { enrichActionResult = null, onActionResult = null } = {}) {
  if (enrichActionResult) enrichActionResult(result);
  if (onActionResult) onActionResult(result);
  return result;
}

async function runActionWithFeedback({ action, target = null, dispatch, feedbackPolicy, observe, dispatchMethod = action, nextHint = 'Use perceive --since-action if more evidence is needed', enrichActionResult = null, onActionResult = null }) {
  const startedAt = Date.now();
  let dispatchText;
  try {
    dispatchText = await dispatch();
  } catch (e) {
    const failure = classifyActionFailure(e, { action, target });
    const result = createActionResult({
      action,
      target: target || { input: '', resolvedBy: 'command', label: '' },
      dispatch: { ok: false, method: dispatchMethod, error: failure.originalMessage },
      settle: { ok: false, durationMs: Date.now() - startedAt },
      effects: { domDiff: null, console: [], network: [], navigation: null, failure },
      nextHint: failure.nextCommand,
    });
    finalizeActionResult(result, { enrichActionResult, onActionResult });
    throw new Error(formatActionFailure(e, { action, target }));
  }
  if (feedbackPolicy === 'none' || feedbackPolicy === 'report-only') {
    const result = createActionResult({
      action,
      target: target || { input: '', resolvedBy: 'command', label: '' },
      dispatch: { ok: true, method: dispatchMethod },
      settle: { ok: true, durationMs: Date.now() - startedAt },
      effects: { domDiff: null, console: [], network: [], navigation: null },
      nextHint: feedbackPolicy === 'report-only' ? nextHint : null,
    });
    finalizeActionResult(result, { enrichActionResult, onActionResult });
    if (feedbackPolicy === 'none') return dispatchText;
    return `${dispatchText}\n---\n${formatActionText(result)}`;
  }
  try {
    const domDiff = await observe();
    const result = createActionResult({
      action,
      target: target || { input: '', resolvedBy: 'command', label: '' },
      dispatch: { ok: true, method: dispatchMethod },
      settle: { ok: true, durationMs: Date.now() - startedAt },
      effects: { domDiff, console: [], network: [], navigation: null },
      nextHint,
    });
    finalizeActionResult(result, { enrichActionResult, onActionResult });
    return `${dispatchText}\n---\n${formatActionText(result)}`;
  } catch (e) {
    if (!isTimeoutError(e)) throw e;
    const result = createActionResult({
      action,
      target: target || { input: '', resolvedBy: 'command', label: '' },
      dispatch: { ok: true, method: dispatchMethod },
      settle: { ok: false, durationMs: Date.now() - startedAt },
      effects: { domDiff: null, console: [], network: [], navigation: null },
      nextHint,
    });
    finalizeActionResult(result, { enrichActionResult, onActionResult });
    return `${dispatchText}\n---\n${formatActionText(result)}\n(success but observation timed out after action dispatch: ${e.message}. The action was already sent; run \`perceive --since-action\`, \`perceive --diff\`, or \`status\` to refresh.)`;
  }
}

function summarizeActionDomDiff(domDiff) {
  const lines = String(domDiff || '').split('\n').map(l => l.trim()).filter(Boolean);
  const summary = lines.find(l =>
    l.startsWith('+++ Added') ||
    l.startsWith('--- Removed') ||
    l.startsWith('~~~ Text nodes updated') ||
    l.includes('no changes detected')
  ) || null;
  const sample = lines.find(l => /^[+-]\s/.test(l)) || null;
  return { summary, sample };
}

const SENSITIVE_ACTION_TARGET_RE = /\b(pass(word)?|secret|token|api[-_]?key|credential|otp|2fa|mfa|auth(orization)?|pin|cvv|card|ssn)\b/i;

function isSensitiveActionTarget(action, target = {}) {
  if (action !== 'fill' && action !== 'type') return false;
  const probe = [
    target.input,
    target.label,
    ...(Array.isArray(target.commandArgs) ? target.commandArgs.slice(0, 1) : []),
  ].filter(Boolean).join(' ');
  return SENSITIVE_ACTION_TARGET_RE.test(probe);
}

function sanitizeActionTargetForLog(action, target = null) {
  if (!target || typeof target !== 'object') return target;
  const sanitized = {
    ...target,
    commandArgs: Array.isArray(target.commandArgs) ? [...target.commandArgs] : target.commandArgs,
  };
  if (isSensitiveActionTarget(action, sanitized) && Array.isArray(sanitized.commandArgs) && sanitized.commandArgs.length > 1) {
    sanitized.commandArgs = sanitized.commandArgs.map((arg, index) => index === 0 ? arg : '<redacted>');
    sanitized.redacted = [...(sanitized.redacted || []), 'commandArgs'];
  }
  return sanitized;
}

function sessionLogPath(targetId, runtimeDir = RUNTIME_DIR) {
  const safeTarget = String(targetId || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_');
  return resolve(runtimeDir, `cdp-${safeTarget}.log`);
}

function sessionScreenshotDir(targetId, runtimeDir = RUNTIME_DIR) {
  const safeTarget = String(targetId || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_');
  return resolve(runtimeDir, `cdp-${safeTarget}-screenshots`);
}

function nextSessionScreenshotPath(session, kind = 'shot') {
  const safeKind = String(kind || 'shot').replace(/[^A-Za-z0-9_.-]/g, '_');
  const dir = session.screenshotDir || sessionScreenshotDir(session.targetId);
  const seq = String((session.screenshots?.length || 0) + 1).padStart(3, '0');
  return resolve(dir, `${safeKind}-${seq}.png`);
}

function ensureSessionScreenshotDir(session) {
  if (!session.screenshotDir) return null;
  try {
    mkdirSync(session.screenshotDir, { recursive: true, mode: 0o700 });
    return session.screenshotDir;
  } catch (e) {
    if (!session.logErrors) session.logErrors = [];
    session.logErrors.push({ ts: Date.now(), message: `screenshot-dir: ${e.message}` });
    return null;
  }
}

function appendSessionEventLog(session, event, { writer = appendFileSync } = {}) {
  if (!session.logPath) return null;
  const payload = {
    schema: 'chrome-cdp-ex.session-event.v1',
    targetId: session.targetId,
    sessionId: session.sessionId,
    ...event,
  };
  try {
    writer(session.logPath, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
    return payload;
  } catch (e) {
    if (!session.logErrors) session.logErrors = [];
    session.logErrors.push({ ts: Date.now(), message: e.message });
    return null;
  }
}

function initializeSessionLog(session, { ts = session.createdAt || Date.now(), writer = writeFileSync } = {}) {
  if (!session.logPath) return null;
  const payload = {
    schema: 'chrome-cdp-ex.session-event.v1',
    kind: 'session-start',
    ts,
    targetId: session.targetId,
    sessionId: session.sessionId,
  };
  try {
    writer(session.logPath, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
    return payload;
  } catch (e) {
    if (!session.logErrors) session.logErrors = [];
    session.logErrors.push({ ts: Date.now(), message: e.message });
    return null;
  }
}

function appendSessionActionLog(session, actionResult, { ts = Date.now() } = {}) {
  if (!session.actionLog) session.actionLog = [];
  const domDiff = actionResult.effects?.domDiff || '';
  const { summary, sample } = summarizeActionDomDiff(domDiff);
  const diagnostics = summarizeActionObservationEffects(actionResult.effects || {});
  const target = sanitizeActionTargetForLog(actionResult.action, actionResult.target || null);
  const entry = {
    ts,
    action: actionResult.action,
    target,
    dispatch: actionResult.dispatch || null,
    settle: actionResult.settle || null,
    effectSummary: summary,
    effectSample: sample,
    consoleSummary: diagnostics.consoleSummary,
    consoleSample: diagnostics.consoleSample,
    exceptionSummary: diagnostics.exceptionSummary,
    exceptionSample: diagnostics.exceptionSample,
    networkSummary: diagnostics.networkSummary,
    networkSample: diagnostics.networkSample,
    failure: actionResult.effects?.failure || null,
    nextHint: actionResult.nextHint || null,
  };
  session.actionLog.push(entry);
  if (session.actionLog.length > MAX_ACTION_LOG_ENTRIES) {
    session.actionLog.splice(0, session.actionLog.length - MAX_ACTION_LOG_ENTRIES);
  }
  appendSessionEventLog(session, { kind: 'action', ts, action: entry });
  return entry;
}

function appendSessionScreenshot(session, { kind = 'shot', path = null, note = '', ts = Date.now() } = {}) {
  if (!session.screenshots) session.screenshots = [];
  const entry = {
    ts,
    kind,
    path: path || nextSessionScreenshotPath(session, kind),
    note,
  };
  session.screenshots.push(entry);
  if (session.screenshots.length > MAX_SCREENSHOT_ENTRIES) {
    session.screenshots.splice(0, session.screenshots.length - MAX_SCREENSHOT_ENTRIES);
  }
  appendSessionEventLog(session, { kind: 'screenshot', ts, screenshot: entry });
  return entry;
}

function formatSessionReport(session, { now = Date.now() } = {}) {
  const actionLog = session.actionLog || [];
  const screenshots = session.screenshots || [];
  const uptimeMs = Math.max(0, now - (session.createdAt || now));
  const lines = [
    `Session report: ${session.targetId}`,
    `CDP session: ${session.sessionId}`,
    `Uptime: ${formatDuration(uptimeMs)}`,
    `Log: ${session.logPath || '(disabled)'}`,
    `Screenshot dir: ${session.screenshotDir || '(disabled)'}`,
    `Actions: ${actionLog.length}`,
    `Screenshots: ${screenshots.length}`,
    `Records: ${session.records?.length || 0}`,
    '',
    'Action timeline:',
  ];
  if (actionLog.length === 0) {
    lines.push('No actions recorded yet. Run click/fill/press/nav/inject/reload, then report again.');
  } else {
    for (const [i, entry] of actionLog.entries()) {
      const label = entry.target?.label || entry.target?.input || '';
      const settleStatus = entry.dispatch?.ok === false ? 'failed' : (entry.settle?.ok ? 'ok' : 'not confirmed');
      const settleDuration = Number.isFinite(entry.settle?.durationMs) ? ` in ${entry.settle.durationMs}ms` : '';
      lines.push(`${i + 1}. ${entry.action}${label ? ` ${label}` : ''} — ${settleStatus}${settleDuration}`);
      if (entry.dispatch?.method) lines.push(`   Dispatch: ${entry.dispatch.method}`);
      if (entry.failure?.kind) lines.push(`   Failure: ${entry.failure.kind} — ${entry.failure.reason}`);
      if (entry.effectSummary) lines.push(`   Effect: ${entry.effectSummary}`);
      if (entry.effectSample) lines.push(`   Sample: ${entry.effectSample}`);
      if (entry.consoleSummary) lines.push(`   ${entry.consoleSummary}`);
      if (entry.consoleSample) lines.push(`   Console sample: ${entry.consoleSample}`);
      if (entry.exceptionSummary) lines.push(`   ${entry.exceptionSummary}`);
      if (entry.exceptionSample) lines.push(`   Exception sample: ${entry.exceptionSample}`);
      if (entry.networkSummary) lines.push(`   ${entry.networkSummary}`);
      if (entry.networkSample) lines.push(`   Network sample: ${entry.networkSample}`);
      if (entry.nextHint) lines.push(`   Next: ${entry.nextHint}`);
    }
  }
  if (screenshots.length > 0) {
    lines.push('', 'Attachments:');
    for (const [i, entry] of screenshots.entries()) {
      const note = entry.note ? ` (${entry.note})` : '';
      lines.push(`${i + 1}. ${entry.kind || 'shot'} — ${entry.path}${note}`);
    }
  }
  lines.push('', 'Next: use `perceive --since-action` to re-check the last action, or continue from the timeline above.');
  return lines.join('\n');
}

function commandArgsFromTarget(entry, fallbackArgs = []) {
  const args = entry.target && Array.isArray(entry.target.commandArgs)
    ? entry.target.commandArgs
    : fallbackArgs;
  return args.filter(v => v !== undefined && v !== null).map(v => String(v));
}

function inferRecordActionCommand(entry) {
  const targetInput = entry.target?.input || '';
  const commandName = entry.target?.commandName || entry.action;
  const explicitArgs = entry.target && Array.isArray(entry.target.commandArgs);
  if (explicitArgs) {
    const args = commandArgsFromTarget(entry);
    const needsInput = args.includes('<redacted>') ? redactedCommandNeedsInput(entry.action) : [];
    return { command: [commandName, ...args], replayable: needsInput.length === 0, needsInput };
  }

  switch (entry.action) {
    case 'click':
    case 'jsclick':
      return targetInput
        ? { command: [entry.action, targetInput], replayable: true, needsInput: [] }
        : { command: [entry.action, '<selector|@ref>'], replayable: false, needsInput: ['target'] };
    case 'clickxy': {
      const parts = targetInput.split(',').map(s => s.trim()).filter(Boolean);
      return parts.length >= 2
        ? { command: ['clickxy', parts[0], parts[1]], replayable: true, needsInput: [] }
        : { command: ['clickxy', '<x>', '<y>'], replayable: false, needsInput: ['coordinates'] };
    }
    case 'press':
    case 'scroll':
    case 'nav':
    case 'viewport':
      return targetInput
        ? { command: [entry.action, ...targetInput.split(/\s+/).filter(Boolean)], replayable: true, needsInput: [] }
        : { command: [entry.action, '<input>'], replayable: false, needsInput: ['input'] };
    case 'back':
    case 'forward':
    case 'reload':
    case 'dismiss-modal':
      return { command: [entry.action], replayable: true, needsInput: [] };
    case 'fill':
      return {
        command: ['fill', targetInput || '<selector|@ref>', '<text>'],
        replayable: false,
        needsInput: targetInput ? ['text'] : ['target', 'text'],
      };
    case 'select':
      return {
        command: ['select', targetInput || '<selector>', '<value>'],
        replayable: false,
        needsInput: targetInput ? ['value'] : ['target', 'value'],
      };
    case 'type':
      return { command: ['type', '<text>'], replayable: false, needsInput: ['text'] };
    case 'inject':
      return { command: ['inject', targetInput || '<type>', '<content>'], replayable: false, needsInput: ['content'] };
    default:
      return {
        command: targetInput ? [entry.action, targetInput] : [entry.action],
        replayable: false,
        needsInput: ['review'],
      };
  }
}

function redactedCommandNeedsInput(action) {
  if (action === 'fill' || action === 'type') return ['text'];
  if (action === 'select') return ['value'];
  if (action === 'inject') return ['content'];
  return ['input'];
}

function buildRecordActionsModel(session) {
  const actions = (session.actionLog || []).map((entry, index) => {
    const inferred = inferRecordActionCommand(entry);
    return {
      index: index + 1,
      ts: entry.ts,
      action: entry.action,
      target: entry.target || null,
      command: inferred.command,
      replayable: inferred.replayable,
      needsInput: inferred.needsInput,
      evidence: {
        dispatchMethod: entry.dispatch?.method || null,
        settleOk: entry.settle?.ok ?? null,
        settleDurationMs: entry.settle?.durationMs ?? null,
        effectSummary: entry.effectSummary || null,
        effectSample: entry.effectSample || null,
        consoleSummary: entry.consoleSummary || null,
        consoleSample: entry.consoleSample || null,
        exceptionSummary: entry.exceptionSummary || null,
        exceptionSample: entry.exceptionSample || null,
        networkSummary: entry.networkSummary || null,
        networkSample: entry.networkSample || null,
        failure: entry.failure || null,
        nextHint: entry.nextHint || null,
      },
    };
  });
  return {
    schema: 'chrome-cdp-ex.record-actions.v1',
    targetId: session.targetId,
    sessionId: session.sessionId,
    source: 'session-action-log',
    actionCount: actions.length,
    actions,
  };
}

function formatCommandLine(command) {
  return (command || []).map(arg => {
    const s = String(arg);
    return /^[^\s"']+$/.test(s) ? s : JSON.stringify(s);
  }).join(' ');
}

function formatRecordActions(session, { format = 'text' } = {}) {
  const model = buildRecordActionsModel(session);
  if (format === 'json') return formatJson(model);
  const lines = [
    `Recorded actions: ${model.actionCount}`,
    `Session: ${model.targetId}`,
    'Source: current daemon session action log',
  ];
  if (model.actions.length === 0) {
    lines.push('No actions recorded yet. Run click/fill/press/nav/inject/reload, then record-actions again.');
    return lines.join('\n');
  }
  for (const step of model.actions) {
    const label = step.target?.label || step.target?.input || '';
    const status = step.replayable ? 'replayable' : (step.needsInput.length ? 'needs input' : 'review needed');
    lines.push(`${step.index}. ${step.action}${label ? ` ${label}` : ''} — ${status}`);
    lines.push(`   Replay: ${formatCommandLine(step.command)}`);
    if (step.needsInput.length) lines.push(`   Missing: ${step.needsInput.join(', ')}`);
    if (step.evidence.settleOk !== null) {
      const settle = step.evidence.settleOk ? 'ok' : 'not confirmed';
      const duration = Number.isFinite(step.evidence.settleDurationMs) ? ` in ${step.evidence.settleDurationMs}ms` : '';
      lines.push(`   Settle: ${settle}${duration}`);
    }
    if (step.evidence.effectSummary) lines.push(`   Evidence: ${step.evidence.effectSummary}`);
    if (step.evidence.effectSample) lines.push(`   Sample: ${step.evidence.effectSample}`);
    if (step.evidence.consoleSummary) lines.push(`   ${step.evidence.consoleSummary}`);
    if (step.evidence.consoleSample) lines.push(`   Console sample: ${step.evidence.consoleSample}`);
    if (step.evidence.exceptionSummary) lines.push(`   ${step.evidence.exceptionSummary}`);
    if (step.evidence.exceptionSample) lines.push(`   Exception sample: ${step.evidence.exceptionSample}`);
    if (step.evidence.networkSummary) lines.push(`   ${step.evidence.networkSummary}`);
    if (step.evidence.networkSample) lines.push(`   Network sample: ${step.evidence.networkSample}`);
  }
  return lines.join('\n');
}

function createSessionState({ targetId, sessionId, logPath = sessionLogPath(targetId), screenshotDir = sessionScreenshotDir(targetId) }) {
  return {
    targetId,
    sessionId,
    createdAt: Date.now(),
    logPath,
    screenshotDir,
    logErrors: [],
    pageGeneration: 0,
    refGeneration: 0,
    refs: {
      map: new Map(),
      generation: 0,
      lastPerceiveAt: 0,
      invalidatedAt: Date.now(),
      invalidationReason: 'daemon-start',
    },
    lastPerceive: { output: null, model: null },
    lastAction: null,
    buffers: {},
    pendingRequests: new Map(),
    actionLog: [],
    screenshots: [],
    records: [],
    frames: [],
    injections: [],
    privacy: {
      redactCookies: true,
      redactStorage: true,
      redactAuthorizationHeaders: true,
    },
  };
}

function invalidateSessionRefs(session, reason) {
  session.refs.map.clear();
  if (session.refs.frameRefs instanceof Map) session.refs.frameRefs.clear();
  if (session.refs.frameLastOutputs instanceof Map) session.refs.frameLastOutputs.clear();
  session.refs.invalidatedAt = Date.now();
  session.refs.invalidationReason = reason;
  session.refGeneration += 1;
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

// Format a stale/unknown @ref error explaining the most likely root cause.
// `state` holds {generation, invalidationReason, lastPerceiveAt} from the daemon.
function formatUnknownRefError(ref, state = {}) {
  const reason = state.invalidationReason || (state.generation ? null : 'daemon-start');
  if (reason === 'navigation') {
    return `Unknown ref: ${ref}. Refs were cleared because the page navigated/reloaded after the last perceive (e.g. Vite HMR or in-app routing). Run "perceive" to refresh refs, or use a stable CSS selector for long loops.`;
  }
  if (reason === 'dom-mutation') {
    return `Unknown ref: ${ref}. Refs were invalidated by DOM changes after the last perceive. Run "perceive" again, or use a stable CSS selector in batch/loops.`;
  }
  if (reason === 'daemon-start' || (!state.generation)) {
    return `Unknown ref: ${ref}. No refs have been assigned in this daemon yet. Run "perceive" first, or use a CSS selector.`;
  }
  return `Unknown ref: ${ref}. Run "perceive" to refresh refs, or use a stable CSS selector for long loops.`;
}

async function resolveRefNode(cdp, sid, refMap, ref, refState) {
  const frameParsed = parseFrameRef(ref);
  let num = null;
  let frameEntry = null;
  let backendNodeId;
  if (frameParsed) {
    const scoped = frameScopedBackendNode(refState || {}, frameParsed);
    frameEntry = scoped.entry;
    backendNodeId = scoped.backendNodeId;
  } else {
    num = parseInt(ref.slice(1));
    if (isNaN(num) || !refMap.has(num)) {
      throw new Error(formatUnknownRefError(ref, refState || {}));
    }
    backendNodeId = refMap.get(num);
  }
  try {
    const { object } = await cdp.send('DOM.resolveNode', { backendNodeId }, sid);
    return object.objectId;
  } catch (e) {
    // The ref existed in this daemon, but the backend node can no longer be
    // resolved. That is the common "DOM rewrote the element after perceive"
    // stale-ref case; classify it distinctly instead of surfacing raw CDP text.
    if (refState) {
      refState.invalidatedAt = Date.now();
      refState.invalidationReason = 'dom-mutation';
    }
    if (frameParsed) frameEntry?.refs?.delete(frameParsed.refIndex);
    else refMap.delete(num);
    throw new Error(formatUnknownRefError(ref, refState || {}) + ` Original CDP error: ${e.message}`);
  }
}

async function resolveRef(cdp, sid, refMap, ref, refState) {
  const frameParsed = parseFrameRef(ref);
  const objectId = await resolveRefNode(cdp, sid, refMap, ref, refState);
  const result = await cdp.send('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: `function() {
      this.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = this.getBoundingClientRect();
      return { x: rect.x, y: rect.y, w: rect.width, h: rect.height, tag: this.tagName, text: this.textContent.trim().substring(0, 80) };
    }`,
    returnByValue: true,
  }, sid);
  const value = result.result.value || {};
  if (frameParsed) {
    const { entry } = frameScopedBackendNode(refState || {}, frameParsed);
    const offset = await frameViewportOffset(cdp, sid, entry);
    value.x = (Number(value.x) || 0) + offset.x;
    value.y = (Number(value.y) || 0) + offset.y;
  }
  return value;
}

function isRef(s) { return /^@\d+$/.test(s) || /^@f\d+:\d+$/.test(s); }

function parseFrameOnlyRef(s) {
  const m = String(s || '').match(/^@f(\d+)$/);
  if (!m) return null;
  const frameIndex = Number(m[1]);
  if (!Number.isSafeInteger(frameIndex) || frameIndex < 1) return null;
  return { frameRef: `@f${frameIndex}`, frameIndex };
}

function parseFrameRef(s) {
  const m = String(s || '').match(/^@f(\d+):(\d+)$/);
  if (!m) return null;
  const frameIndex = Number(m[1]);
  const refIndex = Number(m[2]);
  if (!Number.isSafeInteger(frameIndex) || frameIndex < 1 || !Number.isSafeInteger(refIndex) || refIndex < 1) return null;
  return {
    frameRef: `@f${frameIndex}`,
    frameIndex,
    ref: `@${refIndex}`,
    refIndex,
  };
}

function flattenFrameTree(frameTree, { startIndex = 1 } = {}) {
  const frames = [];
  function visit(node, depth = 0, parentRef = null) {
    if (!node?.frame) return;
    const ref = `@f${startIndex + frames.length}`;
    const frame = node.frame;
    frames.push({
      ref,
      index: startIndex + frames.length,
      id: frame.id || '',
      parentId: frame.parentId || null,
      parentRef,
      depth,
      name: frame.name || '',
      url: frame.url || '',
      securityOrigin: frame.securityOrigin || '',
      unreachableUrl: frame.unreachableUrl || '',
      mimeType: frame.mimeType || '',
    });
    for (const child of node.childFrames || []) visit(child, depth + 1, ref);
  }
  visit(frameTree);
  return frames;
}

function formatFrameTreeText(frames = []) {
  const lines = [`Frames: ${frames.length}`];
  if (frames.length === 0) {
    lines.push('No frames reported by Page.getFrameTree.');
    return lines.join('\n');
  }
  for (const frame of frames) {
    const indent = '  '.repeat(Math.min(frame.depth || 0, 8));
    const label = frame.name || '(anonymous)';
    const parent = frame.parentRef ? ` parent:${frame.parentRef}` : '';
    const origin = frame.securityOrigin ? ` origin:${frame.securityOrigin}` : '';
    const url = frame.url || frame.unreachableUrl || '(no url)';
    lines.push(`${indent}${frame.ref} ${label} ${frame.id}${parent} ${url}${origin}`);
  }
  lines.push('Hint: use frame refs to diagnose wrong-frame errors; element refs inside frames will use @fN:M syntax.');
  return lines.join('\n');
}

async function framesModel(cdp, sid) {
  const result = await cdp.send('Page.getFrameTree', {}, sid);
  const frames = flattenFrameTree(result.frameTree);
  return {
    schema: 'chrome-cdp-ex.frames.v1',
    frameCount: frames.length,
    frames,
  };
}

async function framesStr(cdp, sid, { format = 'text' } = {}) {
  const model = await framesModel(cdp, sid);
  if (format === 'json') return formatJson(model);
  return formatFrameTreeText(model.frames);
}

async function resolveFrameRef(cdp, sid, frameRef) {
  const parsed = parseFrameOnlyRef(frameRef);
  if (!parsed) throw new Error(`Frame ref required (example: @f2), got: ${frameRef || '(empty)'}`);
  const model = await framesModel(cdp, sid);
  const frame = model.frames[parsed.frameIndex - 1];
  if (!frame || frame.ref !== parsed.frameRef) {
    throw new Error(`Unknown frame: ${parsed.frameRef}. Run "frame" to refresh the frame tree, then use a listed @fN ref.`);
  }
  return { frame, frames: model.frames };
}

async function createFrameExecutionContext(cdp, sid, frameId) {
  const res = await cdp.send('Page.createIsolatedWorld', {
    frameId,
    worldName: 'chrome-cdp-ex',
    grantUniveralAccess: false,
  }, sid);
  return res.executionContextId;
}

function storeFrameScopedRefs(refState, frame, frames, scopedRefMap) {
  if (!refState || !frame) return;
  if (!(refState.frameRefs instanceof Map)) refState.frameRefs = new Map();
  refState.frameRefs.set(frame.ref, {
    frameRef: frame.ref,
    frameIndex: frame.index,
    frameId: frame.id,
    parentId: frame.parentId || null,
    parentRef: frame.parentRef || null,
    name: frame.name || '',
    url: frame.url || '',
    refs: new Map(scopedRefMap),
    frames: frames || [],
  });
}

function frameScopedRefEntry(refState, parsed) {
  const store = refState?.frameRefs;
  if (!(store instanceof Map)) return null;
  return store.get(parsed.frameRef) || null;
}

function frameScopedBackendNode(refState, parsed) {
  const entry = frameScopedRefEntry(refState, parsed);
  if (!entry) {
    throw new Error(`Unknown frame ref: ${parsed.frameRef}. Run "frame", then "perceive --frame ${parsed.frameRef}" to assign iframe-local refs.`);
  }
  if (!(entry.refs instanceof Map) || !entry.refs.has(parsed.refIndex)) {
    throw new Error(`Unknown ref: ${parsed.frameRef}:${parsed.refIndex}. Run "perceive --frame ${parsed.frameRef}" to refresh refs inside that frame.`);
  }
  return { entry, backendNodeId: entry.refs.get(parsed.refIndex) };
}

function qualifyFrameRefsInLines(lines, frameRef) {
  return lines.map(line => line.replace(/@(\d+)(?=\s*(?:\(|$))/, `${frameRef}:$1`));
}

function frameRefFromActionTarget(target = {}) {
  for (const value of [target.input, target.label, target.selector]) {
    const parsed = parseFrameRef(value);
    if (parsed) return parsed.frameRef;
  }
  return null;
}

function rememberFramePerceiveOutput(refState, frameRef, output) {
  if (!refState || !frameRef) return;
  if (!(refState.frameLastOutputs instanceof Map)) refState.frameLastOutputs = new Map();
  refState.frameLastOutputs.set(frameRef, output);
}

function baselineOutputForActionTarget(refState, fallbackOutput, target = {}) {
  const targetFrameRef = frameRefFromActionTarget(target);
  if (targetFrameRef && refState?.frameLastOutputs instanceof Map && refState.frameLastOutputs.has(targetFrameRef)) {
    return refState.frameLastOutputs.get(targetFrameRef);
  }
  return fallbackOutput;
}

async function frameViewportOffset(cdp, sid, frameEntry) {
  if (!frameEntry?.frameId || !frameEntry.parentId) return { x: 0, y: 0 };
  let x = 0;
  let y = 0;
  let current = frameEntry;
  for (let guard = 0; current?.frameId && current.parentId && guard < 8; guard++) {
    const owner = await cdp.send('DOM.getFrameOwner', { frameId: current.frameId }, sid);
    const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: owner.backendNodeId }, sid);
    const res = await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: `function() {
        const r = this.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
      }`,
      returnByValue: true,
    }, sid);
    const rect = res.result.value || {};
    x += Number(rect.x) || 0;
    y += Number(rect.y) || 0;
    const parent = (current.frames || []).find(frame => frame.id === current.parentId);
    if (!parent) break;
    current = {
      ...parent,
      frameRef: parent.ref,
      frameId: parent.id,
      frames: current.frames || [],
    };
  }
  return { x, y };
}

async function resolveRefRectNoScroll(cdp, sid, refMap, ref, refState) {
  const frameParsed = parseFrameRef(ref);
  const objectId = await resolveRefNode(cdp, sid, refMap, ref, refState);
  const result = await cdp.send('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: `function() {
      const rect = this.getBoundingClientRect();
      const cs = (typeof getComputedStyle === 'function') ? getComputedStyle(this) : null;
      return {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
        tag: this.tagName,
        text: (this.textContent || '').trim().substring(0, 80),
        position: cs ? cs.position : '',
        pointerEvents: cs ? cs.pointerEvents : '',
        visible: !!(rect.width && rect.height),
      };
    }`,
    returnByValue: true,
  }, sid);
  const value = result.result.value || {};
  if (frameParsed) {
    const { entry } = frameScopedBackendNode(refState || {}, frameParsed);
    const offset = await frameViewportOffset(cdp, sid, entry);
    value.x = (Number(value.x) || 0) + offset.x;
    value.y = (Number(value.y) || 0) + offset.y;
  }
  return value;
}

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
  const opts = {
    diff: false, selector: null, exclude: null,
    interactive: false, maxDepth: Infinity, cursorInteractive: false,
    keepRefs: false, last: null, sinceAction: false, frameRef: null,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--diff') opts.diff = true;
    else if (a === '--since-action') opts.sinceAction = true;
    else if (a === '-F' || a === '--frame') opts.frameRef = args[++i] || null;
    else if (a === '-s' || a === '--selector') opts.selector = args[++i];
    else if (a === '-x' || a === '--exclude') opts.exclude = args[++i];
    else if (a === '-i' || a === '--interactive') opts.interactive = true;
    else if (a === '-d' || a === '--depth') opts.maxDepth = parseInt(args[++i]) || Infinity;
    else if (a === '-C' || a === '--cursor-interactive') opts.cursorInteractive = true;
    else if (a === '--keep-refs') opts.keepRefs = true;
    else if (a === '--last') {
      const n = parseInt(args[++i]);
      opts.last = Number.isFinite(n) && n > 0 ? n : null;
    }
  }
  return opts;
}

function formatPerceiveDiffOutput(previousOutput, currentOutput) {
  const prev = previousOutput.split('\n');
  const curr = currentOutput.split('\n');
  const diffLines = [];
  // Skip header lines up to the first blank line. Frame-scoped perceive adds
  // a `Frame:` header, so avoid hard-coding the legacy 5-line header shape.
  const prevHeaderEnd = prev.findIndex(line => line === '');
  const currHeaderEnd = curr.findIndex(line => line === '');
  const prevTreeStart = prevHeaderEnd >= 0 ? prevHeaderEnd + 1 : 5;
  const currTreeStart = currHeaderEnd >= 0 ? currHeaderEnd + 1 : 5;
  const prevTree = prev.slice(prevTreeStart);
  const currTree = curr.slice(currTreeStart);
  // Line-level diff with StaticText noise filtering.
  const prevSet = new Set(prevTree);
  const currSet = new Set(currTree);
  const removed = prevTree.filter(l => !currSet.has(l));
  const added = currTree.filter(l => !prevSet.has(l));
  const isTextOnly = l => /^\s*\[StaticText\]/.test(l) && !isPriorityPerceiveTextLine(l);
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
    if (removedText > 0 || addedText > 0) {
      const parts = [];
      if (removedText > 0) parts.push(`${removedText} removed`);
      if (addedText > 0) parts.push(`${addedText} added`);
      diffLines.push(`~~~ Text nodes updated (${parts.join(', ')})`);
    }
  }
  const headerEnd = currHeaderEnd >= 0 ? currHeaderEnd : 5;
  return curr.slice(0, headerEnd).join('\n') + '\n\n' + diffLines.join('\n');
}

// Format a single @ref bounding-rect annotation. Adds `position` only for
// fixed/sticky elements so agents do not misread visible fixed UI as off-screen.
function formatRefRect(rect) {
  if (!rect) return '';
  const base = `(${rect.x},${rect.y} ${rect.w}×${rect.h}`;
  if (rect.position === 'fixed' || rect.position === 'sticky') {
    return `${base}, ${rect.position})`;
  }
  return `${base})`;
}

// Pure tree-building logic extracted from perceiveStr for testability.
// Takes raw AX nodes + page metadata, returns enriched tree lines and ref node IDs.
function buildPerceiveTree(nodes, meta, refMap, opts = {}) {
  const { maxDepth = Infinity, interactiveOnly = false, keepRefs = false, last = null } = opts;

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

  // --last N: keep only the last N StaticText / paragraph rows. Ref-bearing
  // lines (anything containing `@<digit>` or `@c<digit>`) and structural lines
  // (landmarks, headings, dialogs, etc.) are always kept.
  // --keep-refs: when truncating, ensure every line carrying an @ref survives.
  let outLines = treeLines;
  if (last && Number.isFinite(last) && last > 0) {
    const refLineRe = /@(c?\d+)/;
    const textRoleRe = /\[(StaticText|paragraph|listitem|note|description|comment|term|definition)\]/;
    // Walk backwards collecting the last N text lines while keeping all ref/structural lines
    const reversed = [];
    let textKept = 0;
    let priorityKept = 0;
    const priorityBudget = Math.max(last, 12);
    let textOmitted = 0;
    for (let i = outLines.length - 1; i >= 0; i--) {
      const ln = outLines[i];
      const isRef = refLineRe.test(ln);
      const isText = textRoleRe.test(ln) && !isRef;
      if (isText) {
        if (isPriorityPerceiveTextLine(ln) && priorityKept < priorityBudget) { reversed.push(ln); priorityKept++; }
        else if (textKept < last) { reversed.push(ln); textKept++; }
        else { textOmitted++; }
      } else {
        reversed.push(ln);
      }
    }
    outLines = reversed.reverse();
    if (textOmitted > 0) outLines.push(`  ... ${textOmitted} earlier text node(s) omitted (--last ${last})`);
  } else if (keepRefs) {
    // No size budget enforced here; the caller chooses when to truncate, but
    // when --keep-refs is set we mark lines so downstream truncation can
    // protect them. We currently return the lines as-is (the truncation that
    // hid refs was happening elsewhere; --keep-refs is now a soft flag agents
    // can use to assert "do not drop my @ref lines"). The flag is honoured
    // upstream by perceiveStr which avoids cutting ref lines.
  }

  return { treeLines: outLines, refNodeIds };
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

async function perceiveStr(cdp, sid, consoleBuf, exceptionBuf, refMap, lastPerceiveStore, opts = {}, refState = null) {
  const {
    diff: diffMode = false, selector: scopeSelector = null, exclude: excludeSelector = null,
    interactive: interactiveOnly = false, maxDepth = Infinity, cursorInteractive = false,
    keepRefs = false, last = null, sinceAction = false, diffBaseline = null,
    frameRef = null,
  } = opts;
  const frameContext = frameRef ? await resolveFrameRef(cdp, sid, frameRef) : null;
  const frame = frameContext?.frame || null;
  const frameExecutionContextId = frame ? await createFrameExecutionContext(cdp, sid, frame.id) : null;
  if (frame && (scopeSelector || excludeSelector)) {
    throw new Error('perceive --frame does not yet support --selector/--exclude; run frame-scoped perceive first, then use the listed @fN:M refs.');
  }
  // Get AX tree nodes and page metadata + layout map in parallel
  // Hoist DOM.getDocument so scope and exclude can share it
  const needsDocument = !frame && (scopeSelector || excludeSelector);
  const docRootPromise = needsDocument ? cdp.send('DOM.getDocument', {}, sid) : null;
  const axPromise = frame
    ? cdp.send('Accessibility.getFullAXTree', { frameId: frame.id }, sid)
    : scopeSelector
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
    evalStr(cdp, sid, perceivePageScript(cursorInteractive), false, frameExecutionContextId != null ? { contextId: frameExecutionContextId } : {})
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

  const activeRefMap = frame ? new Map() : refMap;
  const builtTree = buildPerceiveTree(axNodes, meta, activeRefMap, { maxDepth, interactiveOnly, keepRefs, last });
  let treeLines = builtTree.treeLines;
  const { refNodeIds } = builtTree;
  if (frame) storeFrameScopedRefs(refState, frame, frameContext.frames, activeRefMap);

  // === Batch-resolve @ref bounding rects (parallel, non-scrolling) ===
  // Now also returns `position` (computed style) so fixed/sticky elements get
  // a clear annotation — agents previously saw negative document-relative Ys
  // and assumed elements were off-screen.
  const refRects = new Map(); // ref number → {x, y, w, h, position?}
  const frameOffset = frame
    ? await frameViewportOffset(cdp, sid, {
        ...frame,
        frameRef: frame.ref,
        frameId: frame.id,
        frames: frameContext.frames,
      })
    : { x: 0, y: 0 };
  if (refNodeIds.length > 0) {
    const results = await Promise.allSettled(refNodeIds.map(async ({ ref, backendDOMNodeId }) => {
      const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: backendDOMNodeId }, sid);
      const res = await cdp.send('Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: `function() {
          const r = this.getBoundingClientRect();
          const cs = (typeof getComputedStyle === 'function') ? getComputedStyle(this) : null;
          return {
            x: Math.round(r.x),
            y: Math.round(r.y),
            w: Math.round(r.width),
            h: Math.round(r.height),
            position: cs ? cs.position : '',
          };
        }`,
        returnByValue: true,
      }, sid);
      const rect = res.result.value || {};
      if (frame) {
        rect.x = (Number(rect.x) || 0) + frameOffset.x;
        rect.y = (Number(rect.y) || 0) + frameOffset.y;
      }
      return { ref, rect };
    }));
    for (const r of results) {
      if (r.status === 'fulfilled') refRects.set(r.value.ref, r.value.rect);
    }
  }

  // Inject @ref coordinates into treeLines (top-level viewport CSS pixels; same space as clickxy)
  for (let i = 0; i < treeLines.length; i++) {
    const m = treeLines[i].match(/@(\d+)$/);
    if (m) {
      const rect = refRects.get(parseInt(m[1]));
      if (rect) treeLines[i] += `  ${formatRefRect(rect)}`;
    }
  }
  if (frame) treeLines = qualifyFrameRefsInLines(treeLines, frame.ref);

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
  if (frame) {
    const label = frame.name || '(anonymous)';
    const url = frame.url || frame.unreachableUrl || '(no url)';
    lines.push(`Frame: ${frame.ref} ${label} ${frame.id} ${url}`);
  }

  const scrollPct = meta.scrollMax > 0 ? Math.round(meta.scrollY / meta.scrollMax * 100) : 0;
  lines.push(`Viewport: ${meta.vw}×${meta.vh} | Scroll: ${meta.scrollY}/${meta.scrollMax > 0 ? meta.scrollMax : 0} (${scrollPct}%) | Focused: ${meta.focused}`);

  const countParts = Object.entries(meta.counts).map(([k, v]) => `${v} ${k}`);
  lines.push(`Interactive: ${countParts.length > 0 ? countParts.join(', ') : 'none'}`);

  const healthParts = [];
  if (errors > 0) healthParts.push(`${errors} error${errors > 1 ? 's' : ''}`);
  if (warnings > 0) healthParts.push(`${warnings} warning${warnings > 1 ? 's' : ''}`);
  if (exceptions > 0) healthParts.push(`${exceptions} exception${exceptions > 1 ? 's' : ''}`);
  lines.push(`Console: ${healthParts.length > 0 ? healthParts.join(', ') : 'clean'}`);
  // Coordinate hint — top-level viewport CSS pixels match clickxy/Input events.
  // Fixed/sticky elements include a "fixed"/"sticky" tag so agents do not
  // misread negative scroll-relative Ys as off-screen.
  lines.push(`Coords: top-level viewport CSS px (use clickxy with these values; fixed/sticky elements are tagged)`);

  lines.push('');
  lines.push(...treeLines);

  const output = lines.join('\n');

  const markPerceived = () => {
    lastPerceiveStore.output = output;
    if (frame) rememberFramePerceiveOutput(refState, frame.ref, output);
    // Mark refs as freshly assigned (clears 'navigation'/'daemon-start' state).
    if (refState && typeof refState === 'object') {
      refState.generation = (refState.generation || 0) + 1;
      refState.lastPerceiveAt = Date.now();
      refState.invalidationReason = null;
    }
  };

  if (sinceAction) {
    markPerceived();
    if (!diffBaseline) {
      return output + '\n\n(no action baseline available; run `perceive` before a mutating command, or use `perceive --diff` after a normal perceive.)';
    }
    return formatPerceiveDiffOutput(diffBaseline, output);
  }

  // Diff mode: compare with previous perceive output.
  if (diffMode && lastPerceiveStore.output) {
    const previousOutput = lastPerceiveStore.output;
    markPerceived();
    return formatPerceiveDiffOutput(previousOutput, output);
  }

  markPerceived();
  // Hint when perceive returns many interactive elements without exclude
  if (interactiveOnly && !excludeSelector && refNodeIds.length > 50) {
    return output + `\n\n(Hint: ${refNodeIds.length} interactive elements found — most may be sidebar/nav noise. Use \`perceive -x "nav, aside"\` to exclude, or \`perceive -s "main"\` to scope.)`;
  }
  return output;
}

function perceptionModelFromText(output, refState = {}) {
  const lines = String(output || '').split('\n');
  const pageMatch = (lines[0] || '').match(/^Page: (.*) — (.*)$/);
  const viewportMatch = (lines[1] || '').match(/^Viewport: (\d+)×(\d+) \| Scroll: (\d+)\/(\d+)/);
  const consoleLine = lines.find(line => line.startsWith('Console: ')) || 'Console: clean';
  const consoleHealth = { errors: 0, warnings: 0, exceptions: 0 };
  for (const [key, pattern] of [
    ['errors', /(\d+) errors?/],
    ['warnings', /(\d+) warnings?/],
    ['exceptions', /(\d+) exceptions?/],
  ]) {
    const match = consoleLine.match(pattern);
    if (match) consoleHealth[key] = Number(match[1]);
  }

  const nodes = [];
  for (const line of lines) {
    const refMatch = line.match(/\[(\w+)\]\s+(.+?)\s+(@f\d+:\d+|@\d+)(?:\s+\((-?\d+),(-?\d+) (\d+)×(\d+)(?:, [^)]+)?\))?$/);
    if (!refMatch) continue;
    const [, role, rawName, ref, x, y, width, height] = refMatch;
    const node = {
      ref,
      role,
      name: rawName.trim(),
    };
    if (x !== undefined) {
      node.rect = {
        x: Number(x),
        y: Number(y),
        width: Number(width),
        height: Number(height),
      };
    }
    nodes.push(node);
  }

  return createPerceptionModel({
    page: {
      title: pageMatch ? pageMatch[1] : '',
      url: pageMatch ? pageMatch[2] : '',
    },
    viewport: {
      width: viewportMatch ? Number(viewportMatch[1]) : 0,
      height: viewportMatch ? Number(viewportMatch[2]) : 0,
      scrollY: viewportMatch ? Number(viewportMatch[3]) : 0,
      scrollMax: viewportMatch ? Number(viewportMatch[4]) : 0,
    },
    consoleHealth,
    refs: { generation: refState.generation || 0 },
    nodes,
    limits: {
      truncated: output.includes('truncated'),
    },
  });
}

async function perceiveModel(cdp, sid, consoleBuf, exceptionBuf, refMap, lastPerceiveStore, opts = {}, refState = null) {
  const output = await perceiveStr(cdp, sid, consoleBuf, exceptionBuf, refMap, lastPerceiveStore, opts, refState);
  return perceptionModelFromText(output, refState || {});
}

// Element screenshot: targeted capture of a specific element by CSS selector or @ref
async function elshotStr(cdp, sid, selector, targetId, refMap, refState) {
  if (!selector) throw new Error('CSS selector or @ref required');
  if (isRef(selector)) {
    const r = await resolveRef(cdp, sid, refMap, selector, refState);
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

async function resolveSelectorNode(cdp, sid, selector) {
  if (!selector) throw new Error('CSS selector required');
  try { await cdp.send('DOM.enable', {}, sid); } catch {}
  const { root } = await cdp.send('DOM.getDocument', {}, sid);
  let result;
  try {
    result = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector }, sid);
  } catch (e) {
    throw new Error(`Invalid selector: ${selector}. ${e.message}`);
  }
  if (!result.nodeId) throw new Error('Element not found: ' + selector);
  const { object } = await cdp.send('DOM.resolveNode', { nodeId: result.nodeId }, sid);
  return object.objectId;
}

// JS-fallback click: uses HTMLElement.click() / dispatchEvent in the page
// instead of CDP Input.dispatchMouseEvent. Useful when the page intercepts
// real-pointer events with overlays, has misaligned hit testing under custom
// transforms, or when an MUD/game UI binds handlers only to synthetic clicks.
// This path is intentionally separate from clickStr — agents opt into it via
// `jsclick` or `click --js` so the default behaviour stays a realistic mouse
// dispatch.
async function jsClickStr(cdp, sid, selector, refMap, refState) {
  if (!selector) throw new Error('CSS selector or @ref required');
  const objectId = isRef(selector)
    ? await resolveRefNode(cdp, sid, refMap, selector, refState)
    : await resolveSelectorNode(cdp, sid, selector);
  try {
    const res = await cdp.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function() {
        this.scrollIntoView({ block: 'center', inline: 'center' });
        if (typeof this.click === 'function') this.click();
        else this.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        return { tag: this.tagName, text: (this.textContent || '').trim().substring(0, 80) };
      }`,
      returnByValue: true,
    }, sid);
    const r = res.result.value || {};
    return `JS-clicked <${r.tag || '?'}> "${r.text || ''}"${isRef(selector) ? ` (${selector})` : ''}`;
  } catch (e) {
    if (isTimeoutError(e, ['Runtime.callFunctionOn'])) {
      return `JS-click dispatched for ${selector}; success but click acknowledgement timed out after dispatch (${e.message}). Run \`perceive --diff\` or \`status\` to refresh observation.`;
    }
    throw e;
  }
}

// Click element by CSS selector or @ref
async function clickStr(cdp, sid, selector, refMap, refState) {
  if (!selector) throw new Error('CSS selector or @ref required');
  if (isRef(selector)) {
    const r = await resolveRef(cdp, sid, refMap, selector, refState);
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

// Punctuation → CDP code/keyCode map for unshifted US keys
const PUNCT_KEY_MAP = {
  '`': { code: 'Backquote',    keyCode: 192 },
  '-': { code: 'Minus',        keyCode: 189 },
  '=': { code: 'Equal',        keyCode: 187 },
  '[': { code: 'BracketLeft',  keyCode: 219 },
  ']': { code: 'BracketRight', keyCode: 221 },
  '\\':{ code: 'Backslash',    keyCode: 220 },
  ';': { code: 'Semicolon',    keyCode: 186 },
  "'": { code: 'Quote',        keyCode: 222 },
  ',': { code: 'Comma',        keyCode: 188 },
  '.': { code: 'Period',       keyCode: 190 },
  '/': { code: 'Slash',        keyCode: 191 },
};

// Shifted printable punctuation on a US keyboard. `key` stays the visible
// character, while code/keyCode identify the physical base key.
const SHIFTED_PUNCT_KEY_MAP = {
  '~': { code: 'Backquote',    keyCode: 192 },
  '_': { code: 'Minus',        keyCode: 189 },
  '+': { code: 'Equal',        keyCode: 187 },
  '{': { code: 'BracketLeft',  keyCode: 219 },
  '}': { code: 'BracketRight', keyCode: 221 },
  '|': { code: 'Backslash',    keyCode: 220 },
  ':': { code: 'Semicolon',    keyCode: 186 },
  '"': { code: 'Quote',        keyCode: 222 },
  '<': { code: 'Comma',        keyCode: 188 },
  '>': { code: 'Period',       keyCode: 190 },
  '?': { code: 'Slash',        keyCode: 191 },
  '!': { code: 'Digit1',       keyCode: 49 },
  '@': { code: 'Digit2',       keyCode: 50 },
  '#': { code: 'Digit3',       keyCode: 51 },
  '$': { code: 'Digit4',       keyCode: 52 },
  '%': { code: 'Digit5',       keyCode: 53 },
  '^': { code: 'Digit6',       keyCode: 54 },
  '&': { code: 'Digit7',       keyCode: 55 },
  '*': { code: 'Digit8',       keyCode: 56 },
  '(': { code: 'Digit9',       keyCode: 57 },
  ')': { code: 'Digit0',       keyCode: 48 },
};

// Resolve a press argument (named key or single-character) to a CDP descriptor.
// Returns { key, code, keyCode, shift? } or null when unsupported.
function keyForPress(input) {
  if (!input || typeof input !== 'string') return null;
  const named = KEY_MAP[input.toLowerCase()];
  if (named) return { ...named };
  if (input.length !== 1) return null;
  // a-z
  if (/^[a-z]$/.test(input)) {
    return { key: input, code: 'Key' + input.toUpperCase(), keyCode: input.toUpperCase().charCodeAt(0) };
  }
  // A-Z (shift-modified)
  if (/^[A-Z]$/.test(input)) {
    return { key: input, code: 'Key' + input, keyCode: input.charCodeAt(0), shift: true };
  }
  // 0-9
  if (/^[0-9]$/.test(input)) {
    return { key: input, code: 'Digit' + input, keyCode: input.charCodeAt(0) };
  }
  if (Object.prototype.hasOwnProperty.call(PUNCT_KEY_MAP, input)) {
    const p = PUNCT_KEY_MAP[input];
    return { key: input, code: p.code, keyCode: p.keyCode };
  }
  if (Object.prototype.hasOwnProperty.call(SHIFTED_PUNCT_KEY_MAP, input)) {
    const p = SHIFTED_PUNCT_KEY_MAP[input];
    return { key: input, code: p.code, keyCode: p.keyCode, shift: true };
  }
  return null;
}

async function pressStr(cdp, sid, keyName) {
  if (!keyName) throw new Error('Key name required (Enter, Tab, Escape, Backspace, Space, Arrow*, or single character a-z/A-Z/0-9/punctuation)');
  const mapped = keyForPress(keyName);
  if (!mapped) throw new Error(
    `Unknown key: ${keyName}. Supported: ${Object.keys(KEY_MAP).join(', ')}, single characters (a-z, A-Z, 0-9, common punctuation). Use \`type\` for multi-character text.`
  );
  const modifiers = mapped.shift ? 8 : 0;
  const base = {
    key: mapped.key,
    code: mapped.code,
    windowsVirtualKeyCode: mapped.keyCode,
    nativeVirtualKeyCode: mapped.keyCode,
    modifiers,
  };
  await cdp.send('Input.dispatchKeyEvent', { ...base, type: 'keyDown' }, sid);
  // For printable single characters, send a `char` event so the page receives input
  // (mirrors what real keyboards do for letter / digit / punctuation keys).
  if (mapped.key.length === 1 && mapped.code !== 'Space' && mapped.key !== ' ') {
    await cdp.send('Input.dispatchKeyEvent', { ...base, type: 'char', text: mapped.key, unmodifiedText: mapped.key }, sid);
  }
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

async function hoverStr(cdp, sid, selector, refMap, refState) {
  if (!selector) throw new Error('CSS selector or @ref required');
  if (isRef(selector)) {
    const r = await resolveRef(cdp, sid, refMap, selector, refState);
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

async function waitForStr(cdp, sid, args, refMap, refState) {
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

  // --any-of: regex-OR text wait, returns the first matching alternative.
  if (args[0] === '--any-of') {
    const pattern = args[1];
    if (!pattern) throw new Error('Pattern required after --any-of (e.g. "win|lose|escape")');
    let scope = 'body';
    let timeoutMs = 30000;
    for (let i = 2; i < args.length; i++) {
      if (args[i] === '--scope' || args[i] === '-s') scope = args[++i];
      else if (/^\d+$/.test(args[i])) timeoutMs = parseInt(args[i]);
    }
    const alternatives = pattern.split('|').filter(Boolean);
    if (alternatives.length === 0) throw new Error('--any-of pattern must contain at least one alternative');
    const altsJson = JSON.stringify(alternatives);
    return poll(
      `(function() {
        const el = document.querySelector(${JSON.stringify(scope)});
        if (!el) return null;
        const t = el.innerText || el.textContent || '';
        const alts = ${altsJson};
        for (const a of alts) {
          const idx = t.indexOf(a);
          if (idx !== -1) return { matched: a, snippet: t.substring(Math.max(0, idx - 20), idx + a.length + 60).trim(), len: t.length };
        }
        return null;
      })()`,
      r => `Found "${r.matched}" (page has ${r.len} chars): "...${r.snippet}..."`,
      400, timeoutMs, `any of [${alternatives.join(', ')}]`
    );
  }

  // --selector-stable: wait for selector's textContent to stop changing for stableMs.
  if (args[0] === '--selector-stable') {
    const selector = args[1];
    if (!selector) throw new Error('Selector required after --selector-stable');
    const stableMs = parseInt(args[2]) || 3000;
    const timeoutMs = parseInt(args[3]) || 30000;
    const deadline = Date.now() + Math.min(Math.max(timeoutMs, 500), 300000);
    let lastText = null;
    let stableSince = null;
    while (Date.now() < deadline) {
      const raw = await evalStr(cdp, sid, `(function() {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const t = el.innerText || el.textContent || '';
        return JSON.stringify({ len: t.length, hash: t });
      })()`);
      if (raw === 'null' || raw === '') {
        // selector not present yet — keep polling
        lastText = null; stableSince = null;
        await sleep(300);
        continue;
      }
      const cur = JSON.parse(raw);
      if (lastText !== null && cur.hash === lastText) {
        if (stableSince == null) stableSince = Date.now();
        if (Date.now() - stableSince >= stableMs) {
          return `Selector "${selector}" stable for ${stableMs}ms (${cur.len} chars)`;
        }
      } else {
        lastText = cur.hash;
        stableSince = null;
      }
      await sleep(Math.min(300, stableMs / 4));
    }
    throw new Error(`Timeout: "${selector}" did not stabilise within ${timeoutMs}ms`);
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
      if (!backendNodeId) throw new Error(formatUnknownRefError(selector, refState || {}));
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

function formatInputTextPreview(text) {
  return `${text.substring(0, 40)}${text.length > 40 ? '...' : ''}`;
}

async function fillReactStr(cdp, sid, selector, text, refMap, refState) {
  const objectId = isRef(selector)
    ? await resolveRefNode(cdp, sid, refMap, selector, refState)
    : await resolveSelectorNode(cdp, sid, selector);
  const res = await cdp.send('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: `function(value) {
      const el = this;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.focus();
      if (el.isContentEditable) {
        el.textContent = value;
      } else {
        const proto = el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : el instanceof HTMLSelectElement
            ? HTMLSelectElement.prototype
            : HTMLInputElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(proto, 'value')
          || Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'value');
        if (descriptor && descriptor.set) descriptor.set.call(el, value);
        else el.value = value;
      }
      const inputEvent = typeof InputEvent === 'function'
        ? new InputEvent('input', { bubbles: true, cancelable: true, composed: true, inputType: 'insertText', data: value })
        : new Event('input', { bubbles: true, cancelable: true });
      el.dispatchEvent(inputEvent);
      el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
      return { tag: el.tagName, value: el.isContentEditable ? el.textContent : el.value };
    }`,
    arguments: [{ value: text }],
    returnByValue: true,
  }, sid);
  const tag = res.result.value?.tag || '?';
  return `React-filled ${isRef(selector) ? selector : `<${tag}>`} with "${formatInputTextPreview(text)}"`;
}

async function fillStr(cdp, sid, selector, text, refMap, refState, opts = {}) {
  if (!selector) throw new Error('CSS selector or @ref required');
  if (text == null) throw new Error('Text required');
  if (opts.react) return fillReactStr(cdp, sid, selector, text, refMap, refState);
  if (isRef(selector)) {
    const objectId = await resolveRefNode(cdp, sid, refMap, selector, refState);
    await cdp.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function() { this.scrollIntoView({block:'center'}); this.focus(); this.value=''; this.dispatchEvent(new Event('input',{bubbles:true})); }`,
      returnByValue: true,
    }, sid);
    await cdp.send('Input.insertText', { text }, sid);
    return `Filled ${selector} with "${formatInputTextPreview(text)}"`;
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
  return `Filled <${r.tag}> with "${formatInputTextPreview(text)}"`;
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

// Checkpoint/restore: serialize the minimum browser state needed to resume a
// real-page exploration flow without pretending to snapshot the whole browser.
function checkpointPageScript() {
  return `(function() {
    function dumpStorage(storage) {
      const out = {};
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        out[key] = storage.getItem(key);
      }
      return out;
    }
    return JSON.stringify({
      url: location.href,
      title: document.title,
      origin: location.origin,
      localStorage: dumpStorage(localStorage),
      sessionStorage: dumpStorage(sessionStorage)
    });
  })()`;
}

function sanitizeCheckpointCookies(cookies = []) {
  return cookies.map(cookie => {
    const out = {};
    for (const key of ['name', 'value', 'domain', 'path', 'secure', 'httpOnly', 'sameSite']) {
      if (cookie[key] !== undefined) out[key] = cookie[key];
    }
    if (Number.isFinite(cookie.expires) && cookie.expires > 0) out.expires = cookie.expires;
    return out;
  }).filter(cookie => cookie.name);
}

async function checkpointModel(cdp, sid, { now = Date.now() } = {}) {
  const raw = await evalStr(cdp, sid, checkpointPageScript());
  let pageState;
  try {
    pageState = JSON.parse(raw);
  } catch (e) {
    throw new Error(`checkpoint: failed to read page state (${e.message})`);
  }
  let cookies = [];
  try {
    const res = await cdp.send('Network.getCookies', {}, sid);
    cookies = sanitizeCheckpointCookies(res.cookies || []);
  } catch {}
  return {
    schema: 'chrome-cdp-ex.checkpoint.v1',
    ts: now,
    page: {
      url: pageState.url || '',
      title: pageState.title || '',
      origin: pageState.origin || '',
    },
    storage: {
      localStorage: pageState.localStorage || {},
      sessionStorage: pageState.sessionStorage || {},
    },
    cookies,
  };
}

async function checkpointStr(cdp, sid, { format = 'text', now = Date.now() } = {}) {
  const model = await checkpointModel(cdp, sid, { now });
  if (format === 'json') return formatJson(model);
  const localCount = Object.keys(model.storage.localStorage || {}).length;
  const sessionCount = Object.keys(model.storage.sessionStorage || {}).length;
  return [
    'Checkpoint captured',
    `URL: ${model.page.url}`,
    `Storage: local ${localCount}, session ${sessionCount}`,
    `Cookies: ${model.cookies.length}`,
    'Next: save `checkpoint --format json` output and restore with `restore --file <path>`.',
  ].join('\n');
}

function parseCheckpointArtifact(raw) {
  let artifact;
  try {
    artifact = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) {
    throw new Error(`restore: invalid checkpoint JSON (${e.message})`);
  }
  if (!artifact || typeof artifact !== 'object') throw new Error('restore: checkpoint artifact must be a JSON object');
  if (artifact.schema !== 'chrome-cdp-ex.checkpoint.v1') {
    throw new Error(`restore: unsupported checkpoint schema ${artifact.schema || '(missing)'}`);
  }
  if (!artifact.page?.url) throw new Error('restore: checkpoint.page.url is required');
  validateUrl(artifact.page.url);
  return artifact;
}

function parseRestoreArgs(args, { reader = readFileSync } = {}) {
  const tokens = (args || []).filter(a => a !== undefined && a !== null);
  const positional = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '--json') {
      const raw = tokens.slice(i + 1).join(' ').trim();
      if (!raw) throw new Error('restore --json requires a checkpoint JSON payload');
      return { artifact: parseCheckpointArtifact(raw), source: 'inline JSON' };
    }
    if (token === '--file' || token === '-f') {
      const filePath = tokens[++i];
      if (!filePath) throw new Error('restore --file requires a checkpoint JSON path');
      return { artifact: parseCheckpointArtifact(reader(filePath, 'utf8')), source: filePath };
    }
    positional.push(token);
  }
  const raw = positional.join(' ').trim();
  if (!raw) throw new Error('restore requires --file <path> or --json <checkpoint-json>');
  if (raw.startsWith('{')) return { artifact: parseCheckpointArtifact(raw), source: 'inline JSON' };
  return { artifact: parseCheckpointArtifact(reader(positional[0], 'utf8')), source: positional[0] };
}

function redactRestoreCommandArgs(args = []) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    out.push(arg);
    if (arg === '--json') {
      out.push('[checkpoint-json-redacted]');
      break;
    }
    if (arg === '--file' || arg === '-f') {
      if (args[i + 1]) out.push(args[++i]);
    }
  }
  return out.length ? out : ['restore'];
}

function checkpointCookieToSetCookieParams(cookie, url) {
  const params = { url };
  for (const key of ['name', 'value', 'domain', 'path', 'secure', 'httpOnly', 'sameSite', 'expires']) {
    if (cookie[key] !== undefined) params[key] = cookie[key];
  }
  return params;
}

function restoreStorageScript(storage = {}) {
  const local = storage.localStorage || {};
  const session = storage.sessionStorage || {};
  return `(function() {
    const localItems = ${JSON.stringify(local)};
    const sessionItems = ${JSON.stringify(session)};
    localStorage.clear();
    for (const [key, value] of Object.entries(localItems)) localStorage.setItem(key, value);
    sessionStorage.clear();
    for (const [key, value] of Object.entries(sessionItems)) sessionStorage.setItem(key, value);
    return JSON.stringify({ localStorage: Object.keys(localItems).length, sessionStorage: Object.keys(sessionItems).length });
  })()`;
}

async function navigateForRestore(cdp, sid, url) {
  await cdp.send('Page.enable', {}, sid).catch(() => {});
  let loadEvent = cdp.waitForEvent('Page.loadEventFired', NAVIGATION_TIMEOUT);
  try {
    const nav = await cdp.send('Page.navigate', { url }, sid, 5000);
    if (nav.errorText) {
      loadEvent.cancel();
      throw new Error(nav.errorText);
    }
    if (nav.loaderId) {
      await loadEvent.promise;
    } else {
      loadEvent.cancel();
    }
    return 'Page.navigate';
  } catch (e) {
    loadEvent.cancel();
    if (!isTimeoutError(e, ['Page.navigate'])) throw e;
    loadEvent = cdp.waitForEvent('Page.loadEventFired', NAVIGATION_TIMEOUT);
    await evalStr(cdp, sid, `(function() { location.assign(${JSON.stringify(url)}); return 'navigating'; })()`);
    await loadEvent.promise.catch(() => {});
    return 'location.assign fallback';
  }
}

async function restoreCheckpointStr(cdp, sid, args) {
  const { artifact } = parseRestoreArgs(args);
  const url = artifact.page.url;
  const cookies = sanitizeCheckpointCookies(artifact.cookies || []);
  let cookieSet = 0;
  for (const cookie of cookies) {
    const result = await cdp.send('Network.setCookie', checkpointCookieToSetCookieParams(cookie, url), sid);
    if (result && result.success === false) throw new Error(`restore: failed to set cookie ${cookie.name}`);
    cookieSet++;
  }

  let currentUrl = null;
  try { currentUrl = await evalStr(cdp, sid, 'location.href'); } catch {}
  const navigationMethod = currentUrl === url
    ? 'already at checkpoint URL'
    : await navigateForRestore(cdp, sid, url);
  await evalStr(cdp, sid, restoreStorageScript(artifact.storage || {}));

  const localCount = Object.keys(artifact.storage?.localStorage || {}).length;
  const sessionCount = Object.keys(artifact.storage?.sessionStorage || {}).length;
  return [
    `Restored checkpoint: ${url}`,
    `Navigation: ${navigationMethod}`,
    `Storage: local ${localCount}, session ${sessionCount}; cookies: ${cookieSet}`,
    'Refs were invalidated; run `perceive` before using @refs again.',
  ].join('\n');
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
  if (entries.length === 0) return 'No network requests captured (tracking action-relevant requests; static assets are skipped)';
  const lines = [`Network requests (${entries.length}):`];
  for (const e of entries) {
    const ago = Math.round((Date.now() - e.ts) / 1000);
    const size = e.size > 1024 ? `${(e.size / 1024).toFixed(1)}KB` : `${e.size}B`;
    lines.push(`  ${e.method} ${e.url} → ${e.status} (${e.duration}ms, ${size}) ${ago}s ago`);
  }
  return lines.join('\n');
}

function clearObservationBuffers({ consoleBuf, exceptionBuf, navBuf, netReqBuf, pendingReqs, lastReadSeq }) {
  consoleBuf?.clear();
  exceptionBuf?.clear();
  navBuf?.clear();
  netReqBuf?.clear();
  pendingReqs?.clear();
  if (lastReadSeq) {
    lastReadSeq.console = consoleBuf?.latest?.() || 0;
    lastReadSeq.exception = exceptionBuf?.latest?.() || 0;
  }
}

async function waitForActionNetworkQuiet(pendingReqs, { quietMs = 150, timeoutMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let quietSince = pendingReqs?.size ? 0 : Date.now();
  while (Date.now() < deadline) {
    if (pendingReqs?.size) {
      quietSince = 0;
    } else {
      if (!quietSince) quietSince = Date.now();
      if (Date.now() - quietSince >= quietMs) return true;
    }
    await sleep(50);
  }
  return !pendingReqs?.size;
}

function appendPendingActionNetworkEntries(pendingReqs, netReqBuf, sinceTs, { now = Date.now() } = {}) {
  if (!pendingReqs || !netReqBuf) return 0;
  let count = 0;
  for (const req of pendingReqs.values()) {
    if (!req || req.actionEvidenceReported || req.ts < sinceTs) continue;
    req.actionEvidenceReported = true;
    netReqBuf.push({
      method: req.method,
      url: req.url,
      status: 'pending',
      type: req.type,
      duration: now - req.ts,
      size: 0,
      pending: true,
      ts: req.ts,
    });
    count += 1;
  }
  return count;
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
// Parse `text` arguments. Supports:
//   text                          → full body
//   text "main, [role=main]"      → fallback chain (try first, then next…)
//   text --auto                   → auto-pick main content (excludes nav/aside/script/style)
//   text --root auto              → scope extraction to #root / [data-reactroot] / main / body
//   text --auto --exclude "nav,.sidebar"  → custom extra exclusions
function parseTextArgs(args) {
  const opts = { selectors: [], auto: false, exclude: null, root: null };
  const tokens = Array.isArray(args) ? args.filter(a => a !== undefined && a !== null) : [];
  for (let i = 0; i < tokens.length; i++) {
    const a = tokens[i];
    if (a === '--auto') opts.auto = true;
    else if (a === '--root') opts.root = tokens[++i] || 'auto';
    else if (a === '--exclude' || a === '-x') opts.exclude = tokens[++i];
    else if (typeof a === 'string') {
      // Comma list = fallback chain (try each until one matches)
      const parts = a.split(',').map(s => s.trim()).filter(Boolean);
      if (parts.length === 0) continue;
      opts.selectors.push(...parts);
    }
  }
  return opts;
}

function textPageScript(opts) {
  const { selectors = [], auto = false, exclude = null, root = null } = opts || {};
  const extraExcludes = exclude ? exclude.split(',').map(s => s.trim()).filter(Boolean) : [];
  return `(function() {
    const STRIP = ['script','style','noscript','svg','link','meta','template'];
    const AUTO_NOISE = ['nav','aside','footer','[role="navigation"]','[role="complementary"]','[role="contentinfo"]'];
    const ROOT_CANDIDATES = ['#root', '[data-reactroot]', 'main', 'body'];
    const AUTO_CANDIDATES = ['main', '[role="main"]', 'article', '#root main', '#app main', '#root', '[data-reactroot]', '#app', 'body'];
    const EXTRA_EXCLUDES = ${JSON.stringify(extraExcludes)};
    function safeMatches(el, sel) { try { return !!el?.matches?.(sel); } catch { return false; } }
    function safeQuery(root, sel) { try { return root?.querySelector?.(sel) || null; } catch { return null; } }
    function selectorFallbacks(sel) {
      const s = String(sel || '').trim();
      if (s.toLowerCase() === 'header') {
        return ['header', '[role="banner"]', '[data-testid*="header" i]', '[class*="header" i]', '[id*="header" i]', 'h1', 'h2'];
      }
      return [s];
    }
    function pickRoot() {
      const setting = ${JSON.stringify(root || 'auto')};
      if (!setting || setting === 'auto' || setting === 'default') {
        for (const sel of ROOT_CANDIDATES) {
          const found = safeQuery(document, sel);
          if (found) return { el: found, sel };
        }
        return { el: document.body || document.documentElement, sel: 'body' };
      }
      const found = safeQuery(document, setting);
      return found ? { el: found, sel: setting } : { el: null, sel: setting };
    }
    function shouldSkipElement(el, rootEl, skipSelectors) {
      if (!el || el === rootEl) return false;
      if (el.hidden || el.getAttribute('aria-hidden') === 'true') return true;
      for (const sel of skipSelectors) if (safeMatches(el, sel)) return true;
      const style = window.getComputedStyle(el);
      return style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse';
    }
    function clean(rootEl, stripNoise) {
      if (!rootEl) return '';
      const skipSelectors = STRIP.concat(EXTRA_EXCLUDES, stripNoise ? AUTO_NOISE : []);
      const parts = [];
      const blockish = new Set(['ADDRESS','ARTICLE','ASIDE','BLOCKQUOTE','BR','DIV','DL','FIELDSET','FIGCAPTION','FIGURE','FOOTER','FORM','H1','H2','H3','H4','H5','H6','HEADER','HR','LI','MAIN','NAV','OL','P','PRE','SECTION','TABLE','TR','UL']);
      function walk(node) {
        if (!node) return;
        if (node.nodeType === Node.TEXT_NODE) {
          parts.push(node.nodeValue || '');
          return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_NODE) return;
        const el = node.nodeType === Node.ELEMENT_NODE ? node : null;
        if (el && shouldSkipElement(el, rootEl, skipSelectors)) return;
        if (el?.tagName === 'BR') { parts.push('\\n'); return; }
        for (const child of node.childNodes) walk(child);
        if (el && blockish.has(el.tagName)) parts.push('\\n');
      }
      walk(rootEl);
      return parts.join('')
        .replace(/[ \\t\\f\\v]+/g, ' ')
        .replace(/ *\\n */g, '\\n')
        .replace(/(\\n\\s*){3,}/g, '\\n\\n')
        .trim();
    }
    function findWithin(scope, sel, tried) {
      for (const candidate of selectorFallbacks(sel)) {
        tried.push(candidate);
        if (safeMatches(scope, candidate)) return { el: scope, sel: candidate };
        const found = safeQuery(scope, candidate);
        if (found) return { el: found, sel: candidate === sel ? candidate : candidate + ' (fallback for ' + sel + ')' };
      }
      return null;
    }
    const tried = [];
    const rootInfo = pickRoot();
    if (!rootInfo.el) return JSON.stringify({ ok: false, tried: ['--root ' + rootInfo.sel] });
    const scope = rootInfo.el;
    const selectors = ${JSON.stringify(selectors)};
    for (const sel of selectors) {
      const found = findWithin(scope, sel, tried);
      if (found) return JSON.stringify({ ok: true, sel: found.sel, root: rootInfo.sel, text: clean(found.el, false) });
    }
    if (${auto ? 'true' : 'false'}) {
      for (const sel of AUTO_CANDIDATES) {
        const found = findWithin(scope, sel, tried);
        if (!found) continue;
        const text = clean(found.el, true);
        if (text.length > 0) return JSON.stringify({ ok: true, sel: found.sel + ' (auto)', root: rootInfo.sel, text });
        tried.push(sel + ' (auto)');
      }
    }
    if (selectors.length === 0 && !${auto ? 'true' : 'false'}) {
      return JSON.stringify({ ok: true, sel: rootInfo.sel, root: rootInfo.sel, text: clean(scope, false) });
    }
    return JSON.stringify({ ok: false, tried });
  })()`;
}

async function textStr(cdp, sid, args) {
  // Support legacy single-string call: textStr(cdp, sid, 'main') — wrap into args[]
  let optsArgs = args;
  if (typeof args === 'string' || args == null) optsArgs = args ? [args] : [];
  else if (!Array.isArray(args)) optsArgs = [];
  const opts = parseTextArgs(optsArgs);
  const result = await evalStr(cdp, sid, textPageScript(opts));
  let parsed;
  try { parsed = JSON.parse(result); }
  catch { return result; }
  if (!parsed.ok) {
    const tried = (parsed.tried || []).join(', ') || '(no candidates)';
    throw new Error(`text: no element matched. Tried: ${tried}. Try \`text <target> --auto\` or \`text <target> "main, [role=main], body"\`.`);
  }
  const out = parsed.text || '';
  // Hint when no scope was given and text is large.
  const noScope = opts.selectors.length === 0 && !opts.auto;
  if (noScope && out.length > 2000) {
    return out + '\n\n(Hint: output is large — use `text <target> --auto` or `text <target> "main"` / `text <target> "main, [role=main], #app .main"` to scope to a specific area)';
  }
  return out;
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

// --- Inject: live CSS/JS injection with tracking ---
async function injectStr(cdp, sid, args) {
  const type = args[0];
  const content = args.slice(1).join(' ');

  if (type === '--remove') {
    const selector = content
      ? `[data-cdp-inject="${content}"]`
      : '[data-cdp-inject]';
    return evalStr(cdp, sid, `(() => {
      const els = document.querySelectorAll(${JSON.stringify(selector)});
      els.forEach(el => el.remove());
      return els.length + ' element(s) removed';
    })()`);
  }

  if (type === '--css') {
    if (!content) throw new Error('CSS text required: inject --css "body { background: red }"');
    return evalStr(cdp, sid, `(() => {
      const id = 'inject-' + (document.querySelectorAll('[data-cdp-inject]').length + 1);
      const s = document.createElement('style');
      s.setAttribute('data-cdp-inject', id);
      s.textContent = ${JSON.stringify(content)};
      document.head.appendChild(s);
      return id;
    })()`);
  }

  if (type === '--css-file') {
    if (!content) throw new Error('URL required: inject --css-file https://example.com/style.css');
    validateUrl(content);
    return evalStr(cdp, sid, `new Promise((resolve, reject) => {
      const id = 'inject-' + (document.querySelectorAll('[data-cdp-inject]').length + 1);
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = ${JSON.stringify(content)};
      link.setAttribute('data-cdp-inject', id);
      link.onload = () => resolve(id);
      link.onerror = () => reject(new Error('Failed to load stylesheet: ' + ${JSON.stringify(content)}));
      document.head.appendChild(link);
    })`);
  }

  if (type === '--js-file') {
    if (!content) throw new Error('URL required: inject --js-file https://example.com/lib.js');
    validateUrl(content);
    return evalStr(cdp, sid, `new Promise((resolve, reject) => {
      const id = 'inject-' + (document.querySelectorAll('[data-cdp-inject]').length + 1);
      const s = document.createElement('script');
      s.src = ${JSON.stringify(content)};
      s.setAttribute('data-cdp-inject', id);
      s.onload = () => resolve(id);
      s.onerror = () => reject(new Error('Failed to load script: ' + ${JSON.stringify(content)}));
      document.head.appendChild(s);
    })`);
  }

  throw new Error('inject requires --css, --css-file, --js-file, or --remove\n  inject --css "body { color: red }"   inject inline CSS\n  inject --css-file <url>              load external stylesheet\n  inject --js-file <url>               load external script\n  inject --remove [id]                 remove injected element(s)');
}

// --- Record: short timeline capture around actions / waits ---
function formatRecordEvent(e, startTs) {
  const rel = Math.max(0, e.ts - startTs).toString().padStart(5, ' ');
  if (e.kind === 'dom') return `  +${rel}ms DOM ${e.summary}`;
  if (e.kind === 'console') return `  +${rel}ms console.${e.level}: ${e.text}${e.loc ? ' (' + e.loc + ')' : ''}`;
  if (e.kind === 'exception') return `  +${rel}ms exception: ${e.msg}${e.loc ? ' (' + e.loc + ')' : ''}`;
  if (e.kind === 'network') return `  +${rel}ms ${e.method} ${e.url} → ${e.status} (${e.duration}ms)`;
  if (e.kind === 'navigation') return `  +${rel}ms navigation ${e.url}`;
  if (e.kind === 'action') return `  +${rel}ms action ${e.summary}`;
  return `  +${rel}ms ${e.kind || 'event'} ${e.summary || ''}`.trimEnd();
}

function parseRecordArgs(args) {
  const opts = { durationMs: 1000, until: null, action: null, actionArgs: [], explicitDuration: false };
  const setUntil = (val) => {
    const v = (val || '').toLowerCase();
    if (!['dom stable', 'network idle', 'auto settle'].includes(v)) throw new Error('record --until supports "dom stable" or "network idle"');
    opts.until = v;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--action') {
      opts.action = args[++i];
      if (!opts.action) throw new Error('record --action requires an action command (click, press, fill, select, type, scroll, nav)');
      const rest = args.slice(i + 1);
      const actionArgs = [];
      for (let j = 0; j < rest.length; j++) {
        const a = rest[j];
        if (a === '--until') { setUntil(rest[++j]); continue; }
        if (/^\d+$/.test(a) && j === rest.length - 1) {
          opts.durationMs = Math.min(Math.max(parseInt(a), 100), 30000);
          opts.explicitDuration = true;
          continue;
        }
        actionArgs.push(a);
      }
      opts.actionArgs = actionArgs;
      break;
    }
    if (arg === '--until') { setUntil(args[++i]); continue; }
    if (/^\d+$/.test(arg)) {
      opts.durationMs = Math.min(Math.max(parseInt(arg), 100), 30000);
      opts.explicitDuration = true;
      continue;
    }
    throw new Error(`Unknown record argument: ${arg}`);
  }
  // --action with no explicit duration and no --until: auto-settle (DOM/network quiet)
  // Cap: 5s for DOM-only, 10s if network activity observed.
  if (opts.action && !opts.until && !opts.explicitDuration) {
    opts.until = 'auto settle';
    opts.durationMs = 10000;
  } else if (opts.until && !opts.explicitDuration) {
    opts.durationMs = 30000;
  }
  return opts;
}

async function collectDomMutationSummary(cdp, sid) {
  const raw = await evalStr(cdp, sid, `(function() {
    const bucket = window.__cdp_record_mutations || [];
    window.__cdp_record_mutations = [];
    const totals = { added: 0, removed: 0, attributes: 0, characterData: 0 };
    const labels = [];
    for (const m of bucket) {
      if (m.type === 'childList') { totals.added += m.added || 0; totals.removed += m.removed || 0; }
      else if (m.type === 'attributes') totals.attributes += 1;
      else if (m.type === 'characterData') totals.characterData += 1;
      if (m.label && labels.length < 4) labels.push(m.label);
    }
    return JSON.stringify({ totals, labels, count: bucket.length });
  })()`);
  const parsed = JSON.parse(raw || '{}');
  if (!parsed.count) return null;
  const parts = [];
  if (parsed.totals.added) parts.push(`${parsed.totals.added} added`);
  if (parsed.totals.removed) parts.push(`${parsed.totals.removed} removed`);
  if (parsed.totals.attributes) parts.push(`${parsed.totals.attributes} attr`);
  if (parsed.totals.characterData) parts.push(`${parsed.totals.characterData} text`);
  const labelText = parsed.labels?.length ? ` [${parsed.labels.join('; ')}]` : '';
  return `${parts.join(', ') || parsed.count + ' mutation(s)'}${labelText}`;
}

async function installRecordMutationObserver(cdp, sid) {
  await evalStr(cdp, sid, `(function() {
    if (window.__cdp_record_observer) { window.__cdp_record_mutations = []; return 'already'; }
    window.__cdp_record_mutations = [];
    const label = (node) => {
      if (!node || node.nodeType !== 1) return '';
      const el = node;
      const id = el.id ? '#' + el.id : '';
      const cls = typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\\s+/).slice(0,2).join('.') : '';
      const text = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40);
      return '<' + el.tagName.toLowerCase() + id + cls + '>' + (text ? ' "' + text + '"' : '');
    };
    window.__cdp_record_observer = new MutationObserver((mutations) => {
      const out = window.__cdp_record_mutations || (window.__cdp_record_mutations = []);
      for (const m of mutations) {
        out.push({
          type: m.type,
          added: m.addedNodes ? m.addedNodes.length : 0,
          removed: m.removedNodes ? m.removedNodes.length : 0,
          attr: m.attributeName || '',
          label: label(m.target) || label(m.addedNodes && m.addedNodes[0]) || label(m.removedNodes && m.removedNodes[0]),
        });
      }
      if (out.length > 200) out.splice(0, out.length - 200);
    });
    window.__cdp_record_observer.observe(document.documentElement || document, { subtree: true, childList: true, attributes: true, characterData: true });
    return 'installed';
  })()`);
}

async function recordStr(cdp, sid, args, refs) {
  const opts = parseRecordArgs(args);
  const startTs = Date.now();
  const events = [];
  const offConsole = cdp.onEvent?.('Runtime.consoleAPICalled', (params) => {
    const text = (params.args || []).map(a => a.value ?? a.description ?? JSON.stringify(a)).join(' ');
    events.push({ kind: 'console', level: params.type || 'log', text, ts: Date.now() });
  });
  const offException = cdp.onEvent?.('Runtime.exceptionThrown', (params) => {
    events.push({ kind: 'exception', msg: params.exceptionDetails?.exception?.description || params.exceptionDetails?.text || 'Unknown error', ts: Date.now() });
  });
  const pending = new Map();
  const offReq = cdp.onEvent?.('Network.requestWillBeSent', (params) => {
    if (['XHR','Fetch','Document'].includes(params.type)) pending.set(params.requestId, { method: params.request.method, url: params.request.url.substring(0, 160), ts: Date.now() });
  });
  const offRes = cdp.onEvent?.('Network.responseReceived', (params) => {
    const req = pending.get(params.requestId);
    if (!req) return;
    pending.delete(params.requestId);
    events.push({ kind: 'network', ...req, status: params.response.status, duration: Date.now() - req.ts, ts: Date.now() });
  });
  const offNav = cdp.onEvent?.('Page.frameNavigated', (params) => {
    if (!params.frame?.parentId) events.push({ kind: 'navigation', url: params.frame?.url || '', ts: Date.now() });
  });

  // Wrap setup/action/loop in try/finally so the temporary listeners are
  // always detached — including when an action throws (unsupported action,
  // click/fill failure, CDP error). Leaking listeners would pollute future
  // record/timeline runs on the same daemon.
  try {
    try { await cdp.send('Runtime.enable', {}, sid); } catch {}
    try { await cdp.send('Page.enable', {}, sid); } catch {}
    try { await cdp.send('DOM.enable', {}, sid); } catch {}
    try { await cdp.send('Network.enable', {}, sid); } catch {}
    await installRecordMutationObserver(cdp, sid);

    let actionText = null;
    if (opts.action) {
      if (opts.action === 'click') actionText = await clickStr(cdp, sid, opts.actionArgs[0], refs);
      else if (opts.action === 'press') actionText = await pressStr(cdp, sid, opts.actionArgs[0]);
      else if (opts.action === 'fill') actionText = await fillStr(cdp, sid, opts.actionArgs[0], opts.actionArgs.slice(1).join(' '), refs);
      else if (opts.action === 'select') actionText = await selectStr(cdp, sid, opts.actionArgs[0], opts.actionArgs[1]);
      else if (opts.action === 'type') actionText = await typeStr(cdp, sid, opts.actionArgs.join(' '));
      else if (opts.action === 'scroll') actionText = await scrollStr(cdp, sid, opts.actionArgs[0], opts.actionArgs[1]);
      else if (opts.action === 'nav' || opts.action === 'navigate') actionText = await navStr(cdp, sid, opts.actionArgs[0]);
      else throw new Error(`record --action does not support: ${opts.action}`);
      events.push({ kind: 'action', summary: actionText.split('\n')[0], ts: Date.now() });
    }

    let quietSince = Date.now();
    let networkSeen = false;
    const deadline = Date.now() + opts.durationMs;
    // Auto-settle cap: 5s if no network activity has been observed yet, else 10s.
    const autoCap = () => Date.now() - startTs >= (networkSeen ? 10000 : 5000);
    while (Date.now() < deadline) {
      await sleep(Math.min(100, deadline - Date.now()));
      const domSummary = await collectDomMutationSummary(cdp, sid);
      if (domSummary) { events.push({ kind: 'dom', summary: domSummary, ts: Date.now() }); quietSince = Date.now(); }
      if (pending.size > 0 || events.some(e => e.kind === 'network')) networkSeen = true;
      if (opts.until === 'network idle' && pending.size === 0 && Date.now() - quietSince >= 500) break;
      if (opts.until === 'dom stable' && Date.now() - quietSince >= 500) break;
      if (opts.until === 'auto settle' && pending.size === 0 && Date.now() - quietSince >= 500) break;
      if (opts.until === 'auto settle' && autoCap()) break;
      if (!opts.until && Date.now() >= deadline) break;
    }

    const lines = [`Record timeline (${Date.now() - startTs}ms${opts.action ? `, action: ${opts.action}` : ''}${opts.until ? `, until: ${opts.until}` : ''})`];
    if (actionText) lines.push(`Action: ${actionText.split('\n')[0]}`);
    if (events.length === 0) lines.push('  (no DOM, console, exception, navigation, or XHR/Fetch/Document network events observed)');
    else for (const e of events.sort((a,b) => a.ts - b.ts)) lines.push(formatRecordEvent(e, startTs));
    return lines.join('\n');
  } finally {
    offConsole?.();
    offException?.();
    offReq?.();
    offRes?.();
    offNav?.();
  }
}

// --- Cascade: CSS origin tracing via CSS.getMatchedStylesForNode ---
const INHERITABLE_PROPS = new Set([
  'color', 'font-family', 'font-size', 'font-weight', 'font-style',
  'line-height', 'letter-spacing', 'text-align', 'text-indent',
  'text-transform', 'white-space', 'word-spacing', 'visibility',
  'cursor', 'direction', 'list-style',
]);

// Strip Vite/CSS Module query suffixes (?vue&type=style&lang.css, ?direct, ?used)
function stripVitePathQuery(url) {
  if (!url) return url;
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

const _B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function decodeVLQ(str) {
  const out = [];
  let value = 0, shift = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = _B64.indexOf(str[i]);
    if (ch === -1) return out;
    const cont = ch & 32;
    const digit = ch & 31;
    value += digit << shift;
    shift += 5;
    if (!cont) {
      const negate = value & 1;
      out.push(negate ? -(value >> 1) : (value >> 1));
      value = 0; shift = 0;
    }
  }
  return out;
}

// Walk source-map mappings to find first segment on generated line `genLine0`
function mapLineToSource(mappings, genLine0) {
  if (typeof mappings !== 'string' || !mappings) return null;
  const lines = mappings.split(';');
  if (genLine0 < 0 || genLine0 >= lines.length) return null;
  let srcIdx = 0, origLine = 0, origCol = 0;
  let result = null;
  for (let i = 0; i <= genLine0; i++) {
    const segments = lines[i].split(',');
    for (const seg of segments) {
      if (!seg) continue;
      const vals = decodeVLQ(seg);
      if (vals.length >= 4) {
        srcIdx += vals[1];
        origLine += vals[2];
        origCol += vals[3];
        if (i === genLine0 && result === null) {
          result = { srcIdx, origLine, origCol };
        }
      }
    }
  }
  return result;
}

function mapInlineSourceMap(sheetText, genLine0) {
  const m = sheetText.match(/sourceMappingURL=data:application\/json[^,]*?base64,([A-Za-z0-9+/=]+)/);
  if (!m) return null;
  let json;
  try {
    const decoded = Buffer.from(m[1], 'base64').toString('utf8');
    json = JSON.parse(decoded);
  } catch { return null; }
  const sources = json.sources || [];
  if (sources.length === 0) return null;
  const mapping = mapLineToSource(json.mappings || '', genLine0);
  const srcIdx = mapping ? Math.max(0, Math.min(mapping.srcIdx, sources.length - 1)) : 0;
  const origLine = mapping ? mapping.origLine : genLine0;
  const sourceRoot = (json.sourceRoot || '').replace(/\/$/, '');
  const rawSrc = sources[srcIdx] || '';
  if (!rawSrc) return null;
  const fullPath = sourceRoot ? `${sourceRoot}/${rawSrc}` : rawSrc;
  return `${stripVitePathQuery(fullPath)}:${origLine + 1}`;
}

// Map a stylesheet line to the most-informative source location available
function mapStyleSource(sheetText, sheetId, genLine0) {
  const text = sheetText || '';
  const inline = mapInlineSourceMap(text, genLine0);
  if (inline) return inline;
  const sourceUrl = text.match(/\/\*#?\s*sourceURL=([^*\n]+)\s*\*\//)?.[1]
    || text.match(/\/\/# sourceURL=([^\n]+)/)?.[1];
  if (sourceUrl) return `${stripVitePathQuery(sourceUrl.trim())}:${genLine0 + 1}`;
  const mapUrl = text.match(/sourceMappingURL=([^\s*]+)/)?.[1];
  if (mapUrl && !mapUrl.startsWith('data:')) {
    return `${stripVitePathQuery(mapUrl.trim().replace(/\.map$/, ''))}:${genLine0 + 1}`;
  }
  return `${sheetId}:${genLine0 + 1}`;
}

async function resolveStyleSource(cdp, sid, rule) {
  const origin = rule.origin;
  if (origin === 'user-agent') return 'user-agent stylesheet';
  const sheetId = rule.style?.styleSheetId;
  if (!sheetId) return origin === 'regular' ? 'inline style' : (origin || 'unknown stylesheet');
  const range = rule.style.range;
  const genLine0 = range ? range.startLine : 0;
  let header;
  try { header = await cdp.send('CSS.getStyleSheetText', { styleSheetId: sheetId }, sid); } catch {}
  return mapStyleSource(header?.text || '', sheetId, genLine0);
}

async function cascadeStr(cdp, sid, selector, property, refMap, refState) {
  if (!selector) throw new Error('CSS selector or @ref required');

  // CSS.getMatchedStylesForNode requires these domains/document state. Enable
  // them inside cascade so the first call works even before evalraw/perceive.
  try { await cdp.send('DOM.enable', {}, sid); } catch {}
  try { await cdp.send('CSS.enable', {}, sid); } catch {}
  const { root } = await cdp.send('DOM.getDocument', {}, sid);

  // Resolve element to DOM nodeId
  let nodeId;
  if (isRef(selector)) {
    const frameParsed = parseFrameRef(selector);
    let backendNodeId;
    if (frameParsed) {
      backendNodeId = frameScopedBackendNode(refState || {}, frameParsed).backendNodeId;
    } else {
      const num = parseInt(selector.slice(1));
      backendNodeId = refMap.get(num);
      if (!backendNodeId) throw new Error(formatUnknownRefError(selector, refState || {}));
    }
    const { nodeIds } = await cdp.send('DOM.pushNodesByBackendIdsToFrontend',
      { backendNodeIds: [backendNodeId] }, sid);
    nodeId = nodeIds[0];
  } else {
    const result = await cdp.send('DOM.querySelector',
      { nodeId: root.nodeId, selector }, sid);
    if (!result.nodeId) throw new Error('Element not found: ' + selector);
    nodeId = result.nodeId;
  }

  // Get matched styles + computed style in parallel
  const [matched, computed] = await Promise.all([
    cdp.send('CSS.getMatchedStylesForNode', { nodeId }, sid),
    cdp.send('CSS.getComputedStyleForNode', { nodeId }, sid),
  ]);

  // Build computed value lookup
  const computedMap = new Map();
  for (const c of computed.computedStyle || []) {
    computedMap.set(c.name, c.value);
  }

  // Collect rules by property
  const propRules = new Map();
  for (const match of matched.matchedCSSRules || []) {
    const rule = match.rule;
    const selectorText = rule.selectorList?.text || '?';
    const origin = rule.origin; // 'regular', 'user-agent', 'injected', 'inspector'
    const source = await resolveStyleSource(cdp, sid, rule);

    for (const prop of rule.style?.cssProperties || []) {
      if (prop.disabled || !prop.value) continue;
      if (prop.name.startsWith('-webkit-') || prop.name.startsWith('-moz-')) continue;
      if (property && prop.name !== property) continue;
      if (!propRules.has(prop.name)) propRules.set(prop.name, []);
      propRules.get(prop.name).push({
        value: prop.value,
        selector: selectorText,
        source,
        origin,
      });
    }
  }

  // Inline styles (highest specificity — style="" attribute)
  for (const prop of matched.inlineStyle?.cssProperties || []) {
    if (prop.disabled || !prop.value) continue;
    if (prop.name.startsWith('-webkit-') || prop.name.startsWith('-moz-')) continue;
    if (property && prop.name !== property) continue;
    if (!propRules.has(prop.name)) propRules.set(prop.name, []);
    // Insert at the beginning — inline styles win over everything
    propRules.get(prop.name).unshift({
      value: prop.value,
      selector: '[inline]',
      source: 'inline style attribute',
      origin: 'inline',
    });
  }

  const normalizeCssValue = (v) => String(v || '')
    .trim()
    .replace(/\s*,\s*/g, ', ')
    .replace(/\s+/g, ' ');

  // Dedupe identical (selector, normalized value, source, origin) entries per property.
  // CDP can return repeated matchedCSSRules / cssProperties (e.g. same rule
  // matched via multiple selectors in the selectorList, or authored vs normalized
  // values like rgb(37,99,235) vs rgb(37, 99, 235)); rendering them twice
  // misleadingly implies multiple independent winning rules.
  for (const [name, rules] of propRules) {
    const seen = new Set();
    const deduped = [];
    for (const r of rules) {
      const key = `${r.selector}\u0000${normalizeCssValue(r.value)}\u0000${r.source}\u0000${r.origin}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(r);
    }
    propRules.set(name, deduped);
  }

  const hasInherited = (matched.inherited || []).some(inh =>
    inh.matchedCSSRules?.some(m =>
      m.rule.style?.cssProperties?.some(p => !p.disabled && p.value && INHERITABLE_PROPS.has(p.name))));

  if (propRules.size === 0 && !hasInherited && !property) {
    return 'No matching CSS rules found for this element';
  }
  if (propRules.size === 0 && !hasInherited && property) {
    const computed = computedMap.get(property);
    return computed
      ? `${property}: ${computed} (computed, no explicit rule found)`
      : `Property "${property}" not found on this element`;
  }

  // Format output
  const lines = [];
  for (const [prop, rules] of propRules) {
    const computedVal = computedMap.get(prop);
    if (!computedVal) continue;

    lines.push(`${prop}: ${computedVal}`);
    for (const r of rules) {
      const isWinner = normalizeCssValue(r.value) === normalizeCssValue(computedVal);
      const mark = isWinner ? '✓' : '✗';
      const note = isWinner ? '' : '  [overridden]';
      lines.push(`  ${mark} ${r.selector} { ${prop}: ${r.value} }${note}`);
      lines.push(`    → ${r.source}`);
    }
    lines.push('');
  }

  // Inherited properties
  const inherited = matched.inherited || [];
  const inheritedLines = [];
  for (const inh of inherited) {
    for (const match of inh.matchedCSSRules || []) {
      const rule = match.rule;
      for (const prop of rule.style?.cssProperties || []) {
        if (prop.disabled || !prop.value) continue;
        if (!INHERITABLE_PROPS.has(prop.name)) continue;
        if (property && prop.name !== property) continue;
        const selectorText = rule.selectorList?.text || '?';
        const source = await resolveStyleSource(cdp, sid, rule);
        inheritedLines.push(`  ${prop.name}: ${prop.value}  ← ${selectorText}  → ${source}`);
      }
    }
  }
  if (inheritedLines.length > 0) {
    lines.push('Inherited:');
    // Deduplicate identical lines (CDP can repeat the same inherited rule
    // across multiple ancestors / selectors); distinct (selector, source)
    // entries with the same property+value are still preserved.
    const seen = new Set();
    for (const l of inheritedLines) {
      if (seen.has(l)) continue;
      seen.add(l);
      lines.push(l);
    }
  }

  return lines.join('\n').trim() || 'No matching CSS rules found';
}

// --- Tab close ---
async function closetabStr(cdp, targetId) {
  await cdp.send('Target.closeTarget', { targetId });
  return `Closed tab: ${targetId.slice(0, 8)}`;
}

// --- Batch result formatting ---
function formatBatchResults(results, format = 'json') {
  if (format === 'plain') {
    const lines = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      lines.push(`[${i + 1}/${results.length}] ${r.cmd}${r.ok ? '' : ' (error)'}`);
      if (r.ok) {
        const body = (r.result ?? '').toString();
        if (body) lines.push(...body.split('\n').map(l => '  ' + l));
      } else {
        lines.push(`  ${r.error}`);
      }
    }
    return lines.join('\n');
  }
  if (format === 'compact') {
    return results.map((r, i) => {
      const head = `[${i + 1}] ${r.cmd}`;
      if (!r.ok) return `${head}: ERROR ${r.error}`;
      const body = (r.result ?? '').toString().split('\n')[0].slice(0, 200);
      return body ? `${head}: ${body}` : `${head}: ok`;
    }).join('\n');
  }
  return JSON.stringify(results, null, 2);
}

// --- Repeat: bounded loop primitive ---
// `repeat <count> <cmd> [args...]` runs the inner command up to count times.
// Defaults to fail-fast (halt on first error) so a stale @ref or missing
// element does not waste 50 round-trips silently. `--continue` (or `-c`) keeps
// going through errors and reports the tally at the end. The cap is
// intentionally low — repeat is for "press c 5 times to advance through MUD
// dialogue", not for unbounded loops; agents that need more should drive their
// own loop with state checks between iterations.
const REPEAT_CAP = 50;
// `flow` is intentionally allowed: `repeat N flow "step1; step2; ..."` is the
// documented pattern for bounded multi-step loops (combat turns, multi-phase
// dialogues). Nesting is a single level — the inner flow runs through the
// same daemon dispatcher and cannot recurse back into repeat. `batch` stays
// blocked because its parallel/JSON modes are awkward to compose linearly,
// and `repeat`/`stop` are blocked to avoid recursion and IPC corruption.
const REPEAT_BLOCKED = new Set(['repeat', 'batch', 'stop']);

function parseRepeatArgs(args) {
  if (!Array.isArray(args) || args.length < 1) {
    throw new Error('repeat requires <count> <cmd> [args...]');
  }
  const opts = { count: 0, cmd: null, args: [], continueOnError: false };
  const positional = [];
  for (const a of args) {
    if (a === '--continue' || a === '-c') opts.continueOnError = true;
    else positional.push(a);
  }
  if (positional.length < 1) throw new Error('repeat requires <count> <cmd> [args...]');
  const count = parseInt(positional[0], 10);
  if (!Number.isFinite(count) || count < 1 || String(count) !== String(positional[0]).trim()) {
    throw new Error(`repeat: count must be a positive integer, got "${positional[0]}"`);
  }
  if (count > REPEAT_CAP) {
    throw new Error(`repeat: count ${count} exceeds cap ${REPEAT_CAP}. Run multiple repeats or drive your own loop with state checks.`);
  }
  opts.count = count;
  if (positional.length < 2) throw new Error('repeat: command name required after count');
  opts.cmd = positional[1];
  opts.args = positional.slice(2);
  if (REPEAT_BLOCKED.has(opts.cmd)) {
    throw new Error(`repeat: cannot wrap "${opts.cmd}" (would recurse or break IPC). Use a single-shot command (click, press, fill, ...).`);
  }
  return opts;
}

async function repeatStr({ run }, args) {
  const opts = parseRepeatArgs(args);
  const head = `Repeat ${opts.count}× ${opts.cmd}${opts.args.length ? ' ' + opts.args.join(' ') : ''}${opts.continueOnError ? ' (--continue)' : ''}`;
  const lines = [head];
  let okCount = 0, failCount = 0;
  for (let i = 1; i <= opts.count; i++) {
    const r = await run({ cmd: opts.cmd, args: opts.args.slice() });
    if (r && r.ok) {
      okCount++;
      const body = (r.result || '').toString().split('\n')[0].slice(0, 200);
      lines.push(body ? `[${i}/${opts.count}] ok: ${body}` : `[${i}/${opts.count}] ok`);
    } else {
      failCount++;
      const errText = (r && r.error) || 'unknown error';
      lines.push(`[${i}/${opts.count}] ✗ ${errText}`);
      if (!opts.continueOnError) {
        lines.push(`Repeat halted at iteration ${i}/${opts.count} (use --continue to keep going).`);
        break;
      }
    }
  }
  lines.push(`Done: ${okCount} ok, ${failCount} failed`);
  return lines.join('\n');
}

// --- Flow: sequential step runner ---
function parseFlowSteps(input) {
  if (typeof input !== 'string' || !input.trim()) return [];
  return input.split(';').map(s => s.trim()).filter(Boolean).map(line => {
    const parts = line.split(/\s+/);
    const head = parts[0];
    if (head === 'wait') {
      const what = parts.slice(1).join(' ').toLowerCase();
      return { kind: 'wait', what };
    }
    return { kind: 'command', cmd: head, args: parts.slice(1) };
  });
}

async function settleFlow(cdp, sid, what, pendingReqs, opts = {}) {
  const max = opts.maxMs || 10000;
  const quiet = opts.quietMs || 500;
  if (what === 'dom stable') {
    await waitForSettle(cdp, sid, max);
    return 'dom stable';
  }
  if (what === 'network idle') {
    const deadline = Date.now() + max;
    let lastBusy = Date.now();
    while (Date.now() < deadline) {
      const size = pendingReqs?.size || 0;
      if (size > 0) lastBusy = Date.now();
      else if (Date.now() - lastBusy >= quiet) return 'network idle';
      await sleep(100);
    }
    return `network idle (timeout, ${pendingReqs?.size || 0} pending)`;
  }
  throw new Error(`Unknown wait: "${what}". Use "dom stable" or "network idle".`);
}

async function flowStr({ run, settle }, input) {
  const steps = parseFlowSteps(input);
  if (steps.length === 0) throw new Error('flow: no steps. Example: flow <target> "click @1; wait dom stable; summary"');
  const lines = [`Flow: ${steps.length} step(s)`];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const head = step.kind === 'wait'
      ? `[${i + 1}/${steps.length}] wait ${step.what}`
      : `[${i + 1}/${steps.length}] ${step.cmd}${step.args.length ? ' ' + step.args.join(' ') : ''}`;
    lines.push(head);
    try {
      let body;
      if (step.kind === 'wait') {
        body = await settle(step.what);
      } else {
        const r = await run(step);
        if (!r.ok) {
          lines.push(`  ✗ ${r.error}`);
          lines.push(`Flow halted at step ${i + 1}/${steps.length}`);
          return lines.join('\n');
        }
        body = r.result ?? '';
      }
      const text = (body || '').toString();
      if (text) for (const ln of text.split('\n')) lines.push('  ' + ln);
    } catch (e) {
      lines.push(`  ✗ ${e.message}`);
      lines.push(`Flow halted at step ${i + 1}/${steps.length}`);
      return lines.join('\n');
    }
  }
  return lines.join('\n');
}

// --- Replay: execute record-actions artifacts ---
const REPLAY_BLOCKED = new Set(['replay', 'record-actions', 'recordactions', 'batch', 'flow', 'repeat', 'stop']);

function parseReplayArgs(args, { reader = readFileSync } = {}) {
  const tokens = (args || []).filter(a => a !== undefined && a !== null);
  const opts = { continueOnError: false, artifact: null, source: 'inline JSON' };
  const positional = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '--continue' || token === '-c') {
      opts.continueOnError = true;
    } else if (token === '--json') {
      const raw = tokens.slice(i + 1).join(' ').trim();
      if (!raw) throw new Error('replay --json requires a record-actions JSON payload');
      opts.artifact = parseReplayArtifact(raw);
      opts.source = 'inline JSON';
      break;
    } else if (token === '--file' || token === '-f') {
      const filePath = tokens[++i];
      if (!filePath) throw new Error('replay --file requires a path to a record-actions JSON artifact');
      opts.artifact = parseReplayArtifact(reader(filePath, 'utf8'));
      opts.source = filePath;
    } else {
      positional.push(token);
    }
  }
  if (!opts.artifact) {
    const raw = positional.join(' ').trim();
    if (!raw) throw new Error('replay requires --json <record-actions-json> or --file <path>');
    if (raw.startsWith('{') || raw.startsWith('[')) {
      opts.artifact = parseReplayArtifact(raw);
      opts.source = 'inline JSON';
    } else {
      opts.artifact = parseReplayArtifact(reader(positional[0], 'utf8'));
      opts.source = positional[0];
    }
  }
  return opts;
}

function parseReplayArtifact(raw) {
  let artifact;
  try {
    artifact = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) {
    throw new Error(`replay: invalid JSON artifact (${e.message})`);
  }
  if (Array.isArray(artifact)) {
    artifact = { schema: 'chrome-cdp-ex.record-actions.v1', actions: artifact };
  }
  if (!artifact || typeof artifact !== 'object') throw new Error('replay: artifact must be a record-actions JSON object');
  if (artifact.schema !== 'chrome-cdp-ex.record-actions.v1') {
    throw new Error(`replay: unsupported artifact schema ${artifact.schema || '(missing)'}`);
  }
  if (!Array.isArray(artifact.actions)) throw new Error('replay: artifact.actions must be an array');
  return artifact;
}

function replayStepFromAction(action = {}) {
  const command = Array.isArray(action.command) ? action.command.map(v => String(v)) : [];
  const commandText = command.length ? formatCommandLine(command) : `${action.action || 'action'} <missing command>`;
  if (action.replayable !== true) {
    const missing = Array.isArray(action.needsInput) && action.needsInput.length
      ? action.needsInput
      : ['review'];
    return { skip: true, commandText, missing, reason: 'not replayable' };
  }
  if (!command.length || !command[0]) {
    return { skip: true, commandText, missing: ['command'], reason: 'missing command' };
  }
  if (command.includes('<redacted>')) {
    return { skip: true, commandText, missing: redactedCommandNeedsInput(action.action || command[0]), reason: 'redacted input' };
  }
  if (REPLAY_BLOCKED.has(command[0])) {
    return { skip: true, commandText, missing: ['safe command'], reason: `blocked command: ${command[0]}` };
  }
  return { cmd: command[0], args: command.slice(1), commandText };
}

async function replayActionsStr({ run }, args) {
  const opts = parseReplayArgs(args);
  const actions = opts.artifact.actions;
  const total = actions.length;
  const lines = [
    `Replay: ${total} step(s)`,
    `Source: ${opts.source}`,
  ];
  let okCount = 0, failCount = 0, skipCount = 0;
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    const step = replayStepFromAction(action);
    if (step.skip) {
      skipCount++;
      lines.push(`[${i + 1}/${total}] skip ${step.commandText}`);
      if (step.reason) lines.push(`  Reason: ${step.reason}`);
      if (step.missing?.length) lines.push(`  Missing: ${step.missing.join(', ')}`);
      continue;
    }
    lines.push(`[${i + 1}/${total}] ${step.commandText}`);
    const result = await run({ cmd: step.cmd, args: step.args });
    if (result?.ok) {
      okCount++;
      const body = (result.result || '').toString().split('\n')[0].slice(0, 240);
      if (body) lines.push(`  ok: ${body}`);
      else lines.push('  ok');
    } else {
      failCount++;
      lines.push(`  ✗ ${result?.error || 'unknown error'}`);
      if (!opts.continueOnError) {
        lines.push(`Replay halted at step ${i + 1}/${total} (use --continue to keep going).`);
        break;
      }
    }
  }
  lines.push(`Done: ${okCount} ok, ${failCount} failed, ${skipCount} skipped`);
  return lines.join('\n');
}

// --- Doctor: one-call diagnostics ---
function checkNode(version = process.version) {
  const major = parseInt(String(version).replace(/^v/, '').split('.')[0]) || 0;
  if (major >= 22) return { status: 'OK', label: 'Node', detail: `${version} (>= 22)` };
  return {
    status: 'FAIL', label: 'Node', detail: `${version} (need >= 22)`,
    hint: 'chrome-cdp-ex uses built-in WebSocket which requires Node 22+',
  };
}

function checkSkillSymlink({ home = homedir(), fs = { existsSync, lstatSync: null } } = {}) {
  const target = resolve(home, '.claude', 'skills', 'chrome-cdp-ex');
  if (!fs.existsSync(target)) {
    return {
      status: 'WARN', label: 'Skill install', detail: `${target} not found`,
      hint: 'Install with: cp -r skills/chrome-cdp-ex ~/.claude/skills/  (or use the plugin loader)',
    };
  }
  let kind = 'directory';
  try {
    const lstat = fs.lstatSync ? fs.lstatSync(target) : null;
    if (lstat?.isSymbolicLink?.()) kind = 'symlink';
  } catch {}
  return { status: 'OK', label: 'Skill install', detail: `${kind}: ${target}` };
}

function checkDaemonSockets({ list = listDaemonSockets } = {}) {
  const daemons = list();
  if (!daemons || daemons.length === 0) {
    return { status: 'OK', label: 'Daemons', detail: 'no live tab daemons', targetPrefixes: [] };
  }
  const ids = daemons.map(d => (d.targetId || '').slice(0, 8)).filter(Boolean);
  return {
    status: 'OK', label: 'Daemons',
    detail: `${daemons.length} live: ${ids.join(', ')}`,
    targetPrefixes: ids,
  };
}

function detectFdLimit({ runner = spawnSync } = {}) {
  if (IS_WINDOWS) return null;
  try {
    const res = runner('/bin/sh', ['-lc', 'ulimit -n'], { encoding: 'utf8', timeout: 1000 });
    if (res.status !== 0) return null;
    const raw = String(res.stdout || '').trim();
    if (raw === 'unlimited') return Number.POSITIVE_INFINITY;
    const limit = Number(raw);
    return Number.isFinite(limit) ? limit : null;
  } catch {
    return null;
  }
}

function checkFdLimit({ limit = detectFdLimit() } = {}) {
  if (limit == null) {
    return {
      status: 'WARN',
      label: 'FD limit',
      detail: 'open-files limit unavailable',
      hint: 'If you see "Too many open files", rerun commands with: ulimit -n 4096',
    };
  }
  if (limit >= 1024) {
    const text = limit === Number.POSITIVE_INFINITY ? 'unlimited' : String(limit);
    return { status: 'OK', label: 'FD limit', detail: `${text} open files` };
  }
  return {
    status: 'WARN',
    label: 'FD limit',
    detail: `${limit} open files (low for long browser sessions)`,
    hint: 'Raise for this shell with: ulimit -n 4096',
  };
}

async function checkCdpReachability({ env = process.env, fetcher = fetch, host = env.CDP_HOST || process.env.CDP_HOST || '127.0.0.1' } = {}) {
  const port = env.CDP_PORT;
  const tryFetch = async (p) => {
    const res = await fetcher(`http://${host}:${p}/json/version`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };
  const describe = (info) => {
    const product = info.Browser || info.product || 'unknown browser';
    const ua = info['User-Agent'] || '';
    const m = ua.match(/Electron\/([\d.]+)/);
    return m ? `${product} (Electron ${m[1]})` : product;
  };
  if (port) {
    try {
      const info = await tryFetch(port);
      if (!info.webSocketDebuggerUrl) {
        return {
          status: 'WARN', label: 'CDP', detail: `port ${port}: no webSocketDebuggerUrl`,
          hint: 'Browser exposes /json/version but not the debugger WebSocket — toggle remote debugging again',
          host,
          port: String(port),
        };
      }
      return { status: 'OK', label: 'CDP', detail: `${host}:${port} → ${describe(info)}`, host, port: String(port) };
    } catch (e) {
      return {
        status: 'FAIL', label: 'CDP', detail: `cannot reach ${host}:${port} (${e.message})`,
        hint: `start the app with --remote-debugging-port=${port}, or unset CDP_PORT to auto-discover Chrome`,
        host,
        port: String(port),
      };
    }
  }
  // Auto-discover via DevToolsActivePort (light reuse — avoids full ws connect)
  const home = homedir();
  const localAppData = env.LOCALAPPDATA || process.env.LOCALAPPDATA || '';
  const tryPaths = [
    env.CDP_PORT_FILE,
    resolve(home, 'Library/Application Support/Google/Chrome/DevToolsActivePort'),
    resolve(home, 'Library/Application Support/Google/Chrome/Default/DevToolsActivePort'),
    resolve(home, '.config/google-chrome/DevToolsActivePort'),
    resolve(home, '.config/chromium/DevToolsActivePort'),
    resolve(localAppData, 'Google\\Chrome\\User Data\\DevToolsActivePort'),
  ].filter(Boolean);
  const found = tryPaths.find(p => existsSync(p));
  if (!found) {
    return {
      status: 'FAIL', label: 'CDP', detail: 'no DevToolsActivePort and no CDP_PORT set',
      hint: 'Toggle chrome://inspect/#remote-debugging in Chrome, or set CDP_PORT=<port> for an Electron app',
    };
  }
  let lines;
  try {
    lines = readFileSync(found, 'utf8').trim().split('\n');
  } catch (e) {
    return { status: 'WARN', label: 'CDP', detail: `cannot read ${found}: ${e.message}`, host };
  }
  if (lines.length < 2 || !lines[0]) {
    return { status: 'WARN', label: 'CDP', detail: `invalid DevToolsActivePort at ${found}`, host };
  }
  const discoveredPort = lines[0];
  try {
    const info = await tryFetch(discoveredPort);
    return { status: 'OK', label: 'CDP', detail: `${host}:${discoveredPort} → ${describe(info)} (auto-discovered)`, host, port: String(discoveredPort) };
  } catch (e) {
    return {
      status: 'WARN', label: 'CDP',
      detail: `DevToolsActivePort points to ${discoveredPort} but /json/version unreachable: ${e.message}`,
      hint: 'Browser may have stopped — re-toggle chrome://inspect/#remote-debugging',
      host,
      port: String(discoveredPort),
    };
  }
}

function normalizeBrowserTargetInfo(target) {
  return {
    targetId: target.targetId || target.id || '',
    type: target.type || '',
    title: target.title || '',
    url: target.url || '',
  };
}

function isDebuggablePageTarget(target) {
  return target.type === 'page'
    && target.targetId
    && !target.url.startsWith('chrome://')
    && !target.url.startsWith('edge://')
    && !target.url.startsWith('devtools://');
}

async function checkBrowserTargets({ cdp = null, env = process.env, fetcher = fetch, host = env.CDP_HOST || process.env.CDP_HOST || '127.0.0.1' } = {}) {
  if (cdp?.status !== 'OK') {
    return {
      status: 'WARN',
      label: 'Tabs',
      detail: 'skipped until CDP is reachable',
      hint: 'Fix CDP first, then rerun: cdp doctor',
      targetPrefixes: [],
    };
  }
  const port = cdp.port || env.CDP_PORT;
  const cdpHost = cdp.host || host;
  if (!port) {
    return {
      status: 'WARN',
      label: 'Tabs',
      detail: 'cannot list tabs without a CDP port',
      hint: 'Rerun: cdp doctor, then use the printed CDP/open path.',
      targetPrefixes: [],
    };
  }

  try {
    const res = await fetcher(`http://${cdpHost}:${port}/json/list`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json();
    const targets = Array.isArray(raw) ? raw.map(normalizeBrowserTargetInfo).filter(isDebuggablePageTarget) : [];
    if (targets.length === 0) {
      return {
        status: 'WARN',
        label: 'Tabs',
        detail: 'no debuggable page targets',
        hint: 'Create one with: cdp open https://example.com',
        targetPrefixes: [],
        noTargets: true,
      };
    }
    const prefixLen = getDisplayPrefixLength(targets.map(target => target.targetId));
    const targetPrefixes = targets.map(target => target.targetId.slice(0, prefixLen));
    const labels = targets.slice(0, 3).map((target, index) => {
      const title = target.title || (target.url === 'about:blank' ? '(blank tab)' : target.url || '(untitled)');
      return `${targetPrefixes[index]} ${title}`.trim();
    });
    const suffix = targets.length > labels.length ? `, +${targets.length - labels.length} more` : '';
    return {
      status: 'OK',
      label: 'Tabs',
      detail: `${targets.length} debuggable page target${targets.length === 1 ? '' : 's'}: ${labels.join(', ')}${suffix}`,
      targetPrefixes,
    };
  } catch (e) {
    return {
      status: 'WARN',
      label: 'Tabs',
      detail: `cannot list debuggable page targets (${e.message})`,
      hint: 'Run: cdp list. If it is empty, run: cdp open https://example.com',
      targetPrefixes: [],
    };
  }
}

function checkBrowserPermission({ daemons = null, tabs = null } = {}) {
  const daemonPrefixes = daemons?.targetPrefixes || [];
  if (daemonPrefixes.length > 0) {
    return {
      status: 'OK',
      label: 'Permission',
      detail: `debugging approved for ${daemonPrefixes.join(', ')}`,
      targetPrefixes: daemonPrefixes,
    };
  }

  const tabPrefixes = tabs?.targetPrefixes || [];
  if (tabPrefixes.length > 0) {
    const target = tabPrefixes[0];
    return {
      status: 'WARN',
      label: 'Permission',
      detail: `browser debugging approval not confirmed for ${target}`,
      hint: `Run: cdp perceive ${target} -C -d 8; if Chrome asks "Allow debugging?", click Allow`,
      targetPrefixes: tabPrefixes,
    };
  }

  if (tabs?.noTargets || /no debuggable page targets/i.test(tabs?.detail || '')) {
    return {
      status: 'WARN',
      label: 'Permission',
      detail: 'no target available to request browser debugging approval',
      hint: 'Run: cdp open https://example.com; if Chrome asks "Allow debugging?", click Allow',
      targetPrefixes: [],
    };
  }

  return {
    status: 'WARN',
    label: 'Permission',
    detail: 'skipped until CDP and tabs are reachable',
    hint: 'Fix CDP/tabs first, then rerun: cdp doctor',
    targetPrefixes: [],
  };
}

function doctorNextSteps(checks) {
  const failures = checks.filter(c => c.status === 'FAIL');
  const cdp = checks.find(c => c.label === 'CDP');
  const node = checks.find(c => c.label === 'Node');
  const fd = checks.find(c => c.label === 'FD limit');
  const daemon = checks.find(c => c.label === 'Daemons');
  const tabs = checks.find(c => c.label === 'Tabs');
  const liveTarget = daemon?.targetPrefixes?.[0] || tabs?.targetPrefixes?.[0] || '<target>';
  const noTargets = tabs?.noTargets || /no debuggable page targets/i.test(tabs?.detail || '');
  const lines = ['', 'Next steps:'];
  if (node?.status === 'FAIL') {
    lines.push('  1. Install Node.js 22+ and rerun: cdp doctor');
    return lines;
  }
  if (cdp?.status === 'FAIL') {
    lines.push('  1. Existing browser: open chrome://inspect/#remote-debugging, enable remote debugging, then rerun: cdp doctor');
    lines.push('  2. Isolated profile: cdp spawn-debug-browser edge --port 9222 --url https://example.com');
    lines.push('  3. Then run: cdp list');
    return lines;
  }
  if (cdp?.status === 'WARN') {
    lines.push('  1. Re-toggle browser remote debugging, or restart the app with CDP_PORT set.');
    lines.push('  2. If Chrome asks "Allow debugging?", click Allow, then rerun: cdp list');
  } else {
    if (noTargets) {
      lines.push('  1. cdp open https://example.com');
      lines.push('  2. If Chrome asks "Allow debugging?", click Allow; open waits up to 60s.');
      lines.push('  3. Use the target id printed by open: cdp perceive <target-from-open> -C -d 8');
      lines.push('  4. cdp click <target-from-open> @ref  # or: cdp fill <target-from-open> <selector> <text>');
      lines.push('  5. cdp perceive <target-from-open> --since-action');
      lines.push('  6. cdp report <target-from-open>');
    } else {
      lines.push('  1. cdp list');
      if (!tabs?.targetPrefixes?.length) lines.push('  2. If list is empty: cdp open https://example.com');
      lines.push(`  ${tabs?.targetPrefixes?.length ? '2' : '3'}. cdp perceive ${liveTarget} -C -d 8`);
      lines.push(`  ${tabs?.targetPrefixes?.length ? '3' : '4'}. cdp click ${liveTarget} @ref  # or: cdp fill ${liveTarget} <selector> <text>`);
      lines.push(`  ${tabs?.targetPrefixes?.length ? '4' : '5'}. cdp perceive ${liveTarget} --since-action`);
      lines.push(`  ${tabs?.targetPrefixes?.length ? '5' : '6'}. cdp report ${liveTarget}`);
    }
  }
  if (fd?.status === 'WARN') {
    lines.push('  Note: for long sessions, use: ulimit -n 4096');
  }
  if (failures.length === 0) {
    lines.push('  Goal: doctor -> list/open -> perceive -> click/fill -> since-action evidence -> report');
  }
  return lines;
}

function formatDoctorReport(checks) {
  const lines = ['chrome-cdp-ex doctor'];
  for (const c of checks) {
    const tag = c.status.padEnd(4);
    lines.push(`  [${tag}] ${c.label}: ${c.detail}`);
    if (c.hint) lines.push(`         hint: ${c.hint}`);
  }
  const fails = checks.filter(c => c.status === 'FAIL').length;
  const warns = checks.filter(c => c.status === 'WARN').length;
  if (fails === 0 && warns === 0) lines.push('Ready.');
  else if (fails === 0) lines.push(`Mostly ready (${warns} warning${warns > 1 ? 's' : ''}).`);
  else lines.push(`Not ready: ${fails} failure${fails > 1 ? 's' : ''}${warns ? `, ${warns} warning${warns > 1 ? 's' : ''}` : ''}.`);
  lines.push(...doctorNextSteps(checks));
  return lines.join('\n');
}

async function runDoctorChecks(opts = {}) {
  const safeLstat = (p) => { try { return lstatSync(p); } catch { return null; } };
  const fs = opts.fs || { existsSync, lstatSync: safeLstat };
  const checks = [];
  checks.push(checkNode(opts.nodeVersion));
  checks.push(checkSkillSymlink({ home: opts.home, fs }));
  checks.push(checkDaemonSockets({ list: opts.listDaemons }));
  checks.push(checkFdLimit({ limit: opts.fdLimit }));
  const cdp = await checkCdpReachability({ env: opts.env, fetcher: opts.fetcher, host: opts.host });
  checks.push(cdp);
  const tabs = await checkBrowserTargets({ cdp, env: opts.env, fetcher: opts.fetcher, host: opts.host });
  checks.push(tabs);
  checks.push(checkBrowserPermission({ daemons: checks.find(c => c.label === 'Daemons'), tabs }));
  return checks;
}

async function doctorStr(opts = {}) {
  const checks = await runDoctorChecks(opts);
  return formatDoctorReport(checks);
}

// ---------------------------------------------------------------------------
// spawn-debug-browser: launch a browser with --remote-debugging-port using a
// disposable user-data-dir. macOS reviewer feedback: previous skill docs said
// to never suggest --remote-debugging-port, but the only way to debug a
// fresh-install Chrome/Edge without touching the user's main profile is to
// spawn an isolated debug profile. This helper keeps that path predictable.
// ---------------------------------------------------------------------------

const DEFAULT_BROWSER_PATHS = {
  darwin: {
    edge:   ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
    chrome: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    brave:  ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
  },
  linux: {
    edge:   ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable', '/usr/bin/microsoft-edge-dev'],
    chrome: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
    brave:  ['/usr/bin/brave-browser', '/usr/bin/brave'],
  },
  win32: {
    edge:   [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ],
    chrome: [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ],
    brave: [
      'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      'C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    ],
  },
};

function parseSpawnDebugBrowserArgs(args, env = process.env) {
  const opts = { browser: (env && env.CDP_DEBUG_BROWSER) || 'edge', port: 9222, url: null, profileDir: null, executable: null };
  const tokens = (args || []).filter(a => a !== undefined && a !== null);
  for (let i = 0; i < tokens.length; i++) {
    const a = tokens[i];
    if (a === '--port' || a === '-p') opts.port = parseInt(tokens[++i]) || 9222;
    else if (a === '--url' || a === '-u') opts.url = tokens[++i];
    else if (a === '--profile-dir') opts.profileDir = tokens[++i];
    else if (a === '--browser') opts.browser = (tokens[++i] || opts.browser).toLowerCase();
    else if (a === '--exe' || a === '--executable') opts.executable = tokens[++i];
    else if (['edge','chrome','brave','google-chrome','msedge','chromium'].includes(a.toLowerCase())) {
      const norm = a.toLowerCase();
      if (norm === 'msedge') opts.browser = 'edge';
      else if (norm === 'google-chrome' || norm === 'chromium') opts.browser = 'chrome';
      else opts.browser = norm;
    }
  }
  if (!opts.profileDir) {
    const tmp = (env && env.TMPDIR) || '/tmp';
    opts.profileDir = `${tmp.replace(/\/$/, '')}/chrome-cdp-ex-${opts.browser}-debug-profile-${opts.port}`;
  }
  return opts;
}

const BROWSER_COMMANDS = {
  edge: ['microsoft-edge', 'microsoft-edge-stable', 'microsoft-edge-dev', 'msedge'],
  chrome: ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome'],
  brave: ['brave-browser', 'brave'],
};

function findOnPath(commands, env = process.env, fs = { existsSync }) {
  const dirs = String(env?.PATH || '').split(delimiter).filter(Boolean);
  for (const cmd of commands || []) {
    for (const dir of dirs) {
      const candidate = resolve(dir, cmd);
      if (fs.existsSync(candidate)) return candidate;
      if (IS_WINDOWS && fs.existsSync(candidate + '.exe')) return candidate + '.exe';
    }
  }
  return null;
}

function detectBrowserPath(browser, platform = process.platform, fs = { existsSync }, env = process.env) {
  const list = (DEFAULT_BROWSER_PATHS[platform] || {})[browser] || [];
  for (const candidate of list) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return findOnPath(BROWSER_COMMANDS[browser] || [], env, fs);
}

function buildSpawnDebugBrowserPlan(opts, platform = process.platform, fs = { existsSync }, env = process.env) {
  const exe = opts.executable || detectBrowserPath(opts.browser, platform, fs, env);
  if (!exe || !fs.existsSync(exe)) {
    const list = [
      ...((DEFAULT_BROWSER_PATHS[platform] || {})[opts.browser] || []),
      ...((BROWSER_COMMANDS[opts.browser] || []).map(c => `$PATH:${c}`)),
    ];
    const tried = list.length ? list.join(', ') : '(no candidates configured for this platform)';
    throw new Error(`spawn-debug-browser: cannot find ${opts.browser} executable. Tried: ${tried}. Use --exe /path/to/browser, set CDP_DEBUG_BROWSER, or install it on PATH.`);
  }
  const args = [
    `--remote-debugging-port=${opts.port}`,
    `--user-data-dir=${opts.profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];
  if (opts.url) args.push(opts.url);
  return { exe, args, profileDir: opts.profileDir, port: opts.port, url: opts.url, browser: opts.browser };
}

async function spawnDebugBrowserStr(args, env = process.env, deps = {}) {
  const platform = deps.platform || process.platform;
  const fs = deps.fs || { existsSync, mkdirSync };
  const launcher = deps.spawn || spawn;
  const opts = parseSpawnDebugBrowserArgs(args, env);
  const plan = buildSpawnDebugBrowserPlan(opts, platform, fs, env);
  try { fs.mkdirSync(plan.profileDir, { recursive: true }); } catch {}
  const child = launcher(plan.exe, plan.args, { detached: true, stdio: 'ignore' });
  child.unref?.();
  const lines = [];
  lines.push(`Spawned ${plan.browser} debug profile on CDP_PORT=${plan.port} (pid ${child.pid || '?'})`);
  lines.push(`  Executable: ${plan.exe}`);
  lines.push(`  Profile:    ${plan.profileDir}`);
  if (plan.url) lines.push(`  URL:        ${plan.url}`);
  lines.push('');
  lines.push(`Next: CDP_PORT=${plan.port} node skills/chrome-cdp-ex/scripts/cdp.mjs list`);
  lines.push(`(Profile is disposable — delete ${plan.profileDir} to reset.)`);
  return lines.join('\n');
}

function overlayDetectorScript({ targetPoint = null } = {}) {
  const targetJson = JSON.stringify(targetPoint || null);
  return `(function() {
    const targetPoint = ${targetJson};
    const vw = window.innerWidth || 0;
    const vh = window.innerHeight || 0;
    function visible(el) {
      if (!el || el.id === '__cdp_annot_overlay__') return false;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width >= 2 && r.height >= 2 && r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
    }
    function selectorFor(el) {
      if (!el) return '';
      if (el.id) return '#' + CSS.escape(el.id);
      const tag = el.tagName ? el.tagName.toLowerCase() : 'node';
      const cls = typeof el.className === 'string' && el.className.trim()
        ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).map(CSS.escape).join('.')
        : '';
      return tag + cls;
    }
    function shortText(el) {
      return (el?.getAttribute?.('aria-label') || el?.textContent || '').trim().replace(/\\s+/g, ' ').substring(0, 80);
    }
    function pointInRect(point, rect) {
      return !!point && point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
    }
    function elementInfo(el, kind, target) {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const cx = Math.min(Math.max(r.left + r.width / 2, 0), Math.max(vw - 1, 0));
      const cy = Math.min(Math.max(r.top + r.height / 2, 0), Math.max(vh - 1, 0));
      const topAtCenter = document.elementFromPoint(cx, cy);
      const topAtTarget = target ? document.elementFromPoint(target.x, target.y) : null;
      return {
        kind,
        selector: selectorFor(el),
        role: el.getAttribute('role') || '',
        label: el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || '',
        text: shortText(el),
        tag: el.tagName,
        position: cs.position,
        pointerEvents: cs.pointerEvents,
        zIndex: cs.zIndex,
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        coversViewport: r.left <= 8 && r.top <= 8 && r.right >= vw - 8 && r.bottom >= vh - 8,
        coversTarget: pointInRect(target, r),
        topAtCenter: topAtCenter === el || el.contains(topAtCenter),
        topAtTarget: topAtTarget === el || el.contains(topAtTarget),
      };
    }
    function isDialog(el) {
      return el.matches('[role="dialog"], dialog, [aria-modal="true"]');
    }
    const seen = new Set();
    const overlays = [];
    function add(el, kind) {
      if (!visible(el) || seen.has(el)) return;
      seen.add(el);
      const info = elementInfo(el, kind, targetPoint);
      const hasPointer = info.pointerEvents !== 'none';
      const blocksTarget = !!targetPoint && info.coversTarget && hasPointer && (info.topAtTarget || isDialog(el));
      const blocksPage = !targetPoint && hasPointer && (isDialog(el) || info.coversViewport);
      if (isDialog(el) || blocksTarget || blocksPage) overlays.push({ ...info, blocking: blocksTarget || blocksPage || isDialog(el) });
    }
    for (const el of document.querySelectorAll('[role="dialog"], dialog, [aria-modal="true"]')) add(el, 'dialog');
    for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
      add(el, el.getAttribute('aria-modal') === 'true' ? 'dialog' : 'overlay');
      if (overlays.length >= 20) break;
    }
    overlays.sort((a, b) => {
      const za = Number.parseInt(a.zIndex, 10);
      const zb = Number.parseInt(b.zIndex, 10);
      const zcmp = (Number.isFinite(zb) ? zb : 0) - (Number.isFinite(za) ? za : 0);
      if (zcmp) return zcmp;
      return (b.rect.w * b.rect.h) - (a.rect.w * a.rect.h);
    });
    const target = targetPoint ? { ...targetPoint, blocked: false, topElement: null } : null;
    if (targetPoint) {
      const top = document.elementFromPoint(targetPoint.x, targetPoint.y);
      if (top) target.topElement = elementInfo(top, isDialog(top) ? 'dialog' : 'top-element', targetPoint);
      const blocker = overlays.find(o => o.coversTarget && (o.topAtTarget || o.kind === 'dialog' || o.blocking));
      if (blocker) {
        target.blocked = true;
        target.topElement = { kind: blocker.kind, selector: blocker.selector, text: blocker.label || blocker.text || blocker.tag };
      }
    }
    const blocking = overlays.some(o => o.blocking) || !!target?.blocked;
    return JSON.stringify({
      schema: 'chrome-cdp-ex.overlays.v1',
      viewport: { width: vw, height: vh },
      target,
      overlayCount: overlays.length,
      blocking,
      overlays: overlays.slice(0, 10),
      nextCommand: null,
    });
  })()`;
}

function formatOverlayRect(rect = {}) {
  return `(${Math.round(rect.x || 0)},${Math.round(rect.y || 0)} ${Math.round(rect.w || 0)}×${Math.round(rect.h || 0)})`;
}

function overlayElementLabel(element = {}) {
  const selector = element.selector || '<unknown>';
  const label = element.label || element.text || element.tag || '';
  return `[${element.kind || 'overlay'}] ${selector}${label ? ` "${label}"` : ''}`;
}

function formatOverlayReport(model, targetId) {
  const lines = [`Overlay detector: ${model.blocking ? 'blocking' : 'clear'}`];
  if (model.target) {
    const target = model.target;
    const status = target.blocked && target.topElement
      ? `blocked by ${overlayElementLabel(target.topElement)}`
      : 'not blocked';
    lines.push(`Target: ${target.input || '(point)'} at (${Math.round(target.x)},${Math.round(target.y)}) — ${status}`);
  }
  if (!model.overlays || model.overlays.length === 0) {
    lines.push('No visible blocking overlays/dialogs detected.');
  } else {
    lines.push(`Overlays: ${model.overlays.length}`);
    for (const [i, overlay] of model.overlays.entries()) {
      const role = overlay.role ? ` role=${overlay.role}` : '';
      const z = overlay.zIndex != null ? ` z=${overlay.zIndex}` : '';
      const pointer = overlay.pointerEvents ? ` pointer=${overlay.pointerEvents}` : '';
      const target = overlay.coversTarget ? ' covers-target' : '';
      lines.push(`${i + 1}. [${overlay.kind || 'overlay'}] ${overlay.selector || '<unknown>'}${role}${z}${pointer} rect=${formatOverlayRect(overlay.rect)}${target}`);
      const text = overlay.label || overlay.text;
      if (text) lines.push(`   Text: ${text}`);
    }
  }
  const next = model.blocking
    ? (model.nextCommand || `cdp dismiss-modal ${targetId}`)
    : 'continue; if click still fails, run `status` or `perceive --since-action` before retrying';
  lines.push(`Next: ${next}`);
  return lines.join('\n');
}

async function resolveOverlayTargetPoint(cdp, sid, targetArg, refMap, refState) {
  if (!targetArg) return null;
  if (isRef(targetArg)) {
    const rect = await resolveRefRectNoScroll(cdp, sid, refMap, targetArg, refState);
    return {
      input: targetArg,
      x: Math.round((Number(rect.x) || 0) + (Number(rect.w) || 0) / 2),
      y: Math.round((Number(rect.y) || 0) + (Number(rect.h) || 0) / 2),
      descriptor: `<${rect.tag || '?'}> "${rect.text || ''}"`,
    };
  }
  const raw = await evalStr(cdp, sid, `(function() {
    const el = document.querySelector(${JSON.stringify(targetArg)});
    if (!el) return JSON.stringify({ ok: false, error: 'Element not found: ' + ${JSON.stringify(targetArg)} });
    const rect = el.getBoundingClientRect();
    return JSON.stringify({
      ok: true,
      input: ${JSON.stringify(targetArg)},
      x: Math.round(rect.x + rect.width / 2),
      y: Math.round(rect.y + rect.height / 2),
      descriptor: '<' + el.tagName + '> "' + (el.textContent || '').trim().substring(0, 80) + '"'
    });
  })()`);
  const parsed = JSON.parse(raw);
  if (!parsed.ok) throw new Error(parsed.error);
  delete parsed.ok;
  return parsed;
}

async function overlayStr(cdp, sid, targetId, args = [], refMap = new Map(), refState = null) {
  const fopts = parseFormatArgs(args, ['text', 'json']);
  const targetArg = fopts.args[0] || null;
  const targetPoint = await resolveOverlayTargetPoint(cdp, sid, targetArg, refMap, refState);
  const raw = await evalStr(cdp, sid, overlayDetectorScript({ targetPoint }));
  const model = JSON.parse(raw);
  if (model.blocking && !model.nextCommand) model.nextCommand = `cdp dismiss-modal ${targetId}`;
  if (fopts.format === 'json') return formatJson(model);
  return formatOverlayReport(model, targetId);
}

// ---------------------------------------------------------------------------
// dismiss-modal: close common dialog/modal patterns without firing background
// shortcuts. Reviewer feedback: pressing Space to close a "press any key" MOTD
// also triggered the underlying game's `space` shortcut. dismiss-modal favours
// safer signals (Escape / explicit close button / aria-modal click target)
// over global-key presses.
// ---------------------------------------------------------------------------

function dismissModalScript() {
  return `(function() {
    function visible(el) {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return false;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return false;
      return true;
    }
    function findCloseButton(root) {
      const candidates = root.querySelectorAll('button, [role="button"], a, [aria-label], [data-dismiss], [data-close]');
      const labels = ['close', 'dismiss', 'cancel', 'ok', '關閉', '取消', '確認', '繼續', '×', '✕'];
      for (const el of candidates) {
        if (!visible(el)) continue;
        const aria = (el.getAttribute('aria-label') || '').toLowerCase();
        const txt  = (el.textContent || '').trim().toLowerCase();
        const data = (el.getAttribute('data-dismiss') || el.getAttribute('data-close') || '').toLowerCase();
        for (const lab of labels) {
          if (aria.includes(lab) || txt === lab || txt.includes(lab) || data.includes(lab)) {
            return { el, label: lab };
          }
        }
      }
      return null;
    }
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], dialog, [aria-modal="true"]')).filter(visible);
    if (dialogs.length === 0) {
      return JSON.stringify({ ok: false, reason: 'no-dialog' });
    }
    // Prefer an explicit close button inside a visible dialog.
    for (const d of dialogs) {
      const hit = findCloseButton(d);
      if (hit) {
        hit.el.click();
        return JSON.stringify({ ok: true, action: 'click', label: hit.label, sel: d.tagName.toLowerCase() });
      }
    }
    // Fall through: signal that the caller should send Escape next.
    return JSON.stringify({ ok: false, reason: 'no-close-button', dialogs: dialogs.length });
  })()`;
}

async function dismissModalStr(cdp, sid) {
  const raw = await evalStr(cdp, sid, dismissModalScript());
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { parsed = { ok: false, reason: 'parse-error' }; }
  if (parsed.ok) {
    return `Dismissed modal via close button "${parsed.label}" (${parsed.sel})`;
  }
  if (parsed.reason === 'no-dialog') {
    return 'No visible modal/dialog detected.';
  }
  // Fallback: send Escape (does not fire window-level shortcuts the way Space does).
  await pressStr(cdp, sid, 'escape');
  return `No close button found in ${parsed.dialogs || 0} dialog(s); sent Escape as fallback.`;
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

  const session = createSessionState({ targetId, sessionId });
  initializeSessionLog(session);
  ensureSessionScreenshotDir(session);

  // --- Background observation ---
  const consoleBuf = new RingBuffer(200);
  const exceptionBuf = new RingBuffer(50);
  const navBuf = new RingBuffer(10);
  const netReqBuf = new RingBuffer(100); // network request/response pairs
  const pendingReqs = session.pendingRequests; // requestId → {method, url, ts}
  const networkStatusByRequest = new Map(); // requestId → statusCode from ExtraInfo that arrived first
  let lastReadSeq = { console: 0, exception: 0 };

  // --- Ref system & perceive diff state ---
  const refMap = session.refs.map;              // ref number → backendDOMNodeId
  const lastPerceiveStore = session.lastPerceive; // stores last perceive output for diff
  const refState = session.refs;                // ref lifecycle for stale @ref errors
  session.buffers = {
    console: consoleBuf,
    exception: exceptionBuf,
    navigation: navBuf,
    network: netReqBuf,
  };

  // Enable domains for background collection and ref resolution
  try { await cdp.send('Runtime.enable', {}, sessionId); } catch {}
  try { await cdp.send('Page.enable', {}, sessionId); } catch {}
  try { await cdp.send('DOM.enable', {}, sessionId); } catch {}
  try { await cdp.send('CSS.enable', {}, sessionId); } catch {}
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
      // Top-level navigation (or Vite HMR full reload) invalidates all @refs.
      session.pageGeneration += 1;
      invalidateSessionRefs(session, 'navigation');
    }
  });

  // --- Network request/response tracking ---
  function appendNetworkResponse(requestId, req, { status = null, type = req.type, size = 0, failed = false, errorText = null } = {}) {
    pendingReqs.delete(requestId);
    netReqBuf.push({
      method: req.method,
      url: req.url,
      status,
      type,
      duration: Date.now() - req.ts,
      size,
      ...(failed ? { failed: true } : {}),
      ...(errorText ? { errorText } : {}),
      ts: req.ts,
    });
  }

  cdp.onEvent('Network.requestWillBeSent', (params) => {
    // Track action-relevant traffic while skipping static asset noise.
    if (shouldTrackActionNetworkRequest(params.type)) {
      const req = {
        method: params.request.method,
        url: params.request.url.substring(0, 200),
        type: params.type,
        ts: Date.now(),
      };
      if (networkStatusByRequest.has(params.requestId)) {
        const status = networkStatusByRequest.get(params.requestId);
        networkStatusByRequest.delete(params.requestId);
        appendNetworkResponse(params.requestId, req, { status });
      } else {
        pendingReqs.set(params.requestId, req);
      }
    }
  });
  cdp.onEvent('Network.responseReceived', (params) => {
    const req = pendingReqs.get(params.requestId);
    if (!req) return;
    appendNetworkResponse(params.requestId, req, {
      status: params.response.status,
      type: params.type,
      size: params.response.encodedDataLength || 0,
    });
  });

  cdp.onEvent('Network.responseReceivedExtraInfo', (params) => {
    const req = pendingReqs.get(params.requestId);
    if (!Number.isFinite(Number(params.statusCode))) return;
    const status = Number(params.statusCode);
    if (!req) {
      networkStatusByRequest.set(params.requestId, status);
      return;
    }
    appendNetworkResponse(params.requestId, req, { status });
  });

  cdp.onEvent('Network.loadingFinished', (params) => {
    const req = pendingReqs.get(params.requestId);
    if (!req) return;
    appendNetworkResponse(params.requestId, req, {
      status: null,
      size: params.encodedDataLength || 0,
    });
  });

  cdp.onEvent('Network.loadingFailed', (params) => {
    const req = pendingReqs.get(params.requestId);
    if (!req) return;
    appendNetworkResponse(params.requestId, req, {
      status: null,
      type: params.type,
      failed: true,
      errorText: params.errorText || 'loadingFailed',
    });
  });

  // --- Dialog handling (alert/confirm/prompt/beforeunload) ---
  const dialogBuf = new RingBuffer(20);
  session.buffers.dialog = dialogBuf;
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
  let keepaliveUntil = 0;
  let idleTimer = setTimeout(shutdown, IDLE_TIMEOUT);
  function scheduleIdle() {
    clearTimeout(idleTimer);
    const delay = Math.max(IDLE_TIMEOUT, keepaliveUntil - Date.now(), 1000);
    idleTimer = setTimeout(shutdown, delay);
  }
  function resetIdle() {
    scheduleIdle();
  }
  function extendKeepalive(ms) {
    keepaliveUntil = Math.max(keepaliveUntil, Date.now() + ms);
    scheduleIdle();
    return `Daemon keepalive extended for ${ms}ms (until ${new Date(keepaliveUntil).toISOString()})`;
  }

  // Action feedback: wait for DOM to settle, then return structured evidence.
  const BATCH_BLOCKED = new Set(['batch', 'stop', 'repeat', 'flow']);
  // Commands that mutate shared state (refMap, lastPerceiveStore) — unsafe for parallel execution
  const BATCH_NO_PARALLEL = new Set(['click', 'clickxy', 'jsclick', 'select', 'press', 'scroll', 'nav', 'navigate', 'back', 'forward', 'reload', 'viewport', 'fill', 'type', 'inject', 'perceive', 'snap', 'snapshot', 'dismiss-modal', 'dismissmodal']);
  async function observeActionDiffForTarget(target = {}, baselineOutput = null) {
    const targetFrameRef = frameRefFromActionTarget(target);
    await waitForSettle(cdp, sessionId);
    return perceiveStr(
      cdp,
      sessionId,
      consoleBuf,
      exceptionBuf,
      refMap,
      lastPerceiveStore,
      targetFrameRef
        ? { sinceAction: true, diffBaseline: baselineOutput, frameRef: targetFrameRef }
        : { sinceAction: true, diffBaseline: baselineOutput },
      refState
    );
  }
  async function observeFullPerceive() {
    await waitForSettle(cdp, sessionId);
    return perceiveStr(cdp, sessionId, consoleBuf, exceptionBuf, refMap, lastPerceiveStore, {}, refState);
  }
  async function actionFeedback(action, actionDispatch, target = {}, feedbackPolicy = 'settle-diff', observe = null) {
    const dispatch = typeof actionDispatch === 'function' ? actionDispatch : async () => actionDispatch;
    const actionTarget = target && typeof target === 'object'
      ? { ...target, targetId }
      : { input: String(target || ''), label: String(target || ''), targetId };
    const baselineOutput = baselineOutputForActionTarget(refState, lastPerceiveStore.output, actionTarget);
    const observationBaseline = createActionObservationBaseline({ consoleBuf, exceptionBuf, netReqBuf });
    const actionStartedAt = Date.now();
    const observeAfterAction = observe || (() => observeActionDiffForTarget(actionTarget, baselineOutput));
    const observeThenFlush = async () => {
      const text = await observeAfterAction();
      await waitForActionNetworkQuiet(pendingReqs);
      appendPendingActionNetworkEntries(pendingReqs, netReqBuf, actionStartedAt);
      return text;
    };
    session.lastAction = { action, target: actionTarget, feedbackPolicy, ts: actionStartedAt, baselineOutput };
    return runActionWithFeedback({
      action,
      target: actionTarget,
      dispatch,
      feedbackPolicy,
      observe: observeThenFlush,
      enrichActionResult: (actionResult) => applyActionObservationDelta(actionResult, buildActionObservationDelta(
        { consoleBuf, exceptionBuf, netReqBuf },
        observationBaseline
      )),
      onActionResult: (actionResult) => appendSessionActionLog(session, actionResult, { ts: session.lastAction.ts }),
    });
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
        case 'eval': {
          const eopts = parseEvalArgs(args);
          if (eopts.fireAndForget) {
            result = await evalFireAndForgetStr(cdp, sessionId, eopts.expression, true);
            result += `\n${extendKeepalive(FIRE_AND_FORGET_KEEPALIVE)} (fire-and-forget default)`;
          } else {
            result = await evalStr(cdp, sessionId, eopts.expression, true);
          }
          break;
        }
        case 'eval64': {
          const decoded = evalBase64Decode(args[0]);
          result = await evalStr(cdp, sessionId, decoded, true);
          break;
        }
        case 'call': result = await callStr(cdp, sessionId, args.join(' ')); break;
        case 'wait': result = await waitStr(args[0]); break;
        case 'keepalive': result = extendKeepalive(parseDelayMs(args[0], { name: 'keepalive duration' })); break;
        case 'shot': case 'screenshot': {
          if (args[0] === '--annotate' || args[0] === '-a') {
            result = await annotshotStr(cdp, sessionId, targetId, refMap);
            appendSessionScreenshot(session, {
              kind: 'annotshot',
              path: result.split('\n')[0],
              note: 'annotated refs',
            });
          } else {
            const sopts = parseShotArgs(args);
            const filePath = sopts.filePath || nextSessionScreenshotPath(session, 'shot');
            if (!sopts.filePath) ensureSessionScreenshotDir(session);
            result = await shotStr(cdp, sessionId, filePath, targetId, { quiet: sopts.quiet, verbose: sopts.verbose });
            appendSessionScreenshot(session, {
              kind: 'shot',
              path: result.split('\n')[0],
              note: sopts.filePath ? 'custom path' : 'session screenshot',
            });
          }
          break;
        }
        case 'html': result = await htmlStr(cdp, sessionId, args[0]); break;
        case 'nav': case 'navigate': {
          result = await actionFeedback(
            'nav',
            () => navStr(cdp, sessionId, args[0]),
            { input: args[0], resolvedBy: 'url', label: args[0] || '', commandArgs: [args[0]] },
            'full-perceive',
            observeFullPerceive
          );
          break;
        }
        case 'net': case 'network': result = await netStr(cdp, sessionId); break;
        case 'status': {
          const fopts = parseFormatArgs(args, ['text', 'json']);
          if (fopts.format === 'json') {
            const runtime = fopts.args.includes('--runtime')
              ? await runtimeMetricsStr(cdp, sessionId).catch(e => ({ unavailable: e.message }))
              : null;
            result = formatJson(buildStatusModel({
              targetId,
              page: await pageInfoModel(cdp, sessionId),
              consoleBuf,
              exceptionBuf,
              navBuf,
              lastReadSeq,
              runtime,
            }));
            lastReadSeq.console = consoleBuf.latest();
            lastReadSeq.exception = exceptionBuf.latest();
          } else {
            result = await statusStr(cdp, sessionId, consoleBuf, exceptionBuf, navBuf, lastReadSeq, { runtime: fopts.args.includes('--runtime') });
          }
          break;
        }
        case 'console': {
          const fopts = parseFormatArgs(args, ['text', 'json']);
          if (fopts.format === 'json') {
            const flag = fopts.args[0];
            result = formatJson(buildConsoleModel(consoleBuf, exceptionBuf, lastReadSeq, flag));
            if (flag !== '--all' && flag !== '--errors') {
              lastReadSeq.console = consoleBuf.latest();
              lastReadSeq.exception = exceptionBuf.latest();
            }
          } else {
            result = await consoleStr(consoleBuf, exceptionBuf, lastReadSeq, fopts.args[0]);
          }
          break;
        }
        case 'summary': {
          const fopts = parseFormatArgs(args, ['text', 'json']);
          result = fopts.format === 'json'
            ? formatJson(await summaryModel(cdp, sessionId, consoleBuf, exceptionBuf))
            : await summaryStr(cdp, sessionId, consoleBuf, exceptionBuf);
          break;
        }
        case 'frame': case 'frames': {
          const fopts = parseFormatArgs(args, ['text', 'json']);
          result = await framesStr(cdp, sessionId, { format: fopts.format });
          break;
        }
        case 'overlay': case 'overlays': {
          result = await overlayStr(cdp, sessionId, targetId, args, refMap, refState);
          break;
        }
        case 'report': {
          result = formatSessionReport(session);
          break;
        }
        case 'checkpoint': {
          const fopts = parseFormatArgs(args, ['text', 'json']);
          result = await checkpointStr(cdp, sessionId, { format: fopts.format });
          appendSessionEventLog(session, { kind: 'checkpoint', url: result.includes('URL: ') ? result.split('URL: ')[1]?.split('\n')[0] : undefined });
          break;
        }
        case 'record-actions': case 'recordactions': {
          const fopts = parseFormatArgs(args, ['text', 'json']);
          result = formatRecordActions(session, { format: fopts.format });
          break;
        }
        case 'perceive': {
          const fopts = parseFormatArgs(args, ['text', 'json']);
          const popts = parsePerceiveArgs(fopts.args);
          if (popts.sinceAction) {
            popts.diffBaseline = session.lastAction?.baselineOutput || null;
            if (fopts.format === 'json') {
              throw new Error('perceive --since-action currently supports text output only; omit --format json.');
            }
          }
          result = fopts.format === 'json'
            ? formatPerceptionJson(await perceiveModel(cdp, sessionId, consoleBuf, exceptionBuf, refMap, lastPerceiveStore, popts, refState))
            : await perceiveStr(cdp, sessionId, consoleBuf, exceptionBuf, refMap, lastPerceiveStore, popts, refState);
          break;
        }
        case 'elshot': result = await elshotStr(cdp, sessionId, args[0], targetId, refMap, refState); break;
        case 'click': {
          // `click --js <selector|@ref>` switches to the JS-fallback path that
          // calls HTMLElement.click() instead of dispatching CDP mouse events.
          // Useful when overlays or weird hit testing block the realistic
          // mouse path; opt-in only so default behaviour is unchanged.
          if (args[0] === '--js' || args[0] === '-j') {
            result = await actionFeedback('click', () => jsClickStr(cdp, sessionId, args[1], refMap, refState), { input: args[1], resolvedBy: 'selector-or-ref', label: args[1] || '', commandArgs: ['--js', args[1]] });
          } else {
            result = await actionFeedback('click', () => clickStr(cdp, sessionId, args[0], refMap, refState), { input: args[0], resolvedBy: 'selector-or-ref', label: args[0] || '', commandArgs: [args[0]] });
          }
          break;
        }
        case 'jsclick': result = await actionFeedback('jsclick', () => jsClickStr(cdp, sessionId, args[0], refMap, refState), { input: args[0], resolvedBy: 'selector-or-ref', label: args[0] || '', commandArgs: [args[0]] }); break;
        case 'clickxy': result = await actionFeedback('clickxy', () => clickXyStr(cdp, sessionId, args[0], args[1]), { input: `${args[0]},${args[1]}`, resolvedBy: 'coordinates', label: `${args[0]},${args[1]}`, commandArgs: [args[0], args[1]] }); break;
        case 'type': result = await actionFeedback('type', () => typeStr(cdp, sessionId, args[0]), { input: 'current focus', resolvedBy: 'focus', label: 'current focus', commandArgs: [args[0]] }); break;
        case 'press': {
          result = await actionFeedback('press', () => pressStr(cdp, sessionId, args[0]), { input: args[0], resolvedBy: 'key', label: args[0] || '', commandArgs: [args[0]] });
          break;
        }
        case 'scroll': {
          result = await actionFeedback('scroll', () => scrollStr(cdp, sessionId, args[0], args[1]), { input: [args[0], args[1]].filter(Boolean).join(' '), resolvedBy: 'scroll', label: args[0] || 'scroll', commandArgs: [args[0], args[1]] });
          break;
        }
        case 'hover': result = await hoverStr(cdp, sessionId, args[0], refMap, refState); break;
        case 'waitfor': result = await waitForStr(cdp, sessionId, args, refMap, refState); break;
        case 'loadall': result = await loadAllStr(cdp, sessionId, args[0], args[1] ? parseInt(args[1]) : 1500); break;
        case 'fill': {
          if (args[0] === '--react') result = await actionFeedback('fill', () => fillStr(cdp, sessionId, args[1], args[2], refMap, refState, { react: true }), { input: args[1], resolvedBy: 'selector-or-ref', label: args[1] || '', commandArgs: ['--react', args[1], args[2]] });
          else result = await actionFeedback('fill', () => fillStr(cdp, sessionId, args[0], args[1], refMap, refState), { input: args[0], resolvedBy: 'selector-or-ref', label: args[0] || '', commandArgs: [args[0], args[1]] });
          break;
        }
        case 'select': result = await actionFeedback('select', () => selectStr(cdp, sessionId, args[0], args[1]), { input: args[0], resolvedBy: 'selector', label: args[0] || '', commandArgs: [args[0], args[1]] }); break;
        case 'fullshot': result = await fullshotStr(cdp, sessionId, args[0], targetId); break;
        case 'scanshot': result = await scanshotStr(cdp, sessionId, targetId); break;
        case 'styles': result = await stylesStr(cdp, sessionId, args[0]); break;
        case 'cookies': result = await cookiesStr(cdp, sessionId); break;
        case 'cookieset': result = await cookieSetStr(cdp, sessionId, args[0]); break;
        case 'cookiedel': result = await cookieDelStr(cdp, sessionId, args[0]); break;
        case 'dialog': result = dialogStr(dialogBuf, dialogAutoAcceptRef, args[0]); break;
        case 'viewport': {
          if (args[0]) result = await actionFeedback('viewport', () => viewportStr(cdp, sessionId, args[0]), { input: args[0], resolvedBy: 'viewport', label: args[0], commandArgs: [args[0]] }); // auto-diff when resizing
          else result = await viewportStr(cdp, sessionId, args[0]);
          break;
        }
        case 'upload': result = await uploadStr(cdp, sessionId, args[0], args[1]); break;
        case 'text': result = await textStr(cdp, sessionId, args); break;
        case 'table': result = await tableStr(cdp, sessionId, args[0]); break;
        case 'back': result = await actionFeedback('back', () => historyNavStr(cdp, sessionId, -1), { input: 'back', resolvedBy: 'history', label: 'back', commandArgs: [] }, 'full-perceive', observeFullPerceive); break;
        case 'forward': result = await actionFeedback('forward', () => historyNavStr(cdp, sessionId, +1), { input: 'forward', resolvedBy: 'history', label: 'forward', commandArgs: [] }, 'full-perceive', observeFullPerceive); break;
        case 'reload': {
          result = await actionFeedback('reload', async () => {
            const reloadResult = await reloadStr(cdp, sessionId);
            clearObservationBuffers({ consoleBuf, exceptionBuf, navBuf, netReqBuf, pendingReqs, lastReadSeq });
            return `${reloadResult} (console/exception/navigation buffers cleared)`;
          }, { input: 'reload', resolvedBy: 'page', label: 'reload', commandArgs: [] }, 'full-perceive', observeFullPerceive);
          break;
        }
        case 'closetab': result = await closetabStr(cdp, targetId); break;
        case 'netlog': result = netlogStr(netReqBuf, args[0]); break;
        case 'inject': result = await actionFeedback('inject', () => injectStr(cdp, sessionId, args), { input: args[0] || '', resolvedBy: 'command', label: args[0] || 'inject', commandArgs: args }, 'state-change'); break;
        case 'record': result = await recordStr(cdp, sessionId, args, refMap); break;
        case 'cascade': result = await cascadeStr(cdp, sessionId, args[0], args[1], refMap, refState); break;
        case 'dismiss-modal': case 'dismissmodal': result = await actionFeedback('dismiss-modal', () => dismissModalStr(cdp, sessionId), { input: 'modal', resolvedBy: 'dialog', label: 'modal', commandArgs: [] }); break;
        case 'evalraw': result = await evalRawStr(cdp, sessionId, args[0], args[1]); break;
        case 'batch': {
          let commands;
          const parallel = args.includes('--parallel');
          const plain = args.includes('--plain');
          const compact = args.includes('--compact');
          const input = args.filter(a => a !== '--parallel' && a !== '--plain' && a !== '--compact').join(' ') || '';
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
          const fmt = plain ? 'plain' : compact ? 'compact' : 'json';
          result = formatBatchResults(results, fmt);
          break;
        }
        case 'flow': {
          const input = args.join(' ');
          result = await flowStr({
            run: (step) => handleCommand({ cmd: step.cmd, args: step.args || [] }),
            settle: (what) => settleFlow(cdp, sessionId, what, pendingReqs),
          }, input);
          break;
        }
        case 'repeat': {
          result = await repeatStr({
            run: (step) => handleCommand({ cmd: step.cmd, args: step.args || [] }),
          }, args);
          break;
        }
        case 'replay': {
          result = await replayActionsStr({
            run: (step) => handleCommand({ cmd: step.cmd, args: step.args || [] }),
          }, args);
          break;
        }
        case 'restore': {
          const safeCommandArgs = redactRestoreCommandArgs(args);
          result = await actionFeedback(
            'restore',
            async () => {
              const restoreResult = await restoreCheckpointStr(cdp, sessionId, args);
              clearObservationBuffers({ consoleBuf, exceptionBuf, navBuf, netReqBuf, pendingReqs, lastReadSeq });
              session.pageGeneration += 1;
              invalidateSessionRefs(session, 'navigation');
              return restoreResult;
            },
            { input: 'checkpoint', resolvedBy: 'artifact', label: 'checkpoint', commandArgs: safeCommandArgs },
            'report-only'
          );
          break;
        }
        case 'stop': return { ok: true, result: '', stopAfter: true };
        default: return { ok: false, error: `Unknown command: ${cmd}` };
      }
      return { ok: true, result: result ?? '' };
    } catch (e) {
      const rawError = actionFailureMessage(e);
      const commandMeta = COMMANDS.find(command => command.name === cmd || (command.aliases || []).includes(cmd));
      const isMutatingCommand = commandMeta?.mutates === true;
      const alreadyClassified = rawError.startsWith('Action failure:');
      const lastAction = session.lastAction || {};
      const context = {
        action: isMutatingCommand && lastAction.action ? lastAction.action : cmd,
        target: isMutatingCommand && lastAction.target ? lastAction.target : { targetId, input: args?.[0], label: args?.[0] },
      };
      const failure = classifyActionFailure(e, context);
      const error = alreadyClassified || (isMutatingCommand && failure.kind !== 'unknown')
        ? formatActionFailure(e, context)
        : rawError;
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

function ipcTimeoutForRequest(req) {
  if (req?.cmd !== 'wait') return IPC_TIMEOUT;
  try {
    const waitMs = parseDelayMs(req.args?.[0], { name: 'wait duration', max: 60 * 60 * 1000 });
    return Math.max(IPC_TIMEOUT, waitMs + 5000);
  } catch {
    return IPC_TIMEOUT;
  }
}

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
    const onEnd = () => settle(() => reject(new Error(`Connection closed before response. The daemon for this tab may have crashed or exited (idle timeout, page closed, or browser disconnect). Re-run "perceive <target>" to restart it; check ${RUNTIME_DIR} for stale sockets if this repeats.`)));
    const onClose = () => settle(() => reject(new Error(`Connection closed before response. The daemon for this tab may have crashed or exited (idle timeout, page closed, or browser disconnect). Re-run "perceive <target>" to restart it; check ${RUNTIME_DIR} for stale sockets if this repeats.`)));

    const timeoutMs = ipcTimeoutForRequest(req);
    const timer = setTimeout(() => {
      settle(() => { conn.destroy(); reject(new Error(`IPC timeout: command "${req.cmd}" took longer than ${timeoutMs / 1000}s`)); });
    }, timeoutMs);

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
                                    --since-action: show changes caused by the last mutating command
                                    --frame @fN / -F @fN: perceive inside an iframe; refs become @fN:M
                                    -s <sel> / --selector: scope to CSS selector subtree
                                    -i / --interactive: only show interactive elements
                                    -d N / --depth N: limit tree depth
                                    -C / --cursor-interactive: include non-ARIA clickable elements (@c refs)
  snap  <target> [--full]           Accessibility tree snapshot (compact by default, --full for complete)
  eval  <target> <expr>             Evaluate JS expression
                                    --b64 / -b <base64>: decode UTF-8 base64 first
                                    (safe transport for CJK / shell-hostile expressions)
                                    --fire-and-forget: dispatch without awaiting returned promise
  eval64 <target> <base64>          Shorthand for eval --b64; preserves multibyte characters
  call  <target> <expr|fn>          Await expression/function result and print JSON when possible
  elshot <target> <sel|@ref>        Element screenshot: captures element by CSS selector or @ref
  shot  <target> [file|--annotate]  Viewport screenshot; --annotate (-a) overlays @ref labels
  html  <target> [selector]         Get HTML (full page or CSS selector)
  nav   <target> <url>              Navigate to URL and wait for load completion
  status <target> [--runtime]        Page state + new console/exception entries (primary debug entry point)
                                    --runtime: include Performance.getMetrics counters
  console <target> [--all|--errors] Console buffer (default: new entries only; --all: last 200; --errors: errors+exceptions)
  summary <target>                  Token-efficient page overview (interactive elements, scroll, console health)
  report <target>                   Session action timeline + evidence summary + JSONL log path
  checkpoint <target> [--format json]  Capture URL, cookies, localStorage, and sessionStorage
  restore <target> --file <path>     Restore a checkpoint artifact into the live page
  restore <target> --json <json>     Restore an inline checkpoint JSON artifact
  record-actions <target>           Export session action log as replay-oriented text or JSON
  replay <target> --file <path>      Replay a record-actions JSON artifact against the live page
  replay <target> --json <json>      Replay an inline record-actions JSON artifact
  frame <target> [--format json]     List page frames with stable @fN refs (alias: frames)
  overlay <target> [sel|@ref] [--format json]  Detect visible dialogs/overlays and target blockers
  net   <target>                    Network performance entries
  click   <target> <sel|@ref>       Click element by CSS selector or @ref
                                    --js / -j: use HTMLElement.click() (JS fallback)
  jsclick <target> <sel|@ref>       JS-only click: el.click() instead of CDP mouse events
                                    Use when overlays or hit-testing block the realistic mouse path.
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
  wait    <target> <ms>             Delay inside cdp (also: cdp wait <ms> [target])
  fill    <target> <sel|@ref> <txt> Clear field and type text (for form filling)
                                    --react: native value setter + input/change events
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
  text    <target> [selector]       Clean visible text — optional CSS selector to scope
                                    --root auto|default|<sel>: scope to #root/[data-reactroot]/main/body or selector
  table   <target> [selector]       Full table data extraction (tab-separated, no row limit)
  back    <target>                  Navigate back in browser history
  forward <target>                  Navigate forward in browser history
  reload  <target>                  Reload current page and clear console/exception/navigation buffers
  closetab <target>                 Close a browser tab
  netlog  <target> [--clear]        Network request log (XHR/Fetch/Document with status + timing)
  inject <target> <flag> [content]   Live CSS/JS injection with tracking and removal
                                    --css "<text>"   Inject inline <style>
                                    --css-file <url> Inject <link rel="stylesheet">
                                    --js-file <url>  Inject <script src> and wait for load
                                    --remove [id]    Remove injected element(s) (all, or by id)
  cascade <target> <sel|@ref> [prop] CSS origin tracing — shows which rules apply, source file + line
                                    Optional: filter to one property (e.g. "background-color")
  record <target> [ms]              Record a short timeline of DOM/console/network/navigation events
  record <target> --action click @5 Record events around an action (click/press/fill/select/type/scroll/nav)
  record <target> --until "dom stable"|"network idle"  Record until page quiets (max 30s)
  evalraw <target> <method> [json]  Send a raw CDP command; returns JSON result
                                    e.g. evalraw <t> "DOM.getDocument" '{}'
  batch <target> <cmds> [--parallel] Execute multiple commands in one call (reduces IPC overhead)
                                    Pipe syntax: 'fill @3 hello | fill @5 world | click @7'
                                    JSON syntax: '[{"cmd":"click","args":["@1"]},{"cmd":"perceive","args":["--diff"]}]'
                                    --parallel  Run commands concurrently (for independent ops like multiple elshots)
                                    --plain     Human-readable per-step output (default: pretty JSON)
                                    --compact   One line per step (head + first line of result)
  flow  <target> "<steps>"          Sequential runner. Steps separated by ";".
                                    Each step is a normal command (e.g. "click @1") or a wait alias:
                                    "wait dom stable" / "wait network idle" — uses settle helper.
                                    Halts on the first failing step. Output is readable, not JSON.
                                    Example: flow A7BA "click @1; wait dom stable; summary; console --errors"
  repeat <target> <N> <cmd> [args]  Run a command up to N times (cap 50). Fail-fast by default.
                                    --continue / -c: keep going through errors and report tally.
                                    Cannot wrap repeat/batch/stop (recursion / IPC corruption).
                                    Can wrap flow for multi-step turn loops, e.g.
                                    repeat A7BA 3 flow "click @1; wait dom stable; text .log"
                                    Useful for advancing MUD dialogue ("repeat 5 press space"),
                                    retry-style probes, or short keypress sequences. Re-perceive
                                    between iterations if the DOM changes — refs are not auto-remapped.
                                    Example: repeat A7BA 5 press c
  doctor / ready                    One-call diagnostics: Node version, skill install path,
                                    daemon socket state, fd limit, CDP_PORT/DevToolsActivePort reachability,
                                    debuggable tab inventory, browser permission, and onboarding next steps.
                                    No target required. Exits 1 if any check FAILs.
  keepalive <target> <ms>           Extend this tab daemon lifetime (fire-and-forget eval extends 1h)
  open  [url]                       Open a new tab (default: about:blank)
                                    Note: each new tab triggers a fresh "Allow debugging?" prompt
  spawn-debug-browser [browser] [--port N] [--url URL] [--profile-dir DIR] [--exe PATH]
                                    Launch an isolated debug profile (browser: edge|chrome|brave; default edge, port 9222).
                                    Uses --remote-debugging-port + --user-data-dir; does not touch your main profile.
                                    "spawn" is a short alias.
  dismiss-modal <target>            Close common dialog/modal patterns safely (close button, then Escape) —
                                    avoids triggering background shortcuts the way a bare "press Space" does.
  stop  [target]                    Stop daemon(s)

ACTION FEEDBACK
  click, clickxy, press (Enter/Escape/Tab), select, scroll, and viewport (when
  resizing) automatically wait for DOM to settle and return a perceive diff.
  Each mutating action also snapshots console/exception/network buffers before
  dispatch and reports compact deltas such as console errors, failed requests,
  or requests still pending after the action observation window.
  If that post-action observation times out after the action was sent, the
  command reports success with "observation timed out" instead of a pure timeout.
  nav automatically returns a full perceive of the loaded page.
  No need to manually run perceive or perceive --diff after these actions.
  To re-check what the last action changed, run perceive --since-action.

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
  Commands mirror the CLI: perceive, status, summary, console, frame, snap, eval, eval64, call, wait, keepalive, shot,
  elshot, fullshot, scanshot, html, nav, net, click, jsclick, clickxy, hover, type, press,
  scroll, fill, select, waitfor, loadall, styles, cookies, cookieset, cookiedel, dialog,
  viewport, upload, text, table, back, forward, reload, closetab, netlog, inject, cascade,
  record, checkpoint, restore, record-actions, replay, report, evalraw, batch, flow, repeat, stop.
  The socket disappears after 20 min of inactivity or when the tab closes.
`;

const COMMANDS = Object.freeze([
  { name: 'list', aliases: [], needsTarget: false, mutates: false, outputFormats: ['text'] },
  { name: 'open', aliases: [], needsTarget: false, mutates: true, feedbackPolicy: 'full-perceive', outputFormats: ['text'] },
  { name: 'doctor', aliases: ['ready'], needsTarget: false, mutates: false, outputFormats: ['text'] },
  { name: 'spawn-debug-browser', aliases: ['spawn'], needsTarget: false, mutates: true, feedbackPolicy: 'report-only', outputFormats: ['text'] },
  { name: 'stop', aliases: [], needsTarget: false, mutates: true, feedbackPolicy: 'report-only', outputFormats: ['text'] },
  { name: 'perceive', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text', 'json'] },
  { name: 'snap', aliases: ['snapshot'], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'eval', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'eval64', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'call', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'wait', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'keepalive', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'shot', aliases: ['screenshot'], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'html', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'nav', aliases: ['navigate'], needsTarget: true, mutates: true, feedbackPolicy: 'full-perceive', outputFormats: ['text', 'json'] },
  { name: 'net', aliases: ['network'], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'status', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text', 'json'] },
  { name: 'console', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text', 'json'] },
  { name: 'summary', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text', 'json'] },
  { name: 'frame', aliases: ['frames'], needsTarget: true, mutates: false, outputFormats: ['text', 'json'] },
  { name: 'overlay', aliases: ['overlays'], needsTarget: true, mutates: false, outputFormats: ['text', 'json'] },
  { name: 'report', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'checkpoint', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text', 'json'] },
  { name: 'restore', aliases: [], needsTarget: true, mutates: true, feedbackPolicy: 'report-only', outputFormats: ['text'] },
  { name: 'record-actions', aliases: ['recordactions'], needsTarget: true, mutates: false, outputFormats: ['text', 'json'] },
  { name: 'replay', aliases: [], needsTarget: true, mutates: true, feedbackPolicy: 'report-only', outputFormats: ['text'] },
  { name: 'elshot', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'click', aliases: [], needsTarget: true, mutates: true, feedbackPolicy: 'settle-diff', outputFormats: ['text', 'json'] },
  { name: 'jsclick', aliases: [], needsTarget: true, mutates: true, feedbackPolicy: 'settle-diff', outputFormats: ['text', 'json'] },
  { name: 'clickxy', aliases: [], needsTarget: true, mutates: true, feedbackPolicy: 'settle-diff', outputFormats: ['text', 'json'] },
  { name: 'type', aliases: [], needsTarget: true, mutates: true, feedbackPolicy: 'settle-diff', outputFormats: ['text', 'json'] },
  { name: 'press', aliases: [], needsTarget: true, mutates: true, feedbackPolicy: 'settle-diff', outputFormats: ['text', 'json'] },
  { name: 'scroll', aliases: [], needsTarget: true, mutates: true, feedbackPolicy: 'settle-diff', outputFormats: ['text', 'json'] },
  { name: 'hover', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'waitfor', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'loadall', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'fill', aliases: [], needsTarget: true, mutates: true, feedbackPolicy: 'settle-diff', outputFormats: ['text', 'json'] },
  { name: 'select', aliases: [], needsTarget: true, mutates: true, feedbackPolicy: 'settle-diff', outputFormats: ['text', 'json'] },
  { name: 'fullshot', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'scanshot', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'styles', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'cookies', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'cookieset', aliases: [], needsTarget: true, mutates: true, feedbackPolicy: 'report-only', outputFormats: ['text'] },
  { name: 'cookiedel', aliases: [], needsTarget: true, mutates: true, feedbackPolicy: 'report-only', outputFormats: ['text'] },
  { name: 'evalraw', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'batch', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'dialog', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'viewport', aliases: [], needsTarget: true, mutates: true, feedbackPolicy: 'settle-diff', outputFormats: ['text', 'json'] },
  { name: 'upload', aliases: [], needsTarget: true, mutates: true, feedbackPolicy: 'state-change', outputFormats: ['text', 'json'] },
  { name: 'text', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'table', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'back', aliases: [], needsTarget: true, mutates: true, feedbackPolicy: 'full-perceive', outputFormats: ['text', 'json'] },
  { name: 'forward', aliases: [], needsTarget: true, mutates: true, feedbackPolicy: 'full-perceive', outputFormats: ['text', 'json'] },
  { name: 'reload', aliases: [], needsTarget: true, mutates: true, feedbackPolicy: 'full-perceive', outputFormats: ['text', 'json'] },
  { name: 'closetab', aliases: [], needsTarget: true, mutates: true, feedbackPolicy: 'report-only', outputFormats: ['text'] },
  { name: 'netlog', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'inject', aliases: [], needsTarget: true, mutates: true, feedbackPolicy: 'state-change', outputFormats: ['text', 'json'] },
  { name: 'cascade', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'record', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'flow', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'repeat', aliases: [], needsTarget: true, mutates: false, outputFormats: ['text'] },
  { name: 'dismiss-modal', aliases: ['dismissmodal'], needsTarget: true, mutates: true, feedbackPolicy: 'settle-diff', outputFormats: ['text', 'json'] },
]);

const NEEDS_TARGET = new Set(
  COMMANDS
    .filter(command => command.needsTarget)
    .flatMap(command => [command.name, ...command.aliases])
);

function parseTargetAndCommandArgs(cmd, args) {
  let targetPrefix = args[0];
  let cmdArgs = args.slice(1);
  if (cmd === 'wait' && /^\d+$/.test(args[0] || '') && args[1] && !/^\d+$/.test(args[1] || '')) {
    targetPrefix = args[1];
    cmdArgs = [args[0], ...args.slice(2)];
  }
  return { targetPrefix, cmdArgs };
}

function formatCliError(err, { cmd = '', targetPrefix = '' } = {}) {
  const message = String(err?.message || err || '').trim();
  if (!message) return 'Error: unknown failure\nNext: cdp doctor';
  if (message.startsWith('Action failure:')) return message;
  const lines = [message.startsWith('Error:') ? message : `Error: ${message}`];
  if (/^Next:/m.test(message)) return lines.join('\n');

  const lower = message.toLowerCase();
  let next = null;
  if (
    lower.includes('cannot reach cdp') ||
    lower.includes('no devtoolsactiveport') ||
    lower.includes('websocket error') ||
    lower.includes('remote-debugging-port')
  ) {
    next = 'cdp doctor';
  } else if (
    lower.includes('target id required') ||
    lower.includes('no page list cached') ||
    lower.includes('no target matching prefix')
  ) {
    next = 'cdp list  # if empty: cdp open https://example.com';
  } else if (lower.includes('ambiguous prefix')) {
    next = 'cdp list  # copy a longer target prefix';
  } else if (
    lower.includes('connection closed before response') ||
    lower.includes('daemon failed to start') ||
    lower.includes('ipc timeout')
  ) {
    next = `cdp perceive ${targetPrefix || '<target>'} -C -d 8`;
  } else if (lower.includes('unknown command')) {
    next = 'cdp help';
  } else if ((cmd === 'nav' || cmd === 'navigate') && lower.includes('url required')) {
    next = `cdp nav ${targetPrefix || '<target>'} https://example.com`;
  } else {
    next = targetPrefix ? `cdp status ${targetPrefix}` : 'cdp doctor';
  }
  lines.push(`Next: ${next}`);
  return lines.join('\n');
}

function targetPrefixForDisplay(targetId) {
  return String(targetId || '').slice(0, 8) || '<target>';
}

function formatOpenReadyMessage(targetId, url = '') {
  const target = targetPrefixForDisplay(targetId);
  const lines = [
    'Tab ready — debugging approved.',
    `Target: ${target}${url ? `  ${url}` : ''}`,
    `Next: cdp click ${target} @ref  # choose a ref from the perception below`,
    `Then: cdp perceive ${target} --since-action`,
    `Report: cdp report ${target}`,
  ];
  return lines.join('\n');
}

function formatOpenTimeoutMessage(targetId) {
  const target = targetPrefixForDisplay(targetId);
  return [
    'Timeout waiting for debugging approval. Tab created but daemon not connected.',
    `Target: ${target}`,
    'If Chrome asks "Allow debugging?", click Allow first.',
    `Next: cdp perceive ${target} -C -d 8`,
  ].join('\n');
}

function formatOpenAutoPerceiveFailure(err, targetId) {
  const target = targetPrefixForDisplay(targetId);
  return [
    'Auto-perceive failed after the tab was attached.',
    formatCliError(err, { cmd: 'perceive', targetPrefix: target }),
  ].join('\n');
}

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
      console.log(formatOpenReadyMessage(targetId, url));
      // Auto-perceive: give agent immediate page understanding (matches nav behavior)
      try {
        const conn = await connectToSocket(sp);
        const resp = await sendCommand(conn, { cmd: 'perceive', args: [] });
        conn.end();
        if (resp.ok && resp.result) console.log('---\n' + resp.result);
      } catch (e) {
        console.error(formatOpenAutoPerceiveFailure(e, targetId));
      }
    } else {
      console.log(formatOpenTimeoutMessage(targetId));
    }
    return;
  }

  // Stop
  if (cmd === 'stop') {
    await stopDaemons(args[0]);
    return;
  }

  // Doctor / ready — one-call diagnostics, no target needed
  if (cmd === 'doctor' || cmd === 'ready') {
    const out = await doctorStr();
    console.log(out);
    process.exit(out.includes('Not ready') ? 1 : 0);
  }

  // spawn-debug-browser / spawn — launch isolated debug profile (no target)
  if (cmd === 'spawn-debug-browser' || cmd === 'spawn') {
    try {
      const out = await spawnDebugBrowserStr(args);
      console.log(out);
      process.exit(0);
    } catch (e) {
      console.error(formatCliError(e, { cmd }));
      process.exit(1);
    }
  }

  // Targetless wait: avoids shell sleep policy for simple delays.
  if (cmd === 'wait' && /^\d+$/.test(args[0] || '') && !args[1]) {
    console.log(await waitStr(args[0]));
    return;
  }

  // Page commands — need target prefix
  if (!NEEDS_TARGET.has(cmd)) {
    console.error(formatCliError(`Unknown command: ${cmd}`));
    console.error('');
    console.log(USAGE);
    process.exit(1);
  }

  let { targetPrefix, cmdArgs } = parseTargetAndCommandArgs(cmd, args);
  if (!targetPrefix) {
    console.error(formatCliError('target ID required. Run "cdp list" first.', { cmd }));
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
      console.error(formatCliError('No page list cached. Run "cdp list" first.', { cmd, targetPrefix }));
      process.exit(1);
    }
    const pages = JSON.parse(readFileSync(PAGES_CACHE, 'utf8'));
    targetId = resolvePrefix(targetPrefix, pages.map(p => p.targetId), 'target', 'Run "cdp list".');
  }

  const conn = await getOrStartTabDaemon(targetId);

  if (cmd === 'eval') {
    const fire = cmdArgs.includes('--fire-and-forget') || cmdArgs.includes('--faf');
    const b64Index = cmdArgs.findIndex(a => a === '--b64' || a === '-b');
    if (b64Index !== -1) {
      // eval --b64 <base64>: pass the flag and the (possibly chunked) base64
      // payload through to the daemon untouched. Shells split a long base64
      // blob across argv slots; rejoin without spaces.
      const b64 = cmdArgs.slice(b64Index + 1)
        .filter(a => a !== '--fire-and-forget' && a !== '--faf')
        .join('').trim();
      if (!b64) { console.error('Error: base64 expression required'); process.exit(1); }
      cmdArgs.splice(0, cmdArgs.length, ...(fire ? ['--fire-and-forget'] : []), '--b64', b64);
    } else {
      const expr = cmdArgs.filter(a => a !== '--fire-and-forget' && a !== '--faf').join(' ');
      if (!expr) { console.error('Error: expression required'); process.exit(1); }
      cmdArgs.splice(0, cmdArgs.length, ...(fire ? ['--fire-and-forget'] : []), expr);
    }
  } else if (cmd === 'eval64') {
    const b64 = cmdArgs.join('').trim();
    if (!b64) { console.error('Error: base64 expression required'); process.exit(1); }
    cmdArgs.splice(0, cmdArgs.length, b64);
  } else if (cmd === 'call') {
    const expr = cmdArgs.join(' ');
    if (!expr) { console.error('Error: expression required'); process.exit(1); }
    cmdArgs.splice(0, cmdArgs.length, expr);
  } else if (cmd === 'elshot') {
    if (!cmdArgs[0]) { console.error('Error: CSS selector required'); process.exit(1); }
  } else if (cmd === 'type') {
    // Join all remaining args as text (allows spaces)
    const text = cmdArgs.join(' ');
    if (!text) { console.error('Error: text required'); process.exit(1); }
    cmdArgs[0] = text;
  } else if (cmd === 'fill') {
    if (cmdArgs[0] === '--react') {
      if (!cmdArgs[1]) { console.error('Error: selector required'); process.exit(1); }
      const text = cmdArgs.slice(2).join(' ');
      if (!text) { console.error('Error: text required'); process.exit(1); }
      cmdArgs.splice(0, cmdArgs.length, '--react', cmdArgs[1], text);
    } else {
      if (!cmdArgs[0]) { console.error('Error: selector required'); process.exit(1); }
      if (cmdArgs.length > 2) cmdArgs[1] = cmdArgs.slice(1).join(' ');
    }
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
    const filtered = cmdArgs.filter(a => a !== '--parallel' && a !== '--plain' && a !== '--compact');
    if (!filtered[0]) { console.error('Error: commands required (pipe syntax or JSON array)'); process.exit(1); }
  } else if (cmd === 'flow') {
    if (!cmdArgs[0]) { console.error('Error: flow steps required (semicolon-separated). Example: flow <target> "click @1; wait dom stable; summary"'); process.exit(1); }
    // Preserve multi-word/unquoted step recipes as one daemon argument.
    cmdArgs.splice(0, cmdArgs.length, cmdArgs.join(' '));
  } else if (cmd === 'replay') {
    const jsonIndex = cmdArgs.findIndex(a => a === '--json');
    if (jsonIndex !== -1) {
      const jsonPayload = cmdArgs.slice(jsonIndex + 1).join(' ').trim();
      if (!jsonPayload) { console.error('Error: replay --json requires a record-actions JSON payload'); process.exit(1); }
      cmdArgs.splice(jsonIndex + 1, cmdArgs.length - jsonIndex - 1, jsonPayload);
    } else if (!cmdArgs[0]) {
      console.error('Error: replay requires --file <path> or --json <record-actions-json>');
      process.exit(1);
    }
  } else if (cmd === 'restore') {
    const jsonIndex = cmdArgs.findIndex(a => a === '--json');
    if (jsonIndex !== -1) {
      const jsonPayload = cmdArgs.slice(jsonIndex + 1).join(' ').trim();
      if (!jsonPayload) { console.error('Error: restore --json requires a checkpoint JSON payload'); process.exit(1); }
      cmdArgs.splice(jsonIndex + 1, cmdArgs.length - jsonIndex - 1, jsonPayload);
    } else if (!cmdArgs[0]) {
      console.error('Error: restore requires --file <path> or --json <checkpoint-json>');
      process.exit(1);
    }
  }

  if ((cmd === 'nav' || cmd === 'navigate') && !cmdArgs[0]) {
    console.error('Error: URL required');
    process.exit(1);
  }

  const response = await sendCommand(conn, { cmd, args: cmdArgs });

  if (response.ok) {
    if (response.result) console.log(response.result);
  } else {
    console.error(formatCliError(response.error, { cmd, targetPrefix }));
    process.exitCode = 1;
  }
}

// Test exports — only available when NODE_ENV=test to avoid side effects
if (process.env.NODE_ENV !== 'test') {
  main().catch(e => { console.error(formatCliError(e)); process.exit(1); });
}
export const __test__ = process.env.NODE_ENV === 'test' ? {
  // Data structures
  RingBuffer, CDP,
  // Utilities
  resolvePrefix, getDisplayPrefixLength, sockPath, isRef, validateUrl,
  // AX tree helpers
  shouldShowAxNode, formatAxNode, orderedAxChildren,
  // Perceive & snapshot
  parsePerceiveArgs, formatPerceiveDiffOutput, buildPerceiveTree, perceivePageScript, perceiveStr,
  createPerceptionModel, formatPerceptionJson, perceptionModelFromText, perceiveModel,
  createSessionState, invalidateSessionRefs,
  classifyActionFailure, formatActionFailure,
  createActionResult, formatActionText, runActionWithFeedback,
  createActionObservationBaseline, buildActionObservationDelta, applyActionObservationDelta,
  summarizeActionObservationEffects, shouldTrackActionNetworkRequest,
  appendSessionActionLog, appendSessionEventLog, appendSessionScreenshot,
  initializeSessionLog, formatSessionReport, sessionScreenshotDir,
  ensureSessionScreenshotDir, nextSessionScreenshotPath,
  buildRecordActionsModel, formatRecordActions,
  checkpointPageScript, sanitizeCheckpointCookies, checkpointModel, checkpointStr,
  parseCheckpointArtifact, parseRestoreArgs, redactRestoreCommandArgs,
  checkpointCookieToSetCookieParams, restoreStorageScript, restoreCheckpointStr,
  // Command implementations
  formatPageList, dialogStr, netlogStr, injectStr, cascadeStr, recordStr, parseRecordArgs,
  isTimeoutError, parseDelayMs, waitStr, ipcTimeoutForRequest, parseTargetAndCommandArgs,
  parseFormatArgs, formatJson, buildConsoleModel, buildStatusModel, summaryModel, formatSummaryText,
  evalStr, evalFireAndForgetStr, parseEvalArgs, callStr, formatCallResult, evalBase64Decode,
  navStr, clickStr, jsClickStr, fillStr, fillReactStr, waitForStr, snapshotStr,
  statusStr, runtimeMetricsStr, clearObservationBuffers,
  parseRepeatArgs, repeatStr,
  parseReplayArgs, parseReplayArtifact, replayStepFromAction, replayActionsStr,
  // 3y-mud feedback additions
  KEY_MAP, PUNCT_KEY_MAP, SHIFTED_PUNCT_KEY_MAP, keyForPress, pressStr,
  formatUnknownRefError, resolveRefNode, formatRefRect, isPriorityPerceiveTextLine,
  parseFrameOnlyRef, parseFrameRef, flattenFrameTree, formatFrameTreeText, framesModel, framesStr,
  resolveFrameRef, storeFrameScopedRefs, qualifyFrameRefsInLines, frameRefFromActionTarget,
  rememberFramePerceiveOutput, baselineOutputForActionTarget, frameViewportOffset,
  parseTextArgs, textPageScript, textStr,
  parseShotArgs, shotStr,
  parseSpawnDebugBrowserArgs, detectBrowserPath, buildSpawnDebugBrowserPlan, spawnDebugBrowserStr,
  overlayDetectorScript, formatOverlayReport, resolveOverlayTargetPoint, overlayStr,
  dismissModalStr, dismissModalScript,
  // Screenshot
  captureScreenshot, screencastFallback,
  resetScreenshotTier, getScreenshotTier, SCREENSHOT_TIMEOUT,
  // Constants
  ENRICHED_ROLES, INTERACTIVE_ROLES,
  // Cascade source mapping
  decodeVLQ, mapLineToSource, mapInlineSourceMap, stripVitePathQuery, mapStyleSource,
  // Batch / flow / doctor
  formatBatchResults, parseFlowSteps, settleFlow, flowStr,
  formatCliError, formatOpenReadyMessage, formatOpenTimeoutMessage, formatOpenAutoPerceiveFailure,
  checkNode, checkSkillSymlink, checkDaemonSockets, checkFdLimit, checkCdpReachability, checkBrowserTargets, checkBrowserPermission,
  doctorNextSteps, formatDoctorReport, runDoctorChecks, doctorStr,
  COMMANDS, NEEDS_TARGET,
} : undefined;
