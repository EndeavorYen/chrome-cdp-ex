import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
const { argsRequireConfirm } = await import('../skills/chrome-cdp-ex/scripts/lib/mcp-adapter.mjs');

// #634: the secrets.html matrix. Receipts, netlog, and report already mask these.
const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature';
const PAGE_URL = 'https://app.example.test/secrets.html?token=SECRET_URL_TOKEN_123&user=alice';
const MASKED_PAGE_URL = 'https://app.example.test/secrets.html?token=<redacted>&user=alice';
const CONSOLE_LOG = `calling /api/me with Authorization: Bearer ${JWT}`;
const CONSOLE_ERR = 'refresh failed for https://api.example.test/v1/session?access_token=SECRET_ACCESS_777&user=alice';
const SESSION_COOKIE = 'SECRET_SESSION_8f3k2q9';
const SECRETS = [JWT, 'SECRET_URL_TOKEN_123', 'SECRET_ACCESS_777', SESSION_COOKIE];

function expectMasked(text) {
  const printed = String(text);
  for (const secret of SECRETS) expect(printed, secret).not.toContain(secret);
  expect(printed).not.toContain('eyJ');
}

function expectKeptContext(text) {
  expect(text).toContain('user=alice');
}

function pageCdp(evaluate) {
  return {
    send(method, params = {}) {
      if (method === 'Runtime.evaluate') return Promise.resolve({ result: { value: evaluate(String(params.expression || '')) } });
      if (method === 'Accessibility.getFullAXTree') {
        return Promise.resolve({
          nodes: [{ nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Account' }, childIds: [] }],
        });
      }
      if (method === 'Network.getCookies') {
        return Promise.resolve({
          cookies: [
            {
              name: 'sid',
              value: SESSION_COOKIE,
              domain: 'app.example.test',
              path: '/',
              secure: true,
              httpOnly: true,
              sameSite: 'Lax',
              expires: -1,
            },
            {
              name: 'theme',
              value: 'dark',
              domain: 'app.example.test',
              path: '/',
              secure: false,
              httpOnly: false,
              sameSite: 'Lax',
              expires: -1,
            },
            {
              name: 'auth_jwt',
              value: JWT,
              domain: 'app.example.test',
              path: '/',
              secure: true,
              httpOnly: false,
              sameSite: 'Lax',
              expires: -1,
            },
          ],
        });
      }
      return Promise.resolve({});
    },
  };
}

function consoleBuffers() {
  const consoleBuf = new T.RingBuffer(20);
  const exceptionBuf = new T.RingBuffer(20);
  consoleBuf.push({ level: 'log', text: CONSOLE_LOG, loc: '', frames: [], ts: 1 });
  exceptionBuf.push({ msg: CONSOLE_ERR, loc: '', frames: [], ts: 2 });
  return { consoleBuf, exceptionBuf, lastReadSeq: { console: 0, exception: 0, nav: 0 } };
}

const pages = [{
  targetId: 'ABCDEF0123456789',
  title: 'Account',
  url: PAGE_URL,
  type: 'page',
}];

describe('#634 secret output is masked by default', () => {
  it('masks token query params in list text and JSON', () => {
    const text = T.formatPageList(pages);
    const model = T.buildPageListModel(pages);
    expect(text).toContain(MASKED_PAGE_URL);
    expect(model.pages[0].url).toBe(MASKED_PAGE_URL);
    expect(model.recommended.url).toBe(MASKED_PAGE_URL);
    expectMasked(text);
    expectMasked(JSON.stringify(model));
    expectKeptContext(text);
    expect(T.formatPageList(pages, null, { unsafeFull: true })).toContain('SECRET_URL_TOKEN_123');
    expect(T.buildPageListModel(pages, null, { unsafeFull: true }).pages[0].url).toBe(PAGE_URL);
    expect(T.parseListArgs(['--unsafe-full', '--format', 'json'])).toEqual({ format: 'json', unsafeFull: true, unknown: null });
    expect(T.parseListArgs(['--format', 'text'])).toEqual({ format: 'text', unsafeFull: false, unknown: null });
  });

  it('masks bearer JWTs and token query params in console text and JSON', async () => {
    const { consoleBuf, exceptionBuf, lastReadSeq } = consoleBuffers();
    const text = await T.consoleStr(consoleBuf, exceptionBuf, lastReadSeq, '--all');
    expect(text).toContain('Authorization: <redacted>');
    expect(text).toContain('access_token=<redacted>');
    expectKeptContext(text);
    expectMasked(text);

    const fresh = consoleBuffers();
    const model = T.buildConsoleModel(fresh.consoleBuf, fresh.exceptionBuf, fresh.lastReadSeq, '--all');
    const json = JSON.stringify(model);
    expect(json).toContain('access_token=<redacted>');
    expectMasked(json);
    expectKeptContext(json);

    const raw = consoleBuffers();
    const unsafe = await T.consoleStr(raw.consoleBuf, raw.exceptionBuf, raw.lastReadSeq, '--all', { unsafeFull: true });
    expect(unsafe).toContain(JWT);
    expect(unsafe).toContain('SECRET_ACCESS_777');
    expect(T.parseConsoleArgs(['--all', '--unsafe-full'])).toMatchObject({ mode: 'all', format: 'text', unsafeFull: true });
  });

  it('masks the page URL and console excerpts in status text and JSON', async () => {
    const cdp = pageCdp(() => JSON.stringify({ title: 'Account', url: PAGE_URL, contentType: 'text/html' }));
    const bufs = consoleBuffers();
    const navBuf = new T.RingBuffer(10);
    navBuf.push({ url: PAGE_URL, ts: 1 });
    const text = await T.statusStr(cdp, 'sid', bufs.consoleBuf, bufs.exceptionBuf, navBuf, bufs.lastReadSeq);
    expect(text).toContain(`URL: ${MASKED_PAGE_URL}`);
    expect(text).toContain('access_token=<redacted>');
    expect(text).toContain('Authorization: <redacted>');
    expectKeptContext(text);
    expectMasked(text);

    const again = consoleBuffers();
    const model = T.buildStatusModel({
      targetId: 'ABCDEF0123456789',
      page: { title: 'Account', url: PAGE_URL },
      consoleBuf: again.consoleBuf,
      exceptionBuf: again.exceptionBuf,
      navBuf,
      lastReadSeq: { console: 0, exception: 0, nav: 0 },
    });
    expect(model.page.url).toBe(MASKED_PAGE_URL);
    expect(model.navigation[0].url).toBe(MASKED_PAGE_URL);
    expectMasked(JSON.stringify(model));
    expectKeptContext(JSON.stringify(model));

    const open = T.buildStatusModel({
      targetId: 'ABCDEF0123456789',
      page: { title: 'Account', url: PAGE_URL },
      consoleBuf: new T.RingBuffer(4),
      exceptionBuf: new T.RingBuffer(4),
      navBuf: new T.RingBuffer(4),
      lastReadSeq: { console: 0, exception: 0, nav: 0 },
      unsafeFull: true,
    });
    expect(open.page.url).toBe(PAGE_URL);
  });

  it('masks the page URL in summary text and JSON', async () => {
    const cdp = pageCdp(() => JSON.stringify({
      title: 'Account',
      url: PAGE_URL,
      contentType: 'text/html',
      viewport: '800x600',
      scrollY: 0,
      scrollMax: 0,
      counts: {},
      domNodes: 2,
      tableRows: 0,
      visibleControls: 0,
      hiddenTemplateNodes: 0,
      focused: 'none',
    }));
    const model = await T.summaryModel(cdp, 'sid', new T.RingBuffer(4), new T.RingBuffer(4));
    expect(model.page.url).toBe(MASKED_PAGE_URL);
    expectMasked(T.formatSummaryText(model));
    expectKeptContext(T.formatSummaryText(model));
    const open = await T.summaryModel(cdp, 'sid', new T.RingBuffer(4), new T.RingBuffer(4), { unsafeFull: true });
    expect(open.page.url).toBe(PAGE_URL);
  });

  it('masks the page URL in the perceive header and PDF handoff', async () => {
    const cdp = pageCdp(() => JSON.stringify({
      title: 'Account',
      url: PAGE_URL,
      contentType: 'text/html',
      vw: 800,
      vh: 600,
      scrollY: 0,
      scrollMax: 0,
      counts: {},
      focused: 'none',
      layoutMap: {},
      styleHints: {},
      cursorInteractives: [],
      visibleControls: [],
    }));
    const text = await T.perceiveStr(cdp, 'sid', new T.RingBuffer(4), new T.RingBuffer(4), new Map(), {}, {});
    expect(text.startsWith(`Page: Account — ${MASKED_PAGE_URL}`)).toBe(true);
    expectMasked(text);
    expectKeptContext(text);
    const model = T.perceptionModelFromText(text);
    expect(model.page.url).toBe(MASKED_PAGE_URL);

    const open = await T.perceiveStr(cdp, 'sid', new T.RingBuffer(4), new T.RingBuffer(4), new Map(), {}, { unsafeFull: true });
    expect(open.startsWith(`Page: Account — ${PAGE_URL}`)).toBe(true);
    expect(T.parsePerceiveArgs(['--unsafe-full']).unsafeFull).toBe(true);

    const pdf = T.formatPdfViewerOutput({ title: 'Account', url: PAGE_URL, contentType: 'application/pdf' });
    expect(pdf).toContain(`URL: ${MASKED_PAGE_URL}`);
    expectMasked(pdf);
  });

  it('masks every cookie value and the checkpoint URL', async () => {
    const cdp = pageCdp(() => JSON.stringify({
      url: PAGE_URL,
      title: 'Account',
      origin: 'https://app.example.test',
      localStorage: { theme: 'dark' },
      sessionStorage: {},
    }));
    const cookies = await T.cookiesStr(cdp, 'sid');
    expect(cookies).toContain('sid');
    expect(cookies).toContain('HttpOnly');
    expect(cookies).toContain('auth_jwt');
    expect(cookies).toContain('theme');
    expect(cookies).toContain('<redacted>');
    expect(cookies).not.toContain('dark');
    expectMasked(cookies);
    const openCookies = await T.cookiesStr(cdp, 'sid', { unsafeFull: true });
    expect(openCookies).toContain(SESSION_COOKIE);
    expect(openCookies).toContain(JWT);
    expect(openCookies).toContain('dark');
    expect(() => T.parseCookieArgs(['--nope'])).toThrow(/cookies: unknown argument --nope/);

    const text = await T.checkpointStr(cdp, 'sid', { now: 1 });
    expect(text).toContain(`URL: ${MASKED_PAGE_URL}`);
    expect(text).toContain('Privacy: default-redacted');
    expectMasked(text);
    expectKeptContext(text);
    const model = await T.checkpointModel(cdp, 'sid', { now: 1 });
    expect(model.page.url).toBe(MASKED_PAGE_URL);
    expect(model.cookies.every(cookie => cookie.value === '<redacted>')).toBe(true);
    const raw = await T.checkpointModel(cdp, 'sid', { now: 1, unsafeFullCapture: true });
    expect(raw.page.url).toBe(PAGE_URL);
    expect(raw.cookies.find(cookie => cookie.name === 'sid').value).toBe(SESSION_COOKIE);
  });

  it('asks for confirmation before --unsafe-full on console, status, list, and summary', () => {
    expect(argsRequireConfirm('console', ['--unsafe-full'])).toBe(true);
    expect(argsRequireConfirm('console', ['--all'])).toBe(false);
    expect(argsRequireConfirm('status', ['T', '--unsafe-full'])).toBe(true);
    expect(argsRequireConfirm('status', ['T'])).toBe(false);
    expect(argsRequireConfirm('list', ['--unsafe-full'])).toBe(true);
    expect(argsRequireConfirm('list', [])).toBe(false);
    expect(argsRequireConfirm('summary', ['T', '--unsafe-full'])).toBe(true);
    expect(argsRequireConfirm('perceive', ['T', '--unsafe-full'])).toBe(true);
    expect(argsRequireConfirm('cookies', ['T'])).toBe(true);
  });
});

describe('#634 receipts, netlog, and report stay on the same mask', () => {
  it('masks the page token the same way as list', () => {
    const buf = new T.RingBuffer(10);
    buf.push({ method: 'GET', url: PAGE_URL, status: 200, duration: 3, size: 10, ts: 1, type: 'Document' });
    const net = T.netlogStr(buf);
    expect(net).toContain('token=<redacted>');
    expect(net).not.toContain('SECRET_URL_TOKEN_123');
    expectKeptContext(net);
    expect(T.netlogStr(buf, null, { unsafeFull: true })).toContain('SECRET_URL_TOKEN_123');

    const result = T.applyActionObservationDelta(T.createActionResult({
      action: 'click',
      target: { input: '#go', resolvedBy: 'selector', label: '#go' },
      dispatch: { ok: true, method: 'mouse' },
      settle: { ok: true, durationMs: 4 },
      effects: {
        domDiff: `Navigated https://app.example.test/ -> ${PAGE_URL}`,
        navigation: { from: 'https://app.example.test/', to: PAGE_URL },
      },
      nextHint: null,
    }), {
      console: { count: 1, errors: 0, warnings: 0, entries: [{ level: 'log', text: CONSOLE_LOG }] },
      exceptions: { count: 1, entries: [{ message: CONSOLE_ERR }] },
      network: {
        count: 1,
        failures: 0,
        pending: 0,
        entries: [{ method: 'GET', url: PAGE_URL, status: 200, duration: 9 }],
      },
    });
    const receipt = T.formatActionResultOutput(result, { format: 'text', full: true });
    const receiptJson = T.formatActionResultOutput(result, { format: 'json' });
    for (const out of [receipt, receiptJson]) {
      expect(out).toContain('token=<redacted>');
      expect(out).not.toContain(JWT);
      expect(out).not.toContain('SECRET_URL_TOKEN_123');
      expect(out).not.toContain('SECRET_ACCESS_777');
    }
    expectKeptContext(receipt);

    const logPath = join(tmpdir(), `cdp-634-${Date.now()}-${Math.random().toString(16).slice(2)}.log`);
    const state = T.createSessionState({ targetId: 'ABCDEF01', sessionId: 'sid-634', logPath });
    try {
      T.initializeSessionLog(state);
      T.appendSessionActionLog(state, result, { ts: Date.parse('2026-10-09T00:00:00.000Z') });
      const report = T.formatSessionReport(state, { page: { url: PAGE_URL, title: 'Account' } });
      expect(report).toContain('token=<redacted>');
      expect(report).not.toContain('SECRET_URL_TOKEN_123');
      expectKeptContext(report);
    } finally {
      rmSync(logPath, { force: true });
    }
  });
});
