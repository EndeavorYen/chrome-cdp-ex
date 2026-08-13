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
});
