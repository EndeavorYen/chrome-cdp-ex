import { describe, it, expect } from 'vitest';
import { createMockCDP } from './mock-cdp.mjs';
import * as input from '../skills/chrome-cdp-ex/scripts/lib/cdp-input.mjs';

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

describe('#748 fill keeps at most maxlength characters', () => {

  // A field with `maxlength`: Input.insertText keeps maxLength code units, as Chrome does for typed
  // text; the native value setter (the fill --react path and the fallback) writes the whole value.
  function maxLengthField(maxLength, { ref = false, tag = 'INPUT', type = 'text' } = {}) {
    const field = { value: '', setterValues: [] };
    const live = () => ({ result: { value: { ok: true, cdpFillLiveValue: true, tag, type, value: field.value, textContent: '', maxLength } } });
    const probe = () => ({ result: { value: { ok: true, fillable: true, tag, type, before: field.value, maxLength } } });
    const handlers = {
      'DOM.enable': () => ({}),
      'DOM.getDocument': () => ({ root: { nodeId: 1 } }),
      'DOM.querySelector': () => ({ nodeId: 42 }),
      'DOM.resolveNode': () => ({ object: { objectId: 'obj-field' } }),
      'Input.insertText': ({ text }) => {
        field.value = (field.value + text).slice(0, maxLength);
        return {};
      },
      'Runtime.callFunctionOn': (params) => {
        const fn = String(params.functionDeclaration || '');
        if (fn.includes('cdpFillLiveValue')) return live();
        if (params.arguments) {
          field.setterValues.push(params.arguments[0].value);
          field.value = params.arguments[0].value;
          return { result: { value: { tag, value: field.value } } };
        }
        return probe();
      },
    };
    if (!ref) {
      handlers['Runtime.evaluate'] = (params) => {
        const expr = String(params.expression || '');
        if (expr.includes('cdpFillLiveValue')) return live();
        return probe();
      };
    }
    return { field, cdp: createMockCDP(handlers) };
  }

  it('keeps maxlength characters by selector and says how many it kept', async () => {
    const { field, cdp } = maxLengthField(5);
    const out = await fillStr(cdp, 'sid1', '#name', 'abcdefghij', new Map());
    expect(field.value).toBe('abcde');
    expect(field.setterValues).not.toContain('abcdefghij');
    expect(out).toBe('Filled <INPUT> with "abcde" (maxlength 5: kept 5 of 10 characters)');
  });

  it('keeps maxlength characters with --react', async () => {
    const { field, cdp } = maxLengthField(3, { tag: 'TEXTAREA' });
    const out = await fillStr(cdp, 'sid1', '#note', 'abcdef', new Map(), null, { react: true });
    expect(field.setterValues).toEqual(['abc']);
    expect(field.value).toBe('abc');
    expect(out).toMatch(/^React-filled <TEXTAREA> with "abc".* \(maxlength 3: kept 3 of 6 characters\)$/);
  });

  it('keeps maxlength characters by @ref', async () => {
    const { field, cdp } = maxLengthField(5, { ref: true });
    const out = await fillStr(cdp, 'sid1', '@1', 'abcdefghij', new Map([[1, 201]]), { generation: 1 });
    expect(field.value).toBe('abcde');
    expect(out).toBe('Filled @1 with "abcde" (maxlength 5: kept 5 of 10 characters)');
  });

  it('records the limit as numbers for the JSON receipt, and hides a password length', async () => {
    const plain = maxLengthField(5);
    const valueState = {};
    await fillStr(plain.cdp, 'sid1', '#name', 'abcdefghij', new Map(), null, { valueState });
    expect(valueState.maxLength).toEqual({ limit: 5, kept: 5, requested: 10 });

    const secret = maxLengthField(4, { type: 'password' });
    const passwordState = {};
    const out = await fillStr(secret.cdp, 'sid1', '#pw', 'hunter22', new Map(), null, { valueState: passwordState });
    expect(out).toBe('Filled <INPUT> with "<redacted>" (maxlength 4: kept 4 characters)');
    expect(passwordState.maxLength).toEqual({ limit: 4, kept: 4 });
  });

  it('reads maxlength only where the browser enforces it', () => {
    const limitOf = new Function('el', `return ${input.fillMaxLengthExpression('el')};`);
    expect(limitOf({ tagName: 'INPUT', type: 'text', maxLength: 5 })).toBe(5);
    expect(limitOf({ tagName: 'input', type: 'email', maxLength: 5 })).toBe(5);
    expect(limitOf({ tagName: 'TEXTAREA', type: 'textarea', maxLength: 3 })).toBe(3);
    expect(limitOf({ tagName: 'INPUT', type: 'text', maxLength: -1 })).toBeNull();
    for (const type of ['number', 'date', 'time', 'range', 'color']) {
      expect(limitOf({ tagName: 'INPUT', type, maxLength: 2 }), type).toBeNull();
    }
    expect(limitOf({ tagName: 'DIV', isContentEditable: true })).toBeNull();
    expect(limitOf(null)).toBeNull();
  });

  it('adds no note for a value within maxlength', async () => {
    const { field, cdp } = maxLengthField(5);
    const out = await fillStr(cdp, 'sid1', '#name', 'abc', new Map());
    expect(field.value).toBe('abc');
    expect(out).toBe('Filled <INPUT> with "abc"');
  });

  it('cuts by UTF-16 code units and never splits a surrogate pair', () => {
    const { keepWithinMaxLength } = input;
    expect(keepWithinMaxLength('abcdef', 3)).toBe('abc');
    expect(keepWithinMaxLength('ab😀c', 3)).toBe('ab');
    expect(keepWithinMaxLength('ab😀c', 4)).toBe('ab😀');
    expect(keepWithinMaxLength('abc', null)).toBe('abc');
    expect(keepWithinMaxLength('abc', 0)).toBe('');
  });
});
