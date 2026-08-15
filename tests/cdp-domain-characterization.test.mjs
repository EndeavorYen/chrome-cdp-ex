import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { Linter } from 'eslint';
import { describe, expect, it, vi } from 'vitest';

import { __test__ as cdpTest } from '../skills/chrome-cdp-ex/scripts/cdp.mjs';
import { CDP_METHODS } from '../skills/chrome-cdp-ex/scripts/lib/cdp-domains.mjs';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const source = readFileSync(join(rootDir, 'skills/chrome-cdp-ex/scripts/cdp.mjs'), 'utf8');

const METHOD_CLASSIFICATION = Object.freeze({
  '<dynamic>': 'raw-gateway',
  'Accessibility.getFullAXTree': 'observation',
  'Browser.getBrowserCommandLine': 'observation',
  'CSS.enable': 'session-control',
  'CSS.getComputedStyleForNode': 'observation',
  'CSS.getMatchedStylesForNode': 'observation',
  'CSS.getStyleSheetText': 'observation',
  'DOM.describeNode': 'observation',
  'DOM.enable': 'session-control',
  'DOM.getDocument': 'observation',
  'DOM.getFrameOwner': 'observation',
  'DOM.pushNodesByBackendIdsToFrontend': 'session-control',
  'DOM.querySelector': 'observation',
  'DOM.querySelectorAll': 'observation',
  'DOM.resolveNode': 'session-control',
  'DOM.setFileInputFiles': 'page-mutation',
  'Emulation.setDeviceMetricsOverride': 'page-mutation',
  'Emulation.setEmulatedMedia': 'page-mutation',
  'Fetch.continueRequest': 'page-mutation',
  'Fetch.disable': 'page-mutation',
  'Fetch.enable': 'page-mutation',
  'Fetch.fulfillRequest': 'page-mutation',
  'Input.dispatchKeyEvent': 'page-mutation',
  'Input.dispatchMouseEvent': 'page-mutation',
  'Input.insertText': 'page-mutation',
  'Network.deleteCookies': 'sensitive-mutation',
  'Network.emulateNetworkConditions': 'page-mutation',
  'Network.enable': 'session-control',
  'Network.getCookies': 'sensitive-observation',
  'Network.setCookie': 'sensitive-mutation',
  'Page.addScriptToEvaluateOnNewDocument': 'page-mutation',
  'Page.captureScreenshot': 'observation',
  'Page.createIsolatedWorld': 'session-control',
  'Page.enable': 'session-control',
  'Page.getFrameTree': 'observation',
  'Page.getLayoutMetrics': 'observation',
  'Page.getNavigationHistory': 'observation',
  'Page.handleJavaScriptDialog': 'page-mutation',
  'Page.navigate': 'page-mutation',
  'Page.navigateToHistoryEntry': 'page-mutation',
  'Page.reload': 'page-mutation',
  'Page.removeScriptToEvaluateOnNewDocument': 'page-mutation',
  'Page.screencastFrameAck': 'session-control',
  'Page.startScreencast': 'session-control',
  'Page.stopScreencast': 'session-control',
  'Performance.enable': 'session-control',
  'Performance.getMetrics': 'observation',
  'Runtime.callFunctionOn': 'escape-potentially-mutating',
  'Runtime.enable': 'session-control',
  'Runtime.evaluate': 'escape-potentially-mutating',
  'Runtime.releaseObjectGroup': 'session-control',
  'Target.activateTarget': 'browser-mutation',
  'Target.attachToTarget': 'session-control',
  'Target.closeTarget': 'browser-mutation',
  'Target.createTarget': 'browser-mutation',
  'Target.getTargets': 'observation',
});

function callerName(sourceCode, node) {
  const ancestors = sourceCode.getAncestors(node);
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const ancestor = ancestors[index];
    if (ancestor.type === 'FunctionDeclaration' && ancestor.id?.name) return ancestor.id.name;
    if (ancestor.type === 'FunctionExpression' || ancestor.type === 'ArrowFunctionExpression') {
      const parent = ancestors[index - 1];
      if (parent?.type === 'VariableDeclarator' && parent.id.type === 'Identifier') return parent.id.name;
      if (parent?.type === 'Property' && !parent.computed) return parent.key.name || parent.key.value;
      if (parent?.type === 'MethodDefinition' && !parent.computed) return parent.key.name || parent.key.value;
    }
  }
  return '<top>';
}

