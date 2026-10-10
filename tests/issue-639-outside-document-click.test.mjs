import { describe, expect, it, afterEach } from 'vitest';
import { runInNewContext } from 'node:vm';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

const TAB_ID = 'AB78B41A9E3238F5CEA88A787E777B3A';
const NEW_ID = 'F78D41FA4492257A29C2DA4D2CD22976';
const FRAME_TARGET = 'C0FFEE12AABBCCDDEEFF001122334455';
const PAGE = 'http://127.0.0.1:8765/host.html';
const FRAME = 'http://localhost:8765/pay.html';
const FILE = 'http://127.0.0.1:8765/report.csv';
const NO_CHANGE = '(no changes detected in AX tree)';

function probeResult(value) {
  return { result: { type: 'object', value } };
}

// Top-document clickxy whose point is a cross-origin iframe. The child session
// is a separate CDP target; `childSeen` is what that frame's probe reports.
function opaqueFrameCdp({ childSeen = ['pointerdown', 'mousedown', 'click'], targets = null, visibility = 'visible' } = {}) {
  const calls = [];
  const frameTargets = targets || [
    { targetId: TAB_ID, type: 'page', url: PAGE },
    { targetId: FRAME_TARGET, type: 'iframe', url: FRAME },
  ];
  return {
    calls,
    onEvent() { return () => {}; },
    send(method, params = {}, sessionId) {
      calls.push({ method, params, sessionId });
      const src = String(params.expression || params.functionDeclaration || '');
      if (method === 'Target.getTargets') return Promise.resolve({ targetInfos: frameTargets });
      if (method === 'Target.attachToTarget') return Promise.resolve({ sessionId: 'child-sid' });
      if (method === 'Target.detachFromTarget') return Promise.resolve({});
      if (method === 'Runtime.evaluate' && sessionId === 'child-sid') {
        if (src.includes('function readOnView')) {
          return Promise.resolve(probeResult({ cdpClickProbe: true, ok: true, seen: childSeen.slice() }));
        }
        return Promise.resolve(probeResult({
          cdpClickProbe: true, ok: true, installed: true, scope: 'target-document',
        }));
      }
      if (method === 'Runtime.evaluate' && src.includes('visibilityState')) {
        return Promise.resolve({ result: { type: 'string', value: visibility } });
      }
      if (src.includes('__chromeCdpExClickProbe') && src.includes('elementFromPoint')) {
        return Promise.resolve(probeResult({
          cdpClickProbe: true,
          ok: true,
          installed: false,
          opaqueFrame: true,
          scope: 'opaque-frame',
          frameSrc: FRAME,
        }));
      }
      if (src.includes('__chromeCdpExClickProbe')) {
        return Promise.resolve(probeResult({ cdpClickProbe: true, ok: false }));
      }
      return Promise.resolve({});
    },
  };
}

function mouseEvents(cdp) {
  return cdp.calls.filter(call => call.method === 'Input.dispatchMouseEvent');
}

