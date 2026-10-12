// Moved from cdp.mjs without changes (#688). cdp.mjs is the entry point and re-exports for tests.
import { actionFailureMessage } from './action-recovery.mjs';
import { createCommandExecutionContext, inspectCommandExecutionContext } from './command-application.mjs';
import { DAEMON_RESTART_NOTICE_PREFIX } from './daemon-restart-notice.mjs';
import { daemonEndpointForPlatform, daemonSocketIdentity, sameDaemonSocket } from './daemon-transport.mjs';
import { redactSensitiveString, redactUrl } from './redaction.mjs';
import { validateRequestSecrets } from './secrets.mjs';
import { snapshotPolicyWire } from './session-policy.mjs';
import { captureStackFrames, formatGeneratedFrame } from './source-maps.mjs';
import { readTabObservation, restoredNetlogEntry, snapshotNetlogForDisk, writeTabObservation } from './tab-observation.mjs';
import { parseTableArgs } from './table-contract.mjs';
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { shouldTrackActionNetworkRequest } from './cdp-action-result.mjs';
import { ALIASES_CACHE, BACKGROUND_THROTTLE_FLAGS, CDP_REPLAY_FLAG, CDP_REPLAY_FLAGS_MAX, DAEMON_CRASH_SCHEMA, DAEMON_RECORD_SCHEMA, DAEMON_RECORD_SUFFIX, DAEMON_REQUEST_DECODER, DAEMON_REQUEST_IDLE_PAUSE_MAX_MS, DEFAULT_CDP_HOST, DEFAULT_DEBUG_PORT, EARLY_RESPONSE_STATUS_MAX, EARLY_RESPONSE_STATUS_MAX_AGE_MS, FALSY_ENV_WORD, IDLE_TIMEOUT, IS_WINDOWS, LAST_CDP_ENDPOINT_FILE, LAST_CDP_ENDPOINT_HISTORY_MAX, LAST_CDP_ENDPOINT_HISTORY_PER_PORT_MAX, LAST_CDP_ENDPOINT_SCHEMA, LOCATION_COORD_SOURCE, MAX_CAPTURED_CONSOLE_CHARS, MAX_DAEMON_REQUEST_LINE_BYTES, OCCLUDED_WINDOWS_FLAG, RESTART_NOTICE_PROBE_COMMANDS, RUNTIME_DIR, SPAWN_DEBUG_BROWSER_VIA, TABLE_COLLECTION_DEADLINES, TABLE_COLLECTION_RUNTIME_STATES, TAB_ENV_RECORDS_MAX, TAB_ENV_SCHEMA, TAB_ENV_SUFFIX, TAB_ENV_THROTTLE_PROFILES, TAB_MODE_RECORDS_MAX, TAB_MODE_SCHEMA, TAB_MODE_SUFFIX, TRUSTED_DAEMON_REQUEST_CONTEXTS, TRUTHY_ENV_WORD, abortReason, cdpProfileKey, daemonRequestAbortSignal, pathApiForRoot, profileDirFromCommandLine, systemTempRootKey } from './cdp-base.mjs';
import { readBrowserArgvViaCdp } from './cdp-browser.mjs';
import { snapshotApplicationArray, snapshotApplicationDataObject } from './cdp-cli.mjs';
import { daemonCommandResetsIdle } from './cdp-daemon.mjs';
import { defaultPersistentDailySpawnCommand, preferredDebugBrowserName } from './cdp-doctor.mjs';
import { cdpDomains } from './cdp-page.mjs';
import { applyNetworkMocks, filterNetlogEntries, setMockCacheDisabled, throttleCdpParams } from './cdp-page-commands.mjs';

