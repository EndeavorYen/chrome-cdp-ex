import { describe, it, expect } from 'vitest';
import { createMockCDP } from './mock-cdp.mjs';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
const { injectStr, cascadeStr, decodeVLQ, mapLineToSource, stripVitePathQuery, mapStyleSource } = T;

// =========================================================================
// CDP mock helper — lightweight fake for testing command functions
// =========================================================================


// =========================================================================
// injectStr — live CSS/JS injection
// =========================================================================

describe('injectStr', () => {
  it('--css should inject a style element with data-cdp-inject attribute', async () => {
    let evalledExpr = '';
    const cdp = createMockCDP({
      'Runtime.evaluate': (params) => {
        evalledExpr = params.expression;
        return { result: { value: 'inject-1' } };
      },
    });
    const result = await injectStr(cdp, 'sid1', ['--css', 'body { color: red }']);
    expect(result).toBe('inject-1');
    expect(evalledExpr).toContain('createElement');
    expect(evalledExpr).toContain('data-cdp-inject');
    expect(evalledExpr).toContain('body { color: red }');
  });

  it('--css-file should inject a link element', async () => {
    let evalledExpr = '';
    const cdp = createMockCDP({
      'Runtime.evaluate': (params) => {
        evalledExpr = params.expression;
        return { result: { value: 'inject-1' } };
      },
    });
    const result = await injectStr(cdp, 'sid1', ['--css-file', 'https://cdn.example.com/style.css']);
    expect(result).toBe('inject-1');
    expect(evalledExpr).toContain('link');
    expect(evalledExpr).toContain('stylesheet');
    expect(evalledExpr).toContain('https://cdn.example.com/style.css');
  });

  it('--js-file should inject a script element with onload', async () => {
    let evalledExpr = '';
    const cdp = createMockCDP({
      'Runtime.evaluate': (params) => {
        evalledExpr = params.expression;
        return { result: { value: 'inject-2' } };
      },
    });
    const result = await injectStr(cdp, 'sid1', ['--js-file', 'https://cdn.example.com/lib.js']);
    expect(result).toBe('inject-2');
    expect(evalledExpr).toContain('script');
    expect(evalledExpr).toContain('.src');
    expect(evalledExpr).toContain('onload');
  });

  it('--remove should remove elements with data-cdp-inject', async () => {
    let evalledExpr = '';
    const cdp = createMockCDP({
      'Runtime.evaluate': (params) => {
        evalledExpr = params.expression;
        return { result: { value: '3 element(s) removed' } };
      },
    });
    const result = await injectStr(cdp, 'sid1', ['--remove']);
    expect(result).toBe('3 element(s) removed');
    expect(evalledExpr).toContain('[data-cdp-inject]');
  });

  it('--remove with specific id should target that injection', async () => {
    let evalledExpr = '';
    const cdp = createMockCDP({
      'Runtime.evaluate': (params) => {
        evalledExpr = params.expression;
        return { result: { value: '1 element(s) removed' } };
      },
    });
    const result = await injectStr(cdp, 'sid1', ['--remove', 'inject-2']);
    expect(result).toBe('1 element(s) removed');
    expect(evalledExpr).toContain('inject-2');
  });

  it('--css with empty content should throw', async () => {
    const cdp = createMockCDP({});
    await expect(injectStr(cdp, 'sid1', ['--css'])).rejects.toThrow(/CSS text required/);
  });

  it('--css-file with no URL should throw', async () => {
    const cdp = createMockCDP({});
    await expect(injectStr(cdp, 'sid1', ['--css-file'])).rejects.toThrow(/URL required/);
  });

  it('--js-file with no URL should throw', async () => {
    const cdp = createMockCDP({});
    await expect(injectStr(cdp, 'sid1', ['--js-file'])).rejects.toThrow(/URL required/);
  });

  it('unknown flag should throw with usage', async () => {
    const cdp = createMockCDP({});
    await expect(injectStr(cdp, 'sid1', ['--html', '<div>'])).rejects.toThrow(/--css.*--css-file.*--js-file.*--remove/);
  });

  it('--css-file should reject non-http URLs', async () => {
    const cdp = createMockCDP({});
    await expect(injectStr(cdp, 'sid1', ['--css-file', 'data:text/css,body{color:red}'])).rejects.toThrow(/Only http/);
    await expect(injectStr(cdp, 'sid1', ['--css-file', 'file:///etc/passwd'])).rejects.toThrow(/Only http/);
  });

  it('--js-file should reject non-http URLs', async () => {
    const cdp = createMockCDP({});
    await expect(injectStr(cdp, 'sid1', ['--js-file', 'data:text/javascript,alert(1)'])).rejects.toThrow(/Only http/);
    await expect(injectStr(cdp, 'sid1', ['--js-file', 'javascript:void(0)'])).rejects.toThrow(/Only http|Invalid URL/);
  });

  it('--css-file should reject cloud metadata URLs', async () => {
    const cdp = createMockCDP({});
    await expect(injectStr(cdp, 'sid1', ['--css-file', 'http://169.254.169.254/latest/'])).rejects.toThrow(/metadata/i);
  });
});

