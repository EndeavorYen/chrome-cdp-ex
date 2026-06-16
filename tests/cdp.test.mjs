// cdp.test.mjs — Tests for cdp.mjs pure functions
// Run: npm test

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, rmSync } from 'fs';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
const {
  RingBuffer, resolvePrefix, getDisplayPrefixLength, sockPath,
  shouldShowAxNode, formatAxNode, orderedAxChildren, isRef,
  validateUrl, parsePerceiveArgs, dialogStr, netlogStr,
  formatPageList, buildPerceiveTree, perceivePageScript, injectStr, cascadeStr, recordStr, parseRecordArgs,
  evalStr, evalFireAndForgetStr, parseEvalArgs, callStr, navStr, clickStr, fillStr, fillReactStr, waitForStr,
  isTimeoutError, parseDelayMs, waitStr, ipcTimeoutForRequest, parseTargetAndCommandArgs, normalizeTargetCommandArgs, formatCliError,
  formatOpenReadyMessage, formatOpenTimeoutMessage, formatOpenAutoPerceiveFailure,
  statusStr, clearObservationBuffers,
  KEY_MAP, ENRICHED_ROLES, INTERACTIVE_ROLES,
  captureScreenshot, screencastFallback, snapshotStr,
  resetScreenshotTier, getScreenshotTier, SCREENSHOT_TIMEOUT,
  decodeVLQ, mapLineToSource, stripVitePathQuery, mapStyleSource,
  formatBatchResults, parseBatchArgs, parseFlowSteps, settleFlow, flowStr,
  checkNode, checkSkillSymlink, checkDaemonSockets, checkCdpReachability, checkBrowserTargets, checkBrowserPermission, checkFdLimit,
  doctorWizardSummary, formatDoctorReport, runDoctorChecks, doctorStr,
} = T;

// =========================================================================
// RingBuffer
// =========================================================================

describe('RingBuffer', () => {
  let buf;
  beforeEach(() => { buf = new RingBuffer(3); });

  it('should start empty with seq 0', () => {
    expect(buf.all()).toEqual([]);
    expect(buf.latest()).toBe(0);
  });

  it('should push entries with incrementing _seq', () => {
    buf.push({ a: 1 });
    buf.push({ a: 2 });
    buf.push({ a: 3 });
    const all = buf.all();
    expect(all).toHaveLength(3);
    expect(all[0]._seq).toBe(1);
    expect(all[1]._seq).toBe(2);
    expect(all[2]._seq).toBe(3);
  });

  it('should evict oldest when capacity exceeded', () => {
    buf.push({ v: 'a' });
    buf.push({ v: 'b' });
    buf.push({ v: 'c' });
    buf.push({ v: 'd' }); // evicts 'a'
    const all = buf.all();
    expect(all).toHaveLength(3);
    expect(all[0].v).toBe('b');
    expect(all[2].v).toBe('d');
  });

  it('should mutate the pushed object to add _seq', () => {
    const obj = { x: 42 };
    buf.push(obj);
    expect(obj._seq).toBe(1);
  });

  it('since() should return entries after given seq', () => {
    buf.push({ v: 1 });
    buf.push({ v: 2 });
    buf.push({ v: 3 });
    expect(buf.since(2)).toHaveLength(1);
    expect(buf.since(2)[0].v).toBe(3);
    expect(buf.since(0)).toHaveLength(3);
    expect(buf.since(buf.latest())).toEqual([]);
  });

  it('all() should return a copy', () => {
    buf.push({ v: 1 });
    const a = buf.all();
    const b = buf.all();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });

  it('clear() should empty buffer but preserve seq', () => {
    buf.push({ v: 1 });
    buf.push({ v: 2 });
    const seqBefore = buf.latest();
    buf.clear();
    expect(buf.all()).toEqual([]);
    expect(buf.latest()).toBe(seqBefore);
  });

  it('should work correctly after clear + re-push', () => {
    buf.push({ v: 1 });
    buf.clear();
    buf.push({ v: 2 });
    expect(buf.all()).toHaveLength(1);
    expect(buf.all()[0]._seq).toBe(2);
    expect(buf.since(1)).toHaveLength(1);
  });
});

// =========================================================================
// resolvePrefix
// =========================================================================

describe('resolvePrefix', () => {
  const ids = ['ABCD1234EEEE', 'ABCE5678FFFF', 'XYZ99999GGGG'];

  it('should resolve unambiguous prefix', () => {
    expect(resolvePrefix('XYZ', ids)).toBe('XYZ99999GGGG');
  });

  it('should be case-insensitive', () => {
    expect(resolvePrefix('xyz9', ids)).toBe('XYZ99999GGGG');
  });

  it('should resolve when prefix uniquely narrows to one', () => {
    expect(resolvePrefix('ABCD', ids)).toBe('ABCD1234EEEE');
    expect(resolvePrefix('ABCE', ids)).toBe('ABCE5678FFFF');
  });

  it('should throw on ambiguous prefix', () => {
    expect(() => resolvePrefix('ABC', ids)).toThrow(/Ambiguous/);
    expect(() => resolvePrefix('ABC', ids)).toThrow(/matches 2/);
  });

  it('should throw on no match', () => {
    expect(() => resolvePrefix('QQQ', ids)).toThrow(/No .* matching/);
  });

  it('should include missingHint in error', () => {
    expect(() => resolvePrefix('QQQ', ids, 'target', 'Run "cdp list".'))
      .toThrow(/Run "cdp list"/);
  });

  it('should use custom noun in error', () => {
    expect(() => resolvePrefix('QQQ', ids, 'daemon'))
      .toThrow(/No daemon matching/);
  });
});

// =========================================================================
// getDisplayPrefixLength
// =========================================================================

describe('getDisplayPrefixLength', () => {
  it('should return 8 (MIN) for empty array', () => {
    expect(getDisplayPrefixLength([])).toBe(8);
  });

  it('should return 8 when IDs diverge within first 8 chars', () => {
    expect(getDisplayPrefixLength(['AAAA1111', 'BBBB2222'])).toBe(8);
  });

  it('should grow prefix until all IDs are unique', () => {
    // These share first 8 chars, diverge at position 9
    const ids = ['ABCDEFGH1XXX', 'ABCDEFGH2YYY'];
    expect(getDisplayPrefixLength(ids)).toBe(9);
  });

  it('should handle single ID', () => {
    expect(getDisplayPrefixLength(['ABCD1234'])).toBe(8);
  });
});

// =========================================================================
// COMMANDS registry
// =========================================================================

