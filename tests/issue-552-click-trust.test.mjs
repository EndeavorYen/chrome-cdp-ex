import { describe, expect, it } from 'vitest';
import { createContext, runInContext } from 'node:vm';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
const {
  classifyActionFailure,
  listRecoveryPolicyKinds,
} = await import('../skills/chrome-cdp-ex/scripts/lib/action-recovery.mjs');

const TARGET_ID = '9E3238F5CEA88A787E777B3A5E650842';
const NO_CHANGE = '(no changes detected in AX tree)';

function compilePageFunction(source) {
  return runInContext(`(${source})`, createContext({}));
}

function element(tag, { id = '', parent = null, control = null } = {}) {
  const node = {
    nodeType: 1,
    tagName: String(tag || 'DIV').toUpperCase(),
    id,
    parentNode: parent,
    control,
    closest(selector) {
      let current = this;
      while (current) {
        if (selector === 'label' && current.tagName === 'LABEL') return current;
        current = current.parentNode && current.parentNode.nodeType === 11
          ? current.parentNode.host
          : current.parentNode;
      }
      return null;
    },
  };
  return node;
}

function probeWindow() {
  const listeners = new Map();
  const view = {
    location: { href: 'http://example.test/form' },
    addEventListener(type, handler) {
      const list = listeners.get(type) || [];
      list.push(handler);
      listeners.set(type, list);
    },
    removeEventListener(type, handler) {
      listeners.set(type, (listeners.get(type) || []).filter(item => item !== handler));
    },
    dispatch(type, target) {
      for (const handler of [...(listeners.get(type) || [])]) handler({ type, target });
    },
  };
  view.top = view;
  const doc = { nodeType: 9, defaultView: view };
  return { view, doc };
}

function installProbeOn(node) {
  const install = compilePageFunction(T.clickEventProbeInstallOnNodeDeclaration());
  const read = compilePageFunction(T.clickEventProbeReadOnNodeDeclaration());
  const installed = install.call(node);
  return {
    installed,
    read: () => read.call(node),
    fire: (type, target) => node.ownerDocument.defaultView.dispatch(type, target),
  };
}

function probeCdp({ install, read }) {
  const calls = [];
  return {
    calls,
    send(method, params = {}) {
      calls.push({ method, params });
      const src = method === 'Runtime.evaluate'
        ? String(params.expression || '')
        : String(params.functionDeclaration || '');
      if (src.includes('__chromeCdpExClickProbe')) {
        if (src.includes('installed: true')) {
          return Promise.resolve({ result: { value: install } });
        }
        return Promise.resolve({ result: { value: read } });
      }
      if (method === 'Runtime.evaluate' && String(params.expression).includes('visibilityState')) {
        return Promise.resolve({ result: { type: 'string', value: 'visible' } });
      }
      return Promise.resolve({ result: { value: '' } });
    },
  };
}

function mouseEvents(cdp) {
  return cdp.calls.filter(call => call.method === 'Input.dispatchMouseEvent');
}

async function clickFeedback({
  action = 'click',
  dispatchText,
  domDiff = NO_CHANGE,
  target = {},
  format = 'text',
  enrichActionResult = null,
}) {
  return T.runActionWithFeedback({
    action,
    target: {
      targetId: TARGET_ID,
      input: '#save',
      resolvedBy: 'selector',
      label: '#save',
      ...target,
    },
    dispatch: async () => dispatchText,
    feedbackPolicy: 'settle-diff',
    observe: async () => domDiff,
    enrichActionResult,
    format,
  });
}

