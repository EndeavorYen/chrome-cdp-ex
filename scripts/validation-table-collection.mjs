#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildDisposableBrowserArgs } from './validation-live-boundary.mjs';

const USAGE = 'Usage: node scripts/validation-table-collection.mjs --static-check | --allow-live';
const EXTRACTION_IMPORT_RE = /from\s+['"][^'"]*(?:table-extraction|table-artifacts|table-contract)[^'"]*['"]/;

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
    return { title: document.title, readyState: document.readyState };
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
    const initial = await page.evaluate(() => ({
      logicalRows: 1024,
      mountedRows: document.querySelectorAll('#virtual-grid-body tr').length,
    }));
    let clicks = 0;
    while (await page.locator('#load-more').count()) {
      await page.locator('#load-more').click();
      clicks += 1;
      if (clicks > 16) throw new Error('load-more click cap exceeded');
    }
    return {
      logicalRows: initial.logicalRows,
      mountedRows: initial.mountedRows,
      loadMoreClicks: clicks,
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

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.command === 'static-check') {
    process.stdout.write(`${JSON.stringify(buildStaticReadiness(), null, 2)}\n`);
    return 0;
  }
  throw new Error('live table-collection trials require a later authorized dispatch; this runner does not launch a browser');
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  main().then(status => {
    process.exitCode = status;
  }).catch(error => {
    console.error(`Validation table collection: ${error.message}`);
    process.exitCode = 1;
  });
}
