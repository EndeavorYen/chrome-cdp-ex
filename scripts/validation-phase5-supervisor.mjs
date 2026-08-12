#!/usr/bin/env node

import { spawn, spawnSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { createServer } from 'http';
import { userInfo } from 'os';
import { resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import { withLiveBenchmarkLock } from './benchmark-run-lock.mjs';
import {
  assertLiveBoundary,
  buildDisposableBrowserArgs,
  discoverBrowserCandidates,
} from './validation-live-boundary.mjs';
import { createBrowserSupervisor } from '../skills/chrome-cdp-ex/scripts/lib/browser-supervisor.mjs';
import { createLocatorPlan } from '../skills/chrome-cdp-ex/scripts/lib/browser-resources.mjs';
import {
  connectToDaemon,
  daemonEndpointForPlatform,
} from '../skills/chrome-cdp-ex/scripts/lib/daemon-transport.mjs';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const cdpPath = resolve(rootDir, 'skills/chrome-cdp-ex/scripts/cdp.mjs');
const pagePath = resolve(rootDir, 'scripts/smoke-page.html');
const EXPECTED_TITLE = 'chrome-cdp-ex long-session smoke';

function parseJson(label, value) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} output is not valid JSON`);
  }
}

export function assertPhase5SemanticParity(cliOutput, mcpOutput, options) {
  const { expectedTitle, expectedUrl } = options;
  const cli = parseJson('CLI perception', cliOutput);
  const mcp = parseJson('MCP perception', mcpOutput);
  const expectedCliTargetPrefix = options.expectedCliTargetPrefix;
  const expectedMcpTargetPrefix = options.expectedMcpTargetPrefix ?? expectedCliTargetPrefix;
  const projections = [];
  for (const [label, model, expectedTargetPrefix] of [
    ['CLI', cli, expectedCliTargetPrefix],
    ['MCP', mcp, expectedMcpTargetPrefix],
  ]) {
    if (model?.schema !== 'chrome-cdp-ex.perceive.v1') throw new Error(`${label} perception schema is invalid`);
    if (!expectedTargetPrefix || model?.targetPrefix !== expectedTargetPrefix) {
      throw new Error(`${label} perception target is invalid`);
    }
    if (model?.page?.title !== expectedTitle) throw new Error(`${label} perception title is invalid`);
    if (model?.page?.url !== expectedUrl) throw new Error(`${label} perception URL is invalid`);
    if (model?.viewport?.coordinateSpace !== 'viewport-css-px'
      || !Number.isFinite(model.viewport.width)
      || model.viewport.width <= 0
      || !Number.isFinite(model.viewport.height)
      || model.viewport.height <= 0) {
      throw new Error(`${label} perception viewport is invalid`);
    }
    if (!Number.isInteger(model?.refs?.generation)
      || !Array.isArray(model?.nodes)
      || model.nodes.length === 0
      || typeof model?.limits?.truncated !== 'boolean') {
      throw new Error(`${label} perception structure is invalid`);
    }
    for (const key of ['errors', 'warnings', 'exceptions']) {
      if (!Number.isInteger(model?.console?.[key])) {
        throw new Error(`${label} perception console health is invalid`);
      }
    }
    projections.push({
      page: model.page,
      viewport: {
        coordinateSpace: model.viewport.coordinateSpace,
        width: model.viewport.width,
      },
      console: model.console,
      nodes: model.nodes.map(node => ({ role: node?.role ?? null, name: node?.name ?? null })),
      truncated: model.limits.truncated,
    });
  }
  if (JSON.stringify(projections[0]) !== JSON.stringify(projections[1])) {
    const differing = Object.keys(projections[0]).filter(key => (
      JSON.stringify(projections[0][key]) !== JSON.stringify(projections[1][key])
    ));
    throw new Error(`CLI and MCP perception semantics differ: ${differing.join(',')}`);
  }
  return { schema: cli.schema, title: cli.page.title, url: cli.page.url };
}

export function assertDaemonStopped(output, expectedTargetPrefix) {
  const model = parseJson('daemon stop', output);
  if (model?.schema !== 'chrome-cdp-ex.stop.v1'
    || model.stopped !== true
    || model.noop !== false
    || !Array.isArray(model.stoppedTargets)
    || !model.stoppedTargets.includes(expectedTargetPrefix)
    || !Array.isArray(model.failedTargets)
    || model.failedTargets.length !== 0) {
    throw new Error([
      'daemon stop receipt is invalid',
      `schema=${model?.schema === 'chrome-cdp-ex.stop.v1'}`,
      `stopped=${model?.stopped === true}`,
      `noop=${model?.noop === false}`,
      `stoppedCount=${Array.isArray(model?.stoppedTargets) ? model.stoppedTargets.length : -1}`,
      `targetMatched=${Array.isArray(model?.stoppedTargets) && model.stoppedTargets.includes(expectedTargetPrefix)}`,
      `failedCount=${Array.isArray(model?.failedTargets) ? model.failedTargets.length : -1}`,
    ].join(' '));
  }
  return model;
}

async function assertDaemonEndpointUnavailable(endpoint) {
  let connection;
  try {
    connection = await connectToDaemon(endpoint, { timeoutMs: 100 });
  } catch {
    return;
  }
  connection.destroy();
  throw new Error('daemon endpoint remained reachable after cleanup');
}

function assertAction(output, expectedTargetPrefix) {
  const model = parseJson('recovered action', output);
  if (model?.schema !== 'chrome-cdp-ex.action.v1' || model?.action !== 'click') {
    throw new Error('recovered action schema is invalid');
  }
  if (model?.dispatch?.ok !== true) throw new Error('recovered action dispatch is invalid');
  if (model?.settle?.ok !== true
    || model?.outcome?.status !== 'changed'
    || model?.receipt?.schema !== 'chrome-cdp-ex.action-receipt.v1'
    || model.receipt.outcome !== 'changed'
    || model?.recommendation?.targetPrefix !== expectedTargetPrefix) {
    throw new Error('recovered action receipt is invalid');
  }
  return model.receipt.outcome;
}

function assertReport(output, expectedTargetPrefix) {
  const model = parseJson('recovered report', output);
  if (model?.schema !== 'chrome-cdp-ex.report.v1') throw new Error('recovered report schema is invalid');
  if (model.targetPrefix !== expectedTargetPrefix) throw new Error('recovered report target is invalid');
  if (!Number.isInteger(model?.counts?.actions) || model.counts.actions < 1) {
    throw new Error('recovered report action count is invalid');
  }
  if (model?.latestAction?.action !== 'click') throw new Error('recovered report latest action is invalid');
  return model.counts.actions;
}

export async function runPhase5SupervisorSession(steps) {
  const required = [
    'discover', 'resolve', 'connect', 'executeCli', 'executeMcp', 'stopDaemon',
    'restart', 'replaceTarget', 'rebind', 'report', 'cleanup',
  ];
  for (const name of required) if (typeof steps?.[name] !== 'function') throw new Error(`${name} step is required`);
  if (typeof steps.expectedTitle !== 'string' || typeof steps.expectedUrl !== 'string') {
    throw new Error('expectedTitle and expectedUrl are required');
  }

  let result;
  let primaryError = null;
  try {
    const discovery = await steps.discover();
    if (!discovery?.targetId) throw new Error('discovery target is invalid');
    const handle = await steps.resolve(discovery);
    const beforeResource = handle?.resource?.();
    if (!beforeResource?.id || !Number.isInteger(beforeResource.revision)) {
      throw new Error('resolved resource is invalid');
    }
    await steps.connect(handle, discovery);
    const cliOutput = await steps.executeCli(handle, discovery);
    const mcpOutput = await steps.executeMcp(handle, discovery);
    assertPhase5SemanticParity(cliOutput, mcpOutput, {
      ...steps,
      expectedCliTargetPrefix: discovery.targetPrefix,
      expectedMcpTargetPrefix: discovery.targetPrefix,
    });

    assertDaemonStopped(await steps.stopDaemon(handle, discovery), discovery.targetPrefix);
    const restarted = await steps.restart(handle, discovery);
    if (typeof restarted?.output !== 'string' || typeof restarted?.stopReceipt !== 'string') {
      throw new Error('daemon restart proof is invalid');
    }
    assertPhase5SemanticParity(cliOutput, restarted.output, {
      ...steps,
      expectedCliTargetPrefix: discovery.targetPrefix,
      expectedMcpTargetPrefix: discovery.targetPrefix,
    });
    assertDaemonStopped(restarted.stopReceipt, discovery.targetPrefix);

    const replacement = await steps.replaceTarget(handle, discovery);
    if (!replacement?.targetId || replacement.targetId === discovery.targetId) {
      throw new Error('replacement target did not advance');
    }
    const rebound = await steps.rebind(handle, replacement);
    const afterResource = rebound?.resource;
    if (!afterResource?.id
      || afterResource.id === beforeResource.id
      || !Number.isInteger(afterResource.revision)
      || afterResource.revision <= beforeResource.revision) {
      throw new Error('recovered resource identity and revision did not advance');
    }
    assertPhase5SemanticParity(cliOutput, rebound.output, {
      ...steps,
      expectedCliTargetPrefix: discovery.targetPrefix,
      expectedMcpTargetPrefix: replacement.targetPrefix,
    });
    const actionOutcome = assertAction(rebound.action, replacement.targetPrefix);
    const reportActions = assertReport(
      await steps.report(rebound.handle || handle, replacement),
      replacement.targetPrefix,
    );
    result = {
      initialTargetId: discovery.targetId,
      replacementTargetId: replacement.targetId,
      beforeRevision: beforeResource.revision,
      afterRevision: afterResource.revision,
      actionOutcome,
      reportActions,
    };
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

async function boundedCleanup(label, operation, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} cleanup timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function cleanupPhase5Resources(resources) {
  const targetIds = new Set(resources.targetIds || []);
  const timeoutMs = Number.isInteger(resources.timeoutMs) && resources.timeoutMs > 0
    ? resources.timeoutMs
    : 500;
  const browserTimeoutMs = Number.isInteger(resources.browserTimeoutMs) && resources.browserTimeoutMs > 0
    ? resources.browserTimeoutMs
    : 1_500;
  const capture = async (label, operation, operationTimeoutMs = timeoutMs) => {
    try {
      await boundedCleanup(label, operation, operationTimeoutMs);
      return null;
    } catch (error) {
      return error;
    }
  };

  const discoveryError = await capture('target discovery', async () => {
    for (const targetId of await resources.discoverTargetIds()) targetIds.add(targetId);
  });
  const boundedTargetIds = [...targetIds].slice(0, 4);
  const targetLimitError = targetIds.size > boundedTargetIds.length
    ? new Error('cleanup target count exceeded 4')
    : null;

  const [browserError, serverError] = await Promise.all([
    capture('browser', () => resources.stopBrowserProcess(resources.browser), browserTimeoutMs),
    capture('server', () => resources.closeHttpServer(resources.server)),
  ]);
  const [supervisorError, ...targetErrors] = await Promise.all([
    capture('supervisor', () => resources.supervisor?.close()),
    ...boundedTargetIds.map(targetId => capture(
      `daemon ${targetId}`,
      () => resources.stopTarget(targetId),
    )),
  ]);

  let profileError = null;
  let runtimeError = null;
  let restoreError = null;
  try {
    profileError = await capture('profile', () => resources.removeProfile(resources.profileDir));
    runtimeError = await capture('runtime', () => resources.removeRuntime(resources.runtimeDir));
    if (resources.pathExists(resources.runtimeDir)) {
      profileError ||= new Error('disposable runtime directory was not removed');
    }
    if (resources.pathExists(resources.profileDir)) {
      profileError ||= new Error('disposable profile was not removed');
    }
  } finally {
    try {
      resources.restoreEnvironment();
    } catch (error) {
      restoreError = error;
    }
  }

  const failures = [
    discoveryError,
    targetLimitError,
    supervisorError,
    ...targetErrors,
    browserError,
    serverError,
    profileError,
    runtimeError,
    restoreError,
  ].filter(Boolean);
  if (failures.length) throw new AggregateError(failures, 'Phase 5 cleanup failed');
}

function delay(ms) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms));
}

export async function stopBrowser(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  for (let attempt = 0; attempt < 10 && child.exitCode === null && child.signalCode === null; attempt += 1) {
    await delay(50);
  }
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  for (let attempt = 0; attempt < 20 && child.exitCode === null && child.signalCode === null; attempt += 1) {
    await delay(50);
  }
  if (child.exitCode === null && child.signalCode === null) {
    throw new Error(`disposable browser process ${child.pid} did not exit`);
  }
}

export async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
}

export function monitorBrowser(child, { maxBytes = 4096 } = {}) {
  let error = null;
  let stderr = '';
  child.stderr?.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-maxBytes); });
  child.once('error', value => { error = value; });
  return { error: () => error, stderr: () => stderr };
}

export function spawnCdp(args, env, timeout = 30_000) {
  const child = spawnSync(process.execPath, [cdpPath, ...args], {
    cwd: rootDir,
    env,
    encoding: 'utf8',
    timeout,
  });
  if (child.error) {
    throw new Error(`${args[0]} process failed: ${child.error.message}`, { cause: child.error });
  }
  if (child.status !== 0) {
    const detail = (child.stderr.trim() || child.stdout.trim() || `exit ${child.status}`).slice(-4096);
    throw new Error(`${args[0]} failed: ${detail}`);
  }
  return child.stdout.trim();
}

export async function waitForTarget({
  browser, diagnostics, port, url, env, excludedTargetId = null, isCancelled = () => false,
}) {
  let lastError = 'browser did not become reachable';
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (isCancelled()) throw new Error('target discovery cancelled');
    if (diagnostics.error()) throw new Error(`disposable browser launch failed: ${diagnostics.error().message}`);
    if (browser.exitCode !== null || browser.signalCode !== null) {
      const detail = diagnostics.stderr().trim();
      throw new Error(`disposable browser exited ${browser.exitCode ?? browser.signalCode}${detail ? `: ${detail}` : ''}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) });
      if (!response.ok) throw new Error(`CDP version endpoint returned ${response.status}`);
      const model = parseJson('list', spawnCdp(['list', '--format', 'json'], env, 5_000));
      const observation = assertLiveBoundary(model, url);
      const page = model.pages.find(entry => entry?.url === url && entry?.targetId !== excludedTargetId);
      if (!page || page.title !== EXPECTED_TITLE || !page.targetId) throw new Error('disposable page is not ready');
      return { ...observation, page, targetId: page.targetId, targetPrefix: page.targetPrefix };
    } catch (error) {
      lastError = error.message;
      await delay(150);
    }
  }
  throw new Error(`CDP_REACHABILITY: ${lastError}`);
}

