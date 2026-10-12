import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

describe('issue #141 perceive target/document readiness', () => {
  const persistentMismatchMessage = [
    'perceive: target/document readiness mismatch;',
    'targetId=ABC12345FULLTARGET;',
    'requestedTargetId=ABC12345FULLTARGET;',
    'resolvedTargetId=ABC12345FULLTARGET;',
    'boundTargetId=ABC12345FULLTARGET;',
    'advertisedUrl=https://example.test/start;',
    'observedUrl=about:srcdoc;',
    'readyState=interactive;',
    'attempts=3/3;',
    'elapsedMs=18.',
  ].join(' ');

  function createHandler({
    advertisedUrl = 'https://example.test/start',
    states = [{ url: 'https://example.test/start', readyState: 'complete' }],
    sampleDelaysMs = [0, 7, 11],
    metadataError = null,
  } = {}) {
    let stateIndex = 0;
    let clock = 500;
    const waits = [];
    const reads = [];
    const forbiddenCdp = {
      send(method) {
        throw new Error(`unexpected CDP command: ${method}`);
      },
    };
    const emptyBuffer = { all: () => [] };
    const handler = T.createPerceiveCommandHandler({
      cdp: forbiddenCdp,
      sessionId: 'session-141',
      targetId: 'ABC12345FULLTARGET',
      session: { lastAction: null },
      consoleBuf: emptyBuffer,
      exceptionBuf: emptyBuffer,
      netReqBuf: emptyBuffer,
      refMap: new Map(),
      lastPerceiveStore: { output: null },
      refState: { generation: 0 },
      ops: {
        readPerceiveTargetMetadata: async () => {
          if (metadataError) throw metadataError;
          return {
            targetId: 'ABC12345FULLTARGET',
            url: advertisedUrl,
          };
        },
        readPerceiveDocumentState: async () => {
          const state = states[Math.min(stateIndex, states.length - 1)];
          stateIndex += 1;
          reads.push(state);
          return state;
        },
        perceiveReadinessDelaysMs: sampleDelaysMs,
        sleep: async ms => {
          waits.push(ms);
          clock += ms;
        },
        now: () => clock,
        pageInfoModel: async () => ({ title: 'Ready', url: states.at(-1)?.url || advertisedUrl }),
        collectPageHealth: async () => ({ status: 'healthy' }),
        perceiveText: async () => 'ready perception',
        perceiveModel: async () => ({
          schema: 'chrome-cdp-ex.perception.v1',
          page: { title: 'Ready', url: states.at(-1)?.url || advertisedUrl },
        }),
        perceiveDiffModel: async () => ({
          schema: 'chrome-cdp-ex.perceive-diff.v1',
          changed: false,
        }),
      },
    });
    return { handler, reads, waits };
  }

  it('boundedly samples a blank renderer and accepts a nonblank redirect without navigation', async () => {
    const fixture = createHandler({
      states: [
        { url: 'about:blank', readyState: 'loading' },
        { url: 'about:srcdoc', readyState: 'interactive' },
        { url: 'https://redirect.example.test/final', readyState: 'complete' },
      ],
    });

    const result = await fixture.handler({ args: [] });

    expect(result.value).toBe('ready perception');
    expect(fixture.reads).toEqual([
      { url: 'about:blank', readyState: 'loading' },
      { url: 'about:srcdoc', readyState: 'interactive' },
      { url: 'https://redirect.example.test/final', readyState: 'complete' },
    ]);
    expect(fixture.waits).toEqual([7, 11]);
    expect(result.value).not.toContain('Navigated');
  });

  it.each([
    ['text', []],
    ['JSON', ['--format', 'json']],
    ['QA JSON', ['--qa', '--format', 'json']],
  ])('fails %s perception explicitly when the advertised HTTP target stays blank', async (_label, args) => {
    const fixture = createHandler({
      states: [
        { url: 'about:blank', readyState: 'loading' },
        { url: 'about:blank', readyState: 'interactive' },
        { url: 'about:srcdoc', readyState: 'interactive' },
      ],
    });

    await expect(fixture.handler({ args })).rejects.toThrow(persistentMismatchMessage);
    expect(fixture.waits).toEqual([7, 11]);
  });

  it('formats a readiness mismatch as an executable perceive retry instead of a status loop', () => {
    const output = T.formatCliError(new Error(persistentMismatchMessage), {
      cmd: 'perceive',
      targetPrefix: 'ABC12345',
    });

    expect(output).toContain('Kind: loading');
    expect(output).toContain('Strategy: retry-perceive');
    expect(output).toContain('Run: cdp perceive ABC12345 -C -d 8');
    expect(output).toContain('Next: cdp perceive ABC12345 -C -d 8');
    expect(output).not.toContain('cdp status');
  });

  it('builds the same bounded perceive retry in the structured CLI error model', () => {
    const model = T.buildCliErrorModel(new Error(persistentMismatchMessage), {
      cmd: 'perceive',
      targetPrefix: 'ABC12345',
    });

    expect(model).toMatchObject({
      schema: 'chrome-cdp-ex.cli-error.v1',
      ok: false,
      command: 'perceive',
      targetPrefix: 'ABC12345',
      error: { message: persistentMismatchMessage },
      recovery: {
        kind: 'loading',
        strategy: 'retry-perceive',
        run: 'cdp perceive ABC12345 -C -d 8',
      },
      nextSteps: ['cdp perceive ABC12345 -C -d 8'],
    });
    expect(model.recovery.run).not.toContain('status');
  });

  it.each([
    ['intentionally blank', 'about:blank'],
    ['non-HTTP', 'file:///tmp/fixture.html'],
  ])('preserves current perception behavior for an %s advertised target', async (_label, advertisedUrl) => {
    const fixture = createHandler({
      advertisedUrl,
      states: [{ url: 'about:blank', readyState: 'complete' }],
    });

    await expect(fixture.handler({ args: [] })).resolves.toMatchObject({ value: 'ready perception' });
    expect(fixture.reads).toEqual([]);
    expect(fixture.waits).toEqual([]);
  });

  it('preserves current perception behavior when live target metadata is unavailable', async () => {
    const fixture = createHandler({
      metadataError: new Error('Target.getTargets unavailable'),
    });

    await expect(fixture.handler({ args: [] })).resolves.toMatchObject({ value: 'ready perception' });
    expect(fixture.reads).toEqual([]);
    expect(fixture.waits).toEqual([]);
  });

  it('stops retrying when a renderer-state probe fails and preserves its exact error', async () => {
    const failure = new Error('Runtime.evaluate target closed');
    const fixture = createHandler();
    fixture.handler = T.createPerceiveCommandHandler({
      cdp: { send: () => { throw new Error('unexpected direct CDP call'); } },
      sessionId: 'session-141',
      targetId: 'ABC12345FULLTARGET',
      session: { lastAction: null },
      consoleBuf: { all: () => [] },
      exceptionBuf: { all: () => [] },
      netReqBuf: { all: () => [] },
      refMap: new Map(),
      lastPerceiveStore: { output: null },
      refState: { generation: 0 },
      ops: {
        readPerceiveTargetMetadata: async () => ({
          targetId: 'ABC12345FULLTARGET',
          url: 'https://example.test/start',
        }),
        readPerceiveDocumentState: async () => { throw failure; },
        perceiveReadinessDelaysMs: [0, 7, 11],
        sleep: async () => { throw new Error('probe failure must stop retries'); },
        perceiveText: async () => 'must not perceive',
      },
    });

    await expect(fixture.handler({ args: [] })).rejects.toBe(failure);
  });
});

