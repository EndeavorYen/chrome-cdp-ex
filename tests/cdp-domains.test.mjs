import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

import {
  bindCdpTransport,
  CDP_METHODS,
  createCdpDomains,
  createRawCdpGateway,
} from '../skills/chrome-cdp-ex/scripts/lib/cdp-domains.mjs';
import {
  commandResult,
  createCommandRegistry,
  defineCommandSpec,
  executeCommand,
} from '../skills/chrome-cdp-ex/scripts/lib/command-application.mjs';

const domainSource = readFileSync(fileURLToPath(new URL(
  '../skills/chrome-cdp-ex/scripts/lib/cdp-domains.mjs', import.meta.url,
)), 'utf8');

const EXPECTED_METHODS = Object.freeze([
  'Accessibility.getFullAXTree',
  'CSS.enable',
  'CSS.getComputedStyleForNode',
  'CSS.getMatchedStylesForNode',
  'CSS.getStyleSheetText',
  'DOM.describeNode',
  'DOM.enable',
  'DOM.getDocument',
  'DOM.getFrameOwner',
  'DOM.pushNodesByBackendIdsToFrontend',
  'DOM.querySelector',
  'DOM.querySelectorAll',
  'DOM.resolveNode',
  'DOM.setFileInputFiles',
  'Emulation.setDeviceMetricsOverride',
  'Emulation.setEmulatedMedia',
  'Fetch.continueRequest',
  'Fetch.disable',
  'Fetch.enable',
  'Fetch.fulfillRequest',
  'Input.dispatchKeyEvent',
  'Input.dispatchMouseEvent',
  'Input.insertText',
  'Network.deleteCookies',
  'Network.emulateNetworkConditions',
  'Network.enable',
  'Network.getCookies',
  'Network.setCookie',
  'Page.addScriptToEvaluateOnNewDocument',
  'Page.captureScreenshot',
  'Page.createIsolatedWorld',
  'Page.enable',
  'Page.getFrameTree',
  'Page.getLayoutMetrics',
  'Page.getNavigationHistory',
  'Page.handleJavaScriptDialog',
  'Page.navigate',
  'Page.navigateToHistoryEntry',
  'Page.reload',
  'Page.removeScriptToEvaluateOnNewDocument',
  'Page.screencastFrameAck',
  'Page.startScreencast',
  'Page.stopScreencast',
  'Performance.enable',
  'Performance.getMetrics',
  'Runtime.callFunctionOn',
  'Runtime.enable',
  'Runtime.evaluate',
  'Runtime.releaseObjectGroup',
  'Target.activateTarget',
  'Target.attachToTarget',
  'Target.closeTarget',
  'Target.createTarget',
  'Target.getTargets',
]);

function adapter(send = vi.fn(async () => ({ ok: true }))) {
  return { send };
}

function rawSpec() {
  return defineCommandSpec({
    name: 'evalraw',
    aliases: [],
    needsTarget: true,
    mutates: false,
    feedbackPolicy: null,
    outputFormats: ['text'],
    kind: 'raw-cdp',
    authorization: 'raw-cdp',
    evidencePolicy: 'raw-audit',
  });
}

