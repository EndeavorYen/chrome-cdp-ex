#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { acquireLiveBenchmarkLock } from './benchmark-run-lock.mjs';
import { buildDisposableBrowserArgs, discoverBrowserCandidates } from './validation-live-boundary.mjs';
import { monitorDisposableBrowser } from './validation-phase4-slices.mjs';

const USAGE = 'Usage: node scripts/validation-table-collection.mjs --static-check | --allow-live';
const EXTRACTION_IMPORT_RE = /from\s+['"][^'"]*(?:table-extraction|table-artifacts|table-contract)[^'"]*['"]/;
const ROOT_DIR = fileURLToPath(new URL('..', import.meta.url));
const CDP_PATH = resolve(ROOT_DIR, 'skills/chrome-cdp-ex/scripts/cdp.mjs');
const FROZEN_STATUSES = Object.freeze(['queued', 'ready', 'blocked', 'done']);

export const TABLE_COLLECTION_ROUTES = Object.freeze(['cli', 'mcp', 'mcp-run-command', 'playwright']);
export const MAX_PAYLOAD_EVIDENCE_BYTES = 1024;
export const TABLE_COLLECTION_DEADLINE = Object.freeze({
  maxDurationMs: 600_000,
  cdpTimeoutMs: 295_000,
  playwrightTimeoutMs: 295_000,
  serverTimeoutMs: 300_000,
});
const FIXTURE_LISTEN_HOST = '127.0.0.1';
const PERSONAL_USER_DATA_DIR_RE = /(?:^|\/)(?:library\/application support\/(?:google\/chrome|microsoft edge)|\.config\/(?:google-chrome|chromium)|(?:google\/chrome|microsoft\/edge)\/user data)(?:\/|$)/i;
const BOUNDED_STRING_KEYS = Object.freeze(['stdout', 'text']);
export const TABLE_COLLECTION_FIXTURE = Object.freeze({
  logicalRows: 1024,
  headerRows: 1,
  ariaRowCount: 1025,
  columns: 4,
  mountedRows: 12,
  rowHeightPx: 32,
  initialAvailable: 128,
  loadIncrement: 64,
  loadMoreClicks: 14,
  bodyBytes: 31104,
  checksum: '73e9f36080b8c781e204857ad9c7dcf4ce7ce419b1503d9affd0343f58f964ed',
  selector: '#virtual-grid',
  scrollContainer: '#grid-scrollport',
  loadMore: '#load-more',
});
export const CLEANUP_ORDER = Object.freeze([
  'chrome-daemon',
  'chrome-browser',
  'playwright',
  'fixture-server',
  'processes',
  'endpoints-and-ports',
  'profile-runtime-artifacts',
  'task-root',
  'lock',
]);
const CLEANUP_STEPS = Object.freeze([
  ['stopChromeDaemon', 'chrome-daemon'],
  ['stopChromeBrowser', 'chrome-browser'],
  ['closePlaywright', 'playwright'],
  ['closeServer', 'fixture-server'],
  ['assertNoTaskProcesses', 'processes'],
  ['assertEndpointsAndPortsGone', 'endpoints-and-ports'],
  ['removeProfileRuntimeArtifacts', 'profile-runtime-artifacts'],
  ['removeAndVerifyTaskRoot', 'task-root'],
  ['assertLockReleased', 'lock'],
]);
const ROUTE_PORTS = Object.freeze({
  cli: Object.freeze({ portStart: 9624, serverPortStart: 42824 }),
  mcp: Object.freeze({ portStart: 9634, serverPortStart: 42834 }),
  'mcp-run-command': Object.freeze({ portStart: 9644, serverPortStart: 42844 }),
  playwright: Object.freeze({ portStart: 9654, serverPortStart: 42854 }),
});
const ROUTE_KINDS = Object.freeze({
  cli: Object.freeze({
    kind: 'direct-cli-collect',
    browser: 'fresh-cft-about-blank',
    reset: Object.freeze(['browser', 'target', 'profile', 'runtime']),
  }),
  mcp: Object.freeze({
    kind: 'first-class-mcp-collect',
    browser: 'fresh-cft-about-blank',
    reset: Object.freeze(['browser', 'target', 'profile', 'runtime']),
  }),
  'mcp-run-command': Object.freeze({
    kind: 'mcp-run-command-collect',
    browser: 'fresh-cft-about-blank',
    reset: Object.freeze(['browser', 'target', 'profile', 'runtime']),
  }),
  playwright: Object.freeze({
    kind: 'independent-playwright-oracle',
    browser: 'fresh-wrapper-loopback-fixture',
    reset: Object.freeze(['browser', 'target', 'profile', 'runtime']),
    importsProductExtraction: false,
  }),
});

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export function parseArgs(argv) {
  invariant(Array.isArray(argv), 'validation table-collection arguments must be an array');
  if (argv.length === 0) throw new Error(USAGE);
  const options = { command: null, allowLive: false };
  for (const arg of argv) {
    if (arg === '--static-check') options.command = 'static-check';
    else if (arg === '--allow-live') {
      options.command = 'live';
      options.allowLive = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!options.command) throw new Error(USAGE);
  return options;
}

export function describeRouteFixture(route) {
  invariant(TABLE_COLLECTION_ROUTES.includes(route), `unknown table-collection route: ${route}`);
  const ports = ROUTE_PORTS[route];
  const kind = ROUTE_KINDS[route];
  return {
    route,
    kind: kind.kind,
    browser: kind.browser,
    reset: [...kind.reset],
    chromeStartUrl: 'about:blank',
    listenHost: FIXTURE_LISTEN_HOST,
    portStart: ports.portStart,
    serverPortStart: ports.serverPortStart,
    profilePrefix: `chrome-cdp-ex-table-${route}`,
    runtimePrefix: `chrome-cdp-ex-table-runtime-${route}`,
  };
}

function assertDisposableUserDataDir(profileDir) {
  invariant(typeof profileDir === 'string' && profileDir.trim(), 'profileDir is required');
  const normalized = resolve(profileDir).replaceAll('\\', '/');
  invariant(!PERSONAL_USER_DATA_DIR_RE.test(normalized), 'personal Chrome user-data-dir is forbidden');
  return normalized;
}

export function allocateRouteFixture(route, { taskRoot, slot = 0 } = {}) {
  const described = describeRouteFixture(route);
  const root = taskRoot || mkdtempSync(join(tmpdir(), `${described.profilePrefix}-${slot}-`));
  assertDisposableUserDataDir(root);
  const profileDir = join(root, 'profile');
  assertDisposableUserDataDir(profileDir);
  return {
    ...described,
    slot,
    taskRoot: root,
    profileDir,
    runtimeDir: join(root, 'runtime'),
    port: described.portStart + slot,
    serverPort: described.serverPortStart + slot,
    browserInstanceId: `browser-${route}-${slot}`,
    profileToken: `profile-${route}-${slot}`,
  };
}

export function assertIndependentRouteFixtures(fixtures) {
  invariant(Array.isArray(fixtures) && fixtures.length === TABLE_COLLECTION_ROUTES.length, 'four route fixtures required');
  invariant(
    fixtures.every((fixture, index) => fixture?.route === TABLE_COLLECTION_ROUTES[index]),
    'route fixtures must match the frozen four-route order',
  );
  const identityKeys = [
    'profilePrefix', 'runtimePrefix', 'portStart', 'serverPortStart',
    'profileDir', 'runtimeDir', 'taskRoot', 'port', 'serverPort',
    'browserInstanceId', 'profileToken',
  ];
  for (const key of identityKeys) {
    const values = fixtures.map(fixture => fixture[key]).filter(value => value !== undefined);
    if (values.length === 0) continue;
    invariant(new Set(values).size === values.length, `routes require independent ${key}`);
  }
  return true;
}

export function buildChromeLaunchArgs({ port, profileDir }) {
  assertDisposableUserDataDir(profileDir);
  const base = buildDisposableBrowserArgs({ port, profileDir, url: 'about:blank' });
  return [
    ...base.slice(0, -1),
    '--remote-debugging-address=127.0.0.1',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    'about:blank',
  ];
}

export function buildChromeFixtureProvisionExpression(documentHtml) {
  invariant(typeof documentHtml === 'string' && documentHtml.trim(), 'Chrome fixture document is missing');
  return `(() => {
    document.open();
    document.write(${JSON.stringify(documentHtml)});
    document.close();
    const oracle = window.__tableCollectionOracle?.state?.() || null;
    return {
      title: document.title,
      readyState: document.readyState,
      loadedRows: oracle?.loadedRows ?? null,
      mountedRows: oracle?.mountedRows ?? null,
      loadMoreClicks: oracle?.loadMoreClicks ?? null,
    };
  })()`;
}

export function buildLoopbackFixtureUrl(port) {
  invariant(Number.isInteger(port) && port > 0 && port <= 65535, 'loopback fixture port is invalid');
  return `http://127.0.0.1:${port}/validation-table-collection.html`;
}

export function listenTableCollectionFixtureServer(server, { port, host } = {}) {
  return new Promise((resolveListen, reject) => {
    try {
      invariant(server && typeof server.listen === 'function', 'fixture server is required');
      invariant(Number.isInteger(port) && port > 0 && port <= 65535, 'loopback fixture port is invalid');
      invariant(host === undefined || host === FIXTURE_LISTEN_HOST, 'fixture server must listen on 127.0.0.1');
      server.once?.('error', reject);
      server.listen(port, FIXTURE_LISTEN_HOST, resolveListen);
    } catch (error) {
      reject(error);
    }
  });
}

export function createTableCollectionDeadline(overrides = {}, { parentSignal } = {}) {
  const budget = {
    maxDurationMs: overrides.maxDurationMs ?? TABLE_COLLECTION_DEADLINE.maxDurationMs,
    cdpTimeoutMs: overrides.cdpTimeoutMs ?? TABLE_COLLECTION_DEADLINE.cdpTimeoutMs,
    playwrightTimeoutMs: overrides.playwrightTimeoutMs ?? TABLE_COLLECTION_DEADLINE.playwrightTimeoutMs,
    serverTimeoutMs: overrides.serverTimeoutMs ?? TABLE_COLLECTION_DEADLINE.serverTimeoutMs,
  };
  for (const key of Object.keys(TABLE_COLLECTION_DEADLINE)) {
    invariant(Number.isInteger(budget[key]) && budget[key] > 0, `deadline.${key} is invalid`);
  }
  invariant(budget.cdpTimeoutMs <= budget.maxDurationMs, 'deadline.cdpTimeoutMs exceeds maxDurationMs');
  invariant(budget.playwrightTimeoutMs <= budget.maxDurationMs, 'deadline.playwrightTimeoutMs exceeds maxDurationMs');
  invariant(budget.serverTimeoutMs <= budget.maxDurationMs, 'deadline.serverTimeoutMs exceeds maxDurationMs');
  const trial = AbortSignal.timeout(budget.maxDurationMs);
  const compose = timeoutMs => AbortSignal.any(
    [trial, AbortSignal.timeout(timeoutMs), parentSignal].filter(Boolean),
  );
  return Object.freeze({
    ...budget,
    signals: Object.freeze({
      trial,
      cdp: compose(budget.cdpTimeoutMs),
      playwright: compose(budget.playwrightTimeoutMs),
      server: compose(budget.serverTimeoutMs),
    }),
  });
}

export function assertLoopbackOnlyUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('loopback fixture URL is invalid');
  }
  invariant(parsed.protocol === 'http:', 'loopback fixture URL must use http');
  invariant(parsed.hostname === '127.0.0.1', 'loopback fixture URL must bind 127.0.0.1');
  invariant(parsed.pathname === '/validation-table-collection.html', 'loopback fixture path mismatch');
  const port = Number(parsed.port);
  invariant(Number.isInteger(port) && port > 0, 'loopback fixture port is invalid');
  return { host: '127.0.0.1', port };
}

