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

  it('T2 an <input type=hidden> (no layout box) is not counted, whatever its own style says', () => {
    expect(isCounted({ ...control({ rects: 0 }), _visibility: 'visible' })).toBe(false);
  });

  it('T3 visibility hidden or collapse is not counted', () => {
    expect(isCounted(control({ visibility: 'hidden' }))).toBe(false);
    expect(isCounted(control({ visibility: 'collapse' }))).toBe(false);
  });

  it('a control under a closed <details> (content-visibility: hidden) is not counted', () => {
    const calls = [];
    const inClosedDetails = { ...control(), checkVisibility: opts => { calls.push(opts); return false; } };
    expect(isCounted(inClosedDetails)).toBe(false);
    expect(calls[0]).toMatchObject({ visibilityProperty: true });
    expect(isCounted({ ...control(), checkVisibility: () => true })).toBe(true);
  });

  it('T4 perceive and summary census both apply the rule inside their counting loops', () => {
    const perceive = T.perceivePageScript(false);
    expect(perceive).toMatch(/for \(const el of document\.querySelectorAll\('a, button, input, select, textarea, \[role="button"\], \[tabindex\]'\)\) \{\s*if \(!renderedInteractive\(el\)\) continue;/);
    const summaryLoop = source.slice(source.indexOf('async function summaryModel('), source.indexOf('const domNodes = document.querySelectorAll'));
    expect(summaryLoop).toMatch(/for \(const el of interactive\) \{\s*if \(el\.getAttribute\('aria-hidden'\) === 'true' \|\| !renderedInteractive\(el\)\) continue;/);
  });
});
