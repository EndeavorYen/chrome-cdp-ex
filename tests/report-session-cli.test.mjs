import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseSessionArgs, runSession, serializeReceipt } from '../skills/chrome-cdp-ex/scripts/session.mjs';

describe('parseSessionArgs', () => {
  it('reads target, script, args and port', () => {
    expect(parseSessionArgs(['ABCD', '--script', 'job.mjs', '--args', '{"n":2}', '--port', '9224'], {})).toEqual({
      target: 'ABCD', script: 'job.mjs', args: { n: 2 }, port: 9224, host: '127.0.0.1',
    });
  });

  it('has no default port: neither --port nor CDP_PORT is a usage error', () => {
    expect(() => parseSessionArgs(['ABCD', '--script', 'j.mjs'], {})).toThrow(/port is required[\s\S]*usage: session\.mjs/);
    expect(() => parseSessionArgs(['ABCD', '--script', 'j.mjs'], { CDP_PORT: '' })).toThrow(/port is required/);
  });

  it('takes the port from CDP_PORT, and --port wins over it', () => {
    expect(parseSessionArgs(['ABCD', '--script', 'j.mjs'], { CDP_PORT: '9336' }).port).toBe(9336);
    expect(parseSessionArgs(['ABCD', '--script', 'j.mjs', '--port', '9444'], { CDP_PORT: '9336' }).port).toBe(9444);
  });

  it('rejects a port that is not an integer from 1 to 65535', () => {
    for (const bad of ['abc', '0', '65536', '9336.5']) {
      expect(() => parseSessionArgs(['ABCD', '--script', 'j.mjs', '--port', bad], {})).toThrow(/port must be an integer from 1 to 65535/);
    }
  });

  it('rejects a missing script, bad json and unknown flags', () => {
    expect(() => parseSessionArgs(['ABCD'], { CDP_PORT: '9336' })).toThrow(/usage/);
    expect(() => parseSessionArgs(['ABCD', '--script', 'j.mjs', '--args', '{bad'], { CDP_PORT: '9336' })).toThrow(/--args must be JSON/);
    expect(() => parseSessionArgs(['ABCD', '--script', 'j.mjs', '--nope'], { CDP_PORT: '9336' })).toThrow(/unknown flag/);
  });
});

describe('runSession', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'session-cli-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const fakeConnect = (log) => async () => ({
    transport: { send: async () => ({ result: { value: 'title' } }), on: () => () => {} },
    sessionId: 'S1',
    targetId: 'ABCD1234',
    close: () => log.push('closed'),
  });

  it('runs the script with page and args, returns a receipt, and closes the connection', async () => {
    const script = join(dir, 'ok.mjs');
    writeFileSync(script, 'export default async ({ page, args }) => ({ title: await page.ev("document.title"), n: args.n });');
    const log = [];
    const receipt = await runSession({ target: 'ABCD', script, args: { n: 3 }, port: 9224, host: '127.0.0.1' }, { connect: fakeConnect(log) });
    expect(receipt).toMatchObject({ schema: 'chrome-cdp-ex.session.v1', ok: true, target: 'ABCD1234', result: { title: 'title', n: 3 } });
    expect(typeof receipt.ms).toBe('number');
    expect(log).toEqual(['closed']);
  });

  it('returns ok:false with the message when the script throws, and still closes', async () => {
    const script = join(dir, 'bad.mjs');
    writeFileSync(script, 'export default async () => { throw new Error("boom"); };');
    const log = [];
    const receipt = await runSession({ target: 'ABCD', script, args: {}, port: 9224, host: '127.0.0.1' }, { connect: fakeConnect(log) });
    expect(receipt).toMatchObject({ ok: false, error: 'boom' });
    expect(log).toEqual(['closed']);
  });

  it('returns ok:false when the script file does not exist', async () => {
    const receipt = await runSession({ target: 'ABCD', script: join(dir, 'missing.mjs'), args: {}, port: 9224, host: '127.0.0.1' }, { connect: fakeConnect([]) });
    expect(receipt.ok).toBe(false);
    expect(receipt.error).toMatch(/cannot load script/);
  });

  it('returns ok:false when the script has no default export function', async () => {
    const script = join(dir, 'nodefault.mjs');
    writeFileSync(script, 'export const x = 1;');
    const receipt = await runSession({ target: 'ABCD', script, args: {}, port: 9224, host: '127.0.0.1' }, { connect: fakeConnect([]) });
    expect(receipt.ok).toBe(false);
    expect(receipt.error).toMatch(/default export/);
  });

  it('returns a readable error when the script throws a non-Error value', async () => {
    const script = join(dir, 'str.mjs');
    writeFileSync(script, 'export default async () => { throw "plain string"; };');
    const log = [];
    const receipt = await runSession({ target: 'ABCD', script, args: {}, port: 9224, host: '127.0.0.1' }, { connect: fakeConnect(log) });
    expect(receipt).toMatchObject({ ok: false, error: 'plain string' });
    expect(log).toEqual(['closed']);
  });
});

