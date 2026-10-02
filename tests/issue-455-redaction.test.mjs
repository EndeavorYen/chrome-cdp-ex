import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
const { isSensitiveKey, redactUrl, redactSensitiveString, REDACTED_VALUE } = await import('../skills/chrome-cdp-ex/scripts/lib/redaction.mjs');
const { argsRequireConfirm } = await import('../skills/chrome-cdp-ex/scripts/lib/mcp-adapter.mjs');

// #455: one key classifier decides what is secret. Every fixture key below
// carried its value verbatim into receipts, netlog, report, or the session log.
const SECRETS = {
  access_token: 'sentinel-access-1',
  refresh_token: 'sentinel-refresh-2',
  id_token: 'sentinel-idtok-3',
  client_secret: 'sentinel-client-4',
  session_id: 'sentinel-session-5',
  accessToken: 'sentinel-camel-6',
  api_key: 'sentinel-apikey-7',
  'X-Amz-Signature': 'sentinel-amzsig-8',
};
const SAFE = { page: '2', q: 'shoes', sort: 'asc', pinned: '1', cardinality: '3' };
const SECRET_VALUES = Object.values(SECRETS);
const query = [...Object.entries(SECRETS), ...Object.entries(SAFE)].map(([k, v]) => `${k}=${v}`).join('&');
const SECRET_URL = `https://app.example.test/oauth/callback?${query}`;

function expectNoSecrets(text) {
  for (const value of SECRET_VALUES) expect(text).not.toContain(value);
}

function expectSafeParamsKept(text) {
  for (const [key, value] of Object.entries(SAFE)) expect(text).toContain(`${key}=${value}`);
}

function navigationAction() {
  return T.applyActionObservationDelta(T.createActionResult({
    action: 'click',
    target: { input: '#login', resolvedBy: 'selector', label: '#login' },
    dispatch: { ok: true, method: 'mouse' },
    settle: { ok: true, durationMs: 12 },
    effects: {
      domDiff: `Navigated https://app.example.test/login -> ${SECRET_URL}`,
      navigation: { from: 'https://app.example.test/login', to: SECRET_URL },
    },
    nextHint: null,
  }), {
    console: { count: 0, errors: 0, warnings: 0, entries: [] },
    exceptions: { count: 0, entries: [] },
    network: {
      count: 1,
      failures: 1,
      pending: 0,
      entries: [{ method: 'GET', url: SECRET_URL, status: 401, duration: 9 }],
    },
  });
}

describe('#455 key classifier', () => {
  it('treats snake, kebab and camelCase secret keys as sensitive', () => {
    const urlOnly = new Set(['X-Amz-Signature']);
    for (const key of [...Object.keys(SECRETS).filter(key => !urlOnly.has(key)), 'X-Amz-Credential', 'X-Amz-Security-Token',
      'apiKey', 'API-KEY', 'apikey', 'password', 'user[password]', 'jsessionid', 'PHPSESSID', 'csrfToken',
      'private_key', 'secretkey', 'AWSAccessKeyId', 'mytoken', 'token', 'access%5Ftoken']) {
      expect(isSensitiveKey(key), key).toBe(true);
      expect(isSensitiveKey(key, { urlQuery: true }), key).toBe(true);
    }
  });

  it('treats key, sig and *Signature as secrets only as URL query keys', () => {
    for (const key of ['X-Amz-Signature', 'X-Goog-Signature', 'sig', 'key', 'Signature']) {
      expect(isSensitiveKey(key, { urlQuery: true }), key).toBe(true);
      expect(isSensitiveKey(key), key).toBe(false);
    }
  });

  it('does not redact words that merely contain a keyword', () => {
    for (const key of [...Object.keys(SAFE), 'passage', 'tokenizer', 'sidebar', 'author', 'accessibility',
      'keyboard', 'monkey', 'signup', 'design', 'pinboard', 'cardholder_name', 'sort_key', '']) {
      expect(isSensitiveKey(key), key).toBe(false);
      expect(isSensitiveKey(key, { urlQuery: true }), key).toBe(false);
    }
  });

  it('does not redact token used as a quantity', () => {
    for (const key of ['tokens', 'maxTokens', 'max_tokens', 'max_token', 'maxtoken', 'tokenCount', 'token_limit',
      'totalTokens', 'designTokens']) {
      expect(isSensitiveKey(key), key).toBe(false);
    }
    expect(T.redactSensitiveArtifactValue({ maxTokens: 512, tokens: { color: 'red' }, signature: 'sig-x' }))
      .toEqual({ maxTokens: 512, tokens: { color: 'red' }, signature: 'sig-x' });
  });
});

