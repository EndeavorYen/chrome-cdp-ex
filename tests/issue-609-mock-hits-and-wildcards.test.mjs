import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

const tempDirs = [];
function runtimeDir() {
  const dir = mkdtempSync(join(tmpdir(), 'cdp-609-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakeCdp({ fail = [] } = {}) {
  const calls = [];
  return {
    calls,
    send(method, params = {}, sessionId) {
      calls.push({ method, params, sessionId });
      if (fail.includes(method)) return Promise.reject(new Error(`${method} failed`));
      return Promise.resolve({});
    },
  };
}

function sessionAt(dir, targetId = 'T609TARGET') {
  const session = T.createSessionState({
    targetId,
    sessionId: 'sid-609',
    logPath: join(dir, `cdp-${targetId}.log`),
  });
  session.runtimeDir = dir;
  return session;
}

async function arm(pattern, url, { method = 'GET' } = {}) {
  const state = T.createSessionState({ targetId: 'T609', sessionId: 'sid' });
  const cdp = fakeCdp();
  await T.mockStr(cdp, 'sid', state, ['add', pattern, '--status', '500', '--body', 'no']);
  await T.handleMockRequestPaused(cdp, 'sid', state, {
    requestId: 'req-1',
    request: { method, url },
  });
  const enable = cdp.calls.find(call => call.method === 'Fetch.enable');
  return {
    hits: T.buildMockModel(state, { mode: 'status' }).rules[0].hits,
    fulfilled: cdp.calls.some(call => call.method === 'Fetch.fulfillRequest'),
    continued: cdp.calls.some(call => call.method === 'Fetch.continueRequest'),
    patterns: enable?.params.patterns,
  };
}

describe('#609 mock hit counts and wildcard matching', () => {
  it('keeps the hit count for the life of the mock, including a daemon restart', async () => {
    const dir = runtimeDir();
    const first = sessionAt(dir);
    const cdp = fakeCdp();
    await T.mockStr(cdp, 'sid-609', first, ['add', 'https://example.com/api/items*', '--status', '500', '--body', 'no']);
    await T.handleMockRequestPaused(cdp, 'sid-609', first, {
      requestId: 'hit-1',
      request: { method: 'GET', url: 'https://example.com/api/items?x=1' },
    });
    expect(T.buildMockModel(first, { mode: 'status' }).rules[0].hits).toBe(1);
    expect(T.readTabEnvironment(first.targetId, { runtimeDir: dir }).mocks[0].hits).toBe(1);

    const next = sessionAt(dir);
    await T.applySavedTabEnvironment(fakeCdp(), 'sid-next', next, { value: true }, { runtimeDir: dir });
    expect(next.networkMocks[0].hits).toBe(1);
    expect(T.formatMockText(T.buildMockModel(next, { mode: 'status' }))).toContain('(1 hit)');

    await T.handleMockRequestPaused(fakeCdp(), 'sid-next', next, {
      requestId: 'hit-2',
      request: { method: 'GET', url: 'https://example.com/api/items?x=2' },
    });
    expect(next.networkMocks[0].hits).toBe(2);
    expect(T.readTabEnvironment(next.targetId, { runtimeDir: dir }).mocks[0].hits).toBe(2);
  });

  it('does not drop the hit count when the recent-hit buffer fills', async () => {
    const state = T.createSessionState({ targetId: 'T609', sessionId: 'sid' });
    const cdp = fakeCdp();
    await T.mockStr(cdp, 'sid', state, ['add', 'https://example.com/api/*', '--status', '500', '--body', 'no']);
    for (let i = 0; i < 51; i += 1) {
      await T.handleMockRequestPaused(cdp, 'sid', state, {
        requestId: `hit-${i}`,
        request: { method: 'GET', url: `https://example.com/api/item-${i}` },
      });
    }
    expect(T.buildMockModel(state, { mode: 'status' }).rules[0].hits).toBe(51);
    expect(T.formatMockText(T.buildMockModel(state, { mode: 'status' }))).toContain('(51 hits)');
  });

  it('matches wildcard patterns against the URLs a browser request actually uses', async () => {
    const cases = [
      ['https://example.com/api/items?', 'https://example.com/api/items'],
      ['https://example.com/api/items?*', 'https://example.com/api/items'],
      ['https://example.com/api/items?*', 'https://example.com/api/items?x=1'],
      ['https://example.com/api/items\\?x=*', 'https://example.com/api/items?x=1'],
      ['https://example.com/file?.js', 'https://example.com/file.js'],
      ['/api/items*', 'https://example.com/api/items?x=1'],
      ['example.com/api*', 'https://example.com/api/v1?x=1'],
      ['example.com/api*', 'https://www.example.com/api/v1'],
      ['items*', 'https://cdn.example.com/assets/items?x=1'],
      ['**/api/*', 'https://example.com/api/items?x=1#section'],
    ];
    for (const [pattern, url] of cases) {
      const result = await arm(pattern, url);
      expect(result, `${pattern} -> ${url}`).toMatchObject({ hits: 1, fulfilled: true, continued: false });
    }

    const hostBoundary = await arm('example.com/api*', 'https://notexample.com/api/v1');
    expect(hostBoundary).toMatchObject({ hits: 0, fulfilled: false, continued: true });

    const otherPath = await arm('/api/items*', 'https://example.com/other/api/items');
    expect(otherPath).toMatchObject({ hits: 0, fulfilled: false, continued: true });

    const literalQuestion = await arm('https://example.com/api/items\\?x=*', 'https://example.com/api/itemsXx=1');
    expect(literalQuestion).toMatchObject({ hits: 0, fulfilled: false, continued: true });
  });

  it('registers a Fetch pattern wide enough for path and host wildcards and disables the HTTP cache', async () => {
    const state = T.createSessionState({ targetId: 'T609', sessionId: 'sid' });
    const cdp = fakeCdp();
    await T.mockStr(cdp, 'sid', state, ['add', '/api/items*', '--status', '500', '--body', 'no']);
    await T.mockStr(cdp, 'sid', state, ['add', 'example.com/api*', '--status', '500', '--body', 'no']);
    const patterns = cdp.calls.filter(call => call.method === 'Fetch.enable').at(-1).params.patterns;
    expect(patterns).toEqual([
      { urlPattern: '*/api/items*', requestStage: 'Request' },
      { urlPattern: '*example.com/api*', requestStage: 'Request' },
    ]);
    expect(cdp.calls.filter(call => call.method === 'Network.setCacheDisabled').at(-1).params).toEqual({ cacheDisabled: true });

    await T.mockStr(cdp, 'sid', state, ['clear']);
    expect(cdp.calls.at(-1)).toMatchObject({
      method: 'Network.setCacheDisabled',
      params: { cacheDisabled: false },
    });
  });

  it('warns at registration when a pattern cannot match a browser request URL', async () => {
    const state = T.createSessionState({ targetId: 'ABC123', sessionId: 'sid' });
    const broken = await T.mockStr(fakeCdp(), 'sid', state, ['add', 'http:/api*', '--status', '500', '--body', 'no']);
    expect(broken).toContain('Warning: mock pattern "http:/api*" has one slash after the scheme, so it cannot match a browser URL. Use http:// or https://.');
    expect(broken).toContain('pattern cannot match');

    const bare = await T.mockStr(fakeCdp(), 'sid', state, ['add', '?', '--status', '500', '--body', 'no']);
    expect(bare).toContain('Warning: mock pattern "?" cannot match a browser request URL. Use a full URL, a leading *, or a path that starts with /.');

    const spaced = JSON.parse(await T.mockStr(fakeCdp(), 'sid', state, [
      'add', 'https://example.com/a b*', '--status', '500', '--format', 'json',
    ]));
    expect(spaced.rules.at(-1).warning).toBe('mock pattern "https://example.com/a b*" contains whitespace, so it cannot match a request URL. Encode a space as %20.');

    const usable = await T.mockStr(fakeCdp(), 'sid', state, ['add', '**/api/*', '--status', '503', '--body', 'no']);
    expect(usable).not.toContain('Warning:');
  });

  it('documents the matching rule in help', () => {
    expect(T.CATALOG_USAGE).toContain('* = any length (including / and ?), ? = zero or one character, \\ escapes * ? and \\. Case-sensitive.');
    expect(T.CATALOG_USAGE).toContain('A pattern with ://, a leading *, or a scheme matches that whole URL.');
    expect(T.CATALOG_USAGE).toContain('No scheme and a leading / matches the path and query only.');
    expect(T.CATALOG_USAGE).toContain('No scheme otherwise matches the path and query. With a dot it also matches the host after :// and one subdomain label.');
    expect(T.CATALOG_USAGE).toContain('A pattern that cannot match warns when it is added. Hit counts persist with the rule.');
    expect(T.CATALOG_USAGE).toContain('The HTTP cache is disabled while a mock is active.');
  });
});