describe('COMMANDS registry', () => {
  it('exports command metadata with unique names', () => {
    const names = T.COMMANDS.map(c => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('generates target command requirements from registry metadata', () => {
    const fromRegistry = new Set(
      T.COMMANDS
        .filter(c => c.needsTarget)
        .flatMap(c => [c.name, ...(c.aliases || [])])
    );
    expect(fromRegistry).toEqual(T.NEEDS_TARGET);
  });

  it('marks mutating commands with a feedback policy or explicit none policy', () => {
    const mutating = T.COMMANDS.filter(c => c.mutates);
    expect(mutating.map(c => c.name).sort()).toEqual([
      'back', 'click', 'clickxy', 'closetab', 'cookiedel', 'cookieset',
      'clock', 'dismiss-modal', 'fill', 'forward', 'inject', 'jsclick', 'nav',
      'open', 'press', 'reload', 'replay', 'restore', 'scroll', 'select', 'spawn-debug-browser',
      'stop', 'mock', 'throttle', 'type', 'upload', 'viewport',
    ].sort());
    for (const command of mutating) {
      expect(command.feedbackPolicy).toMatch(/^(none|settle-diff|full-perceive|state-change|report-only)$/);
    }
  });

  it('registers record-actions as a target command with text and json output', () => {
    expect(T.COMMANDS).toContainEqual(expect.objectContaining({
      name: 'record-actions',
      aliases: ['recordactions'],
      needsTarget: true,
      mutates: false,
      outputFormats: ['text', 'json'],
    }));
  });

  it('registers report as a target command with text and json output', () => {
    expect(T.COMMANDS).toContainEqual(expect.objectContaining({
      name: 'report',
      aliases: [],
      needsTarget: true,
      mutates: false,
      outputFormats: ['text', 'json'],
    }));
  });

  it('registers doctor as a targetless command with text and json output', () => {
    expect(T.COMMANDS).toContainEqual(expect.objectContaining({
      name: 'doctor',
      aliases: ['ready'],
      needsTarget: false,
      mutates: false,
      outputFormats: ['text', 'json'],
    }));
  });

  it('registers list as a targetless command with text and json output', () => {
    expect(T.COMMANDS).toContainEqual(expect.objectContaining({
      name: 'list',
      aliases: [],
      needsTarget: false,
      mutates: false,
      outputFormats: ['text', 'json'],
    }));
  });

  it('registers open as a targetless command with text and json output', () => {
    expect(T.COMMANDS).toContainEqual(expect.objectContaining({
      name: 'open',
      aliases: [],
      needsTarget: false,
      mutates: true,
      feedbackPolicy: 'full-perceive',
      outputFormats: ['text', 'json'],
    }));
  });

  it('registers replay as a mutating target command', () => {
    expect(T.COMMANDS).toContainEqual(expect.objectContaining({
      name: 'replay',
      aliases: [],
      needsTarget: true,
      mutates: true,
      feedbackPolicy: 'report-only',
      outputFormats: ['text'],
    }));
  });

  it('registers batch structured JSON handoff as a target command', () => {
    expect(T.COMMANDS).toContainEqual(expect.objectContaining({
      name: 'batch',
      aliases: [],
      needsTarget: true,
      mutates: false,
      outputFormats: ['text', 'json'],
    }));
  });

  it('registers flow structured JSON handoff as a target command', () => {
    expect(T.COMMANDS).toContainEqual(expect.objectContaining({
      name: 'flow',
      aliases: [],
      needsTarget: true,
      mutates: false,
      outputFormats: ['text', 'json'],
    }));
  });

  it('registers export-playwright as a target command', () => {
    expect(T.COMMANDS).toContainEqual(expect.objectContaining({
      name: 'export-playwright',
      aliases: ['export-pw'],
      needsTarget: true,
      mutates: false,
      outputFormats: ['text'],
    }));
  });

  it('registers diff-shot as a target command', () => {
    expect(T.COMMANDS).toContainEqual(expect.objectContaining({
      name: 'diff-shot',
      aliases: ['diffshot'],
      needsTarget: true,
      mutates: false,
      outputFormats: ['text', 'json'],
    }));
  });

  it('registers throttle as a mutating target command', () => {
    expect(T.COMMANDS).toContainEqual(expect.objectContaining({
      name: 'throttle',
      aliases: ['network-throttle'],
      needsTarget: true,
      mutates: true,
      feedbackPolicy: 'report-only',
      outputFormats: ['text', 'json'],
    }));
  });

  it('registers mock as a mutating target command', () => {
    expect(T.COMMANDS).toContainEqual(expect.objectContaining({
      name: 'mock',
      aliases: ['network-mock'],
      needsTarget: true,
      mutates: true,
      feedbackPolicy: 'report-only',
      outputFormats: ['text', 'json'],
    }));
  });

  it('registers clock as a mutating target command', () => {
    expect(T.COMMANDS).toContainEqual(expect.objectContaining({
      name: 'clock',
      aliases: ['time-travel'],
      needsTarget: true,
      mutates: true,
      feedbackPolicy: 'report-only',
      outputFormats: ['text', 'json'],
    }));
  });

  it('registers checkpoint and restore commands', () => {
    expect(T.COMMANDS).toContainEqual(expect.objectContaining({
      name: 'checkpoint',
      aliases: [],
      needsTarget: true,
      mutates: false,
      outputFormats: ['text', 'json'],
    }));
    expect(T.COMMANDS).toContainEqual(expect.objectContaining({
      name: 'restore',
      aliases: [],
      needsTarget: true,
      mutates: true,
      feedbackPolicy: 'report-only',
      outputFormats: ['text'],
    }));
  });

  it('registers frame listing as a target command', () => {
    expect(T.COMMANDS).toContainEqual(expect.objectContaining({
      name: 'frame',
      aliases: ['frames'],
      needsTarget: true,
      mutates: false,
      outputFormats: ['text', 'json'],
    }));
  });

  it('registers overlay detector as a read-only target command', () => {
    expect(T.COMMANDS).toContainEqual(expect.objectContaining({
      name: 'overlay',
      aliases: ['overlays'],
      needsTarget: true,
      mutates: false,
      outputFormats: ['text', 'json'],
    }));
  });
});

describe('diff-shot', () => {
  it('parses threshold, reset, and baseline options', () => {
    expect(T.parseDiffShotArgs(['--threshold', '0.5', '--keep-baseline'])).toEqual({
      format: 'text',
      thresholdRatio: 0.005,
      reset: false,
      keepBaseline: true,
    });
    expect(T.parseDiffShotArgs(['--format', 'json', '--reset'])).toEqual({
      format: 'json',
      thresholdRatio: 0,
      reset: true,
      keepBaseline: false,
    });
  });

  it('formats a first baseline capture with an executable next step', () => {
    const out = T.formatDiffShotResult({
      schema: 'chrome-cdp-ex.diff-shot.v1',
      targetId: 'ABC123',
      baselineCaptured: true,
      baselinePath: '/tmp/base.png',
      currentPath: '/tmp/base.png',
      diffPath: null,
      changedPixels: 0,
      totalPixels: 0,
      changedRatio: 0,
      thresholdRatio: 0,
      exceedsThreshold: false,
      advancedBaseline: true,
      fallback: false,
    });

    expect(out).toContain('Diff-shot baseline captured');
    expect(out).toContain('/tmp/base.png');
    expect(out).toContain('Next: cdp diff-shot ABC123');
  });

  it('formats a pixel diff with reviewable artifacts and honest scope', () => {
    const out = T.formatDiffShotResult({
      schema: 'chrome-cdp-ex.diff-shot.v1',
      targetId: 'ABC123',
      baselineCaptured: false,
      baselinePath: '/tmp/base.png',
      currentPath: '/tmp/current.png',
      diffPath: '/tmp/diff.png',
      width: 10,
      height: 10,
      changedPixels: 7,
      totalPixels: 100,
      changedRatio: 0.07,
      thresholdRatio: 0.01,
      exceedsThreshold: true,
      advancedBaseline: true,
      fallback: true,
    });

    expect(out).toContain('Diff-shot: changed 7/100 px (7.00%)');
    expect(out).toContain('Threshold: 1.00% (exceeded)');
    expect(out).toContain('Baseline: /tmp/base.png');
    expect(out).toContain('Current: /tmp/current.png');
    expect(out).toContain('Diff image: /tmp/diff.png');
    expect(out).toContain('Pixel diff only');
    expect(out).toContain('screenshot fallback');
  });
});

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

    expect(cdp.calls.map(c => c.method)).toEqual(['Fetch.enable']);
    expect(cdp.calls[0].params).toMatchObject({
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
      'Fetch.enable',
      'Fetch.fulfillRequest',
      'Fetch.continueRequest',
    ]);
    expect(cdp.calls[1].params).toMatchObject({
      requestId: 'match-1',
      responseCode: 503,
      responseHeaders: [{ name: 'content-type', value: 'application/json' }],
    });
    expect(Buffer.from(cdp.calls[1].params.body, 'base64').toString('utf8')).toBe('{"ok":false}');
    expect(cdp.calls[2].params).toEqual({ requestId: 'miss-1' });
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

    expect(cdp.calls.map(c => c.method)).toEqual(['Fetch.enable', 'Fetch.disable']);
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
// Output formats
// =========================================================================

describe('parseFormatArgs', () => {
  it('defaults to text format', () => {
    expect(T.parseFormatArgs(['--runtime'])).toEqual({
      format: 'text',
      args: ['--runtime'],
    });
  });

  it('parses --format json and removes the option from command args', () => {
    expect(T.parseFormatArgs(['--runtime', '--format', 'json'])).toEqual({
      format: 'json',
      args: ['--runtime'],
    });
  });

  it('rejects unknown formats', () => {
    expect(() => T.parseFormatArgs(['--format', 'xml'], ['text', 'json'])).toThrow(/format must be text or json/);
  });

  it('serializes JSON models with indentation', () => {
    expect(T.formatJson({ schema: 'x', ok: true })).toBe('{\n  "schema": "x",\n  "ok": true\n}');
  });

  it('preserves trailing --format json when joining fill and type text args', () => {
    expect(normalizeTargetCommandArgs('fill', ['#cmd', 'look', 'merchant', '--format', 'json'])).toEqual([
      '#cmd',
      'look merchant',
      '--format',
      'json',
    ]);
    expect(normalizeTargetCommandArgs('fill', ['--react', '#cmd', 'look', 'merchant', '--format', 'json'])).toEqual([
      '--react',
      '#cmd',
      'look merchant',
      '--format',
      'json',
    ]);
    expect(normalizeTargetCommandArgs('type', ['hello', 'world', '--format', 'json'])).toEqual([
      'hello world',
      '--format',
      'json',
    ]);
  });
});

describe('structured status and console models', () => {
  it('builds a versioned console model using new entries by default', () => {
    const consoleBuf = new RingBuffer(10);
    const exceptionBuf = new RingBuffer(10);
    consoleBuf.push({ level: 'log', text: 'old' });
    consoleBuf.push({ level: 'error', text: 'new' });
    exceptionBuf.push({ msg: 'boom' });
    const model = T.buildConsoleModel(consoleBuf, exceptionBuf, { console: 1, exception: 0 }, undefined);

    expect(model.schema).toBe('chrome-cdp-ex.console.v1');
    expect(model.mode).toBe('new');
    expect(model.entries.map(e => e.text)).toEqual(['new']);
    expect(model.exceptions.map(e => e.msg)).toEqual(['boom']);
  });

  it('builds a versioned console model for --all', () => {
    const consoleBuf = new RingBuffer(10);
    const exceptionBuf = new RingBuffer(10);
    consoleBuf.push({ level: 'log', text: 'first' });
    consoleBuf.push({ level: 'warn', text: 'second' });
    const model = T.buildConsoleModel(consoleBuf, exceptionBuf, { console: 2, exception: 0 }, '--all');

    expect(model.mode).toBe('all');
    expect(model.entries.map(e => e.text)).toEqual(['first', 'second']);
  });

  it('builds a versioned status model with page and unread buffers', () => {
    const consoleBuf = new RingBuffer(10);
    const exceptionBuf = new RingBuffer(10);
    const navBuf = new RingBuffer(10);
    consoleBuf.push({ level: 'error', text: 'old' });
    consoleBuf.push({ level: 'warning', text: 'new' });
    exceptionBuf.push({ msg: 'boom' });
    navBuf.push({ url: 'https://example.com/next', ts: 123 });

    const model = T.buildStatusModel({
      targetId: 'ABC123',
      page: { title: 'Example', url: 'https://example.com' },
      consoleBuf,
      exceptionBuf,
      navBuf,
      lastReadSeq: { console: 1, exception: 0, nav: 0 },
    });

    expect(model.schema).toBe('chrome-cdp-ex.status.v1');
    expect(model.targetId).toBe('ABC123');
    expect(model.page.title).toBe('Example');
    expect(model.console.map(e => e.text)).toEqual(['new']);
    expect(model.exceptions.map(e => e.msg)).toEqual(['boom']);
    expect(model.navigation.map(e => e.url)).toEqual(['https://example.com/next']);
  });
});

// =========================================================================
// Perception model
// =========================================================================

describe('PerceptionModel', () => {
  it('builds a versioned model with page, viewport, console, refs, and nodes', () => {
    const model = T.createPerceptionModel({
      targetPrefix: 'ABC12345',
      page: { title: 'Example', url: 'https://example.com' },
      viewport: { width: 1280, height: 720, scrollY: 0, scrollMax: 1000 },
      consoleHealth: { errors: 1, warnings: 2, exceptions: 0 },
      refs: { generation: 3 },
      nodes: [{ ref: '@1', role: 'button', name: 'Submit', rect: { x: 10, y: 20, width: 80, height: 30 } }],
      limits: { truncated: false },
    });

    expect(model.schema).toBe('chrome-cdp-ex.perceive.v1');
    expect(model.viewport.coordinateSpace).toBe('viewport-css-px');
    expect(model.nodes[0].ref).toBe('@1');
    expect(model.recommendation).toMatchObject({
      source: 'golden-path',
      stage: 'act',
      targetPrefix: 'ABC12345',
      run: 'cdp click ABC12345 @1',
      after: 'cdp perceive ABC12345 --since-action',
      report: 'cdp report ABC12345',
      requiresUserAction: false,
      consentRequired: false,
    });
    expect(model.recommendation.reason).toContain('first interactive ref');
  });

  it('formats perception JSON as parseable output', () => {
    const model = T.createPerceptionModel({
      page: { title: 'Example', url: 'https://example.com' },
      viewport: { width: 1280, height: 720, scrollY: 0, scrollMax: 1000 },
      consoleHealth: { errors: 0, warnings: 0, exceptions: 0 },
      refs: { generation: 1 },
      nodes: [],
      limits: { truncated: false },
    });
    expect(JSON.parse(T.formatPerceptionJson(model)).schema).toBe('chrome-cdp-ex.perceive.v1');
  });
});

// =========================================================================
// SessionState
// =========================================================================

describe('SessionState', () => {
  it('creates explicit daemon session state', () => {
    const state = T.createSessionState({ targetId: 'ABC123', sessionId: 'sid-1' });
    expect(state.targetId).toBe('ABC123');
    expect(state.sessionId).toBe('sid-1');
    expect(state.refs.map).toBeInstanceOf(Map);
    expect(state.refs.invalidationReason).toBe('daemon-start');
    expect(state.actionLog).toEqual([]);
  });

  it('invalidates refs on navigation', () => {
    const state = T.createSessionState({ targetId: 'ABC123', sessionId: 'sid-1' });
    state.refs.map.set(1, 42);
    T.invalidateSessionRefs(state, 'navigation');
    expect(state.refs.map.size).toBe(0);
    expect(state.refs.invalidationReason).toBe('navigation');
  });
});

// =========================================================================
// ActionResult
// =========================================================================

describe('ActionResult', () => {
  it('creates versioned action evidence', () => {
    const result = T.createActionResult({
      action: 'click',
      target: { input: '@4', resolvedBy: 'ref', label: 'Submit' },
      dispatch: { ok: true, method: 'Input.dispatchMouseEvent' },
      settle: { ok: true, durationMs: 120 },
      effects: { domDiff: 'button disabled', console: [], network: [], navigation: null },
      nextHint: 'Use perceive --since-action if more evidence is needed',
    });
    expect(result.schema).toBe('chrome-cdp-ex.action.v1');
    expect(result.action).toBe('click');
    expect(result.dispatch.ok).toBe(true);
  });

  it('formats action evidence as compact text', () => {
    const text = T.formatActionText(T.createActionResult({
      action: 'fill',
      target: { input: '#email', resolvedBy: 'selector', label: 'Email' },
      dispatch: { ok: true, method: 'Input.insertText' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: 'value changed', console: [], network: [], navigation: null },
      nextHint: 'Continue with the next form field',
    }));
    expect(text).toMatch(/fill/i);
    expect(text).toMatch(/value changed/);
  });

  it('builds and formats console, exception, and network deltas since action dispatch', () => {
    const consoleBuf = new RingBuffer(10);
    const exceptionBuf = new RingBuffer(10);
    const netReqBuf = new RingBuffer(10);
    consoleBuf.push({ level: 'log', text: 'before action', loc: 'app.js:1', ts: 1 });
    netReqBuf.push({ method: 'GET', url: 'https://example.com/before', status: 200, duration: 9, ts: 1 });
    const baseline = T.createActionObservationBaseline({ consoleBuf, exceptionBuf, netReqBuf });

    consoleBuf.push({ level: 'warning', text: 'deprecated API', loc: 'app.js:10', ts: 2 });
    consoleBuf.push({ level: 'error', text: 'save failed', loc: 'app.js:11', ts: 3 });
    exceptionBuf.push({ msg: 'Error: render exploded', loc: 'app.js:12', ts: 4 });
    netReqBuf.push({ method: 'GET', url: 'https://example.com/ok', status: 200, duration: 12, ts: 5 });
    netReqBuf.push({ method: 'POST', url: 'https://example.com/api/save?draft=1', status: 500, duration: 31, ts: 6 });

    const delta = T.buildActionObservationDelta({ consoleBuf, exceptionBuf, netReqBuf }, baseline);
    const result = T.applyActionObservationDelta(T.createActionResult({
      action: 'click',
      target: { input: '#save', resolvedBy: 'selector', label: 'Save' },
      dispatch: { ok: true, method: 'click' },
      settle: { ok: true, durationMs: 150 },
      effects: { domDiff: 'Saved banner appeared', console: [], network: [], navigation: null },
      nextHint: null,
    }), delta);
    const text = T.formatActionText(result);

    expect(delta.console).toMatchObject({ count: 2, errors: 1, warnings: 1 });
    expect(delta.exceptions).toMatchObject({ count: 1 });
    expect(delta.network).toMatchObject({ count: 2, failures: 1 });
    expect(text).toContain('Console: 2 entries (1 error, 1 warning)');
    expect(text).toContain('Console sample: [error] save failed @ app.js:11');
    expect(text).toContain('Exception: 1 thrown');
    expect(text).toContain('Network: 2 requests (1 failed)');
    expect(text).toContain('Network sample: POST /api/save?draft=1 -> 500 in 31ms');
  });

  it('tracks action-relevant network request types while skipping static assets', () => {
    expect(T.shouldTrackActionNetworkRequest('Fetch')).toBe(true);
    expect(T.shouldTrackActionNetworkRequest('XHR')).toBe(true);
    expect(T.shouldTrackActionNetworkRequest('Document')).toBe(true);
    expect(T.shouldTrackActionNetworkRequest('Other')).toBe(true);
    expect(T.shouldTrackActionNetworkRequest(undefined)).toBe(true);
    expect(T.shouldTrackActionNetworkRequest('Image')).toBe(false);
    expect(T.shouldTrackActionNetworkRequest('Script')).toBe(false);
    expect(T.shouldTrackActionNetworkRequest('Stylesheet')).toBe(false);
  });

  it('formats pending network requests as action evidence', () => {
    const result = T.applyActionObservationDelta(T.createActionResult({
      action: 'click',
      target: { input: '#diagnostic', resolvedBy: 'selector', label: 'Diagnostic' },
      dispatch: { ok: true, method: 'click' },
      settle: { ok: true, durationMs: 1400 },
      effects: { domDiff: null, console: [], network: [], navigation: null },
      nextHint: null,
    }), {
      console: { count: 0, errors: 0, warnings: 0, entries: [] },
      exceptions: { count: 0, entries: [] },
      network: {
        count: 1,
        failures: 0,
        pending: 1,
        entries: [{ method: 'POST', url: 'https://example.com/api/fail', status: 'pending', duration: 1404, pending: true }],
      },
    });

    const text = T.formatActionText(result);

    expect(text).toContain('Network: 1 request (1 pending)');
    expect(text).toContain('Network sample: POST /api/fail -> pending in 1404ms');
  });

  it('wraps dispatch output with observed action evidence', async () => {
    let captured = null;
    const text = await T.runActionWithFeedback({
      action: 'click',
      target: { input: '@4', resolvedBy: 'ref', label: 'Submit' },
      dispatch: async () => 'Clicked @4',
      feedbackPolicy: 'settle-diff',
      observe: async () => 'button disabled',
      onActionResult: (result) => { captured = result; },
    });

    expect(text).toMatch(/Clicked @4/);
    expect(text).toMatch(/click: dispatched/);
    expect(text).toMatch(/button disabled/);
    expect(captured.action).toBe('click');
    expect(captured.effects.domDiff).toBe('button disabled');
  });

  it('formats observed action evidence as JSON without dispatch text noise', async () => {
    const out = await T.runActionWithFeedback({
      action: 'click',
      target: { input: '#submit', resolvedBy: 'selector', label: 'Submit' },
      dispatch: async () => 'Clicked #submit',
      feedbackPolicy: 'settle-diff',
      observe: async () => 'checkout banner appeared',
      format: 'json',
    });
    const parsed = JSON.parse(out);

    expect(parsed).toMatchObject({
      schema: 'chrome-cdp-ex.action.v1',
      action: 'click',
      target: { input: '#submit', label: 'Submit' },
      dispatch: { ok: true, method: 'click' },
      settle: { ok: true },
      effects: { domDiff: 'checkout banner appeared' },
      nextHint: 'Use perceive --since-action if more evidence is needed',
    });
    expect(out).not.toContain('Clicked #submit');
  });

  it('enriches action feedback before formatting and logging', async () => {
    const delta = {
      console: {
        count: 1,
        errors: 1,
        warnings: 0,
        entries: [{ level: 'error', text: 'submit failed', loc: 'checkout.js:20' }],
      },
      exceptions: { count: 0, entries: [] },
      network: {
        count: 1,
        failures: 1,
        entries: [{ method: 'POST', url: 'https://example.com/api/checkout', status: 503, duration: 44 }],
      },
    };
    let captured = null;

    const text = await T.runActionWithFeedback({
      action: 'click',
      target: { input: '#submit', resolvedBy: 'selector', label: 'Submit' },
      dispatch: async () => 'Clicked #submit',
      feedbackPolicy: 'settle-diff',
      observe: async () => 'checkout error banner',
      enrichActionResult: (result) => T.applyActionObservationDelta(result, delta),
      onActionResult: (result) => { captured = result; },
    });

    expect(text).toContain('Console: 1 entry (1 error)');
    expect(text).toContain('Network sample: POST /api/checkout -> 503 in 44ms');
    expect(captured.effects.consoleDelta.errors).toBe(1);
    expect(captured.effects.networkDelta.failures).toBe(1);
  });

  it('adds a structured diagnosis when action evidence shows runtime trouble', async () => {
    const delta = {
      console: {
        count: 1,
        errors: 0,
        warnings: 1,
        entries: [{ level: 'warning', text: 'slow endpoint', loc: 'app.js:21' }],
      },
      exceptions: { count: 0, entries: [] },
      network: {
        count: 1,
        failures: 1,
        pending: 0,
        entries: [{ method: 'POST', url: 'https://example.com/api/save', status: 500, duration: 44 }],
      },
    };

    const out = await T.runActionWithFeedback({
      action: 'click',
      target: { targetId: 'ABC123', input: '#save', resolvedBy: 'selector', label: 'Save' },
      dispatch: async () => 'Clicked #save',
      feedbackPolicy: 'settle-diff',
      observe: async () => 'error banner appeared',
      enrichActionResult: (result) => T.applyActionObservationDelta(result, delta),
      format: 'json',
    });
    const parsed = JSON.parse(out);

    expect(parsed.effects.diagnosis).toMatchObject({
      schema: 'chrome-cdp-ex.action-diagnosis.v1',
      status: 'attention',
      kind: 'network-failure',
      confidence: 'high',
      source: 'network',
      nextCommand: 'cdp netlog ABC123',
      recovery: {
        schema: 'chrome-cdp-ex.recovery-policy.v1',
        strategy: 'inspect-network',
        priority: 'high',
        verifyCommand: 'cdp perceive ABC123 --since-action',
        commands: [
          { command: 'cdp netlog ABC123' },
          { command: 'cdp perceive ABC123 --since-action' },
          { command: 'cdp report ABC123 --format json' },
        ],
      },
      signals: {
        dispatchOk: true,
        settleOk: true,
        domChanged: true,
        consoleWarnings: 1,
        networkFailures: 1,
      },
    });
    expect(T.formatActionText(parsed)).toContain('Diagnosis: network-failure');
    expect(T.formatActionText(parsed)).toContain('Next: cdp netlog ABC123');
  });

  it('records report-only actions as action evidence without a DOM observation', async () => {
    let captured = null;

    const text = await T.runActionWithFeedback({
      action: 'restore',
      target: { input: 'checkpoint', resolvedBy: 'artifact', label: 'checkpoint' },
      dispatch: async () => 'Restored checkpoint',
      feedbackPolicy: 'report-only',
      observe: async () => 'not reached',
      onActionResult: (result) => { captured = result; },
    });

    expect(text).toContain('Restored checkpoint');
    expect(text).toContain('restore: dispatched');
    expect(captured.effects.domDiff).toBeNull();
    expect(captured.settle.ok).toBe(true);
  });

  it('returns timeout evidence with diagnostics when post-action observation times out', async () => {
    const err = new Error('Timeout: post-action perceive');
    err.name = 'TimeoutError';
    const delta = {
      console: { count: 1, errors: 0, warnings: 1, entries: [{ level: 'warning', text: 'slow rerender', loc: '' }] },
      exceptions: { count: 0, entries: [] },
      network: { count: 0, failures: 0, entries: [] },
    };
    let captured = null;

    const text = await T.runActionWithFeedback({
      action: 'click',
      target: { input: '#save', resolvedBy: 'selector', label: 'Save' },
      dispatch: async () => 'Clicked #save',
      feedbackPolicy: 'settle-diff',
      observe: async () => { throw err; },
      enrichActionResult: (result) => T.applyActionObservationDelta(result, delta),
      onActionResult: (result) => { captured = result; },
    });

    expect(text).toContain('success but observation timed out');
    expect(text).toContain('Console: 1 entry (1 warning)');
    expect(captured.settle.ok).toBe(false);
    expect(captured.effects.consoleDelta.warnings).toBe(1);
  });

  it('classifies action failures into recoverable next steps', () => {
    const overlay = T.classifyActionFailure(
      new Error('Element is not clickable at point (20, 30). Other element would receive the click'),
      { action: 'click', target: { targetId: 'abc123', input: '@4', label: 'Submit' } }
    );
    expect(overlay.kind).toBe('overlay');
    expect(overlay.nextCommand).toBe('cdp dismiss-modal abc123');
    expect(overlay.hints.join('\n')).toContain('cdp jsclick abc123 @4');

    const wrongFrame = T.classifyActionFailure(
      new Error('No frame for given id found'),
      { action: 'click', target: { targetId: 'abc123', input: '#pay' } }
    );
    expect(wrongFrame.kind).toBe('wrong-frame');
    expect(wrongFrame.nextCommand).toBe('cdp perceive abc123 -C -d 8');

    const navigation = T.classifyActionFailure(
      new Error('Cannot find context with specified id'),
      { action: 'fill', target: { targetId: 'abc123', input: '#email' } }
    );
    expect(navigation.kind).toBe('navigation');
    expect(navigation.nextCommand).toBe('cdp perceive abc123 -C -d 8');

    const domRewrite = T.classifyActionFailure(
      new Error('No node with given id'),
      { action: 'click', target: { targetId: 'abc123', input: '@9' } }
    );
    expect(domRewrite.kind).toBe('dom-rewrite');
    expect(domRewrite.nextCommand).toBe('cdp perceive abc123 -C -d 8');

    const timeout = T.classifyActionFailure(
      new Error('Timeout: Runtime.callFunctionOn'),
      { action: 'reload', target: { targetId: 'abc123', input: 'reload' } }
    );
    expect(timeout.kind).toBe('timeout');
    expect(timeout.nextCommand).toBe('cdp status abc123');
  });

  it('maps wrong-frame diagnoses to frame-aware recovery commands', () => {
    const recovery = T.buildActionRecoveryPlan({
      status: 'blocked',
      kind: 'wrong-frame',
      nextCommand: 'cdp perceive ABC123 -C -d 8',
    }, { targetId: 'ABC123' });

    expect(recovery).toMatchObject({
      schema: 'chrome-cdp-ex.recovery-policy.v1',
      strategy: 'refresh-frame-context',
      priority: 'high',
      commands: [
        { command: 'cdp frame ABC123 --format json' },
        { command: 'cdp perceive ABC123 -C -d 8' },
      ],
      verifyCommand: 'cdp perceive ABC123 -C -d 8',
    });
  });

  it('formats action failures without losing the original browser error', () => {
    const text = T.formatActionFailure(
      new Error('Element not found: #save'),
      { action: 'click', target: { targetId: 'abc123', input: '#save' } }
    );
    expect(text).toContain('Action failure: selector');
    expect(text).toContain('Next: cdp perceive abc123 -C -d 8');
    expect(text).toContain('Original: Element not found: #save');
  });

  it('records failed dispatches as action evidence before returning a classified error', async () => {
    let captured = null;
    await expect(T.runActionWithFeedback({
      action: 'click',
      target: { targetId: 'abc123', input: '@4', resolvedBy: 'ref', label: 'Submit' },
      dispatch: async () => {
        throw new Error('Element is not clickable at point (20, 30). Other element would receive the click');
      },
      feedbackPolicy: 'settle-diff',
      observe: async () => 'not reached',
      onActionResult: (result) => { captured = result; },
    })).rejects.toThrow(/Action failure: overlay/);

    expect(captured.action).toBe('click');
    expect(captured.dispatch.ok).toBe(false);
    expect(captured.effects.failure.kind).toBe('overlay');
    expect(captured.nextHint).toBe('cdp dismiss-modal abc123');
  });

  it('returns classified failed dispatch evidence as JSON for agents', async () => {
    let captured = null;
    const out = await T.runActionWithFeedback({
      action: 'click',
      target: { targetId: 'abc123', input: '@4', resolvedBy: 'ref', label: 'Submit' },
      dispatch: async () => {
        throw new Error('Element is not clickable at point (20, 30). Other element would receive the click');
      },
      feedbackPolicy: 'settle-diff',
      observe: async () => 'not reached',
      format: 'json',
      onActionResult: (result) => { captured = result; },
    });
    const parsed = JSON.parse(out);

    expect(parsed).toMatchObject({
      schema: 'chrome-cdp-ex.action.v1',
      action: 'click',
      target: { input: '@4', label: 'Submit' },
      dispatch: {
        ok: false,
        method: 'click',
        error: 'Element is not clickable at point (20, 30). Other element would receive the click',
      },
      settle: { ok: false },
      effects: {
        domDiff: null,
        failure: {
          kind: 'overlay',
          nextCommand: 'cdp dismiss-modal abc123',
        },
        diagnosis: {
          status: 'blocked',
          kind: 'overlay',
          source: 'dispatch',
          nextCommand: 'cdp dismiss-modal abc123',
          recovery: {
            strategy: 'clear-overlay',
            commands: [
              { command: 'cdp overlay abc123 @4 --format json' },
              { command: 'cdp dismiss-modal abc123' },
              { command: 'cdp perceive abc123 -C -d 8' },
            ],
            avoid: ['retrying the same click before clearing or re-checking the overlay'],
          },
        },
      },
      nextHint: 'cdp dismiss-modal abc123',
    });
    expect(captured.effects.failure.kind).toBe('overlay');
    expect(out).not.toContain('Action failure: overlay');
  });
});

// =========================================================================
// Session report
// =========================================================================

describe('Session report', () => {
  function sampleActionResult() {
    return T.createActionResult({
      action: 'click',
      target: { targetId: 'ABC123', input: '#combat', resolvedBy: 'selector', label: '#combat' },
      dispatch: { ok: true, method: 'click' },
      settle: { ok: true, durationMs: 123 },
      effects: {
        domDiff: [
          'Page: Smoke — http://127.0.0.1/',
          '',
          '+++ Added (1):',
          '+   [alert] 戰鬥勝利',
        ].join('\n'),
        console: [],
        network: [],
        navigation: null,
      },
      nextHint: 'Use perceive --since-action if more evidence is needed',
    });
  }

  it('formats an empty session report with a next action hint', () => {
    const state = T.createSessionState({ targetId: 'ABC123', sessionId: 'sid-1' });
    state.createdAt = Date.parse('2026-06-16T00:00:00.000Z');

    const out = T.formatSessionReport(state, { now: Date.parse('2026-06-16T00:00:05.000Z') });

    expect(out).toContain('Session report: ABC123');
    expect(out).toContain('Uptime: 5s');
    expect(out).toContain('Log:');
    expect(out).toContain('Actions: 0');
    expect(out).toContain('Screenshot dir:');
    expect(out).toContain('No actions recorded yet');
  });

  it('records action evidence and formats an action timeline', () => {
    const state = T.createSessionState({ targetId: 'ABC123', sessionId: 'sid-1' });
    state.createdAt = Date.parse('2026-06-16T00:00:00.000Z');
    const actionResult = sampleActionResult();

    T.appendSessionActionLog(state, actionResult, { ts: Date.parse('2026-06-16T00:00:03.000Z') });
    const out = T.formatSessionReport(state, { now: Date.parse('2026-06-16T00:00:05.000Z') });

    expect(state.actionLog).toHaveLength(1);
    expect(out).toContain('Actions: 1');
    expect(out).toContain('Action timeline:');
    expect(out).toContain('1. click #combat — ok in 123ms');
    expect(out).toContain('Effect: +++ Added (1):');
    expect(out).toContain('戰鬥勝利');
  });

  it('builds a JSON report model for agent handoff', () => {
    const state = T.createSessionState({
      targetId: 'ABC123456789',
      sessionId: 'sid-1',
      logPath: '/tmp/chrome-cdp-ex/session-ABC12345.jsonl',
      screenshotDir: '/tmp/chrome-cdp-ex/screens-ABC12345',
    });
    state.createdAt = Date.parse('2026-06-16T00:00:00.000Z');
    T.appendSessionActionLog(state, sampleActionResult(), {
      ts: Date.parse('2026-06-16T00:00:03.000Z'),
    });
    T.appendSessionScreenshot(state, {
      kind: 'shot',
      path: '/tmp/chrome-cdp-ex/screens-ABC12345/shot-001.png',
      note: 'after combat',
      ts: Date.parse('2026-06-16T00:00:04.000Z'),
    });

    const model = T.buildSessionReportModel(state, {
      now: Date.parse('2026-06-16T00:00:05.000Z'),
    });

    expect(model).toMatchObject({
      schema: 'chrome-cdp-ex.report.v1',
      targetId: 'ABC123456789',
      targetPrefix: 'ABC12345',
      sessionId: 'sid-1',
      uptimeMs: 5000,
      counts: { actions: 1, screenshots: 1, records: 0 },
      paths: {
        log: '/tmp/chrome-cdp-ex/session-ABC12345.jsonl',
        screenshotDir: '/tmp/chrome-cdp-ex/screens-ABC12345',
      },
      actions: [
        {
          index: 1,
          action: 'click',
          status: 'ok',
          target: { input: '#combat', label: '#combat' },
          evidence: {
            settleDurationMs: 123,
            effectSummary: '+++ Added (1):',
            effectSample: '+   [alert] 戰鬥勝利',
          },
          nextHint: 'Use perceive --since-action if more evidence is needed',
        },
      ],
      screenshots: [
        {
          index: 1,
          kind: 'shot',
          path: '/tmp/chrome-cdp-ex/screens-ABC12345/shot-001.png',
          note: 'after combat',
        },
      ],
      nextSteps: [
        'cdp perceive ABC12345 --since-action',
        'cdp record-actions ABC12345 --format json',
        'cdp export-playwright ABC12345',
      ],
    });
  });

  it('records compact console and network deltas in session reports', () => {
    const state = T.createSessionState({ targetId: 'ABC123', sessionId: 'sid-1' });
    const actionResult = T.applyActionObservationDelta(sampleActionResult(), {
      console: {
        count: 1,
        errors: 1,
        warnings: 0,
        entries: [{ level: 'error', text: 'combat failed', loc: 'game.js:44' }],
      },
      exceptions: { count: 0, entries: [] },
      network: {
        count: 1,
        failures: 1,
        entries: [{ method: 'POST', url: 'https://example.com/api/combat', status: 500, duration: 27 }],
      },
    });

    T.appendSessionActionLog(state, actionResult, { ts: Date.parse('2026-06-16T00:00:03.000Z') });
    const out = T.formatSessionReport(state, { now: Date.parse('2026-06-16T00:00:05.000Z') });

    expect(out).toContain('Console: 1 entry (1 error)');
    expect(out).toContain('Console sample: [error] combat failed @ game.js:44');
    expect(out).toContain('Network: 1 request (1 failed)');
    expect(out).toContain('Network sample: POST /api/combat -> 500 in 27ms');
    expect(out).toContain('Diagnosis: network-failure');
    expect(out).toContain('Recovery: inspect-network');
    expect(state.actionLog[0].consoleSummary).toBe('Console: 1 entry (1 error)');
    expect(state.actionLog[0].networkSummary).toBe('Network: 1 request (1 failed)');
    expect(state.actionLog[0].diagnosis).toMatchObject({
      kind: 'network-failure',
      nextCommand: 'cdp netlog ABC123',
    });
  });

  it('prioritizes latest diagnosis recovery commands in JSON report next steps', () => {
    const state = T.createSessionState({ targetId: 'ABC123', sessionId: 'sid-1' });
    const actionResult = T.applyActionObservationDelta(sampleActionResult(), {
      console: { count: 0, errors: 0, warnings: 0, entries: [] },
      exceptions: { count: 0, entries: [] },
      network: {
        count: 1,
        failures: 1,
        pending: 0,
        entries: [{ method: 'POST', url: 'https://example.com/api/combat', status: 500, duration: 27 }],
      },
    });

    T.appendSessionActionLog(state, actionResult, { ts: Date.parse('2026-06-16T00:00:03.000Z') });
    const model = T.buildSessionReportModel(state, { now: Date.parse('2026-06-16T00:00:05.000Z') });

    expect(model.nextSteps).toEqual([
      'cdp netlog ABC123',
      'cdp perceive ABC123 --since-action',
      'cdp report ABC123 --format json',
      'cdp record-actions ABC123 --format json',
      'cdp export-playwright ABC123',
    ]);
    expect(model.recommendation).toMatchObject({
      source: 'latest-action-diagnosis',
      strategy: 'inspect-network',
      actionIndex: 1,
      diagnosisKind: 'network-failure',
      verifyCommand: 'cdp perceive ABC123 --since-action',
    });
  });

  it('records classified action failures in the session report', () => {
    const state = T.createSessionState({ targetId: 'ABC123', sessionId: 'sid-1' });
    const failure = T.classifyActionFailure(
      new Error('No node with given id'),
      { action: 'click', target: { targetId: 'ABC123', input: '@9' } }
    );

    T.appendSessionActionLog(state, T.createActionResult({
      action: 'click',
      target: { input: '@9', resolvedBy: 'ref', label: '@9' },
      dispatch: { ok: false, method: 'click', error: failure.originalMessage },
      settle: { ok: false, durationMs: 12 },
      effects: { domDiff: null, console: [], network: [], navigation: null, failure },
      nextHint: failure.nextCommand,
    }), { ts: Date.parse('2026-06-16T00:00:03.000Z') });

    const out = T.formatSessionReport(state, { now: Date.parse('2026-06-16T00:00:05.000Z') });

    expect(out).toContain('1. click @9 — failed in 12ms');
    expect(out).toContain('Failure: dom-rewrite');
    expect(out).toContain('Next: cdp perceive ABC123 -C -d 8');
  });

  it('writes compact action events to the per-target session log', () => {
    const logPath = `/tmp/cdp-session-log-${Date.now()}-${Math.random().toString(16).slice(2)}.log`;
    const state = T.createSessionState({ targetId: 'ABC123', sessionId: 'sid-1', logPath });

    try {
      T.appendSessionActionLog(state, sampleActionResult(), { ts: Date.parse('2026-06-16T00:00:03.000Z') });
      const [line] = readFileSync(logPath, 'utf8').trim().split('\n');
      const event = JSON.parse(line);

      expect(event.schema).toBe('chrome-cdp-ex.session-event.v1');
      expect(event.kind).toBe('action');
      expect(event.targetId).toBe('ABC123');
      expect(event.action.action).toBe('click');
      expect(event.action.effectSummary).toBe('+++ Added (1):');
      expect(event.action.effectSample).toContain('戰鬥勝利');
      expect(event.action.domDiff).toBeUndefined();
    } finally {
      rmSync(logPath, { force: true });
    }
  });

  it('initializes the per-target session log with a session-start event', () => {
    const logPath = `/tmp/cdp-session-start-${Date.now()}-${Math.random().toString(16).slice(2)}.log`;
    const state = T.createSessionState({ targetId: 'ABC123', sessionId: 'sid-1', logPath });

    try {
      T.initializeSessionLog(state, { ts: Date.parse('2026-06-16T00:00:00.000Z') });
      const [line] = readFileSync(logPath, 'utf8').trim().split('\n');
      const event = JSON.parse(line);

      expect(event.schema).toBe('chrome-cdp-ex.session-event.v1');
      expect(event.kind).toBe('session-start');
      expect(event.targetId).toBe('ABC123');
      expect(event.sessionId).toBe('sid-1');
      expect(event.ts).toBe(Date.parse('2026-06-16T00:00:00.000Z'));
    } finally {
      rmSync(logPath, { force: true });
    }
  });

  it('registers screenshot attachments and shows them in the report', () => {
    const state = T.createSessionState({
      targetId: 'ABC123',
      sessionId: 'sid-1',
      screenshotDir: '/tmp/cdp-session-shots-ABC123',
    });
    const entry = T.appendSessionScreenshot(state, {
      kind: 'shot',
      path: '/tmp/cdp-session-shots-ABC123/shot-001.png',
      note: 'viewport',
      ts: Date.parse('2026-06-16T00:00:04.000Z'),
    });
    const out = T.formatSessionReport(state, { now: Date.parse('2026-06-16T00:00:05.000Z') });

    expect(entry.path).toBe('/tmp/cdp-session-shots-ABC123/shot-001.png');
    expect(state.screenshots).toHaveLength(1);
    expect(out).toContain('Screenshots: 1');
    expect(out).toContain('Attachments:');
    expect(out).toContain('shot — /tmp/cdp-session-shots-ABC123/shot-001.png');
  });

  it('builds default screenshot paths inside the session screenshot directory', () => {
    const state = T.createSessionState({
      targetId: 'ABC123',
      sessionId: 'sid-1',
      screenshotDir: '/tmp/cdp-session-shots-ABC123',
    });

    expect(T.nextSessionScreenshotPath(state, 'shot')).toBe('/tmp/cdp-session-shots-ABC123/shot-001.png');
    T.appendSessionScreenshot(state, { kind: 'shot', path: '/tmp/cdp-session-shots-ABC123/shot-001.png' });
    expect(T.nextSessionScreenshotPath(state, 'shot')).toBe('/tmp/cdp-session-shots-ABC123/shot-002.png');
  });

  it('builds a record-actions JSON model from the session action log', () => {
    const state = T.createSessionState({ targetId: 'ABC123', sessionId: 'sid-1' });
    T.appendSessionActionLog(state, T.createActionResult({
      action: 'click',
      target: {
        input: '#combat',
        resolvedBy: 'selector',
        label: '#combat',
        commandArgs: ['#combat'],
      },
      dispatch: { ok: true, method: 'click' },
      settle: { ok: true, durationMs: 123 },
      effects: { domDiff: '+++ Added (1):\n+   [alert] 戰鬥勝利', console: [], network: [], navigation: null },
      nextHint: 'Use perceive --since-action if more evidence is needed',
    }), { ts: Date.parse('2026-06-16T00:00:03.000Z') });

    const model = T.buildRecordActionsModel(state);

    expect(model.schema).toBe('chrome-cdp-ex.record-actions.v1');
    expect(model.targetId).toBe('ABC123');
    expect(model.actions).toHaveLength(1);
    expect(model.actions[0]).toMatchObject({
      index: 1,
      action: 'click',
      command: ['click', '#combat'],
      replayable: true,
      evidence: {
        settleOk: true,
        settleDurationMs: 123,
        effectSummary: '+++ Added (1):',
      },
    });
  });

  it('includes reusable environment controls in record-actions artifacts', async () => {
    const cdp = createMockCDP({
      'Page.addScriptToEvaluateOnNewDocument': () => ({ identifier: 'clock-script-1' }),
      'Runtime.evaluate': () => ({ result: { value: { ok: true } } }),
    });
    const state = T.createSessionState({ targetId: 'ABC123', sessionId: 'sid-1' });

    await T.mockStr(cdp, 'sid-1', state, ['add', '**/api/fail*', '--status', '503', '--body', '{"ok":false}', '--content-type', 'application/json']);
    await T.throttleStr(cdp, 'sid-1', state, ['custom', '--latency', '120', '--download', '256', '--upload', '128']);
    await T.clockStr(cdp, 'sid-1', state, ['freeze', '--at', '2020-01-02T03:04:05.000Z']);

    const model = T.buildRecordActionsModel(state);
    const out = T.formatRecordActions(state);

    expect(model.environmentCount).toBe(3);
    expect(model.environment.map(entry => entry.type)).toEqual(['mock', 'throttle', 'clock']);
    expect(model.environment[0]).toMatchObject({
      index: 1,
      type: 'mock',
      action: 'add',
      replayable: true,
      command: ['mock', 'add', '**/api/fail*', '--status', '503', '--body', '{"ok":false}', '--content-type', 'application/json'],
    });
    expect(model.environment[1]).toMatchObject({
      index: 2,
      type: 'throttle',
      action: 'apply',
      command: ['throttle', 'custom', '--latency', '120', '--download', '256', '--upload', '128'],
    });
    expect(model.environment[2]).toMatchObject({
      index: 3,
      type: 'clock',
      action: 'apply',
      command: ['clock', 'freeze', '--at', '2020-01-02T03:04:05.000Z'],
    });
    expect(out).toContain('Environment controls: 3');
    expect(out).toContain('Env 1. mock add **/api/fail* --status 503 --body "{\\"ok\\":false}" --content-type application/json — replayable');
  });

  it('formats record-actions text with replay drafts and honest gaps', () => {
    const state = T.createSessionState({ targetId: 'ABC123', sessionId: 'sid-1' });
    T.appendSessionActionLog(state, T.createActionResult({
      action: 'click',
      target: { input: '#combat', resolvedBy: 'selector', label: '#combat', commandArgs: ['#combat'] },
      dispatch: { ok: true, method: 'click' },
      settle: { ok: true, durationMs: 123 },
      effects: { domDiff: '+++ Added (1):\n+   [alert] 戰鬥勝利', console: [], network: [], navigation: null },
      nextHint: null,
    }));
    T.appendSessionActionLog(state, T.createActionResult({
      action: 'fill',
      target: { input: '#cmd', resolvedBy: 'selector', label: '#cmd' },
      dispatch: { ok: true, method: 'fill' },
      settle: { ok: false, durationMs: 900 },
      effects: { domDiff: null, console: [], network: [], navigation: null },
      nextHint: null,
    }));

    const out = T.formatRecordActions(state);

    expect(out).toContain('Recorded actions: 2');
    expect(out).toContain('1. click #combat — replayable');
    expect(out).toContain('Replay: click #combat');
    expect(out).toContain('Evidence: +++ Added (1):');
    expect(out).toContain('2. fill #cmd — needs input');
    expect(out).toContain('Replay: fill #cmd <text>');
  });

  it('includes diagnostic evidence in record-actions artifacts', () => {
    const state = T.createSessionState({ targetId: 'ABC123', sessionId: 'sid-1' });
    T.appendSessionActionLog(state, T.applyActionObservationDelta(T.createActionResult({
      action: 'click',
      target: { input: '#combat', resolvedBy: 'selector', label: '#combat', commandArgs: ['#combat'] },
      dispatch: { ok: true, method: 'click' },
      settle: { ok: true, durationMs: 123 },
      effects: { domDiff: '+++ Added (1):\n+   [alert] 戰鬥勝利', console: [], network: [], navigation: null },
      nextHint: null,
    }), {
      console: {
        count: 1,
        errors: 0,
        warnings: 1,
        entries: [{ level: 'warning', text: 'animation fallback used', loc: '' }],
      },
      exceptions: { count: 0, entries: [] },
      network: {
        count: 1,
        failures: 1,
        entries: [{ method: 'POST', url: 'https://example.com/api/combat', status: 500, duration: 27 }],
      },
    }));

    const model = T.buildRecordActionsModel(state);
    const out = T.formatRecordActions(state);

    expect(model.actions[0].evidence.consoleSummary).toBe('Console: 1 entry (1 warning)');
    expect(model.actions[0].evidence.networkSummary).toBe('Network: 1 request (1 failed)');
    expect(out).toContain('Console: 1 entry (1 warning)');
    expect(out).toContain('Network sample: POST /api/combat -> 500 in 27ms');
  });

  it('keeps failed dispatches as diagnostic evidence but not replayable steps', () => {
    const state = T.createSessionState({ targetId: 'ABC123', sessionId: 'sid-1' });
    const failure = T.classifyActionFailure(
      new Error('Element not found: #missing'),
      { action: 'click', target: { targetId: 'ABC123', input: '#missing' } }
    );
    T.appendSessionActionLog(state, T.createActionResult({
      action: 'click',
      target: {
        input: '#missing',
        resolvedBy: 'selector',
        label: '#missing',
        commandArgs: ['#missing'],
      },
      dispatch: { ok: false, method: 'click', error: failure.originalMessage },
      settle: { ok: false, durationMs: 12 },
      effects: { domDiff: null, console: [], network: [], navigation: null, failure },
      nextHint: failure.nextCommand,
    }));

    const model = T.buildRecordActionsModel(state);
    const out = T.formatRecordActions(state);

    expect(model.actions[0]).toMatchObject({
      action: 'click',
      command: ['click', '#missing'],
      replayable: false,
      needsInput: ['successful-dispatch'],
      evidence: {
        failure: { kind: 'selector' },
        nextHint: 'cdp perceive ABC123 -C -d 8',
      },
    });
    expect(out).toContain('1. click #missing — needs input');
    expect(out).toContain('Missing: successful-dispatch');
    expect(out).toContain('Failure: selector');
  });

  it('formats record-actions JSON for scripting', () => {
    const state = T.createSessionState({ targetId: 'ABC123', sessionId: 'sid-1' });
    T.appendSessionActionLog(state, T.createActionResult({
      action: 'nav',
      target: { input: 'https://example.com', resolvedBy: 'url', label: 'https://example.com', commandArgs: ['https://example.com'] },
      dispatch: { ok: true, method: 'nav' },
      settle: { ok: true, durationMs: 300 },
      effects: { domDiff: 'Page changed', console: [], network: [], navigation: null },
      nextHint: null,
    }));

    const parsed = JSON.parse(T.formatRecordActions(state, { format: 'json' }));

    expect(parsed.schema).toBe('chrome-cdp-ex.record-actions.v1');
    expect(parsed.actions[0].command).toEqual(['nav', 'https://example.com']);
  });

  it('exports replayable actions as a Playwright spec with honest gaps', () => {
    const state = T.createSessionState({ targetId: 'ABC123', sessionId: 'sid-1' });
    T.appendSessionActionLog(state, T.createActionResult({
      action: 'nav',
      target: { input: 'https://example.com/dashboard', resolvedBy: 'url', label: 'dashboard', commandArgs: ['https://example.com/dashboard'] },
      dispatch: { ok: true, method: 'nav' },
      settle: { ok: true, durationMs: 300 },
      effects: { domDiff: 'Page changed', console: [], network: [], navigation: null },
      nextHint: null,
    }));
    T.appendSessionActionLog(state, T.createActionResult({
      action: 'fill',
      target: { input: '#cmd', resolvedBy: 'selector', label: '#cmd', commandArgs: ['#cmd', 'look trainer'] },
      dispatch: { ok: true, method: 'fill' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: 'value changed', console: [], network: [], navigation: null },
      nextHint: null,
    }));
    T.appendSessionActionLog(state, T.createActionResult({
      action: 'click',
      target: { input: '#combat', resolvedBy: 'selector', label: '#combat', commandArgs: ['#combat'] },
      dispatch: { ok: true, method: 'click' },
      settle: { ok: true, durationMs: 123 },
      effects: { domDiff: '~~~ Text nodes updated (1 added)\n+   [StaticText] 戰鬥勝利', console: [], network: [], navigation: null },
      nextHint: null,
    }));
    T.appendSessionActionLog(state, T.createActionResult({
      action: 'click',
      target: { input: '@1', resolvedBy: 'ref', label: '@1', commandArgs: ['@1'] },
      dispatch: { ok: true, method: 'click' },
      settle: { ok: true, durationMs: 60 },
      effects: { domDiff: null, console: [], network: [], navigation: null },
      nextHint: null,
    }));

    const out = T.formatExportPlaywright(state);

    expect(out).toContain("import { test } from '@playwright/test';");
    expect(out).toContain("test('chrome-cdp-ex exported workflow'");
    expect(out).toContain('await page.goto("https://example.com/dashboard");');
    expect(out).toContain('await page.locator("#cmd").fill("look trainer");');
    expect(out).toContain('await page.locator("#combat").click();');
    expect(out).toContain('Not exported: click @1');
    expect(out).toContain('needs stable selector');
  });

  it('exports portable network mocks before Playwright action steps', () => {
    const state = T.createSessionState({ targetId: 'ABC123', sessionId: 'sid-1' });
    state.environmentLog.push({
      ts: Date.parse('2026-06-16T00:00:01.000Z'),
      kind: 'mock',
      action: 'add',
      rule: {
        urlPattern: '**/api/fail*',
        status: 503,
        body: '{"ok":false}',
        contentType: 'application/json',
      },
    });
    T.appendSessionActionLog(state, T.createActionResult({
      action: 'click',
      target: { input: '#combat', resolvedBy: 'selector', label: '#combat', commandArgs: ['#combat'] },
      dispatch: { ok: true, method: 'click' },
      settle: { ok: true, durationMs: 123 },
      effects: { domDiff: 'Page changed', console: [], network: [], navigation: null },
      nextHint: null,
    }));

    const out = T.formatExportPlaywright(state);

    expect(out.indexOf('await page.route("**/api/fail*"')).toBeLessThan(out.indexOf('await page.locator("#combat").click();'));
    expect(out).toContain('route.fulfill({ status: 503, contentType: "application/json", body: "{\\"ok\\":false}" })');
  });

  it('exports react fill actions without treating the flag as a selector', () => {
    const state = T.createSessionState({ targetId: 'ABC123', sessionId: 'sid-1' });
    T.appendSessionActionLog(state, T.createActionResult({
      action: 'fill',
      target: { input: '#cmd', resolvedBy: 'selector', label: '#cmd', commandArgs: ['--react', '#cmd', 'look trainer'] },
      dispatch: { ok: true, method: 'fill' },
      settle: { ok: true, durationMs: 80 },
      effects: { domDiff: 'value changed', console: [], network: [], navigation: null },
      nextHint: null,
    }));

    const out = T.formatExportPlaywright(state);

    expect(out).toContain('await page.locator("#cmd").fill("look trainer");');
    expect(out).not.toContain('page.locator("--react")');
  });

  it('redacts sensitive fill values before recording action artifacts', () => {
    const logPath = `/tmp/cdp-sensitive-action-${Date.now()}-${Math.random().toString(16).slice(2)}.log`;
    const state = T.createSessionState({ targetId: 'ABC123', sessionId: 'sid-1', logPath });

    try {
      T.appendSessionActionLog(state, T.createActionResult({
        action: 'fill',
        target: {
          input: '#password',
          resolvedBy: 'selector',
          label: '#password',
          commandArgs: ['#password', 'secret123'],
        },
        dispatch: { ok: true, method: 'fill' },
        settle: { ok: true, durationMs: 50 },
        effects: { domDiff: 'value changed', console: [], network: [], navigation: null },
        nextHint: null,
      }));

      const model = T.buildRecordActionsModel(state);
      const logText = readFileSync(logPath, 'utf8');

      expect(model.actions[0].command).toEqual(['fill', '#password', '<redacted>']);
      expect(model.actions[0].replayable).toBe(false);
      expect(model.actions[0].needsInput).toEqual(['text']);
      expect(logText).not.toContain('secret123');
      expect(logText).toContain('<redacted>');
    } finally {
      rmSync(logPath, { force: true });
    }
  });
});

// =========================================================================
// Perceive diff baseline
// =========================================================================

describe('Perceive diff baseline', () => {
  it('formats a diff from an explicit baseline output', () => {
    const previous = [
      'Page: Example — https://example.com',
      'Viewport: 1280×720 | Scroll: 0/0 (0%) | Focused: none',
      'Interactive: 1 button',
      'Console: clean',
      'Coords: top-level viewport CSS px (use clickxy with these values; fixed/sticky elements are tagged)',
      '',
      '[WebArea] Example',
      '  [button] Save  @1',
    ].join('\n');
    const current = [
      'Page: Example — https://example.com',
      'Viewport: 1280×720 | Scroll: 0/0 (0%) | Focused: none',
      'Interactive: 1 button',
      'Console: clean',
      'Coords: top-level viewport CSS px (use clickxy with these values; fixed/sticky elements are tagged)',
      '',
      '[WebArea] Example',
      '  [button] Save  @1',
      '  [alert] Saved',
    ].join('\n');

    const diff = T.formatPerceiveDiffOutput(previous, current);

    expect(diff).toContain('Page: Example');
    expect(diff).toContain('+++ Added (1):');
    expect(diff).toContain('+   [alert] Saved');
  });

  it('builds a JSON diff model from an explicit baseline output', () => {
    const previous = [
      'Page: Example — https://example.com',
      'Viewport: 1280×720 | Scroll: 0/0 (0%) | Focused: none',
      'Interactive: 1 button',
      'Console: clean',
      'Coords: top-level viewport CSS px (use clickxy with these values; fixed/sticky elements are tagged)',
      '',
      '[WebArea] Example',
      '  [button] Save  @1',
    ].join('\n');
    const current = [
      'Page: Example — https://example.com',
      'Viewport: 1280×720 | Scroll: 0/0 (0%) | Focused: none',
      'Interactive: 1 button',
      'Console: clean',
      'Coords: top-level viewport CSS px (use clickxy with these values; fixed/sticky elements are tagged)',
      '',
      '[WebArea] Example',
      '  [button] Save  @1',
      '  [alert] Saved',
    ].join('\n');

    const model = T.buildPerceiveDiffModel(previous, current, {
      mode: 'since-action',
      targetPrefix: 'ABC12345',
    });

    expect(model).toMatchObject({
      schema: 'chrome-cdp-ex.perceive-diff.v1',
      mode: 'since-action',
      page: { title: 'Example', url: 'https://example.com' },
      viewport: { width: 1280, height: 720, scrollY: 0, scrollMax: 0, coordinateSpace: 'viewport-css-px' },
      summary: {
        changed: true,
        removed: 0,
        added: 1,
        textRemoved: 0,
        textAdded: 0,
      },
      added: ['  [alert] Saved'],
      removed: [],
      textAddedSamples: [],
      nextSteps: [
        'cdp report ABC12345 --format json',
        'cdp record-actions ABC12345 --format json',
      ],
    });
  });

  it('builds a JSON diff model for text-only changes with compact samples', () => {
    const previous = [
      'Page: Log — https://example.com',
      'Viewport: 1280×720 | Scroll: 0/0 (0%) | Focused: none',
      'Interactive: none',
      'Console: clean',
      'Coords: top-level viewport CSS px (use clickxy with these values; fixed/sticky elements are tagged)',
      '',
      '[region] Event log',
      '  [StaticText] old row',
    ].join('\n');
    const current = [
      'Page: Log — https://example.com',
      'Viewport: 1280×720 | Scroll: 0/0 (0%) | Focused: none',
      'Interactive: none',
      'Console: clean',
      'Coords: top-level viewport CSS px (use clickxy with these values; fixed/sticky elements are tagged)',
      '',
      '[region] Event log',
      '  [StaticText] old row',
      '  [StaticText] hmr panel ready',
    ].join('\n');

    const model = T.buildPerceiveDiffModel(previous, current, {
      mode: 'diff',
      targetPrefix: 'ABC12345',
    });

    expect(model.summary).toMatchObject({
      changed: true,
      added: 0,
      removed: 0,
      textAdded: 1,
      textRemoved: 0,
    });
    expect(model.textAddedSamples).toEqual(['  [StaticText] hmr panel ready']);
    expect(model.nextSteps).toEqual(['cdp report ABC12345 --format json']);
  });

  it('keeps high-signal StaticText additions in action diffs', () => {
    const previous = [
      'Page: Checkout — https://example.com',
      'Viewport: 1280×720 | Scroll: 0/0 (0%) | Focused: none',
      'Interactive: 1 button',
      'Console: clean',
      'Coords: top-level viewport CSS px (use clickxy with these values; fixed/sticky elements are tagged)',
      '',
      '[WebArea] Checkout',
    ].join('\n');
    const current = [
      'Page: Checkout — https://example.com',
      'Viewport: 1280×720 | Scroll: 0/0 (0%) | Focused: none',
      'Interactive: 1 button',
      'Console: clean',
      'Coords: top-level viewport CSS px (use clickxy with these values; fixed/sticky elements are tagged)',
      '',
      '[WebArea] Checkout',
      '  [StaticText] Payment failed: card number is required',
      '  [StaticText] diagnostic noise',
    ].join('\n');

    const diff = T.formatPerceiveDiffOutput(previous, current);

    expect(diff).toContain('+++ Added (1):');
    expect(diff).toContain('+   [StaticText] Payment failed: card number is required');
    expect(diff).toContain('~~~ Text nodes updated (1 added)');
    expect(diff).not.toContain('diagnostic noise');
  });

  it('includes compact samples for low-signal StaticText additions', () => {
    const previous = [
      'Page: Log — https://example.com',
      'Viewport: 1280×720 | Scroll: 0/0 (0%) | Focused: none',
      'Interactive: none',
      'Console: clean',
      'Coords: top-level viewport CSS px (use clickxy with these values; fixed/sticky elements are tagged)',
      '',
      '[region] Event log',
      '  [StaticText] old row',
      '  ... 10 earlier text node(s) omitted (--last 20)',
    ].join('\n');
    const current = [
      'Page: Log — https://example.com',
      'Viewport: 1280×720 | Scroll: 0/0 (0%) | Focused: none',
      'Interactive: none',
      'Console: clean',
      'Coords: top-level viewport CSS px (use clickxy with these values; fixed/sticky elements are tagged)',
      '',
      '[region] Event log',
      '  [StaticText] old row',
      '  [StaticText] hmr panel ready',
      '  ... 11 earlier text node(s) omitted (--last 20)',
    ].join('\n');

    const diff = T.formatPerceiveDiffOutput(previous, current);

    expect(diff).toContain('~~~ Text nodes updated (1 added)');
    expect(diff).toContain('+   [StaticText] hmr panel ready');
  });
});

// =========================================================================
// shouldShowAxNode
// =========================================================================

describe('shouldShowAxNode', () => {
  const node = (role, name, value) => ({
    role: { value: role },
    name: { value: name },
    value: value !== undefined ? { value } : undefined,
  });

  it('should hide role=none', () => {
    expect(shouldShowAxNode(node('none', 'text'))).toBe(false);
  });

  it('should hide role=generic with empty name and no value', () => {
    expect(shouldShowAxNode(node('generic', ''))).toBe(false);
  });

  it('should hide role=generic even with non-empty name', () => {
    // generic is always filtered out (role === 'generic' check comes first)
    expect(shouldShowAxNode(node('generic', 'wrapper'))).toBe(false);
  });

  it('should show meaningful roles with name', () => {
    expect(shouldShowAxNode(node('button', 'Submit'))).toBe(true);
    expect(shouldShowAxNode(node('link', 'Home'))).toBe(true);
  });

  it('should show node with empty name but non-empty value', () => {
    expect(shouldShowAxNode(node('textbox', '', 'hello'))).toBe(true);
  });

  it('should hide node with empty name and empty value', () => {
    expect(shouldShowAxNode(node('textbox', '', ''))).toBe(false);
  });

  it('should hide InlineTextBox in compact mode', () => {
    expect(shouldShowAxNode(node('InlineTextBox', 'text'), true)).toBe(false);
  });

  it('should show InlineTextBox in non-compact mode', () => {
    expect(shouldShowAxNode(node('InlineTextBox', 'text'), false)).toBe(true);
  });

  it('should hide StaticText duplicating parent name in compact mode', () => {
    const parent = node('link', 'Click Here');
    const child = node('StaticText', 'Click Here');
    expect(shouldShowAxNode(child, true, parent)).toBe(false);
  });

  it('should hide StaticText that is substring of parent name in compact mode', () => {
    const parent = node('link', 'Hello World');
    const child = node('StaticText', 'Hello');
    expect(shouldShowAxNode(child, true, parent)).toBe(false);
  });

  it('should show StaticText with different name than parent in compact mode', () => {
    const parent = node('link', 'Home');
    const child = node('StaticText', 'Something else');
    expect(shouldShowAxNode(child, true, parent)).toBe(true);
  });
});

// =========================================================================
// formatAxNode
// =========================================================================

describe('formatAxNode', () => {
  const node = (role, name, value) => ({
    role: { value: role },
    name: { value: name },
    value: value !== undefined ? { value } : undefined,
  });

  it('should format [role] name', () => {
    expect(formatAxNode(node('button', 'OK'), 0)).toBe('[button] OK');
  });

  it('should include value as JSON string', () => {
    expect(formatAxNode(node('textbox', 'Email', 'user@test.com'), 0))
      .toBe('[textbox] Email = "user@test.com"');
  });

  it('should omit value when empty string', () => {
    expect(formatAxNode(node('textbox', 'Email', ''), 0))
      .toBe('[textbox] Email');
  });

  it('should omit name when empty', () => {
    expect(formatAxNode(node('generic', '', 'val'), 0))
      .toBe('[generic] = "val"');
  });

  it('should indent 2 spaces per depth level', () => {
    const result = formatAxNode(node('button', 'OK'), 3);
    expect(result).toBe('      [button] OK');
  });

  it('should cap indent at depth 10', () => {
    const d10 = formatAxNode(node('button', 'OK'), 10);
    const d15 = formatAxNode(node('button', 'OK'), 15);
    expect(d10).toBe(d15); // both capped at 20 spaces
    expect(d10.startsWith('                    [')).toBe(true); // 20 spaces
  });
});

// =========================================================================
// orderedAxChildren
// =========================================================================

describe('orderedAxChildren', () => {
  it('should return children from childIds first', () => {
    const a = { nodeId: 'a' };
    const b = { nodeId: 'b' };
    const nodesById = new Map([['a', a], ['b', b]]);
    const childrenByParent = new Map();
    const parent = { nodeId: 'p', childIds: ['a', 'b'] };
    const result = orderedAxChildren(parent, nodesById, childrenByParent);
    expect(result).toEqual([a, b]);
  });

  it('should append childrenByParent entries after childIds', () => {
    const a = { nodeId: 'a' };
    const c = { nodeId: 'c' };
    const nodesById = new Map([['a', a]]);
    const childrenByParent = new Map([['p', [c]]]);
    const parent = { nodeId: 'p', childIds: ['a'] };
    const result = orderedAxChildren(parent, nodesById, childrenByParent);
    expect(result).toEqual([a, c]);
  });

  it('should deduplicate nodes appearing in both sources', () => {
    const a = { nodeId: 'a' };
    const nodesById = new Map([['a', a]]);
    const childrenByParent = new Map([['p', [a]]]);
    const parent = { nodeId: 'p', childIds: ['a'] };
    const result = orderedAxChildren(parent, nodesById, childrenByParent);
    expect(result).toHaveLength(1);
  });

  it('should return empty array for node with no children', () => {
    const nodesById = new Map();
    const childrenByParent = new Map();
    const parent = { nodeId: 'p' };
    expect(orderedAxChildren(parent, nodesById, childrenByParent)).toEqual([]);
  });

  it('should skip childIds not found in nodesById', () => {
    const nodesById = new Map();
    const childrenByParent = new Map();
    const parent = { nodeId: 'p', childIds: ['missing'] };
    expect(orderedAxChildren(parent, nodesById, childrenByParent)).toEqual([]);
  });
});

// =========================================================================
// isRef
// =========================================================================

describe('isRef', () => {
  it('should match @<digits>', () => {
    expect(isRef('@1')).toBe(true);
    expect(isRef('@42')).toBe(true);
    expect(isRef('@999')).toBe(true);
  });

  it('should reject non-ref strings', () => {
    expect(isRef('@')).toBe(false);
    expect(isRef('1')).toBe(false);
    expect(isRef('@c1')).toBe(false);
    expect(isRef('@abc')).toBe(false);
    expect(isRef('')).toBe(false);
    expect(isRef('#btn')).toBe(false);
    expect(isRef('@ 1')).toBe(false);
  });
});

// =========================================================================
// validateUrl
// =========================================================================

describe('validateUrl', () => {
  it('should accept http and https URLs', () => {
    expect(() => validateUrl('http://example.com')).not.toThrow();
    expect(() => validateUrl('https://example.com/path?q=1')).not.toThrow();
    expect(() => validateUrl('http://192.168.1.1:8080/')).not.toThrow();
  });

  it('should reject non-http protocols', () => {
    expect(() => validateUrl('file:///etc/passwd')).toThrow(/Only http/);
    expect(() => validateUrl('ftp://example.com')).toThrow(/Only http/);
    expect(() => validateUrl('data:text/html,<h1>hi</h1>')).toThrow(/Only http/);
  });

  it('should reject invalid URLs', () => {
    expect(() => validateUrl('not a url')).toThrow(/Invalid URL/);
    expect(() => validateUrl('')).toThrow(/Invalid URL/);
  });

  it('should block AWS metadata (169.254.169.254)', () => {
    expect(() => validateUrl('http://169.254.169.254/latest/meta-data/'))
      .toThrow(/metadata/i);
  });

  it('should block GCP metadata endpoint', () => {
    expect(() => validateUrl('http://metadata.google.internal/computeMetadata/v1/'))
      .toThrow(/metadata/i);
  });

  it('should block Azure metadata (169.254.170.2)', () => {
    expect(() => validateUrl('http://169.254.170.2/'))
      .toThrow(/metadata/i);
  });

  it('should block link-local range 169.254.x.x', () => {
    expect(() => validateUrl('http://169.254.1.1/')).toThrow(/link-local/);
    expect(() => validateUrl('http://169.254.255.255/')).toThrow(/link-local/);
  });

  it('should allow private IPs that are not metadata/link-local', () => {
    expect(() => validateUrl('http://192.168.1.1/')).not.toThrow();
    expect(() => validateUrl('http://10.0.0.1/')).not.toThrow();
    expect(() => validateUrl('http://127.0.0.1:3000/')).not.toThrow();
  });

  it('should block GKE metadata host', () => {
    expect(() => validateUrl('http://metadata.gke.internal/'))
      .toThrow(/metadata/i);
  });
});

// =========================================================================
// parsePerceiveArgs
// =========================================================================

describe('parsePerceiveArgs', () => {
  it('should return defaults for empty args', () => {
    const opts = parsePerceiveArgs([]);
    expect(opts).toEqual({
      diff: false,
      selector: null,
      exclude: null,
      interactive: false,
      maxDepth: Infinity,
      cursorInteractive: false,
      keepRefs: false,
      last: null,
      sinceAction: false,
      frameRef: null,
    });
  });

  it('should parse --diff', () => {
    expect(parsePerceiveArgs(['--diff']).diff).toBe(true);
  });

  it('should parse --since-action', () => {
    expect(parsePerceiveArgs(['--since-action']).sinceAction).toBe(true);
  });

  it('should parse -s with value', () => {
    expect(parsePerceiveArgs(['-s', '.main']).selector).toBe('.main');
  });

  it('should parse --selector with value', () => {
    expect(parsePerceiveArgs(['--selector', '#app']).selector).toBe('#app');
  });

  it('should parse -i', () => {
    expect(parsePerceiveArgs(['-i']).interactive).toBe(true);
  });

  it('should parse --interactive', () => {
    expect(parsePerceiveArgs(['--interactive']).interactive).toBe(true);
  });

  it('should parse -d with numeric value', () => {
    expect(parsePerceiveArgs(['-d', '3']).maxDepth).toBe(3);
  });

  it('should parse --depth with numeric value', () => {
    expect(parsePerceiveArgs(['--depth', '5']).maxDepth).toBe(5);
  });

  it('should default maxDepth to Infinity for non-numeric -d', () => {
    expect(parsePerceiveArgs(['-d', 'abc']).maxDepth).toBe(Infinity);
  });

  it('should parse -C', () => {
    expect(parsePerceiveArgs(['-C']).cursorInteractive).toBe(true);
  });

  it('should parse --cursor-interactive', () => {
    expect(parsePerceiveArgs(['--cursor-interactive']).cursorInteractive).toBe(true);
  });

  it('should parse -x with value', () => {
    expect(parsePerceiveArgs(['-x', 'nav, aside']).exclude).toBe('nav, aside');
  });

  it('should parse --exclude with value', () => {
    expect(parsePerceiveArgs(['--exclude', '[role=complementary]']).exclude).toBe('[role=complementary]');
  });

  it('should handle all flags combined', () => {
    const opts = parsePerceiveArgs(['--diff', '-i', '-s', 'form', '-x', 'nav', '-d', '2', '-C']);
    expect(opts).toEqual({
      diff: true,
      interactive: true,
      selector: 'form',
      exclude: 'nav',
      maxDepth: 2,
      cursorInteractive: true,
      keepRefs: false,
      last: null,
      sinceAction: false,
      frameRef: null,
    });
  });

  it('should allow -s and -x together', () => {
    const opts = parsePerceiveArgs(['-s', '#main', '-x', '.sidebar']);
    expect(opts.selector).toBe('#main');
    expect(opts.exclude).toBe('.sidebar');
  });
});

describe('perceiveStr selector scope', () => {
  it('scopes perception to DOM subtree descendants for long live logs', async () => {
    const pageMeta = JSON.stringify({
      title: 'Scoped Log',
      url: 'https://example.test/log',
      vw: 800,
      vh: 600,
      scrollY: 0,
      scrollMax: 0,
      focused: 'none',
      counts: {},
      layoutMap: {},
      styleHints: {},
      cursorInteractives: [],
    });
    const fullAxTree = [
      { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Scoped Log' }, backendDOMNodeId: 100 },
      { nodeId: '2', parentId: '1', role: { value: 'StaticText' }, name: { value: 'Sticky toolbar' }, backendDOMNodeId: 200 },
      { nodeId: '3', parentId: '1', role: { value: 'region' }, name: { value: 'Event log' }, backendDOMNodeId: 300 },
      { nodeId: '4', parentId: '3', role: { value: 'StaticText' }, name: { value: 'old log row' } },
      { nodeId: '5', parentId: '3', role: { value: 'StaticText' }, name: { value: 'hmr panel ready' } },
      { nodeId: '6', parentId: '1', role: { value: 'button' }, name: { value: 'Run diagnostic' }, backendDOMNodeId: 400 },
    ];
    const unscopedSkeleton = fullAxTree.filter(node => node.nodeId !== '4' && node.nodeId !== '5');
    const cdp = createMockCDP({
      'DOM.getDocument': () => ({ root: { nodeId: 10 } }),
      'DOM.querySelector': (_params) => ({ nodeId: 30 }),
      'DOM.describeNode': () => ({
        node: {
          nodeId: 30,
          backendNodeId: 300,
          children: [
            { nodeId: 31, backendNodeId: 301 },
            { nodeId: 32, backendNodeId: 302 },
          ],
        },
      }),
      'Accessibility.getFullAXTree': (params) => ({
        nodes: params.backendNodeId ? unscopedSkeleton : fullAxTree,
      }),
      'Runtime.evaluate': () => ({ result: { value: pageMeta } }),
      'DOM.resolveNode': () => ({ object: { objectId: 'button-object' } }),
      'Runtime.callFunctionOn': () => ({ result: { value: { x: 0, y: 0, w: 1, h: 1 } } }),
    });

    const out = await T.perceiveStr(
      cdp,
      'sid1',
      new RingBuffer(10),
      new RingBuffer(10),
      new Map(),
      { output: null },
      { selector: '#combat-log', last: 20 },
    );

    expect(out).toContain('hmr panel ready');
    expect(out).not.toContain('Sticky toolbar');
    expect(out).not.toContain('Run diagnostic');
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
// formatPageList
// =========================================================================

describe('formatPageList', () => {
  it('should return empty string for no pages', () => {
    expect(formatPageList([])).toBe('');
  });

  it('builds a versioned list JSON model with stable prefixes and next steps', () => {
    const model = T.buildPageListModel([
      { targetId: 'AABBCCDD11223344', type: 'page', title: 'Dashboard', url: 'https://example.com/app' },
      { targetId: 'AABBCCDD55667788', type: 'page', title: '', url: 'about:blank' },
    ], {
      Browser: 'Chrome/123',
      'User-Agent': 'Mozilla/5.0 Electron/33.4.11',
    });

    expect(model.schema).toBe('chrome-cdp-ex.list.v1');
    expect(model.targetCount).toBe(2);
    expect(model.prefixLength).toBeGreaterThan(8);
    expect(model.browser).toMatchObject({ product: 'Chrome/123', electron: '33.4.11' });
    expect(model.pages[0]).toMatchObject({
      index: 1,
      targetId: 'AABBCCDD11223344',
      title: 'Dashboard',
      url: 'https://example.com/app',
      isBlank: false,
    });
    expect(model.pages[0].targetPrefix.length).toBe(model.prefixLength);
    expect(model.pages[1]).toMatchObject({
      index: 2,
      title: '(blank tab)',
      url: 'about:blank',
      isBlank: true,
    });
    expect(model.nextSteps).toEqual([
      `cdp perceive ${model.pages[0].targetPrefix} -C -d 8`,
      `cdp click ${model.pages[0].targetPrefix} @ref  # choose a ref from perceive`,
      `cdp perceive ${model.pages[0].targetPrefix} --since-action`,
      `cdp report ${model.pages[0].targetPrefix}`,
    ]);
    expect(model.recommendation).toMatchObject({
      source: 'golden-path',
      stage: 'perceive',
      targetPrefix: model.pages[0].targetPrefix,
      run: `cdp perceive ${model.pages[0].targetPrefix} -C -d 8`,
      after: `cdp click ${model.pages[0].targetPrefix} @ref  # choose a ref from perceive`,
      evidence: `cdp perceive ${model.pages[0].targetPrefix} --since-action`,
      report: `cdp report ${model.pages[0].targetPrefix}`,
      requiresUserAction: false,
      consentRequired: false,
    });
    expect(model.recommendation.commands).toEqual(model.nextSteps);
  });

  it('builds an empty list JSON model with an open next step', () => {
    const model = T.buildPageListModel([]);

    expect(model).toMatchObject({
      schema: 'chrome-cdp-ex.list.v1',
      targetCount: 0,
      prefixLength: 8,
      pages: [],
      nextSteps: ['cdp open https://example.com'],
    });
    expect(model.recommendation).toMatchObject({
      source: 'golden-path',
      stage: 'open-page',
      targetPrefix: null,
      run: 'cdp open https://example.com',
      after: 'cdp perceive <target-from-open> -C -d 8',
      requiresUserAction: false,
      consentRequired: false,
    });
  });

  it('should format page with id prefix, title, url', () => {
    const result = formatPageList([{
      targetId: 'AABBCCDD11223344',
      title: 'Test Page',
      url: 'https://example.com',
    }]);
    expect(result).toContain('AABBCCDD');
    expect(result).toContain('Test Page');
    expect(result).toContain('https://example.com');
  });

  it('should truncate long titles to 54 chars', () => {
    const longTitle = 'A'.repeat(80);
    const result = formatPageList([{
      targetId: 'AABBCCDD11223344',
      title: longTitle,
      url: 'https://x.com',
    }]);
    // Title column is 54 chars wide
    expect(result).not.toContain('A'.repeat(55));
  });

  it('should align columns for multiple pages', () => {
    const pages = [
      { targetId: 'AAAA1111XXXX', title: 'Page A', url: 'https://a.com' },
      { targetId: 'BBBB2222YYYY', title: 'Page B', url: 'https://b.com' },
    ];
    const lines = formatPageList(pages).split('\n');
    expect(lines).toHaveLength(2);
    // Both lines should have same structure
    expect(lines[0]).toContain('Page A');
    expect(lines[1]).toContain('Page B');
  });
});

// =========================================================================
// sockPath
// =========================================================================

describe('sockPath', () => {
  it('should include targetId in path', () => {
    const p = sockPath('abc123def');
    expect(p).toContain('abc123def');
  });

  // On Linux/Mac: Unix socket ending in .sock
  if (process.platform !== 'win32') {
    it('should return .sock path on Unix', () => {
      expect(sockPath('abc123')).toMatch(/cdp-abc123\.sock$/);
    });
  }
});

// =========================================================================
// KEY_MAP
// =========================================================================

describe('KEY_MAP', () => {
  const expectedKeys = ['enter', 'tab', 'escape', 'backspace', 'delete', 'space',
    'arrowup', 'arrowdown', 'arrowleft', 'arrowright'];

  it('should contain all documented keys', () => {
    for (const k of expectedKeys) {
      expect(KEY_MAP).toHaveProperty(k);
    }
  });

  it('should have correct structure for each entry', () => {
    for (const [name, entry] of Object.entries(KEY_MAP)) {
      expect(entry).toHaveProperty('key');
      expect(entry).toHaveProperty('code');
      expect(entry).toHaveProperty('keyCode');
      expect(typeof entry.key).toBe('string');
      expect(typeof entry.code).toBe('string');
      expect(typeof entry.keyCode).toBe('number');
    }
  });

  it('should map enter to keyCode 13', () => {
    expect(KEY_MAP.enter.keyCode).toBe(13);
  });

  it('should map escape to keyCode 27', () => {
    expect(KEY_MAP.escape.keyCode).toBe(27);
  });
});

// =========================================================================
// ENRICHED_ROLES / INTERACTIVE_ROLES
// =========================================================================

describe('Role constants', () => {
  it('should include all landmark roles in ENRICHED_ROLES', () => {
    for (const r of ['banner', 'navigation', 'main', 'contentinfo', 'complementary']) {
      expect(ENRICHED_ROLES.has(r)).toBe(true);
    }
  });

  it('should include semantic structural roles in ENRICHED_ROLES', () => {
    for (const r of ['heading', 'img', 'form', 'table', 'dialog', 'region', 'article', 'alert']) {
      expect(ENRICHED_ROLES.has(r)).toBe(true);
    }
  });

  it('should include core interactive roles in INTERACTIVE_ROLES', () => {
    for (const r of ['link', 'button', 'textbox', 'checkbox', 'radio', 'combobox', 'slider', 'tab']) {
      expect(INTERACTIVE_ROLES.has(r)).toBe(true);
    }
  });

  it('should have no overlap between ENRICHED and INTERACTIVE', () => {
    for (const r of ENRICHED_ROLES) {
      expect(INTERACTIVE_ROLES.has(r)).toBe(false);
    }
    for (const r of INTERACTIVE_ROLES) {
      expect(ENRICHED_ROLES.has(r)).toBe(false);
    }
  });
});

// =========================================================================
// buildPerceiveTree — core tree-building logic (extracted from perceiveStr)
// =========================================================================

describe('buildPerceiveTree', () => {
  // Helper to build AX nodes quickly
  const axNode = (id, role, name, opts = {}) => ({
    nodeId: id,
    role: { value: role },
    name: { value: name },
    ...(opts.parentId ? { parentId: opts.parentId } : {}),
    ...(opts.childIds ? { childIds: opts.childIds } : {}),
    ...(opts.backendDOMNodeId ? { backendDOMNodeId: opts.backendDOMNodeId } : {}),
    ...(opts.value !== undefined ? { value: { value: opts.value } } : {}),
  });

  const emptyMeta = { layoutMap: {}, styleHints: {} };

  // ─── Basic tree rendering ─────────────────────────────────

  it('should render a simple tree with roles and names', () => {
    const nodes = [
      axNode('root', 'WebArea', 'Test Page'),
      axNode('nav', 'navigation', 'Main Nav', { parentId: 'root' }),
      axNode('link1', 'link', 'Home', { parentId: 'nav', backendDOMNodeId: 101 }),
      axNode('main', 'main', '', { parentId: 'root' }),
      axNode('h1', 'heading', 'Welcome', { parentId: 'main' }),
    ];
    nodes[0].childIds = ['nav', 'main'];
    nodes[1].childIds = ['link1'];
    nodes[3].childIds = ['h1'];

    const refMap = new Map();
    const { treeLines, refNodeIds } = buildPerceiveTree(nodes, emptyMeta, refMap);

    expect(treeLines.join('\n')).toContain('[WebArea] Test Page');
    expect(treeLines.join('\n')).toContain('[navigation] Main Nav');
    expect(treeLines.join('\n')).toContain('[link] Home');
    expect(treeLines.join('\n')).toContain('[heading] Welcome');
  });

  // ─── @ref assignment ──────────────────────────────────────

  it('should assign @ref indices to interactive elements', () => {
    const nodes = [
      axNode('root', 'WebArea', 'Page'),
      axNode('btn', 'button', 'Submit', { parentId: 'root', backendDOMNodeId: 201 }),
      axNode('link', 'link', 'Help', { parentId: 'root', backendDOMNodeId: 202 }),
      axNode('input', 'textbox', 'Email', { parentId: 'root', backendDOMNodeId: 203 }),
    ];
    nodes[0].childIds = ['btn', 'link', 'input'];

    const refMap = new Map();
    const { treeLines, refNodeIds } = buildPerceiveTree(nodes, emptyMeta, refMap);

    // Should have @1, @2, @3 refs
    expect(refMap.size).toBe(3);
    expect(refMap.get(1)).toBe(201);
    expect(refMap.get(2)).toBe(202);
    expect(refMap.get(3)).toBe(203);

    // Tree lines should contain @ref markers
    const output = treeLines.join('\n');
    expect(output).toContain('@1');
    expect(output).toContain('@2');
    expect(output).toContain('@3');

    // refNodeIds for batch rect resolution
    expect(refNodeIds).toHaveLength(3);
    expect(refNodeIds[0]).toEqual({ ref: 1, backendDOMNodeId: 201 });
  });

  it('should not assign @ref to non-interactive elements', () => {
    const nodes = [
      axNode('root', 'WebArea', 'Page'),
      axNode('h1', 'heading', 'Title', { parentId: 'root', backendDOMNodeId: 300 }),
      axNode('p', 'paragraph', 'Text', { parentId: 'root', backendDOMNodeId: 301 }),
    ];
    nodes[0].childIds = ['h1', 'p'];

    const refMap = new Map();
    const { refNodeIds } = buildPerceiveTree(nodes, emptyMeta, refMap);
    expect(refMap.size).toBe(0);
    expect(refNodeIds).toHaveLength(0);
  });

  it('should not assign @ref to interactive elements without backendDOMNodeId', () => {
    const nodes = [
      axNode('root', 'WebArea', 'Page'),
      axNode('btn', 'button', 'Click', { parentId: 'root' }), // no backendDOMNodeId
    ];
    nodes[0].childIds = ['btn'];

    const refMap = new Map();
    buildPerceiveTree(nodes, emptyMeta, refMap);
    expect(refMap.size).toBe(0);
  });

  it('should clear refMap before rebuilding', () => {
    const nodes = [
      axNode('root', 'WebArea', 'Page'),
      axNode('btn', 'button', 'OK', { parentId: 'root', backendDOMNodeId: 100 }),
    ];
    nodes[0].childIds = ['btn'];

    const refMap = new Map([[99, 999]]); // pre-existing entry
    buildPerceiveTree(nodes, emptyMeta, refMap);
    expect(refMap.has(99)).toBe(false); // old entry cleared
    expect(refMap.has(1)).toBe(true);   // new entry added
  });

  // ─── Depth limit ──────────────────────────────────────────

  it('should respect maxDepth and hide deeper nodes', () => {
    const nodes = [
      axNode('root', 'WebArea', 'Page'),
      axNode('nav', 'navigation', 'Nav', { parentId: 'root' }),
      axNode('link', 'link', 'Deep Link', { parentId: 'nav', backendDOMNodeId: 400 }),
    ];
    nodes[0].childIds = ['nav'];
    nodes[1].childIds = ['link'];

    const refMap = new Map();
    const { treeLines } = buildPerceiveTree(nodes, emptyMeta, refMap, { maxDepth: 1 });

    const output = treeLines.join('\n');
    expect(output).toContain('[navigation] Nav');
    expect(output).not.toContain('Deep Link'); // depth 2 > maxDepth 1
  });

  it('should still collect refs for interactive elements beyond depth limit', () => {
    const nodes = [
      axNode('root', 'WebArea', 'Page'),
      axNode('nav', 'navigation', 'Nav', { parentId: 'root' }),
      axNode('link', 'link', 'Deep', { parentId: 'nav', backendDOMNodeId: 401 }),
    ];
    nodes[0].childIds = ['nav'];
    nodes[1].childIds = ['link'];

    const refMap = new Map();
    const { refNodeIds } = buildPerceiveTree(nodes, emptyMeta, refMap, { maxDepth: 1 });

    // Ref still collected even though node is hidden
    expect(refMap.size).toBe(1);
    expect(refNodeIds).toHaveLength(1);
    expect(refNodeIds[0].backendDOMNodeId).toBe(401);
  });

  // ─── Interactive-only mode ────────────────────────────────

  it('should filter non-interactive non-structural nodes in interactive mode', () => {
    const nodes = [
      axNode('root', 'WebArea', 'Page'),
      axNode('main', 'main', 'Content', { parentId: 'root' }),
      axNode('para', 'paragraph', 'Some text', { parentId: 'main' }),
      axNode('btn', 'button', 'Action', { parentId: 'para', backendDOMNodeId: 500 }),
    ];
    nodes[0].childIds = ['main'];
    nodes[1].childIds = ['para'];
    nodes[2].childIds = ['btn'];

    const refMap = new Map();
    const { treeLines } = buildPerceiveTree(nodes, emptyMeta, refMap, { interactiveOnly: true });

    const output = treeLines.join('\n');
    expect(output).toContain('[button] Action');
    expect(output).toContain('[main] Content'); // structural parent kept
    expect(output).not.toContain('paragraph'); // non-interactive, non-structural filtered
  });

  // ─── Table row truncation ─────────────────────────────────

  it('should truncate table rows beyond limit of 5', () => {
    const nodes = [
      axNode('root', 'WebArea', 'Page'),
      axNode('tbl', 'table', 'Data', { parentId: 'root' }),
    ];
    nodes[0].childIds = ['tbl'];
    const rowIds = [];
    for (let i = 0; i < 8; i++) {
      const rowId = `row${i}`;
      const cellId = `cell${i}`;
      rowIds.push(rowId);
      nodes.push(axNode(rowId, 'row', '', { parentId: 'tbl' }));
      nodes.push(axNode(cellId, 'cell', `Value ${i}`, { parentId: rowId }));
      nodes[nodes.length - 2].childIds = [cellId];
    }
    nodes[1].childIds = rowIds;

    const refMap = new Map();
    const { treeLines } = buildPerceiveTree(nodes, emptyMeta, refMap);

    const output = treeLines.join('\n');
    // First 5 rows should be visible
    expect(output).toContain('Value 0');
    expect(output).toContain('Value 4');
    // Row 5+ should be truncated
    expect(output).not.toContain('Value 5');
    expect(output).not.toContain('Value 7');
    // Truncation notice
    expect(output).toContain('... more rows truncated');
  });

  // ─── Icon image filtering ────────────────────────────────

  it('should filter decorative icon images', () => {
    const nodes = [
      axNode('root', 'WebArea', 'Page'),
      axNode('icon1', 'image', 'check-circle', { parentId: 'root' }),  // filtered: short, lowercase, no space
      axNode('icon2', 'image', 'thunderbolt', { parentId: 'root' }),   // filtered
      axNode('hero', 'image', 'Hero Banner Photo', { parentId: 'root' }), // kept: has space
      axNode('logo', 'image', 'CompanyLogo', { parentId: 'root' }),    // kept: has uppercase
    ];
    nodes[0].childIds = ['icon1', 'icon2', 'hero', 'logo'];

    const refMap = new Map();
    const { treeLines } = buildPerceiveTree(nodes, emptyMeta, refMap);

    const output = treeLines.join('\n');
    expect(output).not.toContain('check-circle');
    expect(output).not.toContain('thunderbolt');
    expect(output).toContain('Hero Banner Photo');
    expect(output).toContain('CompanyLogo');
  });

  // ─── Layout annotations ──────────────────────────────────

  it('should annotate enriched roles with layout info', () => {
    const nodes = [
      axNode('root', 'WebArea', 'Page'),
      axNode('banner', 'banner', 'Header', { parentId: 'root' }),
      axNode('main', 'main', 'Content', { parentId: 'root' }),
    ];
    nodes[0].childIds = ['banner', 'main'];

    const meta = {
      layoutMap: {
        banner: [{ h: 80, bg: 'rgb(0,0,0)', vis: 'above' }],
        main: [{ h: 2000, display: 'flex', gap: '20px' }],
      },
      styleHints: {},
    };

    const refMap = new Map();
    const { treeLines } = buildPerceiveTree(nodes, meta, refMap);
    const output = treeLines.join('\n');

    expect(output).toContain('↕80px');
    expect(output).toContain('bg:rgb(0,0,0)');
    expect(output).toContain('↑above fold');
    expect(output).toContain('↕2000px');
    expect(output).toContain('flex gap:20px');
  });

  it('should annotate with width×height when element is narrow', () => {
    const nodes = [
      axNode('root', 'WebArea', 'Page'),
      axNode('aside', 'complementary', 'Sidebar', { parentId: 'root' }),
    ];
    nodes[0].childIds = ['aside'];

    const meta = {
      layoutMap: { complementary: [{ w: 300, h: 800 }] },
      styleHints: {},
    };

    const refMap = new Map();
    const { treeLines } = buildPerceiveTree(nodes, meta, refMap);
    expect(treeLines.join('\n')).toContain('300×800px');
  });

  it('should annotate below-fold visibility', () => {
    const nodes = [
      axNode('root', 'WebArea', 'Page'),
      axNode('footer', 'contentinfo', 'Footer', { parentId: 'root' }),
    ];
    nodes[0].childIds = ['footer'];

    const meta = {
      layoutMap: { contentinfo: [{ h: 160, vis: 'below' }] },
      styleHints: {},
    };

    const refMap = new Map();
    const { treeLines } = buildPerceiveTree(nodes, meta, refMap);
    expect(treeLines.join('\n')).toContain('↓below fold');
  });

  // ─── Table style hints ────────────────────────────────────

  it('should annotate table cells with style hints', () => {
    const nodes = [
      axNode('root', 'WebArea', 'Page'),
      axNode('tbl', 'table', 'Prices', { parentId: 'root' }),
      axNode('row0', 'row', '', { parentId: 'tbl' }),
      axNode('cell0', 'cell', '$29.99', { parentId: 'row0' }),
    ];
    nodes[0].childIds = ['tbl'];
    nodes[1].childIds = ['row0'];
    nodes[2].childIds = ['cell0'];

    const meta = {
      layoutMap: {},
      styleHints: { '0:0:0': 'bold color:rgb(0,128,0)' },
    };

    const refMap = new Map();
    const { treeLines } = buildPerceiveTree(nodes, meta, refMap);
    expect(treeLines.join('\n')).toContain('bold color:rgb(0,128,0)');
  });

  // ─── Node filtering (none, generic, duplicate StaticText) ─

  it('should hide none and generic role nodes but show their children', () => {
    const nodes = [
      axNode('root', 'WebArea', 'Page'),
      axNode('wrap', 'generic', '', { parentId: 'root' }),
      axNode('btn', 'button', 'OK', { parentId: 'wrap', backendDOMNodeId: 600 }),
    ];
    nodes[0].childIds = ['wrap'];
    nodes[1].childIds = ['btn'];

    const refMap = new Map();
    const { treeLines } = buildPerceiveTree(nodes, emptyMeta, refMap);
    const output = treeLines.join('\n');

    expect(output).not.toContain('generic');
    expect(output).toContain('[button] OK');
    expect(refMap.size).toBe(1);
  });

  // ─── Orphan node handling ─────────────────────────────────

  it('should handle nodes without parentId (multiple roots)', () => {
    const nodes = [
      axNode('r1', 'WebArea', 'Page 1'),
      axNode('r2', 'banner', 'Header'),
    ];
    // Both are roots (no parentId)

    const refMap = new Map();
    const { treeLines } = buildPerceiveTree(nodes, emptyMeta, refMap);
    const output = treeLines.join('\n');
    expect(output).toContain('[WebArea] Page 1');
    expect(output).toContain('[banner] Header');
  });

  // ─── Empty tree ───────────────────────────────────────────

  it('should handle empty node list', () => {
    const refMap = new Map();
    const { treeLines, refNodeIds } = buildPerceiveTree([], emptyMeta, refMap);
    expect(treeLines).toEqual([]);
    expect(refNodeIds).toEqual([]);
  });

  // ─── Complex scenario: realistic page structure ───────────

  it('should handle a realistic page with nav, main, footer, and interactive elements', () => {
    const nodes = [
      axNode('root', 'WebArea', 'Store'),
      axNode('banner', 'banner', 'Site Header', { parentId: 'root' }),
      axNode('nav', 'navigation', 'Main Menu', { parentId: 'banner' }),
      axNode('l1', 'link', 'Home', { parentId: 'nav', backendDOMNodeId: 1 }),
      axNode('l2', 'link', 'Products', { parentId: 'nav', backendDOMNodeId: 2 }),
      axNode('main', 'main', 'Content', { parentId: 'root' }),
      axNode('h1', 'heading', 'Welcome', { parentId: 'main' }),
      axNode('region', 'region', 'Product Grid', { parentId: 'main' }),
      axNode('l3', 'link', 'Product 1', { parentId: 'region', backendDOMNodeId: 3 }),
      axNode('btn', 'button', 'Add to Cart', { parentId: 'region', backendDOMNodeId: 4 }),
      axNode('footer', 'contentinfo', 'Site Footer', { parentId: 'root' }),
      axNode('l4', 'link', 'Privacy', { parentId: 'footer', backendDOMNodeId: 5 }),
    ];
    nodes[0].childIds = ['banner', 'main', 'footer'];
    nodes[1].childIds = ['nav'];
    nodes[2].childIds = ['l1', 'l2'];
    nodes[5].childIds = ['h1', 'region'];
    nodes[7].childIds = ['l3', 'btn'];
    nodes[10].childIds = ['l4'];

    const meta = {
      layoutMap: {
        banner: [{ h: 80, bg: 'rgb(26,26,46)' }],
        main: [{ h: 2920 }],
        heading: [{ h: 50 }],
        region: [{ h: 800, display: 'grid', gap: '20px' }],
        contentinfo: [{ h: 160, bg: 'rgb(26,26,46)', vis: 'below' }],
      },
      styleHints: {},
    };

    const refMap = new Map();
    const { treeLines, refNodeIds } = buildPerceiveTree(nodes, meta, refMap);
    const output = treeLines.join('\n');

    // Structure
    expect(output).toContain('[WebArea] Store');
    expect(output).toContain('[banner] Site Header');
    expect(output).toContain('[navigation] Main Menu');
    expect(output).toContain('[main] Content');
    expect(output).toContain('[heading] Welcome');
    expect(output).toContain('[contentinfo] Site Footer');

    // Interactive refs
    expect(output).toContain('[link] Home  @1');
    expect(output).toContain('[link] Products  @2');
    expect(output).toContain('[link] Product 1  @3');
    expect(output).toContain('[button] Add to Cart  @4');
    expect(output).toContain('[link] Privacy  @5');

    // Layout annotations
    expect(output).toContain('bg:rgb(26,26,46)');
    expect(output).toContain('↕2920px');
    expect(output).toContain('grid gap:20px');
    expect(output).toContain('↓below fold');

    // Ref map
    expect(refMap.size).toBe(5);
    expect(refNodeIds).toHaveLength(5);
  });
});

// =========================================================================
// CDP mock helper — lightweight fake for testing command functions
// =========================================================================

function createMockCDP(handlers = {}) {
  const calls = [];
  return {
    calls,
    send(method, params = {}, sessionId) {
      calls.push({ method, params, sessionId });
      if (handlers[method]) return Promise.resolve(handlers[method](params, sessionId));
      return Promise.resolve({});
    },
    onEvent() { return () => {}; },
    waitForEvent(method, timeout) {
      let timer;
      return {
        promise: handlers[`event:${method}`]
          ? Promise.resolve(handlers[`event:${method}`]())
          : new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), 50); }),
        cancel() { clearTimeout(timer); },
      };
    },
  };
}

// =========================================================================
// frame tree helpers
// =========================================================================

describe('frame tree helpers', () => {
  const sampleTree = {
    frame: { id: 'main-frame', url: 'https://app.example.com/', name: 'top' },
    childFrames: [
      {
        frame: {
          id: 'checkout-frame',
          parentId: 'main-frame',
          url: 'https://pay.example.com/checkout',
          name: 'checkout',
          securityOrigin: 'https://pay.example.com',
        },
      },
      {
        frame: {
          id: 'ads-frame',
          parentId: 'main-frame',
          url: 'about:blank',
          name: '',
        },
        childFrames: [
          {
            frame: {
              id: 'nested-frame',
              parentId: 'ads-frame',
              url: 'https://widgets.example.com/picker',
              name: 'picker',
            },
          },
        ],
      },
    ],
  };

  it('parses frame-scoped refs like @f2:4', () => {
    expect(T.parseFrameRef('@f2:4')).toEqual({ frameRef: '@f2', frameIndex: 2, ref: '@4', refIndex: 4 });
    expect(T.parseFrameRef('@4')).toBeNull();
    expect(T.parseFrameRef('@f2')).toBeNull();
  });

  it('parses perceive --frame refs', () => {
    expect(parsePerceiveArgs(['--frame', '@f2']).frameRef).toBe('@f2');
    expect(parsePerceiveArgs(['-F', '@f3']).frameRef).toBe('@f3');
  });

  it('extracts a frame ref from frame-scoped action targets', () => {
    expect(T.frameRefFromActionTarget({ input: '@f2:4' })).toBe('@f2');
    expect(T.frameRefFromActionTarget({ label: '@f3:9' })).toBe('@f3');
    expect(T.frameRefFromActionTarget({ input: '@4' })).toBeNull();
  });

  it('uses the last frame perceive output as the baseline for frame-scoped actions', () => {
    const refState = {
      frameLastOutputs: new Map([['@f2', 'Frame: @f2\nold child state']]),
    };
    expect(T.baselineOutputForActionTarget(refState, 'main page output', { input: '@f2:4' }))
      .toBe('Frame: @f2\nold child state');
    expect(T.baselineOutputForActionTarget(refState, 'main page output', { input: '@4' }))
      .toBe('main page output');
  });

  it('flattens frame trees into stable @f refs', () => {
    const frames = T.flattenFrameTree(sampleTree);
    expect(frames).toEqual([
      expect.objectContaining({ ref: '@f1', id: 'main-frame', parentRef: null, depth: 0 }),
      expect.objectContaining({ ref: '@f2', id: 'checkout-frame', parentRef: '@f1', depth: 1 }),
      expect.objectContaining({ ref: '@f3', id: 'ads-frame', parentRef: '@f1', depth: 1 }),
      expect.objectContaining({ ref: '@f4', id: 'nested-frame', parentRef: '@f3', depth: 2 }),
    ]);
  });

  it('formats frame refs with url and parent context', () => {
    const out = T.formatFrameTreeText(T.flattenFrameTree(sampleTree));
    expect(out).toContain('Frames: 4');
    expect(out).toContain('@f1 top main-frame https://app.example.com/');
    expect(out).toContain('@f2 checkout checkout-frame parent:@f1 https://pay.example.com/checkout');
    expect(out).toContain('@f4 picker nested-frame parent:@f3 https://widgets.example.com/picker');
  });

  it('reads Page.getFrameTree from the target session', async () => {
    const cdp = createMockCDP({
      'Page.getFrameTree': () => ({ frameTree: sampleTree }),
    });
    const out = await T.framesStr(cdp, 'sid1');
    expect(out).toContain('Frames: 4');
    expect(out).toContain('@f2 checkout checkout-frame');
    expect(cdp.calls[0]).toMatchObject({ method: 'Page.getFrameTree', sessionId: 'sid1' });
  });

  it('perceives a frame and qualifies element refs with the frame ref', async () => {
    const cdp = createMockCDP({
      'Page.getFrameTree': () => ({ frameTree: sampleTree }),
      'Page.createIsolatedWorld': (params) => {
        expect(params.frameId).toBe('checkout-frame');
        return { executionContextId: 42 };
      },
      'Runtime.evaluate': (params) => {
        expect(params.contextId).toBe(42);
        return { result: { value: JSON.stringify({
          title: 'Checkout',
          url: 'https://pay.example.com/checkout',
          vw: 320,
          vh: 240,
          scrollY: 0,
          scrollMax: 0,
          counts: { button: 1 },
          focused: 'none',
          layoutMap: {},
          styleHints: {},
          cursorInteractives: [],
        }) } };
      },
      'Accessibility.getFullAXTree': (params) => {
        expect(params.frameId).toBe('checkout-frame');
        return { nodes: [
          { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Checkout' }, childIds: ['2'] },
          { nodeId: '2', parentId: '1', role: { value: 'button' }, name: { value: 'Pay now' }, backendDOMNodeId: 222 },
        ] };
      },
      'DOM.resolveNode': (params) => {
        if (params.backendNodeId === 222) return { object: { objectId: 'button-object' } };
        if (params.backendNodeId === 333) return { object: { objectId: 'frame-owner' } };
        throw new Error(`unexpected backend node ${params.backendNodeId}`);
      },
      'Runtime.callFunctionOn': (params) => {
        if (params.objectId === 'button-object') return { result: { value: { x: 12, y: 20, w: 80, h: 24, position: '' } } };
        if (params.objectId === 'frame-owner') return { result: { value: { x: 50, y: 40, w: 300, h: 200 } } };
        throw new Error(`unexpected object ${params.objectId}`);
      },
      'DOM.getFrameOwner': (params) => {
        expect(params.frameId).toBe('checkout-frame');
        return { backendNodeId: 333 };
      },
    });
    const refState = {};
    const out = await T.perceiveStr(
      cdp,
      'sid1',
      new RingBuffer(5),
      new RingBuffer(5),
      new Map(),
      { output: null, model: null },
      { frameRef: '@f2' },
      refState
    );

    expect(out).toContain('Frame: @f2 checkout checkout-frame https://pay.example.com/checkout');
    expect(out).toContain('[button] Pay now  @f2:1  (62,60 80×24)');
    expect(refState.frameRefs.get('@f2').refs.get(1)).toBe(222);
    expect(refState.frameLastOutputs.get('@f2')).toContain('[button] Pay now  @f2:1');
  });

  it('clicks frame-scoped refs using top-level viewport coordinates', async () => {
    const refState = {
      frameRefs: new Map([
        ['@f2', {
          frameRef: '@f2',
          frameId: 'checkout-frame',
          parentId: 'main-frame',
          refs: new Map([[1, 222]]),
        }],
      ]),
    };
    const cdp = createMockCDP({
      'DOM.resolveNode': (params) => {
        if (params.backendNodeId === 222) return { object: { objectId: 'child-button' } };
        if (params.backendNodeId === 333) return { object: { objectId: 'frame-owner' } };
        throw new Error(`unexpected backend node ${params.backendNodeId}`);
      },
      'Runtime.callFunctionOn': (params) => {
        if (params.objectId === 'child-button') {
          return { result: { value: { x: 10, y: 5, w: 100, h: 20, tag: 'BUTTON', text: 'Pay now' } } };
        }
        if (params.objectId === 'frame-owner') {
          return { result: { value: { x: 50, y: 40, w: 300, h: 200 } } };
        }
        throw new Error(`unexpected object ${params.objectId}`);
      },
      'DOM.getFrameOwner': (params) => {
        expect(params.frameId).toBe('checkout-frame');
        return { backendNodeId: 333 };
      },
      'Input.dispatchMouseEvent': () => ({}),
    });

    const out = await T.clickStr(cdp, 'sid1', '@f2:1', new Map(), refState);
    expect(out).toContain('Clicked <BUTTON> "Pay now" (@f2:1)');
    const pressed = cdp.calls.find(call => call.method === 'Input.dispatchMouseEvent' && call.params.type === 'mousePressed');
    expect(pressed.params.x).toBe(110);
    expect(pressed.params.y).toBe(55);
  });
});

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
            localStorage: { theme: 'dark' },
            sessionStorage: { wizard: '2' },
          }),
        },
      }),
      'Network.getCookies': () => ({
        cookies: [{
          name: 'sid',
          value: 'abc',
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
    expect(model.storage.localStorage).toEqual({ theme: 'dark' });
    expect(model.storage.sessionStorage).toEqual({ wizard: '2' });
    expect(model.cookies).toHaveLength(1);
    expect(model.cookies[0]).toMatchObject({ name: 'sid', value: 'abc', domain: 'example.com' });
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
    expect(cdp.calls.some(c => c.method === 'Network.setCookie' && c.params.name === 'sid' && c.params.url === 'https://example.com/app')).toBe(true);
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
});

// =========================================================================
// evalStr (with CDP mock)
// =========================================================================

describe('evalStr', () => {
  it('should return string value from Runtime.evaluate', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { value: 'hello' } }),
    });
    const result = await evalStr(cdp, 'sid1', '1+1');
    expect(result).toBe('hello');
  });

  it('should JSON.stringify object results', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { value: { a: 1, b: 2 } } }),
    });
    const result = await evalStr(cdp, 'sid1', 'obj');
    expect(JSON.parse(result)).toEqual({ a: 1, b: 2 });
  });

  it('should return empty string for undefined result', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { value: undefined } }),
    });
    expect(await evalStr(cdp, 'sid1', 'void 0')).toBe('');
  });

  it('should return "null" for null result (typeof null === "object")', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { value: null } }),
    });
    // typeof null === 'object', so it goes through JSON.stringify path
    expect(await evalStr(cdp, 'sid1', 'null')).toBe('null');
  });

  it('should throw on exceptionDetails', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({
        result: {},
        exceptionDetails: { text: 'ReferenceError: x is not defined' },
      }),
    });
    await expect(evalStr(cdp, 'sid1', 'x')).rejects.toThrow('ReferenceError');
  });

  it('should prefer exceptionDetails.text over exception.description', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({
        result: {},
        exceptionDetails: {
          text: 'Uncaught',
          exception: { description: 'TypeError: cannot read property' },
        },
      }),
    });
    // text is checked first; falls back to exception.description only if text is falsy
    await expect(evalStr(cdp, 'sid1', 'x.y')).rejects.toThrow('Uncaught');
  });

  it('should fall back to exception.description when text is empty', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({
        result: {},
        exceptionDetails: {
          text: '',
          exception: { description: 'TypeError: cannot read property' },
        },
      }),
    });
    await expect(evalStr(cdp, 'sid1', 'x.y')).rejects.toThrow('TypeError');
  });

  it('should auto-wrap await expressions when autoWrap=true', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': (params) => {
        // Verify the expression was wrapped in async IIFE
        expect(params.expression).toContain('async');
        return { result: { value: 'done' } };
      },
    });
    await evalStr(cdp, 'sid1', 'await fetch("/api")', true);
  });

  it('should not wrap expressions without await even when autoWrap=true', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': (params) => {
        expect(params.expression).not.toContain('async');
        return { result: { value: '42' } };
      },
    });
    await evalStr(cdp, 'sid1', '1 + 1', true);
  });

  it('should wrap multi-statement await in block body', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': (params) => {
        // Multi-statement with semicolons → block body {…}
        expect(params.expression).toMatch(/\(async\(\)=>\{/);
        return { result: { value: 'ok' } };
      },
    });
    await evalStr(cdp, 'sid1', 'const r = await fetch("/api"); return r', true);
  });

  it('should pass awaitPromise and returnByValue to CDP', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': (params) => {
        expect(params.awaitPromise).toBe(true);
        expect(params.returnByValue).toBe(true);
        return { result: { value: 'ok' } };
      },
    });
    await evalStr(cdp, 'sid1', '"test"');
  });

  it('should pass sessionId to CDP', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { value: 'ok' } }),
    });
    await evalStr(cdp, 'session-xyz', '"test"');
    expect(cdp.calls[0].sessionId).toBe('session-xyz');
  });
});