function directCdpInventory(text) {
  const records = [];
  const reviewedMethods = new Set(CDP_METHODS);
  const rule = {
    create(context) {
      const sourceCode = context.sourceCode;
      const staticPropertyName = (member) => {
        if (!member.computed) return member.property.type === 'Identifier' ? member.property.name : null;
        const evaluate = (node) => {
          if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
          if (node?.type === 'BinaryExpression' && node.operator === '+') {
            const left = evaluate(node.left);
            const right = evaluate(node.right);
            return typeof left === 'string' && typeof right === 'string' ? left + right : null;
          }
          return null;
        };
        return evaluate(member.property);
      };
      const isAnySendMember = member => member.type === 'MemberExpression'
        && staticPropertyName(member) === 'send';
      const compact = value => value
        ? sourceCode.getText(value).replace(/\s+/g, ' ')
        : null;
      const typedCall = (node) => {
        const operationMember = node.callee;
        if (operationMember.type !== 'MemberExpression') return null;
        const domainMember = operationMember.object;
        if (domainMember.type !== 'MemberExpression') return null;
        const factoryCall = domainMember.object;
        if (factoryCall.type !== 'CallExpression'
          || factoryCall.callee.type !== 'Identifier'
          || factoryCall.callee.name !== 'cdpDomains') return null;
        if (factoryCall.arguments.length !== 1
          || factoryCall.arguments[0].type !== 'Identifier'
          || factoryCall.arguments[0].name !== 'cdp') {
          context.report({ node, message: 'CDP domains must bind the local cdp transport exactly' });
          return { invalid: true };
        }
        if (operationMember.computed || domainMember.computed
          || operationMember.optional || domainMember.optional || node.optional) {
          context.report({ node, message: 'CDP domain calls must use direct non-optional members' });
          return { invalid: true };
        }
        if (operationMember.property.type !== 'Identifier'
          || domainMember.property.type !== 'Identifier') {
          context.report({ node, message: 'CDP domain and method names must be identifiers' });
          return { invalid: true };
        }
        return { method: `${domainMember.property.name}.${operationMember.property.name}` };
      };
      return {
        MemberExpression(node) {
          if (isAnySendMember(node)) {
            if (node.parent?.type === 'CallExpression' && node.parent.callee === node) return;
            const parent = node.parent;
            if (sourceCode.getText(node) === 'deps.send'
              && parent?.type === 'LogicalExpression'
              && parent.parent?.type === 'VariableDeclarator'
              && parent.parent.id.type === 'Identifier' && parent.parent.id.name === 'send'
              && callerName(sourceCode, node) === 'stopDaemons') return;
            context.report({ node, message: 'transport send references may not be detached or reflected' });
            return;
          }
          if (node.object.type === 'Identifier' && node.object.name === 'cdp' && node.computed) {
            context.report({ node, message: 'computed CDP transport members are not allowed' });
          }
        },
        CallExpression(node) {
          const callee = node.callee;
          if (callee.type === 'MemberExpression' && callee.computed) {
            context.report({ node, message: 'computed dispatch is not allowed in the CDP module' });
            return;
          }
          const typed = typedCall(node);
          if (typed) {
            if (typed.invalid) return;
            if (!reviewedMethods.has(typed.method)) {
              context.report({ node, message: `unreviewed CDP method ${typed.method}` });
              return;
            }
            records.push({
              caller: callerName(sourceCode, node),
              method: typed.method,
              session: compact(node.arguments[1]) || '<browser>',
              timeout: compact(node.arguments[2]) || '<default>',
            });
            return;
          }
          if (callee.type === 'Identifier' && callee.name === 'cdpDomains') {
            const domainMember = node.parent;
            const operationMember = domainMember?.parent;
            const invocation = operationMember?.parent;
            if (domainMember?.type === 'MemberExpression' && domainMember.object === node
              && operationMember?.type === 'MemberExpression' && operationMember.object === domainMember
              && invocation?.type === 'CallExpression' && invocation.callee === operationMember) {
              return;
            }
            context.report({ node, message: 'CDP domain factory results may not be aliased or detached' });
            return;
          }
          if (isAnySendMember(callee)) {
            const method = node.arguments[0];
            const memberText = sourceCode.getText(callee);
            const argumentText = method ? sourceCode.getText(method).replace(/\s+/g, ' ') : '';
            const caller = callerName(sourceCode, node);
            const underlyingWebSocketSend = (
              memberText === 'this.#ws.send'
              && caller === 'send'
              && argumentText === 'JSON.stringify(msg)'
            ) || (
              memberText === 'ws.send'
              && ['checkBrowserTargets', 'listSpawnedDebugTargets'].includes(caller)
              && argumentText === "JSON.stringify({ id: 1, method: 'Target.getTargets' })"
            );
            if (!underlyingWebSocketSend) {
              context.report({ node, message: 'CDP transport sends must stay behind domain clients or the raw gateway' });
            }
            return;
          }
          if (callee.type === 'MemberExpression'
            && !callee.computed
            && callee.object.type === 'Identifier' && callee.object.name === 'gateway'
            && callee.property.type === 'Identifier' && callee.property.name === 'execute'
            && callerName(sourceCode, node) === 'evalRawStr') {
            records.push({
              caller: 'evalRawStr',
              method: '<dynamic>',
              session: compact(node.arguments[1]) || '<browser>',
              timeout: compact(node.arguments[2]) || '<default>',
            });
            return;
          }
          const method = node.arguments[0];
          if (callee.type === 'Identifier'
            && method?.type === 'Literal' && typeof method.value === 'string'
            && /^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/.test(method.value)) {
            context.report({ node, message: 'CDP method names must use reviewed domain clients' });
          }
        },
      };
    },
  };
  const linter = new Linter();
  const messages = linter.verify(text, {
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    plugins: { characterization: { rules: { inventory: rule } } },
    rules: { 'characterization/inventory': 'error' },
  });
  expect(messages).toEqual([]);
  return records.sort((left, right) => {
    const leftJson = JSON.stringify(left);
    const rightJson = JSON.stringify(right);
    return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
  });
}