describe('#455 URL redaction', () => {
  it('redacts every secret query value and keeps safe params verbatim', () => {
    const out = redactUrl(SECRET_URL);
    expectNoSecrets(out);
    expectSafeParamsKept(out);
    expect(out).toContain(`access_token=${REDACTED_VALUE}`);
    expect(out).toContain(`X-Amz-Signature=${REDACTED_VALUE}`);
    expect(out.startsWith('https://app.example.test/oauth/callback?')).toBe(true);
  });

  it('redacts fragment tokens, userinfo passwords and path session params', () => {
    const out = redactUrl('https://bob:hunter2@host.test/a;jsessionid=JSID99/b?ok=1#access_token=FRAG7&token_type=Bearer&state=xyz');
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('JSID99');
    expect(out).not.toContain('FRAG7');
    expect(out).toContain('state=xyz');
    expect(out).toContain('ok=1');
    expect(redactUrl('https://host.test/#/route?token=HASHQ&tab=2')).toBe(`https://host.test/#/route?token=${REDACTED_VALUE}&tab=2`);
  });

  it('leaves URLs without secrets byte-identical', () => {
    for (const url of ['https://x.test/', 'https://x.test/p?page=2&q=a%20b#section', 'about:blank', '/relative?sort=asc', '']) {
      expect(redactUrl(url)).toBe(url);
    }
  });

  it('free-text redaction shares the classifier and stops over-matching', () => {
    const text = `GET /p?sidebar=open#access_token=FRAG8 pinned=1 cardinality=3 /s3?a=1&X-Amz-Signature=SIG9 author: Ann`;
    const out = redactSensitiveString(text);
    expect(out).not.toContain('FRAG8');
    expect(out).not.toContain('SIG9');
    expect(out).toContain('sidebar=open');
    expect(out).toContain('pinned=1');
    expect(out).toContain('cardinality=3');
    expect(out).toContain('author: Ann');
    expect(redactSensitiveString('https://bob:hunter2@host.test/')).not.toContain('hunter2');
  });

  it('free text keeps prose keys, quantities and URL-only keys readable', () => {
    for (const text of ['Sort key: name', 'key=enter', 'maxTokens: 512', 'tokens: 3', 'signature: Ann Lee', 'sig=1 here']) {
      expect(redactSensitiveString(text), text).toBe(text);
    }
    expect(redactSensitiveString('GET /maps?key=AIzaSECRET&z=3')).toBe(`GET /maps?key=${REDACTED_VALUE}&z=3`);
  });

  it('free text redacts %-encoded keys, whole quoted values and JSON-shaped pairs', () => {
    expect(redactSensitiveString('/cb?access%5Ftoken=PCT1&x=1')).toBe(`/cb?access%5Ftoken=${REDACTED_VALUE}&x=1`);
    expect(redactSensitiveString('token = "a b c" done')).toBe(`token = "${REDACTED_VALUE}" done`);
    expect(redactSensitiveString('body {"access_token":"JSON1","page":2}')).toBe(`body {"access_token":"${REDACTED_VALUE}","page":2}`);
  });

  it('never rewrites CSS selectors whose id or class is a keyword', () => {
    for (const selector of ['#pin:checked', '#card:nth-child(2)', '#password:focus', '#session:hover',
      '.token:hover', 'input.password:focus', 'form #pin:checked > label', 'a#token:not(.x)']) {
      expect(redactSensitiveString(selector), selector).toBe(selector);
      expect(redactSensitiveString(`Target: ${selector}`), selector).toBe(`Target: ${selector}`);
    }
    expect(redactSensitiveString('password: hunter2')).toBe(`password: ${REDACTED_VALUE}`);
    expect(redactSensitiveString('#access_token=FRAG')).toBe(`#access_token=${REDACTED_VALUE}`);
  });
});