function collectArgv(targetId) {
  invariant(typeof targetId === 'string' && targetId, 'collect targetId is required');
  return [
    'table', targetId, TABLE_COLLECTION_FIXTURE.selector, '--collect',
    '--scroll-container', TABLE_COLLECTION_FIXTURE.scrollContainer,
    '--load-more', TABLE_COLLECTION_FIXTURE.loadMore, '--format', 'json',
  ];
}

export function buildCliCollectArgv(targetId) {
  return collectArgv(targetId);
}

export function buildFirstClassMcpCollectParams(targetId) {
  invariant(typeof targetId === 'string' && targetId, 'collect targetId is required');
  return {
    name: 'table',
    arguments: {
      target: targetId,
      selector: TABLE_COLLECTION_FIXTURE.selector,
      collect: true,
      scrollContainer: TABLE_COLLECTION_FIXTURE.scrollContainer,
      loadMore: TABLE_COLLECTION_FIXTURE.loadMore,
      confirm: true,
    },
  };
}

export function buildRunCommandMcpCollectParams(targetId) {
  return {
    name: 'run_command',
    arguments: {
      command: 'table',
      args: collectArgv(targetId).slice(1),
      confirm: true,
    },
  };
}

export function playwrightOracleProbeSource() {
  return `async (page) => {
    const initial = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('#virtual-grid-body tr')];
      window.__tableOracleSlots = rows;
      return {
        logicalRows: 1024,
        mountedRows: rows.length,
      };
    });
    let clicks = 0;
    while (await page.locator('#load-more').count()) {
      await page.locator('#load-more').click();
      clicks += 1;
      if (clicks > 16) throw new Error('load-more click cap exceeded');
    }
    const recycled = await page.evaluate(() => {
      const current = [...document.querySelectorAll('#virtual-grid-body tr')];
      return current.length === 12 && current.every((node, index) => node === window.__tableOracleSlots[index]);
    });
    const collected = await page.evaluate(async () => {
      const port = document.querySelector('#grid-scrollport');
      const rows = new Map();
      const starts = [];
      for (let start = 0; start <= 1012; start += 12) starts.push(start);
      if (starts.at(-1) !== 1012) starts.push(1012);
      for (const start of starts) {
        port.scrollTop = start * 32;
        port.dispatchEvent(new Event('scroll'));
        for (const tr of document.querySelectorAll('#virtual-grid-body tr')) {
          const index = Number(tr.getAttribute('aria-rowindex')) - 1;
          if (!Number.isInteger(index) || index < 1) continue;
          rows.set(index, [...tr.querySelectorAll('th,td')].map(cell => cell.textContent).join('\\t'));
        }
      }
      const body = Array.from({ length: 1024 }, (_, offset) => rows.get(offset + 1)).join('\\n');
      const bytes = new TextEncoder().encode(body);
      const hash = await crypto.subtle.digest('SHA-256', bytes);
      return {
        uniqueIndexes: rows.size,
        checksum: [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join(''),
      };
    });
    return {
      logicalRows: initial.logicalRows,
      uniqueIndexes: collected.uniqueIndexes,
      mountedRows: initial.mountedRows,
      recycledNodes: recycled ? 12 : 0,
      loadMoreClicks: clicks,
      checksum: collected.checksum,
    };
  }`;
}

