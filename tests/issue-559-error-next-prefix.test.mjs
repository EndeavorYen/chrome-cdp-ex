import { describe, expect, it } from 'vitest';

const { classifyActionFailure, formatActionFailure } = await import('../skills/chrome-cdp-ex/scripts/lib/action-recovery.mjs');

const FULL_ID = 'C3573E00040E8B91633F7895CEF45D09';

function disabledError() {
  const err = new Error('<BUTTON> "文生圖0" is disabled (disabled attribute). The click was not sent.');
  err.actionDisabled = { tag: 'BUTTON', text: '文生圖0', reason: 'disabled attribute', enabledSelector: '#filters .chip:nth-child(3):not(:disabled)' };
  return err;
}

describe('#559 action failure Next uses the 8-character target prefix', () => {
  it('T1 a disabled target names the prefix', () => {
    const text = formatActionFailure(disabledError(), { action: 'click', target: { targetId: FULL_ID, input: '#filters .chip:nth-child(3)' } });
    expect(text).toMatch(/^Next: cdp \S+ C3573E00 /m);
    expect(text).not.toContain(FULL_ID);
  });

  it('T2 an unknown-kind failure (scroll direction) names the prefix', () => {
    const text = formatActionFailure(new Error('Direction required: down, up, left, right, x,y, or to top/to bottom'), {
      action: 'scroll',
      target: { targetId: FULL_ID, input: 'sideways' },
    });
    expect(text).toContain('Next: cdp perceive C3573E00 -C -d 8');
    expect(text).not.toContain(FULL_ID);
  });

  it('T3 the JSON recovery holds no full target id', () => {
    for (const err of [disabledError(), new Error('Element not found: #nope'), new Error('Direction required: down')]) {
      const failure = classifyActionFailure(err, { action: 'click', target: { targetId: FULL_ID, input: '#x' } });
      expect(JSON.stringify({ ...failure, target: null }), err.message).not.toContain(FULL_ID);
    }
  });

  it('T4 an alias, a short prefix and the placeholder are unchanged', () => {
    const err = new Error('Direction required: down');
    expect(classifyActionFailure(err, { action: 'scroll', target: { targetId: '@app' } }).nextCommand).toBe('cdp perceive @app -C -d 8');
    expect(classifyActionFailure(err, { action: 'scroll', target: { targetId: 'C3573E' } }).nextCommand).toBe('cdp perceive C3573E -C -d 8');
    expect(classifyActionFailure(err, { action: 'scroll', target: {} }).nextCommand).toBe('cdp perceive <target> -C -d 8');
  });
});
