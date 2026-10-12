import { describe, it, expect } from 'vitest';
import { createMockCDP } from './mock-cdp.mjs';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

// =========================================================================
// CDP mock helper — lightweight fake for testing command functions
// =========================================================================


// =========================================================================
// dismiss-modal helper script + dispatch
// =========================================================================

describe('dismissModalScript', () => {
  const { dismissModalScript } = T;

  it('returns a self-invoking IIFE that looks for dialogs', () => {
    const script = dismissModalScript();
    expect(typeof script).toBe('string');
    expect(script).toMatch(/role="dialog"/);
    expect(script).toMatch(/aria-modal/);
  });
});

describe('dismissModalStr', () => {
  const { dismissModalStr } = T;

  it('reports success when the page-side script clicks a close button', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { value: JSON.stringify({ ok: true, action: 'click', label: 'close', sel: 'div' }) } }),
    });
    const out = await dismissModalStr(cdp, 'sid1');
    expect(out).toMatch(/Dismissed modal via close button/);
  });

  it('returns a friendly message when no dialog is visible', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { value: JSON.stringify({ ok: false, reason: 'no-dialog' }) } }),
    });
    const out = await dismissModalStr(cdp, 'sid1');
    expect(out).toMatch(/No visible modal/);
  });

  it('falls back to Escape when no close button is found', async () => {
    let evalCalls = 0;
    const cdp = createMockCDP({
      'Runtime.evaluate': () => {
        evalCalls++;
        return { result: { value: JSON.stringify({ ok: false, reason: 'no-close-button', dialogs: 1 }) } };
      },
      'Input.dispatchKeyEvent': () => ({}),
    });
    const out = await dismissModalStr(cdp, 'sid1');
    expect(out).toMatch(/sent Escape as fallback/);
    const keyEvents = cdp.calls.filter(c => c.method === 'Input.dispatchKeyEvent');
    expect(keyEvents.length).toBeGreaterThan(0);
    expect(evalCalls).toBeGreaterThan(0);
  });

  it('#276 dismiss-modal names dialog-only scope when a blocking overlay is still up', async () => {
    const overlay = {
      id: 'p20ov',
      tagName: 'DIV',
      textContent: '',
      parentElement: null,
      __style: {
        display: 'block',
        visibility: 'visible',
        opacity: '1',
        position: 'fixed',
        pointerEvents: 'auto',
        zIndex: '99999',
      },
      getBoundingClientRect: () => ({
        x: 0, y: 0, left: 0, top: 0, right: 1027, bottom: 632, width: 1027, height: 632,
      }),
      getAttribute: () => null,
      matches: () => false,
      querySelectorAll: () => [],
    };
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    const previousCss = globalThis.CSS;
    const previousGetComputedStyle = globalThis.getComputedStyle;
    globalThis.window = { innerWidth: 1042, innerHeight: 632 };
    globalThis.CSS = { escape: (value) => String(value) };
    globalThis.getComputedStyle = (element) => element.__style;
    globalThis.document = {
      documentElement: { clientWidth: 1027, clientHeight: 632 },
      querySelectorAll: (selector) => selector === 'body *' ? [overlay] : [],
    };
    try {
      const parsed = JSON.parse(Function('source', 'return eval(source);')(T.dismissModalScript()));
      expect(parsed).toMatchObject({ ok: false, reason: 'overlay-not-dialog' });
      expect(parsed.overlays).toContain('#p20ov');
    } finally {
      globalThis.window = previousWindow;
      globalThis.document = previousDocument;
      globalThis.CSS = previousCss;
      globalThis.getComputedStyle = previousGetComputedStyle;
    }

    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({
        result: { value: JSON.stringify({ ok: false, reason: 'overlay-not-dialog', overlays: ['#p20ov'] }) },
      }),
    });
    const out = await T.dismissModalStr(cdp, 'sid1');
    expect(out).toMatch(/only handles dialog\/modal/i);
    expect(out).toMatch(/#p20ov/);
    expect(out).not.toMatch(/No visible modal\/dialog detected/);
    expect(out).not.toMatch(/was present/);
    expect(/no visible modal\/dialog detected/i.test(out)).toBe(false);
  });

  it('does not call a full-viewport fixed app shell a blocking overlay', () => {
    const button = {
      id: 'submit',
      tagName: 'BUTTON',
      textContent: 'Submit',
      __style: {
        display: 'block', visibility: 'visible', opacity: '1',
        position: 'static', pointerEvents: 'auto', zIndex: 'auto',
      },
      getBoundingClientRect: () => ({
        x: 480, y: 300, left: 480, top: 300, right: 600, bottom: 340, width: 120, height: 40,
      }),
      getAttribute: () => null,
      matches: () => false,
      contains(other) { return other === button; },
    };
    const shell = {
      id: 'app',
      tagName: 'DIV',
      textContent: 'App',
      __style: {
        display: 'block', visibility: 'visible', opacity: '1',
        position: 'fixed', pointerEvents: 'auto', zIndex: '1',
      },
      getBoundingClientRect: () => ({
        x: 0, y: 0, left: 0, top: 0, right: 1042, bottom: 632, width: 1042, height: 632,
      }),
      getAttribute: () => null,
      matches: () => false,
      contains(other) { return other === shell || other === button; },
    };
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    const previousCss = globalThis.CSS;
    const previousGetComputedStyle = globalThis.getComputedStyle;
    globalThis.window = { innerWidth: 1042, innerHeight: 632 };
    globalThis.CSS = { escape: (value) => String(value) };
    globalThis.getComputedStyle = (element) => element.__style;
    globalThis.document = {
      documentElement: { clientWidth: 1042, clientHeight: 632 },
      querySelectorAll: (selector) => selector === 'body *' ? [shell, button] : [],
      elementsFromPoint: () => [button, shell],
    };
    try {
      const parsed = JSON.parse(Function('source', 'return eval(source);')(T.dismissModalScript()));
      expect(parsed).toMatchObject({ ok: false, reason: 'no-dialog' });
      expect(parsed.overlays).toBeUndefined();
    } finally {
      globalThis.window = previousWindow;
      globalThis.document = previousDocument;
      globalThis.CSS = previousCss;
      globalThis.getComputedStyle = previousGetComputedStyle;
    }
  });

  it('still names a full-viewport fixed cover that paints over other content', () => {
    const button = {
      id: 'submit',
      tagName: 'BUTTON',
      textContent: 'Submit',
      __style: {
        display: 'block', visibility: 'visible', opacity: '1',
        position: 'static', pointerEvents: 'auto', zIndex: 'auto',
      },
      getBoundingClientRect: () => ({
        x: 480, y: 300, left: 480, top: 300, right: 600, bottom: 340, width: 120, height: 40,
      }),
      getAttribute: () => null,
      matches: () => false,
      contains(other) { return other === button; },
    };
    const cover = {
      id: 'cover',
      tagName: 'DIV',
      textContent: 'Opaque cover',
      __style: {
        display: 'block', visibility: 'visible', opacity: '1',
        position: 'fixed', pointerEvents: 'auto', zIndex: '5',
      },
      getBoundingClientRect: () => ({
        x: 0, y: 0, left: 0, top: 0, right: 1042, bottom: 632, width: 1042, height: 632,
      }),
      getAttribute: () => null,
      matches: () => false,
      contains(other) { return other === cover; },
    };
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    const previousCss = globalThis.CSS;
    const previousGetComputedStyle = globalThis.getComputedStyle;
    globalThis.window = { innerWidth: 1042, innerHeight: 632 };
    globalThis.CSS = { escape: (value) => String(value) };
    globalThis.getComputedStyle = (element) => element.__style;
    globalThis.document = {
      documentElement: { clientWidth: 1042, clientHeight: 632 },
      querySelectorAll: (selector) => selector === 'body *' ? [button, cover] : [],
      elementsFromPoint: () => [cover, button],
    };
    try {
      const parsed = JSON.parse(Function('source', 'return eval(source);')(T.dismissModalScript()));
      expect(parsed).toMatchObject({ ok: false, reason: 'overlay-not-dialog', overlays: ['#cover'] });
    } finally {
      globalThis.window = previousWindow;
      globalThis.document = previousDocument;
      globalThis.CSS = previousCss;
      globalThis.getComputedStyle = previousGetComputedStyle;
    }
  });
});