// =========================================================================
// cascadeStr — CSS origin tracing
// =========================================================================

describe('cascadeStr', () => {
  function makeCascadeCDP(matchedRules = [], computedStyle = [], inherited = []) {
    return createMockCDP({
      'DOM.getDocument': () => ({ root: { nodeId: 1 } }),
      'DOM.querySelector': () => ({ nodeId: 10 }),
      'DOM.pushNodesByBackendIdsToFrontend': () => ({ nodeIds: [10] }),
      'CSS.getStyleSheetText': ({ styleSheetId }) => ({ text: `/* ${styleSheetId} */` }),
      'CSS.getMatchedStylesForNode': () => ({
        matchedCSSRules: matchedRules,
        inherited,
      }),
      'CSS.getComputedStyleForNode': () => ({ computedStyle }),
    });
  }

  it('should show winning and overridden rules for a property', async () => {
    const cdp = makeCascadeCDP(
      [
        {
          rule: {
            selectorList: { text: '.btn-primary' },
            origin: 'regular',
            style: {
              styleSheetId: 'components.css',
              range: { startLine: 141 },
              cssProperties: [{ name: 'background-color', value: '#2563eb' }],
            },
          },
        },
        {
          rule: {
            selectorList: { text: 'button' },
            origin: 'regular',
            style: {
              styleSheetId: 'base.css',
              range: { startLine: 27 },
              cssProperties: [{ name: 'background-color', value: '#e5e7eb' }],
            },
          },
        },
      ],
      [{ name: 'background-color', value: '#2563eb' }],
    );
    const result = await cascadeStr(cdp, 'sid1', '.btn', 'background-color', new Map());
    expect(result).toContain('background-color: #2563eb');
    expect(result).toContain('✓ .btn-primary');
    expect(result).toContain('✗ button');
    expect(result).toContain('[overridden]');
    expect(result).toContain('components.css:142');
    expect(result).toContain('base.css:28');
  });

  it('returns structured JSON with winning CSS source for agents', async () => {
    const cdp = makeCascadeCDP(
      [
        {
          rule: {
            selectorList: { text: '.btn-primary' },
            origin: 'regular',
            style: {
              styleSheetId: 'components.css',
              range: { startLine: 141 },
              cssProperties: [{ name: 'background-color', value: '#2563eb' }],
            },
          },
        },
        {
          rule: {
            selectorList: { text: 'button' },
            origin: 'regular',
            style: {
              styleSheetId: 'base.css',
              range: { startLine: 27 },
              cssProperties: [{ name: 'background-color', value: '#e5e7eb' }],
            },
          },
        },
      ],
      [{ name: 'background-color', value: '#2563eb' }],
    );
    const result = await cascadeStr(cdp, 'sid1', '.btn', 'background-color', new Map(), null, { format: 'json' });
    const model = JSON.parse(result);

    expect(model).toMatchObject({
      schema: 'chrome-cdp-ex.cascade.v1',
      input: { selector: '.btn', property: 'background-color' },
      propertyCount: 1,
      properties: [
        {
          name: 'background-color',
          computedValue: '#2563eb',
          winner: {
            selector: '.btn-primary',
            value: '#2563eb',
            source: 'components.css:142',
          },
          rules: [
            {
              selector: '.btn-primary',
              value: '#2563eb',
              source: 'components.css:142',
              winner: true,
              overridden: false,
            },
            {
              selector: 'button',
              value: '#e5e7eb',
              source: 'base.css:28',
              winner: false,
              overridden: true,
            },
          ],
        },
      ],
    });
    expect(model.editTarget).toMatchObject({
      property: 'background-color',
      selector: '.btn-primary',
      source: 'components.css:142',
    });
  });

  it('should show inherited properties', async () => {
    const cdp = makeCascadeCDP(
      [],
      [{ name: 'color', value: 'rgb(31, 41, 55)' }],
      [
        {
          matchedCSSRules: [{
            rule: {
              selectorList: { text: 'body' },
              origin: 'regular',
              style: {
                styleSheetId: 'base.css',
                range: { startLine: 11 },
                cssProperties: [{ name: 'color', value: '#1f2937' }],
              },
            },
          }],
        },
      ],
    );
    const result = await cascadeStr(cdp, 'sid1', '.text', null, new Map());
    expect(result).toContain('Inherited:');
    expect(result).toContain('color: #1f2937');
    expect(result).toContain('body');
    expect(result).toContain('base.css:12');
  });

  it('should return descriptive message when no rules match', async () => {
    const cdp = makeCascadeCDP([], []);
    const result = await cascadeStr(cdp, 'sid1', '.empty', null, new Map());
    expect(result).toContain('No matching CSS rules');
  });

  it('should filter to a single property', async () => {
    const cdp = makeCascadeCDP(
      [
        {
          rule: {
            selectorList: { text: '.box' },
            origin: 'regular',
            style: {
              styleSheetId: 'style.css',
              range: { startLine: 0 },
              cssProperties: [
                { name: 'color', value: 'red' },
                { name: 'margin', value: '10px' },
              ],
            },
          },
        },
      ],
      [
        { name: 'color', value: 'red' },
        { name: 'margin', value: '10px' },
      ],
    );
    const result = await cascadeStr(cdp, 'sid1', '.box', 'color', new Map());
    expect(result).toContain('color: red');
    expect(result).not.toContain('margin');
  });

  it('should resolve @ref to nodeId', async () => {
    const refMap = new Map([[3, 42]]);
    const cdp = makeCascadeCDP([], [{ name: 'display', value: 'block' }]);
    const result = await cascadeStr(cdp, 'sid1', '@3', null, refMap);
    // Should not throw — ref resolved successfully
    expect(typeof result).toBe('string');
  });

  it('should throw on unknown @ref', async () => {
    const cdp = makeCascadeCDP([], []);
    await expect(cascadeStr(cdp, 'sid1', '@99', null, new Map())).rejects.toThrow(/Unknown ref/);
  });

  it('should throw when no selector provided', async () => {
    const cdp = makeCascadeCDP([], []);
    await expect(cascadeStr(cdp, 'sid1', undefined, null, new Map())).rejects.toThrow(/selector.*required/i);
  });

  it('should show computed value when property has no explicit rule', async () => {
    const cdp = makeCascadeCDP(
      [],
      [{ name: 'display', value: 'flex' }],
    );
    const result = await cascadeStr(cdp, 'sid1', '.box', 'display', new Map());
    expect(result).toContain('display: flex');
    expect(result).toContain('no explicit rule');
  });

  it('should report inline styles with highest priority', async () => {
    const cdp = createMockCDP({
      'DOM.getDocument': () => ({ root: { nodeId: 1 } }),
      'DOM.querySelector': () => ({ nodeId: 10 }),
      'CSS.getStyleSheetText': ({ styleSheetId }) => ({ text: `/* ${styleSheetId} */` }),
      'CSS.getMatchedStylesForNode': () => ({
        matchedCSSRules: [{
          rule: {
            selectorList: { text: '.box' },
            origin: 'regular',
            style: {
              styleSheetId: 'style.css',
              range: { startLine: 9 },
              cssProperties: [{ name: 'color', value: 'blue' }],
            },
          },
        }],
        inlineStyle: {
          cssProperties: [{ name: 'color', value: 'red' }],
        },
        inherited: [],
      }),
      'CSS.getComputedStyleForNode': () => ({
        computedStyle: [{ name: 'color', value: 'red' }],
      }),
    });
    const result = await cascadeStr(cdp, 'sid1', '.box', 'color', new Map());
    expect(result).toContain('color: red');
    expect(result).toContain('✓ [inline]');
    expect(result).toContain('inline style attribute');
    expect(result).toContain('✗ .box');
    expect(result).toContain('[overridden]');
  });

  it('marks the last matching rule as winner when specified values do not equal computed', async () => {
    const cdp = makeCascadeCDP(
      [
        {
          rule: {
            selectorList: { text: 'h1' },
            origin: 'user-agent',
            style: {
              styleSheetId: 'user-agent.css',
              range: { startLine: 0 },
              cssProperties: [
                { name: 'font-size', value: '2em' },
                { name: 'font-weight', value: 'bold' },
              ],
            },
          },
        },
        {
          rule: {
            selectorList: { text: 'h1' },
            origin: 'regular',
            style: {
              styleSheetId: 'example.css',
              range: { startLine: 3 },
              cssProperties: [{ name: 'font-size', value: '1.5em' }],
            },
          },
        },
      ],
      [
        { name: 'font-size', value: '24px' },
        { name: 'font-weight', value: '700' },
      ],
    );
    const fontSize = JSON.parse(await cascadeStr(cdp, 'sid1', 'h1', 'font-size', new Map(), null, { format: 'json' }));
    expect(fontSize.properties[0]).toMatchObject({
      computedValue: '24px',
      winner: { selector: 'h1', value: '1.5em', origin: 'regular' },
    });
    expect(fontSize.properties[0].rules.filter(rule => rule.winner)).toHaveLength(1);
    expect(fontSize.properties[0].rules[0].overridden).toBe(true);
    expect(fontSize.properties[0].rules[1].winner).toBe(true);

    const fontWeight = JSON.parse(await cascadeStr(cdp, 'sid1', 'h1', 'font-weight', new Map(), null, { format: 'json' }));
    expect(fontWeight.properties[0]).toMatchObject({
      computedValue: '700',
      winner: { value: 'bold' },
    });
    expect(fontWeight.properties[0].rules[0].winner).toBe(true);
  });

  it('selects a var() winner by cascade order when computed px does not match specified', async () => {
    const cdp = makeCascadeCDP(
      [
        {
          rule: {
            selectorList: { text: '.text-lg' },
            origin: 'regular',
            style: {
              styleSheetId: 'utilities.css',
              range: { startLine: 10 },
              cssProperties: [{ name: 'font-size', value: 'var(--text-lg)' }],
            },
          },
        },
        {
          rule: {
            selectorList: { text: '.md\\:text-xl' },
            origin: 'regular',
            style: {
              styleSheetId: 'utilities.css',
              range: { startLine: 40 },
              cssProperties: [{ name: 'font-size', value: 'var(--text-xl)' }],
            },
          },
        },
      ],
      [{ name: 'font-size', value: '20px' }],
    );
    const result = JSON.parse(await cascadeStr(cdp, 'sid1', 'h1', 'font-size', new Map(), null, { format: 'json' }));
    expect(result.properties[0].winner).toMatchObject({
      selector: '.md\\:text-xl',
      value: 'var(--text-xl)',
    });
    expect(result.properties[0].rules[0]).toMatchObject({ winner: false, overridden: true });
    expect(result.properties[0].rules[1]).toMatchObject({ winner: true, overridden: false });
    expect(await cascadeStr(cdp, 'sid1', 'h1', 'font-size', new Map())).toContain('✓ .md\\:text-xl');
  });

  it('should enable DOM/CSS and request document before first style lookup', async () => {
    const cdp = makeCascadeCDP(
      [{
        rule: { selectorList: { text: '.box' }, origin: 'regular', style: {
          styleSheetId: 'style.css', range: { startLine: 0 }, cssProperties: [{ name: 'display', value: 'block' }],
        } },
      }],
      [{ name: 'display', value: 'block' }],
    );
    await cascadeStr(cdp, 'sid1', '.box', 'display', new Map());
    expect(cdp.calls.map(c => c.method)).toEqual(expect.arrayContaining(['DOM.enable', 'CSS.enable', 'DOM.getDocument']));
    expect(cdp.calls.findIndex(c => c.method === 'DOM.getDocument')).toBeLessThan(
      cdp.calls.findIndex(c => c.method === 'CSS.getMatchedStylesForNode')
    );
  });

  it('should use sourceURL from stylesheet text when available', async () => {
    const cdp = createMockCDP({
      'DOM.getDocument': () => ({ root: { nodeId: 1 } }),
      'DOM.querySelector': () => ({ nodeId: 10 }),
      'CSS.getStyleSheetText': () => ({ text: '.box{color:red}\n/*# sourceURL=/src/Button.module.css */' }),
      'CSS.getMatchedStylesForNode': () => ({
        matchedCSSRules: [{
          rule: { selectorList: { text: '.box' }, origin: 'regular', style: {
            styleSheetId: 'style-sheet-123', range: { startLine: 4 }, cssProperties: [{ name: 'color', value: 'red' }],
          } },
        }],
        inherited: [],
      }),
      'CSS.getComputedStyleForNode': () => ({ computedStyle: [{ name: 'color', value: 'red' }] }),
    });
    const result = await cascadeStr(cdp, 'sid1', '.box', 'color', new Map());
    expect(result).toContain('/src/Button.module.css:5');
    expect(result).not.toContain('style-sheet-123:5');
  });

  // Regression: dogfood report showed identical winner / overridden lines
  // appearing twice when CDP returned the same matchedCSSRule twice.
  it('should dedupe identical matchedCSSRules entries before formatting', async () => {
    const dupRule = {
      rule: {
        selectorList: { text: '.primary' },
        origin: 'regular',
        style: {
          styleSheetId: 'base.css',
          range: { startLine: 4 },
          cssProperties: [{ name: 'background-color', value: 'rgb(37, 99, 235)' }],
        },
      },
    };
    const cdp = makeCascadeCDP(
      [dupRule, dupRule],
      [{ name: 'background-color', value: 'rgb(37, 99, 235)' }],
    );
    const result = await cascadeStr(cdp, 'sid1', '.btn', 'background-color', new Map());
    // The .primary rule should appear exactly once, not twice.
    const matches = result.match(/\.primary \{ background-color: rgb\(37, 99, 235\) \}/g) || [];
    expect(matches).toHaveLength(1);
  });

  // Regression: semantically identical CSS values may differ only by formatting
  // (e.g. authored rgb(37,99,235) vs CDP-normalized rgb(37, 99, 235)).
  it('should dedupe and mark winner using normalized CSS values', async () => {
    const cdp = makeCascadeCDP(
      [{
        rule: {
          selectorList: { text: '.primary' },
          origin: 'regular',
          style: {
            styleSheetId: 'base.css',
            range: { startLine: 4 },
            cssProperties: [
              { name: 'background-color', value: 'rgb(37,99,235)' },
              { name: 'background-color', value: 'rgb(37, 99, 235)' },
            ],
          },
        },
      }],
      [{ name: 'background-color', value: 'rgb(37, 99, 235)' }],
    );
    const result = await cascadeStr(cdp, 'sid1', '.btn', 'background-color', new Map());
    const matches = result.match(/\.primary \{ background-color:/g) || [];
    expect(matches).toHaveLength(1);
    expect(result).toContain('✓ .primary');
    expect(result).not.toContain('✗ .primary');
  });

  // Regression: same property listed twice within a single rule's
  // cssProperties (e.g. fallback declarations) should also dedupe.
  it('should dedupe duplicate cssProperties within a single rule', async () => {
    const cdp = makeCascadeCDP(
      [{
        rule: {
          selectorList: { text: '.box' },
          origin: 'regular',
          style: {
            styleSheetId: 'style.css',
            range: { startLine: 0 },
            cssProperties: [
              { name: 'color', value: 'rgb(255, 255, 255)' },
              { name: 'color', value: 'rgb(255, 255, 255)' },
            ],
          },
        },
      }],
      [{ name: 'color', value: 'rgb(255, 255, 255)' }],
    );
    const result = await cascadeStr(cdp, 'sid1', '.box', 'color', new Map());
    const matches = result.match(/\.box \{ color: rgb\(255, 255, 255\) \}/g) || [];
    expect(matches).toHaveLength(1);
  });

  // Regression: duplicate inherited rules (same selector + value + source)
  // should dedupe in the Inherited: section as well.
  it('should dedupe identical inherited rule lines', async () => {
    const dupInheritedRule = {
      rule: {
        selectorList: { text: 'body' },
        origin: 'regular',
        style: {
          styleSheetId: 'base.css',
          range: { startLine: 11 },
          cssProperties: [{ name: 'color', value: '#1f2937' }],
        },
      },
    };
    const cdp = makeCascadeCDP(
      [],
      [{ name: 'color', value: '#1f2937' }],
      [{ matchedCSSRules: [dupInheritedRule, dupInheritedRule] }],
    );
    const result = await cascadeStr(cdp, 'sid1', '.text', null, new Map());
    expect(result).toContain('Inherited:');
    const inheritedSection = result.split('Inherited:')[1] || '';
    const matches = inheritedSection.match(/color: #1f2937/g) || [];
    expect(matches).toHaveLength(1);
  });
});

// =========================================================================
// mapStyleSource — improved cascade source mapping (Vite / CSS Modules)
// =========================================================================

describe('stripVitePathQuery', () => {
  it('returns input unchanged when no query', () => {
    expect(stripVitePathQuery('/src/Foo.module.css')).toBe('/src/Foo.module.css');
  });
  it('strips Vite vue/style query suffix', () => {
    expect(stripVitePathQuery('/src/App.vue?vue&type=style&index=0&scoped=true&lang.css'))
      .toBe('/src/App.vue');
  });
  it('strips ?direct and ?used suffixes', () => {
    expect(stripVitePathQuery('/src/Foo.module.css?direct')).toBe('/src/Foo.module.css');
    expect(stripVitePathQuery('/src/Foo.module.css?used')).toBe('/src/Foo.module.css');
  });
  it('handles empty input', () => {
    expect(stripVitePathQuery('')).toBe('');
  });
});

describe('decodeVLQ', () => {
  it('decodes a single zero', () => {
    expect(decodeVLQ('A')).toEqual([0]);
  });
  it('decodes a known multi-segment value (AAAA)', () => {
    // AAAA = 4 zero values — generated col, source idx, orig line, orig col deltas
    expect(decodeVLQ('AAAA')).toEqual([0, 0, 0, 0]);
  });
  it('handles continuation bits across multiple base64 chars', () => {
    // 'CAAA' encodes [1,0,0,0] (1<<1 = 2 → negate flag 0 → 1)
    const vals = decodeVLQ('CAAA');
    expect(vals).toEqual([1, 0, 0, 0]);
  });
});

describe('mapLineToSource', () => {
  it('returns null for empty mappings', () => {
    expect(mapLineToSource('', 0)).toBe(null);
  });
  it('returns null when genLine0 is out of range', () => {
    expect(mapLineToSource('AAAA', 5)).toBe(null);
  });
  it('returns mapping with srcIdx=0 origLine=0 for single AAAA segment', () => {
    const m = mapLineToSource('AAAA', 0);
    expect(m).not.toBe(null);
    expect(m.srcIdx).toBe(0);
    expect(m.origLine).toBe(0);
  });
});

describe('mapStyleSource', () => {
  it('falls back to sheetId:line when no sourceURL or sourceMappingURL', () => {
    expect(mapStyleSource('.box{color:red}', 'sheet-1', 4)).toBe('sheet-1:5');
  });

  it('uses sourceURL when present and strips Vite query suffix', () => {
    const sheet = '.box{color:red}\n/*# sourceURL=/src/Foo.module.css?vue&type=style&lang.css */';
    expect(mapStyleSource(sheet, 'sheet-1', 4)).toBe('/src/Foo.module.css:5');
  });

  it('uses external sourceMappingURL (.css.map → .css) when no sourceURL', () => {
    const sheet = '.box{color:red}\n/*# sourceMappingURL=/src/Foo.module.css.map */';
    expect(mapStyleSource(sheet, 'sheet-1', 0)).toBe('/src/Foo.module.css:1');
  });

  it('decodes inline base64 sourcemap and uses sources[0] + mapped origLine', () => {
    const map = JSON.stringify({
      version: 3,
      sources: ['/src/Button.module.css'],
      mappings: 'AAAA',
    });
    const b64 = Buffer.from(map).toString('base64');
    const sheet = `.btn{color:red}\n/*# sourceMappingURL=data:application/json;base64,${b64} */`;
    expect(mapStyleSource(sheet, 'sheet-1', 0)).toBe('/src/Button.module.css:1');
  });

  it('strips Vite query from inline source map sources[0]', () => {
    const map = JSON.stringify({
      version: 3,
      sources: ['/src/App.vue?vue&type=style&index=0'],
      mappings: 'AAAA',
    });
    const b64 = Buffer.from(map).toString('base64');
    const sheet = `.x{color:red}\n/*# sourceMappingURL=data:application/json;base64,${b64} */`;
    expect(mapStyleSource(sheet, 'sheet-1', 0)).toBe('/src/App.vue:1');
  });

  it('respects sourceRoot when joining sources path', () => {
    const map = JSON.stringify({
      version: 3,
      sourceRoot: '/project',
      sources: ['src/styles/main.css'],
      mappings: 'AAAA',
    });
    const b64 = Buffer.from(map).toString('base64');
    const sheet = `*{}\n/*# sourceMappingURL=data:application/json;base64,${b64} */`;
    expect(mapStyleSource(sheet, 'sheet-1', 0)).toBe('/project/src/styles/main.css:1');
  });

  it('degrades to sheetId:line when base64 sourcemap is malformed', () => {
    const sheet = '.x{}\n/*# sourceMappingURL=data:application/json;base64,!!!not-base64-or-json!!! */';
    // Either succeeds with our regex matching or falls back gracefully — must
    // not throw, and must produce some line reference for the rule.
    const out = mapStyleSource(sheet, 'sheet-99', 3);
    expect(typeof out).toBe('string');
    expect(out).toContain(':4');
  });
});

// =========================================================================
// cascadeStr — integration with mapStyleSource (Vite / CSS Modules)
// =========================================================================

describe('cascadeStr Vite/CSS-modules integration', () => {
  function mkCdp(sheetText) {
    return {
      calls: [],
      send(method, params = {}) {
        this.calls.push({ method, params });
        if (method === 'DOM.getDocument') return Promise.resolve({ root: { nodeId: 1 } });
        if (method === 'DOM.querySelector') return Promise.resolve({ nodeId: 10 });
        if (method === 'CSS.getStyleSheetText') return Promise.resolve({ text: sheetText });
        if (method === 'CSS.getMatchedStylesForNode') return Promise.resolve({
          matchedCSSRules: [{
            rule: {
              selectorList: { text: '.btn' },
              origin: 'regular',
              style: {
                styleSheetId: 'opaque-sheet-id-xyz',
                range: { startLine: 0 },
                cssProperties: [{ name: 'color', value: 'rgb(0, 128, 0)' }],
              },
            },
          }],
          inherited: [],
        });
        if (method === 'CSS.getComputedStyleForNode') return Promise.resolve({
          computedStyle: [{ name: 'color', value: 'rgb(0, 128, 0)' }],
        });
        return Promise.resolve({});
      },
      onEvent() { return () => {}; },
    };
  }

  it('shows a CSS module path (with Vite query stripped) instead of opaque sheet id', async () => {
    const sheet = '.btn{color:rgb(0,128,0)}\n/*# sourceURL=/src/Button.module.css?vue&type=style&lang.css */';
    const cdp = mkCdp(sheet);
    const out = await cascadeStr(cdp, 'sid', '.btn', 'color', new Map());
    expect(out).toContain('/src/Button.module.css:1');
    expect(out).not.toContain('opaque-sheet-id-xyz');
  });

  it('uses inline base64 sourcemap to resolve original module path', async () => {
    const map = JSON.stringify({
      version: 3,
      sources: ['/src/components/Card.module.css'],
      mappings: 'AAAA',
    });
    const b64 = Buffer.from(map).toString('base64');
    const sheet = `.btn{color:rgb(0,128,0)}\n/*# sourceMappingURL=data:application/json;base64,${b64} */`;
    const cdp = mkCdp(sheet);
    const out = await cascadeStr(cdp, 'sid', '.btn', 'color', new Map());
    expect(out).toContain('/src/components/Card.module.css:1');
    expect(out).not.toContain('opaque-sheet-id-xyz');
  });

  it('degrades to sheetId:line when sheet text is empty (safe fallback)', async () => {
    const cdp = mkCdp('');
    const out = await cascadeStr(cdp, 'sid', '.btn', 'color', new Map());
    expect(out).toContain('opaque-sheet-id-xyz:1');
  });
});
