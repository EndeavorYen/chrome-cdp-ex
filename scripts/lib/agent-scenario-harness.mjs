// Harness for the agent scenarios in validation/scenarios/ (spec: docs/audit/scenarios.md).
// A scenario module exports its spec and calls runScenario(); the module file is the registry
// entrypoint. Every run uses a disposable headless browser and loopback servers only.
//   node validation/scenarios/<file>.mjs --self-test   reference path + judge; exit 0 when the judge passes
//   node validation/scenarios/<file>.mjs --prepare     start the scenario for an agent, print a JSON handoff,
//                                                      judge on POST /judge, stop on POST /teardown
//   node validation/scenarios/<file>.mjs --print-spec  print the spec as JSON (no browser)
// CDP_SCENARIO_BROWSER=<path> picks the browser; otherwise Chrome for Testing from the Playwright cache,
// then the installed Chrome or Edge. CDP_SCENARIO_NO_SANDBOX=1 adds --no-sandbox (Ubuntu AppArmor).
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateSync } from 'node:zlib';

import { detectBrowserPath } from '../../skills/chrome-cdp-ex/scripts/lib/browser-paths.mjs';
import { discoverBrowserCandidates } from '../validation-live-boundary.mjs';
import { checkTestPort } from './port-guard.mjs';

export const rootDir = fileURLToPath(new URL('../..', import.meta.url));
const cdpScript = resolve(rootDir, 'skills/chrome-cdp-ex/scripts/cdp.mjs');
const binScript = resolve(rootDir, 'bin/chrome-cdp');
const CLI_TIMEOUT_MS = 60_000;
const EXIT_ENVIRONMENT = 2;

export const SCENARIO_TYPES = Object.freeze({
  1: 'logged-in admin setting saved with the session cookie',
  2: 'search to detail in an SPA without a URL change',
  3: 'modal blocks the click',
  4: 'form validation: fix and resubmit',
  5: 'same-site tabs: pick the right one',
  6: 'cross-origin iframe',
  7: 'virtual list and nested scroll',
  8: 'download or new window without losing the session',
  9: 'visual diff of two states without the default scanshot',
  10: 'console error with a source map',
  11: 'network failure with a next step',
  12: 'WebGL: screenshot versus perceive',
});
const SPEC_ARRAYS = ['startState', 'allowedOracle', 'successCondition', 'referencePath'];

export function assertSpec(spec) {
  const problems = [];
  if (!/^agent-\d\d-[a-z0-9-]+$/.test(spec?.id || '')) problems.push('id must look like agent-NN-name');
  if (!SCENARIO_TYPES[spec?.type]) problems.push('type must be 1-12');
  if (!['dynamic-app', 'static-page'].includes(spec?.kind)) problems.push('kind must be dynamic-app or static-page');
  for (const key of ['title', 'userWords']) if (typeof spec?.[key] !== 'string' || !spec[key].trim()) problems.push(`${key} is required`);
  for (const key of SPEC_ARRAYS) if (!Array.isArray(spec?.[key]) || spec[key].length === 0) problems.push(`${key} must be a non-empty array`);
  const listOf = (key, fields) => {
    if (!Array.isArray(spec?.[key]) || spec[key].length === 0) problems.push(`${key} must be a non-empty array`);
    else spec[key].forEach((item, i) => fields.forEach(f => { if (typeof item?.[f] !== 'string' || !item[f]) problems.push(`${key}[${i}].${f} is required`); }));
  };
  listOf('forbiddenShortcuts', ['id', 'description', 'detectedBy']);
  listOf('failureTaxonomy', ['code', 'description']);
  listOf('weakModelTraps', ['trap', 'refs']);
  if (problems.length) throw new Error(`scenario spec ${spec?.id || '?'}: ${problems.join('; ')}`);
  return spec;
}

// ---------- small HTTP helpers for the scenario apps ----------

