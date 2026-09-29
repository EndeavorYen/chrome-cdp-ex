import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  downloadViaPage,
  parseDownloadArgs,
  redactDownloadUrl,
} from '../skills/chrome-cdp-ex/scripts/lib/page-download.mjs';

// A fake page: answers the three in-page expressions the helper sends.
function fakePage({ bytes = Buffer.alloc(0), status = 200, type = 'video/mp4', contentLength = null } = {}) {
  const calls = [];
  let held = null;
  const evaluate = async (expression) => {
    calls.push(expression);
    if (expression.includes('fetch(')) {
      if (status < 200 || status >= 300) return JSON.stringify({ ok: false, status, type: '', size: 0 });
      held = bytes;
      return JSON.stringify({ ok: true, status, type, size: bytes.length, contentLength });
    }
    if (expression.includes('__cdpDownload') && expression.includes('slice(')) {
      const [, start, end] = expression.match(/slice\((\d+),(\d+)\)/);
      return held.subarray(Number(start), Number(end)).toString('base64');
    }
    if (expression.includes('delete window.__cdpDownload')) {
      held = null;
      return 'ok';
    }
    throw new Error(`unexpected expression: ${expression.slice(0, 80)}`);
  };
  return { evaluate, calls, isCleaned: () => held === null };
}

describe('downloadViaPage (#397)', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'page-download-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('writes the bytes in chunks, returns a receipt with sha256, and cleans up the page', async () => {
    const bytes = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251));
    const page = fakePage({ bytes });
    const outFile = join(dir, 'clip.mp4');

    const receipt = await downloadViaPage({
      evaluate: page.evaluate,
      url: 'https://assets.example.com/a/b.mp4?token=secret',
      outFile,
      chunkBytes: 1024,
    });

    expect(readFileSync(outFile).equals(bytes)).toBe(true);
    expect(receipt).toMatchObject({
      status: 200,
      contentType: 'video/mp4',
      bytes: 5000,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      path: outFile,
      url: 'https://assets.example.com/a/b.mp4',
    });
    expect(page.calls.filter(c => c.includes('slice('))).toHaveLength(5);
    expect(page.isCleaned()).toBe(true);
    expect(existsSync(`${outFile}.part`)).toBe(false);
  });

  it('downloads a data: URL and never prints its payload in the receipt', async () => {
    const bytes = Buffer.from('hello data url');
    const page = fakePage({ bytes, type: 'text/plain' });
    const receipt = await downloadViaPage({
      evaluate: page.evaluate,
      url: `data:text/plain;base64,${bytes.toString('base64')}`,
      outFile: join(dir, 'd.txt'),
    });
    expect(readFileSync(join(dir, 'd.txt'), 'utf8')).toBe('hello data url');
    expect(receipt.url).toMatch(/^data:text\/plain/);
    expect(receipt.url).not.toContain(bytes.toString('base64'));
  });

  it('rejects a non-2xx response, writes nothing, and cleans up', async () => {
    const page = fakePage({ status: 403 });
    const outFile = join(dir, 'x.bin');
    await expect(downloadViaPage({ evaluate: page.evaluate, url: 'https://a.example/x', outFile }))
      .rejects.toMatchObject({ code: 'http_status', message: expect.stringContaining('403') });
    expect(existsSync(outFile)).toBe(false);
    expect(existsSync(`${outFile}.part`)).toBe(false);
    expect(page.isCleaned()).toBe(true);
  });

  it('rejects a body over the byte cap before writing', async () => {
    const page = fakePage({ bytes: Buffer.alloc(3000, 1) });
    const outFile = join(dir, 'big.bin');
    await expect(downloadViaPage({ evaluate: page.evaluate, url: 'https://a.example/big', outFile, maxBytes: 2000 }))
      .rejects.toMatchObject({ code: 'too_large' });
    expect(existsSync(outFile)).toBe(false);
    expect(existsSync(`${outFile}.part`)).toBe(false);
    expect(page.isCleaned()).toBe(true);
  });

  it('stops on a declared content-length over the cap without reading the body', async () => {
    const calls = [];
    const evaluate = async (expression) => {
      calls.push(expression);
      if (expression.includes('fetch(')) return JSON.stringify({ ok: true, status: 200, type: '', size: 9999, tooLarge: true });
      return 'ok';
    };
    const outFile = join(dir, 'huge.bin');
    await expect(downloadViaPage({ evaluate, url: 'https://a.example/huge', outFile, maxBytes: 100 }))
      .rejects.toMatchObject({ code: 'too_large' });
    expect(calls.some(c => c.includes('slice('))).toBe(false);
    expect(existsSync(`${outFile}.part`)).toBe(false);
  });

  it('refuses to overwrite an existing file unless force is set', async () => {
    const outFile = join(dir, 'keep.bin');
    writeFileSync(outFile, 'old');
    const page = fakePage({ bytes: Buffer.from('new') });
    await expect(downloadViaPage({ evaluate: page.evaluate, url: 'https://a.example/k', outFile }))
      .rejects.toMatchObject({ code: 'exists' });
    expect(readFileSync(outFile, 'utf8')).toBe('old');
    expect(page.calls).toHaveLength(0);

    await downloadViaPage({ evaluate: page.evaluate, url: 'https://a.example/k', outFile, force: true });
    expect(readFileSync(outFile, 'utf8')).toBe('new');
  });

  it('fails cleanly when the page returns a short chunk', async () => {
    const page = fakePage({ bytes: Buffer.alloc(100, 7) });
    const shortEvaluate = async (expression) => (expression.includes('slice(') ? '' : page.evaluate(expression));
    const outFile = join(dir, 's.bin');
    await expect(downloadViaPage({ evaluate: shortEvaluate, url: 'https://a.example/s', outFile }))
      .rejects.toMatchObject({ code: 'short_read' });
    expect(existsSync(`${outFile}.part`)).toBe(false);
  });
});

