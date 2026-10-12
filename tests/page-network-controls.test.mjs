import { describe, it, expect, beforeEach } from 'vitest';
import { createMockCDP } from './mock-cdp.mjs';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
const { RingBuffer, dialogStr, netlogStr } = T;

// =========================================================================
// CDP pending command rejection (#144)
// =========================================================================

describe('throttle', () => {
  it('parses presets and custom network profiles into CDP payloads', () => {
    expect(T.parseThrottleArgs(['slow-3g'])).toMatchObject({
      format: 'text',
      profile: 'slow-3g',
      offline: false,
      latencyMs: 400,
      downloadKbps: 400,
      uploadKbps: 400,
      cdpParams: {
        offline: false,
        latency: 400,
        downloadThroughput: 50000,
        uploadThroughput: 50000,
      },
    });
    expect(T.parseThrottleArgs(['custom', '--latency', '120', '--download', '256', '--upload', '128'])).toMatchObject({
      profile: 'custom',
      latencyMs: 120,
      downloadKbps: 256,
      uploadKbps: 128,
      cdpParams: {
        offline: false,
        latency: 120,
        downloadThroughput: 32000,
        uploadThroughput: 16000,
      },
    });
  });

  it('parses off and status modes', () => {
    expect(T.parseThrottleArgs([])).toMatchObject({ mode: 'status', format: 'text' });
    expect(T.parseThrottleArgs(['--format', 'json'])).toMatchObject({ mode: 'status', format: 'json' });
    expect(T.parseThrottleArgs(['off'])).toMatchObject({
      mode: 'apply',
      profile: 'off',
      cdpParams: {
        offline: false,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
      },
    });
  });

  it('rejects unknown profiles and stray preset arguments', () => {
    expect(() => T.parseThrottleArgs(['slow-3g', '--latency', '99'])).toThrow(/does not accept extra arguments/);
    expect(() => T.parseThrottleArgs(['custom', '--download', '256'])).toThrow(/requires --download .* --upload/);
    expect(() => T.parseThrottleArgs(['dialup'])).toThrow(/Unknown throttle profile/);
  });

  it('applies network throttling through CDP and records session state', async () => {
    const cdp = createMockCDP();
    const state = T.createSessionState({ targetId: 'ABC123', sessionId: 'sid-1' });

    const out = await T.throttleStr(cdp, 'sid-1', state, ['slow-3g']);

    expect(cdp.calls.map(c => c.method)).toEqual(['Network.enable', 'Network.emulateNetworkConditions']);
    expect(cdp.calls[1].params).toMatchObject({
      offline: false,
      latency: 400,
      downloadThroughput: 50000,
      uploadThroughput: 50000,
    });
    expect(state.networkThrottle).toMatchObject({ profile: 'slow-3g', latencyMs: 400, downloadKbps: 400, uploadKbps: 400 });
    expect(out).toContain('Network throttle: slow-3g');
    expect(out).toContain('latency 400ms');
    expect(out).toContain('Next: cdp throttle ABC123 off');
  });

  it('reports current throttle state in session reports', async () => {
    const cdp = createMockCDP();
    const state = T.createSessionState({ targetId: 'ABC123', sessionId: 'sid-1' });

    await T.throttleStr(cdp, 'sid-1', state, ['custom', '--latency', '120', '--download', '256', '--upload', '128']);
    const report = T.formatSessionReport(state, { now: state.createdAt + 5000 });

    expect(report).toContain('Network throttle: custom');
    expect(report).toContain('120ms');
    expect(report).toContain('256 kbps down');
    expect(report).toContain('128 kbps up');
  });
});

