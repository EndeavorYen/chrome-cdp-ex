import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { createServer as createProbeServer } from 'http';
import { fileURLToPath } from 'url';
import { describe, expect, it, vi } from 'vitest';

import {
  assertPhase4ActionState,
  assertPhase4CookieEffect,
  assertPhase4EnvironmentEffect,
  assertPhase4NavigationState,
  assertPhase4ReloadState,
  assertPhase4RenderingEffect,
  assertPhase4OutputPrivacy,
  assertPhase4TargetReady,
  buildPhase4SliceCommands,
  buildPhase4CookieEffectCommand,
  buildPhase4RenderingEffectCommand,
  createPhase4Cancellation,
  launchLoopbackFixtureServer,
  monitorDisposableBrowser,
  phase4RuntimeBase,
  runPhase4SliceSession,
} from '../scripts/validation-phase4-slices.mjs';
import { createValidationLoopbackServer } from '../scripts/validation-loopback-server.mjs';

const TARGET = 'ABC12345';
const TARGET_ID = `${TARGET}6789`;
const SESSION_ID = 'B361FE026EC722325854623516F3EF83';
const TITLE = 'chrome-cdp-ex long-session smoke';
const URL = 'http://127.0.0.1:41758/validation-phase4.html';
const NAV_URL = `${URL}#phase7-navigation`;

function targetResolution() {
  return {
    requestedTargetPrefix: TARGET,
    requestedTargetId: TARGET_ID,
    boundTargetId: TARGET_ID,
    resolvedTargetId: TARGET_ID,
    resolutionSource: 'live-discovery',
    status: 'started',
    rebound: false,
  };
}