// =========================================================================
// overlay detector
// =========================================================================

describe('overlay detector', () => {
  function overlayFixtureElement({
    id,
    tagName = 'DIV',
    text = '',
    position = 'static',
    pointerEvents = 'auto',
    zIndex = 'auto',
    role = null,
    ariaModal = null,
    rect,
    parent = null,
  }) {
    const element = {
      id,
      tagName,
      className: '',
      textContent: text,
      parentElement: parent,
      __style: {
        display: 'block',
        visibility: 'visible',
        opacity: '1',
        position,
        pointerEvents,
        zIndex,
      },
      getBoundingClientRect: () => ({
        x: rect.x,
        y: rect.y,
        left: rect.x,
        top: rect.y,
        right: rect.x + rect.w,
        bottom: rect.y + rect.h,
        width: rect.w,
        height: rect.h,
      }),
      getAttribute: (name) => ({
        role,
        'aria-modal': ariaModal,
        'aria-label': null,
        'aria-labelledby': null,
      }[name] ?? null),
      matches: () => tagName === 'DIALOG' || role === 'dialog' || ariaModal === 'true',
      contains(other) {
        for (let current = other; current; current = current.parentElement) {
          if (current === element) return true;
        }
        return false;
      },
    };
    return element;
  }

  function runOverlayPageFixture({ elements, targetPoint, topElement, targetContext = null, source = null, elementConstructor = null, viewport = null, elementsFromPoint = null }) {
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    const previousCss = globalThis.CSS;
    const previousGetComputedStyle = globalThis.getComputedStyle;
    const previousElement = Object.getOwnPropertyDescriptor(globalThis, 'Element');
    const innerWidth = viewport?.innerWidth ?? 1440;
    const innerHeight = viewport?.innerHeight ?? 900;
    const clientWidth = viewport?.clientWidth ?? innerWidth;
    const clientHeight = viewport?.clientHeight ?? innerHeight;
    const pointInside = (point, element) => {
      const rect = element.getBoundingClientRect();
      return point.x >= rect.left && point.x <= rect.right
        && point.y >= rect.top && point.y <= rect.bottom;
    };
    const hitTest = (x, y) => (pointInside({ x, y }, topElement) ? topElement : null);
    globalThis.window = {
      innerWidth,
      innerHeight,
      devicePixelRatio: 2,
    };
    globalThis.CSS = { escape: (value) => String(value) };
    globalThis.getComputedStyle = (element) => element.__style;
    globalThis.Element = elementConstructor || class FixtureElement {
      static [Symbol.hasInstance](value) {
        return elements.includes(value);
      }
    };
    globalThis.document = {
      documentElement: { clientWidth, clientHeight },
      body: { clientWidth, clientHeight },
      querySelector: (selector) => elements.find(element => `#${element.id}` === selector) || null,
      querySelectorAll: (selector) => selector === 'body *'
        ? elements
        : elements.filter(element => element.matches(selector)),
      elementFromPoint: hitTest,
      ...(elementsFromPoint ? { elementsFromPoint } : {}),
    };
    try {
      const runPageScript = Function('source', 'return eval(source);');
      return {
        model: JSON.parse(runPageScript.call(targetContext, source || T.overlayDetectorScript({ targetPoint }))),
        oracleTopElement: targetPoint ? hitTest(targetPoint.x, targetPoint.y) : topElement,
      };
    } finally {
      globalThis.window = previousWindow;
      globalThis.document = previousDocument;
      globalThis.CSS = previousCss;
      globalThis.getComputedStyle = previousGetComputedStyle;
      if (previousElement) Object.defineProperty(globalThis, 'Element', previousElement);
      else delete globalThis.Element;
    }
  }

  it('builds a page-side script that scans dialogs and hit-test blockers', () => {
    const script = T.overlayDetectorScript({ targetPoint: { input: '@4', x: 10, y: 20 } });
    expect(script).toMatch(/elementFromPoint/);
    expect(script).toMatch(/aria-modal/);
    expect(script).toMatch(/role="dialog"/);
    expect(script).toContain('"input":"@4"');
  });

  it('#276 page-level overlay reports a visible fixed inset:0 overlay despite a scrollbar gutter', async () => {
    const overlay = overlayFixtureElement({
      id: 'p20ov',
      position: 'fixed',
      zIndex: '99999',
      rect: { x: 0, y: 0, w: 1027, h: 632 },
    });
    const scrollbarViewport = {
      innerWidth: 1042,
      innerHeight: 632,
      clientWidth: 1027,
      clientHeight: 632,
    };
    const targetPoint = {
      input: '#p20btn',
      x: 80,
      y: 40,
      descriptor: '<BUTTON> "Continue"',
    };
    const button = overlayFixtureElement({
      id: 'p20btn',
      tagName: 'BUTTON',
      text: 'Continue',
      rect: { x: 40, y: 24, w: 80, h: 32 },
    });

    const pageLevel = runOverlayPageFixture({
      elements: [overlay],
      targetPoint: null,
      topElement: overlay,
      viewport: scrollbarViewport,
    });
    expect(pageLevel.model).toMatchObject({
      schema: 'chrome-cdp-ex.overlays.v1',
      overlayCount: 1,
      blocking: true,
    });
    expect(pageLevel.model.overlayCount).toBeGreaterThanOrEqual(1);
    expect(pageLevel.model.overlays[0]).toMatchObject({
      selector: '#p20ov',
      kind: 'overlay',
      blocking: true,
      coversViewport: true,
    });

    const targeted = runOverlayPageFixture({
      elements: [button, overlay],
      targetPoint,
      topElement: overlay,
      viewport: scrollbarViewport,
    });
    expect(targeted.model.target.blocked).toBe(true);
    expect(targeted.model.overlays).toContainEqual(expect.objectContaining({ selector: '#p20ov' }));

    overlay.__style.display = 'none';
    const hidden = runOverlayPageFixture({
      elements: [overlay],
      targetPoint: null,
      topElement: overlay,
      viewport: scrollbarViewport,
    });
    expect(hidden.model).toMatchObject({ overlayCount: 0, blocking: false, overlays: [] });

    overlay.__style.display = 'block';
    const cdp = createMockCDP({
      'Runtime.evaluate': (params) => {
        const { model } = runOverlayPageFixture({
          elements: [overlay],
          targetPoint: null,
          topElement: overlay,
          viewport: scrollbarViewport,
          source: params.expression,
        });
        return { result: { value: JSON.stringify(model) } };
      },
    });
    const json = JSON.parse(await T.overlayStr(cdp, 'sid1', '62E1DF19ABCDEF', ['--format', 'json'], new Map(), {}));
    expect(json).toMatchObject({
      schema: 'chrome-cdp-ex.overlays.v1',
      overlayCount: 1,
      blocking: true,
      nextCommand: 'cdp dismiss-modal 62E1DF19',
    });
    const text = await T.overlayStr(cdp, 'sid1', '62E1DF19ABCDEF', [], new Map(), {});
    expect(text).toContain('Overlay detector: blocking');
    expect(text).not.toContain('Overlay detector: clear');
  });

  it('does not classify a fixed target as its own blocking overlay', () => {
    const target = overlayFixtureElement({
      id: 'clear-action',
      tagName: 'BUTTON',
      text: 'Clear bottom action',
      position: 'fixed',
      zIndex: '20',
      rect: { x: 1120, y: 800, w: 240, h: 48 },
    });
    const targetPoint = {
      input: '#clear-action',
      x: 1240,
      y: 824,
      descriptor: '<BUTTON> "Clear bottom action"',
    };

    const { model, oracleTopElement } = runOverlayPageFixture({
      elements: [target],
      targetPoint,
      topElement: target,
    });

    expect(oracleTopElement).toBe(target);
    expect(model).toMatchObject({
      schema: 'chrome-cdp-ex.overlays.v1',
      viewport: { width: 1440, height: 900 },
      overlayCount: 0,
      blocking: false,
      target: {
        input: '#clear-action',
        blocked: false,
      },
      overlays: [],
      nextCommand: null,
    });
  });

  it('does not mistake an ambient Window getBoundingClientRect accessor for selector target identity', async () => {
    const target = overlayFixtureElement({
      id: 'ambient-safe-action',
      tagName: 'BUTTON',
      text: 'Continue safely',
      position: 'fixed',
      zIndex: '20',
      rect: { x: 1120, y: 800, w: 240, h: 48 },
    });
    const targetPoint = {
      input: '#ambient-safe-action',
      x: 1240,
      y: 824,
      descriptor: '<BUTTON> "Continue safely"',
    };
    let ambientRectReads = 0;
    const ambientWindow = {};
    Object.defineProperty(ambientWindow, 'getBoundingClientRect', {
      get() {
        ambientRectReads += 1;
        return () => ({ x: 0, y: 0, width: 1440, height: 900 });
      },
    });
    const cdp = createMockCDP({
      'Runtime.evaluate': (params) => {
        if (!params.expression.includes('chrome-cdp-ex.overlays.v1')) {
          return { result: { value: JSON.stringify({ ok: true, ...targetPoint }) } };
        }
        const { model } = runOverlayPageFixture({
          elements: [target],
          targetPoint,
          topElement: target,
          targetContext: ambientWindow,
          source: params.expression,
        });
        return { result: { value: JSON.stringify(model) } };
      },
    });

    const out = JSON.parse(await T.overlayStr(
      cdp,
      'sid1',
      'abc123',
      ['#ambient-safe-action', '--format', 'json'],
      new Map(),
      {},
    ));

    expect(ambientRectReads).toBe(0);
    expect(out).toMatchObject({
      blocking: false,
      overlayCount: 0,
      target: { input: '#ambient-safe-action', blocked: false },
    });
  });

  it('treats a descendant hit inside a sticky target as reachable', () => {
    const target = overlayFixtureElement({
      id: 'sticky-action',
      tagName: 'BUTTON',
      text: 'Save',
      position: 'sticky',
      zIndex: '10',
      rect: { x: 100, y: 40, w: 160, h: 48 },
    });
    const icon = overlayFixtureElement({
      id: 'save-icon',
      tagName: 'SPAN',
      text: '✓',
      rect: { x: 170, y: 54, w: 20, h: 20 },
      parent: target,
    });
    const targetPoint = {
      input: '#sticky-action',
      x: 180,
      y: 64,
      descriptor: '<BUTTON> "Save"',
    };

    const { model, oracleTopElement } = runOverlayPageFixture({
      elements: [target, icon],
      targetPoint,
      topElement: icon,
    });

    expect(oracleTopElement).toBe(icon);
    expect(model).toMatchObject({
      overlayCount: 0,
      blocking: false,
      target: {
        input: '#sticky-action',
        blocked: false,
        topElement: { selector: '#save-icon' },
      },
      overlays: [],
      nextCommand: null,
    });
  });

  it('does not classify a fixed @ref target as its own blocker', () => {
    const target = overlayFixtureElement({
      id: 'ref-action',
      tagName: 'BUTTON',
      text: 'Continue with ref',
      position: 'fixed',
      zIndex: '20',
      rect: { x: 1120, y: 800, w: 240, h: 48 },
    });
    const targetPoint = {
      input: '@4',
      x: 1240,
      y: 824,
      descriptor: '<BUTTON> "Continue with ref"',
    };

    const { model, oracleTopElement } = runOverlayPageFixture({
      elements: [target],
      targetPoint,
      topElement: target,
      targetContext: target,
      source: T.overlayDetectorScript({ targetPoint, objectBoundTarget: true }),
    });

    expect(oracleTopElement).toBe(target);
    expect(model).toMatchObject({
      schema: 'chrome-cdp-ex.overlays.v1',
      overlayCount: 0,
      blocking: false,
      target: {
        input: '@4',
        blocked: false,
      },
      overlays: [],
      nextCommand: null,
    });
  });

  it('keeps a distinct fixed occluder blocking the target', () => {
    const target = overlayFixtureElement({
      id: 'covered-action',
      tagName: 'BUTTON',
      text: 'Continue',
      position: 'fixed',
      zIndex: '10',
      rect: { x: 1120, y: 800, w: 240, h: 48 },
    });
    const occluder = overlayFixtureElement({
      id: 'blocking-overlay',
      text: 'Cookie settings',
      position: 'fixed',
      zIndex: '30',
      rect: { x: 1080, y: 770, w: 320, h: 100 },
    });
    const targetPoint = {
      input: '#covered-action',
      x: 1240,
      y: 824,
      descriptor: '<BUTTON> "Continue"',
    };

    const { model, oracleTopElement } = runOverlayPageFixture({
      elements: [target, occluder],
      targetPoint,
      topElement: occluder,
    });

    expect(oracleTopElement).toBe(occluder);
    expect(model).toMatchObject({
      blocking: true,
      target: {
        blocked: true,
        topElement: { kind: 'overlay', selector: '#blocking-overlay' },
      },
    });
    expect(model.overlays).toContainEqual(expect.objectContaining({
      kind: 'overlay',
      selector: '#blocking-overlay',
      blocking: true,
    }));
  });

  it('does not report a full-viewport fixed shell that contains the target', () => {
    const shell = overlayFixtureElement({
      id: 'app',
      text: 'App',
      position: 'fixed',
      zIndex: '1',
      rect: { x: 0, y: 0, w: 1440, h: 900 },
    });
    const button = overlayFixtureElement({
      id: 'submit',
      tagName: 'BUTTON',
      text: 'Submit',
      rect: { x: 100, y: 120, w: 120, h: 40 },
      parent: shell,
    });
    const targetPoint = {
      input: '#submit',
      x: 160,
      y: 140,
      descriptor: '<BUTTON> "Submit"',
    };
    const { model } = runOverlayPageFixture({
      elements: [shell, button],
      targetPoint,
      topElement: button,
    });
    expect(model).toMatchObject({
      blocking: false,
      overlayCount: 0,
      target: { input: '#submit', blocked: false },
      overlays: [],
    });
    expect(JSON.stringify(model)).not.toContain('#app');
  });

  it('names an absolute popover over the target instead of the shell that contains the target', () => {
    const shell = overlayFixtureElement({
      id: 'app',
      text: 'App',
      position: 'fixed',
      zIndex: '1',
      rect: { x: 0, y: 0, w: 1440, h: 900 },
    });
    const button = overlayFixtureElement({
      id: 'submit',
      tagName: 'BUTTON',
      text: 'Submit',
      rect: { x: 100, y: 120, w: 120, h: 40 },
      parent: shell,
    });
    const popover = overlayFixtureElement({
      id: 'menu',
      text: 'Account menu',
      position: 'absolute',
      zIndex: '5',
      rect: { x: 80, y: 100, w: 220, h: 120 },
      parent: shell,
    });
    const targetPoint = {
      input: '#submit',
      x: 160,
      y: 140,
      descriptor: '<BUTTON> "Submit"',
    };
    const { model } = runOverlayPageFixture({
      elements: [shell, button, popover],
      targetPoint,
      topElement: popover,
    });
    expect(model.target).toMatchObject({
      blocked: true,
      topElement: { selector: '#menu' },
    });
    expect(model.overlays.map(overlay => overlay.selector)).toContain('#menu');
    expect(model.overlays.map(overlay => overlay.selector)).not.toContain('#app');
  });

  it('does not report a full-viewport fixed shell when no target is given and the shell contains the hit', () => {
    const shell = overlayFixtureElement({
      id: 'app',
      text: 'App',
      position: 'fixed',
      zIndex: '1',
      rect: { x: 0, y: 0, w: 1440, h: 900 },
    });
    const button = overlayFixtureElement({
      id: 'submit',
      tagName: 'BUTTON',
      text: 'Submit',
      rect: { x: 660, y: 430, w: 120, h: 40 },
      parent: shell,
    });
    const { model } = runOverlayPageFixture({
      elements: [shell, button],
      targetPoint: null,
      topElement: button,
      elementsFromPoint: () => [button, shell],
    });
    expect(model).toMatchObject({ blocking: false, overlayCount: 0, overlays: [] });
  });

  it('still reports a full-viewport fixed cover that does not contain the target', () => {
    const button = overlayFixtureElement({
      id: 'submit',
      tagName: 'BUTTON',
      text: 'Submit',
      rect: { x: 100, y: 120, w: 120, h: 40 },
    });
    const cover = overlayFixtureElement({
      id: 'cover',
      text: 'Opaque cover',
      position: 'fixed',
      zIndex: '5',
      rect: { x: 0, y: 0, w: 1440, h: 900 },
    });
    const targetPoint = {
      input: '#submit',
      x: 160,
      y: 140,
      descriptor: '<BUTTON> "Submit"',
    };
    const { model } = runOverlayPageFixture({
      elements: [button, cover],
      targetPoint,
      topElement: cover,
      elementsFromPoint: () => [cover, button],
    });
    expect(model.blocking).toBe(true);
    expect(model.target).toMatchObject({
      blocked: true,
      topElement: { selector: '#cover' },
    });
    expect(model.overlays.map(overlay => overlay.selector)).toContain('#cover');
  });

  it('keeps a dialog that owns the target hit point blocking', () => {
    const target = overlayFixtureElement({
      id: 'dialog-covered-action',
      tagName: 'BUTTON',
      text: 'Delete',
      position: 'fixed',
      zIndex: '10',
      rect: { x: 620, y: 410, w: 200, h: 48 },
    });
    const dialog = overlayFixtureElement({
      id: 'confirm-dialog',
      tagName: 'DIALOG',
      text: 'Confirm deletion',
      position: 'fixed',
      zIndex: '40',
      role: 'dialog',
      ariaModal: 'true',
      rect: { x: 520, y: 330, w: 400, h: 240 },
    });
    const targetPoint = {
      input: '#dialog-covered-action',
      x: 720,
      y: 434,
      descriptor: '<BUTTON> "Delete"',
    };

    const { model, oracleTopElement } = runOverlayPageFixture({
      elements: [target, dialog],
      targetPoint,
      topElement: dialog,
    });

    expect(oracleTopElement).toBe(dialog);
    expect(model).toMatchObject({
      blocking: true,
      target: {
        blocked: true,
        topElement: { kind: 'dialog', selector: '#confirm-dialog' },
      },
    });
    expect(model.overlays).toContainEqual(expect.objectContaining({
      kind: 'dialog',
      selector: '#confirm-dialog',
      blocking: true,
    }));
  });

  it('detects a parent dialog over a frame-scoped target in the top document', async () => {
    const frameOwner = overlayFixtureElement({
      id: 'checkout-frame',
      tagName: 'IFRAME',
      rect: { x: 50, y: 40, w: 300, h: 200 },
    });
    const parentDialog = overlayFixtureElement({
      id: 'parent-dialog',
      tagName: 'DIALOG',
      text: 'Parent confirmation',
      position: 'fixed',
      zIndex: '40',
      role: 'dialog',
      ariaModal: 'true',
      rect: { x: 80, y: 20, w: 220, h: 120 },
    });
    const targetPoint = {
      input: '@f2:1',
      x: 110,
      y: 55,
      descriptor: '<BUTTON> "Pay now"',
    };
    const refState = {
      frameRefs: new Map([['@f2', {
        frameRef: '@f2',
        frameId: 'checkout-frame-id',
        parentId: 'main-frame-id',
        refs: new Map([[1, 222]]),
      }]]),
    };
    let detectorRealm = null;
    const cdp = createMockCDP({
      'DOM.resolveNode': (params) => {
        if (params.backendNodeId === 222) return { object: { objectId: 'child-button' } };
        if (params.backendNodeId === 333) return { object: { objectId: 'frame-owner' } };
        throw new Error(`unexpected backend node ${params.backendNodeId}`);
      },
      'DOM.getFrameOwner': () => ({ backendNodeId: 333 }),
      'Runtime.callFunctionOn': (params) => {
        if (params.objectId === 'child-button' && !params.functionDeclaration.includes('chrome-cdp-ex.overlays.v1')) {
          return { result: { value: { x: 10, y: 5, w: 100, h: 20, tag: 'BUTTON', text: 'Pay now' } } };
        }
        if (params.objectId === 'frame-owner') {
          return { result: { value: { x: 50, y: 40, w: 300, h: 200 } } };
        }
        detectorRealm = 'child';
        return { result: { value: JSON.stringify({
          schema: 'chrome-cdp-ex.overlays.v1',
          viewport: { width: 300, height: 200 },
          target: { ...targetPoint, blocked: false, topElement: null },
          overlayCount: 0,
          blocking: false,
          overlays: [],
          nextCommand: null,
        }) } };
      },
      'Runtime.evaluate': (params) => {
        detectorRealm = 'parent';
        const { model } = runOverlayPageFixture({
          elements: [frameOwner, parentDialog],
          targetPoint,
          topElement: parentDialog,
          source: params.expression,
        });
        return { result: { value: JSON.stringify(model) } };
      },
    });

    const out = JSON.parse(await T.overlayStr(
      cdp,
      'sid1',
      'abc123',
      ['@f2:1', '--format', 'json'],
      new Map(),
      refState,
    ));

    expect(detectorRealm).toBe('parent');
    expect(out).toMatchObject({
      schema: 'chrome-cdp-ex.overlays.v1',
      viewport: { width: 1440, height: 900 },
      blocking: true,
      target: {
        input: '@f2:1',
        x: 110,
        y: 55,
        blocked: true,
        topElement: { kind: 'dialog', selector: '#parent-dialog' },
      },
      nextCommand: 'cdp dismiss-modal abc123',
    });
    expect(out.overlays).toContainEqual(expect.objectContaining({
      kind: 'dialog',
      selector: '#parent-dialog',
      blocking: true,
    }));
  });

  it('keeps a targeted dialog page-blocking without treating it as its own target blocker', async () => {
    const dialog = overlayFixtureElement({
      id: 'target-dialog',
      tagName: 'DIALOG',
      text: 'Review changes',
      position: 'fixed',
      zIndex: '40',
      role: 'dialog',
      ariaModal: 'true',
      rect: { x: 520, y: 330, w: 400, h: 240 },
    });
    const targetPoint = {
      input: '#target-dialog',
      x: 720,
      y: 450,
      descriptor: '<DIALOG> "Review changes"',
    };
    const cdp = createMockCDP({
      'Runtime.evaluate': (params) => {
        if (!params.expression.includes('chrome-cdp-ex.overlays.v1')) {
          return { result: { value: JSON.stringify({ ok: true, ...targetPoint }) } };
        }
        const { model, oracleTopElement } = runOverlayPageFixture({
          elements: [dialog],
          targetPoint,
          topElement: dialog,
          source: params.expression,
        });
        expect(oracleTopElement).toBe(dialog);
        return { result: { value: JSON.stringify(model) } };
      },
    });

    const out = JSON.parse(await T.overlayStr(
      cdp,
      'sid1',
      'abc123',
      ['#target-dialog', '--format', 'json'],
      new Map(),
      {},
    ));

    expect(out).toMatchObject({
      schema: 'chrome-cdp-ex.overlays.v1',
      blocking: true,
      overlayCount: 1,
      target: {
        input: '#target-dialog',
        blocked: false,
      },
      nextCommand: 'cdp dismiss-modal abc123',
    });
    expect(out.overlays).toContainEqual(expect.objectContaining({
      kind: 'dialog',
      selector: '#target-dialog',
      blocking: true,
    }));
  });

  it('formats a clear page when no blocking overlay is visible', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { value: JSON.stringify({
        schema: 'chrome-cdp-ex.overlays.v1',
        viewport: { width: 800, height: 600 },
        target: null,
        overlayCount: 0,
        blocking: false,
        overlays: [],
        nextCommand: null,
      }) } }),
    });

    const out = await T.overlayStr(cdp, 'sid1', 'abc123', [], new Map(), {});
    expect(out).toContain('Overlay detector: clear');
    expect(out).toContain('No visible blocking overlays/dialogs detected.');
    expect(out).toContain('Next: continue');
  });

  it('reports a blocking dialog and concrete dismissal command for a target ref', async () => {
    const refMap = new Map([[4, 444]]);
    const detectorModel = {
      schema: 'chrome-cdp-ex.overlays.v1',
      viewport: { width: 800, height: 600 },
      target: {
        input: '@4',
        x: 60,
        y: 40,
        descriptor: '<BUTTON> "Submit"',
        blocked: true,
        topElement: { kind: 'dialog', selector: '#motd', text: 'MOTD' },
      },
      overlayCount: 1,
      blocking: true,
      overlays: [{
        kind: 'dialog',
        selector: '#motd',
        role: 'dialog',
        label: 'MOTD',
        text: 'Press any key',
        pointerEvents: 'auto',
        zIndex: '20',
        rect: { x: 100, y: 90, w: 320, h: 180 },
        coversTarget: true,
        topAtCenter: true,
      }],
      nextCommand: 'cdp dismiss-modal abc123',
    };
    const detectorResult = (source) => {
      expect(source).toContain('"input":"@4"');
      expect(source).toContain('"x":60');
      expect(source).toContain('"y":40');
      return { result: { value: JSON.stringify(detectorModel) } };
    };
    const cdp = createMockCDP({
      'DOM.resolveNode': () => ({ object: { objectId: 'target-button' } }),
      'Runtime.callFunctionOn': (params) => params.functionDeclaration.includes('chrome-cdp-ex.overlays.v1')
        ? detectorResult(params.functionDeclaration)
        : ({ result: { value: { x: 20, y: 30, w: 80, h: 20, tag: 'BUTTON', text: 'Submit' } } }),
      'Runtime.evaluate': (params) => detectorResult(params.expression),
    });

    const out = await T.overlayStr(cdp, 'sid1', 'abc123', ['@4'], refMap, {});
    expect(out).toContain('Overlay detector: blocking');
    expect(out).toContain('Target: @4 at (60,40) — blocked by [dialog] #motd "MOTD"');
    expect(out).toContain('1. [dialog] #motd role=dialog z=20 pointer=auto rect=(100,90 320×180)');
    expect(out).toContain('Next: cdp dismiss-modal abc123');
  });

  it('runs the detector against the resolved @ref node without exposing its object id', async () => {
    const refMap = new Map([[4, 444]]);
    let detectorCall = null;
    const cdp = createMockCDP({
      'DOM.resolveNode': () => ({ object: { objectId: 'target-button-object' } }),
      'Runtime.callFunctionOn': (params) => {
        if (params.functionDeclaration.includes('getBoundingClientRect')
          && !params.functionDeclaration.includes('chrome-cdp-ex.overlays.v1')) {
          return { result: { value: {
            x: 20,
            y: 30,
            w: 80,
            h: 20,
            tag: 'BUTTON',
            text: 'Submit',
          } } };
        }
        detectorCall = params;
        return { result: { value: JSON.stringify({
          schema: 'chrome-cdp-ex.overlays.v1',
          viewport: { width: 1440, height: 900 },
          target: {
            input: '@4',
            x: 60,
            y: 40,
            descriptor: '<BUTTON> "Submit"',
            blocked: false,
            topElement: { kind: 'top-element', selector: '#submit', text: 'Submit' },
          },
          overlayCount: 0,
          blocking: false,
          overlays: [],
          nextCommand: null,
        }) } };
      },
      'Runtime.evaluate': () => {
        throw new Error('@ref overlay identity must not fall back to Runtime.evaluate');
      },
    });

    const out = await T.overlayStr(cdp, 'sid1', 'abc123', ['@4', '--format', 'json'], refMap, {});
    const model = JSON.parse(out);

    expect(detectorCall).toMatchObject({
      objectId: 'target-button-object',
      returnByValue: true,
    });
    expect(detectorCall.functionDeclaration).toContain('chrome-cdp-ex.overlays.v1');
    expect(detectorCall.functionDeclaration).not.toContain('target-button-object');
    expect(model).toMatchObject({
      schema: 'chrome-cdp-ex.overlays.v1',
      blocking: false,
      target: { input: '@4', blocked: false },
      nextCommand: null,
    });
    expect(model.target).not.toHaveProperty('objectId');
  });

  it.each([
    ['a forged class', class PageControlledElement {}],
    ['a non-constructible arrow', () => null],
  ])('keeps plain @ref identity trusted when page Element is %s', async (_label, elementConstructor) => {
    const target = overlayFixtureElement({
      id: 'trusted-ref-action',
      tagName: 'BUTTON',
      text: 'Continue with trusted ref',
      position: 'fixed',
      zIndex: '20',
      rect: { x: 1120, y: 800, w: 240, h: 48 },
    });
    const targetPoint = {
      input: '@4',
      x: 1240,
      y: 824,
      descriptor: '<BUTTON> "Continue with trusted ref"',
    };
    const refMap = new Map([[4, 444]]);
    let detectorSource = null;
    const cdp = createMockCDP({
      'DOM.resolveNode': () => ({ object: { objectId: 'trusted-ref-object' } }),
      'Runtime.callFunctionOn': (params) => {
        if (!params.functionDeclaration.includes('chrome-cdp-ex.overlays.v1')) {
          return { result: { value: {
            x: 1120,
            y: 800,
            w: 240,
            h: 48,
            tag: 'BUTTON',
            text: 'Continue with trusted ref',
          } } };
        }
        detectorSource = params.functionDeclaration;
        const { model } = runOverlayPageFixture({
          elements: [target],
          targetPoint,
          topElement: target,
          targetContext: target,
          source: `(${params.functionDeclaration}).call(this)`,
          elementConstructor,
        });
        return { result: { value: JSON.stringify(model) } };
      },
      'Runtime.evaluate': () => {
        throw new Error('plain @ref overlay identity must remain object-bound');
      },
    });

    const out = JSON.parse(await T.overlayStr(
      cdp,
      'sid1',
      'abc123',
      ['@4', '--format', 'json'],
      refMap,
      {},
    ));

    expect(detectorSource).toContain('chrome-cdp-ex.overlays.v1');
    expect(detectorSource).not.toContain('instanceof Element');
    expect(out).toMatchObject({
      blocking: false,
      overlayCount: 0,
      target: { input: '@4', blocked: false },
    });
  });

  it('keeps the @ref object capability out of detector source under inherited toJSON', async () => {
    const refMap = new Map([[4, 444]]);
    const objectId = 'remote-capability-must-stay-private';
    const clearModel = '{"schema":"chrome-cdp-ex.overlays.v1","viewport":{"width":1440,"height":900},"target":{"input":"@4","x":60,"y":40,"descriptor":"<BUTTON> \\"Submit\\"","blocked":false,"topElement":null},"overlayCount":0,"blocking":false,"overlays":[],"nextCommand":null}';
    let detectorSource = null;
    const cdp = createMockCDP({
      'DOM.resolveNode': () => ({ object: { objectId } }),
      'Runtime.callFunctionOn': (params) => {
        if (params.functionDeclaration.includes('chrome-cdp-ex.overlays.v1')) {
          detectorSource = params.functionDeclaration;
          return { result: { value: clearModel } };
        }
        return { result: { value: {
          x: 20,
          y: 30,
          w: 80,
          h: 20,
          tag: 'BUTTON',
          text: 'Submit',
        } } };
      },
    });
    const previousToJSON = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON');
    Object.defineProperty(Object.prototype, 'toJSON', {
      configurable: true,
      value() {
        const exposed = { ...this };
        if ('objectId' in this) exposed.objectId = this.objectId;
        return exposed;
      },
    });

    let out;
    try {
      out = JSON.parse(await T.overlayStr(
        cdp,
        'sid1',
        'abc123',
        ['@4', '--format', 'json'],
        refMap,
        {},
      ));
    } finally {
      if (previousToJSON) Object.defineProperty(Object.prototype, 'toJSON', previousToJSON);
      else delete Object.prototype.toJSON;
    }

    expect(detectorSource).toContain('chrome-cdp-ex.overlays.v1');
    expect(detectorSource).not.toContain(objectId);
    expect(out.target).toMatchObject({ input: '@4', blocked: false });
    expect(out.target).not.toHaveProperty('objectId');
  });

  it('returns versioned overlay JSON for tool-calling agents', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { value: JSON.stringify({
        schema: 'chrome-cdp-ex.overlays.v1',
        viewport: { width: 800, height: 600 },
        target: null,
        overlayCount: 0,
        blocking: false,
        overlays: [],
        nextCommand: null,
      }) } }),
    });

    const out = await T.overlayStr(cdp, 'sid1', 'abc123', ['--format', 'json'], new Map(), {});
    expect(JSON.parse(out).schema).toBe('chrome-cdp-ex.overlays.v1');
  });

  // #629: parentElement / children let soleRenderedChain see siblings the centre stack misses.
  // Missing children on the older fixtures stays "sole child" and keeps the shell tests green.
  function paintedNode({
    id = '',
    tagName = 'DIV',
    text = '',
    position = 'static',
    pointerEvents = 'auto',
    zIndex = 'auto',
    role = null,
    rect,
    style = {},
  }) {
    const node = {
      id,
      tagName,
      className: '',
      textContent: text,
      parentElement: null,
      children: [],
      __style: {
        display: 'block',
        visibility: 'visible',
        opacity: '1',
        position,
        pointerEvents,
        zIndex,
        ...style,
      },
      getBoundingClientRect: () => ({
        x: rect.x,
        y: rect.y,
        left: rect.x,
        top: rect.y,
        right: rect.x + rect.w,
        bottom: rect.y + rect.h,
        width: rect.w,
        height: rect.h,
      }),
      getAttribute: (name) => (name === 'role' ? role : null),
      matches: () => tagName === 'DIALOG' || role === 'dialog',
      contains(other) {
        for (let current = other; current; current = current.parentElement) {
          if (current === node) return true;
        }
        return false;
      },
    };
    return node;
  }

  function adopt(parent, child) {
    child.parentElement = parent;
    parent.children.push(child);
    return child;
  }

  const FULL = { x: 0, y: 0, w: 1440, h: 900 };

  function shortPageRoots() {
    const html = paintedNode({ tagName: 'HTML', rect: FULL });
    const head = paintedNode({ tagName: 'HEAD', rect: { x: 0, y: 0, w: 1440, h: 20 } });
    const body = paintedNode({ tagName: 'BODY', rect: { x: 0, y: 0, w: 1440, h: 80 } });
    adopt(html, head);
    adopt(html, body);
    return { html, head, body };
  }

  function runPainted({ elements, elementsFromPoint, topElement }) {
    const overlay = runOverlayPageFixture({
      elements,
      targetPoint: null,
      topElement,
      elementsFromPoint,
    });
    const dismissed = runOverlayPageFixture({
      elements,
      targetPoint: null,
      topElement,
      elementsFromPoint,
      source: T.dismissModalScript(),
    });
    return { model: overlay.model, dismissed: dismissed.model };
  }

  it('reports #backdrop blocking when a short page\'s centre stack is only html/body behind a role-less fixed inset:0 backdrop with a sibling corner panel and no target', () => {
    const { html, body } = shortPageRoots();
    const backdrop = paintedNode({
      id: 'backdrop',
      position: 'fixed',
      zIndex: '5',
      rect: FULL,
    });
    const panel = paintedNode({
      id: 'panel',
      text: 'Details',
      rect: { x: 1300, y: 12, w: 120, h: 64 },
    });
    adopt(body, backdrop);
    adopt(body, panel);
    const { model } = runPainted({
      elements: [backdrop, panel],
      topElement: backdrop,
      // The corner panel is not under the centre. Only the backdrop, body, and html are.
      elementsFromPoint: () => [backdrop, body, html],
    });
    expect(model).toMatchObject({
      blocking: true,
      overlayCount: 1,
      target: null,
    });
    expect(model.overlays).toContainEqual(expect.objectContaining({
      kind: 'overlay',
      selector: '#backdrop',
      role: '',
      blocking: true,
      coversViewport: true,
    }));
  });

  it('dismiss-modal returns overlay-not-dialog for a role-less fixed inset:0 backdrop with a sibling corner panel on a short page', () => {
    const { html, body } = shortPageRoots();
    const backdrop = paintedNode({
      id: 'backdrop',
      position: 'fixed',
      zIndex: '5',
      rect: FULL,
    });
    const panel = paintedNode({
      id: 'panel',
      text: 'Details',
      rect: { x: 1300, y: 12, w: 120, h: 64 },
    });
    adopt(body, backdrop);
    adopt(body, panel);
    const { dismissed } = runPainted({
      elements: [backdrop, panel],
      topElement: backdrop,
      elementsFromPoint: () => [backdrop, body, html],
    });
    expect(dismissed).toEqual({ ok: false, reason: 'overlay-not-dialog', overlays: ['#backdrop'] });
  });

  function nestedShellPage() {
    const { html, body } = shortPageRoots();
    const ignored = [
      paintedNode({ tagName: 'SCRIPT', rect: { x: 0, y: 0, w: 40, h: 12 } }),
      paintedNode({ tagName: 'STYLE', rect: { x: 0, y: 0, w: 40, h: 12 } }),
      paintedNode({ tagName: 'TEMPLATE', rect: { x: 0, y: 0, w: 40, h: 12 } }),
      paintedNode({ tagName: 'LINK', rect: { x: 0, y: 0, w: 40, h: 12 } }),
      paintedNode({ tagName: 'META', rect: { x: 0, y: 0, w: 40, h: 12 } }),
      paintedNode({ tagName: 'NOSCRIPT', rect: { x: 0, y: 0, w: 40, h: 12 } }),
      paintedNode({ rect: { x: 0, y: 0, w: 80, h: 20 }, style: { display: 'none' } }),
      paintedNode({ rect: { x: 0, y: 0, w: 80, h: 20 }, style: { visibility: 'hidden' } }),
      paintedNode({ rect: { x: 0, y: 0, w: 0, h: 0 } }),
    ];
    for (const node of ignored) adopt(body, node);
    const shell = paintedNode({
      id: 'shell',
      text: 'App',
      position: 'fixed',
      zIndex: '1',
      rect: FULL,
    });
    const inner = paintedNode({
      id: 'inner',
      text: 'Frame',
      position: 'fixed',
      zIndex: '1',
      rect: FULL,
    });
    const button = paintedNode({
      id: 'submit',
      tagName: 'BUTTON',
      text: 'Submit',
      rect: { x: 100, y: 120, w: 120, h: 40 },
    });
    adopt(body, shell);
    adopt(shell, inner);
    adopt(inner, button);
    return {
      html,
      body,
      shell,
      inner,
      button,
      elements: [...ignored, shell, inner, button],
      elementsFromPoint: () => [inner, shell, body, html],
    };
  }

  it('does not report nested fixed shells (#shell > #inner > button) when body has no other rendered child and no target is given', () => {
    const page = nestedShellPage();
    const { model, dismissed } = runPainted({
      elements: page.elements,
      topElement: page.inner,
      elementsFromPoint: page.elementsFromPoint,
    });
    expect(model).toMatchObject({ blocking: false, overlayCount: 0, overlays: [] });
    expect(JSON.stringify(model)).not.toContain('#shell');
    expect(JSON.stringify(model)).not.toContain('#inner');
    expect(dismissed).toEqual({ ok: false, reason: 'no-dialog' });
  });

  it('does not report nested fixed shells (#shell > #inner > button) when the target is the button', () => {
    const page = nestedShellPage();
    const targetPoint = {
      input: '#submit',
      x: 160,
      y: 140,
      descriptor: '<BUTTON> "Submit"',
    };
    const { model } = runOverlayPageFixture({
      elements: page.elements,
      targetPoint,
      topElement: page.button,
      elementsFromPoint: page.elementsFromPoint,
    });
    expect(model).toMatchObject({
      blocking: false,
      overlayCount: 0,
      overlays: [],
      target: { input: '#submit', blocked: false },
    });
    expect(JSON.stringify(model)).not.toContain('#shell');
    expect(JSON.stringify(model)).not.toContain('#inner');
  });

  it('does not report the shell as its own cover when the overlay target is the shell', () => {
    const { html, body } = shortPageRoots();
    const shell = paintedNode({
      id: 'shell',
      text: 'App',
      position: 'fixed',
      zIndex: '1',
      rect: FULL,
    });
    const button = paintedNode({
      id: 'submit',
      tagName: 'BUTTON',
      text: 'Submit',
      rect: { x: 100, y: 120, w: 120, h: 40 },
    });
    adopt(body, shell);
    adopt(shell, button);
    const targetPoint = {
      input: '@shell',
      x: 720,
      y: 450,
      descriptor: '<DIV> "App"',
    };
    const { model } = runOverlayPageFixture({
      elements: [shell, button],
      targetPoint,
      topElement: shell,
      targetContext: shell,
      elementsFromPoint: () => [shell, body, html],
      source: T.overlayDetectorScript({ targetPoint, objectBoundTarget: true }),
    });
    expect(model).toMatchObject({
      blocking: false,
      overlayCount: 0,
      overlays: [],
      target: { input: '@shell', blocked: false },
    });
    expect(model.overlays.map(overlay => overlay.selector)).not.toContain('#shell');
  });

  it('reports a transparent fixed layer as a cover when an iframe sibling sits behind it', () => {
    const { html, body } = shortPageRoots();
    const frame = paintedNode({
      id: 'embed',
      tagName: 'IFRAME',
      rect: FULL,
    });
    const veil = paintedNode({
      id: 'veil',
      position: 'fixed',
      zIndex: '2',
      rect: FULL,
      style: { backgroundColor: 'transparent' },
    });
    adopt(body, frame);
    adopt(body, veil);
    const { model, dismissed } = runPainted({
      elements: [frame, veil],
      topElement: veil,
      elementsFromPoint: () => [veil, frame, body, html],
    });
    expect(model.blocking).toBe(true);
    expect(model.overlays).toContainEqual(expect.objectContaining({
      kind: 'overlay',
      selector: '#veil',
      blocking: true,
    }));
    expect(dismissed).toMatchObject({ ok: false, reason: 'overlay-not-dialog', overlays: ['#veil'] });
  });

  it('does not detect a shadow-DOM backdrop inside a host (out of scope, tracked separately)', () => {
    const { html, body } = shortPageRoots();
    const host = paintedNode({
      id: 'host',
      text: 'widget',
      rect: { x: 16, y: 16, w: 200, h: 40 },
    });
    const backdrop = paintedNode({
      id: 'backdrop',
      position: 'fixed',
      zIndex: '5',
      rect: FULL,
      text: 'Scrim',
    });
    adopt(body, host);
    // Real querySelectorAll('body *') does not enter the shadow root. parentElement of a
    // shadow child is null; the host does not contain it.
    host.shadowRoot = { host, children: [backdrop] };
    const { model, dismissed } = runPainted({
      elements: [host],
      topElement: host,
      elementsFromPoint: () => [backdrop, host, body, html],
    });
    expect(model).toMatchObject({ blocking: false, overlayCount: 0, overlays: [] });
    expect(JSON.stringify(model)).not.toContain('#backdrop');
    expect(dismissed).toEqual({ ok: false, reason: 'no-dialog' });
  });
});