// The mode the environment asks for: true (background), false (foreground) or null (nothing explicit).
// An opt-out wins over CDP_BACKGROUND=1, so a foreground request is never ignored.
export function explicitBackgroundChoice(env = process.env) {
  if (TRUTHY_ENV_WORD.test(String(env?.CDP_FOREGROUND ?? '').trim())) return false;
  const value = String(env?.CDP_BACKGROUND ?? '').trim();
  if (FALSY_ENV_WORD.test(value)) return false;
  if (TRUTHY_ENV_WORD.test(value)) return true;
  return null;
}
export function isBackgroundMode(env = process.env) {
  return explicitBackgroundChoice(env) !== false;
}
export class TableCollectionDeadlineError extends Error {
  constructor(phase, { lateInvocation = false } = {}) {
    const page = phase === 'page';
    super(page
      ? 'table: page/CDP deadline reached before collection completed'
      : 'table: server deadline reached before a committed response was ready');
    this.name = 'TableCollectionDeadlineError';
    this.code = page ? 'TABLE_COLLECTION_PAGE_DEADLINE' : 'TABLE_COLLECTION_SERVER_DEADLINE';
    this.phase = phase;
    if (lateInvocation) this.lateInvocation = true;
  }
}
export class TableCollectionOperationTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`table: CDP operation exceeded its ${timeoutMs}ms bounded timeout`);
    this.name = 'TableCollectionOperationTimeoutError';
    this.code = 'TABLE_COLLECTION_CDP_TIMEOUT';
    this.phase = 'page';
  }
}
export class TableCollectionDaemonTerminationRequiredError extends Error {
  constructor() {
    super('table: server deadline reached with unsettled invoked work; daemon termination is required');
    this.name = 'TableCollectionDaemonTerminationRequiredError';
    this.code = 'TABLE_COLLECTION_DAEMON_TERMINATION_REQUIRED';
    this.phase = 'server';
    this.requiresDaemonTermination = true;
  }
}
export class TableCollectionSynchronousCleanupRequiredError extends Error {
  constructor(cleanupScope) {
    super(`table: ${cleanupScope} cleanup must complete synchronously and return undefined`);
    this.name = 'TableCollectionSynchronousCleanupRequiredError';
    this.code = 'TABLE_COLLECTION_SYNC_CLEANUP_REQUIRED';
    this.cleanupScope = cleanupScope;
  }
}
export function monotonicNow() {
  return performance.now();
}
export function mintDaemonRequestExecutionContext({ signal, tableCollect, now }) {
  if (typeof now !== 'function') throw new Error('daemon request clock must be a function');
  let deadline = null;
  if (tableCollect) {
    const startedAt = now();
    if (!Number.isFinite(startedAt) || startedAt < 0) {
      throw new Error('daemon request monotonic clock must return a finite non-negative number');
    }
    deadline = {
      startedAt,
      pageAt: startedAt + TABLE_COLLECTION_DEADLINES.pageMs,
      serverAt: startedAt + TABLE_COLLECTION_DEADLINES.serverMs,
      maxCdpOperationMs: TABLE_COLLECTION_DEADLINES.maxCdpOperationMs,
      now,
    };
  }
  const context = createCommandExecutionContext({ signal, deadline });
  TRUSTED_DAEMON_REQUEST_CONTEXTS.add(context);
  return context;
}
export function createDaemonRequestExecutionContext({ request, signal, now = monotonicNow }) {
  const tableCollect = request?.cmd === 'table'
    ? parseTableArgs(request.args || []).mode === 'collect'
    : false;
  return mintDaemonRequestExecutionContext({ signal, tableCollect, now });
}
export function enforceDaemonTableCollectionGate(request, execution = null) {
  if (request?.cmd !== 'table') return;
  if (parseTableArgs(request.args || []).mode === 'collect' && !execution?.deadline) {
    throw new Error('table: trusted daemon request deadline context is required');
  }
}
export function throwIfRequestAborted(fallback = 'request aborted') {
  const signal = daemonRequestAbortSignal();
  if (signal?.aborted) throw abortReason(signal, fallback);
}
export function daemonRequestHasUnsettledInvocations(executionContext) {
  return (TABLE_COLLECTION_RUNTIME_STATES.get(executionContext)?.ownedInvocations.size || 0) > 0;
}
export function invokeSynchronousCleanup(cleanup, cleanupScope, args) {
  try {
    return cleanup(...args) === undefined
      ? null
      : new TableCollectionSynchronousCleanupRequiredError(cleanupScope);
  } catch (error) {
    return error;
  }
}
export function retainFatalCleanupError(fatalError, cleanupError) {
  if (!cleanupError || cleanupError === fatalError) return;
  if (!Array.isArray(fatalError.cleanupErrors)) fatalError.cleanupErrors = [];
  if (fatalError.cleanupErrors.length < 16) fatalError.cleanupErrors.push(cleanupError);
}
export function prepareDaemonCollectionFatal(executionContext, error) {
  const state = TABLE_COLLECTION_RUNTIME_STATES.get(executionContext);
  if (!state) return null;
  state.closePageWork?.();
  state.abortLifecycle?.(error);
  return state.startCleanup?.(error) || null;
}
export function isDaemonTerminationRequired(error) {
  return error?.code === 'TABLE_COLLECTION_DAEMON_TERMINATION_REQUIRED'
    && error?.requiresDaemonTermination === true;
}
export function createTableCollectionRuntime(executionContext, {
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const context = inspectCommandExecutionContext(executionContext);
  if (!TRUSTED_DAEMON_REQUEST_CONTEXTS.has(context) || !context.deadline) {
    throw new Error('table: trusted daemon request deadline context is required');
  }
  const { deadline } = context;
  const lifecycleController = new AbortController();
  const pageController = new AbortController();
  const activePageTasks = new Set();
  const ownedInvocations = new Set();
  const runtimeState = { ownedInvocations, latePageInvocation: false };
  TABLE_COLLECTION_RUNTIME_STATES.set(context, runtimeState);
  let finalizing = false;
  const abortLifecycle = reason => {
    if (!lifecycleController.signal.aborted) lifecycleController.abort(reason);
  };
  const onRequestAbort = () => abortLifecycle(abortReason(context.signal));
  if (context.signal.aborted) onRequestAbort();
  else context.signal.addEventListener('abort', onRequestAbort, { once: true });

  const remaining = value => Math.max(0, value - deadline.now());
  const throwIfAborted = () => {
    if (lifecycleController.signal.aborted) throw abortReason(lifecycleController.signal);
  };
  const remainingPageMs = () => remaining(deadline.pageAt);
  const remainingServerMs = () => remaining(deadline.serverAt);
  const phase = () => {
    if (finalizing && remainingServerMs() > 0) return 'finalization-only';
    if (remainingPageMs() > 0) return 'page';
    if (remainingServerMs() > 0) return 'finalization-only';
    return 'expired';
  };
  const cdpOperationTimeoutMs = () => finalizing
    ? 0
    : Math.min(deadline.maxCdpOperationMs, remainingPageMs());
  const trackPageTask = task => {
    activePageTasks.add(task);
    const remove = () => activePageTasks.delete(task);
    task.then(remove, remove);
    return task;
  };
  const trackInvocation = (task, { page = false } = {}) => {
    ownedInvocations.add(task);
    const settle = fulfilled => {
      if (fulfilled && page && deadline.now() >= deadline.pageAt) {
        runtimeState.latePageInvocation = true;
      }
      ownedInvocations.delete(task);
    };
    task.then(() => settle(true), () => settle(false));
    return task;
  };
  const closePageWork = () => {
    if (finalizing) return;
    finalizing = true;
    pageController.abort(new TableCollectionDeadlineError('page'));
  };
  runtimeState.closePageWork = closePageWork;
  runtimeState.abortLifecycle = abortLifecycle;
  const drainOwnedWork = async () => {
    const pending = [...activePageTasks, ...ownedInvocations];
    if (pending.length === 0) {
      if (runtimeState.latePageInvocation) {
        throw new TableCollectionDeadlineError('page', { lateInvocation: true });
      }
      return;
    }
    const timeoutMs = remainingServerMs();
    if (timeoutMs <= 0) throw new TableCollectionDaemonTerminationRequiredError();
    const fatalError = new TableCollectionDaemonTerminationRequiredError();
    let timer;
    const timeout = new Promise((resolve, reject) => {
      timer = setTimer(() => {
        abortLifecycle(fatalError);
        reject(fatalError);
      }, timeoutMs);
    });
    try {
      await Promise.race([Promise.allSettled(pending), timeout]);
    } finally {
      clearTimer(timer);
    }
    if (ownedInvocations.size > 0) throw fatalError;
    if (runtimeState.latePageInvocation) {
      throw new TableCollectionDeadlineError('page', { lateInvocation: true });
    }
  };
  const beginFinalization = async () => {
    closePageWork();
    await drainOwnedWork();
  };

  const runCdpOperation = operation => trackPageTask((async () => {
    if (typeof operation !== 'function') throw new Error('table: CDP operation must be a function');
    throwIfAborted();
    if (finalizing) throw new TableCollectionDeadlineError('page');
    const pageRemaining = remainingPageMs();
    if (pageRemaining <= 0) throw new TableCollectionDeadlineError('page');
    const timeoutMs = Math.min(deadline.maxCdpOperationMs, pageRemaining);
    const timeoutError = timeoutMs === pageRemaining
      ? new TableCollectionDeadlineError('page')
      : new TableCollectionOperationTimeoutError(timeoutMs);
    const operationController = new AbortController();
    let rejectAbort;
    const aborted = new Promise((resolve, reject) => {
      rejectAbort = reject;
    });
    const propagateAbort = signal => {
      const reason = abortReason(signal);
      if (!operationController.signal.aborted) {
        operationController.abort(reason);
      }
      rejectAbort(reason);
    };
    const onLifecycleAbort = () => propagateAbort(lifecycleController.signal);
    const onPageAbort = () => propagateAbort(pageController.signal);
    lifecycleController.signal.addEventListener('abort', onLifecycleAbort, { once: true });
    pageController.signal.addEventListener('abort', onPageAbort, { once: true });
    let timer;
    const timeout = new Promise((resolve, reject) => {
      timer = setTimer(() => {
        if (!operationController.signal.aborted) operationController.abort(timeoutError);
        reject(timeoutError);
      }, timeoutMs);
    });
    const invocation = Promise.resolve().then(() => {
      throwIfAborted();
      if (operationController.signal.aborted) throw abortReason(operationController.signal);
      return trackInvocation(
        Promise.resolve(operation({ signal: operationController.signal, timeoutMs })),
        { page: true },
      );
    });
    try {
      const result = await Promise.race([
        invocation,
        timeout,
        aborted,
      ]);
      throwIfAborted();
      if (remainingPageMs() <= 0) {
        const error = new TableCollectionDeadlineError('page', { lateInvocation: true });
        if (!operationController.signal.aborted) operationController.abort(error);
        throw error;
      }
      return result;
    } finally {
      clearTimer(timer);
      lifecycleController.signal.removeEventListener('abort', onLifecycleAbort);
      pageController.signal.removeEventListener('abort', onPageAbort);
    }
  })());

  const sleep = milliseconds => trackPageTask((async () => {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      throw new Error('table: sleep duration must be a finite non-negative number');
    }
    throwIfAborted();
    if (finalizing) throw new TableCollectionDeadlineError('page');
    const pageRemaining = remainingPageMs();
    if (pageRemaining <= 0) throw new TableCollectionDeadlineError('page');
    const requestedMs = Math.trunc(milliseconds);
    const timeoutMs = Math.min(requestedMs, pageRemaining);
    if (timeoutMs === 0) return;
    const reachesPageDeadline = requestedMs >= pageRemaining;
    await new Promise((resolve, reject) => {
      let timer;
      const removeAbortListeners = () => {
        lifecycleController.signal.removeEventListener('abort', onLifecycleAbort);
        pageController.signal.removeEventListener('abort', onPageAbort);
      };
      const rejectForAbort = signal => {
        clearTimer(timer);
        removeAbortListeners();
        reject(abortReason(signal));
      };
      const onLifecycleAbort = () => rejectForAbort(lifecycleController.signal);
      const onPageAbort = () => rejectForAbort(pageController.signal);
      timer = setTimer(() => {
        removeAbortListeners();
        if (reachesPageDeadline) reject(new TableCollectionDeadlineError('page'));
        else resolve();
      }, timeoutMs);
      lifecycleController.signal.addEventListener('abort', onLifecycleAbort, { once: true });
      pageController.signal.addEventListener('abort', onPageAbort, { once: true });
    });
    throwIfAborted();
    if (remainingPageMs() <= 0) throw new TableCollectionDeadlineError('page');
  })());

  const runFinalization = async operation => {
    if (typeof operation !== 'function') throw new Error('table: finalization operation must be a function');
    await beginFinalization();
    throwIfAborted();
    const timeoutMs = remainingServerMs();
    if (timeoutMs <= 0) {
      const error = new TableCollectionDeadlineError('server');
      abortLifecycle(error);
      throw error;
    }
    const timeoutError = new TableCollectionDeadlineError('server');
    let timer;
    let rejectAbort;
    const aborted = new Promise((resolve, reject) => {
      rejectAbort = reject;
    });
    const onAbort = () => rejectAbort(abortReason(lifecycleController.signal));
    lifecycleController.signal.addEventListener('abort', onAbort, { once: true });
    const timeout = new Promise((resolve, reject) => {
      timer = setTimer(() => {
        abortLifecycle(timeoutError);
        reject(timeoutError);
      }, timeoutMs);
    });
    try {
      const invocation = Promise.resolve().then(() => {
        throwIfAborted();
        return trackInvocation(Promise.resolve(operation()));
      });
      const result = await Promise.race([
        invocation,
        timeout,
        aborted,
      ]);
      throwIfAborted();
      if (remainingServerMs() <= 0) {
        abortLifecycle(timeoutError);
        throw timeoutError;
      }
      return result;
    } finally {
      clearTimer(timer);
      lifecycleController.signal.removeEventListener('abort', onAbort);
    }
  };

  return Object.freeze({
    signal: lifecycleController.signal,
    deadline,
    phase,
    remainingPageMs,
    remainingServerMs,
    cdpOperationTimeoutMs,
    throwIfAborted,
    runCdpOperation,
    sleep,
    beginFinalization,
    runFinalization,
    clearLatePageInvocation() {
      runtimeState.latePageInvocation = false;
    },
    dispose() {
      closePageWork();
      context.signal.removeEventListener('abort', onRequestAbort);
      if (TABLE_COLLECTION_RUNTIME_STATES.get(context) === runtimeState) {
        TABLE_COLLECTION_RUNTIME_STATES.delete(context);
      }
    },
  });
}
export async function runTableCollectionLifecycle(executionContext, {
  collect,
  finalize,
  cleanup,
} = {}) {
  if (typeof collect !== 'function') throw new Error('table: collector seam is required');
  if (typeof finalize !== 'function') throw new Error('table: finalizer seam is required');
  if (typeof cleanup !== 'function') throw new Error('table: cleanup seam is required');
  const runtime = createTableCollectionRuntime(executionContext);
  const runtimeState = TABLE_COLLECTION_RUNTIME_STATES.get(executionContext);
  let cleanupStarted = false;
  let cleanupFailure = null;
  const startCleanup = error => {
    if (cleanupStarted) return cleanupFailure;
    cleanupStarted = true;
    cleanupFailure = invokeSynchronousCleanup(cleanup, 'collector', [error]);
    return cleanupFailure;
  };
  runtimeState.startCleanup = startCleanup;
  try {
    let collection;
    try {
      collection = await collect(runtime);
    } catch (error) {
      if (error?.code !== 'TABLE_COLLECTION_PAGE_DEADLINE' || error.lateInvocation === true) throw error;
      collection = { termination: 'time-limit' };
    }
    return await runtime.runFinalization(() => finalize(collection, runtime));
  } catch (error) {
    let failure = error;
    if (!isDaemonTerminationRequired(failure)) {
      try {
        await runtime.beginFinalization();
      } catch (drainError) {
        failure = drainError;
      }
    }
    if (isDaemonTerminationRequired(failure)) {
      retainFatalCleanupError(failure, startCleanup(failure));
      throw failure;
    }
    const cleanupError = startCleanup(failure);
    if (cleanupError) throw cleanupError;
    throw failure;
  } finally {
    runtime.dispose();
  }
}
export function validateDaemonProtocolRequest(input) {
  const request = snapshotApplicationDataObject(input, 'daemon request');
  const expectedKeys = new Set(['id', 'cmd', 'args']);
  for (const key of Object.keys(request)) {
    // `policy` (#466) and `secrets` (#469) are optional request fields.
    if (!expectedKeys.has(key) && key !== 'policy' && key !== 'secrets') throw new Error(`daemon request.${key}: is not allowed`);
  }
  for (const key of expectedKeys) {
    if (!Object.hasOwn(request, key)) throw new Error(`daemon request ${key === 'cmd' ? 'command' : key} is required`);
  }
  if (!Number.isSafeInteger(request.id) || request.id <= 0) {
    throw new Error('daemon request id must be a positive safe integer');
  }
  if (typeof request.cmd !== 'string' || request.cmd.length === 0) {
    throw new Error('daemon request command must be a non-empty string');
  }
  const args = snapshotApplicationArray(request.args, 'daemon request args');
  for (let index = 0; index < args.length; index += 1) {
    if (typeof args[index] !== 'string') throw new Error(`daemon request args[${index}] must be a string`);
  }
  const secrets = validateRequestSecrets(request.secrets);
  const frozenRequest = Object.freeze({
    id: request.id,
    cmd: request.cmd,
    args: Object.freeze(args),
    ...(Object.hasOwn(request, 'policy') ? { policy: snapshotPolicyWire(request.policy) } : {}),
    ...(secrets ? { secrets } : {}),
  });
  const tableCollect = frozenRequest.cmd === 'table'
    ? parseTableArgs(frozenRequest.args).mode === 'collect'
    : false;
  return Object.freeze({ request: frozenRequest, tableCollect });
}
export function ignoreLateConnectionError() {}
export function createDaemonRequestConnection(conn, {
  handleRequest,
  cleanup = () => {},
  onFlushed = () => {},
  onDispose = () => {},
  onDisconnect = () => {},
  onFatal = () => {},
  onStop = () => {},
  now = monotonicNow,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (!conn || typeof conn.on !== 'function' || typeof conn.off !== 'function') {
    throw new Error('daemon request connection must be an event emitter');
  }
  if (typeof conn.write !== 'function') throw new Error('daemon request connection.write must be a function');
  if (typeof handleRequest !== 'function') throw new Error('daemon request handler must be a function');
  if (typeof cleanup !== 'function') throw new Error('daemon request cleanup must be a function');
  if (typeof onFlushed !== 'function') throw new Error('daemon request flush callback must be a function');
  if (typeof onDispose !== 'function') throw new Error('daemon request disposer must be a function');
  if (typeof onDisconnect !== 'function') throw new Error('daemon request disconnect callback must be a function');
  if (typeof onFatal !== 'function') throw new Error('daemon request fatal callback must be a function');
  if (typeof onStop !== 'function') throw new Error('daemon request stop callback must be a function');
  if (typeof setTimer !== 'function' || typeof clearTimer !== 'function') {
    throw new Error('daemon request timer functions are required');
  }
  const active = new Map();
  // Raw bytes of the incomplete request line. Decoding happens only once a whole
  // newline-terminated frame is present, so a multibyte UTF-8 character split
  // across socket reads is never decoded half at a time (#457).
  const pending = [];
  let pendingBytes = 0;
  let disconnected = false;
  let poisoned = false;
  let disconnectNotified = false;
  let errorSinkInstalled = false;

  const canWrite = () => !disconnected && conn.destroyed !== true && conn.writable !== false;
  const writePayload = (payload, callback = () => {}) => {
    if (!canWrite()) return false;
    try {
      conn.write(payload, callback);
      return true;
    } catch {
      return false;
    }
  };
  const responsePayload = (response, id) => `${JSON.stringify({ ...response, id })}\n`;
  const writeFailure = (id, error) => {
    let payload;
    try {
      payload = responsePayload({ ok: false, error: actionFailureMessage(error) }, id);
    } catch {
      return false;
    }
    return writePayload(payload);
  };
  const cleanupRequest = (entry, reason) => {
    if (entry.cleanupStarted) return entry.cleanupFailure;
    entry.cleanupStarted = true;
    entry.cleaned = true;
    entry.cleanupFailure = invokeSynchronousCleanup(
      cleanup,
      'request',
      [entry.request, entry.execution, reason],
    );
    return entry.cleanupFailure;
  };
  const disposeRequest = (entry, { abort = null, clean = false } = {}) => {
    if (entry.disposed) return entry.cleanupFailure;
    entry.disposed = true;
    if (entry.executionTimer !== null) {
      clearTimer(entry.executionTimer);
      entry.executionTimer = null;
    }
    if (abort && !entry.controller.signal.aborted) entry.controller.abort(abort);
    if (active.get(entry.id) === entry) active.delete(entry.id);
    const cleanupError = clean ? cleanupRequest(entry, abort) : entry.cleanupFailure;
    try { onDispose(entry.request, entry.execution); } catch {}
    return cleanupError;
  };
  const disposeAfterSuccessfulFlush = entry => {
    let releaseError = null;
    try {
      if (onFlushed(entry.request, entry.execution) !== undefined) {
        releaseError = new TableCollectionSynchronousCleanupRequiredError('request release');
      }
    } catch (error) {
      releaseError = error;
    }
    if (!releaseError) {
      disposeRequest(entry);
      return;
    }
    const cleanupError = disposeRequest(entry, { abort: releaseError, clean: true });
    retainFatalCleanupError(releaseError, cleanupError);
    terminateForFatal(releaseError);
  };
  const notifyDisconnect = error => {
    if (disconnectNotified || active.size > 0) return;
    disconnectNotified = true;
    try { onDisconnect(error); } catch {}
  };
  const disconnectReason = cause => cause instanceof Error
    ? cause
    : new Error(`daemon client disconnected: ${cause || 'connection closed'}`);
  const abortAll = (reason, { retire = true } = {}) => {
    const error = disconnectReason(reason);
    const unsafeCollect = !retire && [...active.values()].some(entry => (
      entry.execution.deadline
      && (!entry.handlerSettled || daemonRequestHasUnsettledInvocations(entry.execution))
    ));
    if (unsafeCollect) {
      terminateForFatal(new TableCollectionDaemonTerminationRequiredError());
      return;
    }
    disconnected = true;
    let cleanupFailure = null;
    for (const entry of [...active.values()]) {
      if (retire) retainFatalCleanupError(error, prepareDaemonCollectionFatal(entry.execution, error));
      const entryCleanupFailure = disposeRequest(entry, { abort: error, clean: true });
      cleanupFailure ||= entryCleanupFailure;
    }
    removeConnectionListeners();
    if (!retire && cleanupFailure) {
      terminateForFatal(cleanupFailure);
      return;
    }
    notifyDisconnect(error);
  };
  const onEnd = () => abortAll('connection ended', { retire: false });
  const onClose = () => abortAll('connection closed', { retire: false });
  const onError = error => abortAll(error, { retire: false });

  const terminateForFatal = error => {
    if (poisoned) return;
    poisoned = true;
    disconnected = true;
    const entries = [...active.values()];
    for (const entry of entries) {
      if (!entry.controller.signal.aborted) entry.controller.abort(error);
    }
    for (const entry of entries) {
      retainFatalCleanupError(error, prepareDaemonCollectionFatal(entry.execution, error));
    }
    for (const entry of entries) retainFatalCleanupError(error, cleanupRequest(entry, error));
    for (const entry of entries) disposeRequest(entry, { abort: error });
    removeConnectionListeners();
    try { conn.destroy?.(); } catch {}
    notifyDisconnect(error);
    try { onFatal(error); } catch {}
  };

  // Reply once with a protocol error, retire this connection's requests and
  // close it. The daemon keeps serving other connections, unless an unproven
  // table collect forces the same fatal retirement as any other abort would.
  const terminateConnection = (error, id) => {
    pending.length = 0;
    pendingBytes = 0;
    const unsafeCollect = [...active.values()].some(entry => (
      entry.execution.deadline
      && (!entry.handlerSettled || daemonRequestHasUnsettledInvocations(entry.execution))
    ));
    if (unsafeCollect) {
      terminateForFatal(new TableCollectionDaemonTerminationRequiredError());
      return;
    }
    let cleanupFailure = null;
    for (const entry of [...active.values()]) {
      cleanupFailure ||= disposeRequest(entry, { abort: error, clean: true });
    }
    if (cleanupFailure) {
      terminateForFatal(cleanupFailure);
      return;
    }
    // The peer may already be gone (it wrote the bad line and closed), so this
    // reply can fail with EPIPE/ECONNRESET; the sink must be in place first.
    installErrorSink();
    let payload = null;
    try { payload = responsePayload({ ok: false, error: error.message }, id); } catch {}
    if (payload && canWrite()) {
      try {
        if (typeof conn.end === 'function') conn.end(payload);
        else conn.write(payload);
      } catch {}
    }
    disconnected = true;
    disconnectNotified = true;
    removeConnectionListeners();
    try { onDisconnect(error); } catch {}
  };
  const terminateForDuplicate = id => terminateConnection(new Error(`Duplicate active request id: ${id}`), id);
  const terminateForOversizedLine = () => terminateConnection(
    new Error(`daemon request line exceeded ${MAX_DAEMON_REQUEST_LINE_BYTES} bytes; connection closed`),
    null,
  );

  const dispatch = input => {
    let validated;
    try {
      validated = validateDaemonProtocolRequest(input);
    } catch (error) {
      const responseId = Number.isSafeInteger(input?.id) && input.id > 0 ? input.id : null;
      writeFailure(responseId, error);
      return;
    }
    const { request: req, tableCollect } = validated;
    if (active.has(req.id)) {
      terminateForDuplicate(req.id);
      return;
    }
    const controller = new AbortController();
    const execution = mintDaemonRequestExecutionContext({ signal: controller.signal, tableCollect, now });
    const entry = {
      id: req.id,
      request: req,
      execution,
      controller,
      disposed: false,
      cleaned: false,
      cleanupStarted: false,
      cleanupFailure: null,
      handlerSettled: false,
      executionTimer: null,
    };
    active.set(req.id, entry);
    if (execution.deadline) {
      entry.executionTimer = setTimer(() => {
        terminateForFatal(new TableCollectionDaemonTerminationRequiredError());
      }, execution.deadline.serverAt - execution.deadline.startedAt);
    }
    const finishWithoutResponse = reason => {
      const cleanupError = cleanupRequest(entry, reason);
      if (cleanupError) {
        terminateForFatal(cleanupError);
        return;
      }
      disposeRequest(entry);
      notifyDisconnect(reason);
    };
    const responseGateOpen = () => {
      if (execution.deadline && (execution.deadline.now() >= execution.deadline.serverAt
        || daemonRequestHasUnsettledInvocations(execution))) {
        terminateForFatal(new TableCollectionDaemonTerminationRequiredError());
        return false;
      }
      return true;
    };
    const handlerInvocation = Promise.resolve().then(() => {
      execution.signal.throwIfAborted();
      return handleRequest(req, execution);
    });
    entry.handlerInvocation = handlerInvocation;
    handlerInvocation
      .then(response => {
        entry.handlerSettled = true;
        if (entry.disposed) return;
        if (!canWrite()) {
          finishWithoutResponse(abortReason(controller.signal));
          return;
        }
        if (!responseGateOpen()) return;
        if (entry.executionTimer !== null) {
          clearTimer(entry.executionTimer);
          entry.executionTimer = null;
        }
        if (response?.ok === false) {
          const cleanupError = cleanupRequest(entry, new Error(response.error || 'daemon request failed'));
          if (cleanupError) {
            terminateForFatal(cleanupError);
            return;
          }
          if (entry.disposed || !canWrite()) return;
          if (!responseGateOpen()) return;
        }
        let payload;
        try {
          payload = responsePayload(response, req.id);
        } catch (error) {
          const cleanupError = disposeRequest(entry, { abort: error, clean: true });
          if (cleanupError) terminateForFatal(cleanupError);
          return;
        }
        if (!responseGateOpen()) return;
        const successfulResponse = response?.ok === true;
        const flushed = error => {
          if (error) {
            const cleanupError = disposeRequest(entry, { abort: error, clean: true });
            if (cleanupError) terminateForFatal(cleanupError);
          } else if (successfulResponse) disposeAfterSuccessfulFlush(entry);
          else disposeRequest(entry);
        };
        if (response?.stopAfter && typeof conn.end === 'function') {
          try {
            conn.end(payload, () => {
              flushed();
              onStop();
            });
          } catch (error) {
            const cleanupError = disposeRequest(entry, { abort: error, clean: true });
            if (cleanupError) terminateForFatal(cleanupError);
          }
          return;
        }
        if (!writePayload(payload, flushed)) {
          const cleanupError = disposeRequest(entry, {
            abort: new Error('daemon response write failed before flush'),
            clean: true,
          });
          if (cleanupError) terminateForFatal(cleanupError);
        }
      })
      .catch(error => {
        entry.handlerSettled = true;
        if (entry.disposed) return;
        if (isDaemonTerminationRequired(error)) {
          terminateForFatal(error);
          return;
        }
        if (!canWrite()) {
          finishWithoutResponse(error);
          return;
        }
        if (!responseGateOpen()) return;
        if (entry.executionTimer !== null) {
          clearTimer(entry.executionTimer);
          entry.executionTimer = null;
        }
        const cleanupError = cleanupRequest(entry, error);
        if (cleanupError) {
          terminateForFatal(cleanupError);
          return;
        }
        if (entry.disposed || !canWrite()) return;
        if (!responseGateOpen()) return;
        let payload;
        try {
          payload = responsePayload({ ok: false, error: actionFailureMessage(error) }, req.id);
        } catch (serializationError) {
          const serializationCleanupError = disposeRequest(entry, { abort: serializationError, clean: true });
          if (serializationCleanupError) terminateForFatal(serializationCleanupError);
          return;
        }
        if (!responseGateOpen()) return;
        if (!writePayload(payload, writeError => {
          if (writeError) {
            const writeCleanupError = disposeRequest(entry, { abort: writeError, clean: true });
            if (writeCleanupError) terminateForFatal(writeCleanupError);
            return;
          }
          disposeRequest(entry);
        })) {
          const writeCleanupError = disposeRequest(entry, { abort: error, clean: true });
          if (writeCleanupError) terminateForFatal(writeCleanupError);
        }
      });
  };

  const dispatchFrame = frameBytes => {
    let line;
    try {
      line = DAEMON_REQUEST_DECODER.decode(frameBytes);
    } catch {
      writeFailure(null, new Error('Invalid request: not valid UTF-8'));
      return;
    }
    if (!line.trim()) return;
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      writeFailure(null, new Error('Invalid JSON request'));
      return;
    }
    dispatch(req);
  };
  const onData = chunk => {
    if (disconnected) return;
    let incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    while (!disconnected) {
      const newline = incoming.indexOf(10);
      const lineBytes = pendingBytes + (newline === -1 ? incoming.length : newline);
      if (lineBytes > MAX_DAEMON_REQUEST_LINE_BYTES) {
        terminateForOversizedLine();
        return;
      }
      if (newline === -1) {
        if (incoming.length > 0) pending.push(incoming);
        pendingBytes = lineBytes;
        return;
      }
      pending.push(incoming.subarray(0, newline));
      const frameBytes = Buffer.concat(pending, lineBytes);
      pending.length = 0;
      pendingBytes = 0;
      incoming = incoming.subarray(newline + 1);
      dispatchFrame(frameBytes);
    }
  };
  // A socket can still emit 'error' after this lifecycle lets go of it: a reply
  // or end() write that fails with EPIPE/ECONNRESET because the peer already
  // closed. An 'error' event with no listener throws and would crash the whole
  // daemon, so a no-op sink replaces onError instead of leaving nothing.
  function installErrorSink() {
    if (errorSinkInstalled) return;
    errorSinkInstalled = true;
    conn.on('error', ignoreLateConnectionError);
  }
  function removeConnectionListeners() {
    installErrorSink();
    conn.off('data', onData);
    conn.off('end', onEnd);
    conn.off('close', onClose);
    conn.off('error', onError);
  }

  conn.on('data', onData);
  conn.on('end', onEnd);
  conn.on('close', onClose);
  conn.on('error', onError);
  return Object.freeze({
    abortAll,
    activeRequestCount: () => active.size,
  });
}
export function createDaemonShutdown({
  requestConnections,
  getServer,
  socketPath,
  cleanupSession = () => {},
  closeCdp,
  exitProcess = code => process.exit(code),
  // dev+ino this daemon recorded once it bound `socketPath`; null if it never bound it.
  getSocketIdentity = () => null,
  statSocket = statSync,
  removeRecord = () => {},
  isWindows = IS_WINDOWS,
  beforeExit = () => {},
}) {
  if (!(requestConnections instanceof Set)) throw new Error('daemon request connection registry must be a Set');
  if (typeof getServer !== 'function') throw new Error('daemon server accessor must be a function');
  if (typeof closeCdp !== 'function') throw new Error('daemon CDP closer must be a function');
  if (typeof cleanupSession !== 'function') throw new Error('daemon session cleanup must be a function');
  if (typeof exitProcess !== 'function') throw new Error('daemon process exit must be a function');
  let alive = true;
  return (exitCode = 0, meta = {}) => {
    if (!alive) return;
    alive = false;
    const info = meta && typeof meta === 'object' ? meta : {};
    try {
      beforeExit({
        exitCode: Number.isInteger(exitCode) ? exitCode : 0,
        reason: info.reason || 'exit',
        ...(info.signal ? { signal: info.signal } : {}),
        ...(info.exceptionKind ? { exceptionKind: info.exceptionKind } : {}),
        ...(info.message ? { message: info.message } : {}),
      });
    } catch {}
    const reason = new Error('daemon shutting down');
    for (const connection of [...requestConnections]) {
      try { connection.abortAll(reason, { retire: true }); } catch {}
    }
    let finalExitCode = Number.isInteger(exitCode) ? exitCode : 0;
    try {
      if (cleanupSession() !== undefined) finalExitCode = 1;
    } catch {
      finalExitCode = 1;
    }
    // On POSIX the path may now hold a newer daemon's socket (#458). libuv unlinks a bound
    // pipe's path when its server closes, so closing is the cleanup, and a daemon that no
    // longer owns the path must not close; the exit below releases its listener.
    let ownsSocket = isWindows;
    if (!isWindows) {
      try {
        ownsSocket = sameDaemonSocket(getSocketIdentity(), daemonSocketIdentity(socketPath, { stat: statSocket }));
      } catch {}
    }
    if (ownsSocket) try { getServer()?.close(); } catch {}
    try { closeCdp(); } catch {}
    try { removeRecord(); } catch {}
    exitProcess(finalExitCode);
  };
}
// The daemon's idle shutdown timer. `remainingMs` lets `meta` report how long the daemon
// has left, so a client can avoid a daemon that would exit before its command arrives (#440).
// A running command pauses the countdown, so a long `wait` or `loadall` is never cut off and
// leaves a full idle period behind it: the countdown restarts when the last one ends (#462).
// A request stops counting as running after maxPauseMs, so a wedged handler cannot hold the
// pause forever: its daemon then idles out a full timeout later.
export function createDaemonIdleTimer({
  timeoutMs = IDLE_TIMEOUT,
  maxPauseMs = DAEMON_REQUEST_IDLE_PAUSE_MAX_MS,
  onIdle,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (typeof onIdle !== 'function') throw new Error('daemon idle handler must be a function');
  let keepaliveUntil = 0;
  let inFlight = 0;
  let deadline = now() + timeoutMs;
  let timer = setTimer(onIdle, timeoutMs);
  const nextDelay = () => Math.max(timeoutMs, keepaliveUntil - now(), 1000);
  function schedule() {
    clearTimer(timer);
    timer = null;
    if (inFlight > 0) return;
    const delay = nextDelay();
    deadline = now() + delay;
    timer = setTimer(onIdle, delay);
  }
  return Object.freeze({
    reset: schedule,
    extendKeepalive(ms) {
      keepaliveUntil = Math.max(keepaliveUntil, now() + ms);
      schedule();
      return keepaliveUntil;
    },
    // Returns the matching end call; calling it twice ends the request once. The request
    // also ends by itself after maxPauseMs.
    beginRequest() {
      inFlight += 1;
      clearTimer(timer);
      timer = null;
      let ended = false;
      let ceiling = null;
      const end = () => {
        if (ended) return;
        ended = true;
        clearTimer(ceiling);
        inFlight -= 1;
        if (inFlight === 0) schedule();
      };
      ceiling = setTimer(end, maxPauseMs);
      return end;
    },
    // While paused the daemon has at least a full idle period left.
    remainingMs: () => (inFlight > 0 ? nextDelay() : Math.max(0, deadline - now())),
  });
}
// Wraps the daemon request handler so a command in flight pauses the idle timer. `meta` and
// `list_raw` are probes that must not keep a daemon alive (#419): pausing for them would
// restart the full countdown when they end. `onSettled` runs after every request.
export function idleTrackedDaemonRequestHandler(idleTimer, handle, { onSettled = () => {} } = {}) {
  return (request, execution) => {
    const end = daemonCommandResetsIdle(request?.cmd) ? idleTimer.beginRequest() : () => {};
    const settle = () => {
      end();
      try { onSettled(); } catch {}
    };
    let pending;
    try {
      pending = handle(request, execution);
    } catch (error) {
      settle();
      throw error;
    }
    return Promise.resolve(pending).finally(settle);
  };
}
export function createEarlyResponseStatusStore({
  maxEntries = EARLY_RESPONSE_STATUS_MAX,
  maxAgeMs = EARLY_RESPONSE_STATUS_MAX_AGE_MS,
  now = Date.now,
} = {}) {
  const early = new Map(); // requestId → { status, ts }, oldest first
  const announced = new Set(); // requestIds seen in requestWillBeSent, oldest first
  const bound = collection => {
    while (collection.size > maxEntries) collection.delete(collection.keys().next().value);
  };
  const dropExpired = () => {
    const cutoff = now() - maxAgeMs;
    for (const [requestId, entry] of early) {
      if (entry.ts >= cutoff) break;
      early.delete(requestId);
    }
  };
  return {
    // The request is announced; returns the status that arrived before it, if any.
    announce(requestId) {
      announced.delete(requestId);
      announced.add(requestId);
      bound(announced);
      dropExpired();
      const entry = early.get(requestId);
      if (!entry) return undefined;
      early.delete(requestId);
      return entry.status;
    },
    remember(requestId, status) {
      if (announced.has(requestId)) return false;
      dropExpired();
      early.delete(requestId);
      early.set(requestId, { status, ts: now() });
      bound(early);
      return true;
    },
    clear() {
      early.clear();
      announced.clear();
    },
    get size() { return early.size; },
  };
}
// CDP Network event handlers for the daemon's request/response buffer. Only action-relevant
// requests are tracked; static assets are skipped as noise.
export function createDaemonNetworkObserver({ pendingReqs, netReqBuf, networkStatusByRequest, now = Date.now, session = null } = {}) {
  function rememberNetwork() {
    if (session) rememberTabObservation(session);
  }
  function appendNetworkResponse(requestId, req, { status = null, type = req.type, size = 0, failed = false, errorText = null } = {}) {
    pendingReqs.delete(requestId);
    netReqBuf.push({
      requestId,
      method: req.method,
      url: req.url,
      status,
      type,
      duration: now() - req.ts,
      size,
      ...(failed ? { failed: true } : {}),
      ...(errorText ? { errorText } : {}),
      ts: req.ts,
    });
    rememberNetwork();
  }
  return {
    'Network.requestWillBeSent': (params) => {
      const earlyStatus = networkStatusByRequest.announce(params.requestId);
      if (!shouldTrackActionNetworkRequest(params.type)) return;
      const req = {
        requestId: params.requestId,
        method: params.request.method,
        url: params.request.url.substring(0, 200),
        type: params.type,
        ts: now(),
      };
      if (earlyStatus !== undefined) appendNetworkResponse(params.requestId, req, { status: earlyStatus });
      else pendingReqs.set(params.requestId, req);
    },
    'Network.responseReceived': (params) => {
      const req = pendingReqs.get(params.requestId);
      if (!req) return;
      appendNetworkResponse(params.requestId, req, {
        status: params.response.status,
        type: params.type,
        size: params.response.encodedDataLength || 0,
      });
    },
    'Network.responseReceivedExtraInfo': (params) => {
      const req = pendingReqs.get(params.requestId);
      if (!Number.isFinite(Number(params.statusCode))) return;
      const status = Number(params.statusCode);
      if (!req) {
        networkStatusByRequest.remember(params.requestId, status);
        return;
      }
      appendNetworkResponse(params.requestId, req, { status });
    },
    'Network.loadingFinished': (params) => {
      const req = pendingReqs.get(params.requestId);
      if (!req) {
        if (session?.netRequestStore?.idFor?.(params.requestId) != null) rememberNetwork();
        return;
      }
      appendNetworkResponse(params.requestId, req, {
        status: null,
        size: params.encodedDataLength || 0,
      });
    },
    'Network.loadingFailed': (params) => {
      const req = pendingReqs.get(params.requestId);
      if (!req) {
        if (session?.netRequestStore?.idFor?.(params.requestId) != null) rememberNetwork();
        return;
      }
      appendNetworkResponse(params.requestId, req, {
        status: null,
        type: params.type,
        failed: true,
        errorText: params.errorText || 'loadingFailed',
      });
    },
  };
}
export class RingBuffer {
  constructor(capacity) { this.buf = []; this.capacity = capacity; this.seq = 0; }
  push(entry) { entry._seq = ++this.seq; this.buf.push(entry); if (this.buf.length > this.capacity) this.buf.shift(); }
  load(entries) {
    for (const entry of Array.isArray(entries) ? entries : []) this.push({ ...entry });
  }
  since(seq) { return this.buf.filter(e => e._seq > seq); }
  all() { return [...this.buf]; }
  latest() { return this.seq; }
  clear() { this.buf.length = 0; }
}
// `text.slice(0, end)` that never keeps half of a surrogate pair at the cut.
export function sliceAtCodePoint(text, end) {
  const cut = Math.max(0, end);
  if (cut <= 0 || cut >= text.length) return text.slice(0, cut);
  const before = text.charCodeAt(cut - 1);
  const after = text.charCodeAt(cut);
  const splitsPair = before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
  return text.slice(0, splitsPair ? cut - 1 : cut);
}
export function boundCapturedText(parts) {
  let text = '';
  let originalLength = 0;
  let room = MAX_CAPTURED_CONSOLE_CHARS;
  for (const [index, part] of parts.entries()) {
    const value = `${index > 0 ? ' ' : ''}${part}`;
    originalLength += value.length;
    if (room <= 0) continue;
    const kept = sliceAtCodePoint(value, room);
    text += kept;
    // Once a part is cut, nothing after it is kept, even if a surrogate pair left room.
    room = kept.length < value.length ? 0 : room - kept.length;
  }
  if (originalLength <= MAX_CAPTURED_CONSOLE_CHARS) return { text };
  return { text, truncated: true, originalLength };
}
// Capture-time bound (#459) plus up to three generated frames for source mapping (#470).
export function consoleEntryFromEvent(params = {}, ts = Date.now()) {
  const { text, ...cut } = boundCapturedText((params.args || []).map(a => a.value ?? a.description ?? JSON.stringify(a)));
  const frames = captureStackFrames(params.stackTrace);
  return { level: params.type || 'log', text, loc: frames.length ? formatGeneratedFrame(frames[0]) : '', frames, ts, ...cut };
}
export function exceptionEntryFromEvent(params = {}, ts = Date.now()) {
  const detail = params.exceptionDetails;
  // exception.description has the full message (e.g. "Error: foo"); text is just "Uncaught".
  const { text: msg, ...cut } = boundCapturedText([detail?.exception?.description || detail?.text || 'Unknown error']);
  const frames = captureStackFrames(detail?.stackTrace, detail);
  return { msg, loc: frames.length ? formatGeneratedFrame(frames[0]) : '', frames, ts, ...cut };
}
// One bounded console line for text surfaces. It says when the line is not the
// whole entry, with the length the page actually logged.
export function boundedConsoleLineText(text, entry = {}, max = 300) {
  const value = String(text ?? '');
  if (value.length <= max && entry.truncated !== true) return value;
  const total = Number.isFinite(entry.originalLength) ? entry.originalLength : value.length;
  return `${sliceAtCodePoint(value, max)}… [truncated, ${total} chars]`;
}
// #634: page URLs, console text, and cookie values use the same redactor as
// receipts, netlog, and report. `--unsafe-full` is the explicit opt-in.
export function displayUrl(value, { unsafeFull = false } = {}) {
  const text = String(value ?? '');
  return unsafeFull ? text : redactUrl(text);
}
export function displayObservedText(value, entry = {}, { unsafeFull = false } = {}) {
  const text = String(value ?? '');
  if (unsafeFull) return text;
  return redactSensitiveString(text, { truncated: entry?.truncated === true });
}
export function displayConsoleLine(text, entry = {}, max = 300, { unsafeFull = false } = {}) {
  return boundedConsoleLineText(displayObservedText(text, entry, { unsafeFull }), entry, max);
}
export function redactLocationText(text) {
  const pattern = new RegExp(LOCATION_COORD_SOURCE, 'g');
  let out = '';
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    out += redactSensitiveString(text.slice(last, match.index));
    out += match[0];
    last = match.index + match[0].length;
  }
  return `${out}${redactSensitiveString(text.slice(last))}`;
}
export function displayLocation(value, { unsafeFull = false } = {}) {
  const text = String(value ?? '');
  if (!text || unsafeFull) return text;
  return redactLocationText(text);
}
export function sockPath(targetId) {
  return daemonEndpointForPlatform(targetId, { runtimeDir: RUNTIME_DIR });
}
export function ensureRuntimeDir() {
  try { mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 }); } catch {}
}
export function daemonRecordPath(targetId, runtimeDir = RUNTIME_DIR) {
  const safeTarget = String(targetId || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_');
  return resolve(runtimeDir, `cdp-${safeTarget}${DAEMON_RECORD_SUFFIX}`);
}
export function daemonCrashReportPath(targetId, runtimeDir = RUNTIME_DIR) {
  const safeTarget = String(targetId || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_');
  return resolve(runtimeDir, `cdp-${safeTarget}.crash.json`);
}
export function recordDaemonCrash(targetId, kind, error, { runtimeDir = RUNTIME_DIR, writer = writeFileSync, now = Date.now, pid = process.pid } = {}) {
  const payload = {
    schema: DAEMON_CRASH_SCHEMA,
    ts: now(),
    pid,
    kind,
    // Bounded first, then redacted: an error message can quote page data.
    message: redactSensitiveString(String(error?.message || error || 'unknown error').slice(0, 300)),
    stack: redactSensitiveString(String(error?.stack || '').slice(0, 2000)),
  };
  try {
    writer(daemonCrashReportPath(targetId, runtimeDir), `${JSON.stringify(payload)}\n`, { mode: 0o600 });
  } catch {}
  return payload;
}
export function readDaemonCrashReport(targetId, { sinceMs = 0, runtimeDir = RUNTIME_DIR, reader = readFileSync } = {}) {
  try {
    const record = JSON.parse(reader(daemonCrashReportPath(targetId, runtimeDir), 'utf8'));
    if (record?.schema !== DAEMON_CRASH_SCHEMA || !(Number(record.ts) >= sinceMs)) return null;
    return `${record.kind}: ${record.message}`;
  } catch {
    return null;
  }
}
export function installDaemonCrashRecorder(targetId, { processRef = process, record = recordDaemonCrash, onCrash = () => {} } = {}) {
  const fail = kind => error => {
    record(targetId, kind, error);
    try { onCrash(kind, error); } catch {}
    try { processRef.stderr.write(`Daemon ${kind}: ${error?.stack || error}\n`); } catch {}
    processRef.exit(1);
  };
  processRef.on('uncaughtException', fail('uncaughtException'));
  processRef.on('unhandledRejection', fail('unhandledRejection'));
}
export function writeDaemonRecord(targetId, { pid = process.pid, startedAt = new Date().toISOString() } = {}, { runtimeDir = RUNTIME_DIR, writer = writeFileSync } = {}) {
  try {
    writer(daemonRecordPath(targetId, runtimeDir), JSON.stringify({
      schema: DAEMON_RECORD_SCHEMA,
      targetId: String(targetId),
      pid,
      startedAt,
    }), { mode: 0o600 });
  } catch {}
}
export function parseDaemonRecord(text) {
  try {
    const record = JSON.parse(text);
    if (record?.schema !== DAEMON_RECORD_SCHEMA || !/^[A-Za-z0-9_.-]+$/.test(String(record.targetId || '')) || String(record.targetId).includes('..')) return null;
    if (!Number.isInteger(record.pid) || record.pid <= 0) return null;
    return record;
  } catch {
    return null;
  }
}
export function readDaemonRecord(targetId, { runtimeDir = RUNTIME_DIR, reader = readFileSync } = {}) {
  try {
    const record = parseDaemonRecord(reader(daemonRecordPath(targetId, runtimeDir), 'utf8'));
    return record && record.targetId === String(targetId) ? record : null;
  } catch {
    return null;
  }
}
export function removeDaemonRecord(targetId, { runtimeDir = RUNTIME_DIR, remover = unlinkSync } = {}) {
  try { remover(daemonRecordPath(targetId, runtimeDir)); } catch {}
}
// A daemon that lost the endpoint must not delete the record of the daemon that won it.
export function removeOwnDaemonRecord(targetId, { pid = process.pid, runtimeDir = RUNTIME_DIR, reader = readFileSync, remover = unlinkSync } = {}) {
  if (readDaemonRecord(targetId, { runtimeDir, reader })?.pid === pid) removeDaemonRecord(targetId, { runtimeDir, remover });
}
export function listDaemonRecords({ runtimeDir = RUNTIME_DIR, readdir = readdirSync, reader = readFileSync } = {}) {
  try {
    return readdir(runtimeDir)
      .filter(name => name.startsWith('cdp-') && name.endsWith(DAEMON_RECORD_SUFFIX))
      .map(name => {
        // One unreadable file (a daemon removing its own record mid-scan) must not hide the rest.
        try {
          const record = parseDaemonRecord(reader(resolve(runtimeDir, name), 'utf8'));
          return record && name === `cdp-${record.targetId}${DAEMON_RECORD_SUFFIX}` ? record : null;
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}
export function tabModePath(targetId, runtimeDir = RUNTIME_DIR) {
  const safeTarget = String(targetId || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_');
  return resolve(runtimeDir, `cdp-${safeTarget}${TAB_MODE_SUFFIX}`);
}
export function parseTabModeRecord(text) {
  try {
    const record = JSON.parse(text);
    if (record?.schema !== TAB_MODE_SCHEMA || typeof record.targetId !== 'string' || !record.targetId) return null;
    return { targetId: record.targetId, background: record.background === true, setAt: String(record.setAt || '') };
  } catch {
    return null;
  }
}
export function listTabModeRecords({ runtimeDir = RUNTIME_DIR, readdir = readdirSync, reader = readFileSync } = {}) {
  try {
    return readdir(runtimeDir)
      .filter(name => name.startsWith('cdp-') && name.endsWith(TAB_MODE_SUFFIX))
      .map(name => {
        try {
          const record = parseTabModeRecord(reader(resolve(runtimeDir, name), 'utf8'));
          return record ? { ...record, path: resolve(runtimeDir, name) } : null;
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}
export function writeTabBackgroundMode(targetId, { background = true, runtimeDir = RUNTIME_DIR, writer = writeFileSync, remover = unlinkSync, now = Date.now } = {}) {
  try {
    mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
    writer(tabModePath(targetId, runtimeDir), JSON.stringify({
      schema: TAB_MODE_SCHEMA,
      targetId: String(targetId),
      background: background === true,
      setAt: new Date(now()).toISOString(),
    }), { mode: 0o600 });
  } catch {
    return false;
  }
  const records = listTabModeRecords({ runtimeDir });
  if (records.length > TAB_MODE_RECORDS_MAX) {
    records.sort((a, b) => a.setAt.localeCompare(b.setAt));
    for (const record of records.slice(0, records.length - TAB_MODE_RECORDS_MAX)) {
      try { remover(record.path); } catch {}
    }
  }
  return true;
}
// The recorded mode of a tab: true (background), false (foreground) or null (no record for it).
export function readTabMode(targetId, { runtimeDir = RUNTIME_DIR, reader = readFileSync } = {}) {
  try {
    const record = parseTabModeRecord(reader(tabModePath(targetId, runtimeDir), 'utf8'));
    return record && record.targetId === String(targetId) ? record.background : null;
  } catch {
    return null;
  }
}
export function readTabBackgroundMode(targetId, options = {}) {
  return readTabMode(targetId, options) === true;
}
export function removeTabMode(targetId, { runtimeDir = RUNTIME_DIR, remover = unlinkSync } = {}) {
  try { remover(tabModePath(targetId, runtimeDir)); } catch {}
}
// Background mode for a starting tab daemon (#441, #488): an explicit choice in the environment of the
// call that starts it, else the mode recorded for this tab by `open`, else the default (background).
export function daemonBackgroundMode(targetId, { env = process.env, runtimeDir = RUNTIME_DIR, reader } = {}) {
  return explicitBackgroundChoice(env)
    ?? readTabMode(targetId, { runtimeDir, ...(reader ? { reader } : {}) })
    ?? true;
}
export function tabEnvPath(targetId, runtimeDir = RUNTIME_DIR) {
  const safeTarget = String(targetId || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_');
  return resolve(runtimeDir, `cdp-${safeTarget}${TAB_ENV_SUFFIX}`);
}
export function persistedThrottle(throttle) {
  if (!throttle || throttle.profile === 'off') return null;
  const profile = String(throttle.profile || '');
  if (!TAB_ENV_THROTTLE_PROFILES.has(profile)) return null;
  return {
    profile,
    offline: throttle.offline === true,
    latencyMs: Number(throttle.latencyMs) || 0,
    downloadKbps: throttle.downloadKbps == null ? null : Number(throttle.downloadKbps),
    uploadKbps: throttle.uploadKbps == null ? null : Number(throttle.uploadKbps),
  };
}
export function persistedHitCount(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return 0;
  if (value > Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER;
  return value;
}
export function persistedMocks(mocks) {
  if (!Array.isArray(mocks)) return [];
  return mocks.map(rule => ({
    id: typeof rule?.id === 'string' && rule.id ? rule.id : `mock-${Date.now().toString(36)}`,
    urlPattern: String(rule?.urlPattern || ''),
    method: rule?.method ? String(rule.method).toUpperCase() : null,
    status: Number(rule?.status),
    body: String(rule?.body ?? ''),
    contentType: String(rule?.contentType || 'text/plain; charset=utf-8'),
    hits: persistedHitCount(rule?.hits),
  }));
}
export function finiteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
export function parsePersistedThrottle(value) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const profile = String(value.profile || '');
  if (!TAB_ENV_THROTTLE_PROFILES.has(profile)) return undefined;
  const downloadKbps = value.downloadKbps == null ? null : Number(value.downloadKbps);
  const uploadKbps = value.uploadKbps == null ? null : Number(value.uploadKbps);
  const latencyMs = Number(value.latencyMs);
  if (!finiteNonNegative(latencyMs)) return undefined;
  if (downloadKbps != null && !finiteNonNegative(downloadKbps)) return undefined;
  if (uploadKbps != null && !finiteNonNegative(uploadKbps)) return undefined;
  if (profile === 'custom' && (downloadKbps == null || uploadKbps == null)) return undefined;
  return {
    profile,
    offline: value.offline === true,
    latencyMs,
    downloadKbps,
    uploadKbps,
  };
}
export function parsePersistedMocks(value) {
  if (!Array.isArray(value)) return null;
  const mocks = [];
  for (const rule of value) {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return null;
    const urlPattern = rule.urlPattern;
    const status = Number(rule.status);
    if (typeof urlPattern !== 'string' || !urlPattern) return null;
    if (!Number.isInteger(status) || status < 100 || status > 599) return null;
    if (rule.body != null && typeof rule.body !== 'string') return null;
    if (rule.contentType != null && typeof rule.contentType !== 'string') return null;
    if (rule.method != null && typeof rule.method !== 'string') return null;
    mocks.push({
      id: typeof rule.id === 'string' && rule.id ? rule.id : `mock-${Date.now().toString(36)}`,
      urlPattern,
      method: rule.method ? String(rule.method).toUpperCase() : null,
      status,
      body: String(rule.body ?? ''),
      contentType: String(rule.contentType || 'text/plain; charset=utf-8'),
      // A missing or unusable count is zero. Rejecting the file would also drop dialog and throttle.
      hits: persistedHitCount(rule.hits),
    });
  }
  return mocks;
}
export function parseTabEnvironment(text, targetId) {
  let record;
  try {
    record = JSON.parse(text);
  } catch {
    return { status: 'unreadable' };
  }
  if (!record || record.schema !== TAB_ENV_SCHEMA || record.targetId !== String(targetId)) {
    return { status: 'unreadable' };
  }
  if (record.dialog !== 'accept' && record.dialog !== 'dismiss') return { status: 'unreadable' };
  const throttle = parsePersistedThrottle(record.throttle);
  if (throttle === undefined) return { status: 'unreadable' };
  const mocks = parsePersistedMocks(record.mocks);
  if (!mocks) return { status: 'unreadable' };
  return { status: 'ok', dialog: record.dialog, throttle, mocks };
}
export function readTabEnvironment(targetId, { runtimeDir = RUNTIME_DIR, reader = readFileSync } = {}) {
  let text;
  try {
    text = reader(tabEnvPath(targetId, runtimeDir), 'utf8');
  } catch (error) {
    return error?.code === 'ENOENT' ? { status: 'absent' } : { status: 'unreadable' };
  }
  return parseTabEnvironment(text, targetId);
}
export function listTabEnvironmentRecords({ runtimeDir = RUNTIME_DIR, readdir = readdirSync, reader = readFileSync } = {}) {
  try {
    return readdir(runtimeDir)
      .filter(name => name.startsWith('cdp-') && name.endsWith(TAB_ENV_SUFFIX))
      .map(name => {
        const path = resolve(runtimeDir, name);
        let text;
        try {
          text = reader(path, 'utf8');
        } catch {
          return null;
        }
        let record;
        try {
          record = JSON.parse(text);
        } catch {
          // Unreadable files force dismiss on the next daemon. Deleting one is not how a tab
          // becomes accept, but the record stays until closetab so a corrupt file is not dropped.
          return { path, setAt: '', prunable: false };
        }
        if (!record || record.schema !== TAB_ENV_SCHEMA) return { path, setAt: '', prunable: false };
        const parsed = parseTabEnvironment(text, record.targetId);
        // A readable dismiss record with throttle off and no mocks matches a missing file.
        // Anything else, including accept, is kept: dropping an explicit accept would
        // come back as dismiss, and dropping a throttle or mock record would drop that setting.
        const prunable = parsed.status === 'ok'
          && parsed.dialog === 'dismiss'
          && !parsed.throttle
          && parsed.mocks.length === 0;
        return { path, setAt: String(record.setAt || ''), prunable };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}
export function writeTabEnvironment(targetId, state, {
  runtimeDir = RUNTIME_DIR,
  writer = writeFileSync,
  rename = renameSync,
  remover = unlinkSync,
  now = Date.now,
} = {}) {
  const path = tabEnvPath(targetId, runtimeDir);
  const tmp = `${path}.${process.pid}.tmp`;
  const record = {
    schema: TAB_ENV_SCHEMA,
    targetId: String(targetId),
    dialog: state?.dialog === 'accept' ? 'accept' : 'dismiss',
    throttle: persistedThrottle(state?.throttle),
    mocks: persistedMocks(state?.mocks),
    setAt: new Date(now()).toISOString(),
  };
  try {
    mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
    writer(tmp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    rename(tmp, path);
  } catch {
    try { remover(tmp); } catch {}
    return false;
  }
  const records = listTabEnvironmentRecords({ runtimeDir, reader: readFileSync });
  if (records.length > TAB_ENV_RECORDS_MAX) {
    const extra = records.length - TAB_ENV_RECORDS_MAX;
    const victims = records
      .filter(record => record.prunable && record.path !== path)
      .sort((a, b) => a.setAt.localeCompare(b.setAt))
      .slice(0, extra);
    for (const old of victims) {
      try { remover(old.path); } catch {}
    }
  }
  return true;
}
export function removeTabEnvironment(targetId, { runtimeDir = RUNTIME_DIR, remover = unlinkSync } = {}) {
  try { remover(tabEnvPath(targetId, runtimeDir)); } catch {}
}
export function rememberTabEnvironment(session) {
  if (!session?.targetId || !session.runtimeDir) return false;
  const saved = writeTabEnvironment(session.targetId, {
    dialog: session.dialogMode === 'accept' ? 'accept' : 'dismiss',
    throttle: session.networkThrottle,
    mocks: session.networkMocks,
  }, { runtimeDir: session.runtimeDir });
  if (!saved) {
    throw new Error('Could not save dialog, throttle, and mock settings for this tab. They are active in this daemon only; a restarted daemon will not keep them.');
  }
  return true;
}
// Absent means the caller never chose a mode, so confirm/prompt/beforeunload are dismissed (#658).
// Anything we cannot read fails closed the same way. Only an explicit accept record accepts.
export function savedDialogAccepts(record) {
  if (!record || record.status !== 'ok') return false;
  return record.dialog === 'accept';
}
export function environmentRestoreOutcome(saved) {
  if (!saved || saved.status === 'absent') {
    return {
      unreadable: false,
      dialog: 'dismiss',
      throttleProfile: 'off',
      throttleReset: false,
      mockCount: 0,
      mocksReset: false,
    };
  }
  if (saved.status !== 'ok') {
    return {
      unreadable: true,
      dialog: 'dismiss',
      throttleProfile: 'off',
      throttleReset: true,
      mockCount: 0,
      mocksReset: true,
    };
  }
  return {
    unreadable: false,
    dialog: saved.dialog === 'accept' ? 'accept' : 'dismiss',
    throttleProfile: saved.throttle?.profile || 'off',
    throttleReset: false,
    mockCount: Array.isArray(saved.mocks) ? saved.mocks.length : 0,
    mocksReset: false,
  };
}
export function formatDaemonRestartNotice(outcome = {}) {
  const dialogPart = outcome.unreadable
    ? 'dialog=dismiss (saved record unreadable)'
    : `dialog=${outcome.dialog === 'dismiss' ? 'dismiss' : 'accept'}`;
  const throttlePart = outcome.throttleReset
    ? 'throttle was reset'
    : `throttle=${outcome.throttleProfile || 'off'}`;
  let mockPart;
  if (outcome.unreadable) {
    mockPart = 'mocks were reset';
  } else {
    const count = Number(outcome.mockCount) || 0;
    const noun = count === 1 ? 'mock' : 'mocks';
    const verb = outcome.mocksReset ? (count === 1 ? 'was reset' : 'were reset') : 'restored';
    mockPart = `${count} ${noun} ${verb}`;
  }
  const netlogPart = outcome.netlogUnreadable
    ? 'netlog buffer was reset (saved record unreadable)'
    : formatRestoredCount(outcome.netlogCount, 'netlog entry', 'netlog entries');
  const actionPart = outcome.actionsUnreadable
    ? 'action log was reset (saved record unreadable)'
    : formatRestoredCount(outcome.actionCount, 'action', 'actions');
  return `${DAEMON_RESTART_NOTICE_PREFIX} ${dialogPart}, ${throttlePart}, ${mockPart}, ${netlogPart}, ${actionPart}`;
}
export function formatRestoredCount(count, one, many) {
  const n = Number.isInteger(count) && count > 0 ? count : 0;
  return `${n} ${n === 1 ? one : many} restored`;
}
export function observationNoticeFields(observation) {
  const unreadable = observation?.status === 'unreadable';
  return {
    netlogCount: Number.isInteger(observation?.netlogCount) ? observation.netlogCount : 0,
    netlogUnreadable: unreadable,
    actionCount: Number.isInteger(observation?.actionCount) ? observation.actionCount : 0,
    actionsUnreadable: unreadable,
  };
}
export function withObservationNotice(outcome, session) {
  return { ...(outcome || {}), ...observationNoticeFields(session?.observationRestore) };
}
export function netlogBufferForDisk(session) {
  const netReqBuf = session?.buffers?.network;
  if (!netReqBuf || typeof netReqBuf.all !== 'function') return netReqBuf;
  // Restored rows stay on disk until a main-frame navigation after this daemon is ready.
  // After that, save the same window `netlog` prints, so the next daemon does not bring them back.
  if (session.restoredNetlogHold === true) return netReqBuf;
  const lastNavigationTs = session.buffers?.navigation?.all?.().at(-1)?.ts ?? null;
  if (!Number.isFinite(Number(lastNavigationTs))) return netReqBuf;
  const visible = filterNetlogEntries(netReqBuf.all(), { lastNavigationTs, holdRestored: false });
  return { all: () => visible };
}
export function observationSnapshot(session) {
  return {
    actionSeq: Number.isInteger(session?.actionSeq) ? session.actionSeq : (session?.actionLog?.length || 0),
    actions: session?.actionLog || [],
    environment: session?.environmentLog || [],
    netlog: snapshotNetlogForDisk(netlogBufferForDisk(session), session?.netRequestStore),
  };
}
export function rememberTabObservation(session) {
  if (!session?.targetId || !session.runtimeDir) return false;
  try {
    const snapshot = observationSnapshot(session);
    const comparable = JSON.stringify({
      actionSeq: snapshot.actionSeq,
      actions: snapshot.actions,
      environment: snapshot.environment,
      netlog: snapshot.netlog,
    });
    if (session.observationComparable === comparable) return true;
    const saved = writeTabObservation(session.targetId, snapshot, { runtimeDir: session.runtimeDir });
    session.observationWriteFailed = !saved;
    if (saved) session.observationComparable = comparable;
    return saved;
  } catch {
    // A capture or action already happened. Saving it must not fail that command.
    session.observationWriteFailed = true;
    return false;
  }
}
export function restoreTabObservation(session) {
  if (!session || session.observationRestore?.applied === true) return session?.observationRestore || null;
  if (!session.runtimeDir || !session.targetId) {
    session.observationRestore = { applied: true, status: 'absent', netlogCount: 0, actionCount: 0, environmentCount: 0 };
    return session.observationRestore;
  }
  const saved = readTabObservation(session.targetId, { runtimeDir: session.runtimeDir });
  if (saved.status !== 'ok') {
    session.observationRestore = {
      applied: true,
      status: saved.status === 'unreadable' ? 'unreadable' : 'absent',
      netlogCount: 0,
      actionCount: 0,
      environmentCount: 0,
    };
    return session.observationRestore;
  }
  let loaded = false;
  if (!session.actionLog?.length && saved.actions.length) {
    session.actionLog = saved.actions;
    session.actionSeq = saved.actionSeq;
    loaded = true;
  }
  if (!session.environmentLog?.length && saved.environment.length) {
    session.environmentLog = saved.environment;
    loaded = true;
  }
  const netReqBuf = session.buffers?.network;
  const netlogWaiting = saved.netlog.entries.length > 0 && !(netReqBuf && typeof netReqBuf.all === 'function');
  let netlogCount = 0;
  if (netReqBuf && typeof netReqBuf.all === 'function' && netReqBuf.all().length === 0 && saved.netlog.entries.length) {
    const entries = saved.netlog.entries.map((entry, index) => restoredNetlogEntry(entry, index));
    if (typeof netReqBuf.load === 'function') netReqBuf.load(entries);
    else for (const entry of entries) netReqBuf.push(entry);
    netlogCount = netReqBuf.all().length;
    session.netRequestStore?.restore?.(saved.netlog.details, saved.netlog.nextId);
    if (netlogCount > 0) session.restoredNetlogHold = true;
  }
  if (loaded) session.observationLoaded = true;
  if (netlogWaiting) {
    session.observationRestore = {
      applied: false,
      status: 'ok',
      netlogCount: 0,
      actionCount: loaded ? (session.actionLog?.length || 0) : 0,
      environmentCount: loaded ? (session.environmentLog?.length || 0) : 0,
    };
    return session.observationRestore;
  }
  session.observationRestore = {
    applied: true,
    status: 'ok',
    netlogCount,
    actionCount: loaded ? (session.actionLog?.length || 0) : 0,
    environmentCount: loaded ? (session.environmentLog?.length || 0) : 0,
  };
  return session.observationRestore;
}
export function armDaemonRestartNotice(session, outcome, { restarted = false } = {}) {
  if (!session) return null;
  if (!restarted) {
    session.restartNotice = null;
    return null;
  }
  session.restartNotice = formatDaemonRestartNotice(outcome);
  return session.restartNotice;
}
export function resultLooksLikeJson(result) {
  const trimmed = String(result ?? '').trim();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}
export function applyDaemonRestartNotice(session, cmd, response) {
  if (!response || typeof response !== 'object') return response;
  const notice = session?.restartNotice;
  if (!notice) return response;
  if (RESTART_NOTICE_PROBE_COMMANDS.has(cmd)) return response;
  session.restartNotice = null;
  const next = { ...response, restartNotice: notice };
  if (typeof next.result === 'string' && !resultLooksLikeJson(next.result)) {
    next.result = next.result ? `${notice}\n${next.result}` : notice;
  } else if ((next.result == null || next.result === '') && typeof next.error === 'string' && !resultLooksLikeJson(next.error)) {
    next.error = `${notice}\n${next.error}`;
  }
  return next;
}
export async function applySavedNetworkControls(cdp, sid, session, saved) {
  const outcome = environmentRestoreOutcome(saved);
  if (!saved || saved.status !== 'ok') return outcome;
  if (saved.throttle) {
    try {
      const profile = { ...saved.throttle };
      await cdpDomains(cdp).Network.enable({}, sid);
      await cdpDomains(cdp).Network.emulateNetworkConditions(throttleCdpParams(profile), sid);
      session.networkThrottle = {
        ...profile,
        cdpParams: throttleCdpParams(profile),
        appliedAt: Date.now(),
      };
      outcome.throttleProfile = profile.profile;
    } catch {
      session.networkThrottle = null;
      outcome.throttleReset = true;
      outcome.throttleProfile = 'off';
    }
  }
  if (saved.mocks?.length) {
    session.networkMocks = saved.mocks.map(rule => ({ ...rule }));
    session.networkMockHits = [];
    try {
      await applyNetworkMocks(cdp, sid, session);
    } catch {
      session.networkMocks = [];
      session.networkMockHits = [];
      try { await cdpDomains(cdp).Fetch.disable({}, sid); } catch {}
      if (session.mockCacheDisabled) {
        try { await setMockCacheDisabled(cdp, sid, session, false); } catch {}
      }
      outcome.mocksReset = true;
    }
  }
  return outcome;
}
// Sets the dialog ref before its first await so a caller can register Page.javascriptDialogOpening
// while throttle and mocks are still being applied.
export async function applySavedTabEnvironment(cdp, sid, session, dialogAutoAcceptRef, {
  runtimeDir = session?.runtimeDir || RUNTIME_DIR,
  reader,
} = {}) {
  const saved = readTabEnvironment(session.targetId, { runtimeDir, ...(reader ? { reader } : {}) });
  const accept = savedDialogAccepts(saved);
  if (dialogAutoAcceptRef) dialogAutoAcceptRef.value = accept;
  if (session) session.dialogMode = accept ? 'accept' : 'dismiss';
  return applySavedNetworkControls(cdp, sid, session, saved);
}
export function emptyAliasStore() {
  return {
    schema: 'chrome-cdp-ex.aliases.v1',
    current: null,
    aliases: {},
  };
}
export function normalizeAliasName(name) {
  const value = String(name || '').trim();
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(value)) {
    throw new Error('alias name must start with a letter and contain only letters, numbers, dot, dash, or underscore');
  }
  return value;
}
export function normalizeAliasStore(raw) {
  const store = raw && typeof raw === 'object' ? raw : {};
  const aliases = {};
  for (const [name, alias] of Object.entries(store.aliases || {})) {
    if (!alias?.targetId) continue;
    aliases[name] = {
      name,
      targetId: String(alias.targetId),
      targetPrefix: String(alias.targetPrefix || alias.targetId).slice(0, 8),
      port: alias.port == null || alias.port === '' ? null : Number(alias.port),
      host: alias.host || null,
      url: alias.url || '',
      title: alias.title || '',
      createdAt: alias.createdAt || null,
      updatedAt: alias.updatedAt || null,
    };
  }
  const current = store.current && aliases[store.current] ? store.current : null;
  return { ...emptyAliasStore(), aliases, current };
}
export function readTargetAliases({ path = ALIASES_CACHE, reader = readFileSync } = {}) {
  try {
    return normalizeAliasStore(JSON.parse(reader(path, 'utf8')));
  } catch {
    return emptyAliasStore();
  }
}
export function writeTargetAliases(store, { path = ALIASES_CACHE, writer = writeFileSync } = {}) {
  const normalized = normalizeAliasStore(store);
  writer(path, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
  return normalized;
}
export function lastCdpEndpointPath(runtimeDir = RUNTIME_DIR) {
  return pathApiForRoot(runtimeDir).resolve(runtimeDir, LAST_CDP_ENDPOINT_FILE);
}
// One profile seen on one port. `via` is only ever the spawn-debug-browser marker (#416).
export function normalizeCdpEndpointHistoryEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const port = raw.port == null || raw.port === '' ? null : String(raw.port);
  const profileDir = raw.profileDir ? String(raw.profileDir) : null;
  if (!port || !profileDir) return null;
  const entry = {
    port,
    profileDir,
    exe: raw.exe ? String(raw.exe) : null,
    browser: raw.browser ? String(raw.browser).toLowerCase() : null,
    lastSeenAt: raw.lastSeenAt ? String(raw.lastSeenAt) : null,
  };
  if (raw.via === SPAWN_DEBUG_BROWSER_VIA) entry.via = SPAWN_DEBUG_BROWSER_VIA;
  // #426: the browser flags this profile was launched with, replayed by relaunch-same-profile.
  const launchFlags = replayableLaunchFlags(raw.launchFlags);
  if (launchFlags.length) entry.launchFlags = launchFlags;
  return entry;
}
export function mergeCdpEndpointHistoryEntry(a, b) {
  const [older, newer] = String(a.lastSeenAt || '') <= String(b.lastSeenAt || '') ? [a, b] : [b, a];
  return {
    ...older,
    ...newer,
    exe: newer.exe || older.exe,
    browser: newer.browser || older.browser,
    lastSeenAt: newer.lastSeenAt || older.lastSeenAt,
    ...((a.via || b.via) ? { via: SPAWN_DEBUG_BROWSER_VIA } : {}),
    // A sighting that could not read the command line must not erase flags recorded earlier.
    ...((newer.launchFlags || older.launchFlags) ? { launchFlags: newer.launchFlags || older.launchFlags } : {}),
  };
}
export function mergeCdpEndpointHistory(history, raw) {
  const list = (Array.isArray(history) ? history : []).map(normalizeCdpEndpointHistoryEntry).filter(Boolean);
  const entry = normalizeCdpEndpointHistoryEntry(raw);
  if (entry) {
    const at = list.findIndex(item => item.port === entry.port && cdpProfileKey(item.profileDir) === cdpProfileKey(entry.profileDir));
    if (at === -1) list.push(entry);
    else list[at] = mergeCdpEndpointHistoryEntry(list[at], entry);
  }
  // Keep persistent profiles over temp ones, so churn of test spawns cannot evict the real profile.
  list.sort((a, b) => (isTempCdpProfileDir(a.profileDir) - isTempCdpProfileDir(b.profileDir))
    || String(b.lastSeenAt || '').localeCompare(String(a.lastSeenAt || '')));
  // Bounded per port as well as overall, so one busy port cannot push out another port's profile.
  const perPort = new Map();
  return list.filter(item => {
    const n = (perPort.get(item.port) || 0) + 1;
    perPort.set(item.port, n);
    return n <= LAST_CDP_ENDPOINT_HISTORY_PER_PORT_MAX;
  }).slice(0, LAST_CDP_ENDPOINT_HISTORY_MAX);
}
export function normalizeLastCdpEndpoint(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const port = raw.port == null || raw.port === '' ? null : String(raw.port);
  const host = raw.host ? String(raw.host) : null;
  const profileDir = raw.profileDir ? String(raw.profileDir) : null;
  const exe = raw.exe ? String(raw.exe) : null;
  const browser = raw.browser ? String(raw.browser).toLowerCase() : null;
  const launchedAt = raw.launchedAt ? String(raw.launchedAt) : null;
  if (!port && !host && !profileDir) return null;
  const record = {
    schema: LAST_CDP_ENDPOINT_SCHEMA,
    host,
    port,
    profileDir,
    exe,
    browser,
    launchedAt,
  };
  if (profileDir && raw.via === SPAWN_DEBUG_BROWSER_VIA) record.via = SPAWN_DEBUG_BROWSER_VIA;
  const history = mergeCdpEndpointHistory(raw.history, null);
  if (history.length) record.history = history;
  return record;
}
export function readLastCdpEndpoint({ runtimeDir = RUNTIME_DIR, reader = readFileSync } = {}) {
  try {
    return normalizeLastCdpEndpoint(JSON.parse(reader(lastCdpEndpointPath(runtimeDir), 'utf8')));
  } catch {
    return null;
  }
}
export function writeLastCdpEndpoint(record, { runtimeDir = RUNTIME_DIR, writer = writeFileSync, now } = {}) {
  const launchedAt = record?.launchedAt
    || new Date(typeof now === 'function' ? now() : (now || Date.now())).toISOString();
  const normalized = normalizeLastCdpEndpoint({ ...record, launchedAt });
  if (!normalized) return null;
  try { mkdirSync(runtimeDir, { recursive: true, mode: 0o700 }); } catch {}
  writer(lastCdpEndpointPath(runtimeDir), `${JSON.stringify(normalized)}\n`, { mode: 0o600 });
  return normalized;
}
export function rememberLastCdpEndpoint(record, opts = {}) {
  const previous = opts.previous !== undefined ? opts.previous : readLastCdpEndpoint(opts);
  const next = { ...(previous || {}) };
  for (const [key, value] of Object.entries(record || {})) {
    if (value != null && value !== '' && key !== 'history' && key !== 'launchFlags') next[key] = value;
  }
  const portChanged = previous?.port && record?.port != null && String(previous.port) !== String(record.port);
  if (portChanged && !record.profileDir) next.profileDir = null;
  // Per-port profile history (#416): a later spawn on the same port must not erase the
  // persistent profile an earlier one used. An old flat record seeds the history once.
  let history = mergeCdpEndpointHistory(previous?.history, previous?.profileDir ? {
    port: previous.port,
    profileDir: previous.profileDir,
    exe: previous.exe,
    browser: previous.browser,
    via: previous.via,
    lastSeenAt: previous.launchedAt,
  } : null);
  const seenPort = record?.port ?? previous?.port;
  if (record?.profileDir && seenPort != null && seenPort !== '') {
    const at = new Date(typeof opts.now === 'function' ? opts.now() : (opts.now || Date.now())).toISOString();
    history = mergeCdpEndpointHistory(history, {
      port: seenPort,
      profileDir: record.profileDir,
      exe: record.exe,
      browser: record.browser,
      via: record.via,
      launchFlags: record.launchFlags,
      lastSeenAt: at,
    });
  }
  if (history.length) next.history = history;
  const current = next.profileDir
    ? history.find(item => item.port === String(next.port) && cdpProfileKey(item.profileDir) === cdpProfileKey(next.profileDir))
    : null;
  if (current?.via) next.via = current.via;
  else delete next.via;
  return writeLastCdpEndpoint(next, opts);
}
// A profile under a temp dir (or a disposable chrome-cdp-ex-* spawn dir) is a leftover of a test
// or one-off spawn, never the profile to recover a logged-in session into (#416).
// `tempRoot` overrides the system temp folder (tests).
export function isTempCdpProfileDir(profileDir, { tempRoot } = {}) {
  const normalized = String(profileDir || '').replace(/\\/g, '/');
  if (!normalized) return false;
  if (isIsolatedChromeCdpExProfileDir(normalized)) return true;
  if (/^\/(?:private\/)?tmp\//i.test(normalized) || /(?:^|\/)var\/folders\//i.test(normalized)) return true;
  if (/^[a-z]:\/(?:windows\/)?temp\//i.test(normalized) || /\/appdata\/local\/temp\//i.test(normalized)) return true;
  // Fallback: anything under the system temp folder (TMPDIR / TEMP pointing elsewhere).
  const root = tempRoot === undefined ? systemTempRootKey() : cdpProfileKey(tempRoot).toLowerCase();
  // A temp folder at a filesystem root (`/`, `c:/`) would make every profile temp: ignore it.
  if (!root || /^(?:[a-z]:)?\/$/.test(root)) return false;
  return cdpProfileKey(profileDir).toLowerCase().startsWith(root.endsWith('/') ? root : `${root}/`);
}
// Profiles plausibly behind `port`, best first: spawn-debug-browser-recorded persistent, other
// persistent, spawn-recorded temp, other temp; newest first inside a tier. Other ports never match.
export function rankCdpRelaunchCandidates(record, port, { display } = {}) {
  if (!record || typeof record !== 'object') return [];
  const want = port != null && port !== '' ? String(port) : null;
  const byDir = new Map();
  const add = raw => {
    // A record without a port keeps the old default of 9222 when the caller has no port either.
    const entryPort = raw?.port == null || raw.port === '' ? (want || '9222') : String(raw.port);
    const entry = normalizeCdpEndpointHistoryEntry({ ...raw, port: entryPort });
    if (!entry || (want && entry.port !== want)) return;
    const key = cdpProfileKey(entry.profileDir);
    const known = byDir.get(key);
    byDir.set(key, known ? mergeCdpEndpointHistoryEntry(known, entry) : entry);
  };
  for (const item of Array.isArray(record.history) ? record.history : []) add(item);
  if (record.profileDir) {
    add({
      port: record.port,
      profileDir: record.profileDir,
      exe: record.exe,
      browser: record.browser,
      via: record.via,
      lastSeenAt: record.launchedAt,
    });
  }
  const tier = entry => (isTempCdpProfileDir(entry.profileDir) ? 2 : 0) + (entry.via ? 0 : 1);
  return [...byDir.values()]
    .map(entry => ({ ...entry, temp: isTempCdpProfileDir(entry.profileDir) }))
    .sort((a, b) => tier(a) - tier(b) || String(b.lastSeenAt || '').localeCompare(String(a.lastSeenAt || '')))
    .map(entry => ({ ...entry, relaunch: formatCdpRelaunchCommand(entry, { port: want || entry.port, display }) }));
}
// One line naming the profiles that were not chosen; null when there is nothing to choose between.
export function formatCdpCandidateList(candidates) {
  if (!Array.isArray(candidates) || candidates.length < 2) return null;
  const label = c => `${c.profileDir} (${c.temp ? 'temp' : 'persistent'}${c.via ? ', spawn-debug-browser' : ''})`;
  return `Other profiles seen on this port: ${candidates.slice(1).map(label).join('; ')}. Use one only if the first is wrong.`;
}
export function shellQuoteCliArg(value) {
  const text = String(value ?? '');
  if (text === '') return "''";
  if (/^[A-Za-z0-9_./:=+-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}
// #615: flow and batch split on whitespace, so a quoted phrase was stored with the
// quote characters still in the value (`fill #note " "` became quote-space-quote).
// A quote starts a word only at a word boundary. Quotes inside a CSS token stay.
// An unmatched quote is an error (#641), not a silently truncated word.
// The default quote set is " and '. Flow passes backticks too; batch does not.
export function tokenizeCommandLine(input, quoteChars = '"\'') {
  const text = String(input ?? '');
  const tokens = [];
  let index = 0;
  while (index < text.length) {
    while (index < text.length && /\s/.test(text[index])) index += 1;
    if (index >= text.length) break;
    const quote = text[index];
    if (quoteChars.includes(quote)) {
      let cursor = index + 1;
      let value = '';
      let closed = false;
      while (cursor < text.length) {
        if (text[cursor] === quote) {
          closed = true;
          cursor += 1;
          break;
        }
        value += text[cursor];
        cursor += 1;
      }
      if (!closed) {
        const example = quote === '"' ? "'abc'" : quote === "'" ? '"abc"' : '"hello"';
        throw new Error(`unclosed quote: ${quote} has no closing ${quote}. Close it, for example ${example}.`);
      }
      tokens.push({ value, quoted: true });
      index = cursor;
      continue;
    }
    let raw = '';
    while (index < text.length && !/\s/.test(text[index])) {
      raw += text[index];
      index += 1;
    }
    tokens.push({ value: raw, quoted: false });
  }
  return tokens;
}
// Flow already treats a backtick as a step quote. In a non-script step that word
// is one argument with the backticks removed. Contents stay byte-exact:
// decodeQuotedFlowSemicolon has already turned `\;` into a semicolon, and every
// other backslash stays. Batch and standalone commands keep the default quote
// set, so a backtick there is still literal text.
export function tokenizeFlowCommandLine(input) {
  return tokenizeCommandLine(input, '"\'`');
}
// A quoted word that looks like a flag is text. `--` ends flag parsing for fill.
export function commandArgsFromTokens(tokens = []) {
  const args = [];
  for (const token of tokens) {
    if (token.quoted && String(token.value).startsWith('-')) args.push('--');
    args.push(token.value);
  }
  return args;
}
export function inferBrowserFromExe(exe) {
  const name = String(exe || '').toLowerCase();
  if (name.includes('msedge') || name.includes('edge')) return 'edge';
  if (name.includes('brave')) return 'brave';
  if (name.includes('chrom')) return 'chrome';
  return null;
}
export function isDisposableSpawnProfileDir(profileDir) {
  const normalized = String(profileDir || '').replace(/\\/g, '/');
  return /(?:^|\/)chrome-cdp-ex-[a-z0-9-]+-debug-profile-\d+$/i.test(normalized);
}
export function isIsolatedChromeCdpExProfileDir(profileDir) {
  const normalized = String(profileDir || '').replace(/\\/g, '/');
  if (!normalized) return false;
  if (isDisposableSpawnProfileDir(normalized)) return true;
  const leafLooksIsolated = /(?:^|\/)chrome-cdp-ex-[^/]+$/i.test(normalized);
  const inTemp = /(?:^|\/)tmp\//i.test(normalized)
    || /(?:^|\/)var\/folders\//i.test(normalized)
    || /(?:^|\/)Temp\//i.test(normalized);
  return leafLooksIsolated && inTemp;
}
export function isolatedOccupantAsk(environment, { port, profileDir } = {}, prefix = 'cdp') {
  const browser = preferredDebugBrowserName(environment);
  const resolvedPort = port || DEFAULT_DEBUG_PORT;
  const dir = profileDir ? ` (${profileDir})` : '';
  return `${resolvedPort} occupant${dir} is not the daily profile. Enable debug on the persistent daily ${browser} dir first (${defaultPersistentDailySpawnCommand(environment, prefix)}; ask first). Do not kill the occupant without asking. Or set CDP_PORT=${resolvedPort} to use this isolated window.`;
}
export function isolatedOccupantCdpCheck({ host, port, profileDir, environment } = {}) {
  const resolvedHost = host || DEFAULT_CDP_HOST;
  const resolvedPort = String(port || DEFAULT_DEBUG_PORT);
  return {
    status: 'FAIL',
    label: 'CDP',
    isolatedOccupant: true,
    host: resolvedHost,
    port: resolvedPort,
    profileDir: profileDir || null,
    detail: `${resolvedHost}:${resolvedPort} is an isolated chrome-cdp-ex profile (${profileDir}), not the daily Chrome`,
    hint: isolatedOccupantAsk(environment, { port: resolvedPort, profileDir }),
  };
}
export function isolatedOccupantAttachError({ host, port, profileDir } = {}) {
  const check = isolatedOccupantCdpCheck({ host, port, profileDir });
  const err = new Error(check.hint);
  err.code = 'cdp_isolated_occupant';
  err.host = check.host;
  err.port = check.port;
  err.profileDir = check.profileDir;
  err.isolatedOccupant = true;
  return err;
}
export async function inspectCdpOccupantProfileDirViaCdp({ host, port, connectWebSocket } = {}) {
  const argv = await readBrowserArgvViaCdp({ host, port, connectWebSocket });
  return argv ? profileDirFromCommandLine(argv) : null;
}
export async function resolveOccupantProfileDir({
  host,
  port,
  remembered,
  inspectOccupantProfileDir,
  connectWebSocket,
} = {}) {
  if (typeof inspectOccupantProfileDir === 'function') {
    return inspectOccupantProfileDir({ host, port, remembered });
  }
  if (process.env.NODE_ENV === 'test') {
    if (remembered?.profileDir && String(remembered.port) === String(port)) {
      return remembered.profileDir;
    }
    return null;
  }
  const live = await inspectCdpOccupantProfileDirViaCdp({ host, port, connectWebSocket });
  if (live) return live;
  if (remembered?.profileDir && String(remembered.port) === String(port)) {
    return remembered.profileDir;
  }
  return null;
}
export function replayableLaunchFlags(argv) {
  const flags = [];
  for (const raw of Array.isArray(argv) ? argv : []) {
    // First word only: a word of a title-joined command line can carry a trailing positional argument.
    const flag = String(raw ?? '').trim().split(/\s/)[0];
    if (CDP_REPLAY_FLAG.test(flag) && !flags.includes(flag)) flags.push(flag);
    if (flags.length >= CDP_REPLAY_FLAGS_MAX) break;
  }
  return flags;
}
export function cdpDisplayContext({ platform = process.platform, env = process.env } = {}) {
  return { platform, env };
}
// Linux with neither DISPLAY nor WAYLAND_DISPLAY: a headed browser aborts at once (#426).
export function displayNeedsHeadless(display) {
  return Boolean(display) && display.platform === 'linux' && !display.env?.DISPLAY && !display.env?.WAYLAND_DISPLAY;
}
export function relaunchFlagsFor(entry, display) {
  const flags = replayableLaunchFlags(entry?.launchFlags);
  if (displayNeedsHeadless(display) && !flags.some(flag => /^--headless(?:=|$)/i.test(flag))) flags.push('--headless=new');
  return flags;
}
// The same flags as spawn-debug-browser options, or null when one of them has no option there.
// The full anti-throttling set is what `--background` adds, so it maps back to `--background`, which
// also minimizes the window again (#438). --disable-backgrounding-occluded-windows alone is a spawn default
// (#488) and needs no option; any other partial set has no option and keeps the raw line.
export function spawnOptionsForLaunchFlags(flags) {
  const options = [];
  const throttle = new Set();
  for (const flag of flags) {
    const address = flag.match(/^--remote-debugging-address=(.+)$/i);
    if (address) {
      if (address[1] !== DEFAULT_CDP_HOST) options.unshift('--host', shellQuoteCliArg(address[1]));
    } else if (/^--headless(?:=new)?$/i.test(flag)) options.push('--headless');
    else if (/^--headless=/i.test(flag)) options.push(flag);
    else if (/^--(?:no-sandbox|disable-gpu)$/i.test(flag)) options.push(flag);
    else if (BACKGROUND_THROTTLE_FLAGS.includes(flag.toLowerCase())) throttle.add(flag.toLowerCase());
    else return null;
  }
  if (throttle.size === BACKGROUND_THROTTLE_FLAGS.length) options.push('--background');
  // --disable-backgrounding-occluded-windows alone is what spawn-debug-browser passes by default (#488).
  else if (throttle.size && !(throttle.size === 1 && throttle.has(OCCLUDED_WINDOWS_FLAG))) return null;
  return options;
}
// `display` ({ platform, env }) adds --headless=new where a headed browser cannot start; without it
// the command is built from the record alone.
export function formatCdpRelaunchCommand(lastEndpoint, { port, display } = {}) {
  const profileDir = lastEndpoint?.profileDir;
  if (!profileDir) return null;
  const resolvedPort = String(port || lastEndpoint.port || '9222');
  const flags = relaunchFlagsFor(lastEndpoint, display);
  const spawnOptions = spawnOptionsForLaunchFlags(flags);
  const viaSpawn = lastEndpoint.via === SPAWN_DEBUG_BROWSER_VIA;
  // A flag spawn-debug-browser cannot pass falls back to the raw browser line, so nothing is dropped.
  if (spawnOptions && (viaSpawn || isDisposableSpawnProfileDir(profileDir))) {
    const browser = lastEndpoint.browser || inferBrowserFromExe(lastEndpoint.exe) || 'chrome';
    const parts = [
      'cdp spawn-debug-browser',
      browser,
      '--port', resolvedPort,
      viaSpawn ? '--profile-dir' : '--user-data-dir', shellQuoteCliArg(profileDir),
    ];
    if (lastEndpoint.exe) parts.push('--exe', shellQuoteCliArg(lastEndpoint.exe));
    parts.push(...spawnOptions);
    return parts.join(' ');
  }
  const exe = lastEndpoint.exe || lastEndpoint.browser || 'chrome';
  return [
    shellQuoteCliArg(exe),
    `--remote-debugging-port=${resolvedPort}`,
    // Chromium reads `--user-data-dir DIR` as an empty switch plus a URL to open, and starts on another
    // profile; only the `=` form relaunches the same one (#426).
    shellQuoteCliArg(`--user-data-dir=${profileDir}`),
    ...flags.map(shellQuoteCliArg),
  ].join(' ');
}
// #594: a main-frame navigation cuts console and exception reads to the document
// that just committed. The ring still holds earlier entries so an action delta
// can report a throw that landed after its baseline and before the commit.
export const documentCutSeqs = new WeakMap();
export function consoleDocumentEntries(buf) {
  if (typeof buf?.since === 'function' && documentCutSeqs.has(buf)) return buf.since(documentCutSeqs.get(buf) || 0);
  if (typeof buf?.all === 'function') return buf.all();
  return [];
}
export function consoleDocumentSince(buf, seq) {
  if (typeof buf?.since !== 'function') return [];
  const cut = documentCutSeqs.has(buf) ? Number(documentCutSeqs.get(buf)) || 0 : 0;
  return buf.since(Math.max(Number(seq) || 0, cut));
}
export function cutDocumentConsoleBuffers(buffers) {
  if (!buffers) return;
  for (const buf of [buffers.console, buffers.exception]) {
    if (typeof buf?.latest === 'function') documentCutSeqs.set(buf, buf.latest());
  }
}
export function documentConsoleCutSeq(buf) {
  if (!buf || !documentCutSeqs.has(buf)) return null;
  return documentCutSeqs.get(buf);
}
export function cutDocumentConsoleBuffersAt(buffers, seqs = {}) {
  if (!buffers) return;
  if (buffers.console && seqs.console != null) documentCutSeqs.set(buffers.console, seqs.console);
  if (buffers.exception && seqs.exception != null) documentCutSeqs.set(buffers.exception, seqs.exception);
}
