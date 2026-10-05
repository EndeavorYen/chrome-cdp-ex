import { describe, expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

// The #436 fake DOM, plus computed overflow and a scroll hook per element.
function fakeDom({ innerWidth = 780, innerHeight = 900 } = {}) {
  class Node {
    get isConnected() { return true; }
    get ownerDocument() { return doc; }
    get parentNode() { return this._parent || null; }
    getRootNode() { return doc; }
  }
  const doc = { nodeType: 9, hitAt: () => null, elementFromPoint(x, y) { return this.hitAt(x, y); } };
  function el(tag, { id = '', className = '', text = '', parent = null, rect = null, overflow = 'visible' } = {}) {
    const node = Object.create(Node.prototype);
    Object.assign(node, {
      nodeType: 1,
      tagName: tag.toUpperCase(),
      id,
      className,
      textContent: text,
      _parent: parent,
      _rect: rect || { x: 0, y: 0, width: 0, height: 0 },
      _overflow: overflow,
      scrolls: 0,
      getAttribute: () => null,
      getBoundingClientRect() { return { ...this._rect }; },
      scrollIntoView() { this.scrolls += 1; if (this.onScroll) this.onScroll(); },
      matches: selector => selector.split(',').map(part => part.trim().toUpperCase()).includes(tag.toUpperCase()),
      closest() { return null; },
    });
    return node;
  }
  const context = {
    window: { innerWidth, innerHeight },
    document: doc,
    location: { href: 'file:///dialog.html' },
    Node,
    getComputedStyle: node => ({ position: 'static', overflowX: node._overflow, overflowY: node._overflow }),
    Promise, Date, setTimeout, Math, Object, Reflect, String, Number, Array,
  };
  return { doc, el, context };
}

async function settledRect(context, node) {
  const fn = runInNewContext(`(${T.scrollSettledRectFunctionDeclaration({ hitTest: true })})`, context);
  return fn.call(node);
}

// The issue's layout: a <dialog> holding a max-height, overflow-y:auto grid; the last button sits
// inside the 900px viewport but below the grid's visible bottom (300).
function dialogLayout({ overflow = 'auto' } = {}) {
  const dom = fakeDom();
  const body = dom.el('body', { rect: { x: 0, y: 0, width: 780, height: 900 } });
  const dialog = dom.el('dialog', { id: 'pose-dlg', parent: body, rect: { x: 40, y: 60, width: 700, height: 800 } });
  const grid = dom.el('div', { className: 'pose-grid', parent: dialog, overflow, rect: { x: 60, y: 100, width: 660, height: 200 } });
  const button = dom.el('button', { text: '刪除', parent: grid, rect: { x: 80, y: 798, width: 60, height: 30 } });
  return { ...dom, body, dialog, grid, button };
}

describe('#551 a click target clipped by a scrollable ancestor', () => {
  it('T1 scrolls the clipping container first, then hits the target', async () => {
    const page = dialogLayout();
    page.button.onScroll = () => { page.button._rect = { x: 80, y: 185, width: 60, height: 30 }; };
    page.doc.hitAt = (x, y) => (y >= 100 && y <= 300 && page.button._rect.y < 300 ? page.button : page.dialog);
    const value = await settledRect(page.context, page.button);
    expect(page.button.scrolls).toBeGreaterThanOrEqual(1);
    expect(value.hit).toEqual({ covered: false });
    expect(value).toMatchObject({ y: 185 });
  });

  it('T2 a target still clipped after scrolling is covered and clipped, even when an ancestor is at the point', async () => {
    const page = dialogLayout({ overflow: 'hidden' });
    page.doc.hitAt = () => page.dialog;
    const value = await settledRect(page.context, page.button);
    expect(value.hit).toMatchObject({ covered: true, clipped: true, by: '<DIALOG#pose-dlg>' });
    const error = (() => {
      try {
        T.assertClickPointNotCovered(value.hit, { x: 110, y: 813, tag: 'BUTTON', text: '刪除' });
      } catch (e) {
        return e;
      }
      return null;
    })();
    expect(error.message).toContain('clipped by its scroll container');
    expect(error.message).toContain('The mouse click was not sent');
    expect(error.clickCovered).toMatchObject({ clipped: true, dialog: false });

    const { classifyActionFailure } = await import('../skills/chrome-cdp-ex/scripts/lib/action-recovery.mjs');
    const failure = classifyActionFailure(error, { action: 'click', target: { targetId: 'DDDCD75E', input: '[data-pdel="u-1"]' } });
    expect(failure).toMatchObject({ kind: 'covered', dispatched: false, covering: { clipped: true, dialog: false } });
    expect(failure.nextCommand).not.toContain('dismiss-modal');
    expect(failure.hints.join('\n')).toContain('clipped by its scroll container');
  });

  it('T2 keeps the dialog flag when a dialog that is not the container covers the clipped point', async () => {
    const page = dialogLayout({ overflow: 'hidden' });
    const modal = page.el('dialog', { id: 'confirm', parent: page.body });
    page.doc.hitAt = () => modal;
    const value = await settledRect(page.context, page.button);
    expect(value.hit).toMatchObject({ covered: true, clipped: true, dialog: true, by: '<DIALOG#confirm>' });
  });

  it('T3 an ancestor at a point inside the clip-visible rect still reaches the target', async () => {
    const page = dialogLayout();
    page.button._rect = { x: 80, y: 150, width: 60, height: 30 };
    page.doc.hitAt = () => page.grid;
    const value = await settledRect(page.context, page.button);
    expect(page.button.scrolls).toBe(0);
    expect(value.hit).toEqual({ covered: false });
  });
});