describe('network mock', () => {
  it('parses status, clear, json, and static response rules', () => {
    expect(T.parseMockArgs([])).toMatchObject({ mode: 'status', format: 'text' });
    expect(T.parseMockArgs(['--format', 'json'])).toMatchObject({ mode: 'status', format: 'json' });
    expect(T.parseMockArgs(['clear'])).toMatchObject({ mode: 'clear', format: 'text' });
    expect(T.parseMockArgs(['clear', '--format', 'json'])).toMatchObject({ mode: 'clear', format: 'json' });
    expect(T.parseMockArgs(['add', '**/api/fail*', '--status', '503', '--body', '{"ok":false}', '--content-type', 'application/json'])).toMatchObject({
      mode: 'add',
      rule: {
        urlPattern: '**/api/fail*',
        status: 503,
        body: '{"ok":false}',
        contentType: 'application/json',
      },
    });
  });

  it('applies a mock through Fetch.enable and records session state', async () => {
    const cdp = createMockCDP();
    const state = T.createSessionState({ targetId: 'ABC123', sessionId: 'sid-1' });

    const out = await T.mockStr(cdp, 'sid-1', state, ['add', '**/api/fail*', '--status', '503', '--body', '{"ok":false}', '--content-type', 'application/json']);

    expect(cdp.calls.map(c => c.method)).toEqual(['Network.setCacheDisabled', 'Fetch.enable']);
    expect(cdp.calls[0].params).toEqual({ cacheDisabled: true });
    expect(cdp.calls[1].params).toMatchObject({
      patterns: [{ urlPattern: '**/api/fail*', requestStage: 'Request' }],
    });
    expect(state.networkMocks).toHaveLength(1);
    expect(state.networkMocks[0]).toMatchObject({ urlPattern: '**/api/fail*', status: 503, contentType: 'application/json' });
    expect(out).toContain('Network mock: 1 rule');
    expect(out).toContain('**/api/fail* -> 503');
    expect(out).toContain('Next: cdp mock ABC123 clear');
  });

  it('fulfills matched requests and continues unmatched requests', async () => {
    const cdp = createMockCDP();
    const state = T.createSessionState({ targetId: 'ABC123', sessionId: 'sid-1' });
    await T.mockStr(cdp, 'sid-1', state, ['add', '**/api/fail*', '--status', '503', '--body', '{"ok":false}', '--content-type', 'application/json']);

    await T.handleMockRequestPaused(cdp, 'sid-1', state, {
      requestId: 'match-1',
      request: { method: 'GET', url: 'https://example.com/api/fail?id=1' },
    });
    await T.handleMockRequestPaused(cdp, 'sid-1', state, {
      requestId: 'miss-1',
      request: { method: 'GET', url: 'https://example.com/api/ok' },
    });

    expect(cdp.calls.map(c => c.method)).toEqual([
      'Network.setCacheDisabled',
      'Fetch.enable',
      'Fetch.fulfillRequest',
      'Fetch.continueRequest',
    ]);
    expect(cdp.calls[2].params).toMatchObject({
      requestId: 'match-1',
      responseCode: 503,
      responseHeaders: [{ name: 'content-type', value: 'application/json' }],
    });
    expect(Buffer.from(cdp.calls[2].params.body, 'base64').toString('utf8')).toBe('{"ok":false}');
    expect(cdp.calls[3].params).toEqual({ requestId: 'miss-1' });
    expect(state.networkMockHits).toHaveLength(1);
    expect(state.networkMockHits[0]).toMatchObject({ url: 'https://example.com/api/fail?id=1', status: 503 });
  });

  it('clears mocks through Fetch.disable and reports in session reports', async () => {
    const cdp = createMockCDP();
    const state = T.createSessionState({ targetId: 'ABC123', sessionId: 'sid-1' });

    await T.mockStr(cdp, 'sid-1', state, ['add', '**/api/fail*', '--status', '503', '--body', 'down']);
    const report = T.formatSessionReport(state, { now: state.createdAt + 5000 });
    expect(report).toContain('Network mocks: 1 rule');
    expect(report).toContain('**/api/fail* -> 503');

    const out = await T.mockStr(cdp, 'sid-1', state, ['clear']);

    expect(cdp.calls.map(c => c.method)).toEqual([
      'Network.setCacheDisabled',
      'Fetch.enable',
      'Fetch.disable',
      'Network.setCacheDisabled',
    ]);
    expect(cdp.calls.at(-1).params).toEqual({ cacheDisabled: false });
    expect(state.networkMocks).toEqual([]);
    expect(out).toContain('Network mock: off');
  });
});