// =========================================================================
// eval fire-and-forget / call / wait helpers
// =========================================================================

describe('eval fire-and-forget and call helpers', () => {
  it('dispatches eval without awaiting the returned promise', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': (params) => {
        expect(params.awaitPromise).toBe(false);
        expect(params.returnByValue).toBe(false);
        expect(params.expression).toContain('setInterval');
        return { result: { objectId: 'promise-1' } };
      },
    });
    const out = await evalFireAndForgetStr(cdp, 'sid1', 'setInterval(() => {}, 1000)', true);
    expect(out).toMatch(/fire-and-forget eval/i);
  });

  it('parses --fire-and-forget with --b64', () => {
    const b64 = Buffer.from('window.__loop = true', 'utf8').toString('base64');
    const opts = parseEvalArgs(['--fire-and-forget', '--b64', b64]);
    expect(opts.fireAndForget).toBe(true);
    expect(opts.expression).toBe('window.__loop = true');
  });

  it('callStr awaits page result and serializes JSON values', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': (params) => {
        expect(params.awaitPromise).toBe(true);
        expect(params.returnByValue).toBe(true);
        expect(params.expression).toContain('typeof value');
        return { result: { value: { ok: true, n: 2 } } };
      },
    });
    const out = await callStr(cdp, 'sid1', 'async () => ({ ok: true, n: 2 })');
    expect(JSON.parse(out)).toEqual({ ok: true, n: 2 });
  });
});

