import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

describe('issue #267 restore --unsafe-full cookie fidelity', () => {
  it('#267 unsafe-full restore writes the original cookie, not the literal <redacted> sentinel', async () => {
    const setCookies = [];
    const cdp = {
      calls: [],
      send(method, params = {}) {
        cdp.calls.push({ method, params });
        if (method === 'Network.setCookie') {
          setCookies.push(params);
          return Promise.resolve({ success: true });
        }
        if (method === 'Page.navigate') return Promise.resolve({ loaderId: 'loader-1' });
        if (method === 'Runtime.evaluate') {
          if (params.expression === 'location.href') {
            return Promise.resolve({ result: { value: 'https://example.com/#p17mut2' } });
          }
          return Promise.resolve({ result: { value: 'restored' } });
        }
        return Promise.resolve({});
      },
      onEvent() { return () => {}; },
      waitForEvent() {
        return { promise: Promise.resolve({}), cancel() {} };
      },
    };
    const checkpoint = {
      schema: 'chrome-cdp-ex.checkpoint.v1',
      privacy: { redaction: 'unsafe-full', cookies: false, storage: false },
      page: { url: 'https://example.com/', title: 'Example', origin: 'https://example.com' },
      storage: { localStorage: {}, sessionStorage: {} },
      cookies: [{ name: 'picky17full', value: 'orig', domain: 'example.com', path: '/' }],
    };

    const out = await T.restoreCheckpointStr(cdp, 'sid', ['--json', JSON.stringify(checkpoint)]);

    expect(out).toContain('Restored checkpoint');
    expect(setCookies).toHaveLength(1);
    expect(setCookies[0]).toMatchObject({ name: 'picky17full', value: 'orig' });
    expect(setCookies[0].value).not.toBe('<redacted>');
    expect(T.sanitizeCheckpointCookies(checkpoint.cookies)[0].value).toBe('<redacted>');
    expect(T.cookiesForRestore(checkpoint.cookies)[0].value).toBe('orig');
  });

  it('#267 default redacted checkpoint restore leaves later cookies in place', async () => {
    const setCookies = [];
    const cdp = {
      send(method, params = {}) {
        if (method === 'Network.setCookie') {
          setCookies.push(params);
          return Promise.resolve({ success: true });
        }
        if (method === 'Runtime.evaluate') {
          return Promise.resolve({ result: { value: 'https://example.com/' } });
        }
        return Promise.resolve({});
      },
      onEvent() { return () => {}; },
      waitForEvent() {
        return { promise: Promise.resolve({}), cancel() {} };
      },
    };
    const checkpoint = {
      schema: 'chrome-cdp-ex.checkpoint.v1',
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

    const out = await T.restoreCheckpointStr(cdp, 'sid', ['--json', JSON.stringify(checkpoint)]);
    expect(out).toContain('cookies: 0');
    expect(setCookies).toEqual([]);
    expect(T.cookiesForRestore(checkpoint.cookies)).toEqual([]);
  });
});
