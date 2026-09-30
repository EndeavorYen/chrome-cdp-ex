import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseSessionArgs, runSession, serializeReceipt } from '../skills/chrome-cdp-ex/scripts/session.mjs';

describe('parseSessionArgs', () => {
  it('reads target, script, args and port', () => {
    expect(parseSessionArgs(['ABCD', '--script', 'job.mjs', '--args', '{"n":2}', '--port', '9224'])).toEqual({
      target: 'ABCD', script: 'job.mjs', args: { n: 2 }, port: 9224, host: '127.0.0.1',
    });
  });

  it('rejects a missing script, bad json and unknown flags', () => {
    expect(() => parseSessionArgs(['ABCD'])).toThrow(/usage/);
    expect(() => parseSessionArgs(['ABCD', '--script', 'j.mjs', '--args', '{bad'])).toThrow(/--args must be JSON/);
    expect(() => parseSessionArgs(['ABCD', '--script', 'j.mjs', '--nope'])).toThrow(/unknown flag/);
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