export const APP_CSS = `
*{box-sizing:border-box}body{margin:0;font:14px/1.45 system-ui,"Segoe UI",sans-serif;color:#1f2328;background:#f6f8fa}
header.top{height:52px;display:flex;align-items:center;gap:24px;padding:0 20px;background:#24292f;color:#fff}
header.top a{color:#d0d7de;text-decoration:none}header.top .brand{font-weight:700;color:#fff}
header.top .who{margin-left:auto;font-size:13px;color:#d0d7de}
main{max-width:980px;margin:24px auto;padding:0 20px}
.card{background:#fff;border:1px solid #d0d7de;border-radius:8px;padding:20px;margin-bottom:16px}
label{display:block;margin:12px 0 4px;font-weight:600}
input,select,button,textarea{font:inherit}
input[type=text],input[type=email],input:not([type]),select{width:320px;padding:6px 10px;border:1px solid #d0d7de;border-radius:6px}
button{padding:6px 14px;border:1px solid #d0d7de;border-radius:6px;background:#f6f8fa;cursor:pointer}
button.primary{background:#1f883d;border-color:#1a7f37;color:#fff}button.danger{color:#cf222e}
button:disabled{opacity:.5;cursor:not-allowed}
.flash{padding:10px 14px;border-radius:6px;margin-bottom:16px}.flash.ok{background:#dafbe1}.flash.err{background:#ffebe9}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:8px;border-bottom:1px solid #d0d7de}
.muted{color:#656d76}.error{color:#cf222e;font-size:13px}
`;

export function page(title, body, { head = '', app = 'Acme' } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><style>${APP_CSS}</style>${head}</head>
<body data-app="${app}">${body}</body></html>`;
}

export function sendHtml(res, html, status = 200, headers = {}) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(html);
}

export function sendJson(res, status, value, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(value));
}

export function redirect(res, location, status = 303, headers = {}) {
  res.writeHead(status, { location, 'cache-control': 'no-store', ...headers });
  res.end();
}

export function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export async function readForm(req) {
  return Object.fromEntries(new URLSearchParams(await readBody(req)));
}

export async function readJson(req) {
  const text = await readBody(req);
  try { return JSON.parse(text || '{}'); } catch { return {}; }
}

export function cookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(/;\s*/).filter(Boolean).map(part => {
    const eq = part.indexOf('=');
    return eq < 0 ? [part, ''] : [part.slice(0, eq), decodeURIComponent(part.slice(eq + 1))];
  }));
}

export function randomToken(bytes = 18) {
  return createHash('sha256').update(`${Date.now()}:${Math.random()}:${process.pid}`).digest('base64url').slice(0, bytes * 4 / 3 | 0);
}

// True when a request looks like it came from the browser rather than curl, Node or Python.
export function fromBrowser(req) {
  return /Chrome\//.test(String(req.headers['user-agent'] || ''));
}

// ---------- raw CDP client for setup and judging (it never goes through cdp.mjs) ----------

class RawCdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.addEventListener('message', event => {
      const msg = JSON.parse(typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8'));
      if (!msg.id || !this.pending.has(msg.id)) return;
      const { resolveCall, reject, timer } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(timer);
      if (msg.error) reject(new Error(`${msg.error.message}${msg.error.data ? `: ${msg.error.data}` : ''}`));
      else resolveCall(msg.result || {});
    });
  }

  static connect(wsUrl) {
    return new Promise((resolveConnect, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.addEventListener('open', () => resolveConnect(new RawCdp(ws)), { once: true });
      ws.addEventListener('error', () => reject(new Error(`cannot connect to ${wsUrl}`)), { once: true });
    });
  }

  send(method, params = {}, sessionId, timeoutMs = 15_000) {
    const id = this.nextId++;
    return new Promise((resolveCall, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolveCall, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}

// ---------- browser, ports, servers ----------

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

// Ports the Fetch standard blocks: Node's fetch (and so cdp.mjs's /json/version probe) refuses them.
// Some Windows hosts hand these out from a low dynamic port range (6667 was seen here).
const FETCH_BAD_PORTS = new Set([1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95,
  101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513,
  514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049,
  3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080]);

async function testPort() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const port = await freePort();
    if (!FETCH_BAD_PORTS.has(port) && checkTestPort(port).ok) return port;
  }
  throw new Error('no free test port');
}

export function findBrowser(env = process.env) {
  if (env.CDP_SCENARIO_BROWSER) {
    if (!existsSync(env.CDP_SCENARIO_BROWSER)) throw new Error(`CDP_SCENARIO_BROWSER does not exist: ${env.CDP_SCENARIO_BROWSER}`);
    return [env.CDP_SCENARIO_BROWSER, 'explicit'];
  }
  const cft = discoverBrowserCandidates()[0];
  if (cft) return cft;
  for (const name of ['chrome', 'edge']) {
    const path = detectBrowserPath(name);
    if (path && existsSync(path)) return [path, name];
  }
  return null;
}

const delay = ms => new Promise(r => setTimeout(r, ms));

function writeProfilePreferences(profileDir, downloadDir) {
  mkdirSync(join(profileDir, 'Default'), { recursive: true });
  writeFileSync(join(profileDir, 'Default', 'Preferences'), JSON.stringify({
    download: { default_directory: downloadDir, prompt_for_download: false, directory_upgrade: true },
    profile: { default_content_setting_values: { automatic_downloads: 1 } },
  }));
}

async function launchBrowser({ browserPath, port, profileDir }) {
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1280,900',
    ...(/^(1|true|yes)$/i.test(process.env.CDP_SCENARIO_NO_SANDBOX || '') ? ['--no-sandbox'] : []),
    'about:blank',
  ];
  const child = spawn(browserPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-2000); });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`browser exited ${child.exitCode}: ${stderr.trim()}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) });
      if (res.ok) return { child, version: await res.json() };
    } catch {}
    await delay(150);
  }
  killTree(child); // the caller never receives this child, so it cannot stop it
  throw new Error(`browser did not open CDP on ${port}: ${stderr.trim()}`);
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' });
  else child.kill('SIGKILL');
}

