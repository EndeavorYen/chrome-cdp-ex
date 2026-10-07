import { describe, expect, it } from 'vitest';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

const TARGET = '1667E1A4BEEF00000000000000000001';
const NO_AX_CHANGE = 'No changes detected.';
const AX_CHANGE = '+++ Added\n+ [button] "Phone menu"';

function viewportCdp({ readBack = null, screen = null } = {}) {
  let current = { w: 1042, h: 632 };
  return {
    send(method, params = {}) {
      if (method === 'Emulation.setDeviceMetricsOverride') {
        current = { w: params.width, h: params.height };
        return Promise.resolve({});
      }
      if (method === 'Runtime.evaluate') {
        const dims = readBack ? readBack(current) : current;
        const shown = screen ? screen(current) : dims;
        return Promise.resolve({
          result: {
            value: JSON.stringify({
              w: dims.w,
              h: dims.h,
              sw: shown.w,
              sh: shown.h,
              dpr: dims.dpr ?? 1,
            }),
          },
        });
      }
      return Promise.resolve({});
    },
  };
}

// Same sequence as the tab daemon: viewportStr stores the readback on the
// session, then the shallow-copied action target receives it.
async function resizeReceipt({ size, readBack = null, screen = null, domDiff = NO_AX_CHANGE } = {}) {
  const session = {};
  const line = await T.viewportStr(viewportCdp({ readBack, screen }), 'sid', size, { session });
  const target = {
    targetId: TARGET,
    input: size,
    resolvedBy: 'viewport',
    label: size,
    commandArgs: [size],
  };
  T.rememberViewportReadback(target, session);
  const run = format => T.runActionWithFeedback({
    action: 'viewport',
    target,
    dispatch: async () => line,
    dispatchMethod: 'viewport',
    feedbackPolicy: 'settle-diff',
    observe: async () => domDiff,
    format,
  });
  const text = await run('text');
  const json = JSON.parse(await run('json'));
  return { line, text, json, target };
}

