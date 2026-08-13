import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it, vi } from 'vitest';

import { createMcpRequestHandler } from '../skills/chrome-cdp-ex/scripts/mcp-server.mjs';
import { __test__ as cdpTest } from '../skills/chrome-cdp-ex/scripts/cdp.mjs';
import { createRuntimeClient } from '../skills/chrome-cdp-ex/scripts/lib/runtime-client.mjs';

const packageVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const contract = JSON.parse(readFileSync(
  new URL(`../docs/contracts/v${packageVersion}/public-contracts.v1.json`, import.meta.url),
  'utf8',
));

function handlerWith(executeCli) {
  const sent = [];
  const runtimeClient = createRuntimeClient({ executeCli });
  return {
    sent,
    executeCli,
    handle: createMcpRequestHandler({
      runtimeClient,
      sendMessage: message => sent.push(message),
    }),
  };
}

describe('Phase 5 direct RuntimeClient MCP adapter', () => {
  it('imports MCP without filesystem, process-global, stdin, browser, socket, or subprocess effects', () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'chrome-cdp-mcp-import-'));
    try {
      const moduleUrl = new URL('../skills/chrome-cdp-ex/scripts/mcp-server.mjs', import.meta.url).href;
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import childProcess from 'node:child_process';
        import fs from 'node:fs';
        import net from 'node:net';
        import { syncBuiltinESMExports } from 'node:module';
        const effects = [];
        const blocked = name => (..._args) => {
          effects.push(name);
          throw new Error('import effect: ' + name);
        };
        for (const name of ['appendFileSync', 'writeFileSync', 'unlinkSync', 'mkdirSync', 'rmSync', 'renameSync']) {
          fs[name] = blocked('fs.' + name);
        }
        for (const name of ['spawn', 'spawnSync', 'exec', 'execFile', 'fork']) {
          childProcess[name] = blocked('child_process.' + name);
        }
        for (const name of ['createConnection', 'connect', 'createServer']) {
          net[name] = blocked('net.' + name);
        }
        syncBuiltinESMExports();
        globalThis.WebSocket = class ImportWebSocket {
          constructor() { throw new Error('import effect: WebSocket'); }
        };
        process.umask(0o022);
        const stdinCounts = () => Object.fromEntries(
          process.stdin.eventNames().map(name => [String(name), process.stdin.listenerCount(name)]),
        );
        const before = {
          argv: [...process.argv],
          env: Object.entries(process.env).sort(),
          exitCode: process.exitCode ?? null,
          stdin: stdinCounts(),
          umask: process.umask(),
        };
        await import(${JSON.stringify(moduleUrl)});
        const after = {
          argv: [...process.argv],
          env: Object.entries(process.env).sort(),
          exitCode: process.exitCode ?? null,
          stdin: stdinCounts(),
          umask: process.umask(),
        };
        console.log(JSON.stringify({ before, after, effects, created: fs.existsSync(process.env.XDG_RUNTIME_DIR + '/cdp') }));
      `], {
        encoding: 'utf8',
        env: { ...process.env, XDG_RUNTIME_DIR: runtimeRoot, NODE_ENV: 'test' },
      });
      expect(child.status).toBe(0);
      const result = JSON.parse(child.stdout);
      expect(result.after).toEqual(result.before);
      expect(result.effects).toEqual([]);
      expect(result.created).toBe(false);
      expect(existsSync(join(runtimeRoot, 'cdp'))).toBe(false);
    } finally {
      rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it('runs all frozen valid mappings in process with exact content and no command fallback', async () => {
    const executeCli = vi.fn(async command => ({
      code: 0,
      stdout: JSON.stringify(command),
      stderr: '',
    }));
    const state = handlerWith(executeCli);

    for (const [index, fixture] of contract.mcp.mappingCases.entries()) {
      await state.handle({
        jsonrpc: '2.0',
        id: index + 1,
        method: 'tools/call',
        params: { name: fixture.tool, arguments: fixture.args },
      });
      expect(executeCli).toHaveBeenLastCalledWith(fixture.command);
      expect(state.sent.at(-1)).toEqual({
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

  it('rejects every frozen invalid mapping before RuntimeClient execution', async () => {
    const executeCli = vi.fn();
    const state = handlerWith(executeCli);
    for (const [index, fixture] of contract.mcp.invalidCases.entries()) {
      await state.handle({
        jsonrpc: '2.0',
        id: index + 1,
        method: fixture.kind === 'resource' ? 'resources/read' : 'tools/call',
        params: fixture.kind === 'resource'
          ? { uri: fixture.uri }
          : { name: fixture.tool, arguments: fixture.args },
      });
      expect(state.sent.at(-1).error).toEqual({ code: -32000, message: fixture.error });
    }
    expect(executeCli).not.toHaveBeenCalled();
  });

  it.each([
    'back', 'clickxy', 'dismiss-modal', 'forward', 'jsclick', 'nav',
    'navigate', 'reload', 'type', 'verify-click', 'mock', 'clock', 'throttle',
    'emulate', 'resize',
  ])(
    'rejects run_command %s without confirmation before RuntimeClient execution',
    async command => {
      const executeCli = vi.fn();
      const state = handlerWith(executeCli);
      await state.handle({
        jsonrpc: '2.0', id: 40, method: 'tools/call',
        params: { name: 'run_command', arguments: { command, args: ['fixture'] } },
      });
      expect(state.sent[0].error).toMatchObject({ code: -32000 });
      expect(state.sent[0].error.message).toMatch(/confirm: true/i);
      expect(executeCli).not.toHaveBeenCalled();
    },
  );

  it('rejects table collection without confirmation before RuntimeClient execution', async () => {
    const executeCli = vi.fn();
    const state = handlerWith(executeCli);
    await state.handle({
      jsonrpc: '2.0', id: 46, method: 'tools/call',
      params: {
        name: 'run_command',
        arguments: {
          command: 'table',
          args: ['fixture', '#grid', '--collect', '--scroll-container', '.viewport'],
        },
      },
    });
    expect(state.sent[0].error).toMatchObject({ code: -32000 });
    expect(state.sent[0].error.message).toMatch(/confirm: true/i);
    expect(executeCli).not.toHaveBeenCalled();
  });

  it.each([
    ['session_checkpoint', Object.assign(Object.create({ confirm: true }), { target: 'fixture' })],
    ['run_command', Object.assign(Object.create({ confirm: true }), {
      command: 'checkpoint', args: ['fixture'],
    })],
    ['run_command', Object.assign(Object.create({ confirm: true }), {
      command: 'cookies', args: ['fixture'],
    })],
    ['run_command', Object.assign(Object.create({ confirm: true }), {
      command: 'table', args: ['fixture', '--collect', '--scroll-container', '.viewport'],
    })],
    ['table', Object.assign(Object.create({ confirm: true }), {
      target: 'fixture', collect: true, scrollContainer: '.viewport',
    })],
  ])('rejects inherited confirmation for %s before RuntimeClient execution', async (name, args) => {
    const executeCli = vi.fn();
    const state = handlerWith(executeCli);
    await state.handle({
      jsonrpc: '2.0', id: 41, method: 'tools/call', params: { name, arguments: args },
    });
    expect(state.sent[0].error).toMatchObject({ code: -32600 });
    expect(executeCli).not.toHaveBeenCalled();
  });

  it.each([
    ['session_checkpoint', { target: 'fixture' }],
    ['run_command', { command: 'checkpoint', args: ['fixture'] }],
    ['run_command', { command: 'cookies', args: ['fixture'] }],
    ['run_command', { command: 'table', args: ['fixture', '--collect', '--scroll-container', '.viewport'] }],
  ])('rejects non-enumerable confirmation for %s before RuntimeClient execution', async (name, base) => {
    const executeCli = vi.fn();
    const state = handlerWith(executeCli);
    const args = { ...base };
    Object.defineProperty(args, 'confirm', { enumerable: false, value: true });
    await state.handle({
      jsonrpc: '2.0', id: 43, method: 'tools/call', params: { name, arguments: args },
    });
    expect(state.sent[0].error).toMatchObject({ code: -32600 });
    expect(executeCli).not.toHaveBeenCalled();
  });

  it('rejects a non-enumerable request method as non-JSON data', async () => {
    const executeCli = vi.fn();
    const state = handlerWith(executeCli);
    const message = { jsonrpc: '2.0', id: 44 };
    Object.defineProperty(message, 'method', { enumerable: false, value: 'tools/list' });
    await state.handle(message);
    expect(state.sent[0]).toMatchObject({ id: null, error: { code: -32600 } });
    expect(executeCli).not.toHaveBeenCalled();
  });

  it.each([1, {}, ''])('returns invalid-request for non-string or empty method %j', async method => {
    const executeCli = vi.fn();
    const state = handlerWith(executeCli);
    await state.handle({ jsonrpc: '2.0', id: 45, method });
    expect(state.sent[0]).toEqual({
      jsonrpc: '2.0', id: 45,
      error: { code: -32600, message: 'mcp.request.method: must be a non-empty string' },
    });
    expect(executeCli).not.toHaveBeenCalled();
  });

  it.each([
    ['session_checkpoint', { target: 'fixture' }],
    ['run_command', { command: 'checkpoint', args: ['fixture'] }],
    ['run_command', { command: 'cookies', args: ['fixture'] }],
    ['run_command', { command: 'table', args: ['fixture', '--collect', '--scroll-container', '.viewport'] }],
  ])('rejects accessor confirmation for %s without invoking it or RuntimeClient', async (name, base) => {
    const executeCli = vi.fn();
    const state = handlerWith(executeCli);
    const read = vi.fn(() => true);
    const args = { ...base };
    Object.defineProperty(args, 'confirm', { enumerable: true, get: read });
    await state.handle({
      jsonrpc: '2.0', id: 42, method: 'tools/call', params: { name, arguments: args },
    });
    expect(state.sent[0].error).toMatchObject({ code: -32600 });
    expect(read).not.toHaveBeenCalled();
    expect(executeCli).not.toHaveBeenCalled();
  });

  it('rejects proxied table collection arguments before RuntimeClient execution', async () => {
    const executeCli = vi.fn();
    const state = handlerWith(executeCli);
    const argumentsProxy = new Proxy({
      command: 'table',
      args: ['fixture', '--collect', '--scroll-container', '.viewport'],
      confirm: true,
    }, {});
    await state.handle({
      jsonrpc: '2.0', id: 47, method: 'tools/call',
      params: { name: 'run_command', arguments: argumentsProxy },
    });
    expect(state.sent[0].error).toMatchObject({ code: -32600 });
    expect(executeCli).not.toHaveBeenCalled();
  });

  it('runs all frozen resource mappings through the same direct client', async () => {
    const executeCli = vi.fn(async command => ({
      code: 0,
      stdout: JSON.stringify(command),
      stderr: '',
    }));
    const state = handlerWith(executeCli);
    for (const [index, fixture] of contract.mcp.resourceMappings.entries()) {
      await state.handle({
        jsonrpc: '2.0', id: index + 1, method: 'resources/read',
        params: { uri: fixture.uri },
      });
      expect(executeCli).toHaveBeenLastCalledWith(fixture.command);
      expect(state.sent.at(-1).result.contents[0]).toMatchObject({
        uri: fixture.uri,
        text: JSON.stringify(fixture.command),
      });
    }
  });

  it('preserves stderr-first failure composition and empty-output success', async () => {
    const failures = handlerWith(vi.fn(async () => ({
      code: 7,
      stdout: 'partial stdout',
      stderr: 'exact stderr',
    })));
    await failures.handle({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'doctor', arguments: {} },
    });
    expect(failures.sent[0].result).toEqual({
      content: [{ type: 'text', text: 'exact stderr\npartial stdout' }],
      isError: true,
    });

    const empty = handlerWith(vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })));
    await empty.handle({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'doctor', arguments: {} },
    });
    expect(empty.sent[0].result.content[0].text).toBe('');
  });

  it('executes deterministic CLI help and errors in process with exact exit channels', async () => {
    const client = createRuntimeClient();
    await expect(client.execute(['help'])).resolves.toMatchObject({
      code: 0,
      stdout: expect.stringContaining('chrome-cdp-ex'),
      stderr: '',
    });
    const unknown = await client.execute(['definitely-not-a-command']);
    expect(unknown.code).toBe(1);
    expect(unknown.stdout).toBe('');
    expect(unknown.stderr).toContain('Unknown command');
  });

  it('matches the real CLI process for every frozen browser-independent exit', async () => {
    const client = createRuntimeClient();
    const script = fileURLToPath(new URL('../skills/chrome-cdp-ex/scripts/cdp.mjs', import.meta.url));
    const cases = [
      [],
      ['help'],
      ['perceev'],
      ['list', '--bogus'],
      ['list', '--format', 'yaml'],
      ['perceive'],
    ];
    for (const command of cases) {
      const child = spawnSync(process.execPath, [script, ...command], {
        encoding: 'utf8',
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
        shell: false,
        timeout: 5_000,
      });
      expect(child.error).toBeUndefined();
      await expect(client.execute(command)).resolves.toEqual({
        code: child.status,
        stdout: child.stdout.trim(),
        stderr: child.stderr.trim(),
      });
    }
  });

  it('uses the production default RuntimeClient for an actual MCP tool call', async () => {
    const sent = [];
    const handle = createMcpRequestHandler({ sendMessage: message => sent.push(message) });
    await handle({
      jsonrpc: '2.0', id: 11, method: 'tools/call',
      params: { name: 'run_command', arguments: { command: 'help', args: [] } },
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      jsonrpc: '2.0',
      id: 11,
      result: { isError: false },
    });
    expect(sent[0].result.content[0].text).toContain('chrome-cdp-ex');
  });

  it('ships no MCP child-process or CLI fallback path', () => {
    const source = readFileSync(
      new URL('../skills/chrome-cdp-ex/scripts/mcp-server.mjs', import.meta.url),
      'utf8',
    );
    expect(source).not.toMatch(/from ['"]child_process['"]/);
    expect(source).not.toContain('runCdpCommand');
    expect(source).not.toContain('CDP_SCRIPT');
    expect(source).toContain('createRuntimeClient');
  });

  it('binds daemon spawn and freshness identity to cdp.mjs under an MCP host argv', () => {
    const expectedScript = fileURLToPath(new URL(
      '../skills/chrome-cdp-ex/scripts/cdp.mjs',
      import.meta.url,
    ));
    expect(cdpTest.cdpRuntimeIdentity({
      execPath: '/fixture/node',
      argv: ['/fixture/node', '/fixture/mcp-server.mjs'],
    })).toEqual({
      execPath: '/fixture/node',
      scriptPath: expectedScript,
    });

    const source = readFileSync(expectedScript, 'utf8');
    expect(source).toContain('...runtimeIdentity');
    expect(source).toContain('collectDaemonMetadata({ scriptPath: runtimeIdentity.scriptPath })');
    expect(source).toContain('[runtimeIdentity.scriptPath, \'_daemon\', targetId]');
  });

  it('snapshots a plain execute dependency and rejects accessor or forged clients', async () => {
    const executeCli = vi.fn(async command => ({ code: 0, stdout: command.join(' '), stderr: '' }));
    const client = createRuntimeClient({ executeCli });
    const command = ['help'];
    const execution = client.execute(command);
    command[0] = 'doctor';
    await expect(execution).resolves.toMatchObject({ stdout: 'help' });
    expect(Object.isFrozen(client)).toBe(true);

    const accessor = {};
    Object.defineProperty(accessor, 'executeCli', { enumerable: true, get: () => executeCli });
    expect(() => createRuntimeClient(accessor)).toThrow(/accessor/);
    expect(() => createMcpRequestHandler({ runtimeClient: { execute: executeCli } }))
      .toThrow(/RuntimeClient/);

    const accessorCommand = ['help'];
    Object.defineProperty(accessorCommand, '0', { enumerable: true, get: () => 'help' });
    await expect(client.execute(accessorCommand)).rejects.toThrow(/own data value/);

    const accessorResult = {};
    Object.defineProperty(accessorResult, 'code', { enumerable: true, get: () => 0 });
    Object.defineProperty(accessorResult, 'stdout', { enumerable: true, value: '' });
    Object.defineProperty(accessorResult, 'stderr', { enumerable: true, value: '' });
    const unsafeClient = createRuntimeClient({ executeCli: async () => accessorResult });
    await expect(unsafeClient.execute(['help'])).rejects.toThrow(/accessor/);
  });
});
