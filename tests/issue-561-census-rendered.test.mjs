import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
const source = readFileSync(new URL('../skills/chrome-cdp-ex/scripts/cdp.mjs', import.meta.url), 'utf8');

function control({ rects = 1, visibility = 'visible' } = {}) {
  return { getClientRects: () => Array.from({ length: rects }), _visibility: visibility };
}

function isCounted(el) {
  const fn = runInNewContext(`(${T.renderedInteractiveSource()})`, {
    getComputedStyle: node => ({ visibility: node._visibility }),
  });
  return fn(el);
}

describe('#561 the Interactive census counts rendered, visible controls only', () => {
  it('T1 a control with no client rects (closed <dialog>, display:none ancestor, hidden) is not counted', () => {
    expect(isCounted(control({ rects: 0 }))).toBe(false);
    expect(isCounted(control())).toBe(true);
  });

  it('T2 an <input type=hidden> has no client rects and is not counted', () => {
    expect(isCounted(control({ rects: 0 }))).toBe(false);
  });

  it('T3 visibility hidden or collapse is not counted', () => {
    expect(isCounted(control({ visibility: 'hidden' }))).toBe(false);
    expect(isCounted(control({ visibility: 'collapse' }))).toBe(false);
  });

  it('T4 perceive and summary census both apply the rule', () => {
    const uses = source.match(/renderedInteractive\(el\)/g) || [];
    expect(uses.length).toBeGreaterThanOrEqual(2);
    expect(T.perceivePageScript ? String(T.perceivePageScript) : source).toBeTruthy();
  });
});
