import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

describe('issue #119 live target binding contracts', () => {
  const livePages = [
    { targetId: 'AAAABBBB11112222', title: 'Blank', url: 'about:blank' },
    { targetId: 'CCCCDDDD33334444', title: 'Agent Decision Lab', url: 'http://127.0.0.1:8788/app' },
  ];

  it('resolves the requested populated target from live discovery instead of a stale blank daemon', () => {
    expect(T.resolveLiveTargetBinding).toBeTypeOf('function');
    const binding = T.resolveLiveTargetBinding({
      requested: 'CCCCDDDD',
      livePages,
      daemonBinding: {
        targetId: 'CCCCDDDD33334444',
        boundTargetId: 'AAAABBBB11112222',
      },
    });

    expect(binding).toMatchObject({
      schema: 'chrome-cdp-ex.target-resolution.v1',
      requestedTargetPrefix: 'CCCCDDDD',
      requestedTargetId: 'CCCCDDDD33334444',
      boundTargetId: 'AAAABBBB11112222',
      resolvedTargetId: 'CCCCDDDD33334444',
      resolutionSource: 'live-discovery',
      status: 'rebind-required',
      rebindRequired: true,
    });
  });

  it('reuses matching target daemons and preserves ambiguity errors', () => {
    const binding = T.resolveLiveTargetBinding({
      requested: 'CCCCDDDD',
      livePages,
      daemonBinding: {
        targetId: 'CCCCDDDD33334444',
        boundTargetId: 'CCCCDDDD33334444',
      },
    });
    expect(binding).toMatchObject({ status: 'reused', rebindRequired: false });

    expect(() => T.resolveLiveTargetBinding({
      requested: 'CCCC',
      livePages: [
        ...livePages,
        { targetId: 'CCCCEEEE55556666', title: 'Other', url: 'http://127.0.0.1:8788/other' },
      ],
    })).toThrow(/ambiguous/i);
  });

  it('attaches bounded requested, bound, and resolved ids to structured CLI output', () => {
    const diagnostic = {
      schema: 'chrome-cdp-ex.target-resolution.v1',
      requestedTargetPrefix: 'CCCCDDDD',
      requestedTargetId: 'CCCCDDDD33334444',
      boundTargetId: 'CCCCDDDD33334444',
      resolvedTargetId: 'CCCCDDDD33334444',
      resolutionSource: 'live-discovery',
      status: 'rebound',
      rebindRequired: false,
      rebound: true,
    };
    const output = T.attachTargetResolutionDiagnostics(JSON.stringify({
      schema: 'chrome-cdp-ex.perception.v1',
      page: { url: 'http://127.0.0.1:8788/app' },
    }), diagnostic);

    expect(JSON.parse(output).targetResolution).toEqual({
      requestedTargetPrefix: 'CCCCDDDD',
      requestedTargetId: 'CCCCDDDD33334444',
      boundTargetId: 'CCCCDDDD33334444',
      resolvedTargetId: 'CCCCDDDD33334444',
      resolutionSource: 'live-discovery',
      status: 'rebound',
      rebound: true,
    });
    expect(output.length).toBeLessThan(500);
  });

  it('collapses identical target ids in compact CLI output', () => {
    const targetId = 'CCCCDDDD33334444';
    const output = T.attachTargetResolutionDiagnostics(JSON.stringify({
      schema: 'chrome-cdp-ex.action.v1',
      mode: 'compact',
      action: 'click',
    }), {
      requestedTargetPrefix: 'CCCCDDDD',
      requestedTargetId: targetId,
      boundTargetId: targetId,
      resolvedTargetId: targetId,
      resolutionSource: 'live-discovery',
      status: 'reused',
      rebound: false,
    });

    expect(JSON.parse(output).targetResolution).toEqual({
      requestedTargetPrefix: 'CCCCDDDD',
      targetId,
      status: 'reused',
      rebound: false,
    });
    expect(output.length).toBeLessThan(300);
    expect(output).not.toContain('\n');
  });

  it('keeps full target diagnostics in compact output when the target changed', () => {
    const output = T.attachTargetResolutionDiagnostics(JSON.stringify({
      schema: 'chrome-cdp-ex.action.v1',
      mode: 'compact',
      action: 'click',
    }), {
      requestedTargetPrefix: 'CCCCDDDD',
      requestedTargetId: 'CCCCDDDD33334444',
      boundTargetId: 'AAAABBBB11112222',
      resolvedTargetId: 'CCCCDDDD33334444',
      resolutionSource: 'live-discovery',
      status: 'rebound',
      rebound: true,
    });

    expect(JSON.parse(output).targetResolution).toMatchObject({
      requestedTargetId: 'CCCCDDDD33334444',
      boundTargetId: 'AAAABBBB11112222',
      resolvedTargetId: 'CCCCDDDD33334444',
      status: 'rebound',
      rebound: true,
    });
  });

  it('treats a daemon bound to a different target as stale', () => {
    const assessment = T.assessDaemonFreshness({
      targetPrefix: 'CCCCDDDD',
      expectedTargetId: 'CCCCDDDD33334444',
      current: { schema: 'chrome-cdp-ex.daemon-metadata.v1', gitCommit: 'same' },
      daemon: {
        schema: 'chrome-cdp-ex.daemon-metadata.v1',
        gitCommit: 'same',
        boundTargetId: 'AAAABBBB11112222',
      },
    });
    expect(assessment).toMatchObject({ stale: true, status: 'target-mismatch' });
    expect(assessment.mismatches).toContainEqual(expect.objectContaining({ field: 'boundTargetId' }));
  });
});
