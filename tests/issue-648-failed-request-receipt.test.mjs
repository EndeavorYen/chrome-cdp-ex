import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
const { createNetlogRequestStore, parseNetlogArgs } = await import('../skills/chrome-cdp-ex/scripts/lib/netlog.mjs');
const { buildActionRecoveryPlan } = await import('../skills/chrome-cdp-ex/scripts/lib/action-recovery.mjs');

// #648: a save that fails is named on the action receipt (status, Retry-After, a short
// redacted body). Chrome sends no loadingFinished for a `Cache-Control: no-store` response the
// page never reads, and Network.getResponseBody then has no data; Network.streamResourceContent
// still returns the bytes Chrome received.

const TARGET = 'ABCDEF1234567890ABCDEF1234567890';
const PREFIX = 'ABCDEF12';
const BODY = '{"error":"upstream timeout","retryAfterSeconds":2}';

// One no-store 503 the page never read (no loadingFinished), one network error, one 200.
function traffic() {
  const store = createNetlogRequestStore({ shouldTrack: T.shouldTrackActionNetworkRequest, now: () => 1_000_000 });
  const buf = new T.RingBuffer(100);
  const fire = (event, params) => store.handlers[event](params);
  fire('Network.requestWillBeSent', { requestId: 'r1', type: 'Fetch', request: { method: 'POST', url: 'https://app.example/api/profile?token=tok-123', headers: {} } });
  fire('Network.responseReceived', {
    requestId: 'r1', type: 'Fetch',
    response: { status: 503, statusText: 'Service Unavailable', mimeType: 'application/json', headers: { 'cache-control': 'no-store', 'Retry-After': '2' } },
  });
  buf.push({ requestId: 'r1', method: 'POST', url: 'https://app.example/api/profile?token=tok-123', type: 'Fetch', status: 503, duration: 7, size: 0, ts: 1 });
  fire('Network.requestWillBeSent', { requestId: 'r2', type: 'XHR', request: { method: 'GET', url: 'https://app.example/api/me', headers: {} } });
  fire('Network.loadingFailed', { requestId: 'r2', type: 'XHR', errorText: 'net::ERR_CONNECTION_REFUSED' });
  buf.push({ requestId: 'r2', method: 'GET', url: 'https://app.example/api/me', type: 'XHR', status: null, failed: true, errorText: 'net::ERR_CONNECTION_REFUSED', duration: 2, size: 0, ts: 2 });
  fire('Network.requestWillBeSent', { requestId: 'r3', type: 'Fetch', request: { method: 'GET', url: 'https://app.example/api/ok', headers: {} } });
  fire('Network.responseReceived', { requestId: 'r3', type: 'Fetch', response: { status: 200, statusText: 'OK', mimeType: 'application/json', headers: {} } });
  fire('Network.loadingFinished', { requestId: 'r3', encodedDataLength: 40 });
  buf.push({ requestId: 'r3', method: 'GET', url: 'https://app.example/api/ok', type: 'Fetch', status: 200, duration: 3, size: 40, ts: 3 });
  return { store, buf };
}

// getResponseBody has no data for unread no-store bodies; streamResourceContent returns `buffered`.
function fakeCdp({ bodies = {}, buffered = {} } = {}) {
  const calls = [];
  return {
    calls,
    send(method, params) {
      calls.push(method);
      if (method === 'Network.getResponseBody') {
        return bodies[params.requestId]
          ? Promise.resolve(bodies[params.requestId])
          : Promise.reject(new Error('No data found for resource with given identifier'));
      }
      if (method === 'Network.streamResourceContent') {
        return buffered[params.requestId]
          ? Promise.resolve({ bufferedData: Buffer.from(buffered[params.requestId]).toString('base64') })
          : Promise.reject(new Error('No resource with given identifier found'));
      }
      return Promise.resolve({});
    },
  };
}