describe('serializeReceipt', () => {
  const ok = { schema: 'chrome-cdp-ex.session.v1', ok: true, ms: 5, target: 'ABCD1234', result: { n: 1 } };

  it('prints a normal receipt unchanged and reports its ok flag', () => {
    expect(serializeReceipt(ok)).toEqual({ line: JSON.stringify(ok), ok: true });
  });

  it('turns an unserialisable result (BigInt) into an ok:false receipt', () => {
    const { line, ok: good } = serializeReceipt({ ...ok, result: { big: 10n } });
    expect(good).toBe(false);
    expect(JSON.parse(line)).toMatchObject({ schema: 'chrome-cdp-ex.session.v1', ok: false, target: 'ABCD1234', error: expect.stringMatching(/result is not JSON-serialisable.*BigInt/) });
  });

  it('turns a circular result into an ok:false receipt', () => {
    const loop = {};
    loop.self = loop;
    const { line, ok: good } = serializeReceipt({ ...ok, result: loop });
    expect(good).toBe(false);
    expect(JSON.parse(line).error).toMatch(/result is not JSON-serialisable.*circular/i);
  });
});

describe('session.mjs as a process (no browser)', () => {
  const SESSION = fileURLToPath(new URL('../skills/chrome-cdp-ex/scripts/session.mjs', import.meta.url));
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'session-proc-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  // Never let the child find a real browser: no CDP_PORT, a port file that does not exist.
  const childEnv = () => {
    const env = { ...process.env, CDP_PORT_FILE: join(dir, 'no-such-DevToolsActivePort') };
    delete env.CDP_PORT;
    return env;
  };
  const run = (args) => spawnSync(process.execPath, [SESSION, ...args], { encoding: 'utf8', env: childEnv(), timeout: 20000 });

  it('exits 2 with usage and connects nowhere when no port is given', () => {
    const script = join(dir, 'job.mjs');
    writeFileSync(script, 'export default async () => 1;');
    const r = run(['ABCD', '--script', script]);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/port is required[\s\S]*usage: session\.mjs/);
  });

  const receiptLines = (stdout) => stdout.trim().split(/\r?\n/);

  // The job module is imported before any connect, so top-level code that fails asynchronously hits the
  // process handlers first; the top-level await keeps the import pending until they have fired.
  it('turns an unhandled rejection into one ok:false receipt and exit 1', () => {
    const script = join(dir, 'stray.mjs');
    writeFileSync(script, [
      'Promise.reject(new Error("stray rejection"));',
      'await new Promise((r) => setTimeout(r, 3000));',
      'export default async () => 1;',
    ].join('\n'));
    const r = run(['ABCD', '--script', script, '--port', '1']);
    expect(r.status).toBe(1);
    const lines = receiptLines(r.stdout);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ schema: 'chrome-cdp-ex.session.v1', ok: false, target: 'ABCD', error: expect.stringMatching(/unhandled rejection: stray rejection/) });
  });

  it('turns an uncaught exception into one ok:false receipt and exit 1', () => {
    const script = join(dir, 'throws.mjs');
    writeFileSync(script, [
      'setTimeout(() => { throw new Error("async boom"); }, 0);',
      'await new Promise((r) => setTimeout(r, 3000));',
      'export default async () => 1;',
    ].join('\n'));
    const r = run(['ABCD', '--script', script, '--port', '1']);
    expect(r.status).toBe(1);
    const lines = receiptLines(r.stdout);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ schema: 'chrome-cdp-ex.session.v1', ok: false, error: expect.stringMatching(/uncaught exception: async boom/) });
  });
});
