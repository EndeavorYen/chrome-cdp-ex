import { createHash } from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  absolutizeExpectDownloadOut,
  captureClickDownload,
  compactDownloadUrl,
  DEFAULT_DOWNLOAD_TIMEOUT_MS,
  downloadReceiptLines,
  formatDownloadBytes,
  parseExpectDownloadArgs,
  safeDownloadFilename,
} from '../skills/chrome-cdp-ex/scripts/lib/click-download.mjs';
import { ipcTimeoutForRequest } from '../skills/chrome-cdp-ex/scripts/lib/daemon-transport.mjs';
import { buildMcpToolCommand } from '../skills/chrome-cdp-ex/scripts/lib/mcp-adapter.mjs';
import { MCP_TOOL_DEFINITIONS } from '../skills/chrome-cdp-ex/scripts/lib/command-surface.mjs';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

const dirs = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'cdp-472-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const sha256 = text => createHash('sha256').update(text).digest('hex');

// A fake root CDP connection: records Browser.* calls and lets a test emit Browser events.
function fakeBrowser({ contextId = 'CTX', rejectContextId = false, unsupported = false, restoreFails = false } = {}) {
  const handlers = new Map();
  const calls = [];
  return {
    calls,
    listenerCount: () => [...handlers.values()].reduce((n, set) => n + set.size, 0),
    emit(method, params) {
      for (const handler of [...(handlers.get(method) || [])]) handler(params);
    },
    browser: {
      browserContextId: vi.fn(async () => contextId),
      setDownloadBehavior: vi.fn(async (params) => {
        calls.push(['setDownloadBehavior', params]);
        if (unsupported) throw new Error("'Browser.setDownloadBehavior' wasn't found");
        if (params.browserContextId && rejectContextId) throw new Error(`Failed to find browser context for id ${params.browserContextId}`);
        if (params.behavior === 'default' && restoreFails) throw new Error('CDP websocket closed');
        return {};
      }),
      cancelDownload: vi.fn(async (params) => {
        calls.push(['cancelDownload', params]);
        return {};
      }),
      onEvent(method, handler) {
        if (!handlers.has(method)) handlers.set(method, new Set());
        handlers.get(method).add(handler);
        return () => handlers.get(method).delete(handler);
      },
    },
  };
}

// The click: Chrome names the file <dir>/<guid> (allowAndName) and reports progress.
function downloadingClick(fake, dir, { guid = 'guid-1', name = 'report.csv', body = 'a,b\n1,2\n', url = 'https://app.example/export?token=s3cret&x=1', end = 'completed' } = {}) {
  return async () => {
    setTimeout(() => {
      fake.emit('Browser.downloadWillBegin', { frameId: 'F', guid, url, suggestedFilename: name });
      fake.emit('Browser.downloadProgress', { guid, state: 'inProgress', receivedBytes: 1, totalBytes: body.length });
      if (end === 'completed') {
        writeFileSync(join(dir, guid), body);
        fake.emit('Browser.downloadProgress', { guid, state: 'completed', receivedBytes: body.length, totalBytes: body.length });
      } else if (end === 'canceled') {
        fake.emit('Browser.downloadProgress', { guid, state: 'canceled', receivedBytes: 1, totalBytes: body.length });
      }
    }, 5);
    return 'Clicked <BUTTON> "Export CSV" (#export)';
  };
}

function behaviors(fake) {
  return fake.calls.filter(([method]) => method === 'setDownloadBehavior').map(([, params]) => params);
}