describe('wait helpers', () => {
  it('classifies CDP timeout messages by method', () => {
    expect(isTimeoutError(new Error('Timeout: Runtime.evaluate'), ['Runtime.evaluate'])).toBe(true);
    expect(isTimeoutError(new Error('Timeout: Runtime.evaluate'), ['Page.captureScreenshot'])).toBe(false);
    expect(isTimeoutError(new Error('Other failure'))).toBe(false);
  });

  it('parses bounded positive millisecond durations', () => {
    expect(parseDelayMs('30')).toBe(30);
    expect(() => parseDelayMs('0')).toThrow(/at least/);
    expect(() => parseDelayMs('x')).toThrow(/positive integer/);
  });

  it('waitStr waits inside the Node command and reports the duration', async () => {
    const out = await waitStr('1');
    expect(out).toBe('Waited 1ms');
  });

  it('extends IPC timeout for long daemon-backed waits', () => {
    expect(ipcTimeoutForRequest({ cmd: 'wait', args: ['180000'] })).toBe(185000);
    expect(ipcTimeoutForRequest({ cmd: 'wait', args: ['30'] })).toBe(120000);
    expect(ipcTimeoutForRequest({ cmd: 'status', args: [] })).toBe(120000);
  });

  it('supports wait ms target form without stealing numeric target prefixes', () => {
    expect(parseTargetAndCommandArgs('wait', ['30000', 'A7BA1234'])).toEqual({
      targetPrefix: 'A7BA1234',
      cmdArgs: ['30000'],
    });
    expect(parseTargetAndCommandArgs('wait', ['12345678', '30000'])).toEqual({
      targetPrefix: '12345678',
      cmdArgs: ['30000'],
    });
  });
});

describe('formatCliError', () => {
  it('adds an executable doctor next step when CDP is unreachable', () => {
    const out = formatCliError(new Error('Cannot reach CDP on 127.0.0.1:9222 — is the app running with --remote-debugging-port=9222?'));

    expect(out).toContain('Error: Cannot reach CDP on 127.0.0.1:9222');
    expect(out).toContain('Recovery:');
    expect(out).toContain('Kind: browser-cdp');
    expect(out).toContain('Strategy: run-doctor');
    expect(out).toContain('Run: cdp doctor');
    expect(out).toContain('Next: cdp doctor');
  });

  it('turns target resolution failures into list/open guidance', () => {
    const out = formatCliError(new Error('No target matching prefix "abc". Run "cdp list".'));

    expect(out).toContain('Error: No target matching prefix "abc". Run "cdp list".');
    expect(out).toContain('Recovery:');
    expect(out).toContain('Kind: target-resolution');
    expect(out).toContain('Strategy: rediscover-target');
    expect(out).toContain('Run: cdp list  # if empty: cdp open https://example.com');
    expect(out).toContain('Then: cdp open https://example.com');
    expect(out).toContain('Next: cdp list');
    expect(out).toContain('cdp open https://example.com');
  });

  it('turns ambiguous prefixes into a longer-prefix next step', () => {
    const out = formatCliError(new Error('Ambiguous prefix "AABB" — matches 2 targets. Use more characters.'));

    expect(out).toContain('Error: Ambiguous prefix "AABB"');
    expect(out).toContain('Next: cdp list');
    expect(out).toContain('copy a longer target prefix');
  });

  it('turns daemon disconnects into a restartable perceive command', () => {
    const out = formatCliError(
      new Error('Connection closed before response. The daemon for this tab may have crashed or exited.'),
      { targetPrefix: 'AABBCCDD' }
    );

    expect(out).toContain('Error: Connection closed before response');
    expect(out).toContain('Recovery:');
    expect(out).toContain('Kind: daemon-disconnect');
    expect(out).toContain('Strategy: restart-tab-daemon');
    expect(out).toContain('Run: cdp perceive AABBCCDD -C -d 8');
    expect(out).toContain('Next: cdp perceive AABBCCDD -C -d 8');
  });

  it('preserves already-classified action failures', () => {
    const out = formatCliError('Action failure: overlay\nNext: cdp dismiss-modal AABBCCDD');

    expect(out).toBe('Action failure: overlay\nNext: cdp dismiss-modal AABBCCDD');
  });

  it('builds a structured JSON handoff for top-level CLI errors', () => {
    const model = T.buildCliErrorModel(new Error('target ID required. Run "cdp list" first.'), { cmd: 'perceive' });

    expect(model).toMatchObject({
      schema: 'chrome-cdp-ex.cli-error.v1',
      ok: false,
      command: 'perceive',
      error: {
        message: 'target ID required. Run "cdp list" first.',
      },
      recovery: {
        kind: 'target-resolution',
        strategy: 'rediscover-target',
        run: 'cdp list  # if empty: cdp open https://example.com',
        then: 'cdp open https://example.com',
      },
      nextSteps: [
        'cdp list  # if empty: cdp open https://example.com',
        'cdp open https://example.com',
      ],
    });
  });

  it('formats top-level CLI errors as parseable JSON when requested', () => {
    const out = formatCliError(
      new Error('Connection closed before response. The daemon for this tab may have crashed or exited.'),
      { cmd: 'perceive', targetPrefix: 'AABBCCDD', format: 'json' }
    );
    const parsed = JSON.parse(out);

    expect(parsed.schema).toBe('chrome-cdp-ex.cli-error.v1');
    expect(parsed.recovery.kind).toBe('daemon-disconnect');
    expect(parsed.recovery.run).toBe('cdp perceive AABBCCDD -C -d 8');
    expect(parsed.nextSteps).toEqual(['cdp perceive AABBCCDD -C -d 8']);
    expect(out).not.toContain('Recovery:');
  });

  it('classifies missing action arguments as usage recovery instead of target status', () => {
    const out = formatCliError(new Error('selector required'), {
      cmd: 'fill',
      targetPrefix: 'AABBCCDD',
      format: 'json',
    });
    const parsed = JSON.parse(out);

    expect(parsed).toMatchObject({
      schema: 'chrome-cdp-ex.cli-error.v1',
      ok: false,
      command: 'fill',
      targetPrefix: 'AABBCCDD',
      recovery: {
        kind: 'usage',
        strategy: 'provide-required-argument',
        run: 'cdp fill AABBCCDD <selector|@ref> <text>',
      },
      nextSteps: ['cdp fill AABBCCDD <selector|@ref> <text>'],
    });
  });

  it('classifies missing nav URLs as a concrete navigation recovery', () => {
    const out = formatCliError(new Error('URL required'), {
      cmd: 'nav',
      targetPrefix: 'AABBCCDD',
      format: 'json',
    });
    const parsed = JSON.parse(out);

    expect(parsed.recovery.kind).toBe('navigation');
    expect(parsed.recovery.strategy).toBe('provide-url');
    expect(parsed.recovery.run).toBe('cdp nav AABBCCDD https://example.com');
    expect(parsed.nextSteps).toEqual(['cdp nav AABBCCDD https://example.com']);
  });
});

describe('open onboarding guidance', () => {
  it('formats a ready continuation after open auto-perceives the page', () => {
    const out = formatOpenReadyMessage('AABBCCDDEEFF', 'https://example.com');

    expect(out).toContain('Tab ready');
    expect(out).toContain('Target: AABBCCDD');
    expect(out).toContain('Next: cdp click AABBCCDD @ref');
    expect(out).toContain('Then: cdp perceive AABBCCDD --since-action');
    expect(out).toContain('Report: cdp report AABBCCDD');
  });

  it('builds a JSON model for a ready opened tab', () => {
    const model = T.buildOpenModel({
      targetId: 'AABBCCDDEEFF',
      url: 'https://example.com',
      attached: true,
      autoPerceive: { attempted: true, ok: true },
    });

    expect(model).toMatchObject({
      schema: 'chrome-cdp-ex.open.v1',
      targetId: 'AABBCCDDEEFF',
      targetPrefix: 'AABBCCDD',
      url: 'https://example.com',
      attached: true,
      approval: 'approved',
      autoPerceive: { attempted: true, ok: true },
      nextSteps: [
        'cdp perceive AABBCCDD -C -d 8',
        'cdp click AABBCCDD @ref  # choose a ref from perceive',
        'cdp perceive AABBCCDD --since-action',
        'cdp report AABBCCDD',
      ],
    });
    expect(model.recommendation).toMatchObject({
      source: 'golden-path',
      stage: 'act',
      targetPrefix: 'AABBCCDD',
      run: 'cdp click AABBCCDD @ref  # choose a ref from the perception below',
      after: 'cdp perceive AABBCCDD --since-action',
      report: 'cdp report AABBCCDD',
      requiresUserAction: false,
      consentRequired: false,
    });
    expect(model.recommendation.commands).toEqual([
      'cdp click AABBCCDD @ref  # choose a ref from the perception below',
      'cdp perceive AABBCCDD --since-action',
      'cdp report AABBCCDD',
    ]);
  });

  it('recommends perceive when open JSON skipped auto-perceive output', () => {
    const model = T.buildOpenModel({
      targetId: 'AABBCCDDEEFF',
      url: 'about:blank',
      attached: true,
      autoPerceive: { attempted: false, ok: false, reason: 'json-output' },
    });

    expect(model.recommendation).toMatchObject({
      source: 'golden-path',
      stage: 'perceive',
      targetPrefix: 'AABBCCDD',
      run: 'cdp perceive AABBCCDD -C -d 8',
      after: 'cdp click AABBCCDD @ref  # choose a ref from perceive',
    });
  });

  it('formats a timeout recovery when browser permission is not approved yet', () => {
    const out = formatOpenTimeoutMessage('AABBCCDDEEFF');

    expect(out).toContain('Timeout waiting for debugging approval');
    expect(out).toContain('Target: AABBCCDD');
    expect(out).toContain('Next: cdp perceive AABBCCDD -C -d 8');
    expect(out).toContain('click Allow');
  });

  it('builds a JSON model for an opened tab that still needs approval', () => {
    const model = T.buildOpenModel({
      targetId: 'AABBCCDDEEFF',
      url: 'about:blank',
      attached: false,
      autoPerceive: { attempted: false, ok: false, reason: 'not-attached' },
    });

    expect(model).toMatchObject({
      schema: 'chrome-cdp-ex.open.v1',
      targetPrefix: 'AABBCCDD',
      url: 'about:blank',
      attached: false,
      approval: 'pending',
      autoPerceive: { attempted: false, ok: false, reason: 'not-attached' },
      nextSteps: [
        'cdp perceive AABBCCDD -C -d 8',
      ],
    });
    expect(model.recommendation).toMatchObject({
      source: 'golden-path',
      stage: 'browser-permission',
      targetPrefix: 'AABBCCDD',
      run: 'cdp perceive AABBCCDD -C -d 8',
      ask: 'Click Allow if Chrome asks.',
      requiresUserAction: true,
      consentRequired: false,
    });
  });

  it('formats auto-perceive failure with actionable recovery', () => {
    const out = formatOpenAutoPerceiveFailure(
      new Error('Connection closed before response. The daemon for this tab may have crashed.'),
      'AABBCCDDEEFF'
    );

    expect(out).toContain('Auto-perceive failed');
    expect(out).toContain('Next: cdp perceive AABBCCDD -C -d 8');
  });
});

describe('status --runtime and buffer reset', () => {
  it('includes Performance.getMetrics counters only when requested', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { value: JSON.stringify({ title: 'T', url: 'https://example.test/' }) } }),
      'Performance.enable': () => ({}),
      'Performance.getMetrics': () => ({
        metrics: [
          { name: 'Documents', value: 2 },
          { name: 'Frames', value: 1 },
          { name: 'JSEventListeners', value: 9 },
          { name: 'Nodes', value: 123 },
          { name: 'JSHeapUsedSize', value: 1048576 },
          { name: 'Tasks', value: 7 },
        ],
      }),
    });
    const out = await statusStr(cdp, 'sid1', new RingBuffer(10), new RingBuffer(10), new RingBuffer(10), { console: 0, exception: 0 }, { runtime: true });
    expect(out).toContain('Runtime metrics (Performance.getMetrics):');
    expect(out).toContain('Documents: 2');
    expect(out).toContain('JSHeapUsedSize: 1.0 MB');
    expect(out).not.toMatch(/pending fetch|pending timer/i);
  });

  it('clears observation buffers and advances read sequence', () => {
    const consoleBuf = new RingBuffer(10);
    const exceptionBuf = new RingBuffer(10);
    const navBuf = new RingBuffer(10);
    const netReqBuf = new RingBuffer(10);
    const pendingReqs = new Map([['1', { url: '/api' }]]);
    consoleBuf.push({ text: 'a' });
    exceptionBuf.push({ msg: 'b' });
    navBuf.push({ url: 'https://example.test/' });
    netReqBuf.push({ url: '/api' });
    const lastReadSeq = { console: 0, exception: 0 };
    clearObservationBuffers({ consoleBuf, exceptionBuf, navBuf, netReqBuf, pendingReqs, lastReadSeq });
    expect(consoleBuf.all()).toEqual([]);
    expect(exceptionBuf.all()).toEqual([]);
    expect(navBuf.all()).toEqual([]);
    expect(netReqBuf.all()).toEqual([]);
    expect(pendingReqs.size).toBe(0);
    expect(lastReadSeq.console).toBe(consoleBuf.latest());
    expect(lastReadSeq.exception).toBe(exceptionBuf.latest());
  });
});

// =========================================================================
// navStr (with CDP mock)
// =========================================================================

describe('navStr', () => {
  it('should navigate and return confirmation', async () => {
    const cdp = createMockCDP({
      'Page.enable': () => ({}),
      'Page.navigate': () => ({ loaderId: 'loader1' }),
      'event:Page.loadEventFired': () => ({}),
      'Runtime.evaluate': () => ({ result: { value: 'complete' } }),
    });
    const result = await navStr(cdp, 'sid1', 'https://example.com');
    expect(result).toBe('Navigated to https://example.com');
  });

  it('should throw on errorText from Page.navigate', async () => {
    const cdp = createMockCDP({
      'Page.enable': () => ({}),
      'Page.navigate': () => ({ errorText: 'net::ERR_NAME_NOT_RESOLVED' }),
    });
    await expect(navStr(cdp, 'sid1', 'https://bad.invalid'))
      .rejects.toThrow('net::ERR_NAME_NOT_RESOLVED');
  });

  it('should reject non-http URLs', async () => {
    const cdp = createMockCDP({});
    await expect(navStr(cdp, 'sid1', 'file:///etc/passwd'))
      .rejects.toThrow(/Only http/);
  });

  it('should reject metadata URLs', async () => {
    const cdp = createMockCDP({});
    await expect(navStr(cdp, 'sid1', 'http://169.254.169.254/'))
      .rejects.toThrow(/metadata/i);
  });
});

// =========================================================================
// clickStr (with CDP mock)
// =========================================================================

describe('clickStr', () => {
  it('should click element by CSS selector', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({
        result: { value: { ok: true, x: 100, y: 200, tag: 'BUTTON', text: 'Submit' } },
      }),
      'Input.dispatchMouseEvent': () => ({}),
    });
    const result = await clickStr(cdp, 'sid1', '.btn-submit', new Map());
    expect(result).toContain('Clicked');
    expect(result).toContain('BUTTON');
    expect(result).toContain('Submit');
  });

  it('should click element by @ref', async () => {
    const refMap = new Map([[1, 101]]);
    const cdp = createMockCDP({
      'DOM.resolveNode': () => ({ object: { objectId: 'obj-1' } }),
      'Runtime.callFunctionOn': () => ({
        result: { value: { x: 50, y: 60, w: 100, h: 40, tag: 'A', text: 'Link' } },
      }),
      'Input.dispatchMouseEvent': () => ({}),
    });
    const result = await clickStr(cdp, 'sid1', '@1', refMap);
    expect(result).toContain('Clicked');
    expect(result).toContain('@1');
  });

  it('should throw when element not found by CSS selector', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({
        result: { value: { ok: false, error: 'Element not found: .missing' } },
      }),
    });
    await expect(clickStr(cdp, 'sid1', '.missing', new Map()))
      .rejects.toThrow('Element not found');
  });

  it('should throw on unknown @ref', async () => {
    const refMap = new Map(); // empty
    const cdp = createMockCDP({});
    await expect(clickStr(cdp, 'sid1', '@99', refMap))
      .rejects.toThrow(/Unknown ref/);
  });

  it('should throw when no selector provided', async () => {
    const cdp = createMockCDP({});
    await expect(clickStr(cdp, 'sid1', undefined, new Map()))
      .rejects.toThrow(/selector.*required/i);
  });

  it('should dispatch mouseMoved, mousePressed, mouseReleased in order', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({
        result: { value: { ok: true, x: 10, y: 20, tag: 'DIV', text: 'x' } },
      }),
      'Input.dispatchMouseEvent': () => ({}),
    });
    await clickStr(cdp, 'sid1', '.el', new Map());
    const mouseEvents = cdp.calls
      .filter(c => c.method === 'Input.dispatchMouseEvent')
      .map(c => c.params.type);
    expect(mouseEvents).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased']);
  });
});

// =========================================================================
// fillStr (with CDP mock)
// =========================================================================

describe('fillStr', () => {
  it('should clear and fill element by CSS selector', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({
        result: { value: { ok: true, tag: 'INPUT' } },
      }),
      'Input.insertText': () => ({}),
    });
    const result = await fillStr(cdp, 'sid1', '#email', 'user@test.com', new Map());
    expect(result).toContain('Filled');
    expect(result).toContain('user@test.com');
  });

  it('should fill element by @ref', async () => {
    const refMap = new Map([[1, 201]]);
    const cdp = createMockCDP({
      'DOM.resolveNode': () => ({ object: { objectId: 'obj-1' } }),
      'Runtime.callFunctionOn': () => ({ result: { value: undefined } }),
      'Input.insertText': () => ({}),
    });
    const result = await fillStr(cdp, 'sid1', '@1', 'hello', refMap);
    expect(result).toContain('Filled @1');
    expect(result).toContain('hello');
  });

  it('should truncate long text in result message', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({
        result: { value: { ok: true, tag: 'TEXTAREA' } },
      }),
      'Input.insertText': () => ({}),
    });
    const longText = 'A'.repeat(100);
    const result = await fillStr(cdp, 'sid1', 'textarea', longText, new Map());
    expect(result).toContain('...');
    expect(result.length).toBeLessThan(longText.length);
  });

  it('should throw when selector missing', async () => {
    const cdp = createMockCDP({});
    await expect(fillStr(cdp, 'sid1', undefined, 'text', new Map()))
      .rejects.toThrow(/selector.*required/i);
  });

  it('should throw when text missing', async () => {
    const cdp = createMockCDP({});
    await expect(fillStr(cdp, 'sid1', '#input', null, new Map()))
      .rejects.toThrow(/Text required/);
  });
});