describe('#639 clickxy into a cross-origin iframe', () => {
  it('names frameSrc when the point document cannot be read', () => {
    const iframe = {
      tagName: 'IFRAME',
      src: FRAME,
      contentDocument: null,
      contentWindow: {},
      getBoundingClientRect: () => ({ left: 8, top: 12, width: 200, height: 80 }),
    };
    const sandbox = {
      document: { elementFromPoint: () => iframe },
      window: {},
    };
    const result = runInNewContext(T.clickEventProbeInstallAtPointScript(40, 50), sandbox);
    expect(result).toMatchObject({
      opaqueFrame: true,
      installed: false,
      frameSrc: FRAME,
    });
  });

  it('treats a throwing contentDocument as the same opaque frame', () => {
    const iframe = {
      tagName: 'IFRAME',
      src: FRAME,
      get contentDocument() { throw new Error('Blocked a frame with origin'); },
      contentWindow: {},
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 10, height: 10 }),
    };
    const result = runInNewContext(T.clickEventProbeInstallAtPointScript(1, 1), {
      document: { elementFromPoint: () => iframe },
      window: {},
    });
    expect(result.opaqueFrame).toBe(true);
    expect(result.frameSrc).toBe(FRAME);
  });

  it('reports events delivered to the child frame and does not suggest jsclick', async () => {
    const cdp = opaqueFrameCdp();
    const text = await T.clickXyStr(cdp, 'sid', 231, 461);
    expect(text).toBe(`Clicked at CSS (231, 461) → child-frame delivered ${FRAME}`);
    expect(mouseEvents(cdp).map(call => call.params.type)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased']);
    const receipt = await T.runActionWithFeedback({
      action: 'clickxy',
      target: {
        targetId: TAB_ID,
        input: '231,461',
        resolvedBy: 'coordinates',
        label: '231,461',
        commandArgs: ['231', '461'],
      },
      dispatch: async () => text,
      feedbackPolicy: 'settle-diff',
      observe: async () => NO_CHANGE,
    });
    expect(receipt).toMatch(/child-frame delivered/);
    expect(receipt).toMatch(/Next: cdp shot AB78B41A/);
    expect(receipt).not.toMatch(/clickxy: dispatched/);
    expect(receipt).not.toMatch(/Outcome:/);
    expect(receipt.length).toBeLessThan(220);
    expect(receipt).not.toMatch(/jsclick/);
    expect(receipt).not.toMatch(/Kind:/);
  });

  it('says the frame cannot be observed when no single child target matches', async () => {
    const cdp = opaqueFrameCdp({
      targets: [{ targetId: TAB_ID, type: 'page', url: PAGE }],
    });
    const text = await T.clickXyStr(cdp, 'sid', 231, 461);
    expect(text).toBe(`Clicked at CSS (231, 461) → child-frame unobserved ${FRAME}`);
    expect(mouseEvents(cdp)).toHaveLength(3);
    const receipt = await T.runActionWithFeedback({
      action: 'clickxy',
      target: {
        targetId: TAB_ID,
        input: '231,461',
        resolvedBy: 'coordinates',
        label: '231,461',
        commandArgs: ['231', '461'],
      },
      dispatch: async () => text,
      feedbackPolicy: 'settle-diff',
      observe: async () => NO_CHANGE,
    });
    expect(receipt).toMatch(/child-frame unobserved/);
    expect(receipt).toMatch(/Next: cdp shot AB78B41A/);
    expect(receipt).not.toMatch(/jsclick/);
    expect(receipt).not.toMatch(/Kind:/);
  });

  it('stays fail-closed when the child frame is probed and sees no events', async () => {
    const cdp = opaqueFrameCdp({ childSeen: [] });
    const err = await T.clickXyStr(cdp, 'sid', 231, 461).catch(error => error);
    expect(err).toBeInstanceOf(Error);
    expect(err.crossOriginFrame).toMatchObject({ delivered: false });
    const failure = T.formatActionFailure(err, {
      action: 'clickxy',
      target: { targetId: TAB_ID, input: '231 461', commandArgs: ['231', '461'] },
    });
    expect(failure).toMatch(/Kind: no-input-events/);
    expect(failure).toMatch(/Next: cdp shot AB78B41A/);
    expect(failure).not.toMatch(/jsclick/);
    expect(mouseEvents(cdp)).toHaveLength(3);
  });

  it('still fail-closes a top-document click that delivered no events', async () => {
    const cdp = {
      calls: [],
      send(method, params = {}) {
        cdp.calls.push({ method, params });
        const src = String(params.expression || '');
        if (src.includes('visibilityState')) {
          return Promise.resolve({ result: { type: 'string', value: 'visible' } });
        }
        if (src.includes('__chromeCdpExClickProbe') && src.includes('installed: true')) {
          return Promise.resolve(probeResult({
            cdpClickProbe: true, ok: true, installed: true, scope: 'top', top: true, href: PAGE,
          }));
        }
        if (src.includes('__chromeCdpExClickProbe')) {
          return Promise.resolve(probeResult({ cdpClickProbe: true, ok: true, seen: [] }));
        }
        return Promise.resolve({});
      },
    };
    const err = await T.clickXyStr(cdp, 'sid', 10, 10).catch(error => error);
    expect(err.message).toMatch(/received no mousedown\/click events/);
    const failure = T.formatActionFailure(err, {
      action: 'clickxy',
      target: { targetId: TAB_ID, input: '10 10', commandArgs: ['10', '10'] },
    });
    expect(failure).toMatch(/Kind: no-input-events/);
    expect(failure).toMatch(/Next: cdp jsclick AB78B41A "10 10"/);
  });
});