const PERCEPTION_META = JSON.stringify({
  title: 'Fixture',
  url: 'http://127.0.0.1/fixture',
  vw: 800,
  vh: 600,
  scrollY: 0,
  scrollMax: 0,
  counts: {},
  focused: null,
  layoutMap: {},
  styleHints: {},
  cursorInteractives: [],
  visibleControls: [],
  visibleControlsTruncated: false,
});

function responseFor(method, params = {}) {
  switch (method) {
    case 'Target.getTargets': return { targetInfos: [] };
    case 'Accessibility.getFullAXTree': return { nodes: [] };
    case 'Runtime.evaluate':
      if (String(params.expression).includes('visibleControls')) return { result: { value: PERCEPTION_META } };
      if (String(params.expression).includes('title: document.title')) {
        return { result: { value: JSON.stringify({ title: 'Fixture', url: 'https://example.test/fixture', readyState: 'complete' }) } };
      }
      if (params.expression === 'document.readyState') return { result: { value: 'complete' } };
      return { result: { value: 7 } };
    case 'DOM.getDocument': return { root: { nodeId: 1 } };
    case 'DOM.resolveNode': return { object: { objectId: 'OBJECT' } };
    case 'DOM.querySelector': return { nodeId: 2 };
    case 'CSS.getMatchedStylesForNode': return { matchedCSSRules: [], inherited: [] };
    case 'CSS.getComputedStyleForNode': return { computedStyle: [] };
    case 'Page.navigate': return { loaderId: null };
    case 'Page.getFrameTree': return { frameTree: { frame: { id: 'ROOT_FRAME' } } };
    case 'Page.createIsolatedWorld': return { executionContextId: 901 };
    case 'Performance.getMetrics': return { metrics: [] };
    case 'Runtime.callFunctionOn': return { result: { value: { connected: true } } };
    default: return {};
  }
}