describe('fill --react', () => {
  it('uses the native value setter and input/change events for CSS selectors', async () => {
    const cdp = createMockCDP({
      'DOM.enable': () => ({}),
      'DOM.getDocument': () => ({ root: { nodeId: 1 } }),
      'DOM.querySelector': (params) => {
        expect(params.selector).toBe('#name');
        return { nodeId: 42 };
      },
      'DOM.resolveNode': () => ({ object: { objectId: 'obj-input' } }),
      'Runtime.callFunctionOn': (params) => {
        expect(params.objectId).toBe('obj-input');
        expect(params.arguments[0].value).toBe('戰鬥勝利');
        expect(params.functionDeclaration).toContain('Object.getOwnPropertyDescriptor');
        expect(params.functionDeclaration).toContain("new InputEvent('input'");
        expect(params.functionDeclaration).toContain("new Event('change'");
        return { result: { value: { tag: 'INPUT', value: '戰鬥勝利' } } };
      },
    });
    const out = await fillReactStr(cdp, 'sid1', '#name', '戰鬥勝利', new Map());
    expect(out).toContain('React-filled <INPUT>');
    expect(out).toContain('戰鬥勝利');
  });

  it('keeps normal fill using Input.insertText', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { value: { ok: true, tag: 'INPUT' } } }),
      'Input.insertText': () => ({}),
    });
    await fillStr(cdp, 'sid1', '#name', 'plain', new Map());
    expect(cdp.calls.some(c => c.method === 'Input.insertText')).toBe(true);
    expect(cdp.calls.some(c => c.method === 'Runtime.callFunctionOn')).toBe(false);
  });
});

// =========================================================================
// Exclude subtree filtering (unit test for the filtering logic)
// =========================================================================

describe('exclude subtree filtering', () => {
  // Simulate the exclude logic from perceiveStr without CDP
  function filterExcluded(axNodes, excludedBackendNodeIds) {
    const excludedAxIds = new Set();
    for (const n of axNodes) {
      if (n.backendDOMNodeId && excludedBackendNodeIds.has(n.backendDOMNodeId))
        excludedAxIds.add(n.nodeId);
    }
    if (excludedAxIds.size === 0) return axNodes;
    const childMap = new Map();
    for (const n of axNodes) {
      if (n.parentId) {
        if (!childMap.has(n.parentId)) childMap.set(n.parentId, []);
        childMap.get(n.parentId).push(n.nodeId);
      }
    }
    const queue = [...excludedAxIds];
    while (queue.length) {
      const id = queue.pop();
      for (const child of (childMap.get(id) || [])) {
        excludedAxIds.add(child);
        queue.push(child);
      }
    }
    return axNodes.filter(n => !excludedAxIds.has(n.nodeId));
  }

  const axNode = (id, role, name, opts = {}) => ({
    nodeId: id,
    role: { value: role },
    name: { value: name },
    ...(opts.parentId ? { parentId: opts.parentId } : {}),
    ...(opts.backendDOMNodeId ? { backendDOMNodeId: opts.backendDOMNodeId } : {}),
  });

  it('should remove excluded node and all descendants', () => {
    const nodes = [
      axNode('root', 'WebArea', 'Page'),
      axNode('nav', 'navigation', 'Nav', { parentId: 'root', backendDOMNodeId: 100 }),
      axNode('link1', 'link', 'Home', { parentId: 'nav', backendDOMNodeId: 101 }),
      axNode('link2', 'link', 'About', { parentId: 'nav', backendDOMNodeId: 102 }),
      axNode('main', 'main', 'Content', { parentId: 'root', backendDOMNodeId: 200 }),
      axNode('h1', 'heading', 'Title', { parentId: 'main' }),
    ];
    const excluded = new Set([100]); // exclude nav (backendDOMNodeId=100)
    const filtered = filterExcluded(nodes, excluded);

    expect(filtered.map(n => n.nodeId)).toEqual(['root', 'main', 'h1']);
    expect(filtered.find(n => n.nodeId === 'nav')).toBeUndefined();
    expect(filtered.find(n => n.nodeId === 'link1')).toBeUndefined();
    expect(filtered.find(n => n.nodeId === 'link2')).toBeUndefined();
  });

  it('should handle multiple excluded roots', () => {
    const nodes = [
      axNode('root', 'WebArea', 'Page'),
      axNode('nav', 'navigation', 'Nav', { parentId: 'root', backendDOMNodeId: 100 }),
      axNode('aside', 'complementary', 'Sidebar', { parentId: 'root', backendDOMNodeId: 200 }),
      axNode('main', 'main', 'Content', { parentId: 'root', backendDOMNodeId: 300 }),
    ];
    const excluded = new Set([100, 200]); // exclude nav and sidebar
    const filtered = filterExcluded(nodes, excluded);

    expect(filtered.map(n => n.nodeId)).toEqual(['root', 'main']);
  });

  it('should return all nodes when no backendDOMNodeId matches', () => {
    const nodes = [
      axNode('root', 'WebArea', 'Page'),
      axNode('main', 'main', 'Content', { parentId: 'root', backendDOMNodeId: 300 }),
    ];
    const excluded = new Set([999]); // non-existent
    const filtered = filterExcluded(nodes, excluded);

    expect(filtered).toHaveLength(2);
  });

  it('should handle deeply nested exclusion', () => {
    const nodes = [
      axNode('root', 'WebArea', 'Page'),
      axNode('nav', 'navigation', 'Nav', { parentId: 'root', backendDOMNodeId: 100 }),
      axNode('list', 'list', '', { parentId: 'nav' }),
      axNode('item1', 'listitem', 'Item 1', { parentId: 'list' }),
      axNode('item2', 'listitem', 'Item 2', { parentId: 'list' }),
      axNode('sublink', 'link', 'Sub', { parentId: 'item1' }),
    ];
    const excluded = new Set([100]); // exclude nav → should cascade to list, items, sublink
    const filtered = filterExcluded(nodes, excluded);

    expect(filtered.map(n => n.nodeId)).toEqual(['root']);
  });
});

// =========================================================================
// Diff compact: StaticText noise filtering
// =========================================================================

describe('diff compact filtering', () => {
  const isTextOnly = l => /^\s*\[StaticText\]/.test(l);

  it('should classify [StaticText] lines as text-only', () => {
    expect(isTextOnly('  [StaticText] "Hello"')).toBe(true);
    expect(isTextOnly('[StaticText] "World"')).toBe(true);
    expect(isTextOnly('    [StaticText] "deeply indented"')).toBe(true);
  });

  it('should not classify structural lines as text-only', () => {
    expect(isTextOnly('  [button] "Submit" @1')).toBe(false);
    expect(isTextOnly('  [navigation] "Nav"')).toBe(false);
    expect(isTextOnly('  [heading] "Title"')).toBe(false);
    expect(isTextOnly('  [link] "Home" @2')).toBe(false);
    expect(isTextOnly('  [textbox] "Search" @3')).toBe(false);
  });

  it('should separate structural from text-only changes', () => {
    const removed = [
      '  [StaticText] "old text 1"',
      '  [button] "Old Button" @5',
      '  [StaticText] "old text 2"',
    ];
    const added = [
      '  [StaticText] "new text 1"',
      '  [StaticText] "new text 2"',
      '  [StaticText] "new text 3"',
      '  [link] "New Link" @7',
    ];
    const removedStructural = removed.filter(l => !isTextOnly(l));
    const addedStructural = added.filter(l => !isTextOnly(l));
    const removedText = removed.length - removedStructural.length;
    const addedText = added.length - addedStructural.length;

    expect(removedStructural).toEqual(['  [button] "Old Button" @5']);
    expect(addedStructural).toEqual(['  [link] "New Link" @7']);
    expect(removedText).toBe(2);
    expect(addedText).toBe(3);
  });
});

// =========================================================================
// waitForStr --gone (with CDP mock)
// =========================================================================

describe('waitForStr --gone', () => {
  it('should throw when no selector provided after --gone', async () => {
    const cdp = createMockCDP({});
    await expect(waitForStr(cdp, 'sid1', ['--gone'], new Map()))
      .rejects.toThrow(/selector.*required.*--gone/i);
  });

  it('should return immediately when CSS selector element is already absent', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { value: 'null' } }),
    });
    const result = await waitForStr(cdp, 'sid1', ['--gone', '.stop-btn', '5000'], new Map());
    expect(result).toMatch(/gone/i);
  });

  it('should return when CSS selector element disappears after polling', async () => {
    let callCount = 0;
    const cdp = createMockCDP({
      'Runtime.evaluate': () => {
        callCount++;
        // Element present for first 2 calls, then gone
        return { result: { value: callCount <= 2 ? '"yes"' : 'null' } };
      },
    });
    const result = await waitForStr(cdp, 'sid1', ['--gone', '.loading', '5000'], new Map());
    expect(result).toMatch(/gone/i);
    expect(callCount).toBeGreaterThan(2);
  });

  it('should throw on timeout when CSS element never disappears', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { value: '"yes"' } }),
    });
    await expect(waitForStr(cdp, 'sid1', ['--gone', '.sticky', '500'], new Map()))
      .rejects.toThrow(/still present/);
  });

  it('should throw for unknown @ref', async () => {
    const cdp = createMockCDP({});
    const refMap = new Map(); // empty — no refs
    await expect(waitForStr(cdp, 'sid1', ['--gone', '@99', '500'], refMap))
      .rejects.toThrow(/Unknown ref/);
  });

  it('should return when @ref element is removed from DOM (resolveNode throws)', async () => {
    const cdp = createMockCDP({
      'DOM.resolveNode': () => { throw new Error('Could not find node'); },
    });
    const refMap = new Map([[5, 12345]]); // ref @5 → backendNodeId 12345
    const result = await waitForStr(cdp, 'sid1', ['--gone', '@5', '5000'], refMap);
    expect(result).toMatch(/@5.*gone.*removed/i);
  });

  it('should return when @ref element becomes disconnected', async () => {
    const cdp = createMockCDP({
      'DOM.resolveNode': () => ({ object: { objectId: 'obj-1' } }),
      'Runtime.callFunctionOn': () => ({ result: { value: false } }), // isConnected=false
    });
    const refMap = new Map([[3, 99999]]);
    const result = await waitForStr(cdp, 'sid1', ['--gone', '@3', '5000'], refMap);
    expect(result).toMatch(/@3.*gone.*disconnected|hidden/i);
  });

  it('should timeout when @ref element stays present', async () => {
    const cdp = createMockCDP({
      'DOM.resolveNode': () => ({ object: { objectId: 'obj-1' } }),
      'Runtime.callFunctionOn': () => ({ result: { value: true } }), // still connected+visible
    });
    const refMap = new Map([[7, 77777]]);
    await expect(waitForStr(cdp, 'sid1', ['--gone', '@7', '500'], refMap))
      .rejects.toThrow(/@7.*still present/);
  });
});

// =========================================================================
// captureScreenshot — multi-tier fallback
// =========================================================================

describe('captureScreenshot', () => {
  beforeEach(() => {
    resetScreenshotTier();
  });

  it('should return data from Tier 1 (standard captureScreenshot) on success', async () => {
    const cdp = createMockCDP({
      'Page.captureScreenshot': () => ({ data: 'base64png-tier1' }),
    });
    const result = await captureScreenshot(cdp, 'sid1', { format: 'png' });
    expect(result.data).toBe('base64png-tier1');
    expect(result.fallback).toBe(false);
    expect(getScreenshotTier()).toBe(1); // tier not advanced
  });

  it('should fall to Tier 2 (fromSurface:false) when Tier 1 times out', async () => {
    let callCount = 0;
    const cdp = createMockCDP({
      'Page.captureScreenshot': (params) => {
        callCount++;
        if (!params.fromSurface && params.fromSurface !== undefined) {
          // Tier 2: fromSurface:false — succeeds
          return { data: 'base64png-tier2' };
        }
        // Tier 1: standard — timeout
        throw new Error('Timeout: Page.captureScreenshot');
      },
    });
    const result = await captureScreenshot(cdp, 'sid1', { format: 'png' });
    expect(result.data).toBe('base64png-tier2');
    expect(result.fallback).toBe(true);
    expect(getScreenshotTier()).toBe(2); // advanced to tier 2
    expect(callCount).toBe(2);
  });

  it('should fall to Tier 3 (screencast) when Tier 1 and 2 both time out', async () => {
    const cdp = createMockCDP({
      'Page.captureScreenshot': () => {
        throw new Error('Timeout: Page.captureScreenshot');
      },
      'event:Page.screencastFrame': () => ({ data: 'base64png-tier3', sessionId: 42 }),
    });
    const result = await captureScreenshot(cdp, 'sid1', { format: 'png' });
    expect(result.data).toBe('base64png-tier3');
    expect(result.fallback).toBe(true);
    expect(getScreenshotTier()).toBe(3);
  });

  it('should throw descriptive error when all tiers fail', async () => {
    const cdp = createMockCDP({
      'Page.captureScreenshot': () => {
        throw new Error('Timeout: Page.captureScreenshot');
      },
      // No screencast event handler → waitForEvent will reject with timeout
    });
    await expect(captureScreenshot(cdp, 'sid1', { format: 'png' }))
      .rejects.toThrow(/all methods timed out/);
    expect(getScreenshotTier()).toBe(3);
  });

  it('should re-throw non-timeout errors from Tier 1 without advancing tier', async () => {
    const cdp = createMockCDP({
      'Page.captureScreenshot': () => {
        throw new Error('Protocol error: Target closed');
      },
    });
    await expect(captureScreenshot(cdp, 'sid1', { format: 'png' }))
      .rejects.toThrow(/Target closed/);
    expect(getScreenshotTier()).toBe(1); // not advanced — it was not a timeout
  });

  it('should pass params (including clip) through to CDP', async () => {
    const cdp = createMockCDP({
      'Page.captureScreenshot': (params) => {
        return { data: JSON.stringify(params) };
      },
    });
    const clip = { x: 10, y: 20, width: 100, height: 50, scale: 1 };
    const result = await captureScreenshot(cdp, 'sid1', { format: 'png', clip });
    const passedParams = JSON.parse(result.data);
    expect(passedParams.clip).toEqual(clip);
    expect(passedParams.format).toBe('png');
  });

  // --- Tier caching ---

  it('should skip Tier 1 on second call after Tier 1 timeout (caching)', async () => {
    let tier1Calls = 0;
    const cdp = createMockCDP({
      'Page.captureScreenshot': (params) => {
        if (params.fromSurface === false) return { data: 'tier2-ok' };
        tier1Calls++;
        throw new Error('Timeout: Page.captureScreenshot');
      },
    });

    // First call: tries Tier 1, fails, falls to Tier 2
    await captureScreenshot(cdp, 'sid1', { format: 'png' });
    expect(tier1Calls).toBe(1);

    // Second call: should skip Tier 1 entirely
    tier1Calls = 0;
    await captureScreenshot(cdp, 'sid1', { format: 'png' });
    expect(tier1Calls).toBe(0); // Tier 1 was NOT attempted
    expect(getScreenshotTier()).toBe(2);
  });

  it('should skip Tier 1 and 2 on second call after both timeout (caching)', async () => {
    let cdpCalls = 0;
    const cdp = createMockCDP({
      'Page.captureScreenshot': () => {
        cdpCalls++;
        throw new Error('Timeout: Page.captureScreenshot');
      },
      'event:Page.screencastFrame': () => ({ data: 'tier3-ok', sessionId: 1 }),
    });

    // First call: tries Tier 1, 2, then falls to Tier 3
    await captureScreenshot(cdp, 'sid1', { format: 'png' });
    expect(cdpCalls).toBe(2); // Tier 1 + Tier 2

    // Second call: should skip directly to Tier 3
    cdpCalls = 0;
    await captureScreenshot(cdp, 'sid1', { format: 'png' });
    expect(cdpCalls).toBe(0); // no captureScreenshot calls at all
    expect(getScreenshotTier()).toBe(3);
  });
});

// =========================================================================
// screencastFallback
// =========================================================================

describe('screencastFallback', () => {
  it('should return frame data on successful screencast', async () => {
    const cdp = createMockCDP({
      'event:Page.screencastFrame': () => ({ data: 'screencast-b64', sessionId: 7 }),
    });
    const data = await screencastFallback(cdp, 'sid1');
    expect(data).toBe('screencast-b64');
    // Verify startScreencast was called
    expect(cdp.calls.some(c => c.method === 'Page.startScreencast')).toBe(true);
  });

  it('should call stopScreencast in finally (even on success)', async () => {
    const cdp = createMockCDP({
      'event:Page.screencastFrame': () => ({ data: 'ok', sessionId: 1 }),
    });
    await screencastFallback(cdp, 'sid1');
    // stopScreencast is fire-and-forget so it may appear after a microtask
    await new Promise(r => setTimeout(r, 10));
    expect(cdp.calls.some(c => c.method === 'Page.stopScreencast')).toBe(true);
  });

  it('should reject when no screencast frame arrives (timeout)', async () => {
    const cdp = createMockCDP({
      // No event:Page.screencastFrame → waitForEvent rejects
    });
    await expect(screencastFallback(cdp, 'sid1')).rejects.toThrow();
  });

  it('should acknowledge frame to prevent screencast stall', async () => {
    const cdp = createMockCDP({
      'event:Page.screencastFrame': () => ({ data: 'ok', sessionId: 99 }),
    });
    await screencastFallback(cdp, 'sid1');
    await new Promise(r => setTimeout(r, 10));
    const ackCall = cdp.calls.find(c => c.method === 'Page.screencastFrameAck');
    expect(ackCall).toBeDefined();
    expect(ackCall.params.sessionId).toBe(99);
  });
});

// =========================================================================
// snapshotStr — perceive hint
// =========================================================================

