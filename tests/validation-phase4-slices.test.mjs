import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { describe, expect, it, vi } from 'vitest';

import {
  assertPhase4ActionState,
  assertPhase4OutputPrivacy,
  assertPhase4TargetReady,
  buildPhase4SliceCommands,
  createPhase4Cancellation,
  monitorDisposableBrowser,
  phase4RuntimeBase,
  runPhase4SliceSession,
} from '../scripts/validation-phase4-slices.mjs';

const TARGET = 'ABC12345';
const TARGET_ID = `${TARGET}6789`;
const SESSION_ID = 'B361FE026EC722325854623516F3EF83';
const TITLE = 'chrome-cdp-ex long-session smoke';
const URL = 'http://127.0.0.1:41758/validation-phase4.html';

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
  if (['click', 'fill', 'press', 'scroll', 'select'].includes(id)) {
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
        inputValue: 'phase7 input',
        selectValue: 'two',
        scrollY: 100,
      },
    },
  });
}

describe('Phase 4 disposable core-slice scenario', () => {
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

  it('freezes the exact bounded twenty-eight-command route and final fixture-state raw expression', () => {
    expect(buildPhase4SliceCommands(TARGET)).toEqual([
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
      { id: 'fill', args: ['fill', TARGET, '#cmd', 'phase7 input', '--format', 'json'] },
      { id: 'hover', args: ['hover', TARGET, '#refresh-account'] },
      { id: 'scroll', args: ['scroll', TARGET, 'down', '100', '--format', 'json'] },
      { id: 'select', args: ['select', TARGET, '#phase7-select', 'two', '--format', 'json'] },
      { id: 'press', args: ['press', TARGET, 'c', '--format', 'json'] },
      {
        id: 'evalraw',
        args: [
          'evalraw',
          TARGET,
          'Runtime.evaluate',
          '{"expression":"({title:document.title,modalHidden:document.querySelector(\'#motd\')?.hidden===true,shortcut:document.querySelector(\'#shortcut-status\')?.textContent,inputValue:document.querySelector(\'#cmd\')?.value,selectValue:document.querySelector(\'#phase7-select\')?.value,scrollY:Math.round(window.scrollY)})","returnByValue":true}',
        ],
      },
    ]);
    expect(Object.isFrozen(buildPhase4SliceCommands(TARGET))).toBe(true);
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

  it('validates every public handoff and always cleans up after success', async () => {
    const commands = buildPhase4SliceCommands(TARGET);
    const runCommand = vi.fn(async command => fixtureOutput(command.id));
    const runMcpCommand = vi.fn(async command => fixtureOutput(command.id));
    const cleanup = vi.fn(async () => {});

    await expect(runPhase4SliceSession({
      targetPrefix: TARGET,
      expectedTitle: TITLE,
      expectedUrl: URL,
      runCommand,
      runMcpCommand,
      cleanup,
    })).resolves.toEqual({
      targetPrefix: TARGET,
      commands: [
        'perceive', 'click', 'report', 'html', 'text', 'table', 'net', 'status', 'summary',
        'snap', 'controls', 'frame', 'overlay', 'styles', 'components', 'record-actions', 'export-playwright',
        'wait', 'waitfor', 'cascade',
        'checkpoint', 'cookies', 'fill', 'hover', 'scroll', 'select', 'press', 'evalraw',
      ],
      title: TITLE,
      clickOutcome: 'changed',
      reportActions: 1,
      extractionParity: 24,
    });
    expect(runCommand.mock.calls.map(([command]) => command)).toEqual(commands);
    expect(runMcpCommand.mock.calls.map(([command]) => command.id)).toEqual([
      'html', 'text', 'table', 'net', 'status', 'summary', 'snap', 'controls', 'frame',
      'overlay', 'styles', 'components', 'record-actions', 'export-playwright',
      'wait', 'waitfor', 'cascade',
      'checkpoint', 'cookies', 'fill', 'hover', 'scroll', 'select', 'press',
    ]);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it.each([
    'perceive', 'click', 'report', 'html', 'text', 'table', 'net', 'status', 'summary',
    'snap', 'controls', 'frame', 'overlay', 'styles', 'components', 'record-actions', 'export-playwright',
    'wait', 'waitfor', 'cascade',
    'checkpoint', 'cookies', 'fill', 'hover', 'scroll', 'select', 'press', 'evalraw',
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
    })).resolves.toMatchObject({ extractionParity: 24 });
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