describe('#455 selectors survive the session log and replay artifacts', () => {
  it('keeps #pin:checked / #card:nth-child(2) in log commandArgs, record-actions and export-playwright', () => {
    const logPath = join(tmpdir(), `cdp-455-sel-${Date.now()}-${Math.random().toString(16).slice(2)}.log`);
    const state = T.createSessionState({ targetId: 'ABC455', sessionId: 'sid-455', logPath });
    const selectors = ['#pin:checked', '#card:nth-child(2)', '#password:focus', '#session:hover'];
    try {
      T.initializeSessionLog(state);
      for (const [index, selector] of selectors.entries()) {
        const result = T.createActionResult({
          action: 'click',
          target: { input: selector, resolvedBy: 'selector', label: selector, commandArgs: [selector] },
          dispatch: { ok: true, method: 'mouse' },
          settle: { ok: true, durationMs: 5 },
          effects: { domDiff: '', console: [], network: [], navigation: null },
          nextHint: null,
        });
        expect(T.formatActionResultOutput(result, { format: 'text', full: true })).toContain(`Target: ${selector}`);
        expect(JSON.parse(T.formatActionResultOutput(result, { format: 'json' })).target.input).toBe(selector);
        T.appendSessionActionLog(state, result, { ts: Date.parse('2026-10-02T00:00:00.000Z') + index });
      }
      const log = readFileSync(logPath, 'utf8');
      const records = JSON.parse(T.formatRecordActions(state, { format: 'json' }));
      const playwright = T.formatExportPlaywright(state);
      for (const selector of selectors) {
        expect(log).toContain(JSON.stringify(selector));
        expect(playwright).toContain(selector);
      }
      expect(records.actions.map(action => action.command)).toEqual(selectors.map(selector => ['click', selector]));
      expect(log).not.toContain(REDACTED_VALUE);
    } finally {
      rmSync(logPath, { force: true });
    }
  });
});

