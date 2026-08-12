import { spawn } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'fs';
import { createServer as createHttpServer } from 'http';
import { connect as connectNet, createServer as createNetServer } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it, vi } from 'vitest';

import {
  assertPhase5SemanticParity,
  cleanupPhase5Resources,
  runPhase5SupervisorSession,
} from '../scripts/validation-phase5-supervisor.mjs';
import { withLiveBenchmarkLock } from '../scripts/benchmark-run-lock.mjs';

const TITLE = 'chrome-cdp-ex long-session smoke';
const URL = 'http://127.0.0.1:41759/validation-phase5.html';

function perception(targetPrefix = 'ABC12345') {
  return JSON.stringify({
    schema: 'chrome-cdp-ex.perceive.v1',
    targetPrefix,
    page: { title: TITLE, url: URL },
    viewport: { coordinateSpace: 'viewport-css-px', width: 1280, height: 720 },
    console: { errors: 0, warnings: 0, exceptions: 0 },
    refs: { generation: 1 },
    nodes: [{ ref: '@1', role: 'button', name: 'Close' }],
    limits: { truncated: false },
  });
}

function stopped(targetPrefix = 'TARGET-O') {
  return JSON.stringify({
    schema: 'chrome-cdp-ex.stop.v1',
    requestedTarget: targetPrefix,
    stopped: true,
    stoppedTargets: [targetPrefix],
    failedTargets: [],
    remainingSessions: 0,
    remainingTargets: [],
    noop: false,
  });
}

function steps(overrides = {}) {
  const beforeResource = Object.freeze({ kind: 'page', id: 'page-old', revision: 1 });
  const afterResource = Object.freeze({ kind: 'page', id: 'page-new', revision: 2 });
  return {
    discover: vi.fn(async () => ({ targetId: 'TARGET-OLD', targetPrefix: 'TARGET-O' })),
    resolve: vi.fn(async () => ({ id: 'private-handle', resource: () => beforeResource })),
    connect: vi.fn(async handle => handle),
    executeCli: vi.fn(async () => perception('TARGET-O')),
    executeMcp: vi.fn(async () => perception('TARGET-O')),
    stopDaemon: vi.fn(async () => stopped()),
    restart: vi.fn(async () => ({
      output: perception('TARGET-O'),
      stopReceipt: stopped(),
    })),
    replaceTarget: vi.fn(async () => ({ targetId: 'TARGET-NEW', targetPrefix: 'TARGET-N' })),
    rebind: vi.fn(async handle => ({
      handle,
      resource: afterResource,
      output: perception('TARGET-N'),
      action: JSON.stringify({
        schema: 'chrome-cdp-ex.action.v1',
        action: 'click',
        dispatch: { ok: true },
        settle: { ok: true },
        outcome: { status: 'changed' },
        receipt: {
          schema: 'chrome-cdp-ex.action-receipt.v1', outcome: 'changed',
        },
        recommendation: { targetPrefix: 'TARGET-N' },
      }),
    })),
    report: vi.fn(async () => JSON.stringify({
      schema: 'chrome-cdp-ex.report.v1',
      targetPrefix: 'TARGET-N',
      counts: { actions: 1 },
      latestAction: { action: 'click', outcome: 'changed' },
    })),
    cleanup: vi.fn(async () => {}),
    expectedTitle: TITLE,
    expectedUrl: URL,
    ...overrides,
  };
}

function cleanupFixture(overrides = {}) {
  let profilePresent = true;
  let runtimePresent = true;
  const fixture = {
    supervisor: { close: vi.fn(async () => {}) },
    targetIds: new Set(['TARGET-OLD']),
    discoverTargetIds: vi.fn(async () => ['TARGET-OLD', 'TARGET-UNTRACKED']),
    stopTarget: vi.fn(async () => {}),
    browser: { pid: 42 },
    stopBrowserProcess: vi.fn(async () => {}),
    server: { listening: true },
    closeHttpServer: vi.fn(async () => {}),
    profileDir: '/fixture/profile',
    runtimeDir: '/fixture/profile/runtime',
    removeProfile: vi.fn(() => { profilePresent = false; }),
    removeRuntime: vi.fn(() => { runtimePresent = false; }),
    pathExists: vi.fn(path => path.endsWith('/runtime') ? runtimePresent : profilePresent),
    restoreEnvironment: vi.fn(() => {}),
    timeoutMs: 50,
    ...overrides,
  };
  return fixture;
}