// Time of the last request any scenario server saw; judges wait for quiet before reading state.
const activity = { lastRequestAt: 0, inFlight: 0 };

// Chrome refuses the same unsafe ports (net::ERR_UNSAFE_PORT), so app servers avoid them too.
async function listen(handler, host) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const listening = await listenOnce(handler, host);
    if (!FETCH_BAD_PORTS.has(listening.port)) return listening;
    await new Promise(r => listening.server.close(() => r()));
  }
  throw new Error('no safe port for a scenario server');
}

function listenOnce(handler, host) {
  return new Promise((resolveListen, reject) => {
    const server = createServer((req, res) => {
      activity.lastRequestAt = Date.now();
      activity.inFlight += 1;
      res.once('close', () => { activity.inFlight -= 1; activity.lastRequestAt = Date.now(); });
      Promise.resolve(handler(req, res)).catch(error => {
        if (!res.headersSent) sendJson(res, 500, { error: String(error?.message || error) });
      });
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolveListen({ server, port: server.address().port, host }));
  });
}

// ---------- the context handed to scenario code ----------

function createContext({ spec, workDir, port, cdp, browserVersion }) {
  const runtimeDir = join(workDir, 'runtime');
  const downloadDir = join(workDir, 'downloads');
  const browserDownloadDir = join(workDir, 'browser-downloads');
  for (const dir of [runtimeDir, downloadDir, browserDownloadDir]) mkdirSync(dir, { recursive: true });
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^CDP_/.test(key)) delete env[key];
  Object.assign(env, {
    CDP_PORT: String(port),
    CDP_HOST: '127.0.0.1',
    NODE_ENV: 'production',
    ...(process.platform === 'win32' ? { LOCALAPPDATA: runtimeDir } : { XDG_RUNTIME_DIR: runtimeDir }),
  });
  const ctx = {
    spec,
    workDir,
    runtimeDir,
    downloadDir,
    browserDownloadDir,
    port,
    cdp,
    browserVersion,
    cliEnv: env,
    servers: {},
    state: {},
    transcript: [],
    secrets: [],
    url(name, path = '/') {
      const server = ctx.servers[name];
      if (!server) throw new Error(`unknown server ${name}`);
      return `http://${server.host}:${server.port}${path}`;
    },
    // Async on purpose: a blocked event loop would stop this process reading its own CDP socket.
    cli(...args) {
      const t0 = Date.now();
      return new Promise(resolveRun => {
        const child = spawn(process.execPath, [cdpScript, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
        child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
        const timer = setTimeout(() => child.kill(), CLI_TIMEOUT_MS);
        child.on('close', code => {
          clearTimeout(timer);
          const entry = { args, exit: code, startedAt: t0, ms: Date.now() - t0, stdout, stderr };
          ctx.transcript.push(entry);
          resolveRun(entry);
        });
      });
    },
    async openTab(url, { activate = false } = {}) {
      const { targetId } = await cdp.send('Target.createTarget', { url });
      if (activate) await cdp.send('Target.activateTarget', { targetId });
      return targetId;
    },
    async activate(targetId) {
      await cdp.send('Target.activateTarget', { targetId });
    },
    // The browser starts on about:blank; a scenario's tabs replace it.
    async closeBlankTabs() {
      for (const tab of await ctx.tabs()) {
        if (tab.url === 'about:blank') await cdp.send('Target.closeTarget', { targetId: tab.targetId }).catch(() => {});
      }
    },
    async tabs() {
      const { targetInfos } = await cdp.send('Target.getTargets');
      return targetInfos.filter(t => t.type === 'page');
    },
    async evaluate(targetId, expression, { timeoutMs = 10_000 } = {}) {
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      try {
        const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId, timeoutMs);
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
        return result.result?.value;
      } finally {
        await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
      }
    },
    async waitFor(targetId, expression, { timeoutMs = 8000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      let last;
      while (Date.now() < deadline) {
        try {
          last = await ctx.evaluate(targetId, expression);
          if (last) return last;
        } catch (error) {
          last = `error: ${error.message}`; // not ready yet (e.g. still about:blank); keep waiting
        }
        await delay(100);
      }
      throw new Error(`timed out waiting for ${expression} (last: ${JSON.stringify(last)})`);
    },
    // Opens url in a new tab (same cookie jar as the agent's tabs), waits until that document has
    // loaded, evaluates expression there, and closes the tab. Returns { path, value }.
    async readFreshTab(url, expression, { timeoutMs = 8000 } = {}) {
      const targetId = await ctx.openTab(url);
      try {
        const loaded = await ctx.waitFor(targetId, `location.href !== 'about:blank' && document.readyState === 'complete' && location.pathname`, { timeoutMs });
        return { path: loaded, value: await ctx.evaluate(targetId, expression) };
      } finally {
        await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
      }
    },
    async setCookie({ name, value, url, httpOnly = true, sameSite = 'Lax' }) {
      await cdp.send('Storage.setCookies', { cookies: [{ name, value, url, path: '/', httpOnly, sameSite }] });
      ctx.secrets.push(value);
    },
    prefix(targetId) {
      return String(targetId).slice(0, 8);
    },
    // Waits until no scenario server has had a request in flight for quietMs (max timeoutMs).
    async quiet({ quietMs = 750, timeoutMs = 15_000 } = {}) {
      const start = Date.now();
      const deadline = start + timeoutMs;
      while (Date.now() < deadline) {
        if (activity.inFlight === 0 && Date.now() - Math.max(activity.lastRequestAt, start) >= quietMs) return true;
        await delay(100);
      }
      return false;
    },
  };
  return ctx;
}

// ---------- judging helpers ----------

export function transcriptText(transcript = []) {
  return transcript.map(entry => `${entry.stdout || ''}${entry.stderr || ''}`).join('\n');
}

export function commandLines(transcript = []) {
  return transcript.map(entry => (Array.isArray(entry.args) ? entry.args.join(' ') : String(entry.command || '')));
}

export function verdict(checks) {
  const failures = checks.filter(check => !check.ok).map(check => ({ code: check.code, detail: check.detail || '' }));
  return { pass: failures.length === 0, failures, checks: checks.map(check => ({ code: check.code, ok: check.ok, detail: check.detail || '' })) };
}

// Checks every scenario shares: no secret value in what the agent read.
export function commonChecks(ctx, { transcript = [] } = {}) {
  const text = transcriptText(transcript);
  const leaked = ctx.secrets.filter(secret => secret && text.includes(secret));
  return [{ code: 'secret-leak', ok: leaked.length === 0, detail: leaked.length ? `${leaked.length} secret value(s) printed` : '' }];
}

// Finds `@N` for the first `[role] name` line of a perceive tree whose name matches exactly
// (ignoring a trailing `= "value"` and state words such as `checked`).
const STATE_SUFFIX = /\s+(?:checked|unchecked|selected|disabled|expanded|collapsed|pressed|focused|required|invalid|readonly)(?:=\S*)?(?:\s.*)?$/;
export function refFor(perceiveOutput, role, name) {
  for (const line of String(perceiveOutput).split('\n')) {
    const m = line.match(/^\s*\[([^\]]+)\]\s+(.*?)\s+(@(?:f\d+:)?\d+)\b/);
    if (!m) continue;
    const label = m[2].replace(/\s+=\s+".*"$/, '').replace(STATE_SUFFIX, '').trim();
    if (m[1] === role && label === name) return m[3];
  }
  return null;
}

// Like refFor, but only after the first line that matches anchor (a row label, a section heading).
export function refAfter(perceiveOutput, anchor, role, name) {
  const lines = String(perceiveOutput).split('\n');
  const start = lines.findIndex(line => anchor.test(line));
  return start < 0 ? null : refFor(lines.slice(start).join('\n'), role, name);
}

// Minimal PNG reader (8-bit RGB or RGBA, no interlace): enough for the reference paths to "look at"
// a screenshot the way an agent would. Returns { width, height, pixel(x, y) -> [r, g, b, a] }.
export function decodePng(buffer) {
  const sig = '89504e470d0a1a0a';
  if (buffer.subarray(0, 8).toString('hex') !== sig) throw new Error('not a PNG');
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('latin1');
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0) throw new Error('only 8-bit non-interlaced PNG is supported');
      colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!channels) throw new Error(`PNG color type ${colorType} is not supported`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? out[y * stride + x - channels] : 0;
      const up = y > 0 ? out[(y - 1) * stride + x] : 0;
      const upLeft = y > 0 && x >= channels ? out[(y - 1) * stride + x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      out[y * stride + x] = value & 0xff;
    }
  }
  return {
    width,
    height,
    pixel(x, y) {
      const i = y * stride + x * channels;
      return [out[i], out[i + 1], out[i + 2], channels === 4 ? out[i + 3] : 255];
    },
  };
}

