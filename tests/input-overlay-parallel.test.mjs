import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

const { COMMAND_SURFACE } = await import('../skills/chrome-cdp-ex/scripts/lib/command-surface.mjs');

describe('issues #276-#277 overlay detector and parallel cookies', () => {
  function runP20OverlayPage({
    targetPoint = null,
    display = 'block',
    source = null,
    includeButton = false,
  } = {}) {
    const overlay = {
      id: 'p20ov',
      tagName: 'DIV',
      className: '',
      textContent: '',
      parentElement: null,
      __style: {
        display,
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
      contains(other) {
        for (let current = other; current; current = current.parentElement) {
          if (current === overlay) return true;
        }
        return false;
      },
    };
    const button = {
      id: 'p20btn',
      tagName: 'BUTTON',
      className: '',
      textContent: 'Continue',
      parentElement: null,
      __style: {
        display: 'block',
        visibility: 'visible',
        opacity: '1',
        position: 'static',
        pointerEvents: 'auto',
        zIndex: 'auto',
      },
      getBoundingClientRect: () => ({
        x: 40, y: 24, left: 40, top: 24, right: 120, bottom: 56, width: 80, height: 32,
      }),
      getAttribute: () => null,
      matches: () => false,
      contains(other) {
        return other === button;
      },
    };
    const elements = includeButton ? [button, overlay] : [overlay];
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    const previousCss = globalThis.CSS;
    const previousGetComputedStyle = globalThis.getComputedStyle;
    const previousElement = Object.getOwnPropertyDescriptor(globalThis, 'Element');
    globalThis.window = { innerWidth: 1042, innerHeight: 632, devicePixelRatio: 1 };
    globalThis.CSS = { escape: (value) => String(value) };
    globalThis.getComputedStyle = (element) => element.__style;
    globalThis.Element = class FixtureElement {
      static [Symbol.hasInstance](value) {
        return elements.includes(value);
      }
    };
    globalThis.document = {
      documentElement: { clientWidth: 1027, clientHeight: 632 },
      body: { clientWidth: 1027, clientHeight: 632 },
      querySelector: (selector) => elements.find(element => `#${element.id}` === selector) || null,
      querySelectorAll: (selector) => selector === 'body *'
        ? elements
        : elements.filter(element => element.matches(selector)),
      elementFromPoint: (x, y) => {
        const rect = overlay.getBoundingClientRect();
        if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom && overlay.__style.display !== 'none') {
          return overlay;
        }
        return includeButton ? button : null;
      },
    };
    try {
      const runPageScript = Function('source', 'return eval(source);');
      return JSON.parse(runPageScript.call(null, source || T.overlayDetectorScript({ targetPoint })));
    } finally {
      globalThis.window = previousWindow;
      globalThis.document = previousDocument;
      globalThis.CSS = previousCss;
      globalThis.getComputedStyle = previousGetComputedStyle;
      if (previousElement) Object.defineProperty(globalThis, 'Element', previousElement);
      else delete globalThis.Element;
    }
  }

  it('#276 page-level overlay reports a visible fixed inset:0 overlay; scrollbar gutter must not hide it', async () => {
    const pageLevel = runP20OverlayPage();
    expect(pageLevel.schema).toBe('chrome-cdp-ex.overlays.v1');
    expect(pageLevel.overlayCount).toBeGreaterThanOrEqual(1);
    expect(pageLevel.blocking).toBe(true);
    expect(pageLevel.overlays[0]).toMatchObject({
      selector: '#p20ov',
      kind: 'overlay',
      blocking: true,
      coversViewport: true,
    });
    expect(pageLevel.overlays[0].rect).toEqual({ x: 0, y: 0, w: 1027, h: 632 });

    const targeted = runP20OverlayPage({
      includeButton: true,
      targetPoint: { input: '#p20btn', x: 80, y: 40, descriptor: '<BUTTON> "Continue"' },
    });
    expect(targeted.target.blocked).toBe(true);
    expect(targeted.overlayCount).toBeGreaterThanOrEqual(1);

    const hidden = runP20OverlayPage({ display: 'none' });
    expect(hidden).toMatchObject({ overlayCount: 0, blocking: false, overlays: [] });

    const cdp = {
      send(method, params = {}) {
        if (method !== 'Runtime.evaluate') return {};
        return { result: { value: JSON.stringify(runP20OverlayPage({ source: params.expression })) } };
      },
    };
    const json = JSON.parse(await T.overlayStr(cdp, 'sid1', '62E1DF19ABCDEF', ['--format', 'json']));
    expect(json.overlayCount).toBeGreaterThanOrEqual(1);
    expect(json.blocking).toBe(true);
    expect(json.overlays[0].selector).toBe('#p20ov');
    const text = await T.overlayStr(cdp, 'sid1', '62E1DF19ABCDEF', []);
    expect(text).toContain('Overlay detector: blocking');
    expect(text).not.toContain('Overlay detector: clear');
    expect(text).not.toContain('No visible blocking overlays/dialogs detected.');
  });

  it('#276 dismiss-modal does not claim no modal while a blocking overlay is still visible', async () => {
    const parsed = runP20OverlayPage({ source: T.dismissModalScript() });
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toBe('overlay-not-dialog');
    expect(parsed.overlays).toContain('#p20ov');

    const cdp = {
      send(method) {
        if (method !== 'Runtime.evaluate') return {};
        return { result: { value: JSON.stringify(parsed) } };
      },
    };
    const out = await T.dismissModalStr(cdp, 'sid1');
    expect(out).toMatch(/only handles dialog\/modal/i);
    expect(out).toMatch(/#p20ov/);
    expect(out).not.toMatch(/No visible modal\/dialog detected/);
    expect(/no visible modal\/dialog detected/i.test(out)).toBe(false);
  });

  function guardParallelBatch(commands) {
    const unsafe = commands.filter(command => T.isBatchParallelUnsafeCommand(command.cmd, command.args || []));
    if (unsafe.length) {
      throw new Error(`batch --parallel: ${[...new Set(unsafe.map(command => command.cmd))].join(', ')} mutate shared state — use sequential batch`);
    }
    return commands;
  }

  it('#277 batch --parallel accepts cookies list with eval; cookieset/cookiedel stay sequential', async () => {
    const cookies = COMMAND_SURFACE.resolve('cookies');
    const cookieset = COMMAND_SURFACE.resolve('cookieset');
    const cookiedel = COMMAND_SURFACE.resolve('cookiedel');
    expect(cookies).toMatchObject({ mutates: false, kind: 'sensitive-read', authorization: 'sensitive-read' });
    expect(cookieset).toMatchObject({ mutates: true, kind: 'mutation' });
    expect(cookiedel).toMatchObject({ mutates: true, kind: 'mutation' });

    expect(T.isBatchParallelUnsafeCommand('cookies')).toBe(false);
    expect(T.isBatchParallelUnsafeCommand('eval', ['1+1'])).toBe(false);
    expect(T.isBatchParallelUnsafeCommand('cookieset', ['a=b'])).toBe(true);
    expect(T.isBatchParallelUnsafeCommand('cookiedel', ['sid'])).toBe(true);

    const cookiesThenEval = T.parseBatchArgs(['--parallel', 'cookies | eval 1+1']);
    expect(cookiesThenEval.parallel).toBe(true);
    expect(cookiesThenEval.commands.map(command => command.cmd)).toEqual(['cookies', 'eval']);
    expect(() => guardParallelBatch(cookiesThenEval.commands)).not.toThrow();

    const evalThenCookies = T.parseBatchArgs(['--parallel', 'eval location.hostname | cookies']);
    expect(() => guardParallelBatch(evalThenCookies.commands)).not.toThrow();

    const results = await T.runBatchCommands({
      run: async (command) => {
        if (command.cmd === 'cookies') return { ok: true, result: 'No cookies' };
        if (command.cmd === 'eval') return { ok: true, result: '2' };
        throw new Error(`unexpected ${command.cmd}`);
      },
    }, cookiesThenEval.commands, { parallel: true });
    expect(results).toMatchObject([
      { cmd: 'cookies', ok: true, result: 'No cookies' },
      { cmd: 'eval', ok: true, result: '2' },
    ]);
    const formatted = T.formatBatchResults(results, 'plain');
    expect(formatted).toMatch(/No cookies/);
    expect(formatted).toMatch(/\b2\b/);

    expect(() => guardParallelBatch(T.parseBatchArgs(['--parallel', 'cookieset a=b | eval 1+1']).commands))
      .toThrow(/cookieset mutate shared state/);
    expect(() => guardParallelBatch(T.parseBatchArgs(['--parallel', 'cookiedel sid | eval 1+1']).commands))
      .toThrow(/cookiedel mutate shared state/);
    expect(() => guardParallelBatch(T.parseBatchArgs(['--parallel', 'cookies | eval 1+1']).commands))
      .not.toThrow(/cookies mutate shared state/);

    const mutationError = T.formatCliError(
      new Error('batch --parallel: cookieset mutate shared state — use sequential batch'),
      { cmd: 'batch', targetPrefix: '62E1DF19' },
    );
    expect(mutationError).toMatch(/Kind: usage/);
    expect(mutationError).toMatch(/Next: cdp help batch/);
    expect(mutationError).not.toMatch(/cookies mutate shared state/);
  });
});