function waitForSpawn(child) {
  return new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([
    exited,
    new Promise((resolve, reject) => setTimeout(() => reject(new Error('fixture child did not exit')), 500)),
  ]);
}

function closeListener(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

function canConnect(port) {
  return new Promise(resolve => {
    const socket = connectNet({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

describe('Phase 5 disposable supervisor scenario', () => {
  it('accepts exact CLI/direct-MCP perception semantics without requiring byte identity', () => {
    expect(assertPhase5SemanticParity(perception('ABC12345'), perception('ABC12345'), {
      expectedTitle: TITLE,
      expectedUrl: URL,
      expectedCliTargetPrefix: 'ABC12345',
      expectedMcpTargetPrefix: 'ABC12345',
    })).toEqual({
      schema: 'chrome-cdp-ex.perceive.v1',
      title: TITLE,
      url: URL,
    });
    expect(() => assertPhase5SemanticParity(perception(), JSON.stringify({
      schema: 'chrome-cdp-ex.perceive.v1',
      targetPrefix: 'ABC12345',
      page: { title: 'wrong', url: URL },
    }), {
      expectedTitle: TITLE,
      expectedUrl: URL,
      expectedCliTargetPrefix: 'ABC12345',
      expectedMcpTargetPrefix: 'ABC12345',
    })).toThrow(/title/);
    expect(() => assertPhase5SemanticParity(perception('WRONG'), perception('ABC12345'), {
      expectedTitle: TITLE,
      expectedUrl: URL,
      expectedCliTargetPrefix: 'ABC12345',
      expectedMcpTargetPrefix: 'ABC12345',
    })).toThrow(/target/);
    const stripped = JSON.stringify({
      schema: 'chrome-cdp-ex.perceive.v1', targetPrefix: 'ABC12345', page: { title: TITLE, url: URL },
    });
    expect(() => assertPhase5SemanticParity(perception(), stripped, {
      expectedTitle: TITLE,
      expectedUrl: URL,
      expectedCliTargetPrefix: 'ABC12345',
      expectedMcpTargetPrefix: 'ABC12345',
    })).toThrow(/viewport|structure/);
  });

  it('runs the exact discovery-through-rebind sequence and always cleans up', async () => {
    const fixture = steps();
    await expect(runPhase5SupervisorSession(fixture)).resolves.toMatchObject({
      initialTargetId: 'TARGET-OLD',
      replacementTargetId: 'TARGET-NEW',
      beforeRevision: 1,
      afterRevision: 2,
      reportActions: 1,
    });
    expect(fixture.cleanup).toHaveBeenCalledOnce();
    expect(fixture.stopDaemon).toHaveBeenCalledOnce();
    expect(fixture.restart).toHaveBeenCalledOnce();
    expect(fixture.rebind).toHaveBeenCalledOnce();
  });

  it.each([
    'discover',
    'resolve',
    'connect',
    'executeCli',
    'executeMcp',
    'stopDaemon',
    'restart',
    'replaceTarget',
    'rebind',
    'report',
  ])('fails at %s and still runs cleanup exactly once', async failureStep => {
    const resources = cleanupFixture();
    const fixture = steps({
      [failureStep]: vi.fn(async () => { throw new Error(`forced ${failureStep} failure`); }),
      cleanup: vi.fn(() => cleanupPhase5Resources(resources)),
    });
    await expect(runPhase5SupervisorSession(fixture)).rejects.toThrow(`forced ${failureStep} failure`);
    expect(fixture.cleanup).toHaveBeenCalledOnce();
    expect(resources.supervisor.close).toHaveBeenCalledOnce();
    expect(resources.stopTarget).toHaveBeenCalledTimes(2);
    expect(resources.stopTarget).toHaveBeenCalledWith('TARGET-OLD');
    expect(resources.stopTarget).toHaveBeenCalledWith('TARGET-UNTRACKED');
    expect(resources.stopBrowserProcess).toHaveBeenCalledWith(resources.browser);
    expect(resources.closeHttpServer).toHaveBeenCalledWith(resources.server);
    expect(resources.removeProfile).toHaveBeenCalledWith(resources.profileDir);
    expect(resources.removeRuntime).toHaveBeenCalledWith(resources.runtimeDir);
    expect(resources.restoreEnvironment).toHaveBeenCalledOnce();
  });

  it('continues every cleanup category and preserves all cleanup failures', async () => {
    const failures = {
      discover: new Error('discover cleanup failed'),
      supervisor: new Error('supervisor cleanup failed'),
      target: new Error('target cleanup failed'),
      browser: new Error('browser cleanup failed'),
      server: new Error('server cleanup failed'),
      profile: new Error('profile cleanup failed'),
      runtime: new Error('runtime cleanup failed'),
      restore: new Error('restore cleanup failed'),
    };
    const resources = cleanupFixture({
      discoverTargetIds: vi.fn(async () => { throw failures.discover; }),
      supervisor: { close: vi.fn(async () => { throw failures.supervisor; }) },
      stopTarget: vi.fn(async () => { throw failures.target; }),
      stopBrowserProcess: vi.fn(async () => { throw failures.browser; }),
      closeHttpServer: vi.fn(async () => { throw failures.server; }),
      removeProfile: vi.fn(() => { throw failures.profile; }),
      removeRuntime: vi.fn(() => { throw failures.runtime; }),
      restoreEnvironment: vi.fn(() => { throw failures.restore; }),
      pathExists: vi.fn(() => false),
    });

    try {
      await cleanupPhase5Resources(resources);
      throw new Error('expected cleanup failure');
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect(error.errors).toEqual(Object.values(failures));
    }
    expect(resources.stopTarget).toHaveBeenCalledOnce();
    expect(resources.stopBrowserProcess).toHaveBeenCalledOnce();
    expect(resources.closeHttpServer).toHaveBeenCalledOnce();
    expect(resources.removeProfile).toHaveBeenCalledOnce();
    expect(resources.removeRuntime).toHaveBeenCalledOnce();
    expect(resources.restoreEnvironment).toHaveBeenCalledOnce();
  });

  it('releases the real live-run lock after a forced orchestration failure', async () => {
    const lockRoot = mkdtempSync(join(tmpdir(), 'phase5-lock-proof-'));
    const scope = join(lockRoot, 'scope');
    let lockDir;
    try {
      await expect(withLiveBenchmarkLock({
        name: 'phase5-forced-failure', lockRoot, scope,
      }, async run => {
        lockDir = run.lockDir;
        expect(existsSync(lockDir)).toBe(true);
        throw new Error('forced orchestration failure');
      })).rejects.toThrow('forced orchestration failure');
      expect(existsSync(lockDir)).toBe(false);
    } finally {
      rmSync(lockRoot, { recursive: true, force: true });
    }
  });

  it('removes real child processes, port, socket, profile, and environment state', async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'phase5-real-cleanup-'));
    const profileDir = join(fixtureRoot, 'profile');
    const runtimeDir = join(profileDir, 'runtime');
    mkdirSync(runtimeDir, { recursive: true });
    const socketPath = process.platform === 'win32'
      ? `\\\\.\\pipe\\phase5-cleanup-${process.pid}-${Date.now()}`
      : join(runtimeDir, 'daemon.sock');
    const daemon = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    const browser = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    const socketServer = createNetServer();
    const httpServer = createHttpServer((_request, response) => response.end('ok'));
    let restored = false;
    try {
      await Promise.all([waitForSpawn(daemon), waitForSpawn(browser)]);
      await new Promise((resolve, reject) => {
        socketServer.once('error', reject);
        socketServer.listen(socketPath, resolve);
      });
      await new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(0, '127.0.0.1', resolve);
      });
      const port = httpServer.address().port;
      expect(await canConnect(port)).toBe(true);

      await cleanupPhase5Resources({
        supervisor: { close: async () => {} },
        targetIds: new Set(['TARGET-REAL']),
        discoverTargetIds: async () => ['TARGET-REAL'],
        stopTarget: async () => {
          await closeListener(socketServer);
          await stopChild(daemon);
        },
        browser,
        stopBrowserProcess: stopChild,
        server: httpServer,
        closeHttpServer: closeListener,
        profileDir,
        runtimeDir,
        removeProfile: path => rmSync(path, { recursive: true, force: true }),
        removeRuntime: path => rmSync(path, { recursive: true, force: true }),
        pathExists: existsSync,
        restoreEnvironment: () => { restored = true; },
        timeoutMs: 500,
        browserTimeoutMs: 500,
      });

      expect(daemon.exitCode !== null || daemon.signalCode !== null).toBe(true);
      expect(browser.exitCode !== null || browser.signalCode !== null).toBe(true);
      expect(socketServer.listening).toBe(false);
      expect(httpServer.listening).toBe(false);
      expect(await canConnect(port)).toBe(false);
      if (process.platform !== 'win32') expect(existsSync(socketPath)).toBe(false);
      expect(existsSync(runtimeDir)).toBe(false);
      expect(existsSync(profileDir)).toBe(false);
      expect(restored).toBe(true);
    } finally {
      await Promise.allSettled([
        stopChild(daemon),
        stopChild(browser),
        closeListener(socketServer),
        closeListener(httpServer),
      ]);
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('preserves both primary and cleanup failures', async () => {
    const primary = new Error('execute failed');
    const cleanup = new Error('cleanup failed');
    const fixture = steps({
      executeMcp: vi.fn(async () => { throw primary; }),
      cleanup: vi.fn(async () => { throw cleanup; }),
    });
    try {
      await runPhase5SupervisorSession(fixture);
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect(error.errors).toEqual([primary, cleanup]);
    }
  });

  it('rejects a successful stop command that reports an explicit no-op', async () => {
    const fixture = steps({
      stopDaemon: vi.fn(async () => JSON.stringify({
        schema: 'chrome-cdp-ex.stop.v1', requestedTarget: 'TARGET-O', stopped: false,
        stoppedTargets: [], failedTargets: [], remainingSessions: 1,
        remainingTargets: ['TARGET-O'], noop: true,
      })),
    });
    await expect(runPhase5SupervisorSession(fixture)).rejects.toThrow(/stop receipt/);
    expect(fixture.restart).not.toHaveBeenCalled();
    expect(fixture.cleanup).toHaveBeenCalledOnce();
  });

  it('rejects fake recovery that does not advance identity and revision', async () => {
    const fixture = steps({
      rebind: vi.fn(async handle => ({
        handle,
        resource: handle.resource(),
        output: perception(),
        action: JSON.stringify({
          schema: 'chrome-cdp-ex.action.v1', action: 'click', dispatch: { ok: true },
          settle: { ok: true }, outcome: { status: 'changed' },
          receipt: {
            schema: 'chrome-cdp-ex.action-receipt.v1', outcome: 'changed',
          },
          recommendation: { targetPrefix: 'TARGET-N' },
        }),
      })),
    });
    await expect(runPhase5SupervisorSession(fixture)).rejects.toThrow(/did not advance/);
    expect(fixture.cleanup).toHaveBeenCalledOnce();
  });

  it('rejects an invalid final report after recovery', async () => {
    const fixture = steps({
      report: vi.fn(async () => JSON.stringify({ schema: 'wrong', counts: { actions: 0 } })),
    });
    await expect(runPhase5SupervisorSession(fixture)).rejects.toThrow(/report/);
    expect(fixture.cleanup).toHaveBeenCalledOnce();
  });
});
