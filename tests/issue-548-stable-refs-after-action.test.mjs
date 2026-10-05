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

  it('T3 action settle and hover recapture perceive with preserveRefs', () => {
    expect(T.actionObservationPerceiveOpts('48515122').preserveRefs).toBe(true);
    expect(T.actionObservationPerceiveOpts('48515122', { frameRef: '@f1' }).preserveRefs).toBe(true);
  });
});