describe('redactDownloadUrl', () => {
  it('drops query and fragment', () => {
    expect(redactDownloadUrl('https://h.example/p/a.mp4?sig=abc#frag')).toBe('https://h.example/p/a.mp4');
  });
  it('summarises data: URLs without the payload', () => {
    expect(redactDownloadUrl('data:image/png;base64,AAAA')).toBe('data:image/png;base64,(4 chars)');
  });
  it('bounds an unparsable value', () => {
    expect(redactDownloadUrl('x'.repeat(500)).length).toBeLessThanOrEqual(120);
  });
});

describe('parseDownloadArgs', () => {
  it('parses target, url, file, --max-mb and --force', () => {
    expect(parseDownloadArgs(['T1', 'https://a/b', 'out.bin', '--max-mb', '5', '--force']))
      .toEqual({ target: 'T1', url: 'https://a/b', outFile: 'out.bin', maxBytes: 5 * 1024 * 1024, force: true });
  });
  it('defaults to a 512 MB cap and no force', () => {
    expect(parseDownloadArgs(['T1', 'https://a/b', 'out.bin']))
      .toMatchObject({ maxBytes: 512 * 1024 * 1024, force: false });
  });
  it('rejects missing positionals and bad --max-mb', () => {
    expect(() => parseDownloadArgs(['T1', 'https://a/b'])).toThrow(/usage/i);
    expect(() => parseDownloadArgs(['T1', 'u', 'f', '--max-mb', 'abc'])).toThrow(/--max-mb/);
    expect(() => parseDownloadArgs(['T1', 'u', 'f', '--nope'])).toThrow(/unknown/i);
  });
});

describe('download.mjs wrapper', () => {
  it('sends Runtime.evaluate through evalraw and returns the string value', async () => {
    const { createEvaluate } = await import('../skills/chrome-cdp-ex/scripts/download.mjs');
    const seen = [];
    const run = async (_node, args) => {
      seen.push(args);
      return { stdout: JSON.stringify({ result: { type: 'string', value: 'abc' } }) };
    };
    const value = await createEvaluate('T1', { run, cdpPath: '/x/cdp.mjs' })('1+1');
    expect(value).toBe('abc');
    expect(seen[0].slice(0, 4)).toEqual(['/x/cdp.mjs', 'evalraw', 'T1', 'Runtime.evaluate']);
    expect(JSON.parse(seen[0][4])).toMatchObject({ expression: '1+1', awaitPromise: true, returnByValue: true });
  });

  it('turns exceptionDetails into an error', async () => {
    const { createEvaluate } = await import('../skills/chrome-cdp-ex/scripts/download.mjs');
    const run = async () => ({
      stdout: JSON.stringify({ exceptionDetails: { text: 'Uncaught', exception: { description: 'TypeError: boom' } } }),
    });
    await expect(createEvaluate('T1', { run })('x')).rejects.toThrow(/TypeError: boom/);
  });
});
