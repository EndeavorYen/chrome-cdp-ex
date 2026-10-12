import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

function files() {
  const dir = mkdtempSync(join(tmpdir(), 'cdp-upload-guard-'));
  const a = join(dir, 'a.png');
  const b = join(dir, 'b.png');
  writeFileSync(a, Buffer.alloc(1234, 1));
  writeFileSync(b, Buffer.alloc(56, 2));
  return { a, b };
}

// Fake CDP for uploadStr. `scan` is what the in-page scan reports, `readBack` the input's files after upload.
// A page that cannot be evaluated is modelled with `evaluate: 'unavailable'`.
function fakeCdp({ scan = [], readBack = [], evaluate = 'ok' } = {}) {
  const calls = [];
  return {
    calls,
    send(method, params = {}) {
      calls.push({ method, params });
      switch (method) {
        case 'DOM.getDocument': return Promise.resolve({ root: { nodeId: 1 } });
        case 'DOM.querySelector': return Promise.resolve({ nodeId: 2 });
        case 'DOM.describeNode': return Promise.resolve({ node: { nodeName: 'INPUT', attributes: ['type', 'file'] } });
        case 'DOM.setFileInputFiles': return Promise.resolve({});
        case 'Runtime.evaluate': {
          if (evaluate === 'unavailable') return Promise.reject(new Error('Timeout: Runtime.evaluate'));
          const expression = String(params.expression || '');
          if (expression.includes('__uploadScan')) return Promise.resolve({ result: { type: 'string', value: JSON.stringify(scan) } });
          if (expression.includes('__uploadRead')) return Promise.resolve({ result: { type: 'string', value: JSON.stringify(readBack) } });
          return Promise.resolve({ result: { type: 'undefined' } });
        }
        default: return Promise.resolve({});
      }
    },
  };
}

const composer = { index: 2, id: 'composer-file', accept: 'image/*', multiple: true, label: 'Ask anything' };
const template = { index: 0, id: '', accept: 'image/*', multiple: false, label: 'Text Edit' };

describe('upload guards (#403)', () => {
  it('refuses a selector that matches several elements and lists them', async () => {
    const { a } = files();
    const cdp = fakeCdp({ scan: [template, composer] });
    const error = await T.uploadStr(cdp, 'sid', 'input[type=file]', a).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/matches 2 elements/);
    expect(error.message).toMatch(/refusing to guess/);
    expect(error.message).toMatch(/#0.*Text Edit.*image\/\*/);
    expect(error.message).toMatch(/#2 id="composer-file".*Ask anything/);
    expect(cdp.calls.map((c) => c.method)).not.toContain('DOM.setFileInputFiles');
  });

  it('refuses several files for an input without `multiple`', async () => {
    const { a, b } = files();
    const cdp = fakeCdp({ scan: [template] });
    await expect(T.uploadStr(cdp, 'sid', '#f', `${a},${b}`)).rejects.toThrow(/does not accept several files/);
    expect(cdp.calls.map((c) => c.method)).not.toContain('DOM.setFileInputFiles');
  });

  it('uploads to a single match and confirms the page sees the same names and sizes', async () => {
    const { a, b } = files();
    const cdp = fakeCdp({
      scan: [composer],
      readBack: [{ name: 'a.png', size: 1234 }, { name: 'b.png', size: 56 }],
    });
    const result = await T.uploadStr(cdp, 'sid', '#composer-file', `${a},${b}`);
    expect(result).toMatch(/^Uploaded 2 file\(s\) to #composer-file: /);
    const set = cdp.calls.find((c) => c.method === 'DOM.setFileInputFiles');
    expect(set.params.files).toEqual([a, b]);
  });

  it('fails when the page reads back a different file list', async () => {
    const { a } = files();
    const cdp = fakeCdp({ scan: [composer], readBack: [] });
    await expect(T.uploadStr(cdp, 'sid', '#f', a)).rejects.toThrow(/page reports/);
  });

  it('behaves as before when the page cannot be evaluated (probes are best-effort)', async () => {
    const { a } = files();
    const cdp = fakeCdp({ evaluate: 'unavailable' });
    await expect(T.uploadStr(cdp, 'sid', '#f', a)).resolves.toMatch(/^Uploaded 1 file\(s\) to #f: /);
    expect(cdp.calls.map((c) => c.method)).toContain('DOM.setFileInputFiles');
  });

  it('classifies the new refusals as usage errors that point to `cdp help upload`', () => {
    const ambiguous = 'upload: selector "input[type=file]" matches 2 elements, refusing to guess which one to fill.';
    const multiple = 'upload: #f does not accept several files (no `multiple`); pass one file';
    for (const message of [ambiguous, multiple]) {
      expect(T.classifyActionFailure(new Error(message), {
        action: 'upload',
        target: { targetId: 'ABC123', input: '#f' },
      })).toMatchObject({ kind: 'usage', nextCommand: 'cdp help upload' });
      const recovery = T.buildCliErrorRecovery(message, { cmd: 'upload' });
      expect(recovery.kind).toBe('usage');
      expect(recovery.run).toBe('cdp help upload');
    }
  });
});