export function assertPlaywrightOracleIndependence(source) {
  invariant(typeof source === 'string' && source, 'oracle source is required');
  invariant(!EXTRACTION_IMPORT_RE.test(source), 'Playwright oracle must not import chrome-cdp-ex extraction code');
  return { importsProductExtraction: false };
}

export function buildStaticReadiness() {
  return {
    schema: 'chrome-cdp-ex.validation-table-collection.readiness.v1',
    ready: true,
    browserStarted: false,
    chromeStartUrl: 'about:blank',
    chromeProvisioning: 'direct Runtime.evaluate document.open/write/close into about:blank',
    fixtureHost: '127.0.0.1',
    listenHost: FIXTURE_LISTEN_HOST,
    deadline: { ...TABLE_COLLECTION_DEADLINE },
    routes: Object.fromEntries(TABLE_COLLECTION_ROUTES.map(route => [route, { ...ROUTE_KINDS[route] }])),
    fixture: {
      logicalRows: TABLE_COLLECTION_FIXTURE.logicalRows,
      mountedRows: TABLE_COLLECTION_FIXTURE.mountedRows,
      initialAvailable: TABLE_COLLECTION_FIXTURE.initialAvailable,
      loadMoreClicks: TABLE_COLLECTION_FIXTURE.loadMoreClicks,
      checksum: TABLE_COLLECTION_FIXTURE.checksum,
    },
    cleanupOrder: [...CLEANUP_ORDER],
  };
}

export function retainBoundedCommandEvidence(record) {
  invariant(record && typeof record === 'object', 'command evidence record is required');
  const stdout = typeof record.stdout === 'string' ? record.stdout : '';
  const raw = Buffer.from(stdout, 'utf8');
  const prefixBytes = Math.min(raw.byteLength, Math.ceil(MAX_PAYLOAD_EVIDENCE_BYTES / 2));
  const suffixBytes = raw.byteLength > prefixBytes
    ? Math.min(raw.byteLength - prefixBytes, Math.floor(MAX_PAYLOAD_EVIDENCE_BYTES / 2))
    : 0;
  return {
    phase: record.phase,
    argv: record.argv,
    status: record.status,
    payload: {
      totalBytes: raw.byteLength,
      sha256: createHash('sha256').update(raw).digest('hex'),
      prefix: raw.subarray(0, prefixBytes).toString('utf8'),
      suffix: suffixBytes ? raw.subarray(raw.byteLength - suffixBytes).toString('utf8') : '',
      truncated: prefixBytes + suffixBytes < raw.byteLength,
    },
    stderr: record.stderr,
  };
}

function boundPayload(value) {
  const raw = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
  const prefixBytes = Math.min(raw.byteLength, Math.ceil(MAX_PAYLOAD_EVIDENCE_BYTES / 2));
  const suffixBytes = raw.byteLength > prefixBytes
    ? Math.min(raw.byteLength - prefixBytes, Math.floor(MAX_PAYLOAD_EVIDENCE_BYTES / 2))
    : 0;
  return {
    totalBytes: raw.byteLength,
    sha256: createHash('sha256').update(raw).digest('hex'),
    prefix: raw.subarray(0, prefixBytes).toString('utf8'),
    suffix: suffixBytes ? raw.subarray(raw.byteLength - suffixBytes).toString('utf8') : '',
    truncated: prefixBytes + suffixBytes < raw.byteLength,
    ...(Array.isArray(value) ? { length: value.length } : {}),
  };
}

function boundNode(value, key = '') {
  if (typeof value === 'string') {
    if (BOUNDED_STRING_KEYS.includes(key) || Buffer.byteLength(value) > MAX_PAYLOAD_EVIDENCE_BYTES) {
      return boundPayload(value);
    }
    return value;
  }
  if (Array.isArray(value) && (key === 'rows' || key === 'content')) return boundPayload(value);
  if (Array.isArray(value)) return value.map(item => boundNode(item));
  if (!value || typeof value !== 'object') return value;
  if (typeof value.stdout === 'string') {
    const retained = retainBoundedCommandEvidence(value);
    const extra = {};
    for (const [nestedKey, nestedValue] of Object.entries(value)) {
      if (['stdout', 'phase', 'argv', 'status', 'stderr'].includes(nestedKey)) continue;
      extra[nestedKey] = boundNode(nestedValue, nestedKey);
    }
    return { ...retained, ...extra };
  }
  return Object.fromEntries(
    Object.entries(value).map(([nestedKey, nestedValue]) => [
      nestedKey,
      boundNode(nestedValue, nestedKey),
    ]),
  );
}

function boundCapturedEvidence(captured) {
  invariant(captured && typeof captured === 'object', 'captured evidence must be an object');
  return boundNode(captured);
}

export async function executeEvidenceFirstAttempt({ capture, retain, assertEvidence, cleanup }) {
  invariant(typeof capture === 'function', 'capture operation is required');
  invariant(typeof retain === 'function', 'evidence retention operation is required');
  invariant(typeof assertEvidence === 'function', 'evidence assertion is required');
  invariant(typeof cleanup === 'function', 'cleanup operation is required');
  const cleanupTruth = {
    attempted: true,
    captureCompleted: false,
    evidenceRetained: false,
    assertionStarted: false,
  };
  let evidence;
  let evidencePath = null;
  let result;
  let failure = null;
  let finalCleanup = cleanupTruth;
  try {
    const captured = await capture();
    cleanupTruth.captureCompleted = true;
    evidence = boundCapturedEvidence(captured);
    evidencePath = await retain(evidence);
    cleanupTruth.evidenceRetained = true;
    cleanupTruth.assertionStarted = true;
    result = await assertEvidence(evidence);
  } catch (error) {
    failure = error;
  } finally {
    try {
      finalCleanup = await cleanup({ ...cleanupTruth });
    } catch (cleanupError) {
      if (failure) failure.cleanupError = cleanupError;
      else failure = cleanupError;
    }
  }
  if (failure) {
    failure.cleanupTruth = finalCleanup;
    throw failure;
  }
  return { evidence, evidencePath, result, cleanup: finalCleanup };
}