describe('issue #158 unknown perceive flags', () => {
  it('#158 rejects unknown perceive flags with compact-flag help instead of dumping the page', async () => {
    expect(() => T.parsePerceiveArgs(['--cards'])).not.toThrow();
    expect(T.parsePerceiveArgs(['--cards']).cards).toBe(true);
    expect(() => T.parsePerceiveArgs(['--not-a-real-flag'])).toThrow(/unknown option --not-a-real-flag/);

    let message = '';
    try {
      T.parsePerceiveArgs(['--not-a-real-flag']);
    } catch (error) {
      message = error.message;
    }
    expect(message).toContain('unknown option --not-a-real-flag');
    expect(message).toContain('perceive compact flags:');
    expect(message).toContain('--last N | --adaptive | --qa | --summary | -i | -C | -d N | -x sel | -s sel');
    expect(message).toContain('--cards');

    const cli = T.formatCliError(new Error(message), { cmd: 'perceive', targetPrefix: 'F8741D08' });
    expect(cli).toContain('unknown option --not-a-real-flag');
    expect(cli).toContain('perceive compact flags:');
    expect(cli).not.toMatch(/Page:/);

    const handler = T.createPerceiveCommandHandler({
      cdp: { send() { throw new Error('unexpected CDP'); } },
      sessionId: 'session-158',
      targetId: 'F8741D08FULLTARGET',
      session: { lastAction: null },
      consoleBuf: { all: () => [] },
      exceptionBuf: { all: () => [] },
      netReqBuf: { all: () => [] },
      refMap: new Map(),
      lastPerceiveStore: { output: null },
      refState: { generation: 0 },
      ops: {
        readPerceiveTargetMetadata: async () => {
          throw new Error('should not sample readiness for unknown flags');
        },
        perceiveText: async () => 'FULL DUMP SHOULD NOT RUN',
      },
    });
    await expect(handler({ args: ['--feed-dump'] })).rejects.toThrow(/unknown option --feed-dump/);
    await expect(handler({ args: ['--qa', '--not-a-real-flag'] })).rejects.toThrow(/unknown option --not-a-real-flag/);

    const qa = T.parseQaModeArgs(['--qa', '--summary', '--adaptive']);
    expect(qa).toMatchObject({ qa: true, summary: true });
    expect(T.parsePerceiveArgs(qa.args).adaptive).toBe(true);
  });
});