describe('issue #578 viewport readback is the receipt', () => {
  it('a matching size is success when the AX tree did not change', async () => {
    const { line, text, json } = await resizeReceipt({ size: '390x844' });
    expect(line).toBe('Viewport: 390x844 (DPR 1) (mobile mode)');
    expect(text.startsWith(`${line}\n`)).toBe(true);
    expect(text).toMatch(/Outcome: changed — Viewport 390x844 applied \(DPR 1, mobile mode\)\./);
    expect(text).toMatch(/Verdict: continue — Viewport 390x844 applied \(DPR 1, mobile mode\)\./);
    expect(text).not.toMatch(/Verdict: investigate/);
    expect(text).not.toMatch(/fresh-perception-needed/);
    expect(text).not.toMatch(/No changes detected/);
    expect(text).not.toMatch(/No visible AX tree change/);
    expect(json.outcome).toMatchObject({
      status: 'changed',
      changed: true,
      needsAttention: false,
      evidence: 'viewport',
    });
    expect(json.verdict).toMatchObject({
      status: 'continue',
      canContinue: true,
      needsRecovery: false,
    });
    expect(json.receipt.blockingSignals).not.toContain('fresh-perception-needed');
    expect(json.outcome.reason).toBe('Viewport 390x844 applied (DPR 1, mobile mode).');
  });

  it('a mobile screen match is success when the layout viewport stays wide', async () => {
    const { line, text, json } = await resizeReceipt({
      size: '390x844',
      readBack: () => ({ w: 980, h: 2121 }),
      screen: () => ({ w: 390, h: 844 }),
    });
    expect(line).toBe('Viewport: 390x844 (DPR 1) (mobile mode); layout 980x2121');
    expect(text).toMatch(/Verdict: continue — Viewport 390x844 applied \(DPR 1, mobile mode, layout 980x2121\)\./);
    expect(text).not.toMatch(/fresh-perception-needed/);
    expect(text).not.toMatch(/No changes detected/);
    expect(json.verdict.status).toBe('continue');
    expect(json.verdict.canContinue).toBe(true);
  });

  it('a size mismatch names requested vs actual and is not success', async () => {
    const { line, text, json } = await resizeReceipt({
      size: '1920x1080',
      readBack: () => ({ w: 1042, h: 632 }),
      screen: () => ({ w: 1920, h: 1080 }),
    });
    expect(line).toBe('Viewport: 1042x632 (DPR 1); requested 1920x1080');
    expect(text.startsWith(`${line}\n`)).toBe(true);
    expect(text).toMatch(/Outcome: attention — Requested 1920x1080; read back 1042x632 \(DPR 1\)\./);
    expect(text).toMatch(/Verdict: investigate — Requested 1920x1080; read back 1042x632 \(DPR 1\)\./);
    expect(text).toMatch(/Next: cdp viewport 1667E1A4/);
    expect(text).not.toMatch(/Verdict: continue/);
    expect(text).not.toMatch(/fresh-perception-needed/);
    expect(text).not.toMatch(/No changes detected/);
    expect(json.outcome).toMatchObject({
      status: 'attention',
      changed: false,
      needsAttention: true,
      evidence: 'viewport',
    });
    expect(json.outcome.reason).toBe('Requested 1920x1080; read back 1042x632 (DPR 1).');
    expect(json.verdict).toMatchObject({
      status: 'investigate',
      canContinue: false,
      needsRecovery: false,
    });
    expect(json.receipt.blockingSignals).not.toContain('fresh-perception-needed');
  });

  it('attaches the AX diff only when the tree changed, and that change is still success', async () => {
    const { text, json } = await resizeReceipt({ size: '390x844', domDiff: AX_CHANGE });
    expect(text).toMatch(/Verdict: continue — Viewport 390x844 applied \(DPR 1, mobile mode\)\./);
    expect(text).toContain('+ [button] "Phone menu"');
    expect(text).not.toMatch(/fresh-perception-needed/);
    expect(text).not.toMatch(/Verdict: investigate/);
    expect(json.verdict.status).toBe('continue');
    expect(json.receipt.observedDeltaDetails).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'viewport', status: 'applied' }),
      expect.objectContaining({ type: 'dom', status: 'changed' }),
    ]));
  });

  it('an AX change does not turn a size mismatch into success', async () => {
    const { text, json } = await resizeReceipt({
      size: '1920x1080',
      readBack: () => ({ w: 1042, h: 632 }),
      domDiff: AX_CHANGE,
    });
    expect(text).toContain('+ [button] "Phone menu"');
    expect(text).toMatch(/Verdict: investigate — Requested 1920x1080; read back 1042x632 \(DPR 1\)\./);
    expect(json.verdict.status).toBe('investigate');
    expect(json.verdict.canContinue).toBe(false);
    expect(json.outcome.changed).toBe(false);
  });

  it('does not change other commands when the AX tree is unchanged', () => {
    const click = T.createActionResult({
      action: 'click',
      target: {
        targetId: TARGET,
        input: '#go',
        resolvedBy: 'selector',
        label: '#go',
      },
      dispatch: { ok: true, method: 'click' },
      settle: { ok: true, durationMs: 12 },
      effects: { domDiff: NO_AX_CHANGE, console: [], network: [], navigation: null },
    });
    expect(click.outcome.status).toBe('no-change');
    expect(click.verdict.status).toBe('investigate');
    expect(click.verdict.canContinue).toBe(false);
    expect(click.receipt.blockingSignals).toContain('fresh-perception-needed');

    const unreadViewport = T.createActionResult({
      action: 'viewport',
      target: {
        targetId: TARGET,
        input: '390x844',
        resolvedBy: 'viewport',
        label: '390x844',
      },
      dispatch: { ok: true, method: 'viewport' },
      settle: { ok: true, durationMs: 12 },
      effects: { domDiff: NO_AX_CHANGE, console: [], network: [], navigation: null },
    });
    expect(unreadViewport.outcome.status).toBe('no-change');
    expect(unreadViewport.verdict.status).toBe('investigate');
    expect(unreadViewport.receipt.blockingSignals).toContain('fresh-perception-needed');
  });
});
