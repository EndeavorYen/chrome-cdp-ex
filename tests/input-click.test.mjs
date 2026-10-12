import { describe, it, expect, vi } from 'vitest';
import { createMockCDP } from './mock-cdp.mjs';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
const { buildPerceiveTree, clickStr } = T;

// =========================================================================
// CDP mock helper — lightweight fake for testing command functions
// =========================================================================


// =========================================================================
// clickStr (with CDP mock)
// =========================================================================

describe('clickStr', () => {
  it('should click element by CSS selector', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': (params) => {
        expect(params.expression).toContain('requestAnimationFrame');
        expect(params.expression).toContain('maxSamples = fullyVisible ? 2 : 60');
        expect(params.expression).toContain('currentVisible && stableSamples >= 2');
        return { result: { value: { ok: true, x: 100, y: 200, tag: 'BUTTON', text: 'Submit' } } };
      },
      'Input.dispatchMouseEvent': () => ({}),
    });
    const result = await clickStr(cdp, 'sid1', '.btn-submit', new Map());
    expect(result).toContain('Clicked');
    expect(result).toContain('BUTTON');
    expect(result).toContain('Submit');
  });

  it('should click element by @ref', async () => {
    const refMap = new Map([[1, 101]]);
    const cdp = createMockCDP({
      'DOM.resolveNode': () => ({ object: { objectId: 'obj-1' } }),
      'Runtime.callFunctionOn': (params) => {
        expect(params.functionDeclaration).toContain('requestAnimationFrame');
        expect(params.functionDeclaration).toContain('maxSamples = fullyVisible ? 2 : 60');
        expect(params.functionDeclaration).toContain('currentVisible && stableSamples >= 2');
        expect(params.awaitPromise).toBe(true);
        return { result: { value: { connected: true, x: 50, y: 60, w: 100, h: 40, tag: 'A', text: 'Link' } } };
      },
      'Input.dispatchMouseEvent': () => ({}),
    });
    const result = await clickStr(cdp, 'sid1', '@1', refMap);
    expect(result).toContain('Clicked');
    expect(result).toContain('@1');
  });

  it('fails a detached @ref after replaceChildren before dispatch or pre-action churn observation', async () => {
    const oldNodes = [
      { nodeId: 'root-0', role: { value: 'RootWebArea' }, name: { value: 'Reviews' }, childIds: ['alpha-0'] },
      { nodeId: 'alpha-0', parentId: 'root-0', role: { value: 'button' }, name: { value: 'Review Alpha' }, backendDOMNodeId: 101 },
    ];
    const freshNodes = [
      { nodeId: 'root-1', role: { value: 'RootWebArea' }, name: { value: 'Reviews' }, childIds: ['charlie-1', 'alpha-1', 'bravo-1'] },
      { nodeId: 'charlie-1', parentId: 'root-1', role: { value: 'button' }, name: { value: 'Review Charlie' }, backendDOMNodeId: 201 },
      { nodeId: 'alpha-1', parentId: 'root-1', role: { value: 'button' }, name: { value: 'Review Alpha' }, backendDOMNodeId: 202 },
      { nodeId: 'bravo-1', parentId: 'root-1', role: { value: 'button' }, name: { value: 'Review Bravo' }, backendDOMNodeId: 203 },
    ];
    const refMap = new Map();
    const refState = { generation: 1, invalidationReason: null };
    const meta = { layoutMap: {}, styleHints: {} };
    buildPerceiveTree(oldNodes, meta, refMap);
    expect(refMap.get(1)).toBe(101);

    // Harness-only replaceChildren: the old backend node still resolves, but is detached.
    const appAttempts = [];
    const currentTargets = [
      { name: 'Review Charlie', x: 40, y: 20, w: 120, h: 32 },
      { name: 'Review Alpha', x: 40, y: 72, w: 120, h: 32 },
      { name: 'Review Bravo', x: 40, y: 124, w: 120, h: 32 },
    ];
    const connectedObjects = new Set(['fresh-charlie', 'fresh-alpha', 'fresh-bravo']);
    const cdp = createMockCDP({
      'Runtime.callFunctionOn:trusted-connectivity': ({ objectId }) => ({
        result: { value: { connected: connectedObjects.has(objectId) } },
      }),
      'DOM.resolveNode': ({ backendNodeId }) => ({
        object: {
          objectId: backendNodeId === 101
            ? 'detached-alpha'
            : backendNodeId === 202 ? 'fresh-alpha'
            : backendNodeId === 203 ? 'fresh-bravo' : 'fresh-charlie',
        },
      }),
      'Runtime.callFunctionOn': ({ objectId, functionDeclaration }) => {
        if (objectId === 'detached-alpha') {
          return { result: { value: {
            ...(functionDeclaration.includes('isConnected') ? { connected: false } : {}),
            x: 0, y: 0, w: 0, h: 0, tag: 'BUTTON', text: 'Review Alpha',
          } } };
        }
        return { result: { value: {
          ...(functionDeclaration.includes('isConnected') ? { connected: true } : {}),
          x: 40, y: 72, w: 120, h: 32, tag: 'BUTTON', text: 'Review Alpha',
        } } };
      },
      'Input.dispatchMouseEvent': ({ type, x, y }) => {
        if (type === 'mouseReleased') {
          const target = currentTargets.find(entry => (
            x >= entry.x && x <= entry.x + entry.w && y >= entry.y && y <= entry.y + entry.h
          ));
          if (target) appAttempts.push(target.name);
        }
        return {};
      },
    });
    const observe = vi.fn(async () => '+++ Added\n+ [button] Review Charlie @1');
    let captured = null;
    const output = await T.runActionWithFeedback({
      action: 'click',
      target: { targetId: 'ABC12345', input: '@1', resolvedBy: 'selector-or-ref', label: '@1' },
      dispatch: () => clickStr(cdp, 'sid1', '@1', refMap, refState),
      feedbackPolicy: 'settle-diff',
      observe,
      onActionResult: result => { captured = result; },
      format: { format: 'json', compact: true },
    });
    const result = JSON.parse(output);
    const processLike = { exitCode: 0, platform: 'darwin' };
    T.emitTargetCommandResponse({ ok: true, result: output }, {
      cmd: 'click',
      targetPrefix: 'ABC12345',
      format: 'json',
      console: { log: () => {}, error: () => {} },
      process: processLike,
    });

    expect(result.dispatch).toMatchObject({ ok: false, method: 'click' });
    expect(result.effects).toMatchObject({
      domDiff: null,
      failure: {
        kind: 'stale-ref',
        nextCommand: 'cdp perceive ABC12345 -C -d 8',
      },
    });
    expect(result.outcome).toMatchObject({ status: 'failed', changed: false });
    expect(captured.dispatch.ok).toBe(false);
    expect(cdp.calls.filter(call => call.method.startsWith('Input.dispatch'))).toEqual([]);
    expect(appAttempts).toEqual([]);
    expect(observe).not.toHaveBeenCalled();
    expect(processLike.exitCode).toBe(1);

    // A fresh perceive replaces, rather than remaps, the stale ref authority.
    buildPerceiveTree(freshNodes, meta, refMap);
    expect([...refMap.entries()]).toEqual([[1, 201], [2, 202], [3, 203]]);
    expect(refMap.get(2)).toBe(202);
    await clickStr(cdp, 'sid1', '@2', refMap, refState);
    expect(appAttempts).toEqual(['Review Alpha']);
  });

  it('should click cursor-interactive @c refs using saved viewport coordinates', async () => {
    const refMap = new Map([
      ['c2', { x: 10, y: 20, w: 30, h: 40, sel: 'svg', text: 'Remove image' }],
    ]);
    const cdp = createMockCDP({
      'Input.dispatchMouseEvent': () => ({}),
    });
    const result = await clickStr(cdp, 'sid1', '@c2', refMap);
    const pressed = cdp.calls.find(call => call.method === 'Input.dispatchMouseEvent' && call.params.type === 'mousePressed');

    expect(result).toBe('Clicked <svg> "Remove image" (@c2)');
    expect(pressed.params).toMatchObject({ x: 25, y: 40 });
  });

  it('should throw when element not found by CSS selector', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({
        result: { value: { ok: false, error: 'Element not found: .missing' } },
      }),
    });
    await expect(clickStr(cdp, 'sid1', '.missing', new Map()))
      .rejects.toThrow('Element not found');
  });

  it('should throw on unknown @ref', async () => {
    const refMap = new Map(); // empty
    const cdp = createMockCDP({});
    await expect(clickStr(cdp, 'sid1', '@99', refMap))
      .rejects.toThrow(/Unknown ref/);
  });

  it('should throw when no selector provided', async () => {
    const cdp = createMockCDP({});
    await expect(clickStr(cdp, 'sid1', undefined, new Map()))
      .rejects.toThrow(/selector.*required/i);
  });

  it('should dispatch mouseMoved, mousePressed, mouseReleased in order', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({
        result: { value: { ok: true, x: 10, y: 20, tag: 'DIV', text: 'x' } },
      }),
      'Input.dispatchMouseEvent': () => ({}),
    });
    await clickStr(cdp, 'sid1', '.el', new Map());
    const mouseEvents = cdp.calls
      .filter(c => c.method === 'Input.dispatchMouseEvent')
      .map(c => c.params);
    expect(mouseEvents.map(params => params.type)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased']);
    expect(mouseEvents[0]).toMatchObject({ type: 'mouseMoved', button: 'none', buttons: 0, pointerType: 'mouse' });
    expect(mouseEvents[1]).toMatchObject({ type: 'mousePressed', button: 'left', buttons: 1, pointerType: 'mouse' });
    expect(mouseEvents[2]).toMatchObject({ type: 'mouseReleased', button: 'left', buttons: 0, pointerType: 'mouse' });
  });

  it('follows an <a href> when location.href changes after the realistic click', async () => {
    let href = 'https://example.com/';
    const cdp = createMockCDP({
      'Runtime.evaluate': (params) => {
        if (String(params.expression) === 'location.href') {
          return { result: { value: href } };
        }
        return {
          result: {
            value: {
              ok: true,
              x: 40,
              y: 20,
              tag: 'A',
              text: 'Learn more',
              href: 'https://www.iana.org/help/example-domains',
              pageHref: 'https://example.com/',
            },
          },
        };
      },
      'Input.dispatchMouseEvent': ({ type }) => {
        if (type === 'mouseReleased') href = 'https://www.iana.org/help/example-domains';
        return {};
      },
    });
    await expect(clickStr(cdp, 'sid1', 'a', new Map()))
      .resolves.toBe('Clicked <A> "Learn more"');
    expect(cdp.calls.some(call => call.method === 'Input.dispatchMouseEvent' && call.params.buttons === 1)).toBe(true);
  });

  it('fails fast when an <a href> click does not navigate', async () => {
    const started = Date.now();
    const cdp = createMockCDP({
      'Runtime.evaluate': (params) => {
        if (String(params.expression) === 'location.href') {
          return { result: { value: 'https://example.com/' } };
        }
        return {
          result: {
            value: {
              ok: true,
              x: 40,
              y: 20,
              tag: 'A',
              text: 'Learn more',
              href: 'https://www.iana.org/help/example-domains',
              pageHref: 'https://example.com/',
            },
          },
        };
      },
      'Input.dispatchMouseEvent': () => ({}),
    });
    await expect(clickStr(cdp, 'sid1', 'a', new Map()))
      .rejects.toThrow(/did not navigate/);
    expect(Date.now() - started).toBeLessThanOrEqual(750);
  });
});

