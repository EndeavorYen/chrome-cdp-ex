import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

const node = (nodeId, role, name, backendDOMNodeId) => ({
  nodeId, parentId: 'root', role: { value: role }, name: { value: name }, backendDOMNodeId,
});
const root = { nodeId: 'root', role: { value: 'RootWebArea' }, name: { value: 'login' } };
// The issue's form before and after `fill @1 alice` reveals the allowClear button.
const before = [root, node('u', 'textbox', 'Username', 11), node('p', 'textbox', 'Password', 12), node('s', 'button', 'Login', 13)];
const after = [root, node('u', 'textbox', 'Username', 11), node('c', 'button', 'clear', 14), node('p', 'textbox', 'Password', 12), node('s', 'button', 'Login', 13)];

const build = (nodes, refMap, opts = {}) => T.buildPerceiveTree(nodes, { layoutMap: {} }, refMap, opts).treeLines.join('\n');

describe('#548 an action settle does not renumber the refs the agent holds', () => {
  it('T1 keeps existing numbers and numbers a new element after the highest ref', () => {
    const refMap = new Map();
    build(before, refMap);
    expect([...refMap]).toEqual([[1, 11], [2, 12], [3, 13]]);

    const text = build(after, refMap, { preserveRefs: true });
    expect([...refMap].sort((a, b) => a[0] - b[0])).toEqual([[1, 11], [2, 12], [3, 13], [4, 14]]);
    expect(text).toMatch(/Login.*@3/);
    expect(text).toMatch(/clear.*@4/);
  });

  it('T1 drops a ref whose element is gone and never reuses its number for another element', () => {
    const refMap = new Map();
    build(after, refMap);
    const gone = [root, node('u', 'textbox', 'Username', 11), node('p', 'textbox', 'Password', 12), node('n', 'button', 'Next', 15)];
    build(gone, refMap, { preserveRefs: true });
    expect([...refMap].sort((a, b) => a[0] - b[0])).toEqual([[1, 11], [3, 12], [5, 15]]);
  });

  it('T2 explicit perceive still numbers refs 1..N in document order', () => {
    const refMap = new Map();
    build(before, refMap);
    const text = build(after, refMap);
    expect([...refMap]).toEqual([[1, 11], [2, 14], [3, 12], [4, 13]]);
    expect(text).toMatch(/Login.*@4/);
  });

  it('a node listed twice keeps its lowest number on every settle', () => {
    const refMap = new Map();
    const twice = [root, node('u', 'textbox', 'Username', 11), node('u2', 'textbox', 'Username', 11), node('s', 'button', 'Login', 13)];
    build(twice, refMap);
    build(twice, refMap, { preserveRefs: true });
    const first = [...refMap];
    build(twice, refMap, { preserveRefs: true });
    expect([...refMap]).toEqual(first);
    expect(refMap.get(1)).toBe(11);
  });

  it('perceive --diff after a settle does not report lines whose only change is the ref number', () => {
    const header = ['Page: login — http://127.0.0.1:8799/', 'Viewport: 1280×720 | Scroll: 0/0 (0%) | Focused: none', 'Interactive: 4', 'Console: clean', ''];
    // The settle kept Login @3 and gave clear @4; the next plain perceive numbers in document order.
    const settled = [...header, '[WebArea] login', '  [textbox] Username  @1', '  [button] clear  @4', '  [textbox] Password  @2', '  [button] Login  @3'].join('\n');
    const renumbered = [...header, '[WebArea] login', '  [textbox] Username  @1', '  [button] clear  @2', '  [textbox] Password  @3', '  [button] Login  @4'].join('\n');
    const unchanged = T.formatPerceiveDiffOutput(settled, renumbered);
    expect(unchanged).not.toMatch(/Added|Removed/);
    const withNew = T.formatPerceiveDiffOutput(settled, `${renumbered}\n  [button] Next  @5`);
    expect(withNew).toContain('+   [button] Next  @5');
    expect(withNew).not.toContain('Login');
  });

  it('perceive --diff still reports one of two identical lines going away', () => {
    const header = ['Page: list — http://127.0.0.1:8799/', 'Viewport: 1280×720 | Scroll: 0/0 (0%) | Focused: none', 'Interactive: 2', 'Console: clean', ''];
    const two = [...header, '[WebArea] list', '  [button] Delete  @1', '  [button] Delete  @2'].join('\n');
    const one = [...header, '[WebArea] list', '  [button] Delete  @1'].join('\n');
    expect(T.formatPerceiveDiffOutput(two, one)).toContain('[button] Delete');
  });

  it('T3 action settle and hover recapture perceive with preserveRefs', () => {
    expect(T.actionObservationPerceiveOpts('48515122').preserveRefs).toBe(true);
    expect(T.actionObservationPerceiveOpts('48515122', { frameRef: '@f1' }).preserveRefs).toBe(true);
  });
});