describe('click probe confirms the intended target received the event (#552)', () => {
  it('keeps the install/read split that existing CDP mocks use', () => {
    expect(T.clickEventProbeInstallOnNodeDeclaration()).toContain('installed: true');
    expect(T.clickEventProbeReadOnNodeDeclaration()).not.toContain('installed: true');
    expect(T.clickEventProbeInstallAtPointScript(1, 2, '#save')).toContain('installed: true');
    expect(T.clickEventProbeReadAtPointScript(1, 2)).not.toContain('installed: true');
  });

  it('records a click on the target, a descendant, an ancestor, or its label', () => {
    const { view, doc } = probeWindow();
    const host = element('DIV', { id: 'wrap' });
    host.ownerDocument = doc;
    const button = element('BUTTON', { id: 'save', parent: host });
    button.ownerDocument = doc;
    const child = element('SPAN', { parent: button });
    child.ownerDocument = doc;
    const label = element('LABEL', { control: button });
    label.ownerDocument = doc;
    const labelText = element('SPAN', { parent: label });
    labelText.ownerDocument = doc;

    const onButton = installProbeOn(button);
    expect(onButton.installed.verifiesTarget).toBe(true);
    onButton.fire('click', button);
    expect(onButton.read().reached).toContain('click');

    const onChild = installProbeOn(button);
    onChild.fire('click', child);
    expect(onChild.read().reached).toContain('click');

    const onAncestor = installProbeOn(button);
    onAncestor.fire('click', host);
    expect(onAncestor.read().reached).toContain('click');

    const onLabel = installProbeOn(button);
    onLabel.fire('click', labelText);
    expect(onLabel.read().reached).toContain('click');

    expect(view.top).toBe(view);
  });

  it('binds a CSS selector in the same document before walking iframes', () => {
    const { doc, view } = probeWindow();
    const button = element('BUTTON', { id: 'save' });
    button.ownerDocument = doc;
    const iframe = element('IFRAME');
    const document = {
      querySelector(selector) { return selector === '#save' ? button : null; },
      elementFromPoint() { return iframe; },
    };
    view.document = document;
    const context = createContext({ document, window: view });
    const installed = runInContext(T.clickEventProbeInstallAtPointScript(10, 20, '#save'), context);
    expect(installed.verifiesTarget).toBe(true);
    expect(installed.installed).toBe(true);
    view.dispatch('click', iframe);
    const readout = runInContext(T.clickEventProbeReadAtPointScript(10, 20), context);
    expect(readout.reached).toEqual([]);
    expect(readout.landedOn).toBe('<IFRAME>');
  });

  it('reports missingTarget when the CSS selector is gone and sends no iframe walk', () => {
    const document = {
      querySelector() { return null; },
      elementFromPoint() { throw new Error('should not walk'); },
    };
    const window = { document, addEventListener() {} };
    window.top = window;
    const result = runInContext(
      T.clickEventProbeInstallAtPointScript(10, 20, '#save'),
      createContext({ document, window }),
    );
    expect(result).toMatchObject({ missingTarget: true, installed: false });
  });

  it('names the element that received a click outside that set', () => {
    const { doc } = probeWindow();
    const button = element('BUTTON', { id: 'save' });
    button.ownerDocument = doc;
    const mask = element('DIV', { id: 'mask' });
    const probe = installProbeOn(button);
    probe.fire('mousedown', mask);
    probe.fire('click', mask);
    const readout = probe.read();
    expect(readout.seen).toEqual(['mousedown', 'click']);
    expect(readout.reached).toEqual([]);
    expect(readout.landedOn).toBe('<DIV#mask>');
    expect(readout.verifiesTarget).toBe(true);
  });

  it('fails closed when a bound click is delivered to a different element', async () => {
    const cdp = probeCdp({
      install: {
        cdpClickProbe: true, ok: true, installed: true, verifiesTarget: true, scope: 'target-document',
      },
      read: {
        cdpClickProbe: true, ok: true, seen: ['mousedown', 'click'], reached: [], landedOn: '<DIV#mask>',
      },
    });
    const err = await T.dispatchClick(cdp, 'sid', 12, 24, { selector: '#save', objectId: 'obj-1' }).catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.clickMisdirected).toMatchObject({ sent: true, landedOn: '<DIV#mask>', selector: '#save' });
    expect(mouseEvents(cdp).length).toBeGreaterThan(0);
    const failure = classifyActionFailure(err, {
      action: 'click',
      target: { targetId: TARGET_ID, input: '#save' },
    });
    expect(failure.kind).toBe('misdirected');
    expect(failure.dispatched).toBe(true);
    expect(failure.nextCommand).toBe('cdp perceive 9E3238F5 --since-action');
    const text = T.formatActionFailure(err, { action: 'click', target: { targetId: TARGET_ID, input: '#save' } });
    expect(text).toMatch(/Kind: misdirected/);
    expect(text).toMatch(/did not reach the intended element/);
  });

  it('accepts a bound click whose event reached the target', async () => {
    const cdp = probeCdp({
      install: {
        cdpClickProbe: true, ok: true, installed: true, verifiesTarget: true, scope: 'target-document',
      },
      read: {
        cdpClickProbe: true, ok: true, seen: ['click'], reached: ['click'], landedOn: '',
      },
    });
    await expect(T.dispatchClick(cdp, 'sid', 12, 24, {
      selector: '#save', objectId: 'obj-1',
    })).resolves.toBeUndefined();
  });

  it('sends nothing when the bound target is gone before dispatch', async () => {
    const cdp = probeCdp({
      install: { cdpClickProbe: true, ok: false, missingTarget: true, installed: false },
      read: { cdpClickProbe: true, ok: false },
    });
    const err = await T.dispatchClick(cdp, 'sid', 12, 24, { selector: '#save' }).catch(e => e);
    expect(err.clickMisdirected).toMatchObject({ sent: false, selector: '#save' });
    expect(mouseEvents(cdp)).toEqual([]);
    expect(classifyActionFailure(err, {
      action: 'click',
      target: { targetId: TARGET_ID, input: '#save' },
    }).kind).toBe('misdirected');
    expect(classifyActionFailure(err, {
      action: 'click',
      target: { targetId: TARGET_ID, input: '#save' },
    }).dispatched).toBe(false);
  });

  it('keeps a page-level probe (no bound target) on the existing seen-event contract', async () => {
    const cdp = probeCdp({
      install: { cdpClickProbe: true, ok: true, installed: true, scope: 'top' },
      read: { cdpClickProbe: true, ok: true, seen: ['click'] },
    });
    await expect(T.dispatchClick(cdp, 'sid', 3, 4, { x: 3, y: 4 })).resolves.toBeUndefined();
  });
});

