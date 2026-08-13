import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';

import {
  assertPhase6Convergence,
  createPhase6Cancellation,
  provePhase6InjectedBoundaries,
  runPhase6ConvergenceSession,
} from '../scripts/validation-phase6-convergence.mjs';
import {
  COMMAND_SURFACE,
  MCP_TOOL_DEFINITIONS,
} from '../skills/chrome-cdp-ex/scripts/lib/command-surface.mjs';
import {
  commandResult,
  createCommandRegistry,
  defineCommandSpec,
  executeCommand,
} from '../skills/chrome-cdp-ex/scripts/lib/command-application.mjs';
import { createBrowserSupervisor } from '../skills/chrome-cdp-ex/scripts/lib/browser-supervisor.mjs';
import { createLocatorPlan } from '../skills/chrome-cdp-ex/scripts/lib/browser-resources.mjs';
import { requestDaemon } from '../skills/chrome-cdp-ex/scripts/lib/daemon-transport.mjs';
import {
  createCdpDomains,
  createRawCdpGateway,
} from '../skills/chrome-cdp-ex/scripts/lib/cdp-domains.mjs';

const TITLE = 'chrome-cdp-ex long-session smoke';
const URL = 'http://127.0.0.1:41868/validation-phase6.html';
const TARGET = 'ABC12345';

function perception() {
  return JSON.stringify({
    schema: 'chrome-cdp-ex.perceive.v1',
    targetPrefix: TARGET,
    page: { title: TITLE, url: URL },
    viewport: { coordinateSpace: 'viewport-css-px', width: 1280, height: 720 },
    console: { errors: 0, warnings: 0, exceptions: 0 },
    refs: { generation: 1 },
    nodes: [{ ref: '@1', role: 'button', name: 'Close' }],
    limits: { truncated: false },
  });
}

function action(name) {
  return JSON.stringify({
    schema: 'chrome-cdp-ex.action.v1',
    action: name,
    targetPrefix: TARGET,
    dispatch: { ok: true },
    settle: { ok: true },
    outcome: { status: 'changed' },
    receipt: { schema: 'chrome-cdp-ex.action-receipt.v1', outcome: 'changed' },
    recommendation: { targetPrefix: TARGET },
  });
}

function outputs(overrides = {}) {
  return {
    help: `cdp fixture\nUsage: cdp <command> [args]\n${COMMAND_SURFACE.commands.map(command => command.help.synopsis).join('\n')}`,
    tools: MCP_TOOL_DEFINITIONS,
    cliPerception: perception(),
    mcpPerception: perception(),
    click: action('click'),
    modalState: JSON.stringify({ title: TITLE, modalHidden: true }),
    reload: action('reload'),
    networkTrigger: 'triggered',
    network: `Network requests (1):\n  POST http://127.0.0.1:41868/api/fail → 503 (1ms, 0B) 0s ago`,
    raw: JSON.stringify({ root: { nodeId: 1 } }),
    report: JSON.stringify({
      schema: 'chrome-cdp-ex.report.v1',
      targetPrefix: TARGET,
      counts: { actions: 2 },
      latestAction: { action: 'reload', outcome: 'changed' },
    }),
    boundaries: {
      schema: 'chrome-cdp-ex.phase6-boundaries.v1',
      denials: 5,
      audit: { kind: 'raw-audit', method: 'DOM.getDocument', sideEffectClass: 'read-only' },
      staleRecovery: true,
      timeoutIdentity: true,
      transportIdentity: true,
      primaryCleanupIdentity: true,
    },
    expectedTitle: TITLE,
    expectedUrl: URL,
    expectedTargetPrefix: TARGET,
    ...overrides,
  };
}