export function writeTableCollectionEvidence(outDir, evidence) {
  invariant(typeof outDir === 'string' && outDir, 'evidence outDir is required');
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const path = join(outDir, 'table-collection-evidence.json');
  writeFileSync(path, `${JSON.stringify(evidence)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

export function cleanupPartialLiveState(state, operations) {
  invariant(state && typeof state === 'object', 'table-collection cleanup state is required');
  if (state.cleanupPromise) return state.cleanupPromise;
  state.cleanup = { attempted: true, verified: false, failures: [] };
  state.cleanupPromise = (async () => {
    for (const [operation] of CLEANUP_STEPS) {
      try {
        if (typeof operations?.[operation] !== 'function') {
          throw new Error(`missing required cleanup step: ${operation}`);
        }
        await operations[operation]();
      } catch (error) {
        state.cleanup.failures.push(String(error?.message || error).slice(0, 1024));
      }
    }
    state.cleanup.verified = state.cleanup.failures.length === 0;
    if (!state.cleanup.verified) {
      throw new Error(`table-collection cleanup failed: ${state.cleanup.failures.join('; ')}`);
    }
    return state.cleanup;
  })();
  return state.cleanupPromise;
}

export async function runLockedCleanup({ acquireLock, cleanup, releaseLock }) {
  invariant(typeof acquireLock === 'function', 'lock acquire operation is required');
  invariant(typeof cleanup === 'function', 'locked cleanup operation is required');
  invariant(typeof releaseLock === 'function', 'lock release operation is required');
  const lock = await acquireLock();
  try {
    return await cleanup(lock);
  } finally {
    await releaseLock(lock);
  }
}

async function runRegisteredCleanup(state) {
  state.requestAbort?.();
  if (typeof state.runCleanup === 'function') return state.runCleanup();
  if (state.cleanupPromise) return state.cleanupPromise;
  if (typeof state.cleanup === 'function') return state.cleanup.call(state);
  throw new Error('table-collection cancellation has no cleanup work');
}

export function createLiveCancellationController() {
  let activeState = null;
  let signal = null;
  let cancellationPromise = null;
  return {
    register(state) {
      activeState = state;
      if (signal) return this.cancel(signal);
      return null;
    },
    clear(state) {
      if (cancellationPromise) return;
      if (activeState === state) activeState = null;
    },
    cancel(nextSignal) {
      if (!signal) signal = nextSignal;
      if (cancellationPromise) return cancellationPromise;
      const registeredState = activeState;
      if (!registeredState) {
        return Promise.reject(new Error('table-collection cancellation has no registered live state'));
      }
      cancellationPromise = Promise.resolve().then(() => runRegisteredCleanup(registeredState));
      return cancellationPromise;
    },
    get cancelled() { return signal !== null; },
    get signal() { return signal; },
  };
}

const liveCancellation = createLiveCancellationController();

export function frozenTableCollectionRow(index) {
  invariant(
    Number.isInteger(index) && index >= 1 && index <= TABLE_COLLECTION_FIXTURE.logicalRows,
    'frozen row index is out of range',
  );
  return Object.freeze([
    `ROW-${String(index).padStart(4, '0')}`,
    FROZEN_STATUSES[(index * 7) % 4],
    `team-${String(((index * 13) % 17) + 1).padStart(2, '0')}`,
    String(1000 + ((index * 7919) % 900000)),
  ]);
}

export function frozenTableCollectionBodyTsv() {
  return Array.from(
    { length: TABLE_COLLECTION_FIXTURE.logicalRows },
    (_, offset) => frozenTableCollectionRow(offset + 1).join('\t'),
  ).join('\n');
}

export function frozenTableCollectionChecksum() {
  return createHash('sha256').update(frozenTableCollectionBodyTsv(), 'utf8').digest('hex');
}

export function buildTableCollectionFixtureDocument() {
  const fixture = TABLE_COLLECTION_FIXTURE;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>table collection fixture</title>
  <style>
    body { margin: 16px; font: 16px/1.4 system-ui, sans-serif; }
    #load-more { min-height: 44px; margin-bottom: 12px; }
    #grid-scrollport { height: ${fixture.mountedRows * fixture.rowHeightPx}px; overflow: auto; border: 1px solid #333; }
    #virtual-grid-track { position: relative; }
    #virtual-grid { position: absolute; top: 0; left: 0; width: 100%; border-collapse: collapse; table-layout: fixed; }
    #virtual-grid th, #virtual-grid td { height: ${fixture.rowHeightPx}px; padding: 0 8px; border-bottom: 1px solid #ccc; text-align: left; }
  </style>
</head>
<body>
  <main id="grid-fixture" data-loaded-rows="${fixture.initialAvailable}" data-load-more-clicks="0">
    <button id="load-more" type="button">Load more</button>
    <div id="grid-scrollport">
      <div id="virtual-grid-track">
        <table id="virtual-grid" aria-rowcount="${fixture.ariaRowCount}" aria-colcount="${fixture.columns}">
          <thead>
            <tr aria-rowindex="1">
              <th>Id</th><th>Status</th><th>Team</th><th>Value</th>
            </tr>
          </thead>
          <tbody id="virtual-grid-body">
            ${Array.from({ length: fixture.mountedRows }, (_, slot) => (
              `<tr id="virtual-slot-${String(slot).padStart(2, '0')}"></tr>`
            )).join('\n            ')}
          </tbody>
        </table>
      </div>
    </div>
  </main>
  <script>
  (() => {
    const LOGICAL = ${fixture.logicalRows};
    const MOUNTED = ${fixture.mountedRows};
    const ROW_H = ${fixture.rowHeightPx};
    const INITIAL = ${fixture.initialAvailable};
    const INCREMENT = ${fixture.loadIncrement};
    const STATUSES = ${JSON.stringify(FROZEN_STATUSES)};
    const fixtureRoot = document.querySelector('#grid-fixture');
    const scrollport = document.querySelector('#grid-scrollport');
    const track = document.querySelector('#virtual-grid-track');
    const loadMore = document.querySelector('#load-more');
    const slots = [...document.querySelectorAll('#virtual-grid-body tr')];
    let loadedRows = INITIAL;
    let windowStart = 0;
    let loadMoreClicks = 0;
    const frozenRow = index => ([
      'ROW-' + String(index).padStart(4, '0'),
      STATUSES[(index * 7) % 4],
      'team-' + String(((index * 13) % 17) + 1).padStart(2, '0'),
      String(1000 + ((index * 7919) % 900000)),
    ]);
    const renderWindow = () => {
      slots.forEach((node, offset) => {
        const dataIndex = windowStart + offset + 1;
        node.setAttribute('aria-rowindex', String(dataIndex + 1));
        const cells = frozenRow(dataIndex);
        node.replaceChildren(...cells.map((value, column) => {
          const cell = document.createElement(column === 0 ? 'th' : 'td');
          cell.textContent = value;
          return cell;
        }));
      });
      track.style.height = (loadedRows * ROW_H) + 'px';
      fixtureRoot.dataset.loadedRows = String(loadedRows);
      fixtureRoot.dataset.loadMoreClicks = String(loadMoreClicks);
      fixtureRoot.dataset.windowStart = String(windowStart);
    };
    const syncWindow = () => {
      const maxStart = Math.max(0, loadedRows - MOUNTED);
      windowStart = Math.min(maxStart, Math.max(0, Math.floor(scrollport.scrollTop / ROW_H)));
      renderWindow();
    };
    const clickLoadMore = () => {
      if (!loadMore.isConnected || loadedRows >= LOGICAL) return false;
      loadedRows = Math.min(LOGICAL, loadedRows + INCREMENT);
      loadMoreClicks += 1;
      if (loadedRows >= LOGICAL) loadMore.remove();
      renderWindow();
      return true;
    };
    loadMore.addEventListener('click', clickLoadMore);
    scrollport.addEventListener('scroll', syncWindow);
    window.__tableCollectionOracle = Object.freeze({
      state() {
        return Object.freeze({
          logicalRows: LOGICAL,
          loadedRows,
          mountedRows: MOUNTED,
          windowStart,
          loadMoreClicks,
          loadMoreVisible: loadMore.isConnected,
        });
      },
    });
    renderWindow();
  })();
  </script>
</body>
</html>
`;
}

export function assertProductRouteProof(captured, oracle) {
  invariant(captured && typeof captured === 'object', 'product route proof is required');
  invariant(oracle && typeof oracle === 'object', 'Playwright oracle proof is required');
  const initial = captured.initial || {};
  const proof = captured.proof || {};
  invariant(initial.available === TABLE_COLLECTION_FIXTURE.initialAvailable, 'product route must start at 128 available rows');
  invariant(initial.mountedRows === TABLE_COLLECTION_FIXTURE.mountedRows, 'product route must start at 12 stable nodes');
  invariant(initial.clicks === 0, 'product route must start at zero clicks');
  invariant(proof.collectedRows === TABLE_COLLECTION_FIXTURE.logicalRows, 'product route did not collect 1024 rows');
  invariant(proof.logicalRows === TABLE_COLLECTION_FIXTURE.logicalRows, 'product route logicalRows mismatch');
  invariant(proof.recycledMountedNodes === TABLE_COLLECTION_FIXTURE.mountedRows, 'product route recycling mismatch');
  invariant(proof.checksum === TABLE_COLLECTION_FIXTURE.checksum, 'product route checksum mismatch');
  invariant(proof.artifactBytes === TABLE_COLLECTION_FIXTURE.bodyBytes, 'product route artifact byte mismatch');
  invariant(proof.checksumScope === 'canonical-data-rows-tsv-utf8', 'product route checksum scope mismatch');
  invariant(proof.completeness?.state === 'complete', 'product route completeness is not complete');
  invariant(proof.completeness?.termination === 'logical-count-reached', 'product route termination mismatch');
  invariant(proof.loadMoreClicks === TABLE_COLLECTION_FIXTURE.loadMoreClicks, 'product route did not use exactly 14 interactions');
  invariant(Number.isInteger(proof.jsonBytes) && proof.jsonBytes <= 16384, 'product JSON exceeded 16384 bytes');
  invariant(proof.continuationBytesEqual === true, 'repeated continuation was not byte-identical');
  invariant(proof.checksum === oracle.checksum, 'product route checksum diverged from Playwright oracle');
  invariant(proof.collectedRows === oracle.uniqueIndexes, 'product route row count diverged from Playwright oracle');
  invariant(proof.loadMoreClicks === oracle.loadMoreClicks, 'product route interactions diverged from Playwright oracle');
  return {
    collectedRows: proof.collectedRows,
    checksum: proof.checksum,
    loadMoreClicks: proof.loadMoreClicks,
  };
}

export function assertPlaywrightOracleProof(proof) {
  invariant(proof && typeof proof === 'object', 'Playwright oracle proof is required');
  invariant(!('artifact' in proof), 'Playwright oracle must not assert product artifacts');
  invariant(!('continuation' in proof), 'Playwright oracle must not assert product continuation');
  invariant(!('token' in proof), 'Playwright oracle must not assert product tokens');
  invariant(proof.logicalRows === TABLE_COLLECTION_FIXTURE.logicalRows, 'Playwright logical row count mismatch');
  invariant(proof.uniqueIndexes === TABLE_COLLECTION_FIXTURE.logicalRows, 'Playwright unique index count mismatch');
  invariant(proof.mountedRows === TABLE_COLLECTION_FIXTURE.mountedRows, 'Playwright mounted row count mismatch');
  invariant(proof.recycledNodes === TABLE_COLLECTION_FIXTURE.mountedRows, 'Playwright recycled node count mismatch');
  invariant(proof.loadMoreClicks === TABLE_COLLECTION_FIXTURE.loadMoreClicks, 'Playwright load-more activations were not 14');
  invariant(proof.checksum === TABLE_COLLECTION_FIXTURE.checksum, 'Playwright canonical checksum mismatch');
  return {
    uniqueIndexes: proof.uniqueIndexes,
    recycledNodes: proof.recycledNodes,
    loadMoreClicks: proof.loadMoreClicks,
    checksum: proof.checksum,
  };
}

function delay(ms) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms));
}

