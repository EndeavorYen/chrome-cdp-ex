import { describe, expect, it, vi } from 'vitest';

import {
  assertRuntimeV3Evidence,
  createRuntimeV3Cancellation,
  proveRuntimeV3InjectedFailures,
  runIsolatedValidationScript,
  runRuntimeV3EvidenceSession,
} from '../scripts/validation-phase7-runtime-v3.mjs';

const PHASE4 = 'Phase 4 core slices OK: chrome-for-testing, 69 commands, 56 MCP extraction parities, click changed';
const PHASE5 = 'Phase 5 supervisor OK: chrome-for-testing, revision 1->2, 1 action(s)';

function proof(overrides = {}) {
  return {
    phase4: PHASE4,
    phase5: PHASE5,
    boundaries: {
      schema: 'chrome-cdp-ex.phase6-boundaries.v1',
      denials: 5,
      audit: { kind: 'raw-audit', method: 'DOM.getDocument', sideEffectClass: 'read-only' },
      staleRecovery: true,
      timeoutIdentity: true,
      transportIdentity: true,
      primaryCleanupIdentity: true,
    },
    failures: {
      schema: 'chrome-cdp-ex.runtime-v3-failures.v1',
      failClosed: 9,
      aliasExecutions: 1,
      applicationExecutions: 1,
      deniedExecutions: 0,
      signalCodes: [130, 143],
      inventory: { commands: 81, application: 68, adapters: 13, daemonGroups: 5, deletions: 0 },
    },
    ...overrides,
  };
}

describe('Phase 7 Runtime v3 final evidence', () => {
  it('accepts exact all-route, supervisor, domain, failure, and inventory proof', () => {
    expect(assertRuntimeV3Evidence(proof())).toEqual({
      commands: 69,
      mcpParities: 56,
      recovery: '1->2',
      denials: 5,
      failClosed: 9,
      applicationCommands: 68,
    });
  });

  it.each([
    ['phase4', PHASE4.replace('69 commands', '68 commands')],
    ['phase5', PHASE5.replace('revision 1->2', 'revision 1->1')],
    ['boundaries', { ...proof().boundaries, denials: 4 }],
    ['failures', { ...proof().failures, failClosed: 8 }],
    ['failures', { ...proof().failures, inventory: { ...proof().failures.inventory, deletions: 1 } }],
  ])('rejects incomplete %s evidence', (key, value) => {
    expect(() => assertRuntimeV3Evidence(proof({ [key]: value }))).toThrow();
  });

  it('executes the exact injected failure routine used by live evidence', async () => {
    await expect(proveRuntimeV3InjectedFailures()).resolves.toEqual(proof().failures);
  }, 15_000);

  it('runs accepted live routes in a bounded isolated process instead of sharing runtime cache', async () => {
    await expect(runIsolatedValidationScript('scripts/check-docs-contract.mjs', {
      timeoutMs: 5_000,
    })).resolves.toContain('Docs contract OK: 20 survivor commands on the card (81 catalog)');
    await expect(runIsolatedValidationScript('validation/fixtures/controlled-failure.mjs', {
      timeoutMs: 5_000,
    })).rejects.toThrow(/exited 23/);
  });

  it('runs fail-closed injections before live effects and loads domain proof after task-local runtimes', async () => {
    const order = [];
    const steps = {
      proveBoundaries: vi.fn(async () => { order.push('boundaries'); return proof().boundaries; }),
      proveFailures: vi.fn(async () => { order.push('failures'); return proof().failures; }),
      runPhase4: vi.fn(async () => { order.push('phase4'); return PHASE4; }),
      runPhase5: vi.fn(async () => { order.push('phase5'); return PHASE5; }),
    };
    await expect(runRuntimeV3EvidenceSession(steps)).resolves.toEqual(assertRuntimeV3Evidence(proof()));
    expect(order).toEqual(['failures', 'phase4', 'phase5', 'boundaries']);
  });

  it('fails without running later live effects when a prior boundary fails', async () => {
    const sentinel = new Error('boundary failed');
    const steps = {
      proveBoundaries: vi.fn(),
      proveFailures: vi.fn(async () => { throw sentinel; }),
      runPhase4: vi.fn(),
      runPhase5: vi.fn(),
    };
    await expect(runRuntimeV3EvidenceSession(steps)).rejects.toBe(sentinel);
    expect(steps.proveFailures).toHaveBeenCalledOnce();
    expect(steps.runPhase4).not.toHaveBeenCalled();
    expect(steps.runPhase5).not.toHaveBeenCalled();
    expect(steps.proveBoundaries).not.toHaveBeenCalled();
  });

  it('sets cancellation before cleanup and reports exact signal identity', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const cleanup = vi.fn(async () => gate);
    const exit = vi.fn();
    const cancellation = createRuntimeV3Cancellation({ cleanup, exit });
    const signal = cancellation.onSignal('SIGTERM');
    expect(cancellation.isCancelled()).toBe(true);
    expect(() => cancellation.ensureActive()).toThrow(/cancelled/);
    expect(exit).not.toHaveBeenCalled();
    release();
    await signal;
    expect(cleanup).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(143);
  });
});
