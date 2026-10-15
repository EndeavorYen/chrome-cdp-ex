import { describe, expect, it } from 'vitest';
import { formatActionControlStateDiff } from '../skills/chrome-cdp-ex/scripts/lib/cdp-input.mjs';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

describe('issue #266 click mouse events must land or fail closed', () => {
  const layoutNoise = '+++ Added (1):\n+   [generic] layout-noise';
  const TARGET_ID = '62E1DF19';

  function createPicky17Page({ deliverMouseEvents = true } = {}) {
    const state = {
      clicks: 0,
      checked: false,
      probeSeen: [],
      mouseTypes: [],
      movedAcked: false,
      pressedWhileMovePending: false,
      probeInstalledOn: null,
    };
    const cdp = {
      calls: [],
      send(method, params = {}, sessionId, timeout) {
        cdp.calls.push({ method, params, sessionId, timeout });
        const probeSource = method === 'Runtime.evaluate'
          ? String(params.expression || '')
          : method === 'Runtime.callFunctionOn'
            ? String(params.functionDeclaration || '')
            : '';
        if (probeSource.includes('__chromeCdpExClickProbe')) {
          const framedNode = method === 'Runtime.callFunctionOn' && params.objectId === 'child-button';
          if (probeSource.includes('installed: true')) {
            state.probeSeen = [];
            state.probeInstalledOn = framedNode ? 'iframe' : 'top';
            return Promise.resolve({
              result: { value: { cdpClickProbe: true, ok: true, installed: true, scope: framedNode ? 'target-document' : 'top' } },
            });
          }
          return Promise.resolve({
            result: { value: { cdpClickProbe: true, ok: true, seen: state.probeSeen.slice() } },
          });
        }
        if (method === 'Runtime.evaluate') {
          const expr = String(params.expression || '');
          if (expr.includes("type === 'checkbox'") || expr.includes('el.checked === true')) {
            return Promise.resolve({
              result: { value: { tag: 'input', type: 'checkbox', id: 'p17cb', checked: state.checked } },
            });
          }
          if (expr === 'location.href' || expr.includes('document.title')) {
            return Promise.resolve({ result: { value: 'https://example.com/' } });
          }
          return Promise.resolve({
            result: {
              value: {
                ok: true,
                x: 51,
                y: 110,
                w: 80,
                h: 24,
                tag: 'BUTTON',
                text: 'p17-click',
              },
            },
          });
        }
        if (method === 'Runtime.callFunctionOn') {
          const fn = String(params.functionDeclaration || '');
          if (fn.includes('this.click()')) {
            state.clicks += 1;
            state.checked = true;
            return Promise.resolve({ result: { value: { tag: 'INPUT', text: 'p17cb' } } });
          }
          if (fn.includes('el.checked === true') || fn.includes("type === 'checkbox'")) {
            return Promise.resolve({
              result: { value: { tag: 'input', type: 'checkbox', id: 'p17cb', checked: state.checked } },
            });
          }
          return Promise.resolve({
            result: {
              value: {
                connected: true,
                x: 51,
                y: 110,
                w: 80,
                h: 24,
                tag: 'BUTTON',
                text: 'p17-click',
              },
            },
          });
        }
        if (method === 'Input.dispatchMouseEvent') {
          state.mouseTypes.push(params.type);
          if (params.type === 'mousePressed' && !state.movedAcked) {
            state.pressedWhileMovePending = true;
          }
          if (params.type === 'mouseMoved') state.movedAcked = true;
          const pressOrRelease = params.type === 'mousePressed' || params.type === 'mouseReleased';
          if (pressOrRelease && Number(timeout) < T.CLICK_MOUSE_ACK_TIMEOUT_MS) {
            return Promise.reject(new Error('Timeout: Input.dispatchMouseEvent'));
          }
          if (deliverMouseEvents) {
            if (params.type === 'mousePressed') state.probeSeen.push('mousedown', 'pointerdown');
            if (params.type === 'mouseReleased') {
              state.probeSeen.push('mouseup', 'pointerup', 'click');
              state.clicks += 1;
              state.checked = true;
            }
          }
          return Promise.resolve({});
        }
        if (method === 'DOM.enable') return Promise.resolve({});
        if (method === 'DOM.getDocument') return Promise.resolve({ root: { nodeId: 1 } });
        if (method === 'DOM.querySelector') return Promise.resolve({ nodeId: 2 });
        if (method === 'DOM.resolveNode') {
          if (params.backendNodeId === 222) return Promise.resolve({ object: { objectId: 'child-button' } });
          if (params.backendNodeId === 333) return Promise.resolve({ object: { objectId: 'frame-owner' } });
          return Promise.resolve({ object: { objectId: 'el-p17' } });
        }
        if (method === 'DOM.getFrameOwner') {
          return Promise.resolve({ backendNodeId: 333 });
        }
        if (method === 'Page.getFrameTree') {
          return Promise.resolve({ frameTree: { frame: { id: 'mock-root-frame' } } });
        }
        if (method === 'Page.createIsolatedWorld') {
          return Promise.resolve({ executionContextId: 901 });
        }
        return Promise.resolve({});
      },
    };
    return { cdp, state };
  }

  function formControlActionFeedback(cdp, { observeText, refMap = new Map(), refState = {} } = {}) {
    return async (action, actionDispatch, target = {}, _policy, _observe, format = 'text') => {
      const actionTarget = { ...target, targetId: target.targetId || TARGET_ID };
      const dispatch = async () => {
        const snapshotControls = T.shouldSnapshotFormControlState(action, actionTarget);
        const beforeControl = snapshotControls
          ? await T.snapshotFormControlState(cdp, 'sid', actionTarget.input, refMap, refState)
          : null;
        const text = await actionDispatch();
        if (snapshotControls) {
          const afterControl = await T.snapshotFormControlState(cdp, 'sid', actionTarget.input, refMap, refState);
          if (T.formControlStateChanged(beforeControl, afterControl)) {
            actionTarget.controlStateChanged = true;
            actionTarget.controlStateDiff = formatActionControlStateDiff(cdp, 'sid', actionTarget.input, refState, beforeControl, afterControl);
          }
        }
        return text;
      };
      return T.runActionWithFeedback({
        action,
        target: actionTarget,
        dispatch,
        feedbackPolicy: 'settle-diff',
        observe: async () => observeText,
        format,
      });
    };
  }

  async function clickJsonCommand(cdp, args, extras = {}) {
    const refMap = extras.refMap || new Map();
    const refState = extras.refState || {};
    const handler = T.createClickCommandHandler({
      actionFeedback: formControlActionFeedback(cdp, { ...extras, refMap, refState }),
      click: selector => T.clickStr(cdp, 'sid', selector, refMap, refState),
      jsClick: selector => T.jsClickStr(cdp, 'sid', selector, refMap, refState),
    });
    const result = await handler({ args: [...args, '--format', 'json'] });
    return JSON.parse(result.value);
  }

  it('#266 mouse click receipt is Outcome:changed from the real form-control snapshot', async () => {
    const { cdp, state } = createPicky17Page();
    const receipt = await clickJsonCommand(cdp, ['#p17cb'], {
      observeText: '(no changes detected in AX tree)',
    });

    expect(state.clicks).toBe(1);
    expect(state.checked).toBe(true);
    expect(state.probeSeen).toContain('click');
    expect(receipt.dispatch.ok).toBe(true);
    expect(receipt.target.controlStateChanged).toBe(true);
    expect(receipt.outcome).toMatchObject({ status: 'changed', changed: true });
  });

  it('#266 mouse click with no page events fails closed through runActionWithFeedback', async () => {
    const { cdp, state } = createPicky17Page({ deliverMouseEvents: false });
    const receipt = await clickJsonCommand(cdp, ['#p17cb'], { observeText: layoutNoise });

    expect(state.clicks).toBe(0);
    expect(state.checked).toBe(false);
    expect(receipt.dispatch.ok).toBe(false);
    expect(receipt.effects.failure.kind).toBe('no-input-events');
    expect(receipt.outcome.status).not.toBe('changed');
    expect(receipt.outcome).toMatchObject({ status: 'failed', changed: false });
    expect(receipt.effects.failure.nextCommand).toBe(`cdp jsclick ${TARGET_ID} "#p17cb"`);
    expect(receipt.effects.diagnosis.nextCommand).toBe(`cdp jsclick ${TARGET_ID} "#p17cb"`);
    expect(state.mouseTypes).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased']);

    const jsReceipt = await clickJsonCommand(cdp, ['--js', '#p17cb'], {
      observeText: '(no changes detected in AX tree)',
    });
    expect(state.clicks).toBe(1);
    expect(state.checked).toBe(true);
    expect(state.mouseTypes).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased']);
    expect(jsReceipt.dispatch.ok).toBe(true);
    expect(jsReceipt.target.controlStateChanged).toBe(true);
    expect(jsReceipt.outcome).toMatchObject({ status: 'changed', changed: true });
  });

  it('#266 clickxy --format json with no page events also fails closed', async () => {
    const { cdp, state } = createPicky17Page({ deliverMouseEvents: false });
    const receipt = JSON.parse(await T.runActionWithFeedback({
      action: 'clickxy',
      target: { targetId: TARGET_ID, input: '51,110', resolvedBy: 'coordinates', label: '51,110' },
      dispatch: () => T.clickXyStr(cdp, 'sid', 51, 110),
      feedbackPolicy: 'settle-diff',
      observe: async () => layoutNoise,
      format: { format: 'json' },
    }));
    expect(state.clicks).toBe(0);
    expect(receipt.dispatch.ok).toBe(false);
    expect(receipt.effects.failure.kind).toBe('no-input-events');
    expect(receipt.outcome.status).not.toBe('changed');
    expect(cdp.calls.some(call => call.method === 'Input.dispatchMouseEvent' && call.params.type === 'mousePressed')).toBe(true);
  });

  it('#266 probe not installed + 250ms swallow fails closed', async () => {
    const events = [];
    await expect(T.dispatchClick({
      send(method, params = {}, _sessionId, timeoutMs) {
        if (method === 'Input.dispatchMouseEvent') {
          events.push({ ...params, timeoutMs });
          return Promise.reject(new Error('Timeout: Input.dispatchMouseEvent'));
        }
        return Promise.resolve({});
      },
    }, 'sid', 40, 20)).rejects.toThrow(/received no mousedown\/click events/);
    expect(events).toHaveLength(3);
    expect(events[0].timeoutMs).toBe(T.HOVER_MOUSE_ACK_TIMEOUT_MS);
    expect(events[1].timeoutMs).toBe(T.CLICK_MOUSE_ACK_TIMEOUT_MS);
    expect(events[2].timeoutMs).toBe(T.CLICK_MOUSE_ACK_TIMEOUT_MS);
  });

  it('#266 250ms compositor-ack swallow does not deliver page events and fails closed', async () => {
    const { cdp, state } = createPicky17Page();
    const originalSend = cdp.send.bind(cdp);
    cdp.send = (method, params = {}, sessionId, timeout) => {
      if (method === 'Input.dispatchMouseEvent' && (params.type === 'mousePressed' || params.type === 'mouseReleased')) {
        return originalSend(method, params, sessionId, T.HOVER_MOUSE_ACK_TIMEOUT_MS);
      }
      return originalSend(method, params, sessionId, timeout);
    };
    const receipt = await clickJsonCommand(cdp, ['#p17cb'], { observeText: layoutNoise });
    expect(receipt.dispatch.ok).toBe(false);
    expect(receipt.effects.failure.kind).toBe('no-input-events');
    expect(state.clicks).toBe(0);
    expect(state.checked).toBe(false);
    expect(state.probeSeen).toEqual([]);
  });

  it('#266 CLI Next for no-input-events includes the selector', () => {
    const message = 'click: Input.dispatchMouseEvent completed but the page received no mousedown/click events at (51, 110) for #p17cb. The mouse path failed closed. Try jsclick or click --js.';
    const cli = T.formatCliError(new Error(message), {
      cmd: 'click',
      targetPrefix: TARGET_ID,
      args: ['#p17cb'],
    });
    expect(cli).toMatch(/Kind: no-input-events/);
    expect(cli).toMatch(new RegExp(`Next: cdp jsclick ${TARGET_ID} "#p17cb"`));
    expect(cli).not.toMatch(new RegExp(`Next: cdp jsclick ${TARGET_ID}$`, 'm'));
  });

  it('#266 framed @f2:1 probes the iframe document and succeeds when the iframe handler ran', async () => {
    const { cdp, state } = createPicky17Page();
    const refState = {
      frameRefs: new Map([
        ['@f2', {
          frameRef: '@f2',
          frameId: 'checkout-frame',
          parentId: 'main-frame',
          refs: new Map([[1, 222]]),
        }],
      ]),
    };
    const originalSend = cdp.send.bind(cdp);
    cdp.send = (method, params = {}, sessionId, timeout) => {
      if (method === 'Runtime.callFunctionOn' && params.objectId === 'frame-owner') {
        cdp.calls.push({ method, params, sessionId, timeout });
        return Promise.resolve({ result: { value: { x: 50, y: 40, w: 300, h: 200 } } });
      }
      if (method === 'Runtime.callFunctionOn' && params.objectId === 'child-button') {
        cdp.calls.push({ method, params, sessionId, timeout });
        const fn = String(params.functionDeclaration || '');
        if (fn.includes('__chromeCdpExClickProbe') && fn.includes('installed: true')) {
          state.probeSeen = [];
          state.probeInstalledOn = 'iframe';
          return Promise.resolve({
            result: { value: { cdpClickProbe: true, ok: true, installed: true, scope: 'target-document' } },
          });
        }
        if (fn.includes('__chromeCdpExClickProbe')) {
          return Promise.resolve({
            result: { value: { cdpClickProbe: true, ok: true, seen: state.probeSeen.slice() } },
          });
        }
        if (fn.includes('requestAnimationFrame') || fn.includes('getBoundingClientRect')) {
          return Promise.resolve({
            result: { value: { connected: true, x: 10, y: 5, w: 100, h: 20, tag: 'BUTTON', text: 'Pay now' } },
          });
        }
      }
      return originalSend(method, params, sessionId, timeout);
    };

    const receipt = await clickJsonCommand(cdp, ['@f2:1'], {
      observeText: '(no changes detected in AX tree)',
      refState,
    });
    expect(state.probeInstalledOn).toBe('iframe');
    expect(state.clicks).toBe(1);
    expect(receipt.dispatch.ok).toBe(true);
    expect(receipt.outcome.status).not.toBe('failed');
    expect(cdp.calls.some(call => (
      call.method === 'Runtime.callFunctionOn'
      && call.params.objectId === 'child-button'
      && String(call.params.functionDeclaration || '').includes('__chromeCdpExClickProbe')
    ))).toBe(true);
  });

  it('#266 framed @f2:1 does not fail-close from a top-level empty seen', async () => {
    const { cdp, state } = createPicky17Page();
    const refState = {
      frameRefs: new Map([
        ['@f2', {
          frameRef: '@f2',
          frameId: 'checkout-frame',
          parentId: 'main-frame',
          refs: new Map([[1, 222]]),
        }],
      ]),
    };
    const originalSend = cdp.send.bind(cdp);
    cdp.send = (method, params = {}, sessionId, timeout) => {
      if (method === 'DOM.resolveNode' && params.backendNodeId === 222 && params.executionContextId == null) {
        cdp.calls.push({ method, params, sessionId, timeout });
        return Promise.reject(new Error('page-world object unavailable'));
      }
      const expr = method === 'Runtime.evaluate' ? String(params.expression || '') : '';
      if (expr.includes('__chromeCdpExClickProbe')) {
        cdp.calls.push({ method, params, sessionId, timeout });
        if (expr.includes('installed: true')) {
          state.probeSeen = [];
          state.probeInstalledOn = 'top';
          return Promise.resolve({
            result: { value: { cdpClickProbe: true, ok: true, installed: true, scope: 'top' } },
          });
        }
        return Promise.resolve({
          result: { value: { cdpClickProbe: true, ok: true, seen: [] } },
        });
      }
      return originalSend(method, params, sessionId, timeout);
    };

    const receipt = await clickJsonCommand(cdp, ['@f2:1'], {
      observeText: '(no changes detected in AX tree)',
      refState,
    });
    expect(state.probeInstalledOn).toBe('top');
    expect(state.clicks).toBe(1);
    expect(receipt.dispatch.ok).toBe(true);
    expect(receipt.outcome.status).not.toBe('failed');
  });

  it('#266 sends mousePressed before mouseMoved compositor ack resolves', async () => {
    const { cdp, state } = createPicky17Page();
    let movedResolve;
    const originalSend = cdp.send.bind(cdp);
    cdp.send = (method, params = {}, sessionId, timeout) => {
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseMoved') {
        state.mouseTypes.push('mouseMoved');
        cdp.calls.push({ method, params, sessionId, timeout });
        return new Promise(resolve => {
          movedResolve = () => {
            state.movedAcked = true;
            resolve({});
          };
        });
      }
      return originalSend(method, params, sessionId, timeout);
    };

    const pending = T.dispatchClick(cdp, 'sid', 51, 110);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(state.mouseTypes.slice(0, 2)).toEqual(['mouseMoved', 'mousePressed']);
    expect(state.pressedWhileMovePending).toBe(true);
    expect(state.movedAcked).toBe(false);
    movedResolve();
    await pending;
    expect(state.clicks).toBe(1);
  });
});