export function createShortLiveRuntimeDir(route) {
  invariant(TABLE_COLLECTION_ROUTES.includes(route), `unknown table-collection route: ${route}`);
  const dir = mkdtempSync(`/tmp/t8${route[0]}-`);
  const socket = join(dir, 'cdp', `cdp-${'A'.repeat(32)}.sock`);
  invariant(socket.length < 104, 'daemon socket path exceeds the unix sockaddr limit');
  mkdirSync(join(dir, 'cdp'), { recursive: true, mode: 0o700 });
  return dir;
}

function ensureLiveActive() {
  if (liveCancellation.cancelled) {
    throw new Error(`table-collection cancelled by ${liveCancellation.signal}`);
  }
}

function runSync(command, args, { cwd = ROOT_DIR, env = process.env, timeout = 10_000 } = {}) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 });
  return {
    exitCode: result.status,
    signal: result.signal || null,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
    timedOut: result.error?.code === 'ETIMEDOUT',
    spawnError: result.error ? String(result.error.message || result.error) : null,
  };
}

async function stopChild(child, timeoutMs = 2_000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return true;
  const wait = timeout => new Promise(resolveWait => {
    let timer;
    const done = () => { clearTimeout(timer); resolveWait(true); };
    child.once('exit', done);
    timer = setTimeout(() => {
      child.off('exit', done);
      resolveWait(false);
    }, timeout);
  });
  child.kill('SIGTERM');
  if (await wait(timeoutMs)) return true;
  child.kill('SIGKILL');
  return wait(1_000);
}

async function endpointGone(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(350) });
    return false;
  } catch {
    return true;
  }
}

function matchingProcesses(markers) {
  const record = runSync('/bin/ps', ['ax', '-o', 'pid=,command='], { timeout: 2_000 });
  if (record.exitCode !== 0) throw new Error(`process scan failed: ${record.stderr || record.stdout}`);
  const needles = (Array.isArray(markers) ? markers : [markers]).filter(Boolean).map(String);
  return record.stdout.split(/\r?\n/).filter(line => needles.some(marker => line.includes(marker)));
}

async function waitForNoProcesses(markers) {
  let matches = [];
  for (let attempt = 0; attempt < 20; attempt += 1) {
    matches = matchingProcesses(markers);
    if (matches.length === 0) return true;
    await delay(100);
  }
  throw new Error(`owned processes remain: ${matches.slice(0, 3).join(' | ')}`);
}

async function waitForTarget(port, url = 'about:blank') {
  let last = `target ${url} not ready`;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    ensureLiveActive();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(500) });
      if (!response.ok) throw new Error(`target list returned ${response.status}`);
      const target = (await response.json()).find(item => item.type === 'page' && item.url === url);
      if (target?.id && target.webSocketDebuggerUrl) return target;
      last = `${url} page missing`;
    } catch (error) {
      last = error.message;
    }
    await delay(100);
  }
  throw new Error(last);
}

