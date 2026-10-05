// #526: elshot <target> <sel|@ref> [file] writes where the caller asks, like shot.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';
const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
const { argsRequireConfirm } = await import('../skills/chrome-cdp-ex/scripts/lib/mcp-adapter.mjs');

const TARGET_ID = '526E15H0700000000000000000000000';

function elementCdp(text = 'hello') {
  return {
    send(method, params = {}) {
      if (method === 'Runtime.evaluate') {
        const expr = String(params.expression || '');
        if (expr.includes('querySelector')) {
          return Promise.resolve({ result: { value: JSON.stringify({
            ok: true, x: 10, y: 20, w: 100, h: 40, scrollX: 0, scrollY: 0, tag: 'DIV', id: 'f', text,
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

function refElshotCdp(text, rectText = text) {
  return {
    send(method, params = {}) {
      if (method === 'Page.getFrameTree') return Promise.resolve({ frameTree: { frame: { id: 'frame-1' } } });
      if (method === 'Page.createIsolatedWorld') return Promise.resolve({ executionContextId: 1 });
      if (method === 'DOM.resolveNode') return Promise.resolve({ object: { objectId: 'obj-1' } });
      if (method === 'Runtime.callFunctionOn') {
        const decl = String(params.functionDeclaration || '');
        if (decl.includes('elshot-label')) return Promise.resolve({ result: { value: text } });
        return Promise.resolve({ result: { value: {
          connected: true, tag: 'FORM', text: rectText, x: 1, y: 2, w: 10, h: 20,
        } } });
      }
      if (method === 'Runtime.evaluate') {
        return Promise.resolve({ result: { value: JSON.stringify({ x: 0, y: 0 }) } });
      }
      if (method === 'Page.captureScreenshot') return Promise.resolve({ data: Buffer.from('PNG547').toString('base64') });
      return Promise.resolve({});
    },
    onEvent() { return () => {}; },
    waitForEvent() { return { promise: Promise.reject(new Error('timeout')), cancel() {} }; },
  };
}

function oneLineReceipt(out, { tag, id = '', text, ref = '', w, h, clip = null }) {
  const idText = id ? `#${id}` : '';
  const refText = ref ? ` (${ref})` : '';
  const clipText = clip ? ` (clip: ${clip} with padding)` : '';
  return `Element screenshot of <${tag}>${idText} "${text}"${refText} — ${w}×${h} CSS px${clipText} -> ${out}`;
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
    expect(out).toBe(oneLineReceipt(file, { tag: 'DIV', id: 'f', text: 'hello', w: 100, h: 40, clip: '116×56' }));
    expect(out.includes('\n')).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe('PNG526');
  });

  it('T2: without a file keeps the runtime-dir default', async () => {
    mkdirSync(T.RUNTIME_DIR, { recursive: true });
    T.resetScreenshotTier();
    const path = resolve(T.RUNTIME_DIR, 'elshot-526E15H0-_f.png');
    try {
      const out = await T.elshotStr(elementCdp(), 'sid', '#f', TARGET_ID, new Map(), {});
      expect(out).toBe(oneLineReceipt(path, { tag: 'DIV', id: 'f', text: 'hello', w: 100, h: 40, clip: '116×56' }));
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
    expect(() => T.parseElshotArgs(['#f', '--format', 'out.png'])).toThrow('elshot: --format must be text');
    expect(() => T.parseElshotArgs(['#f', '--format'])).toThrow('elshot: --format must be text');
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

  it('collapses a CSS label onto one line and cuts it at 80 characters', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cdp-elshot-547-'));
    dirs.push(dir);
    const file = join(dir, 'form.png');
    T.resetScreenshotTier();
    const raw = `${'a'.repeat(40)}\n\n  ${'b'.repeat(50)}`;
    const out = await T.elshotStr(elementCdp(raw), 'sid', '#f', TARGET_ID, new Map(), {}, file);
    const label = `${'a'.repeat(40)} ${'b'.repeat(39)}`;
    expect(out).toBe(oneLineReceipt(file, { tag: 'DIV', id: 'f', text: label, w: 100, h: 40, clip: '116×56' }));
    expect(out).not.toContain('…');
    expect(out.includes('\n')).toBe(false);
  });

  it('asks the page to collapse whitespace before the 80-character cut', async () => {
    let expr = '';
    const cdp = {
      send(method, params = {}) {
        if (method === 'Runtime.evaluate') {
          const next = String(params.expression || '');
          if (next.includes('querySelector')) expr = next;
          return Promise.resolve({ result: { value: JSON.stringify({
            ok: true, x: 0, y: 0, w: 10, h: 10, scrollX: 0, scrollY: 0, tag: 'FORM', id: 'composer', text: 'x',
          }) } });
        }
        if (method === 'Page.captureScreenshot') return Promise.resolve({ data: Buffer.from('PNG547').toString('base64') });
        return Promise.resolve({});
      },
      onEvent() { return () => {}; },
      waitForEvent() { return { promise: Promise.reject(new Error('timeout')), cancel() {} }; },
    };
    const dir = mkdtempSync(join(tmpdir(), 'cdp-elshot-547-page-'));
    dirs.push(dir);
    T.resetScreenshotTier();
    await T.elshotStr(cdp, 'sid', '#composer', TARGET_ID, new Map(), {}, join(dir, 'page.png'));
    expect(expr).toContain(".replace(/\\s+/g, ' ').trim().substring(0, 80)");
  });

  it('collapses an @ref label onto one line without a clip clause', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cdp-elshot-547-ref-'));
    dirs.push(dir);
    const file = join(dir, 'ref.png');
    T.resetScreenshotTier();
    const out = await T.elshotStr(
      refElshotCdp('她從左邊走到窗前\n\n    動態'),
      'sid',
      '@1',
      TARGET_ID,
      new Map([[1, 101]]),
      {},
      file,
    );
    expect(out).toBe(oneLineReceipt(file, {
      tag: 'FORM', text: '她從左邊走到窗前 動態', ref: '@1', w: 10, h: 20,
    }));
    expect(out).not.toContain('clip:');
    expect(out.includes('\n')).toBe(false);
  });

  it('cuts an @ref label after collapse, not before', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cdp-elshot-547-ref-cut-'));
    dirs.push(dir);
    const file = join(dir, 'ref.png');
    const raw = `${'a'.repeat(70)}\n\n${'b'.repeat(20)}`;
    let decl = '';
    const cdp = refElshotCdp(raw, raw.substring(0, 80));
    const send = cdp.send.bind(cdp);
    cdp.send = (method, params = {}) => {
      if (method === 'Runtime.callFunctionOn' && String(params.functionDeclaration || '').includes('elshot-label')) {
        decl = String(params.functionDeclaration);
      }
      return send(method, params);
    };
    T.resetScreenshotTier();
    const out = await T.elshotStr(cdp, 'sid', '@1', TARGET_ID, new Map([[1, 101]]), {}, file);
    const label = `${'a'.repeat(70)} ${'b'.repeat(9)}`;
    expect(out).toBe(oneLineReceipt(file, { tag: 'FORM', text: label, ref: '@1', w: 10, h: 20 }));
    expect(decl).toContain(".replace(/\\s+/g, ' ').trim().substring(0, 80)");
    expect(out).not.toContain('…');
  });
});
