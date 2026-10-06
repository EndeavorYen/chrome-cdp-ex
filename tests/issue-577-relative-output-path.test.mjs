// #577: shot (and the other daemon file paths) must use the caller's cwd, not the
// tab daemon's. The daemon opens whatever path the CLI sends.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';
const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

const CALLER = '/caller/work';

function abs(path) {
  return resolve(CALLER, path);
}

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'cdp-577-'));
  dirs.push(dir);
  return dir;
}

function refusingCdp() {
  return {
    send() { throw new Error('cdp should not be called'); },
    onEvent() { return () => {}; },
    waitForEvent() { return { promise: Promise.reject(new Error('timeout')), cancel() {} }; },
  };
}

describe('caller cwd for daemon file paths (#577)', () => {
  it('resolves a relative shot path from the caller cwd and leaves an absolute path', () => {
    expect(T.absolutizeCallerFileArgs('shot', ['shots/a.png'], CALLER)).toEqual([abs('shots/a.png')]);
    expect(T.absolutizeCallerFileArgs('screenshot', ['shots/a.png', '--quiet'], CALLER))
      .toEqual([abs('shots/a.png'), '--quiet']);
    expect(T.absolutizeCallerFileArgs('shot', ['--verbose', 'shots/a.png'], CALLER))
      .toEqual(['--verbose', abs('shots/a.png')]);
    const absolute = ['/tmp/a.png', '--quiet'];
    expect(T.absolutizeCallerFileArgs('shot', absolute, CALLER)).toBe(absolute);
    const annotate = ['--annotate'];
    expect(T.absolutizeCallerFileArgs('shot', annotate, CALLER)).toBe(annotate);
    const shorthand = ['-a'];
    expect(T.absolutizeCallerFileArgs('shot', shorthand, CALLER)).toBe(shorthand);
    const noFile = ['--quiet'];
    expect(T.absolutizeCallerFileArgs('shot', noFile, CALLER)).toBe(noFile);
  });

  it('resolves the other caller file arguments the daemon would open', () => {
    expect(T.absolutizeCallerFileArgs('fullshot', ['shots/full.png'], CALLER)).toEqual([abs('shots/full.png')]);
    expect(T.absolutizeCallerFileArgs('fullshot', ['/tmp/full.png'], CALLER)).toEqual(['/tmp/full.png']);
    expect(T.absolutizeCallerFileArgs('upload', ['#file', 'shots/a.png,/tmp/b.png'], CALLER))
      .toEqual(['#file', `${abs('shots/a.png')},/tmp/b.png`]);
    expect(T.absolutizeCallerFileArgs('upload', ['#file', '--format', 'json', 'shots/a.png'], CALLER))
      .toEqual(['#file', '--format', 'json', abs('shots/a.png')]);
    expect(T.absolutizeCallerFileArgs('replay', ['--file', 'art.json', '--format', 'json'], CALLER))
      .toEqual(['--file', abs('art.json'), '--format', 'json']);
    expect(T.absolutizeCallerFileArgs('restore', ['-f', 'checkpoint.json'], CALLER))
      .toEqual(['-f', abs('checkpoint.json')]);
    expect(T.absolutizeCallerFileArgs('replay', ['art.json'], CALLER)).toEqual([abs('art.json')]);
    const inline = ['--json', '{"file":"shots/a.png"}'];
    expect(T.absolutizeCallerFileArgs('replay', inline, CALLER)).toBe(inline);
    const inlineRestore = ['{"schema":"chrome-cdp-ex.checkpoint.v1"}'];
    expect(T.absolutizeCallerFileArgs('restore', inlineRestore, CALLER)).toBe(inlineRestore);
    expect(T.absolutizeCallerFileArgs('responsive-audit', ['--viewport', '390x844', '--out-dir', 'shots'], CALLER))
      .toEqual(['--viewport', '390x844', '--out-dir', abs('shots')]);
    expect(T.absolutizeCallerFileArgs('visual-check', ['--output-dir', 'shots'], CALLER))
      .toEqual(['--output-dir', abs('shots')]);
  });

  it('resolves the same paths inside flow, batch, and repeat', () => {
    expect(T.absolutizeCallerFileArgs('flow', ['shot shots/a.png; perceive -C'], CALLER))
      .toEqual([`shot ${abs('shots/a.png')}; perceive -C`]);
    expect(T.absolutizeCallerFileArgs('flow', ['--format', 'json', 'screenshot shots/a.png'], CALLER))
      .toEqual(['--format', 'json', `screenshot ${abs('shots/a.png')}`]);
    expect(T.absolutizeCallerFileArgs('flow', ['elshot #f shots/panel.png'], CALLER))
      .toEqual([`elshot #f ${abs('shots/panel.png')}`]);
    expect(T.absolutizeCallerFileArgs('flow', ['click #go --expect-download --out shots'], CALLER))
      .toEqual([`click #go --expect-download --out ${abs('shots')}`]);
    expect(T.absolutizeCallerFileArgs('batch', ['shot shots/a.png | text'], CALLER))
      .toEqual([`shot ${abs('shots/a.png')}| text`]);
    expect(T.absolutizeCallerFileArgs('batch', ['--parallel', 'netlog --id 3 --out body.json'], CALLER))
      .toEqual(['--parallel', `netlog --id 3 --out ${abs('body.json')}`]);
    const batchJson = JSON.stringify([{ cmd: 'shot', args: ['shots/a.png'], note: 1 }]);
    const rewritten = T.absolutizeCallerFileArgs('batch', [batchJson], CALLER);
    expect(JSON.parse(rewritten[0])).toEqual([{ cmd: 'shot', args: [abs('shots/a.png')], note: 1 }]);
    expect(T.absolutizeCallerFileArgs('repeat', ['2', 'shot', 'shots/a.png', '--quiet'], CALLER))
      .toEqual(['2', 'shot', abs('shots/a.png'), '--quiet']);
    expect(T.absolutizeCallerFileArgs('repeat', ['2', '--until-text', 'done', 'fullshot', 'shots/full.png'], CALLER))
      .toEqual(['2', '--until-text', 'done', 'fullshot', abs('shots/full.png')]);
    expect(T.absolutizeCallerFileArgs('repeat', ['2', 'flow', 'shot shots/a.png; text'], CALLER))
      .toEqual(['2', 'flow', `shot ${abs('shots/a.png')}; text`]);
    const untouched = ['perceive -C -d 8'];
    expect(T.absolutizeCallerFileArgs('flow', untouched, CALLER)).toBe(untouched);
    const batchUntouched = ['click #buy | shot'];
    expect(T.absolutizeCallerFileArgs('batch', batchUntouched, CALLER)).toBe(batchUntouched);
  });

  it('writes the absolute path shot receives, and names a missing directory before capture', async () => {
    const dir = tempDir();
    const shots = join(dir, 'shots');
    mkdirSync(shots);
    const file = join(shots, 'a.png');
    const cdp = {
      send(method) {
        if (method === 'Runtime.evaluate') return Promise.resolve({ result: { value: 1 } });
        if (method === 'Page.captureScreenshot') return Promise.resolve({ data: Buffer.from('PNG577').toString('base64') });
        return Promise.resolve({});
      },
      onEvent() { return () => {}; },
      waitForEvent() { return { promise: Promise.reject(new Error('timeout')), cancel() {} }; },
    };
    T.resetScreenshotTier();
    const out = await T.shotStr(cdp, 'sid', file, 'TARGET577', { quiet: true });
    expect(out).toBe(file);
    expect(readFileSync(file, 'utf8')).toBe('PNG577');
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);

    const missing = join(dir, 'missing', 'a.png');
    T.resetScreenshotTier();
    await expect(T.shotStr(refusingCdp(), 'sid', missing, 'TARGET577')).rejects.toThrow(
      `shot: output directory does not exist: ${dirname(missing)}`,
    );
    const notDir = join(dir, 'not-a-dir');
    writeFileSync(notDir, 'x');
    await expect(T.shotStr(refusingCdp(), 'sid', join(notDir, 'a.png'), 'TARGET577')).rejects.toThrow(
      `shot: output path is not a directory: ${notDir}`,
    );
    await expect(T.fullshotStr(refusingCdp(), 'sid', missing, 'TARGET577')).rejects.toThrow(
      `fullshot: output directory does not exist: ${dirname(missing)}`,
    );
    await expect(T.elshotStr(refusingCdp(), 'sid', '#f', 'TARGET577', new Map(), {}, missing)).rejects.toThrow(
      `elshot: output directory does not exist: ${dirname(missing)}`,
    );
  });

  it('classifies a missing output directory as usage, not unknown', () => {
    const message = 'shot: output directory does not exist: /caller/work/shots';
    const recovery = T.buildCliErrorRecovery(message, { cmd: 'shot', targetPrefix: 'ABCD1234' });
    expect(recovery).toMatchObject({
      kind: 'usage',
      strategy: 'create-output-directory',
      run: 'cdp help shot',
    });
    const text = T.formatCliError(new Error(message), { cmd: 'shot', targetPrefix: 'ABCD1234' });
    expect(text).toMatch(/Error: shot: output directory does not exist: \/caller\/work\/shots/);
    expect(text).toMatch(/Kind: usage/);
    expect(text).not.toMatch(/Kind: unknown/);
    expect(text).toMatch(/Next: cdp help shot \(Kind: usage\)/);
  });
});