async function evaluateWebSocket(wsUrl, expression, timeout = 8_000) {
  const socket = new WebSocket(wsUrl);
  await new Promise((resolveOpen, rejectOpen) => {
    const timer = setTimeout(() => rejectOpen(new Error('fixture websocket open timed out')), timeout);
    socket.onopen = () => { clearTimeout(timer); resolveOpen(); };
    socket.onerror = () => { clearTimeout(timer); rejectOpen(new Error('fixture websocket failed to open')); };
  });
  try {
    return await new Promise((resolveResult, rejectResult) => {
      const timer = setTimeout(() => rejectResult(new Error('fixture evaluation timed out')), timeout);
      socket.onmessage = event => {
        const message = JSON.parse(event.data);
        if (message.id !== 1) return;
        clearTimeout(timer);
        if (message.error) rejectResult(new Error(message.error.message));
        else if (message.result?.exceptionDetails) {
          rejectResult(new Error(
            message.result.exceptionDetails.exception?.description
            || message.result.exceptionDetails.text
            || 'fixture evaluation failed',
          ));
        } else resolveResult(message.result?.result?.value);
      };
      socket.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: true },
      }));
    });
  } finally {
    socket.close();
  }
}

function routeEnv(paths, port) {
  return {
    ...process.env,
    HOME: paths.home,
    TMPDIR: paths.runtimeDir,
    XDG_RUNTIME_DIR: paths.runtimeDir,
    CDP_HOST: '127.0.0.1',
    CDP_PORT: String(port),
    NODE_ENV: 'production',
    FORCE_COLOR: '0',
    NO_COLOR: '1',
  };
}

function resolveCdpTargetId(env) {
  const listed = runSync(process.execPath, [CDP_PATH, 'list', '--format', 'json'], { env, timeout: 10_000 });
  invariant(listed.exitCode === 0, `cdp list failed: ${listed.stderr || listed.stdout}`);
  const model = JSON.parse(listed.stdout);
  const page = (model.pages || []).find(entry => entry.url === 'about:blank') || model.pages?.[0];
  invariant(typeof page?.targetId === 'string' && page.targetId, 'cdp list did not return a targetId');
  return page.targetId;
}

async function withLiveRouteSession(state, work) {
  liveCancellation.register(state);
  let result;
  let failure = null;
  try {
    result = await work();
  } catch (error) {
    failure = error;
  }
  try {
    await state.runCleanup();
  } catch (cleanupError) {
    if (failure) failure.cleanupError = cleanupError;
    else failure = cleanupError;
  }
  liveCancellation.clear(state);
  if (failure) throw failure;
  return result;
}

