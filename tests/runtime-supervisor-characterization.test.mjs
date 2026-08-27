import { EventEmitter } from 'events';
import { readFileSync } from 'fs';
import { PassThrough } from 'stream';
import { describe, expect, it, vi } from 'vitest';

import { __test__ as cdpTest } from '../skills/chrome-cdp-ex/scripts/cdp.mjs';
import {
  createMcpRequestHandler,
} from '../skills/chrome-cdp-ex/scripts/mcp-server.mjs';
import { commandResult } from '../skills/chrome-cdp-ex/scripts/lib/command-application.mjs';
import { createCommandDispatcher } from '../skills/chrome-cdp-ex/scripts/lib/command-dispatch.mjs';
import { createRuntimeClient } from '../skills/chrome-cdp-ex/scripts/lib/runtime-client.mjs';

const packageVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const contract = JSON.parse(readFileSync(
  new URL(`../docs/contracts/v${packageVersion}/public-contracts.v1.json`, import.meta.url),
  'utf8',
));

function fakeChild({ code = 0, stdout = '', stderr = '' } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  queueMicrotask(() => {
    if (stdout) child.stdout.write(stdout);
    if (stderr) child.stderr.write(stderr);
    child.stdout.end();
    child.stderr.end();
    child.emit('close', code);
  });
  return child;
}

