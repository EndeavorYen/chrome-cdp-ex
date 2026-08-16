import { describe, expect, it } from 'vitest';

import {
  buildActionRecoveryPlan,
  buildNoChangeOutcomeRecommendation,
  classifyActionFailure,
  formatActionFailure,
  overlaySelectorArg,
  recoveryCommandsFromDiagnosis,
  RECOVERY_POLICY_REGISTRY,
  listRecoveryPolicyKinds,
  getRecoveryPolicyTemplate,
} from '../skills/chrome-cdp-ex/scripts/lib/action-recovery.mjs';

describe('action recovery lib', () => {
  it('classifies stale refs, overlays, and wrong frames into executable next commands', () => {
    expect(classifyActionFailure(
      new Error('Unknown ref: @4. Refs were invalidated by DOM changes.'),
      { action: 'click', target: { targetId: 'ABC123', input: '@4' } },
    )).toMatchObject({
      kind: 'stale-ref',
      nextCommand: 'cdp perceive ABC123 -C -d 8',
    });

    expect(classifyActionFailure(
      new Error('Other element would receive the click'),
      { action: 'click', target: { targetId: 'ABC123', input: '#save' } },
    )).toMatchObject({
      kind: 'overlay',
      nextCommand: 'cdp dismiss-modal ABC123',
    });

    expect(classifyActionFailure(
      new Error('No frame for given id found'),
      { action: 'click', target: { targetId: 'ABC123', input: '#pay' } },
    )).toMatchObject({
      kind: 'wrong-frame',
      nextCommand: 'cdp perceive ABC123 -C -d 8',
    });

    expect(classifyActionFailure(
      new Error('Click on <A href="https://www.iana.org/help/example-domains"> did not navigate. Try jsclick or click --js.'),
      { action: 'click', target: { targetId: '1D366978', input: 'a' } },
    )).toMatchObject({
      kind: 'no-navigation',
      nextCommand: 'cdp jsclick 1D366978 a',
    });

    expect(classifyActionFailure(
      new Error('click: Input.dispatchMouseEvent completed but the page received no mousedown/click events at (51, 110). The mouse path failed closed. Try jsclick or click --js.'),
      { action: 'click', target: { targetId: '62E1DF19', input: '#p17btn' } },
    )).toMatchObject({
      kind: 'no-input-events',
      nextCommand: 'cdp jsclick 62E1DF19 #p17btn',
    });
  });

  it('builds recovery policies for runtime and network diagnostics', () => {
    expect(buildActionRecoveryPlan({ status: 'attention', kind: 'console-error' }, { targetId: 'ABC123' })).toMatchObject({
      strategy: 'inspect-runtime-errors',
      priority: 'high',
      commands: [
        { command: 'cdp console ABC123 --errors' },
        { command: 'cdp perceive ABC123 --since-action' },
        { command: 'cdp report ABC123 --format json' },
      ],
      verifyCommand: 'cdp perceive ABC123 --since-action',
    });

    expect(buildActionRecoveryPlan({ status: 'attention', kind: 'network-failure' }, { targetId: 'ABC123' })).toMatchObject({
      strategy: 'inspect-network',
      priority: 'high',
      commands: [
        { command: 'cdp netlog ABC123' },
        { command: 'cdp perceive ABC123 --since-action' },
        { command: 'cdp report ABC123 --format json' },
      ],
    });
  });

  it('routes no-change actions to target-aware overlay, perceive, and report checks', () => {
    const recommendation = buildNoChangeOutcomeRecommendation({
      action: 'click',
      actionIndex: 2,
      target: 'ABC123',
      targetInput: '#refresh',
    });

    expect(recommendation).toMatchObject({
      source: 'action-outcome',
      actionIndex: 2,
      action: 'click',
      strategy: 'investigate-no-change',
      priority: 'medium',
      blockingSignals: [
        'overlay-check-needed',
        'fresh-perception-needed',
      ],
      recoveryHint: 'Action dispatched but produced no visible AX tree change; inspect overlays and fresh refs before retrying.',
      verifyCommand: 'cdp perceive ABC123 -C -d 8',
      commands: [
        'cdp overlay ABC123 "#refresh" --format json',
        'cdp perceive ABC123 -C -d 8',
        'cdp report ABC123 --format json',
      ],
    });
  });

  it('adds frame checks to no-change recommendations only for frame-scoped targets', () => {
    const recommendation = buildNoChangeOutcomeRecommendation({
      action: 'click',
      target: 'ABC123',
      targetInput: '@f2:4',
      targetInfo: { resolvedBy: 'frame-ref', frameRef: '@f2' },
    });

    expect(recommendation.blockingSignals).toEqual([
      'overlay-check-needed',
      'frame-check-needed',
      'fresh-perception-needed',
    ]);
    expect(recommendation.commands).toEqual([
      'cdp overlay ABC123 @f2:4 --format json',
      'cdp frame ABC123 --format json',
      'cdp perceive ABC123 -C -d 8',
      'cdp report ABC123 --format json',
    ]);
  });

  it('treats clipboard copy clicks as expected no-change without overlay recovery', () => {
    const recommendation = buildNoChangeOutcomeRecommendation({
      action: 'click',
      target: '6914C171',
      targetInput: '@3',
      targetInfo: {
        input: '@3',
        label: 'Copy model name to clipboard',
        expectedOutcome: 'clipboard-no-change',
      },
    });
    expect(recommendation.strategy).toBe('continue');
    expect(recommendation.blockingSignals).toEqual([]);
    expect(recommendation.commands.join('\n')).not.toMatch(/\boverlay\b/);
  });

  it('omits press keys from overlay Next and continues no-change key presses', () => {
    expect(overlaySelectorArg('Escape', { resolvedBy: 'key' })).toBe('');
    expect(overlaySelectorArg('modal', { resolvedBy: 'dialog' })).toBe('');
    const recommendation = buildNoChangeOutcomeRecommendation({
      action: 'press',
      target: 'ABC123',
      targetInput: 'Escape',
      targetInfo: { input: 'Escape', resolvedBy: 'key' },
    });
    expect(recommendation.strategy).toBe('continue');
    expect(recommendation.commands.join('\n')).not.toMatch(/\boverlay\b/);
  });

  it('keeps text failure output and recovery command extraction stable', () => {
    const text = formatActionFailure(new Error('Element not found: #save'), {
      action: 'click',
      target: { targetId: 'ABC123', input: '#save' },
    });

    expect(text).toContain('Action failure: selector');
    expect(text).toContain('Next: cdp perceive ABC123 -C -d 8');
    expect(text).toContain('Original: Element not found: #save');
    expect(recoveryCommandsFromDiagnosis({
      recovery: { commands: [{ command: 'cdp console ABC123 --errors' }] },
    })).toEqual(['cdp console ABC123 --errors']);
  });

  it('PDF plugin action misses Next eval prefix instead of perceive', () => {
    const target = {
      targetId: '9FAD7C71E2DA7ED50C67BE2092417850',
      input: 'a',
      page: {
        title: '',
        url: 'https://arxiv.org/pdf/2608.12307',
        contentType: 'application/pdf',
      },
    };
    expect(classifyActionFailure(new Error('Element not found: a'), {
      action: 'click',
      target,
    })).toMatchObject({
      kind: 'selector',
      nextCommand: 'cdp eval 9FAD7C71 "document.contentType"',
    });
    const text = formatActionFailure(new Error('Element not found: a'), { action: 'click', target });
    expect(text).toContain('Next: cdp eval 9FAD7C71 "document.contentType"');
    expect(text).not.toMatch(/cdp perceive /);
  });

  it('#285 leftover pdf-viewer no-change click --js / scroll Next eval, not overlay/perceive', () => {
    const targetInfo = {
      targetId: 'CFD023D2E2DA7ED50C67BE2092417850',
      input: 'body',
      label: 'body',
      page: {
        title: '',
        url: 'https://arxiv.org/pdf/2608.12307',
        contentType: 'application/pdf',
      },
    };
    const extraText = 'No changes detected (settle shape was pdf-viewer.v1; empty AX).';
    const clickJs = buildNoChangeOutcomeRecommendation({
      action: 'click',
      target: 'CFD023D2',
      targetInput: 'body',
      targetInfo,
      extraText,
    });
    expect(clickJs.strategy).toBe('continue');
    expect(clickJs.blockingSignals).toEqual([]);
    expect(clickJs.commands).toEqual(['cdp eval CFD023D2 "document.contentType"']);
    expect(clickJs.commands.join('\n')).not.toMatch(/\boverlay\b/);
    expect(clickJs.commands.join('\n')).not.toMatch(/perceive .* -C/);

    const scroll = buildNoChangeOutcomeRecommendation({
      action: 'scroll',
      target: 'CFD023D2',
      targetInput: 'down',
      targetInfo: {
        ...targetInfo,
        input: 'down',
        label: 'down',
        resolvedBy: 'scroll',
      },
      extraText,
    });
    expect(scroll.strategy).toBe('continue');
    expect(scroll.commands).toEqual(['cdp eval CFD023D2 "document.contentType"']);
    expect(scroll.commands.join('\n')).not.toMatch(/perceive .* -C/);
  });

  it('#293 leftover feed --cards no-change scroll Next perceive --cards, not -C -d 8', () => {
    const extraText = 'unchanged; still first cards; virtualized window did not replace cards';
    const rec = buildNoChangeOutcomeRecommendation({
      action: 'scroll',
      target: '2E94F948',
      targetInput: 'down 80',
      targetInfo: {
        targetId: '2E94F948ABCDEF0123456789ABCDEF01',
        input: 'down 80',
        resolvedBy: 'scroll',
        expectedOutcome: 'cards-window-no-change',
      },
      extraText,
    });
    expect(rec.strategy).toBe('continue');
    expect(rec.blockingSignals).toEqual([]);
    expect(rec.commands).toEqual(['cdp perceive 2E94F948 --cards']);
    expect(rec.commands.join('\n')).not.toMatch(/perceive .* -C/);
    expect(rec.commands.join('\n')).not.toMatch(/\breport\b/);
  });

  it('#295 leftover golden-path AX no-change scroll Next perceive -C -d 8, not report', () => {
    const extraText = '(no changes detected in AX tree)';
    const rec = buildNoChangeOutcomeRecommendation({
      action: 'scroll',
      target: '561F7DA8',
      targetInput: 'down 80',
      targetInfo: {
        targetId: '561F7DA8ABCDEF0123456789ABCDEF01',
        input: 'down 80',
        resolvedBy: 'scroll',
        expectedOutcome: 'leftover-ax-scroll-no-change',
      },
      extraText,
    });
    expect(rec.strategy).toBe('continue');
    expect(rec.blockingSignals).toEqual([]);
    expect(rec.commands).toEqual(['cdp perceive 561F7DA8 -C -d 8']);
    expect(rec.commands.join('\n')).not.toMatch(/\breport\b/);
    expect(rec.commands.join('\n')).not.toMatch(/record-actions/);
    expect(rec.recoveryHint).toBeNull();
  });

  it('#311 leftover golden-path AX no-change does not author a Recovery hint that restates Next perceive', () => {
    const rec = buildNoChangeOutcomeRecommendation({
      action: 'scroll',
      target: '561F7DA8',
      targetInput: 'down 80',
      targetInfo: {
        targetId: '561F7DA8ABCDEF0123456789ABCDEF01',
        input: 'down 80',
        resolvedBy: 'scroll',
        expectedOutcome: 'leftover-ax-scroll-no-change',
      },
      extraText: '(no changes detected in AX tree)',
    });
    expect(rec.strategy).toBe('continue');
    expect(rec.outcomeStatus).toBe('no-change');
    expect(rec.commands).toEqual(['cdp perceive 561F7DA8 -C -d 8']);
    expect(rec.recoveryHint).toBeNull();
    expect(rec.reason).toMatch(/leftover golden-path AX/);
  });
});