describe('clock', () => {
  it('parses status, freeze, offset, and reset modes', () => {
    expect(T.parseClockArgs([])).toMatchObject({ mode: 'status', format: 'text' });
    expect(T.parseClockArgs(['--format', 'json'])).toMatchObject({ mode: 'status', format: 'json' });
    expect(T.parseClockArgs(['freeze', '--at', '2020-01-02T03:04:05.000Z'])).toMatchObject({
      mode: 'apply',
      profile: 'freeze',
      atMs: 1577934245000,
    });
    expect(T.parseClockArgs(['offset', '--ms', '3600000'])).toMatchObject({
      mode: 'apply',
      profile: 'offset',
      offsetMs: 3600000,
    });
    expect(T.parseClockArgs(['reset'])).toMatchObject({ mode: 'reset', profile: 'real' });
  });

  it('rejects invalid clock arguments', () => {
    expect(() => T.parseClockArgs(['freeze'])).toThrow(/requires --at/);
    expect(() => T.parseClockArgs(['freeze', '--at', 'not-a-date'])).toThrow(/valid date/);
    expect(() => T.parseClockArgs(['offset', '--ms', 'nan'])).toThrow(/finite millisecond/);
    expect(() => T.parseClockArgs(['dial'])).toThrow(/Unknown clock command/);
  });

  it('installs a frozen clock for current and future page contexts', async () => {
    const cdp = createMockCDP({
      'Page.addScriptToEvaluateOnNewDocument': () => ({ identifier: 'clock-script-1' }),
      'Runtime.evaluate': () => ({ result: { value: { ok: true } } }),
    });
    const state = T.createSessionState({ targetId: 'ABC123', sessionId: 'sid-1' });

    const out = await T.clockStr(cdp, 'sid-1', state, ['freeze', '--at', '2020-01-02T03:04:05.000Z']);

    expect(cdp.calls.map(c => c.method)).toEqual(['Page.addScriptToEvaluateOnNewDocument', 'Runtime.evaluate']);
    expect(cdp.calls[0].params.source).toContain('__cdpClockOriginals');
    expect(cdp.calls[0].params.source).toContain('1577934245000');
    expect(cdp.calls[1].params.expression).toContain('__cdpClockOriginals');
    expect(state.clock).toMatchObject({ profile: 'freeze', atMs: 1577934245000, scriptIdentifier: 'clock-script-1' });
    expect(out).toContain('Clock: frozen at 2020-01-02T03:04:05.000Z');
    expect(out).toContain('Next: cdp clock ABC123 reset');
  });

  it('installs an offset clock and reports it in session reports', async () => {
    const cdp = createMockCDP({
      'Page.addScriptToEvaluateOnNewDocument': () => ({ identifier: 'clock-script-2' }),
      'Runtime.evaluate': () => ({ result: { value: { ok: true } } }),
    });
    const state = T.createSessionState({ targetId: 'ABC123', sessionId: 'sid-1' });

    await T.clockStr(cdp, 'sid-1', state, ['offset', '--ms', '3600000']);
    const report = T.formatSessionReport(state, { now: state.createdAt + 5000 });

    expect(state.clock).toMatchObject({ profile: 'offset', offsetMs: 3600000 });
    expect(report).toContain('Clock: offset +3600000ms');
  });

  it('resets the installed clock script and restores real time', async () => {
    const cdp = createMockCDP({
      'Page.addScriptToEvaluateOnNewDocument': () => ({ identifier: 'clock-script-1' }),
      'Runtime.evaluate': () => ({ result: { value: { ok: true } } }),
    });
    const state = T.createSessionState({ targetId: 'ABC123', sessionId: 'sid-1' });
    await T.clockStr(cdp, 'sid-1', state, ['freeze', '--at', '2020-01-02T03:04:05.000Z']);

    const out = await T.clockStr(cdp, 'sid-1', state, ['reset']);

    expect(cdp.calls.map(c => c.method)).toEqual([
      'Page.addScriptToEvaluateOnNewDocument',
      'Runtime.evaluate',
      'Page.removeScriptToEvaluateOnNewDocument',
      'Runtime.evaluate',
    ]);
    expect(cdp.calls[2].params).toEqual({ identifier: 'clock-script-1' });
    expect(state.clock).toBe(null);
    expect(out).toContain('Clock: real time');
  });
});

