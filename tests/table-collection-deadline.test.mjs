import { describe, expect, it, vi } from 'vitest';
import { createCommandExecutionContext } from '../skills/chrome-cdp-ex/scripts/lib/command-application.mjs';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

describe('table collection monotonic deadline context', () => {
  it('freezes one shared 295s page, 300s server, and 5s operation budget', () => {
    let now = 1000;
    const controller = new AbortController();
    const context = T.createDaemonRequestExecutionContext({
      request: { cmd: 'table', args: ['#orders', '--collect', '--scroll-container', '.viewport'] },
      signal: controller.signal,
      now: () => now,
    });

    expect(T.TABLE_COLLECTION_DEADLINES).toEqual({
      pageMs: 295000,
      serverMs: 300000,
      maxCdpOperationMs: 5000,
    });
    expect(Object.isFrozen(T.TABLE_COLLECTION_DEADLINES)).toBe(true);
    expect(context.deadline).toMatchObject({
      startedAt: 1000,
      pageAt: 296000,
      serverAt: 301000,
      maxCdpOperationMs: 5000,
    });

    const runtime = T.createTableCollectionRuntime(context);
    expect(runtime.phase()).toBe('page');
    expect(runtime.remainingPageMs()).toBe(295000);
    expect(runtime.cdpOperationTimeoutMs()).toBe(5000);

    now = 295750;
    expect(runtime.remainingPageMs()).toBe(250);
    expect(runtime.cdpOperationTimeoutMs()).toBe(250);

    now = 296000;
    expect(runtime.phase()).toBe('finalization-only');
    expect(runtime.remainingPageMs()).toBe(0);
    expect(runtime.remainingServerMs()).toBe(5000);

    now = 301000;
    expect(runtime.phase()).toBe('expired');
    expect(runtime.remainingServerMs()).toBe(0);
  });

  it('does not allocate collection deadlines for non-collect or malformed table requests', () => {
    const signal = new AbortController().signal;
    const status = T.createDaemonRequestExecutionContext({
      request: { cmd: 'status', args: [] }, signal, now: () => 10,
    });
    const observation = T.createDaemonRequestExecutionContext({
      request: { cmd: 'table', args: ['#orders'] }, signal, now: () => 20,
    });
    expect(status.deadline).toBeNull();
    expect(observation.deadline).toBeNull();
    expect(() => T.createDaemonRequestExecutionContext({
      request: { cmd: 'table', args: ['--collect'] }, signal, now: () => 30,
    })).toThrow('table: --collect requires --scroll-container');
  });

  it('rejects an internally forged deadline context even when application validation brands it', () => {
    const forged = createCommandExecutionContext({
      signal: new AbortController().signal,
      deadline: {
        startedAt: 0,
        pageAt: 999999,
        serverAt: 1000000,
        maxCdpOperationMs: 999999,
        now: () => 0,
      },
    });
    expect(() => T.createTableCollectionRuntime(forged))
      .toThrow('table: trusted daemon request deadline context is required');
  });

  it('dynamically caps and aborts an in-flight CDP operation at the page deadline', async () => {
    vi.useFakeTimers();
    try {
      let now = 294000;
      const controller = new AbortController();
      const context = T.createDaemonRequestExecutionContext({
        request: { cmd: 'table', args: ['--collect', '--scroll-container', '.viewport'] },
        signal: controller.signal,
        now: () => now,
      });
      now = context.deadline.pageAt - 1250;
      const runtime = T.createTableCollectionRuntime(context);
      let operationSignal;
      let selectedTimeout;
      const operation = vi.fn(({ signal, timeoutMs }) => {
        operationSignal = signal;
        selectedTimeout = timeoutMs;
        return new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      });

      const promise = runtime.runCdpOperation(operation);
      const rejection = promise.catch(error => error);
      await Promise.resolve();
      expect(operation).toHaveBeenCalledOnce();
      expect(selectedTimeout).toBe(1250);
      expect(operationSignal.aborted).toBe(false);

      now = context.deadline.pageAt;
      await vi.advanceTimersByTimeAsync(1250);
      await expect(rejection).resolves.toMatchObject({
        code: 'TABLE_COLLECTION_PAGE_DEADLINE',
        phase: 'page',
      });
      expect(operationSignal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a CDP result returned at the absolute page deadline without finalizing', async () => {
    let now = 0;
    const context = T.createDaemonRequestExecutionContext({
      request: { cmd: 'table', args: ['--collect', '--scroll-container', '.viewport'] },
      signal: new AbortController().signal,
      now: () => now,
    });
    const finalize = vi.fn(async ({ termination }) => termination);
    const cleanup = vi.fn();

    const lifecycle = T.runTableCollectionLifecycle(context, {
      collect: runtime => runtime.runCdpOperation(() => {
        now = context.deadline.pageAt;
        return { termination: 'logical-count-reached', value: 'late-cdp-success' };
      }),
      finalize,
      cleanup,
    });

    await expect(lifecycle).rejects.toMatchObject({
      code: 'TABLE_COLLECTION_PAGE_DEADLINE',
      phase: 'page',
      lateInvocation: true,
    });
    expect(finalize).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('fails after a signal-ignoring page operation settles beyond 295s instead of partial-finalizing', async () => {
    let now = 0;
    let settleOperation;
    const context = T.createDaemonRequestExecutionContext({
      request: { cmd: 'table', args: ['--collect', '--scroll-container', '.viewport'] },
      signal: new AbortController().signal,
      now: () => now,
    });
    const finalize = vi.fn();
    const cleanup = vi.fn();
    const lifecycle = T.runTableCollectionLifecycle(context, {
      collect: runtime => runtime.runCdpOperation(() => new Promise(resolve => {
        settleOperation = () => {
          now = context.deadline.pageAt + 2000;
          resolve('late-page-result');
        };
      })),
      finalize,
      cleanup,
    });
    await new Promise(resolve => setImmediate(resolve));

    settleOperation();
    await expect(lifecycle).rejects.toMatchObject({
      code: 'TABLE_COLLECTION_PAGE_DEADLINE',
      phase: 'page',
    });
    expect(finalize).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('fails when the operation timer wins first but ignored raw work settles at 297s', async () => {
    vi.useFakeTimers();
    try {
      let now = 0;
      let settleOperation;
      const context = T.createDaemonRequestExecutionContext({
        request: { cmd: 'table', args: ['--collect', '--scroll-container', '.viewport'] },
        signal: new AbortController().signal,
        now: () => now,
      });
      const finalize = vi.fn(async () => 'unsafe-partial-success');
      const cleanup = vi.fn();
      const lifecycle = T.runTableCollectionLifecycle(context, {
        collect: runtime => runtime.runCdpOperation(() => new Promise(resolve => {
          settleOperation = resolve;
        })),
        finalize,
        cleanup,
      });
      await Promise.resolve();

      now = 5000;
      await vi.advanceTimersByTimeAsync(5000);
      expect(finalize).not.toHaveBeenCalled();

      now = context.deadline.pageAt + 2000;
      settleOperation('ignored-timeout-and-settled-late');
      await expect(lifecycle).rejects.toMatchObject({
        code: 'TABLE_COLLECTION_PAGE_DEADLINE',
        phase: 'page',
        lateInvocation: true,
      });
      expect(finalize).not.toHaveBeenCalled();
      expect(cleanup).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a short sleep whose delayed callback runs at the absolute page deadline', async () => {
    let now = 0;
    let wake;
    const context = T.createDaemonRequestExecutionContext({
      request: { cmd: 'table', args: ['--collect', '--scroll-container', '.viewport'] },
      signal: new AbortController().signal,
      now: () => now,
    });
    const runtime = T.createTableCollectionRuntime(context, {
      setTimer: vi.fn(callback => {
        wake = callback;
        return Symbol('sleep-timer');
      }),
      clearTimer: vi.fn(),
    });
    const outcome = runtime.sleep(10);
    now = context.deadline.pageAt;
    wake();

    await expect(outcome).rejects.toMatchObject({
      code: 'TABLE_COLLECTION_PAGE_DEADLINE',
      phase: 'page',
    });
    runtime.dispose();
  });

  it('rejects a finalizer result returned at the absolute server deadline and cleans once', async () => {
    let now = 0;
    const context = T.createDaemonRequestExecutionContext({
      request: { cmd: 'table', args: ['--collect', '--scroll-container', '.viewport'] },
      signal: new AbortController().signal,
      now: () => now,
    });
    const cleanup = vi.fn();
    const lifecycle = T.runTableCollectionLifecycle(context, {
      collect: async () => ({ termination: 'logical-count-reached' }),
      finalize: async () => {
        now = context.deadline.serverAt;
        return 'late-finalize-success';
      },
      cleanup,
    });

    await expect(lifecycle).rejects.toMatchObject({
      code: 'TABLE_COLLECTION_SERVER_DEADLINE',
      phase: 'server',
    });
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('aborts and drains unawaited page work before finalization and leaves no live timers', async () => {
    let nextTimer = 0;
    const timers = new Map();
    const setTimer = vi.fn((callback, delay) => {
      const handle = ++nextTimer;
      timers.set(handle, { callback, delay });
      return handle;
    });
    const clearTimer = vi.fn(handle => timers.delete(handle));
    const latePageEffect = vi.fn();
    let operationSignal;
    let finishUnderlyingOperation;
    let operationOutcome;
    let sleepOutcome;
    const context = T.createDaemonRequestExecutionContext({
      request: { cmd: 'table', args: ['--collect', '--scroll-container', '.viewport'] },
      signal: new AbortController().signal,
      now: () => 0,
    });
    const runtime = T.createTableCollectionRuntime(context, { setTimer, clearTimer });
    const finalize = vi.fn(async () => {
      expect(operationSignal.aborted).toBe(true);
      await expect(operationOutcome).resolves.toMatchObject({
        code: 'TABLE_COLLECTION_PAGE_DEADLINE',
        phase: 'page',
      });
      await expect(sleepOutcome).resolves.toMatchObject({
        code: 'TABLE_COLLECTION_PAGE_DEADLINE',
        phase: 'page',
      });
      return 'committed-after-drain';
    });

    const lifecycle = (async () => {
      try {
        const collection = await (async () => {
          operationOutcome = runtime.runCdpOperation(({ signal }) => new Promise(resolve => {
            operationSignal = signal;
            finishUnderlyingOperation = () => {
              if (!signal.aborted) latePageEffect();
              resolve('late-page-result');
            };
          })).catch(error => error);
          sleepOutcome = runtime.sleep(30).catch(error => error);
          await Promise.resolve();
          return { termination: 'logical-count-reached' };
        })();
        return await runtime.runFinalization(() => finalize(collection, runtime));
      } finally {
        runtime.dispose();
      }
    })();

    await new Promise(resolve => setImmediate(resolve));
    expect(operationSignal.aborted).toBe(true);
    expect(finalize).not.toHaveBeenCalled();
    finishUnderlyingOperation();
    await expect(lifecycle).resolves.toBe('committed-after-drain');
    expect(finalize).toHaveBeenCalledOnce();
    expect(timers.size).toBe(0);
    await Promise.resolve();
    expect(latePageEffect).not.toHaveBeenCalled();
  });

  it('owns a signal-ignoring operation until it settles before finalization and return', async () => {
    const rootController = new AbortController();
    const addListener = vi.spyOn(rootController.signal, 'addEventListener');
    const removeListener = vi.spyOn(rootController.signal, 'removeEventListener');
    const events = [];
    let finishOperation;
    let operationSignal;
    let lifecycleSettled = false;
    const context = T.createDaemonRequestExecutionContext({
      request: { cmd: 'table', args: ['--collect', '--scroll-container', '.viewport'] },
      signal: rootController.signal,
      now: () => 0,
    });
    const finalize = vi.fn(async () => {
      events.push('finalize');
      return 'committed-after-owned-operation';
    });
    const lifecycle = T.runTableCollectionLifecycle(context, {
      collect: async runtime => {
        runtime.runCdpOperation(({ signal }) => new Promise(resolve => {
          operationSignal = signal;
          finishOperation = () => {
            events.push('operation-settled');
            resolve('ignored-abort-and-settled');
          };
        })).catch(() => {});
        await Promise.resolve();
        return { termination: 'logical-count-reached' };
      },
      finalize,
      cleanup: vi.fn(),
    });
    lifecycle.then(
      () => { lifecycleSettled = true; },
      () => { lifecycleSettled = true; },
    );
    await new Promise(resolve => setImmediate(resolve));

    expect(operationSignal.aborted).toBe(true);
    expect(finalize).not.toHaveBeenCalled();
    expect(lifecycleSettled).toBe(false);

    finishOperation();
    await expect(lifecycle).resolves.toBe('committed-after-owned-operation');
    events.push('returned');
    expect(events).toEqual(['operation-settled', 'finalize', 'returned']);
    expect(removeListener.mock.calls.length).toBeGreaterThanOrEqual(addListener.mock.calls.length);
  });

  it('drains a live invoked operation before cleanup and returning a collector error', async () => {
    const collectorError = new Error('collector failed after starting page work');
    const events = [];
    let finishOperation;
    let lifecycleSettled = false;
    const context = T.createDaemonRequestExecutionContext({
      request: { cmd: 'table', args: ['--collect', '--scroll-container', '.viewport'] },
      signal: new AbortController().signal,
      now: () => 0,
    });
    const cleanup = vi.fn(() => { events.push('cleanup'); });
    const lifecycle = T.runTableCollectionLifecycle(context, {
      collect: async runtime => {
        runtime.runCdpOperation(() => new Promise(resolve => {
          finishOperation = () => {
            events.push('operation-settled');
            resolve('ignored-abort-and-settled');
          };
        })).catch(() => {});
        await Promise.resolve();
        throw collectorError;
      },
      finalize: vi.fn(),
      cleanup,
    });
    lifecycle.then(
      () => { lifecycleSettled = true; },
      () => { lifecycleSettled = true; },
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(cleanup).not.toHaveBeenCalled();
    expect(lifecycleSettled).toBe(false);

    finishOperation();
    await expect(lifecycle).rejects.toBe(collectorError);
    events.push('returned');
    expect(events).toEqual(['operation-settled', 'cleanup', 'returned']);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('rejects a thenable collector cleanup synchronously without assimilating it', async () => {
    const collectorError = new Error('collector failed');
    const then = vi.fn();
    const cleanup = vi.fn(() => ({ then }));
    const context = T.createDaemonRequestExecutionContext({
      request: { cmd: 'table', args: ['--collect', '--scroll-container', '.viewport'] },
      signal: new AbortController().signal,
      now: () => 0,
    });
    const lifecycle = T.runTableCollectionLifecycle(context, {
      collect: async () => { throw collectorError; },
      finalize: vi.fn(),
      cleanup,
    });
    const outcome = lifecycle.catch(error => error);
    const nextTurn = new Promise(resolve => setImmediate(() => resolve('still-pending')));

    await expect(Promise.race([outcome, nextTurn])).resolves.toMatchObject({
      code: 'TABLE_COLLECTION_SYNC_CLEANUP_REQUIRED',
      cleanupScope: 'collector',
    });
    expect(cleanup).toHaveBeenCalledOnce();
    expect(then).not.toHaveBeenCalled();
  });

  it('starts finalization immediately after early page success and forbids later CDP work', async () => {
    let now = 500;
    const context = T.createDaemonRequestExecutionContext({
      request: { cmd: 'table', args: ['--collect', '--scroll-container', '.viewport'] },
      signal: new AbortController().signal,
      now: () => now,
    });
    const events = [];
    const result = await T.runTableCollectionLifecycle(context, {
      collect: async runtime => {
        events.push(['collect', now]);
        await runtime.runCdpOperation(async ({ timeoutMs }) => {
          events.push(['cdp', timeoutMs, now]);
          now += 25;
          return 'sample';
        });
        return { termination: 'logical-count-reached' };
      },
      finalize: async ({ termination }, runtime) => {
        events.push(['finalize', termination, now, runtime.phase()]);
        const forbidden = vi.fn();
        await expect(runtime.runCdpOperation(forbidden)).rejects.toMatchObject({
          code: 'TABLE_COLLECTION_PAGE_DEADLINE',
          phase: 'page',
        });
        expect(forbidden).not.toHaveBeenCalled();
        return 'committed-result';
      },
      cleanup: vi.fn(),
    });

    expect(result).toBe('committed-result');
    expect(events).toEqual([
      ['collect', 500],
      ['cdp', 5000, 500],
      ['finalize', 'logical-count-reached', 525, 'finalization-only'],
    ]);

    now = context.deadline.pageAt;
    const runtime = T.createTableCollectionRuntime(context);
    const forbidden = vi.fn();
    await expect(runtime.runCdpOperation(forbidden)).rejects.toMatchObject({
      code: 'TABLE_COLLECTION_PAGE_DEADLINE',
      phase: 'page',
    });
    expect(forbidden).not.toHaveBeenCalled();
  });

  it('reserves 295-300s for finalization only and fails truthfully with cleanup by 300s', async () => {
    vi.useFakeTimers();
    try {
      let now = 100;
      const context = T.createDaemonRequestExecutionContext({
        request: { cmd: 'table', args: ['--collect', '--scroll-container', '.viewport'] },
        signal: new AbortController().signal,
        now: () => now,
      });
      now = context.deadline.pageAt - 10;
      const cleanup = vi.fn();
      const finalize = vi.fn(async ({ termination }, runtime) => {
        expect(termination).toBe('time-limit');
        expect(runtime.phase()).toBe('finalization-only');
        return new Promise((resolve, reject) => {
          runtime.signal.addEventListener('abort', () => reject(runtime.signal.reason), { once: true });
        });
      });
      const lifecycle = T.runTableCollectionLifecycle(context, {
        collect: runtime => runtime.runCdpOperation(({ signal }) => new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        })),
        finalize,
        cleanup,
      });
      const rejection = lifecycle.catch(error => error);

      now = context.deadline.pageAt;
      await vi.advanceTimersByTimeAsync(10);
      expect(finalize).toHaveBeenCalledOnce();

      now = context.deadline.serverAt;
      await vi.advanceTimersByTimeAsync(5000);
      await expect(rejection).resolves.toMatchObject({
        code: 'TABLE_COLLECTION_SERVER_DEADLINE',
        phase: 'server',
      });
      expect(cleanup).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles immediately on root abort and removes operation timers and listeners', async () => {
    const controller = new AbortController();
    const addListener = vi.spyOn(controller.signal, 'addEventListener');
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    const timerHandle = Symbol('timer');
    const setTimer = vi.fn(() => timerHandle);
    const clearTimer = vi.fn();
    const context = T.createDaemonRequestExecutionContext({
      request: { cmd: 'table', args: ['--collect', '--scroll-container', '.viewport'] },
      signal: controller.signal,
      now: () => 0,
    });
    const runtime = T.createTableCollectionRuntime(context, { setTimer, clearTimer });
    const neverSettles = vi.fn(() => new Promise(() => {}));
    const promise = runtime.runCdpOperation(neverSettles);
    await Promise.resolve();
    expect(neverSettles).toHaveBeenCalledOnce();

    const reason = new Error('caller disconnected');
    const outcome = promise.catch(error => error);
    controller.abort(reason);

    const nextTurn = new Promise(resolve => setTimeout(() => resolve('still-pending'), 0));
    await expect(Promise.race([outcome, nextTurn])).resolves.toBe(reason);
    expect(clearTimer).toHaveBeenCalledWith(timerHandle);
    runtime.dispose();
    expect(removeListener.mock.calls.length).toBeGreaterThanOrEqual(addListener.mock.calls.length);

    const preAborted = new AbortController();
    preAborted.abort(reason);
    const preAbortedContext = T.createDaemonRequestExecutionContext({
      request: { cmd: 'table', args: ['--collect', '--scroll-container', '.viewport'] },
      signal: preAborted.signal,
      now: () => 0,
    });
    const preAbortedRuntime = T.createTableCollectionRuntime(preAbortedContext);
    const notStarted = vi.fn();
    await expect(preAbortedRuntime.runCdpOperation(notStarted)).rejects.toBe(reason);
    expect(notStarted).not.toHaveBeenCalled();
    preAbortedRuntime.dispose();
  });

  it('does not start queued CDP or finalization work after a synchronous caller abort', async () => {
    const reason = new Error('disconnect before queued work');

    const operationController = new AbortController();
    const operationContext = T.createDaemonRequestExecutionContext({
      request: { cmd: 'table', args: ['--collect', '--scroll-container', '.viewport'] },
      signal: operationController.signal,
      now: () => 0,
    });
    const operationRuntime = T.createTableCollectionRuntime(operationContext);
    const operation = vi.fn();
    const operationOutcome = operationRuntime.runCdpOperation(operation).catch(error => error);
    operationController.abort(reason);
    await expect(operationOutcome).resolves.toBe(reason);
    expect(operation).not.toHaveBeenCalled();
    operationRuntime.dispose();

    const finalizationController = new AbortController();
    const finalizationContext = T.createDaemonRequestExecutionContext({
      request: { cmd: 'table', args: ['--collect', '--scroll-container', '.viewport'] },
      signal: finalizationController.signal,
      now: () => 0,
    });
    const finalizationRuntime = T.createTableCollectionRuntime(finalizationContext);
    const finalization = vi.fn();
    const finalizationOutcome = finalizationRuntime.runFinalization(finalization).catch(error => error);
    finalizationController.abort(reason);
    await expect(finalizationOutcome).resolves.toBe(reason);
    expect(finalization).not.toHaveBeenCalled();
    finalizationRuntime.dispose();
  });
});
