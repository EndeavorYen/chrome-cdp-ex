import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

describe('issue #271 cascade injected !important beats inline', () => {
  it('#271 winner and editTarget match computedValue when injected !important beats inline', async () => {
    const cdp = {
      send(method) {
        if (method === 'DOM.getDocument') return Promise.resolve({ root: { nodeId: 1 } });
        if (method === 'DOM.querySelector') return Promise.resolve({ nodeId: 10 });
        if (method === 'CSS.getMatchedStylesForNode') {
          return Promise.resolve({
            matchedCSSRules: [{
              rule: {
                selectorList: { text: '#p18w-label' },
                origin: 'injected',
                style: {
                  styleSheetId: 'inject-1',
                  range: { startLine: 0 },
                  cssProperties: [{
                    name: 'background-color',
                    value: '#00ffff',
                    important: true,
                  }],
                },
              },
            }],
            inlineStyle: {
              cssProperties: [{ name: 'background-color', value: 'rgb(255, 255, 0)' }],
            },
            inherited: [],
          });
        }
        if (method === 'CSS.getComputedStyleForNode') {
          return Promise.resolve({
            computedStyle: [{ name: 'background-color', value: 'rgb(0, 255, 255)' }],
          });
        }
        if (method === 'CSS.getStyleSheetText') {
          return Promise.resolve({ text: '#p18w-label{background:#00ffff !important}' });
        }
        return Promise.resolve({});
      },
    };

    const model = JSON.parse(await T.cascadeStr(
      cdp, 'sid', '#p18w-label', 'background-color', new Map(), null, { format: 'json' },
    ));
    const property = model.properties[0];
    expect(property.computedValue).toBe('rgb(0, 255, 255)');
    expect(property.winner).toMatchObject({
      selector: '#p18w-label',
      value: '#00ffff',
      origin: 'injected',
    });
    expect(property.winner.selector).not.toBe('[inline]');
    expect(property.winner.value).not.toBe('rgb(255, 255, 0)');
    expect(model.editTarget).toMatchObject({
      property: 'background-color',
      selector: '#p18w-label',
      value: '#00ffff',
      origin: 'injected',
    });
    const injected = property.rules.find(rule => rule.origin === 'injected');
    const inline = property.rules.find(rule => rule.selector === '[inline]');
    expect(injected).toMatchObject({ winner: true, overridden: false, value: '#00ffff' });
    expect(inline).toMatchObject({ winner: false, overridden: true, value: 'rgb(255, 255, 0)' });
    expect(property.rules.filter(rule => rule.winner)).toHaveLength(1);
  });
});