describe('#648 unread no-store bodies', () => {
  it('reads a body the page never read from Chrome\'s buffer, and says so', async () => {
    const { store } = traffic();
    const cdp = fakeCdp({ buffered: { r1: BODY } });
    const text = await T.netlogRequestStr(cdp, 'SESSION', store, parseNetlogArgs(['--id', '1', '--body']), { targetId: TARGET });
    expect(cdp.calls).toEqual(['Network.getResponseBody', 'Network.streamResourceContent']);
    expect(text).toContain('Body (50 bytes, not read by the page):');
    expect(text).toContain(BODY);
    expect(text).not.toContain('still loading');
    const model = JSON.parse(await T.netlogRequestStr(fakeCdp({ buffered: { r1: BODY } }), 'SESSION', store, parseNetlogArgs(['--id', '1', '--body', '--format', 'json']), { targetId: TARGET }));
    expect(model.body).toMatchObject({ available: true, unread: true, text: BODY });
  });

  it('does not call the buffer for a request with no response yet or one that finished', async () => {
    const { store } = traffic();
    store.handlers['Network.requestWillBeSent']({ requestId: 'r4', type: 'Fetch', request: { method: 'GET', url: 'https://app.example/slow', headers: {} } });
    const cdp = fakeCdp({ buffered: { r4: 'partial' } });
    const pending = JSON.parse(await T.netlogRequestStr(cdp, 'SESSION', store, parseNetlogArgs(['--id', '4', '--body', '--format', 'json']), { targetId: TARGET }));
    expect(pending.body).toMatchObject({ available: false, error: 'still loading: No data found for resource with given identifier' });
    const finished = JSON.parse(await T.netlogRequestStr(cdp, 'SESSION', store, parseNetlogArgs(['--id', '3', '--body', '--format', 'json']), { targetId: TARGET }));
    expect(finished.body.error).toMatch(/^Chrome no longer holds it/);
    expect(cdp.calls).not.toContain('Network.streamResourceContent');
  });

  it('names a finished-looking response whose body Chrome no longer has, without "still loading"', async () => {
    const { store } = traffic();
    const model = JSON.parse(await T.netlogRequestStr(fakeCdp(), 'SESSION', store, parseNetlogArgs(['--id', '1', '--body', '--format', 'json']), { targetId: TARGET }));
    expect(model.body.available).toBe(false);
    expect(model.body.error).toMatch(/^the response arrived but its body never finished loading, and Chrome holds no copy/);
  });

  it('lists such a response as "body not finished", not 0B', () => {
    const { store, buf } = traffic();
    const text = T.netlogStr(buf, null, { requestStore: store, targetId: TARGET });
    expect(text).toMatch(/#1 POST \S+ → 503 \(7ms, body not finished\)/);
    expect(text).toMatch(/#3 GET \S+ → 200 \(3ms, 40B\)/);
    const model = JSON.parse(T.netlogStr(buf, null, { requestStore: store, targetId: TARGET, format: 'json' }));
    expect(model.requests.find(request => request.id === 1)).toMatchObject({ status: 503, bodyFinished: false });
    expect(model.requests.find(request => request.id === 3).bodyFinished).toBeUndefined();
  });
});

describe('#648 failed requests on the action receipt', () => {
  const readBodyWith = cdp => detail => T.readNetlogResponseBody(cdp, 'SESSION', detail);

  it('describes failed requests with status text, Retry-After and a redacted body, newest last', async () => {
    const { store, buf } = traffic();
    const failed = await T.describeFailedActionRequests(buf.all(), { store, readBody: readBodyWith(fakeCdp({ buffered: { r1: BODY } })) });
    expect(failed).toEqual([
      {
        id: 1, method: 'POST', url: 'https://app.example/api/profile?token=<redacted>', status: 503, statusText: 'Service Unavailable',
        retryAfter: '2', errorText: null, body: { text: BODY, truncated: false },
      },
      {
        id: 2, method: 'GET', url: 'https://app.example/api/me', status: null, statusText: null,
        retryAfter: null, errorText: 'net::ERR_CONNECTION_REFUSED', body: null,
      },
    ]);
    expect(T.formatFailedRequestLine(failed[0])).toBe(`Request failed: #1 POST https://app.example/api/profile?token=<redacted> → 503 Service Unavailable; Retry-After: 2; body: ${BODY}`);
    expect(T.formatFailedRequestLine(failed[1])).toBe('Request failed: #2 GET https://app.example/api/me → failed (net::ERR_CONNECTION_REFUSED)');
  });

  it('caps the body at 200 chars, flattens whitespace and masks secrets', async () => {
    const { store, buf } = traffic();
    const long = JSON.stringify({ error: 'bad', access_token: 'body-secret-999', detail: 'x'.repeat(400) }, null, 2);
    const [item] = await T.describeFailedActionRequests(buf.all().slice(0, 1), { store, readBody: readBodyWith(fakeCdp({ bodies: { r1: { body: long, base64Encoded: false } } })) });
    expect(item.body.text.length).toBeLessThanOrEqual(200);
    expect(item.body.truncated).toBe(true);
    expect(item.body.text).not.toContain('\n');
    expect(item.body.text).not.toContain('body-secret-999');
    expect(T.formatFailedRequestLine(item)).toMatch(/; body: \{.* …$/);
  });

  it('keeps the line when the body cannot be read, and points Next at that request', async () => {
    const { store, buf } = traffic();
    const failed = await T.describeFailedActionRequests(buf.all().slice(0, 1), { store, readBody: readBodyWith(fakeCdp()) });
    expect(failed[0].body).toBeNull();
    expect(T.formatFailedRequestLine(failed[0])).toBe('Request failed: #1 POST https://app.example/api/profile?token=<redacted> → 503 Service Unavailable; Retry-After: 2');
    expect(T.failedRequestNextCommand(failed, PREFIX)).toBe(`cdp netlog ${PREFIX} --id 1 --body`);
  });

  it('points Next at the page once every failed request is explained', () => {
    expect(T.failedRequestNextCommand(undefined, PREFIX)).toBe(`cdp netlog ${PREFIX}`);
    expect(T.failedRequestNextCommand([{ id: 1, body: { text: BODY } }, { id: 2, errorText: 'net::ERR_FAILED' }], PREFIX))
      .toBe(`cdp perceive ${PREFIX} --since-action`);
  });

  it('puts the lines before Next so Next stays last', () => {
    expect(T.insertBeforeNextLine('Clicked <BUTTON> "Save". Next: cdp perceive X --since-action', ['Request failed: a', 'Request failed: b']))
      .toBe('Clicked <BUTTON> "Save".\nRequest failed: a\nRequest failed: b\nNext: cdp perceive X --since-action');
    expect(T.insertBeforeNextLine('Done\nNext: cdp list', ['Request failed: a'])).toBe('Done\nRequest failed: a\nNext: cdp list');
    expect(T.insertBeforeNextLine('Done', ['Request failed: a'])).toBe('Done\nRequest failed: a');
    expect(T.insertBeforeNextLine('Done. Next: cdp list', [])).toBe('Done. Next: cdp list');
  });

  it('the default click receipt names the failed request and Next agrees with the JSON plan', async () => {
    const delta = {
      console: { count: 0, errors: 0, warnings: 0, entries: [] },
      exceptions: { count: 0, entries: [] },
      network: { count: 1, failures: 1, entries: [{ method: 'POST', url: 'https://app.example/api/profile', status: 503, duration: 7 }] },
    };
    let captured = null;
    const text = await T.runActionWithFeedback({
      action: 'click',
      target: { targetId: TARGET, input: '#save', resolvedBy: 'selector', label: 'Save changes' },
      dispatch: async () => 'Clicked <BUTTON> "Save changes"',
      feedbackPolicy: 'settle-diff',
      observe: async () => 'toast changed',
      enrichActionResult: (result) => {
        T.applyActionObservationDelta(result, delta);
        result.effects.failedRequests = [{
          id: 1, method: 'POST', url: 'https://app.example/api/profile', status: 503, statusText: 'Service Unavailable',
          retryAfter: '2', errorText: null, body: { text: BODY, truncated: false },
        }];
      },
      onActionResult: (result) => { captured = result; },
    });
    expect(text).toBe([
      'Clicked <BUTTON> "Save changes".',
      `Request failed: #1 POST https://app.example/api/profile → 503 Service Unavailable; Retry-After: 2; body: ${BODY}`,
      `Next: cdp perceive ${PREFIX} --since-action`,
    ].join('\n'));
    expect(captured.effects.diagnosis).toMatchObject({ kind: 'network-failure', nextCommand: `cdp perceive ${PREFIX} --since-action` });
    expect(captured.effects.diagnosis.recovery.commands[0].command).toBe(`cdp perceive ${PREFIX} --since-action`);
  });

  it('keeps the old receipt when no failed request was described', async () => {
    const plan = buildActionRecoveryPlan({ status: 'attention', kind: 'network-failure' }, { targetId: PREFIX });
    expect(plan.commands.map(entry => entry.command)).toEqual([
      `cdp netlog ${PREFIX}`, `cdp perceive ${PREFIX} --since-action`, `cdp report ${PREFIX} --format json`,
    ]);
  });
});