describe('CDP domain clients', () => {
  it('owns the exact characterized method inventory', () => {
    expect(CDP_METHODS).toEqual(EXPECTED_METHODS);
    expect(Object.isFrozen(CDP_METHODS)).toBe(true);

    const clients = createCdpDomains(adapter());
    expect(Object.keys(clients)).toEqual([
      'Accessibility', 'CSS', 'DOM', 'Emulation', 'Fetch', 'Input',
      'Network', 'Page', 'Performance', 'Runtime', 'Target',
    ]);
    for (const method of EXPECTED_METHODS) {
      const [domain, operation] = method.split('.');
      expect(typeof clients[domain][operation], method).toBe('function');
    }
    expect(clients.Runtime.notARealMethod).toBeUndefined();
    expect(clients.NotARealDomain).toBeUndefined();
    expect(Object.isFrozen(clients)).toBe(true);
    expect(Object.values(clients).every(Object.isFrozen)).toBe(true);
  });

  it('preserves exact argument presence, session, timeout, return, and error identity', async () => {
    const sentinelResult = Object.freeze({ targetInfos: [] });
    const send = vi.fn(async () => sentinelResult);
    const clients = createCdpDomains(adapter(send));

    await expect(clients.Target.getTargets()).resolves.toBe(sentinelResult);
    expect(send).toHaveBeenLastCalledWith('Target.getTargets');

    const params = Object.freeze({ expression: '1 + 1' });
    await clients.Runtime.evaluate(params, undefined, 321);
    expect(send).toHaveBeenLastCalledWith('Runtime.evaluate', params, undefined, 321);

    await clients.Page.enable({}, 'SESSION');
    expect(send).toHaveBeenLastCalledWith('Page.enable', {}, 'SESSION');

    const sentinelError = new Error('transport sentinel');
    send.mockRejectedValueOnce(sentinelError);
    await expect(clients.DOM.getDocument({}, 'SESSION')).rejects.toBe(sentinelError);
  });

  it('rejects accessor, prototype-backed, sparse, and malformed call arguments before transport', () => {
    const send = vi.fn();
    const clients = createCdpDomains(adapter(send));
    let reads = 0;
    const accessorParams = {};
    Object.defineProperty(accessorParams, 'expression', {
      enumerable: true,
      get() { reads += 1; return '1 + 1'; },
    });
    expect(() => clients.Runtime.evaluate(accessorParams, 'SESSION')).toThrow(/data property/);
    expect(reads).toBe(0);

    expect(() => clients.Runtime.evaluate(Object.create({ expression: '1 + 1' }), 'SESSION'))
      .toThrow(/plain data object/);
    expect(() => clients.Runtime.callFunctionOn({
      arguments: [Object.create({ value: 1 })],
    }, 'SESSION')).toThrow(/plain data object/);
    expect(() => clients.Runtime.callFunctionOn({ arguments: new Array(1) }, 'SESSION'))
      .toThrow(/sparse/);
    expect(() => clients.Runtime.evaluate({ expression: () => '1 + 1' }, 'SESSION'))
      .toThrow(/JSON-compatible/);
    expect(() => clients.Runtime.evaluate({ expression: undefined }, 'SESSION'))
      .toThrow(/JSON-compatible/);
    expect(() => clients.Runtime.evaluate({ expression: Infinity }, 'SESSION'))
      .toThrow(/JSON-compatible/);
    const hidden = {};
    Object.defineProperty(hidden, 'expression', { value: '1 + 1' });
    expect(() => clients.Runtime.evaluate(hidden, 'SESSION')).toThrow(/enumerable/);
    expect(() => clients.Runtime.callFunctionOn({ arguments: Array(10_001).fill(0) }, 'SESSION'))
      .toThrow(/maximum data size/);
    expect(() => clients.Runtime.evaluate(Object.fromEntries(
      Array.from({ length: 10_001 }, (_, index) => [`k${index}`, index]),
    ), 'SESSION')).toThrow(/maximum data size/);
    expect(() => Reflect.apply(clients.Runtime.evaluate, null, new Array(3)))
      .toThrow(/params/);
    expect(() => clients.Runtime.evaluate({}, 'SESSION', 0)).toThrow(/timeout/);
    expect(() => clients.Runtime.evaluate({}, 42)).toThrow(/session/);
    expect(() => clients.Runtime.evaluate({}, 'SESSION', 100, 'extra')).toThrow(/at most/);
    expect(send).not.toHaveBeenCalled();
  });

  it('is stateless across concurrent calls', async () => {
    const pending = new Map();
    const send = vi.fn((method, params) => new Promise(resolve => pending.set(params.id, { method, resolve })));
    const clients = createCdpDomains(adapter(send));
    const first = clients.Runtime.evaluate({ id: 1 }, 'A');
    const second = clients.Page.navigate({ id: 2 }, 'B');

    pending.get(2).resolve('second');
    pending.get(1).resolve('first');
    await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second']);
    expect(send.mock.calls).toEqual([
      ['Runtime.evaluate', { id: 1 }, 'A'],
      ['Page.navigate', { id: 2 }, 'B'],
    ]);
  });

  it('rejects accessor, inherited, symbolic, and embellished transports before effects', () => {
    let reads = 0;
    const accessor = {};
    Object.defineProperty(accessor, 'send', { enumerable: true, get() { reads += 1; return vi.fn(); } });
    expect(() => createCdpDomains(accessor)).toThrow(/data property/);
    expect(reads).toBe(0);

    expect(() => createCdpDomains(Object.create({ send: vi.fn() }))).toThrow(/own data property/);
    expect(() => createCdpDomains({ send: vi.fn(), extra: true })).toThrow(/not allowed/);
    expect(() => createCdpDomains({ send: vi.fn(), [Symbol('send')]: true })).toThrow(/symbol/);
    expect(() => createCdpDomains({ send: 'not-a-function' })).toThrow(/function/);

    const boundAccessor = {};
    Object.defineProperty(boundAccessor, 'send', { get() { reads += 1; return vi.fn(); } });
    expect(() => bindCdpTransport(boundAccessor)).toThrow(/accessor/);
    expect(reads).toBe(0);

    const inheritedSend = vi.fn();
    const bound = bindCdpTransport(Object.create({ send: inheritedSend }));
    expect(Reflect.ownKeys(bound)).toEqual(['send']);
    bound.send('Target.getTargets');
    expect(inheritedSend).toHaveBeenCalledWith('Target.getTargets');
  });

  it('keeps all fixed and raw transport effects behind one reviewed dispatcher', () => {
    expect([...domainSource.matchAll(/\bsend\(([^\n]+)\)/g)].map(match => match[1])).toEqual([
      'method, ...args',
    ]);
  });

  it('creates a raw gateway only from the authorization minted after command authorization', async () => {
    const send = vi.fn(async () => ({ value: 7 }));
    const registry = createCommandRegistry([rawSpec()]);
    let capturedAuthorization;
    const execution = await executeCommand({
      name: 'evalraw',
      args: ['Runtime.evaluate', '{"expression":"1 + 6"}'],
      targetBound: true,
    }, {
      registry,
      authorize: vi.fn(async () => ({ allowed: true, code: 'test-approved' })),
      handlers: {
        evalraw: async ({ authorization }) => {
          capturedAuthorization = authorization;
          const gateway = createRawCdpGateway(adapter(send), authorization);
          const value = await gateway.execute({ expression: '1 + 6' }, 'SESSION');
          return commandResult(JSON.stringify(value), {
            kind: 'raw-audit',
            method: gateway.method,
            sideEffectClass: gateway.sideEffectClass,
          });
        },
      },
    });

    expect(execution.value).toBe('{"value":7}');
    expect(execution.evidence).toEqual({
      kind: 'raw-audit',
      method: 'Runtime.evaluate',
      sideEffectClass: 'potentially-mutating',
    });
    expect(JSON.stringify(execution.evidence)).not.toContain('expression');
    expect(JSON.stringify(execution.evidence)).not.toContain('1 + 6');
    expect(send).toHaveBeenCalledWith('Runtime.evaluate', { expression: '1 + 6' }, 'SESSION');
    expect(Reflect.ownKeys(capturedAuthorization)).toEqual(['method', 'sideEffectClass']);
    expect(() => createRawCdpGateway(adapter(send), {
      method: 'Runtime.evaluate', sideEffectClass: 'potentially-mutating',
    })).toThrow(/authorization/);

    let transportTraps = 0;
    const hostileTransport = new Proxy({}, {
      getOwnPropertyDescriptor() { transportTraps += 1; return undefined; },
      getPrototypeOf() { transportTraps += 1; return Object.prototype; },
      ownKeys() { transportTraps += 1; return []; },
    });
    expect(() => createRawCdpGateway(hostileTransport, {
      method: 'Runtime.evaluate', sideEffectClass: 'potentially-mutating',
    })).toThrow(/authorization/);
    expect(transportTraps).toBe(0);
  });

  it('denies raw execution before touching the transport', async () => {
    const send = vi.fn();
    const registry = createCommandRegistry([rawSpec()]);
    await expect(executeCommand({
      name: 'evalraw',
      args: ['Runtime.evaluate', '{}'],
      targetBound: true,
    }, {
      registry,
      authorize: vi.fn(async () => ({ allowed: false, code: 'test-denied' })),
      handlers: {
        evalraw: async ({ authorization }) => {
          await createRawCdpGateway(adapter(send), authorization).execute({}, 'SESSION');
          throw new Error('unreachable');
        },
      },
    })).rejects.toThrow(/authorization denied/);
    expect(send).not.toHaveBeenCalled();
  });
});
