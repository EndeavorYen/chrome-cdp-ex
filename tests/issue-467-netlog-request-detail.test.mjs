import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
const {
  NETLOG_BODY_PREVIEW_BYTES,
  createNetlogRequestStore,
  isSensitiveHeaderName,
  parseNetlogArgs,
  redactBodyText,
  redactHeaders,
  writeNetlogBodyFile,
} = await import('../skills/chrome-cdp-ex/scripts/lib/netlog.mjs');
const { argsRequireConfirm } = await import('../skills/chrome-cdp-ex/scripts/lib/mcp-adapter.mjs');
const { redactMarkupSecrets, redactSensitiveString } = await import('../skills/chrome-cdp-ex/scripts/lib/redaction.mjs');

function timed(fn) {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
}

// #467 / #555: `netlog` lists each tracked request with a short id.
// `netlog <target> --id N` prints status, timing and headers. The body stays
// omitted until `--body`. `--out` writes the file without echoing the body.

const TARGET = 'ABC46700';
const SECRETS = ['tok-url-123', 'Bearer-secret-456', 'sess-cookie-789', 'set-cookie-abc', 'x-auth-def', 'api-key-ghi', 'body-token-jkl'];
const API_URL = 'https://app.example/api/items?page=2&access_token=tok-url-123';

function expectNoSecrets(text) {
  for (const secret of SECRETS) expect(text, secret).not.toContain(secret);
}

// Feeds CDP Network events to the store and mirrors what the daemon pushes into
// its netReqBuf, so the list and the detail come from the same fake traffic.
function fakeTraffic() {
  const store = createNetlogRequestStore({ shouldTrack: T.shouldTrackActionNetworkRequest, now: () => 1_000_000 });
  const buf = new T.RingBuffer(100);
  const fire = (event, params) => store.handlers[event](params);
  const now = Date.now();

  // r1: fetch → 500 JSON error, with every kind of secret header.
  fire('Network.requestWillBeSent', {
    requestId: 'r1', type: 'Fetch', timestamp: 100, wallTime: 1_700_000_000,
    initiator: { type: 'script', stack: { callFrames: [{ url: 'https://app.example/app.js?sig=abc' }] } },
    request: { method: 'POST', url: API_URL, hasPostData: true, headers: { Accept: 'application/json', Authorization: 'Bearer Bearer-secret-456', 'X-Auth-Token': 'x-auth-def' } },
  });
  fire('Network.requestWillBeSentExtraInfo', {
    requestId: 'r1',
    headers: { Accept: 'application/json', Authorization: 'Bearer Bearer-secret-456', 'X-Auth-Token': 'x-auth-def', 'X-Api-Key': 'api-key-ghi', Cookie: 'sid=sess-cookie-789' },
  });
  fire('Network.responseReceived', {
    requestId: 'r1', type: 'Fetch',
    response: {
      status: 500, statusText: 'Internal Server Error', mimeType: 'application/json', protocol: 'http/1.1',
      headers: { 'Content-Type': 'application/json' },
      timing: { requestTime: 100, dnsStart: 0, dnsEnd: 1.5, connectStart: 1.5, connectEnd: 4, sslStart: 2, sslEnd: 4, sendStart: 4.2, sendEnd: 4.4, receiveHeadersEnd: 54.4 },
    },
  });
  fire('Network.responseReceivedExtraInfo', {
    requestId: 'r1', statusCode: 500, headersText: 'HTTP/1.1 500 Internal Server Error\r\n',
    headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'sid=set-cookie-abc; HttpOnly', 'Access-Control-Allow-Credentials': 'true', Location: 'https://app.example/next?token=tok-url-123' },
  });
  fire('Network.loadingFinished', { requestId: 'r1', timestamp: 100.123, encodedDataLength: 321 });
  buf.push({ requestId: 'r1', method: 'POST', url: API_URL, type: 'Fetch', status: 500, duration: 123, size: 321, ts: now });

  // r2: xhr → 200.
  fire('Network.requestWillBeSent', { requestId: 'r2', type: 'XHR', request: { method: 'GET', url: 'https://app.example/api/me', headers: {} } });
  fire('Network.responseReceived', { requestId: 'r2', type: 'XHR', response: { status: 200, statusText: 'OK', mimeType: 'application/json', headers: {} } });
  fire('Network.loadingFinished', { requestId: 'r2', timestamp: 2, encodedDataLength: 10 });
  // The daemon writes the buffer entry at responseReceived, before the body arrives.
  buf.push({ requestId: 'r2', method: 'GET', url: 'https://app.example/api/me', type: 'XHR', status: 200, duration: 5, size: 0, ts: now });

  // r3: fetch that never got a response (network error); first seen pending by an action.
  fire('Network.requestWillBeSent', { requestId: 'r3', type: 'Fetch', request: { method: 'GET', url: 'https://down.example/health', headers: {} } });
  buf.push({ requestId: 'r3', method: 'GET', url: 'https://down.example/health', type: 'Fetch', status: 'pending', pending: true, duration: 1, size: 0, ts: now });
  fire('Network.loadingFailed', { requestId: 'r3', type: 'Fetch', errorText: 'net::ERR_CONNECTION_REFUSED', canceled: false });
  buf.push({ requestId: 'r3', method: 'GET', url: 'https://down.example/health', type: 'Fetch', status: null, failed: true, errorText: 'net::ERR_CONNECTION_REFUSED', duration: 9, size: 0, ts: now });

  // r4: document → 404; r5: an image is never tracked.
  fire('Network.requestWillBeSent', { requestId: 'r4', type: 'Document', request: { method: 'GET', url: 'https://app.example/missing', headers: {} } });
  fire('Network.responseReceived', { requestId: 'r4', type: 'Document', response: { status: 404, statusText: 'Not Found', mimeType: 'text/html', headers: {} } });
  fire('Network.loadingFinished', { requestId: 'r4', timestamp: 3, encodedDataLength: 50 });
  buf.push({ requestId: 'r4', method: 'GET', url: 'https://app.example/missing', type: 'Document', status: 404, duration: 7, size: 50, ts: now });
  fire('Network.requestWillBeSent', { requestId: 'r5', type: 'Image', request: { method: 'GET', url: 'https://app.example/logo.png', headers: {} } });

  return { store, buf };
}