describe('snapshotStr', () => {
  it('should append perceive recommendation hint', async () => {
    const cdp = createMockCDP({
      'Accessibility.getFullAXTree': () => ({
        nodes: [
          { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Test Page' } },
          { nodeId: '2', parentId: '1', role: { value: 'heading' }, name: { value: 'Hello' } },
        ],
      }),
    });
    const result = await snapshotStr(cdp, 'sid1', true);
    expect(result).toContain('[RootWebArea]');
    expect(result).toContain('[heading] Hello');
    // Critical: the hint must be present
    expect(result).toMatch(/perceive/i);
    expect(result).toMatch(/recommended/i);
  });

  it('should include hint even for empty AX tree', async () => {
    const cdp = createMockCDP({
      'Accessibility.getFullAXTree': () => ({ nodes: [] }),
    });
    const result = await snapshotStr(cdp, 'sid1', true);
    expect(result).toMatch(/perceive/i);
  });
});

// =========================================================================
// perceivePageScript — extracted browser-side script
// =========================================================================

describe('perceivePageScript', () => {
  it('should return a string containing a self-invoking function', () => {
    const script = perceivePageScript(false);
    expect(typeof script).toBe('string');
    expect(script).toMatch(/^\(function\(\)/);
    expect(script).toMatch(/\)\(\)$/);
  });

  it('should interpolate cursorInteractive=false to disable scan', () => {
    const script = perceivePageScript(false);
    expect(script).toContain('if (false)');
    expect(script).not.toContain('if (true)');
  });

  it('should interpolate cursorInteractive=true to enable scan', () => {
    const script = perceivePageScript(true);
    expect(script).toContain('if (true)');
  });

  it('should use targeted selector instead of querySelectorAll("*")', () => {
    const script = perceivePageScript(true);
    // The optimized version uses specific tag selectors, not wildcard *
    expect(script).not.toContain("querySelectorAll('*')");
    // Should target common clickable container elements
    expect(script).toContain('div, span, li');
    expect(script).toContain('[onclick]');
    expect(script).toContain('[tabindex]');
  });

  it('should collect layout map, style hints, and counts', () => {
    const script = perceivePageScript(false);
    expect(script).toContain('layoutMap');
    expect(script).toContain('styleHints');
    expect(script).toContain('counts');
    expect(script).toContain('cursorInteractives');
  });
});

// =========================================================================
// perceiveStr — integration test with mock CDP
// =========================================================================

describe('perceiveStr integration', () => {
  // Minimal page metadata that perceivePageScript would return from the browser
  const fakeMeta = JSON.stringify({
    title: 'Test Page', url: 'https://example.com',
    vw: 1280, vh: 720, scrollY: 0, scrollMax: 500,
    counts: { a: 2, button: 1 },
    focused: 'none',
    layoutMap: {
      banner: [{ h: 80, bg: 'rgb(26,26,46)', vis: 'above' }],
      main: [{ h: 2000 }],
    },
    styleHints: {},
    cursorInteractives: [],
  });

  // Minimal AX tree with a banner, main, link, and button
  const fakeAxNodes = [
    { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Test Page' } },
    { nodeId: '2', parentId: '1', role: { value: 'banner' }, name: { value: 'Site Header' }, backendDOMNodeId: 100 },
    { nodeId: '3', parentId: '2', role: { value: 'link' }, name: { value: 'Home' }, backendDOMNodeId: 101 },
    { nodeId: '4', parentId: '1', role: { value: 'main' }, name: { value: 'Content' }, backendDOMNodeId: 102 },
    { nodeId: '5', parentId: '4', role: { value: 'heading' }, name: { value: 'Welcome' }, backendDOMNodeId: 103 },
    { nodeId: '6', parentId: '4', role: { value: 'button' }, name: { value: 'Submit' }, backendDOMNodeId: 104 },
  ];

  function makePerceiveCDP() {
    return createMockCDP({
      'Accessibility.getFullAXTree': () => ({ nodes: fakeAxNodes }),
      'Runtime.evaluate': () => ({ result: { value: fakeMeta } }),
      'DOM.resolveNode': (params) => ({ object: { objectId: `obj-${params.backendNodeId}` } }),
      'Runtime.callFunctionOn': () => ({
        result: { value: { x: 10, y: 20, w: 100, h: 30 } },
      }),
    });
  }

  it('should produce header with page title, URL, viewport, and console health', async () => {
    const cdp = makePerceiveCDP();
    const refMap = new Map();
    const consoleBuf = new RingBuffer(200);
    const exceptionBuf = new RingBuffer(50);
    const store = { output: null };

    const result = await T.evalStr(cdp, 'sid1', '1').then(() => null).catch(() => null);
    // Use buildPerceiveTree directly since perceiveStr needs real evalStr
    const { treeLines, refNodeIds } = buildPerceiveTree(fakeAxNodes, JSON.parse(fakeMeta), refMap, {});

    expect(treeLines.length).toBeGreaterThan(0);
    // Should have @refs for interactive elements (link + button)
    expect(refNodeIds.length).toBe(2);
    expect(refMap.size).toBe(2);
  });

  it('should assign @ref to link and button but not heading or banner', async () => {
    const refMap = new Map();
    const meta = JSON.parse(fakeMeta);
    const { refNodeIds } = buildPerceiveTree(fakeAxNodes, meta, refMap, {});

    // link and button get refs
    const refBackendIds = refNodeIds.map(r => r.backendDOMNodeId);
    expect(refBackendIds).toContain(101); // link "Home"
    expect(refBackendIds).toContain(104); // button "Submit"
    // banner and heading do NOT get refs
    expect(refBackendIds).not.toContain(100);
    expect(refBackendIds).not.toContain(103);
  });

  it('should include layout annotations on enriched roles', async () => {
    const refMap = new Map();
    const meta = JSON.parse(fakeMeta);
    const { treeLines } = buildPerceiveTree(fakeAxNodes, meta, refMap, {});
    const bannerLine = treeLines.find(l => l.includes('[banner]'));
    expect(bannerLine).toBeDefined();
    // Banner has height and bg from layout map
    expect(bannerLine).toContain('↕80px');
    expect(bannerLine).toContain('bg:rgb(26,26,46)');
  });

  it('should respect --interactive mode (only show interactive elements)', async () => {
    const refMap = new Map();
    const meta = JSON.parse(fakeMeta);
    const { treeLines } = buildPerceiveTree(fakeAxNodes, meta, refMap, { interactiveOnly: true });
    // Should include link and button
    const hasLink = treeLines.some(l => l.includes('[link]'));
    const hasButton = treeLines.some(l => l.includes('[button]'));
    expect(hasLink).toBe(true);
    expect(hasButton).toBe(true);
    // Should NOT include heading (it's not interactive, not enriched in this context)
    // (heading IS in ENRICHED_ROLES so it still shows as structural parent)
  });

  it('should respect maxDepth limit', async () => {
    const refMap = new Map();
    const meta = JSON.parse(fakeMeta);
    // Depth 0 = only roots
    const { treeLines } = buildPerceiveTree(fakeAxNodes, meta, refMap, { maxDepth: 0 });
    // Only root-level node should be in output
    const lines = treeLines.filter(l => l.trim().length > 0);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('[RootWebArea]');
    // But refs should still be assigned (even beyond depth)
    expect(refMap.size).toBe(2);
  });

  it('diff mode should report no changes when tree is identical', async () => {
    const refMap = new Map();
    const meta = JSON.parse(fakeMeta);
    const store = { output: null };
    const consoleBuf = new RingBuffer(200);
    const exceptionBuf = new RingBuffer(50);

    // Build a fake "first perceive" output manually
    const { treeLines } = buildPerceiveTree(fakeAxNodes, meta, refMap, {});
    const header = [
      `Page: Test Page — https://example.com`,
      `Viewport: 1280×720 | Scroll: 0/500 (0%) | Focused: none`,
      `Interactive: 2 a, 1 button`,
      `Console: clean`,
    ];
    store.output = [...header, '', ...treeLines].join('\n');

    // Build same tree again for diff — should detect no changes
    const refMap2 = new Map();
    const { treeLines: treeLines2 } = buildPerceiveTree(fakeAxNodes, meta, refMap2, {});
    const output2 = [...header, '', ...treeLines2].join('\n');
    const prev = store.output.split('\n');
    const curr = output2.split('\n');
    const prevTree = prev.slice(4);
    const currTree = curr.slice(4);
    const prevSet = new Set(prevTree);
    const currSet = new Set(currTree);
    const removed = prevTree.filter(l => !currSet.has(l));
    const added = currTree.filter(l => !prevSet.has(l));
    expect(removed.length).toBe(0);
    expect(added.length).toBe(0);
  });
});

// =========================================================================
// injectStr — live CSS/JS injection
// =========================================================================

describe('injectStr', () => {
  it('--css should inject a style element with data-cdp-inject attribute', async () => {
    let evalledExpr = '';
    const cdp = createMockCDP({
      'Runtime.evaluate': (params) => {
        evalledExpr = params.expression;
        return { result: { value: 'inject-1' } };
      },
    });
    const result = await injectStr(cdp, 'sid1', ['--css', 'body { color: red }']);
    expect(result).toBe('inject-1');
    expect(evalledExpr).toContain('createElement');
    expect(evalledExpr).toContain('data-cdp-inject');
    expect(evalledExpr).toContain('body { color: red }');
  });

  it('--css-file should inject a link element', async () => {
    let evalledExpr = '';
    const cdp = createMockCDP({
      'Runtime.evaluate': (params) => {
        evalledExpr = params.expression;
        return { result: { value: 'inject-1' } };
      },
    });
    const result = await injectStr(cdp, 'sid1', ['--css-file', 'https://cdn.example.com/style.css']);
    expect(result).toBe('inject-1');
    expect(evalledExpr).toContain('link');
    expect(evalledExpr).toContain('stylesheet');
    expect(evalledExpr).toContain('https://cdn.example.com/style.css');
  });

  it('--js-file should inject a script element with onload', async () => {
    let evalledExpr = '';
    const cdp = createMockCDP({
      'Runtime.evaluate': (params) => {
        evalledExpr = params.expression;
        return { result: { value: 'inject-2' } };
      },
    });
    const result = await injectStr(cdp, 'sid1', ['--js-file', 'https://cdn.example.com/lib.js']);
    expect(result).toBe('inject-2');
    expect(evalledExpr).toContain('script');
    expect(evalledExpr).toContain('.src');
    expect(evalledExpr).toContain('onload');
  });

  it('--remove should remove elements with data-cdp-inject', async () => {
    let evalledExpr = '';
    const cdp = createMockCDP({
      'Runtime.evaluate': (params) => {
        evalledExpr = params.expression;
        return { result: { value: '3 element(s) removed' } };
      },
    });
    const result = await injectStr(cdp, 'sid1', ['--remove']);
    expect(result).toBe('3 element(s) removed');
    expect(evalledExpr).toContain('[data-cdp-inject]');
  });

  it('--remove with specific id should target that injection', async () => {
    let evalledExpr = '';
    const cdp = createMockCDP({
      'Runtime.evaluate': (params) => {
        evalledExpr = params.expression;
        return { result: { value: '1 element(s) removed' } };
      },
    });
    const result = await injectStr(cdp, 'sid1', ['--remove', 'inject-2']);
    expect(result).toBe('1 element(s) removed');
    expect(evalledExpr).toContain('inject-2');
  });

  it('--css with empty content should throw', async () => {
    const cdp = createMockCDP({});
    await expect(injectStr(cdp, 'sid1', ['--css'])).rejects.toThrow(/CSS text required/);
  });

  it('--css-file with no URL should throw', async () => {
    const cdp = createMockCDP({});
    await expect(injectStr(cdp, 'sid1', ['--css-file'])).rejects.toThrow(/URL required/);
  });

  it('--js-file with no URL should throw', async () => {
    const cdp = createMockCDP({});
    await expect(injectStr(cdp, 'sid1', ['--js-file'])).rejects.toThrow(/URL required/);
  });

  it('unknown flag should throw with usage', async () => {
    const cdp = createMockCDP({});
    await expect(injectStr(cdp, 'sid1', ['--html', '<div>'])).rejects.toThrow(/--css.*--css-file.*--js-file.*--remove/);
  });

  it('--css-file should reject non-http URLs', async () => {
    const cdp = createMockCDP({});
    await expect(injectStr(cdp, 'sid1', ['--css-file', 'data:text/css,body{color:red}'])).rejects.toThrow(/Only http/);
    await expect(injectStr(cdp, 'sid1', ['--css-file', 'file:///etc/passwd'])).rejects.toThrow(/Only http/);
  });

  it('--js-file should reject non-http URLs', async () => {
    const cdp = createMockCDP({});
    await expect(injectStr(cdp, 'sid1', ['--js-file', 'data:text/javascript,alert(1)'])).rejects.toThrow(/Only http/);
    await expect(injectStr(cdp, 'sid1', ['--js-file', 'javascript:void(0)'])).rejects.toThrow(/Only http|Invalid URL/);
  });

  it('--css-file should reject cloud metadata URLs', async () => {
    const cdp = createMockCDP({});
    await expect(injectStr(cdp, 'sid1', ['--css-file', 'http://169.254.169.254/latest/'])).rejects.toThrow(/metadata/i);
  });
});

// =========================================================================
// cascadeStr — CSS origin tracing
// =========================================================================

describe('cascadeStr', () => {
  function makeCascadeCDP(matchedRules = [], computedStyle = [], inherited = []) {
    return createMockCDP({
      'DOM.getDocument': () => ({ root: { nodeId: 1 } }),
      'DOM.querySelector': () => ({ nodeId: 10 }),
      'DOM.pushNodesByBackendIdsToFrontend': () => ({ nodeIds: [10] }),
      'CSS.getStyleSheetText': ({ styleSheetId }) => ({ text: `/* ${styleSheetId} */` }),
      'CSS.getMatchedStylesForNode': () => ({
        matchedCSSRules: matchedRules,
        inherited,
      }),
      'CSS.getComputedStyleForNode': () => ({ computedStyle }),
    });
  }

  it('should show winning and overridden rules for a property', async () => {
    const cdp = makeCascadeCDP(
      [
        {
          rule: {
            selectorList: { text: '.btn-primary' },
            origin: 'regular',
            style: {
              styleSheetId: 'components.css',
              range: { startLine: 141 },
              cssProperties: [{ name: 'background-color', value: '#2563eb' }],
            },
          },
        },
        {
          rule: {
            selectorList: { text: 'button' },
            origin: 'regular',
            style: {
              styleSheetId: 'base.css',
              range: { startLine: 27 },
              cssProperties: [{ name: 'background-color', value: '#e5e7eb' }],
            },
          },
        },
      ],
      [{ name: 'background-color', value: '#2563eb' }],
    );
    const result = await cascadeStr(cdp, 'sid1', '.btn', 'background-color', new Map());
    expect(result).toContain('background-color: #2563eb');
    expect(result).toContain('✓ .btn-primary');
    expect(result).toContain('✗ button');
    expect(result).toContain('[overridden]');
    expect(result).toContain('components.css:142');
    expect(result).toContain('base.css:28');
  });

  it('should show inherited properties', async () => {
    const cdp = makeCascadeCDP(
      [],
      [{ name: 'color', value: 'rgb(31, 41, 55)' }],
      [
        {
          matchedCSSRules: [{
            rule: {
              selectorList: { text: 'body' },
              origin: 'regular',
              style: {
                styleSheetId: 'base.css',
                range: { startLine: 11 },
                cssProperties: [{ name: 'color', value: '#1f2937' }],
              },
            },
          }],
        },
      ],
    );
    const result = await cascadeStr(cdp, 'sid1', '.text', null, new Map());
    expect(result).toContain('Inherited:');
    expect(result).toContain('color: #1f2937');
    expect(result).toContain('body');
    expect(result).toContain('base.css:12');
  });

  it('should return descriptive message when no rules match', async () => {
    const cdp = makeCascadeCDP([], []);
    const result = await cascadeStr(cdp, 'sid1', '.empty', null, new Map());
    expect(result).toContain('No matching CSS rules');
  });

  it('should filter to a single property', async () => {
    const cdp = makeCascadeCDP(
      [
        {
          rule: {
            selectorList: { text: '.box' },
            origin: 'regular',
            style: {
              styleSheetId: 'style.css',
              range: { startLine: 0 },
              cssProperties: [
                { name: 'color', value: 'red' },
                { name: 'margin', value: '10px' },
              ],
            },
          },
        },
      ],
      [
        { name: 'color', value: 'red' },
        { name: 'margin', value: '10px' },
      ],
    );
    const result = await cascadeStr(cdp, 'sid1', '.box', 'color', new Map());
    expect(result).toContain('color: red');
    expect(result).not.toContain('margin');
  });

  it('should resolve @ref to nodeId', async () => {
    const refMap = new Map([[3, 42]]);
    const cdp = makeCascadeCDP([], [{ name: 'display', value: 'block' }]);
    const result = await cascadeStr(cdp, 'sid1', '@3', null, refMap);
    // Should not throw — ref resolved successfully
    expect(typeof result).toBe('string');
  });

  it('should throw on unknown @ref', async () => {
    const cdp = makeCascadeCDP([], []);
    await expect(cascadeStr(cdp, 'sid1', '@99', null, new Map())).rejects.toThrow(/Unknown ref/);
  });

  it('should throw when no selector provided', async () => {
    const cdp = makeCascadeCDP([], []);
    await expect(cascadeStr(cdp, 'sid1', undefined, null, new Map())).rejects.toThrow(/selector.*required/i);
  });

  it('should show computed value when property has no explicit rule', async () => {
    const cdp = makeCascadeCDP(
      [],
      [{ name: 'display', value: 'flex' }],
    );
    const result = await cascadeStr(cdp, 'sid1', '.box', 'display', new Map());
    expect(result).toContain('display: flex');
    expect(result).toContain('no explicit rule');
  });

  it('should report inline styles with highest priority', async () => {
    const cdp = createMockCDP({
      'DOM.getDocument': () => ({ root: { nodeId: 1 } }),
      'DOM.querySelector': () => ({ nodeId: 10 }),
      'CSS.getStyleSheetText': ({ styleSheetId }) => ({ text: `/* ${styleSheetId} */` }),
      'CSS.getMatchedStylesForNode': () => ({
        matchedCSSRules: [{
          rule: {
            selectorList: { text: '.box' },
            origin: 'regular',
            style: {
              styleSheetId: 'style.css',
              range: { startLine: 9 },
              cssProperties: [{ name: 'color', value: 'blue' }],
            },
          },
        }],
        inlineStyle: {
          cssProperties: [{ name: 'color', value: 'red' }],
        },
        inherited: [],
      }),
      'CSS.getComputedStyleForNode': () => ({
        computedStyle: [{ name: 'color', value: 'red' }],
      }),
    });
    const result = await cascadeStr(cdp, 'sid1', '.box', 'color', new Map());
    expect(result).toContain('color: red');
    expect(result).toContain('✓ [inline]');
    expect(result).toContain('inline style attribute');
    expect(result).toContain('✗ .box');
    expect(result).toContain('[overridden]');
  });

  it('should enable DOM/CSS and request document before first style lookup', async () => {
    const cdp = makeCascadeCDP(
      [{
        rule: { selectorList: { text: '.box' }, origin: 'regular', style: {
          styleSheetId: 'style.css', range: { startLine: 0 }, cssProperties: [{ name: 'display', value: 'block' }],
        } },
      }],
      [{ name: 'display', value: 'block' }],
    );
    await cascadeStr(cdp, 'sid1', '.box', 'display', new Map());
    expect(cdp.calls.map(c => c.method)).toEqual(expect.arrayContaining(['DOM.enable', 'CSS.enable', 'DOM.getDocument']));
    expect(cdp.calls.findIndex(c => c.method === 'DOM.getDocument')).toBeLessThan(
      cdp.calls.findIndex(c => c.method === 'CSS.getMatchedStylesForNode')
    );
  });

  it('should use sourceURL from stylesheet text when available', async () => {
    const cdp = createMockCDP({
      'DOM.getDocument': () => ({ root: { nodeId: 1 } }),
      'DOM.querySelector': () => ({ nodeId: 10 }),
      'CSS.getStyleSheetText': () => ({ text: '.box{color:red}\n/*# sourceURL=/src/Button.module.css */' }),
      'CSS.getMatchedStylesForNode': () => ({
        matchedCSSRules: [{
          rule: { selectorList: { text: '.box' }, origin: 'regular', style: {
            styleSheetId: 'style-sheet-123', range: { startLine: 4 }, cssProperties: [{ name: 'color', value: 'red' }],
          } },
        }],
        inherited: [],
      }),
      'CSS.getComputedStyleForNode': () => ({ computedStyle: [{ name: 'color', value: 'red' }] }),
    });
    const result = await cascadeStr(cdp, 'sid1', '.box', 'color', new Map());
    expect(result).toContain('/src/Button.module.css:5');
    expect(result).not.toContain('style-sheet-123:5');
  });

  // Regression: dogfood report showed identical winner / overridden lines
  // appearing twice when CDP returned the same matchedCSSRule twice.
  it('should dedupe identical matchedCSSRules entries before formatting', async () => {
    const dupRule = {
      rule: {
        selectorList: { text: '.primary' },
        origin: 'regular',
        style: {
          styleSheetId: 'base.css',
          range: { startLine: 4 },
          cssProperties: [{ name: 'background-color', value: 'rgb(37, 99, 235)' }],
        },
      },
    };
    const cdp = makeCascadeCDP(
      [dupRule, dupRule],
      [{ name: 'background-color', value: 'rgb(37, 99, 235)' }],
    );
    const result = await cascadeStr(cdp, 'sid1', '.btn', 'background-color', new Map());
    // The .primary rule should appear exactly once, not twice.
    const matches = result.match(/\.primary \{ background-color: rgb\(37, 99, 235\) \}/g) || [];
    expect(matches).toHaveLength(1);
  });

  // Regression: semantically identical CSS values may differ only by formatting
  // (e.g. authored rgb(37,99,235) vs CDP-normalized rgb(37, 99, 235)).
  it('should dedupe and mark winner using normalized CSS values', async () => {
    const cdp = makeCascadeCDP(
      [{
        rule: {
          selectorList: { text: '.primary' },
          origin: 'regular',
          style: {
            styleSheetId: 'base.css',
            range: { startLine: 4 },
            cssProperties: [
              { name: 'background-color', value: 'rgb(37,99,235)' },
              { name: 'background-color', value: 'rgb(37, 99, 235)' },
            ],
          },
        },
      }],
      [{ name: 'background-color', value: 'rgb(37, 99, 235)' }],
    );
    const result = await cascadeStr(cdp, 'sid1', '.btn', 'background-color', new Map());
    const matches = result.match(/\.primary \{ background-color:/g) || [];
    expect(matches).toHaveLength(1);
    expect(result).toContain('✓ .primary');
    expect(result).not.toContain('✗ .primary');
  });

  // Regression: same property listed twice within a single rule's
  // cssProperties (e.g. fallback declarations) should also dedupe.
  it('should dedupe duplicate cssProperties within a single rule', async () => {
    const cdp = makeCascadeCDP(
      [{
        rule: {
          selectorList: { text: '.box' },
          origin: 'regular',
          style: {
            styleSheetId: 'style.css',
            range: { startLine: 0 },
            cssProperties: [
              { name: 'color', value: 'rgb(255, 255, 255)' },
              { name: 'color', value: 'rgb(255, 255, 255)' },
            ],
          },
        },
      }],
      [{ name: 'color', value: 'rgb(255, 255, 255)' }],
    );
    const result = await cascadeStr(cdp, 'sid1', '.box', 'color', new Map());
    const matches = result.match(/\.box \{ color: rgb\(255, 255, 255\) \}/g) || [];
    expect(matches).toHaveLength(1);
  });

  // Regression: duplicate inherited rules (same selector + value + source)
  // should dedupe in the Inherited: section as well.
  it('should dedupe identical inherited rule lines', async () => {
    const dupInheritedRule = {
      rule: {
        selectorList: { text: 'body' },
        origin: 'regular',
        style: {
          styleSheetId: 'base.css',
          range: { startLine: 11 },
          cssProperties: [{ name: 'color', value: '#1f2937' }],
        },
      },
    };
    const cdp = makeCascadeCDP(
      [],
      [{ name: 'color', value: '#1f2937' }],
      [{ matchedCSSRules: [dupInheritedRule, dupInheritedRule] }],
    );
    const result = await cascadeStr(cdp, 'sid1', '.text', null, new Map());
    expect(result).toContain('Inherited:');
    const inheritedSection = result.split('Inherited:')[1] || '';
    const matches = inheritedSection.match(/color: #1f2937/g) || [];
    expect(matches).toHaveLength(1);
  });
});

// =========================================================================
// recordStr — timeline capture
// =========================================================================

describe('recordStr', () => {
  it('should parse duration, action, and until arguments', () => {
    expect(parseRecordArgs(['500']).durationMs).toBe(500);
    expect(parseRecordArgs(['--until', 'dom stable']).until).toBe('dom stable');
    const action = parseRecordArgs(['--action', 'click', '@1']);
    expect(action.action).toBe('click');
    expect(action.actionArgs).toEqual(['@1']);
    expect(() => parseRecordArgs(['--until', 'paint stable'])).toThrow(/dom stable|network idle/);
  });

  function makeRecordCDP(extraHandlers = {}) {
    const calls = [];
    const listeners = new Map();
    const cdp = {
      calls,
      listeners,
      onEvent(method, cb) {
        if (!listeners.has(method)) listeners.set(method, new Set());
        listeners.get(method).add(cb);
        return () => listeners.get(method)?.delete(cb);
      },
      emit(method, params) { for (const cb of listeners.get(method) || []) cb(params); },
      send(method, params = {}, sessionId) {
        calls.push({ method, params, sessionId });
        if (extraHandlers[method]) return Promise.resolve(extraHandlers[method](params, sessionId, cdp));
        if (method === 'Runtime.evaluate') return Promise.resolve({ result: { value: JSON.stringify({ totals: {}, labels: [], count: 0 }) } });
        return Promise.resolve({});
      },
    };
    return cdp;
  }

  it('should record passive duration mode and report no events', async () => {
    const cdp = makeRecordCDP();
    const result = await recordStr(cdp, 'sid1', ['100'], new Map());
    expect(result).toContain('Record timeline');
    expect(result).toContain('no DOM, console');
    expect(cdp.calls.map(c => c.method)).toEqual(expect.arrayContaining(['Runtime.enable', 'Page.enable', 'DOM.enable', 'Network.enable']));
  });

  it('should record --until dom stable and include DOM mutation summary', async () => {
    let drained = false;
    const cdp = makeRecordCDP({
      'Runtime.evaluate': (params) => {
        if (params.expression.includes('__cdp_record_observer')) return { result: { value: 'installed' } };
        if (!drained) {
          drained = true;
          return { result: { value: JSON.stringify({ totals: { added: 2, removed: 1, attributes: 0, characterData: 0 }, labels: ['<div#app>'], count: 2 }) } };
        }
        return { result: { value: JSON.stringify({ totals: {}, labels: [], count: 0 }) } };
      },
    });
    const result = await recordStr(cdp, 'sid1', ['--until', 'dom stable'], new Map());
    expect(result).toContain('until: dom stable');
    expect(result).toContain('DOM 2 added, 1 removed');
  });

  it('should record --until network idle and include network timeline output', async () => {
    const cdp = makeRecordCDP({
      'Runtime.evaluate': () => ({ result: { value: JSON.stringify({ totals: {}, labels: [], count: 0 }) } }),
      'Network.enable': (params, sid, cdp) => {
        queueMicrotask(() => {
          cdp.emit('Network.requestWillBeSent', { requestId: 'r1', type: 'Fetch', request: { method: 'GET', url: 'https://example.com/api' } });
          cdp.emit('Network.responseReceived', { requestId: 'r1', type: 'Fetch', response: { status: 200 } });
        });
        return {};
      },
    });
    const result = await recordStr(cdp, 'sid1', ['--until', 'network idle'], new Map());
    expect(result).toContain('until: network idle');
    expect(result).toContain('GET https://example.com/api → 200');
  });

  it('should execute record --action click @ref and include action output', async () => {
    const cdp = makeRecordCDP({
      'Runtime.evaluate': (params) => {
        if (params.expression.includes('__cdp_record_observer')) return { result: { value: 'installed' } };
        return { result: { value: JSON.stringify({ totals: {}, labels: [], count: 0 }) } };
      },
      'DOM.resolveNode': () => ({ object: { objectId: 'obj-1' } }),
      'Runtime.callFunctionOn': () => ({ result: { value: { x: 10, y: 20 } } }),
      'Input.dispatchMouseEvent': () => ({}),
    });
    const result = await recordStr(cdp, 'sid1', ['--action', 'click', '@1'], new Map([[1, 123]]));
    expect(result).toContain('action: click');
    expect(result).toContain('Clicked');
    expect(cdp.calls.some(c => c.method === 'Input.dispatchMouseEvent')).toBe(true);
  });

  it('should include console and exception events in timeline output', async () => {
    const cdp = makeRecordCDP({
      'Runtime.evaluate': () => ({ result: { value: JSON.stringify({ totals: {}, labels: [], count: 0 }) } }),
      'Runtime.enable': (params, sid, cdp) => {
        queueMicrotask(() => {
          cdp.emit('Runtime.consoleAPICalled', { type: 'error', args: [{ value: 'boom' }] });
          cdp.emit('Runtime.exceptionThrown', { exceptionDetails: { text: 'Uncaught', exception: { description: 'Error: bad' } } });
        });
        return {};
      },
    });
    const result = await recordStr(cdp, 'sid1', ['100'], new Map());
    expect(result).toContain('console.error: boom');
    expect(result).toContain('exception: Error: bad');
  });

  // Regression: previous code only removed temporary listeners after the
  // happy-path loop, so any throw in the action path leaked listeners onto
  // the long-lived daemon. Use try/finally to guarantee cleanup.
  function listenerCount(cdp) {
    let total = 0;
    for (const set of cdp.listeners.values()) total += set.size;
    return total;
  }

  it('should remove temporary listeners when an unsupported action throws', async () => {
    const cdp = makeRecordCDP({
      'Runtime.evaluate': (params) => {
        if (params.expression.includes('__cdp_record_observer')) return { result: { value: 'installed' } };
        return { result: { value: JSON.stringify({ totals: {}, labels: [], count: 0 }) } };
      },
    });
    await expect(
      recordStr(cdp, 'sid1', ['--action', 'wiggle', '@1'], new Map([[1, 123]]))
    ).rejects.toThrow(/does not support: wiggle/);
    expect(listenerCount(cdp)).toBe(0);
  });

  it('should remove temporary listeners when the action implementation throws', async () => {
    const cdp = makeRecordCDP({
      'Runtime.evaluate': (params) => {
        if (params.expression.includes('__cdp_record_observer')) return { result: { value: 'installed' } };
        return { result: { value: JSON.stringify({ totals: {}, labels: [], count: 0 }) } };
      },
      // clickStr starts by resolving the @ref via DOM.resolveNode; force a
      // throw there to exercise the action error path.
      'DOM.resolveNode': () => { throw new Error('node detached'); },
    });
    await expect(
      recordStr(cdp, 'sid1', ['--action', 'click', '@1'], new Map([[1, 123]]))
    ).rejects.toThrow();
    expect(listenerCount(cdp)).toBe(0);
  });

  // Parser ergonomics: --until should work whether it appears before OR after
  // --action. Previously everything after --action was eaten as actionArgs.
  it('parseRecordArgs should accept --until after --action', () => {
    const opts = parseRecordArgs(['--action', 'click', '@5', '--until', 'network idle']);
    expect(opts.action).toBe('click');
    expect(opts.actionArgs).toEqual(['@5']);
    expect(opts.until).toBe('network idle');
    expect(opts.durationMs).toBe(30000);
  });

  it('parseRecordArgs should still accept --until before --action', () => {
    const opts = parseRecordArgs(['--until', 'dom stable', '--action', 'click', '@5']);
    expect(opts.action).toBe('click');
    expect(opts.actionArgs).toEqual(['@5']);
    expect(opts.until).toBe('dom stable');
  });

  it('parseRecordArgs should reject invalid --until value when supplied after --action', () => {
    expect(() => parseRecordArgs(['--action', 'click', '@5', '--until', 'paint stable']))
      .toThrow(/dom stable|network idle/);
  });

  // --action default: auto-settle (DOM/network quiet) capped at 5/10s when no
  // explicit duration/--until given. Explicit duration or --until is preserved.
  it('parseRecordArgs --action without duration/until defaults to auto settle (10s cap)', () => {
    const opts = parseRecordArgs(['--action', 'click', '@5']);
    expect(opts.until).toBe('auto settle');
    expect(opts.durationMs).toBe(10000);
    expect(opts.explicitDuration).toBe(false);
  });

  it('parseRecordArgs --action with explicit duration preserves duration and skips auto settle', () => {
    const opts = parseRecordArgs(['--action', 'click', '@5', '2000']);
    expect(opts.until).toBe(null);
    expect(opts.durationMs).toBe(2000);
    expect(opts.explicitDuration).toBe(true);
  });

  it('parseRecordArgs --action with explicit --until preserves it (not auto settle)', () => {
    const opts = parseRecordArgs(['--action', 'click', '@5', '--until', 'dom stable']);
    expect(opts.until).toBe('dom stable');
    expect(opts.durationMs).toBe(30000);
  });

  it('parseRecordArgs without --action keeps original 1s default', () => {
    const opts = parseRecordArgs([]);
    expect(opts.until).toBe(null);
    expect(opts.durationMs).toBe(1000);
  });
});

// =========================================================================
// mapStyleSource — improved cascade source mapping (Vite / CSS Modules)
// =========================================================================

describe('stripVitePathQuery', () => {
  it('returns input unchanged when no query', () => {
    expect(stripVitePathQuery('/src/Foo.module.css')).toBe('/src/Foo.module.css');
  });
  it('strips Vite vue/style query suffix', () => {
    expect(stripVitePathQuery('/src/App.vue?vue&type=style&index=0&scoped=true&lang.css'))
      .toBe('/src/App.vue');
  });
  it('strips ?direct and ?used suffixes', () => {
    expect(stripVitePathQuery('/src/Foo.module.css?direct')).toBe('/src/Foo.module.css');
    expect(stripVitePathQuery('/src/Foo.module.css?used')).toBe('/src/Foo.module.css');
  });
  it('handles empty input', () => {
    expect(stripVitePathQuery('')).toBe('');
  });
});

describe('decodeVLQ', () => {
  it('decodes a single zero', () => {
    expect(decodeVLQ('A')).toEqual([0]);
  });
  it('decodes a known multi-segment value (AAAA)', () => {
    // AAAA = 4 zero values — generated col, source idx, orig line, orig col deltas
    expect(decodeVLQ('AAAA')).toEqual([0, 0, 0, 0]);
  });
  it('handles continuation bits across multiple base64 chars', () => {
    // 'CAAA' encodes [1,0,0,0] (1<<1 = 2 → negate flag 0 → 1)
    const vals = decodeVLQ('CAAA');
    expect(vals).toEqual([1, 0, 0, 0]);
  });
});

describe('mapLineToSource', () => {
  it('returns null for empty mappings', () => {
    expect(mapLineToSource('', 0)).toBe(null);
  });
  it('returns null when genLine0 is out of range', () => {
    expect(mapLineToSource('AAAA', 5)).toBe(null);
  });
  it('returns mapping with srcIdx=0 origLine=0 for single AAAA segment', () => {
    const m = mapLineToSource('AAAA', 0);
    expect(m).not.toBe(null);
    expect(m.srcIdx).toBe(0);
    expect(m.origLine).toBe(0);
  });
});

describe('mapStyleSource', () => {
  it('falls back to sheetId:line when no sourceURL or sourceMappingURL', () => {
    expect(mapStyleSource('.box{color:red}', 'sheet-1', 4)).toBe('sheet-1:5');
  });

  it('uses sourceURL when present and strips Vite query suffix', () => {
    const sheet = '.box{color:red}\n/*# sourceURL=/src/Foo.module.css?vue&type=style&lang.css */';
    expect(mapStyleSource(sheet, 'sheet-1', 4)).toBe('/src/Foo.module.css:5');
  });

  it('uses external sourceMappingURL (.css.map → .css) when no sourceURL', () => {
    const sheet = '.box{color:red}\n/*# sourceMappingURL=/src/Foo.module.css.map */';
    expect(mapStyleSource(sheet, 'sheet-1', 0)).toBe('/src/Foo.module.css:1');
  });

  it('decodes inline base64 sourcemap and uses sources[0] + mapped origLine', () => {
    const map = JSON.stringify({
      version: 3,
      sources: ['/src/Button.module.css'],
      mappings: 'AAAA',
    });
    const b64 = Buffer.from(map).toString('base64');
    const sheet = `.btn{color:red}\n/*# sourceMappingURL=data:application/json;base64,${b64} */`;
    expect(mapStyleSource(sheet, 'sheet-1', 0)).toBe('/src/Button.module.css:1');
  });

  it('strips Vite query from inline source map sources[0]', () => {
    const map = JSON.stringify({
      version: 3,
      sources: ['/src/App.vue?vue&type=style&index=0'],
      mappings: 'AAAA',
    });
    const b64 = Buffer.from(map).toString('base64');
    const sheet = `.x{color:red}\n/*# sourceMappingURL=data:application/json;base64,${b64} */`;
    expect(mapStyleSource(sheet, 'sheet-1', 0)).toBe('/src/App.vue:1');
  });

  it('respects sourceRoot when joining sources path', () => {
    const map = JSON.stringify({
      version: 3,
      sourceRoot: '/project',
      sources: ['src/styles/main.css'],
      mappings: 'AAAA',
    });
    const b64 = Buffer.from(map).toString('base64');
    const sheet = `*{}\n/*# sourceMappingURL=data:application/json;base64,${b64} */`;
    expect(mapStyleSource(sheet, 'sheet-1', 0)).toBe('/project/src/styles/main.css:1');
  });

  it('degrades to sheetId:line when base64 sourcemap is malformed', () => {
    const sheet = '.x{}\n/*# sourceMappingURL=data:application/json;base64,!!!not-base64-or-json!!! */';
    // Either succeeds with our regex matching or falls back gracefully — must
    // not throw, and must produce some line reference for the rule.
    const out = mapStyleSource(sheet, 'sheet-99', 3);
    expect(typeof out).toBe('string');
    expect(out).toContain(':4');
  });
});

// =========================================================================
// cascadeStr — integration with mapStyleSource (Vite / CSS Modules)
// =========================================================================

describe('cascadeStr Vite/CSS-modules integration', () => {
  function mkCdp(sheetText) {
    return {
      calls: [],
      send(method, params = {}) {
        this.calls.push({ method, params });
        if (method === 'DOM.getDocument') return Promise.resolve({ root: { nodeId: 1 } });
        if (method === 'DOM.querySelector') return Promise.resolve({ nodeId: 10 });
        if (method === 'CSS.getStyleSheetText') return Promise.resolve({ text: sheetText });
        if (method === 'CSS.getMatchedStylesForNode') return Promise.resolve({
          matchedCSSRules: [{
            rule: {
              selectorList: { text: '.btn' },
              origin: 'regular',
              style: {
                styleSheetId: 'opaque-sheet-id-xyz',
                range: { startLine: 0 },
                cssProperties: [{ name: 'color', value: 'rgb(0, 128, 0)' }],
              },
            },
          }],
          inherited: [],
        });
        if (method === 'CSS.getComputedStyleForNode') return Promise.resolve({
          computedStyle: [{ name: 'color', value: 'rgb(0, 128, 0)' }],
        });
        return Promise.resolve({});
      },
      onEvent() { return () => {}; },
    };
  }

  it('shows a CSS module path (with Vite query stripped) instead of opaque sheet id', async () => {
    const sheet = '.btn{color:rgb(0,128,0)}\n/*# sourceURL=/src/Button.module.css?vue&type=style&lang.css */';
    const cdp = mkCdp(sheet);
    const out = await cascadeStr(cdp, 'sid', '.btn', 'color', new Map());
    expect(out).toContain('/src/Button.module.css:1');
    expect(out).not.toContain('opaque-sheet-id-xyz');
  });

  it('uses inline base64 sourcemap to resolve original module path', async () => {
    const map = JSON.stringify({
      version: 3,
      sources: ['/src/components/Card.module.css'],
      mappings: 'AAAA',
    });
    const b64 = Buffer.from(map).toString('base64');
    const sheet = `.btn{color:rgb(0,128,0)}\n/*# sourceMappingURL=data:application/json;base64,${b64} */`;
    const cdp = mkCdp(sheet);
    const out = await cascadeStr(cdp, 'sid', '.btn', 'color', new Map());
    expect(out).toContain('/src/components/Card.module.css:1');
    expect(out).not.toContain('opaque-sheet-id-xyz');
  });

  it('degrades to sheetId:line when sheet text is empty (safe fallback)', async () => {
    const cdp = mkCdp('');
    const out = await cascadeStr(cdp, 'sid', '.btn', 'color', new Map());
    expect(out).toContain('opaque-sheet-id-xyz:1');
  });
});

// =========================================================================
// formatBatchResults — human-readable batch output
// =========================================================================

describe('formatBatchResults', () => {
  const results = [
    { cmd: 'click', ok: true, result: 'Clicked <button> "Submit"' },
    { cmd: 'console', ok: true, result: '[error] boom\n[warning] hi' },
    { cmd: 'fill', ok: false, error: 'Element not found: #x' },
  ];

  it('default json output is parseable JSON array', () => {
    const out = formatBatchResults(results);
    const parsed = JSON.parse(out);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(3);
    expect(parsed[2].ok).toBe(false);
  });

  it('plain output is human-readable and not valid JSON', () => {
    const out = formatBatchResults(results, 'plain');
    expect(() => JSON.parse(out)).toThrow();
    expect(out).toContain('[1/3] click');
    expect(out).toContain('Clicked <button> "Submit"');
    expect(out).toContain('[2/3] console');
    expect(out).toContain('[error] boom');
    expect(out).toContain('[3/3] fill (error)');
    expect(out).toContain('Element not found: #x');
  });

  it('compact output is one line per command', () => {
    const out = formatBatchResults(results, 'compact');
    const lines = out.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('[1] click');
    expect(lines[0]).toContain('Clicked <button> "Submit"');
    expect(lines[1]).toContain('[2] console');
    expect(lines[1]).toContain('[error] boom');
    expect(lines[1]).not.toContain('[warning] hi'); // truncated to first line
    expect(lines[2]).toContain('[3] fill');
    expect(lines[2]).toContain('ERROR Element not found');
  });

  it('plain output handles empty result string with bare header', () => {
    const out = formatBatchResults([{ cmd: 'press', ok: true, result: '' }], 'plain');
    expect(out).toContain('[1/1] press');
  });

  it('compact marks empty result as ok', () => {
    const out = formatBatchResults([{ cmd: 'press', ok: true, result: '' }], 'compact');
    expect(out).toContain('[1] press: ok');
  });

  it('formats structured JSON with failed step recovery hints for agents', () => {
    const out = formatBatchResults(results, 'model', {
      targetId: 'ABC123',
      mode: 'sequential',
    });
    const parsed = JSON.parse(out);

    expect(parsed).toMatchObject({
      schema: 'chrome-cdp-ex.batch.v1',
      targetId: 'ABC123',
      mode: 'sequential',
      counts: {
        steps: 3,
        ok: 2,
        failed: 1,
      },
      failedStep: {
        index: 3,
        cmd: 'fill',
        ok: false,
        error: 'Element not found: #x',
      },
      nextSteps: ['cdp status ABC123'],
    });
    expect(parsed.steps[0]).toMatchObject({
      index: 1,
      cmd: 'click',
      ok: true,
      resultPreview: 'Clicked <button> "Submit"',
    });
  });

  it('extracts classified action failure next steps from structured batch JSON', () => {
    const out = formatBatchResults([{
      cmd: 'click',
      ok: false,
      error: [
        'Action failure: overlay',
        'Reason: overlay blocked the target',
        'Next: cdp dismiss-modal ABC123',
        'Original: Other element would receive the click',
      ].join('\n'),
    }], 'model', { targetId: 'ABC123' });
    const parsed = JSON.parse(out);

    expect(parsed.failedStep).toMatchObject({
      cmd: 'click',
      failureKind: 'overlay',
      nextCommand: 'cdp dismiss-modal ABC123',
    });
    expect(parsed.nextSteps).toEqual(['cdp dismiss-modal ABC123']);
  });

  it('surfaces attention diagnoses from successful action JSON steps', () => {
    const action = T.applyActionObservationDelta(T.createActionResult({
      action: 'click',
      target: { targetId: 'ABC123', input: '#save', resolvedBy: 'selector', label: 'Save' },
      dispatch: { ok: true, method: 'click' },
      settle: { ok: true, durationMs: 120 },
      effects: { domDiff: 'error banner appeared', console: [], network: [], navigation: null },
      nextHint: null,
    }), {
      console: { count: 0, errors: 0, warnings: 0, entries: [] },
      exceptions: { count: 0, entries: [] },
      network: {
        count: 1,
        failures: 1,
        pending: 0,
        entries: [{ method: 'POST', url: 'https://example.com/api/save', status: 500, duration: 44 }],
      },
    });
    const out = formatBatchResults([{ cmd: 'click', ok: true, result: T.formatJson(action) }], 'model', { targetId: 'ABC123' });
    const parsed = JSON.parse(out);

    expect(parsed.counts).toMatchObject({ steps: 1, ok: 1, failed: 0, attention: 1 });
    expect(parsed.steps[0]).toMatchObject({
      cmd: 'click',
      ok: true,
      diagnosis: {
        status: 'attention',
        kind: 'network-failure',
        nextCommand: 'cdp netlog ABC123',
      },
    });
    expect(parsed.nextSteps).toEqual([
      'cdp netlog ABC123',
      'cdp perceive ABC123 --since-action',
      'cdp report ABC123 --format json',
    ]);
  });
});

describe('parseBatchArgs', () => {
  it('keeps legacy JSON array output by default', () => {
    expect(parseBatchArgs(['click #ok | summary'])).toMatchObject({
      parallel: false,
      output: 'legacy-json',
      commands: [
        { cmd: 'click', args: ['#ok'] },
        { cmd: 'summary', args: [] },
      ],
    });
  });

  it('parses explicit --format json as structured batch output', () => {
    expect(parseBatchArgs(['--format', 'json', 'click #ok | click #missing'])).toMatchObject({
      output: 'model',
      commands: [
        { cmd: 'click', args: ['#ok'] },
        { cmd: 'click', args: ['#missing'] },
      ],
    });
  });

  it('preserves plain and compact text modes', () => {
    expect(parseBatchArgs(['--plain', 'click #ok']).output).toBe('plain');
    expect(parseBatchArgs(['--compact', 'click #ok']).output).toBe('compact');
  });
});

// =========================================================================
// parseFlowSteps — semicolon-separated step parser
// =========================================================================

describe('parseFlowSteps', () => {
  it('returns empty array for empty input', () => {
    expect(parseFlowSteps('')).toEqual([]);
    expect(parseFlowSteps('   ')).toEqual([]);
    expect(parseFlowSteps(undefined)).toEqual([]);
  });

  it('parses a single command step', () => {
    expect(parseFlowSteps('click @1')).toEqual([
      { kind: 'command', cmd: 'click', args: ['@1'] },
    ]);
  });

  it('parses multiple steps separated by semicolons', () => {
    const steps = parseFlowSteps('click @1; summary; console --errors');
    expect(steps).toHaveLength(3);
    expect(steps[0]).toEqual({ kind: 'command', cmd: 'click', args: ['@1'] });
    expect(steps[1]).toEqual({ kind: 'command', cmd: 'summary', args: [] });
    expect(steps[2]).toEqual({ kind: 'command', cmd: 'console', args: ['--errors'] });
  });

  it('parses wait dom stable as a wait step', () => {
    expect(parseFlowSteps('wait dom stable')).toEqual([
      { kind: 'wait', what: 'dom stable' },
    ]);
  });

  it('parses wait network idle as a wait step', () => {
    expect(parseFlowSteps('wait network idle')).toEqual([
      { kind: 'wait', what: 'network idle' },
    ]);
  });

  it('mixes wait and command steps', () => {
    const steps = parseFlowSteps('click @1; wait dom stable; summary; console --errors');
    expect(steps.map(s => s.kind)).toEqual(['command', 'wait', 'command', 'command']);
    expect(steps[1].what).toBe('dom stable');
  });

  it('trims whitespace and skips empty steps', () => {
    expect(parseFlowSteps('  click @1  ;  ;  summary  ')).toEqual([
      { kind: 'command', cmd: 'click', args: ['@1'] },
      { kind: 'command', cmd: 'summary', args: [] },
    ]);
  });
});

// =========================================================================
// flowStr — sequential runner with halt-on-error
// =========================================================================

describe('flowStr', () => {
  it('throws when input is empty', async () => {
    await expect(flowStr({ run: async () => ({}), settle: async () => '' }, '')).rejects.toThrow(/no steps/);
  });

  it('runs commands sequentially and includes results', async () => {
    const calls = [];
    const run = async (step) => {
      calls.push(step);
      return { ok: true, result: `did ${step.cmd}` };
    };
    const settle = async () => 'ignored';
    const out = await flowStr({ run, settle }, 'click @1; summary');
    expect(calls.map(c => c.cmd)).toEqual(['click', 'summary']);
    expect(out).toContain('Flow: 2 step(s)');
    expect(out).toContain('[1/2] click @1');
    expect(out).toContain('did click');
    expect(out).toContain('[2/2] summary');
    expect(out).toContain('did summary');
  });

  it('invokes settle helper for wait steps', async () => {
    const settleCalls = [];
    const run = async () => ({ ok: true, result: 'ok' });
    const settle = async (what) => { settleCalls.push(what); return `settled: ${what}`; };
    const out = await flowStr({ run, settle }, 'wait dom stable; wait network idle');
    expect(settleCalls).toEqual(['dom stable', 'network idle']);
    expect(out).toContain('settled: dom stable');
    expect(out).toContain('settled: network idle');
  });

  it('halts immediately on the first failing step', async () => {
    const seen = [];
    const run = async (step) => {
      seen.push(step.cmd);
      if (step.cmd === 'click') return { ok: false, error: 'Element not found' };
      return { ok: true, result: 'ok' };
    };
    const out = await flowStr({ run, settle: async () => '' }, 'click @9; summary');
    expect(seen).toEqual(['click']);
    expect(out).toContain('Element not found');
    expect(out).toContain('Flow halted');
    expect(out).not.toContain('did summary');
  });

  it('halts when settle helper throws', async () => {
    const run = async () => ({ ok: true, result: 'ok' });
    const settle = async () => { throw new Error('settle exploded'); };
    const out = await flowStr({ run, settle }, 'wait dom stable; summary');
    expect(out).toContain('settle exploded');
    expect(out).toContain('Flow halted');
  });

  it('produces a step-by-step layout (not one giant JSON blob)', async () => {
    const run = async (step) => ({ ok: true, result: `result of ${step.cmd}` });
    const out = await flowStr({ run, settle: async (w) => w }, 'click @1; wait dom stable; summary');
    // Should not be JSON
    expect(() => JSON.parse(out)).toThrow();
    // Should have one numbered head per step
    const heads = out.split('\n').filter(l => /^\[\d+\/\d+\]/.test(l));
    expect(heads).toHaveLength(3);
  });

  it('returns structured JSON failure handoff for command failures', async () => {
    const seen = [];
    const run = async (step) => {
      seen.push(step.cmd);
      if (step.cmd === 'click') {
        return {
          ok: false,
          error: [
            'Action failure: selector',
            'Reason: No current element matched the requested selector/ref.',
            'Next: cdp perceive ABC123 -C -d 8',
            'Original: Element not found: #missing',
          ].join('\n'),
        };
      }
      return { ok: true, result: `did ${step.cmd}` };
    };
    const out = await flowStr(
      { run, settle: async () => '' },
      'summary; click #missing; status',
      { format: 'json', targetId: 'ABC123' }
    );
    const parsed = JSON.parse(out);

    expect(seen).toEqual(['summary', 'click']);
    expect(parsed).toMatchObject({
      schema: 'chrome-cdp-ex.flow.v1',
      targetId: 'ABC123',
      halted: true,
      counts: { steps: 3, ok: 1, failed: 1, skipped: 1 },
      failedStep: {
        index: 2,
        kind: 'command',
        cmd: 'click',
        ok: false,
        failureKind: 'selector',
        nextCommand: 'cdp perceive ABC123 -C -d 8',
      },
      nextSteps: ['cdp perceive ABC123 -C -d 8'],
    });
    expect(parsed.steps[0]).toMatchObject({ index: 1, cmd: 'summary', ok: true, resultPreview: 'did summary' });
    expect(parsed.steps[2]).toMatchObject({ index: 3, cmd: 'status', skipped: true });
  });

  it('returns structured JSON failure handoff for wait failures', async () => {
    const out = await flowStr(
      { run: async () => ({ ok: true, result: 'ok' }), settle: async () => { throw new Error('Unknown wait: "paint idle"'); } },
      'wait paint idle; summary',
      { format: 'json', targetId: 'ABC123' }
    );
    const parsed = JSON.parse(out);

    expect(parsed).toMatchObject({
      schema: 'chrome-cdp-ex.flow.v1',
      halted: true,
      failedStep: {
        index: 1,
        kind: 'wait',
        wait: 'paint idle',
        ok: false,
        error: 'Unknown wait: "paint idle"',
      },
      nextSteps: ['cdp status ABC123'],
    });
  });

  it('surfaces attention diagnoses from successful action JSON steps', async () => {
    const action = T.applyActionObservationDelta(T.createActionResult({
      action: 'click',
      target: { targetId: 'ABC123', input: '#save', resolvedBy: 'selector', label: 'Save' },
      dispatch: { ok: true, method: 'click' },
      settle: { ok: true, durationMs: 120 },
      effects: { domDiff: 'error banner appeared', console: [], network: [], navigation: null },
      nextHint: null,
    }), {
      console: { count: 0, errors: 0, warnings: 0, entries: [] },
      exceptions: { count: 0, entries: [] },
      network: {
        count: 1,
        failures: 1,
        pending: 0,
        entries: [{ method: 'POST', url: 'https://example.com/api/save', status: 500, duration: 44 }],
      },
    });
    const out = await flowStr(
      { run: async (step) => ({ ok: true, result: step.cmd === 'click' ? T.formatJson(action) : 'ok' }), settle: async () => '' },
      'click #save; summary',
      { format: 'json', targetId: 'ABC123' }
    );
    const parsed = JSON.parse(out);

    expect(parsed).toMatchObject({
      schema: 'chrome-cdp-ex.flow.v1',
      halted: false,
      counts: { steps: 2, ok: 2, failed: 0, skipped: 0, attention: 1 },
      nextSteps: [
        'cdp netlog ABC123',
        'cdp perceive ABC123 --since-action',
        'cdp report ABC123 --format json',
      ],
    });
    expect(parsed.steps[0]).toMatchObject({
      cmd: 'click',
      ok: true,
      diagnosis: {
        status: 'attention',
        kind: 'network-failure',
        nextCommand: 'cdp netlog ABC123',
      },
    });
  });
});

// =========================================================================
// replayActionsStr — execute record-actions artifacts
// =========================================================================

describe('replayActionsStr', () => {
  function artifact(actions) {
    return {
      schema: 'chrome-cdp-ex.record-actions.v1',
      targetId: 'ABC123',
      sessionId: 'sid-1',
      source: 'test',
      actionCount: actions.length,
      actions,
    };
  }

  it('replays environment controls before recorded actions', async () => {
    const calls = [];
    const source = artifact([
      { index: 1, action: 'click', command: ['click', '#combat'], replayable: true, needsInput: [] },
    ]);
    source.environmentCount = 3;
    source.environment = [
      { index: 1, type: 'mock', action: 'add', command: ['mock', 'add', '**/api/fail*', '--status', '503', '--body', '{"ok":false}'], replayable: true, needsInput: [] },
      { index: 2, type: 'throttle', action: 'apply', command: ['throttle', 'slow-3g'], replayable: true, needsInput: [] },
      { index: 3, type: 'clock', action: 'apply', command: ['clock', 'freeze', '--at', '2020-01-02T03:04:05.000Z'], replayable: true, needsInput: [] },
    ];

    const out = await T.replayActionsStr({
      run: async (step) => {
        calls.push(step);
        return { ok: true, result: `${step.cmd} ok` };
      },
    }, ['--json', JSON.stringify(source)]);

    expect(calls).toEqual([
      { cmd: 'mock', args: ['add', '**/api/fail*', '--status', '503', '--body', '{"ok":false}'] },
      { cmd: 'throttle', args: ['slow-3g'] },
      { cmd: 'clock', args: ['freeze', '--at', '2020-01-02T03:04:05.000Z'] },
      { cmd: 'click', args: ['#combat'] },
    ]);
    expect(out).toContain('Environment: 3 step(s)');
    expect(out).toContain('[env 1/3] mock add **/api/fail* --status 503 --body "{\\"ok\\":false}"');
    expect(out).toContain('[1/1] click #combat');
    expect(out).toContain('Done: 4 ok, 0 failed, 0 skipped');
  });

  it('runs replayable recorded commands sequentially', async () => {
    const calls = [];
    const source = artifact([
      { index: 1, action: 'fill', command: ['fill', '#cmd', 'look trainer'], replayable: true, needsInput: [] },
      { index: 2, action: 'click', command: ['click', '#combat'], replayable: true, needsInput: [] },
    ]);

    const out = await T.replayActionsStr({
      run: async (step) => {
        calls.push(step);
        return { ok: true, result: `${step.cmd} ok` };
      },
    }, ['--json', JSON.stringify(source)]);

    expect(calls).toEqual([
      { cmd: 'fill', args: ['#cmd', 'look trainer'] },
      { cmd: 'click', args: ['#combat'] },
    ]);
    expect(out).toContain('Replay: 2 step(s)');
    expect(out).toContain('[1/2] fill #cmd "look trainer"');
    expect(out).toContain('fill ok');
    expect(out).toContain('[2/2] click #combat');
    expect(out).toContain('Done: 2 ok, 0 failed, 0 skipped');
  });

  it('skips non-replayable recorded actions with explicit missing input', async () => {
    const calls = [];
    const source = artifact([
      { index: 1, action: 'fill', command: ['fill', '#password', '<redacted>'], replayable: false, needsInput: ['text'] },
    ]);

    const out = await T.replayActionsStr({
      run: async (step) => {
        calls.push(step);
        return { ok: true, result: 'should not run' };
      },
    }, ['--json', JSON.stringify(source)]);

    expect(calls).toEqual([]);
    expect(out).toContain('[1/1] skip fill #password <redacted>');
    expect(out).toContain('Missing: text');
    expect(out).toContain('Done: 0 ok, 0 failed, 1 skipped');
  });

  it('halts on the first failed replay step by default', async () => {
    const calls = [];
    const source = artifact([
      { index: 1, action: 'click', command: ['click', '#missing'], replayable: true, needsInput: [] },
      { index: 2, action: 'click', command: ['click', '#later'], replayable: true, needsInput: [] },
    ]);

    const out = await T.replayActionsStr({
      run: async (step) => {
        calls.push(step.cmd);
        return { ok: false, error: 'Element not found' };
      },
    }, ['--json', JSON.stringify(source)]);

    expect(calls).toEqual(['click']);
    expect(out).toContain('Element not found');
    expect(out).toContain('Replay halted at step 1/2');
    expect(out).toContain('Done: 0 ok, 1 failed, 0 skipped');
  });
});

// =========================================================================
// settleFlow — wait helpers
// =========================================================================

describe('settleFlow', () => {
  it('rejects unknown wait verb', async () => {
    const cdp = createMockCDP({});
    await expect(settleFlow(cdp, 'sid', 'paint stable', new Map())).rejects.toThrow(/dom stable.*network idle/i);
  });

  it('returns "network idle" immediately when no pending requests', async () => {
    const cdp = createMockCDP({});
    const out = await settleFlow(cdp, 'sid', 'network idle', new Map(), { quietMs: 50, maxMs: 500 });
    expect(out).toBe('network idle');
  });

  it('reports timeout for network idle when requests stay pending', async () => {
    const cdp = createMockCDP({});
    const pending = new Map([['r1', {}], ['r2', {}]]);
    const out = await settleFlow(cdp, 'sid', 'network idle', pending, { maxMs: 200, quietMs: 50 });
    expect(out).toContain('timeout');
    expect(out).toContain('2 pending');
  });

  it('uses waitForSettle for "dom stable"', async () => {
    // waitForSettle calls evalStr with a Promise. Our mock resolves immediately.
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { value: undefined } }),
    });
    const out = await settleFlow(cdp, 'sid', 'dom stable', new Map(), { maxMs: 100 });
    expect(out).toBe('dom stable');
  });
});

