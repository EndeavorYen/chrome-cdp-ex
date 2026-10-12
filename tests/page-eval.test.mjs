import { describe, it, expect } from 'vitest';
import { createMockCDP } from './mock-cdp.mjs';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
const { evalStr, evalFireAndForgetStr, parseEvalArgs, callStr } = T;

// =========================================================================
// CDP mock helper — lightweight fake for testing command functions
// =========================================================================


// =========================================================================
// evalStr (with CDP mock)
// =========================================================================

describe('evalStr', () => {
  it('should return string value from Runtime.evaluate', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { value: 'hello' } }),
    });
    const result = await evalStr(cdp, 'sid1', '1+1');
    expect(result).toBe('hello');
  });

  it('should JSON.stringify object results', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { value: { a: 1, b: 2 } } }),
    });
    const result = await evalStr(cdp, 'sid1', 'obj');
    expect(JSON.parse(result)).toEqual({ a: 1, b: 2 });
  });

  it('should return empty string for undefined result', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { value: undefined } }),
    });
    expect(await evalStr(cdp, 'sid1', 'void 0')).toBe('');
  });

  it('should return "null" for null result (typeof null === "object")', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { value: null } }),
    });
    // typeof null === 'object', so it goes through JSON.stringify path
    expect(await evalStr(cdp, 'sid1', 'null')).toBe('null');
  });

  it('should throw on exceptionDetails', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({
        result: {},
        exceptionDetails: { text: 'ReferenceError: x is not defined' },
      }),
    });
    await expect(evalStr(cdp, 'sid1', 'x')).rejects.toThrow('ReferenceError');
  });

  it('should prefer exception.description when exceptionDetails.text is generic Uncaught', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({
        result: {},
        exceptionDetails: {
          text: 'Uncaught',
          exception: { description: 'TypeError: cannot read property' },
        },
      }),
    });
    await expect(evalStr(cdp, 'sid1', 'x.y')).rejects.toThrow('TypeError: cannot read property');
  });

  it('should fall back to exception.description when text is empty', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({
        result: {},
        exceptionDetails: {
          text: '',
          exception: { description: 'TypeError: cannot read property' },
        },
      }),
    });
    await expect(evalStr(cdp, 'sid1', 'x.y')).rejects.toThrow('TypeError');
  });

  it('should auto-wrap await expressions when autoWrap=true', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': (params) => {
        // Verify the expression was wrapped in async IIFE
        expect(params.expression).toContain('async');
        return { result: { value: 'done' } };
      },
    });
    await evalStr(cdp, 'sid1', 'await fetch("/api")', true);
  });

  it('should not wrap expressions without await even when autoWrap=true', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': (params) => {
        expect(params.expression).not.toContain('async');
        return { result: { value: '42' } };
      },
    });
    await evalStr(cdp, 'sid1', '1 + 1', true);
  });

  it('should wrap multi-statement await in block body', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': (params) => {
        // Multi-statement with semicolons → block body {…}
        expect(params.expression).toMatch(/\(async\(\)=>\{/);
        return { result: { value: 'ok' } };
      },
    });
    await evalStr(cdp, 'sid1', 'const r = await fetch("/api"); return r', true);
  });

  it('returns the final expression from multi-statement async eval input', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': (params) => {
        expect(params.expression).toBe('(async()=>{const value = await Promise.resolve(42); return (value);})()');
        return { result: { value: 42 } };
      },
    });

    await expect(evalStr(cdp, 'sid1', 'const value = await Promise.resolve(42); value', true)).resolves.toBe('42');
  });

  it('rejects an ambiguous multi-statement async eval instead of returning empty success', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => {
        throw new Error('Runtime.evaluate should not be called');
      },
    });

    await expect(evalStr(cdp, 'sid1', 'const value = await Promise.resolve(42); if (value) {}', true))
      .rejects.toThrow(/add an explicit return/i);
    expect(cdp.calls).toHaveLength(0);
  });

  it('does not treat return text inside strings or comments as an explicit return statement', () => {
    expect(T.wrapAwaitExpression('const msg = "return"; await Promise.resolve(1); msg', true))
      .toBe('(async()=>{const msg = "return"; await Promise.resolve(1); return (msg);})()');
    expect(T.wrapAwaitExpression('const value = await Promise.resolve(42); /* return */ value', true))
      .toBe('(async()=>{const value = await Promise.resolve(42); return (/* return */ value);})()');
  });

  it('returns the value of an async IIFE whose nested function has its own return (#396)', async () => {
    const run = (src) => new Function(`return ${T.wrapAwaitExpression(src, true)}`)();
    await expect(run('(async()=>{const r=await Promise.resolve(7);return r})()')).resolves.toBe(7);
    await expect(run('Promise.resolve("abc").then(async s=>{const t=await Promise.resolve(s.length);return t})'))
      .resolves.toBe(3);
    await expect(run('await (async()=>{await Promise.resolve();return "x"})()')).resolves.toBe('x');
    await expect(run('const f = async()=>{await Promise.resolve(); return 2}; f()')).resolves.toBe(2);
  });

  it('still treats a top-level return as the explicit result and keeps ambiguous input an error (#396)', async () => {
    expect(T.wrapAwaitExpression('const r = await Promise.resolve(1); return r', true))
      .toBe('(async()=>{const r = await Promise.resolve(1); return r})()');
    expect(() => T.wrapAwaitExpression('const value = await Promise.resolve(42); if (value) {}', true))
      .toThrow(/add an explicit return/i);
  });

  it('should pass awaitPromise and returnByValue to CDP', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': (params) => {
        expect(params.awaitPromise).toBe(true);
        expect(params.returnByValue).toBe(true);
        return { result: { value: 'ok' } };
      },
    });
    await evalStr(cdp, 'sid1', '"test"');
  });

  it('should pass sessionId to CDP', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { value: 'ok' } }),
    });
    await evalStr(cdp, 'session-xyz', '"test"');
    expect(cdp.calls[0].sessionId).toBe('session-xyz');
  });
});