function fakeCdp(bodies = {}) {
  const calls = [];
  return {
    calls,
    send(method, params, sessionId) {
      calls.push([method, params, sessionId]);
      if (method !== 'Network.getResponseBody') return Promise.resolve({});
      const body = bodies[params.requestId];
      if (!body) return Promise.reject(new Error('No resource with given identifier found'));
      return Promise.resolve(body);
    },
  };
}

const ERROR_BODY = { body: JSON.stringify({ error: 'database unavailable', access_token: 'body-token-jkl' }), base64Encoded: false };

let tempDirs = [];
afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe('#467 netlog request ids and filters', () => {
  it('lists each tracked request once with a stable #id, redacted, and points at the newest failure', () => {
    const { store, buf } = fakeTraffic();
    const out = T.netlogStr(buf, null, { requestStore: store, targetId: TARGET, filters: parseNetlogArgs([]) });
    expect(out).toMatch(/^Network requests \(4\):/);
    expect(out).toContain('#1 POST https://app.example/api/items?page=2&access_token=<redacted> → 500');
    expect(out).toContain('#2 GET https://app.example/api/me → 200 (5ms, 10B)');
    expect(out).toContain('#3 GET https://down.example/health → failed (net::ERR_CONNECTION_REFUSED)');
    expect(out).not.toMatch(/#3 .*pending/);
    expect(out.match(/#3 /g)).toHaveLength(1);
    expect(out).toContain('#4 GET https://app.example/missing → 404');
    expect(out).toContain(`Next: cdp netlog ${TARGET} --id 4`);
    expectNoSecrets(out);
    expect(store.idFor('r5')).toBeNull();
  });

  it('filters by --type, --url and --status', () => {
    const { store, buf } = fakeTraffic();
    const list = args => JSON.parse(T.netlogStr(buf, null, {
      requestStore: store, targetId: TARGET, format: 'json', filters: parseNetlogArgs(args),
    }));
    const ids = args => list(args).requests.map(request => request.id);
    expect(ids(['--type', 'xhr'])).toEqual([2]);
    expect(ids(['--type', 'fetch,document'])).toEqual([1, 3, 4]);
    expect(ids(['--type', 'XHR,Fetch'])).toEqual([1, 2, 3]);
    expect(ids(['--url', '/api/'])).toEqual([1, 2]);
    expect(ids(['--url', 'DOWN.example'])).toEqual([3]);
    expect(ids(['--status', '5xx'])).toEqual([1]);
    expect(ids(['--status', '4xx'])).toEqual([4]);
    expect(ids(['--status', 'failed'])).toEqual([3]);
    expect(ids(['--status', '404,500'])).toEqual([1, 4]);
    expect(ids(['--status', '4xx,5xx,failed', '--type', 'fetch'])).toEqual([1, 3]);
    // The URL filter sees what is printed, so it cannot probe a redacted value.
    expect(ids(['--url', 'tok-url-123'])).toEqual([]);
    expect(ids(['--url', 'tok-url-123', '--unsafe-full'])).toEqual([]);
    const filtered = list(['--status', '5xx']);
    expect(filtered).toMatchObject({ schema: 'chrome-cdp-ex.netlog.v1', targetId: TARGET, redacted: true, total: 4, count: 1 });
    expect(filtered.filters).toEqual({ types: [], url: null, status: ['5xx'] });
    expect(T.netlogStr(buf, null, { requestStore: store, targetId: TARGET, filters: parseNetlogArgs(['--status', '2xx', '--type', 'document']) }))
      .toBe(`No captured requests match the filters (4 captured). Next: cdp netlog ${TARGET}`);
    expect(T.netlogStr(buf, null, { requestStore: store, targetId: TARGET, filters: parseNetlogArgs(['--type', 'xhr']) }))
      .toMatch(/^Network requests \(1 of 4\):/);
  });

  it('--unsafe-full lists raw URLs; the URL filter then matches raw text', () => {
    const { store, buf } = fakeTraffic();
    const raw = JSON.parse(T.netlogStr(buf, null, {
      requestStore: store, targetId: TARGET, format: 'json', unsafeFull: true, filters: parseNetlogArgs(['--url', 'tok-url-123', '--unsafe-full']),
    }));
    expect(raw.redacted).toBe(false);
    expect(raw.requests.map(request => request.url)).toEqual([API_URL]);
  });

  it('--clear empties the list and the detail store, and ids are never reused', () => {
    const { store, buf } = fakeTraffic();
    expect(T.netlogStr(buf, '--clear', { requestStore: store })).toBe('Network log cleared');
    expect(store.get(1)).toBeNull();
    store.handlers['Network.requestWillBeSent']({ requestId: 'r9', type: 'Fetch', request: { method: 'GET', url: 'https://app.example/after', headers: {} } });
    expect(store.idFor('r9')).toBe(5);
  });

  it('parses and validates arguments', () => {
    expect(parseNetlogArgs([])).toEqual({ clear: false, unsafeFull: false, includeBody: false, format: 'text', id: null, out: null, overwrite: false, types: [], url: null, status: [] });
    expect(parseNetlogArgs(['--id', '7', '--body'])).toMatchObject({ id: 7, includeBody: true });
    expect(() => parseNetlogArgs(['--body'])).toThrow(/--body requires --id/);
    expect(() => parseNetlogArgs(['--clear', '--id', '1', '--body'])).toThrow(/cannot be combined/);
    expect(parseNetlogArgs(['--id', '#12', '--out', 'body.json', '--format', 'json'])).toMatchObject({ id: 12, out: 'body.json', format: 'json' });
    expect(parseNetlogArgs(['--id', '7'])).toMatchObject({ id: 7 });
    expect(() => parseNetlogArgs(['--id', 'abc'])).toThrow(/--id requires a request number/);
    expect(() => parseNetlogArgs(['--id'])).toThrow(/--id requires a value/);
    expect(() => parseNetlogArgs(['--type', 'xhrr'])).toThrow(/not a resource type/);
    expect(() => parseNetlogArgs(['--status', '6xx'])).toThrow(/--status 6xx must be/);
    expect(() => parseNetlogArgs(['--out', 'x.json'])).toThrow(/--out requires --id/);
    expect(parseNetlogArgs(['--id', '1', '--out', '/a.json', '--overwrite'])).toMatchObject({ out: '/a.json', overwrite: true });
    expect(() => parseNetlogArgs(['--id', '1', '--overwrite'])).toThrow(/--overwrite only applies to --out/);
    expect(() => parseNetlogArgs(['--id', '1', '--status', '5xx'])).toThrow(/cannot be combined/);
    expect(() => parseNetlogArgs(['--clear', '--id', '1'])).toThrow(/cannot be combined/);
    expect(() => parseNetlogArgs(['--bogus'])).toThrow(/netlog: unknown argument --bogus/);
  });
});

describe('#467 netlog --id request detail', () => {
  it('T1 default --id omits access_token, a nested JSON-string secret, and an escaped-quote secret', async () => {
    const { store } = fakeTraffic();
    const body = [
      '{"access_token":"BODY-ACCESS-TOKEN-555",',
      '"wrapped":"{\\"token\\":\\"NESTED-SECRET-511\\"}",',
      '"msg":"\\"ESCAPED-QUOTE-SECRET-503"}',
    ].join('');
    const secrets = ['BODY-ACCESS-TOKEN-555', 'NESTED-SECRET-511', 'ESCAPED-QUOTE-SECRET-503'];
    const cdp = fakeCdp({ r2: { body, base64Encoded: false } });
    const text = await T.netlogRequestStr(cdp, 'SESSION', store, parseNetlogArgs(['--id', '2']), { targetId: TARGET });
    const model = JSON.parse(await T.netlogRequestStr(cdp, 'SESSION', store, parseNetlogArgs(['--id', '2', '--format', 'json']), { targetId: TARGET }));
    for (const secret of secrets) {
      expect(text, secret).not.toContain(secret);
      expect(JSON.stringify(model), secret).not.toContain(secret);
    }
    expect(text).toContain('Status: 200');
    expect(text).toContain('Body: omitted (pass --body to include the redacted body)');
    expect(model.body).toMatchObject({ omitted: true });
    expect(model.body.text).toBeUndefined();
    expect(cdp.calls).toEqual([]);
  });

  it('a failed fetch shows its status, timing and initiator; the body stays omitted until --body', async () => {
    const { store } = fakeTraffic();
    const cdp = fakeCdp({ r1: ERROR_BODY });
    const text = await T.netlogRequestStr(cdp, 'SESSION', store, parseNetlogArgs(['--id', '1']), { targetId: TARGET });
    expect(cdp.calls).toEqual([]);
    expect(text).toContain('Request #1');
    expect(text).toContain('POST https://app.example/api/items?page=2&access_token=<redacted>');
    expect(text).toContain('Status: 500 Internal Server Error');
    expect(text).toContain('Type: Fetch | MIME: application/json | Protocol: http/1.1');
    expect(text).toContain('Initiator: script https://app.example/app.js?sig=<redacted>');
    expect(text).toContain('Timing: total 123ms | dns 1.5ms | connect 2.5ms | ssl 2ms | send 0.2ms | wait (TTFB) 50ms');
    expect(text).toContain('Authorization: <redacted>');
    expect(text).toContain('Cookie: <redacted>');
    expect(text).toContain('X-Auth-Token: <redacted>');
    expect(text).toContain('X-Api-Key: <redacted>');
    expect(text).toContain('Set-Cookie: <redacted>');
    expect(text).toContain('Access-Control-Allow-Credentials: true');
    expect(text).toContain('Location: https://app.example/next?token=<redacted>');
    expect(text).toContain('Body: omitted (pass --body to include the redacted body)');
    expect(text).not.toContain('"error":"database unavailable"');
    expect(text).toContain(`Next: cdp netlog ${TARGET}`);
    expectNoSecrets(text);
    const withBody = await T.netlogRequestStr(cdp, 'SESSION', store, parseNetlogArgs(['--id', '1', '--body']), { targetId: TARGET });
    expect(cdp.calls).toEqual([['Network.getResponseBody', { requestId: 'r1' }, 'SESSION']]);
    expect(withBody).toContain('"error":"database unavailable"');
    expect(withBody).toContain('secrets redacted');
    expectNoSecrets(withBody);
  });

  it('--format json emits chrome-cdp-ex.netlog-request.v1, redacted by default', async () => {
    const { store } = fakeTraffic();
    const model = JSON.parse(await T.netlogRequestStr(fakeCdp({ r1: ERROR_BODY }), 'SESSION', store, parseNetlogArgs(['--id', '1', '--format', 'json']), { targetId: TARGET }));
    expect(model).toMatchObject({
      schema: 'chrome-cdp-ex.netlog-request.v1',
      targetId: TARGET,
      id: 1,
      redacted: true,
      state: 'complete',
      request: { method: 'POST', resourceType: 'Fetch', hasPostData: true, initiator: { type: 'script' } },
      response: { status: 500, statusText: 'Internal Server Error', mimeType: 'application/json', encodedDataLength: 321 },
      error: null,
      timing: { startedAt: '2023-11-14T22:13:20.000Z', totalMs: 123, waitMs: 50 },
      body: { omitted: true, savedTo: null, savedBytes: null, savedRedacted: null },
    });
    expect(model.body.text).toBeUndefined();
    expect(model.request.headers.Cookie).toBe('<redacted>');
    expect(model.response.headers['Set-Cookie']).toBe('<redacted>');
    expectNoSecrets(JSON.stringify(model));
    const withBody = JSON.parse(await T.netlogRequestStr(fakeCdp({ r1: ERROR_BODY }), 'SESSION', store, parseNetlogArgs(['--id', '1', '--body', '--format', 'json']), { targetId: TARGET }));
    expect(withBody.body).toMatchObject({ available: true, kind: 'text', truncated: false, redacted: true, savedTo: null });
    expect(withBody.nextSteps).toContain(`cdp netlog ${TARGET} --id 1 --body --unsafe-full  # raw body, headers and URL`);
    expect(JSON.parse(withBody.body.text)).toEqual({ error: 'database unavailable', access_token: '<redacted>' });
    expectNoSecrets(JSON.stringify(withBody));
  });

  it('--unsafe-full prints raw headers and URL; the body still needs --body', async () => {
    const { store } = fakeTraffic();
    const text = await T.netlogRequestStr(fakeCdp({ r1: ERROR_BODY }), 'SESSION', store, parseNetlogArgs(['--id', '1', '--unsafe-full']), { targetId: TARGET });
    expect(text).toContain('[unsafe-full: headers and URL not redacted]');
    expect(text).toContain('Body: omitted (pass --body to include the redacted body)');
    for (const secret of SECRETS) {
      if (secret === 'body-token-jkl') expect(text).not.toContain(secret);
      else expect(text).toContain(secret);
    }
    const raw = await T.netlogRequestStr(fakeCdp({ r1: ERROR_BODY }), 'SESSION', store, parseNetlogArgs(['--id', '1', '--body', '--unsafe-full']), { targetId: TARGET });
    for (const secret of SECRETS) expect(raw).toContain(secret);
  });

  it('bounds the body preview and --out writes the full body with mode 0600', async () => {
    const { store } = fakeTraffic();
    const big = JSON.stringify({ rows: Array.from({ length: 800 }, (_, i) => ({ i, name: `row-${i}` })), access_token: 'body-token-jkl' });
    expect(big.length).toBeGreaterThan(NETLOG_BODY_PREVIEW_BYTES * 3);
    const dir = mkdtempSync(join(tmpdir(), 'cdp-467-'));
    tempDirs.push(dir);
    const out = join(dir, 'body.json');
    const cdp = fakeCdp({ r2: { body: big, base64Encoded: false } });

    const omitted = JSON.parse(await T.netlogRequestStr(cdp, 'SESSION', store, parseNetlogArgs(['--id', '2', '--format', 'json']), { targetId: TARGET }));
    expect(omitted.body).toMatchObject({ omitted: true });
    expect(omitted.body.text).toBeUndefined();
    expect(omitted.nextSteps[0]).toBe(`cdp netlog ${TARGET}`);
    expect(cdp.calls).toEqual([]);
    const preview = JSON.parse(await T.netlogRequestStr(cdp, 'SESSION', store, parseNetlogArgs(['--id', '2', '--body', '--format', 'json']), { targetId: TARGET }));
    expect(preview.body).toMatchObject({ kind: 'text', bytes: big.length, truncated: true });
    expect(Buffer.byteLength(preview.body.text)).toBeLessThanOrEqual(NETLOG_BODY_PREVIEW_BYTES);
    expect(preview.nextSteps[0]).toBe(`cdp netlog ${TARGET} --id 2 --out <file>`);
    const previewText = await T.netlogRequestStr(cdp, 'SESSION', store, parseNetlogArgs(['--id', '2', '--body']), { targetId: TARGET });
    expect(previewText).toContain(`first ${preview.body.shownBytes} shown`);
    expect(previewText.length).toBeLessThan(NETLOG_BODY_PREVIEW_BYTES + 2000);

    const saved = await T.netlogRequestStr(cdp, 'SESSION', store, parseNetlogArgs(['--id', '2', '--out', out]), { targetId: TARGET });
    expect(saved).toContain('Body: omitted (pass --body to include the redacted body)');
    expect(saved).not.toContain('body-token-jkl');
    const written = readFileSync(out, 'utf8');
    expect(JSON.parse(written).rows).toHaveLength(800);
    expect(written).not.toContain('body-token-jkl');
    expect(written).toContain('"access_token":"<redacted>"');
    expect(saved).toContain(`Saved body: ${out}`);
    if (process.platform !== 'win32') expect(statSync(out).mode & 0o777).toBe(0o600);

    // An existing file is refused unless --overwrite; --unsafe-full keeps the 4 KB preview.
    await expect(T.netlogRequestStr(cdp, 'SESSION', store, parseNetlogArgs(['--id', '2', '--out', out, '--unsafe-full']), { targetId: TARGET }))
      .rejects.toThrow(/already exists; pass --overwrite/);
    const raw = JSON.parse(await T.netlogRequestStr(cdp, 'SESSION', store, parseNetlogArgs(['--id', '2', '--body', '--out', out, '--overwrite', '--unsafe-full', '--format', 'json']), { targetId: TARGET }));
    expect(Buffer.byteLength(raw.body.text)).toBeLessThanOrEqual(NETLOG_BODY_PREVIEW_BYTES);
    expect(raw.body).toMatchObject({ truncated: true, savedBytes: big.length, savedRedacted: false });
    expect(readFileSync(out, 'utf8')).toBe(big);
  });

  it('redacts JSON bodies structurally: nested objects, arrays and stringified JSON; the result still parses', async () => {
    const { store } = fakeTraffic();
    const body = JSON.stringify({
      error: 'db down',
      session: { id: 'SESSIONLEAK' },
      secrets: ['ARRLEAK'],
      credentials: { user: 'u', password: 'PWLEAK' },
      nested: JSON.stringify({ token: 'INNERLEAK', note: 'kept' }),
      list: [{ auth: { bearer: 'AUTHLEAK' } }, { name: 'ok' }],
      header: 'Bearer BEARERLEAK',
      jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln',
      tokens: 3,
    }).replace('"tokens":3', '"tokens":3,"id":12345678901234567890');
    const leaks = ['SESSIONLEAK', 'ARRLEAK', 'PWLEAK', 'INNERLEAK', 'AUTHLEAK', 'BEARERLEAK', 'eyJzdWIiOiIxIn0'];
    const dir = mkdtempSync(join(tmpdir(), 'cdp-467-'));
    tempDirs.push(dir);
    const out = join(dir, 'nested.json');
    const cdp = fakeCdp({ r1: { body, base64Encoded: false } });
    const model = JSON.parse(await T.netlogRequestStr(cdp, 'SESSION', store, parseNetlogArgs(['--id', '1', '--body', '--format', 'json', '--out', out]), { targetId: TARGET }));
    for (const shown of [model.body.text, readFileSync(out, 'utf8')]) {
      for (const leak of leaks) expect(shown, leak).not.toContain(leak);
      const parsed = JSON.parse(shown);
      expect(parsed).toMatchObject({ error: 'db down', session: '<redacted>', secrets: '<redacted>', credentials: '<redacted>', tokens: 3 });
      expect(parsed.list).toEqual([{ auth: '<redacted>' }, { name: 'ok' }]);
      expect(JSON.parse(parsed.nested)).toEqual({ token: '<redacted>', note: 'kept' });
      // 64-bit ids survive re-serialization byte for byte.
      expect(shown).toContain('"id":12345678901234567890');
    }
    expect(model.body).toMatchObject({ redacted: true, savedRedacted: true });
    // A JSON body with nothing secret is returned byte for byte.
    expect(redactBodyText('{ "a" : 1,\n "b": [1, 2] }')).toBe('{ "a" : 1,\n "b": [1, 2] }');
    expect(redactBodyText('{\n  "token": "x"\n}')).toBe('{\n  "token": "<redacted>"\n}');
  });

  it('redacts csrf and authenticity tokens, password inputs and secret XML elements in markup bodies', () => {
    const html = [
      '<form><input type="hidden" name="csrf_token" value="HTMLCSRF">',
      "<input name='authenticity_token' type='hidden' value='RAILSTOKEN'>",
      '<input type="password" name="pw" value="PWVALUE">',
      '<input name="q" value="search-term">',
      '<meta name="csrf-token" content="METACSRF"><meta name="viewport" content="width=device-width">',
      '<token>XMLTOKEN</token><tokens>3</tokens><code>x = 1</code></form>',
    ].join('');
    const out = redactBodyText(html, { mimeType: 'text/html' });
    for (const leak of ['HTMLCSRF', 'RAILSTOKEN', 'PWVALUE', 'METACSRF', 'XMLTOKEN']) expect(out, leak).not.toContain(leak);
    for (const kept of ['value="search-term"', 'content="width=device-width"', '<tokens>3</tokens>', '<code>x = 1</code>']) expect(out, kept).toContain(kept);
  });

  it('summarizes a binary body instead of printing it, and --out writes its bytes', async () => {
    const { store } = fakeTraffic();
    store.handlers['Network.responseReceived']({ requestId: 'r2', type: 'XHR', response: { status: 200, mimeType: 'application/octet-stream', headers: {} } });
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10]);
    const dir = mkdtempSync(join(tmpdir(), 'cdp-467-'));
    tempDirs.push(dir);
    const out = join(dir, 'blob.bin');
    const cdp = fakeCdp({ r2: { body: bytes.toString('base64'), base64Encoded: true } });
    const text = await T.netlogRequestStr(cdp, 'SESSION', store, parseNetlogArgs(['--id', '2', '--out', out]), { targetId: TARGET });
    expect(text).toContain('Body: omitted (pass --body to include the redacted body)');
    expect(text).toContain(`Saved body: ${out}`);
    expect(readFileSync(out)).toEqual(bytes);
    const shown = await T.netlogRequestStr(cdp, 'SESSION', store, parseNetlogArgs(['--id', '2', '--body']), { targetId: TARGET });
    expect(shown).toContain('Body: binary body, 7 bytes (application/octet-stream)');
  });

  it('a network failure reports errorText and no body; --out then fails', async () => {
    const { store } = fakeTraffic();
    const cdp = fakeCdp();
    const text = await T.netlogRequestStr(cdp, 'SESSION', store, parseNetlogArgs(['--id', '3']), { targetId: TARGET });
    expect(text).toContain('Status: failed');
    expect(text).toContain('Error: net::ERR_CONNECTION_REFUSED');
    expect(text).toContain('Body: omitted (pass --body to include the redacted body)');
    expect(cdp.calls).toEqual([]);
    const withBody = await T.netlogRequestStr(cdp, 'SESSION', store, parseNetlogArgs(['--id', '3', '--body']), { targetId: TARGET });
    expect(withBody).toContain('Body: not available (the request failed (net::ERR_CONNECTION_REFUSED), so there is no response body)');
    expect(cdp.calls).toEqual([]);
    await expect(T.netlogRequestStr(cdp, 'SESSION', store, parseNetlogArgs(['--id', '3', '--out', 'x.bin']), { targetId: TARGET }))
      .rejects.toThrow(/--out has no body to save for request #3/);
  });

  it('a body Chrome no longer holds is reported, not thrown', async () => {
    const { store } = fakeTraffic();
    const cdp = fakeCdp();
    const omitted = JSON.parse(await T.netlogRequestStr(cdp, 'SESSION', store, parseNetlogArgs(['--id', '4', '--format', 'json']), { targetId: TARGET }));
    expect(omitted.body).toMatchObject({ omitted: true });
    expect(omitted.body.error).toBeUndefined();
    expect(cdp.calls).toEqual([]);
    const model = JSON.parse(await T.netlogRequestStr(cdp, 'SESSION', store, parseNetlogArgs(['--id', '4', '--body', '--format', 'json']), { targetId: TARGET }));
    expect(model.body).toMatchObject({ available: false, error: 'Chrome no longer holds it: No resource with given identifier found' });
    expect(model.response).toMatchObject({ status: 404, statusText: 'Not Found' });
    store.handlers['Network.requestWillBeSent']({ requestId: 'r6', type: 'Fetch', request: { method: 'GET', url: 'https://app.example/slow', headers: {} } });
    const pendingCdp = fakeCdp();
    const pendingOmitted = JSON.parse(await T.netlogRequestStr(pendingCdp, 'SESSION', store, parseNetlogArgs(['--id', '5', '--format', 'json']), { targetId: TARGET }));
    expect(pendingOmitted).toMatchObject({ state: 'pending', response: null, body: { omitted: true } });
    expect(pendingCdp.calls).toEqual([]);
    const pending = JSON.parse(await T.netlogRequestStr(pendingCdp, 'SESSION', store, parseNetlogArgs(['--id', '5', '--body', '--format', 'json']), { targetId: TARGET }));
    expect(pending).toMatchObject({ state: 'pending', response: null, body: { available: false, error: 'still loading: No resource with given identifier found' } });
  });

  it('an unknown id is a classified usage error that points back at the list', async () => {
    const { store } = fakeTraffic();
    let error;
    try {
      await T.netlogRequestStr(fakeCdp(), 'SESSION', store, parseNetlogArgs(['--id', '99']), { targetId: TARGET });
    } catch (caught) {
      error = caught;
    }
    expect(error?.message).toMatch(/^netlog: no request #99 in this tab's log/);
    const model = T.buildCliErrorModel(error, { cmd: 'netlog', targetPrefix: TARGET, args: ['--id', '99'] });
    expect(model.recovery).toMatchObject({ kind: 'usage', strategy: 'list-requests', run: `cdp netlog ${TARGET}` });
    expect(T.formatCliError(error, { cmd: 'netlog', targetPrefix: TARGET })).toContain(`Next: cdp netlog ${TARGET}`);
    const usage = T.buildCliErrorModel(new Error('netlog: unknown argument --bogus. Use --id N.'), { cmd: 'netlog', targetPrefix: TARGET });
    expect(usage.recovery).toMatchObject({ kind: 'usage', run: 'cdp help netlog' });
  });
});

describe('#467 detail capture', () => {
  it('the daemon network observer tags buffer entries with the requestId the store numbers', () => {
    const store = createNetlogRequestStore({ shouldTrack: T.shouldTrackActionNetworkRequest });
    const netReqBuf = new T.RingBuffer(100);
    const observer = T.createDaemonNetworkObserver({
      pendingReqs: new Map(), netReqBuf, networkStatusByRequest: T.createEarlyResponseStatusStore(), now: () => 1000,
    });
    const fire = (event, params) => {
      store.handlers[event]?.(params);
      observer[event]?.(params);
    };
    // ExtraInfo first: the observer appends at once with the status only.
    fire('Network.responseReceivedExtraInfo', { requestId: 'o1', statusCode: 503, headersText: 'HTTP/1.1 503 Service Unavailable\r\n', headers: {} });
    fire('Network.requestWillBeSent', { requestId: 'o1', type: 'XHR', request: { method: 'GET', url: 'https://app.example/api/x', headers: {} } });
    fire('Network.responseReceived', { requestId: 'o1', type: 'XHR', response: { status: 503, mimeType: 'application/json', headers: {} } });
    fire('Network.loadingFinished', { requestId: 'o1', encodedDataLength: 77 });
    expect(netReqBuf.all()).toEqual([expect.objectContaining({ requestId: 'o1', status: 503 })]);
    const out = T.netlogStr(netReqBuf, null, { requestStore: store, targetId: TARGET, filters: parseNetlogArgs([]) });
    expect(out).toContain('#1 GET https://app.example/api/x → 503 (0ms, 77B)');
    expect(store.get(1)).toMatchObject({ status: 503, statusText: 'Service Unavailable', mimeType: 'application/json', state: 'complete' });
  });

  it('applies ExtraInfo that arrives before requestWillBeSent and keeps the id across a redirect', () => {
    const store = createNetlogRequestStore({ shouldTrack: T.shouldTrackActionNetworkRequest });
    const fire = (event, params) => store.handlers[event](params);
    fire('Network.requestWillBeSentExtraInfo', { requestId: 'e1', headers: { Cookie: 'a=b', Accept: '*/*' } });
    fire('Network.responseReceivedExtraInfo', { requestId: 'e1', statusCode: 302, headersText: 'HTTP/1.1 302 Found\r\n', headers: { Location: '/login' } });
    fire('Network.requestWillBeSent', { requestId: 'e1', type: 'Fetch', request: { method: 'GET', url: 'https://app.example/a', headers: { Accept: '*/*' } } });
    const detail = store.get(1);
    expect(detail.requestHeaders).toEqual({ Cookie: 'a=b', Accept: '*/*' });
    expect(detail).toMatchObject({ status: 302, statusText: 'Found' });
    fire('Network.requestWillBeSent', {
      requestId: 'e1', type: 'Fetch', redirectResponse: { status: 302 },
      request: { method: 'GET', url: 'https://app.example/login', headers: {} },
    });
    expect(store.idFor('e1')).toBe(1);
    expect(store.get(1)).toMatchObject({ url: 'https://app.example/login', status: null, redirects: [{ status: 302, url: 'https://app.example/a' }] });
  });

  it('bounds stored requests, headers and URLs', () => {
    const store = createNetlogRequestStore({ capacity: 3 });
    const headers = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`x-h${i}`, 'v'.repeat(i === 0 ? 5000 : 1)]));
    for (let i = 0; i < 5; i++) {
      store.handlers['Network.requestWillBeSent']({ requestId: `b${i}`, type: 'XHR', request: { method: 'GET', url: `https://app.example/${'p'.repeat(5000)}`, headers } });
    }
    expect(store.size).toBe(3);
    expect(store.get(1)).toBeNull();
    expect(store.idFor('b0')).toBeNull();
    const detail = store.get(5);
    expect(detail.url.length).toBe(2048);
    expect(detail.urlTruncated).toBe(true);
    expect(Object.keys(detail.requestHeaders)).toHaveLength(64);
    expect(detail.requestHeaders['x-h0']).toHaveLength(1024);
    expect(detail).toMatchObject({ requestHeaderCount: 80, requestHeadersTruncated: true });
  });

  it('redacts JWTs, signatures and OAuth codes in headers without mangling policy or Link headers', () => {
    const out = redactHeaders({
      'X-Custom': 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln',
      'X-Hub-Signature-256': 'sha256=deadbeef',
      'X-Firebase-AppCheck': 'appcheck-token',
      Location: 'https://app.example/cb?code=OAUTHCODE&state=xyz',
      'Content-Location': 'https://app.example/geo?code=US',
      Link: '<https://app.example/p?token=LINKTOK&page=2>; rel="next", <https://app.example/p?page=1>; rel="prev"',
      'Permissions-Policy': 'identity-credentials-get=(), camera=(self)',
      'Content-Security-Policy': "default-src 'self'; report-uri https://r.example/csp?token=CSPTOK",
    });
    expect(out).toEqual({
      'X-Custom': '<redacted>',
      'X-Hub-Signature-256': '<redacted>',
      'X-Firebase-AppCheck': '<redacted>',
      Location: 'https://app.example/cb?code=<redacted>&state=xyz',
      'Content-Location': 'https://app.example/geo?code=US',
      Link: '<https://app.example/p?token=<redacted>&page=2>; rel="next", <https://app.example/p?page=1>; rel="prev"',
      'Permissions-Policy': 'identity-credentials-get=(), camera=(self)',
      'Content-Security-Policy': "default-src 'self'; report-uri https://r.example/csp?token=<redacted>",
    });
  });

  it('keeps early ExtraInfo clipped and drops ExtraInfo for requests it does not track', () => {
    const store = createNetlogRequestStore({ shouldTrack: T.shouldTrackActionNetworkRequest });
    const fire = (event, params) => store.handlers[event](params);
    const many = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`x-h${i}`, 'v'.repeat(3000)]));
    fire('Network.requestWillBeSentExtraInfo', {
      requestId: 'c1', headers: { Cookie: 'sid=RAW', ...many },
      associatedCookies: [{ cookie: { name: 'sid', value: 'RAWCOOKIE' } }],
    });
    fire('Network.responseReceivedExtraInfo', { requestId: 'c1', statusCode: 200, headersText: `HTTP/1.1 200 OK\r\nSet-Cookie: big=${'z'.repeat(5000)}\r\n`, headers: {} });
    expect(store.pendingExtraInfo).toBe(1);
    // An image is not tracked: its early ExtraInfo is purged and later ones are dropped.
    fire('Network.requestWillBeSentExtraInfo', { requestId: 'img', headers: { Cookie: 'sid=IMG' } });
    fire('Network.requestWillBeSent', { requestId: 'img', type: 'Image', request: { method: 'GET', url: 'https://app.example/a.png', headers: {} } });
    fire('Network.responseReceivedExtraInfo', { requestId: 'img', statusCode: 200, headers: { 'Set-Cookie': 'x=IMG' } });
    expect(store.pendingExtraInfo).toBe(1);
    fire('Network.requestWillBeSent', { requestId: 'c1', type: 'Fetch', request: { method: 'GET', url: 'https://app.example/c', headers: {} } });
    expect(store.pendingExtraInfo).toBe(0);
    const detail = store.get(1);
    expect(Object.keys(detail.requestHeaders)).toHaveLength(64);
    expect(detail).toMatchObject({ requestHeaderCount: 81, requestHeadersTruncated: true, status: 200, statusText: 'OK' });
    expect(JSON.stringify(detail)).not.toContain('RAWCOOKIE');
    expect(JSON.stringify(detail)).not.toContain('z'.repeat(1100));
    expect(store.idFor('img')).toBeNull();
  });

  it('classifies sensitive header names with the shared key classifier', () => {
    for (const name of ['Authorization', 'Proxy-Authorization', 'Cookie', 'Set-Cookie', 'X-Auth-Token', 'X-CSRF-Token', 'X-Api-Key', 'X-Amz-Security-Token', 'apikey']) {
      expect(isSensitiveHeaderName(name), name).toBe(true);
    }
    for (const name of ['Content-Type', 'Access-Control-Allow-Credentials', 'Access-Control-Allow-Headers', 'Cache-Control', 'Sec-Fetch-Mode', 'X-Request-Id', 'WWW-Authenticate']) {
      expect(isSensitiveHeaderName(name), name).toBe(false);
    }
  });
});

