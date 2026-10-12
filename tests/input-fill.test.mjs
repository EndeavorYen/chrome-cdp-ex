import { describe, it, expect } from 'vitest';
import { createMockCDP } from './mock-cdp.mjs';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
const { fillStr, fillReactStr } = T;

// =========================================================================
// CDP mock helper — lightweight fake for testing command functions
// =========================================================================


// =========================================================================
// fillStr (with CDP mock)
// =========================================================================

describe('fillStr', () => {
  it('should clear and fill element by CSS selector', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': (params) => {
        const expr = String(params.expression || '');
        if (expr.includes('cdpFillLiveValue')) {
          return { result: { value: { ok: true, tag: 'INPUT', value: 'user@test.com', textContent: '' } } };
        }
        return { result: { value: { ok: true, tag: 'INPUT' } } };
      },
      'Input.insertText': () => ({}),
    });
    const result = await fillStr(cdp, 'sid1', '#email', 'user@test.com', new Map());
    expect(result).toContain('Filled');
    expect(result).toContain('user@test.com');
  });

  it('should fill element by @ref', async () => {
    const refMap = new Map([[1, 201]]);
    const cdp = createMockCDP({
      'DOM.resolveNode': () => ({ object: { objectId: 'obj-1' } }),
      'Runtime.callFunctionOn': (params) => {
        if (params.functionDeclaration?.includes('cdpFillLiveValue')) {
          return { result: { value: { ok: true, tag: 'INPUT', value: 'hello', textContent: 'hello' } } };
        }
        return { result: { value: { ok: true, fillable: true, tag: 'INPUT' } } };
      },
      'Input.insertText': () => ({}),
    });
    const result = await fillStr(cdp, 'sid1', '@1', 'hello', refMap);
    expect(result).toContain('Filled @1');
    expect(result).toContain('hello');
  });

  it('should truncate long text in result message', async () => {
    const longText = 'A'.repeat(100);
    const cdp = createMockCDP({
      'Runtime.evaluate': (params) => {
        const expr = String(params.expression || '');
        if (expr.includes('cdpFillLiveValue')) {
          return { result: { value: { ok: true, tag: 'TEXTAREA', value: longText, textContent: longText } } };
        }
        return { result: { value: { ok: true, tag: 'TEXTAREA' } } };
      },
      'Input.insertText': () => ({}),
    });
    const result = await fillStr(cdp, 'sid1', 'textarea', longText, new Map());
    expect(result).toContain('...');
    expect(result.length).toBeLessThan(longText.length);
  });

  it('should throw when selector missing', async () => {
    const cdp = createMockCDP({});
    await expect(fillStr(cdp, 'sid1', undefined, 'text', new Map()))
      .rejects.toThrow(/selector.*required/i);
  });

  it('should throw when text missing', async () => {
    const cdp = createMockCDP({});
    await expect(fillStr(cdp, 'sid1', '#input', null, new Map()))
      .rejects.toThrow(/Text required/);
  });
});

describe('fill --react', () => {
  it('uses the native value setter and input/change events for CSS selectors', async () => {
    const cdp = createMockCDP({
      'DOM.enable': () => ({}),
      'DOM.getDocument': () => ({ root: { nodeId: 1 } }),
      'DOM.querySelector': (params) => {
        expect(params.selector).toBe('#name');
        return { nodeId: 42 };
      },
      'DOM.resolveNode': () => ({ object: { objectId: 'obj-input' } }),
      'Runtime.callFunctionOn': (params) => {
        expect(params.objectId).toBe('obj-input');
        if (!params.arguments) {
          return { result: { value: { ok: true, fillable: true, tag: 'INPUT' } } };
        }
        expect(params.arguments[0].value).toBe('戰鬥勝利');
        expect(params.functionDeclaration).toContain('Object.getOwnPropertyDescriptor');
        expect(params.functionDeclaration).toContain("new InputEvent('input'");
        expect(params.functionDeclaration).toContain("new Event('change'");
        return { result: { value: { tag: 'INPUT', value: '戰鬥勝利' } } };
      },
    });
    const out = await fillReactStr(cdp, 'sid1', '#name', '戰鬥勝利', new Map());
    expect(out).toContain('React-filled <INPUT>');
    expect(out).toContain('戰鬥勝利');
  });

  it('keeps normal fill using Input.insertText', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': (params) => {
        const expr = String(params.expression || '');
        if (expr.includes('cdpFillLiveValue')) {
          return { result: { value: { ok: true, tag: 'INPUT', value: 'plain', textContent: '' } } };
        }
        return { result: { value: { ok: true, tag: 'INPUT' } } };
      },
      'Input.insertText': () => ({}),
    });
    await fillStr(cdp, 'sid1', '#name', 'plain', new Map());
    expect(cdp.calls.some(c => c.method === 'Input.insertText')).toBe(true);
    expect(cdp.calls.some(c => c.method === 'Runtime.callFunctionOn')).toBe(false);
  });
});