function fixtureOutput(id) {
  if (id === 'html') return '<p id="auth-state">auth state preserved</p>';
  if (id === 'text') return 'auth state preserved';
  if (id === 'table') return 'No tables found matching #missing-table';
  if (id === 'net') return '';
  if (id === 'wait') return 'Waited 25ms';
  if (id === 'waitfor') return 'Found <P> "auth state preserved"';
  if (id === 'checkpoint') return [
    'Checkpoint captured', `URL: ${URL}`, 'Privacy: default-redacted',
    'Storage: local 2, session 1', 'Cookies: 1',
    'Values: cookie values and sensitive storage values are redacted by default.',
    'Next: use `checkpoint --unsafe-full --format json` only when restore fidelity is required.',
  ].join('\n');
  if (id === 'cookies') return 'phase7_fixture  fixture-value  127.0.0.1  session  Lax';
  if (id === 'cookieset') return 'Cookie set: phase7_mutation=fixture (domain: 127.0.0.1)';
  if (id === 'cookiedel') return 'Cookie deleted: phase7_mutation';
  if (id === 'dialog') return 'Dialog auto-accept: OFF (dialogs will be dismissed/rejected)';
  if (id === 'keepalive') return 'Daemon keepalive extended for 1000ms (until 2026-08-12T09:00:00.000Z)';
  if (id === 'netlog') return 'Network log cleared';
  if (id === 'eval') return 'phase7-eval';
  if (id === 'eval64') return '多語';
  if (id === 'call') return '{\n  "phase7": "call"\n}';
  if (id === 'console') return 'Console baseline cleared (console and exception buffers)';
  if (id === 'record') return 'Record timeline (100ms)\n  (no DOM, console, exception, navigation, or XHR/Fetch/Document network events observed)';
  if (id === 'batch') return '[1] text: auth state preserved after refresh\n[2] wait: Waited 25ms';
  if (id === 'flow') return 'Flow: 2 step(s)\n[1/2] text #auth-state\n  auth state preserved after refresh\n[2/2] assert text includes "auth state preserved after refresh"\n  Assertion passed: text includes "auth state preserved after refresh"';
  if (id === 'repeat') return 'Repeat 2× wait 25\n[1/2] ok: Waited 25ms\n[2/2] ok: Waited 25ms\nDone: 2 ok, 0 failed';
  if (id === 'replay') return JSON.stringify({
    schema: 'chrome-cdp-ex.replay.v1', source: 'inline JSON', sourceTargetId: null,
    sourceSessionId: null, continueOnError: false, halted: false,
    counts: { environment: 0, actions: 1, total: 1, ok: 1, failed: 0, skipped: 0 },
    steps: [{
      phase: 'action', index: 1, total: 1, command: ['wait', '25'],
      commandText: 'wait 25', ok: true, skipped: false, resultPreview: 'Waited 25ms',
    }],
    failedStep: null, nextSteps: [],
    targetResolution: targetResolution(),
  });
  if (id === 'snap') return `[RootWebArea] ${TITLE}\n  [button] Refresh account\n\n(Hint: \`snap\` gives only the raw AX tree. Use \`perceive\` instead for layout, @refs, style hints, and console health — it is the recommended starting command.)`;
  if (id === 'styles') return '<SECTION>#auth-panel\n  background-color: rgb(240, 253, 244)\n  padding: 12px\n  border: 1px solid rgb(187, 247, 208)';
  if (id === 'overlay') return JSON.stringify({
    schema: 'chrome-cdp-ex.overlays.v1',
    viewport: { width: 1280, height: 720 },
    target: null, overlayCount: 0, blocking: false, overlays: [], nextCommand: null,
    targetResolution: targetResolution(),
  });
  if (id === 'components') return JSON.stringify({
    schema: 'chrome-cdp-ex.components.v1', framework: null, ok: false,
    message: 'No supported framework detected (React fiber/DevTools, Vue, or Angular ng-version).',
    targetResolution: targetResolution(),
  });
  if (id === 'cascade') return JSON.stringify({
    schema: 'chrome-cdp-ex.cascade.v1',
    input: { selector: '#auth-panel', property: 'padding-top' },
    propertyCount: 1,
    properties: [{
      name: 'padding-top', computedValue: '12px',
      winner: {
        selector: '#auth-panel', value: '12px',
        source: 'chrome-cdp-ex-smoke.css:17', origin: 'regular',
      },
      rules: [{
        selector: '#auth-panel', value: '12px',
        source: 'chrome-cdp-ex-smoke.css:17', origin: 'regular',
        winner: true, overridden: false,
      }],
    }],
    inherited: [],
    editTarget: {
      property: 'padding-top', selector: '#auth-panel', value: '12px',
      source: 'chrome-cdp-ex-smoke.css:17', origin: 'regular',
    },
    recommendation: {
      source: 'cascade', strategy: 'edit-winning-source', property: 'padding-top',
      selector: '#auth-panel', sourceLocation: 'chrome-cdp-ex-smoke.css:17',
    },
    targetResolution: targetResolution(),
  });
  if (id === 'record-actions') return JSON.stringify({
    schema: 'chrome-cdp-ex.record-actions.v1', targetId: TARGET_ID, sessionId: SESSION_ID,
    source: 'session-action-log', environmentCount: 0, environment: [], actionCount: 1,
    actions: [{
      index: 1, ts: 1, action: 'click', target: { input: '#close-modal' },
      command: ['click', '#close-modal'], replayable: true, needsInput: [], evidence: {},
    }],
    targetResolution: targetResolution(),
  });
  if (id === 'export-playwright') return JSON.stringify({
    schema: 'chrome-cdp-ex.export-playwright.v1', targetId: TARGET_ID, sessionId: SESSION_ID,
    source: 'record-actions', title: 'Phase 7 fixture',
    counts: {
      environment: 0, environmentExported: 0, environmentSkipped: 0,
      actions: 1, actionsExported: 1, actionsSkipped: 0, assertions: 0,
    },
    spec: 'test(\'Phase 7 fixture\', async ({ page }) => {\n  await page.locator("#close-modal").click();\n});',
    review: [], nextSteps: ['Review auth state and selectors before committing the Playwright spec.', 'report'],
    targetResolution: targetResolution(),
  });
  if (id === 'controls') return JSON.stringify({
    schema: 'chrome-cdp-ex.visible-controls.v1',
    scope: 'main', filter: 'command input', limit: 5, total: 1, returned: 1,
    truncated: false,
    controls: [{
      role: 'textbox', label: 'command input', selector: 'input#cmd',
      disabled: false, clickable: true, rect: { x: 1, y: 2, w: 3, h: 4 },
    }],
    compact: true,
    targetResolution: targetResolution(),
  });
  if (id === 'frame') return JSON.stringify({
    schema: 'chrome-cdp-ex.frames.v1', frameCount: 2,
    frames: [
      { ref: '@f1', depth: 0, url: URL },
      { ref: '@f2', depth: 1, parentRef: '@f1', url: 'about:srcdoc' },
    ],
    targetResolution: targetResolution(),
  });
  if (id === 'status') return JSON.stringify({
    schema: 'chrome-cdp-ex.status.v1',
    targetId: TARGET_ID,
    target: { state: 'connected', diagnostic: null },
    page: { title: TITLE, url: URL },
    console: [], exceptions: [], navigation: [],
    runtime: null,
    targetResolution: targetResolution(),
  });
  if (id === 'summary') return JSON.stringify({
    schema: 'chrome-cdp-ex.summary.v1',
    page: { title: TITLE, url: URL },
    viewport: { size: '1280x720', scrollY: 0, scrollMax: 1680 },
    interactive: { button: 8, 'input[text]': 1, 'input[file]': 1 },
    counts: { domNodes: 42, tableRows: 0, visibleControls: 10, hiddenTemplateNodes: 2 },
    limits: { outputTokenBudget: 1200, hiddenTemplateNodesOmitted: 2, truncated: true },
    focused: 'none',
    console: { errors: 0, warnings: 0, exceptions: 0 },
    targetResolution: targetResolution(),
  });
  if (id === 'perceive') {
    return JSON.stringify({
      schema: 'chrome-cdp-ex.perceive.v1',
      targetPrefix: TARGET,
      page: { title: TITLE, url: 'http://127.0.0.1:41758/validation-phase4.html' },
    });
  }
  if (['back', 'click', 'clickxy', 'dismiss-modal', 'fill', 'forward', 'jsclick', 'nav', 'press', 'reload', 'scroll', 'select', 'type', 'viewport'].includes(id)) {
    return JSON.stringify({
      schema: 'chrome-cdp-ex.action.v1',
      action: id,
      targetSummary: id,
      dispatch: { ok: true, method: id === 'press' ? 'Input.dispatchKeyEvent' : 'fixture' },
      settlement: { ok: true },
      outcome: { status: 'changed' },
      receipt: {
        schema: 'chrome-cdp-ex.action-receipt.v1',
        outcome: 'changed',
      },
    });
  }
  if (id === 'verify-click') return JSON.stringify({
    schema: 'chrome-cdp-ex.semantic-interaction.v1',
    action: 'click', target: '#refresh-account', dispatch: { ok: true },
    settlement: { status: 'settled' }, outcome: 'changed', verdict: 'pass',
    assertions: [{ kind: 'text', expected: 'auth state preserved after refresh', status: 'pass', message: '"auth state preserved after refresh" matched' }],
    matchedRequest: null, actionEvidence: null, targetResolution: targetResolution(),
  });
  if (id === 'mock') return JSON.stringify({
    schema: 'chrome-cdp-ex.mock.v1', mode: 'add',
    rules: [{ urlPattern: '**/api/mock', status: 201 }],
  });
  if (id === 'clock') return JSON.stringify({
    schema: 'chrome-cdp-ex.clock.v1', mode: 'apply', profile: 'freeze',
    atMs: 1577934245000,
  });
  if (id === 'throttle') return JSON.stringify({
    schema: 'chrome-cdp-ex.throttle.v1', mode: 'apply', profile: 'fast-3g',
    offline: false, latencyMs: 150, downloadKbps: 1600, uploadKbps: 750,
  });
  if (id === 'emulate') return JSON.stringify({
    schema: 'chrome-cdp-ex.emulate.v1', targetPrefix: TARGET,
    colorScheme: 'dark', reducedMotion: 'reduce',
    features: [
      { name: 'prefers-color-scheme', value: 'dark' },
      { name: 'prefers-reduced-motion', value: 'reduce' },
    ],
    active: true, nextCommand: `cdp perceive ${TARGET} -C -d 8`,
    targetResolution: targetResolution(),
  });
  if (id === 'hover') return 'Hovering over <BUTTON> at CSS (640, 320)';
  if (id === 'report') {
    return JSON.stringify({
      schema: 'chrome-cdp-ex.qa-summary.v1', source: 'report',
      targetPrefix: TARGET,
      report: {
        schema: 'chrome-cdp-ex.report.v1', counts: { actions: 1 },
        latestAction: { action: 'click', status: 'ok', outcomeStatus: 'changed' },
      },
    });
  }
  return JSON.stringify({
    result: {
      type: 'object',
      value: {
        title: TITLE,
        modalHidden: true,
        shortcut: 'shortcut:c',
        inputValue: 'phase7 input +typed',
        selectValue: 'two',
        scrollY: 100,
        jsStatus: 'jsclick:reopened',
        coordStatus: 'clickxy:clicked',
        authState: 'auth state preserved after refresh',
      },
    },
  });
}

