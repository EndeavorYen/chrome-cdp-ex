#!/usr/bin/env node

import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import { buildRuntimeDispatchInventory } from './runtime-dispatch-inventory.mjs';
import {
  commandResult,
  createCommandRegistry,
  defineCommandSpec,
} from '../skills/chrome-cdp-ex/scripts/lib/command-application.mjs';
import { createCommandDispatcher } from '../skills/chrome-cdp-ex/scripts/lib/command-dispatch.mjs';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const sourcePath = resolve(rootDir, 'skills/chrome-cdp-ex/scripts/cdp.mjs');
const packageVersion = JSON.parse(readFileSync(resolve(rootDir, 'package.json'), 'utf8')).version;
const inventoryPath = resolve(rootDir, `docs/contracts/v${packageVersion}/runtime-dispatch.v1.json`);

const EXPECTED_FAILURE_PROOF = Object.freeze({
  schema: 'chrome-cdp-ex.runtime-v3-failures.v1',
  failClosed: 9,
  aliasExecutions: 1,
  applicationExecutions: 1,
  deniedExecutions: 0,
  signalCodes: Object.freeze([130, 143]),
  inventory: Object.freeze({
    commands: 81,
    application: 68,
    adapters: 13,
    daemonGroups: 5,
    deletions: 0,
  }),
});

const EXPECTED_BOUNDARIES = Object.freeze({
  schema: 'chrome-cdp-ex.phase6-boundaries.v1',
  denials: 5,
  audit: Object.freeze({
    kind: 'raw-audit', method: 'DOM.getDocument', sideEffectClass: 'read-only',
  }),
  staleRecovery: true,
  timeoutIdentity: true,
  transportIdentity: true,
  primaryCleanupIdentity: true,
});

function exact(value, expected) {
  return JSON.stringify(value) === JSON.stringify(expected);
}