describe('a control that should react cannot exit 0 on Outcome: no-change (#552)', () => {
  it('exits non-zero for a button, an input, and a jsclick with Kind: click-no-change', async () => {
    for (const dispatchText of [
      'Clicked <BUTTON> "Save"',
      'Clicked <INPUT> "" (@4)',
      'JS-clicked <BUTTON> "Save"',
    ]) {
      const err = await clickFeedback({
        action: dispatchText.startsWith('JS-clicked') ? 'jsclick' : 'click',
        dispatchText,
      }).catch(e => e);
      expect(err, dispatchText).toBeInstanceOf(Error);
      expect(err.message, dispatchText).toMatch(/Kind: click-no-change/);
      expect(err.message, dispatchText).toMatch(/Outcome: no-change/);
    }
  });

  it('returns dispatch.ok false for JSON and the CLI exits 1', async () => {
    const output = await clickFeedback({
      dispatchText: 'Clicked <BUTTON> "Save"',
      format: 'json',
    });
    const model = JSON.parse(output);
    expect(model.dispatch.ok).toBe(false);
    expect(model.effects.failure.kind).toBe('click-no-change');
    expect(model.effects.failure.detailLines).toContain('Outcome: no-change');
    expect(model.outcome.status).toBe('failed');

    const stdout = [];
    const processLike = { exitCode: 0 };
    T.emitTargetCommandResponse({ ok: true, result: output }, {
      cmd: 'click',
      format: 'json',
      console: { log: value => stdout.push(value), error() {} },
      process: processLike,
    });
    expect(processLike.exitCode).toBe(1);
    expect(stdout).toEqual([output]);
  });

  it('keeps an expected clipboard no-change and a non-control as success', async () => {
    const clipboard = await clickFeedback({
      dispatchText: 'Clicked <BUTTON> "Copy model name to clipboard"',
    });
    expect(clipboard).toMatch(/^Clicked <BUTTON> "Copy model name to clipboard"/);
    expect(clipboard).not.toMatch(/Kind:/);

    const spacer = await clickFeedback({
      dispatchText: 'Clicked <DIV> "spacer"',
    });
    expect(spacer).toMatch(/^Clicked <DIV> "spacer"/);
    expect(spacer).not.toMatch(/Kind:/);
  });

  it('fails a non-button element whose role is a control', async () => {
    const err = await clickFeedback({
      dispatchText: 'Clicked <DIV> "Save"',
      target: { clickTrust: { tag: 'DIV', role: 'button' } },
    }).catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/Kind: click-no-change/);
  });

  it('stays exit 0 when the page, a checkbox, or a download changed', async () => {
    const changed = await clickFeedback({
      dispatchText: 'Clicked <BUTTON> "Save"',
      domDiff: '+ [StaticText] Saved',
    });
    expect(changed).toMatch(/^Clicked <BUTTON> "Save"/);
    expect(changed).not.toMatch(/Kind:/);

    const toggled = await clickFeedback({
      dispatchText: 'Clicked <INPUT> "Agree"',
      target: { controlStateChanged: true },
    });
    expect(toggled).toMatch(/^Clicked <INPUT> "Agree"/);
    expect(toggled).not.toMatch(/Kind:/);

    const downloaded = await clickFeedback({
      dispatchText: 'Clicked <BUTTON> "Export CSV"',
      enrichActionResult: (result) => {
        result.effects.download = {
          state: 'completed',
          filename: 'report.csv',
          bytes: 12,
          sha256: 'ab',
          path: '/tmp/report.csv',
        };
      },
    });
    expect(downloaded).toMatch(/^Clicked <BUTTON> "Export CSV"/);
    expect(downloaded).not.toMatch(/Kind: click-no-change/);
  });

  it('registers misdirected and click-no-change recovery', () => {
    const kinds = listRecoveryPolicyKinds();
    expect(kinds).toContain('misdirected');
    expect(kinds).toContain('click-no-change');
    const err = new Error('click: the control did not react (Outcome: no-change). Clicked <BUTTON> "Save"');
    err.clickNoChange = { dispatchText: 'Clicked <BUTTON> "Save"' };
    expect(classifyActionFailure(err, {
      action: 'click',
      target: { targetId: TARGET_ID, input: '#save' },
    })).toMatchObject({
      kind: 'click-no-change',
      dispatched: true,
      detailLines: ['Outcome: no-change'],
    });
  });
});