function pageCandidate(page, browser, revision) {
  return {
    resource: {
      schema: 'chrome-cdp-ex.resource-ref.v1',
      kind: 'page',
      id: `page-${page.targetId}`,
      revision,
      capabilities: ['execute', 'perceive'],
      links: [{ relation: 'browser', ...browser }],
    },
    targetId: page.targetId,
    aliases: [],
    url: page.url,
    current: true,
    browser,
  };
}

export async function runDisposablePhase5Supervisor() {
  if (!existsSync(cdpPath) || !existsSync(pagePath)) throw new Error('Phase 5 validation fixtures are missing');
  const candidate = discoverBrowserCandidates()[0];
  if (!candidate) throw new Error('no Chrome for Testing browser binary found');
  const [browserPath, browserName] = candidate;

  return withLiveBenchmarkLock({
    name: 'validation-phase5-supervisor',
    portStart: 9364,
    serverPortStart: 41768,
    browser: browserName,
    profilePrefix: 'chrome-cdp-ex-validation-phase5',
  }, async run => {
    const { port, serverPort, profileDir } = run.metadata;
    const url = `http://127.0.0.1:${serverPort}/validation-phase5.html`;
    const runtimeDir = mkdtempSync('/tmp/chrome-cdp-p5-');
    const daemonRuntimeDir = resolve(runtimeDir, 'cdp');
    const env = {
      ...process.env,
      CDP_PORT: String(port),
      NODE_ENV: 'production',
      XDG_RUNTIME_DIR: runtimeDir,
    };
    const previousPort = process.env.CDP_PORT;
    const previousRuntimeDir = process.env.XDG_RUNTIME_DIR;
    process.env.CDP_PORT = String(port);
    process.env.XDG_RUNTIME_DIR = runtimeDir;

    const server = createServer((request, response) => {
      if (request.url === '/validation-phase5.html') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(readFileSync(pagePath));
        return;
      }
      response.writeHead(404);
      response.end('not found');
    });
    let browser = null;
    let diagnostics = null;
    let supervisor = null;
    let current = null;
    let cleaning = null;
    let cleanupAttempted = false;
    const targetIds = new Set();
    const revisions = new Map();
    let nextRevision = 1;

    const cleanup = () => {
      cleanupAttempted = true;
      cleaning ||= cleanupPhase5Resources({
        supervisor,
        targetIds,
        discoverTargetIds: async () => {
          if (!browser || browser.exitCode !== null || browser.signalCode !== null) return [];
          const model = parseJson('cleanup list', spawnCdp(['list', '--format', 'json'], env, 250));
          return model.pages
            .filter(page => page?.url === url && typeof page?.targetId === 'string')
            .map(page => page.targetId);
        },
        stopTarget: async targetId => {
          const output = spawnCdp(['stop', targetId, '--format', 'json'], env, 500);
          const model = parseJson('cleanup stop', output);
          if (model?.schema !== 'chrome-cdp-ex.stop.v1'
            || !Array.isArray(model.failedTargets)
            || model.failedTargets.length !== 0
            || (model.stopped !== true && model.noop !== true)) {
            throw new Error('cleanup stop receipt is invalid');
          }
          await assertDaemonEndpointUnavailable(daemonEndpointForPlatform(targetId, {
            runtimeDir: daemonRuntimeDir,
          }));
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
        },
        timeoutMs: 500,
        browserTimeoutMs: 1_500,
      });
      return cleaning;
    };
    const onSignal = signal => { cleanup().finally(() => process.exit(signal === 'SIGTERM' ? 143 : 130)); };
    process.once('SIGTERM', onSignal);
    process.once('SIGINT', onSignal);

    let output;
    let primaryError = null;
    try {
      await new Promise((resolveListen, reject) => {
        server.once('error', reject);
        server.listen(serverPort, '127.0.0.1', resolveListen);
      });
      browser = spawn(browserPath, buildDisposableBrowserArgs({ port, profileDir, url }), {
        detached: false,
        env: { ...process.env, HOME: userInfo().homedir },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      diagnostics = monitorBrowser(browser);

      const { createMcpRequestHandler } = await import('../skills/chrome-cdp-ex/scripts/mcp-server.mjs');
      const sent = [];
      const mcpHandler = createMcpRequestHandler({ sendMessage: message => sent.push(message) });
      const directTool = async (name, args) => {
        sent.length = 0;
        await mcpHandler({
          jsonrpc: '2.0', id: 1, method: 'tools/call',
          params: { name, arguments: args },
        });
        const response = sent[0];
        if (response?.error) throw new Error(response.error.message);
        if (response?.result?.isError) throw new Error(response.result.content?.[0]?.text || `${name} failed`);
        const text = response?.result?.content?.[0]?.text;
        if (typeof text !== 'string') throw new Error(`${name} returned no text content`);
        return text;
      };

      const browserIdentity = {
        kind: 'browser', id: 'browser-phase5', revision: 1,
      };
      const discoverCandidates = async () => {
        const model = parseJson('list', spawnCdp(['list', '--format', 'json'], env, 5_000));
        const pages = model.pages.filter(page => page?.url === url && page?.targetId);
        return pages.map(page => {
          if (!revisions.has(page.targetId)) revisions.set(page.targetId, nextRevision++);
          return pageCandidate(page, browserIdentity, revisions.get(page.targetId));
        });
      };
      supervisor = createBrowserSupervisor({
        discover: discoverCandidates,
        endpointFor: targetId => `runtime:${targetId}`,
        open: async (targetId, endpoint) => ({ targetId, endpoint }),
        inspect: async connection => ({ boundTargetId: connection.targetId, endpoint: connection.endpoint }),
        request: async (connection, request) => directTool(request.name, {
          ...request.args,
          target: connection.targetId,
        }),
        stop: async targetId => { spawnCdp(['stop', targetId], env, 5_000); },
      });

      const session = await runPhase5SupervisorSession({
        expectedTitle: EXPECTED_TITLE,
        expectedUrl: url,
        discover: async () => {
          current = await waitForTarget({ browser, diagnostics, port, url, env });
          targetIds.add(current.targetId);
          return current;
        },
        resolve: async () => supervisor.resolve(createLocatorPlan({
          schema: 'chrome-cdp-ex.locator-plan.v1',
          strategy: 'url',
          value: url,
          scope: browserIdentity,
          fallbacks: [],
        })),
        connect: async handle => {
          if (handle.resource().id !== `page-${current.targetId}`) {
            throw new Error('resolved handle did not bind the discovered page');
          }
        },
        executeCli: async () => spawnCdp(['perceive', current.targetId, '--format', 'json'], env),
        executeMcp: async handle => {
          const mcpOutput = await supervisor.execute(handle, {
            name: 'perceive', args: { adaptive: false },
          });
          return mcpOutput;
        },
        stopDaemon: async () => {
          const endpoint = daemonEndpointForPlatform(current.targetId, { runtimeDir: daemonRuntimeDir });
          if (process.platform !== 'win32' && !existsSync(endpoint)) {
            throw new Error('daemon endpoint was absent immediately before stop');
          }
          const receipt = spawnCdp(['stop', current.targetId, '--format', 'json'], env, 5_000);
          if (process.platform !== 'win32' && existsSync(endpoint)) {
            throw new Error('daemon endpoint remained after stop');
          }
          return receipt;
        },
        restart: async handle => {
          const restartedOutput = await supervisor.execute(handle, {
            name: 'perceive', args: { adaptive: false },
          });
          const stopReceipt = spawnCdp(
            ['stop', current.targetId, '--format', 'json'], env, 5_000,
          );
          return { output: restartedOutput, stopReceipt };
        },
        replaceTarget: async () => {
          const oldTargetId = current.targetId;
          spawnCdp(['closetab', oldTargetId, '--format', 'json'], env);
          const opened = parseJson('open', spawnCdp([
            'open', url, '--attach-timeout-ms', '30000', '--ready-timeout-ms', '5000', '--format', 'json',
          ], env, 45_000));
          if (typeof opened.targetId === 'string' && opened.targetId) targetIds.add(opened.targetId);
          current = await waitForTarget({
            browser, diagnostics, port, url, env, excludedTargetId: oldTargetId,
          });
          targetIds.add(current.targetId);
          return current;
        },
        rebind: async handle => {
          const output = await supervisor.execute(handle, {
            name: 'perceive', args: { adaptive: false },
          });
          const action = await supervisor.execute(handle, {
            name: 'click', args: { selector: '#close-modal', confirm: true },
          });
          return { handle, resource: handle.resource(), action, output };
        },
        report: async () => spawnCdp(['report', current.targetId, '--format', 'json'], env),
        cleanup,
      });
      output = `Phase 5 supervisor OK: ${browserName}, revision ${session.beforeRevision}->${session.afterRevision}, ${session.reportActions} action(s)`;
    } catch (error) {
      primaryError = error;
    } finally {
      process.off('SIGTERM', onSignal);
      process.off('SIGINT', onSignal);
      if (!cleanupAttempted) {
        try {
          await cleanup();
        } catch (cleanupError) {
          primaryError = primaryError
            ? new AggregateError([primaryError, cleanupError], primaryError.message)
            : cleanupError;
        }
      }
    }
    if (primaryError) throw primaryError;
    return output;
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  runDisposablePhase5Supervisor().then(output => {
    console.log(output);
  }).catch(error => {
    console.error(`Phase 5 supervisor failed: ${error.message}`);
    process.exitCode = 1;
  });
}