// =========================================================================
// eval fire-and-forget / call / wait helpers
// =========================================================================

describe('eval fire-and-forget and call helpers', () => {
  it('dispatches eval without awaiting the returned promise', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': (params) => {
        expect(params.awaitPromise).toBe(false);
        expect(params.returnByValue).toBe(false);
        expect(params.expression).toContain('setInterval');
        return { result: { objectId: 'promise-1' } };
      },
    });
    const out = await evalFireAndForgetStr(cdp, 'sid1', 'setInterval(() => {}, 1000)', true);
    expect(out).toMatch(/fire-and-forget eval/i);
  });

  it('parses --fire-and-forget with --b64', () => {
    const b64 = Buffer.from('window.__loop = true', 'utf8').toString('base64');
    const opts = parseEvalArgs(['--fire-and-forget', '--b64', b64]);
    expect(opts.fireAndForget).toBe(true);
    expect(opts.expression).toBe('window.__loop = true');
  });

  it('callStr awaits page result and serializes JSON values', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': (params) => {
        expect(params.awaitPromise).toBe(true);
        expect(params.returnByValue).toBe(true);
        expect(params.expression).toContain('typeof value');
        return { result: { value: { ok: true, n: 2 } } };
      },
    });
    const out = await callStr(cdp, 'sid1', 'async () => ({ ok: true, n: 2 })');
    expect(JSON.parse(out)).toEqual({ ok: true, n: 2 });
  });

  it('callStr evaluates synchronous function expressions without calling the returned promise', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': async (params) => {
        const value = await globalThis.eval(params.expression);
        return { result: { value } };
      },
    });

    await expect(callStr(cdp, 'sid1', '() => "Imagine - Grok"')).resolves.toBe('"Imagine - Grok"');
  });
});

// =========================================================================
// eval64 / eval --b64 — base64 transport for CJK / shell-hostile expressions
// =========================================================================

describe('eval base64 transport', () => {
  const { evalBase64Decode } = T;

  it('decodes UTF-8 base64 expressions losslessly (CJK round-trip)', () => {
    const expr = 'document.title === "戰鬥勝利"';
    const b64 = Buffer.from(expr, 'utf8').toString('base64');
    expect(evalBase64Decode(b64)).toBe(expr);
  });

  it('rejects empty input with a clear error', () => {
    expect(() => evalBase64Decode('')).toThrow(/empty/);
    expect(() => evalBase64Decode(null)).toThrow(/empty/);
  });

  it('rejects non-base64 garbage instead of silently running', () => {
    // base64 alphabet only; invalid chars should fail
    expect(() => evalBase64Decode('not base64!!')).toThrow(/base64/i);
  });

  it('rejects payloads whose length is not a multiple of 4', () => {
    // "YWJj" decodes to "abc" cleanly; truncating one char leaves a 3-char
    // payload that Node would silently decode to 2 bytes. We must reject it.
    expect(() => evalBase64Decode('YWJ')).toThrow(/length/i);
    expect(() => evalBase64Decode('YWJjZA')).toThrow(/length/i);
  });

  it('rejects = padding that appears anywhere but the tail', () => {
    // "YQ==" is the canonical encoding of "a"; placing = in the middle is
    // never legal even if the overall length is a multiple of 4.
    expect(() => evalBase64Decode('YQ==YQ==')).toThrow(/padding/i);
    expect(() => evalBase64Decode('AB=CDEFG')).toThrow(/padding/i);
  });

  it('rejects payloads where Node lenient-decodes but loses bytes (round-trip)', () => {
    // "ABCDE" is 5 chars (length not %4). After we add the length check this
    // is caught earlier; but build a length-%4 payload whose final char does
    // not align to a 6-bit boundary so the round-trip guard fires.
    // "YWJjZGV=" — last group has 3 base64 chars + 1 pad: legal length, but
    // the trailing low bits of the third char must be zero. "ZGV=" decodes
    // to "de" (last char of input must end in == or two trailing zero bits).
    // Picking a char whose low bits are non-zero ("ZGW=") triggers the
    // round-trip guard.
    expect(() => evalBase64Decode('YWJjZGW=')).toThrow(/canonical|truncated|corrupt/i);
  });

  it('accepts canonical padded base64 without flagging it', () => {
    // "abc" round-trips cleanly with one = pad; "ab" with two; "abcd" with none.
    expect(evalBase64Decode('YWJj')).toBe('abc');
    expect(evalBase64Decode('YWI=')).toBe('ab');
    expect(evalBase64Decode('YWJjZA==')).toBe('abcd');
  });
});