describe('recovery policy registry', () => {
  it('#95 exposes a stable registry for known diagnosis kinds', () => {
    const kinds = listRecoveryPolicyKinds();
    for (const kind of ['overlay', 'stale-ref', 'network-failure', 'timeout', 'wrong-frame', 'console-error', 'no-input-events']) {
      expect(kinds).toContain(kind);
      expect(getRecoveryPolicyTemplate(kind).strategy).toBeTruthy();
    }
    expect(RECOVERY_POLICY_REGISTRY.default.strategy).toBe('refresh-perception');
    const plan = buildActionRecoveryPlan({ kind: 'overlay', nextCommand: 'cdp dismiss-modal ABC' }, { targetId: 'ABC123', targetInput: '#x' });
    expect(plan.schema).toBe('chrome-cdp-ex.recovery-policy.v1');
    expect(plan.strategy).toBe('clear-overlay');
    expect(plan.commands.map(c => c.command)).toEqual(expect.arrayContaining([
      'cdp overlay ABC123 "#x" --format json',
      'cdp dismiss-modal ABC',
      'cdp perceive ABC123 -C -d 8',
    ]));
  });

  it('classifies restore/replay missing files and verify-click usage as Kind:usage', () => {
    expect(classifyActionFailure(new Error("ENOENT: no such file or directory, open '[checkpoint-path-redacted]'"), {
      action: 'restore',
      target: { targetId: '1D366978' },
    })).toMatchObject({ kind: 'usage', nextCommand: 'cdp help restore' });
    expect(classifyActionFailure(new Error('restore: unsupported checkpoint schema (missing)'), {
      action: 'restore',
      target: { targetId: '1D366978' },
    })).toMatchObject({ kind: 'usage', nextCommand: 'cdp help restore' });
    expect(classifyActionFailure(new Error('replay requires --json <record-actions-json> or --file <path>'), {
      action: 'replay',
      target: { targetId: '1D366978' },
    })).toMatchObject({ kind: 'usage', nextCommand: 'cdp help replay' });
    expect(classifyActionFailure(new Error('verify-click: --expect-status requires --expect-request'), {
      action: 'verify-click',
      target: { targetId: '270379DA', input: '#b' },
    })).toMatchObject({ kind: 'usage', nextCommand: 'cdp help verify-click' });
  });
});
