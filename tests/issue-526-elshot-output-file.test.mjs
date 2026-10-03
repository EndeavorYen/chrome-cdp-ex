// #526: elshot <target> <sel|@ref> [file] writes where the caller asks, like shot.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';
const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
const { argsRequireConfirm } = await import('../skills/chrome-cdp-ex/scripts/lib/mcp-adapter.mjs');

const TARGET_ID = '526E15H0700000000000000000000000';

function elementCdp() {
  return {
    send(method, params = {}) {
      if (method === 'Runtime.evaluate') {
        const expr = String(params.expression || '');
        if (expr.includes('querySelector')) {
          return Promise.resolve({ result: { value: JSON.stringify({
            ok: true, x: 10, y: 20, w: 100, h: 40, scrollX: 0, scrollY: 0, tag: 'DIV', id: 'f', text: 'hello',
          }) } });
        }
        return Promise.resolve({ result: { value: 1 } });
      }
      if (method === 'Page.captureScreenshot') return Promise.resolve({ data: Buffer.from('PNG526').toString('base64') });
      return Promise.resolve({});
    },
    onEvent() { return () => {}; },
    waitForEvent() { return { promise: Promise.reject(new Error('timeout')), cancel() {} }; },
  };
}

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('elshot output file (#526)', () => {
  it('T1: writes the PNG to the given file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cdp-elshot-526-'));
    dirs.push(dir);
    const file = join(dir, 'panel.png');
    T.resetScreenshotTier();
    const out = await T.elshotStr(elementCdp(), 'sid', '#f', TARGET_ID, new Map(), {}, file);
    expect(out.split('\n')[0]).toBe(file);
    expect(readFileSync(file, 'utf8')).toBe('PNG526');
  });

  it('T2: without a file keeps the runtime-dir default', async () => {
    mkdirSync(T.RUNTIME_DIR, { recursive: true });
    T.resetScreenshotTier();
    const path = resolve(T.RUNTIME_DIR, 'elshot-526E15H0-_f.png');
    try {
      const out = await T.elshotStr(elementCdp(), 'sid', '#f', TARGET_ID, new Map(), {});
      expect(out.split('\n')[0]).toBe(path);
      expect(existsSync(path)).toBe(true);
    } finally {
      rmSync(path, { force: true });
    }
  });

  it('T3: the CLI sends an absolute file path and the daemon parses selector and file', () => {
    const cwd = resolve(tmpdir(), 'caller-cwd');
    expect(T.absolutizeElshotFileArg(['#f', 'out/panel.png'], cwd)).toEqual(['#f', resolve(cwd, 'out/panel.png')]);
    expect(T.absolutizeElshotFileArg(['#f'], cwd)).toEqual(['#f']);
    expect(T.absolutizeElshotFileArg(['@3', 'a.png', '--format', 'text'], cwd)).toEqual(['@3', resolve(cwd, 'a.png'), '--format', 'text']);
    expect(T.parseElshotArgs(['#f', '/abs/panel.png'])).toEqual({ selector: '#f', filePath: '/abs/panel.png', fileIndex: 1 });
    expect(T.parseElshotArgs(['#f'])).toEqual({ selector: '#f', filePath: null, fileIndex: -1 });
    expect(T.parseElshotArgs(['@3', '--format', 'text', 'x.png'])).toEqual({ selector: '@3', filePath: 'x.png', fileIndex: 3 });
    // The file is replaced at its own index, never at an earlier token with the same text.
    expect(T.absolutizeElshotFileArg(['#f', '--format', 'text', 'text'], cwd)).toEqual(['#f', '--format', 'text', resolve(cwd, 'text')]);
    // A stray flag or a third positional is an error, not a file name.
    expect(() => T.parseElshotArgs(['#f', '-v'])).toThrow('elshot: unknown argument -v');
    expect(() => T.parseElshotArgs(['div', 'p', 'x.png'])).toThrow(/unexpected argument x\.png; quote a selector/);
  });

  it('T4: MCP elshot needs confirm only when it names a file, like shot', () => {
    expect(argsRequireConfirm('elshot', ['ABCD1234', '#f'])).toBe(false);
    expect(argsRequireConfirm('elshot', ['ABCD1234', '#f', '/tmp/x.png'])).toBe(true);
    expect(argsRequireConfirm('elshot', ['ABCD1234'])).toBe(true);
    expect(argsRequireConfirm('elshot', ['ABCD1234', '#f', '--format', 'text'])).toBe(false);
    // Any shape the runtime could read as a file needs confirm, including a file named like a flag value.
    for (const rest of [['text'], ['--format', 'text', 'text'], ['text', '--format'], ['--format', 'json'], ['-v']]) {
      expect(argsRequireConfirm('elshot', ['ABCD1234', '#f', ...rest]), rest.join(' ')).toBe(true);
    }
    expect(argsRequireConfirm('elshot', ['ABCD1234', '--format', 'text'])).toBe(true);
    expect(argsRequireConfirm('shot', ['ABCD1234', '/tmp/x.png'])).toBe(true);
  });

  it('T5: help shows the optional file', () => {
    expect(T.helpStr()).toContain('elshot <target> <sel|@ref> [file]');
    expect(T.helpTopicStr('elshot')).toContain('cdp elshot <target> <sel|@ref> [file]');
  });
});