async function startOwnedDaemon(state, targetId) {
  invariant(typeof targetId === 'string' && targetId, 'owned daemon targetId is required');
  mkdirSync(join(state.paths.runtimeDir, 'cdp'), { recursive: true, mode: 0o700 });
  const socket = join(state.paths.runtimeDir, 'cdp', `cdp-${targetId}.sock`);
  let stderr = '';
  state.daemon = spawn(process.execPath, [CDP_PATH, '_daemon', targetId], {
    cwd: ROOT_DIR,
    env: state.env,
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  state.daemon.stderr.on('data', chunk => {
    stderr = `${stderr}${chunk}`.slice(-4096);
  });
  state.daemon.stdout?.resume();
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (state.daemon.exitCode !== null || state.daemon.signalCode !== null) {
      throw new Error(`owned table daemon exited: ${stderr.trim() || state.daemon.exitCode || state.daemon.signalCode}`);
    }
    if (existsSync(socket)) return socket;
    await delay(100);
  }
  throw new Error(`owned table daemon socket did not appear: ${stderr.trim() || socket}`);
}

function prepareRoutePaths(route, slot) {
  const allocated = allocateRouteFixture(route, { slot });
  const home = join(allocated.taskRoot, 'home');
  const runtimeDir = createShortLiveRuntimeDir(route);
  mkdirSync(allocated.profileDir, { recursive: true, mode: 0o700 });
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return { ...allocated, home, runtimeDir };
}

function parseCollectJson(text) {
  const model = JSON.parse(String(text || '').trim());
  invariant(model?.schema === 'chrome-cdp-ex.table.v1', 'collect JSON schema mismatch');
  return model;
}

function productProofFromCollect(model, { initial, jsonBytes, continuationBytesEqual, continuationSha256, loadMoreClicks }) {
  return {
    initial,
    proof: {
      collectedRows: model.collectedRows,
      logicalRows: model.logicalRows,
      recycledMountedNodes: model.recycledMountedNodes,
      checksum: model.artifact?.checksum,
      artifactBytes: model.artifact?.bytes,
      checksumScope: model.artifact?.checksumScope,
      jsonBytes,
      continuationBytesEqual,
      continuationSha256,
      loadMoreClicks,
      completeness: model.completeness,
    },
  };
}

function attachRouteCleanup(state) {
  state.runCleanup = () => cleanupPartialLiveState(state, {
    async stopChromeDaemon() {
      if (state.daemon) {
        await stopChild(state.daemon);
        state.daemon = null;
      }
      const marker = state.targetId ? `${CDP_PATH} _daemon ${state.targetId}` : null;
      if (state.env && state.targetId) {
        runSync(process.execPath, [CDP_PATH, 'stop', state.targetId, '--format', 'json'], {
          env: state.env,
          timeout: 8_000,
        });
      }
      if (marker) {
        for (const line of matchingProcesses([marker])) {
          const pid = Number(line.trim().split(/\s+/)[0]);
          if (Number.isInteger(pid) && pid > 0) {
            try { process.kill(pid, 'SIGTERM'); } catch {}
          }
        }
        await delay(250);
        state.cleanup.daemonStopped = matchingProcesses([marker]).length === 0;
        invariant(state.cleanup.daemonStopped, 'owned table daemon process remained');
        return;
      }
      state.cleanup.daemonStopped = true;
    },
    async stopChromeBrowser() {
      state.cleanup.browserStopped = await stopChild(state.browser);
      invariant(state.cleanup.browserStopped, 'Chrome for Testing did not stop');
    },
    async closePlaywright() {
      if (state.playwrightBrowser) {
        await state.playwrightBrowser.close();
        state.playwrightBrowser = null;
      }
      state.cleanup.playwrightClosed = true;
    },
    async closeServer() {
      if (!state.server?.listening) {
        state.cleanup.serverStopped = true;
        return;
      }
      await new Promise((resolveClose, rejectClose) => {
        state.server.close(error => error ? rejectClose(error) : resolveClose());
      });
      state.cleanup.serverStopped = true;
    },
    async assertNoTaskProcesses() {
      state.cleanup.processesGone = await waitForNoProcesses([
        state.paths.taskRoot,
        state.paths.runtimeDir,
        state.targetId ? `${CDP_PATH} _daemon ${state.targetId}` : null,
      ]);
    },
    async assertEndpointsAndPortsGone() {
      const ports = [state.paths.port, state.paths.serverPort].filter(Number.isFinite);
      state.cleanup.endpointGone = (await Promise.all(ports.map(endpointGone))).every(Boolean);
      invariant(state.cleanup.endpointGone, 'task endpoint or fixture port remained reachable');
    },
    async removeProfileRuntimeArtifacts() {
      rmSync(state.paths.profileDir, { recursive: true, force: true });
      rmSync(state.paths.runtimeDir, { recursive: true, force: true });
      state.cleanup.profileRemoved = !existsSync(state.paths.profileDir);
      state.cleanup.runtimeRemoved = !existsSync(state.paths.runtimeDir);
      invariant(state.cleanup.profileRemoved, 'profile directory remained after cleanup');
      invariant(state.cleanup.runtimeRemoved, 'runtime directory remained after cleanup');
    },
    async removeAndVerifyTaskRoot() {
      rmSync(state.paths.taskRoot, { recursive: true, force: true });
      state.cleanup.rootRemoved = !existsSync(state.paths.taskRoot);
      invariant(state.cleanup.rootRemoved, 'task root remained after cleanup');
    },
    assertLockReleased() {
      const lockDir = state.lock?.lockDir;
      state.lock?.release();
      state.lock = null;
      state.cleanup.lockReleased = lockDir ? !existsSync(lockDir) : true;
      invariant(state.cleanup.lockReleased, 'live lock remained after release');
    },
  });
  return state;
}

async function runProductCommands(route, env, targetId) {
  const collectTimeout = TABLE_COLLECTION_DEADLINE.cdpTimeoutMs;
  const continueArgv = token => ['table', targetId, '--continue', token, '--format', 'json'];
  if (route === 'cli') {
    const collectArgv = buildCliCollectArgv(targetId);
    const collect = runSync(process.execPath, [CDP_PATH, ...collectArgv], { env, timeout: collectTimeout });
    invariant(collect.exitCode === 0, `CLI collect failed: ${(collect.stderr || collect.stdout).trim() || `exit ${collect.exitCode}`}`);
    const model = parseCollectJson(collect.stdout);
    const token = model.continuation?.token;
    invariant(typeof token === 'string' && token, 'CLI collect continuation token is missing');
    const first = runSync(process.execPath, [CDP_PATH, ...continueArgv(token)], { env, timeout: 15_000 });
    const second = runSync(process.execPath, [CDP_PATH, ...continueArgv(token)], { env, timeout: 15_000 });
    invariant(first.exitCode === 0 && second.exitCode === 0, 'CLI continuation failed');
    invariant(first.stdout === second.stdout, 'CLI continuation byte identity mismatch');
    return {
      model,
      jsonBytes: Buffer.byteLength(collect.stdout, 'utf8'),
      continuationBytesEqual: first.stdout === second.stdout,
      continuationSha256: createHash('sha256').update(first.stdout, 'utf8').digest('hex'),
      commands: [
        { phase: 'collect', argv: collectArgv, status: collect.exitCode, stdout: collect.stdout, stderr: collect.stderr },
        { phase: 'continue', argv: continueArgv(token), status: first.exitCode, stdout: first.stdout, stderr: first.stderr },
        { phase: 'continue-repeat', argv: continueArgv(token), status: second.exitCode, stdout: second.stdout, stderr: second.stderr },
      ],
    };
  }
  const { executeCdpCli } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
  const { createRuntimeClient } = await import('../skills/chrome-cdp-ex/scripts/lib/runtime-client.mjs');
  const { createMcpRequestHandler } = await import('../skills/chrome-cdp-ex/scripts/mcp-server.mjs');
  const previous = {
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
    CDP_HOST: process.env.CDP_HOST,
    CDP_PORT: process.env.CDP_PORT,
  };
  Object.assign(process.env, {
    HOME: env.HOME,
    TMPDIR: env.TMPDIR,
    XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR,
    CDP_HOST: env.CDP_HOST,
    CDP_PORT: env.CDP_PORT,
  });
  try {
    const hostProcess = Object.create(process);
    Object.defineProperty(hostProcess, 'env', { value: env, writable: true });
    const sent = [];
    const handler = createMcpRequestHandler({
      runtimeClient: createRuntimeClient({
        executeCli: command => executeCdpCli(command, { hostProcess }),
      }),
      sendMessage: message => sent.push(message),
    });
    const call = async (id, params) => {
      sent.length = 0;
      await handler({ jsonrpc: '2.0', id, method: 'tools/call', params });
      const response = sent[0];
      if (response?.error) throw new Error(response.error.message);
      if (response?.result?.isError) {
        throw new Error(response.result.content?.[0]?.text || 'MCP collect failed');
      }
      return response?.result?.content?.[0]?.text || '';
    };
    const collectParams = route === 'mcp'
      ? buildFirstClassMcpCollectParams(targetId)
      : buildRunCommandMcpCollectParams(targetId);
    const collectText = await call(1, collectParams);
    const model = parseCollectJson(collectText);
    const token = model.continuation?.token;
    invariant(typeof token === 'string' && token, 'MCP collect continuation token is missing');
    const continueParams = route === 'mcp'
      ? { name: 'table', arguments: { target: targetId, continue: token } }
      : {
        name: 'run_command',
        arguments: { command: 'table', args: [targetId, '--continue', token, '--format', 'json'] },
      };
    const first = await call(2, continueParams);
    const second = await call(3, continueParams);
    invariant(first === second, 'MCP continuation byte identity mismatch');
    return {
      model,
      jsonBytes: Buffer.byteLength(collectText, 'utf8'),
      continuationBytesEqual: first === second,
      continuationSha256: createHash('sha256').update(first, 'utf8').digest('hex'),
      commands: [
        { phase: 'collect', argv: collectParams, status: 0, stdout: collectText, stderr: '' },
        { phase: 'continue', argv: continueParams, status: 0, stdout: first, stderr: '' },
        { phase: 'continue-repeat', argv: continueParams, status: 0, stdout: second, stderr: '' },
      ],
    };
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function runChromeProductRoute(route, browserPath, fixtureDocument, trial) {
  const paths = prepareRoutePaths(route, trial - 1);
  const state = attachRouteCleanup({
    route,
    paths,
    browser: null,
    env: null,
    target: null,
    targetId: null,
    daemon: null,
    lock: null,
    server: null,
    playwrightBrowser: null,
    requestAbort() { this.abortRequested = true; },
  });
  return withLiveRouteSession(state, async () => {
    ensureLiveActive();
    state.lock = acquireLiveBenchmarkLock({
      name: `table-collection-${route}-${trial}`,
      scope: ROOT_DIR,
      portStart: paths.portStart,
      serverPortStart: paths.serverPortStart,
      browser: 'chrome-for-testing',
      profileDir: paths.profileDir,
    });
    const port = state.lock.metadata.port;
    paths.port = port;
    paths.serverPort = state.lock.metadata.serverPort;
    state.env = routeEnv(paths, port);
    state.browser = spawn(browserPath, buildChromeLaunchArgs({ port, profileDir: paths.profileDir }), {
      env: state.env,
      detached: false,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const diagnostics = monitorDisposableBrowser(state.browser);
    state.browser.stderr?.resume();
    state.target = await waitForTarget(port);
    ensureLiveActive();
    if (diagnostics.error()) throw diagnostics.error();
    const provisioned = await evaluateWebSocket(
      state.target.webSocketDebuggerUrl,
      buildChromeFixtureProvisionExpression(fixtureDocument),
    );
    invariant(provisioned?.readyState === 'complete', 'direct Chrome fixture readyState mismatch');
    invariant(provisioned?.loadedRows === TABLE_COLLECTION_FIXTURE.initialAvailable, 'product route did not start at 128 available rows');
    invariant(provisioned?.mountedRows === TABLE_COLLECTION_FIXTURE.mountedRows, 'product route did not start at 12 stable nodes');
    invariant(provisioned?.loadMoreClicks === 0, 'product route did not start at zero clicks');
    const initial = {
      available: provisioned.loadedRows,
      mountedRows: provisioned.mountedRows,
      clicks: provisioned.loadMoreClicks,
    };
    state.targetId = resolveCdpTargetId(state.env);
    await startOwnedDaemon(state, state.targetId);
    ensureLiveActive();
    const collected = await runProductCommands(route, state.env, state.targetId);
    const after = await evaluateWebSocket(state.target.webSocketDebuggerUrl, `window.__tableCollectionOracle.state()`);
    return {
      route,
      identity: {
        browserInstanceId: paths.browserInstanceId,
        profileToken: paths.profileToken,
        port,
        runtimeDir: paths.runtimeDir,
        targetId: state.targetId,
      },
      ...productProofFromCollect(collected.model, {
        initial,
        jsonBytes: collected.jsonBytes,
        continuationBytesEqual: collected.continuationBytesEqual,
        continuationSha256: collected.continuationSha256,
        loadMoreClicks: after?.loadMoreClicks,
      }),
      commands: collected.commands,
    };
  });
}

function resolvePlaywrightModule() {
  const searchRoot = join(homedir(), '.npm/_npx');
  invariant(existsSync(searchRoot), 'installed Playwright package is unavailable');
  const candidates = readdirSync(searchRoot)
    .map(name => join(searchRoot, name, 'node_modules/playwright/index.mjs'))
    .filter(existsSync)
    .sort();
  invariant(candidates.length > 0, 'installed Playwright package is unavailable');
  return candidates.at(-1);
}

function createFixtureHttpServer(html) {
  return createServer((request, response) => {
    const path = String(request.url || '').split('?')[0];
    if (path === '/validation-table-collection.html') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(html);
      return;
    }
    response.writeHead(404);
    response.end('not found');
  });
}

async function runPlaywrightOracleRoute(browserPath, fixtureDocument, trial) {
  const paths = prepareRoutePaths('playwright', trial - 1);
  const state = attachRouteCleanup({
    route: 'playwright',
    paths,
    browser: null,
    env: null,
    target: null,
    targetId: null,
    lock: null,
    server: createFixtureHttpServer(fixtureDocument),
    playwrightBrowser: null,
    requestAbort() { this.abortRequested = true; },
  });
  return withLiveRouteSession(state, async () => {
    ensureLiveActive();
    state.lock = acquireLiveBenchmarkLock({
      name: `table-collection-playwright-${trial}`,
      scope: ROOT_DIR,
      portStart: paths.portStart,
      serverPortStart: paths.serverPortStart,
      browser: 'chrome-for-testing',
      profileDir: paths.profileDir,
    });
    const serverPort = state.lock.metadata.serverPort;
    paths.port = state.lock.metadata.port;
    paths.serverPort = serverPort;
    await listenTableCollectionFixtureServer(state.server, { port: serverPort });
    const url = buildLoopbackFixtureUrl(serverPort);
    const playwrightModule = await import(pathToFileURL(resolvePlaywrightModule()).href);
    const browser = await playwrightModule.chromium.launch({
      executablePath: browserPath,
      headless: true,
      args: ['--no-first-run', '--no-default-browser-check', '--disable-extensions'],
    });
    state.playwrightBrowser = browser;
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    const probe = (0, eval)(`(${playwrightOracleProbeSource()})`);
    const truth = await probe(page);
    return {
      route: 'playwright',
      ...truth,
    };
  });
}

async function defaultRunRoute(route, trial) {
  const candidate = discoverBrowserCandidates()[0];
  invariant(candidate, 'no Chrome for Testing browser binary found');
  const [browserPath] = candidate;
  const fixtureDocument = buildTableCollectionFixtureDocument();
  if (route === 'playwright') return runPlaywrightOracleRoute(browserPath, fixtureDocument, trial);
  return runChromeProductRoute(route, browserPath, fixtureDocument, trial);
}

function installLiveSignals() {
  const onSignal = signal => {
    liveCancellation.cancel(signal).finally(() => {
      process.exit(signal === 'SIGTERM' ? 143 : 130);
    });
  };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
  return () => {
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
  };
}

export async function runLiveTableCollectionTrials(hooks = {}) {
  const trialCount = hooks.trialCount ?? 2;
  const runRoute = hooks.runRoute || defaultRunRoute;
  const outDir = hooks.outDir || (hooks.runRoute
    ? mkdtempSync(join(tmpdir(), 'chrome-cdp-table-collection-evidence-'))
    : join(ROOT_DIR, '.superpowers/sdd/2026-08-13-table-collection/live-evidence'));
  invariant(Number.isInteger(trialCount) && trialCount === 2, 'live table-collection requires two fresh trials');
  const uninstallSignals = hooks.runRoute ? () => {} : installLiveSignals();
  const routes = [];
  const trials = [];
  try {
  for (let trial = 1; trial <= trialCount; trial += 1) {
    const trialRoutes = [];
    for (const route of TABLE_COLLECTION_ROUTES) {
      const captured = await runRoute(route, trial);
      trialRoutes.push({ trial, route, captured });
    }
    const oracle = trialRoutes.find(entry => entry.route === 'playwright')?.captured;
    for (const entry of trialRoutes) {
      if (entry.route === 'playwright') assertPlaywrightOracleProof(entry.captured);
      else assertProductRouteProof(entry.captured, oracle);
    }
    routes.push(...trialRoutes);
    trials.push({
      trial,
      ok: true,
      checksum: oracle?.checksum,
      loadMoreClicks: oracle?.loadMoreClicks,
    });
  }
  const evidence = boundCapturedEvidence({
    schema: 'chrome-cdp-ex.validation-table-collection.live.v1',
    ok: true,
    trialCount,
    routes: routes.map(entry => ({
      trial: entry.trial,
      route: entry.route,
      identity: entry.captured.identity || null,
      initial: entry.captured.initial || null,
      proof: entry.captured.proof || {
        logicalRows: entry.captured.logicalRows,
        uniqueIndexes: entry.captured.uniqueIndexes,
        mountedRows: entry.captured.mountedRows,
        recycledNodes: entry.captured.recycledNodes,
        loadMoreClicks: entry.captured.loadMoreClicks,
        checksum: entry.captured.checksum,
      },
      commands: entry.captured.commands || [],
    })),
  });
  const evidencePath = writeTableCollectionEvidence(outDir, evidence);
  return { ok: true, trials, routes, evidencePath };
  } catch (error) {
    try {
      error.evidencePath = writeTableCollectionEvidence(outDir, boundCapturedEvidence({
        schema: 'chrome-cdp-ex.validation-table-collection.live.v1',
        ok: false,
        error: String(error?.message || error).slice(0, 1024),
        trialCount,
        routes: routes.map(entry => ({
          trial: entry.trial,
          route: entry.route,
          identity: entry.captured?.identity || null,
          initial: entry.captured?.initial || null,
          proof: entry.captured?.proof || null,
        })),
      }));
    } catch {}
    throw error;
  } finally {
    uninstallSignals();
  }
}

export async function main(argv = process.argv.slice(2), hooks = {}) {
  const options = parseArgs(argv);
  if (options.command === 'static-check') {
    process.stdout.write(`${JSON.stringify(buildStaticReadiness(), null, 2)}\n`);
    return 0;
  }
  const runLive = hooks.runLive || runLiveTableCollectionTrials;
  const result = await runLive();
  if (typeof result === 'number') return result;
  process.stdout.write(`${JSON.stringify({
    ok: result.ok,
    trials: result.trials?.length ?? null,
    routes: result.routes?.length ?? null,
    evidencePath: result.evidencePath || null,
  }, null, 2)}\n`);
  return result.ok ? 0 : 1;
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  main().then(status => {
    process.exitCode = status;
  }).catch(error => {
    console.error(`Validation table collection: ${error.message}`);
    process.exitCode = 1;
  });
}