function downloadClickCdp(link, { emitDownload = true, onEvent = true } = {}) {
  const handlers = new Map();
  const state = { href: PAGE, methods: [] };
  const cdp = {
    state,
    send(method, params = {}) {
      state.methods.push(method);
      const src = method === 'Runtime.evaluate' ? String(params.expression || '') : '';
      if (src.includes('__chromeCdpExClickProbe')) {
        if (src.includes('installed: true')) {
          return Promise.resolve(probeResult({
            cdpClickProbe: true, ok: true, installed: true, scope: 'top', top: true, href: PAGE,
          }));
        }
        return Promise.resolve(probeResult({
          cdpClickProbe: true, ok: true, seen: ['mousedown', 'click'],
        }));
      }
      if (method === 'Runtime.evaluate' && src === 'location.href') {
        return Promise.resolve({ result: { type: 'string', value: state.href } });
      }
      if (method === 'Runtime.evaluate') {
        return Promise.resolve({ result: { value: { ok: true, x: 40, y: 20, pageHref: PAGE, ...link } } });
      }
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased' && emitDownload) {
        for (const handler of handlers.get('Page.downloadWillBegin') || []) {
          handler({
            guid: 'GUID1',
            suggestedFilename: 'report.csv',
            url: FILE,
            frameId: 'F1',
          });
        }
      }
      if (method === 'Page.getFrameTree') {
        return Promise.resolve({ frameTree: { frame: { id: 'F1' } } });
      }
      if (method === 'Browser.setDownloadBehavior') return Promise.resolve({});
      if (method === 'Target.getTargets') return Promise.resolve({ targetInfos: [] });
      return Promise.resolve({});
    },
  };
  if (onEvent) {
    cdp.onEvent = (method, handler) => {
      if (!handlers.has(method)) handlers.set(method, new Set());
      handlers.get(method).add(handler);
      return () => handlers.get(method)?.delete(handler);
    };
  }
  return cdp;
}

const DOWNLOAD_LINK = {
  tag: 'A',
  text: 'Download report',
  href: FILE,
  linkTarget: '',
  frameName: '',
  downloadAttr: true,
};

describe('#639 click on a download link', () => {
  afterEach(() => {
    T.forgetSessionTarget('sid');
  });

  it('reports a download the browser started instead of Kind: no-navigation', async () => {
    T.rememberSessionTarget('sid', TAB_ID);
    const cdp = downloadClickCdp(DOWNLOAD_LINK);
    const text = await T.clickStr(cdp, 'sid', '#dl', new Map());
    expect(text).toBe('Clicked <A> "Download report" → download started "report.csv"');
    expect(text).not.toMatch(/did not navigate/);
    expect(cdp.state.methods).not.toContain('Browser.setDownloadBehavior');
    expect(cdp.state.methods).not.toContain('Target.getTargets');

    const receipt = await T.runActionWithFeedback({
      action: 'click',
      target: {
        targetId: TAB_ID,
        input: '#dl',
        resolvedBy: 'selector',
        label: '#dl',
        commandArgs: ['#dl'],
        clickTrust: { tag: 'A' },
      },
      dispatch: async () => text,
      feedbackPolicy: 'settle-diff',
      observe: async () => NO_CHANGE,
    });
    expect(receipt).toMatch(/download started "report\.csv"/);
    expect(receipt).not.toMatch(/Kind:/);
    expect(receipt).not.toMatch(/jsclick/);
  });

  it('reports a Content-Disposition download that has no download attribute', async () => {
    T.rememberSessionTarget('sid', TAB_ID);
    const cdp = downloadClickCdp({ ...DOWNLOAD_LINK, downloadAttr: false });
    await expect(T.clickStr(cdp, 'sid', '#dl', new Map()))
      .resolves.toBe('Clicked <A> "Download report" → download started "report.csv"');
  });

  it('does not suggest jsclick when a download attribute link did not emit an event', async () => {
    T.rememberSessionTarget('sid', TAB_ID);
    const cdp = downloadClickCdp(DOWNLOAD_LINK, { emitDownload: false });
    const text = await T.clickStr(cdp, 'sid', '#dl', new Map());
    expect(text).toMatch(/no download event was observed/);
    expect(text).not.toMatch(/did not navigate/);
    const receipt = await T.runActionWithFeedback({
      action: 'click',
      target: {
        targetId: TAB_ID,
        input: '#dl',
        resolvedBy: 'selector',
        label: '#dl',
        commandArgs: ['#dl'],
        clickTrust: { tag: 'A' },
      },
      dispatch: async () => text,
      feedbackPolicy: 'settle-diff',
      observe: async () => NO_CHANGE,
    });
    expect(receipt).not.toMatch(/Kind:/);
    expect(receipt).not.toMatch(/jsclick/);
    expect(receipt).not.toMatch(/click #dl/);
  });

  it('still fail-closes a link that neither navigates nor downloads', async () => {
    T.rememberSessionTarget('sid', TAB_ID);
    const cdp = downloadClickCdp({ ...DOWNLOAD_LINK, downloadAttr: false, href: 'http://127.0.0.1:8765/next.html' }, { emitDownload: false });
    const err = await T.clickStr(cdp, 'sid', '#go', new Map()).catch(error => error);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/did not navigate/);
    const failure = T.formatActionFailure(err, {
      action: 'click',
      target: { targetId: TAB_ID, input: '#go' },
    });
    expect(failure).toMatch(/Kind: no-navigation/);
    expect(failure).toMatch(/jsclick/);
  });
});