describe('Phase 6 convergence validation', () => {
  it('accepts exact generated/MCP/perception/action/network/raw/report semantics', () => {
    expect(assertPhase6Convergence(outputs())).toEqual({
      tools: 26,
      actions: 2,
      rawMethod: 'DOM.getDocument',
      boundaries: 5,
    });
  });

  it.each([
    ['help', 'not generated help', /help/],
    ['tools', MCP_TOOL_DEFINITIONS.slice(1), /tools/],
    ['mcpPerception', '{}', /perception/],
    ['click', action('press'), /click/],
    ['modalState', JSON.stringify({ title: TITLE, modalHidden: false }), /modal state/],
    ['reload', action('click'), /reload/],
    ['networkTrigger', 'no event', /network trigger/],
    ['network', 'No network requests', /network/],
    ['network', `Network requests (1):\n  POST ${URL.replace('/validation-phase6.html', '/api/fail')} → 5030 (1ms)`, /network/],
    ['raw', JSON.stringify({}), /raw/],
    ['report', JSON.stringify({ schema: 'chrome-cdp-ex.report.v1', targetPrefix: TARGET, counts: { actions: 0 } }), /report/],
  ])('rejects invalid %s proof', (key, value, pattern) => {
    expect(() => assertPhase6Convergence(outputs({ [key]: value }))).toThrow(pattern);
  });

  it('runs every convergence step and cleans exactly once', async () => {
    const fixture = outputs();
    const steps = {
      collect: vi.fn(async () => fixture),
      cleanup: vi.fn(async () => {}),
    };
    await expect(runPhase6ConvergenceSession(steps)).resolves.toEqual({
      tools: 26,
      actions: 2,
      rawMethod: 'DOM.getDocument',
      boundaries: 5,
    });
    expect(steps.collect).toHaveBeenCalledOnce();
    expect(steps.cleanup).toHaveBeenCalledOnce();
  });

  it('preserves primary and cleanup failures and never skips cleanup', async () => {
    const primary = new Error('primary failed');
    const cleanup = new Error('cleanup failed');
    const steps = {
      collect: vi.fn(async () => { throw primary; }),
      cleanup: vi.fn(async () => { throw cleanup; }),
    };
    let thrown;
    try { await runPhase6ConvergenceSession(steps); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(AggregateError);
    expect(thrown.errors).toEqual([primary, cleanup]);
    expect(steps.cleanup).toHaveBeenCalledOnce();

    steps.cleanup.mockResolvedValueOnce();
    await expect(runPhase6ConvergenceSession(steps)).rejects.toBe(primary);
  });

  it('sets cancellation before cleanup and fences every later step before exit', async () => {
    let releaseCleanup;
    const cleanupGate = new Promise(resolve => { releaseCleanup = resolve; });
    const cleanup = vi.fn(async () => cleanupGate);
    const exit = vi.fn();
    const cancellation = createPhase6Cancellation({ cleanup, exit });
    const signal = cancellation.onSignal('SIGTERM');
    expect(cancellation.isCancelled()).toBe(true);
    expect(() => cancellation.ensureActive()).toThrow(/cancelled/);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();
    releaseCleanup();
    await signal;
    expect(exit).toHaveBeenCalledWith(143);
  });

  it('fails unknown, cross-domain, and unauthorized raw calls before transport', () => {
    const send = vi.fn();
    const transport = { send };
    const domains = createCdpDomains(transport);
    expect(domains.Experimental).toBeUndefined();
    expect(domains.DOM.mystery).toBeUndefined();
    expect(() => domains.DOM.mystery({})).toThrow(TypeError);
    expect(domains.Page.getDocument).toBeUndefined();
    expect(() => domains.Page.getDocument({})).toThrow(TypeError);
    expect(() => createRawCdpGateway(transport, null)).toThrow(/authorization/);
    expect(send).not.toHaveBeenCalled();
  });

  it('runs the exact injected boundary routine used by live evidence', async () => {
    await expect(provePhase6InjectedBoundaries()).resolves.toEqual(outputs().boundaries);
  });

  it('exercises actual stale-target recovery before routing one request', async () => {
    const browser = { kind: 'browser', id: 'browser-p6', revision: 1 };
    const candidate = (targetId, revision) => ({
      resource: {
        schema: 'chrome-cdp-ex.resource-ref.v1',
        kind: 'page',
        id: `page-${targetId}`,
        revision,
        capabilities: ['perceive'],
        links: [{ relation: 'browser', ...browser }],
      },
      targetId,
      aliases: [],
      url: URL,
      current: true,
      browser,
    });
    let discovered = [candidate('TARGET-OLD', 1)];
    const stop = vi.fn(async () => {});
    const request = vi.fn(async (_connection, value) => value);
    const supervisor = createBrowserSupervisor({
      discover: async () => discovered,
      endpointFor: targetId => `/runtime/${targetId}`,
      open: async (targetId, endpoint) => ({ targetId, endpoint }),
      inspect: async connection => ({ boundTargetId: connection.targetId, endpoint: connection.endpoint }),
      request,
      stop,
    });
    const handle = await supervisor.resolve(createLocatorPlan({
      schema: 'chrome-cdp-ex.locator-plan.v1',
      strategy: 'exact-target',
      value: 'TARGET-OLD',
      scope: browser,
      fallbacks: [{
        schema: 'chrome-cdp-ex.locator-plan.v1',
        strategy: 'target-prefix',
        value: 'TARGET-',
        scope: browser,
        fallbacks: [],
      }],
    }));
    discovered = [candidate('TARGET-NEW', 2)];
    await expect(supervisor.execute(handle, { cmd: 'perceive', args: [] }))
      .resolves.toEqual({ cmd: 'perceive', args: [] });
    expect(stop).toHaveBeenCalledWith('TARGET-OLD', '/runtime/TARGET-OLD', undefined);
    expect(request).toHaveBeenCalledOnce();
    await supervisor.close();
  });

  it('preserves actual domain transport errors and bounded daemon timeout identity', async () => {
    const sentinel = new Error('transport sentinel');
    const domains = createCdpDomains({ send: vi.fn(async () => { throw sentinel; }) });
    await expect(domains.DOM.getDocument({}, 'SESSION')).rejects.toBe(sentinel);

    vi.useFakeTimers();
    try {
      const connection = new EventEmitter();
      connection.write = vi.fn();
      connection.end = vi.fn();
      connection.destroy = vi.fn();
      const promise = requestDaemon(connection, { cmd: 'report', args: [] }, {
        runtimeDir: '/runtime',
        timeoutMs: 25,
      });
      const rejected = expect(promise).rejects.toThrow(/IPC timeout: command "report"/);
      await vi.advanceTimersByTimeAsync(25);
      await rejected;
      expect(connection.destroy).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('proves authorized raw audit is params-free and denied raw never reaches transport', async () => {
    const spec = defineCommandSpec({
      name: 'evalraw', aliases: [], needsTarget: true, mutates: false,
      feedbackPolicy: null, outputFormats: ['text'], kind: 'raw-cdp',
      authorization: 'raw-cdp', evidencePolicy: 'raw-audit',
    });
    const registry = createCommandRegistry([spec]);
    const send = vi.fn(async () => ({ root: { nodeId: 1 } }));
    const handler = async ({ authorization }) => {
      const gateway = createRawCdpGateway({ send }, authorization);
      const value = await gateway.execute({ depth: 99, secret: 'must-not-enter-audit' }, 'SESSION');
      return commandResult(JSON.stringify(value), {
        kind: 'raw-audit', method: gateway.method, sideEffectClass: gateway.sideEffectClass,
      });
    };
    const approved = await executeCommand({
      name: 'evalraw', args: ['DOM.getDocument', '{}'], targetBound: true,
    }, {
      registry,
      handlers: { evalraw: handler },
      authorize: async () => ({ allowed: true, code: 'phase6-approved' }),
    });
    expect(approved.evidence).toEqual({
      kind: 'raw-audit', method: 'DOM.getDocument', sideEffectClass: 'read-only',
    });
    expect(JSON.stringify(approved.evidence)).not.toMatch(/depth|secret|99/);
    send.mockClear();
    await expect(executeCommand({
      name: 'evalraw', args: ['DOM.getDocument', '{}'], targetBound: true,
    }, {
      registry,
      handlers: { evalraw: handler },
      authorize: async () => ({ allowed: false, code: 'phase6-denied' }),
    })).rejects.toThrow(/authorization denied/);
    expect(send).not.toHaveBeenCalled();
  });
});
