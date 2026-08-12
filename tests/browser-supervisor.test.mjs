import { describe, expect, it, vi } from 'vitest';

import { createBrowserSupervisor } from '../skills/chrome-cdp-ex/scripts/lib/browser-supervisor.mjs';
import { createLocatorPlan, isResolvedHandle } from '../skills/chrome-cdp-ex/scripts/lib/browser-resources.mjs';

const browser = { kind: 'browser', id: 'browser-main', revision: 1 };
const locator = createLocatorPlan({
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
});

function locatorFor(targetId) {
  return createLocatorPlan({
    schema: 'chrome-cdp-ex.locator-plan.v1',
    strategy: 'exact-target',
    value: targetId,
    scope: browser,
    fallbacks: [],
  });
}

function candidate(targetId = 'TARGET-OLD', revision = 1) {
  return {
    resource: {
      schema: 'chrome-cdp-ex.resource-ref.v1',
      kind: 'page',
      id: `page-${targetId.toLowerCase()}`,
      revision,
      capabilities: ['perceive'],
      links: [{ relation: 'browser', ...browser }],
    },
    targetId,
    aliases: ['app'],
    url: 'http://127.0.0.1:4173/',
    current: true,
    browser,
  };
}

function fixture(overrides = {}) {
  let discovered = [candidate()];
  const deps = {
    discover: vi.fn(async () => discovered),
    endpointFor: vi.fn(targetId => `/runtime/cdp-${targetId}.sock`),
    open: vi.fn(async (targetId, endpoint) => ({ targetId, endpoint })),
    inspect: vi.fn(async connection => ({
      boundTargetId: connection.targetId,
      endpoint: connection.endpoint,
    })),
    request: vi.fn(async (_connection, request) => ({ ok: true, result: request.cmd })),
    stop: vi.fn(async () => {}),
    ...overrides,
  };
  return {
    deps,
    supervisor: createBrowserSupervisor(deps),
    setDiscovered(next) { discovered = next; },
  };
}

