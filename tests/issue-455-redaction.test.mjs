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
    for (const key of [...Object.keys(SECRETS), 'X-Amz-Credential', 'X-Amz-Security-Token', 'apiKey', 'API-KEY',
      'apikey', 'password', 'user[password]', 'jsessionid', 'PHPSESSID', 'csrfToken', 'sig', 'key', 'private_key', 'secretkey', 'AWSAccessKeyId', 'mytoken']) {
      expect(isSensitiveKey(key), key).toBe(true);
    }
  });

  it('does not redact words that merely contain a keyword', () => {
    for (const key of [...Object.keys(SAFE), 'passage', 'tokenizer', 'sidebar', 'author', 'accessibility',
      'keyboard', 'monkey', 'signup', 'design', 'pinboard', 'cardholder_name', 'sort_key', '']) {
      expect(isSensitiveKey(key), key).toBe(false);
    }
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
    const text = `GET /p?sidebar=open#access_token=FRAG8 pinned=1 cardinality=3 X-Amz-Signature=SIG9 author: Ann`;
    const out = redactSensitiveString(text);
    expect(out).not.toContain('FRAG8');
    expect(out).not.toContain('SIG9');
    expect(out).toContain('sidebar=open');
    expect(out).toContain('pinned=1');
    expect(out).toContain('cardinality=3');
    expect(out).toContain('author: Ann');
    expect(redactSensitiveString('https://bob:hunter2@host.test/')).not.toContain('hunter2');
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
    expect(T.parseNetlogArgs([])).toEqual({ clear: false, unsafeFull: false });
    expect(T.parseNetlogArgs(['--unsafe-full'])).toEqual({ clear: false, unsafeFull: true });
    expect(T.parseNetlogArgs(['--clear'])).toEqual({ clear: true, unsafeFull: false });
    expect(() => T.parseNetlogArgs(['--bogus'])).toThrow(/netlog/);
  });

  it('MCP run_command asks for confirmation before netlog --unsafe-full', () => {
    expect(argsRequireConfirm('netlog', [])).toBe(false);
    expect(argsRequireConfirm('netlog', ['--unsafe-full'])).toBe(true);
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