describe('#639 click that opens a tab with window.open', () => {
  afterEach(() => {
    T.forgetSessionTarget('sid');
  });

  it('reports the new tab instead of click-no-change', async () => {
    T.rememberSessionTarget('sid', TAB_ID);
    const targets = [{ targetId: TAB_ID, type: 'page', url: PAGE, title: 'Host' }];
    const cdp = {
      send(method, params = {}) {
        const src = method === 'Runtime.evaluate' ? String(params.expression || '') : '';
        if (src.includes('__chromeCdpExClickProbe')) {
          if (src.includes('installed: true')) {
            return Promise.resolve(probeResult({
              cdpClickProbe: true, ok: true, installed: true, scope: 'top', top: true, href: PAGE,
            }));
          }
          return Promise.resolve(probeResult({
            cdpClickProbe: true, ok: true, seen: ['mousedown', 'click'],
          }));
        }
        if (method === 'Runtime.evaluate' && src === 'location.href') {
          return Promise.resolve({ result: { type: 'string', value: PAGE } });
        }
        if (method === 'Runtime.evaluate') {
          return Promise.resolve({ result: { value: {
            ok: true,
            x: 20,
            y: 20,
            tag: 'BUTTON',
            text: 'Open in new window',
            role: 'button',
            href: null,
            linkTarget: null,
            frameName: '',
            pageHref: PAGE,
            hit: { covered: false },
          } } });
        }
        if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') {
          targets.push({
            targetId: NEW_ID,
            type: 'page',
            url: 'http://127.0.0.1:8765/inner.html',
            title: 'Inner',
            openerId: TAB_ID,
          });
        }
        if (method === 'Target.getTargets') return Promise.resolve({ targetInfos: targets.slice() });
        return Promise.resolve({});
      },
    };
    const text = await T.clickStr(cdp, 'sid', '#popup', new Map());
    expect(text).toBe('Clicked <BUTTON> "Open in new window" → opened new tab F78D41FA http://127.0.0.1:8765/inner.html');
    const receipt = await T.runActionWithFeedback({
      action: 'click',
      target: {
        targetId: TAB_ID,
        input: '#popup',
        resolvedBy: 'selector',
        label: '#popup',
        commandArgs: ['#popup'],
        clickTrust: { tag: 'BUTTON', role: 'button' },
      },
      dispatch: async () => text,
      feedbackPolicy: 'settle-diff',
      observe: async () => NO_CHANGE,
    });
    expect(receipt).toMatch(/opened new tab F78D41FA/);
    expect(receipt).toMatch(/Next: cdp perceive F78D41FA -C -d 8/);
    expect(receipt).not.toMatch(/Kind: click-no-change/);
    expect(receipt).not.toMatch(/jsclick/);
  });

  it('reports the new tab when the opener blocks the probe and releases the opener', async () => {
    T.rememberSessionTarget('sid', TAB_ID);
    const targets = [{ targetId: TAB_ID, type: 'page', url: PAGE, title: 'Host' }];
    let released = false;
    let releaseProbe = () => {};
    const cdp = {
      send(method, params = {}, _sessionId, timeoutMs) {
        const src = method === 'Runtime.evaluate' ? String(params.expression || '') : '';
        if (src.trim() === '1') {
          if (released) return Promise.resolve({ result: { type: 'number', value: 1 } });
          return Promise.reject(new Error('Timeout: Runtime.evaluate'));
        }
        if (method === 'Runtime.terminateExecution') {
          released = true;
          releaseProbe();
          return Promise.resolve({});
        }
        if (src.includes('__chromeCdpExClickProbe')) {
          if (src.includes('installed: true')) {
            return Promise.resolve(probeResult({
              cdpClickProbe: true, ok: true, installed: true, scope: 'top', top: true, href: PAGE,
            }));
          }
          return new Promise((_resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Timeout: Runtime.evaluate')), timeoutMs || 15000);
            releaseProbe = () => {
              clearTimeout(timer);
              reject(new Error('Timeout: Runtime.evaluate'));
            };
          });
        }
        if (method === 'Runtime.evaluate' && (src === 'location.href' || src.includes('visibilityState'))) {
          return Promise.resolve({ result: { type: 'string', value: src.includes('visibility') ? 'visible' : PAGE } });
        }
        if (method === 'Runtime.evaluate') {
          return Promise.resolve({ result: { value: {
            ok: true,
            x: 20,
            y: 20,
            tag: 'BUTTON',
            text: 'Open inner2',
            role: 'button',
            href: null,
            linkTarget: null,
            frameName: '',
            pageHref: PAGE,
            hit: { covered: false },
          } } });
        }
        if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') {
          targets.push({
            targetId: NEW_ID,
            type: 'page',
            url: 'about:blank',
            title: '',
            openerId: TAB_ID,
          });
          return new Promise(resolve => { setTimeout(resolve, 1500); });
        }
        if (method === 'Target.getTargets') return Promise.resolve({ targetInfos: targets.slice() });
        return Promise.resolve({});
      },
    };
    const started = Date.now();
    const text = await T.clickStr(cdp, 'sid', '#popup', new Map());
    expect(Date.now() - started).toBeLessThan(2500);
    expect(text).toBe('Clicked <BUTTON> "Open inner2" → opened new tab F78D41FA about:blank');
    expect(released).toBe(true);
    const receipt = await T.runActionWithFeedback({
      action: 'click',
      target: {
        targetId: TAB_ID,
        input: '#popup',
        resolvedBy: 'selector',
        label: '#popup',
        commandArgs: ['#popup'],
        clickTrust: { tag: 'BUTTON', role: 'button' },
      },
      dispatch: async () => text,
      feedbackPolicy: 'settle-diff',
      observe: async () => NO_CHANGE,
    });
    expect(receipt).toMatch(/opened new tab F78D41FA about:blank/);
    expect(receipt).toMatch(/Next: cdp perceive F78D41FA -C -d 8/);
    expect(receipt).not.toMatch(/Kind:/);
    expect(receipt).not.toMatch(/jsclick/);
  });

  it('still fail-closes a button whose click changes nothing and opens no tab', async () => {
    const err = await T.runActionWithFeedback({
      action: 'click',
      target: {
        targetId: TAB_ID,
        input: '#save',
        resolvedBy: 'selector',
        label: '#save',
        commandArgs: ['#save'],
        clickTrust: { tag: 'BUTTON' },
      },
      dispatch: async () => 'Clicked <BUTTON> "Save"',
      feedbackPolicy: 'settle-diff',
      observe: async () => NO_CHANGE,
    }).catch(error => error);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/Kind: click-no-change/);
    expect(err.message).not.toMatch(/jsclick #save|click #save"/);
  });
});