describe('#472 click --expect-download: capture', () => {
  it('completed: renames <guid> to the suggested name, hashes it, redacts the URL, and restores default', async () => {
    const dir = tempDir();
    const fake = fakeBrowser();
    const effects = {};
    const text = await captureClickDownload({ browser: fake.browser, dir, timeoutMs: 2000, run: downloadingClick(fake, dir), effects });

    expect(text).toBe('Clicked <BUTTON> "Export CSV" (#export)');
    const path = join(dir, 'report.csv');
    expect(readFileSync(path, 'utf8')).toBe('a,b\n1,2\n');
    expect(existsSync(join(dir, 'guid-1'))).toBe(false);
    expect(effects.download).toMatchObject({
      state: 'completed',
      filename: 'report.csv',
      bytes: 8,
      sha256: sha256('a,b\n1,2\n'),
      path,
      behavior: { scope: 'target-context', restored: true },
    });
    expect(effects.download.url).not.toContain('s3cret');
    expect(effects.download.url).toMatch(/^https:\/\/app\.example\/export\?/);
    expect(behaviors(fake)).toEqual([
      { behavior: 'allowAndName', downloadPath: resolve(dir), eventsEnabled: true, browserContextId: 'CTX' },
      { behavior: 'default', eventsEnabled: false, browserContextId: 'CTX' },
    ]);
    expect(fake.listenerCount()).toBe(0);
  });

  it('never overwrites: a second report.csv becomes "report (1).csv"', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'report.csv'), 'old');
    const fake = fakeBrowser();
    const effects = {};
    await captureClickDownload({ browser: fake.browser, dir, timeoutMs: 2000, run: downloadingClick(fake, dir), effects });
    expect(readFileSync(join(dir, 'report.csv'), 'utf8')).toBe('old');
    expect(effects.download).toMatchObject({ filename: 'report (1).csv', suggestedFilename: 'report.csv', path: join(dir, 'report (1).csv') });
  });

  it('a hostile suggested name stays inside the folder', async () => {
    const dir = tempDir();
    const fake = fakeBrowser();
    const effects = {};
    await captureClickDownload({ browser: fake.browser, dir, timeoutMs: 2000, run: downloadingClick(fake, dir, { name: '../../evil.sh' }), effects });
    expect(effects.download.filename).toBe('evil.sh');
    expect(readdirSync(dir)).toEqual(['evil.sh']);
  });

  it('canceled: Kind download-canceled error, default restored', async () => {
    const dir = tempDir();
    const fake = fakeBrowser();
    const effects = {};
    const error = await captureClickDownload({ browser: fake.browser, dir, timeoutMs: 2000, run: downloadingClick(fake, dir, { end: 'canceled' }), effects })
      .catch(e => e);
    expect(error.message).toMatch(/canceled the download "report\.csv"/);
    expect(error.download).toMatchObject({ kind: 'canceled' });
    expect(effects.download).toMatchObject({ state: 'canceled', filename: 'report.csv', behavior: { restored: true } });
    expect(behaviors(fake).at(-1)).toMatchObject({ behavior: 'default' });
    expect(fake.listenerCount()).toBe(0);
  });

  it('timeout with no download: Kind timeout, default restored', async () => {
    const dir = tempDir();
    const fake = fakeBrowser();
    const effects = {};
    const error = await captureClickDownload({ browser: fake.browser, dir, timeoutMs: 40, run: async () => 'Clicked <A> "Docs"', effects })
      .catch(e => e);
    expect(error.message).toMatch(/no download started within 40 ms/);
    expect(error.download).toMatchObject({ kind: 'timeout', phase: 'begin' });
    expect(effects.download).toMatchObject({ state: 'not-started', behavior: { restored: true } });
    expect(behaviors(fake).at(-1)).toMatchObject({ behavior: 'default' });
    expect(fake.listenerCount()).toBe(0);
  });

  it('timeout mid-download: the download is cancelled and default restored', async () => {
    const dir = tempDir();
    const fake = fakeBrowser();
    const effects = {};
    const error = await captureClickDownload({ browser: fake.browser, dir, timeoutMs: 60, run: downloadingClick(fake, dir, { end: 'none' }), effects })
      .catch(e => e);
    expect(error.download).toMatchObject({ kind: 'timeout', phase: 'progress' });
    expect(error.message).toMatch(/"report\.csv" did not finish within 60 ms/);
    expect(fake.calls).toContainEqual(['cancelDownload', { guid: 'guid-1', browserContextId: 'CTX' }]);
    expect(effects.download).toMatchObject({ state: 'timeout', cancelled: true, receivedBytes: 1 });
    expect(behaviors(fake).at(-1)).toMatchObject({ behavior: 'default' });
  });

  it('a click that throws still restores default', async () => {
    const dir = tempDir();
    const fake = fakeBrowser();
    const effects = {};
    const error = await captureClickDownload({
      browser: fake.browser, dir, timeoutMs: 1000, effects,
      run: async () => { throw new Error('Element not found: #export'); },
    }).catch(e => e);
    expect(error.message).toBe('Element not found: #export');
    expect(behaviors(fake).at(-1)).toMatchObject({ behavior: 'default' });
    expect(effects.download).toMatchObject({ state: 'not-observed', behavior: { restored: true } });
  });

  it('a link answered with an attachment never navigates: "did not navigate" plus a download is success', async () => {
    const dir = tempDir();
    const fake = fakeBrowser();
    const effects = {};
    const startDownload = downloadingClick(fake, dir, { name: 'server.bin', body: 'hello' });
    const text = await captureClickDownload({
      browser: fake.browser, dir, timeoutMs: 2000, effects,
      run: async () => {
        await startDownload();
        throw new Error('Click on <A href="http://127.0.0.1/file"> did not navigate. Try jsclick or click --js.');
      },
    });
    expect(text).toBe('Clicked <A href="http://127.0.0.1/file">; it started a download instead of navigating');
    expect(effects.download).toMatchObject({ state: 'completed', filename: 'server.bin', bytes: 5 });
  });

  it('a link that neither navigates nor downloads keeps its own no-navigation error', async () => {
    const dir = tempDir();
    const fake = fakeBrowser();
    const noNav = new Error('Click on <A href="http://127.0.0.1/x"> did not navigate. Try jsclick or click --js.');
    const error = await captureClickDownload({
      browser: fake.browser, dir, timeoutMs: 40, effects: {},
      run: async () => { throw noNav; },
    }).catch(e => e);
    expect(error).toBe(noNav);
    expect(behaviors(fake).at(-1)).toMatchObject({ behavior: 'default' });
  });

  it('a default-profile tab whose context id Chrome refuses falls back to the call without an id', async () => {
    const dir = tempDir();
    const fake = fakeBrowser({ rejectContextId: true });
    const effects = {};
    await captureClickDownload({ browser: fake.browser, dir, timeoutMs: 2000, run: downloadingClick(fake, dir), effects });
    expect(behaviors(fake)).toEqual([
      { behavior: 'allowAndName', downloadPath: resolve(dir), eventsEnabled: true, browserContextId: 'CTX' },
      { behavior: 'allowAndName', downloadPath: resolve(dir), eventsEnabled: true },
      { behavior: 'default', eventsEnabled: false },
    ]);
    expect(effects.download.behavior).toEqual({ scope: 'default-context', restored: true });
  });

  it('a browser without Browser.setDownloadBehavior fails before clicking and has nothing to restore', async () => {
    const dir = tempDir();
    const fake = fakeBrowser({ unsupported: true, contextId: null });
    const run = vi.fn(async () => 'clicked');
    const error = await captureClickDownload({ browser: fake.browser, dir, timeoutMs: 1000, run, effects: {} }).catch(e => e);
    expect(error.download).toMatchObject({ kind: 'unsupported' });
    expect(error.message).toMatch(/Nothing was clicked/);
    expect(run).not.toHaveBeenCalled();
    expect(behaviors(fake)).toHaveLength(1);
  });

  it('a failed restore is reported, not hidden', async () => {
    const dir = tempDir();
    const fake = fakeBrowser({ restoreFails: true });
    const effects = {};
    await captureClickDownload({ browser: fake.browser, dir, timeoutMs: 2000, run: downloadingClick(fake, dir), effects });
    expect(effects.download.behavior).toMatchObject({ restored: false, restoreError: 'CDP websocket closed' });
    expect(downloadReceiptLines(effects.download)[1]).toMatch(/^Warning: could not set the browser's download behaviour back to default/);
  });
});

