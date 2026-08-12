#!/usr/bin/env node

import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { createServer } from 'http';
import { tmpdir, userInfo } from 'os';
import { resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import { withLiveBenchmarkLock } from './benchmark-run-lock.mjs';
import {
  buildDisposableBrowserArgs,
  discoverBrowserCandidates,
} from './validation-live-boundary.mjs';
import {
  assertPhase5SemanticParity,
  cleanupPhase5Resources,
  closeServer,
  monitorBrowser,
  spawnCdp,
  stopBrowser,
  waitForTarget,
} from './validation-phase5-supervisor.mjs';
import {
  COMMAND_SURFACE,
  MCP_TOOL_DEFINITIONS,
} from '../skills/chrome-cdp-ex/scripts/lib/command-surface.mjs';
import {
  connectToDaemon,
  daemonEndpointForPlatform,
  requestDaemon,
} from '../skills/chrome-cdp-ex/scripts/lib/daemon-transport.mjs';
import {
  commandResult,
  createCommandRegistry,
  defineCommandSpec,
  executeCommand,
} from '../skills/chrome-cdp-ex/scripts/lib/command-application.mjs';
import {
  createCdpDomains,
  createRawCdpGateway,
} from '../skills/chrome-cdp-ex/scripts/lib/cdp-domains.mjs';
import { createBrowserSupervisor } from '../skills/chrome-cdp-ex/scripts/lib/browser-supervisor.mjs';
import { createLocatorPlan } from '../skills/chrome-cdp-ex/scripts/lib/browser-resources.mjs';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const pagePath = resolve(rootDir, 'scripts/smoke-page.html');
const EXPECTED_TITLE = 'chrome-cdp-ex long-session smoke';

function parseJson(label, value) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

const PHASE6_BOUNDARY_PROOF = Object.freeze({
  schema: 'chrome-cdp-ex.phase6-boundaries.v1',
  denials: 5,
  audit: Object.freeze({
    kind: 'raw-audit',
    method: 'DOM.getDocument',
    sideEffectClass: 'read-only',
  }),
  staleRecovery: true,
  timeoutIdentity: true,
  transportIdentity: true,
  primaryCleanupIdentity: true,
});

export async function provePhase6InjectedBoundaries() {
  let denials = 0;
  const rawSends = [];
  const transport = { send: async (...args) => { rawSends.push(args); return { root: { nodeId: 1 } }; } };
  const domains = createCdpDomains(transport);
  if (domains.Experimental !== undefined) throw new Error('unknown CDP domain was exposed');
  denials += 1;
  if (domains.DOM.mystery !== undefined) throw new Error('unknown CDP method was exposed');
  try {
    domains.DOM.mystery({});
    throw new Error('unknown CDP method was callable');
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    denials += 1;
  }
  try {
    domains.Page.getDocument({});
    throw new Error('cross-domain CDP method was exposed');
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    denials += 1;
  }
  try {
    createRawCdpGateway(transport, null);
    throw new Error('raw gateway accepted missing authorization');
  } catch (error) {
    if (!/authorization/.test(error.message)) throw error;
    denials += 1;
  }

  const spec = defineCommandSpec({
    name: 'evalraw', aliases: [], needsTarget: true, mutates: false,
    feedbackPolicy: null, outputFormats: ['text'], kind: 'raw-cdp',
    authorization: 'raw-cdp', evidencePolicy: 'raw-audit',
  });
  const registry = createCommandRegistry([spec]);
  const rawHandler = async ({ authorization }) => {
    const gateway = createRawCdpGateway(transport, authorization);
    const value = await gateway.execute({ depth: 99, secret: 'proof-only-sentinel' }, 'PHASE6');
    return commandResult(JSON.stringify(value), {
      kind: 'raw-audit', method: gateway.method, sideEffectClass: gateway.sideEffectClass,
    });
  };
  const approved = await executeCommand({
    name: 'evalraw', args: ['DOM.getDocument', '{}'], targetBound: true,
  }, {
    registry,
    handlers: { evalraw: rawHandler },
    authorize: async () => ({ allowed: true, code: 'phase6-approved' }),
  });
  if (JSON.stringify(approved.evidence) !== JSON.stringify(PHASE6_BOUNDARY_PROOF.audit)
    || /depth|secret|99|proof-only/.test(JSON.stringify(approved.evidence))
    || rawSends.length !== 1) {
    throw new Error('raw audit proof was not params-free and exact');
  }
  await executeCommand({
    name: 'evalraw', args: ['DOM.getDocument', '{}'], targetBound: true,
  }, {
    registry,
    handlers: { evalraw: rawHandler },
    authorize: async () => ({ allowed: false, code: 'phase6-denied' }),
  }).then(
    () => { throw new Error('unauthorized raw command was accepted'); },
    error => {
      if (!/authorization denied/.test(error.message)) throw error;
      denials += 1;
    },
  );
  if (rawSends.length !== 1) throw new Error('unauthorized raw command reached transport');

  const browser = { kind: 'browser', id: 'browser-phase6', revision: 1 };
  const candidate = (targetId, revision) => ({
    resource: {
      schema: 'chrome-cdp-ex.resource-ref.v1', kind: 'page', id: `page-${targetId}`,
      revision, capabilities: ['perceive'], links: [{ relation: 'browser', ...browser }],
    },
    targetId, aliases: [], url: 'http://127.0.0.1/phase6', current: true, browser,
  });
  let discovered = [candidate('TARGET-OLD', 1)];
  const stopped = [];
  let requests = 0;
  const supervisor = createBrowserSupervisor({
    discover: async () => discovered,
    endpointFor: targetId => `/phase6/${targetId}`,
    open: async (targetId, endpoint) => ({ targetId, endpoint }),
    inspect: async connection => ({ boundTargetId: connection.targetId, endpoint: connection.endpoint }),
    request: async (_connection, request) => { requests += 1; return request; },
    stop: async targetId => { stopped.push(targetId); },
  });
  const handle = await supervisor.resolve(createLocatorPlan({
    schema: 'chrome-cdp-ex.locator-plan.v1', strategy: 'exact-target', value: 'TARGET-OLD',
    scope: browser,
    fallbacks: [{
      schema: 'chrome-cdp-ex.locator-plan.v1', strategy: 'target-prefix', value: 'TARGET-',
      scope: browser, fallbacks: [],
    }],
  }));
  discovered = [candidate('TARGET-NEW', 2)];
  await supervisor.execute(handle, { cmd: 'perceive', args: [] });
  await supervisor.close();
  if (JSON.stringify(stopped) !== JSON.stringify(['TARGET-OLD', 'TARGET-NEW']) || requests !== 1) {
    throw new Error('stale-target recovery proof was invalid');
  }

  const timeoutConnection = new EventEmitter();
  timeoutConnection.write = () => {};
  timeoutConnection.end = () => {};
  timeoutConnection.destroy = () => {};
  const timeoutError = await requestDaemon(timeoutConnection, { cmd: 'report', args: [] }, {
    runtimeDir: '/phase6-runtime', timeoutMs: 25,
  }).then(() => null, error => error);
  if (!/IPC timeout: command "report"/.test(timeoutError?.message || '')) {
    throw new Error('daemon timeout identity was not preserved');
  }

  const transportSentinel = new Error('phase6 transport sentinel');
  const transportDomains = createCdpDomains({ send: async () => { throw transportSentinel; } });
  const observedTransport = await transportDomains.DOM.getDocument({}).then(() => null, error => error);
  if (observedTransport !== transportSentinel) throw new Error('domain transport error identity changed');

  const primarySentinel = new Error('phase6 primary sentinel');
  const cleanupSentinel = new Error('phase6 cleanup sentinel');
  const combined = await runPhase6ConvergenceSession({
    collect: async () => { throw primarySentinel; },
    cleanup: async () => { throw cleanupSentinel; },
  }).then(() => null, error => error);
  if (!(combined instanceof AggregateError)
    || combined.errors?.[0] !== primarySentinel
    || combined.errors?.[1] !== cleanupSentinel) {
    throw new Error('primary and cleanup error identity was not preserved');
  }

  const proof = {
    schema: PHASE6_BOUNDARY_PROOF.schema,
    denials,
    audit: approved.evidence,
    staleRecovery: true,
    timeoutIdentity: true,
    transportIdentity: true,
    primaryCleanupIdentity: true,
  };
  if (JSON.stringify(proof) !== JSON.stringify(PHASE6_BOUNDARY_PROOF)) {
    throw new Error('injected boundary proof is incomplete');
  }
  return proof;
}

function assertAction(label, output, expectedAction, targetPrefix, { allowObservedTimeout = false } = {}) {
  const model = parseJson(label, output);
  const changed = model?.dispatch?.ok === true
    && model?.settle?.ok === true
    && model?.outcome?.status === 'changed'
    && model?.receipt?.outcome === 'changed';
  const observedTimeout = allowObservedTimeout
    && model?.dispatch?.ok === true
    && model?.settle?.ok === false
    && model?.outcome?.status === 'timeout'
    && model?.receipt?.outcome === 'timeout';
  if (model?.schema !== 'chrome-cdp-ex.action.v1'
    || model.action !== expectedAction
    || model?.receipt?.schema !== 'chrome-cdp-ex.action-receipt.v1'
    || (!changed && !observedTimeout)
    || model?.recommendation?.targetPrefix !== targetPrefix) {
    throw new Error(`${label} action proof is invalid: ${JSON.stringify({
      schema: model?.schema,
      action: model?.action,
      dispatch: model?.dispatch?.ok,
      dispatchError: model?.dispatch?.error,
      settle: model?.settle?.ok,
      outcome: model?.outcome?.status,
      receipt: model?.receipt?.outcome,
      target: model?.recommendation?.targetPrefix,
    })}`);
  }
  return model;
}

export function assertPhase6Convergence(proof) {
  if (!proof || typeof proof !== 'object') throw new Error('proof is required');
  const normalizedHelp = typeof proof.help === 'string'
    ? proof.help.replace(/[ \t]+/g, ' ')
    : '';
  const missingHelp = COMMAND_SURFACE.commands
    .filter(command => !normalizedHelp.includes(command.help.synopsis))
    .map(command => command.name);
  if (typeof proof.help !== 'string'
    || !proof.help.includes('\nUsage: cdp <command> [args]\n')
    || missingHelp.length) {
    throw new Error(`generated help proof is invalid${missingHelp.length ? `: ${missingHelp.slice(0, 8).join(',')}` : ''}`);
  }
  if (!Array.isArray(proof.tools)
    || JSON.stringify(proof.tools) !== JSON.stringify(MCP_TOOL_DEFINITIONS)) {
    throw new Error('MCP tools proof is invalid');
  }
  assertPhase5SemanticParity(proof.cliPerception, proof.mcpPerception, {
    expectedTitle: proof.expectedTitle,
    expectedUrl: proof.expectedUrl,
    expectedCliTargetPrefix: proof.expectedTargetPrefix,
    expectedMcpTargetPrefix: proof.expectedTargetPrefix,
  });
  assertAction('click', proof.click, 'click', proof.expectedTargetPrefix);
  const modalState = parseJson('modal state', proof.modalState);
  if (modalState?.title !== proof.expectedTitle || modalState?.modalHidden !== true) {
    throw new Error('modal state proof is invalid');
  }
  assertAction('reload', proof.reload, 'reload', proof.expectedTargetPrefix, { allowObservedTimeout: true });
  if (typeof proof.networkTrigger !== 'string' || !proof.networkTrigger.includes('triggered')) {
    throw new Error('network trigger proof is invalid');
  }
  const expectedFailureUrl = new URL('/api/fail', proof.expectedUrl).href;
  const escapedFailureUrl = expectedFailureUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const expectedNetworkRow = new RegExp(`^POST ${escapedFailureUrl} → 503 \\(`);
  if (typeof proof.network !== 'string'
    || !proof.network.split(/\r?\n/).map(line => line.trim()).some(line => expectedNetworkRow.test(line))) {
    throw new Error(`network observation proof is invalid: ${String(proof.network).slice(0, 240)}`);
  }
  const raw = parseJson('raw CDP result', proof.raw);
  if (!Number.isInteger(raw?.root?.nodeId)) throw new Error('raw CDP proof is invalid');
  const report = parseJson('report', proof.report);
  if (report?.schema !== 'chrome-cdp-ex.report.v1'
    || report.targetPrefix !== proof.expectedTargetPrefix
    || !Number.isInteger(report?.counts?.actions)
    || report.counts.actions < 2
    || report?.latestAction?.action !== 'reload') {
    throw new Error('report proof is invalid');
  }
  if (JSON.stringify(proof.boundaries) !== JSON.stringify(PHASE6_BOUNDARY_PROOF)) {
    throw new Error('injected boundary proof is invalid');
  }
  return {
    tools: proof.tools.length,
    actions: report.counts.actions,
    rawMethod: 'DOM.getDocument',
    boundaries: proof.boundaries.denials,
  };
}

export async function runPhase6ConvergenceSession(steps) {
  if (typeof steps?.collect !== 'function') throw new Error('collect step is required');
  if (typeof steps?.cleanup !== 'function') throw new Error('cleanup step is required');
  let result;
  let primaryError = null;
  try {
    result = assertPhase6Convergence(await steps.collect());
  } catch (error) {
    primaryError = error;
  }
  try {
    await steps.cleanup();
  } catch (cleanupError) {
    if (primaryError) throw new AggregateError([primaryError, cleanupError], primaryError.message);
    throw cleanupError;
  }
  if (primaryError) throw primaryError;
  return result;
}

export function createPhase6Cancellation({ cleanup, exit }) {
  if (typeof cleanup !== 'function') throw new Error('cancellation cleanup is required');
  if (typeof exit !== 'function') throw new Error('cancellation exit is required');
  let cancelled = false;
  return Object.freeze({
    isCancelled: () => cancelled,
    ensureActive() {
      if (cancelled) throw new Error('Phase 6 convergence cancelled');
    },
    async onSignal(signal) {
      cancelled = true;
      try {
        await cleanup();
      } catch {
        // The main convergence path awaits the same memoized cleanup and
        // preserves its error together with any primary failure.
      } finally {
        exit(signal === 'SIGTERM' ? 143 : 130);
      }
    },
  });
}

async function endpointUnavailable(endpoint) {
  let connection;
  try {
    connection = await connectToDaemon(endpoint, { timeoutMs: 100 });
  } catch {
    return;
  }
  connection.destroy();
  throw new Error('daemon endpoint remained reachable after cleanup');
}

export async function runDisposablePhase6Convergence() {
  if (!existsSync(pagePath)) throw new Error('Phase 6 validation page is missing');
  const candidate = discoverBrowserCandidates()[0];
  if (!candidate) throw new Error('no Chrome for Testing browser binary found');
  const [browserPath, browserName] = candidate;

  return withLiveBenchmarkLock({
    name: 'validation-phase6-convergence',
    portStart: 9464,
    serverPortStart: 41868,
    browser: browserName,
    profilePrefix: 'chrome-cdp-ex-validation-phase6',
  }, async run => {
    const { port, serverPort, profileDir } = run.metadata;
    const url = `http://127.0.0.1:${serverPort}/validation-phase6.html`;
    const runtimeDir = mkdtempSync(resolve(tmpdir(), 'chrome-cdp-p6-'));
    const localAppData = resolve(runtimeDir, 'localappdata');
    const daemonRuntimeDir = process.platform === 'win32'
      ? resolve(localAppData, 'cdp')
      : resolve(runtimeDir, 'cdp');
    const env = {
      ...process.env,
      CDP_PORT: String(port),
      NODE_ENV: 'production',
      XDG_RUNTIME_DIR: runtimeDir,
      ...(process.platform === 'win32' ? { LOCALAPPDATA: localAppData } : {}),
    };
    const previousPort = process.env.CDP_PORT;
    const previousRuntimeDir = process.env.XDG_RUNTIME_DIR;
    const previousLocalAppData = process.env.LOCALAPPDATA;
    process.env.CDP_PORT = String(port);
    process.env.XDG_RUNTIME_DIR = runtimeDir;
    if (process.platform === 'win32') process.env.LOCALAPPDATA = localAppData;

    const server = createServer((request, response) => {
      if (request.url === '/validation-phase6.html') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(readFileSync(pagePath));
        return;
      }
      if (request.url === '/api/fail') {
        response.writeHead(503, { 'content-type': 'text/plain' });
        response.end('expected failure');
        return;
      }
      response.writeHead(404);
      response.end('not found');
    });
    let browser = null;
    let diagnostics = null;
    let current = null;
    let cleaning = null;
    const targetIds = new Set();

    const cleanup = () => {
      cleaning ||= cleanupPhase5Resources({
        supervisor: null,
        targetIds,
        discoverTargetIds: async () => {
          if (!browser || browser.exitCode !== null || browser.signalCode !== null) return [];
          try {
            const model = parseJson('cleanup list', spawnCdp(['list', '--format', 'json'], env, 500));
            return model.pages
              .filter(page => page?.url === url && typeof page?.targetId === 'string')
              .map(page => page.targetId);
          } catch {
            return [];
          }
        },
        stopTarget: async targetId => {
          const receipt = parseJson(
            'cleanup stop',
            spawnCdp(['stop', targetId, '--format', 'json'], env, 1_000),
          );
          if (receipt?.schema !== 'chrome-cdp-ex.stop.v1'
            || !Array.isArray(receipt.failedTargets)
            || receipt.failedTargets.length !== 0
            || (receipt.stopped !== true && receipt.noop !== true)) {
            throw new Error('cleanup stop receipt is invalid');
          }
          await endpointUnavailable(daemonEndpointForPlatform(targetId, { runtimeDir: daemonRuntimeDir }));
        },
        browser,
        stopBrowserProcess: stopBrowser,
        server,
        closeHttpServer: closeServer,
        profileDir,
        runtimeDir,
        removeProfile: path => rmSync(path, { recursive: true, force: true }),
        removeRuntime: path => rmSync(path, { recursive: true, force: true }),
        pathExists: existsSync,
        restoreEnvironment: () => {
          if (previousPort === undefined) delete process.env.CDP_PORT;
          else process.env.CDP_PORT = previousPort;
          if (previousRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR;
          else process.env.XDG_RUNTIME_DIR = previousRuntimeDir;
          if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
          else process.env.LOCALAPPDATA = previousLocalAppData;
        },
        timeoutMs: 1_000,
        browserTimeoutMs: 1_500,
      });
      return cleaning;
    };
    const cancellation = createPhase6Cancellation({ cleanup, exit: code => { process.exitCode = code; } });
    const ensureActive = () => cancellation.ensureActive();
    const runCdp = (...args) => {
      ensureActive();
      const result = spawnCdp(...args);
      ensureActive();
      return result;
    };
    const onSignal = signal => { void cancellation.onSignal(signal); };
    process.once('SIGTERM', onSignal);
    process.once('SIGINT', onSignal);

    let output;
    let primaryError = null;
    try {
      ensureActive();
      await new Promise((resolveListen, reject) => {
        server.once('error', reject);
        server.listen(serverPort, '127.0.0.1', resolveListen);
      });
      ensureActive();
      browser = spawn(browserPath, buildDisposableBrowserArgs({ port, profileDir, url }), {
        detached: false,
        env: { ...process.env, HOME: userInfo().homedir },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      ensureActive();
      diagnostics = monitorBrowser(browser);

      const { createMcpRequestHandler } = await import('../skills/chrome-cdp-ex/scripts/mcp-server.mjs');
      const sent = [];
      let requestId = 0;
      const handler = createMcpRequestHandler({ sendMessage: message => sent.push(message) });
      const requestMcp = async (method, params = {}) => {
        sent.length = 0;
        const id = ++requestId;
        await handler({ jsonrpc: '2.0', id, method, params });
        const response = sent.find(message => message.id === id);
        if (!response) throw new Error(`MCP ${method} returned no response`);
        if (response.error) throw new Error(response.error.message);
        return response.result;
      };
      const callTool = async (name, args) => {
        ensureActive();
        const result = await requestMcp('tools/call', { name, arguments: args });
        ensureActive();
        if (result?.isError) throw new Error(result.content?.[0]?.text || `${name} failed`);
        const text = result?.content?.[0]?.text;
        if (typeof text !== 'string') throw new Error(`${name} returned no text`);
        return text;
      };

      const result = assertPhase6Convergence(await (async () => {
          const boundaries = await provePhase6InjectedBoundaries();
          ensureActive();
          current = await waitForTarget({
            browser, diagnostics, port, url, env, isCancelled: cancellation.isCancelled,
          });
          ensureActive();
          targetIds.add(current.targetId);
          const help = runCdp(['help'], env, 5_000);
          const tools = (await requestMcp('tools/list')).tools;
          ensureActive();
          const cliPerception = runCdp(
            ['perceive', current.targetId, '--format', 'json'], env, 30_000,
          );
          const mcpPerception = await callTool('perceive', {
            target: current.targetId,
            adaptive: false,
          });
          const raw = runCdp(
            ['evalraw', current.targetId, 'DOM.getDocument', '{}'], env, 30_000,
          );
          const click = await callTool('click', {
            target: current.targetId,
            selector: '#close-modal',
            confirm: true,
          });
          const networkTrigger = runCdp(
            [
              'eval', current.targetId,
              "document.querySelector('#diagnostic').click(); JSON.stringify({title:document.title,modalHidden:document.getElementById('motd').hidden,network:'triggered'})",
            ],
            env,
            30_000,
          );
          const modalState = networkTrigger;
          await new Promise(resolveDelay => setTimeout(resolveDelay, 500));
          ensureActive();
          const network = runCdp(['netlog', current.targetId], env, 5_000);
          const reload = runCdp(
            ['reload', current.targetId, '--format', 'json'], env, 30_000,
          );
          const report = runCdp(
            ['report', current.targetId, '--format', 'json'], env, 5_000,
          );
        return {
            help,
            tools,
            cliPerception,
            mcpPerception,
            click,
            modalState,
            reload,
            networkTrigger,
            network,
            raw,
            report,
            boundaries,
            expectedTitle: EXPECTED_TITLE,
            expectedUrl: url,
            expectedTargetPrefix: current.targetPrefix,
        };
      })());
      output = `Phase 6 convergence OK: ${browserName}, ${result.tools} tools, ${result.actions} actions, ${result.rawMethod}, ${result.boundaries} denials`;
    } catch (error) {
      primaryError = error;
    } finally {
      process.off('SIGTERM', onSignal);
      process.off('SIGINT', onSignal);
      try {
        await cleanup();
      } catch (cleanupError) {
        primaryError = primaryError
          ? new AggregateError([primaryError, cleanupError], primaryError.message)
          : cleanupError;
      }
    }
    if (primaryError) throw primaryError;
    return output;
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  runDisposablePhase6Convergence().then(output => {
    console.log(output);
  }).catch(error => {
    console.error(`Phase 6 convergence failed: ${error.message}`);
    if (process.exitCode !== 130 && process.exitCode !== 143) process.exitCode = 1;
  });
}