describe('#467 --out file safety', () => {
  function tempDir() {
    const dir = mkdtempSync(join(tmpdir(), 'cdp-467-'));
    tempDirs.push(dir);
    return dir;
  }

  it('creates the file 0600, refuses an existing file unless --overwrite, and then resets it to 0600', () => {
    const dir = tempDir();
    const path = join(dir, 'body.txt');
    expect(writeNetlogBodyFile(path, Buffer.from('one'), { requestId: 4 })).toEqual({ path, bytes: 3 });
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(() => writeNetlogBodyFile(path, Buffer.from('two'), { requestId: 4 })).toThrow(/request #4: the file already exists; pass --overwrite/);
    expect(readFileSync(path, 'utf8')).toBe('one');
    if (process.platform !== 'win32') chmodSync(path, 0o644);
    writeNetlogBodyFile(path, Buffer.from('two!'), { requestId: 4, overwrite: true });
    expect(readFileSync(path, 'utf8')).toBe('two!');
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('never follows a symlink, needs an absolute path and an existing directory', () => {
    const dir = tempDir();
    const target = join(dir, 'real.txt');
    writeFileSync(target, 'keep');
    const link = join(dir, 'link.txt');
    let linked = true;
    try { symlinkSync(target, link); } catch { linked = false; }
    if (linked) {
      expect(() => writeNetlogBodyFile(link, Buffer.from('x'), { requestId: 2, overwrite: true })).toThrow(/symbolic link; refusing to follow it/);
      expect(readFileSync(target, 'utf8')).toBe('keep');
    }
    expect(() => writeNetlogBodyFile('relative.json', Buffer.from('x'), { requestId: 2 })).toThrow(/must be absolute here/);
    expect(() => writeNetlogBodyFile(join(dir, 'missing', 'x.json'), Buffer.from('x'), { requestId: 2 })).toThrow(/directory does not exist/);
  });

  it('classifies --out failures as usage errors with a runnable next step', () => {
    const recovery = message => T.buildCliErrorModel(new Error(message), { cmd: 'netlog', targetPrefix: TARGET }).recovery;
    expect(recovery('netlog: --out /x/y.json for request #7: the directory does not exist')).toMatchObject({
      kind: 'usage', strategy: 'choose-out-path', run: `cdp netlog ${TARGET} --id 7 --out <new absolute file path>`,
    });
    expect(recovery('netlog: --out /x/y.json for request #7: the file already exists; pass --overwrite or choose a new path')).toMatchObject({ kind: 'usage', strategy: 'choose-out-path' });
    expect(recovery('netlog: --out has no body to save for request #3: Chrome no longer holds it')).toMatchObject({
      kind: 'usage', strategy: 'inspect-request-without-out', run: `cdp netlog ${TARGET} --id 3`,
    });
  });
});

describe('#467 redaction stays linear on hostile text', () => {
  const MB = 1024 * 1024;
  const REAL_JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

  it('still redacts real JWTs, alone, after a separator and inside JSON', () => {
    expect(redactSensitiveString(REAL_JWT)).toBe('<redacted>');
    expect(redactSensitiveString(`token ${REAL_JWT} end`)).toBe('token <redacted> end');
    expect(redactSensitiveString(`x-jwt:${REAL_JWT}`)).toBe('x-jwt:<redacted>');
    expect(redactBodyText(JSON.stringify({ value: REAL_JWT }))).toBe('{"value":"<redacted>"}');
    // Inside a longer base64url run it is not a JWT on its own.
    expect(redactSensitiveString(`abc${REAL_JWT}`)).toBe(`abc${REAL_JWT}`);
  });

  for (const [name, text] of [
    ['eyJ- run', 'eyJ-'.repeat(MB / 4)],
    ['eyJa. run', 'eyJa.'.repeat(MB / 5)],
    ['eyJaaaa.eyJaaaa. run', 'eyJaaaa.eyJaaaa.'.repeat(MB / 16)],
  ]) {
    it(`redactSensitiveString on 1 MB of ${name} is fast`, () => {
      const { ms } = timed(() => redactSensitiveString(text));
      expect(ms).toBeLessThan(200);
    });
  }

  it('a 1 MB hostile body goes through the netlog body redactor quickly (text and JSON string leaf)', () => {
    const hostile = 'eyJ-'.repeat(MB / 4);
    expect(timed(() => redactBodyText(hostile, { mimeType: 'text/plain' })).ms).toBeLessThan(500);
    expect(timed(() => redactBodyText(JSON.stringify({ note: hostile }), { mimeType: 'application/json' })).ms).toBeLessThan(500);
  });

  it('markup and Link patterns are linear on unclosed tags and long attribute names', () => {
    expect(timed(() => redactMarkupSecrets('<input'.repeat(MB / 6))).ms).toBeLessThan(500);
    expect(timed(() => redactMarkupSecrets(`<input ${'a'.repeat(MB)}>`)).ms).toBeLessThan(500);
    expect(timed(() => redactMarkupSecrets(`<x ${'<'.repeat(MB)}`)).ms).toBeLessThan(500);
    expect(timed(() => redactHeaders({ Link: '<'.repeat(MB) })).ms).toBeLessThan(500);
  });
});

describe('#467 JSON behind an anti-hijacking prefix', () => {
  for (const prefix of [")]}'\n", ")]}',\n", 'while(1);', 'for(;;);']) {
    it(`redacts JSON after ${JSON.stringify(prefix)} structurally and keeps the prefix`, () => {
      const out = redactBodyText(`${prefix}{"session":{"id":"XSSI"},"ok":1}`, { mimeType: 'application/json' });
      expect(out).not.toContain('XSSI');
      expect(out.startsWith(prefix)).toBe(true);
      expect(JSON.parse(out.slice(prefix.length))).toEqual({ session: '<redacted>', ok: 1 });
    });
  }
});

describe('#467 CLI and MCP surfaces', () => {
  it('lists --overwrite in the netlog synopsis', async () => {
    const { COMMAND_SURFACE } = await import('../skills/chrome-cdp-ex/scripts/lib/command-surface.mjs');
    expect(COMMAND_SURFACE.resolve('netlog').help.synopsis).toContain('[--out file [--overwrite]]');
  });

  it('resolves a relative --out where the CLI runs', () => {
    expect(T.absolutizeNetlogOutArg(['--id', '3', '--out', 'body.json'], '/work')).toEqual(['--id', '3', '--out', resolve('/work', 'body.json')]);
    expect(T.absolutizeNetlogOutArg(['--status', '5xx'], '/work')).toEqual(['--status', '5xx']);
  });

  it('MCP run_command asks for confirmation before --out and --unsafe-full only', () => {
    expect(argsRequireConfirm('netlog', [TARGET])).toBe(false);
    expect(argsRequireConfirm('netlog', [TARGET, '--id', '3', '--format', 'json'])).toBe(false);
    expect(argsRequireConfirm('netlog', [TARGET, '--id', '3', '--body'])).toBe(false);
    expect(argsRequireConfirm('netlog', [TARGET, '--status', '5xx', '--type', 'fetch'])).toBe(false);
    expect(argsRequireConfirm('netlog', [TARGET, '--id', '3', '--out', '/tmp/x.json'])).toBe(true);
    expect(argsRequireConfirm('netlog', [TARGET, '--id', '3', '--unsafe-full'])).toBe(true);
  });
});