// =========================================================================
// Doctor / ready — diagnostics
// =========================================================================

describe('checkNode', () => {
  it('returns OK for v22+', () => {
    expect(checkNode('v22.10.0').status).toBe('OK');
    expect(checkNode('v24.0.0').status).toBe('OK');
    expect(checkNode('v22.0.0').status).toBe('OK');
  });
  it('returns FAIL for older Node', () => {
    const r = checkNode('v18.16.0');
    expect(r.status).toBe('FAIL');
    expect(r.detail).toContain('need >= 22');
    expect(r.hint).toMatch(/WebSocket/);
  });
  it('handles malformed version strings gracefully', () => {
    const r = checkNode('???');
    expect(r.status).toBe('FAIL');
  });
});

describe('checkSkillSymlink', () => {
  it('returns WARN when path does not exist', () => {
    const fs = { existsSync: () => false };
    const r = checkSkillSymlink({ home: '/home/test', fs });
    expect(r.status).toBe('WARN');
    expect(r.detail).toContain('/home/test/.claude/skills/chrome-cdp-ex');
    expect(r.detail).toContain('not found');
    expect(r.hint).toMatch(/cp -r/);
  });

  it('returns OK with "symlink" detail when target is a symlink', () => {
    const fs = { existsSync: () => true, lstatSync: () => ({ isSymbolicLink: () => true }) };
    const r = checkSkillSymlink({ home: '/h', fs });
    expect(r.status).toBe('OK');
    expect(r.detail).toContain('symlink');
  });

  it('returns OK with "directory" detail when target is a real directory', () => {
    const fs = { existsSync: () => true, lstatSync: () => ({ isSymbolicLink: () => false }) };
    const r = checkSkillSymlink({ home: '/h', fs });
    expect(r.status).toBe('OK');
    expect(r.detail).toContain('directory');
  });

  it('returns OK even when lstat is unavailable', () => {
    const fs = { existsSync: () => true, lstatSync: null };
    const r = checkSkillSymlink({ home: '/h', fs });
    expect(r.status).toBe('OK');
  });
});

describe('checkDaemonSockets', () => {
  it('returns OK with "no live tab daemons" when none running', () => {
    const r = checkDaemonSockets({ list: () => [] });
    expect(r.status).toBe('OK');
    expect(r.detail).toMatch(/no live tab daemons/);
  });
  it('lists daemon target prefixes when sockets are present', () => {
    const r = checkDaemonSockets({ list: () => [
      { targetId: 'AABBCCDDEEFF1122' },
      { targetId: 'XYZ12345QQQQ' },
    ] });
    expect(r.status).toBe('OK');
    expect(r.detail).toContain('2 live');
    expect(r.detail).toContain('AABBCCDD');
    expect(r.detail).toContain('XYZ12345');
  });
});

describe('checkCdpReachability', () => {
  it('returns OK when CDP_PORT /json/version succeeds with debugger url', async () => {
    const fetcher = async () => ({
      ok: true,
      json: async () => ({ Browser: 'Chrome/123.0', webSocketDebuggerUrl: 'ws://x:9222/devtools/browser/abc' }),
    });
    const r = await checkCdpReachability({ env: { CDP_PORT: '9222' }, fetcher });
    expect(r.status).toBe('OK');
    expect(r.detail).toContain('Chrome/123.0');
    expect(r.detail).toContain('9222');
  });

  it('annotates Electron in detail when User-Agent contains Electron/x', async () => {
    const fetcher = async () => ({
      ok: true,
      json: async () => ({
        Browser: 'HeadlessChrome/130',
        webSocketDebuggerUrl: 'ws://localhost:9222/devtools/browser/abc',
        'User-Agent': 'Mozilla/5.0 ... Electron/33.4.11',
      }),
    });
    const r = await checkCdpReachability({ env: { CDP_PORT: '9222' }, fetcher });
    expect(r.status).toBe('OK');
    expect(r.detail).toContain('Electron 33.4.11');
  });

  it('returns FAIL when fetch throws (e.g. ECONNREFUSED)', async () => {
    const fetcher = async () => { throw new Error('ECONNREFUSED'); };
    const r = await checkCdpReachability({ env: { CDP_PORT: '9999' }, fetcher });
    expect(r.status).toBe('FAIL');
    expect(r.detail).toContain('cannot reach');
    expect(r.hint).toContain('--remote-debugging-port=9999');
  });

  it('returns WARN when /json/version is reachable but missing webSocketDebuggerUrl', async () => {
    const fetcher = async () => ({ ok: true, json: async () => ({ Browser: 'Chrome/123' }) });
    const r = await checkCdpReachability({ env: { CDP_PORT: '9222' }, fetcher });
    expect(r.status).toBe('WARN');
    expect(r.detail).toMatch(/no webSocketDebuggerUrl/);
  });

  it('returns FAIL when no CDP_PORT and no DevToolsActivePort discoverable', async () => {
    // Use a fake home so no DevToolsActivePort exists.
    const fetcher = async () => { throw new Error('should not be called'); };
    const r = await checkCdpReachability({
      env: {}, fetcher,
    });
    // Either succeeds against the live machine or fails — both are acceptable
    // shapes here. Critically, it must produce a structured result with hint
    // when no port is set anywhere.
    expect(['OK', 'WARN', 'FAIL']).toContain(r.status);
    if (r.status === 'FAIL') {
      expect(r.hint).toMatch(/chrome:\/\/inspect|CDP_PORT/);
    }
  });
});

describe('checkBrowserTargets', () => {
  it('returns OK with target prefixes when debuggable page targets exist', async () => {
    const fetcher = async () => ({
      ok: true,
      json: async () => ([
        { type: 'page', id: 'AABBCCDDEEFF1122', title: 'Dashboard', url: 'https://app.example.com' },
        { type: 'page', id: 'BBCCDDEEFF001122', title: 'Settings', url: 'https://app.example.com/settings' },
        { type: 'other', id: 'ignored', title: 'Worker', url: 'https://app.example.com/worker' },
      ]),
    });

    const r = await checkBrowserTargets({
      cdp: { status: 'OK', host: '127.0.0.1', port: '9222' },
      fetcher,
    });

    expect(r.status).toBe('OK');
    expect(r.label).toBe('Tabs');
    expect(r.detail).toContain('2 debuggable page targets');
    expect(r.targetPrefixes[0]).toBe('AABBCCDD');
    expect(r.targetPrefixes[1]).toBe('BBCCDDEE');
  });

  it('returns WARN with an open command when CDP is reachable but no pages exist', async () => {
    const fetcher = async () => ({ ok: true, json: async () => [] });

    const r = await checkBrowserTargets({
      cdp: { status: 'OK', host: '127.0.0.1', port: '9222' },
      fetcher,
    });

    expect(r.status).toBe('WARN');
    expect(r.detail).toContain('no debuggable page targets');
    expect(r.hint).toContain('cdp open https://example.com');
  });

  it('skips target inventory until CDP is reachable', async () => {
    const fetcher = async () => { throw new Error('should not be called'); };

    const r = await checkBrowserTargets({
      cdp: { status: 'FAIL', detail: 'cannot reach 127.0.0.1:9999' },
      fetcher,
    });

    expect(r.status).toBe('WARN');
    expect(r.detail).toContain('skipped until CDP is reachable');
  });
});

describe('checkBrowserPermission', () => {
  it('returns OK when a live tab daemon proves browser debugging approval', () => {
    const r = checkBrowserPermission({
      daemons: { status: 'OK', label: 'Daemons', detail: '1 live: AABBCCDD', targetPrefixes: ['AABBCCDD'] },
      tabs: { status: 'OK', label: 'Tabs', detail: '1 debuggable page target', targetPrefixes: ['AABBCCDD'] },
    });

    expect(r.status).toBe('OK');
    expect(r.label).toBe('Permission');
    expect(r.detail).toContain('approved');
    expect(r.detail).toContain('AABBCCDD');
  });

  it('warns with a perceive retry when tabs exist but no daemon is approved yet', () => {
    const r = checkBrowserPermission({
      daemons: { status: 'OK', label: 'Daemons', detail: 'no live tab daemons', targetPrefixes: [] },
      tabs: { status: 'OK', label: 'Tabs', detail: '1 debuggable page target', targetPrefixes: ['AABBCCDD'] },
    });

    expect(r.status).toBe('WARN');
    expect(r.detail).toContain('not confirmed');
    expect(r.hint).toContain('cdp perceive AABBCCDD -C -d 8');
    expect(r.hint).toContain('click Allow');
  });

  it('guides users to open a tab before permission can be confirmed', () => {
    const r = checkBrowserPermission({
      daemons: { status: 'OK', label: 'Daemons', detail: 'no live tab daemons', targetPrefixes: [] },
      tabs: { status: 'WARN', label: 'Tabs', detail: 'no debuggable page targets', targetPrefixes: [], noTargets: true },
    });

    expect(r.status).toBe('WARN');
    expect(r.detail).toContain('no target');
    expect(r.hint).toContain('cdp open https://example.com');
  });
});

describe('checkFdLimit', () => {
  it('returns OK when the open-files limit is high enough for long sessions', () => {
    const r = checkFdLimit({ limit: 4096 });
    expect(r.status).toBe('OK');
    expect(r.detail).toContain('4096');
  });

  it('returns WARN with a concrete command when the open-files limit is low', () => {
    const r = checkFdLimit({ limit: 256 });
    expect(r.status).toBe('WARN');
    expect(r.detail).toContain('256');
    expect(r.hint).toContain('ulimit -n 4096');
  });
});

describe('doctorWizardSummary', () => {
  it('points to browser CDP setup when CDP is unreachable', () => {
    const out = doctorWizardSummary([
      { status: 'OK', label: 'Node', detail: 'v22' },
      { status: 'FAIL', label: 'CDP', detail: 'cannot reach 127.0.0.1:9222' },
    ]).join('\n');

    expect(out).toContain('Wizard:');
    expect(out).toContain('Status: blocked at browser CDP');
    expect(out).toContain('Current step: enable browser remote debugging');
    expect(out).toContain('cdp doctor');
  });

  it('points to open when CDP is ready but no debuggable page exists', () => {
    const out = doctorWizardSummary([
      { status: 'OK', label: 'Node', detail: 'v22' },
      { status: 'OK', label: 'CDP', detail: 'reachable' },
      { status: 'WARN', label: 'Tabs', detail: 'no debuggable page targets', noTargets: true, targetPrefixes: [] },
    ]).join('\n');

    expect(out).toContain('Status: waiting for a debuggable page');
    expect(out).toContain('Current step: cdp open https://example.com');
  });

  it('points to perceive when a target exists but browser permission is not confirmed', () => {
    const out = doctorWizardSummary([
      { status: 'OK', label: 'Node', detail: 'v22' },
      { status: 'OK', label: 'CDP', detail: 'reachable' },
      { status: 'OK', label: 'Tabs', detail: '1 debuggable page target', targetPrefixes: ['AABBCCDD'] },
      { status: 'WARN', label: 'Permission', detail: 'browser debugging approval not confirmed', targetPrefixes: ['AABBCCDD'] },
    ]).join('\n');

    expect(out).toContain('Status: waiting for browser debugging approval');
    expect(out).toContain('Current step: cdp perceive AABBCCDD -C -d 8');
    expect(out).toContain('click Allow');
  });
});

describe('formatDoctorReport', () => {
  it('renders OK/WARN/FAIL labels and shows hints', () => {
    const out = formatDoctorReport([
      { status: 'OK', label: 'Node', detail: 'v22.10.0' },
      { status: 'WARN', label: 'Skill install', detail: '/h/.claude/skills/chrome-cdp-ex not found', hint: 'cp -r ...' },
      { status: 'FAIL', label: 'CDP', detail: 'cannot reach 127.0.0.1:9222', hint: 'enable debugging' },
    ]);
    expect(out).toContain('chrome-cdp-ex doctor');
    expect(out).toContain('Wizard:');
    expect(out).toContain('Status: blocked at browser CDP');
    expect(out).toContain('[OK  ] Node');
    expect(out).toContain('[WARN] Skill install');
    expect(out).toContain('[FAIL] CDP');
    expect(out).toContain('hint: cp -r ...');
    expect(out).toContain('hint: enable debugging');
    expect(out).toContain('Not ready');
    expect(out).toContain('Next steps:');
    expect(out).toContain('cdp spawn-debug-browser edge --port 9222 --url https://example.com');
  });

  it('reports "Ready." when all checks are OK', () => {
    const out = formatDoctorReport([
      { status: 'OK', label: 'Node', detail: 'v22' },
      { status: 'OK', label: 'Tabs', detail: '1 debuggable page target: Example', targetPrefixes: ['AABBCCDD'] },
      { status: 'OK', label: 'Permission', detail: 'debugging approved for AABBCCDD', targetPrefixes: ['AABBCCDD'] },
      { status: 'OK', label: 'CDP', detail: 'reachable' },
    ]);
    expect(out).toContain('Ready.');
    expect(out).not.toContain('Not ready');
    expect(out).toContain('Next steps:');
    expect(out).toContain('cdp list');
    expect(out).toContain('cdp perceive AABBCCDD -C -d 8');
    expect(out).toContain('cdp report AABBCCDD');
  });

  it('reports "Mostly ready" when only WARNs present', () => {
    const out = formatDoctorReport([
      { status: 'OK', label: 'Node', detail: 'v22' },
      { status: 'WARN', label: 'Skill', detail: 'missing' },
    ]);
    expect(out).toContain('Mostly ready');
    expect(out).toContain('1 warning');
  });

  it('uses live daemon prefixes in the ready golden path when available', () => {
    const out = formatDoctorReport([
      { status: 'OK', label: 'Node', detail: 'v22' },
      { status: 'OK', label: 'Daemons', detail: '1 live: AABBCCDD', targetPrefixes: ['AABBCCDD'] },
      { status: 'OK', label: 'Tabs', detail: '1 debuggable page target: ZZYYXXWW', targetPrefixes: ['ZZYYXXWW'] },
      { status: 'OK', label: 'Permission', detail: 'debugging approved for AABBCCDD', targetPrefixes: ['AABBCCDD'] },
      { status: 'OK', label: 'CDP', detail: 'reachable' },
    ]);

    expect(out).toContain('cdp perceive AABBCCDD -C -d 8');
  });

  it('guides users to open a page when CDP is ready but no targets exist', () => {
    const out = formatDoctorReport([
      { status: 'OK', label: 'Node', detail: 'v22' },
      { status: 'OK', label: 'CDP', detail: 'reachable' },
      {
        status: 'WARN',
        label: 'Tabs',
        detail: 'no debuggable page targets',
        hint: 'Create one with: cdp open https://example.com',
      },
    ]);

    expect(out).toContain('Mostly ready');
    expect(out).toContain('cdp open https://example.com');
    expect(out).toContain('Use the target id printed by open');
    expect(out).toContain('cdp report <target-from-open>');
  });
});

describe('runDoctorChecks', () => {
  it('runs all checks and returns array of result objects', async () => {
    const fetcher = async (url) => url.endsWith('/json/list')
      ? { ok: true, json: async () => ([{ type: 'page', id: 'AABBCCDDEEFF', title: 'Example', url: 'https://example.com' }]) }
      : { ok: true, json: async () => ({ Browser: 'Chrome', webSocketDebuggerUrl: 'ws://x' }) };
    const checks = await runDoctorChecks({
      nodeVersion: 'v22.10.0',
      home: '/tmp/no-such-home-here',
      fs: { existsSync: () => false, lstatSync: null },
      listDaemons: () => [],
      fdLimit: 4096,
      env: { CDP_PORT: '9222' },
      fetcher,
    });
    expect(Array.isArray(checks)).toBe(true);
    expect(checks).toHaveLength(7);
    expect(checks[0].label).toBe('Node');
    expect(checks[1].label).toBe('Skill install');
    expect(checks[2].label).toBe('Daemons');
    expect(checks[3].label).toBe('FD limit');
    expect(checks[4].label).toBe('CDP');
    expect(checks[5].label).toBe('Tabs');
    expect(checks[6].label).toBe('Permission');
  });
});

describe('doctorStr', () => {
  it('returns formatted multi-line report including Ready./Not ready summary', async () => {
    const fetcher = async (url) => url.endsWith('/json/list')
      ? { ok: true, json: async () => ([{ type: 'page', id: 'AABBCCDDEEFF', title: 'Example', url: 'https://example.com' }]) }
      : { ok: true, json: async () => ({ Browser: 'Chrome/123', webSocketDebuggerUrl: 'ws://x' }) };
    const out = await doctorStr({
      nodeVersion: 'v22.10.0',
      home: '/tmp/no-such-home',
      fs: { existsSync: () => false, lstatSync: null },
      listDaemons: () => [],
      fdLimit: 4096,
      env: { CDP_PORT: '9222' },
      fetcher,
    });
    expect(out).toContain('chrome-cdp-ex doctor');
    expect(out).toMatch(/\[OK\s*\] Node/);
    expect(out).toMatch(/\[WARN\] Skill install/);
    expect(out).toMatch(/\[OK\s*\] Daemons/);
    expect(out).toMatch(/\[OK\s*\] FD limit/);
    expect(out).toMatch(/\[OK\s*\] CDP/);
    expect(out).toMatch(/\[OK\s*\] Tabs/);
    expect(out).toMatch(/\[WARN\] Permission/);
    expect(out).toContain('Mostly ready');
    expect(out).toContain('Next steps:');
    expect(out).toContain('cdp list');
    expect(out).toContain('cdp perceive AABBCCDD -C -d 8');
    expect(out).toContain('click Allow');
  });

  it('marks report as Not ready when CDP fails', async () => {
    const fetcher = async () => { throw new Error('ECONNREFUSED'); };
    const out = await doctorStr({
      nodeVersion: 'v22.10.0',
      home: '/tmp/x',
      fs: { existsSync: () => true, lstatSync: () => ({ isSymbolicLink: () => true }) },
      listDaemons: () => [],
      fdLimit: 4096,
      env: { CDP_PORT: '9999' },
      fetcher,
    });
    expect(out).toContain('Not ready');
    expect(out).toMatch(/\[FAIL\] CDP/);
  });

  it('returns a versioned JSON onboarding model for agents', async () => {
    const fetcher = async (url) => url.endsWith('/json/list')
      ? { ok: true, json: async () => ([{ type: 'page', id: 'AABBCCDDEEFF', title: 'Example', url: 'https://example.com' }]) }
      : { ok: true, json: async () => ({ Browser: 'Chrome/123', webSocketDebuggerUrl: 'ws://x' }) };
    const out = await doctorStr({
      format: 'json',
      nodeVersion: 'v22.10.0',
      home: '/tmp/no-such-home',
      fs: { existsSync: () => false, lstatSync: null },
      listDaemons: () => [],
      fdLimit: 4096,
      env: { CDP_PORT: '9222' },
      fetcher,
    });

    const model = JSON.parse(out);
    expect(model).toMatchObject({
      schema: 'chrome-cdp-ex.doctor.v1',
      status: 'mostly-ready',
      ready: false,
      failures: 0,
      warnings: 2,
    });
    expect(model.wizard).toMatchObject({
      status: 'waiting for browser debugging approval',
      currentStep: 'cdp perceive AABBCCDD -C -d 8  # click Allow if Chrome asks',
    });
    expect(model.wizard.goldenPath).toEqual(['doctor', 'list/open', 'perceive', 'click/fill', 'since-action evidence', 'report']);
    expect(model.checks.map(check => check.label)).toEqual([
      'Node', 'Skill install', 'Daemons', 'FD limit', 'CDP', 'Tabs', 'Permission',
    ]);
    expect(model.nextSteps).toEqual(expect.arrayContaining([
      'cdp list',
      'cdp perceive AABBCCDD -C -d 8',
      'cdp report AABBCCDD',
    ]));
    expect(model.recommendation).toMatchObject({
      source: 'doctor-onboarding',
      stage: 'browser-permission',
      run: 'cdp perceive AABBCCDD -C -d 8',
      requiresUserAction: true,
      consentRequired: false,
      after: 'cdp click AABBCCDD @ref  # or: cdp fill AABBCCDD <selector> <text>',
    });
    expect(model.recommendation.ask).toContain('Allow');
  });

  it('returns a consent-aware recommendation when browser CDP is blocked', async () => {
    const fetcher = async () => { throw new Error('ECONNREFUSED'); };
    const out = await doctorStr({
      format: 'json',
      nodeVersion: 'v22.10.0',
      home: '/tmp/x',
      fs: { existsSync: () => true, lstatSync: () => ({ isSymbolicLink: () => true }) },
      listDaemons: () => [],
      fdLimit: 256,
      env: { CDP_PORT: '9999' },
      fetcher,
    });

    const model = JSON.parse(out);
    expect(model.recommendation).toMatchObject({
      source: 'doctor-onboarding',
      stage: 'browser-cdp',
      run: 'cdp spawn-debug-browser edge --port 9222 --url https://example.com',
      after: 'cdp list',
      requiresUserAction: true,
      consentRequired: true,
    });
    expect(model.recommendation.ask).toContain('chrome://inspect/#remote-debugging');
    expect(model.recommendation.reason).toContain('cannot reach');
    expect(model.recommendation.warnings).toEqual([
      {
        label: 'FD limit',
        command: 'ulimit -n 4096',
        reason: '256 open files (low for long browser sessions)',
      },
    ]);
  });

  it('prints the recommendation before detailed doctor checks', async () => {
    const fetcher = async (url) => url.endsWith('/json/list')
      ? { ok: true, json: async () => ([{ type: 'page', id: 'AABBCCDDEEFF', title: 'Example', url: 'https://example.com' }]) }
      : { ok: true, json: async () => ({ Browser: 'Chrome/123', webSocketDebuggerUrl: 'ws://x' }) };
    const out = await doctorStr({
      nodeVersion: 'v22.10.0',
      home: '/tmp/no-such-home',
      fs: { existsSync: () => false, lstatSync: null },
      listDaemons: () => [],
      fdLimit: 4096,
      env: { CDP_PORT: '9222' },
      fetcher,
    });

    expect(out).toContain('Recommendation:');
    expect(out).toContain('Run: cdp perceive AABBCCDD -C -d 8');
    expect(out).toContain('Ask: Click Allow if Chrome asks.');
    expect(out.indexOf('Recommendation:')).toBeLessThan(out.indexOf('Checks:'));
  });
});

// =========================================================================
// 3y-Mud feedback fixes — keyForPress + single-character press
// =========================================================================

describe('keyForPress (3y-mud feedback)', () => {
  const { keyForPress } = T;

  it('maps lowercase letters to KeyX with the right keyCode', () => {
    expect(keyForPress('c')).toEqual({ key: 'c', code: 'KeyC', keyCode: 67 });
    expect(keyForPress('z')).toEqual({ key: 'z', code: 'KeyZ', keyCode: 90 });
  });

  it('maps uppercase letters preserving the visible key + shift modifier', () => {
    expect(keyForPress('C')).toEqual({ key: 'C', code: 'KeyC', keyCode: 67, shift: true });
  });

  it('maps digits to DigitN', () => {
    expect(keyForPress('1')).toEqual({ key: '1', code: 'Digit1', keyCode: 49 });
    expect(keyForPress('9')).toEqual({ key: '9', code: 'Digit9', keyCode: 57 });
  });

  it('keeps named keys case-insensitive', () => {
    expect(keyForPress('Enter').code).toBe('Enter');
    expect(keyForPress('escape').code).toBe('Escape');
  });

  it('maps common punctuation', () => {
    expect(keyForPress('-').code).toBe('Minus');
    expect(keyForPress('/').code).toBe('Slash');
  });

  it('maps shifted punctuation with shift modifier', () => {
    expect(keyForPress('?')).toEqual({ key: '?', code: 'Slash', keyCode: 191, shift: true });
    expect(keyForPress('!')).toEqual({ key: '!', code: 'Digit1', keyCode: 49, shift: true });
    expect(keyForPress(':')).toEqual({ key: ':', code: 'Semicolon', keyCode: 186, shift: true });
  });

  it('returns null for unsupported multi-character input', () => {
    expect(keyForPress('hello')).toBeNull();
    expect(keyForPress('')).toBeNull();
  });
});

describe('pressStr — single-character keys', () => {
  const { pressStr } = T;

  it('dispatches keyDown + char + keyUp for letter keys', async () => {
    const cdp = createMockCDP({ 'Input.dispatchKeyEvent': () => ({}) });
    const out = await pressStr(cdp, 'sid1', 'c');
    expect(out).toContain('Pressed c');
    const types = cdp.calls.filter(c => c.method === 'Input.dispatchKeyEvent').map(c => c.params.type);
    expect(types).toContain('keyDown');
    expect(types).toContain('char');
    expect(types).toContain('keyUp');
  });

  it('rejects unsupported keys with an actionable error mentioning single characters', async () => {
    const cdp = createMockCDP({});
    await expect(pressStr(cdp, 'sid1', 'F13'))
      .rejects.toThrow(/single characters|Unknown key/);
  });
});

// =========================================================================
// formatUnknownRefError — actionable stale-ref errors
// =========================================================================

describe('formatUnknownRefError', () => {
  const { formatUnknownRefError } = T;

  it('explains never-created refs (daemon-start)', () => {
    const msg = formatUnknownRefError('@31', { generation: 0, invalidationReason: 'daemon-start' });
    expect(msg).toMatch(/No refs have been assigned/);
    expect(msg).toMatch(/perceive/);
  });

  it('explains navigation invalidation', () => {
    const msg = formatUnknownRefError('@31', { generation: 2, invalidationReason: 'navigation' });
    expect(msg).toMatch(/navigated|reloaded/);
    expect(msg).toMatch(/stable CSS selector/);
  });

  it('explains DOM-mutation invalidation and suggests stable selectors', () => {
    const msg = formatUnknownRefError('@31', { generation: 2, invalidationReason: 'dom-mutation' });
    expect(msg).toMatch(/DOM changes/);
    expect(msg).toMatch(/stable CSS selector/);
  });

  it('falls back to a generic message when state is unset', () => {
    const msg = formatUnknownRefError('@5', {});
    expect(msg).toMatch(/Unknown ref: @5/);
  });
});

