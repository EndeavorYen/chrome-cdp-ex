import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

describe('issue #118 shared blank-page classification', () => {
  it('classifies populated, empty, and loading page signals consistently', () => {
    expect(T.classifyPageHealth).toBeTypeOf('function');

    expect(T.classifyPageHealth({
      url: '',
      readyState: 'complete',
      visibleTextLength: 24,
      elementCount: 12,
      visibleControlCount: 2,
      bodyRect: { width: 390, height: 844 },
      changed: true,
    })).toMatchObject({ status: 'populated', isBlank: false });

    expect(T.classifyPageHealth({
      url: 'https://example.test/empty',
      readyState: 'complete',
      visibleTextLength: 0,
      elementCount: 3,
      visibleControlCount: 0,
      bodyRect: { width: 390, height: 0 },
      changed: false,
    })).toMatchObject({ status: 'blank', isBlank: true });

    expect(T.classifyPageHealth({
      url: 'https://example.test/loading',
      readyState: 'loading',
      visibleTextLength: 0,
      elementCount: 3,
      visibleControlCount: 0,
      bodyRect: { width: 390, height: 0 },
    })).toMatchObject({ status: 'indeterminate', isBlank: false });
  });

  it('uses populated health evidence instead of treating a missing action URL as blank', () => {
    const summary = T.buildQaSummaryModel({
      page: { url: '', title: '' },
      pageHealth: {
        status: 'populated',
        isBlank: false,
        confidence: 'high',
        evidence: { visibleTextLength: 24, visibleControlCount: 2, changed: true },
      },
      console: { errors: 0, exceptions: 0 },
      network: { failures: 0 },
      action: { outcome: 'changed', dispatch: { ok: true }, changed: true },
      source: 'action',
    });

    expect(summary.ok).toBe(true);
    expect(summary.page).toMatchObject({ isBlank: false, healthStatus: 'populated' });
    expect(summary.pageHealth.evidence).toMatchObject({ changed: true });
  });

  it('renders indeterminate page health as review rather than pass', () => {
    const model = T.buildQaSummaryModel({
      page: { title: 'Loading', url: 'https://example.test' },
      pageHealth: T.classifyPageHealth({ readyState: 'loading' }),
    });

    expect(model.ok).toBe(false);
    expect(T.formatQaSummaryText(model)).toContain('Page health: indeterminate');
  });
});