describe('#455 surfaces redact URLs by default', () => {
  it('action JSON (full and compact) carries no secret', () => {
    const result = navigationAction();
    const full = T.formatActionResultOutput(result, { format: 'json' });
    const compact = T.formatActionResultOutput(result, { format: 'json', compact: true });
    for (const out of [full, compact]) expectNoSecrets(out);
  });

  it('effects.network urls are compacted through the shared redactor', () => {
    const buf = new T.RingBuffer(10);
    buf.push({ method: 'GET', url: SECRET_URL, status: 200, duration: 1, size: 1, ts: Date.now(), type: 'XHR' });
    const delta = T.buildActionObservationDelta({ netReqBuf: buf }, { network: 0 });
    const url = delta.network.entries[0].url;
    expect(url.startsWith('/oauth/callback?access_token=<redacted>&refresh_token=<redacted>')).toBe(true);
    expectNoSecrets(url);
  });

  it('text receipts carry no secret, including the navigation outcome reason', () => {
    const result = navigationAction();
    for (const out of [
      T.formatActionResultOutput(result, { format: 'text' }),
      T.formatActionResultOutput(result, { format: 'text', full: true }),
      T.formatActionResultOutput(result, { format: 'text', qa: true }),
      T.formatActionText(result),
    ]) {
      expectNoSecrets(out);
    }
    expect(T.formatActionResultOutput(result, { format: 'text', full: true })).toContain('pinned=1');
  });

  it('netlog redacts by default and only --unsafe-full prints raw URLs', () => {
    const buf = new T.RingBuffer(10);
    buf.push({ method: 'GET', url: SECRET_URL, status: 200, duration: 3, size: 10, ts: Date.now() });
    const redacted = T.netlogStr(buf);
    expectNoSecrets(redacted);
    expectSafeParamsKept(redacted);
    const raw = T.netlogStr(buf, null, { unsafeFull: true });
    for (const value of SECRET_VALUES) expect(raw).toContain(value);
    expect(raw).toMatch(/unsafe-full/);
    expect(T.parseNetlogArgs([])).toMatchObject({ clear: false, unsafeFull: false });
    expect(T.parseNetlogArgs(['--unsafe-full'])).toMatchObject({ clear: false, unsafeFull: true });
    expect(T.parseNetlogArgs(['--clear'])).toMatchObject({ clear: true, unsafeFull: false });
    expect(() => T.parseNetlogArgs(['--bogus'])).toThrow(/netlog/);
  });

  it('MCP run_command asks for confirmation before netlog --unsafe-full', () => {
    expect(argsRequireConfirm('netlog', [])).toBe(false);
    expect(argsRequireConfirm('netlog', ['--unsafe-full'])).toBe(true);
    expect(argsRequireConfirm('netlog', ['--clear'])).toBe(true);
    expect(argsRequireConfirm('netlog', ['ABC455', '--clear', '--unsafe-full'])).toBe(true);
    expect(argsRequireConfirm('netlog', ['ABC455', '--unsafe-full', '--clear'])).toBe(true);
  });

  it('net (resource timing) redacts before it truncates', async () => {
    const entries = [
      // Shape returned by the in-page performance.getEntriesByType('resource') mapper.
      { name: SECRET_URL, type: 'fetch', duration: 4, size: 99 },
      { name: `https://cdn.test/${'p'.repeat(100)}?access_token=LATE_SECRET`, type: 'img', duration: 1, size: 0 },
    ];
    const cdp = { send: async method => (method === 'Runtime.evaluate' ? { result: { value: JSON.stringify(entries) } } : {}) };
    const out = await T.netStr(cdp, 'sid');
    expectNoSecrets(out);
    expect(out).not.toContain('LATE_SECRET');
    expect(out).toContain('callback?access_token=<redacted>&refresh_token=<redacted>');
  });

  it('mock hits (text Last hit and JSON recentHits) are redacted', async () => {
    const calls = [];
    const cdp = { send: async (method, params) => { calls.push({ method, params }); return {}; } };
    const state = T.createSessionState({ targetId: 'ABC455', sessionId: 'sid-455' });
    await T.mockStr(cdp, 'sid-455', state, ['add', '**/oauth/*', '--status', '200']);
    await T.handleMockRequestPaused(cdp, 'sid-455', state, { requestId: 'r1', request: { method: 'GET', url: SECRET_URL } });
    const model = T.buildMockModel(state, { mode: 'status' });
    expectNoSecrets(JSON.stringify(model));
    expectNoSecrets(T.formatMockText(model));
    expect(T.formatMockText(model)).toContain('Last hit: GET https://app.example.test/oauth/callback?access_token=<redacted>');
  });

  it('checkpoint session events log a redacted URL', () => {
    expect(T.checkpointSessionEvent(`Checkpoint saved\nURL: ${SECRET_URL}\nCookies: 2`))
      .toEqual({ kind: 'checkpoint', url: redactUrl(SECRET_URL) });
    expectNoSecrets(JSON.stringify(T.checkpointSessionEvent(`URL: ${SECRET_URL}`)));
    expect(T.checkpointSessionEvent('{"schema":"x"}')).toEqual({ kind: 'checkpoint', url: undefined });
  });

  it('session log JSONL and report text/JSON carry no secret', () => {
    const logPath = join(tmpdir(), `cdp-455-${Date.now()}-${Math.random().toString(16).slice(2)}.log`);
    const state = T.createSessionState({ targetId: 'ABC455', sessionId: 'sid-455', logPath });
    try {
      T.initializeSessionLog(state);
      T.appendSessionActionLog(state, navigationAction(), { ts: Date.parse('2026-10-02T00:00:00.000Z') });
      const page = { url: SECRET_URL, title: 'Callback' };
      const artifacts = [
        readFileSync(logPath, 'utf8'),
        T.formatSessionReport(state),
        T.formatSessionReport(state, { format: 'json' }),
        T.formatSessionReport(state, { qa: true, page }),
        T.formatSessionReport(state, { qa: true, page, format: 'json' }),
      ];
      for (const artifact of artifacts) expectNoSecrets(artifact);
    } finally {
      rmSync(logPath, { force: true });
    }
  });
});