export function runIsolatedValidationScript(entrypoint, {
  timeoutMs,
  maxOutputBytes = 262_144,
  spawnChild = spawn,
} = {}) {
  if (typeof entrypoint !== 'string' || !entrypoint || entrypoint.startsWith('/') || entrypoint.includes('..')) {
    throw new Error('isolated validation entrypoint must be repository-relative');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error('isolated validation timeoutMs is required');
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1024) throw new Error('isolated validation maxOutputBytes is invalid');
  return new Promise((resolveRun, rejectRun) => {
    const child = spawnChild(process.execPath, [resolve(rootDir, entrypoint)], {
      cwd: rootDir,
      env: process.env,
      shell: false,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let failure = null;
    let cancelled = null;
    let forceTimer = null;
    const append = (current, chunk, label) => {
      const next = Buffer.concat([current, Buffer.from(chunk)]);
      if (next.length > maxOutputBytes) {
        failure ||= new Error(`${entrypoint} exceeded ${label} output bound`);
        child.kill('SIGTERM');
        return next.subarray(0, maxOutputBytes);
      }
      return next;
    };
    child.stdout?.on('data', chunk => { stdout = append(stdout, chunk, 'stdout'); });
    child.stderr?.on('data', chunk => { stderr = append(stderr, chunk, 'stderr'); });
    const onSignal = signal => {
      cancelled = signal;
      child.kill(signal);
      forceTimer ||= setTimeout(() => child.kill('SIGKILL'), 5_000);
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    const timer = setTimeout(() => {
      failure ||= new Error(`${entrypoint} timed out after ${timeoutMs}ms`);
      child.kill('SIGTERM');
      forceTimer ||= setTimeout(() => child.kill('SIGKILL'), 5_000);
    }, timeoutMs);
    const finish = () => {
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    };
    child.once('error', error => {
      finish();
      rejectRun(error);
    });
    child.once('close', (code, signal) => {
      finish();
      const out = stdout.toString('utf8').trim();
      const err = stderr.toString('utf8').trim();
      if (cancelled) {
        process.exitCode = cancelled === 'SIGTERM' ? 143 : 130;
        rejectRun(new Error(`${entrypoint} cancelled by ${cancelled}`));
        return;
      }
      if (failure) {
        rejectRun(failure);
        return;
      }
      if (code !== 0) {
        rejectRun(new Error(`${entrypoint} exited ${code ?? signal}: ${err || out || 'no output'}`));
        return;
      }
      if (err) {
        rejectRun(new Error(`${entrypoint} wrote unexpected stderr: ${err}`));
        return;
      }
      resolveRun(out);
    });
  });
}

function readSpec(name, aliases = []) {
  return defineCommandSpec({
    name, aliases, needsTarget: true, mutates: false, feedbackPolicy: null,
    outputFormats: ['text'], kind: 'read', authorization: 'standard', evidencePolicy: 'none',
  });
}

function mutationSpec(name) {
  return defineCommandSpec({
    name, aliases: [], needsTarget: true, mutates: true, feedbackPolicy: 'auto',
    outputFormats: ['text'], kind: 'mutation', authorization: 'mutation', evidencePolicy: 'action-receipt',
  });
}

function compositeSpec(name) {
  return defineCommandSpec({
    name, aliases: [], needsTarget: true, mutates: false, feedbackPolicy: null,
    outputFormats: ['text'], kind: 'composite', authorization: 'composite', evidencePolicy: 'none',
  });
}

function adapterSpec(name) {
  return defineCommandSpec({
    name, aliases: [], needsTarget: false, mutates: false, feedbackPolicy: null,
    outputFormats: ['text'], kind: 'read', authorization: 'standard', evidencePolicy: 'none',
  });
}

function assertRejected(label, action) {
  try {
    action();
  } catch {
    return;
  }
  throw new Error(`${label} did not fail closed`);
}

async function assertRejectedAsync(label, action) {
  try {
    await action();
  } catch {
    return;
  }
  throw new Error(`${label} did not fail closed`);
}

export function createRuntimeV3Cancellation({ cleanup, exit } = {}) {
  if (typeof cleanup !== 'function') throw new Error('runtimeV3 cancellation cleanup is required');
  if (typeof exit !== 'function') throw new Error('runtimeV3 cancellation exit is required');
  let cancelled = false;
  return Object.freeze({
    isCancelled: () => cancelled,
    ensureActive() {
      if (cancelled) throw new Error('Runtime v3 evidence cancelled');
    },
    async onSignal(signal) {
      cancelled = true;
      try {
        await cleanup();
      } finally {
        exit(signal === 'SIGTERM' ? 143 : 130);
      }
    },
  });
}

async function proveSignal(signal, expectedCode) {
  const codes = [];
  let cleanups = 0;
  const cancellation = createRuntimeV3Cancellation({
    cleanup: async () => { cleanups += 1; },
    exit: code => { codes.push(code); },
  });
  await cancellation.onSignal(signal);
  if (!cancellation.isCancelled() || cleanups !== 1 || codes.length !== 1 || codes[0] !== expectedCode) {
    throw new Error(`${signal} cleanup/exit identity was invalid`);
  }
  return codes[0];
}

export async function proveRuntimeV3InjectedFailures() {
  let failClosed = 0;
  let applicationExecutions = 0;
  let deniedExecutions = 0;
  const registry = createCommandRegistry([
    adapterSpec('help'),
    readSpec('observe', ['see']),
    mutationSpec('mutate'),
    compositeSpec('workflow'),
    readSpec('malformed'),
  ]);
  const observe = async () => {
    applicationExecutions += 1;
    return commandResult('observed', null);
  };
  const mutate = async () => {
    deniedExecutions += 1;
    return commandResult('mutated', { kind: 'action-receipt', action: 'mutate', outcome: 'changed' });
  };
  let dispatcher;
  const handlers = {
    observe,
    mutate,
    workflow: async () => {
      await dispatcher.execute({ name: 'mutate', args: [], targetBound: true });
      return commandResult('workflow', null);
    },
    malformed: async () => ({ value: 'not-branded', evidence: null }),
  };
  const owners = {
    help: 'adapter', observe: 'application', mutate: 'application',
    workflow: 'application', malformed: 'application',
  };
  const authorize = async ({ spec, request }) => {
    if (!request.targetBound) return { allowed: false, code: 'target-not-bound' };
    if (spec.name === 'mutate') return { allowed: false, code: 'runtime-v3-denied' };
    return { allowed: true, code: 'runtime-v3-approved' };
  };

  assertRejected('missing handler', () => createCommandDispatcher({
    registry, owners, handlers: { ...handlers, malformed: undefined }, authorize,
  }));
  failClosed += 1;
  assertRejected('extra handler', () => createCommandDispatcher({
    registry, owners, handlers: { ...handlers, planted: observe }, authorize,
  }));
  failClosed += 1;
  dispatcher = createCommandDispatcher({ registry, owners, handlers, authorize });

  await dispatcher.execute({ name: 'see', args: [], targetBound: true });
  const aliasExecutions = applicationExecutions;
  await assertRejectedAsync('unknown command', () => dispatcher.execute({
    name: 'unknown', args: [], targetBound: true,
  }));
  failClosed += 1;
  await assertRejectedAsync('wrong target', () => dispatcher.execute({
    name: 'observe', args: [], targetBound: false,
  }));
  failClosed += 1;
  await assertRejectedAsync('authorization denial', () => dispatcher.execute({
    name: 'mutate', args: [], targetBound: true,
  }));
  failClosed += 1;
  await assertRejectedAsync('nested policy bypass', () => dispatcher.execute({
    name: 'workflow', args: [], targetBound: true,
  }));
  failClosed += 1;
  await assertRejectedAsync('malformed output', () => dispatcher.execute({
    name: 'malformed', args: [], targetBound: true,
  }));
  failClosed += 1;

  const signalCodes = [
    await proveSignal('SIGINT', 130),
    await proveSignal('SIGTERM', 143),
  ];
  failClosed += 2;

  const source = readFileSync(sourcePath, 'utf8');
  const fixture = JSON.parse(readFileSync(inventoryPath, 'utf8'));
  const actualInventory = buildRuntimeDispatchInventory(source);
  if (!exact(actualInventory, fixture)) throw new Error('runtime dispatch inventory is stale');
  const inventory = {
    commands: actualInventory.counts.commands,
    application: actualInventory.counts.applicationCommands,
    adapters: actualInventory.counts.targetlessCommands,
    daemonGroups: actualInventory.counts.daemonGroups,
    deletions: actualInventory.deletionAllowlist.length,
  };
  const proof = {
    schema: EXPECTED_FAILURE_PROOF.schema,
    failClosed,
    aliasExecutions,
    applicationExecutions,
    deniedExecutions,
    signalCodes,
    inventory,
  };
  if (!exact(proof, EXPECTED_FAILURE_PROOF)) throw new Error('Runtime v3 injected failure proof is incomplete');
  return proof;
}

export function assertRuntimeV3Evidence(proof) {
  if (!proof || typeof proof !== 'object') throw new Error('Runtime v3 proof is required');
  const phase4 = /^Phase 4 core slices OK: [^,]+, (\d+) commands, (\d+) MCP extraction parities, click changed$/.exec(proof.phase4 || '');
  if (!phase4 || Number(phase4[1]) !== 69 || Number(phase4[2]) !== 56) {
    throw new Error('Phase 4 all-route proof is incomplete');
  }
  const phase5 = /^Phase 5 supervisor OK: [^,]+, revision (\d+)->(\d+), (\d+) action\(s\)$/.exec(proof.phase5 || '');
  if (!phase5 || phase5[1] !== '1' || phase5[2] !== '2' || Number(phase5[3]) < 1) {
    throw new Error('Phase 5 supervisor proof is incomplete');
  }
  if (!exact(proof.boundaries, EXPECTED_BOUNDARIES)) throw new Error('Runtime v3 domain boundary proof is incomplete');
  if (!exact(proof.failures, EXPECTED_FAILURE_PROOF)) throw new Error('Runtime v3 failure proof is incomplete');
  return Object.freeze({
    commands: Number(phase4[1]),
    mcpParities: Number(phase4[2]),
    recovery: `${phase5[1]}->${phase5[2]}`,
    denials: proof.boundaries.denials,
    failClosed: proof.failures.failClosed,
    applicationCommands: proof.failures.inventory.application,
  });
}

export async function runRuntimeV3EvidenceSession(steps = {}) {
  for (const name of ['proveBoundaries', 'proveFailures', 'runPhase4', 'runPhase5']) {
    if (typeof steps[name] !== 'function') throw new Error(`Runtime v3 ${name} step is required`);
  }
  const failures = await steps.proveFailures();
  const phase4 = await steps.runPhase4();
  const phase5 = await steps.runPhase5();
  const boundaries = await steps.proveBoundaries();
  return assertRuntimeV3Evidence({ phase4, phase5, boundaries, failures });
}

export async function runDisposableRuntimeV3Evidence() {
  return runRuntimeV3EvidenceSession({
    proveBoundaries: async () => {
      const { provePhase6InjectedBoundaries } = await import('./validation-phase6-convergence.mjs');
      return provePhase6InjectedBoundaries();
    },
    proveFailures: proveRuntimeV3InjectedFailures,
    runPhase4: () => runIsolatedValidationScript('scripts/validation-phase4-slices.mjs', {
      timeoutMs: 240_000,
    }),
    runPhase5: () => runIsolatedValidationScript('scripts/validation-phase5-supervisor.mjs', {
      timeoutMs: 300_000,
    }),
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  runDisposableRuntimeV3Evidence().then(result => {
    console.log(`Runtime v3 evidence OK: ${result.commands} commands, ${result.mcpParities} MCP parities, supervisor ${result.recovery}, ${result.denials} domain denials, ${result.failClosed} fail-closed injections`);
  }).catch(error => {
    console.error(`Runtime v3 evidence failed: ${error.message}`);
    if (process.exitCode !== 130 && process.exitCode !== 143) process.exitCode = 1;
  });
}
