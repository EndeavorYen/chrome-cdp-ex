import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

function uploadFile(name = 'avatar.txt') {
  const dir = mkdtempSync(join(tmpdir(), 'cdp-633-'));
  const file = join(dir, name);
  writeFileSync(file, 'avatar-bytes');
  return file;
}

function bindNode(node, backendNodeId, objectId) {
  node.nodeType = node.nodeType || 1;
  node.backendNodeId = backendNodeId;
  node.objectId = objectId;
  node.attributes = node.attributes || [];
  return node;
}

// Page that can resolve an @ref. CSS querySelector/@ evaluate still fail, so a
// select/upload that keeps handing the ref to querySelector does not pass.
function fakeRefPage(entries) {
  const byObjectId = new Map();
  const byBackend = new Map();
  for (const node of entries) {
    byObjectId.set(node.objectId, node);
    byBackend.set(node.backendNodeId, node);
  }
  const calls = [];
  const cdp = {
    calls,
    send(method, params = {}) {
      calls.push({ method, params });
      if (method === 'Page.getFrameTree') return Promise.resolve({ frameTree: { frame: { id: 'root' } } });
      if (method === 'Page.createIsolatedWorld') return Promise.resolve({ executionContextId: 901 });
      if (method === 'DOM.resolveNode') {
        const node = byBackend.get(params.backendNodeId);
        if (!node) return Promise.reject(new Error(`missing backend node ${params.backendNodeId}`));
        return Promise.resolve({ object: { objectId: node.objectId } });
      }
      if (method === 'DOM.describeNode') {
        const node = params.objectId ? byObjectId.get(params.objectId) : byBackend.get(params.backendNodeId);
        if (!node) return Promise.reject(new Error('describeNode: node not found'));
        return Promise.resolve({
          node: { nodeName: node.tagName, attributes: node.attributes, backendNodeId: node.backendNodeId },
        });
      }
      if (method === 'DOM.getDocument') return Promise.resolve({ root: { nodeId: 1 } });
      if (method === 'DOM.querySelector') {
        if (String(params.selector || '').startsWith('@')) return Promise.reject(new Error('DOM Error while querying'));
        return Promise.resolve({ nodeId: 0 });
      }
      if (method === 'DOM.setFileInputFiles') {
        const node = params.backendNodeId != null ? byBackend.get(params.backendNodeId) : byObjectId.get(params.objectId);
        if (!node) return Promise.reject(new Error('setFileInputFiles: node not found'));
        node.files = (params.files || []).map(file => ({ name: basename(file), size: statSync(file).size }));
        if (typeof node.afterSetFiles === 'function') node.afterSetFiles();
        return Promise.resolve({});
      }
      if (method === 'Runtime.evaluate') {
        if (String(params.expression || '').includes('@')) return Promise.reject(new Error("'@1' is not a valid selector"));
        return Promise.resolve({ result: { type: 'undefined' } });
      }
      if (method === 'Runtime.callFunctionOn') {
        const fn = String(params.functionDeclaration || '');
        if (fn.includes('connectedGetter')) {
          const node = byObjectId.get(params.objectId);
          return Promise.resolve({ result: { type: 'object', value: { connected: !node?.detached } } });
        }
        let value;
        try {
          value = new Function(`return (${fn});`)().call(byObjectId.get(params.objectId));
        } catch (error) {
          return Promise.resolve({
            exceptionDetails: { text: 'Uncaught', exception: { description: `${error.name}: ${error.message}` } },
          });
        }
        if (params.returnByValue) {
          return Promise.resolve({ result: { type: value === null ? 'object' : typeof value, value } });
        }
        if (value && value.nodeType === 1 && value.objectId) {
          return Promise.resolve({ result: { type: 'object', subtype: 'node', objectId: value.objectId } });
        }
        return Promise.resolve({ result: { type: 'object', subtype: 'null', value: null } });
      }
      return Promise.resolve({});
    },
  };
  return { cdp, calls };
}