describe('#472 helpers', () => {
  it('sanitises file names', () => {
    expect(safeDownloadFilename('../../etc/passwd')).toBe('passwd');
    expect(safeDownloadFilename('C:\\Users\\me\\x.txt')).toBe('x.txt');
    expect(safeDownloadFilename('..')).toBe('download');
    expect(safeDownloadFilename('')).toBe('download');
    expect(safeDownloadFilename('CON.txt')).toBe('_CON.txt');
    expect(safeDownloadFilename('a:b*c?.csv')).toBe('a_b_c_.csv');
    expect(safeDownloadFilename('invoice\u202Efdp.exe')).toBe('invoice_fdp.exe');
    expect(safeDownloadFilename('trailing. ')).toBe('trailing');
    expect(safeDownloadFilename(`${'x'.repeat(300)}.csv`)).toHaveLength(180);
  });

  it('formats sizes, URLs and the receipt line', () => {
    expect(formatDownloadBytes(512)).toBe('512 B');
    expect(formatDownloadBytes(12_700)).toBe('12.4 KB');
    expect(formatDownloadBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(compactDownloadUrl(`data:text/csv,${'a'.repeat(5000)}`)).toBe('data:text/csv,(5000 chars)');
    expect(compactDownloadUrl('blob:https://app.example/1234')).toBe('blob:https://app.example/1234');
    expect(downloadReceiptLines({ state: 'completed', filename: 'report.csv', bytes: 12_700, sha256: 'ab'.repeat(32), path: '/tmp/d/report.csv' }))
      .toEqual([`Downloaded "report.csv" 12.4 KB sha256=${'ab'.repeat(32)} → /tmp/d/report.csv`]);
    expect(downloadReceiptLines({ state: 'canceled' })).toEqual([]);
  });

  it('parses the click flags', () => {
    expect(parseExpectDownloadArgs(['#x'])).toEqual({ args: ['#x'], download: null });
    expect(parseExpectDownloadArgs(['#x', '--expect-download'])).toEqual({ args: ['#x'], download: { dir: null, timeoutMs: DEFAULT_DOWNLOAD_TIMEOUT_MS } });
    expect(parseExpectDownloadArgs(['--expect-download', '--out', 'd', '--timeout', '5000', '#x']).download).toEqual({ dir: 'd', timeoutMs: 5000 });
    expect(() => parseExpectDownloadArgs(['#x', '--out', 'd'])).toThrow(/only apply with --expect-download/);
    expect(() => parseExpectDownloadArgs(['#x', '--expect-download', '--timeout', 'soon'])).toThrow(/--timeout needs milliseconds/);
    expect(() => parseExpectDownloadArgs(['#x', '--expect-download', '--out'])).toThrow(/--out needs a folder/);
    const base = tempDir();
    expect(absolutizeExpectDownloadOut(['#x', '--expect-download', '--out', 'sub'], base)).toEqual(['#x', '--expect-download', '--out', join(base, 'sub')]);
  });

  it('gives the daemon IPC room for a long download wait', () => {
    expect(ipcTimeoutForRequest({ cmd: 'click', args: ['#x'] })).toBe(120000);
    expect(ipcTimeoutForRequest({ cmd: 'click', args: ['#x', '--expect-download', '--timeout', '300000'] })).toBe(360000);
    expect(ipcTimeoutForRequest({ cmd: 'click', args: ['#x', '--expect-download'] })).toBe(120000);
  });
});

describe('#472 click command wiring', () => {
  it('parseClickArgs keeps the selector and returns the download options', () => {
    const parsed = T.parseClickArgs(['#export', '--expect-download', '--timeout', '9000', '--format', 'json']);
    expect(parsed.selector).toBe('#export');
    expect(parsed.download).toEqual({ dir: null, timeoutMs: 9000 });
    expect(T.parseClickArgs(['#export']).download).toBe(null);
  });

  it('the handler wraps the click in expectDownload and hands effects to actionFeedback', async () => {
    const click = vi.fn(async s => `Clicked ${s}`);
    const expectDownload = vi.fn(async (options, dispatch, effects) => {
      const text = await dispatch();
      effects.download = { state: 'completed', filename: 'r.csv' };
      return text;
    });
    let seenTarget = null;
    const actionFeedback = vi.fn(async (_action, dispatch, target) => {
      seenTarget = target;
      return dispatch();
    });
    const handler = T.createClickCommandHandler({ actionFeedback, click, jsClick: vi.fn(), pointerClick: vi.fn(), expectDownload });
    const result = await handler({ args: ['#export', '--expect-download'] });
    expect(result.value).toBe('Clicked #export');
    expect(expectDownload).toHaveBeenCalledWith({ dir: null, timeoutMs: DEFAULT_DOWNLOAD_TIMEOUT_MS }, expect.any(Function), expect.any(Object));
    expect(seenTarget.commandArgs).toEqual(['#export', '--expect-download']);
    expect(seenTarget.actionEffects.download).toEqual({ state: 'completed', filename: 'r.csv' });
  });

  it('a plain click target is unchanged', async () => {
    let seenTarget = null;
    const actionFeedback = async (_a, dispatch, target) => { seenTarget = target; return dispatch(); };
    const handler = T.createClickCommandHandler({ actionFeedback, click: async () => 'ok', jsClick: vi.fn(), pointerClick: vi.fn(), expectDownload: vi.fn() });
    await handler({ args: ['#a'] });
    expect(seenTarget).not.toHaveProperty('actionEffects');
  });

  it('the default folder is a per-target runtime folder pruned with the tab\'s other artifacts', async () => {
    expect(T.sessionDownloadDir('ABC/1', '/rt')).toBe(resolve('/rt', 'cdp-ABC_1-downloads'));
    const dir = tempDir();
    const NOW = Date.UTC(2026, 9, 1);
    for (let i = 0; i < 25; i++) {
      const folder = join(dir, `cdp-D${String(i).padStart(2, '0')}-downloads`);
      mkdirSync(folder);
      writeFileSync(join(folder, 'r.csv'), 'x');
      const at = new Date(NOW - (10 + i) * 24 * 3600 * 1000);
      utimesSync(folder, at, at);
    }
    const result = await T.pruneRuntimeArtifacts({ runtimeDir: dir, now: NOW });
    expect(result.removedTargets).toBe(5);
    expect(readdirSync(dir)).toHaveLength(20);
  });
});

describe('#472 receipts', () => {
  const download = {
    state: 'completed',
    filename: 'report.csv',
    bytes: 12_700,
    sha256: 'c0ffee'.padEnd(64, '0'),
    path: '/tmp/cdp-ABC-downloads/report.csv',
    url: 'https://app.example/export?token=<redacted>',
    dir: '/tmp/cdp-ABC-downloads',
    behavior: { scope: 'default-context', restored: true },
  };

  async function runClick({ format = 'text', domDiff = '(no changes detected)', dispatch = async () => 'Clicked <BUTTON> "Export CSV" (#export)', effects = { download } } = {}) {
    let captured = null;
    const output = await T.runActionWithFeedback({
      action: 'click',
      target: { input: '#export', resolvedBy: 'selector', label: '#export', targetId: 'ABCDEF1234567890' },
      dispatch,
      feedbackPolicy: 'settle-diff',
      observe: async () => domDiff,
      enrichActionResult: async (result) => {
        Object.assign(result.effects, effects);
        return result;
      },
      onActionResult: (result) => { captured = result; },
      format,
    });
    return { output, result: captured };
  }

  it('text receipt names the file, size, sha256 and path; the download is the outcome evidence', async () => {
    const { output, result } = await runClick();
    expect(output).toContain(`Downloaded "report.csv" 12.4 KB sha256=${download.sha256} → ${download.path}`);
    expect(output).not.toContain('Outcome: no-change');
    expect(result.outcome).toMatchObject({ status: 'changed', changed: true, evidence: 'download', needsAttention: false });
  });

  it('JSON carries effects.download in full and compact form', async () => {
    const full = JSON.parse((await runClick({ format: 'json' })).output);
    expect(full.effects.download).toMatchObject({ filename: 'report.csv', bytes: 12_700, sha256: download.sha256, path: download.path, url: download.url });
    const compact = JSON.parse((await runClick({ format: { format: 'json', compact: true } })).output);
    expect(compact.effects.download).toMatchObject({ filename: 'report.csv', sha256: download.sha256 });
  });

  it('timeout is Kind: timeout with a Next; canceled is Kind: download-canceled', async () => {
    const timeoutError = Object.assign(new Error('click --expect-download: no download started within 30000 ms of the click'), {
      download: { kind: 'timeout', phase: 'begin', timeoutMs: 30000 },
    });
    const timeoutText = await runClick({ dispatch: async () => { throw timeoutError; }, effects: {} }).catch(e => e.message);
    expect(timeoutText).toMatch(/^Error: click --expect-download: no download started within 30000 ms of the click\nKind: timeout\nNext: cdp perceive ABCDEF1234567890 --since-action/);

    const canceled = Object.assign(new Error('click --expect-download: the browser canceled the download "report.csv"'), { download: { kind: 'canceled' } });
    const failure = T.classifyActionFailure(canceled, { action: 'click', target: { targetId: 'ABCDEF1234567890', input: '#export' } });
    expect(failure).toMatchObject({ kind: 'download-canceled', dispatched: true });
    const canceledText = await runClick({ dispatch: async () => { throw canceled; }, effects: {} }).catch(e => e.message);
    expect(canceledText).toMatch(/\nKind: download-canceled\nNext: /);

    const timeoutFailure = T.classifyActionFailure(timeoutError, { action: 'click', target: { targetId: 'ABCDEF1234567890', input: '#export' } });
    expect(timeoutFailure).toMatchObject({ kind: 'timeout', dispatched: true });
    expect(timeoutFailure.hints.join(' ')).toMatch(/--timeout/);
  });
});

describe('#472 MCP', () => {
  it('the pinned click tool is unchanged; run_command click carries the flags behind confirm', () => {
    const click = MCP_TOOL_DEFINITIONS.find(tool => tool.name === 'click');
    expect(Object.keys(click.inputSchema.properties)).not.toContain('expectDownload');
    const args = ['ABC', '#export', '--expect-download', '--out', '/tmp/d', '--format', 'json'];
    expect(() => buildMcpToolCommand('run_command', { command: 'click', args })).toThrow(/confirm/);
    expect(buildMcpToolCommand('run_command', { command: 'click', args, confirm: true })).toEqual(['click', ...args]);
  });
});
