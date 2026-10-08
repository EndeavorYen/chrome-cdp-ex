// #593: a top-level let/const/class must not stay declared on the tab.
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';
const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

function context() {
  return vm.createContext({});
}

function run(source, shared = context(), autoWrap = true) {
  return vm.runInContext(T.wrapAwaitExpression(source, autoWrap), shared);
}

describe('#593 eval lexical scope', () => {
  it('runs the same let/const/class script twice and keeps the last expression', () => {
    const shared = context();
    const source = 'const zz = 1; zz + 1';
    expect(T.wrapAwaitExpression(source, true)).toBe('{const zz = 1; zz + 1\n}');
    expect(run(source, shared)).toBe(2);
    expect(run(source, shared)).toBe(2);
    expect(() => run('zz', shared)).toThrow(/zz is not defined/);

    const classes = context();
    expect(run('class Foo { static id(){ return 1 } }\nFoo.id()', classes)).toBe(1);
    expect(run('class Foo { static id(){ return 2 } }\nFoo.id()', classes)).toBe(2);

    const lets = context();
    expect(run('let n = 1; n += 4; n', lets)).toBe(5);
    expect(run('let n = 1; n += 4; n', lets)).toBe(5);

    const separated = context();
    expect(run('1\nconst zz = 1; zz', separated)).toBe(1);
    expect(run('1\nconst zz = 1; zz', separated)).toBe(1);
    expect(run('let /* name */ value = 4; value')).toBe(4);
  });

  it('allows var after an earlier const of the same name', () => {
    const shared = context();
    expect(run('const zz = 1; zz + 1', shared)).toBe(2);
    expect(T.wrapAwaitExpression('var zz = 3; zz', true)).toBe('var zz = 3; zz');
    expect(run('var zz = 3; zz', shared)).toBe(3);
    expect(run('zz', shared)).toBe(3);
  });

  it('keeps a page lexical binding and still accepts a block-scoped const of that name', () => {
    const shared = context();
    vm.runInContext('const zz = 1', shared);
    expect(run('const zz = 2; zz', shared)).toBe(2);
    expect(vm.runInContext('zz', shared)).toBe(1);
  });

  it('preserves the await path, including a second run and the trailing expression', async () => {
    const source = 'const value = await Promise.resolve(42); value';
    const wrapped = T.wrapAwaitExpression(source, true);
    expect(wrapped).toBe('(async()=>{const value = await Promise.resolve(42); return (value);})()');
    const shared = context();
    expect(await run(source, shared)).toBe(42);
    expect(await run(source, shared)).toBe(42);
  });

  it('preserves the last expression, including an object, a trailing comment, and a bare declaration', () => {
    const shared = context();
    const objectSource = 'const o = 1; ({ a: o })';
    expect(run(objectSource, shared)).toEqual({ a: 1 });
    expect(run(objectSource, shared)).toEqual({ a: 1 });
    expect(run('const a = 1; const b = 2; a + b')).toBe(3);
    expect(run('const zz = 1; zz + 1 // tail')).toBe(2);

    const declared = context();
    expect(run('const zz = 1', declared)).toBeUndefined();
    expect(run('const zz = 1', declared)).toBeUndefined();
  });

  it('leaves scripts without a top-level lexical declaration unchanged', () => {
    for (const source of [
      '1 + 1',
      '{a:1}',
      '({a:1})',
      'let = 1',
      '(function(){ const zz = 1; return zz + 1 })()',
      'for (let i = 0; i < 2; i++) i',
      'switch (1) { default: const zz = 1; zz }',
      'if (true) { const zz = 1; zz }',
      '"const zz = 1".length',
      'globalThis.Foo = class Foo {}',
      '// class Foo\n1 + 1',
      '/* const zz = 1 */\n1 + 1',
    ]) {
      expect(T.wrapAwaitExpression(source, true)).toBe(source);
    }
    const shared = context();
    expect(run('(function(){ const zz = 1; return zz + 1 })()', shared)).toBe(2);
    expect(run('(function(){ const zz = 1; return zz + 1 })()', shared)).toBe(2);
    expect(run('1 + 1; 2')).toBe(2);
  });

  it('keeps var and sloppy function bindings, and strict mode, across calls', () => {
    const sloppy = context();
    expect(run('var zz = 3; zz', sloppy)).toBe(3);
    expect(run('zz', sloppy)).toBe(3);
    expect(run('function foo(){ return 7 }\nconst n = 1\nn', sloppy)).toBe(1);
    expect(run('foo()', sloppy)).toBe(7);
    expect(run('const zz = 1; globalThis.kept = zz + 4', sloppy)).toBe(5);
    expect(run('kept', sloppy)).toBe(5);

    const strict = context();
    const strictSource = '"use strict"; const strict = (function () { return this === undefined; })(); strict';
    expect(T.wrapAwaitExpression(strictSource, true)).toBe(`"use strict";{${strictSource}\n}`);
    expect(run(strictSource, strict)).toBe(true);
    expect(run(strictSource, strict)).toBe(true);
    expect(run("'use strict'\nconst zz = 1; zz + 1")).toBe(2);

    const commented = context();
    const commentedSource = '/* header */\n"use strict";\nconst strict = (function () { return this === undefined; })(); strict';
    expect(run(commentedSource, commented)).toBe(true);

    const notDirective = context();
    const sloppySource = '"use strict" + ""; const strict = (function () { return this === undefined; })(); strict';
    expect(run(sloppySource, notDirective)).toBe(false);
    expect(T.wrapAwaitExpression(sloppySource, true).startsWith('"use strict";')).toBe(false);

    const strictFunction = context();
    const strictFn = '"use strict"; function foo(){ return 7 }\nconst n = foo()\nn';
    expect(run(strictFn, strictFunction)).toBe(7);
    expect(() => run('foo()', strictFunction)).toThrow(/foo is not defined/);

    expect(() => run('const zz = 1; return zz')).toThrow(/Illegal return statement/);
    expect(() => run('"use strict"; const zz = 1; undeclared = 1')).toThrow(/undeclared is not defined/);
  });

  it('does not wrap internal evals that pass autoWrap false', () => {
    const source = 'const internalName = 1; internalName';
    expect(T.wrapAwaitExpression(source, false)).toBe(source);
    const shared = context();
    expect(vm.runInContext(source, shared)).toBe(1);
    expect(() => vm.runInContext(source, shared)).toThrow(/already been declared/);
  });

  it('sends the block to Runtime.evaluate and describes the scope in help and Kind: eval', async () => {
    const calls = [];
    const cdp = {
      send(method, params) {
        calls.push({ method, params });
        expect(params.replMode).toBeUndefined();
        return Promise.resolve({ result: { value: params.awaitPromise === false ? undefined : 2 } });
      },
    };
    await expect(T.evalStr(cdp, 'sid', 'const zz = 1; zz + 1', true)).resolves.toBe('2');
    expect(calls[0].params.expression).toBe('{const zz = 1; zz + 1\n}');
    expect(calls[0].params.awaitPromise).toBe(true);
    expect(calls[0].params.returnByValue).toBe(true);

    await T.evalFireAndForgetStr(cdp, 'sid', 'const zz = 1', true);
    expect(calls[1].params.expression).toBe('{const zz = 1\n}');
    expect(calls[1].params.awaitPromise).toBe(false);

    const help = T.helpTopicStr('eval');
    expect(help).toMatch(/let, const, and class exist only for that call/);
    expect(help).toMatch(/The result is the last expression/);
    expect(help).toMatch(/var and assignments to globalThis or window stay on the tab/);
    expect(help).toMatch(/A sloppy function declaration stays too/);
    expect(help).toMatch(/strict-mode function/);
    expect(T.helpTopicStr('eval64')).toMatch(/let, const, and class exist only for that call/);
    expect(T.CATALOG_USAGE).toMatch(/let\/const\/class exist only for that call/);

    const redeclared = T.formatCliError(new Error("SyntaxError: Identifier 'zz' has already been declared"), { cmd: 'eval' });
    expect(redeclared).toMatch(/Kind: eval/);
    expect(redeclared).toMatch(/Next: cdp help eval/);
    expect(redeclared).toMatch(/let, const, and class from an earlier eval end with that call/);

    const other = T.formatCliError(new Error('SyntaxError: Unexpected token'), { cmd: 'eval64' });
    expect(other).toMatch(/own let, const, and class scope/);
    expect(other).toMatch(/still returns the last expression/);

    const callError = T.formatCliError(new Error('SyntaxError: Unexpected token'), { cmd: 'call' });
    expect(callError).toContain('The JavaScript expression threw. Fix the expression; the tab is still live.');
    expect(callError).not.toMatch(/own let, const, and class scope/);
  });
});