function mockCdp({ failMethod = null, error = null } = {}) {
  const send = vi.fn(async (method, params) => {
    if (method === failMethod) throw error;
    return responseFor(method, params);
  });
  return {
    connect: vi.fn(async () => {}),
    close: vi.fn(),
    send,
    waitForEvent: vi.fn(() => ({ promise: Promise.resolve({}), cancel: vi.fn() })),
  };
}

function domainInvocations() {
  const state = () => cdpTest.createSessionState({ targetId: 'TARGET', sessionId: 'SESSION' });
  return [
    {
      domain: 'Target',
      methods: ['Target.getTargets'],
      callDigest: 'b2502813c7ca683520d8faa766360c6bdbb6843a339bc04daf4c15a886a3fe5f',
      result: [],
      invoke: cdp => cdpTest.getPages(cdp),
    },
    {
      domain: 'Accessibility',
      methods: ['Accessibility.getFullAXTree', 'Runtime.evaluate'],
      callDigest: 'ad424d3e3f6e6ed6fef05f0f0e251768595b44f77d5a7114301881862337acdb',
      result: 'Page: Fixture — http://127.0.0.1/fixture\nViewport: 800×600 | Scroll: 0/0 (0%) | Focused: null\nInteractive: none\nConsole: clean\nCoords: top-level viewport CSS px (use clickxy with these values; fixed/sticky elements are tagged)\n',
      invoke: cdp => cdpTest.perceiveStr(
        cdp,
        'SESSION',
        new cdpTest.RingBuffer(4),
        new cdpTest.RingBuffer(4),
        new Map(),
        { output: null },
      ),
    },
    {
      domain: 'DOM+CSS',
      methods: [
        'Runtime.evaluate',
        'DOM.enable', 'CSS.enable', 'DOM.getDocument', 'DOM.querySelector',
        'CSS.getMatchedStylesForNode', 'CSS.getComputedStyleForNode',
      ],
      callDigest: '02ca5b179b3d686a5f7ca8f9018eae630c4f67ddc69c6db699fef877cfc13449',
      result: 'No matching CSS rules found for this element',
      invoke: cdp => cdpTest.cascadeStr(cdp, 'SESSION', '.fixture', null, new Map()),
    },
    {
      domain: 'Emulation',
      methods: ['Emulation.setEmulatedMedia'],
      callDigest: 'cf068eb1354e64c49fe9644d136d08d0522791692735c5063b600d6423a50d72',
      result: 'Emulation: active\n  prefers-color-scheme: dark',
      invoke: cdp => cdpTest.emulateStr(cdp, 'SESSION', state(), ['--color-scheme', 'dark']),
    },
    {
      domain: 'EmulationViewport',
      methods: ['Emulation.setDeviceMetricsOverride'],
      callDigest: 'c1137e0c2333e27b839cea599e14ed71aafcf777299ffb2d723537dee3cdf6f7',
      result: 'Viewport resized to 390×844 (mobile mode)',
      invoke: cdp => cdpTest.viewportStr(cdp, 'SESSION', '390x844'),
    },
    {
      domain: 'Fetch',
      methods: ['Fetch.enable'],
      callDigest: '7ce0097e37ca30df94f4fdb6249406ba57d0b6ebf299a909a4aea9ece121e9e6',
      result: 'Network mock: 1 rule\n1. **/api* -> 503 text/plain; charset=utf-8 (0 hits)\nNext: cdp mock TARGET clear',
      invoke: cdp => cdpTest.mockStr(cdp, 'SESSION', state(), ['add', '**/api*', '--status', '503']),
    },
    {
      domain: 'Input',
      methods: ['Input.dispatchKeyEvent', 'Input.dispatchKeyEvent'],
      callDigest: 'd1168c59b216df65f7a8df273f0b649936168f7d6fa509a0fb5794b7cde87f75',
      result: 'Pressed Enter',
      invoke: cdp => cdpTest.pressStr(cdp, 'SESSION', 'Enter'),
    },
    {
      domain: 'Network',
      methods: ['Network.enable', 'Network.emulateNetworkConditions'],
      callDigest: '06d8491e26e3507a61293065cdf04f2fc3322148b0933f83ddc77ec511dc557f',
      result: 'Network throttle: slow-3g — latency 400ms, 400 kbps down, 400 kbps up\nNext: cdp throttle TARGET off',
      invoke: cdp => cdpTest.throttleStr(cdp, 'SESSION', state(), ['slow-3g']),
    },
    {
      domain: 'Page',
      methods: ['Page.enable', 'Page.navigate', 'Runtime.evaluate'],
      callDigest: '28a1c2f14e318795e2b3dff815a9bad8141cd4f8173b9f0fea2064b46bcc1115',
      result: 'Navigated to https://example.test/fixture',
      invoke: cdp => cdpTest.navStr(cdp, 'SESSION', 'https://example.test/fixture'),
    },
    {
      domain: 'Performance',
      methods: ['Performance.enable', 'Performance.getMetrics'],
      callDigest: 'c23b15e48def8eed172cebe1a876ba8f5bf82d01e022218ebf6c6bbebb386b4f',
      result: 'Runtime metrics (Performance.getMetrics):\n  (no requested metrics returned by this target)',
      invoke: cdp => cdpTest.runtimeMetricsStr(cdp, 'SESSION'),
    },
    {
      domain: 'Runtime',
      methods: ['Runtime.evaluate'],
      callDigest: '0e8a54ca8455049ec9220d5681f6c532d604061e6737e16be9a7e27768e48b6f',
      result: '7',
      invoke: cdp => cdpTest.evalStr(cdp, 'SESSION', '1 + 6'),
    },
  ];
}

