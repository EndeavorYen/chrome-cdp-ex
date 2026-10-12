// Lightweight fake CDP client for command-function tests. It records every call and answers
// from per-method handlers; Input.dispatchMouseEvent also feeds the click event probe.
process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

export function createMockCDP(handlers = {}) {
  const calls = [];
  const clickProbe = { seen: [] };
  function recordClickProbeMouse(method, params, timeout, result) {
    return Promise.resolve(result).then((value) => {
      if (method !== 'Input.dispatchMouseEvent') return value;
      const pressOrRelease = params.type === 'mousePressed' || params.type === 'mouseReleased';
      const ackBudget = Number(timeout);
      const compositorAckTooShort = pressOrRelease
        && Number.isFinite(ackBudget)
        && ackBudget < T.CLICK_MOUSE_ACK_TIMEOUT_MS;
      if (!compositorAckTooShort && params.type === 'mouseReleased') {
        clickProbe.seen.push('mousedown', 'mouseup', 'click');
      }
      return value;
    });
  }
  return {
    calls,
    send(method, params = {}, sessionId, timeout) {
      calls.push({ method, params, sessionId, timeout });
      const probeSource = method === 'Runtime.evaluate'
        ? String(params.expression || '')
        : method === 'Runtime.callFunctionOn'
          ? String(params.functionDeclaration || '')
          : '';
      if (probeSource.includes('__chromeCdpExClickProbe')) {
        if (probeSource.includes('installed: true')) {
          clickProbe.seen = [];
          return Promise.resolve({ result: { value: { cdpClickProbe: true, ok: true, installed: true, scope: 'target-document' } } });
        }
        const seen = clickProbe.seen.slice();
        clickProbe.seen = [];
        return Promise.resolve({ result: { value: { cdpClickProbe: true, ok: true, seen } } });
      }
      if (probeSource.includes('chrome-cdp-ex.press-probe.v1')) {
        const installing = probeSource.includes("addEventListener('keydown'");
        return Promise.resolve({
          result: {
            value: {
              marker: 'chrome-cdp-ex.press-probe.v1',
              ok: true,
              installed: true,
              matched: !installing,
              count: installing ? 0 : 1,
            },
          },
        });
      }
      const trustedPresenceCall = method === 'Runtime.callFunctionOn'
        && params.functionDeclaration?.includes('ownerDocumentGetter')
        && params.functionDeclaration.includes('getClientRects');
      if (trustedPresenceCall) {
        const handler = handlers['Runtime.callFunctionOn:trusted-presence'] || handlers[method];
        return Promise.resolve(handler
          ? handler(params, sessionId)
          : { result: { value: { connected: true, visible: true } } });
      }
      const trustedConnectivityCall = method === 'Runtime.callFunctionOn'
        && params.functionDeclaration?.includes('ownerDocumentGetter')
        && !params.functionDeclaration.includes('requestAnimationFrame');
      if (trustedConnectivityCall) {
        const handler = handlers['Runtime.callFunctionOn:trusted-connectivity'];
        return Promise.resolve(handler
          ? handler(params, sessionId)
          : { result: { value: { connected: true } } });
      }
      if (handlers[method]) return recordClickProbeMouse(method, params, timeout, handlers[method](params, sessionId));
      if (method === 'Page.getFrameTree') {
        return Promise.resolve({ frameTree: { frame: { id: 'mock-root-frame' } } });
      }
      if (method === 'Page.createIsolatedWorld') {
        return Promise.resolve({ executionContextId: 901 });
      }
      return recordClickProbeMouse(method, params, timeout, {});
    },
    onEvent() { return () => {}; },
    waitForEvent(method, _timeout) {
      let timer;
      return {
        promise: handlers[`event:${method}`]
          ? Promise.resolve(handlers[`event:${method}`]())
          : new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), 50); }),
        cancel() { clearTimeout(timer); },
      };
    },
  };
}
