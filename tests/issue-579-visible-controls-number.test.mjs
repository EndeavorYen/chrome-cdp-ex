import { describe, expect, it } from 'vitest';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

function numberInput(overrides = {}) {
  return {
    tag: 'input',
    role: 'textbox',
    label: 'textbox',
    text: '',
    clickable: true,
    rect: { x: 12, y: 40, w: 80, h: 24 },
    selector: 'input[name="qty"]',
    hints: { id: '', classes: [] },
    ...overrides,
  };
}

describe('issue #579 visible controls use the AX role and accessible name', () => {
  it('replaces textbox "textbox" with the matched spinbutton name', () => {
    const control = T.attachRefToVisibleControl(
      numberInput(),
      T.refAnnotationsFromTreeLines(['[spinbutton] Qty  @2  (12,40 80×24)']),
    );
    const line = T.formatVisibleControlLine(control);
    expect(control.role).toBe('spinbutton');
    expect(control.label).toBe('Qty');
    expect(control.ref).toBe('@2');
    expect(line).toContain('role=spinbutton "Qty"');
    expect(line).toContain('@2');
    expect(line).not.toContain('textbox');
  });

  it('keeps the accessible name when the AX dump also prints the value', () => {
    const control = T.attachRefToVisibleControl(
      numberInput(),
      T.refAnnotationsFromTreeLines(['[spinbutton] Qty = "4"  @2  (12,40 80×24)']),
    );
    expect(control.role).toBe('spinbutton');
    expect(control.label).toBe('Qty');
    expect(T.formatVisibleControlLine(control)).toContain('role=spinbutton "Qty"');
    expect(T.formatVisibleControlLine(control)).not.toContain('"4"');
  });

  it('uses a multi-word AX name for a generic label and keeps a real label', () => {
    const named = T.attachRefToVisibleControl(
      numberInput(),
      T.refAnnotationsFromTreeLines(['[spinbutton] Item quantity  @2  (12,40 80×24)']),
    );
    expect(named.role).toBe('spinbutton');
    expect(named.label).toBe('Item quantity');

    const realLabel = T.attachRefToVisibleControl(
      numberInput({ label: 'count' }),
      T.refAnnotationsFromTreeLines(['[spinbutton] Qty  @2  (12,40 80×24)']),
    );
    expect(realLabel.role).toBe('spinbutton');
    expect(realLabel.label).toBe('count');

    const slider = T.attachRefToVisibleControl(
      numberInput({ role: 'textbox', label: 'textbox', selector: 'input[name="volume"]', rect: { x: 12, y: 80, w: 120, h: 24 } }),
      T.refAnnotationsFromTreeLines(['[slider] Volume  @3  (12,80 120×24)']),
    );
    expect(slider.role).toBe('slider');
    expect(slider.label).toBe('Volume');
  });

  it('does not rewrite a label when several AX nodes share the rect', () => {
    const control = T.attachRefToVisibleControl(
      {
        tag: 'a',
        role: 'link',
        label: 'docs',
        clickable: true,
        rect: { x: 12, y: 40, w: 80, h: 24 },
        selector: 'a[href="#docs"]',
        hints: { id: '', classes: [] },
      },
      T.refAnnotationsFromTreeLines([
        '[link] LICENSE  @1  (12,40 80×24)',
        '[link] README.md  @2  (12,40 80×24)',
      ]),
    );
    expect(control.ref).toBe('@1');
    expect(control.role).toBe('link');
    expect(control.label).toBe('docs');
  });

  it('drops a generic role fallback when the AX node has no accessible name', () => {
    const control = T.attachRefToVisibleControl(
      numberInput(),
      T.refAnnotationsFromTreeLines(['[spinbutton]  @2  (12,40 80×24)']),
    );
    const line = T.formatVisibleControlLine(control);
    expect(control.role).toBe('spinbutton');
    expect(control.label).toBe('');
    expect(line).toContain('role=spinbutton');
    expect(line).not.toContain('textbox');
    expect(line).not.toMatch(/"\s*"/);
  });

  it('leaves an unmatched control and a distinct label without an AX name alone', () => {
    const unmatched = T.attachRefToVisibleControl(
      numberInput(),
      T.refAnnotationsFromTreeLines(['[button] Save  @1  (100,40 64×24)']),
    );
    expect(unmatched.role).toBe('textbox');
    expect(unmatched.label).toBe('textbox');
    expect(unmatched.ref).toBeUndefined();

    const named = T.attachRefToVisibleControl(
      numberInput({ label: 'oin', selector: 'input#oin', hints: { id: 'oin' } }),
      T.refAnnotationsFromTreeLines(['[textbox]  @f2:2  (12,40 80×24)']),
    );
    expect(named.ref).toBe('@f2:2');
    expect(named.role).toBe('textbox');
    expect(named.label).toBe('oin');
  });

  it('prefers the AX node name over a value suffix parsed from the dump', () => {
    const control = T.attachRefToVisibleControl(
      numberInput(),
      T.refAnnotationsFromTreeLines(['[spinbutton] Qty = "4"  @f2:2  (12,40 80×24)']),
      new Map([[2, { role: 'spinbutton', name: 'Quantity' }]]),
    );
    expect(control.ref).toBe('@f2:2');
    expect(control.role).toBe('spinbutton');
    expect(control.label).toBe('Quantity');
  });

  it('perceive -C prints spinbutton "Qty" on the same @ref as the AX tree', async () => {
    const cdp = {
      send(method, params = {}) {
        if (method === 'Runtime.evaluate') {
          return Promise.resolve({
            result: {
              value: JSON.stringify({
                title: 'Order',
                url: 'https://example.test/order',
                contentType: 'text/html',
                vw: 800,
                vh: 600,
                scrollY: 0,
                scrollMax: 0,
                counts: { 'input[number]': 1, 'input[text]': 1, button: 1 },
                focused: 'none',
                layoutMap: {},
                styleHints: {},
                cursorInteractives: [],
                visibleControls: [
                  numberInput(),
                  numberInput({
                    label: 'textbox',
                    selector: 'input[name="note"]',
                    rect: { x: 12, y: 200, w: 80, h: 24 },
                  }),
                  {
                    tag: 'button',
                    role: 'button',
                    label: 'Save',
                    text: 'Save',
                    clickable: true,
                    rect: { x: 100, y: 40, w: 64, h: 24 },
                    selector: 'button',
                    hints: { id: '', classes: [] },
                  },
                ],
                visibleControlsTruncated: false,
              }),
            },
          });
        }
        if (method === 'Accessibility.getFullAXTree') {
          return Promise.resolve({
            nodes: [
              { nodeId: 'root', role: { value: 'RootWebArea' }, name: { value: 'Order' }, childIds: ['qty', 'save'] },
              {
                nodeId: 'qty',
                parentId: 'root',
                role: { value: 'spinbutton' },
                name: { value: 'Qty' },
                value: { value: '4' },
                backendDOMNodeId: 42,
              },
              {
                nodeId: 'save',
                parentId: 'root',
                role: { value: 'button' },
                name: { value: 'Save' },
                backendDOMNodeId: 43,
              },
            ],
          });
        }
        if (method === 'DOM.resolveNode') {
          if (params.backendNodeId === 42) return Promise.resolve({ object: { objectId: 'qty-object' } });
          if (params.backendNodeId === 43) return Promise.resolve({ object: { objectId: 'save-object' } });
          return Promise.resolve({ object: { objectId: 'other' } });
        }
        if (method === 'Runtime.callFunctionOn') {
          if (params.objectId === 'qty-object') {
            return Promise.resolve({ result: { value: { x: 12, y: 40, w: 80, h: 24, position: '' } } });
          }
          if (params.objectId === 'save-object') {
            return Promise.resolve({ result: { value: { x: 100, y: 40, w: 64, h: 24, position: '' } } });
          }
          return Promise.resolve({ result: { value: { x: 0, y: 0, w: 0, h: 0, position: '' } } });
        }
        return Promise.resolve({});
      },
      onEvent() { return () => {}; },
    };

    const out = await T.perceiveStr(
      cdp,
      'sid',
      new T.RingBuffer(8),
      new T.RingBuffer(8),
      new Map(),
      { last: null },
      { cursorInteractive: true, maxDepth: 8 },
    );
    const ax = out.match(/\[spinbutton\] Qty = "4"\s+@(\d+)\s+\(12,40 80×24\)/);
    expect(ax).not.toBeNull();
    const lines = out.split('\n');
    const qtyLine = lines.find(line => line.includes('input[name="qty"]'));
    const noteLine = lines.find(line => line.includes('input[name="note"]'));
    const saveLine = lines.find(line => line.includes('role=button'));
    expect(qtyLine).toContain('role=spinbutton "Qty"');
    expect(qtyLine).toContain(`@${ax[1]}`);
    expect(qtyLine).not.toContain('textbox');
    expect(noteLine).toContain('role=textbox "textbox"');
    expect(saveLine).toContain('role=button "Save"');
    expect(saveLine).not.toContain('spinbutton');
  });
});