function runLegacyCdpCommand(command, { spawnProcess, scriptPath, env }) {
  return new Promise(resolveResult => {
    const child = spawnProcess(process.execPath, [scriptPath, ...command], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('close', code => resolveResult({
      code,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
    }));
  });
}

function makeConnection(responseChunks) {
  const conn = new EventEmitter();
  conn.writes = [];
  conn.write = vi.fn(payload => {
    conn.writes.push(payload);
    queueMicrotask(() => responseChunks.forEach(chunk => conn.emit('data', chunk)));
  });
  conn.end = vi.fn();
  conn.destroy = vi.fn();
  return conn;
}

describe('Phase 5 current runtime characterization', () => {
  it('preserves protocol discovery order while filtering internal pages and resolves the current alias', async () => {
    const targetInfos = [
      { targetId: 'WORKER', type: 'service_worker', url: 'https://worker.test/' },
      { targetId: 'SECOND', type: 'page', title: 'Second', url: 'https://second.test/' },
      { targetId: 'INTERNAL', type: 'page', title: 'Settings', url: 'chrome://settings/' },
      { targetId: 'FIRST', type: 'page', title: 'First', url: 'https://first.test/' },
      { targetId: 'BLANK', type: 'page', title: '', url: 'about:blank' },
    ];
    const cdp = { send: vi.fn(async () => ({ targetInfos })) };
    await expect(cdpTest.getPages(cdp)).resolves.toEqual([
      targetInfos[1], targetInfos[3], targetInfos[4],
    ]);
    expect(cdp.send).toHaveBeenCalledWith('Target.getTargets');

    const store = cdpTest.upsertTargetAlias(cdpTest.emptyAliasStore(), {
      name: 'app',
      targetId: 'FIRST',
      now: '2026-08-12T00:00:00.000Z',
    });
    expect(cdpTest.resolveTargetAlias('current', store)).toEqual(store.aliases.app);
    expect(cdpTest.resolveLiveTargetBinding({
      requested: 'current',
      livePages: [targetInfos[1], targetInfos[3]],
      alias: cdpTest.resolveTargetAlias('current', store),
    })).toMatchObject({
      requestedTargetPrefix: 'current',
      requestedTargetId: 'FIRST',
      resolvedTargetId: 'FIRST',
      resolutionSource: 'live-discovery+alias',
    });
  });

  it('projects only exact-target fields into supervisor discovery candidates', () => {
    const browserIdentity = { kind: 'browser', id: 'browser-runtime', revision: 0 };
    const candidates = cdpTest.buildExactTargetSupervisorCandidates([
      { targetId: 'TARGET-OK', url: 'https://ok.test/' },
      { targetId: 'UNRELATED', url: `data:text/plain,${'x'.repeat(4_096)}` },
    ], 'TARGET-OK', browserIdentity);
    expect(candidates).toHaveLength(2);
    expect(candidates.map(item => item.url)).toEqual(['', '']);
    expect(candidates.map(item => item.targetId)).toEqual(['TARGET-OK', 'UNRELATED']);
    expect(candidates[0]).toMatchObject({ current: true, browser: browserIdentity });
    expect(candidates[1]).toMatchObject({ current: false, browser: browserIdentity });
    const reordered = cdpTest.buildExactTargetSupervisorCandidates([
      { targetId: 'UNRELATED', url: 'https://other.test/' },
      { targetId: 'TARGET-OK', url: 'https://ok.test/' },
    ], 'TARGET-OK', browserIdentity);
    expect(reordered[1].resource.id).toBe(candidates[0].resource.id);
    expect(candidates[0].resource.id).not.toContain('TARGET-OK');
  });

  it('freezes Unix socket and Windows named-pipe endpoint boundaries', () => {
    expect(cdpTest.daemonEndpointForPlatform('AABB1111FULL', {
      platform: 'linux',
      runtimeDir: '/runtime/cdp',
    })).toBe('/runtime/cdp/cdp-AABB1111FULL.sock');
    expect(cdpTest.daemonEndpointForPlatform('AABB1111FULL', {
      platform: 'darwin',
      runtimeDir: '/runtime/cdp',
    })).toBe('/runtime/cdp/cdp-AABB1111FULL.sock');
    expect(cdpTest.daemonEndpointForPlatform('AABB1111FULL', {
      platform: 'win32',
      runtimeDir: 'C:\\ignored',
    })).toBe('\\\\.\\pipe\\cdp-AABB1111FULL');
  });

  it('freezes bounded daemon startup retry success and timeout behavior', async () => {
    const existingConnection = { id: 'existing' };
    const existingConnect = vi.fn(async () => existingConnection);
    const existingUnlink = vi.fn();
    const existingSpawn = vi.fn();
    const existingDelay = vi.fn();
    await expect(cdpTest.getOrStartTabDaemon('EXISTING', {
      connect: existingConnect,
      unlink: existingUnlink,
      spawnProcess: existingSpawn,
      delay: existingDelay,
      platform: 'linux',
      runtimeDir: '/runtime/cdp',
    })).resolves.toBe(existingConnection);
    expect(existingConnect).toHaveBeenCalledOnce();
    expect(existingUnlink).not.toHaveBeenCalled();
    expect(existingSpawn).not.toHaveBeenCalled();
    expect(existingDelay).not.toHaveBeenCalled();

    const connection = { id: 'connected' };
    const connect = vi.fn()
      .mockRejectedValueOnce(new Error('no existing daemon'))
      .mockRejectedValueOnce(new Error('not ready'))
      .mockResolvedValueOnce(connection);
    const unlink = vi.fn();
    const unref = vi.fn();
    const spawnProcess = vi.fn(() => ({ unref }));
    const delay = vi.fn(async () => {});

    await expect(cdpTest.getOrStartTabDaemon('AABB1111FULL', {
      connect,
      unlink,
      spawnProcess,
      delay,
      retries: 2,
      retryDelayMs: 17,
      platform: 'linux',
      runtimeDir: '/runtime/cdp',
      scriptPath: '/fixture/cdp.mjs',
      execPath: '/fixture/node',
      env: { CDP_PORT: '9222' },
    })).resolves.toBe(connection);
    expect(connect).toHaveBeenCalledTimes(3);
    expect(connect).toHaveBeenCalledWith('/runtime/cdp/cdp-AABB1111FULL.sock');
    expect(unlink).toHaveBeenCalledOnce();
    expect(spawnProcess).toHaveBeenCalledWith('/fixture/node', [
      '/fixture/cdp.mjs', '_daemon', 'AABB1111FULL',
    ], {
      detached: true,
      stdio: 'ignore',
      env: { CDP_PORT: '9222' },
    });
    expect(unref).toHaveBeenCalledOnce();
    expect(delay).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenNthCalledWith(1, 17);
    expect(delay).toHaveBeenNthCalledWith(2, 17);

    const timeoutConnect = vi.fn(async () => { throw new Error('still unavailable'); });
    await expect(cdpTest.getOrStartTabDaemon('CCDD2222FULL', {
      connect: timeoutConnect,
      unlink: vi.fn(),
      spawnProcess: () => ({ unref() {} }),
      delay: async () => {},
      retries: 3,
      retryDelayMs: 1,
      platform: 'win32',
      runtimeDir: 'C:\\ignored',
      scriptPath: '/fixture/cdp.mjs',
      execPath: '/fixture/node',
    })).rejects.toThrow('Daemon failed to start — did you click Allow in Chrome?');
    expect(timeoutConnect).toHaveBeenCalledTimes(4);
    expect(timeoutConnect).toHaveBeenCalledWith('\\\\.\\pipe\\cdp-CCDD2222FULL');
  });

  it('freezes target prefix ambiguity, alias/current recovery, and target mismatch authority', () => {
    expect(() => cdpTest.resolvePrefix('AABB', ['AABB1111', 'AABB2222']))
      .toThrow('Ambiguous prefix "AABB"');
    expect(() => cdpTest.resolvePrefix('MISSING', ['AABB1111']))
      .toThrow('No target matching prefix "MISSING"');

    const pages = [
      { targetId: 'AABB1111FULL', url: 'https://one.test/' },
      { targetId: 'CCDD2222FULL', url: 'https://two.test/' },
    ];
    expect(cdpTest.resolveLiveTargetBinding({
      requested: 'app',
      livePages: pages,
      alias: { name: 'app', targetId: 'CCDD2222FULL' },
    })).toMatchObject({ resolvedTargetId: 'CCDD2222FULL', resolutionSource: 'live-discovery+alias' });
    expect(cdpTest.resolveLiveTargetBinding({
      requested: 'AABB1111',
      livePages: pages,
      daemonBinding: { boundTargetId: 'CCDD2222FULL' },
    })).toMatchObject({ resolvedTargetId: 'AABB1111FULL' });

    const current = cdpTest.collectDaemonMetadata({
      scriptPath: new URL('../skills/chrome-cdp-ex/scripts/cdp.mjs', import.meta.url),
      now: 1_700_000_000_000,
      pid: 22,
    });
    expect(cdpTest.assessDaemonFreshness({
      targetPrefix: 'AABB1111',
      expectedTargetId: 'AABB1111FULL',
      current,
      daemon: { ...current, boundTargetId: 'CCDD2222FULL' },
    })).toMatchObject({
      stale: true,
      status: 'target-mismatch',
      mismatches: [expect.objectContaining({ field: 'boundTargetId' })],
    });
  });

  it('freezes daemon socket naming, NDJSON request framing, partial replies, and first-response completion', async () => {
    expect(cdpTest.sockPath('AABB1111FULL')).toMatch(
      process.platform === 'win32' ? /cdp-AABB1111FULL$/ : /cdp-AABB1111FULL\.sock$/,
    );
    const conn = makeConnection([
      '{"ok":true,',
      '"result":"first"}\n{"ok":true,"result":"ignored"}\n',
    ]);
    const request = { cmd: 'report', args: ['--format', 'json'] };
    await expect(cdpTest.sendCommand(conn, request)).resolves.toEqual({ ok: true, result: 'first' });
    expect(conn.write).toHaveBeenCalledWith(
      '{"cmd":"report","args":["--format","json"],"id":1}\n',
    );
    expect(request.id).toBe(1);
    expect(conn.end).toHaveBeenCalledOnce();
  });

  it('freezes stop behavior for one selected daemon and stale-socket removal', async () => {
    const unlink = vi.fn();
    const sent = [];
    const daemons = [
      { targetId: 'AABB1111FULL', socketPath: '/runtime/cdp-AABB1111FULL.sock' },
      { targetId: 'CCDD2222FULL', socketPath: '/runtime/cdp-CCDD2222FULL.sock' },
    ];
    const model = await cdpTest.stopDaemons('AABB1111', {
      list: () => daemons,
      connect: async path => ({ path }),
      send: async (conn, request) => {
        sent.push({ conn, request });
        return { ok: true };
      },
      unlink,
      platform: 'linux',
    });
    expect(sent).toEqual([{
      conn: { path: '/runtime/cdp-AABB1111FULL.sock' },
      request: { cmd: 'stop', args: [] },
    }]);
    expect(unlink).not.toHaveBeenCalled();
    expect(model).toMatchObject({
      requestedTarget: 'AABB1111',
      stopped: true,
      stoppedTargets: ['AABB1111'],
      remainingSessions: 1,
    });

    const stale = await cdpTest.stopDaemons('AABB1111', {
      list: () => daemons,
      connect: async () => { throw new Error('stale socket'); },
      send: async () => { throw new Error('not reached'); },
      unlink,
      platform: 'linux',
    });
    expect(unlink).toHaveBeenCalledWith('/runtime/cdp-AABB1111FULL.sock');
    expect(stale).toMatchObject({
      requestedTarget: 'AABB1111',
      stopped: false,
      stoppedTargets: [],
      failedTargets: [],
      remainingSessions: 1,
    });
  });
});

describe('Phase 5 current MCP process boundary characterization', () => {
  it('spawns exactly one cdp.mjs child and preserves trim/error collection for one command', async () => {
    const spawnProcess = vi.fn(() => fakeChild({
      code: 7,
      stdout: '  partial stdout  \n',
      stderr: '  exact stderr  \n',
    }));
    await expect(runLegacyCdpCommand(['doctor', '--format', 'json'], {
      spawnProcess,
      scriptPath: '/fixture/cdp.mjs',
      env: { CDP_PORT: '9222' },
    })).resolves.toEqual({
      code: 7,
      stdout: 'partial stdout',
      stderr: 'exact stderr',
    });
    expect(spawnProcess).toHaveBeenCalledOnce();
    expect(spawnProcess).toHaveBeenCalledWith(process.execPath, [
      '/fixture/cdp.mjs', 'doctor', '--format', 'json',
    ], {
      env: { CDP_PORT: '9222' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  });

  it('maps every frozen valid tool case through one direct RuntimeClient execution', async () => {
    const executeCli = vi.fn(async command => ({
      code: 0,
      stdout: JSON.stringify(command),
      stderr: '',
    }));
    const sent = [];
    const handle = createMcpRequestHandler({
      runtimeClient: createRuntimeClient({ executeCli }),
      sendMessage: message => sent.push(message),
    });

    for (const [index, fixture] of contract.mcp.mappingCases.entries()) {
      await handle({
        jsonrpc: '2.0',
        id: index + 1,
        method: 'tools/call',
        params: { name: fixture.tool, arguments: fixture.args },
      });
      expect(sent.at(-1)).toEqual({
        jsonrpc: '2.0',
        id: index + 1,
        result: {
          content: [{ type: 'text', text: JSON.stringify(fixture.command) }],
          isError: false,
        },
      });
    }
    expect(executeCli).toHaveBeenCalledTimes(contract.mcp.mappingCases.length);
  });

  it('rejects all frozen invalid mappings before direct runtime execution', async () => {
    const executeCli = vi.fn();
    const sent = [];
    const handle = createMcpRequestHandler({
      runtimeClient: createRuntimeClient({ executeCli }),
      sendMessage: message => sent.push(message),
    });
    for (const [index, fixture] of contract.mcp.invalidCases.entries()) {
      await handle({
        jsonrpc: '2.0',
        id: index + 1,
        method: fixture.kind === 'resource' ? 'resources/read' : 'tools/call',
        params: fixture.kind === 'resource'
          ? { uri: fixture.uri }
          : { name: fixture.tool, arguments: fixture.args },
      });
      expect(sent.at(-1).error).toMatchObject({ code: -32000, message: fixture.error });
    }
    expect(executeCli).not.toHaveBeenCalled();
  });

  it('maps every frozen resource read through one direct runtime execution', async () => {
    const executeCli = vi.fn(async command => ({
      code: 0,
      stdout: JSON.stringify(command),
      stderr: '',
    }));
    const sent = [];
    const handle = createMcpRequestHandler({
      runtimeClient: createRuntimeClient({ executeCli }),
      sendMessage: message => sent.push(message),
    });
    for (const [index, fixture] of contract.mcp.resourceMappings.entries()) {
      await handle({
        jsonrpc: '2.0',
        id: index + 1,
        method: 'resources/read',
        params: { uri: fixture.uri },
      });
      expect(executeCli).toHaveBeenLastCalledWith(fixture.command);
      expect(sent.at(-1).result.contents[0]).toMatchObject({
        uri: fixture.uri,
        text: JSON.stringify(fixture.command),
      });
    }
    expect(executeCli).toHaveBeenCalledTimes(contract.mcp.resourceMappings.length);
  });

  it('freezes content and error parity across direct, daemon-wire, batch, flow, and MCP boundaries', async () => {
    const outputs = new Map([
      ['perceive', '{"schema":"fixture.perceive","ok":true}'],
      ['report', '{"schema":"fixture.report","actions":1}'],
      ['click', '{"schema":"fixture.click","changed":true}'],
      ['evalraw', '{"result":{"value":"Fixture"}}'],
      ['eval', '3'],
      ['eval64', '多語'],
      ['call', '{"ok":true}'],
      ['console', 'Console baseline cleared'],
      ['record', 'Record timeline (100ms)'],
      ['summary', 'Fixture — https://fixture.test/'],
      ['fill', '{"schema":"fixture.fill","changed":true}'],
      ['hover', 'Hovered #fixture'],
      ['press', '{"schema":"fixture.press","key":"Enter"}'],
      ['scroll', '{"schema":"fixture.scroll","changed":true}'],
      ['select', '{"schema":"fixture.select","changed":true}'],
      ['clickxy', '{"schema":"fixture.clickxy","changed":true}'],
      ['dismiss-modal', '{"schema":"fixture.dismiss-modal","changed":true}'],
      ['jsclick', '{"schema":"fixture.jsclick","changed":true}'],
      ['type', '{"schema":"fixture.type","changed":true}'],
      ['verify-click', '{"schema":"fixture.verify-click","changed":true}'],
      ['nav', '{"schema":"fixture.nav","url":"https://fixture.test/next"}'],
      ['navigate', '{"schema":"fixture.navigate","url":"https://fixture.test/alias"}'],
      ['back', '{"schema":"fixture.back","url":"https://fixture.test/"}'],
      ['forward', '{"schema":"fixture.forward","url":"https://fixture.test/next"}'],
      ['reload', '{"schema":"fixture.reload","changed":true}'],
      ['mock', '{"schema":"fixture.mock","rules":1}'],
      ['network-mock', '{"schema":"fixture.network-mock","rules":1}'],
      ['clock', '{"schema":"fixture.clock","profile":"freeze"}'],
      ['closetab', 'Closed tab: ABCDEF01'],
      ['time-travel', '{"schema":"fixture.time-travel","profile":"freeze"}'],
      ['throttle', '{"schema":"fixture.throttle","profile":"fast-3g"}'],
      ['network-throttle', '{"schema":"fixture.network-throttle","profile":"fast-3g"}'],
      ['viewport', '{"schema":"fixture.viewport","width":390,"height":844}'],
      ['viewport-read', 'Viewport: 1280×720 (DPR: 1)'],
      ['resize', '{"schema":"fixture.resize","width":390,"height":844}'],
      ['emulate', '{"schema":"fixture.emulate","colorScheme":"dark"}'],
      ['cookieset', 'Cookie set: fixture_cookie=fixture-value'],
      ['cookiedel', 'Cookie deleted: fixture_cookie'],
      ['dialog', 'Dialog auto-accept: off'],
      ['keepalive', 'Keepalive extended by 1000ms'],
      ['loadall', 'Clicked "#load-more" 2 time(s) until it disappeared'],
      ['netlog', 'No network requests recorded.'],
      ['html', '<main>Fixture</main>'],
      ['text', 'Fixture text'],
      ['table', 'Fixture table:\nName\tValue'],
      ['net', 'Fixture network'],
      ['network', 'Fixture network alias'],
      ['status', 'Fixture status'],
      ['status-json', '{"schema":"fixture.status","format":"json"}'],
      ['status-runtime', 'Fixture status\nRuntime metrics (Performance.getMetrics):'],
      ['snap', 'RootWebArea "Fixture"'],
      ['snapshot', 'RootWebArea "Fixture" full'],
      ['controls', '{"schema":"fixture.controls","count":3}'],
      ['frame', '{"schema":"fixture.frames","count":1}'],
      ['frames', '{"schema":"fixture.frames","count":1,"alias":true}'],
      ['overlay', '{"schema":"fixture.overlay","dialogs":0}'],
      ['overlays', '{"schema":"fixture.overlay","dialogs":0,"alias":true}'],
      ['styles', 'display: block\ncolor: rgb(0, 0, 0)'],
      ['components', '{"schema":"fixture.components","frameworks":[]}'],
      ['record-actions', '{"schema":"fixture.actions","actions":1}'],
      ['recordactions', '{"schema":"fixture.actions","actions":1,"alias":true}'],
      ['export-playwright', 'test("fixture", async ({ page }) => {})'],
      ['export-pw', 'test("fixture alias", async ({ page }) => {})'],
      ['wait', 'Waited 25ms'],
      ['waitfor', 'Text appeared: Ready'],
      ['cascade', '{"schema":"fixture.cascade","property":"color"}'],
      ['checkpoint', 'Checkpoint captured\nPrivacy: default-redacted'],
      ['cookies', 'fixture_cookie  fixture-value'],
      ['qa', '{"schema":"fixture.qa","verdict":"pass"}'],
      ['qa-page', '{"schema":"fixture.qa","verdict":"pass","alias":true}'],
      ['responsive-audit', '{"schema":"fixture.responsive","verdict":"pass"}'],
      ['visual-check', '{"schema":"fixture.responsive","verdict":"pass","alias":true}'],
    ]);
    const failures = new Map([
      ['perceive', 'perceive fixture failure'],
      ['report', 'report fixture failure'],
      ['click', 'click fixture failure'],
      ['evalraw', 'evalraw fixture failure'],
      ['eval', 'eval fixture failure'],
      ['eval64', 'eval64 fixture failure'],
      ['call', 'call fixture failure'],
      ['console', 'console fixture failure'],
      ['record', 'record fixture failure'],
      ['summary', 'summary fixture failure'],
      ['fill', 'fill fixture failure'],
      ['hover', 'hover fixture failure'],
      ['press', 'press fixture failure'],
      ['scroll', 'scroll fixture failure'],
      ['select', 'select fixture failure'],
      ['clickxy', 'clickxy fixture failure'],
      ['dismiss-modal', 'dismiss modal fixture failure'],
      ['jsclick', 'jsclick fixture failure'],
      ['type', 'type fixture failure'],
      ['verify-click', 'verify click fixture failure'],
      ['nav', 'nav fixture failure'],
      ['navigate', 'navigate alias fixture failure'],
      ['back', 'back fixture failure'],
      ['forward', 'forward fixture failure'],
      ['reload', 'reload fixture failure'],
      ['mock', 'mock fixture failure'],
      ['network-mock', 'network mock alias fixture failure'],
      ['clock', 'clock fixture failure'],
      ['closetab', 'closetab fixture failure'],
      ['time-travel', 'time travel alias fixture failure'],
      ['throttle', 'throttle fixture failure'],
      ['network-throttle', 'network throttle alias fixture failure'],
      ['viewport', 'viewport fixture failure'],
      ['viewport-read', 'viewport read fixture failure'],
      ['resize', 'resize alias fixture failure'],
      ['emulate', 'emulate fixture failure'],
      ['cookieset', 'cookieset fixture failure'],
      ['cookiedel', 'cookiedel fixture failure'],
      ['dialog', 'dialog fixture failure'],
      ['keepalive', 'keepalive fixture failure'],
      ['loadall', 'loadall fixture failure'],
      ['netlog', 'netlog fixture failure'],
      ['html', 'html fixture failure'],
      ['text', 'text fixture failure'],
      ['table', 'table fixture failure'],
      ['net', 'net fixture failure'],
      ['network', 'network alias fixture failure'],
      ['status', 'status fixture failure'],
      ['status-json', 'status json fixture failure'],
      ['status-runtime', 'status runtime fixture failure'],
      ['snap', 'snap fixture failure'],
      ['snapshot', 'snapshot alias fixture failure'],
      ['controls', 'controls fixture failure'],
      ['frame', 'frame fixture failure'],
      ['frames', 'frames alias fixture failure'],
      ['overlay', 'overlay fixture failure'],
      ['overlays', 'overlay alias fixture failure'],
      ['styles', 'styles fixture failure'],
      ['components', 'components fixture failure'],
      ['record-actions', 'record actions fixture failure'],
      ['recordactions', 'record actions alias fixture failure'],
      ['export-playwright', 'export playwright fixture failure'],
      ['export-pw', 'export playwright alias fixture failure'],
      ['wait', 'wait fixture failure'],
      ['waitfor', 'waitfor fixture failure'],
      ['cascade', 'cascade fixture failure'],
      ['checkpoint', 'checkpoint fixture failure'],
      ['cookies', 'cookies fixture failure'],
      ['qa', 'qa fixture failure'],
      ['qa-page', 'qa alias fixture failure'],
      ['responsive-audit', 'responsive audit fixture failure'],
      ['visual-check', 'visual check alias fixture failure'],
    ]);
    const cases = [
      { cmd: 'perceive', args: ['--format', 'json'], tool: 'perceive', toolArgs: { target: 'fixture', adaptive: false } },
      { cmd: 'report', args: ['--format', 'json'], tool: 'report', toolArgs: { target: 'fixture' } },
      { cmd: 'click', args: ['@1', '--format', 'json'], tool: 'click', toolArgs: { target: 'fixture', selector: '@1', confirm: true } },
      { cmd: 'evalraw', args: ['DOM.getDocument', '{}'], mcpDenied: 'run_command command not allowlisted: evalraw' },
      { cmd: 'eval', args: ['1 + 2'], mcpDenied: 'run_command command not allowlisted: eval' },
      { cmd: 'eval64', args: [Buffer.from('"多語"').toString('base64')], mcpDenied: 'run_command command not allowlisted: eval64' },
      { cmd: 'call', args: ['Promise.resolve({ok:true})'], mcpDenied: 'run_command command not allowlisted: call' },
      { cmd: 'console', args: ['--clear'], tool: 'run_command', toolArgs: { command: 'console', args: ['fixture', '--clear'], confirm: true } },
      { cmd: 'record', args: ['100'], tool: 'record_snapshot', toolArgs: { target: 'fixture', durationMs: 100 } },
      { cmd: 'summary', args: [], tool: 'run_command', toolArgs: { command: 'summary', args: ['fixture'] } },
      { cmd: 'fill', args: ['#fixture', 'value', '--format', 'json'], tool: 'fill', toolArgs: { target: 'fixture', selector: '#fixture', text: 'value', confirm: true } },
      { cmd: 'hover', args: ['#fixture'], tool: 'run_command', toolArgs: { command: 'hover', args: ['fixture', '#fixture'], confirm: true } },
      { cmd: 'press', args: ['Enter', '--format', 'json'], tool: 'press', toolArgs: { target: 'fixture', key: 'Enter', confirm: true } },
      { cmd: 'scroll', args: ['down', '100', '--format', 'json'], tool: 'run_command', toolArgs: { command: 'scroll', args: ['fixture', 'down', '100', '--format', 'json'], confirm: true } },
      { cmd: 'select', args: ['#fixture', 'two', '--format', 'json'], tool: 'run_command', toolArgs: { command: 'select', args: ['fixture', '#fixture', 'two', '--format', 'json'], confirm: true } },
      { cmd: 'clickxy', args: ['64', '322', '--format', 'json'], tool: 'run_command', toolArgs: { command: 'clickxy', args: ['fixture', '64', '322', '--format', 'json'], confirm: true } },
      { cmd: 'dismiss-modal', args: ['--format', 'json'], tool: 'run_command', toolArgs: { command: 'dismiss-modal', args: ['fixture', '--format', 'json'], confirm: true } },
      { cmd: 'jsclick', args: ['#fixture', '--format', 'json'], tool: 'run_command', toolArgs: { command: 'jsclick', args: ['fixture', '#fixture', '--format', 'json'], confirm: true } },
      { cmd: 'type', args: ['value', '--format', 'json'], tool: 'run_command', toolArgs: { command: 'type', args: ['fixture', 'value', '--format', 'json'], confirm: true } },
      { cmd: 'verify-click', args: ['#fixture', '--format', 'json'], tool: 'run_command', toolArgs: { command: 'verify-click', args: ['fixture', '#fixture', '--format', 'json'], confirm: true } },
      { cmd: 'nav', args: ['https://fixture.test/next', '--format', 'json'], tool: 'navigate', toolArgs: { target: 'fixture', url: 'https://fixture.test/next', confirm: true } },
      {
        key: 'navigate', cmd: 'navigate', canonical: 'nav', args: ['https://fixture.test/alias', '--format', 'json'],
        tool: 'run_command', toolArgs: { command: 'navigate', args: ['fixture', 'https://fixture.test/alias', '--format', 'json'], confirm: true },
      },
      { cmd: 'back', args: ['--format', 'json'], tool: 'run_command', toolArgs: { command: 'back', args: ['fixture', '--format', 'json'], confirm: true } },
      { cmd: 'forward', args: ['--format', 'json'], tool: 'run_command', toolArgs: { command: 'forward', args: ['fixture', '--format', 'json'], confirm: true } },
      { cmd: 'reload', args: ['--format', 'json'], tool: 'run_command', toolArgs: { command: 'reload', args: ['fixture', '--format', 'json'], confirm: true } },
      { cmd: 'mock', args: ['add', '**/api/mock', '--status', '201', '--body', 'fixture', '--format', 'json'], tool: 'run_command', toolArgs: { command: 'mock', args: ['fixture', 'add', '**/api/mock', '--status', '201', '--body', 'fixture', '--format', 'json'], confirm: true } },
      { key: 'network-mock', cmd: 'network-mock', canonical: 'mock', args: [], mcpDenied: 'run_command command not allowlisted: network-mock' },
      { cmd: 'clock', args: ['freeze', '--at', '2020-01-02T03:04:05.000Z', '--format', 'json'], tool: 'run_command', toolArgs: { command: 'clock', args: ['fixture', 'freeze', '--at', '2020-01-02T03:04:05.000Z', '--format', 'json'], confirm: true } },
      { cmd: 'closetab', args: [], tool: 'run_command', toolArgs: { command: 'closetab', args: ['fixture'], confirm: true } },
      { key: 'time-travel', cmd: 'time-travel', canonical: 'clock', args: [], mcpDenied: 'run_command command not allowlisted: time-travel' },
      { cmd: 'throttle', args: ['fast-3g', '--format', 'json'], tool: 'run_command', toolArgs: { command: 'throttle', args: ['fixture', 'fast-3g', '--format', 'json'], confirm: true } },
      { key: 'network-throttle', cmd: 'network-throttle', canonical: 'throttle', args: [], mcpDenied: 'run_command command not allowlisted: network-throttle' },
      { cmd: 'viewport', args: ['390x844', '--format', 'json'], tool: 'viewport', toolArgs: { target: 'fixture', size: '390x844', confirm: true } },
      { key: 'viewport-read', cmd: 'viewport', args: [], tool: 'viewport', toolArgs: { target: 'fixture' } },
      {
        key: 'resize', cmd: 'resize', canonical: 'viewport', args: ['390x844', '--format', 'json'],
        tool: 'run_command', toolArgs: { command: 'resize', args: ['fixture', '390x844', '--format', 'json'], confirm: true },
      },
      { cmd: 'emulate', args: ['dark', '--format', 'json'], tool: 'run_command', toolArgs: { command: 'emulate', args: ['fixture', 'dark', '--format', 'json'], confirm: true } },
      { cmd: 'cookieset', args: ['fixture_cookie=fixture-value'], mcpDenied: 'run_command command not allowlisted: cookieset' },
      { cmd: 'cookiedel', args: ['fixture_cookie'], mcpDenied: 'run_command command not allowlisted: cookiedel' },
      { cmd: 'dialog', args: ['off'], tool: 'run_command', toolArgs: { command: 'dialog', args: ['fixture', 'off'], confirm: true } },
      { cmd: 'keepalive', args: ['1000'], tool: 'run_command', toolArgs: { command: 'keepalive', args: ['fixture', '1000'], confirm: true } },
      { cmd: 'loadall', args: ['#load-more', '25'], tool: 'run_command', toolArgs: { command: 'loadall', args: ['fixture', '#load-more', '25'], confirm: true } },
      { cmd: 'netlog', args: [], tool: 'run_command', toolArgs: { command: 'netlog', args: ['fixture'] } },
      { cmd: 'html', args: ['main'], tool: 'run_command', toolArgs: { command: 'html', args: ['fixture', 'main'] } },
      { cmd: 'text', args: ['--auto'], tool: 'run_command', toolArgs: { command: 'text', args: ['fixture', '--auto'] } },
      { cmd: 'table', args: [], tool: 'run_command', toolArgs: { command: 'table', args: ['fixture'] } },
      { cmd: 'net', args: [], tool: 'run_command', toolArgs: { command: 'net', args: ['fixture'] } },
      {
        key: 'network', cmd: 'network', canonical: 'net', args: [],
        mcpDenied: 'run_command command not allowlisted: network',
      },
      { cmd: 'status', args: [], tool: 'run_command', toolArgs: { command: 'status', args: ['fixture'] } },
      { key: 'status-json', cmd: 'status', args: ['--format', 'json'], tool: 'run_command', toolArgs: { command: 'status', args: ['fixture', '--format', 'json'] } },
      { key: 'status-runtime', cmd: 'status', args: ['--runtime'], tool: 'run_command', toolArgs: { command: 'status', args: ['fixture', '--runtime'] } },
      { cmd: 'snap', args: [], tool: 'run_command', toolArgs: { command: 'snap', args: ['fixture'] } },
      {
        key: 'snapshot', cmd: 'snapshot', canonical: 'snap', args: ['--full'],
        tool: 'run_command', toolArgs: { command: 'snapshot', args: ['fixture', '--full'] },
      },
      { cmd: 'controls', args: ['--format', 'json'], tool: 'controls', toolArgs: { target: 'fixture' } },
      { cmd: 'frame', args: ['--format', 'json'], tool: 'run_command', toolArgs: { command: 'frame', args: ['fixture', '--format', 'json'] } },
      {
        key: 'frames', cmd: 'frames', canonical: 'frame', args: ['--format', 'json'],
        tool: 'run_command', toolArgs: { command: 'frames', args: ['fixture', '--format', 'json'] },
      },
      { cmd: 'overlay', args: ['--format', 'json'], tool: 'overlay', toolArgs: { target: 'fixture' } },
      {
        key: 'overlays', cmd: 'overlays', canonical: 'overlay', args: ['--format', 'json'],
        mcpDenied: 'run_command command not allowlisted: overlays',
      },
      { cmd: 'styles', args: ['#auth-panel'], tool: 'run_command', toolArgs: { command: 'styles', args: ['fixture', '#auth-panel'] } },
      { cmd: 'components', args: ['#auth-panel', '--format', 'json'], tool: 'components', toolArgs: { target: 'fixture', selector: '#auth-panel', confirm: true } },
      { cmd: 'record-actions', args: ['--format', 'json'], tool: 'run_command', toolArgs: { command: 'record-actions', args: ['fixture', '--format', 'json'] } },
      {
        key: 'recordactions', cmd: 'recordactions', canonical: 'record-actions', args: ['--format', 'json'],
        mcpDenied: 'run_command command not allowlisted: recordactions',
      },
      { cmd: 'export-playwright', args: [], tool: 'run_command', toolArgs: { command: 'export-playwright', args: ['fixture'] } },
      {
        key: 'export-pw', cmd: 'export-pw', canonical: 'export-playwright', args: [],
        mcpDenied: 'run_command command not allowlisted: export-pw',
      },
      { cmd: 'wait', args: ['25'], tool: 'run_command', toolArgs: { command: 'wait', args: ['fixture', '25'] } },
      { cmd: 'waitfor', args: ['--text', 'Ready', '500'], tool: 'wait_for', toolArgs: { target: 'fixture', text: 'Ready', timeoutMs: 500 } },
      { cmd: 'cascade', args: ['#auth-panel', 'color', '--format', 'json'], tool: 'cascade', toolArgs: { target: 'fixture', selector: '#auth-panel', property: 'color' } },
      { cmd: 'checkpoint', args: [], tool: 'session_checkpoint', toolArgs: { target: 'fixture', confirm: true } },
      { cmd: 'cookies', args: [], tool: 'run_command', toolArgs: { command: 'cookies', args: ['fixture'], confirm: true } },
      {
        cmd: 'qa', args: ['--desktop', '800x600', '--mobile', '390x844', '--format', 'json'],
        tool: 'qa_page', toolArgs: { target: 'fixture', desktop: '800x600', mobile: '390x844', confirm: true },
      },
      {
        key: 'qa-page', cmd: 'qa-page', canonical: 'qa', args: ['--format', 'json'],
        mcpDenied: 'run_command command not allowlisted: qa-page',
      },
      {
        cmd: 'responsive-audit', args: ['--viewport', '800x600', '--format', 'json'],
        tool: 'responsive_audit', toolArgs: { target: 'fixture', viewports: ['800x600'], confirm: true },
      },
      {
        key: 'visual-check', cmd: 'visual-check', canonical: 'responsive-audit', args: ['--format', 'json'],
        mcpDenied: 'run_command visual-check requires confirm: true',
      },
    ];

    const direct = async (entry, fail = false) => {
      const canonical = entry.canonical || entry.cmd;
      const key = entry.key || entry.cmd;
      expect(cdpTest.DAEMON_APPLICATION_COMMANDS).toContain(canonical);
      const evidence = {
        perceive: null,
        report: { kind: 'session-report' },
        click: { kind: 'action-receipt' },
        fill: { kind: 'action-receipt' },
        hover: null,
        press: { kind: 'action-receipt' },
        scroll: { kind: 'action-receipt' },
        select: { kind: 'action-receipt' },
        clickxy: { kind: 'action-receipt' },
        'dismiss-modal': { kind: 'action-receipt' },
        jsclick: { kind: 'action-receipt' },
        type: { kind: 'action-receipt' },
        'verify-click': { kind: 'action-receipt' },
        nav: { kind: 'action-receipt' },
        navigate: { kind: 'action-receipt' },
        back: { kind: 'action-receipt' },
        forward: { kind: 'action-receipt' },
        reload: { kind: 'action-receipt' },
        mock: { kind: 'action-receipt' },
        clock: { kind: 'action-receipt' },
        closetab: { kind: 'action-receipt' },
        throttle: { kind: 'action-receipt' },
        viewport: { kind: 'action-receipt' },
        emulate: { kind: 'action-receipt' },
        cookieset: { kind: 'action-receipt' },
        cookiedel: { kind: 'action-receipt' },
        dialog: null,
        keepalive: null,
        loadall: null,
        netlog: null,
        evalraw: {
          kind: 'raw-audit',
          method: entry.args[0],
          sideEffectClass: 'read-only',
        },
        eval: null,
        eval64: null,
        call: null,
        console: null,
        record: null,
        qa: { kind: 'action-receipt' },
        'responsive-audit': { kind: 'action-receipt' },
      }[canonical];
      const handler = vi.fn(async () => {
        if (fail) throw new Error(failures.get(key));
        return commandResult(outputs.get(key), evidence);
      });
      const registry = cdpTest.createApplicationCommandRegistry(cdpTest.COMMANDS);
      const preflight = cdpTest.preflightDaemonApplication();
      const handlers = Object.fromEntries(cdpTest.DAEMON_APPLICATION_COMMANDS.map(name => [
        name,
        name === canonical
          ? handler
          : vi.fn(async () => commandResult(outputs.get(name), {
            perceive: null,
            report: { kind: 'session-report' },
            click: { kind: 'action-receipt' },
            fill: { kind: 'action-receipt' },
            hover: null,
            press: { kind: 'action-receipt' },
            scroll: { kind: 'action-receipt' },
            select: { kind: 'action-receipt' },
            clickxy: { kind: 'action-receipt' },
            'dismiss-modal': { kind: 'action-receipt' },
            jsclick: { kind: 'action-receipt' },
            type: { kind: 'action-receipt' },
            'verify-click': { kind: 'action-receipt' },
            nav: { kind: 'action-receipt' },
            back: { kind: 'action-receipt' },
            forward: { kind: 'action-receipt' },
            reload: { kind: 'action-receipt' },
            mock: { kind: 'action-receipt' },
            clock: { kind: 'action-receipt' },
            closetab: { kind: 'action-receipt' },
            throttle: { kind: 'action-receipt' },
            viewport: { kind: 'action-receipt' },
            emulate: { kind: 'action-receipt' },
            cookieset: { kind: 'action-receipt' },
            cookiedel: { kind: 'action-receipt' },
            dialog: null,
            keepalive: null,
            loadall: null,
            netlog: null,
            evalraw: { kind: 'raw-audit', method: 'DOM.getDocument', sideEffectClass: 'read-only' },
            eval: null,
            eval64: null,
            call: null,
            console: null,
            record: null,
            qa: { kind: 'action-receipt' },
            'responsive-audit': { kind: 'action-receipt' },
          }[name])),
      ]));
      const dispatcher = createCommandDispatcher({
        registry,
        owners: preflight.routeOwners,
        handlers,
        authorize: cdpTest.authorizeDaemonApplicationCommand,
      });
      const routed = await cdpTest.executeDaemonApplicationRoute({
        cmd: entry.cmd,
        args: entry.args,
        targetBound: true,
      }, dispatcher);
      expect(routed.handled).toBe(true);
      expect(handler).toHaveBeenCalledOnce();
      return routed.result;
    };
    const daemonWire = async (entry, fail = false) => {
      const key = entry.key || entry.cmd;
      const response = fail
        ? { ok: false, error: failures.get(key) }
        : { ok: true, result: outputs.get(key) };
      const conn = makeConnection([`${JSON.stringify(response)}\n`]);
      return cdpTest.sendCommand(conn, { cmd: entry.cmd, args: entry.args });
    };
    const nested = async (entry, fail = false) => {
      try {
        return { ok: true, result: await direct(entry, fail) };
      } catch (error) {
        return { ok: false, error: error.message };
      }
    };

    for (const [index, entry] of cases.entries()) {
      const key = entry.key || entry.cmd;
      await expect(direct(entry)).resolves.toBe(outputs.get(key));
      await expect(daemonWire(entry)).resolves.toEqual({ ok: true, result: outputs.get(key) });

      const parsed = cdpTest.parseBatchArgs([`${entry.cmd} ${entry.args.join(' ')}`.trim()]);
      const batchSteps = await Promise.all(parsed.commands.map(command => nested({ ...entry, ...command })));
      expect(JSON.parse(cdpTest.formatBatchResults(batchSteps.map((step, stepIndex) => ({
        cmd: parsed.commands[stepIndex].cmd,
        ...step,
      }))))[0]).toMatchObject({ ok: true, result: outputs.get(key) });

      const flow = JSON.parse(await cdpTest.flowStr({
        run: () => nested(entry),
        settle: async () => '',
      }, `${entry.cmd} ${entry.args.join(' ')}`.trim(), { format: 'json' }));
      expect(flow.steps[0]).toMatchObject({
        ok: true,
        resultPreview: entry.cmd === 'wait' ? '' : outputs.get(key).split('\n')[0],
      });

      const sent = [];
      const handle = createMcpRequestHandler({
        runtimeClient: createRuntimeClient({ executeCli: async command => {
          expect(command[0]).toBe(entry.cmd);
          return { code: 0, stdout: outputs.get(key), stderr: '' };
        } }),
        sendMessage: message => sent.push(message),
      });
      await handle({
        jsonrpc: '2.0', id: index + 1, method: 'tools/call',
        params: entry.mcpDenied
          ? { name: 'run_command', arguments: { command: entry.cmd, args: ['fixture', ...entry.args] } }
          : { name: entry.tool, arguments: entry.toolArgs },
      });
      if (entry.mcpDenied) {
        expect(sent[0].error).toMatchObject({ code: -32000, message: entry.mcpDenied });
      } else {
        expect(sent[0].result).toEqual({
          content: [{ type: 'text', text: outputs.get(key) }],
          isError: false,
        });
      }

      await expect(direct(entry, true)).rejects.toThrow(failures.get(key));
      await expect(daemonWire(entry, true)).resolves.toEqual({ ok: false, error: failures.get(key) });
      const failedBatch = await nested(entry, true);
      expect(failedBatch).toEqual({ ok: false, error: failures.get(key) });
      const failedFlow = JSON.parse(await cdpTest.flowStr({
        run: () => nested(entry, true),
        settle: async () => '',
      }, `${entry.cmd} ${entry.args.join(' ')}`.trim(), { format: 'json' }));
      expect(failedFlow.steps[0]).toMatchObject(entry.cmd === 'wait'
        ? { ok: true, resultPreview: '' }
        : { ok: false, error: failures.get(key) });

      if (!entry.mcpDenied) {
        const failedSent = [];
        const failedHandle = createMcpRequestHandler({
          runtimeClient: createRuntimeClient({
            executeCli: async () => ({ code: 1, stdout: '', stderr: failures.get(key) }),
          }),
          sendMessage: message => failedSent.push(message),
        });
        await failedHandle({
          jsonrpc: '2.0', id: index + 100, method: 'tools/call',
          params: { name: entry.tool, arguments: entry.toolArgs },
        });
        expect(failedSent[0].result).toEqual({
          content: [{ type: 'text', text: failures.get(key) }],
          isError: true,
        });
      }
    }
  });
});