describe('Phase 4 disposable core-slice scenario', () => {
  it('serves only the two fixed loopback fixture routes from an immutable page snapshot', async () => {
    const probe = createProbeServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    const server = createValidationLoopbackServer({
      port,
      pagePath: fileURLToPath(new globalThis.URL('../scripts/smoke-page.html', import.meta.url)),
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
    try {
      const base = `http://127.0.0.1:${port}`;
      const cli = await fetch(`${base}/validation-phase4.html`);
      const mcp = await fetch(`${base}/validation-phase4.html?route=mcp`);
      const denied = await fetch(`${base}/private`);
      const throttle = await fetch(`${base}/api/throttle-probe?fixture=1`);
      expect(cli.status).toBe(200);
      expect(mcp.status).toBe(200);
      expect(await cli.text()).toContain(TITLE);
      expect(await mcp.text()).toContain(TITLE);
      expect(denied.status).toBe(404);
      expect(throttle.status).toBe(200);
      expect(await throttle.text()).toBe('throttle-ok');
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
    expect(() => createValidationLoopbackServer({ port: 0, pagePath: 'fixture' })).toThrow(/port/);
  });

  it('waits for the exact loopback document title before spending a slice command', () => {
    const url = 'http://127.0.0.1:41758/validation-phase4.html';
    expect(() => assertPhase4TargetReady({
      schema: 'chrome-cdp-ex.list.v1',
      pages: [{ url, title: '', targetPrefix: TARGET }],
    }, url, TITLE)).toThrow('not ready');
    expect(assertPhase4TargetReady({
      schema: 'chrome-cdp-ex.list.v1',
      pages: [{ url, title: TITLE, targetPrefix: TARGET }],
    }, url, TITLE)).toMatchObject({ targetPrefix: TARGET, title: TITLE, url });
  });

  it('freezes the exact bounded fifty-two-command route and final fixture-state raw expression', () => {
    expect(buildPhase4SliceCommands(TARGET, NAV_URL)).toEqual([
      { id: 'perceive', args: ['perceive', TARGET, '--format', 'json'] },
      { id: 'click', args: ['click', TARGET, '#close-modal', '--format', 'json'] },
      { id: 'report', args: ['report', TARGET, '--qa', '--format', 'json'] },
      { id: 'html', args: ['html', TARGET, '#auth-state'] },
      { id: 'text', args: ['text', TARGET, '#auth-state'] },
      { id: 'table', args: ['table', TARGET, '#missing-table'] },
      { id: 'net', args: ['net', TARGET] },
      { id: 'status', args: ['status', TARGET, '--format', 'json'] },
      { id: 'summary', args: ['summary', TARGET, '--format', 'json'] },
      { id: 'snap', args: ['snap', TARGET] },
      {
        id: 'controls',
        args: ['controls', TARGET, '--selector', 'main', '--filter', 'command input', '--limit', '5', '--compact', '--format', 'json'],
      },
      { id: 'frame', args: ['frame', TARGET, '--format', 'json'] },
      { id: 'overlay', args: ['overlay', TARGET, '--format', 'json'] },
      { id: 'styles', args: ['styles', TARGET, '#auth-panel'] },
      { id: 'components', args: ['components', TARGET, '--format', 'json'] },
      { id: 'record-actions', args: ['record-actions', TARGET, '--format', 'json'] },
      {
        id: 'export-playwright',
        args: ['export-playwright', TARGET, '--title', 'Phase 7 fixture', '--format', 'json'],
      },
      { id: 'wait', args: ['wait', TARGET, '25'] },
      { id: 'waitfor', args: ['waitfor', TARGET, '#auth-state', '1000'] },
      { id: 'cascade', args: ['cascade', TARGET, '#auth-panel', 'padding-top', '--format', 'json'] },
      { id: 'checkpoint', args: ['checkpoint', TARGET] },
      { id: 'cookies', args: ['cookies', TARGET] },
      {
        id: 'verify-click',
        args: ['verify-click', TARGET, '#refresh-account', '--expect-text', 'auth state preserved after refresh', '--format', 'json'],
      },
      { id: 'fill', args: ['fill', TARGET, '#cmd', 'phase7 input', '--format', 'json'] },
      { id: 'type', args: ['type', TARGET, ' +typed', '--format', 'json'] },
      { id: 'hover', args: ['hover', TARGET, '#refresh-account'] },
      { id: 'scroll', args: ['scroll', TARGET, 'down', '100', '--format', 'json'] },
      { id: 'select', args: ['select', TARGET, '#phase7-select', 'two', '--format', 'json'] },
      { id: 'jsclick', args: ['jsclick', TARGET, '#phase7-reopen', '--format', 'json'] },
      { id: 'dismiss-modal', args: ['dismiss-modal', TARGET, '--format', 'json'] },
      { id: 'clickxy', args: ['clickxy', TARGET, '64', '322', '--format', 'json'] },
      { id: 'press', args: ['press', TARGET, 'c', '--format', 'json'] },
      {
        id: 'evalraw',
        args: [
          'evalraw',
          TARGET,
          'Runtime.evaluate',
          '{"expression":"({title:document.title,modalHidden:document.querySelector(\'#motd\')?.hidden===true,shortcut:document.querySelector(\'#shortcut-status\')?.textContent,inputValue:document.querySelector(\'#cmd\')?.value,selectValue:document.querySelector(\'#phase7-select\')?.value,scrollY:Math.round(window.scrollY),jsStatus:document.querySelector(\'#phase7-js-status\')?.textContent,coordStatus:document.querySelector(\'#phase7-coord-status\')?.textContent,authState:document.querySelector(\'#auth-state\')?.textContent})","returnByValue":true}',
        ],
      },
      { id: 'eval', args: ['eval', TARGET, '"phase7-eval"'] },
      { id: 'eval64', args: ['eval64', TARGET, Buffer.from('"多語"', 'utf8').toString('base64')] },
      { id: 'call', args: ['call', TARGET, 'async () => ({ phase7: "call" })'] },
      { id: 'console', args: ['console', TARGET, '--clear'] },
      { id: 'record', args: ['record', TARGET, '100'] },
      { id: 'batch', args: ['batch', TARGET, 'text #auth-state | wait 25', '--compact'] },
      { id: 'flow', args: ['flow', TARGET, 'text #auth-state; assert text "auth state preserved after refresh"'] },
      { id: 'repeat', args: ['repeat', TARGET, '2', 'wait', '25'] },
      {
        id: 'replay',
        args: ['replay', TARGET, '--format', 'json', '--json', JSON.stringify({
          schema: 'chrome-cdp-ex.record-actions.v1',
          actions: [{ index: 1, action: 'wait', command: ['wait', '25'], replayable: true, needsInput: [] }],
        })],
      },
      { id: 'cookieset', args: ['cookieset', TARGET, 'phase7_mutation=fixture'] },
      { id: 'cookiedel', args: ['cookiedel', TARGET, 'phase7_mutation'] },
      { id: 'dialog', args: ['dialog', TARGET, 'dismiss'] },
      { id: 'keepalive', args: ['keepalive', TARGET, '1000'] },
      { id: 'netlog', args: ['netlog', TARGET, '--clear'] },
      { id: 'nav', args: ['nav', TARGET, NAV_URL, '--format', 'json'] },
      { id: 'back', args: ['back', TARGET, '--format', 'json'] },
      { id: 'forward', args: ['forward', TARGET, '--format', 'json'] },
      { id: 'reload', args: ['reload', TARGET, '--format', 'json'] },
      {
        id: 'mock',
        args: ['mock', TARGET, 'add', '**/api/mock', '--status', '201', '--body', 'fixture-mock', '--content-type', 'text/plain', '--format', 'json'],
      },
      { id: 'throttle', args: ['throttle', TARGET, 'fast-3g', '--format', 'json'] },
      { id: 'clock', args: ['clock', TARGET, 'freeze', '--at', '2020-01-02T03:04:05.000Z', '--format', 'json'] },
      { id: 'viewport', args: ['viewport', TARGET, '390x844', '--format', 'json'] },
      { id: 'emulate', args: ['emulate', TARGET, 'dark', 'reduced-motion', 'reduce', '--format', 'json'] },
    ]);
    expect(Object.isFrozen(buildPhase4SliceCommands(TARGET, NAV_URL))).toBe(true);
  });

  it('binds each navigation action to the exact disposable history state', () => {
    expect(assertPhase4NavigationState('nav', NAV_URL, { baseUrl: URL, navigationUrl: NAV_URL })).toBe(NAV_URL);
    expect(assertPhase4NavigationState('back', URL, { baseUrl: URL, navigationUrl: NAV_URL })).toBe(URL);
    expect(assertPhase4NavigationState('forward', NAV_URL, { baseUrl: URL, navigationUrl: NAV_URL })).toBe(NAV_URL);
    expect(assertPhase4NavigationState('reload', NAV_URL, { baseUrl: URL, navigationUrl: NAV_URL })).toBe(NAV_URL);
    expect(() => assertPhase4NavigationState('back', NAV_URL, {
      baseUrl: URL, navigationUrl: NAV_URL,
    })).toThrow(/navigation state/);
  });

  it('requires reload to advance the isolated page generation exactly once', () => {
    expect(assertPhase4ReloadState({
      url: NAV_URL, loadCount: 2, marker: 'load:2',
    }, { navigationUrl: NAV_URL })).toBe(2);
    expect(() => assertPhase4ReloadState({
      url: NAV_URL, loadCount: 1, marker: 'load:1',
    }, { navigationUrl: NAV_URL })).toThrow(/reload generation/);
    expect(() => assertPhase4ReloadState({
      url: URL, loadCount: 2, marker: 'load:2',
    }, { navigationUrl: NAV_URL })).toThrow(/reload generation/);
  });

  it('requires independently observed mock, clock, and throttle effects', () => {
    expect(assertPhase4EnvironmentEffect('mock', '{"status":201,"body":"fixture-mock"}')).toBe(201);
    expect(assertPhase4EnvironmentEffect('clock', '1577934245000')).toBe(1577934245000);
    expect(assertPhase4EnvironmentEffect('throttle', '{"durationMs":150,"status":200,"body":"throttle-ok"}')).toBe(150);
    expect(() => assertPhase4EnvironmentEffect('mock', '{"status":404,"body":"not found"}')).toThrow(/mock live/);
    expect(() => assertPhase4EnvironmentEffect('clock', '1577934245001')).toThrow(/clock live/);
    expect(() => assertPhase4EnvironmentEffect('throttle', '{"durationMs":10,"status":200,"body":"throttle-ok"}')).toThrow(/throttle live/);
  });

  it('requires independently observed viewport and media-query effects', () => {
    expect(buildPhase4RenderingEffectCommand('viewport', TARGET)).toEqual([
      'eval', TARGET,
      'JSON.stringify({width:Math.round(visualViewport.width),height:Math.round(visualViewport.height),dpr:devicePixelRatio})',
    ]);
    expect(assertPhase4RenderingEffect('viewport', '{"width":390,"height":844,"dpr":1}')).toBe('390x844');
    expect(assertPhase4RenderingEffect('emulate', '{"dark":true,"reducedMotion":true}')).toBe('dark+reduce');
    expect(() => assertPhase4RenderingEffect('viewport', '{"width":1280,"height":720,"dpr":1}')).toThrow(/viewport live/);
    expect(() => assertPhase4RenderingEffect('emulate', '{"dark":false,"reducedMotion":true}')).toThrow(/emulate live/);
  });

  it('requires independently observed cookie set and delete effects', () => {
    expect(buildPhase4CookieEffectCommand('cookieset', TARGET)).toEqual([
      'eval', TARGET, "document.cookie.split('; ').includes('phase7_mutation=fixture')",
    ]);
    expect(buildPhase4CookieEffectCommand('cookiedel', TARGET)).toEqual([
      'eval', TARGET, "!(document.cookie.split('; ').includes('phase7_mutation=fixture'))",
    ]);
    expect(assertPhase4CookieEffect('cookieset', 'true')).toBe(true);
    expect(assertPhase4CookieEffect('cookiedel', 'true')).toBe(true);
    expect(() => assertPhase4CookieEffect('cookieset', 'false')).toThrow(/cookie effect/);
  });

  it('drains bounded browser stderr and captures spawn errors without an unhandled event', () => {
    const browser = new EventEmitter();
    browser.stderr = new PassThrough();
    const diagnostics = monitorDisposableBrowser(browser, { maxBytes: 16 });
    const spawnError = new Error('browser launch failed');
    browser.stderr.write('0123456789abcdefghijklmnop');
    browser.emit('error', spawnError);
    expect(diagnostics.stderr()).toBe('abcdefghijklmnop');
    expect(diagnostics.error()).toBe(spawnError);
  });

  it('binds the exact action state for both CLI and independent MCP tabs', () => {
    const state = JSON.parse(fixtureOutput('evalraw')).result.value;
    expect(assertPhase4ActionState(state, { expectedTitle: TITLE, modalHidden: true })).toBe(TITLE);
    expect(assertPhase4ActionState({ ...state, modalHidden: false }, {
      expectedTitle: TITLE,
      modalHidden: false,
    })).toBe(TITLE);
    expect(() => assertPhase4ActionState({ ...state, selectValue: 'one' }, {
      expectedTitle: TITLE,
      modalHidden: true,
    })).toThrow(/fixture state/);
  });

  it('keeps Unix daemon sockets short while preserving the Windows temp boundary', () => {
    expect(phase4RuntimeBase({ platform: 'darwin', tempDir: '/very/long/sandbox/tmp' })).toBe('/tmp');
    expect(phase4RuntimeBase({ platform: 'linux', tempDir: '/very/long/sandbox/tmp' })).toBe('/tmp');
    expect(phase4RuntimeBase({ platform: 'win32', tempDir: 'C:\\Temp\\sandbox' })).toBe('C:\\Temp\\sandbox');
  });

  it.each([
    ['styles', `${fixtureOutput('styles')}\n/Users/alice/private/token.txt password=hunter2`],
    ['export-playwright', JSON.stringify({
      ...JSON.parse(fixtureOutput('export-playwright')),
      spec: `${JSON.parse(fixtureOutput('export-playwright')).spec}\n/home/alice/private/token.txt`,
    })],
    ['record-actions', JSON.stringify({
      ...JSON.parse(fixtureOutput('record-actions')),
      actions: [{
        ...JSON.parse(fixtureOutput('record-actions')).actions[0],
        evidence: { password: 'hunter2' },
      }],
    })],
  ])('rejects privacy-bearing %s output before semantic acceptance', (id, output) => {
    expect(() => assertPhase4OutputPrivacy(id, output)).toThrow(/credential-bearing|machine-local/);
  });

  it('cancels before cleanup, fences later work, and reports a signal exit without terminating the owner scope', async () => {
    let releaseCleanup;
    const cleanupGate = new Promise(resolve => { releaseCleanup = resolve; });
    const cleanup = vi.fn(async () => cleanupGate);
    const exit = vi.fn();
    const cancellation = createPhase4Cancellation({ cleanup, exit });
    const signal = cancellation.onSignal('SIGTERM');
    expect(cancellation.isCancelled()).toBe(true);
    expect(() => cancellation.ensureActive()).toThrow(/cancelled/);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();
    releaseCleanup();
    await signal;
    expect(exit).toHaveBeenCalledWith(143);
  });

  it('publishes a loopback child before readiness so signal cleanup stops it exactly once', async () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    let releaseReadiness;
    const readinessGate = new Promise(resolve => { releaseReadiness = resolve; });
    const stopChild = vi.fn(async () => {});
    const launched = launchLoopbackFixtureServer({
      port: 41758,
      pagePath: '/fixture/page.html',
      spawnChild: () => child,
      stopChild,
      sleep: () => readinessGate,
    });
    const server = launched.child;
    let cleaning = null;
    const cleanup = () => {
      cleaning ||= launched.stop();
      return cleaning;
    };
    const cancellation = createPhase4Cancellation({ cleanup, exit: vi.fn() });
    const signal = cancellation.onSignal('SIGTERM');
    expect(server).toBe(child);
    expect(stopChild).toHaveBeenCalledOnce();
    child.stdout.write('READY 41758\n');
    releaseReadiness();
    await launched.ready;
    await signal;
    await cleanup();
    expect(stopChild).toHaveBeenCalledOnce();
    expect(() => cancellation.ensureActive()).toThrow(/cancelled/);
  });

  it('validates every public handoff and always cleans up after success', async () => {
    const commands = buildPhase4SliceCommands(TARGET, NAV_URL);
    const runCommand = vi.fn(async command => fixtureOutput(command.id));
    const runMcpCommand = vi.fn(async command => fixtureOutput(command.id));
    const cleanup = vi.fn(async () => {});

    await expect(runPhase4SliceSession({
      targetPrefix: TARGET,
      expectedTitle: TITLE,
      expectedUrl: URL,
      navigationUrl: NAV_URL,
      runCommand,
      runMcpCommand,
      cleanup,
    })).resolves.toEqual({
      targetPrefix: TARGET,
      commands: [
        'perceive', 'click', 'report', 'html', 'text', 'table', 'net', 'status', 'summary',
        'snap', 'controls', 'frame', 'overlay', 'styles', 'components', 'record-actions', 'export-playwright',
        'wait', 'waitfor', 'cascade',
        'checkpoint', 'cookies', 'verify-click', 'fill', 'type', 'hover', 'scroll', 'select',
        'jsclick', 'dismiss-modal', 'clickxy', 'press', 'evalraw', 'eval', 'eval64', 'call', 'console', 'record',
        'batch', 'flow', 'repeat', 'replay',
        'cookieset', 'cookiedel', 'dialog', 'keepalive', 'netlog',
        'nav', 'back', 'forward', 'reload', 'mock', 'throttle', 'clock', 'viewport', 'emulate',
      ],
      title: TITLE,
      clickOutcome: 'changed',
      reportActions: 1,
      extractionParity: 43,
    });
    expect(runCommand.mock.calls.map(([command]) => command)).toEqual(commands);
    expect(runMcpCommand.mock.calls.map(([command]) => command.id)).toEqual([
      'html', 'text', 'table', 'net', 'status', 'summary', 'snap', 'controls', 'frame',
      'overlay', 'styles', 'components', 'record-actions', 'export-playwright',
      'wait', 'waitfor', 'cascade',
      'checkpoint', 'cookies', 'verify-click', 'fill', 'type', 'hover', 'scroll', 'select',
      'jsclick', 'dismiss-modal', 'clickxy', 'press', 'console', 'record',
      'dialog', 'keepalive', 'netlog',
      'nav', 'back', 'forward', 'reload', 'mock', 'throttle', 'clock', 'viewport', 'emulate',
    ]);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it.each([
    'perceive', 'click', 'report', 'html', 'text', 'table', 'net', 'status', 'summary',
    'snap', 'controls', 'frame', 'overlay', 'styles', 'components', 'record-actions', 'export-playwright',
    'wait', 'waitfor', 'cascade',
    'checkpoint', 'cookies', 'cookieset', 'cookiedel', 'dialog', 'keepalive', 'netlog',
    'verify-click', 'fill', 'type', 'hover', 'scroll', 'select',
    'jsclick', 'dismiss-modal', 'clickxy', 'press', 'evalraw', 'eval', 'eval64', 'call', 'console', 'record',
    'batch', 'flow', 'repeat', 'replay',
    'nav', 'back', 'forward', 'reload', 'mock', 'throttle', 'clock', 'viewport', 'emulate',
  ])('fails at %s and still runs cleanup exactly once', async failureId => {
    const runCommand = vi.fn(async command => {
      if (command.id === failureId) throw new Error(`forced ${failureId} failure`);
      return fixtureOutput(command.id);
    });
    const cleanup = vi.fn(async () => {});

    await expect(runPhase4SliceSession({
      targetPrefix: TARGET,
      expectedTitle: TITLE,
      expectedUrl: URL,
      runCommand,
      runMcpCommand: async command => fixtureOutput(command.id),
      cleanup,
    })).rejects.toThrow(`forced ${failureId} failure`);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it.each([
    ['perceive', JSON.stringify({ schema: 'wrong' }), 'perceive schema'],
    ['click', JSON.stringify({
      schema: 'chrome-cdp-ex.action.v1',
      action: 'click',
      receipt: { schema: 'chrome-cdp-ex.action-receipt.v1', outcome: 'changed' },
      dispatch: { ok: false },
    }), 'click dispatch'],
    ['report', JSON.stringify({ schema: 'chrome-cdp-ex.qa-summary.v1', source: 'report', targetPrefix: TARGET, report: { schema: 'chrome-cdp-ex.report.v1', counts: { actions: 0 } } }), 'report action'],
    ['evalraw', JSON.stringify({ result: { type: 'object', value: { title: TITLE, modalHidden: false } } }), 'evalraw fixture state'],
    ['fill', JSON.stringify({
      schema: 'chrome-cdp-ex.action.v1', action: 'fill', dispatch: { ok: false },
      receipt: { schema: 'chrome-cdp-ex.action-receipt.v1', outcome: 'changed' },
    }), 'fill dispatch'],
    ['jsclick', JSON.stringify({
      schema: 'chrome-cdp-ex.action.v1', action: 'jsclick', dispatch: { ok: false },
      receipt: { schema: 'chrome-cdp-ex.action-receipt.v1', outcome: 'changed' },
    }), 'jsclick dispatch'],
    ['verify-click', JSON.stringify({
      ...JSON.parse(fixtureOutput('verify-click')),
      verdict: 'fail',
      assertions: [{ kind: 'text', expected: 'auth state preserved after refresh', status: 'fail' }],
    }), 'verify-click fixture output'],
    ['hover', 'hovered the wrong fixture', 'hover fixture output'],
    ['net', 'TOTALLY WRONG NETWORK OUTPUT', 'net fixture output'],
    ['status', JSON.stringify({
      schema: 'chrome-cdp-ex.status.v1', page: { title: TITLE, url: URL },
      console: [], exceptions: [], navigation: [],
    }), 'status fixture output'],
    ['summary', JSON.stringify({
      schema: 'chrome-cdp-ex.summary.v1', page: { title: TITLE, url: URL }, counts: { domNodes: 42 },
    }), 'summary fixture output'],
    ['snap', '[RootWebArea] wrong', 'snap fixture output'],
    ['controls', JSON.stringify({ schema: 'chrome-cdp-ex.visible-controls.v1', controls: [] }), 'controls fixture output'],
    ['frame', JSON.stringify({ schema: 'chrome-cdp-ex.frames.v1', frameCount: 0, frames: [] }), 'frame fixture output'],
    ['overlay', JSON.stringify({ schema: 'chrome-cdp-ex.overlays.v1', overlayCount: 1 }), 'overlay fixture output'],
    ['styles', '<SECTION>#wrong', 'styles fixture output'],
    ['components', JSON.stringify({ schema: 'chrome-cdp-ex.components.v1', framework: 'react', ok: true }), 'components fixture output'],
    ['record-actions', JSON.stringify({ schema: 'chrome-cdp-ex.record-actions.v1', actionCount: 0, actions: [] }), 'record-actions fixture output'],
    ['export-playwright', JSON.stringify({ schema: 'chrome-cdp-ex.export-playwright.v1', counts: { actions: 0 } }), 'export-playwright fixture output'],
    ['wait', 'Waited 26ms', 'wait fixture output'],
    ['waitfor', 'Found <DIV> "wrong"', 'waitfor fixture output'],
    ['cascade', JSON.stringify({
      ...JSON.parse(fixtureOutput('cascade')),
      properties: [{ ...JSON.parse(fixtureOutput('cascade')).properties[0], computedValue: '13px' }],
    }), 'cascade fixture output'],
    ['checkpoint', 'Checkpoint captured\nURL: wrong', 'checkpoint fixture output'],
    ['cookies', 'sid  TOPSECRET  example.test  session', 'cookies fixture output'],
    ['cookieset', 'Cookie set: wrong=value (domain: 127.0.0.1)', 'cookieset fixture output'],
    ['cookiedel', 'Cookie deleted: wrong', 'cookiedel fixture output'],
    ['dialog', 'Dialog auto-accept: ON (default)', 'dialog fixture output'],
    ['keepalive', 'Daemon keepalive extended for 2000ms', 'keepalive fixture output'],
    ['netlog', 'No network requests captured', 'netlog fixture output'],
    ['eval', 'wrong-eval', 'eval fixture output'],
    ['eval64', 'wrong-eval64', 'eval64 fixture output'],
    ['call', '{"phase7":"wrong"}', 'call fixture output'],
    ['console', 'Console entries cleared', 'console fixture output'],
    ['record', 'Record timeline (250ms)', 'record fixture output'],
    ['batch', '[1] text: wrong', 'batch fixture output'],
    ['flow', 'Flow: 1 step(s)', 'flow fixture output'],
    ['repeat', 'Repeat 1× wait 25', 'repeat fixture output'],
    ['replay', JSON.stringify({ schema: 'chrome-cdp-ex.replay.v1' }), 'replay fixture output'],
    ['viewport', JSON.stringify({
      schema: 'chrome-cdp-ex.action.v1', action: 'viewport', dispatch: { ok: false },
      receipt: { schema: 'chrome-cdp-ex.action-receipt.v1', outcome: 'changed' },
    }), 'viewport dispatch'],
    ['emulate', JSON.stringify({ schema: 'chrome-cdp-ex.emulate.v1', active: false }), 'emulate fixture output'],
  ])('rejects an invalid %s handoff and cleans up', async (invalidId, invalidOutput, expectedMessage) => {
    const cleanup = vi.fn(async () => {});
    await expect(runPhase4SliceSession({
      targetPrefix: TARGET,
      expectedTitle: TITLE,
      expectedUrl: URL,
      runCommand: async command => command.id === invalidId ? invalidOutput : fixtureOutput(command.id),
      runMcpCommand: async command => fixtureOutput(command.id),
      cleanup,
    })).rejects.toThrow(expectedMessage);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('rejects MCP extraction drift and still cleans up', async () => {
    const cleanup = vi.fn(async () => {});
    await expect(runPhase4SliceSession({
      targetPrefix: TARGET,
      expectedTitle: TITLE,
      expectedUrl: URL,
      runCommand: async command => fixtureOutput(command.id),
      runMcpCommand: async command => command.id === 'text' ? 'wrong text' : fixtureOutput(command.id),
      cleanup,
    })).rejects.toThrow(/MCP text output differs/);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('accepts a semantically valid second action outcome while keeping read parity byte-exact', async () => {
    const cleanup = vi.fn(async () => {});
    await expect(runPhase4SliceSession({
      targetPrefix: TARGET,
      expectedTitle: TITLE,
      expectedUrl: URL,
      runCommand: async command => fixtureOutput(command.id),
      runMcpCommand: async command => {
        const output = fixtureOutput(command.id);
        if (command.id !== 'press') return output;
        const model = JSON.parse(output);
        model.outcome.status = 'no-change';
        model.receipt.outcome = 'no-change';
        return JSON.stringify(model);
      },
      cleanup,
    })).resolves.toMatchObject({ extractionParity: 43 });
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('binds export identity to the preceding record-actions session and target', async () => {
    const cleanup = vi.fn(async () => {});
    await expect(runPhase4SliceSession({
      targetPrefix: TARGET,
      expectedTitle: TITLE,
      expectedUrl: URL,
      runCommand: async command => {
        if (command.id !== 'export-playwright') return fixtureOutput(command.id);
        const model = JSON.parse(fixtureOutput(command.id));
        model.sessionId = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
        return JSON.stringify(model);
      },
      runMcpCommand: async command => fixtureOutput(command.id),
      cleanup,
    })).rejects.toThrow(/export-playwright fixture output/);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('rejects the same malicious identity in record and export before projection', async () => {
    const cleanup = vi.fn(async () => {});
    const malicious = '/Users/alice/private/token.txt password=hunter2';
    await expect(runPhase4SliceSession({
      targetPrefix: TARGET,
      expectedTitle: TITLE,
      expectedUrl: URL,
      runCommand: async command => {
        const output = fixtureOutput(command.id);
        if (!['record-actions', 'export-playwright'].includes(command.id)) return output;
        const model = JSON.parse(output);
        model.sessionId = malicious;
        return JSON.stringify(model);
      },
      runMcpCommand: async command => {
        const output = fixtureOutput(command.id);
        if (!['record-actions', 'export-playwright'].includes(command.id)) return output;
        const model = JSON.parse(output);
        model.sessionId = malicious;
        return JSON.stringify(model);
      },
      cleanup,
    })).rejects.toThrow(/identity sessionId|opaque identifier/);
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
