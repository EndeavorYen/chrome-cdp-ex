import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CLEANUP_ORDER,
  MAX_PAYLOAD_EVIDENCE_BYTES,
  TABLE_COLLECTION_FIXTURE,
  TABLE_COLLECTION_ROUTES,
  assertIndependentRouteFixtures,
  assertLoopbackOnlyUrl,
  assertPlaywrightOracleIndependence,
  allocateRouteFixture,
  buildChromeFixtureProvisionExpression,
  buildChromeLaunchArgs,
  buildCliCollectArgv,
  buildFirstClassMcpCollectParams,
  buildLoopbackFixtureUrl,
  buildRunCommandMcpCollectParams,
  buildStaticReadiness,
  cleanupPartialLiveState,
  createLiveCancellationController,
  describeRouteFixture,
  executeEvidenceFirstAttempt,
  parseArgs,
  playwrightOracleProbeSource,
  retainBoundedCommandEvidence,
  runLockedCleanup,
  writeTableCollectionEvidence,
} from '../scripts/validation-table-collection.mjs';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const cliPath = join(rootDir, 'scripts/validation-table-collection.mjs');
const runnerSource = readFileSync(cliPath, 'utf8');
const tempPaths = [];

afterEach(() => {
  for (const path of tempPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function tempDir() {
  const path = mkdtempSync(join(tmpdir(), 'chrome-cdp-table-validation-'));
  chmodSync(path, 0o700);
  tempPaths.push(path);
  return path;
}

function oversizedCollectPayload() {
  const rows = Array.from({ length: 1024 }, (_, index) => (
    `ROW-${String(index + 1).padStart(4, '0')}\tdone\tteam-01\t1000`
  ));
  return `${JSON.stringify({
    schema: 'chrome-cdp-ex.table.v1',
    collectedRows: 1024,
    artifact: { checksum: TABLE_COLLECTION_FIXTURE.checksum },
    rows,
  })}\n`;
}

describe('four-route Validation Lab runner', () => {
  it('freezes four separately reset routes and a static plan that starts no browser', () => {
    expect([...TABLE_COLLECTION_ROUTES]).toEqual(['cli', 'mcp', 'mcp-run-command', 'playwright']);
    const readiness = buildStaticReadiness();
    expect(readiness.ready).toBe(true);
    expect(readiness.browserStarted).toBe(false);
    expect(readiness.chromeStartUrl).toBe('about:blank');
    expect(readiness.chromeProvisioning).toMatch(/Runtime\.evaluate.*about:blank/);
    expect(readiness.fixtureHost).toBe('127.0.0.1');
    expect(readiness.routes).toEqual({
      cli: { kind: 'direct-cli-collect', browser: 'fresh-cft-about-blank', reset: ['browser', 'target', 'profile', 'runtime'] },
      mcp: { kind: 'first-class-mcp-collect', browser: 'fresh-cft-about-blank', reset: ['browser', 'target', 'profile', 'runtime'] },
      'mcp-run-command': { kind: 'mcp-run-command-collect', browser: 'fresh-cft-about-blank', reset: ['browser', 'target', 'profile', 'runtime'] },
      playwright: {
        kind: 'independent-playwright-oracle',
        browser: 'fresh-wrapper-loopback-fixture',
        reset: ['browser', 'target', 'profile', 'runtime'],
        importsProductExtraction: false,
      },
    });
    expect(readiness.fixture).toMatchObject({
      logicalRows: 1024,
      mountedRows: 12,
      initialAvailable: 128,
      loadMoreClicks: 14,
      checksum: '73e9f36080b8c781e204857ad9c7dcf4ce7ce419b1503d9affd0343f58f964ed',
    });
  });

  it('gives every route its own browser, target, profile, port, and runtime identities', () => {
    const fixtures = TABLE_COLLECTION_ROUTES.map(route => describeRouteFixture(route));
    assertIndependentRouteFixtures(fixtures);
    for (const fixture of fixtures) {
      expect(fixture.reset).toEqual(['browser', 'target', 'profile', 'runtime']);
      expect(fixture.chromeStartUrl).toBe('about:blank');
      expect(fixture.listenHost).toBe('127.0.0.1');
      expect(fixture.profilePrefix).toContain(fixture.route);
      expect(fixture.runtimePrefix).toContain(fixture.route);
      expect(fixture.portStart).toBeGreaterThan(1023);
      expect(fixture.serverPortStart).toBeGreaterThan(1023);
    }
    const allocated = TABLE_COLLECTION_ROUTES.map((route, slot) => allocateRouteFixture(route, {
      taskRoot: join(tempDir(), route),
      slot,
    }));
    assertIndependentRouteFixtures(allocated);
    const keys = ['profileDir', 'runtimeDir', 'taskRoot', 'port', 'serverPort', 'browserInstanceId', 'profileToken'];
    for (const key of keys) {
      expect(new Set(allocated.map(entry => entry[key])).size).toBe(4);
    }
  });

  it('provisions Chrome from about:blank without a navigational fixture URL', () => {
    const args = buildChromeLaunchArgs({ port: 9624, profileDir: '/tmp/table-profile' });
    expect(args[0]).toBe('--remote-debugging-port=9624');
    expect(args).toContain('--user-data-dir=/tmp/table-profile');
    expect(args.at(-1)).toBe('about:blank');
    expect(args.filter(value => /^https?:/.test(value))).toEqual([]);
    const expression = buildChromeFixtureProvisionExpression('<!doctype html><title>table fixture</title>');
    expect(expression).toContain('document.open()');
    expect(expression).toContain('document.write(');
    expect(expression).toContain('document.close()');
    expect(expression).not.toContain('location.assign');
    expect(expression).not.toContain('location.href');
  });

  it('binds the fixture server to loopback and rejects non-loopback URLs', () => {
    expect(buildLoopbackFixtureUrl(42824)).toBe('http://127.0.0.1:42824/validation-table-collection.html');
    expect(assertLoopbackOnlyUrl('http://127.0.0.1:42824/validation-table-collection.html')).toEqual({
      host: '127.0.0.1',
      port: 42824,
    });
    expect(() => assertLoopbackOnlyUrl('http://[::1]:42824/validation-table-collection.html')).toThrow(/loopback/);
    expect(() => assertLoopbackOnlyUrl('http://localhost:42824/validation-table-collection.html')).toThrow(/loopback/);
    expect(() => assertLoopbackOnlyUrl('http://example.test/validation-table-collection.html')).toThrow(/loopback/);
  });

  it('keeps CLI collect, first-class MCP collect, and run_command collect on distinct call shapes', () => {
    const targetId = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    expect(buildCliCollectArgv(targetId)).toEqual([
      'table', targetId, '#virtual-grid', '--collect',
      '--scroll-container', '#grid-scrollport', '--load-more', '#load-more', '--format', 'json',
    ]);
    expect(buildFirstClassMcpCollectParams(targetId)).toEqual({
      name: 'table',
      arguments: {
        target: targetId,
        selector: '#virtual-grid',
        collect: true,
        scrollContainer: '#grid-scrollport',
        loadMore: '#load-more',
        confirm: true,
      },
    });
    expect(buildRunCommandMcpCollectParams(targetId)).toEqual({
      name: 'run_command',
      arguments: {
        command: 'table',
        args: [
          targetId, '#virtual-grid', '--collect',
          '--scroll-container', '#grid-scrollport', '--load-more', '#load-more', '--format', 'json',
        ],
        confirm: true,
      },
    });
  });

  it('keeps the Playwright oracle free of chrome-cdp-ex extraction imports', () => {
    const probe = playwrightOracleProbeSource();
    expect(assertPlaywrightOracleIndependence(probe)).toEqual({ importsProductExtraction: false });
    expect(assertPlaywrightOracleIndependence(runnerSource)).toEqual({ importsProductExtraction: false });
    expect(probe).toContain('1024');
    expect(probe).toContain('#load-more');
    expect(probe).not.toMatch(/table-extraction|table-artifacts|table-contract|tableCollection/);
    expect(runnerSource).not.toMatch(/from ['"].*table-extraction\.mjs['"]/);
    expect(runnerSource).not.toMatch(/from ['"].*table-artifacts\.mjs['"]/);
    expect(() => assertPlaywrightOracleIndependence("import { canonicalizeTableCells } from './table-extraction.mjs';")).toThrow(/extraction/);
  });

  it('accepts only static-check by default and refuses live without authorization', () => {
    expect(parseArgs(['--static-check'])).toEqual({ command: 'static-check', allowLive: false });
    expect(() => parseArgs([])).toThrow(/--static-check|--allow-live/);
    expect(parseArgs(['--allow-live'])).toEqual({ command: 'live', allowLive: true });
    expect(() => parseArgs(['--wat'])).toThrow(/unknown argument/);
    const executed = spawnSync(process.execPath, [cliPath], { cwd: rootDir, encoding: 'utf8' });
    expect(executed.status).not.toBe(0);
    expect(executed.stderr).toMatch(/--static-check|--allow-live/);
    const checked = spawnSync(process.execPath, [cliPath, '--static-check'], { cwd: rootDir, encoding: 'utf8' });
    expect(checked.status).toBe(0);
    const summary = JSON.parse(checked.stdout);
    expect(summary.browserStarted).toBe(false);
    expect(summary.ready).toBe(true);
  });
});

describe('evidence-first capture and cleanup contracts', () => {
  it('retains bounded argv/status/length/hash/prefix/suffix before parse and drops the raw 1024-row payload', () => {
    const stdout = oversizedCollectPayload();
    const retained = retainBoundedCommandEvidence({
      phase: 'collect',
      argv: buildCliCollectArgv('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
      status: 0,
      stdout,
      stderr: '',
    });
    expect(retained.argv).toEqual(buildCliCollectArgv('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'));
    expect(retained.status).toBe(0);
    expect(retained.payload.totalBytes).toBe(Buffer.byteLength(stdout));
    expect(retained.payload.totalBytes).toBeGreaterThan(MAX_PAYLOAD_EVIDENCE_BYTES);
    expect(retained.payload.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(Buffer.byteLength(retained.payload.prefix) + Buffer.byteLength(retained.payload.suffix))
      .toBeLessThanOrEqual(MAX_PAYLOAD_EVIDENCE_BYTES);
    expect(retained.payload.truncated).toBe(true);
    expect(retained).not.toHaveProperty('stdout');
    expect(JSON.stringify(retained)).not.toContain('ROW-0512');
    expect(JSON.stringify(retained)).not.toContain('"rows":[');
  });

  it('writes mode-0600 evidence and keeps capture-retain-assert-cleanup order', async () => {
    const outDir = tempDir();
    const order = [];
    const captured = {
      identity: {
        browserInstanceId: 'browser-cli-fixture',
        profileToken: 'profile-cli-fixture',
        port: 9624,
        runtimeDir: '/tmp/table-runtime',
        targetId: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      },
      result: {
        phase: 'collect',
        argv: ['table', 'T'],
        status: 0,
        stdout: oversizedCollectPayload(),
        stderr: '',
      },
    };
    const run = await executeEvidenceFirstAttempt({
      async capture() {
        order.push('capture');
        return captured;
      },
      async retain(evidence) {
        order.push('retain');
        expect(evidence.result).not.toHaveProperty('stdout');
        expect(evidence.identity.port).toBe(9624);
        return writeTableCollectionEvidence(outDir, evidence);
      },
      assertEvidence(evidence) {
        order.push('assert');
        expect(evidence.result.payload.truncated).toBe(true);
        return { ok: true };
      },
      async cleanup(truth) {
        order.push('cleanup');
        return { ...truth, lockReleased: true };
      },
    });
    expect(order).toEqual(['capture', 'retain', 'assert', 'cleanup']);
    expect(statSync(run.evidencePath).mode & 0o777).toBe(0o600);
    const stored = JSON.parse(readFileSync(run.evidencePath, 'utf8'));
    expect(stored).not.toHaveProperty('stdout');
    expect(JSON.stringify(stored)).not.toContain('ROW-0512');
  });

  it('retains bounded evidence even when later parsing fails', async () => {
    const order = [];
    let retained;
    await expect(executeEvidenceFirstAttempt({
      async capture() {
        order.push('capture');
        return {
          result: { phase: 'collect', argv: ['table'], status: 1, stdout: oversizedCollectPayload(), stderr: 'failed' },
        };
      },
      async retain(evidence) {
        order.push('retain');
        retained = evidence;
        return '/tmp/table-evidence.json';
      },
      assertEvidence() {
        order.push('assert');
        throw new Error('parse failed');
      },
      async cleanup(truth) {
        order.push('cleanup');
        return truth;
      },
    })).rejects.toThrow(/parse failed/);
    expect(order).toEqual(['capture', 'retain', 'assert', 'cleanup']);
    expect(retained.result.status).toBe(1);
    expect(retained.result).not.toHaveProperty('stdout');
    expect(retained.result.payload.totalBytes).toBeGreaterThan(MAX_PAYLOAD_EVIDENCE_BYTES);
  });

  it('memoizes signal cleanup, stops the daemon before the browser, and holds the lock through leftover proofs', async () => {
    expect([...CLEANUP_ORDER]).toEqual([
      'chrome-daemon',
      'chrome-browser',
      'playwright',
      'fixture-server',
      'processes',
      'endpoints-and-ports',
      'profile-runtime-artifacts',
      'lock',
      'task-root',
    ]);
    const order = [];
    const state = { cleanupPromise: null };
    const cleanup = cleanupPartialLiveState(state, {
      async stopChromeDaemon() { order.push('chrome-daemon'); },
      async stopChromeBrowser() { order.push('chrome-browser'); throw new Error('browser stop failed'); },
      async closePlaywright() { order.push('playwright'); },
      async closeServer() { order.push('fixture-server'); },
      async assertNoTaskProcesses() { order.push('processes'); },
      async assertEndpointsAndPortsGone() { order.push('endpoints-and-ports'); },
      async removeProfileRuntimeArtifacts() { order.push('profile-runtime-artifacts'); },
      async assertLockReleased() { order.push('lock'); },
      async removeAndVerifyTaskRoot() { order.push('task-root'); },
    });
    expect(cleanupPartialLiveState(state, {})).toBe(cleanup);
    await expect(cleanup).rejects.toThrow(/cleanup failed/);
    expect(order).toEqual([...CLEANUP_ORDER]);
    expect(state.cleanup).toMatchObject({ attempted: true, verified: false, failures: ['browser stop failed'] });

    const lockOrder = [];
    const leftover = await runLockedCleanup({
      async acquireLock() {
        lockOrder.push('acquire');
        return { lockDir: '/tmp/table-lock' };
      },
      async cleanup(lock) {
        lockOrder.push('cleanup');
        expect(lock.lockDir).toBe('/tmp/table-lock');
        return {
          daemonStopped: true,
          browserStopped: true,
          playwrightClosed: true,
          serverStopped: true,
          processesGone: true,
          endpointGone: true,
          profileRemoved: true,
          runtimeRemoved: true,
          artifactRemoved: true,
          lockReleased: true,
          rootRemoved: true,
        };
      },
      async releaseLock() { lockOrder.push('release'); },
    });
    expect(lockOrder).toEqual(['acquire', 'cleanup', 'release']);
    expect(leftover).toMatchObject({
      endpointGone: true,
      processesGone: true,
      profileRemoved: true,
      runtimeRemoved: true,
      artifactRemoved: true,
      lockReleased: true,
    });

    const signals = [];
    const controller = createLiveCancellationController();
    const session = {
      requestAbort() { signals.push('abort'); },
      async cleanup() { signals.push('cleanup'); return { verified: true }; },
    };
    controller.register(session);
    const first = controller.cancel('SIGTERM');
    const second = controller.cancel('SIGINT');
    expect(first).toBe(second);
    await expect(first).resolves.toEqual({ verified: true });
    expect(signals).toEqual(['abort', 'cleanup']);
    expect(controller.signal).toBe('SIGTERM');
  });
});