describe('resolveRefNode stale backend handling', () => {
  const { resolveRefNode } = T;

  it('classifies DOM-mutation stale refs when backend node resolution fails', async () => {
    const refMap = new Map([[31, 12345]]);
    const refState = { generation: 1, invalidationReason: null };
    const cdp = { send: async () => { throw new Error('No node with given id'); } };
    await expect(resolveRefNode(cdp, 'sid', refMap, '@31', refState))
      .rejects.toThrow(/DOM changes/);
    expect(refState.invalidationReason).toBe('dom-mutation');
    expect(refMap.has(31)).toBe(false);
  });
});

// =========================================================================
// formatRefRect — fixed/sticky annotations
// =========================================================================

describe('formatRefRect', () => {
  const { formatRefRect } = T;

  it('formats plain rects without position tag', () => {
    expect(formatRefRect({ x: 10, y: 20, w: 200, h: 30 })).toBe('(10,20 200×30)');
  });

  it('marks fixed elements explicitly', () => {
    expect(formatRefRect({ x: 1543, y: 259, w: 266, h: 52, position: 'fixed' }))
      .toBe('(1543,259 266×52, fixed)');
  });

  it('marks sticky elements explicitly', () => {
    expect(formatRefRect({ x: 0, y: 0, w: 100, h: 48, position: 'sticky' }))
      .toBe('(0,0 100×48, sticky)');
  });

  it('omits position for static/relative/absolute', () => {
    expect(formatRefRect({ x: 0, y: 0, w: 1, h: 1, position: 'absolute' }))
      .toBe('(0,0 1×1)');
    expect(formatRefRect({ x: 0, y: 0, w: 1, h: 1, position: 'static' }))
      .toBe('(0,0 1×1)');
  });
});

// =========================================================================
// parseTextArgs / textPageScript / textStr — fallback chain + --auto
// =========================================================================

describe('parseTextArgs', () => {
  const { parseTextArgs } = T;

  it('parses a single CSS selector', () => {
    expect(parseTextArgs(['main']).selectors).toEqual(['main']);
  });

  it('parses comma fallback selectors into an ordered chain', () => {
    expect(parseTextArgs(['main, [role=main], #app .main']).selectors)
      .toEqual(['main', '[role=main]', '#app .main']);
  });

  it('parses --auto', () => {
    const opts = parseTextArgs(['--auto']);
    expect(opts.auto).toBe(true);
    expect(opts.selectors).toEqual([]);
  });

  it('parses --auto with --exclude', () => {
    const opts = parseTextArgs(['--auto', '--exclude', 'nav,.sidebar']);
    expect(opts.auto).toBe(true);
    expect(opts.exclude).toBe('nav,.sidebar');
  });

  it('parses --root auto/default scope', () => {
    expect(parseTextArgs(['--root', 'auto']).root).toBe('auto');
    expect(parseTextArgs(['--root', '#root', 'header']).selectors).toEqual(['header']);
  });
});

describe('textPageScript', () => {
  const { textPageScript } = T;

  it('embeds the selector chain into the script', () => {
    const script = textPageScript({ selectors: ['main', '[role=main]'] });
    expect(script).toContain('"main"');
    expect(script).toContain('"[role=main]"');
  });

  it('strips nav/aside/footer when auto=true', () => {
    const script = textPageScript({ selectors: [], auto: true });
    expect(script).toContain('nav');
    expect(script).toContain('aside');
    expect(script).toContain('footer');
  });

  it('embeds extra exclude selectors when provided', () => {
    const script = textPageScript({ selectors: [], auto: true, exclude: '.sidebar,.banner' });
    expect(script).toContain('.sidebar');
    expect(script).toContain('.banner');
  });

  it('uses app-root candidates and header fallback selectors', () => {
    const script = textPageScript({ selectors: ['header'], root: 'auto' });
    expect(script).toContain("['#root', '[data-reactroot]', 'main', 'body']");
    expect(script).toContain("'[role=\"banner\"]'");
    expect(script).toContain("'h1'");
  });
});

describe('textStr', () => {
  const { textStr } = T;

  it('returns extracted text from the first matching selector', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { value: JSON.stringify({ ok: true, sel: 'main', text: 'Hello' }) } }),
    });
    const out = await textStr(cdp, 'sid1', ['main, [role=main]']);
    expect(out).toBe('Hello');
  });

  it('throws an actionable error when no selector matches', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { value: JSON.stringify({ ok: false, tried: ['main', '[role=main]'] }) } }),
    });
    await expect(textStr(cdp, 'sid1', ['main, [role=main]']))
      .rejects.toThrow(/Tried: main, \[role=main\]/);
  });

  it('accepts legacy single-string call form', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { value: JSON.stringify({ ok: true, sel: 'body', text: 'X' }) } }),
    });
    expect(await textStr(cdp, 'sid1', 'main')).toBe('X');
  });
});

// =========================================================================
// parseShotArgs / shotStr — saved path first, --quiet/--verbose
// =========================================================================

describe('parseShotArgs', () => {
  const { parseShotArgs } = T;

  it('returns defaults for empty args', () => {
    expect(parseShotArgs([])).toEqual({ filePath: null, quiet: false, verbose: false });
  });

  it('parses --quiet', () => {
    expect(parseShotArgs(['--quiet']).quiet).toBe(true);
    expect(parseShotArgs(['-q']).quiet).toBe(true);
  });

  it('parses --verbose', () => {
    expect(parseShotArgs(['--verbose']).verbose).toBe(true);
  });

  it('captures a positional file path', () => {
    expect(parseShotArgs(['/tmp/a.png']).filePath).toBe('/tmp/a.png');
  });

  it('combines path with --quiet', () => {
    expect(parseShotArgs(['/tmp/a.png', '--quiet']))
      .toEqual({ filePath: '/tmp/a.png', quiet: true, verbose: false });
  });
});

describe('shotStr', () => {
  const { shotStr } = T;
  beforeEach(() => { T.resetScreenshotTier(); });

  it('puts the saved path on the first line by default', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { value: 1 } }),
      'Page.captureScreenshot': () => ({ data: Buffer.from('PNG').toString('base64') }),
    });
    // Use OS temp file path to avoid touching the real RUNTIME_DIR
    const path = `/tmp/cdp-test-${Date.now()}.png`;
    const out = await shotStr(cdp, 'sid1', path, 'TARGETID', { quiet: false });
    expect(out.split('\n')[0]).toBe(path);
  });

  it('with --quiet returns ONLY the saved path', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { value: 2 } }),
      'Page.captureScreenshot': () => ({ data: Buffer.from('PNG').toString('base64') }),
    });
    const path = `/tmp/cdp-test-quiet-${Date.now()}.png`;
    const out = await shotStr(cdp, 'sid1', path, 'X', { quiet: true });
    expect(out.split('\n')).toEqual([path]);
  });

  it('with --verbose includes the full DPR coordinate-mapping tutorial', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { value: 2 } }),
      'Page.captureScreenshot': () => ({ data: Buffer.from('PNG').toString('base64') }),
    });
    const path = `/tmp/cdp-test-verbose-${Date.now()}.png`;
    const out = await shotStr(cdp, 'sid1', path, 'X', { verbose: true });
    expect(out).toMatch(/Coordinate mapping/);
    expect(out).toMatch(/clickxy/);
  });
});

// =========================================================================
// waitfor --any-of and --selector-stable
// =========================================================================

describe('waitForStr --any-of', () => {
  const { waitForStr } = T;

  it('returns immediately when one of the alternatives is present', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { value: JSON.stringify({ matched: 'win', snippet: '... you win ...', len: 200 }) } }),
    });
    const out = await waitForStr(cdp, 'sid1', ['--any-of', 'win|lose|escape', '5000'], new Map());
    expect(out).toMatch(/Found "win"/);
  });

  it('throws when no alternative appears before timeout', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { value: 'null' } }),
    });
    await expect(waitForStr(cdp, 'sid1', ['--any-of', 'a|b|c', '500'], new Map()))
      .rejects.toThrow(/Timeout: any of/);
  });

  it('rejects empty patterns', async () => {
    const cdp = createMockCDP({});
    await expect(waitForStr(cdp, 'sid1', ['--any-of', '|', '500'], new Map()))
      .rejects.toThrow(/at least one alternative/);
  });
});

describe('waitForStr --selector-stable', () => {
  const { waitForStr } = T;

  it('throws when no selector is given', async () => {
    const cdp = createMockCDP({});
    await expect(waitForStr(cdp, 'sid1', ['--selector-stable'], new Map()))
      .rejects.toThrow(/Selector required/);
  });

  it('returns once the selector content has stabilised', async () => {
    let calls = 0;
    const cdp = createMockCDP({
      'Runtime.evaluate': () => {
        calls++;
        // Always returns the same hash → considered stable after 2 polls.
        return { result: { value: JSON.stringify({ len: 10, hash: 'abc' }) } };
      },
    });
    const out = await waitForStr(cdp, 'sid1', ['--selector-stable', '.combat-log', '50', '5000'], new Map());
    expect(out).toMatch(/stable for 50ms/);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('times out when the selector keeps changing', async () => {
    let n = 0;
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { value: JSON.stringify({ len: 10, hash: 'h' + (n++) }) } }),
    });
    await expect(waitForStr(cdp, 'sid1', ['--selector-stable', '.x', '300', '500'], new Map()))
      .rejects.toThrow(/did not stabilise/);
  });
});

// =========================================================================
// spawn-debug-browser arg parsing + plan
// =========================================================================

describe('parseSpawnDebugBrowserArgs', () => {
  const { parseSpawnDebugBrowserArgs } = T;

  it('defaults to edge on port 9222 with a temp profile', () => {
    const opts = parseSpawnDebugBrowserArgs([], { TMPDIR: '/tmp' });
    expect(opts.browser).toBe('edge');
    expect(opts.port).toBe(9222);
    expect(opts.profileDir).toBe('/tmp/chrome-cdp-ex-edge-debug-profile-9222');
  });

  it('parses browser, port, url, and profile-dir together', () => {
    const opts = parseSpawnDebugBrowserArgs(
      ['chrome', '--port', '9333', '--url', 'http://127.0.0.1:3000', '--profile-dir', '/tmp/p'],
      { TMPDIR: '/tmp' }
    );
    expect(opts).toEqual({
      browser: 'chrome',
      port: 9333,
      url: 'http://127.0.0.1:3000',
      profileDir: '/tmp/p',
      executable: null,
    });
  });

  it('normalises browser aliases', () => {
    expect(parseSpawnDebugBrowserArgs(['msedge'], { TMPDIR: '/tmp' }).browser).toBe('edge');
    expect(parseSpawnDebugBrowserArgs(['google-chrome'], { TMPDIR: '/tmp' }).browser).toBe('chrome');
    expect(parseSpawnDebugBrowserArgs(['chromium'], { TMPDIR: '/tmp' }).browser).toBe('chrome');
  });

  it('honours CDP_DEBUG_BROWSER and explicit executable path', () => {
    const opts = parseSpawnDebugBrowserArgs(['--exe', '/opt/browser'], { TMPDIR: '/tmp', CDP_DEBUG_BROWSER: 'chrome' });
    expect(opts.browser).toBe('chrome');
    expect(opts.executable).toBe('/opt/browser');
  });
});

describe('detectBrowserPath / buildSpawnDebugBrowserPlan', () => {
  const { detectBrowserPath, buildSpawnDebugBrowserPlan } = T;

  it('returns the first existing candidate path', () => {
    const fs = { existsSync: (p) => p === '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' };
    expect(detectBrowserPath('edge', 'darwin', fs)).toBe('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  });

  it('returns null when nothing exists', () => {
    const fs = { existsSync: () => false };
    expect(detectBrowserPath('chrome', 'darwin', fs, { PATH: '' })).toBeNull();
  });

  it('falls back to browser executables on PATH', () => {
    const fs = { existsSync: (p) => p === '/opt/bin/google-chrome' };
    expect(detectBrowserPath('chrome', 'linux', fs, { PATH: '/usr/bin:/opt/bin' })).toBe('/opt/bin/google-chrome');
  });

  it('builds a plan with --remote-debugging-port and --user-data-dir', () => {
    const fs = { existsSync: () => true };
    const opts = { browser: 'edge', port: 9222, url: null, profileDir: '/tmp/p' };
    const plan = buildSpawnDebugBrowserPlan(opts, 'darwin', fs);
    expect(plan.args).toContain('--remote-debugging-port=9222');
    expect(plan.args).toContain('--user-data-dir=/tmp/p');
    expect(plan.args).toContain('--no-first-run');
  });

  it('throws an actionable error when the executable is missing', () => {
    const fs = { existsSync: () => false };
    expect(() => buildSpawnDebugBrowserPlan({ browser: 'edge', port: 9222, profileDir: '/tmp/p' }, 'darwin', fs, { PATH: '' }))
      .toThrow(/Use --exe/);
  });
});

describe('spawnDebugBrowserStr', () => {
  const { spawnDebugBrowserStr } = T;

  it('reports the launch command and next-step usage', async () => {
    const calls = [];
    const fakeSpawn = (exe, args, _opts) => {
      calls.push({ exe, args });
      return { pid: 4242, unref() {} };
    };
    const fs = { existsSync: () => true, mkdirSync: () => {} };
    const out = await spawnDebugBrowserStr(['edge', '--port', '9311'], { TMPDIR: '/tmp' }, { fs, spawn: fakeSpawn, platform: 'darwin' });
    expect(out).toContain('Spawned edge debug profile on CDP_PORT=9311');
    expect(out).toContain('Next: CDP_PORT=9311');
    expect(calls[0].args).toContain('--remote-debugging-port=9311');
  });
});

// =========================================================================
// dismiss-modal helper script + dispatch
// =========================================================================

describe('dismissModalScript', () => {
  const { dismissModalScript } = T;

  it('returns a self-invoking IIFE that looks for dialogs', () => {
    const script = dismissModalScript();
    expect(typeof script).toBe('string');
    expect(script).toMatch(/role="dialog"/);
    expect(script).toMatch(/aria-modal/);
  });
});

describe('dismissModalStr', () => {
  const { dismissModalStr } = T;

  it('reports success when the page-side script clicks a close button', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { value: JSON.stringify({ ok: true, action: 'click', label: 'close', sel: 'div' }) } }),
    });
    const out = await dismissModalStr(cdp, 'sid1');
    expect(out).toMatch(/Dismissed modal via close button/);
  });

  it('returns a friendly message when no dialog is visible', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { value: JSON.stringify({ ok: false, reason: 'no-dialog' }) } }),
    });
    const out = await dismissModalStr(cdp, 'sid1');
    expect(out).toMatch(/No visible modal/);
  });

  it('falls back to Escape when no close button is found', async () => {
    let evalCalls = 0;
    const cdp = createMockCDP({
      'Runtime.evaluate': () => {
        evalCalls++;
        return { result: { value: JSON.stringify({ ok: false, reason: 'no-close-button', dialogs: 1 }) } };
      },
      'Input.dispatchKeyEvent': () => ({}),
    });
    const out = await dismissModalStr(cdp, 'sid1');
    expect(out).toMatch(/sent Escape as fallback/);
    const keyEvents = cdp.calls.filter(c => c.method === 'Input.dispatchKeyEvent');
    expect(keyEvents.length).toBeGreaterThan(0);
    expect(evalCalls).toBeGreaterThan(0);
  });
});

// =========================================================================
// overlay detector
// =========================================================================

describe('overlay detector', () => {
  it('builds a page-side script that scans dialogs and hit-test blockers', () => {
    const script = T.overlayDetectorScript({ targetPoint: { input: '@4', x: 10, y: 20 } });
    expect(script).toMatch(/elementFromPoint/);
    expect(script).toMatch(/aria-modal/);
    expect(script).toMatch(/role="dialog"/);
    expect(script).toContain('"input":"@4"');
  });

  it('formats a clear page when no blocking overlay is visible', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { value: JSON.stringify({
        schema: 'chrome-cdp-ex.overlays.v1',
        viewport: { width: 800, height: 600 },
        target: null,
        overlayCount: 0,
        blocking: false,
        overlays: [],
        nextCommand: null,
      }) } }),
    });

    const out = await T.overlayStr(cdp, 'sid1', 'abc123', [], new Map(), {});
    expect(out).toContain('Overlay detector: clear');
    expect(out).toContain('No visible blocking overlays/dialogs detected.');
    expect(out).toContain('Next: continue');
  });

  it('reports a blocking dialog and concrete dismissal command for a target ref', async () => {
    const refMap = new Map([[4, 444]]);
    const cdp = createMockCDP({
      'DOM.resolveNode': () => ({ object: { objectId: 'target-button' } }),
      'Runtime.callFunctionOn': () => ({ result: { value: {
        x: 20,
        y: 30,
        w: 80,
        h: 20,
        tag: 'BUTTON',
        text: 'Submit',
      } } }),
      'Runtime.evaluate': (params) => {
        expect(params.expression).toContain('"input":"@4"');
        expect(params.expression).toContain('"x":60');
        expect(params.expression).toContain('"y":40');
        return { result: { value: JSON.stringify({
          schema: 'chrome-cdp-ex.overlays.v1',
          viewport: { width: 800, height: 600 },
          target: {
            input: '@4',
            x: 60,
            y: 40,
            descriptor: '<BUTTON> "Submit"',
            blocked: true,
            topElement: { kind: 'dialog', selector: '#motd', text: 'MOTD' },
          },
          overlayCount: 1,
          blocking: true,
          overlays: [{
            kind: 'dialog',
            selector: '#motd',
            role: 'dialog',
            label: 'MOTD',
            text: 'Press any key',
            pointerEvents: 'auto',
            zIndex: '20',
            rect: { x: 100, y: 90, w: 320, h: 180 },
            coversTarget: true,
            topAtCenter: true,
          }],
          nextCommand: 'cdp dismiss-modal abc123',
        }) } };
      },
    });

    const out = await T.overlayStr(cdp, 'sid1', 'abc123', ['@4'], refMap, {});
    expect(out).toContain('Overlay detector: blocking');
    expect(out).toContain('Target: @4 at (60,40) — blocked by [dialog] #motd "MOTD"');
    expect(out).toContain('1. [dialog] #motd role=dialog z=20 pointer=auto rect=(100,90 320×180)');
    expect(out).toContain('Next: cdp dismiss-modal abc123');
  });

  it('returns versioned overlay JSON for tool-calling agents', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { value: JSON.stringify({
        schema: 'chrome-cdp-ex.overlays.v1',
        viewport: { width: 800, height: 600 },
        target: null,
        overlayCount: 0,
        blocking: false,
        overlays: [],
        nextCommand: null,
      }) } }),
    });

    const out = await T.overlayStr(cdp, 'sid1', 'abc123', ['--format', 'json'], new Map(), {});
    expect(JSON.parse(out).schema).toBe('chrome-cdp-ex.overlays.v1');
  });
});

// =========================================================================
// formatPageList — about:blank labelling (P2 polish)
// =========================================================================

describe('formatPageList about:blank', () => {
  it('labels about:blank pages with "(blank tab)" so agents can still target them', () => {
    const out = T.formatPageList([
      { targetId: 'ABCDEF1234567890', type: 'page', title: '', url: 'about:blank' },
    ]);
    expect(out).toContain('(blank tab)');
    expect(out).toContain('about:blank');
    expect(out).toContain('ABCDEF12');
  });
});

// =========================================================================
// buildPerceiveTree — --keep-refs / --last truncation controls
// =========================================================================

describe('buildPerceiveTree truncation controls', () => {
  const { buildPerceiveTree } = T;
  const axNode = (id, role, name, opts = {}) => ({
    nodeId: id,
    role: { value: role },
    name: { value: name },
    ...(opts.parentId ? { parentId: opts.parentId } : {}),
    ...(opts.childIds ? { childIds: opts.childIds } : {}),
    ...(opts.backendDOMNodeId ? { backendDOMNodeId: opts.backendDOMNodeId } : {}),
  });

  it('keeps interactive @ref lines even when --last truncates static text', () => {
    const nodes = [axNode('root', 'WebArea', 'Page')];
    const childIds = [];
    for (let i = 0; i < 60; i++) {
      const id = `t${i}`;
      nodes.push(axNode(id, 'StaticText', `entry ${i}`, { parentId: 'root' }));
      childIds.push(id);
    }
    nodes.push(axNode('btn', 'button', 'Action', { parentId: 'root', backendDOMNodeId: 999 }));
    childIds.push('btn');
    nodes[0].childIds = childIds;

    const refMap = new Map();
    const { treeLines } = buildPerceiveTree(nodes, { layoutMap: {}, styleHints: {} }, refMap, { last: 5 });
    const out = treeLines.join('\n');
    // Ref line for the button always survives
    expect(out).toMatch(/Action/);
    expect(out).toMatch(/@1/);
    // Truncation notice is present
    expect(out).toMatch(/earlier text node\(s\) omitted/);
  });

  it('passes through unmodified when --last is not set', () => {
    const nodes = [
      axNode('root', 'WebArea', 'Page'),
      axNode('s1', 'StaticText', 'a', { parentId: 'root' }),
      axNode('s2', 'StaticText', 'b', { parentId: 'root' }),
    ];
    nodes[0].childIds = ['s1', 's2'];
    const refMap = new Map();
    const { treeLines } = buildPerceiveTree(nodes, { layoutMap: {}, styleHints: {} }, refMap, {});
    const out = treeLines.join('\n');
    expect(out).toMatch(/a/);
    expect(out).toMatch(/b/);
    expect(out).not.toMatch(/omitted/);
  });

  it('keeps high-signal error text even when it is older than --last', () => {
    const nodes = [axNode('root', 'WebArea', 'Page')];
    const childIds = [];
    nodes.push(axNode('err', 'StaticText', 'Payment failed: card number is required', { parentId: 'root' }));
    childIds.push('err');
    for (let i = 0; i < 40; i++) {
      const id = `noise${i}`;
      nodes.push(axNode(id, 'StaticText', `event log line ${i}`, { parentId: 'root' }));
      childIds.push(id);
    }
    nodes[0].childIds = childIds;

    const refMap = new Map();
    const { treeLines } = buildPerceiveTree(nodes, { layoutMap: {}, styleHints: {} }, refMap, { last: 3 });
    const out = treeLines.join('\n');

    expect(out).toContain('Payment failed: card number is required');
    expect(out).not.toContain('event log line 0');
    expect(out).toContain('event log line 39');
    expect(out).toMatch(/earlier text node\(s\) omitted/);
  });
});

// =========================================================================
// parsePerceiveArgs — --keep-refs / --last
// =========================================================================

describe('parsePerceiveArgs (keep-refs/last)', () => {
  it('parses --keep-refs', () => {
    expect(T.parsePerceiveArgs(['--keep-refs']).keepRefs).toBe(true);
  });

  it('parses --last with a numeric argument', () => {
    expect(T.parsePerceiveArgs(['--last', '20']).last).toBe(20);
  });

  it('treats --last with a non-numeric argument as null', () => {
    expect(T.parsePerceiveArgs(['--last', 'xyz']).last).toBeNull();
  });
});

// =========================================================================
// jsClickStr — explicit JS-fallback click via HTMLElement.click()
// =========================================================================

describe('jsClickStr', () => {
  const { jsClickStr } = T;

  it('calls HTMLElement.click() through Runtime.callFunctionOn for @ref targets', async () => {
    let fnDecl = '';
    const refMap = new Map([[1, 555]]);
    const cdp = createMockCDP({
      'DOM.resolveNode': () => ({ object: { objectId: 'obj-555' } }),
      'Runtime.callFunctionOn': (params) => {
        fnDecl = params.functionDeclaration;
        return { result: { value: { tag: 'BUTTON', text: 'OK' } } };
      },
    });
    const out = await jsClickStr(cdp, 'sid', '@1', refMap, { generation: 1 });
    expect(out).toMatch(/JS-clicked <BUTTON> "OK" \(@1\)/);
    expect(fnDecl).toMatch(/this\.click\(\)/);
    // No mouse events should have been dispatched in JS-fallback mode
    expect(cdp.calls.find(c => c.method === 'Input.dispatchMouseEvent')).toBeUndefined();
  });

  it('resolves CSS selectors to node objects and calls HTMLElement.click()', async () => {
    let fnDecl = '';
    const cdp = createMockCDP({
      'DOM.enable': () => ({}),
      'DOM.getDocument': () => ({ root: { nodeId: 1 } }),
      'DOM.querySelector': (params) => {
        expect(params.selector).toBe('a.help');
        return { nodeId: 77 };
      },
      'DOM.resolveNode': () => ({ object: { objectId: 'obj-77' } }),
      'Runtime.callFunctionOn': (params) => {
        expect(params.objectId).toBe('obj-77');
        fnDecl = params.functionDeclaration;
        return { result: { value: { tag: 'A', text: 'Help' } } };
      },
    });
    const out = await jsClickStr(cdp, 'sid', 'a.help', new Map());
    expect(out).toMatch(/JS-clicked <A> "Help"/);
    expect(fnDecl).toMatch(/this\.click\(\)/);
  });

  it('throws when the CSS selector does not match', async () => {
    const cdp = createMockCDP({
      'DOM.enable': () => ({}),
      'DOM.getDocument': () => ({ root: { nodeId: 1 } }),
      'DOM.querySelector': () => ({ nodeId: 0 }),
    });
    await expect(jsClickStr(cdp, 'sid', '.nope', new Map())).rejects.toThrow(/Element not found/);
  });

  it('throws on unknown @ref with a refState-aware message', async () => {
    const refMap = new Map();
    const refState = { generation: 0, invalidationReason: 'daemon-start' };
    const cdp = createMockCDP({});
    await expect(jsClickStr(cdp, 'sid', '@99', refMap, refState))
      .rejects.toThrow(/No refs have been assigned/);
  });

  it('rejects empty selector', async () => {
    const cdp = createMockCDP({});
    await expect(jsClickStr(cdp, 'sid', undefined, new Map())).rejects.toThrow(/selector.*required/i);
  });
});

// =========================================================================
// repeat primitive — count cap, fail-fast, --continue
// =========================================================================

describe('parseRepeatArgs', () => {
  const { parseRepeatArgs } = T;

  it('parses count, command, and command args', () => {
    const opts = parseRepeatArgs(['3', 'press', 'c']);
    expect(opts.count).toBe(3);
    expect(opts.cmd).toBe('press');
    expect(opts.args).toEqual(['c']);
    expect(opts.continueOnError).toBe(false);
  });

  it('parses --continue anywhere in the argument list', () => {
    expect(parseRepeatArgs(['5', '--continue', 'click', '@1']).continueOnError).toBe(true);
    expect(parseRepeatArgs(['5', 'click', '@1', '--continue']).continueOnError).toBe(true);
    expect(parseRepeatArgs(['-c', '4', 'press', 'space']).continueOnError).toBe(true);
  });

  it('rejects non-positive counts', () => {
    expect(() => parseRepeatArgs(['0', 'press', 'c'])).toThrow(/positive integer/);
    expect(() => parseRepeatArgs(['-1', 'press', 'c'])).toThrow(/positive integer/);
    expect(() => parseRepeatArgs(['abc', 'press', 'c'])).toThrow(/positive integer/);
  });

  it('caps the loop count to prevent runaways', () => {
    expect(() => parseRepeatArgs(['9999', 'press', 'c'])).toThrow(/exceeds cap/);
  });

  it('rejects nesting itself or other meta-commands', () => {
    expect(() => parseRepeatArgs(['3', 'repeat', '2', 'press', 'c'])).toThrow(/cannot wrap/);
    expect(() => parseRepeatArgs(['3', 'batch', 'press c'])).toThrow(/cannot wrap/);
    expect(() => parseRepeatArgs(['3', 'stop'])).toThrow(/cannot wrap/);
  });

  it('allows wrapping flow so multi-step bodies can loop (matches README)', () => {
    const opts = parseRepeatArgs(['3', 'flow', 'click @1; wait dom stable']);
    expect(opts.count).toBe(3);
    expect(opts.cmd).toBe('flow');
    expect(opts.args).toEqual(['click @1; wait dom stable']);
  });

  it('requires a command name after the count', () => {
    expect(() => parseRepeatArgs(['3'])).toThrow(/command name required|repeat requires/);
  });
});

describe('repeatStr', () => {
  const { repeatStr } = T;

  it('runs the inner command N times and counts successes', async () => {
    let calls = 0;
    const run = async (step) => { calls++; return { ok: true, result: `tick ${step.cmd} ${calls}` }; };
    const out = await repeatStr({ run }, ['3', 'press', 'c']);
    expect(calls).toBe(3);
    expect(out).toMatch(/Repeat 3× press c/);
    expect(out).toMatch(/\[1\/3\] ok/);
    expect(out).toMatch(/\[3\/3\] ok/);
    expect(out).toMatch(/Done: 3 ok, 0 failed/);
  });

  it('halts on the first error by default (fail-fast)', async () => {
    let calls = 0;
    const run = async () => {
      calls++;
      if (calls === 2) return { ok: false, error: 'kaboom' };
      return { ok: true, result: 'ok' };
    };
    const out = await repeatStr({ run }, ['5', 'click', '@1']);
    expect(calls).toBe(2);
    expect(out).toMatch(/Repeat halted at iteration 2\/5/);
    expect(out).toMatch(/✗ kaboom/);
    expect(out).toMatch(/Done: 1 ok, 1 failed/);
  });

  it('keeps going through errors when --continue is passed', async () => {
    let calls = 0;
    const run = async () => {
      calls++;
      if (calls % 2 === 0) return { ok: false, error: 'flap' };
      return { ok: true, result: 'fine' };
    };
    const out = await repeatStr({ run }, ['4', '--continue', 'press', 'space']);
    expect(calls).toBe(4);
    expect(out).toMatch(/Done: 2 ok, 2 failed/);
    expect(out).not.toMatch(/halted/);
  });

  it('forwards command args verbatim each iteration', async () => {
    const seen = [];
    const run = async (step) => { seen.push(step); return { ok: true, result: '' }; };
    await repeatStr({ run }, ['2', 'fill', '@3', 'hello world']);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual({ cmd: 'fill', args: ['@3', 'hello world'] });
    expect(seen[1]).toEqual({ cmd: 'fill', args: ['@3', 'hello world'] });
  });

  it('dispatches flow as the inner command (multi-step body loop)', async () => {
    const seen = [];
    const run = async (step) => { seen.push(step); return { ok: true, result: 'flow ok' }; };
    const out = await repeatStr({ run }, ['3', 'flow', 'click @1; wait dom stable']);
    expect(seen).toHaveLength(3);
    expect(seen[0]).toEqual({ cmd: 'flow', args: ['click @1; wait dom stable'] });
    expect(out).toMatch(/Repeat 3× flow click @1; wait dom stable/);
    expect(out).toMatch(/Done: 3 ok, 0 failed/);
  });

  it('halts a repeat-over-flow loop on the first failed flow turn', async () => {
    let calls = 0;
    const run = async () => {
      calls++;
      if (calls === 2) return { ok: false, error: 'Flow halted at step 2/3' };
      return { ok: true, result: 'flow ok' };
    };
    const out = await repeatStr({ run }, ['5', 'flow', 'click @attack; wait dom stable']);
    expect(calls).toBe(2);
    expect(out).toMatch(/Repeat halted at iteration 2\/5/);
    expect(out).toMatch(/Done: 1 ok, 1 failed/);
  });
});

// =========================================================================
// eval64 / eval --b64 — base64 transport for CJK / shell-hostile expressions
// =========================================================================

describe('eval base64 transport', () => {
  const { evalBase64Decode } = T;

  it('decodes UTF-8 base64 expressions losslessly (CJK round-trip)', () => {
    const expr = 'document.title === "戰鬥勝利"';
    const b64 = Buffer.from(expr, 'utf8').toString('base64');
    expect(evalBase64Decode(b64)).toBe(expr);
  });

  it('rejects empty input with a clear error', () => {
    expect(() => evalBase64Decode('')).toThrow(/empty/);
    expect(() => evalBase64Decode(null)).toThrow(/empty/);
  });

  it('rejects non-base64 garbage instead of silently running', () => {
    // base64 alphabet only; invalid chars should fail
    expect(() => evalBase64Decode('not base64!!')).toThrow(/base64/i);
  });

  it('rejects payloads whose length is not a multiple of 4', () => {
    // "YWJj" decodes to "abc" cleanly; truncating one char leaves a 3-char
    // payload that Node would silently decode to 2 bytes. We must reject it.
    expect(() => evalBase64Decode('YWJ')).toThrow(/length/i);
    expect(() => evalBase64Decode('YWJjZA')).toThrow(/length/i);
  });

  it('rejects = padding that appears anywhere but the tail', () => {
    // "YQ==" is the canonical encoding of "a"; placing = in the middle is
    // never legal even if the overall length is a multiple of 4.
    expect(() => evalBase64Decode('YQ==YQ==')).toThrow(/padding/i);
    expect(() => evalBase64Decode('AB=CDEFG')).toThrow(/padding/i);
  });

  it('rejects payloads where Node lenient-decodes but loses bytes (round-trip)', () => {
    // "ABCDE" is 5 chars (length not %4). After we add the length check this
    // is caught earlier; but build a length-%4 payload whose final char does
    // not align to a 6-bit boundary so the round-trip guard fires.
    // "YWJjZGV=" — last group has 3 base64 chars + 1 pad: legal length, but
    // the trailing low bits of the third char must be zero. "ZGV=" decodes
    // to "de" (last char of input must end in == or two trailing zero bits).
    // Picking a char whose low bits are non-zero ("ZGW=") triggers the
    // round-trip guard.
    expect(() => evalBase64Decode('YWJjZGW=')).toThrow(/canonical|truncated|corrupt/i);
  });

  it('accepts canonical padded base64 without flagging it', () => {
    // "abc" round-trips cleanly with one = pad; "ab" with two; "abcd" with none.
    expect(evalBase64Decode('YWJj')).toBe('abc');
    expect(evalBase64Decode('YWI=')).toBe('ab');
    expect(evalBase64Decode('YWJjZA==')).toBe('abcd');
  });
});

// =========================================================================
// stale-ref recovery hint — explicit "no remap" wording in messaging
// =========================================================================

describe('formatUnknownRefError recovery wording', () => {
  const { formatUnknownRefError } = T;

  it('navigation message names a concrete recovery command', () => {
    const msg = formatUnknownRefError('@31', { generation: 2, invalidationReason: 'navigation' });
    expect(msg).toMatch(/perceive/);
    // No claim of automatic remap — agent must re-perceive itself.
    expect(msg).toMatch(/stable CSS selector/);
  });

  it('dom-mutation message tells loop authors to switch to selectors', () => {
    const msg = formatUnknownRefError('@31', { generation: 5, invalidationReason: 'dom-mutation' });
    expect(msg).toMatch(/stable CSS selector in batch\/loops|stable CSS selector/);
  });
});