function planSelect() {
  const options = [
    { value: 'free', textContent: 'Free', selected: true },
    { value: 'pro', textContent: 'Pro', selected: false },
    { value: 'team', textContent: 'Team', selected: false },
  ];
  return bindNode({
    tagName: 'SELECT',
    options,
    value: 'free',
    events: [],
    dispatchEvent(event) { this.events.push(event.type); },
    matches() { return false; },
  }, 101, 'obj-select');
}

function fileInput(backendNodeId, objectId, extra = {}) {
  return bindNode({
    tagName: 'INPUT',
    type: 'file',
    attributes: ['type', 'file'],
    files: [],
    labels: [],
    multiple: false,
    ...extra,
  }, backendNodeId, objectId);
}

function locatorCalls(calls) {
  return calls.filter(call => call.method === 'Runtime.callFunctionOn'
    && String(call.params.functionDeclaration || '').includes('input[type="file"]'));
}

function cdpThatMustNotBeCalled() {
  return {
    send() { throw new Error('ref resolution must fail before CDP'); },
  };
}

describe('select and upload accept perceive @refs (#633)', () => {
  it('selects the option on the node an @ref names and dispatches change', async () => {
    const el = planSelect();
    const { cdp, calls } = fakeRefPage([el]);
    const result = await T.selectStr(cdp, 'sid', '@1', 'pro', {}, new Map([[1, el.backendNodeId]]), {});
    expect(result).toBe('Selected "Pro"');
    expect(el.value).toBe('pro');
    expect(el.options[1].selected).toBe(true);
    expect(el.events).toEqual(['input', 'change']);
    expect(calls.map(call => call.method)).not.toContain('Runtime.evaluate');
    expect(calls.some(call => call.method === 'Runtime.callFunctionOn' && String(call.params.functionDeclaration).includes('Not a <select>'))).toBe(true);
  });

  it('rejects an @ref that is not a <select>', async () => {
    const el = bindNode({ tagName: 'DIV' }, 102, 'obj-div');
    const { cdp } = fakeRefPage([el]);
    const error = await T.selectStr(cdp, 'sid', '@1', 'pro', {}, new Map([[1, el.backendNodeId]]), {}).catch(e => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('Not a <select>: DIV');
    expect(T.classifyActionFailure(error, {
      action: 'select',
      target: { targetId: 'ABC123', input: '@1' },
    })).toMatchObject({ kind: 'usage', nextCommand: 'cdp help select' });
  });

  it('uploads through an @ref onto the resolved file input', async () => {
    const input = fileInput(201, 'obj-file');
    const file = uploadFile();
    const { cdp, calls } = fakeRefPage([input]);
    const result = await T.uploadStr(cdp, 'sid', '@1', file, new Map([[1, input.backendNodeId]]), {});
    expect(result).toMatch(new RegExp(`^Uploaded 1 file\\(s\\) to @1: ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
    const set = calls.find(call => call.method === 'DOM.setFileInputFiles');
    expect(set.params).toMatchObject({ files: [file], backendNodeId: input.backendNodeId });
    expect(set.params.objectId).toBeUndefined();
    expect(set.params.nodeId).toBeUndefined();
    expect(calls.map(call => call.method)).not.toContain('DOM.querySelector');
    expect(input.files).toEqual([{ name: 'avatar.txt', size: statSync(file).size }]);
  });

  it('accepts an @ref input that the page clears after its change event (#743)', async () => {
    const listeners = [];
    const ownerDocument = {
      addEventListener(type, fn, capture) { listeners.push({ type, fn, capture }); },
      removeEventListener(type, fn) {
        const at = listeners.findIndex(entry => entry.type === type && entry.fn === fn);
        if (at >= 0) listeners.splice(at, 1);
      },
    };
    const input = fileInput(205, 'obj-file-clear', {
      ownerDocument,
      // The page reads the file on input/change, then clears the value.
      afterSetFiles() {
        for (const entry of [...listeners]) entry.fn({ type: entry.type, target: this });
        this.files = [];
      },
    });
    const file = uploadFile();
    const { cdp } = fakeRefPage([input]);
    const result = await T.uploadStr(cdp, 'sid', '@5', file, new Map([[5, input.backendNodeId]]), {});
    expect(result).toBe(`Uploaded 1 file(s) to @5: ${file} (the page cleared the input after its change event)`);
    expect(listeners).toEqual([]);
  });

  it('uploads through an @ref to a label of one file input', async () => {
    const input = fileInput(201, 'obj-file');
    const label = bindNode({
      tagName: 'LABEL',
      control: input,
      querySelectorAll(sel) { return sel === 'input[type="file"]' ? [input] : []; },
      ownerDocument: { querySelectorAll(sel) { return sel === 'input[type="file"]' ? [input] : []; } },
      getRootNode() { return {}; },
    }, 202, 'obj-label');
    input.labels = [label];
    const file = uploadFile('note.txt');
    const { cdp, calls } = fakeRefPage([input, label]);
    const result = await T.uploadStr(cdp, 'sid', '@2', file, new Map([[2, label.backendNodeId]]), {});
    expect(result).toMatch(/^Uploaded 1 file\(s\) to @2: /);
    const set = calls.find(call => call.method === 'DOM.setFileInputFiles');
    expect(set.params.backendNodeId).toBe(input.backendNodeId);
    expect(input.files[0].name).toBe('note.txt');
  });

  it('executes the captured page label function on a control, a wrapping label, and a label with no file input', async () => {
    const input = fileInput(211, 'obj-file');
    const host = bindNode({
      tagName: 'DIV',
      querySelectorAll(sel) { return sel === 'input[type="file"]' ? [input] : []; },
      getRootNode() { return {}; },
    }, 212, 'obj-host');
    const { cdp, calls } = fakeRefPage([input, host]);
    await T.uploadStr(cdp, 'sid', '@9', uploadFile(), new Map([[9, host.backendNodeId]]), {});
    const sent = calls.find(call => call.method === 'Runtime.callFunctionOn'
      && String(call.params.functionDeclaration || '').includes('input[type="file"]'));
    expect(sent).toBeTruthy();
    const resolve = new Function(`return (${sent.params.functionDeclaration});`)();

    // One document, three labels. Each hit is reachable by only one LABEL branch:
    // `push(this.control)`, or the ownerDocument scan of `input[type="file"]` `.labels`.
    const controlled = { nodeType: 1, tagName: 'INPUT', type: 'file', labels: [] };
    const wrapped = { nodeType: 1, tagName: 'INPUT', type: 'file', labels: [] };
    const stray = { nodeType: 1, tagName: 'INPUT', type: 'file', labels: [{ nodeType: 1, tagName: 'LABEL' }] };
    const ownerDocument = {
      querySelectorAll(sel) {
        return sel === 'input[type="file"]' ? [controlled, wrapped, stray] : [];
      },
    };
    const label = (extra = {}) => ({
      nodeType: 1,
      tagName: 'LABEL',
      control: null,
      querySelectorAll() { return []; },
      ownerDocument,
      getRootNode() { return {}; },
      ...extra,
    });
    const byControl = label({ control: controlled });
    const byWrap = label();
    wrapped.labels = [byWrap];
    const byNone = label();

    expect(resolve.call(byControl)).toBe(controlled);
    expect(resolve.call(byWrap)).toBe(wrapped);
    expect(resolve.call(byNone)).toBe(null);
  });

  it('uploads through an @ref that wraps one file input', async () => {
    const input = fileInput(201, 'obj-file');
    const wrap = bindNode({
      tagName: 'DIV',
      querySelectorAll(sel) { return sel === 'input[type="file"]' ? [input] : []; },
      getRootNode() { return {}; },
    }, 205, 'obj-wrap');
    const file = uploadFile();
    const { cdp, calls } = fakeRefPage([input, wrap]);
    await expect(T.uploadStr(cdp, 'sid', '@3', file, new Map([[3, wrap.backendNodeId]]), {})).resolves.toMatch(/^Uploaded 1 file\(s\) to @3: /);
    expect(calls.find(call => call.method === 'DOM.setFileInputFiles').params.backendNodeId).toBe(input.backendNodeId);
  });

  it('uploads through the button a file input exposes to perceive', async () => {
    const input = fileInput(201, 'obj-file');
    const button = bindNode({
      tagName: 'BUTTON',
      querySelectorAll() { return []; },
      getRootNode() { return { host: input }; },
    }, 204, 'obj-button');
    const file = uploadFile();
    const { cdp, calls } = fakeRefPage([input, button]);
    await expect(T.uploadStr(cdp, 'sid', '@4', file, new Map([[4, button.backendNodeId]]), {})).resolves.toMatch(/^Uploaded 1 file\(s\) to @4: /);
    expect(calls.find(call => call.method === 'DOM.setFileInputFiles').params.backendNodeId).toBe(input.backendNodeId);
  });

  it('rejects an @ref that is not a file input', async () => {
    const el = bindNode({
      tagName: 'DIV',
      querySelectorAll() { return []; },
      getRootNode() { return {}; },
    }, 203, 'obj-div');
    const { cdp, calls } = fakeRefPage([el]);
    const error = await T.uploadStr(cdp, 'sid', '@1', uploadFile(), new Map([[1, el.backendNodeId]]), {}).catch(e => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('Element is not an <input type="file">');
    expect(calls.map(call => call.method)).not.toContain('DOM.setFileInputFiles');
    expect(T.classifyActionFailure(error, {
      action: 'upload',
      target: { targetId: 'ABC123', input: '@1' },
    })).toMatchObject({ kind: 'usage', nextCommand: 'cdp help upload' });
  });

  it('uploads <input name="type" type="file"> by the type attribute, not the name value', async () => {
    const input = fileInput(221, 'obj-name-type', {
      attributes: ['name', 'type', 'type', 'file'],
      name: 'type',
    });
    const { cdp, calls } = fakeRefPage([input]);
    await expect(T.uploadStr(cdp, 'sid', '@1', uploadFile(), new Map([[1, input.backendNodeId]]), {}))
      .resolves.toMatch(/^Uploaded 1 file\(s\) to @1: /);
    expect(locatorCalls(calls)).toEqual([]);
    expect(calls.find(call => call.method === 'DOM.setFileInputFiles').params.backendNodeId).toBe(input.backendNodeId);
  });

  it('uploads an input whose type attribute is FILE', async () => {
    const input = fileInput(222, 'obj-type-file', { attributes: ['type', 'FILE'] });
    const { cdp, calls } = fakeRefPage([input]);
    await expect(T.uploadStr(cdp, 'sid', '@1', uploadFile(), new Map([[1, input.backendNodeId]]), {}))
      .resolves.toMatch(/^Uploaded 1 file\(s\) to @1: /);
    expect(locatorCalls(calls)).toEqual([]);
    expect(calls.find(call => call.method === 'DOM.setFileInputFiles').params.backendNodeId).toBe(input.backendNodeId);
  });

  it('rejects two files when name="multiple" and the IDL multiple flag is false', async () => {
    const input = fileInput(223, 'obj-name-multiple', {
      attributes: ['name', 'multiple', 'type', 'file'],
      name: 'multiple',
      multiple: false,
    });
    const files = [uploadFile('one.txt'), uploadFile('two.txt')].join(',');
    const { cdp, calls } = fakeRefPage([input]);
    const error = await T.uploadStr(cdp, 'sid', '@1', files, new Map([[1, input.backendNodeId]]), {}).catch(e => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('does not accept several files');
    expect(calls.map(call => call.method)).not.toContain('DOM.setFileInputFiles');
  });

  it('uploads two files when only the IDL multiple flag is set', async () => {
    const input = fileInput(224, 'obj-idl-multiple', { attributes: ['type', 'file'], multiple: true });
    const one = uploadFile('one.txt');
    const two = uploadFile('two.txt');
    const { cdp, calls } = fakeRefPage([input]);
    await expect(T.uploadStr(cdp, 'sid', '@1', `${one},${two}`, new Map([[1, input.backendNodeId]]), {}))
      .resolves.toMatch(/^Uploaded 2 file\(s\) to @1: /);
    expect(input.files.map(file => file.name)).toEqual(['one.txt', 'two.txt']);
    expect(calls.some(call => call.method === 'Runtime.callFunctionOn'
      && String(call.params.functionDeclaration).includes('this.multiple'))).toBe(true);
  });

  it('trusts the locator IDL type when describeNode attributes do not say type=file', async () => {
    const input = fileInput(225, 'obj-idl-only', { attributes: ['id', 'avatar'], id: 'avatar' });
    const wrap = bindNode({
      tagName: 'DIV',
      querySelectorAll(sel) { return sel === 'input[type="file"]' ? [input] : []; },
      getRootNode() { return {}; },
    }, 226, 'obj-idl-wrap');
    const { cdp, calls } = fakeRefPage([input, wrap]);
    await expect(T.uploadStr(cdp, 'sid', '@6', uploadFile(), new Map([[6, wrap.backendNodeId]]), {}))
      .resolves.toMatch(/^Uploaded 1 file\(s\) to @6: /);
    expect(locatorCalls(calls)).toHaveLength(1);
    expect(calls.find(call => call.method === 'DOM.setFileInputFiles').params.backendNodeId).toBe(input.backendNodeId);
  });

  it('refuses to guess when one label wraps two file inputs', async () => {
    const host = fileInput(231, 'obj-shadow-host');
    const first = fileInput(232, 'obj-under-a');
    const second = fileInput(233, 'obj-under-b');
    const label = bindNode({
      tagName: 'LABEL',
      control: null,
      querySelectorAll(sel) { return sel === 'input[type="file"]' ? [first, second] : []; },
      ownerDocument: { querySelectorAll() { return []; } },
      getRootNode() { return { host }; },
    }, 234, 'obj-two-label');
    const { cdp, calls } = fakeRefPage([host, first, second, label]);
    const error = await T.uploadStr(cdp, 'sid', '@5', uploadFile(), new Map([[5, label.backendNodeId]]), {}).catch(e => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('refusing to guess');
    expect(error.message).toContain('"@5"');
    expect(error.message).toContain('matches 2');
    expect(error.message).not.toBe('Element is not an <input type="file">');
    expect(calls.map(call => call.method)).not.toContain('DOM.setFileInputFiles');
    expect(host.files).toEqual([]);
  });

  it('reports a stale @ref for select and upload after a DOM invalidation', async () => {
    const state = { invalidationReason: 'dom-mutation', generation: 4 };
    const cdp = cdpThatMustNotBeCalled();
    const selectError = await T.selectStr(cdp, 'sid', '@8', 'pro', {}, new Map(), state).catch(e => e);
    expect(selectError).toBeInstanceOf(Error);
    expect(selectError.code).toBe('CDP_STALE_REF');
    expect(selectError.message).toMatch(/@8 is stale: the DOM changed after the last perceive/);
    const uploadError = await T.uploadStr(cdp, 'sid', '@8', uploadFile(), new Map(), state).catch(e => e);
    expect(uploadError).toBeInstanceOf(Error);
    expect(uploadError.code).toBe('CDP_STALE_REF');
    expect(uploadError.message).toMatch(/@8 is stale: the DOM changed after the last perceive/);
  });

  it('reports an unknown @ref for select and upload', async () => {
    const state = { invalidationReason: null, generation: 4 };
    const cdp = cdpThatMustNotBeCalled();
    const selectError = await T.selectStr(cdp, 'sid', '@8', 'pro', {}, new Map(), state).catch(e => e);
    expect(selectError).toBeInstanceOf(Error);
    expect(selectError.message).toMatch(/Unknown ref: @8/);
    expect(selectError.message).not.toMatch(/Not a <select>/);
    const uploadError = await T.uploadStr(cdp, 'sid', '@8', uploadFile(), new Map(), state).catch(e => e);
    expect(uploadError).toBeInstanceOf(Error);
    expect(uploadError.message).toMatch(/Unknown ref: @8/);
    expect(uploadError.message).not.toMatch(/not an <input type="file">/);
  });

  it('reports a detached @ref as stale for select and upload', async () => {
    const el = planSelect();
    el.detached = true;
    const selectPage = fakeRefPage([el]);
    const selectError = await T.selectStr(
      selectPage.cdp, 'sid', '@1', 'pro', {}, new Map([[1, el.backendNodeId]]), { generation: 2 },
    ).catch(e => e);
    expect(selectError.code).toBe('CDP_STALE_REF');
    expect(selectError.message).toMatch(/@1 is stale: the DOM changed after the last perceive/);
    expect(el.value).toBe('free');

    const input = fileInput(241, 'obj-detached', { detached: true });
    const uploadPage = fakeRefPage([input]);
    const uploadError = await T.uploadStr(
      uploadPage.cdp, 'sid', '@1', uploadFile(), new Map([[1, input.backendNodeId]]), { generation: 2 },
    ).catch(e => e);
    expect(uploadError.code).toBe('CDP_STALE_REF');
    expect(uploadError.message).toMatch(/@1 is stale: the DOM changed after the last perceive/);
    expect(uploadPage.calls.map(call => call.method)).not.toContain('DOM.setFileInputFiles');
  });

  it('resolves an @fN:M frame ref for select and upload in that frame', async () => {
    const el = planSelect();
    const selectPage = fakeRefPage([el]);
    const selectState = {
      generation: 2,
      frameRefs: new Map([['@f2', { frameId: 'child-frame', refs: new Map([[4, el.backendNodeId]]) }]]),
    };
    await expect(T.selectStr(selectPage.cdp, 'sid', '@f2:4', 'pro', {}, new Map(), selectState)).resolves.toBe('Selected "Pro"');
    expect(el.value).toBe('pro');
    const selectWorlds = selectPage.calls.filter(call => call.method === 'Page.createIsolatedWorld');
    expect(selectWorlds.length).toBeGreaterThan(0);
    expect(selectWorlds.every(call => call.params.frameId === 'child-frame')).toBe(true);

    const input = fileInput(251, 'obj-frame-file');
    const uploadPage = fakeRefPage([input]);
    const uploadState = {
      generation: 2,
      frameRefs: new Map([['@f2', { frameId: 'child-frame', refs: new Map([[4, input.backendNodeId]]) }]]),
    };
    await expect(T.uploadStr(uploadPage.cdp, 'sid', '@f2:4', uploadFile(), new Map(), uploadState))
      .resolves.toMatch(/^Uploaded 1 file\(s\) to @f2:4: /);
    const uploadWorlds = uploadPage.calls.filter(call => call.method === 'Page.createIsolatedWorld');
    expect(uploadWorlds.length).toBeGreaterThan(0);
    expect(uploadWorlds.every(call => call.params.frameId === 'child-frame')).toBe(true);
    expect(uploadPage.calls.find(call => call.method === 'DOM.setFileInputFiles').params.backendNodeId).toBe(input.backendNodeId);
  });
});