describe('BrowserSupervisor over the existing per-tab runtime', () => {
  it('resolves a private handle and executes through one inspected connection', async () => {
    const { supervisor, deps } = fixture();
    const handle = await supervisor.resolve(locator);
    expect(isResolvedHandle(handle)).toBe(true);
    await expect(supervisor.execute(handle, { cmd: 'report', args: [] }))
      .resolves.toEqual({ ok: true, result: 'report' });
    expect(deps.open).toHaveBeenCalledOnce();
    expect(deps.inspect).toHaveBeenCalledOnce();
    expect(deps.request).toHaveBeenCalledOnce();
  });

  it('coalesces concurrent same-target opens without sharing different targets', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const open = vi.fn(async (targetId, endpoint) => {
      await gate;
      return { targetId, endpoint };
    });
    const { supervisor } = fixture({ open });
    const handle = await supervisor.resolve(locator);
    const first = supervisor.execute(handle, { cmd: 'report', args: [] });
    const second = supervisor.execute(handle, { cmd: 'perceive', args: [] });
    await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
    release();
    await Promise.all([first, second]);
    expect(open).toHaveBeenCalledOnce();
  });

  it('recovers one stale target through the locator fallback and stops the old runtime', async () => {
    const state = fixture();
    const handle = await state.supervisor.resolve(locator);
    state.setDiscovered([candidate('TARGET-NEW', 2)]);
    await expect(state.supervisor.execute(handle, { cmd: 'report', args: [] }))
      .resolves.toMatchObject({ ok: true });
    expect(handle.resource().revision).toBe(2);
    expect(state.deps.stop).toHaveBeenCalledWith('TARGET-OLD', '/runtime/cdp-TARGET-OLD.sock', undefined);
    expect(state.deps.open).toHaveBeenCalledWith('TARGET-NEW', '/runtime/cdp-TARGET-NEW.sock');
  });

  it('refreshes public resource revision when the runtime binding is unchanged', async () => {
    const state = fixture();
    const handle = await state.supervisor.resolve(locator);
    const updated = candidate('TARGET-OLD', 2);
    updated.resource.capabilities = ['perceive', 'report'];
    state.setDiscovered([updated]);
    await expect(state.supervisor.execute(handle, { cmd: 'report', args: [] }))
      .resolves.toMatchObject({ ok: true });
    expect(handle.resource().revision).toBe(2);
    expect(handle.resource().capabilities).toEqual(['perceive', 'report']);
    expect(state.deps.stop).not.toHaveBeenCalled();
    expect(state.deps.open).toHaveBeenCalledOnce();
  });

  it('fails closed on same-binding resource identity drift or revision regression', async () => {
    const identityState = fixture();
    const identityHandle = await identityState.supervisor.resolve(locator);
    const changedIdentity = candidate('TARGET-OLD', 2);
    changedIdentity.resource.id = 'page-different';
    identityState.setDiscovered([changedIdentity]);
    await expect(identityState.supervisor.execute(identityHandle, { cmd: 'report', args: [] }))
      .rejects.toThrow(/resource identity drifted/);
    expect(identityState.deps.open).not.toHaveBeenCalled();

    const revisionState = fixture();
    revisionState.setDiscovered([candidate('TARGET-OLD', 2)]);
    const revisionHandle = await revisionState.supervisor.resolve(locator);
    revisionState.setDiscovered([candidate('TARGET-OLD', 1)]);
    await expect(revisionState.supervisor.execute(revisionHandle, { cmd: 'report', args: [] }))
      .rejects.toThrow(/revision regressed/);
    expect(revisionState.deps.open).not.toHaveBeenCalled();

    const capabilityState = fixture();
    const capabilityHandle = await capabilityState.supervisor.resolve(locator);
    const changedCapabilities = candidate('TARGET-OLD', 1);
    changedCapabilities.resource.capabilities = ['perceive', 'report'];
    capabilityState.setDiscovered([changedCapabilities]);
    await expect(capabilityState.supervisor.execute(capabilityHandle, { cmd: 'report', args: [] }))
      .rejects.toThrow(/without a revision advance/);
    expect(capabilityState.deps.open).not.toHaveBeenCalled();
  });

  it('fails closed on a second resolver drift for one handle', async () => {
    const state = fixture();
    const handle = await state.supervisor.resolve(locator);
    state.setDiscovered([candidate('TARGET-NEW', 2)]);
    await state.supervisor.execute(handle, { cmd: 'report', args: [] });
    state.setDiscovered([candidate('TARGET-THIRD', 3)]);
    await expect(state.supervisor.execute(handle, { cmd: 'report', args: [] }))
      .rejects.toThrow(/more than one recovery/);
  });

  it('performs at most one metadata-mismatch restart and then fails closed', async () => {
    const inspect = vi.fn(async () => ({ boundTargetId: 'WRONG', endpoint: '/runtime/cdp-TARGET-OLD.sock' }));
    const { supervisor, deps } = fixture({ inspect });
    const handle = await supervisor.resolve(locator);
    await expect(supervisor.execute(handle, { cmd: 'report', args: [] }))
      .rejects.toThrow(/target mismatch/);
    expect(deps.open).toHaveBeenCalledTimes(2);
    expect(deps.stop).toHaveBeenCalledTimes(2);
    expect(deps.request).not.toHaveBeenCalled();
  });

  it('fails closed on an unexpected inspected endpoint', async () => {
    const { supervisor, deps } = fixture({
      inspect: async connection => ({ boundTargetId: connection.targetId, endpoint: '/wrong/socket' }),
    });
    const handle = await supervisor.resolve(locator);
    await expect(supervisor.execute(handle, { cmd: 'report', args: [] }))
      .rejects.toThrow(/endpoint mismatch/);
    expect(deps.stop).not.toHaveBeenCalled();
  });

  it('makes close terminal and drains an in-flight open without allowing its request', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const state = fixture({ open: vi.fn(async (targetId, endpoint) => { await gate; return { targetId, endpoint }; }) });
    const handle = await state.supervisor.resolve(locator);
    const execution = state.supervisor.execute(handle, { cmd: 'report', args: [] });
    await vi.waitFor(() => expect(state.deps.open).toHaveBeenCalledOnce());
    const closing = state.supervisor.close();
    release();
    await closing;
    await expect(execution).rejects.toThrow(/closed/);
    expect(state.deps.request).not.toHaveBeenCalled();
    expect(state.deps.stop).toHaveBeenCalledOnce();
    await expect(state.supervisor.execute(handle, { cmd: 'report', args: [] })).rejects.toThrow(/closed/);
  });

  it('serializes stop with an in-flight open and prevents the pending request', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const state = fixture({ open: vi.fn(async (targetId, endpoint) => { await gate; return { targetId, endpoint }; }) });
    const handle = await state.supervisor.resolve(locator);
    const execution = state.supervisor.execute(handle, { cmd: 'report', args: [] });
    await vi.waitFor(() => expect(state.deps.open).toHaveBeenCalledOnce());
    const stopping = state.supervisor.stop(handle);
    release();
    await stopping;
    await expect(execution).rejects.toThrow(/stopped/);
    expect(state.deps.request).not.toHaveBeenCalled();
    expect(state.deps.stop).toHaveBeenCalledOnce();
  });

  it('surfaces non-target metadata failures without stopping the daemon', async () => {
    const original = new Error('Daemon source metadata contained target mismatch text');
    const state = fixture({ inspect: vi.fn(async () => { throw original; }) });
    const handle = await state.supervisor.resolve(locator);
    await expect(state.supervisor.execute(handle, { cmd: 'report', args: [] })).rejects.toBe(original);
    expect(state.deps.open).toHaveBeenCalledOnce();
    expect(state.deps.stop).not.toHaveBeenCalled();
  });

  it('prevents a close during refresh from opening or requesting a recovered runtime', async () => {
    let releaseRefresh;
    const refreshGate = new Promise(resolve => { releaseRefresh = resolve; });
    const discover = vi.fn()
      .mockResolvedValueOnce([candidate()])
      .mockImplementation(async () => {
        await refreshGate;
        return [candidate('TARGET-NEW', 2)];
      });
    const state = fixture({ discover });
    const handle = await state.supervisor.resolve(locator);
    const execution = state.supervisor.execute(handle, { cmd: 'report', args: [] });
    await vi.waitFor(() => expect(discover).toHaveBeenCalledTimes(2));
    const closing = state.supervisor.close();
    releaseRefresh();
    await closing;
    await expect(execution).rejects.toThrow(/closed/);
    expect(state.deps.open).not.toHaveBeenCalled();
    expect(state.deps.request).not.toHaveBeenCalled();
    expect(state.deps.stop).not.toHaveBeenCalled();
  });

  it('prevents a stop during refresh from opening and cleans both old and recovered identities', async () => {
    let releaseRefresh;
    const refreshGate = new Promise(resolve => { releaseRefresh = resolve; });
    const discover = vi.fn()
      .mockResolvedValueOnce([candidate()])
      .mockImplementation(async () => {
        await refreshGate;
        return [candidate('TARGET-NEW', 2)];
      });
    const state = fixture({ discover });
    const handle = await state.supervisor.resolve(locator);
    const execution = state.supervisor.execute(handle, { cmd: 'report', args: [] });
    await vi.waitFor(() => expect(discover).toHaveBeenCalledTimes(2));
    const stopping = state.supervisor.stop(handle);
    releaseRefresh();
    await stopping;
    await expect(execution).rejects.toThrow(/stopped/);
    expect(state.deps.open).not.toHaveBeenCalled();
    expect(state.deps.request).not.toHaveBeenCalled();
    expect(state.deps.stop).toHaveBeenCalledWith('TARGET-OLD', '/runtime/cdp-TARGET-OLD.sock', undefined);
    expect(state.deps.stop).toHaveBeenCalledTimes(1);
  });

  it('keeps unrelated targets independent when one handle stops during another open', async () => {
    let releaseB;
    const gateB = new Promise(resolve => { releaseB = resolve; });
    const discovered = [candidate('TARGET-A'), candidate('TARGET-B', 2)];
    const state = fixture({
      discover: vi.fn(async () => discovered),
      open: vi.fn(async (targetId, endpoint) => {
        if (targetId === 'TARGET-B') await gateB;
        return { targetId, endpoint };
      }),
    });
    const handleA = await state.supervisor.resolve(locatorFor('TARGET-A'));
    const handleB = await state.supervisor.resolve(locatorFor('TARGET-B'));
    const executionB = state.supervisor.execute(handleB, { cmd: 'report', args: [] });
    await vi.waitFor(() => expect(state.deps.open).toHaveBeenCalledWith('TARGET-B', '/runtime/cdp-TARGET-B.sock'));
    await state.supervisor.stop(handleA);
    releaseB();
    await expect(executionB).resolves.toMatchObject({ ok: true });
    expect(state.deps.request).toHaveBeenCalledOnce();
    expect(state.deps.stop).not.toHaveBeenCalledWith('TARGET-B', expect.anything(), expect.anything());
  });

  it('single-flights concurrent stale recovery and reserves the one recovery atomically', async () => {
    let releaseRefresh;
    const refreshGate = new Promise(resolve => { releaseRefresh = resolve; });
    const discover = vi.fn()
      .mockResolvedValueOnce([candidate()])
      .mockImplementation(async () => {
        await refreshGate;
        return [candidate('TARGET-NEW', 2)];
      });
    const state = fixture({ discover });
    const handle = await state.supervisor.resolve(locator);
    const first = state.supervisor.execute(handle, { cmd: 'report', args: [] });
    const second = state.supervisor.execute(handle, { cmd: 'perceive', args: [] });
    await vi.waitFor(() => expect(discover).toHaveBeenCalledTimes(2));
    releaseRefresh();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(discover).toHaveBeenCalledTimes(3);
    expect(state.deps.stop).toHaveBeenCalledTimes(1);
    expect(state.deps.open).toHaveBeenCalledTimes(1);
    expect(state.deps.request).toHaveBeenCalledTimes(2);
    expect(handle.resource().revision).toBe(2);
  });

  it('retains failed stop authority so cleanup can be retried while execution stays blocked', async () => {
    const stopError = new Error('first stop failed');
    const stop = vi.fn().mockRejectedValueOnce(stopError).mockResolvedValueOnce(undefined);
    const state = fixture({ stop });
    const handle = await state.supervisor.resolve(locator);
    await state.supervisor.execute(handle, { cmd: 'report', args: [] });
    await expect(state.supervisor.stop(handle)).rejects.toBe(stopError);
    await expect(state.supervisor.execute(handle, { cmd: 'report', args: [] })).rejects.toThrow(/stopped/);
    await expect(state.supervisor.stop(handle)).resolves.toBeUndefined();
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it('all-settles close cleanup and retries only connections whose cleanup failed', async () => {
    const failed = new Set(['TARGET-A']);
    const stop = vi.fn(async targetId => {
      if (failed.has(targetId)) throw new Error(`stop failed for ${targetId}`);
    });
    const discovered = [candidate('TARGET-A'), candidate('TARGET-B', 2)];
    const state = fixture({ discover: vi.fn(async () => discovered), stop });
    const handleA = await state.supervisor.resolve(locatorFor('TARGET-A'));
    const handleB = await state.supervisor.resolve(locatorFor('TARGET-B'));
    await state.supervisor.execute(handleA, { cmd: 'report', args: [] });
    await state.supervisor.execute(handleB, { cmd: 'report', args: [] });
    await expect(state.supervisor.close()).rejects.toThrow(AggregateError);
    expect(stop).toHaveBeenCalledWith('TARGET-A', '/runtime/cdp-TARGET-A.sock', expect.anything());
    expect(stop).toHaveBeenCalledWith('TARGET-B', '/runtime/cdp-TARGET-B.sock', expect.anything());
    failed.clear();
    await expect(state.supervisor.close()).resolves.toBeUndefined();
    expect(stop.mock.calls.filter(([targetId]) => targetId === 'TARGET-A')).toHaveLength(2);
    expect(stop.mock.calls.filter(([targetId]) => targetId === 'TARGET-B')).toHaveLength(1);
  });

  it('single-flights concurrent stop calls for one shared runtime', async () => {
    let releaseStop;
    const stopGate = new Promise(resolve => { releaseStop = resolve; });
    const stop = vi.fn(async () => { await stopGate; });
    const state = fixture({ stop });
    const handle = await state.supervisor.resolve(locator);
    await state.supervisor.execute(handle, { cmd: 'report', args: [] });
    const first = state.supervisor.stop(handle);
    const second = state.supervisor.stop(handle);
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
    releaseStop();
    await Promise.all([first, second]);
    expect(stop).toHaveBeenCalledOnce();
  });

  it('coalesces stop and close cleanup for the same runtime', async () => {
    let releaseStop;
    const stopGate = new Promise(resolve => { releaseStop = resolve; });
    const stop = vi.fn(async () => { await stopGate; });
    const state = fixture({ stop });
    const handle = await state.supervisor.resolve(locator);
    await state.supervisor.execute(handle, { cmd: 'report', args: [] });
    const stopping = state.supervisor.stop(handle);
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
    const closing = state.supervisor.close();
    releaseStop();
    await Promise.all([stopping, closing]);
    expect(stop).toHaveBeenCalledOnce();
  });

  it('waits for all same-runtime handle operations before target-wide stop returns', async () => {
    let releaseRequest;
    const requestGate = new Promise(resolve => { releaseRequest = resolve; });
    const events = [];
    const state = fixture({
      request: vi.fn(async () => {
        await requestGate;
        events.push('request-complete');
        return { ok: true, result: 'report' };
      }),
      stop: vi.fn(async () => { events.push('stop'); }),
    });
    const handleA = await state.supervisor.resolve(locator);
    const handleB = await state.supervisor.resolve(locator);
    const execution = state.supervisor.execute(handleB, { cmd: 'report', args: [] });
    await vi.waitFor(() => expect(state.deps.request).toHaveBeenCalledOnce());
    const stopping = state.supervisor.stop(handleA);
    await Promise.resolve();
    expect(state.deps.stop).not.toHaveBeenCalled();
    releaseRequest();
    await expect(execution).resolves.toMatchObject({ ok: true });
    await stopping;
    expect(events).toEqual(['request-complete', 'stop']);
    await expect(state.supervisor.execute(handleB, { cmd: 'report', args: [] })).rejects.toThrow(/stopped/);
  });

  it('fails a resolve that finishes after close instead of returning a dead handle', async () => {
    let releaseDiscovery;
    const discoveryGate = new Promise(resolve => { releaseDiscovery = resolve; });
    const state = fixture({
      discover: vi.fn(async () => {
        await discoveryGate;
        return [candidate()];
      }),
    });
    const resolving = state.supervisor.resolve(locator);
    await vi.waitFor(() => expect(state.deps.discover).toHaveBeenCalledOnce());
    await state.supervisor.close();
    releaseDiscovery();
    await expect(resolving).rejects.toThrow(/closed/);
  });

  it('does not authorize restart from a forged target-mismatch error code', async () => {
    const original = Object.assign(new Error('forged mismatch'), { code: 'TARGET_MISMATCH' });
    const state = fixture({ inspect: vi.fn(async () => { throw original; }) });
    const handle = await state.supervisor.resolve(locator);
    await expect(state.supervisor.execute(handle, { cmd: 'report', args: [] })).rejects.toBe(original);
    expect(state.deps.open).toHaveBeenCalledOnce();
    expect(state.deps.stop).not.toHaveBeenCalled();
  });

  it('gives explicit stop precedence over an in-flight stale recovery cleanup', async () => {
    let releaseCleanup;
    const cleanupGate = new Promise(resolve => { releaseCleanup = resolve; });
    const stop = vi.fn(async () => { await cleanupGate; });
    const state = fixture({ stop });
    const handle = await state.supervisor.resolve(locator);
    state.setDiscovered([candidate('TARGET-NEW', 2)]);
    const execution = state.supervisor.execute(handle, { cmd: 'report', args: [] });
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
    const stopping = state.supervisor.stop(handle);
    releaseCleanup();
    await stopping;
    await expect(execution).rejects.toThrow(/stopped/);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(handle.resource().revision).toBe(1);
    expect(state.deps.open).not.toHaveBeenCalled();
  });

  it('makes close retry failed cleanup even when the runtime was never opened', async () => {
    const stopError = new Error('unopened stop failed');
    const stop = vi.fn().mockRejectedValueOnce(stopError).mockResolvedValueOnce(undefined);
    const state = fixture({ stop });
    const handle = await state.supervisor.resolve(locator);
    await expect(state.supervisor.stop(handle)).rejects.toBe(stopError);
    await expect(state.supervisor.close()).resolves.toBeUndefined();
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it('makes close retry a failed recovery cleanup with no cached connection', async () => {
    const cleanupError = new Error('recovery cleanup failed');
    const stop = vi.fn().mockRejectedValueOnce(cleanupError).mockResolvedValueOnce(undefined);
    const state = fixture({ stop });
    const handle = await state.supervisor.resolve(locator);
    state.setDiscovered([candidate('TARGET-NEW', 2)]);
    await expect(state.supervisor.execute(handle, { cmd: 'report', args: [] })).rejects.toBe(cleanupError);
    await expect(state.supervisor.close()).resolves.toBeUndefined();
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it('propagates dead-target and ambiguity resolution failures before opening', async () => {
    const dead = fixture();
    dead.setDiscovered([]);
    await expect(dead.supervisor.resolve(locator)).rejects.toThrow(/exhausted/);
    expect(dead.deps.open).not.toHaveBeenCalled();

    const ambiguous = fixture();
    ambiguous.setDiscovered([candidate('TARGET-A'), candidate('TARGET-B', 2)]);
    await expect(ambiguous.supervisor.resolve(locator)).rejects.toThrow(/ambiguous/);
  });

  it('stops one handle and performs bounded cleanup for all opened targets', async () => {
    const { supervisor, deps } = fixture();
    const handle = await supervisor.resolve(locator);
    await supervisor.execute(handle, { cmd: 'report', args: [] });
    await supervisor.stop(handle);
    expect(deps.stop).toHaveBeenCalledWith('TARGET-OLD', '/runtime/cdp-TARGET-OLD.sock', expect.anything());
    await supervisor.close();
    expect(deps.stop).toHaveBeenCalledTimes(1);
  });

  it('rejects forged handles and accessor/prototype-backed dependencies', async () => {
    const { supervisor } = fixture();
    await expect(supervisor.execute({}, { cmd: 'report', args: [] })).rejects.toThrow(/private handle/);

    const deps = fixture().deps;
    const accessor = { ...deps };
    Object.defineProperty(accessor, 'open', { enumerable: true, get: () => deps.open });
    expect(() => createBrowserSupervisor(accessor)).toThrow(/accessor/);
    expect(() => createBrowserSupervisor(Object.assign(Object.create({ token: 'secret' }), deps)))
      .toThrow(/plain object/);
  });
});