// The words a user would type; {downloadDir} becomes this run's requested folder.
export function userWordsFor(spec, ctx) {
  return spec.userWords.replaceAll('{downloadDir}', ctx?.downloadDir || '<download dir>');
}

export function prefixFromList(listOutput, predicate) {
  for (const line of String(listOutput).split('\n')) {
    const m = line.match(/^([0-9A-F]{8})\s+(.*?)\s{2,}(\S+)/);
    if (m && predicate({ prefix: m[1], title: m[2].trim(), url: m[3] })) return m[1];
  }
  return null;
}

// ---------- run modes ----------

export async function startScenario(module) {
  const spec = assertSpec(module.scenario);
  const found = findBrowser();
  if (!found) {
    const error = new Error('no Chrome for Testing, Chrome or Edge binary found; set CDP_SCENARIO_BROWSER');
    error.environment = true;
    throw error;
  }
  const [browserPath, browserName] = found;
  const workDir = mkdtempSync(join(tmpdir(), `chrome-cdp-ex-${spec.id}-`));
  const port = await testPort();
  // The browser's own download folder differs from the folder a scenario asks for (scenario 8).
  writeProfilePreferences(join(workDir, 'profile'), join(workDir, 'browser-downloads'));
  let browser = null;
  let cdp = null;
  const servers = [];
  const stop = async () => {
    try { cdp?.close(); } catch {}
    killTree(browser?.child);
    await Promise.allSettled(servers.map(s => new Promise(r => s.server.close(() => r()))));
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try { rmSync(workDir, { recursive: true, force: true }); break; } catch { await delay(300); }
    }
  };
  try {
    browser = await launchBrowser({ browserPath, port, profileDir: join(workDir, 'profile') });
    cdp = await RawCdp.connect(browser.version.webSocketDebuggerUrl);
    const ctx = createContext({ spec, workDir, port, cdp, browserVersion: browser.version.Browser });
    ctx.browserName = browserName;
    const apps = module.createApps(ctx);
    for (const [name, app] of Object.entries(apps)) {
      const listening = await listen(app.handler, app.host || '127.0.0.1');
      servers.push(listening);
      ctx.servers[name] = { host: listening.host, port: listening.port };
    }
    await module.setup(ctx);
    return { ctx, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

// CLI calls and app requests (scenarios that log `{ at, method, path }` in ctx.state.log) on one clock.
function printTimeline(ctx, t0) {
  const rows = [
    ...ctx.transcript.flatMap(e => [
      { at: e.startedAt, text: `cli start  cdp ${e.args.join(' ')}` },
      { at: e.startedAt + e.ms, text: `cli end    exit ${e.exit} (${e.ms} ms)` },
    ]),
    ...(Array.isArray(ctx.state.log) ? ctx.state.log.filter(r => r.at).map(r => ({ at: r.at, text: `app        ${r.method} ${r.path}` })) : []),
  ].sort((a, b) => a.at - b.at);
  for (const row of rows) console.log(`${String(row.at - t0).padStart(7)} ms  ${row.text}`);
}

async function selfTest(module) {
  const t0 = Date.now();
  const { ctx, stop } = await startScenario(module);
  try {
    const { answer = '' } = (await module.reference(ctx)) || {};
    await ctx.quiet();
    const result = await module.judge(ctx, { answer, transcript: ctx.transcript });
    const chars = transcriptText(ctx.transcript).length;
    const summary = `${ctx.transcript.length} CLI call(s), ${chars} chars, ${Math.round((Date.now() - t0) / 100) / 10} s, ${ctx.browserVersion}`;
    if (!result.pass) {
      console.log(JSON.stringify({ id: ctx.spec.id, answer, result }, null, 2));
      for (const entry of ctx.transcript) console.log(`$ cdp ${entry.args.join(' ')}  (exit ${entry.exit})\n${(entry.stdout + entry.stderr).trim().slice(0, 1200)}`);
      if (process.argv.includes('--timeline')) printTimeline(ctx, t0);
      throw new Error(`judge failed: ${result.failures.map(f => `${f.code}${f.detail ? ` (${f.detail})` : ''}`).join(', ')}`);
    }
    if (process.argv.includes('--verbose')) {
      for (const entry of ctx.transcript) console.log(`$ cdp ${entry.args.join(' ')}  (exit ${entry.exit}, ${entry.ms} ms)\n${(entry.stdout + entry.stderr).trim()}`);
      console.log(`answer: ${answer}`);
    }
    if (process.argv.includes('--timeline')) printTimeline(ctx, t0);
    const trapNote = module.trap ? await trapTest(module) : '';
    console.log(`Scenario ${ctx.spec.id} OK: reference path passed the judge; ${summary}${trapNote}`);
  } finally {
    await stop();
  }
}

// A scenario may export trap(ctx) -> { answer, expect: [failure codes] }: a known-bad path (usually the
// weak-model trap) run in a fresh browser. The judge must fail it with every expected code, which shows
// the oracle can tell the trap from the reference path.
async function trapTest(module) {
  const { ctx, stop } = await startScenario(module);
  try {
    const { answer = '', expect = [] } = (await module.trap(ctx)) || {};
    await ctx.quiet();
    const result = await module.judge(ctx, { answer, transcript: ctx.transcript });
    const codes = result.failures.map(f => f.code);
    const missing = expect.filter(code => !codes.includes(code));
    if (result.pass || missing.length) {
      for (const entry of ctx.transcript) console.log(`$ cdp ${entry.args.join(' ')}  (exit ${entry.exit})\n${(entry.stdout + entry.stderr).trim().slice(0, 1200)}`);
      throw new Error(`trap path was not caught: expected ${expect.join(', ')}, judge reported ${codes.join(', ') || 'pass'}`);
    }
    return `; trap path failed as expected (${codes.join(', ')})`;
  } finally {
    await stop();
  }
}

async function prepare(module) {
  const ttlMs = Number(process.env.CDP_SCENARIO_TTL_MS || 45 * 60_000);
  const { ctx, stop } = await startScenario(module);
  let done = false;
  const finish = async code => {
    if (done) return;
    done = true;
    await stop();
    process.exit(code);
  };
  const control = await listen(async (req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    if (req.method === 'POST' && path === '/judge') {
      const body = await readJson(req);
      await ctx.quiet();
      const result = await module.judge(ctx, { answer: String(body.answer || ''), transcript: Array.isArray(body.transcript) ? body.transcript : [] });
      sendJson(res, 200, { id: ctx.spec.id, ...result });
      return;
    }
    if (req.method === 'POST' && path === '/teardown') {
      sendJson(res, 200, { ok: true });
      setTimeout(() => finish(0), 50);
      return;
    }
    if (path === '/spec') { sendJson(res, 200, ctx.spec); return; }
    sendJson(res, 404, { error: 'not found' });
  }, '127.0.0.1');
  const runtimeKey = process.platform === 'win32' ? 'LOCALAPPDATA' : 'XDG_RUNTIME_DIR';
  console.log(JSON.stringify({
    schema: 'chrome-cdp-ex.agent-scenario-handoff.v1',
    id: ctx.spec.id,
    userWords: userWordsFor(ctx.spec, ctx),
    env: { CDP_PORT: ctx.cliEnv.CDP_PORT, CDP_HOST: '127.0.0.1', [runtimeKey]: ctx.runtimeDir },
    cli: [process.execPath, binScript],
    downloadDir: ctx.downloadDir,
    judge: `http://127.0.0.1:${control.port}/judge`,
    teardown: `http://127.0.0.1:${control.port}/teardown`,
    expiresInMs: ttlMs,
  }));
  process.on('SIGINT', () => finish(130));
  process.on('SIGTERM', () => finish(143));
  setTimeout(() => finish(0), ttlMs).unref();
  await new Promise(() => {});
}

export function runScenario(moduleUrl, module) {
  if (pathToFileURL(process.argv[1] || '').href !== moduleUrl) return;
  const mode = process.argv.includes('--prepare') ? 'prepare' : process.argv.includes('--print-spec') ? 'spec' : 'self-test';
  const run = mode === 'spec'
    ? async () => console.log(JSON.stringify(assertSpec(module.scenario), null, 2))
    : mode === 'prepare' ? () => prepare(module) : () => selfTest(module);
  run().catch(error => {
    console.error(`Scenario ${module.scenario?.id || '?'} ${error.environment ? 'environment' : 'failed'}: ${error.message}`);
    process.exitCode = error.environment ? EXIT_ENVIRONMENT : 1;
  });
}
