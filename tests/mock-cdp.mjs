// Lightweight fake CDP client for command-function tests. It records every call and answers
// from per-method handlers; Input.dispatchMouseEvent also feeds the click event probe.
process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

function childSessionsOf(handlers) {
  return Array.isArray(handlers.childSessions) ? handlers.childSessions : [];
}

function childSessionFor(handlers, sessionId) {
  if (!sessionId) return null;
  return childSessionsOf(handlers).find(child => child && child.sessionId === sessionId) || null;
}

function childTargetInfo(child) {
  return {
    type: 'iframe',
    targetId: child.targetId || child.sessionId,
    url: child.url || '',
    title: child.title || '',
    attached: true,
    ...(child.targetInfo || {}),
  };
}

function filterAcceptsChild(filter, info) {
  if (!Array.isArray(filter) || filter.length === 0) return info.type === 'iframe';
  return filter.some(entry => entry && entry.exclude !== true && (!entry.type || entry.type === info.type));
}

function retainedSessionsOf(handlers) {
  return Array.isArray(handlers.retainedSessions) ? handlers.retainedSessions : [];
}

function sessionFor(handlers, sessionId) {
  return childSessionFor(handlers, sessionId)
    || retainedSessionsOf(handlers).find(child => child && child.sessionId === sessionId)
    || null;
}

function announceKey(parentSessionId, targetId) {
  return `${parentSessionId || ''}\0${targetId || ''}`;
}

// A child with parentSessionId is a target of that session only. Page
// auto-attach does not announce it. Children without one belong to the page,
// so a child session's auto-attach does not announce them again.
function childBelongsToSession(handlers, child, parentSessionId) {
  if (!child?.sessionId) return false;
  if (child.parentSessionId) return child.parentSessionId === parentSessionId;
  return !childSessionsOf(handlers).some(item => item?.sessionId === parentSessionId);
}

function iframeTargetInfo(child) {
  const info = childTargetInfo(child);
  const parentId = child.parentId || info.parentId || 'main-frame';
  return {
    ...info,
    parentId,
    parentFrameId: child.parentFrameId || info.parentFrameId || parentId,
  };
}

export function createMockCDP(handlers = {}) {
  const calls = [];
  const clickProbe = { seen: [] };
  const listeners = new Map();
  // Chrome announces an iframe target once. A later Target.setAutoAttach does not
  // send Target.attachedToTarget again for a target this client already attached.
  const announcedTargets = new Set();
  function emit(method, params = {}, msg = {}) {
    if (method === 'Target.attachedToTarget' && params?.targetInfo?.targetId) {
      announcedTargets.add(announceKey(msg?.sessionId, params.targetInfo.targetId));
    }
    const set = listeners.get(method);
    if (!set) return;
    for (const handler of [...set]) handler(params, msg);
  }
  function emitAttachedChildren(parentSessionId, params) {
    for (const child of childSessionsOf(handlers)) {
      if (!childBelongsToSession(handlers, child, parentSessionId)) continue;
      const targetInfo = childTargetInfo(child);
      if (!filterAcceptsChild(params?.filter, targetInfo)) continue;
      if (announcedTargets.has(announceKey(parentSessionId, targetInfo.targetId))) continue;
      emit('Target.attachedToTarget', {
        sessionId: child.sessionId,
        targetInfo,
        waitingForDebugger: false,
      }, { sessionId: parentSessionId });
    }
  }
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
      // A scroll-settled rect also mentions these getters. That call belongs to
      // the session handler so a child document can return its own box.
      const trustedPresenceCall = method === 'Runtime.callFunctionOn'
        && params.functionDeclaration?.includes('ownerDocumentGetter')
        && params.functionDeclaration.includes('getClientRects')
        && !params.functionDeclaration.includes('requestAnimationFrame');
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
      if (method === 'Target.setAutoAttach') {
        if (params?.autoAttach) emitAttachedChildren(sessionId, params);
        if (handlers[method]) return recordClickProbeMouse(method, params, timeout, handlers[method](params, sessionId));
        return Promise.resolve({});
      }
      if (method === 'Target.getTargets' && !handlers[method]) {
        const targetInfos = childSessionsOf(handlers)
          .filter(child => childBelongsToSession(handlers, child, sessionId))
          .map(child => iframeTargetInfo(child))
          .filter(info => filterAcceptsChild(params?.filter, info));
        return Promise.resolve({ targetInfos });
      }
      if (method === 'Target.attachToTarget' && !handlers[method]) {
        const child = childSessionsOf(handlers).find(item => childTargetInfo(item).targetId === params?.targetId);
        return Promise.resolve(child ? { sessionId: child.sessionId } : {});
      }
      const child = sessionFor(handlers, sessionId);
      if (child) {
        if (child.handlers?.[method]) {
          return recordClickProbeMouse(method, params, timeout, child.handlers[method](params, sessionId));
        }
        if (method === 'Page.getFrameTree') {
          return Promise.resolve({ frameTree: { frame: { id: `mock-child-${child.sessionId}` } } });
        }
        if (method === 'Page.createIsolatedWorld') return Promise.resolve({ executionContextId: 901 });
        return Promise.resolve({});
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
    emit,
    onEvent(method, handler) {
      if (!listeners.has(method)) listeners.set(method, new Set());
      const set = listeners.get(method);
      set.add(handler);
      return () => {
        set.delete(handler);
        if (set.size === 0) listeners.delete(method);
      };
    },
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
