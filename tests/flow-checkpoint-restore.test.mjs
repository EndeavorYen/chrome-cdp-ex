import { describe, it, expect } from 'vitest';
import { createMockCDP } from './mock-cdp.mjs';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

// =========================================================================
// CDP mock helper — lightweight fake for testing command functions
// =========================================================================


// =========================================================================
// checkpoint / restore — page state artifact
// =========================================================================

describe('checkpoint / restore', () => {
  it('captures URL, storage, and cookies as a checkpoint model', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({
        result: {
          value: JSON.stringify({
            url: 'https://example.com/app',
            title: 'App',
            origin: 'https://example.com',
            localStorage: { theme: 'dark', authToken: 'local-sentinel-123' },
            sessionStorage: { wizard: '2', apiKey: 'session-sentinel-456' },
          }),
        },
      }),
      'Network.getCookies': () => ({
        cookies: [{
          name: 'sid',
          value: 'cookie-sentinel-789',
          domain: 'example.com',
          path: '/',
          secure: true,
          httpOnly: true,
          sameSite: 'Lax',
          expires: -1,
        }],
      }),
    });

    const model = await T.checkpointModel(cdp, 'sid-1', { now: 12345 });

    expect(model.schema).toBe('chrome-cdp-ex.checkpoint.v1');
    expect(model.page).toEqual({
      url: 'https://example.com/app',
      title: 'App',
      origin: 'https://example.com',
    });
    expect(model.privacy).toMatchObject({
      redaction: 'default-redacted',
      cookies: true,
      storage: true,
    });
    expect(model.storage.localStorage).toEqual({ theme: 'dark', authToken: '<redacted>' });
    expect(model.storage.sessionStorage).toEqual({ wizard: '2', apiKey: '<redacted>' });
    expect(model.cookies).toHaveLength(1);
    expect(model.cookies[0]).toMatchObject({ name: 'sid', value: '<redacted>', domain: 'example.com' });
    expect(JSON.stringify(model)).not.toContain('local-sentinel-123');
    expect(JSON.stringify(model)).not.toContain('session-sentinel-456');
    expect(JSON.stringify(model)).not.toContain('cookie-sentinel-789');
  });

  it('labels unsafe checkpoint captures that preserve restorable secrets', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({
        result: {
          value: JSON.stringify({
            url: 'https://example.com/app',
            title: 'App',
            origin: 'https://example.com',
            localStorage: { authToken: 'local-sentinel-123' },
            sessionStorage: { apiKey: 'session-sentinel-456' },
          }),
        },
      }),
      'Network.getCookies': () => ({
        cookies: [{
          name: 'sid',
          value: 'cookie-sentinel-789',
          domain: 'example.com',
          path: '/',
        }],
      }),
    });

    const model = await T.checkpointModel(cdp, 'sid-1', { now: 12345, unsafeFullCapture: true });

    expect(model.privacy).toMatchObject({
      redaction: 'unsafe-full',
      cookies: false,
      storage: false,
    });
    expect(model.storage.localStorage.authToken).toBe('local-sentinel-123');
    expect(model.storage.sessionStorage.apiKey).toBe('session-sentinel-456');
    expect(model.cookies[0].value).toBe('cookie-sentinel-789');
  });

  it('formats checkpoint JSON for artifact files', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({
        result: { value: JSON.stringify({ url: 'https://example.com/app', title: 'App', origin: 'https://example.com', localStorage: {}, sessionStorage: {} }) },
      }),
      'Network.getCookies': () => ({ cookies: [] }),
    });

    const parsed = JSON.parse(await T.checkpointStr(cdp, 'sid-1', { format: 'json', now: 12345 }));

    expect(parsed.schema).toBe('chrome-cdp-ex.checkpoint.v1');
    expect(parsed.page.url).toBe('https://example.com/app');
  });

  it('parses restore format separately from checkpoint artifact input', () => {
    const checkpoint = {
      schema: 'chrome-cdp-ex.checkpoint.v1',
      page: { url: 'https://example.com/app', title: 'App', origin: 'https://example.com' },
      storage: { localStorage: {}, sessionStorage: {} },
      cookies: [],
    };

    const parsed = T.parseRestoreArgs(['--format', 'json', '--json', JSON.stringify(checkpoint)]);

    expect(parsed.format).toBe('json');
    expect(parsed.source).toBe('inline JSON');
    expect(parsed.artifact.page.url).toBe('https://example.com/app');
  });

  it('redacts checkpoint JSON and file paths from restore action evidence', () => {
    expect(T.redactRestoreCommandArgs(['--json', '{"token":"secret"}', '--format', 'json']))
      .toEqual(['--json', '[checkpoint-json-redacted]']);
    expect(T.redactRestoreCommandArgs(['--file', '/Users/alice/private/checkpoint.json']))
      .toEqual(['--file', '[checkpoint-path-redacted]']);
    expect(T.redactRestoreCommandArgs(['/Users/alice/private/checkpoint.json']))
      .toEqual(['[checkpoint-path-redacted]']);
    expect(T.redactRestoreCommandArgs(['{"schema":"chrome-cdp-ex.checkpoint.v1","token":"TOPSECRET"}']))
      .toEqual(['[checkpoint-json-redacted]']);
  });

  it('redacts external-input paths, URLs, and payloads from action errors without rewriting unrelated failures', async () => {
    const path = '/Users/alice/private/checkpoint.json';
    const exposed = new Error(`ENOENT: no such file or directory, open '${path}'`);
    const redacted = T.redactRestoreActionError(exposed, ['--file', path]);
    expect(redacted).not.toBe(exposed);
    expect(redacted.message).toBe("ENOENT: no such file or directory, open '[checkpoint-path-redacted]'");
    expect(redacted.cause).toBe(exposed);

    const positional = T.redactRestoreActionError(exposed, [path]);
    expect(positional.message).not.toContain('/Users/alice');

    const checkpointJson = '{"schema":"TOPSECRET","page":{"url":"https://private.example.test/token"}}';
    const inline = T.redactRestoreActionError(
      new Error('restore: unsupported checkpoint schema TOPSECRET at https://private.example.test/token'),
      [checkpointJson],
    );
    expect(inline.message).not.toContain('TOPSECRET');
    expect(inline.message).not.toContain('private.example.test');

    const upload = T.redactExternalInputActionError(
      new Error(`upload failed for ${path}`),
      'upload',
      ['#file', `${path},/home/alice/second.txt`],
    );
    expect(upload.message).not.toContain('/Users/alice');
    expect(upload.message).not.toContain('/home/alice');

    const inject = T.redactExternalInputActionError(
      new Error('Failed to load stylesheet: https://private.example.test/style.css?token=TOPSECRET'),
      'inject',
      ['--css-file', 'https://private.example.test/style.css?token=TOPSECRET'],
    );
    expect(inject.message).not.toContain('private.example.test');
    expect(inject.message).not.toContain('TOPSECRET');

    const receipt = JSON.parse(await T.runActionWithFeedback({
      action: 'upload',
      target: { input: '#file', resolvedBy: 'selector', label: '#file', commandArgs: ['#file', '<redacted>'] },
      dispatch: async () => { throw upload; },
      feedbackPolicy: 'state-change',
      observe: async () => '',
      format: 'json',
    }));
    expect(JSON.stringify(receipt)).not.toContain('/Users/alice');
    expect(JSON.stringify(receipt)).not.toContain('/home/alice');

    const unrelated = new Error('restore: unsupported checkpoint schema wrong');
    expect(T.redactRestoreActionError(unrelated, ['--file', path])).toBe(unrelated);
  });

  it('restores cookies, URL, and storage from a checkpoint artifact', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { value: 'restored' } }),
      'Network.setCookie': () => ({ success: true }),
      'Page.navigate': () => ({ loaderId: 'loader-1' }),
      'Runtime.callFunctionOn': () => ({ result: { value: 'complete' } }),
      'event:Page.loadEventFired': () => ({}),
    });
    const checkpoint = {
      schema: 'chrome-cdp-ex.checkpoint.v1',
      page: { url: 'https://example.com/app', title: 'App', origin: 'https://example.com' },
      storage: {
        localStorage: { theme: 'dark' },
        sessionStorage: { wizard: '2' },
      },
      cookies: [{ name: 'sid', value: 'abc', domain: 'example.com', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }],
    };

    const out = await T.restoreCheckpointStr(cdp, 'sid-1', ['--json', JSON.stringify(checkpoint)]);

    expect(out).toContain('Restored checkpoint');
    expect(out).toContain('cookies: 1');
    expect(cdp.calls.some(c => c.method === 'Network.setCookie' && c.params.name === 'sid' && c.params.value === 'abc' && c.params.url === 'https://example.com/app')).toBe(true);
    expect(cdp.calls.some(c => c.method === 'Network.setCookie' && c.params.value === '<redacted>')).toBe(false);
    expect(cdp.calls.some(c => c.method === 'Page.navigate' && c.params.url === 'https://example.com/app')).toBe(true);
    const storageCall = cdp.calls.find(c => c.method === 'Runtime.evaluate' && c.params.expression.includes('localStorage.setItem'));
    expect(storageCall.params.expression).toContain('"theme"');
    expect(storageCall.params.expression).toContain('"wizard"');
  });

  it('falls back to page-side navigation when Page.navigate times out', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { value: 'restored' } }),
      'Page.navigate': () => { throw new Error('Timeout: Page.navigate'); },
      'event:Page.loadEventFired': () => ({}),
    });
    const checkpoint = {
      schema: 'chrome-cdp-ex.checkpoint.v1',
      page: { url: 'https://example.com/app', title: 'App', origin: 'https://example.com' },
      storage: { localStorage: { theme: 'dark' }, sessionStorage: {} },
      cookies: [],
    };

    const out = await T.restoreCheckpointStr(cdp, 'sid-1', ['--json', JSON.stringify(checkpoint)]);

    expect(out).toContain('Restored checkpoint');
    expect(cdp.calls.some(c => c.method === 'Runtime.evaluate' && c.params.expression.includes('location.assign'))).toBe(true);
    expect(cdp.calls.some(c => c.method === 'Runtime.evaluate' && c.params.expression.includes('localStorage.setItem'))).toBe(true);
  });

  it('skips navigation when already at the checkpoint URL', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': (params) => {
        if (params.expression === 'location.href') return { result: { value: 'https://example.com/app' } };
        return { result: { value: 'restored' } };
      },
      'Page.navigate': () => { throw new Error('Page.navigate should not be called'); },
    });
    const checkpoint = {
      schema: 'chrome-cdp-ex.checkpoint.v1',
      page: { url: 'https://example.com/app', title: 'App', origin: 'https://example.com' },
      storage: { localStorage: { theme: 'dark' }, sessionStorage: {} },
      cookies: [],
    };

    const out = await T.restoreCheckpointStr(cdp, 'sid-1', ['--json', JSON.stringify(checkpoint)]);

    expect(out).toContain('Restored checkpoint');
    expect(out).toContain('already at checkpoint URL');
    expect(cdp.calls.some(c => c.method === 'Page.navigate')).toBe(false);
    expect(cdp.calls.some(c => c.method === 'Runtime.evaluate' && c.params.expression.includes('localStorage.setItem'))).toBe(true);
  });

  it('restores unsafe-full cookie values instead of the <redacted> sentinel', async () => {
    const setCookies = [];
    const cdp = createMockCDP({
      'Runtime.evaluate': (params) => {
        if (params.expression === 'location.href') {
          return { result: { value: 'https://example.com/#p17mut2' } };
        }
        return { result: { value: 'restored' } };
      },
      'Network.setCookie': (params) => {
        setCookies.push(params);
        return { success: true };
      },
      'Page.navigate': () => ({ loaderId: 'loader-1' }),
      'event:Page.loadEventFired': () => ({}),
    });
    const checkpoint = {
      schema: 'chrome-cdp-ex.checkpoint.v1',
      privacy: { redaction: 'unsafe-full', cookies: false, storage: false },
      page: { url: 'https://example.com/', title: 'Example', origin: 'https://example.com' },
      storage: { localStorage: {}, sessionStorage: {} },
      cookies: [{ name: 'picky17full', value: 'orig', domain: 'example.com', path: '/' }],
    };

    const out = await T.restoreCheckpointStr(cdp, 'sid-1', ['--json', JSON.stringify(checkpoint)]);

    expect(out).toContain('cookies: 1');
    expect(setCookies).toEqual([
      expect.objectContaining({
        name: 'picky17full',
        value: 'orig',
        url: 'https://example.com/',
      }),
    ]);
    expect(setCookies[0].value).not.toBe('<redacted>');
    expect(T.sanitizeCheckpointCookies(checkpoint.cookies)[0].value).toBe('<redacted>');
  });

  it('does not plant the <redacted> sentinel when restoring a default checkpoint', async () => {
    const setCookies = [];
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { value: 'https://example.com/' } }),
      'Network.setCookie': (params) => {
        setCookies.push(params);
        return { success: true };
      },
      'Page.navigate': () => ({ loaderId: 'loader-1' }),
      'event:Page.loadEventFired': () => ({}),
    });
    const checkpoint = {
      schema: 'chrome-cdp-ex.checkpoint.v1',
      privacy: { redaction: 'default-redacted', cookies: true, storage: true },
      page: { url: 'https://example.com/', title: 'Example', origin: 'https://example.com' },
      storage: { localStorage: {}, sessionStorage: {} },
      cookies: [{
        name: 'picky17full',
        value: '<redacted>',
        domain: 'example.com',
        path: '/',
        redacted: ['value'],
      }],
    };

    const out = await T.restoreCheckpointStr(cdp, 'sid-1', ['--json', JSON.stringify(checkpoint)]);

    expect(out).toContain('cookies: 0');
    expect(setCookies).toEqual([]);
  });
});