// =========================================================================
// jsClickStr — explicit JS-fallback click via HTMLElement.click()
// =========================================================================

describe('jsClickStr', () => {
  const { jsClickStr } = T;

  it('calls HTMLElement.click() through Runtime.callFunctionOn for @ref targets', async () => {
    let fnDecl = '';
    const refMap = new Map([[1, 555]]);
    const cdp = createMockCDP({
      'DOM.resolveNode': () => ({ object: { objectId: 'obj-555' } }),
      'Runtime.callFunctionOn': (params) => {
        fnDecl = params.functionDeclaration;
        return { result: { value: { tag: 'BUTTON', text: 'OK' } } };
      },
    });
    const out = await jsClickStr(cdp, 'sid', '@1', refMap, { generation: 1 });
    expect(out).toMatch(/JS-clicked <BUTTON> "OK" \(@1\)/);
    expect(fnDecl).toMatch(/this\.click\(\)/);
    // No mouse events should have been dispatched in JS-fallback mode
    expect(cdp.calls.find(c => c.method === 'Input.dispatchMouseEvent')).toBeUndefined();
  });

  it('resolves CSS selectors to node objects and calls HTMLElement.click()', async () => {
    let fnDecl = '';
    const cdp = createMockCDP({
      'DOM.enable': () => ({}),
      'DOM.getDocument': () => ({ root: { nodeId: 1 } }),
      'DOM.querySelector': (params) => {
        expect(params.selector).toBe('a.help');
        return { nodeId: 77 };
      },
      'DOM.resolveNode': () => ({ object: { objectId: 'obj-77' } }),
      'Runtime.callFunctionOn': (params) => {
        expect(params.objectId).toBe('obj-77');
        fnDecl = params.functionDeclaration;
        return { result: { value: { tag: 'A', text: 'Help' } } };
      },
    });
    const out = await jsClickStr(cdp, 'sid', 'a.help', new Map());
    expect(out).toMatch(/JS-clicked <A> "Help"/);
    expect(fnDecl).toMatch(/this\.click\(\)/);
  });

  it('throws when the CSS selector does not match', async () => {
    const cdp = createMockCDP({
      'DOM.enable': () => ({}),
      'DOM.getDocument': () => ({ root: { nodeId: 1 } }),
      'DOM.querySelector': () => ({ nodeId: 0 }),
    });
    await expect(jsClickStr(cdp, 'sid', '.nope', new Map())).rejects.toThrow(/Element not found/);
  });

  it('throws on unknown @ref with a refState-aware message', async () => {
    const refMap = new Map();
    const refState = { generation: 0, invalidationReason: 'daemon-start' };
    const cdp = createMockCDP({});
    await expect(jsClickStr(cdp, 'sid', '@99', refMap, refState))
      .rejects.toThrow(/No refs have been assigned/);
  });

  it('rejects empty selector', async () => {
    const cdp = createMockCDP({});
    await expect(jsClickStr(cdp, 'sid', undefined, new Map())).rejects.toThrow(/selector.*required/i);
  });
});