// =========================================================================
// dialogStr
// =========================================================================

describe('dialogStr', () => {
  let dialogBuf, ref;
  beforeEach(() => {
    dialogBuf = new RingBuffer(20);
    ref = { value: true };
  });

  it('should report no dialogs when empty', () => {
    const result = dialogStr(dialogBuf, ref);
    expect(result).toMatch(/No dialogs recorded/);
    expect(result).toMatch(/Auto-accept: ON/);
  });

  it('should set auto-accept ON', () => {
    ref.value = false;
    const result = dialogStr(dialogBuf, ref, 'accept');
    expect(ref.value).toBe(true);
    expect(result).toMatch(/auto-accept: ON/i);
  });

  it('should set auto-accept OFF with dismiss', () => {
    const result = dialogStr(dialogBuf, ref, 'dismiss');
    expect(ref.value).toBe(false);
    expect(result).toMatch(/auto-accept: OFF/);
  });

  it('should throw on unknown flag', () => {
    expect(() => dialogStr(dialogBuf, ref, 'banana')).toThrow(/Unknown dialog flag.*banana/);
  });

  it('should list dialog entries', () => {
    dialogBuf.push({ type: 'alert', message: 'Hello!', ts: Date.now() });
    dialogBuf.push({ type: 'confirm', message: 'Sure?', ts: Date.now() });
    const result = dialogStr(dialogBuf, ref);
    expect(result).toMatch(/Dialogs \(2/);
    expect(result).toMatch(/\[alert\] "Hello!"/);
    expect(result).toMatch(/\[confirm\] "Sure\?"/);
  });
});

// =========================================================================
// netlogStr
// =========================================================================

describe('netlogStr', () => {
  let netBuf;
  beforeEach(() => { netBuf = new RingBuffer(100); });

  it('should report empty when no requests', () => {
    expect(netlogStr(netBuf)).toMatch(/No network requests/);
  });

  it('should clear buffer with --clear', () => {
    netBuf.push({ method: 'GET', url: 'https://x.com', status: 200, duration: 10, size: 100, ts: Date.now() });
    expect(netlogStr(netBuf, '--clear')).toBe('Network log cleared');
    expect(netBuf.all()).toHaveLength(0);
  });

  it('should format entries with method, url, status, duration', () => {
    netBuf.push({ method: 'POST', url: 'https://api.example.com/data', status: 201, duration: 42, size: 2048, ts: Date.now() });
    const result = netlogStr(netBuf);
    expect(result).toMatch(/Network requests \(1\)/);
    expect(result).toContain('POST');
    expect(result).toContain('https://api.example.com/data');
    expect(result).toContain('201');
    expect(result).toContain('42ms');
    expect(result).toContain('2.0KB');
  });

  it('should show bytes for small sizes', () => {
    netBuf.push({ method: 'GET', url: 'https://x.com', status: 200, duration: 5, size: 512, ts: Date.now() });
    expect(netlogStr(netBuf)).toContain('512B');
  });
});

// =========================================================================
// CDP mock helper — lightweight fake for testing command functions
// =========================================================================