describe('Phase 6 direct CDP characterization', () => {
  it('freezes every direct method, caller, session, and timeout boundary', () => {
    const inventory = directCdpInventory(source);
    const digest = `sha256:${createHash('sha256').update(JSON.stringify(inventory)).digest('hex')}`;
    expect(inventory).toHaveLength(137);
    expect(digest).toBe('sha256:590164805838faa34fec026722999fb21386fd2e261e9b1aefcb976861a1f1df');
    expect([...new Set(inventory.map(entry => entry.timeout))].sort()).toEqual([
      '1000', '2000', '5000', '<default>',
      'HOVER_MOUSE_ACK_TIMEOUT_MS',
      'Math.min(1000, Math.max(100, deadline - now() + 100))',
      'REF_RESOLVE_TIMEOUT', 'RELOAD_DISPATCH_TIMEOUT', 'RELOAD_OBSERVE_TIMEOUT',
      'options.timeoutMs', 'probeTimeoutMs', 'timeoutMs',
    ]);
    expect([...new Set(inventory.map(entry => entry.session))].sort())
      .toEqual(['<browser>', 'attached.sessionId', 'sessionId', 'sid', 'undefined']);
  });

  it('classifies every observed method and keeps dynamic dispatch raw-only', () => {
    const inventory = directCdpInventory(source);
    const methods = [...new Set(inventory.map(entry => entry.method))].sort();
    expect(Object.keys(METHOD_CLASSIFICATION).sort()).toEqual(methods);
    expect(new Set(Object.values(METHOD_CLASSIFICATION))).toEqual(new Set([
      'browser-mutation', 'escape-potentially-mutating', 'observation', 'page-mutation',
      'raw-gateway', 'sensitive-mutation', 'sensitive-observation', 'session-control',
    ]));
    expect(inventory.filter(entry => entry.method === '<dynamic>')).toEqual([{
      caller: 'evalRawStr', method: '<dynamic>', session: 'sid', timeout: '<default>',
    }]);
  });

  it('fails closed on unreviewed, computed, optional, detached, or direct transport syntax', () => {
    const direct = 'cdpDomains(cdp).Target.getTargets()';
    expect(source).toContain(direct);
    for (const replacement of [
      "cdpDomains(cdp)['Target'].getTargets()",
      "cdpDomains(cdp).Target['getTargets']()",
      'cdpDomains(cdp)?.Target.getTargets()',
      'cdpDomains(cdp).Target.notARealMethod()',
      "cdp.send('Target.getTargets')",
      "cdp['se' + 'nd']('Target.getTargets')",
      "Reflect.apply(cdp.send, cdp, ['Target.getTargets'])",
      '(cdpDomains(cdp).Target.getTargets.bind(null))()',
    ]) {
      expect(() => directCdpInventory(source.replace(direct, replacement)), replacement).toThrow();
    }
    for (const fixture of [
      'async function probe(cdp) { const domains = cdpDomains(cdp); await domains.Runtime.evaluate({}); }',
      'async function probe(cdp) { const method = cdpDomains(cdp).Runtime.evaluate; await method({}); }',
      "async function probe(cdp) { await cdp.send('Runtime.evaluate', {}); }",
      "async function probe(cdp) { await cdp['se' + 'nd']('Runtime.evaluate', {}); }",
      "async function probe(cdp) { await Reflect.apply(cdp.send, cdp, ['Runtime.evaluate', {}]); }",
      "async function probe(cdp) { const transport = cdp; await Reflect.apply(transport.send, transport, ['Runtime.evaluate', {}]); }",
      "async function helper(client, prop) { await client[prop]('Runtime.evaluate', {}); } helper(cdp, 'send');",
      "async function helper(client, prop, method) { await client[prop](method, {}); } helper(cdp, 'send', 'Runtime.evaluate');",
      "async function helper(client, p, m) { await client[p](m, {}); } helper(cdp, 'send', 'Runtime.evaluate');",
      "async function helper(client, method) { await client.send(method, {}); } helper(cdp, 'Runtime.evaluate');",
      "async function helper(ws, method) { await ws.send(method, {}); } helper(cdp, 'Runtime.evaluate');",
    ]) {
      expect(() => directCdpInventory(fixture), fixture).toThrow();
    }
  }, 30_000);

  it('preserves browser/session send arguments and exact error identity', async () => {
    const sentinel = new Error('transport sentinel');
    const send = vi.fn(async method => {
      if (method === 'Target.getTargets') throw sentinel;
      return { result: { value: 7 } };
    });
    await expect(cdpTest.getPages({ send })).rejects.toBe(sentinel);
    expect(send).toHaveBeenCalledWith('Target.getTargets');

    const evalSend = vi.fn(async () => ({ result: { value: 7 } }));
    await expect(cdpTest.evalStr({ send: evalSend }, 'SESSION', '1 + 6', false, { timeoutMs: 321 }))
      .resolves.toBe('7');
    expect(evalSend).toHaveBeenCalledWith(
      'Runtime.evaluate', expect.any(Object), 'SESSION', 321,
    );
  });

  it('preserves representative success arguments and values for every used CDP domain', async () => {
    for (const fixture of domainInvocations()) {
      const cdp = mockCdp();
      const result = await fixture.invoke(cdp);
      expect(result, fixture.domain).toEqual(fixture.result);
      expect(createHash('sha256').update(JSON.stringify(cdp.send.mock.calls)).digest('hex'), fixture.domain)
        .toBe(fixture.callDigest);
      expect(cdp.send.mock.calls.map(call => call[0]), fixture.domain).toEqual(fixture.methods);
      for (const [method, , sessionId] of cdp.send.mock.calls) {
        expect(sessionId, `${fixture.domain}:${method}`).toBe(method === 'Target.getTargets' ? undefined : 'SESSION');
      }
    }
  });

  it('preserves exact transport error identity for every used CDP domain', async () => {
    const cases = [
      ['Target', 'Target.getTargets'],
      ['Accessibility', 'Accessibility.getFullAXTree'],
      ['DOM', 'DOM.getDocument'],
      ['CSS', 'CSS.getMatchedStylesForNode'],
      ['Emulation', 'Emulation.setEmulatedMedia'],
      ['Fetch', 'Fetch.enable'],
      ['Input', 'Input.dispatchKeyEvent'],
      ['Network', 'Network.enable'],
      ['Page', 'Page.enable'],
      ['Performance', 'Performance.getMetrics'],
      ['Runtime', 'Runtime.evaluate'],
    ];
    for (const [domain, method] of cases) {
      const fixture = domainInvocations().find(entry => entry.domain.split('+').includes(domain));
      const sentinel = new Error(`${domain} sentinel`);
      const cdp = mockCdp({ failMethod: method, error: sentinel });
      await expect(fixture.invoke(cdp), domain).rejects.toBe(sentinel);
    }
  });

  it('executes the custom timeout and browser/session routing boundaries before migration', async () => {
    const cdp = mockCdp();
    cdpTest.resetScreenshotTier();
    await cdpTest.captureScreenshot(cdp, 'SESSION', { format: 'png' }, {
      inspectFrame: async () => ({ retry: false }),
    });
    expect(cdp.send).toHaveBeenLastCalledWith(
      'Page.captureScreenshot', { format: 'png' }, 'SESSION', cdpTest.SCREENSHOT_TIMEOUT,
    );

    cdp.send.mockClear();
    await expect(cdpTest.resolveRefNode(cdp, 'SESSION', new Map([[1, 101]]), '@1', {}))
      .resolves.toBe('OBJECT');
    expect(cdp.send.mock.calls.map(call => call[0])).toEqual([
      'Page.getFrameTree',
      'Page.createIsolatedWorld',
      'DOM.resolveNode',
      'Runtime.callFunctionOn',
    ]);
    expect(cdp.send.mock.calls[0]).toEqual(['Page.getFrameTree', {}, 'SESSION', 2000]);
    expect(cdp.send.mock.calls[1]).toEqual(['Page.createIsolatedWorld', {
      frameId: 'ROOT_FRAME',
      worldName: 'chrome-cdp-ex-ref-validation',
      grantUniveralAccess: false,
    }, 'SESSION', 2000]);
    expect(cdp.send.mock.calls[2]).toEqual(['DOM.resolveNode', {
      backendNodeId: 101,
      executionContextId: 901,
    }, 'SESSION', 2000]);
    expect(cdp.send.mock.calls[3]).toEqual(['Runtime.callFunctionOn', {
      objectId: 'OBJECT',
      functionDeclaration: expect.stringContaining('ownerDocumentGetter'),
      returnByValue: true,
    }, 'SESSION', 2000]);
    expect(cdp.send.mock.calls[3][1].functionDeclaration)
      .not.toMatch(/this\.(?:isConnected|ownerDocument|getRootNode)/);

    cdp.send.mockClear();
    const checkpoint = {
      schema: 'chrome-cdp-ex.checkpoint.v1',
      page: { url: 'https://example.test/restore', title: 'Restore', origin: 'https://example.test' },
      storage: { localStorage: {}, sessionStorage: {} },
      cookies: [],
    };
    await cdpTest.restoreCheckpointStr(cdp, 'SESSION', ['--json', JSON.stringify(checkpoint)]);
    expect(cdp.send.mock.calls.find(call => call[0] === 'Page.navigate'))
      .toEqual(['Page.navigate', { url: 'https://example.test/restore' }, 'SESSION', 5000]);

    cdp.send.mockClear();
    cdp.waitForEvent = vi.fn(() => ({ promise: new Promise(() => {}), cancel: vi.fn() }));
    await expect(cdpTest.reloadStr(cdp, 'SESSION')).resolves.toBe('Page reloaded');
    expect(cdp.send.mock.calls.find(call => call[0] === 'Page.reload'))
      .toEqual(['Page.reload', {}, 'SESSION', 1000]);
    const readyProbe = cdp.send.mock.calls.find(call => call[0] === 'Runtime.evaluate');
    expect(readyProbe[2]).toBe('SESSION');
    expect(readyProbe[3]).toBeGreaterThanOrEqual(100);
    expect(readyProbe[3]).toBeLessThanOrEqual(1000);

    cdp.send.mockClear();
    await cdpTest.observeReloadPage(cdp, 'SESSION');
    expect(cdp.send.mock.calls[0][2]).toBe('SESSION');
    expect(cdp.send.mock.calls[0][3]).toBe(2000);

    const openClient = {
      connect: vi.fn(async () => {}),
      close: vi.fn(),
      send: vi.fn(async (method) => {
        if (method === 'Target.attachToTarget') return { sessionId: 'ATTACHED' };
        return {
          result: {
            value: JSON.stringify({
              href: 'https://example.test/open',
              readyState: 'complete',
              selectorFound: true,
            }),
          },
        };
      }),
    };
    await cdpTest.waitForOpenReady('TARGET', {
      timeoutMs: 250,
      url: 'https://example.test/open',
      selector: '#app',
      createCdp: () => openClient,
      getWsUrlFn: async () => 'ws://127.0.0.1/devtools/browser/fixture',
    });
    expect(openClient.send.mock.calls[0][0]).toBe('Target.attachToTarget');
    expect(openClient.send.mock.calls[0][1]).toEqual({ targetId: 'TARGET', flatten: true });
    expect(openClient.send.mock.calls[0][2]).toBeUndefined();
    expect(openClient.send.mock.calls[0][3]).toBeGreaterThanOrEqual(100);
    expect(openClient.send.mock.calls[0][3]).toBeLessThanOrEqual(250);
    expect(openClient.send.mock.calls[1][2]).toBe('ATTACHED');
    expect(openClient.send.mock.calls[1][3]).toBeGreaterThanOrEqual(100);
    expect(openClient.send.mock.calls[1][3]).toBeLessThanOrEqual(250);

    const daemonCdp = mockCdp({ failMethod: 'CSS.enable', error: new Error('unsupported CSS') });
    await expect(cdpTest.enableDaemonDomains(daemonCdp, 'DAEMON-SESSION')).resolves.toBeUndefined();
    expect(daemonCdp.send.mock.calls).toEqual([
      ['Runtime.enable', {}, 'DAEMON-SESSION'],
      ['Page.enable', {}, 'DAEMON-SESSION'],
      ['DOM.enable', {}, 'DAEMON-SESSION'],
      ['CSS.enable', {}, 'DAEMON-SESSION'],
      ['Network.enable', {}, 'DAEMON-SESSION'],
    ]);

    const browserProbe = mockCdp();
    browserProbe.send.mockImplementation(async () => ({
      targetInfos: [{ targetId: 'TARGET', url: 'https://example.test/probe' }],
    }));
    await expect(cdpTest.waitForOpenTargetUrl(
      'TARGET',
      'https://example.test/probe',
      250,
      {
        createCdp: () => browserProbe,
        getWsUrlFn: async () => 'ws://127.0.0.1/devtools/browser/fixture',
        now: () => 1000,
      },
    )).resolves.toEqual({ ok: true, href: 'https://example.test/probe' });
    expect(browserProbe.send).toHaveBeenCalledWith('Target.getTargets', {}, undefined, 350);

    const navigationCdp = mockCdp();
    navigationCdp.send.mockImplementation(async method => {
      if (method === 'Target.attachToTarget') return { sessionId: 'NAV-SESSION' };
      if (method === 'Page.navigate') return { loaderId: 'LOADER' };
      return {};
    });
    await expect(cdpTest.navigateOpenTarget(
      'TARGET',
      '/tmp/unused.sock',
      'https://example.test/navigate',
      {
        createCdp: () => navigationCdp,
        getWsUrlFn: async () => 'ws://127.0.0.1/devtools/browser/fixture',
        waitForOpenTargetUrlFn: async () => ({ ok: false, href: null }),
      },
    )).resolves.toMatchObject({ attempted: true, ok: true, method: 'Page.navigate' });
    expect(navigationCdp.send.mock.calls).toEqual([
      ['Target.activateTarget', { targetId: 'TARGET' }, undefined, 5000],
      ['Target.attachToTarget', { targetId: 'TARGET', flatten: true }, undefined, 5000],
      ['Page.enable', {}, 'NAV-SESSION', 2000],
      ['Page.navigate', { url: 'https://example.test/navigate' }, 'NAV-SESSION', 5000],
    ]);
  });
});
