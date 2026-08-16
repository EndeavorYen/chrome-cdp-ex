#!/usr/bin/env node
// cdp - lightweight Chrome DevTools Protocol CLI
// Uses raw CDP over WebSocket, no Puppeteer dependency.
// Requires Node 22+ (built-in WebSocket).
//
// Per-tab persistent daemon: page commands go through a daemon that holds
// the CDP session open. Chrome's "Allow debugging" modal fires once per
// daemon (= once per tab). Daemons auto-exit after 20min idle.

import { appendFileSync, readFileSync, writeFileSync, unlinkSync, existsSync, readdirSync, mkdirSync, lstatSync, realpathSync, statSync } from 'fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { homedir } from 'os';
import { dirname, resolve, delimiter } from 'path';
import { spawn, spawnSync } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import { format as formatValue } from 'util';
import { fileURLToPath } from 'url';
import net from 'net';
import { autoActionJsonArgs as autoActionJsonArgsForCommands } from './lib/action-evidence.mjs';
import {
  classifyRawCdpMethod,
  commandResult,
  createCommandExecutionContext,
  createCommandRegistry,
  defineCommandSpec,
  inspectCommandExecutionContext,
} from './lib/command-application.mjs';
import {
  createCommandDispatcher,
  inspectCommandDispatcher,
} from './lib/command-dispatch.mjs';
import { createDaemonReadHandlers } from './lib/daemon-read-handlers.mjs';
import { createDaemonActionHandlers } from './lib/daemon-action-handlers.mjs';
import { isTableCollectArgs, parseTableArgs, parseTableContinuationToken } from './lib/table-contract.mjs';
import { createTableArtifactStore } from './lib/table-artifacts.mjs';
import {
  addTableSampleBatch,
  buildTableExportBundle,
  canonicalizeTableCells,
  createTableAccumulator,
  finalizeTableExtraction,
  TABLE_EXTRACTION_LIMITS,
} from './lib/table-extraction.mjs';
import { buildTableSamplerExpression, parseTableSamplerResult } from './lib/table-sampler.mjs';
import {
  bindCdpTransport,
  createCdpDomains,
  createRawCdpGateway,
} from './lib/cdp-domains.mjs';
import {
  receiptForActionJson,
  receiptForReport,
} from './lib/action-receipt-surfaces.mjs';
import {
  actionFailureInput,
  actionFailureMessage,
  actionTargetCommandId,
  actionTargetCommandPrefix,
  buildActionRecoveryPlan,
  buildNoChangeOutcomeRecommendation,
  classifyActionFailure,
  formatActionFailure,
  actionFailurePage,
  isExpectedClipboardNoChange,
  isExpectedLeftoverAxScrollNoChange,
  isExpectedNoChange,
  expectedNoChangeReason,
  overlaySelectorArg,
  isTimeoutError,
  looksLikeClipboardControl,
  recoveryCommandsFromDiagnosis,
  uniqueNextStepCommands,
} from './lib/action-recovery.mjs';
import {
  createPerceptionModel,
  formatPerceptionJson,
  goldenPathActRecommendation,
  goldenPathBrowserPermissionRecommendation,
  goldenPathListRecommendation,
  goldenPathOpenPageRecommendation,
  goldenPathReadPageRecommendation,
} from './lib/perception-model.mjs';
import {
  CARDS_SCHEMA,
  buildCardsModel,
  formatCardsJson,
  formatCardsText,
} from './lib/cards-model.mjs';
import {
  buildReportRecommendation,
  defaultReportNextSteps,
  formatReportNextStepLines,
  formatReportRecommendationLines,
  normalizeReportTargetCommand,
} from './lib/session-report.mjs';
import {
  hasResponsiveFindings,
  normalizeResponsiveFindings,
} from './lib/responsive-audit.mjs';
import {
  screenshotHealthScript,
  unavailableScreenshotSanity,
} from './lib/screenshot-health.mjs';
import {
  classifyPageHealth,
  pageHealthScript,
} from './lib/page-health.mjs';
import {
  connectToDaemon,
  daemonEndpointForPlatform,
  ipcTimeoutForRequest,
  requestDaemon,
} from './lib/daemon-transport.mjs';
import {
  attachTargetResolutionDiagnostics,
  completeTargetResolution,
  resolveLiveTargetBinding,
} from './lib/target-binding.mjs';
import { createBrowserSupervisor } from './lib/browser-supervisor.mjs';
import { createLocatorPlan } from './lib/browser-resources.mjs';
import {
  COMMAND_SURFACE,
  isCommandSurface,
  projectCliCommands,
} from './lib/command-surface.mjs';
import {
  NODE22_MISSING_HINT,
  discoverNode22,
  formatNodeRerunCommand,
  nodeMajor,
  resolveChromeCdpNodeLaunch,
} from './lib/node-runtime.mjs';

const TIMEOUT = 15000;
const SCREENSHOT_TIMEOUT = 30000;
const QA_SCREENSHOT_TIMEOUT_MS = 2000;
const FULLSHOT_TIMEOUT_MS = 3000;
const VERIFY_CLICK_SETTLE_MS = 800;
const VERIFY_CLICK_REQUEST_WAIT_MS = 1000;
const NAVIGATION_TIMEOUT = 30000;
const RELOAD_EVENT_TIMEOUT = 1000;
const RELOAD_DISPATCH_TIMEOUT = 1000;
const RELOAD_READY_TIMEOUT = 1000;
const RELOAD_READY_PROBE_TIMEOUT = 500;
const RELOAD_OBSERVE_TIMEOUT = 2000;
const STATUS_PAGE_INFO_TIMEOUT = 500;
const REF_RESOLVE_TIMEOUT = 2000;
const HOVER_MOUSE_ACK_TIMEOUT_MS = 250;
const HOVER_MUTATION_TIMEOUT_MS = 3000;
const HOVER_MUTATION_MARKER = 'chrome-cdp-ex.hover-mutation.v1';
const CLICK_MOUSE_ACK_TIMEOUT_MS = 6000;
const CLICK_EVENT_PROBE_KEY = '__chromeCdpExClickProbe';
const LOADALL_DEFAULT_INTERVAL_MS = 1500;
const LOADALL_DEFAULT_TIMEOUT_MS = 30_000;
const LOADALL_MAX_TIMEOUT_MS = 5 * 60 * 1000;
const CLICK_NAVIGATION_WAIT_MS = 500;
const CLICK_HREF_PROBE_TIMEOUT_MS = 120;
const IDLE_TIMEOUT = 20 * 60 * 1000;
const daemonRequestStorage = new AsyncLocalStorage();
const FIRE_AND_FORGET_KEEPALIVE = 60 * 60 * 1000;
const DAEMON_CONNECT_RETRIES = 20;
const DAEMON_CONNECT_DELAY = 300;
const DAEMON_ALLOW_DELAY = 300;
const DEFAULT_OPEN_ATTACH_TIMEOUT_MS = 5000;
const DEFAULT_OPEN_READY_TIMEOUT_MS = 5000;
const MIN_TARGET_PREFIX_LEN = 8;
const MAX_ACTION_LOG_ENTRIES = 100;
const MAX_ENVIRONMENT_LOG_ENTRIES = 100;
const MAX_SCREENSHOT_ENTRIES = 100;
const MAX_NETWORK_MOCK_HITS = 50;
const IS_WINDOWS = process.platform === 'win32';
const RUNTIME_DIR = IS_WINDOWS
  ? resolve(process.env.LOCALAPPDATA || resolve(homedir(), 'AppData', 'Local'), 'cdp')
  : process.env.XDG_RUNTIME_DIR
    ? resolve(process.env.XDG_RUNTIME_DIR, 'cdp')
    : resolve(homedir(), '.cache', 'cdp');
const PAGES_CACHE = resolve(RUNTIME_DIR, 'pages.json');
const ALIASES_CACHE = resolve(RUNTIME_DIR, 'aliases.json');
const LAST_CDP_ENDPOINT_FILE = 'cdp-last-endpoint.json';
const LAST_CDP_ENDPOINT_SCHEMA = 'chrome-cdp-ex.cdp-last-endpoint.v1';
const DAEMON_METADATA_SCHEMA = 'chrome-cdp-ex.daemon-metadata.v1';
const ALLOW_STALE_DAEMON_FLAG = '--allow-stale-daemon';
const DEFAULT_CDP_HOST = '127.0.0.1';
const DEFAULT_SPAWN_READY_TIMEOUT_MS = 5000;
const TABLE_COLLECTION_DEADLINES = Object.freeze({
  pageMs: 295000,
  serverMs: 300000,
  maxCdpOperationMs: 5000,
});
const TRUSTED_DAEMON_REQUEST_CONTEXTS = new WeakSet();
const TABLE_COLLECTION_RUNTIME_STATES = new WeakMap();

class TableCollectionDeadlineError extends Error {
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

class TableCollectionOperationTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`table: CDP operation exceeded its ${timeoutMs}ms bounded timeout`);
    this.name = 'TableCollectionOperationTimeoutError';
    this.code = 'TABLE_COLLECTION_CDP_TIMEOUT';
    this.phase = 'page';
  }
}

class TableCollectionDaemonTerminationRequiredError extends Error {
  constructor() {
    super('table: server deadline reached with unsettled invoked work; daemon termination is required');
    this.name = 'TableCollectionDaemonTerminationRequiredError';
    this.code = 'TABLE_COLLECTION_DAEMON_TERMINATION_REQUIRED';
    this.phase = 'server';
    this.requiresDaemonTermination = true;
  }
}

class TableCollectionSynchronousCleanupRequiredError extends Error {
  constructor(cleanupScope) {
    super(`table: ${cleanupScope} cleanup must complete synchronously and return undefined`);
    this.name = 'TableCollectionSynchronousCleanupRequiredError';
    this.code = 'TABLE_COLLECTION_SYNC_CLEANUP_REQUIRED';
    this.cleanupScope = cleanupScope;
  }
}

function monotonicNow() {
  return performance.now();
}

function mintDaemonRequestExecutionContext({ signal, tableCollect, now }) {
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

function createDaemonRequestExecutionContext({ request, signal, now = monotonicNow }) {
  const tableCollect = request?.cmd === 'table'
    ? parseTableArgs(request.args || []).mode === 'collect'
    : false;
  return mintDaemonRequestExecutionContext({ signal, tableCollect, now });
}

function enforceDaemonTableCollectionGate(request, execution = null) {
  if (request?.cmd !== 'table') return;
  if (parseTableArgs(request.args || []).mode === 'collect' && !execution?.deadline) {
    throw new Error('table: trusted daemon request deadline context is required');
  }
}

function abortReason(signal, fallback = 'table: collection request aborted') {
  if (signal?.reason instanceof Error) return signal.reason;
  return new Error(signal?.reason == null ? fallback : String(signal.reason));
}

function daemonRequestAbortSignal() {
  return daemonRequestStorage.getStore()?.signal || null;
}

function throwIfRequestAborted(fallback = 'request aborted') {
  const signal = daemonRequestAbortSignal();
  if (signal?.aborted) throw abortReason(signal, fallback);
}

function daemonRequestHasUnsettledInvocations(executionContext) {
  return (TABLE_COLLECTION_RUNTIME_STATES.get(executionContext)?.ownedInvocations.size || 0) > 0;
}

function invokeSynchronousCleanup(cleanup, cleanupScope, args) {
  try {
    return cleanup(...args) === undefined
      ? null
      : new TableCollectionSynchronousCleanupRequiredError(cleanupScope);
  } catch (error) {
    return error;
  }
}

function retainFatalCleanupError(fatalError, cleanupError) {
  if (!cleanupError || cleanupError === fatalError) return;
  if (!Array.isArray(fatalError.cleanupErrors)) fatalError.cleanupErrors = [];
  if (fatalError.cleanupErrors.length < 16) fatalError.cleanupErrors.push(cleanupError);
}

function prepareDaemonCollectionFatal(executionContext, error) {
  const state = TABLE_COLLECTION_RUNTIME_STATES.get(executionContext);
  if (!state) return null;
  state.closePageWork?.();
  state.abortLifecycle?.(error);
  return state.startCleanup?.(error) || null;
}

function isDaemonTerminationRequired(error) {
  return error?.code === 'TABLE_COLLECTION_DAEMON_TERMINATION_REQUIRED'
    && error?.requiresDaemonTermination === true;
}

function createTableCollectionRuntime(executionContext, {
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

async function runTableCollectionLifecycle(executionContext, {
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

function validateDaemonProtocolRequest(input) {
  const request = snapshotApplicationDataObject(input, 'daemon request');
  const expectedKeys = new Set(['id', 'cmd', 'args']);
  for (const key of Object.keys(request)) {
    if (!expectedKeys.has(key)) throw new Error(`daemon request.${key}: is not allowed`);
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
  const frozenRequest = Object.freeze({
    id: request.id,
    cmd: request.cmd,
    args: Object.freeze(args),
  });
  const tableCollect = frozenRequest.cmd === 'table'
    ? parseTableArgs(frozenRequest.args).mode === 'collect'
    : false;
  return Object.freeze({ request: frozenRequest, tableCollect });
}

function createDaemonRequestConnection(conn, {
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
  let buffer = '';
  let disconnected = false;
  let poisoned = false;
  let disconnectNotified = false;

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

  const terminateForDuplicate = (id) => {
    const error = new Error(`Duplicate active request id: ${id}`);
    const unsafeCollect = [...active.values()].some(entry => (
      entry.execution.deadline
      && (!entry.handlerSettled || daemonRequestHasUnsettledInvocations(entry.execution))
    ));
    if (unsafeCollect) {
      terminateForFatal(new TableCollectionDaemonTerminationRequiredError());
      return;
    }
    for (const entry of [...active.values()]) disposeRequest(entry, { abort: error, clean: true });
    let payload = null;
    try { payload = responsePayload({ ok: false, error: error.message }, id); } catch {}
    if (payload && canWrite()) {
      try {
        if (typeof conn.end === 'function') conn.end(payload);
        else conn.write(payload);
      } catch {}
    }
    disconnected = true;
    removeConnectionListeners();
    try { onDisconnect(error); } catch {}
  };

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

  const onData = chunk => {
    if (disconnected) return;
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (disconnected) break;
      if (!line.trim()) continue;
      let req;
      try {
        req = JSON.parse(line);
      } catch {
        writeFailure(null, new Error('Invalid JSON request'));
        continue;
      }
      dispatch(req);
    }
  };
  function removeConnectionListeners() {
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

function createDaemonShutdown({
  requestConnections,
  getServer,
  socketPath,
  cleanupSession = () => {},
  closeCdp,
  exitProcess = code => process.exit(code),
  unlinkSocket = unlinkSync,
  isWindows = IS_WINDOWS,
}) {
  if (!(requestConnections instanceof Set)) throw new Error('daemon request connection registry must be a Set');
  if (typeof getServer !== 'function') throw new Error('daemon server accessor must be a function');
  if (typeof closeCdp !== 'function') throw new Error('daemon CDP closer must be a function');
  if (typeof cleanupSession !== 'function') throw new Error('daemon session cleanup must be a function');
  if (typeof exitProcess !== 'function') throw new Error('daemon process exit must be a function');
  if (typeof unlinkSocket !== 'function') throw new Error('daemon socket unlink must be a function');
  let alive = true;
  return (exitCode = 0) => {
    if (!alive) return;
    alive = false;
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
    try { getServer()?.close(); } catch {}
    if (!isWindows) try { unlinkSocket(socketPath); } catch {}
    try { closeCdp(); } catch {}
    exitProcess(finalExitCode);
  };
}

class RingBuffer {
  constructor(capacity) { this.buf = []; this.capacity = capacity; this.seq = 0; }
  push(entry) { entry._seq = ++this.seq; this.buf.push(entry); if (this.buf.length > this.capacity) this.buf.shift(); }
  since(seq) { return this.buf.filter(e => e._seq > seq); }
  all() { return [...this.buf]; }
  latest() { return this.seq; }
  clear() { this.buf.length = 0; }
}

function sockPath(targetId) {
  return daemonEndpointForPlatform(targetId, { runtimeDir: RUNTIME_DIR });
}

function ensureRuntimeDir() {
  try { mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 }); } catch {}
}

function emptyAliasStore() {
  return {
    schema: 'chrome-cdp-ex.aliases.v1',
    current: null,
    aliases: {},
  };
}

function normalizeAliasName(name) {
  const value = String(name || '').trim();
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(value)) {
    throw new Error('alias name must start with a letter and contain only letters, numbers, dot, dash, or underscore');
  }
  return value;
}

function normalizeAliasStore(raw) {
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

function readTargetAliases({ path = ALIASES_CACHE, reader = readFileSync } = {}) {
  try {
    return normalizeAliasStore(JSON.parse(reader(path, 'utf8')));
  } catch {
    return emptyAliasStore();
  }
}

function writeTargetAliases(store, { path = ALIASES_CACHE, writer = writeFileSync } = {}) {
  const normalized = normalizeAliasStore(store);
  writer(path, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
  return normalized;
}

function lastCdpEndpointPath(runtimeDir = RUNTIME_DIR) {
  return resolve(runtimeDir, LAST_CDP_ENDPOINT_FILE);
}

function normalizeLastCdpEndpoint(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const port = raw.port == null || raw.port === '' ? null : String(raw.port);
  const host = raw.host ? String(raw.host) : null;
  const profileDir = raw.profileDir ? String(raw.profileDir) : null;
  const exe = raw.exe ? String(raw.exe) : null;
  const browser = raw.browser ? String(raw.browser).toLowerCase() : null;
  const launchedAt = raw.launchedAt ? String(raw.launchedAt) : null;
  if (!port && !host && !profileDir) return null;
  return {
    schema: LAST_CDP_ENDPOINT_SCHEMA,
    host,
    port,
    profileDir,
    exe,
    browser,
    launchedAt,
  };
}

function readLastCdpEndpoint({ runtimeDir = RUNTIME_DIR, reader = readFileSync } = {}) {
  try {
    return normalizeLastCdpEndpoint(JSON.parse(reader(lastCdpEndpointPath(runtimeDir), 'utf8')));
  } catch {
    return null;
  }
}

function writeLastCdpEndpoint(record, { runtimeDir = RUNTIME_DIR, writer = writeFileSync, now } = {}) {
  const launchedAt = record?.launchedAt
    || new Date(typeof now === 'function' ? now() : (now || Date.now())).toISOString();
  const normalized = normalizeLastCdpEndpoint({ ...record, launchedAt });
  if (!normalized) return null;
  try { mkdirSync(runtimeDir, { recursive: true, mode: 0o700 }); } catch {}
  writer(lastCdpEndpointPath(runtimeDir), `${JSON.stringify(normalized)}\n`, { mode: 0o600 });
  return normalized;
}

function rememberLastCdpEndpoint(record, opts = {}) {
  const previous = opts.previous !== undefined ? opts.previous : readLastCdpEndpoint(opts);
  const next = { ...(previous || {}) };
  for (const [key, value] of Object.entries(record || {})) {
    if (value != null && value !== '') next[key] = value;
  }
  const portChanged = previous?.port && record?.port != null && String(previous.port) !== String(record.port);
  if (portChanged && !record.profileDir) next.profileDir = null;
  return writeLastCdpEndpoint(next, opts);
}

function shellQuoteCliArg(value) {
  const text = String(value ?? '');
  if (text === '') return "''";
  if (/^[A-Za-z0-9_./:=+-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function inferBrowserFromExe(exe) {
  const name = String(exe || '').toLowerCase();
  if (name.includes('msedge') || name.includes('edge')) return 'edge';
  if (name.includes('brave')) return 'brave';
  if (name.includes('chrom')) return 'chrome';
  return null;
}

function isDisposableSpawnProfileDir(profileDir) {
  const normalized = String(profileDir || '').replace(/\\/g, '/');
  return /(?:^|\/)chrome-cdp-ex-[a-z0-9-]+-debug-profile-\d+$/i.test(normalized);
}

function formatCdpRelaunchCommand(lastEndpoint, { port } = {}) {
  const profileDir = lastEndpoint?.profileDir;
  if (!profileDir) return null;
  const resolvedPort = String(port || lastEndpoint.port || '9222');
  if (isDisposableSpawnProfileDir(profileDir)) {
    const browser = lastEndpoint.browser || inferBrowserFromExe(lastEndpoint.exe) || 'chrome';
    const parts = [
      'cdp spawn-debug-browser',
      browser,
      '--port', resolvedPort,
      '--user-data-dir', shellQuoteCliArg(profileDir),
    ];
    if (lastEndpoint.exe) parts.push('--exe', shellQuoteCliArg(lastEndpoint.exe));
    return parts.join(' ');
  }
  const exe = lastEndpoint.exe || lastEndpoint.browser || 'chrome';
  return [
    shellQuoteCliArg(exe),
    `--remote-debugging-port=${resolvedPort}`,
    '--user-data-dir',
    shellQuoteCliArg(profileDir),
  ].join(' ');
}

function profileDirFromCommandLine(args) {
  const list = Array.isArray(args) ? args : [];
  for (let i = 0; i < list.length; i++) {
    const arg = String(list[i] ?? '');
    if (arg.startsWith('--user-data-dir=')) return arg.slice('--user-data-dir='.length) || null;
    if (arg === '--user-data-dir') return list[i + 1] ? String(list[i + 1]) : null;
  }
  return null;
}

function profileDirFromDevToolsActivePort(portFile) {
  if (!portFile) return null;
  const dir = dirname(String(portFile));
  return /(^|[\\/])Default$/.test(dir) ? dirname(dir) : dir;
}

function cdpUnreachableError({ host, port, cause, lastEndpoint } = {}) {
  const resolvedHost = host || lastEndpoint?.host || DEFAULT_CDP_HOST;
  const resolvedPort = port != null && port !== '' ? String(port) : (lastEndpoint?.port || null);
  const profileDir = lastEndpoint?.profileDir || null;
  const relaunch = formatCdpRelaunchCommand(lastEndpoint, { port: resolvedPort });
  const where = resolvedPort ? `${resolvedHost}:${resolvedPort}` : resolvedHost;
  const causeText = String(cause || 'unreachable').replace(/^Error:\s*/i, '');
  const message = profileDir
    ? `Cannot reach CDP on ${where} (${causeText}). Relaunch the same profile: ${relaunch}`
    : `Cannot reach CDP on ${where} (${causeText}). Profile is unknown — do not invent a new --user-data-dir. Enable remote debugging on the existing Chrome via chrome://inspect/#remote-debugging.`;
  const err = new Error(message);
  err.code = 'cdp_unreachable';
  err.host = resolvedHost;
  err.port = resolvedPort;
  err.profileDir = profileDir;
  err.relaunch = relaunch;
  return err;
}

function isCdpHttp404(error) {
  return Number(error?.status) === 404 || /^HTTP 404\b/i.test(String(error?.message || ''));
}

async function openCdpWebSocket(url, { timeoutMs = 2000, connectWebSocket } = {}) {
  if (typeof connectWebSocket === 'function') return connectWebSocket(url);
  const ws = new WebSocket(url);
  return new Promise((resolveWs, rejectWs) => {
    ws.onopen = () => { resolveWs(true); ws.close(); };
    ws.onerror = (err) => rejectWs(err);
    setTimeout(() => { ws.close(); rejectWs(new Error('WebSocket timeout')); }, timeoutMs);
  });
}

async function rememberLiveCdpEndpointFromSession(cdp, { host, port, env = process.env } = {}) {
  const resolvedHost = host || env.CDP_HOST || DEFAULT_CDP_HOST;
  const resolvedPort = port || env.CDP_PORT || null;
  let profileDir = null;
  let exe = null;
  try {
    const result = await cdpDomains(cdp).Browser.getBrowserCommandLine({}, undefined, 1000);
    const argv = result?.arguments || result?.Arguments || [];
    profileDir = profileDirFromCommandLine(argv);
    exe = argv[0] ? String(argv[0]) : null;
  } catch {}
  if (!resolvedPort && !profileDir) return null;
  try {
    return rememberLastCdpEndpoint({
      host: resolvedHost,
      port: resolvedPort,
      profileDir,
      exe,
      browser: inferBrowserFromExe(exe),
    });
  } catch {
    return null;
  }
}

function upsertTargetAlias(store = emptyAliasStore(), record = {}) {
  const normalized = normalizeAliasStore(store);
  const name = normalizeAliasName(record.name);
  if (!record.targetId) throw new Error('alias targetId is required');
  const now = new Date(record.now || Date.now()).toISOString();
  const previous = normalized.aliases[name] || {};
  normalized.aliases[name] = {
    name,
    targetId: String(record.targetId),
    targetPrefix: String(record.targetId).slice(0, 8),
    port: record.port == null || record.port === '' ? null : Number(record.port),
    host: record.host || null,
    url: record.url || previous.url || '',
    title: record.title || previous.title || '',
    createdAt: previous.createdAt || now,
    updatedAt: now,
  };
  normalized.current = name;
  return normalized;
}

function removeTargetAlias(store = emptyAliasStore(), name) {
  const normalized = normalizeAliasStore(store);
  const aliasName = normalizeAliasName(name);
  delete normalized.aliases[aliasName];
  if (normalized.current === aliasName) normalized.current = Object.keys(normalized.aliases)[0] || null;
  return normalized;
}

function aliasLookupKey(name) {
  return String(name || '').trim().replace(/^@+/, '');
}

function looksLikeHexTargetPrefix(token) {
  const key = aliasLookupKey(token);
  return key.length > 0 && /^[0-9A-Fa-f]+$/.test(key);
}

function looksLikeAliasToken(token) {
  const raw = String(token || '').trim();
  if (!raw) return false;
  if (raw.startsWith('@')) return true;
  const key = aliasLookupKey(raw);
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key)) return false;
  // Unique live target prefixes are hex of any length, including A–F starters
  // (F874, C48C). Named aliases still win when they actually exist.
  if (looksLikeHexTargetPrefix(key)) return false;
  return true;
}

function resolveTargetAlias(name, store = readTargetAliases()) {
  const key = aliasLookupKey(name);
  if (!key) return null;
  const normalized = normalizeAliasStore(store);
  if (key.toLowerCase() === 'current' && normalized.current) {
    return normalized.aliases[normalized.current] || null;
  }
  if (normalized.aliases[key]) return normalized.aliases[key];
  const found = Object.entries(normalized.aliases).find(([stored]) => stored.toLowerCase() === key.toLowerCase());
  return found ? found[1] : null;
}

function unknownAliasError(name) {
  const display = aliasLookupKey(name);
  const err = new Error(`unknown alias "@${display}". Run: cdp list / cdp current`);
  err.code = 'unknown_alias';
  err.aliasName = display;
  return err;
}

function forgetTargetAlias(store = emptyAliasStore(), name) {
  const existing = resolveTargetAlias(name, store);
  if (!existing) throw unknownAliasError(name);
  return {
    next: removeTargetAlias(store, existing.name),
    removed: existing,
  };
}

function aliasesForTarget(targetId, aliases = {}) {
  const id = String(targetId || '').toUpperCase();
  return Object.values(aliases || {})
    .filter(alias => {
      const aid = String(alias?.targetId || '').toUpperCase();
      return aid && (id === aid || id.startsWith(aid));
    })
    .map(alias => alias.name)
    .sort();
}

function aliasEnv(alias, baseEnv = process.env) {
  if (!alias?.port) return baseEnv;
  return {
    ...baseEnv,
    CDP_PORT: String(alias.port),
    ...(alias.host ? { CDP_HOST: alias.host } : {}),
  };
}

function discoverOptionsForTargetAlias(alias, baseEnv = process.env) {
  if (!alias?.port) return { env: baseEnv, pinCdpPort: false };
  return { env: aliasEnv(alias, baseEnv), pinCdpPort: true };
}

function selectLivePagesForAliasResolution({
  alias = null,
  discoveredPages = null,
} = {}) {
  if (!Array.isArray(discoveredPages)) {
    const hint = alias?.port
      ? ` on CDP port ${alias.port}`
      : '';
    throw new Error(`live target discovery is required before resolving an alias${hint}. Run: cdp list`);
  }
  return discoveredPages;
}

async function livePagesForTargetCommand(targetAlias, {
  discoverPages = discoverLivePagesForTargetResolution,
  env = process.env,
} = {}) {
  const discoveredPages = await discoverPages(discoverOptionsForTargetAlias(targetAlias, env));
  return selectLivePagesForAliasResolution({ alias: targetAlias, discoveredPages });
}

function bindAliasTargetFromPages(parsed = {}, livePages = []) {
  const requested = String(parsed?.targetId || '').trim();
  if (!requested) throw new Error(`${parsed?.mode || 'use'}: --target or target id is required`);
  const upper = requested.toUpperCase();
  const matches = (livePages || []).filter(page => String(page?.targetId || '').toUpperCase().startsWith(upper));
  if (matches.length === 1) {
    return {
      targetId: matches[0].targetId,
      url: matches[0].url || '',
      title: matches[0].title || '',
    };
  }
  if (parsed.port) {
    if (matches.length === 0) {
      throw new Error(`No live target matching prefix "${requested}" on CDP port ${parsed.port}. Run: cdp list`);
    }
    throw new Error(`Live target prefix "${requested}" is ambiguous (${matches.length} matches).`);
  }
  return { targetId: requested, url: '', title: '' };
}

async function bindAndSaveTargetAlias(parsed, {
  store = readTargetAliases(),
  discoverPages = discoverLivePagesForTargetResolution,
  writeStore = writeTargetAliases,
  env = process.env,
} = {}) {
  const attachEnv = parsed.port ? {
    ...env,
    CDP_PORT: String(parsed.port),
    CDP_HOST: parsed.host || env.CDP_HOST || DEFAULT_CDP_HOST,
  } : null;
  let targetId = parsed.targetId;
  let boundUrl = '';
  let boundTitle = '';
  try {
    const pages = await discoverPages({
      env: attachEnv || env,
      pinCdpPort: Boolean(parsed.port),
    });
    const bound = bindAliasTargetFromPages(parsed, pages);
    targetId = bound.targetId;
    boundUrl = bound.url;
    boundTitle = bound.title;
  } catch (error) {
    if (parsed.port) throw error;
  }
  const next = upsertTargetAlias(store, {
    name: parsed.name,
    targetId,
    port: parsed.port,
    host: parsed.host,
    url: boundUrl,
    title: boundTitle,
  });
  writeStore(next);
  return next;
}

const ALLOW_IN_CHROME_DAEMON_START = 'Daemon failed to start — did you click Allow in Chrome?';

function formatDaemonStartFailure({
  lastError = null,
  liveTargetPresent = false,
  targetId = null,
} = {}) {
  if (!liveTargetPresent) return ALLOW_IN_CHROME_DAEMON_START;
  const prefix = targetId ? String(targetId).slice(0, 8) : 'target';
  const cause = String(lastError?.message || lastError || 'socket never became ready').replace(/^Error:\s*/i, '');
  return `Daemon failed to start for ${prefix} (${cause}). The tab is already debuggable — this is not an Allow-in-Chrome prompt. Run: cdp list`;
}

function parseAliasCommandArgs(args = [], mode = 'use') {
  const fopts = parseFormatArgs(args, ['text', 'json']);
  const parsed = {
    mode,
    format: fopts.format,
    name: null,
    targetId: null,
    port: null,
    host: null,
  };
  const positional = [];
  for (let i = 0; i < fopts.args.length; i++) {
    const token = fopts.args[i];
    if (token === '--name' || token === '-n') parsed.name = fopts.args[++i] || null;
    else if (token === '--target' || token === '-t') parsed.targetId = fopts.args[++i] || null;
    else if (token === '--port' || token === '-p') parsed.port = Number(fopts.args[++i]);
    else if (token === '--host') parsed.host = fopts.args[++i] || null;
    else if (String(token).startsWith('--')) throw new Error(`${mode}: unknown argument ${token}`);
    else positional.push(token);
  }
  if (!parsed.targetId && positional[0]) {
    const slash = String(positional[0]).match(/^(\d+)\/(.+)$/);
    if (slash) {
      parsed.port = Number(slash[1]);
      parsed.targetId = slash[2];
    } else {
      parsed.targetId = positional[0];
    }
  }
  if (!parsed.name && mode === 'use') parsed.name = positional[1] || 'current';
  if (!parsed.name) throw new Error(`${mode}: --name is required`);
  if (!parsed.targetId) throw new Error(`${mode}: --target or target id is required`);
  if (parsed.port != null && (!Number.isInteger(parsed.port) || parsed.port <= 0 || parsed.port > 65535)) {
    throw new Error(`${mode}: --port must be a TCP port`);
  }
  return parsed;
}

function formatAliasRecord(alias, { format = 'text' } = {}) {
  if (format === 'json') return formatJson({ schema: 'chrome-cdp-ex.alias.v1', alias });
  const parts = [`Alias @${alias.name}: ${alias.targetPrefix}`];
  if (alias.port) parts.push(`CDP_PORT=${alias.port}`);
  if (alias.url) parts.push(alias.url);
  return parts.join('  ');
}

function formatCurrentAlias(store, { format = 'text' } = {}) {
  const normalized = normalizeAliasStore(store);
  const current = normalized.current ? normalized.aliases[normalized.current] : null;
  const aliases = Object.values(normalized.aliases).sort((left, right) => String(left.name).localeCompare(String(right.name)));
  if (format === 'json') {
    return formatJson({
      schema: 'chrome-cdp-ex.alias-current.v1',
      current: current || null,
      aliases,
    });
  }
  if (!aliases.length) return 'No current alias. Run: cdp use <target> --name app';
  const lines = [];
  if (current) lines.push(`Current ${formatAliasRecord(current)}`);
  else lines.push('No current alias. Run: cdp use <target> --name app');
  for (const alias of aliases) {
    if (current && alias.name === current.name) continue;
    lines.push(formatAliasRecord(alias));
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// tab-group / broadcast — multi-tab coordination
// ---------------------------------------------------------------------------

const TAB_GROUPS_CACHE = resolve(RUNTIME_DIR, 'tab-groups.json');

function emptyTabGroupStore() {
  return { schema: 'chrome-cdp-ex.tab-groups.v1', groups: {} };
}

function normalizeTabGroupName(name) {
  const value = String(name || '').trim();
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(value)) {
    throw new Error('tab-group name must start with a letter and contain only letters, numbers, dot, dash, or underscore');
  }
  return value;
}

function normalizeTabGroupStore(raw) {
  const store = raw && typeof raw === 'object' ? raw : {};
  const groups = {};
  for (const [name, group] of Object.entries(store.groups || {})) {
    if (!group) continue;
    const members = Array.isArray(group.members)
      ? [...new Set(group.members.map(m => String(m || '').trim()).filter(Boolean))]
      : [];
    groups[name] = {
      name,
      members,
      createdAt: group.createdAt || null,
      updatedAt: group.updatedAt || null,
    };
  }
  return { ...emptyTabGroupStore(), groups };
}

function readTabGroups({ path = TAB_GROUPS_CACHE, reader = readFileSync } = {}) {
  try {
    return normalizeTabGroupStore(JSON.parse(reader(path, 'utf8')));
  } catch {
    return emptyTabGroupStore();
  }
}

function writeTabGroups(store, { path = TAB_GROUPS_CACHE, writer = writeFileSync } = {}) {
  const normalized = normalizeTabGroupStore(store);
  writer(path, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
  return normalized;
}

function upsertTabGroup(store = emptyTabGroupStore(), { name, members = [], now = Date.now() } = {}) {
  const normalized = normalizeTabGroupStore(store);
  const groupName = normalizeTabGroupName(name);
  const previous = normalized.groups[groupName] || {};
  const ts = new Date(now).toISOString();
  const nextMembers = [...new Set([...(previous.members || []), ...members.map(String)])].filter(Boolean);
  normalized.groups[groupName] = {
    name: groupName,
    members: nextMembers,
    createdAt: previous.createdAt || ts,
    updatedAt: ts,
  };
  return normalized;
}

function removeTabGroupMember(store = emptyTabGroupStore(), name, member, { now = Date.now() } = {}) {
  const normalized = normalizeTabGroupStore(store);
  const groupName = normalizeTabGroupName(name);
  const group = normalized.groups[groupName];
  if (!group) throw new Error(`tab-group: unknown group "${groupName}"`);
  group.members = group.members.filter(m => m !== String(member));
  group.updatedAt = new Date(now).toISOString();
  return normalized;
}

function deleteTabGroup(store = emptyTabGroupStore(), name) {
  const normalized = normalizeTabGroupStore(store);
  const groupName = normalizeTabGroupName(name);
  if (!normalized.groups[groupName]) throw new Error(`tab-group: unknown group "${groupName}"`);
  delete normalized.groups[groupName];
  return normalized;
}

function getTabGroup(store = emptyTabGroupStore(), name) {
  const normalized = normalizeTabGroupStore(store);
  const groupName = normalizeTabGroupName(name);
  return normalized.groups[groupName] || null;
}

function parseTabGroupArgs(args = []) {
  const fopts = parseFormatArgs(args, ['text', 'json']);
  const [action, ...rest] = fopts.args;
  if (!action) throw new Error('tab-group: action required (list|create|add|remove|delete|show)');
  const actionName = String(action).toLowerCase();
  if (!['list', 'create', 'add', 'remove', 'delete', 'show'].includes(actionName)) {
    throw new Error(`tab-group: unknown action ${action}`);
  }
  return { format: fopts.format, action: actionName, args: rest };
}

function formatTabGroupStore(store, { format = 'text' } = {}) {
  const normalized = normalizeTabGroupStore(store);
  const groups = Object.values(normalized.groups).sort((a, b) => a.name.localeCompare(b.name));
  if (format === 'json') {
    return formatJson({
      schema: 'chrome-cdp-ex.tab-groups.v1',
      groupCount: groups.length,
      groups,
    });
  }
  if (!groups.length) return 'No tab groups. Create one: cdp tab-group create app <target> [<target>...]';
  return groups.map(g => `${g.name}  (${g.members.length})  ${g.members.join(', ') || '(empty)'}`).join('\n');
}

function formatTabGroup(group, { format = 'text' } = {}) {
  if (!group) throw new Error('tab-group: group required');
  if (format === 'json') return formatJson({ schema: 'chrome-cdp-ex.tab-group.v1', group });
  return [
    `Tab group: ${group.name}`,
    `Members (${group.members.length}): ${group.members.join(', ') || '(empty)'}`,
    group.updatedAt ? `Updated: ${group.updatedAt}` : null,
  ].filter(Boolean).join('\n');
}

function listKnownLiveTargetIds({
  listDaemons = listDaemonSockets,
  readPages = () => {
    if (!existsSync(PAGES_CACHE)) return [];
    try {
      const cached = JSON.parse(readFileSync(PAGES_CACHE, 'utf8'));
      return Array.isArray(cached) ? cached : cached.pages || [];
    } catch {
      return [];
    }
  },
} = {}) {
  const ids = new Set();
  for (const daemon of listDaemons() || []) {
    if (daemon?.targetId) ids.add(String(daemon.targetId));
  }
  for (const page of readPages() || []) {
    if (page?.targetId) ids.add(String(page.targetId));
  }
  return [...ids];
}

function resolveTabGroupMember(member, {
  targetIds = [],
  resolveAlias = resolveTargetAlias,
} = {}) {
  const raw = String(member || '').trim();
  if (!raw) throw new Error('tab-group: target required');
  const alias = resolveAlias(raw);
  const wanted = alias?.targetId || raw;
  const candidates = (targetIds || []).map(id => String(id));
  if (!candidates.length) {
    throw new Error(`No live target matching prefix "${raw}".`);
  }
  try {
    resolvePrefix(wanted, candidates, 'live target');
  } catch (error) {
    if (/ambiguous/i.test(error.message || '')) throw error;
    throw new Error(`No live target matching prefix "${raw}".`);
  }
  return raw;
}

function resolveTabGroupMembers(members = [], options = {}) {
  return members.map(member => resolveTabGroupMember(member, options));
}

function parseBroadcastArgs(args = []) {
  const fopts = parseFormatArgs(args, ['text', 'json']);
  const fullResults = fopts.args.includes('--full-results');
  const filtered = fopts.args.filter(arg => arg !== '--full-results');
  const [groupName, ...cmdParts] = filtered;
  if (!groupName) throw new Error('broadcast: group name required');
  if (!cmdParts.length) throw new Error('broadcast: command required (e.g. broadcast app perceive -C -d 4)');
  return {
    format: fopts.format,
    groupName: normalizeTabGroupName(groupName),
    command: cmdParts[0],
    commandArgs: cmdParts.slice(1),
    fullResults,
  };
}

function buildBroadcastModel({ groupName, command, commandArgs = [], results = [], fullResults = false } = {}) {
  const ok = results.filter(r => r.ok).length;
  const failed = results.length - ok;
  const boundedResults = results.map((entry) => {
    if (fullResults) return { ...entry };
    const { result, error, ...rest } = entry;
    const bounded = { ...rest };
    if (result != null) {
      const text = String(result);
      bounded.resultPreview = text.slice(0, 240);
      bounded.resultChars = text.length;
      bounded.resultTruncated = text.length > 240;
    }
    if (error != null) {
      const text = String(error);
      bounded.errorPreview = text.slice(0, 240);
      bounded.errorChars = text.length;
      bounded.errorTruncated = text.length > 240;
    }
    if (entry.completion === 'unknown') {
      bounded.completion = 'unknown';
      bounded.sideEffectMayHaveOccurred = entry.sideEffectMayHaveOccurred === true;
      bounded.retrySafe = false;
      if (entry.transportCause) bounded.transportCause = { ...entry.transportCause };
    }
    return bounded;
  });
  const failedResults = results.filter(result => !result.ok);
  return {
    schema: 'chrome-cdp-ex.broadcast.v1',
    group: groupName,
    command,
    commandArgs,
    fullResults,
    count: results.length,
    ok,
    failed,
    results: boundedResults,
    nextSteps: failed
      ? failedResults.slice(0, 3).map(result => result.completion === 'unknown'
          ? `cdp perceive ${result.targetPrefix} -C -d 8`
          : formatCommandLine(['cdp', command, result.targetPrefix, ...commandArgs]))
      : [`cdp tab-group show ${groupName}`],
  };
}

function formatBroadcastResult(model) {
  const lines = [
    `Broadcast ${model.group}: ${model.command} → ${model.ok}/${model.count} ok` +
      (model.failed ? `, ${model.failed} failed` : ''),
  ];
  for (const entry of model.results || []) {
    const head = entry.ok ? 'OK' : 'ERR';
    const preview = String(entry.result || entry.resultPreview || entry.error || entry.errorPreview || '').split('\n')[0].slice(0, 160);
    lines.push(`  [${head}] ${entry.targetPrefix}: ${preview}`);
  }
  return lines.join('\n');
}

function isBlankPageUrl(url = '') {
  const value = String(url || '').trim();
  return !value || value === 'about:blank' || value === 'about:srcdoc';
}

function isLicenseBlobUrl(url = '') {
  const path = String(url || '').split(/[?#]/)[0];
  return /\/blob\/[^/]+\/LICENSE(?:\.[A-Za-z0-9]+)?$/i.test(path)
    || /\/LICENSE(?:\.[A-Za-z0-9]+)?$/i.test(path);
}

function pageTargetScore(page = {}) {
  let score = 0;
  const url = page.url || '';
  const title = page.title || '';
  if (!isBlankPageUrl(url)) score += 100;
  if (title && title !== '(blank tab)') score += 20;
  if (/^https?:\/\//i.test(url)) score += 10;
  if (/^http:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/i.test(url)) score += 5;
  if (page.attached === true || page.attached === 1) score += 3;
  if (typeof page.lastAccessTime === 'number') score += Math.min(10, Math.floor(page.lastAccessTime / 1e12));
  if (isLicenseBlobUrl(url)) score -= 80;
  return score;
}

function rankPageTargets(pages = []) {
  return [...pages].sort((a, b) => {
    const scoreDiff = pageTargetScore(b) - pageTargetScore(a);
    if (scoreDiff !== 0) return scoreDiff;
    return String(a.targetId || '').localeCompare(String(b.targetId || ''));
  });
}

function pageMatchesUrl(page = {}, needle = '', { exact = false } = {}) {
  const url = String(page.url || '');
  const want = String(needle || '');
  if (!want) return false;
  if (exact) return url === want || url === want.replace(/\/$/, '') || url.replace(/\/$/, '') === want;
  return url.toLowerCase().includes(want.toLowerCase());
}

function pageMatchesTitle(page = {}, needle = '', { exact = false } = {}) {
  const title = String(page.title || '');
  const want = String(needle || '');
  if (!want) return false;
  if (exact) return title === want;
  return title.toLowerCase().includes(want.toLowerCase());
}

function matchPageTargets(pages = [], { url = null, title = null, exact = false } = {}) {
  return (pages || []).filter(page => {
    if (url && !pageMatchesUrl(page, url, { exact })) return false;
    if (title && !pageMatchesTitle(page, title, { exact })) return false;
    return true;
  });
}

function formatTargetCandidateLine(page, prefixLength = 8) {
  const prefix = String(page.targetId || '').slice(0, prefixLength);
  const title = isBlankPageUrl(page.url) ? '(blank tab)' : (page.title || '(untitled)');
  return `${prefix}  ${title}  ${page.url || ''}`;
}

function selectPageTarget(pages = [], opts = {}) {
  const { url = null, title = null, exact = false } = opts;
  if (!url && !title) {
    throw new Error('target: provide --url and/or --title to select a page');
  }
  const matches = matchPageTargets(pages, { url, title, exact });
  const ranked = rankPageTargets(matches);
  const prefixLength = getDisplayPrefixLength((pages || []).map(p => p.targetId || ''));
  if (ranked.length === 0) {
    const filters = [
      url ? `--url ${url}` : null,
      title ? `--title ${JSON.stringify(title)}` : null,
      exact ? '--exact' : null,
    ].filter(Boolean).join(' ');
    throw new Error(`target: no page matched ${filters}. Run: cdp list`);
  }
  if (ranked.length > 1) {
    const lines = ranked.slice(0, 8).map(page => `  ${formatTargetCandidateLine(page, prefixLength)}`);
    const more = ranked.length > lines.length ? `\n  … +${ranked.length - lines.length} more` : '';
    throw new Error([
      `target: ${ranked.length} pages matched; narrow with a more specific --url/--title or --exact`,
      'Candidates:',
      ...lines,
      more,
      `Follow-up: cdp list --format json`,
      `Or: cdp target --url <more-specific-url> --format json`,
    ].filter(Boolean).join('\n'));
  }
  const chosen = ranked[0];
  return {
    page: chosen,
    targetId: chosen.targetId,
    targetPrefix: String(chosen.targetId || '').slice(0, prefixLength),
    matchCount: 1,
    filters: { url, title, exact },
  };
}

function parseTargetSelectArgs(args = []) {
  const fopts = parseFormatArgs(args, ['text', 'json']);
  const parsed = {
    format: fopts.format,
    url: null,
    title: null,
    exact: false,
  };
  for (let i = 0; i < fopts.args.length; i++) {
    const token = fopts.args[i];
    if (token === '--url' || token === '-u') parsed.url = fopts.args[++i] || null;
    else if (token === '--title' || token === '-t') parsed.title = fopts.args[++i] || null;
    else if (token === '--exact') parsed.exact = true;
    else throw new Error(`target: unknown argument ${token}`);
  }
  if (!parsed.url && !parsed.title) throw new Error('target: provide --url and/or --title');
  return parsed;
}

function buildTargetSelectModel(selection, pages = []) {
  const page = selection.page || {};
  const prefixLength = getDisplayPrefixLength((pages || []).map(p => p.targetId || ''));
  const targetPrefix = selection.targetPrefix || String(selection.targetId || '').slice(0, prefixLength);
  const recommendation = goldenPathReadPageRecommendation(targetPrefix);
  return {
    schema: 'chrome-cdp-ex.target-select.v1',
    targetId: selection.targetId,
    targetPrefix,
    title: isBlankPageUrl(page.url) ? '(blank tab)' : (page.title || ''),
    url: page.url || '',
    isBlank: isBlankPageUrl(page.url),
    matchCount: selection.matchCount || 1,
    filters: selection.filters || {},
    recommendation,
    nextSteps: uniqueNextStepCommands([
      ...(recommendation.commands || []),
      `cdp use ${targetPrefix} --name app`,
    ]),
  };
}

function formatTargetSelect(selection, pages = [], { format = 'text' } = {}) {
  const model = buildTargetSelectModel(selection, pages);
  if (format === 'json') return formatJson(model);
  return [
    `Selected target: ${model.targetPrefix}`,
    `URL: ${model.url || '(unknown)'}`,
    `Title: ${model.title || '(untitled)'}`,
    `Next: ${model.nextSteps[0]}`,
  ].join('\n');
}

function parseQaModeArgs(args = [], allowed = ['text', 'json']) {
  const fopts = parseFormatArgs(args, allowed);
  let qa = false;
  let summary = false;
  let compact = false;
  let maxDiffLines = null;
  let maxControls = null;
  const next = [];
  for (let i = 0; i < fopts.args.length; i++) {
    const arg = fopts.args[i];
    if (arg === '--qa') qa = true;
    else if (arg === '--summary') summary = true;
    else if (arg === '--compact') compact = true;
    else if (arg === '--max-diff-lines') {
      maxDiffLines = parseNonNegativeInteger(fopts.args[++i], '--max-diff-lines');
    } else if (String(arg).startsWith('--max-diff-lines=')) {
      maxDiffLines = parseNonNegativeInteger(String(arg).slice('--max-diff-lines='.length), '--max-diff-lines');
    } else if (arg === '--max-controls') {
      maxControls = parseNonNegativeInteger(fopts.args[++i], '--max-controls');
    } else if (String(arg).startsWith('--max-controls=')) {
      maxControls = parseNonNegativeInteger(String(arg).slice('--max-controls='.length), '--max-controls');
    } else next.push(arg);
  }
  return {
    format: fopts.format,
    qa: qa || summary,
    summary: summary || qa,
    compact: compact || qa || summary,
    maxDiffLines,
    maxControls,
    args: next,
  };
}

function livePageIdentity({ page = {}, pageHealth = null, navigation = null } = {}) {
  const health = pageHealth?.evidence || {};
  let navTo = '';
  if (navigation && typeof navigation === 'object') {
    navTo = navigation.to || navigation.url || navigation.href || '';
  } else if (typeof navigation === 'string') {
    navTo = navigation;
  }
  return {
    url: String(health.url || navTo || page.url || ''),
    title: String(health.title || page.title || ''),
  };
}

function buildQaSummaryModel({
  page = {},
  console: consoleHealth = {},
  network = {},
  action = null,
  blank = null,
  pageHealth = null,
  navigation = null,
  nextCommand = null,
  targetPrefix = null,
  source = 'qa-summary',
} = {}) {
  const { url, title } = livePageIdentity({ page, pageHealth, navigation });
  const isBlank = pageHealth?.isBlank ?? (blank == null ? isBlankPageUrl(url) : Boolean(blank));
  const healthStatus = pageHealth?.status || (isBlank ? 'blank' : 'populated');
  const consoleErrors = Number(consoleHealth.errors || 0) + Number(consoleHealth.exceptions || 0);
  const networkFailures = Number(network.failures || 0);
  const changed = action?.outcome
    ? !['no-change', 'failed', 'timeout'].includes(action.outcome)
    : action?.changed;
  const changedStatus = changed == null ? 'unknown' : (changed ? 'changed' : 'no-change');
  const ok = healthStatus === 'populated' && consoleErrors === 0 && networkFailures === 0 && action?.dispatch?.ok !== false;
  return {
    schema: 'chrome-cdp-ex.qa-summary.v1',
    source,
    targetPrefix: targetPrefix || null,
    page: { url, title, isBlank, healthStatus },
    pageHealth: pageHealth || {
      status: healthStatus,
      isBlank,
      confidence: blank == null ? 'low' : 'medium',
      evidence: { url, title },
    },
    consoleErrors,
    networkFailures,
    changed: changedStatus,
    ok,
    nextCommand: nextCommand || (targetPrefix ? `cdp report ${targetPrefix}` : null),
  };
}

function formatQaSummaryText(model) {
  return [
    `QA summary: ${model.ok ? 'pass' : 'review'}`,
    `Page: ${model.page?.title || '(untitled)'}`,
    `URL: ${model.page?.url || '(unknown)'}${model.page?.isBlank ? ' (blank)' : ''}`,
    `Page health: ${model.page?.healthStatus || model.pageHealth?.status || 'indeterminate'}`,
    `Console errors: ${model.consoleErrors}`,
    `Network failures: ${model.networkFailures}`,
    `Changed: ${model.changed}`,
    model.nextCommand ? `Next: ${model.nextCommand}` : null,
  ].filter(Boolean).join('\n');
}

function truncateTextLines(text = '', maxLines = null) {
  if (maxLines == null || maxLines < 0) return String(text || '');
  const lines = String(text || '').split('\n');
  if (lines.length <= maxLines) return lines.join('\n');
  return [...lines.slice(0, maxLines), `… truncated ${lines.length - maxLines} lines`].join('\n');
}

// Browser metadata from /json/version — set when connecting via CDP_PORT
let _browserInfo = null;

async function getWsUrl({
  env = process.env,
  fetcher = fetch,
  lastEndpoint,
  readLastEndpoint = readLastCdpEndpoint,
  rememberEndpoint = rememberLastCdpEndpoint,
} = {}) {
  const host = env.CDP_HOST || DEFAULT_CDP_HOST;
  const remembered = lastEndpoint !== undefined ? lastEndpoint : readLastEndpoint();
  const rememberReachable = (record) => {
    try { rememberEndpoint(record); } catch {}
  };

  // CDP_PORT: explicit port (e.g. Electron with --remote-debugging-port=9222)
  if (env.CDP_PORT) {
    const port = env.CDP_PORT;
    let res;
    try {
      res = await fetcher(`http://${host}:${port}/json/version`, { signal: AbortSignal.timeout(3000) });
    } catch (e) {
      throw cdpUnreachableError({ host, port, cause: e?.message || e, lastEndpoint: remembered });
    }
    if (res.ok) {
      const info = await res.json();
      if (!info.webSocketDebuggerUrl) throw new Error(`CDP on port ${port}: /json/version has no webSocketDebuggerUrl`);
      _browserInfo = info;
      rememberReachable({ host, port });
      // Extract path only — don't trust the hostname in the response (may be "localhost"
      // while CDP_HOST points elsewhere, e.g. WSL2→Windows)
      const wsPath = new URL(info.webSocketDebuggerUrl).pathname;
      return `ws://${host}:${port}${wsPath}`;
    }
    // Chrome 136+ / SSH tunnel / websocket-only mode: HTTP discovery returns 404 but
    // direct WebSocket handshake to /devtools/browser still works. Do not fall back on
    // other HTTP failures — those usually mean a non-CDP service is bound to the port.
    if (res.status === 404) {
      rememberReachable({ host, port });
      return `ws://${host}:${port}/devtools/browser`;
    }
    throw cdpUnreachableError({ host, port, cause: `HTTP ${res.status}`, lastEndpoint: remembered });
  }

  // DevToolsActivePort file discovery (Chrome, Edge, Brave, etc.)
  const home = homedir();
  // macOS: ~/Library/Application Support/<name>/DevToolsActivePort
  const macBrowsers = [
    'Google/Chrome', 'Google/Chrome Beta', 'Google/Chrome for Testing',
    'Chromium', 'BraveSoftware/Brave-Browser', 'Microsoft Edge',
  ];
  // Linux: ~/.config/<name>/DevToolsActivePort
  const linuxBrowsers = [
    'google-chrome', 'google-chrome-beta', 'chromium',
    'vivaldi', 'vivaldi-snapshot',
    'BraveSoftware/Brave-Browser', 'microsoft-edge',
  ];
  // Windows: %LOCALAPPDATA%\<name>\User Data\DevToolsActivePort
  const winBrowsers = [
    'Google\\Chrome', 'Google\\Chrome Beta', 'Google\\Chrome for Testing',
    'Chromium', 'BraveSoftware\\Brave-Browser', 'Microsoft\\Edge',
  ];
  const localAppData = env.LOCALAPPDATA || process.env.LOCALAPPDATA || '';
  const candidates = [
    env.CDP_PORT_FILE || process.env.CDP_PORT_FILE,
    ...winBrowsers.flatMap(b => [
      resolve(localAppData, b, 'User Data', 'DevToolsActivePort'),
      resolve(localAppData, b, 'User Data', 'Default', 'DevToolsActivePort'),
    ]),
    ...macBrowsers.flatMap(b => [
      resolve(home, 'Library/Application Support', b, 'DevToolsActivePort'),
      resolve(home, 'Library/Application Support', b, 'Default/DevToolsActivePort'),
    ]),
    ...linuxBrowsers.flatMap(b => [
      resolve(home, '.config', b, 'DevToolsActivePort'),
      resolve(home, '.config', b, 'Default/DevToolsActivePort'),
    ]),
    // Linux Flatpak: ~/.var/app/<app-id>/config/<name>/DevToolsActivePort
    ...([
      ['org.chromium.Chromium', 'chromium'],
      ['com.google.Chrome', 'google-chrome'],
      ['com.brave.Browser', 'BraveSoftware/Brave-Browser'],
      ['com.microsoft.Edge', 'microsoft-edge'],
      ['com.vivaldi.Vivaldi', 'vivaldi'],
    ]).flatMap(([appId, name]) => [
      resolve(home, '.var/app', appId, 'config', name, 'DevToolsActivePort'),
      resolve(home, '.var/app', appId, 'config', name, 'Default/DevToolsActivePort'),
    ]),
  ].filter(Boolean);
  const portFile = candidates.find(p => existsSync(p));
  if (!portFile) {
    if (remembered?.profileDir) {
      throw cdpUnreachableError({
        host,
        port: remembered.port,
        cause: 'No DevToolsActivePort found and no CDP_PORT set',
        lastEndpoint: remembered,
      });
    }
    throw new Error('No DevToolsActivePort found and no CDP_PORT set.\n  Chrome: enable at chrome://inspect/#remote-debugging\n  Electron: set CDP_PORT=<port> (app must use --remote-debugging-port)');
  }
  const lines = readFileSync(portFile, 'utf8').trim().split('\n');
  if (lines.length < 2 || !lines[0] || !lines[1]) throw new Error(`Invalid DevToolsActivePort file: ${portFile}`);
  rememberReachable({
    host,
    port: lines[0],
    profileDir: profileDirFromDevToolsActivePort(portFile),
  });
  return `ws://${host}:${lines[0]}${lines[1]}`;
}

const sleep = (ms, signal = daemonRequestAbortSignal()) => {
  const wait = Math.max(0, Number(ms) || 0);
  if (signal?.aborted) throw abortReason(signal, 'request aborted');
  return new Promise((resolve, reject) => {
    if (!signal) {
      setTimeout(resolve, wait);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal, 'request aborted'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, wait);
    signal.addEventListener('abort', onAbort, { once: true });
  });
};

function parseDelayMs(value, { name = 'ms', min = 1, max = 24 * 60 * 60 * 1000 } = {}) {
  const raw = String(value ?? '').trim();
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a positive integer in milliseconds`);
  const ms = Number(raw);
  if (!Number.isSafeInteger(ms) || ms < min) throw new Error(`${name} must be at least ${min}ms`);
  if (ms > max) throw new Error(`${name} exceeds max ${max}ms`);
  return ms;
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${Number.isInteger(s) ? s : s.toFixed(1)}s`;
  const m = s / 60;
  if (m < 60) return `${Number.isInteger(m) ? m : m.toFixed(1)}m`;
  const h = m / 60;
  return `${Number.isInteger(h) ? h : h.toFixed(1)}h`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'n/a';
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${Number.isInteger(kib) ? kib : kib.toFixed(1)} KiB`;
  const mib = kib / 1024;
  return `${Number.isInteger(mib) ? mib : mib.toFixed(1)} MiB`;
}

function parseFormatArgs(args, allowed = ['text', 'json']) {
  const next = [];
  let format = 'text';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--format') {
      const value = args[++i];
      if (!allowed.includes(value)) {
        throw new Error(`format must be ${allowed.join(' or ')}`);
      }
      format = value;
    } else {
      next.push(args[i]);
    }
  }
  return { format, args: next };
}

function parseCompactFormatArgs(args, allowed = ['text', 'json']) {
  const fopts = parseFormatArgs(args, allowed);
  let compact = false;
  let qa = false;
  let full = false;
  let maxDiffLines = null;
  const next = [];
  for (let i = 0; i < fopts.args.length; i++) {
    const arg = fopts.args[i];
    if (arg === '--compact') compact = true;
    else if (arg === '--full' || arg === '--unsafe-full') full = true;
    else if (arg === '--qa' || arg === '--summary') {
      qa = true;
      compact = true;
    } else if (arg === '--max-diff-lines') {
      maxDiffLines = parseNonNegativeInteger(fopts.args[++i], '--max-diff-lines');
    } else if (String(arg).startsWith('--max-diff-lines=')) {
      maxDiffLines = parseNonNegativeInteger(String(arg).slice('--max-diff-lines='.length), '--max-diff-lines');
    } else next.push(arg);
  }
  return { format: fopts.format, compact, qa, full, maxDiffLines, args: next };
}

function formatJson(model) {
  return JSON.stringify(model, null, 2);
}

function safeLstat(path) {
  try { return lstatSync(path); } catch { return null; }
}

function findNearestPackageJson(startDir = process.cwd()) {
  let dir = resolve(startDir || process.cwd());
  for (let i = 0; i < 12; i++) {
    const candidate = resolve(dir, 'package.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (!parent || parent === dir) break;
    dir = parent;
  }
  return null;
}

function readPackageVersion(packageJsonPath) {
  if (!packageJsonPath) return null;
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    return typeof parsed.version === 'string' && parsed.version.trim() ? parsed.version.trim() : null;
  } catch {
    return null;
  }
}

function currentGitCommit(cwd) {
  try {
    const res = spawnSync('git', ['-C', cwd || process.cwd(), 'rev-parse', '--short=12', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const commit = String(res.stdout || '').trim();
    return res.status === 0 && commit ? commit : null;
  } catch {
    return null;
  }
}

function resolveScriptIdentityPath(scriptPath) {
  if (!scriptPath) return null;
  try {
    return realpathSync(scriptPath);
  } catch {
    return resolve(scriptPath);
  }
}

function collectDaemonMetadata({ scriptPath = process.argv[1], now = Date.now(), pid = process.pid } = {}) {
  // Identity must follow the installed/invoked script, never the agent's cwd checkout.
  const resolvedScriptPath = resolveScriptIdentityPath(scriptPath);
  const scriptStats = resolvedScriptPath ? safeLstat(resolvedScriptPath) : null;
  const packageJsonPath = resolvedScriptPath
    ? findNearestPackageJson(dirname(resolvedScriptPath))
    : null;
  const gitCwd = packageJsonPath ? dirname(packageJsonPath) : null;
  return {
    schema: DAEMON_METADATA_SCHEMA,
    scriptPath: resolvedScriptPath,
    scriptMtimeMs: scriptStats ? scriptStats.mtimeMs : null,
    packageVersion: readPackageVersion(packageJsonPath),
    gitCommit: gitCwd ? currentGitCommit(gitCwd) : null,
    pid,
    startedAt: new Date(now).toISOString(),
  };
}

function comparableMetadataValue(value) {
  return value !== null && value !== undefined && value !== '' && value !== 'unknown';
}

function assessDaemonFreshness({ targetPrefix = '', expectedTargetId = null, current = null, daemon = null } = {}) {
  const displayTarget = targetPrefixForDisplay(targetPrefix);
  if (!daemon || daemon.schema !== DAEMON_METADATA_SCHEMA) {
    return {
      stale: true,
      status: 'missing-metadata',
      targetPrefix: displayTarget,
      current,
      daemon,
      mismatches: [{ field: 'metadata', daemon: null, current: 'available' }],
    };
  }

  const fields = ['gitCommit', 'packageVersion', 'scriptPath', 'scriptMtimeMs'];
  const mismatches = [];
  for (const field of fields) {
    const daemonValue = daemon[field];
    const currentValue = current?.[field];
    if (!comparableMetadataValue(daemonValue) || !comparableMetadataValue(currentValue)) continue;
    if (daemonValue !== currentValue) {
      mismatches.push({ field, daemon: daemonValue, current: currentValue });
    }
  }
  const versionSame = comparableMetadataValue(daemon.packageVersion)
    && comparableMetadataValue(current?.packageVersion)
    && daemon.packageVersion === current.packageVersion;
  if (versionSame) {
    const remaining = mismatches.filter(mismatch => mismatch.field !== 'scriptPath');
    if (remaining.length !== mismatches.length) mismatches.splice(0, mismatches.length, ...remaining);
  }

  if (expectedTargetId && daemon.boundTargetId && daemon.boundTargetId !== expectedTargetId) {
    mismatches.push({ field: 'boundTargetId', daemon: daemon.boundTargetId, current: expectedTargetId });
  }

  const targetMismatch = mismatches.some(mismatch => mismatch.field === 'boundTargetId');

  return {
    stale: mismatches.length > 0,
    status: targetMismatch ? 'target-mismatch' : mismatches.length > 0 ? 'stale' : 'current',
    targetPrefix: displayTarget,
    current,
    daemon,
    mismatches,
  };
}

function metadataCommit(metadata) {
  return metadata?.gitCommit || 'unknown';
}

function formatStaleDaemonMessage(assessment = {}) {
  const target = assessment.targetPrefix || '<target>';
  const currentCommit = metadataCommit(assessment.current);
  const stopCommand = `cdp stop ${target}`;
  if (assessment.status === 'target-mismatch') {
    const bound = assessment.daemon?.boundTargetId || 'unknown';
    const expected = assessment.mismatches?.find(mismatch => mismatch.field === 'boundTargetId')?.current || target;
    return `Target binding mismatch for ${target}: daemon is bound to ${bound}, resolved live target is ${expected}. Run "${stopCommand}" then retry so the daemon can rebind.`;
  }
  if (assessment.status === 'missing-metadata') {
    return `Stale daemon for ${target}: daemon metadata missing, current commit ${currentCommit}. Run "${stopCommand}" then rerun the command. If this long-running daemon is intentional, rerun once with ${ALLOW_STALE_DAEMON_FLAG}.`;
  }

  const daemonCommit = metadataCommit(assessment.daemon);
  const pid = assessment.daemon?.pid ? `, pid ${assessment.daemon.pid}` : '';
  const mismatchText = Array.isArray(assessment.mismatches) && assessment.mismatches.length
    ? ` Mismatched metadata: ${assessment.mismatches.map(m => `${m.field} daemon=${m.daemon} current=${m.current}`).join(', ')}.`
    : '';
  return `Stale daemon for ${target}: daemon commit ${daemonCommit}, current commit ${currentCommit}${pid}.${mismatchText} Run "${stopCommand}" then rerun the command. If this long-running daemon is intentional, rerun once with ${ALLOW_STALE_DAEMON_FLAG}.`;
}

function parseDaemonMetadataResult(result) {
  if (!result) return null;
  if (typeof result === 'object') return result;
  try {
    return JSON.parse(String(result));
  } catch {
    return null;
  }
}

async function waitStr(msArg) {
  const ms = parseDelayMs(msArg, { name: 'wait duration', max: 60 * 60 * 1000 });
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    await sleep(Math.min(250, deadline - Date.now()));
  }
  return `Waited ${formatDuration(ms)}`;
}

function listDaemonSockets() {
  if (IS_WINDOWS) {
    // Named pipes aren't in filesystem; probe pipes for known targets from pages cache
    try {
      const cached = JSON.parse(readFileSync(PAGES_CACHE, 'utf8'));
      return (Array.isArray(cached) ? cached : cached.pages || []).map(p => ({
        targetId: p.targetId,
        socketPath: sockPath(p.targetId),
      }));
    } catch { return []; }
  }
  try {
    return readdirSync(RUNTIME_DIR)
      .filter(f => f.startsWith('cdp-') && f.endsWith('.sock'))
      .map(f => ({
        targetId: f.slice(4, -5),
        socketPath: resolve(RUNTIME_DIR, f),
      }));
  } catch { return []; }
}

function resolvePrefix(prefix, candidates, noun = 'target', missingHint = '') {
  const upper = prefix.toUpperCase();
  const matches = candidates.filter(candidate => candidate.toUpperCase().startsWith(upper));
  if (matches.length === 0) {
    const hint = missingHint ? ` ${missingHint}` : '';
    throw new Error(`No ${noun} matching prefix "${prefix}".${hint}`);
  }
  if (matches.length > 1) {
    throw new Error(`Ambiguous prefix "${prefix}" — matches ${matches.length} ${noun}s. Use more characters.`);
  }
  return matches[0];
}

function getDisplayPrefixLength(targetIds) {
  if (targetIds.length === 0) return MIN_TARGET_PREFIX_LEN;
  const maxLen = Math.max(...targetIds.map(id => id.length));
  for (let len = MIN_TARGET_PREFIX_LEN; len <= maxLen; len++) {
    const prefixes = new Set(targetIds.map(id => id.slice(0, len).toUpperCase()));
    if (prefixes.size === targetIds.length) return len;
  }
  return maxLen;
}

// ---------------------------------------------------------------------------
// CDP WebSocket client
// ---------------------------------------------------------------------------

class CDP {
  #ws; #id = 0; #pending = new Map(); #eventHandlers = new Map(); #closeHandlers = []; #opened = false;

  #failPending(select, createError) {
    for (const [id, entry] of [...this.#pending]) {
      if (select && !select(entry)) continue;
      this.#pending.delete(id);
      entry.reject(createError(entry));
    }
  }

  #failPendingOnClose(event) {
    const code = event?.code;
    const reason = event?.reason;
    const detail = [
      code != null && code !== '' ? `code=${code}` : null,
      reason ? `reason=${reason}` : null,
    ].filter(Boolean).join(', ');
    const suffix = detail ? ` (${detail})` : '';
    this.#failPending(null, entry =>
      new Error(`CDP websocket closed while waiting for ${entry.method}${suffix}`)
    );
    for (const handler of this.#closeHandlers) handler();
  }

  #failPendingOnDetach(msg) {
    const reason = msg?.params?.reason || 'unknown';
    const sessionId = msg?.sessionId;
    this.#failPending(
      sessionId ? entry => entry.sessionId === sessionId : null,
      entry => new Error(`CDP Inspector.detached while waiting for ${entry.method} (reason=${reason})`)
    );
  }

  async connect(wsUrl) {
    return new Promise((res, rej) => {
      this.#ws = new WebSocket(wsUrl);
      this.#ws.onopen = () => {
        this.#opened = true;
        res();
      };
      this.#ws.onerror = (e) => {
        if (!this.#opened) {
          rej(new Error('WebSocket error: ' + (e.message || e.type)));
          return;
        }
        this.#failPending(null, entry =>
          new Error(`CDP websocket closed while waiting for ${entry.method}`)
        );
      };
      this.#ws.onclose = (event) => this.#failPendingOnClose(event);
      this.#ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.method === 'Inspector.detached') this.#failPendingOnDetach(msg);
        if (msg.id && this.#pending.has(msg.id)) {
          const { resolve, reject } = this.#pending.get(msg.id);
          this.#pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message));
          else resolve(msg.result);
        } else if (msg.method && this.#eventHandlers.has(msg.method)) {
          for (const handler of [...this.#eventHandlers.get(msg.method)]) {
            handler(msg.params || {}, msg);
          }
        }
      };
    });
  }

  send(method, params = {}, sessionId, timeoutMs = TIMEOUT) {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      let timer;
      this.#pending.set(id, {
        method,
        sessionId,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      const msg = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      try {
        this.#ws.send(JSON.stringify(msg));
      } catch {
        this.#pending.delete(id);
        reject(new Error(`CDP websocket closed while waiting for ${method}`));
        return;
      }
      timer = setTimeout(() => {
        if (this.#pending.has(id)) {
          this.#pending.delete(id);
          reject(new Error(`Timeout: ${method}`));
        }
      }, timeoutMs);
    });
  }

  onEvent(method, handler) {
    if (!this.#eventHandlers.has(method)) this.#eventHandlers.set(method, new Set());
    const handlers = this.#eventHandlers.get(method);
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.#eventHandlers.delete(method);
    };
  }

  waitForEvent(method, timeout = TIMEOUT) {
    let settled = false;
    let off;
    let offClose;
    let timer;
    const promise = new Promise((resolve, reject) => {
      off = this.onEvent(method, (params) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off();
        offClose?.();
        resolve(params);
      });
      offClose = this.onClose(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off();
        reject(new Error(`CDP websocket closed while waiting for event: ${method}`));
      });
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        off();
        offClose?.();
        reject(new Error(`Timeout waiting for event: ${method}`));
      }, timeout);
    });
    return {
      promise,
      cancel() {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off?.();
        offClose?.();
      },
    };
  }

  onClose(handler) {
    this.#closeHandlers.push(handler);
    return () => {
      const index = this.#closeHandlers.indexOf(handler);
      if (index >= 0) this.#closeHandlers.splice(index, 1);
    };
  }
  close() { this.#ws.close(); }
}

const CDP_DOMAIN_CLIENTS = new WeakMap();

function cdpDomains(cdp) {
  let clients = CDP_DOMAIN_CLIENTS.get(cdp);
  if (!clients) {
    clients = createCdpDomains(bindCdpTransport(cdp));
    CDP_DOMAIN_CLIENTS.set(cdp, clients);
  }
  return clients;
}

// ---------------------------------------------------------------------------
// Command implementations — return strings, take (cdp, sessionId)
// ---------------------------------------------------------------------------

async function getPages(cdp) {
  const { targetInfos } = await cdpDomains(cdp).Target.getTargets();
  // Keep regular page targets, including about:blank so agents always have a
  // usable handle. Skip chrome://, edge://, and devtools:// internal pages.
  return targetInfos.filter(t => t.type === 'page'
    && !t.url.startsWith('chrome://')
    && !t.url.startsWith('edge://')
    && !t.url.startsWith('devtools://'));
}

function formatPageList(pages, browserInfo = null, opts = {}) {
  const aliases = opts.aliases || {};
  const ranked = opts.ranked === false ? pages : rankPageTargets(pages);
  const lines = [];
  if (browserInfo) {
    const ua = browserInfo['User-Agent'] || '';
    const m = ua.match(/Electron\/([\d.]+)/);
    if (m) lines.push(`[Electron ${m[1]}]`);
  }
  const prefixLen = getDisplayPrefixLength(ranked.map(p => p.targetId));
  const recommendedId = (rankPageTargets(pages).find(p => !isBlankPageUrl(p.url)) || ranked[0])?.targetId;
  lines.push(...ranked.map(p => {
    const id = p.targetId.slice(0, prefixLen).padEnd(prefixLen);
    const isBlank = isBlankPageUrl(p.url);
    const rawTitle = isBlank ? '(blank tab)' : (p.title || '');
    const title = rawTitle.substring(0, 54).padEnd(54);
    const aliasNames = aliasesForTarget(p.targetId, aliases);
    const aliasSuffix = aliasNames.length ? `  ${aliasNames.map(name => `@${name}`).join(' ')}` : '';
    const rec = p.targetId === recommendedId ? ' *' : '';
    return `${id}  ${title}  ${p.url || ''}${aliasSuffix}${rec}`;
  }));
  return lines.join('\n');
}

function pageListBrowserModel(browserInfo = null) {
  if (!browserInfo) return null;
  const ua = browserInfo['User-Agent'] || '';
  const electron = ua.match(/Electron\/([\d.]+)/)?.[1] || null;
  return {
    product: browserInfo.Browser || browserInfo.product || null,
    userAgent: ua || null,
    electron,
  };
}

function buildPageListModel(pages = [], browserInfo = null, opts = {}) {
  const aliases = opts.aliases || {};
  const ranked = rankPageTargets(pages);
  const prefixLength = getDisplayPrefixLength(pages.map(p => p.targetId || ''));
  const modelPages = ranked.map((p, index) => {
    const isBlank = isBlankPageUrl(p.url);
    return {
      index: index + 1,
      targetId: p.targetId || '',
      targetPrefix: String(p.targetId || '').slice(0, prefixLength),
      type: p.type || 'page',
      title: isBlank ? '(blank tab)' : (p.title || ''),
      url: p.url || '',
      isBlank,
      score: pageTargetScore(p),
      recommended: false,
      aliases: aliasesForTarget(p.targetId || '', aliases),
    };
  });
  const recommendedPage = modelPages.find(page => !page.isBlank) || modelPages[0];
  if (recommendedPage) recommendedPage.recommended = true;
  const recommendation = recommendedPage
    ? goldenPathListRecommendation()
    : goldenPathOpenPageRecommendation();
  const nextSteps = recommendation.commands;
  return {
    schema: 'chrome-cdp-ex.list.v1',
    targetCount: modelPages.length,
    prefixLength,
    browser: pageListBrowserModel(browserInfo),
    pages: modelPages,
    recommended: recommendedPage
      ? {
          targetId: recommendedPage.targetId,
          targetPrefix: recommendedPage.targetPrefix,
          url: recommendedPage.url,
          title: recommendedPage.title,
          score: recommendedPage.score,
        }
      : null,
    aliases: Object.values(aliases).map(alias => ({ ...alias })),
    recommendation,
    nextSteps,
  };
}

function formatPageListOutput(pages, browserInfo = null, { format = 'text', aliases = {} } = {}) {
  if (format === 'json') return formatJson(buildPageListModel(pages, browserInfo, { aliases }));
  return formatPageList(pages, browserInfo, { aliases });
}

function shouldShowAxNode(node, compact = false, parentNode = null) {
  const role = node.role?.value || '';
  const name = axNodeAccessibleName(node);
  const value = node.value?.value;
  if (compact && role === 'InlineTextBox') return false;
  // In compact mode, filter StaticText that duplicates parent's name
  if (compact && role === 'StaticText' && parentNode) {
    const parentName = axNodeAccessibleName(parentNode);
    if (parentName && parentName.includes(name)) return false;
  }
  if (role === 'none' || role === 'generic') return false;
  // Unnamed empty textboxes/checkboxes/radios are still actionable. Filtering
  // them left Interactive counts advertising controls that had no @ref.
  if (INTERACTIVE_ROLES.has(role)) return true;
  return !(name === '' && (value === '' || value == null));
}

function axNodeTokenState(node, name) {
  const direct = node?.[name];
  if (direct && typeof direct === 'object' && 'value' in direct) {
    if (direct.value === '' || direct.value == null) return '';
    return String(direct.value);
  }
  if (typeof direct === 'boolean' || typeof direct === 'number' || typeof direct === 'string') {
    return String(direct);
  }
  return axPropertyValue(node, name);
}

function formatAxNode(node, depth) {
  const role = node.role?.value || '';
  const name = axNodeAccessibleName(node);
  const value = node.value?.value;
  const indent = '  '.repeat(Math.min(depth, 10));
  let line = `${indent}[${role}]`;
  if (name !== '') line += ` ${name}`;
  if (!(value === '' || value == null)) line += ` = ${JSON.stringify(value)}`;
  const checked = axNodeTokenState(node, 'checked');
  if (checked !== '') line += ` checked=${checked}`;
  const selected = axNodeTokenState(node, 'selected');
  if (selected === 'true') line += ' selected';
  else if (selected && selected !== 'false' && selected !== '') line += ` selected=${selected}`;
  return line;
}

const PERCEIVE_PRIORITY_TEXT_RE = /\b(error|failed?|failure|invalid|required|warning|blocked|denied|unauthori[sz]ed|forbidden|saved|success|submitted|complete)\b/i;

function isPriorityPerceiveTextLine(line) {
  return PERCEIVE_PRIORITY_TEXT_RE.test(String(line || ''));
}

function orderedAxChildren(node, nodesById, childrenByParent) {
  const children = [];
  const seen = new Set();
  for (const childId of node.childIds || []) {
    const child = nodesById.get(childId);
    if (child && !seen.has(child.nodeId)) {
      seen.add(child.nodeId);
      children.push(child);
    }
  }
  for (const child of childrenByParent.get(node.nodeId) || []) {
    if (!seen.has(child.nodeId)) {
      seen.add(child.nodeId);
      children.push(child);
    }
  }
  return children;
}

async function snapshotStr(cdp, sid, compact = false, extra = {}) {
  const targetPrefix = extra.targetPrefix || '<target>';
  await assertNotPdfViewerPage(cdp, sid, { targetPrefix });
  const { nodes } = await cdpDomains(cdp).Accessibility.getFullAXTree( {}, sid);
  const nodesById = new Map(nodes.map(node => [node.nodeId, node]));
  const childrenByParent = new Map();
  for (const node of nodes) {
    if (!node.parentId) continue;
    if (!childrenByParent.has(node.parentId)) childrenByParent.set(node.parentId, []);
    childrenByParent.get(node.parentId).push(node);
  }

  const lines = [];
  const visited = new Set();
  function visit(node, depth, parentNode = null) {
    if (!node || visited.has(node.nodeId)) return;
    visited.add(node.nodeId);
    if (shouldShowAxNode(node, compact, parentNode)) lines.push(formatAxNode(node, depth));
    for (const child of orderedAxChildren(node, nodesById, childrenByParent)) {
      visit(child, depth + 1, node);
    }
  }

  const roots = nodes.filter(node => !node.parentId || !nodesById.has(node.parentId));
  for (const root of roots) visit(root, 0);
  for (const node of nodes) visit(node, 0);

  lines.push('');
  lines.push('(Hint: `snap` gives only the raw AX tree. Use `perceive` instead for layout, @refs, style hints, and console health — it is the recommended starting command.)');
  return lines.join('\n');
}

// Decode a base64-encoded eval expression. Used by `eval64` and `eval --b64`
// so agents can ship CJK / Unicode / shell-hostile expressions without losing
// bytes to the surrounding shell quoting rules. We validate eagerly because a
// silently-corrupted expression would still compile and could match the wrong
// elements — better to surface a base64 error than to evaluate garbage.
function evalBase64Decode(b64) {
  if (b64 == null || b64 === '') {
    throw new Error('eval --b64: empty expression. Pass a base64-encoded JS expression.');
  }
  if (typeof b64 !== 'string') {
    throw new Error('eval --b64: expression must be a base64 string');
  }
  const cleaned = b64.replace(/\s+/g, '');
  // Charset check is intentionally loose on `=` so a misplaced pad falls
  // through to the dedicated padding check below with a clearer message.
  if (!/^[A-Za-z0-9+/=]+$/.test(cleaned)) {
    throw new Error('eval --b64: invalid base64 input (only A-Z, a-z, 0-9, +, /, = are allowed)');
  }
  // Standard base64 must be a multiple of 4 chars after padding, and `=`
  // padding may only appear at the very end. Node's Buffer base64 decoder is
  // intentionally lenient (it silently drops trailing junk), so without these
  // checks a corrupted or truncated payload would decode to a partial JS
  // expression and run as if it were the agent's intent.
  if (cleaned.length % 4 !== 0) {
    throw new Error(`eval --b64: invalid base64 length (${cleaned.length} chars; must be a multiple of 4 with = padding)`);
  }
  const padIdx = cleaned.indexOf('=');
  if (padIdx !== -1 && padIdx < cleaned.length - 2) {
    throw new Error('eval --b64: invalid base64 padding (= may only appear as the last 1-2 chars)');
  }
  if (padIdx === cleaned.length - 2 && cleaned[cleaned.length - 1] !== '=') {
    // e.g. "AB=Y" — first `=` at -2 but final char is not `=`; means body
    // starts after a single trailing pad, which is also illegal.
    throw new Error('eval --b64: invalid base64 padding (= may only appear as the last 1-2 chars)');
  }
  let decoded;
  try {
    decoded = Buffer.from(cleaned, 'base64').toString('utf8');
  } catch (e) {
    throw new Error(`eval --b64: cannot decode base64 (${e.message})`);
  }
  if (!decoded) {
    throw new Error('eval --b64: decoded expression is empty');
  }
  // Round-trip guard: re-encoding the decoded bytes must reproduce the
  // canonical input. This catches cases where the lenient Node decoder
  // accepted bytes it should not have (e.g. a tail char that does not align
  // to a 6-bit boundary), which would otherwise yield a silently-truncated
  // expression. We compare to the original `cleaned` form so legitimate
  // whitespace in the wire format is still tolerated.
  const reencoded = Buffer.from(decoded, 'utf8').toString('base64');
  if (reencoded !== cleaned) {
    throw new Error('eval --b64: input is not canonical base64 (decoder dropped bytes — payload may be truncated or corrupt)');
  }
  return decoded;
}

function runtimeExceptionMessage(exceptionDetails) {
  const text = exceptionDetails?.text;
  const description = exceptionDetails?.exception?.description;
  if (description && (text === 'Uncaught' || text === 'Uncaught (in promise)' || !text)) return description;
  return text || description || 'Unknown runtime exception';
}

function formatEvalValue(val, { raw = false } = {}) {
  // Preserve historical evalStr behavior: undefined prints as empty string.
  if (val === undefined) return '';
  if (val === null) return 'null';
  if (typeof val !== 'object') return String(val);
  // Default: pretty multi-line JSON for agents. --raw keeps a compact single-line encoding.
  return raw ? JSON.stringify(val) : JSON.stringify(val, null, 2);
}

function lastTopLevelSemicolon(source) {
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  let depth = 0;
  let last = -1;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    const next = source[i + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        i++;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      i++;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      i++;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '(' || char === '[' || char === '{') depth++;
    else if (char === ')' || char === ']' || char === '}') depth = Math.max(0, depth - 1);
    else if (char === ';' && depth === 0) last = i;
  }
  return last;
}

function codeWithoutStringsAndComments(source) {
  let output = '';
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    const next = source[i + 1];
    if (lineComment) {
      if (char === '\n') {
        lineComment = false;
        output += '\n';
      } else output += ' ';
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        output += '  ';
        blockComment = false;
        i++;
      } else output += char === '\n' ? '\n' : ' ';
      continue;
    }
    if (quote) {
      output += char === '\n' ? '\n' : ' ';
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '/' && next === '/') {
      output += '  ';
      lineComment = true;
      i++;
      continue;
    }
    if (char === '/' && next === '*') {
      output += '  ';
      blockComment = true;
      i++;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      output += ' ';
      quote = char;
      continue;
    }
    output += char;
  }
  return output;
}

function hasExplicitReturnStatement(source) {
  return /(?:^|[;{}:])\s*return\b/.test(codeWithoutStringsAndComments(source));
}

function wrapAwaitExpression(expression, autoWrap = false) {
  const source = String(expression || '');
  if (!autoWrap || !/\bawait\b/.test(source)) return source;
  if (!source.includes(';') && !source.includes('\n')) return `(async()=>(${source}))()`;
  if (hasExplicitReturnStatement(source)) return `(async()=>{${source}})()`;

  const trimmed = source.replace(/;\s*$/, '').trimEnd();
  const separator = lastTopLevelSemicolon(trimmed);
  if (separator < 0) {
    throw new Error('eval: multi-statement async input is ambiguous; add an explicit return for the desired result.');
  }
  const prefix = trimmed.slice(0, separator + 1);
  const finalExpression = trimmed.slice(separator + 1).trim();
  if (!finalExpression) {
    throw new Error('eval: multi-statement async input is ambiguous; add an explicit return for the desired result.');
  }
  const wrapped = `(async()=>{${prefix} return (${finalExpression});})()`;
  try {
    // Syntax-check only; the returned function is never invoked here.
    new Function(`return ${wrapped}`);
  } catch {
    throw new Error('eval: cannot infer the final async expression safely; add an explicit return for the desired result.');
  }
  return wrapped;
}

async function evalStr(cdp, sid, expression, autoWrap = false, options = {}) {
  const expr = wrapAwaitExpression(expression, autoWrap);
  const params = {
    expression: expr, returnByValue: true, awaitPromise: true,
  };
  if (options.contextId != null) params.contextId = options.contextId;
  if (options.uniqueContextId != null) params.uniqueContextId = options.uniqueContextId;
  const result = await cdpDomains(cdp).Runtime.evaluate( params, sid, options.timeoutMs);
  if (result.exceptionDetails) {
    throw new Error(runtimeExceptionMessage(result.exceptionDetails));
  }
  const val = result.result.value;
  return formatEvalValue(val, { raw: options.raw === true });
}

function maybeAutoWrapEval(expression, autoWrap = false) {
  return wrapAwaitExpression(expression, autoWrap);
}

async function evalFireAndForgetStr(cdp, sid, expression, autoWrap = false) {
  if (!expression) throw new Error('Expression required');
  await cdpDomains(cdp).Runtime.evaluate( {
    expression: maybeAutoWrapEval(expression, autoWrap),
    returnByValue: false,
    awaitPromise: false,
  }, sid);
  return 'Dispatched fire-and-forget eval (not awaiting returned promise)';
}

function formatCallResult(remote) {
  if (!remote) return '';
  if (Object.prototype.hasOwnProperty.call(remote, 'value')) {
    if (remote.value === undefined) return 'undefined';
    const json = JSON.stringify(remote.value, null, 2);
    return json === undefined ? String(remote.value) : json;
  }
  if (remote.unserializableValue != null) return String(remote.unserializableValue);
  return remote.description ?? '';
}

async function callStr(cdp, sid, expression) {
  if (!expression) throw new Error('Expression required');
  const wrapped = `(async () => {
    const value = (${expression});
    let result = (typeof value === 'function') ? value() : value;
    return await result;
  })()`;
  const result = await cdpDomains(cdp).Runtime.evaluate( {
    expression: wrapped,
    returnByValue: true,
    awaitPromise: true,
  }, sid);
  if (result.exceptionDetails) {
    throw new Error(runtimeExceptionMessage(result.exceptionDetails));
  }
  return formatCallResult(result.result);
}

function parseEvalArgs(args) {
  const opts = { expression: '', fireAndForget: false, raw: false };
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--fire-and-forget' || a === '--faf') opts.fireAndForget = true;
    else if (a === '--raw') opts.raw = true;
    else if (a === '--b64' || a === '-b') {
      const b64 = (args[++i] || '').trim();
      if (!b64) throw new Error('eval --b64: empty expression. Pass a base64-encoded JS expression.');
      opts.expression = evalBase64Decode(b64);
    } else if (a === '--format' || a === '--compact' || String(a).startsWith('--')) {
      throw new Error(`eval: unknown argument ${a}`);
    } else {
      rest.push(a);
    }
  }
  if (!opts.expression) opts.expression = rest.join(' ');
  if (!opts.expression) throw new Error('Expression required');
  return opts;
}

function normalizeEvalCliArgs(args = []) {
  const fireAndForget = args.includes('--fire-and-forget') || args.includes('--faf');
  const raw = args.includes('--raw');
  const ignored = new Set(['--fire-and-forget', '--faf', '--raw']);
  const prefix = [
    ...(fireAndForget ? ['--fire-and-forget'] : []),
    ...(raw ? ['--raw'] : []),
  ];
  for (const arg of args) {
    if (ignored.has(arg) || arg === '--b64' || arg === '-b') continue;
    if (arg === '--format' || arg === '--compact' || String(arg).startsWith('--')) {
      throw new Error(`eval: unknown argument ${arg}`);
    }
  }
  const b64Index = args.findIndex(arg => arg === '--b64' || arg === '-b');
  if (b64Index !== -1) {
    const b64 = args.slice(b64Index + 1)
      .filter(arg => !ignored.has(arg) && !String(arg).startsWith('--'))
      .join('')
      .trim();
    if (!b64) throw new Error('base64 expression required');
    return [...prefix, '--b64', b64];
  }
  const expression = args.filter(arg => !ignored.has(arg)).join(' ').trim();
  if (!expression) throw new Error('expression required');
  return [...prefix, expression];
}

// ---------------------------------------------------------------------------
// emulate: media feature overrides (dark/light, reduced-motion, ...)
// ---------------------------------------------------------------------------

function emptyEmulateState() {
  return {
    schema: 'chrome-cdp-ex.emulate.v1',
    colorScheme: null,
    reducedMotion: null,
    features: [],
  };
}

function parseEmulateArgs(args = []) {
  const fopts = parseFormatArgs(args, ['text', 'json']);
  const opts = {
    format: fopts.format,
    mode: 'status',
    colorScheme: null,
    reducedMotion: null,
  };
  const tokens = fopts.args;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === 'status' || token === 'show') opts.mode = 'status';
    else if (token === 'off' || token === 'reset' || token === 'clear') opts.mode = 'off';
    else if (token === 'dark' || token === 'light' || token === 'no-preference') {
      opts.mode = 'set';
      opts.colorScheme = token;
    } else if (token === 'color-scheme' || token === '--color-scheme') {
      const value = tokens[++i];
      if (!value || !['dark', 'light', 'no-preference'].includes(value)) {
        throw new Error('emulate: color-scheme requires dark|light|no-preference');
      }
      opts.mode = 'set';
      opts.colorScheme = value;
    } else if (token === 'reduced-motion' || token === '--reduced-motion') {
      const value = tokens[++i];
      if (!value || !['reduce', 'no-preference'].includes(value)) {
        throw new Error('emulate: reduced-motion requires reduce|no-preference');
      }
      opts.mode = 'set';
      opts.reducedMotion = value;
    } else if (token === 'reduce-motion') {
      opts.mode = 'set';
      opts.reducedMotion = 'reduce';
    } else {
      throw new Error(`emulate: unknown argument ${token}`);
    }
  }
  return opts;
}

function buildEmulateFeatures({ colorScheme = null, reducedMotion = null } = {}) {
  const features = [];
  if (colorScheme) features.push({ name: 'prefers-color-scheme', value: colorScheme });
  if (reducedMotion) features.push({ name: 'prefers-reduced-motion', value: reducedMotion });
  return features;
}

function buildEmulateModel(state = emptyEmulateState(), { targetPrefix = null, nextCommand = null } = {}) {
  const features = Array.isArray(state.features) ? state.features : buildEmulateFeatures(state);
  return {
    schema: 'chrome-cdp-ex.emulate.v1',
    targetPrefix,
    colorScheme: state.colorScheme || null,
    reducedMotion: state.reducedMotion || null,
    features,
    active: features.length > 0,
    nextCommand: nextCommand || (targetPrefix ? `cdp perceive ${targetPrefix} -C -d 8` : null),
  };
}

function formatEmulateText(model) {
  if (!model.active) {
    return [
      'Emulation: off (browser defaults)',
      model.nextCommand ? `Next: ${model.nextCommand}` : null,
    ].filter(Boolean).join('\n');
  }
  const lines = ['Emulation: active'];
  if (model.colorScheme) lines.push(`  prefers-color-scheme: ${model.colorScheme}`);
  if (model.reducedMotion) lines.push(`  prefers-reduced-motion: ${model.reducedMotion}`);
  if (model.nextCommand) lines.push(`Next: ${model.nextCommand}`);
  return lines.join('\n');
}

async function emulateStr(cdp, sid, session, args = [], { targetPrefix = null } = {}) {
  const opts = parseEmulateArgs(args);
  session.emulate = session.emulate || emptyEmulateState();
  if (opts.mode === 'off') {
    await cdpDomains(cdp).Emulation.setEmulatedMedia( { features: [] }, sid);
    session.emulate = emptyEmulateState();
  } else if (opts.mode === 'set') {
    const next = {
      ...session.emulate,
      colorScheme: opts.colorScheme ?? session.emulate.colorScheme,
      reducedMotion: opts.reducedMotion ?? session.emulate.reducedMotion,
    };
    // Explicitly setting only one feature still replaces the whole media feature list.
    if (opts.colorScheme != null) next.colorScheme = opts.colorScheme;
    if (opts.reducedMotion != null) next.reducedMotion = opts.reducedMotion;
    next.features = buildEmulateFeatures(next);
    await cdpDomains(cdp).Emulation.setEmulatedMedia( { features: next.features }, sid);
    session.emulate = next;
  }
  const model = buildEmulateModel(session.emulate, {
    targetPrefix,
    nextCommand: targetPrefix ? `cdp perceive ${targetPrefix} -C -d 8` : null,
  });
  return opts.format === 'json' ? formatJson(model) : formatEmulateText(model);
}

// ---------------------------------------------------------------------------
// Screenshot with multi-tier fallback (handles Electron CDP limitations)
// ---------------------------------------------------------------------------
// Tier 1: Page.captureScreenshot (standard)
// Tier 2: Page.captureScreenshot with fromSurface:false (view-based capture)
// Tier 3: Page.startScreencast single-frame grab (different rendering pipeline)
//
// Once a tier fails for a session, it is skipped on subsequent calls to avoid
// repeated 30s timeouts (critical for scanshot which captures multiple segments).
// State is per-module (one daemon = one tab session, so this is correct).
let _screenshotTier = 1; // start at tier 1; advances on failure
function resetScreenshotTier() { _screenshotTier = 1; }
function getScreenshotTier() { return _screenshotTier; }

// Viewport captures share a session tier so scanshot can skip a known-dead
// compositor path. Clip / captureBeyondViewport timeouts are a different Chrome
// code path and must not poison later `shot` / `elshot` viewport captures.
function screenshotCaptureUsesSessionTier(params = {}) {
  return params.captureBeyondViewport !== true && params.clip == null;
}

async function screencastFallback(cdp, sid, timeoutMs = SCREENSHOT_TIMEOUT) {
  const frame = cdp.waitForEvent('Page.screencastFrame', timeoutMs);
  try {
    await cdpDomains(cdp).Page.startScreencast( { format: 'png', quality: 100, everyNthFrame: 1 }, sid);
    const result = await frame.promise;
    // Acknowledge so the screencast doesn't stall
    cdpDomains(cdp).Page.screencastFrameAck( { sessionId: result.sessionId }, sid).catch(() => {});
    return result.data;
  } finally {
    frame.cancel();
    cdpDomains(cdp).Page.stopScreencast( {}, sid).catch(() => {});
  }
}

async function inspectScreenshotFrame(cdp, sid, data) {
  try {
    return JSON.parse(await evalStr(cdp, sid, screenshotHealthScript(data), false, { timeoutMs: 2000 }));
  } catch (error) {
    return unavailableScreenshotSanity(error?.message || 'inspection-unavailable');
  }
}

async function waitForScreenshotPaint(cdp, sid) {
  try {
    await evalStr(cdp, sid, 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))', false, { timeoutMs: 1000 });
  } catch {
    await sleep(32);
  }
}

// Returns capture data plus bounded method/retry diagnostics.
// `params` is passed to Page.captureScreenshot (format, clip, etc.).
async function captureScreenshot(cdp, sid, params = { format: 'png' }, hooks = {}) {
  const inspectFrame = hooks.inspectFrame || (frame => inspectScreenshotFrame(cdp, sid, frame.data));
  const waitForPaint = hooks.waitForPaint || (() => waitForScreenshotPaint(cdp, sid));
  const timeoutMs = Number.isFinite(hooks.timeoutMs) && hooks.timeoutMs > 0
    ? hooks.timeoutMs
    : SCREENSHOT_TIMEOUT;
  const skipSanityRetry = hooks.skipSanityRetry === true;
  const useSessionTier = screenshotCaptureUsesSessionTier(params);
  let localTier = useSessionTier ? _screenshotTier : 1;
  const advanceTier = (next) => {
    localTier = next;
    if (useSessionTier) _screenshotTier = next;
  };
  let captured;
  // Tier 1: standard captureScreenshot
  if (localTier <= 1) {
    try {
      const result = await cdpDomains(cdp).Page.captureScreenshot( params, sid, timeoutMs);
      captured = { data: result.data, fallback: false, method: 'captureScreenshot' };
    } catch (err) {
      if (!err.message?.startsWith('Timeout:')) throw err;
      if (hooks.failFastOnTimeout === true) throw err;
      advanceTier(2);
    }
  }

  // Tier 2: captureScreenshot with fromSurface:false (captures from view, not compositor)
  if (!captured && localTier <= 2) {
    try {
      const result = await cdpDomains(cdp).Page.captureScreenshot(
        { ...params, fromSurface: false }, sid, timeoutMs);
      captured = { data: result.data, fallback: true, method: 'captureScreenshot-fromSurface-false' };
    } catch (err) {
      if (!err.message?.startsWith('Timeout:')) throw err;
      if (hooks.failFastOnTimeout === true) throw err;
      advanceTier(3);
    }
  }

  // Tier 3: screencast single-frame grab
  if (!captured) {
    try {
      const data = await screencastFallback(cdp, sid, timeoutMs);
      captured = { data, fallback: true, method: 'screencast' };
    } catch {
      throw new Error(
        'Screenshot failed: all methods timed out (Page.captureScreenshot, fromSurface:false, screencast).\n' +
        'This Electron app may not support CDP screenshots. Use `perceive` for structural analysis instead.'
      );
    }
  }

  const firstFrameSanity = await inspectFrame(captured);
  if (skipSanityRetry || !firstFrameSanity?.retry || captured.method !== 'captureScreenshot') {
    return { ...captured, retryCount: 0, sanity: firstFrameSanity };
  }

  await waitForPaint();
  let retry;
  try {
    retry = await cdpDomains(cdp).Page.captureScreenshot( { ...params, fromSurface: false }, sid, timeoutMs);
  } catch (error) {
    throw new Error(`Screenshot alternate capture failed: ${error?.message || String(error)}`);
  }
  const sanity = await inspectFrame({ data: retry.data, method: 'captureScreenshot-fromSurface-false' });
  if (sanity?.retry) {
    throw new Error(`Screenshot alternate capture still failed sanity check (${sanity.reason || 'contradictory-frame'}).`);
  }
  return {
    data: retry.data,
    fallback: true,
    method: 'captureScreenshot-fromSurface-false',
    retryCount: 1,
    sanity,
    firstFrameSanity,
  };
}

// Parse `shot` arguments. Returns { filePath, quiet, verbose }.
// Recognised flags: --quiet (only the saved path), --verbose (full DPR guidance).
// Default (no flags): saved path on the first line, then a brief DPR note —
// scripts that read `head -1` get a clean path without prelude noise.
function parseShotArgs(args) {
  const opts = { filePath: null, quiet: false, verbose: false };
  const tokens = (args || []).filter(a => a !== undefined && a !== null);
  for (const t of tokens) {
    if (t === '--quiet' || t === '-q') opts.quiet = true;
    else if (t === '--verbose' || t === '-v') opts.verbose = true;
    else if (typeof t === 'string' && !t.startsWith('--')) opts.filePath = t;
  }
  return opts;
}

function formatScreenshotCaptureDiagnostics(capture = {}) {
  const { fallback, method, retryCount = 0, sanity, firstFrameSanity } = capture;
  const lines = [];
  if (fallback && retryCount === 0) {
    lines.push('(screenshot fallback — Page.captureScreenshot timed out)');
  }
  if (retryCount) {
    const reason = firstFrameSanity?.reason || sanity?.reason || 'unknown';
    lines.push(`(screenshot retry=${retryCount} method=${method} reason=${reason})`);
  }
  return lines.join('\n');
}

async function shotStr(cdp, sid, filePathOrOpts, targetId, maybeOpts) {
  let filePath = null;
  let opts = { quiet: false, verbose: false, onCapture: null, timeoutMs: null, skipSanityRetry: false };
  if (filePathOrOpts && typeof filePathOrOpts === 'object' && !Array.isArray(filePathOrOpts)) {
    filePath = filePathOrOpts.filePath || null;
    opts = {
      quiet: !!filePathOrOpts.quiet,
      verbose: !!filePathOrOpts.verbose,
      onCapture: filePathOrOpts.onCapture || null,
      timeoutMs: filePathOrOpts.timeoutMs,
      skipSanityRetry: filePathOrOpts.skipSanityRetry === true,
    };
  } else {
    filePath = filePathOrOpts || null;
    if (maybeOpts && typeof maybeOpts === 'object') {
      opts = {
        quiet: !!maybeOpts.quiet,
        verbose: !!maybeOpts.verbose,
        onCapture: maybeOpts.onCapture || null,
        timeoutMs: maybeOpts.timeoutMs,
        skipSanityRetry: maybeOpts.skipSanityRetry === true,
      };
    }
  }
  const dpr = await getDpr(cdp, sid);
  const captureHooks = { skipSanityRetry: opts.skipSanityRetry };
  if (Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0) captureHooks.timeoutMs = opts.timeoutMs;
  const capture = await captureScreenshot(cdp, sid, { format: 'png' }, captureHooks);
  const { data } = capture;
  opts.onCapture?.(capture);
  const out = filePath || resolve(RUNTIME_DIR, `screenshot-${(targetId || 'unknown').slice(0, 8)}.png`);
  writeFileSync(out, Buffer.from(data, 'base64'), { mode: 0o600 });

  // Default output: saved path FIRST so scripts grabbing `head -1` get a clean
  // path. Verbose adds full coordinate-mapping tutorial. Quiet hides hints.
  const lines = [out];
  const diagnostics = formatScreenshotCaptureDiagnostics(capture);
  if (diagnostics) lines.push(diagnostics);
  if (opts.quiet) return lines.join('\n');
  // Default: short DPR hint after the path. (`shot ... --verbose` for the long form.)
  lines.push(`Screenshot saved. DPR=${dpr}${dpr !== 1 ? ` (CSS px = image px / ${dpr})` : ''}`);
  if (opts.verbose) {
    lines.push(`Coordinate mapping:`);
    lines.push(`  Screenshot pixels → CSS pixels (for CDP Input events): divide by ${dpr}`);
    lines.push(`  e.g. screenshot point (${Math.round(100 * dpr)}, ${Math.round(200 * dpr)}) → CSS (100, 200) → use clickxy <target> 100 200`);
    if (dpr !== 1) {
      lines.push(`  On this ${dpr}x display: CSS px = screenshot px / ${dpr} ≈ screenshot px × ${Math.round(100/dpr)/100}`);
    }
  }
  return lines.join('\n');
}

function parseDiffShotArgs(args = []) {
  const fopts = parseFormatArgs(args, ['text', 'json']);
  const opts = { format: fopts.format, thresholdRatio: 0, reset: false, keepBaseline: false };
  for (let i = 0; i < fopts.args.length; i++) {
    const token = fopts.args[i];
    if (token === '--reset') opts.reset = true;
    else if (token === '--keep-baseline') opts.keepBaseline = true;
    else if (token === '--threshold') {
      const raw = fopts.args[++i];
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) throw new Error('diff-shot --threshold requires a non-negative percent value');
      opts.thresholdRatio = n / 100;
    } else {
      throw new Error(`diff-shot: unknown option ${token}`);
    }
  }
  return opts;
}

function formatPercentRatio(value) {
  const n = Number(value);
  return `${((Number.isFinite(n) ? n : 0) * 100).toFixed(2)}%`;
}

function diffShotCompareScript(baselinePngBase64, currentPngBase64) {
  return `
(async () => {
  const decode = (b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  };
  const load = async (b64) => {
    const blob = new Blob([decode(b64)], { type: 'image/png' });
    if (typeof createImageBitmap === 'function') return await createImageBitmap(blob);
    return await new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = (err) => { URL.revokeObjectURL(url); reject(err); };
      img.src = url;
    });
  };
  const [baseline, current] = await Promise.all([
    load(${JSON.stringify(baselinePngBase64)}),
    load(${JSON.stringify(currentPngBase64)}),
  ]);
  const width = Math.min(baseline.width, current.width);
  const height = Math.min(baseline.height, current.height);
  if (!width || !height) throw new Error('diff-shot: screenshot has empty dimensions');
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(baseline, 0, 0, width, height);
  const baselineData = ctx.getImageData(0, 0, width, height);
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(current, 0, 0, width, height);
  const currentData = ctx.getImageData(0, 0, width, height);
  const diffData = ctx.createImageData(width, height);
  let changedPixels = 0;
  for (let i = 0; i < baselineData.data.length; i += 4) {
    const dr = Math.abs(baselineData.data[i] - currentData.data[i]);
    const dg = Math.abs(baselineData.data[i + 1] - currentData.data[i + 1]);
    const db = Math.abs(baselineData.data[i + 2] - currentData.data[i + 2]);
    const da = Math.abs(baselineData.data[i + 3] - currentData.data[i + 3]);
    const changed = dr + dg + db + da > 0;
    if (changed) changedPixels++;
    if (changed) {
      diffData.data[i] = 255;
      diffData.data[i + 1] = 0;
      diffData.data[i + 2] = 180;
      diffData.data[i + 3] = 255;
    } else {
      const gray = Math.round((currentData.data[i] + currentData.data[i + 1] + currentData.data[i + 2]) / 3 * 0.35);
      diffData.data[i] = gray;
      diffData.data[i + 1] = gray;
      diffData.data[i + 2] = gray;
      diffData.data[i + 3] = 255;
    }
  }
  ctx.putImageData(diffData, 0, 0);
  const diffPngBase64 = canvas.toDataURL('image/png').split(',')[1] || '';
  const totalPixels = width * height;
  return JSON.stringify({
    width,
    height,
    baselineWidth: baseline.width,
    baselineHeight: baseline.height,
    currentWidth: current.width,
    currentHeight: current.height,
    changedPixels,
    totalPixels,
    changedRatio: totalPixels ? changedPixels / totalPixels : 0,
    diffPngBase64,
  });
})()
`;
}

function formatDiffShotResult(model = {}) {
  const lines = [];
  if (model.baselineCaptured) {
    lines.push(`Diff-shot baseline captured: ${model.baselinePath}`);
    if (model.fallback) lines.push('(screenshot fallback - Page.captureScreenshot timed out)');
    lines.push(`Next: cdp diff-shot ${model.targetId}`);
    lines.push('Pixel diff only: use perceive/cascade/report to explain semantic cause.');
    return lines.join('\n');
  }

  lines.push(`Diff-shot: changed ${model.changedPixels || 0}/${model.totalPixels || 0} px (${formatPercentRatio(model.changedRatio)})`);
  if (Number(model.thresholdRatio || 0) > 0) {
    lines.push(`Threshold: ${formatPercentRatio(model.thresholdRatio)} (${model.exceedsThreshold ? 'exceeded' : 'within threshold'})`);
  }
  lines.push(`Baseline: ${model.baselinePath}`);
  lines.push(`Current: ${model.currentPath}`);
  lines.push(`Diff image: ${model.diffPath}`);
  if (model.width && model.height) lines.push(`Compared: ${model.width}x${model.height} screenshot pixels`);
  if (model.fallback) lines.push('(screenshot fallback - Page.captureScreenshot timed out)');
  lines.push(model.advancedBaseline ? 'Baseline advanced to current capture.' : 'Baseline kept; pass without --keep-baseline to advance.');
  lines.push('Pixel diff only: use perceive/cascade/report to explain semantic cause.');
  return lines.join('\n');
}

function nextDiffShotArtifactPaths(session) {
  if (!session.diffShot) session.diffShot = {};
  const seq = Number(session.diffShot.seq || 0) + 1;
  session.diffShot.seq = seq;
  const dir = ensureSessionScreenshotDir(session) || session.screenshotDir || sessionScreenshotDir(session.targetId);
  const padded = String(seq).padStart(3, '0');
  return {
    baselinePath: resolve(dir, `diff-shot-baseline-${padded}.png`),
    currentPath: resolve(dir, `diff-shot-current-${padded}.png`),
    diffPath: resolve(dir, `diff-shot-diff-${padded}.png`),
  };
}

async function diffShotStr(cdp, sid, session, opts = {}) {
  let shot;
  try {
    shot = await captureScreenshot(cdp, sid, { format: 'png' }, diffShotScreenshotCaptureOptions());
  } catch (error) {
    if (isScreenshotTimeoutError(error)) {
      throw new Error('diff-shot: screenshot capture timed out; comparison is untrusted');
    }
    throw error;
  }
  if (shot.fallback === true) {
    throw new Error('diff-shot: screenshot capture timed out; comparison is untrusted');
  }
  const targetId = session.targetId;
  const reset = opts.reset || !session.diffShot?.baselineData;
  const paths = nextDiffShotArtifactPaths(session);
  if (reset) {
    writeFileSync(paths.baselinePath, Buffer.from(shot.data, 'base64'), { mode: 0o600 });
    session.diffShot = {
      ...(session.diffShot || {}),
      baselineData: shot.data,
      baselinePath: paths.baselinePath,
    };
    appendSessionScreenshot(session, { kind: 'diff-shot-baseline', path: paths.baselinePath, note: opts.reset ? 'reset baseline' : 'baseline' });
    const model = {
      schema: 'chrome-cdp-ex.diff-shot.v1',
      targetId,
      baselineCaptured: true,
      baselinePath: paths.baselinePath,
      currentPath: paths.baselinePath,
      diffPath: null,
      changedPixels: 0,
      totalPixels: 0,
      changedRatio: 0,
      thresholdRatio: opts.thresholdRatio || 0,
      exceedsThreshold: false,
      advancedBaseline: true,
      fallback: shot.fallback === true,
    };
    return opts.format === 'json' ? formatJson(model) : formatDiffShotResult(model);
  }

  writeFileSync(paths.currentPath, Buffer.from(shot.data, 'base64'), { mode: 0o600 });
  const compareRaw = await evalStr(cdp, sid, diffShotCompareScript(session.diffShot.baselineData, shot.data));
  const compare = JSON.parse(compareRaw);
  writeFileSync(paths.diffPath, Buffer.from(compare.diffPngBase64, 'base64'), { mode: 0o600 });
  appendSessionScreenshot(session, { kind: 'diff-shot-current', path: paths.currentPath, note: 'current capture' });
  appendSessionScreenshot(session, { kind: 'diff-shot-diff', path: paths.diffPath, note: 'pixel diff' });
  const priorBaselinePath = session.diffShot.baselinePath;
  const advancedBaseline = !opts.keepBaseline;
  if (advancedBaseline) {
    session.diffShot.baselineData = shot.data;
    session.diffShot.baselinePath = paths.currentPath;
  }
  const model = {
    schema: 'chrome-cdp-ex.diff-shot.v1',
    targetId,
    baselineCaptured: false,
    baselinePath: priorBaselinePath,
    currentPath: paths.currentPath,
    diffPath: paths.diffPath,
    width: compare.width,
    height: compare.height,
    baselineWidth: compare.baselineWidth,
    baselineHeight: compare.baselineHeight,
    currentWidth: compare.currentWidth,
    currentHeight: compare.currentHeight,
    changedPixels: compare.changedPixels,
    totalPixels: compare.totalPixels,
    changedRatio: compare.changedRatio,
    thresholdRatio: opts.thresholdRatio || 0,
    exceedsThreshold: compare.changedRatio > Number(opts.thresholdRatio || 0),
    advancedBaseline,
    fallback: shot.fallback === true,
  };
  return opts.format === 'json' ? formatJson(model) : formatDiffShotResult(model);
}

async function htmlStr(cdp, sid, selectorOrArgs, extra = {}) {
  // Share selector/root resolution rules with text where practical.
  let opts;
  if (Array.isArray(selectorOrArgs)) opts = parseTextArgs(selectorOrArgs);
  else if (typeof selectorOrArgs === 'string' || selectorOrArgs == null) {
    opts = parseTextArgs(selectorOrArgs ? [selectorOrArgs] : []);
  } else opts = { selectors: [], root: null };
  const targetPrefix = extra.targetPrefix || opts.targetPrefix || '<target>';
  await assertNotPdfViewerPage(cdp, sid, { targetPrefix });
  const selector = opts.selectors[0] || null;
  const root = opts.root || 'document';
  const result = await evalStr(cdp, sid, `(function() {
    function safeQuery(root, sel) { try { return root?.querySelector?.(sel) || null; } catch { return null; } }
    let scope = document.documentElement;
    const rootSetting = ${JSON.stringify(root)};
    if (rootSetting === 'body') scope = document.body || document.documentElement;
    else if (rootSetting === 'auto' || rootSetting === 'default') {
      scope = safeQuery(document, '#root') || safeQuery(document, '[data-reactroot]') || safeQuery(document, 'main') || document.body || document.documentElement;
    } else if (rootSetting !== 'document') {
      scope = safeQuery(document, rootSetting);
      if (!scope) return JSON.stringify({ ok: false, root: rootSetting, reason: 'root-not-found' });
    }
    if (!${JSON.stringify(selector)}) {
      return JSON.stringify({ ok: true, root: rootSetting, html: (scope || document.documentElement).outerHTML });
    }
    const el = scope === document || scope === document.documentElement
      ? safeQuery(document, ${JSON.stringify(selector)})
      : (scope.matches && scope.matches(${JSON.stringify(selector)}) ? scope : safeQuery(scope, ${JSON.stringify(selector)}));
    if (!el) return JSON.stringify({ ok: false, root: rootSetting, selector: ${JSON.stringify(selector)} });
    return JSON.stringify({ ok: true, root: rootSetting, html: el.outerHTML });
  })()`);
  let parsed;
  try { parsed = JSON.parse(result); } catch { return result; }
  if (!parsed.ok) {
    const rootLabel = parsed.root || root || 'document';
    const sel = parsed.selector || selector || '';
    throw new Error(
      `html: no element matched within root "${rootLabel}"${sel ? ` for selector ${sel}` : ''}. ` +
      `Fallback: cdp eval ${targetPrefix} "document.querySelector(${JSON.stringify(sel || 'selector')})?.outerHTML"`
    );
  }
  return parsed.html || '';
}

async function waitForDocumentReady(cdp, sid, timeoutMs = NAVIGATION_TIMEOUT, options = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastState = '';
  let lastError;
  while (Date.now() < deadline) {
    try {
      const state = await evalStr(cdp, sid, 'document.readyState', false, { timeoutMs: options.probeTimeoutMs });
      lastState = state;
      if (state === 'complete') return;
    } catch (e) {
      lastError = e;
    }
    await sleep(200);
  }

  if (lastState) {
    throw new Error(`Timed out waiting for navigation to finish (last readyState: ${lastState})`);
  }
  if (lastError) {
    throw new Error(`Timed out waiting for navigation to finish (${lastError.message})`);
  }
  throw new Error('Timed out waiting for navigation to finish');
}

function navigationDestinationMatches(observedUrl, requestedUrl) {
  if (!observedUrl || !requestedUrl) return false;
  if (isBlankPageUrl(observedUrl)) return false;
  if (observedUrl === requestedUrl) return true;
  try {
    return new URL(observedUrl).href === new URL(requestedUrl).href;
  } catch {
    return false;
  }
}

async function observeSameTargetDestination(cdp, targetId, url, {
  delayMs = 250,
  shouldStop = () => false,
  now = Date.now,
  sleepFn = sleep,
} = {}) {
  if (delayMs > 0) await sleepFn(delayMs);
  const deadline = now() + TIMEOUT;
  while (!shouldStop() && now() <= deadline) {
    try {
      const { targetInfos } = await cdpDomains(cdp).Target.getTargets( {}, undefined, 1000);
      const target = (targetInfos || []).find(info => info.targetId === targetId);
      if (target && navigationDestinationMatches(target.url, url)) return target.url;
    } catch {
      // Browser-level Target.getTargets is best-effort while Page.navigate is outstanding.
    }
    const remainingMs = deadline - now();
    if (remainingMs <= 0 || shouldStop()) break;
    await sleepFn(Math.min(50, remainingMs));
  }
  return null;
}

async function settleObservedNavigation(cdp, sid, {
  targetId,
  onSessionId,
  readyTimeoutMs = 5000,
  probeTimeoutMs,
} = {}) {
  try {
    await waitForDocumentReady(cdp, sid, readyTimeoutMs, { probeTimeoutMs });
    return sid;
  } catch (error) {
    if (!targetId) throw error;
    const attached = await cdpDomains(cdp).Target.attachToTarget(
      { targetId, flatten: true },
      undefined,
      5000,
    );
    const nextSid = attached?.sessionId;
    if (!nextSid) throw error;
    await enableDaemonDomains(cdp, nextSid);
    onSessionId?.(nextSid);
    await waitForDocumentReady(cdp, nextSid, readyTimeoutMs, { probeTimeoutMs });
    return nextSid;
  }
}

async function navStr(cdp, sid, url, opts = {}) {
  validateUrl(url);
  await cdpDomains(cdp).Page.enable( {}, sid);
  const loadEvent = cdp.waitForEvent('Page.loadEventFired', NAVIGATION_TIMEOUT);
  const targetId = opts.targetId || null;
  let navigateSettled = false;
  const navigatePromise = (async () => {
    try {
      const result = await cdpDomains(cdp).Page.navigate( { url }, sid);
      return { kind: 'rpc', result };
    } finally {
      navigateSettled = true;
    }
  })();
  const observePromise = targetId
    ? observeSameTargetDestination(cdp, targetId, url, {
        delayMs: opts.observeDelayMs ?? 250,
        shouldStop: () => navigateSettled,
      }).then(href => (href ? { kind: 'observed', href } : null))
    : null;

  let outcome;
  try {
    outcome = observePromise
      ? await Promise.race([
          navigatePromise,
          observePromise.then(value => value || navigatePromise),
        ])
      : await navigatePromise;
  } catch (e) {
    loadEvent.cancel();
    throw e;
  }

  if (outcome.kind === 'observed') {
    loadEvent.cancel();
    navigatePromise.catch(() => {});
    await settleObservedNavigation(cdp, sid, {
      targetId,
      onSessionId: opts.onSessionId,
      readyTimeoutMs: opts.readyTimeoutMs ?? 5000,
      probeTimeoutMs: opts.probeTimeoutMs,
    });
    return `Navigated to ${url}`;
  }

  const result = outcome.result;
  if (result.errorText) {
    loadEvent.cancel();
    throw new Error(result.errorText);
  }
  if (result.loaderId) {
    await loadEvent.promise;
  } else {
    loadEvent.cancel();
  }
  await waitForDocumentReady(cdp, sid, opts.readyTimeoutMs ?? 5000, {
    probeTimeoutMs: opts.probeTimeoutMs,
  });
  return `Navigated to ${url}`;
}

async function netStr(cdp, sid) {
  const raw = await evalStr(cdp, sid, `JSON.stringify(performance.getEntriesByType('resource').map(e => ({
    name: e.name.substring(0, 120), type: e.initiatorType,
    duration: Math.round(e.duration), size: e.transferSize
  })))`);
  return JSON.parse(raw).map(e =>
    `${String(e.duration).padStart(5)}ms  ${String(e.size || '?').padStart(8)}B  ${e.type.padEnd(8)}  ${e.name}`
  ).join('\n');
}

function formatMetricValue(name, value) {
  if (name === 'JSHeapUsedSize' || name === 'JSHeapTotalSize') {
    if (!Number.isFinite(value)) return String(value);
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
  }
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}

async function runtimeMetricsStr(cdp, sid) {
  try { await cdpDomains(cdp).Performance.enable( {}, sid); } catch {}
  const { metrics = [] } = await cdpDomains(cdp).Performance.getMetrics( {}, sid);
  const wanted = ['Documents', 'Frames', 'JSEventListeners', 'Nodes', 'JSHeapUsedSize', 'Tasks'];
  const byName = new Map(metrics.map(m => [m.name, m.value]));
  const lines = ['Runtime metrics (Performance.getMetrics):'];
  for (const name of wanted) {
    if (!byName.has(name)) continue;
    lines.push(`  ${name}: ${formatMetricValue(name, byName.get(name))}`);
  }
  if (lines.length === 1) lines.push('  (no requested metrics returned by this target)');
  return lines.join('\n');
}

function buildTargetStatusDiagnostic(err, { cmd = 'status', targetPrefix = '' } = {}) {
  const model = buildCliErrorModel(err, { cmd, targetPrefix });
  const state = model.recovery.kind === 'target-closed'
    ? 'closed'
    : model.recovery.kind === 'daemon-disconnect'
    ? 'daemon-disconnect'
    : 'error';
  return {
    state,
    error: model.error,
    recovery: model.recovery,
    nextSteps: model.nextSteps,
  };
}

async function pageInfoModel(cdp, sid, opts = {}) {
  let title = '', url = '', contentType = '';
  try {
    const info = JSON.parse(await evalStr(cdp, sid, 'JSON.stringify({ title: document.title, url: window.location.href, contentType: document.contentType || "" })', false, { timeoutMs: STATUS_PAGE_INFO_TIMEOUT }));
    title = info.title;
    url = info.url;
    contentType = info.contentType || '';
  } catch (e) {
    return { title, url, contentType, diagnostic: buildTargetStatusDiagnostic(e, { targetPrefix: opts.targetPrefix }) };
  }
  return { title, url, contentType, diagnostic: null };
}

function isPdfViewerContentType(contentType) {
  return String(contentType || '').toLowerCase().includes('application/pdf');
}

function pdfViewerNextCommand(targetPrefix = '<target>') {
  return `cdp eval ${targetPrefix} "document.contentType"`;
}

function pdfViewerHandoffModel(meta = {}, { targetPrefix = '<target>' } = {}) {
  return {
    schema: 'chrome-cdp-ex.pdf-viewer.v1',
    title: meta.title || '',
    url: meta.url || '',
    contentType: meta.contentType || 'application/pdf',
    nextCommand: pdfViewerNextCommand(targetPrefix),
    message: 'Chrome is rendering a PDF plugin, not an HTML document.',
  };
}

function pdfViewerReportRecommendation(targetPrefix = '<target>') {
  const run = pdfViewerNextCommand(targetPrefix);
  return {
    source: 'pdf-viewer',
    actionIndex: null,
    action: null,
    diagnosisKind: 'pdf-viewer',
    strategy: 'do-not-probe-ax',
    priority: 'high',
    verifyCommand: run,
    commands: [run],
  };
}

function formatPdfViewerOutput(meta = {}, { targetPrefix = '<target>' } = {}) {
  const model = pdfViewerHandoffModel(meta, { targetPrefix });
  return [
    model.schema,
    `PDF viewer: ${model.message}`,
    `Page: ${model.title || '(untitled)'}`,
    `URL: ${model.url || '(unknown)'}`,
    `contentType: ${model.contentType}`,
    'Accessibility tree is empty for this viewer. Do not retry perceive/text as a next-probe.',
    `Next: ${model.nextCommand}`,
  ].join('\n');
}

function pdfViewerHandoffModelFromOutput(output, targetPrefix = '<target>') {
  const text = String(output || '');
  const title = text.match(/^Page: (.*)$/m)?.[1];
  const url = text.match(/^URL: (.*)$/m)?.[1];
  const contentType = text.match(/^contentType: (.*)$/m)?.[1];
  return pdfViewerHandoffModel({
    title: !title || title === '(untitled)' ? '' : title,
    url: !url || url === '(unknown)' ? '' : url,
    contentType,
  }, { targetPrefix });
}

function pdfViewerError(meta = {}, { targetPrefix = '<target>' } = {}) {
  const err = new Error(formatPdfViewerOutput(meta, { targetPrefix }));
  err.code = 'pdf_viewer';
  return err;
}

async function assertNotPdfViewerPage(cdp, sid, { targetPrefix = '<target>' } = {}) {
  try {
    const page = JSON.parse(await evalStr(
      cdp,
      sid,
      'JSON.stringify({ title: document.title, url: window.location.href, contentType: document.contentType || "" })',
      false,
      { timeoutMs: STATUS_PAGE_INFO_TIMEOUT },
    ));
    if (isPdfViewerContentType(page.contentType)) {
      throw pdfViewerError(page, { targetPrefix });
    }
    return page;
  } catch (error) {
    if (error?.code === 'pdf_viewer') throw error;
    return null;
  }
}

async function collectPageHealth(cdp, sid, { changed = false, retryIndeterminate = true } = {}) {
  const sample = async () => {
    const signals = JSON.parse(await evalStr(cdp, sid, pageHealthScript(), false, { timeoutMs: STATUS_PAGE_INFO_TIMEOUT }));
    return classifyPageHealth({ ...signals, changed });
  };
  let health = await sample();
  if (retryIndeterminate && health.status === 'indeterminate') {
    await sleep(50);
    health = await sample();
  }
  return health;
}

function parseConsoleArgs(args = []) {
  const fopts = parseFormatArgs(args, ['text', 'json']);
  if (fopts.args.length > 1) {
    throw new Error('console: choose exactly one mode: --all, --errors, or --clear.');
  }
  const flag = fopts.args[0];
  const modes = new Map([
    [undefined, 'new'],
    ['--all', 'all'],
    ['--errors', 'errors'],
    ['--clear', 'clear'],
  ]);
  if (!modes.has(flag)) {
    throw new Error(`console: unknown option ${flag}. Supported options: --all, --errors, --clear, --format text|json.`);
  }
  return { mode: modes.get(flag), format: fopts.format };
}

function clearConsoleBaseline(consoleBuf, exceptionBuf, lastReadSeq) {
  const cleared = {
    console: consoleBuf.all().length,
    exceptions: exceptionBuf.all().length,
  };
  consoleBuf.clear();
  exceptionBuf.clear();
  lastReadSeq.console = consoleBuf.latest();
  lastReadSeq.exception = exceptionBuf.latest();
  return {
    schema: 'chrome-cdp-ex.console-baseline.v1',
    mode: 'clear',
    cleared,
    message: 'Console baseline cleared (console and exception buffers)',
  };
}

function buildConsoleModel(consoleBuf, exceptionBuf, lastReadSeq, flag) {
  const mode = flag === '--errors' ? 'errors' : flag === '--all' ? 'all' : flag || 'new';
  const showErrors = mode === 'errors';
  const showAll = mode === 'all';
  let entries;
  let exceptions = [];

  if (showAll) {
    entries = consoleBuf.all();
    exceptions = exceptionBuf.all();
  } else if (showErrors) {
    entries = consoleBuf.all().filter(e => e.level === 'error' || e.level === 'warning');
    exceptions = exceptionBuf.all();
  } else {
    entries = consoleBuf.since(lastReadSeq.console);
    exceptions = exceptionBuf.since(lastReadSeq.exception);
  }

  return {
    schema: 'chrome-cdp-ex.console.v1',
    mode: showAll ? 'all' : showErrors ? 'errors' : 'new',
    entries,
    exceptions,
  };
}

function buildStatusModel({ targetId, page, consoleBuf, exceptionBuf, navBuf, lastReadSeq, runtime = null, diagnostic = null }) {
  return {
    schema: 'chrome-cdp-ex.status.v1',
    targetId,
    target: {
      state: diagnostic?.state || 'connected',
      diagnostic,
    },
    page,
    console: consoleBuf.since(lastReadSeq.console),
    exceptions: exceptionBuf.since(lastReadSeq.exception),
    navigation: navBuf.since(lastReadSeq.nav || 0),
    runtime,
  };
}

async function statusStr(cdp, sid, consoleBuf, exceptionBuf, navBuf, lastReadSeq, opts = {}) {
  const { title, url, diagnostic } = await pageInfoModel(cdp, sid, { targetPrefix: opts.targetPrefix });

  const lines = [];
  lines.push(`URL: ${url}`);
  lines.push(`Title: ${title}`);
  if (diagnostic) {
    lines.push(`Target state: ${diagnostic.state}`);
    lines.push(`Diagnostic: ${diagnostic.error.message}`);
    lines.push(...formatCliErrorRecovery(diagnostic.recovery));
    lines.push(`Next: ${diagnostic.recovery.run}`);
  }

  const navs = navBuf.all();
  if (navs.length > 0) {
    const last = navs[navs.length - 1];
    const ago = Math.round((Date.now() - last.ts) / 1000);
    lines.push(`Navigations: ${navs.length} (last ${ago}s ago)`);
  }

  const newConsole = consoleBuf.since(lastReadSeq.console);
  const newExceptions = exceptionBuf.since(lastReadSeq.exception);

  if (newConsole.length > 0) {
    lines.push(`Console (${newConsole.length} new):`);
    for (const e of newConsole.slice(-20)) {
      const loc = e.loc ? ` (${e.loc})` : '';
      lines.push(`  [${e.level}] ${e.text.substring(0, 200)}${loc}`);
    }
    if (newConsole.length > 20) lines.push(`  ... and ${newConsole.length - 20} more (use 'console --all')`);
  } else {
    lines.push('Console: (no new entries)');
  }

  if (newExceptions.length > 0) {
    lines.push(`Exceptions (${newExceptions.length} new):`);
    for (const e of newExceptions.slice(-10)) {
      const loc = e.loc ? ` at ${e.loc}` : '';
      lines.push(`  ${e.msg.substring(0, 200)}${loc}`);
    }
  }

  if (opts.runtime) {
    try {
      lines.push(await runtimeMetricsStr(cdp, sid));
    } catch (e) {
      lines.push(`Runtime metrics (Performance.getMetrics): unavailable (${e.message})`);
    }
  }

  lastReadSeq.console = consoleBuf.latest();
  lastReadSeq.exception = exceptionBuf.latest();

  return lines.join('\n');
}

async function consoleStr(consoleBuf, exceptionBuf, lastReadSeq, flag) {
  let entries;
  let exceptions = [];
  const mode = flag === '--errors' ? 'errors' : flag === '--all' ? 'all' : flag || 'new';
  const showErrors = mode === 'errors';
  const showAll = mode === 'all';

  if (showAll) {
    entries = consoleBuf.all();
    exceptions = exceptionBuf.all();
  } else if (showErrors) {
    entries = consoleBuf.all().filter(e => e.level === 'error' || e.level === 'warning');
    exceptions = exceptionBuf.all();
  } else {
    entries = consoleBuf.since(lastReadSeq.console);
    exceptions = exceptionBuf.since(lastReadSeq.exception);
    lastReadSeq.console = consoleBuf.latest();
    lastReadSeq.exception = exceptionBuf.latest();
  }

  const lines = [];
  if (entries.length === 0 && exceptions.length === 0) {
    return showAll ? 'Console buffer is empty' : 'No new console entries';
  }

  for (const e of entries) {
    const loc = e.loc ? ` (${e.loc})` : '';
    lines.push(`[${e.level}] ${e.text.substring(0, 300)}${loc}`);
  }
  if (exceptions.length > 0) {
    lines.push('--- Uncaught Exceptions ---');
    for (const e of exceptions) {
      const loc = e.loc ? ` at ${e.loc}` : '';
      lines.push(`[exception] ${e.msg.substring(0, 300)}${loc}`);
    }
  }
  return lines.join('\n');
}

async function summaryModel(cdp, sid, consoleBuf, exceptionBuf, extra = {}) {
  const targetPrefix = extra.targetPrefix || '<target>';
  await assertNotPdfViewerPage(cdp, sid, { targetPrefix });
  const expr = `
    (function() {
      const counts = {};
      const interactive = document.querySelectorAll('a, button, input, select, textarea, [role="button"], [tabindex]');
      let visibleControls = 0;
      for (const el of interactive) {
        const style = window.getComputedStyle(el);
        if (el.hidden || el.getAttribute('aria-hidden') === 'true' || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') continue;
        visibleControls += 1;
        const tag = el.tagName.toLowerCase();
        const type = tag === 'input' ? 'input[' + (el.type || 'text') + ']' : tag;
        counts[type] = (counts[type] || 0) + 1;
      }
      const domNodes = document.querySelectorAll('*').length;
      let tableRows = 0;
      for (const table of document.querySelectorAll('table')) {
        const sourceRows = Number(table.getAttribute('data-source-rows') || table.dataset.sourceRows || 0);
        tableRows = Math.max(tableRows, table.querySelectorAll('tr').length, Number.isFinite(sourceRows) ? sourceRows : 0);
      }
      const hiddenTemplateNodes = document.querySelectorAll('template *, [data-hidden-template], [data-hidden-template] *, [hidden], [hidden] *, [aria-hidden="true"], [aria-hidden="true"] *').length;
      const focused = document.activeElement;
      const focusDesc = focused && focused !== document.body
        ? '<' + focused.tagName.toLowerCase() + (focused.id ? '#' + focused.id : '') + (focused.className ? '.' + focused.className.toString().split(' ')[0] : '') + '>'
        : 'none';
      return {
        title: document.title,
        url: window.location.href,
        viewport: window.innerWidth + 'x' + window.innerHeight,
        scrollY: Math.round(window.scrollY),
        scrollMax: Math.round(document.documentElement.scrollHeight - window.innerHeight),
        counts,
        domNodes,
        tableRows,
        visibleControls,
        hiddenTemplateNodes,
        focused: focusDesc,
      };
    })()
  `;
  const result = await evalStr(cdp, sid, expr);
  const r = JSON.parse(result);
  const allConsole = consoleBuf.all();
  let errors = 0, warnings = 0;
  for (const e of allConsole) {
    if (e.level === 'error') errors++;
    else if (e.level === 'warning' || e.level === 'warn') warnings++;
  }
  const exceptions = exceptionBuf.all().length;

  return {
    schema: 'chrome-cdp-ex.summary.v1',
    page: { title: r.title, url: r.url },
    viewport: {
      size: r.viewport,
      scrollY: r.scrollY,
      scrollMax: r.scrollMax,
    },
    interactive: r.counts,
    counts: {
      domNodes: r.domNodes || 0,
      tableRows: r.tableRows || 0,
      visibleControls: r.visibleControls || 0,
      hiddenTemplateNodes: r.hiddenTemplateNodes || 0,
    },
    limits: {
      outputTokenBudget: 1200,
      hiddenTemplateNodesOmitted: r.hiddenTemplateNodes || 0,
      truncated: (r.domNodes || 0) > 1000 || (r.tableRows || 0) > 100 || (r.visibleControls || 0) > 50 || (r.hiddenTemplateNodes || 0) > 0,
    },
    focused: r.focused,
    console: { errors, warnings, exceptions },
  };
}

function formatSummaryText(model) {
  const lines = [];
  lines.push(`Title: ${model.page.title}`);
  lines.push(`URL: ${model.page.url}`);
  lines.push(`Viewport: ${model.viewport.size}`);

  const countParts = Object.entries(model.interactive).map(([k, v]) => `${v} ${k}`);
  lines.push(`Interactive: ${countParts.length > 0 ? countParts.join(', ') : 'none found'}`);

  lines.push(`Focused: ${model.focused}`);

  if (model.viewport.scrollMax > 0) {
    const pct = Math.round(model.viewport.scrollY / model.viewport.scrollMax * 100);
    lines.push(`Scroll: ${model.viewport.scrollY} / ${model.viewport.scrollMax} max (${pct}%)`);
  } else {
    lines.push('Scroll: no scroll');
  }

  const parts = [];
  if (model.console.errors > 0) parts.push(`${model.console.errors} error${model.console.errors > 1 ? 's' : ''}`);
  if (model.console.warnings > 0) parts.push(`${model.console.warnings} warning${model.console.warnings > 1 ? 's' : ''}`);
  if (model.console.exceptions > 0) parts.push(`${model.console.exceptions} exception${model.console.exceptions > 1 ? 's' : ''}`);
  lines.push(`Console: ${parts.length > 0 ? parts.join(', ') : 'clean'}`);

  return lines.join('\n');
}

async function summaryStr(cdp, sid, consoleBuf, exceptionBuf, extra = {}) {
  return formatSummaryText(await summaryModel(cdp, sid, consoleBuf, exceptionBuf, extra));
}

const MAX_ACTION_DELTA_ENTRIES = 5;
const MAX_ACTION_JSON_DOM_DIFF_CHARS = 800;
const FILL_TYPEAHEAD_LIMIT = 10;
const FILL_TYPEAHEAD_MAX_CHARS = 80;
const DEFAULT_REPORT_ACTION_LIMIT = 20;
const DEFAULT_REPORT_JSON_BYTES_MAX = 64 * 1024;
const DEFAULT_STALE_ARTIFACT_HOURS = 24;
const REDACTED_VALUE = '<redacted>';
const SENSITIVE_QUERY_KEY_RE = /\b(pass(word)?|secret|token|api[-_]?key|credential|otp|2fa|mfa|auth(orization)?|pin|cvv|card|ssn|session|sid|cookie|jwt|csrf|xsrf|refresh|access)\b/i;
const SENSITIVE_METADATA_KEY_ALLOWLIST = new Set([
  'schema',
  'source',
  'targetId',
  'targetPrefix',
  'sessionId',
  'sessionStorage',
  'localStorage',
  'storage',
  'cookies',
  'cookieCount',
  'createdAt',
  'now',
  'ts',
  'index',
  'action',
  'kind',
  'status',
  'method',
  'path',
  'paths',
  'url',
  'origin',
  'title',
  'domain',
  'sameSite',
  'secure',
  'httpOnly',
  'expires',
  'redaction',
  'redacted',
]);
const SECRET_ASSIGNMENT_RE = /(^|[\s{[,;?&])([A-Za-z0-9_.-]*(?:pass(?:word)?|secret|token|api[-_]?key|credential|otp|2fa|mfa|auth(?:orization)?|pin|cvv|card|ssn|session|sid|cookie|jwt|csrf|xsrf|refresh|access)[A-Za-z0-9_.-]*\s*[:=]\s*)(["']?)([^"'\s,;&}\])]+)/gi;
const AUTH_HEADER_VALUE_RE = /\b(Authorization\s*[:=]\s*(?:Bearer|Basic)\s+)([A-Za-z0-9._~+/=-]+)/gi;
const BEARER_VALUE_RE = /\b(Bearer\s+)([A-Za-z0-9._~+/=-]+)/gi;
const NOISY_ACTION_NETWORK_TYPES = new Set(['Image', 'Stylesheet', 'Script', 'Font', 'Media', 'WebSocket']);

function isSensitiveDataKey(key = '') {
  const name = String(key || '');
  if (!name || SENSITIVE_METADATA_KEY_ALLOWLIST.has(name)) return false;
  const normalized = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_.]+/g, ' ');
  return SENSITIVE_QUERY_KEY_RE.test(name) || SENSITIVE_QUERY_KEY_RE.test(normalized);
}

function redactSensitiveString(value) {
  const text = String(value ?? '');
  return text
    .replace(AUTH_HEADER_VALUE_RE, `$1${REDACTED_VALUE}`)
    .replace(BEARER_VALUE_RE, `$1${REDACTED_VALUE}`)
    .replace(SECRET_ASSIGNMENT_RE, (_match, prefix, key, quote) => `${prefix}${key}${quote}${REDACTED_VALUE}${quote}`);
}

function redactSensitiveArtifactValue(value, key = '') {
  if (value == null) return value;
  if (isSensitiveDataKey(key)) return REDACTED_VALUE;
  if (typeof value === 'string') return redactSensitiveString(value);
  if (Array.isArray(value)) return value.map(item => redactSensitiveArtifactValue(item));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      redactSensitiveArtifactValue(entryValue, entryKey),
    ]));
  }
  return value;
}

function createActionResult({ action, target, dispatch, settle, effects, nextHint }) {
  return applyActionReceipt(applyActionVerdict(applyActionRecommendation(applyActionOutcome(applyActionDiagnosis({
    schema: 'chrome-cdp-ex.action.v1',
    action,
    target,
    dispatch,
    settle,
    effects,
    nextHint,
  })))));
}

function createActionObservationBaseline({ consoleBuf = null, exceptionBuf = null, netReqBuf = null } = {}) {
  return {
    console: typeof consoleBuf?.latest === 'function' ? consoleBuf.latest() : 0,
    exception: typeof exceptionBuf?.latest === 'function' ? exceptionBuf.latest() : 0,
    network: typeof netReqBuf?.latest === 'function' ? netReqBuf.latest() : 0,
  };
}

function compactActionText(value, max = 220) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function compactActionUrl(value) {
  const raw = compactActionText(value, 240);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    const params = new URLSearchParams(url.search);
    for (const key of [...params.keys()]) {
      if (SENSITIVE_QUERY_KEY_RE.test(key)) params.set(key, '<redacted>');
    }
    const query = params.toString();
    return compactActionText(`${url.pathname}${query ? `?${query}` : ''}${url.hash || ''}`, 180);
  } catch {
    return compactActionText(raw, 180);
  }
}

function compactObservationError(err) {
  const message = compactActionText(redactSensitiveString(actionFailureMessage(err)), 240);
  return {
    name: compactActionText(err?.name || err?.constructor?.name || 'Error', 80),
    message: message || 'Post-action observation failed.',
  };
}

function compactConsoleDeltaEntry(entry = {}) {
  return {
    level: compactActionText(entry.level || 'log', 30),
    text: compactActionText(redactSensitiveString(entry.text || entry.msg || entry.message || '')),
    loc: compactActionText(entry.loc || '', 120),
  };
}

function compactExceptionDeltaEntry(entry = {}) {
  return {
    message: compactActionText(redactSensitiveString(entry.msg || entry.message || entry.text || 'Unknown exception')),
    loc: compactActionText(entry.loc || '', 120),
  };
}

function isGitHubWebUrl(url) {
  try {
    const host = new URL(String(url || '')).hostname.toLowerCase();
    return host === 'github.com' || host.endsWith('.github.com');
  } catch {
    return false;
  }
}

function isIgnorableTelemetryFailure(entry = {}) {
  const url = String(entry.url || '');
  const type = String(entry.type || '');
  if (/\/copilot\/agent-sessions(?:\/|$|\?)/i.test(url)) return true;
  if (/github\.com\/_private\//i.test(url) && Number(entry.status) === 404) return true;
  // GitHub issue/pr chrome (agent_tasks, hovercards, copilot) 404s are not a failed document.
  if (Number(entry.status) === 404 && type !== 'Document' && isGitHubWebUrl(url)) return true;
  if (Number(entry.status) === 404 && type && type !== 'Document') {
    if (/telemetry|collector|analytics|client-events/i.test(url)) return true;
  }
  return false;
}

function isNetworkFailure(entry = {}) {
  if (isIgnorableTelemetryFailure(entry)) return false;
  if (entry.failed === true || entry.errorText) return true;
  const status = Number(entry.status);
  return Number.isFinite(status) && status >= 400;
}

function shouldTrackActionNetworkRequest(type) {
  return !NOISY_ACTION_NETWORK_TYPES.has(String(type || ''));
}

function compactNetworkDeltaEntry(entry = {}) {
  const status = entry.pending ? 'pending' : (entry.errorText ? 'failed' : entry.status);
  return {
    method: compactActionText(entry.method || 'GET', 20).toUpperCase(),
    url: compactActionUrl(entry.url || ''),
    status,
    type: compactActionText(entry.type || '', 40),
    duration: Number.isFinite(entry.duration) ? entry.duration : null,
    errorText: entry.errorText ? compactActionText(entry.errorText, 120) : null,
    pending: entry.pending === true,
  };
}

function buildActionObservationDelta({ consoleBuf = null, exceptionBuf = null, netReqBuf = null } = {}, baseline = {}) {
  const consoleEntries = typeof consoleBuf?.since === 'function' ? consoleBuf.since(baseline.console || 0) : [];
  const exceptionEntries = typeof exceptionBuf?.since === 'function' ? exceptionBuf.since(baseline.exception || 0) : [];
  const networkEntries = typeof netReqBuf?.since === 'function' ? netReqBuf.since(baseline.network || 0) : [];
  const consoleCompact = consoleEntries.slice(-MAX_ACTION_DELTA_ENTRIES).map(compactConsoleDeltaEntry);
  const exceptionCompact = exceptionEntries.slice(-MAX_ACTION_DELTA_ENTRIES).map(compactExceptionDeltaEntry);
  const networkCompact = networkEntries.slice(-MAX_ACTION_DELTA_ENTRIES).map(compactNetworkDeltaEntry);
  return {
    console: {
      count: consoleEntries.length,
      errors: consoleEntries.filter(entry => ['error', 'assert'].includes(String(entry.level || '').toLowerCase())).length,
      warnings: consoleEntries.filter(entry => ['warning', 'warn'].includes(String(entry.level || '').toLowerCase())).length,
      entries: consoleCompact,
    },
    exceptions: {
      count: exceptionEntries.length,
      entries: exceptionCompact,
    },
    network: {
      count: networkEntries.length,
      failures: networkEntries.filter(isNetworkFailure).length,
      pending: networkEntries.filter(entry => entry.pending === true).length,
      entries: networkCompact,
    },
  };
}

function numericDeltaCount(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeConsoleDelta(delta = {}) {
  const entries = (delta.entries || []).slice(-MAX_ACTION_DELTA_ENTRIES).map(compactConsoleDeltaEntry);
  return {
    count: numericDeltaCount(delta.count, entries.length),
    errors: numericDeltaCount(delta.errors, entries.filter(entry => ['error', 'assert'].includes(String(entry.level || '').toLowerCase())).length),
    warnings: numericDeltaCount(delta.warnings, entries.filter(entry => ['warning', 'warn'].includes(String(entry.level || '').toLowerCase())).length),
    entries,
  };
}

function normalizeExceptionDelta(delta = {}) {
  const entries = (delta.entries || []).slice(-MAX_ACTION_DELTA_ENTRIES).map(compactExceptionDeltaEntry);
  return {
    count: numericDeltaCount(delta.count, entries.length),
    entries,
  };
}

function normalizeNetworkDelta(delta = {}) {
  const rawEntries = (delta.entries || []).slice(-MAX_ACTION_DELTA_ENTRIES);
  const computedFailures = rawEntries.filter(isNetworkFailure).length;
  const entries = rawEntries.map(compactNetworkDeltaEntry);
  return {
    count: numericDeltaCount(delta.count, entries.length),
    failures: Number.isFinite(Number(delta.failures))
      ? numericDeltaCount(delta.failures, computedFailures)
      : computedFailures,
    pending: numericDeltaCount(delta.pending, entries.filter(entry => entry.pending === true).length),
    entries,
  };
}

function noBaselineActionDiffText() {
  return 'No changes detected.';
}

function isPdfViewerPerceiveOutput(output) {
  return String(output || '').includes('chrome-cdp-ex.pdf-viewer.v1');
}

function pdfViewerSettleDiffText() {
  return 'No changes detected (settle shape was pdf-viewer.v1; empty AX).';
}

function rememberPdfViewerPerceive(lastPerceiveStore, opts, output) {
  lastPerceiveStore.output = output;
  lastPerceiveStore.snapshotOpts = perceiveSnapshotOpts({ ...opts, cards: false });
}

function pdfViewerPerceiveResult(lastPerceiveStore, opts, output) {
  rememberPdfViewerPerceive(lastPerceiveStore, opts, output);
  if (!opts.sinceAction) return output;
  if (!opts.diffBaseline || isPdfViewerPerceiveOutput(opts.diffBaseline)) {
    return pdfViewerSettleDiffText();
  }
  return formatPerceiveDiffOutput(opts.diffBaseline, output, { mode: 'since-action' });
}

function isCardsPerceiveOutput(output) {
  return String(output || '').includes(CARDS_SCHEMA);
}

function leftoverCardsCount(output) {
  const match = String(output || '').match(/chrome-cdp-ex\.cards\.v1\s+(\d+)\s+cards?\b/i);
  return match ? Number(match[1]) : 0;
}

function isScrollActionTarget(actionTarget = {}) {
  return String(actionTarget.resolvedBy || '').toLowerCase() === 'scroll'
    || String(actionTarget.action || '').toLowerCase() === 'scroll';
}

function isLeftoverDefaultAxScrollSettle(output, snapshotOpts = null, actionTarget = {}) {
  // Leftover golden-path / default AX (`perceive -C -d 8`) is the settle
  // shape for the next scroll (#295/#297/#299/#301/#311/#313). Viewport @ref rect chrome and
  // fold tags are not a page mutation. Visible-control cap-swap membership
  // is still changed, but the receipt summarizes it with unique named samples
  // (shared commit titles do not occupy both sides, #307) and
  // Next `-C -d 8` without Hint `--since-action` or a generic Recovery hint.
  // Honest leftover-ax-scroll no-change whose Next is already perceive does
  // not reprint "re-run perceive -C -d 8 instead of report" (#311), the
  // settle-shape Outcome reason essay (#313), the reprinted Page /
  // Viewport identity header (#316), the tautological AX body
  // "(no changes detected in AX tree)" (#318), or the tautological
  // "scroll: dispatched via scroll" / "Target: down" restatement (#320).
  // Outcome already states no-change. Position already states scroll
  // identity. Leftover-ax-scroll changed still prints dispatched/Target.
  // Cards / pdf-viewer / framed leftovers keep their own settle gates.
  if (!isScrollActionTarget(actionTarget)) return false;
  if (isPdfViewerPerceiveOutput(output)) return false;
  if (snapshotOpts?.cards === true || isCardsPerceiveOutput(output)) return false;
  if (snapshotOpts?.frameRef || isFramedPerceiveOutput(output)) return false;
  const text = String(output || '');
  return /^Page: /m.test(text) && /^Viewport: /m.test(text);
}

const DOCUMENT_SCROLL_EDGE_OUTCOME = 'document-scroll-edge';

function isDocumentScrollEdgeTarget(actionTarget = {}) {
  return actionTarget?.expectedOutcome === DOCUMENT_SCROLL_EDGE_OUTCOME;
}

function tagScrollLeftoverSettle(action, actionTarget, output, snapshotOpts = null) {
  // Edge forms are report-only (`to top` / `to bottom` for the window
  // document or nested overflow). After leftover `perceive -C -d 8` they
  // must not inherit leftover-ax-scroll-no-change (or leftover cards) so
  // the receipt does not grow Next: perceive -C -d 8.
  // Relative `scroll down N` still uses settle-diff leftover tagging.
  if (!actionTarget || action !== 'scroll') return actionTarget;
  if (isDocumentScrollEdgeTarget(actionTarget)) return actionTarget;
  if (isLeftoverFeedCardsSettle(output, snapshotOpts, actionTarget)) {
    actionTarget.expectedOutcome = actionTarget.expectedOutcome || 'cards-window-no-change';
  }
  if (isLeftoverDefaultAxScrollSettle(output, snapshotOpts, actionTarget)) {
    actionTarget.expectedOutcome = actionTarget.expectedOutcome || 'leftover-ax-scroll-no-change';
  }
  return actionTarget;
}

function isLeftoverFeedCardsSettle(output, snapshotOpts = null, actionTarget = {}) {
  // Leftover --cards / --role feed with a real feed window is the settle
  // shape for the next scroll (#293). 0-card leftovers still recapture
  // default AX (#257/#279). Non-scroll mutators still recapture AX so a
  // like/click is not hidden behind cards.
  if (!isScrollActionTarget(actionTarget)) return false;
  if (!(snapshotOpts?.cards === true || isCardsPerceiveOutput(output))) return false;
  return leftoverCardsCount(output) > 0;
}

function framedPerceiveRefFromOutput(output) {
  const match = String(output || '').match(/^Frame: (@f\d+)\b/m);
  return match ? match[1] : null;
}

function isFramedPerceiveOutput(output) {
  return framedPerceiveRefFromOutput(output) != null;
}

function shouldCaptureTopLevelActionSettle(snapshotOpts = null, output = null, actionTarget = {}) {
  // Frame-scoped settle is only for actions that targeted @fN / @fN:M.
  if (frameRefFromActionTarget(actionTarget)) return false;
  // Leftover pdf-viewer.v1 is an empty-AX plugin stub, not a tree. Recapturing
  // it would re-poison settle with the same stub (#282). Do not treat it as
  // leftover cards/frames, which recapture a real AX baseline (#257/#279).
  if (isPdfViewerPerceiveOutput(output)) return false;
  // Leftover --cards / --role feed dumps are a feed view, not an AX settle
  // shape. Discarding them (#257) without a before-snapshot made a mutating
  // click --js report no-change / "No visible AX tree change" while the
  // handler ran (#279). Recapture default AX so live text changes are
  // Outcome:changed. Leftover-cards + Escape still settles as no-change
  // against that recaptured tree. Leftover N>0 cards then scroll keeps the
  // cards window (#293) and must not recapture full AX.
  if (isLeftoverFeedCardsSettle(output, snapshotOpts, actionTarget)) return false;
  if (snapshotOpts?.cards === true || isCardsPerceiveOutput(output)) return true;
  return Boolean(snapshotOpts?.frameRef) || isFramedPerceiveOutput(output);
}

function actionSettleBaseline(output, snapshotOpts = null, actionTarget = {}) {
  // Leftover pdf-viewer.v1 is not an AX settle baseline. Reusing the empty
  // stub after perceive makes no-op press (Escape / Arrow*) look like a page
  // change (#282). Discard it and do not recapture — the next perceive is
  // still the same stub.
  if (isPdfViewerPerceiveOutput(output)) {
    return { output: null, opts: snapshotOpts || null };
  }
  // Compact --cards dumps are a feed view, not an AX settle baseline. Reusing
  // them after a 0-card page makes no-op press/type/clickxy look like a DOM
  // change (#257). Recapture default AX before the action (#279) instead of
  // settling as "No changes detected." Leftover N>0 cards then scroll keeps
  // that feed window so timestamp chrome is not a fake AX change (#293).
  if (isLeftoverFeedCardsSettle(output, snapshotOpts, actionTarget)) {
    return {
      output: output || null,
      opts: snapshotOpts ? { ...snapshotOpts, cards: true } : { cards: true },
    };
  }
  if (snapshotOpts?.cards === true || isCardsPerceiveOutput(output)) {
    return {
      output: null,
      opts: snapshotOpts ? { ...snapshotOpts, cards: false } : null,
    };
  }
  const actionFrame = frameRefFromActionTarget(actionTarget);
  const outputFrame = framedPerceiveRefFromOutput(output);
  const opts = snapshotOpts
    ? { ...snapshotOpts, frameRef: actionFrame }
    : snapshotOpts;
  // Leftover perceive --frame dumps are an iframe view. Reusing them after a
  // top-level fill/select/upload/click makes a real page mutation look like a
  // no-op against the child AX tree.
  if (outputFrame && outputFrame !== actionFrame) {
    return { output: null, opts: opts || null };
  }
  if (!actionFrame && snapshotOpts?.frameRef) {
    return { output: null, opts: opts || null };
  }
  return { output: output || null, opts: opts || null };
}

function actionDomDiffShowsChange(domDiff) {
  const text = String(domDiff || '').trim();
  if (!text) return false;
  if (/no changes detected/i.test(text)) return false;
  if (/no action baseline available/i.test(text)) return false;
  if (/unchanged; still first cards/i.test(text)) return false;
  if (/\bunchanged\b/i.test(text) && /virtualized window/i.test(text)) return false;
  // Empty-AX PDF plugin stubs are not an AX diff. Identical leftover
  // pdf-viewer.v1 reprints are not evidence of a page change (#282).
  if (isPdfViewerPerceiveOutput(text)) return false;
  return true;
}

function comparableActionHref(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    url.hash = '';
    return url.href;
  } catch {
    return raw;
  }
}

function shouldSkipActionDomSettle(beforeUrl, afterUrl) {
  const from = comparableActionHref(beforeUrl);
  const to = comparableActionHref(afterUrl);
  return Boolean(from && to && from !== to);
}

function formatActionNavigationDiff(fromUrl, toUrl) {
  return `Navigated ${String(fromUrl || '').trim()} -> ${String(toUrl || '').trim()}`;
}

function actionNetworkShowsDocumentNavigation(networkDelta = {}) {
  return (networkDelta.entries || []).some((entry) => {
    const type = String(entry.type || '');
    const method = String(entry.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') return false;
    if (type !== 'Document') return false;
    if (entry.failed === true || entry.errorText) return false;
    return true;
  });
}

function actionNavigationEvidence(actionResult = {}) {
  const effects = actionResult.effects || {};
  const nav = effects.navigation;
  let from = '';
  let to = '';
  if (nav && typeof nav === 'object') {
    from = String(nav.from || nav.before || nav.pageHref || '');
    to = String(nav.to || nav.after || nav.url || nav.href || '');
  } else if (typeof nav === 'string') {
    to = nav;
  }
  const before = from
    || String(effects.page?.url || actionResult.target?.pageHrefBefore || actionResult.target?.pageHref || actionResult.target?.page?.url || '');
  const after = to
    || String(effects.pageHealth?.evidence?.url || effects.pageHealth?.url || actionResult.target?.pageHrefAfter || '');
  const hrefChanged = shouldSkipActionDomSettle(before, after) || nav?.changed === true;
  const documentNavigation = actionNetworkShowsDocumentNavigation(effects.networkDelta || {});
  return {
    from: before,
    to: after,
    hrefChanged,
    documentNavigation,
    navigated: Boolean(hrefChanged || documentNavigation),
  };
}

function actionHasDomObservation(actionResult = {}) {
  return Object.prototype.hasOwnProperty.call(actionResult.effects || {}, 'domDiff')
    && actionResult.effects.domDiff !== null
    && actionResult.effects.domDiff !== undefined;
}

function buildActionOutcome(actionResult = {}) {
  const effects = actionResult.effects || {};
  const diagnosis = effects.diagnosis || null;
  const domObserved = actionHasDomObservation(actionResult);
  const navigation = actionNavigationEvidence(actionResult);
  const controlStateChanged = Boolean(
    actionResult.target?.controlStateChanged
    || effects.controlStateChanged
  );
  const changed = actionDomDiffShowsChange(effects.domDiff) || navigation.navigated || controlStateChanged;
  const base = {
    schema: 'chrome-cdp-ex.action-outcome.v1',
    changed: domObserved || navigation.navigated || controlStateChanged ? changed : null,
    needsAttention: false,
  };

  if (actionResult.dispatch?.ok === false || effects.failure?.kind) {
    return {
      ...base,
      status: 'failed',
      changed: false,
      needsAttention: true,
      evidence: 'dispatch',
      reason: effects.failure?.reason || 'Action failed before dispatch completed.',
    };
  }

  if (diagnosis?.kind === 'observation-error' || effects.observationError?.message) {
    return {
      ...base,
      status: 'attention',
      needsAttention: true,
      evidence: 'observation',
      reason: diagnosis.reason || 'Action dispatched, but post-action observation failed.',
    };
  }

  if (actionResult.dispatch?.ok === true && actionResult.settle?.ok === false) {
    return {
      ...base,
      status: 'timeout',
      needsAttention: true,
      evidence: 'settle',
      reason: 'Action dispatched, but post-action observation timed out.',
    };
  }

  if (diagnosis && diagnosis.status !== 'ok') {
    return {
      ...base,
      status: 'attention',
      needsAttention: true,
      evidence: diagnosis.source || 'diagnosis',
      reason: diagnosis.reason || 'Action needs follow-up.',
    };
  }

  if (navigation.navigated) {
    return {
      ...base,
      status: 'changed',
      changed: true,
      evidence: 'navigation',
      reason: navigation.hrefChanged && navigation.from && navigation.to
        ? `Page navigated from ${navigation.from} to ${navigation.to}.`
        : 'Observed a document navigation after the action.',
    };
  }

  if (changed) {
    return {
      ...base,
      status: 'changed',
      changed: true,
      evidence: 'dom',
      reason: 'Observed page change after action.',
    };
  }

  if (domObserved) {
    const expectedNoChange = isExpectedNoChange(
      actionResult.target,
      actionResult.effects?.domDiff,
      actionResult.action,
    );
    return {
      ...base,
      status: 'no-change',
      changed: false,
      needsAttention: !expectedNoChange,
      evidence: 'dom',
      reason: expectedNoChange
        ? expectedNoChangeReason(actionResult.target, actionResult.action, actionResult.effects?.domDiff)
        : 'No visible AX tree change observed after action.',
    };
  }

  return {
    ...base,
    status: 'dispatched',
    evidence: 'dispatch',
    reason: 'Action dispatched; no DOM observation was captured for this command.',
  };
}

function applyActionOutcome(actionResult) {
  actionResult.outcome = buildActionOutcome(actionResult);
  return actionResult;
}

function stableActionHash(value = {}) {
  const text = JSON.stringify(value, Object.keys(value || {}).sort());
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function buildActionId(actionResult = {}) {
  const seed = {
    action: actionResult.action || '',
    target: actionResult.target?.label || actionResult.target?.input || '',
    dispatch: actionResult.dispatch?.method || '',
    settle: actionResult.settle?.durationMs || 0,
    outcome: actionResult.outcome?.status || '',
  };
  const first = stableActionHash(seed);
  const second = stableActionHash({ ...seed, dispatchOk: actionResult.dispatch?.ok === true });
  return `act_${first}${second.slice(0, 4)}`;
}

function actionTargetSummary(actionResult = {}) {
  const target = actionResult.target || {};
  return compactActionText(target.label || target.input || target.selector || target.resolvedBy || actionResult.action || '', 160) || null;
}

function actionSettlementStrategy(actionResult = {}) {
  if (actionResult.dispatch?.ok === false) return 'dispatch-failed';
  if (actionResult.effects?.failure?.kind) return 'dispatch-failed';
  if (actionResult.effects?.observationError?.message) return 'observation-error';
  if (actionResult.settle?.ok === false) return 'timeout';
  if (actionResult.effects?.domDiff != null) return 'dom-observation';
  return 'report-only';
}

function actionSettlementObservedChannels(actionResult = {}) {
  const effects = actionResult.effects || {};
  const channels = [];
  if (actionResult.dispatch?.ok === false || effects.failure?.kind) channels.push('dispatch');
  if (effects.domDiff != null) channels.push('ax-diff');
  if (Object.hasOwn(effects, 'consoleDelta')) channels.push('console');
  if (Object.hasOwn(effects, 'exceptionDelta')) channels.push('exceptions');
  if (Object.hasOwn(effects, 'networkDelta')) channels.push('network');
  if (effects.observationError?.message) channels.push('observation');
  return [...new Set(channels)];
}

function actionSettlementSignals(actionResult = {}, strategy = actionSettlementStrategy(actionResult)) {
  if (strategy === 'dispatch-failed') return ['dispatch-failed'];
  if (strategy === 'observation-error') return ['observation-error'];
  if (strategy === 'timeout') return ['settlement-timeout'];
  if (strategy === 'report-only') return ['report-only'];
  return [];
}

function actionSettlementState(actionResult = {}, strategy = actionSettlementStrategy(actionResult)) {
  if (strategy === 'dispatch-failed') return 'failed';
  if (strategy === 'report-only') return 'not-applicable';
  if (actionResult.settle?.ok === true) return 'settled';
  return 'not-confirmed';
}

function actionSettlementReason(actionResult = {}, strategy = actionSettlementStrategy(actionResult)) {
  if (strategy === 'dispatch-failed') return 'Action failed before dispatch completed.';
  if (strategy === 'observation-error') return 'Action dispatched, but post-action observation failed.';
  if (strategy === 'timeout') return 'Action dispatched, but post-action observation did not confirm settlement.';
  if (strategy === 'report-only') return 'Action dispatched without post-action DOM observation.';
  if (strategy === 'dom-observation') return 'Post-action DOM observation completed.';
  return 'Action settlement status is not confirmed.';
}

function buildSettlementReceipt(actionResult = {}) {
  const strategy = actionSettlementStrategy(actionResult);
  return {
    ok: actionResult.settle?.ok ?? null,
    state: actionSettlementState(actionResult, strategy),
    strategy,
    durationMs: Number.isFinite(actionResult.settle?.durationMs) ? actionResult.settle.durationMs : null,
    timeoutMs: Number.isFinite(actionResult.settle?.timeoutMs) ? actionResult.settle.timeoutMs : null,
    observedChannels: actionSettlementObservedChannels(actionResult),
    signals: actionSettlementSignals(actionResult, strategy),
    reason: actionSettlementReason(actionResult, strategy),
  };
}

function actionDeltaDetails(actionResult = {}) {
  const effects = actionResult.effects || {};
  const details = [];
  const outcome = actionResult.outcome || buildActionOutcome(actionResult);

  if (effects.failure?.kind) {
    details.push({
      type: 'dispatch',
      status: 'failed',
      summary: `Dispatch failed: ${effects.failure.kind}`,
      ...(effects.failure.reason ? { sample: effects.failure.reason } : {}),
    });
  } else if (outcome.status === 'changed') {
    const sample = summarizeActionDomDiff(effects.domDiff).sample;
    details.push({
      type: 'dom',
      status: 'changed',
      summary: 'DOM changed after action',
      ...(sample ? { sample } : {}),
    });
  } else if (outcome.status === 'no-change') {
    details.push({
      type: 'dom',
      status: 'no-change',
      summary: 'No visible AX tree change observed',
    });
  } else if (effects.domDiff == null) {
    details.push({
      type: 'dom',
      status: 'not-captured',
      summary: 'DOM observation not captured',
    });
  }

  const consoleDelta = normalizeConsoleDelta(effects.consoleDelta || {});
  const consoleSummary = summarizeActionConsoleDelta(consoleDelta);
  details.push({
    type: 'console',
    status: consoleDelta.count > 0 ? 'changed' : 'unchanged',
    count: Number(consoleDelta.count || 0),
    errors: Number(consoleDelta.errors || 0),
    warnings: Number(consoleDelta.warnings || 0),
    summary: consoleSummary.summary || 'Console unchanged',
    ...(consoleSummary.sample ? { sample: consoleSummary.sample } : {}),
  });

  const exceptionDelta = normalizeExceptionDelta(effects.exceptionDelta || {});
  const exceptionSummary = summarizeActionExceptionDelta(exceptionDelta);
  details.push({
    type: 'exception',
    status: exceptionDelta.count > 0 ? 'changed' : 'unchanged',
    count: Number(exceptionDelta.count || 0),
    summary: exceptionSummary.summary || 'Exceptions unchanged',
    ...(exceptionSummary.sample ? { sample: exceptionSummary.sample } : {}),
  });

  const networkDelta = normalizeNetworkDelta(effects.networkDelta || {});
  const networkSummary = summarizeActionNetworkDelta(networkDelta);
  details.push({
    type: 'network',
    status: networkDelta.count > 0 ? 'changed' : 'unchanged',
    count: Number(networkDelta.count || 0),
    failures: Number(networkDelta.failures || 0),
    pending: Number(networkDelta.pending || 0),
    summary: networkSummary.summary || 'Network unchanged',
    ...(networkSummary.sample ? { sample: networkSummary.sample } : {}),
  });

  if (effects.observationError?.message) {
    details.push({
      type: 'observation',
      status: 'error',
      summary: `Observation error: ${effects.observationError.message}`,
    });
  }
  return details;
}

function actionDeltaLines(actionResult = {}) {
  const lines = [];
  for (const detail of actionDeltaDetails(actionResult)) {
    if (detail.summary) lines.push(detail.summary);
    if (!detail.sample) continue;
    if (detail.type === 'dom') lines.push(`DOM sample: ${detail.sample}`);
    else if (detail.type === 'console') lines.push(`Console sample: ${detail.sample}`);
    else if (detail.type === 'exception') lines.push(`Exception sample: ${detail.sample}`);
    else if (detail.type === 'network') lines.push(`Network sample: ${detail.sample}`);
  }
  return lines;
}

function actionBlockingSignals(actionResult = {}) {
  const signals = [];
  const diagnosis = actionResult.effects?.diagnosis || null;
  const recommendation = actionResult.recommendation || {};
  if (Array.isArray(recommendation.blockingSignals)) signals.push(...recommendation.blockingSignals);
  if (diagnosis?.kind && diagnosis.status !== 'ok') signals.push(diagnosis.kind);
  if (actionResult.outcome?.status === 'timeout') signals.push('settlement-timeout');
  if (actionResult.effects?.observationError?.message) signals.push('observation-error');
  return [...new Set(signals)];
}

function leftoverAxScrollNextIsPerceive(actionResult = {}) {
  const next = String(
    actionResult.recommendation?.commands?.[0]
    || actionResult.recommendation?.verifyCommand
    || '',
  );
  return /\bperceive\s+\S+\s+-C\s+-d\s+8\b/.test(next);
}

function actionRecoveryHint(actionResult = {}) {
  const recommendation = actionResult.recommendation || {};
  const diagnosis = actionResult.effects?.diagnosis || null;
  const outcome = actionResult.outcome || buildActionOutcome(actionResult);
  const leftoverAxScroll = isExpectedLeftoverAxScrollNoChange(actionResult.target || {});
  // Leftover-ax-scroll whose Next is already perceive -C -d 8:
  // no-change "AX identities unchanged; re-run perceive -C -d 8 instead of
  // report." restates Next (#311). changed generic "Continue from the
  // observed action evidence." is leftover chrome (#301). Do not drop a
  // Recovery hint on generic non-leftover actions, or when Next is report /
  // investigate.
  if (
    leftoverAxScroll
    && leftoverAxScrollNextIsPerceive(actionResult)
    && (outcome.status === 'no-change' || outcome.status === 'changed')
  ) {
    return null;
  }
  if (typeof recommendation.recoveryHint === 'string' && recommendation.recoveryHint.trim()) return recommendation.recoveryHint;
  if (diagnosis?.reason && diagnosis.status !== 'ok') return diagnosis.reason;
  // Leftover golden-path AX scroll already prints Outcome:changed, the compact
  // named cap-swap/structural diff, and Next `-C -d 8` (#301). The generic
  // "Continue from the observed action evidence." line is leftover chrome.
  if (
    outcome.status === 'changed'
    && leftoverAxScroll
  ) {
    return null;
  }
  if (outcome.status === 'changed') return 'Continue from the observed action evidence.';
  if (outcome.status === 'failed') return 'Run the recovery command before retrying the action.';
  if (outcome.status === 'timeout') return 'Verify the post-action state before retrying; the action may have dispatched.';
  if (outcome.status === 'dispatched') return 'Capture a fresh observation before assuming task progress.';
  return recommendation.reason || outcome.reason || actionResult.nextHint || null;
}

function buildActionReceipt(actionResult = {}) {
  const outcome = actionResult.outcome || buildActionOutcome(actionResult);
  const recommendation = actionResult.recommendation || {};
  const nextSteps = uniqueNextStepCommands(actionResult.nextSteps || recommendation.commands || []);
  return {
    schema: 'chrome-cdp-ex.action-receipt.v1',
    actionId: buildActionId(actionResult),
    actionName: actionResult.action || null,
    targetSummary: actionTargetSummary(actionResult),
    dispatch: actionResult.dispatch || null,
    settlement: buildSettlementReceipt(actionResult),
    outcome: outcome.status || 'unknown',
    observedDelta: actionDeltaLines(actionResult),
    observedDeltaDetails: actionDeltaDetails(actionResult),
    blockingSignals: actionBlockingSignals(actionResult),
    recoveryHint: actionRecoveryHint(actionResult),
    nextSteps,
    recovery: {
      strategy: recommendation.strategy || actionResult.effects?.diagnosis?.recovery?.strategy || null,
      priority: recommendation.priority || actionResult.effects?.diagnosis?.recovery?.priority || null,
      verifyCommand: recommendation.verifyCommand || actionResult.effects?.diagnosis?.recovery?.verifyCommand || null,
    },
  };
}

function applyActionReceipt(actionResult) {
  actionResult.receipt = buildActionReceipt(actionResult);
  return actionResult;
}

function applyActionObservationDelta(actionResult, delta = {}) {
  if (!actionResult.effects) actionResult.effects = {};
  const consoleDelta = normalizeConsoleDelta(delta.console || {});
  const exceptionDelta = normalizeExceptionDelta(delta.exceptions || {});
  const networkDelta = normalizeNetworkDelta(delta.network || {});
  actionResult.effects.consoleDelta = consoleDelta;
  actionResult.effects.exceptionDelta = exceptionDelta;
  actionResult.effects.networkDelta = networkDelta;
  actionResult.effects.console = consoleDelta.entries || [];
  actionResult.effects.exceptions = exceptionDelta.entries || [];
  actionResult.effects.network = networkDelta.entries || [];
  return applyActionReceipt(applyActionVerdict(applyActionRecommendation(applyActionOutcome(applyActionDiagnosis(actionResult)))));
}

function actionDiagnosisSignals(actionResult = {}) {
  const effects = actionResult.effects || {};
  const consoleDelta = normalizeConsoleDelta(effects.consoleDelta || {});
  const exceptionDelta = normalizeExceptionDelta(effects.exceptionDelta || {});
  const networkDelta = normalizeNetworkDelta(effects.networkDelta || {});
  return {
    dispatchOk: actionResult.dispatch?.ok !== false,
    settleOk: actionResult.settle?.ok ?? null,
    domChanged: actionDomDiffShowsChange(effects.domDiff) || actionNavigationEvidence(actionResult).navigated,
    consoleErrors: consoleDelta.errors,
    consoleWarnings: consoleDelta.warnings,
    exceptions: exceptionDelta.count,
    networkFailures: networkDelta.failures,
    networkPending: networkDelta.pending,
    observationError: Boolean(effects.observationError?.message),
  };
}

function createActionDiagnosis(actionResult = {}) {
  const effects = actionResult.effects || {};
  const targetId = actionTargetCommandId(actionResult.target || {});
  const targetInput = actionFailureInput(actionResult.target || effects.failure?.target || {});
  const signals = actionDiagnosisSignals(actionResult);
  const finish = (diagnosis) => ({
    ...diagnosis,
    recovery: buildActionRecoveryPlan(diagnosis, { targetId, targetInput }),
  });
  const base = {
    schema: 'chrome-cdp-ex.action-diagnosis.v1',
    status: 'ok',
    kind: 'ok',
    confidence: 'medium',
    source: 'action',
    reason: 'Action dispatched without captured runtime failures.',
    nextCommand: actionResult.nextHint || null,
    signals,
  };

  if (effects.failure?.kind) {
    return finish({
      ...base,
      status: 'blocked',
      kind: effects.failure.kind,
      confidence: 'high',
      source: 'dispatch',
      reason: effects.failure.reason || 'The action failed before dispatch completed.',
      nextCommand: effects.failure.nextCommand || actionResult.nextHint || `cdp status ${targetId}`,
    });
  }

  if (signals.observationError) {
    return finish({
      ...base,
      status: 'attention',
      kind: 'observation-error',
      confidence: 'medium',
      source: 'observation',
      reason: `The action was dispatched, but post-action observation failed: ${effects.observationError.message}`,
      nextCommand: `cdp status ${targetId}`,
    });
  }

  if (signals.exceptions > 0) {
    return finish({
      ...base,
      status: 'attention',
      kind: 'exception',
      confidence: 'high',
      source: 'exception',
      reason: 'The action triggered one or more page exceptions.',
      nextCommand: `cdp console ${targetId} --errors`,
    });
  }

  if (signals.networkFailures > 0) {
    return finish({
      ...base,
      status: 'attention',
      kind: 'network-failure',
      confidence: 'high',
      source: 'network',
      reason: 'The action triggered one or more failed network requests.',
      nextCommand: `cdp netlog ${targetId}`,
    });
  }

  if (signals.networkPending > 0) {
    return finish({
      ...base,
      status: 'attention',
      kind: 'network-pending',
      confidence: 'medium',
      source: 'network',
      reason: 'The action left network requests pending after the settle window.',
      nextCommand: `cdp netlog ${targetId}`,
    });
  }

  if (signals.consoleErrors > 0) {
    return finish({
      ...base,
      status: 'attention',
      kind: 'console-error',
      confidence: 'high',
      source: 'console',
      reason: 'The action triggered one or more console errors.',
      nextCommand: `cdp console ${targetId} --errors`,
    });
  }

  if (actionResult.dispatch?.ok === true && actionResult.settle?.ok === false) {
    return finish({
      ...base,
      status: 'attention',
      kind: 'observation-timeout',
      confidence: 'medium',
      source: 'settle',
      reason: 'The action was dispatched, but post-action observation did not finish cleanly.',
      nextCommand: `cdp perceive ${targetId} --since-action`,
    });
  }

  if (signals.domChanged) {
    return finish({
      ...base,
      status: 'ok',
      kind: 'dom-changed',
      confidence: 'medium',
      source: 'dom',
      reason: 'The action dispatched and changed the perceived DOM.',
      nextCommand: actionResult.nextHint || `cdp perceive ${targetId} --since-action`,
    });
  }

  return base;
}

function applyActionDiagnosis(actionResult) {
  if (!actionResult.effects) actionResult.effects = {};
  const diagnosis = createActionDiagnosis(actionResult);
  if (diagnosis.status === 'ok' && diagnosis.kind === 'ok') delete actionResult.effects.diagnosis;
  else actionResult.effects.diagnosis = diagnosis;
  return actionResult;
}

function buildActionRecommendation(actionResult = {}) {
  const target = actionTargetCommandPrefix(actionResult.target || {});
  const diagnosis = actionResult.effects?.diagnosis || null;
  if (diagnosis && diagnosis.status !== 'ok') {
    const commands = recoveryCommandsFromDiagnosis(diagnosis);
    return {
      source: 'action-diagnosis',
      action: actionResult.action || null,
      targetPrefix: target,
      diagnosisKind: diagnosis.kind || null,
      strategy: diagnosis.recovery?.strategy || diagnosis.kind || 'recover-action',
      priority: diagnosis.recovery?.priority || (diagnosis.status === 'blocked' ? 'high' : 'medium'),
      verifyCommand: diagnosis.recovery?.verifyCommand || diagnosis.nextCommand || null,
      commands,
    };
  }
  const outcome = actionResult.outcome || buildActionOutcome(actionResult);
  if (outcome.status === 'no-change') {
    return buildNoChangeOutcomeRecommendation({
      action: actionResult.action || null,
      target,
      targetInput: actionFailureInput(actionResult.target || {}),
      targetInfo: {
        ...(actionResult.target || {}),
        page: actionResult.target?.page || actionResult.effects?.page,
      },
      extraText: String(actionResult.effects?.domDiff || ''),
    });
  }
  if (isExpectedLeftoverAxScrollNoChange(actionResult.target || {})) {
    const nextCommand = `cdp perceive ${target} -C -d 8`;
    return {
      source: 'action-evidence',
      action: actionResult.action || null,
      targetPrefix: target,
      strategy: 'continue-from-evidence',
      priority: 'medium',
      reason: 'Leftover golden-path AX already includes observed evidence; re-run perceive -C -d 8 instead of report.',
      commands: uniqueNextStepCommands([nextCommand]),
      optionalCommands: [],
    };
  }

  return {
    source: 'action-evidence',
    action: actionResult.action || null,
    targetPrefix: target,
    strategy: actionResult.effects?.domDiff ? 'continue-from-evidence' : 'continue-or-handoff',
    priority: 'medium',
    reason: actionResult.effects?.domDiff
      ? 'The action already includes observed page evidence; continue from that evidence without an extra verify call.'
      : 'The action dispatched without captured runtime trouble; use report or record-actions when handing off.',
    commands: uniqueNextStepCommands([
      `cdp report ${target} --format json`,
      `cdp record-actions ${target} --format json`,
    ]),
    optionalCommands: uniqueNextStepCommands([
      `cdp perceive ${target} --since-action`,
    ]),
  };
}

const GENERIC_SINCE_ACTION_HINT = 'Use perceive --since-action if more evidence is needed';

function isGenericSinceActionHint(hint) {
  return String(hint || '').trim() === GENERIC_SINCE_ACTION_HINT;
}

function applyActionRecommendation(actionResult) {
  const recommendation = buildActionRecommendation(actionResult);
  actionResult.recommendation = recommendation;
  actionResult.nextSteps = uniqueNextStepCommands(recommendation.commands || []);
  if (
    isExpectedLeftoverAxScrollNoChange(actionResult.target || {})
    && isGenericSinceActionHint(actionResult.nextHint)
  ) {
    actionResult.nextHint = null;
  }
  return actionResult;
}

function buildActionVerdict(actionResult = {}) {
  const diagnosis = actionResult.effects?.diagnosis || null;
  const outcome = actionResult.outcome || buildActionOutcome(actionResult);
  const recommendation = actionResult.recommendation || {};
  const nextSteps = uniqueNextStepCommands(recommendation.commands || []);
  const primaryNextStep = nextSteps[0] || recommendation.verifyCommand || actionResult.nextHint || null;
  const base = {
    schema: 'chrome-cdp-ex.action-verdict.v1',
    source: diagnosis && diagnosis.status !== 'ok' ? 'diagnosis' : 'outcome',
    primaryNextStep,
    nextSteps,
    reason: diagnosis && diagnosis.status !== 'ok'
      ? diagnosis.reason || outcome.reason || null
      : outcome.reason || recommendation.reason || null,
  };

  if (diagnosis && diagnosis.status !== 'ok') {
    const blocked = diagnosis.status === 'blocked' || outcome.status === 'failed';
    return {
      ...base,
      status: blocked ? 'blocked' : 'recover',
      confidence: diagnosis.confidence || (blocked ? 'high' : 'medium'),
      canContinue: false,
      needsRecovery: true,
    };
  }

  switch (outcome.status) {
    case 'changed':
      return {
        ...base,
        status: 'continue',
        confidence: 'medium',
        canContinue: true,
        needsRecovery: false,
      };
    case 'no-change': {
      const expectedNoChange = isExpectedNoChange(
        actionResult.target,
        actionResult.effects?.domDiff,
        actionResult.action,
      );
      return {
        ...base,
        status: expectedNoChange ? 'continue' : 'investigate',
        confidence: 'medium',
        canContinue: expectedNoChange,
        needsRecovery: !expectedNoChange,
      };
    }
    case 'failed':
      return {
        ...base,
        status: 'blocked',
        confidence: 'high',
        canContinue: false,
        needsRecovery: true,
      };
    case 'timeout':
      return {
        ...base,
        status: 'verify',
        confidence: 'low',
        canContinue: false,
        needsRecovery: true,
      };
    case 'attention':
      return {
        ...base,
        status: 'recover',
        confidence: 'medium',
        canContinue: false,
        needsRecovery: true,
      };
    case 'dispatched':
    default:
      return {
        ...base,
        status: 'verify',
        confidence: 'low',
        canContinue: false,
        needsRecovery: false,
      };
  }
}

function applyActionVerdict(actionResult) {
  actionResult.verdict = buildActionVerdict(actionResult);
  return actionResult;
}

function countLabel(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function formatConsoleDeltaSample(entry) {
  if (!entry) return null;
  const level = entry.level || 'log';
  const loc = entry.loc ? ` @ ${entry.loc}` : '';
  return `[${level}] ${redactSensitiveString(entry.text || '(empty)')}${loc}`;
}

function formatExceptionDeltaSample(entry) {
  if (!entry) return null;
  const loc = entry.loc ? ` @ ${entry.loc}` : '';
  return `${redactSensitiveString(entry.message || 'Unknown exception')}${loc}`;
}

function formatNetworkDeltaSample(entry) {
  if (!entry) return null;
  const status = entry.errorText || entry.status || 'pending';
  const duration = Number.isFinite(entry.duration) ? ` in ${entry.duration}ms` : '';
  return `${entry.method || 'GET'} ${redactSensitiveString(entry.url || '(unknown URL)')} -> ${status}${duration}`;
}

function summarizeActionConsoleDelta(delta = {}) {
  const count = Number(delta.count || 0);
  if (count === 0) return { summary: null, sample: null };
  const parts = [];
  if (delta.errors) parts.push(countLabel(delta.errors, 'error'));
  if (delta.warnings) parts.push(countLabel(delta.warnings, 'warning'));
  const summary = `Console: ${countLabel(count, 'entry', 'entries')}${parts.length ? ` (${parts.join(', ')})` : ''}`;
  const prioritized = [...(delta.entries || [])].find(entry => ['error', 'assert'].includes(String(entry.level || '').toLowerCase()))
    || [...(delta.entries || [])].find(entry => ['warning', 'warn'].includes(String(entry.level || '').toLowerCase()))
    || (delta.entries || [])[0];
  return { summary, sample: formatConsoleDeltaSample(prioritized) };
}

function summarizeActionExceptionDelta(delta = {}) {
  const count = Number(delta.count || 0);
  if (count === 0) return { summary: null, sample: null };
  return {
    summary: `Exception: ${count} thrown`,
    sample: formatExceptionDeltaSample((delta.entries || [])[0]),
  };
}

function summarizeActionNetworkDelta(delta = {}) {
  const count = Number(delta.count || 0);
  if (count === 0) return { summary: null, sample: null };
  const failures = Number(delta.failures || 0);
  const pending = Number(delta.pending || 0);
  const parts = [];
  if (failures) parts.push(countLabel(failures, 'failed', 'failed'));
  if (pending) parts.push(countLabel(pending, 'pending', 'pending'));
  const summary = `Network: ${countLabel(count, 'request')}${parts.length ? ` (${parts.join(', ')})` : ''}`;
  const prioritized = [...(delta.entries || [])].find(isNetworkFailure) || (delta.entries || [])[0];
  return { summary, sample: formatNetworkDeltaSample(prioritized) };
}

function summarizeActionObservationEffects(effects = {}) {
  const consoleSummary = summarizeActionConsoleDelta(effects.consoleDelta);
  const exceptionSummary = summarizeActionExceptionDelta(effects.exceptionDelta);
  const networkSummary = summarizeActionNetworkDelta(effects.networkDelta);
  return {
    consoleSummary: consoleSummary.summary,
    consoleSample: consoleSummary.sample,
    exceptionSummary: exceptionSummary.summary,
    exceptionSample: exceptionSummary.sample,
    networkSummary: networkSummary.summary,
    networkSample: networkSummary.sample,
  };
}

const LEFTOVER_AX_SCROLL_CENSUS_RE = /^(Interactive: |Console: |Coords: )/;
const GENERIC_CHANGED_REASON = 'Observed page change after action.';
const LEFTOVER_AX_SCROLL_NO_CHANGE_REASON = 'Settle shape was leftover golden-path AX; viewport rect chrome did not replace identities.';

function stripLeftoverAxScrollCensusChrome(diff) {
  // Leftover-ax-scroll Next is already `perceive -C -d 8`. Interactive census,
  // Console: clean, and the clickxy Coords tutorial do not change that step
  // (#309). Do not rewrite the leftover perceive dump itself.
  return String(diff || '')
    .split('\n')
    .filter(line => !LEFTOVER_AX_SCROLL_CENSUS_RE.test(line))
    .join('\n');
}

const LEFTOVER_AX_SCROLL_IDENTITY_HEADER_RE = /^(Page: |Viewport: )/;

function stripLeftoverAxScrollNoChangeIdentityChrome(diff) {
  // Honest leftover-ax-scroll no-change whose Next is already perceive.
  // Position already states scroll identity. Viewport Scroll restates that
  // Position. Page URL restates leftover session identity that Next
  // perceive re-establishes (#316). Do not strip from leftover-ax-scroll
  // changed or from the leftover perceive dump itself.
  return String(diff || '')
    .split('\n')
    .filter(line => !LEFTOVER_AX_SCROLL_IDENTITY_HEADER_RE.test(line))
    .join('\n')
    .replace(/^\n+/, '');
}

const LEFTOVER_AX_SCROLL_NO_CHANGE_BODY_RE = /^\(no changes detected in AX tree\)$/i;

function stripLeftoverAxScrollNoChangeAxBodyChrome(diff) {
  // Honest leftover-ax-scroll no-change whose Next is already perceive.
  // Outcome already states no-change. The AX body restates that (#318).
  // Do not strip from leftover-ax-scroll changed or from the leftover
  // perceive dump itself.
  return String(diff || '')
    .split('\n')
    .filter(line => !LEFTOVER_AX_SCROLL_NO_CHANGE_BODY_RE.test(line.trim()))
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
}

function formatActionText(result) {
  const diagnostics = summarizeActionObservationEffects(result.effects || {});
  const diagnosis = result.effects?.diagnosis || null;
  const leftoverAxScroll = isExpectedLeftoverAxScrollNoChange(result.target);
  const leftoverAxScrollNext = leftoverAxScroll && result.recommendation?.commands?.[0];
  // Honest leftover-ax-scroll no-change whose Next is already perceive.
  // Scrolled by / Position already states the action. dispatched via
  // scroll + Target: down restates that same leftover input (#320).
  // Do not strip from leftover-ax-scroll changed, leftover --cards,
  // pdf-viewer.v1, or generic non-leftover actions.
  const skipLeftoverNoChangeDispatchChrome = leftoverAxScroll
    && leftoverAxScrollNextIsPerceive(result)
    && result.outcome?.status === 'no-change'
    && result.dispatch?.ok;
  const lines = [];
  if (!skipLeftoverNoChangeDispatchChrome) {
    lines.push(`${result.action}: ${result.dispatch.ok ? 'dispatched' : 'failed'} via ${result.dispatch.method}`);
    if (result.target?.label) lines.push(`Target: ${result.target.label}`);
  }
  if (result.outcome?.status) {
    const skipGenericChangedReason = leftoverAxScroll
      && result.outcome.status === 'changed'
      && result.outcome.reason === GENERIC_CHANGED_REASON;
    // Honest leftover-ax-scroll no-change whose Next is already perceive
    // already prints Outcome: no-change. The settle-shape essay restates
    // that Outcome (#313). Do not drop Outcome reasons on generic
    // non-leftover actions, leftover --cards, or pdf-viewer.v1.
    const skipLeftoverNoChangeReason = leftoverAxScroll
      && leftoverAxScrollNextIsPerceive(result)
      && result.outcome.status === 'no-change'
      && result.outcome.reason === LEFTOVER_AX_SCROLL_NO_CHANGE_REASON;
    const reason = skipGenericChangedReason || skipLeftoverNoChangeReason || !result.outcome.reason
      ? ''
      : ` — ${result.outcome.reason}`;
    lines.push(`Outcome: ${result.outcome.status}${reason}`);
  }
  if (result.receipt?.outcome) {
    const skipReceiptStatus = leftoverAxScroll
      && result.receipt.outcome === result.outcome?.status
      && !(Array.isArray(result.receipt.blockingSignals) && result.receipt.blockingSignals.length);
    if (!skipReceiptStatus) lines.push(`Receipt: ${result.receipt.outcome}`);
    if (Array.isArray(result.receipt.blockingSignals) && result.receipt.blockingSignals.length) {
      lines.push(`Blocking signals: ${result.receipt.blockingSignals.join(', ')}`);
    }
    if (result.receipt.recoveryHint) lines.push(`Recovery hint: ${result.receipt.recoveryHint}`);
  }
  if (result.effects?.failure?.kind) lines.push(`Failure: ${result.effects.failure.kind}`);
  if (diagnosis && diagnosis.status !== 'ok') {
    lines.push(`Diagnosis: ${diagnosis.kind}${diagnosis.reason ? ` — ${diagnosis.reason}` : ''}`);
  }
  if (result.effects?.observationError?.message) lines.push(`Observation error: ${result.effects.observationError.message}`);
  if (result.verdict?.status) {
    const skipDupReason = leftoverAxScroll
      && result.verdict.reason
      && result.verdict.reason === result.outcome?.reason;
    const reason = skipDupReason || !result.verdict.reason ? '' : ` — ${result.verdict.reason}`;
    lines.push(`Verdict: ${result.verdict.status}${reason}`);
  }
  if (result.settle) {
    const duration = result.settle.durationMs ? ` in ${result.settle.durationMs}ms` : '';
    lines.push(`Settle: ${result.settle.ok ? 'ok' : 'not confirmed'}${duration}`);
  }
  if (diagnostics.consoleSummary) lines.push(diagnostics.consoleSummary);
  if (diagnostics.consoleSample) lines.push(`Console sample: ${diagnostics.consoleSample}`);
  if (diagnostics.exceptionSummary) lines.push(diagnostics.exceptionSummary);
  if (diagnostics.exceptionSample) lines.push(`Exception sample: ${diagnostics.exceptionSample}`);
  if (diagnostics.networkSummary) lines.push(diagnostics.networkSummary);
  if (diagnostics.networkSample) lines.push(`Network sample: ${diagnostics.networkSample}`);
  if (result.effects?.domDiff) {
    const diff = redactSensitiveString(result.effects.domDiff);
    let formatted = leftoverAxScroll ? stripLeftoverAxScrollCensusChrome(diff) : diff;
    if (
      leftoverAxScroll
      && leftoverAxScrollNextIsPerceive(result)
      && result.outcome.status === 'no-change'
    ) {
      formatted = stripLeftoverAxScrollNoChangeIdentityChrome(formatted);
      formatted = stripLeftoverAxScrollNoChangeAxBodyChrome(formatted);
    }
    if (formatted.trim()) lines.push('---', formatted);
  }
  if (diagnosis?.nextCommand && diagnosis.status !== 'ok') lines.push(`Next: ${diagnosis.nextCommand}`);
  if (!diagnosis?.nextCommand && result.outcome?.status === 'no-change' && result.recommendation?.commands?.[0]) {
    lines.push(`Next: ${result.recommendation.commands[0]}`);
  } else if (leftoverAxScrollNext) {
    lines.push(`Next: ${result.recommendation.commands[0]}`);
  }
  if (result.nextHint && !leftoverAxScrollNext) lines.push(`Hint: ${result.nextHint}`);
  return lines.join('\n');
}

async function finalizeActionResult(result, { enrichActionResult = null, onActionResult = null } = {}) {
  if (enrichActionResult) await enrichActionResult(result);
  applyActionReceipt(applyActionVerdict(applyActionRecommendation(applyActionOutcome(applyActionDiagnosis(result)))));
  if (onActionResult) onActionResult(result);
  return result;
}

function normalizeActionOutputOptions(format = 'text') {
  if (format && typeof format === 'object') {
    return {
      format: format.format || 'text',
      compact: format.compact === true || format.qa === true || format.summary === true,
      qa: format.qa === true || format.summary === true,
      maxDiffLines: format.maxDiffLines == null ? null : Number(format.maxDiffLines),
      full: format.full === true || format.unsafeFull === true,
    };
  }
  return { format, compact: false, qa: false, maxDiffLines: null, full: false };
}

function typeaheadLabelFromAxLine(line) {
  const trimmed = String(line || '').replace(/^[+-]\s*/, '').trim();
  const match = trimmed.match(/^\[(option|listitem|link)\]\s+(.+)$/i);
  if (!match) return null;
  const name = match[2]
    .replace(/\s+@[c\w:-]+(?:\s+\([^)]+\))?$/, '')
    .replace(/\s+=\s+".*"$/, '')
    .trim();
  if (!name) return null;
  return compactActionText(name, FILL_TYPEAHEAD_MAX_CHARS);
}

function extractTypeaheadLabels(lines = [], { limit = FILL_TYPEAHEAD_LIMIT } = {}) {
  const seen = new Set();
  const labels = [];
  for (const line of lines) {
    const label = typeaheadLabelFromAxLine(line);
    if (!label || seen.has(label)) continue;
    seen.add(label);
    labels.push(label);
    if (labels.length >= limit) break;
  }
  return labels;
}

function countTypeaheadLabels(lines = []) {
  const seen = new Set();
  for (const line of lines) {
    const label = typeaheadLabelFromAxLine(line);
    if (label) seen.add(label);
  }
  return seen.size;
}

function typeaheadLabelFromNetworkUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return null;
  try {
    const parsed = raw.includes('://') ? new URL(raw) : new URL(raw, 'https://typeahead.invalid');
    const keys = [...parsed.searchParams.keys()];
    if (keys.some(key => /^(q|query|search|suggest|typeahead|autocomplete)$/i.test(key))) return null;
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    if (/^(api|search|suggest|autocomplete|query)$/i.test(parts[0])) return null;
    return compactActionText(parts.slice(0, 2).join('/'), FILL_TYPEAHEAD_MAX_CHARS);
  } catch {
    return null;
  }
}

function extractFillTypeahead(effects = {}) {
  const fromDiff = extractTypeaheadLabels(String(effects.domDiff || '').split('\n'));
  const seen = new Set(fromDiff);
  const labels = [...fromDiff];
  const entries = effects.networkDelta?.entries || effects.network || [];
  for (const entry of entries) {
    if (labels.length >= FILL_TYPEAHEAD_LIMIT) break;
    if (String(entry?.method || 'GET').toUpperCase() !== 'GET') continue;
    const label = typeaheadLabelFromNetworkUrl(entry.url || '');
    if (!label || seen.has(label)) continue;
    seen.add(label);
    labels.push(label);
  }
  return labels;
}

function fillTypedValue(result = {}) {
  const target = result.target || {};
  if (isSensitiveActionTarget(result.action, target)) return REDACTED_VALUE;
  const args = Array.isArray(target.commandArgs) ? target.commandArgs : [];
  const text = args[0] === '--react' ? args[2] : args[1];
  return text == null ? '' : String(text);
}

function fillNavigationUrl(effects = {}) {
  const nav = effects.navigation;
  if (nav == null || nav === false) return null;
  if (typeof nav === 'string') return compactActionText(nav, 180) || null;
  if (typeof nav === 'object') {
    const url = nav.url || nav.href || nav.to || '';
    return url ? compactActionText(String(url), 180) : null;
  }
  return null;
}

function compactFillReceiptForJson(result = {}) {
  const typeahead = isSensitiveActionTarget(result.action, result.target || {})
    ? []
    : extractFillTypeahead(result.effects || {});
  const targetId = result.target?.targetId || '';
  const receipt = {
    schema: 'chrome-cdp-ex.fill.v1',
    value: fillTypedValue(result),
    changed: result.outcome?.changed === true || result.outcome?.status === 'changed',
    navigation: fillNavigationUrl(result.effects || {}),
    typeahead,
  };
  if (targetId) receipt.targetPrefix = targetPrefixForDisplay(targetId);
  return receipt;
}

function shouldUseCompactFillReceipt(result, { compact = false, qa = false, full = false } = {}) {
  return result?.action === 'fill'
    && result?.dispatch?.ok !== false
    && result?.settle?.ok !== false
    && result?.outcome?.needsAttention !== true
    && full !== true
    && compact !== true
    && qa !== true;
}

function actionResultPdfViewerMeta(result = {}, dispatchText = '') {
  const page = result.effects?.page || result.page || result.target?.page || {};
  const blob = [
    result.effects?.domDiff,
    dispatchText,
    result.dispatch?.error,
    result.effects?.failure?.originalMessage,
  ].filter(Boolean).join('\n');
  if (!isPdfViewerContentType(page.contentType) && !blob.includes('chrome-cdp-ex.pdf-viewer.v1')) {
    return null;
  }
  return {
    title: page.title || '',
    url: page.url || '',
    contentType: isPdfViewerContentType(page.contentType) ? page.contentType : 'application/pdf',
  };
}

function actionObservationPerceiveOpts(targetId, extra = {}) {
  return {
    ...extra,
    cards: false,
    targetPrefix: extra.targetPrefix || targetPrefixForDisplay(targetId),
  };
}

function actionSettleObserveOpts(targetId, actionTarget = {}, baselineOutput = null, baselineOpts = null) {
  const targetFrameRef = frameRefFromActionTarget(actionTarget);
  const keepFeedCards = isLeftoverFeedCardsSettle(baselineOutput, baselineOpts, actionTarget);
  const opts = actionObservationPerceiveOpts(targetId, {
    ...resolveSinceActionPerceiveOpts(
      {
        sinceAction: true,
        diffBaseline: baselineOutput,
        ...(targetFrameRef ? { frameRef: targetFrameRef } : {}),
      },
      { baselineOutput, baselineOpts },
      [],
    ),
    // Never inherit leftover perceive --frame mode; only the action's @fN target
    // (or an explicit --frame) may settle inside an iframe.
    frameRef: targetFrameRef || null,
  });
  // actionObservationPerceiveOpts forces cards:false so leftover 0-card
  // recapture stays default AX (#257/#279). Re-enable cards only when the
  // leftover feed window is the scroll settle shape (#293).
  if (keepFeedCards) opts.cards = true;
  return opts;
}

function formatActionResultOutput(result, { format = 'text', compact = false, qa = false, maxDiffLines = null, dispatchText = '', timeoutError = null, full = false } = {}) {
  if (qa) {
    const pdf = actionResultPdfViewerMeta(result, dispatchText);
    if (pdf) {
      const targetPrefix = result.target?.targetId
        ? targetPrefixForDisplay(result.target.targetId)
        : '<target>';
      return format === 'json'
        ? formatJson(pdfViewerHandoffModel(pdf, { targetPrefix }))
        : formatPdfViewerOutput(pdf, { targetPrefix });
    }
    const summary = buildQaSummaryModel({
      page: {
        url: result.effects?.page?.url || result.page?.url || '',
        title: result.effects?.page?.title || result.page?.title || '',
      },
      pageHealth: result.effects?.pageHealth || null,
      navigation: result.effects?.navigation || null,
      console: {
        errors: Number(result.effects?.consoleDelta?.errors || 0),
        exceptions: Number(result.effects?.exceptionDelta?.count || 0),
      },
      network: {
        failures: Number(result.effects?.networkDelta?.failures || 0),
      },
      action: {
        outcome: result.outcome?.status || result.receipt?.outcome || null,
        dispatch: result.dispatch || null,
        changed: result.outcome?.status ? result.outcome.status !== 'no-change' : Boolean(result.effects?.domDiff),
      },
      targetPrefix: result.target?.targetId ? targetPrefixForDisplay(result.target.targetId) : null,
      nextCommand: result.recommendation?.commands?.[0] || result.effects?.diagnosis?.nextCommand || null,
      source: 'action',
    });
    if (format === 'json') {
      return formatJson({
        summary,
        action: compactActionResultForJson(result, { compact: true }),
      });
    }
    return formatQaSummaryText(summary);
  }
  if (format === 'json') {
    if (shouldUseCompactFillReceipt(result, { compact, qa, full })) {
      return JSON.stringify(compactFillReceiptForJson(result));
    }
    const model = compactActionResultForJson(result, { compact });
    return compact ? JSON.stringify(model) : formatJson(model);
  }
  let text = dispatchText ? `${dispatchText}\n---\n${formatActionText(result)}` : formatActionText(result);
  if (maxDiffLines != null) text = truncateTextLines(text, maxDiffLines);
  if (!timeoutError) return text;
  return `${text}\n(success but observation timed out after action dispatch: ${timeoutError.message}. The action was already sent; run \`perceive --since-action\`, \`perceive --diff\`, or \`status\` to refresh.)`;
}

function parseVerifyClickArgs(args = []) {
  const fopts = parseFormatArgs(args, ['text', 'json']);
  const tokens = fopts.args;
  const opts = {
    selector: null,
    expectRequest: null,
    expectStatus: null,
    expectText: null,
    noConsoleErrors: false,
    evidence: 'concise',
    format: fopts.format,
  };
  const positional = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '--expect-request') opts.expectRequest = tokens[++i] || '';
    else if (token === '--expect-status') {
      const status = Number(tokens[++i]);
      if (!Number.isInteger(status) || status < 100 || status > 599) throw new Error('verify-click: --expect-status requires an HTTP status code');
      opts.expectStatus = status;
    } else if (token === '--expect-text') opts.expectText = tokens[++i] || '';
    else if (token === '--no-console-errors') opts.noConsoleErrors = true;
    else if (token === '--evidence') {
      const evidence = tokens[++i] || '';
      if (!['concise', 'full'].includes(evidence)) throw new Error('verify-click: --evidence must be concise or full');
      opts.evidence = evidence;
    } else if (String(token).startsWith('--')) {
      throw new Error(`verify-click: unknown argument ${token}`);
    } else {
      positional.push(token);
    }
  }
  if (positional.length !== 1) throw new Error('verify-click requires exactly one selector or @ref');
  if (opts.expectStatus != null && !opts.expectRequest) {
    throw new Error('verify-click: --expect-status requires --expect-request');
  }
  opts.selector = positional[0];
  return opts;
}

function normalizeRequestExpectation(pattern = '') {
  const text = String(pattern || '').trim();
  const match = text.match(/^([A-Z]+)\s+(.+)$/);
  return match
    ? { method: match[1], pattern: match[2].trim(), display: `${match[1]} ${match[2].trim()}` }
    : { method: null, pattern: text, display: text };
}

function requestUrlPieces(url = '') {
  try {
    const parsed = new URL(url);
    return {
      full: parsed.href,
      path: `${parsed.pathname}${parsed.search || ''}`,
    };
  } catch {
    return { full: String(url || ''), path: String(url || '') };
  }
}

function wildcardMatch(value = '', pattern = '') {
  const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`).test(String(value || ''));
}

function findExpectedNetworkRequest(entries = [], expectation = '') {
  const expected = normalizeRequestExpectation(expectation);
  return (entries || []).find(entry => {
    if (expected.method && String(entry.method || '').toUpperCase() !== expected.method) return false;
    const pieces = requestUrlPieces(entry.url || '');
    return pieces.path.includes(expected.pattern)
      || pieces.full.includes(expected.pattern)
      || wildcardMatch(pieces.path, expected.pattern)
      || wildcardMatch(pieces.full, expected.pattern);
  }) || null;
}

function buildSemanticInteractionModel(actionResult = {}, opts = {}, observed = {}) {
  const networkEntries = actionResult.effects?.networkDelta?.entries || actionResult.effects?.network || [];
  const consoleDelta = normalizeConsoleDelta(actionResult.effects?.consoleDelta || {});
  const exceptionDelta = normalizeExceptionDelta(actionResult.effects?.exceptionDelta || {});
  const assertions = [];
  let matchedRequest = null;

  if (opts.expectRequest) {
    matchedRequest = findExpectedNetworkRequest(networkEntries, opts.expectRequest);
    const expected = normalizeRequestExpectation(opts.expectRequest);
    const statusOk = opts.expectStatus == null || Number(matchedRequest?.status) === Number(opts.expectStatus);
    assertions.push({
      kind: 'request',
      expected: expected.display,
      expectedStatus: opts.expectStatus,
      status: matchedRequest && statusOk ? 'pass' : 'fail',
      matched: matchedRequest ? {
        method: matchedRequest.method || null,
        url: matchedRequest.url || null,
        status: matchedRequest.status ?? null,
        duration: matchedRequest.duration ?? null,
      } : null,
      message: matchedRequest
        ? `${expected.display} -> ${matchedRequest.status ?? 'unknown'} ${statusOk ? 'matched' : 'status-mismatch'}`
        : `${expected.display} not observed`,
    });
  }

  if (opts.expectText) {
    const matched = observed.textMatched === true;
    assertions.push({
      kind: 'text',
      expected: opts.expectText,
      status: matched ? 'pass' : 'fail',
      message: matched ? `"${opts.expectText}" matched` : `"${opts.expectText}" not found`,
    });
  }

  if (opts.noConsoleErrors) {
    const errors = Number(consoleDelta.errors || 0) + Number(exceptionDelta.count || 0);
    assertions.push({
      kind: 'console',
      expected: 'no console errors',
      status: errors === 0 ? 'pass' : 'fail',
      errors,
      warnings: Number(consoleDelta.warnings || 0),
      message: errors === 0 ? 'clean' : `${errors} error${errors === 1 ? '' : 's'}`,
    });
  }

  const dispatchOk = actionResult.dispatch?.ok !== false;
  const verdict = dispatchOk && assertions.every(assertion => assertion.status === 'pass') ? 'pass' : 'fail';
  return {
    schema: 'chrome-cdp-ex.semantic-interaction.v1',
    action: actionResult.action || 'click',
    target: actionResult.target?.input || actionResult.target?.label || opts.selector || null,
    dispatch: actionResult.dispatch || null,
    settlement: buildSettlementReceipt(actionResult),
    outcome: actionResult.outcome?.status || buildActionOutcome(actionResult).status,
    verdict,
    assertions,
    matchedRequest,
    actionEvidence: opts.evidence === 'full' ? actionResult : null,
  };
}

function formatSemanticInteractionResult(model) {
  const lines = [
    `Action: ${model.action}${model.target ? ` ${model.target}` : ''}`,
    `Dispatch: ${model.dispatch?.ok === false ? 'failed' : 'ok'}`,
  ];
  for (const assertion of model.assertions || []) {
    if (assertion.kind === 'request') {
      lines.push(`Request: ${assertion.message}`);
    } else if (assertion.kind === 'text') {
      lines.push(`Text: ${assertion.message}`);
    } else if (assertion.kind === 'console') {
      lines.push(`Console: ${assertion.message}`);
    } else {
      lines.push(`${assertion.kind}: ${assertion.message || assertion.status}`);
    }
  }
  lines.push(`Verdict: ${model.verdict}`);
  if (model.verdict === 'fail') {
    lines.push('Kind: assertion');
    lines.push('Next: cdp help verify-click');
  }
  return lines.join('\n');
}

function formatActionWorkflowCommandOutput(model, { format = 'text', text = '' } = {}) {
  if (format === 'json') return formatJson(model);
  const { action, dispatch } = actionDispatchSemanticsFromModel(model);
  if (dispatch?.ok === false) {
    throw new Error(actionDispatchFailureMessage(action, dispatch));
  }
  return typeof text === 'function' ? text() : text;
}

function qaScreenshotCaptureOptions() {
  return {
    timeoutMs: QA_SCREENSHOT_TIMEOUT_MS,
    skipSanityRetry: true,
  };
}

function diffShotScreenshotCaptureOptions() {
  return {
    timeoutMs: QA_SCREENSHOT_TIMEOUT_MS,
    skipSanityRetry: true,
    failFastOnTimeout: true,
  };
}

function isScreenshotTimeoutError(err) {
  const msg = String(err?.message || '');
  return isTimeoutError(err)
    || /screenshot failed: all methods timed out/i.test(msg)
    || /screenshot alternate capture failed/i.test(msg)
    || /page\.capturescreenshot timed out/i.test(msg);
}

function parseQaArgs(args = []) {
  const fopts = parseFormatArgs(args, ['text', 'json']);
  const opts = {
    desktop: '1440x900',
    mobile: '390x844',
    click: null,
    expectRequest: null,
    expectStatus: null,
    expectText: null,
    noConsoleErrors: false,
    format: fopts.format,
  };
  for (let i = 0; i < fopts.args.length; i++) {
    const token = fopts.args[i];
    if (token === '--desktop') opts.desktop = fopts.args[++i] || opts.desktop;
    else if (token === '--mobile') opts.mobile = fopts.args[++i] || opts.mobile;
    else if (token === '--click') opts.click = fopts.args[++i] || '';
    else if (token === '--expect-request') opts.expectRequest = fopts.args[++i] || '';
    else if (token === '--expect-status') {
      const status = Number(fopts.args[++i]);
      if (!Number.isInteger(status) || status < 100 || status > 599) throw new Error('qa: --expect-status requires an HTTP status code');
      opts.expectStatus = status;
    } else if (token === '--expect-text') opts.expectText = fopts.args[++i] || '';
    else if (token === '--no-console-errors') opts.noConsoleErrors = true;
    else throw new Error(`qa: unknown argument ${token}`);
  }
  return opts;
}

function parseResponsiveAuditArgs(args = []) {
  const fopts = parseFormatArgs(args, ['text', 'json']);
  const opts = {
    format: fopts.format,
    viewports: [],
    outDir: null,
    maxControls: 12,
  };
  for (let i = 0; i < fopts.args.length; i++) {
    const token = fopts.args[i];
    if (token === '--viewport' || token === '-V') {
      const size = fopts.args[++i];
      if (!size) throw new Error('responsive-audit: --viewport requires WxH');
      opts.viewports.push(size);
    } else if (token === '--out-dir' || token === '--output-dir') {
      opts.outDir = fopts.args[++i] || null;
      if (!opts.outDir) throw new Error('responsive-audit: --out-dir requires a path');
    } else if (token === '--max-controls') {
      opts.maxControls = parseNonNegativeInteger(fopts.args[++i], 'responsive-audit: --max-controls');
    } else {
      throw new Error(`responsive-audit: unknown argument ${token}`);
    }
  }
  if (!opts.viewports.length) opts.viewports = ['1440x900', '390x844'];
  return opts;
}

function responsiveAuditViewportScript({ maxControls = 12 } = {}) {
  const limit = Math.max(0, Math.min(Number(maxControls) || 12, 100));
  return `(function() {
    const doc = document.documentElement;
    const body = document.body;
    const scrollWidth = Math.max(doc?.scrollWidth || 0, body?.scrollWidth || 0);
    const scrollHeight = Math.max(doc?.scrollHeight || 0, body?.scrollHeight || 0);
    const clientWidth = doc?.clientWidth || window.innerWidth || 0;
    const clientHeight = doc?.clientHeight || window.innerHeight || 0;
    const overflowX = scrollWidth > clientWidth + 1;
    const allControls = Array.from(document.querySelectorAll('a,button,input,select,textarea,[role="button"],[role="link"]'))
      .filter(el => {
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      });
    const rectModel = rect => ({
      x: Math.round(rect.x), y: Math.round(rect.y),
      width: Math.round(rect.width), height: Math.round(rect.height),
    });
    const identity = el => {
      const id = el.id ? '#' + CSS.escape(el.id) : '';
      const testId = el.getAttribute('data-testid');
      const selector = id || (testId ? '[data-testid="' + CSS.escape(testId) + '"]' : el.tagName.toLowerCase());
      const name = (el.getAttribute('aria-label') || el.innerText || el.value || el.title || '').trim().slice(0, 80);
      return { selector, name };
    };
    const nearestScrollable = el => {
      for (let parent = el.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        const scrollable = parent.scrollWidth > parent.clientWidth + 1 || parent.scrollHeight > parent.clientHeight + 1;
        const clips = /(auto|scroll|hidden|clip)/.test(style.overflowX + ' ' + style.overflowY);
        if (scrollable && clips) return parent;
      }
      return null;
    };
    const intersectionRatio = (a, b) => {
      const width = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
      const height = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
      const area = width * height;
      const base = Math.max(1, Math.min(a.width * a.height, b.width * b.height));
      return area / base;
    };
    const clippedControls = [];
    for (const el of allControls.slice(0, 100)) {
      const container = nearestScrollable(el);
      if (!container) continue;
      const elementRect = el.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      const visibleRatio = intersectionRatio(elementRect, containerRect);
      const clippedRatio = Math.max(0, 1 - visibleRatio);
      if (clippedRatio < 0.20) continue;
      const role = container.getAttribute('role') || '';
      const intentional = container.getAttribute('data-cdp-audit-scroll') === 'intentional'
        || role === 'listbox' || role === 'feed';
      clippedControls.push({
        ...identity(el),
        severity: intentional ? 'info' : 'warning',
        clippedRatio: Math.round(clippedRatio * 1000) / 1000,
        elementRect: rectModel(elementRect),
        containerRect: rectModel(containerRect),
        suppressed: intentional,
        suppression: intentional ? 'intentional-scroll-container' : null,
      });
      if (clippedControls.length >= ${limit}) break;
    }
    const surfaces = Array.from(document.querySelectorAll('body *')).filter(el => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const visible = style.visibility !== 'hidden'
        && style.display !== 'none'
        && Number.parseFloat(style.opacity || '1') > 0.05
        && style.pointerEvents !== 'none'
        && !el.hidden
        && el.getAttribute('aria-hidden') !== 'true';
      return visible && rect.width > 0 && rect.height > 0 && (
        style.position === 'fixed' || style.position === 'sticky'
        || el.matches('dialog,[role="dialog"],[aria-modal="true"],[data-cdp-audit-overlay]')
      );
    }).slice(0, 80);
    const overlaps = [];
    for (const el of allControls.slice(0, 100)) {
      const elementRect = el.getBoundingClientRect();
      for (const surface of surfaces) {
        if (surface === el || surface.contains(el) || el.contains(surface)) continue;
        const occluderRect = surface.getBoundingClientRect();
        const overlapRatio = intersectionRatio(elementRect, occluderRect);
        if (overlapRatio < 0.20) continue;
        const overlapLeft = Math.max(elementRect.left, occluderRect.left);
        const overlapRight = Math.min(elementRect.right, occluderRect.right);
        const overlapTop = Math.max(elementRect.top, occluderRect.top);
        const overlapBottom = Math.min(elementRect.bottom, occluderRect.bottom);
        const topElement = document.elementFromPoint(
          (overlapLeft + overlapRight) / 2,
          (overlapTop + overlapBottom) / 2,
        );
        if (topElement !== surface && !surface.contains(topElement)) continue;
        overlaps.push({
          ...identity(el),
          occluderSelector: identity(surface).selector,
          occluderName: identity(surface).name,
          severity: 'warning',
          overlapRatio: Math.round(overlapRatio * 1000) / 1000,
          elementRect: rectModel(elementRect),
          occluderRect: rectModel(occluderRect),
        });
        break;
      }
      if (overlaps.length >= ${limit}) break;
    }
    const controls = allControls
      .slice(0, ${limit})
      .map(el => ({
        tag: el.tagName.toLowerCase(),
        text: (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 80),
      }));
    const bodyRect = body ? body.getBoundingClientRect() : { width: 0, height: 0 };
    const pageHealthSignals = {
      url: location.href,
      readyState: document.readyState,
      visibleTextLength: body ? (body.innerText || body.textContent || '').trim().length : 0,
      elementCount: document.querySelectorAll('*').length,
      visibleControlCount: allControls.length,
      bodyRect: { width: Math.round(bodyRect.width), height: Math.round(bodyRect.height) },
    };
    return JSON.stringify({
      url: location.href,
      title: document.title,
      viewport: window.innerWidth + 'x' + window.innerHeight,
      scroll: { width: scrollWidth, height: scrollHeight, clientWidth, clientHeight },
      overflowX,
      controlCount: allControls.length,
      controls,
      controlsTruncated: allControls.length > ${limit},
      maxControls: ${limit},
      clippedControls,
      overlaps,
      pageHealthSignals,
    });
  })()`;
}

function countNetworkFailures(netReqBuf = null) {
  if (!netReqBuf || typeof netReqBuf.all !== 'function') return 0;
  return netReqBuf.all().filter(isNetworkFailure).length;
}

function buildResponsiveAuditModel({
  targetId = '',
  viewports = [],
  page = {},
  console: consoleHealth = {},
  errors = [],
} = {}) {
  const checks = viewports.map(entry => {
    const findings = normalizeResponsiveFindings(entry);
    const pageHealth = entry.pageHealth || (entry.pageHealthSignals
      ? classifyPageHealth(entry.pageHealthSignals)
      : {
          status: entry.blank ? 'blank' : 'populated',
          isBlank: Boolean(entry.blank),
          confidence: 'legacy',
          evidence: null,
        });
    const blank = pageHealth.isBlank === true;
    let status = 'pass';
    if (entry.error || entry.screenshotCapture?.sanity?.retry === true) status = 'fail';
    else if (blank || pageHealth.status === 'indeterminate' || entry.overflowX || hasResponsiveFindings(findings) || Number(consoleHealth.errors || 0) > 0) status = 'warn';
    return {
      viewport: entry.viewport,
      status,
      url: entry.url || page.url || '',
      title: entry.title || page.title || '',
      screenshot: entry.screenshot || null,
      overflowX: Boolean(entry.overflowX),
      blank,
      pageHealth,
      scroll: entry.scroll || null,
      controlCount: entry.controlCount ?? null,
      controls: entry.controls || [],
      findings,
      screenshotCapture: entry.screenshotCapture || null,
      error: entry.error || null,
    };
  });
  const verdict = checks.some(c => c.status === 'fail')
    ? 'fail'
    : checks.some(c => c.status === 'warn')
      ? 'warn'
      : 'pass';
  return {
    schema: 'chrome-cdp-ex.responsive-audit.v1',
    targetId,
    targetPrefix: targetPrefixForDisplay(targetId),
    page,
    console: consoleHealth,
    viewports: checks,
    errors,
    verdict,
    summary: {
      pass: checks.filter(c => c.status === 'pass').length,
      warn: checks.filter(c => c.status === 'warn').length,
      fail: checks.filter(c => c.status === 'fail').length,
    },
    nextSteps: [
      `cdp shot ${targetPrefixForDisplay(targetId)}`,
      `cdp perceive ${targetPrefixForDisplay(targetId)} -C -d 8`,
      `cdp report ${targetPrefixForDisplay(targetId)}`,
    ],
  };
}

function formatResponsiveAuditReport(model) {
  const lines = [
    `Responsive audit: ${model.verdict}`,
    `Page: ${model.page?.title || '(untitled)'}`,
    `URL: ${model.page?.url || '(unknown)'}`,
    `Console: ${model.console?.errors || 0} errors, ${model.console?.warnings || 0} warnings`,
    `Summary: ${model.summary.pass} pass / ${model.summary.warn} warn / ${model.summary.fail} fail`,
  ];
  for (const vp of model.viewports || []) {
    lines.push(`- ${vp.viewport}: ${vp.status}` +
      `${vp.overflowX ? ' overflow-x' : ''}` +
      `${vp.blank ? ' blank' : ''}` +
      `${vp.findings?.clippedControls?.length || vp.findings?.overlaps?.length ? ` clipped=${vp.findings.clippedControls.length} overlap=${vp.findings.overlaps.length}` : ''}` +
      `${vp.controlCount != null ? ` controls=${vp.controlCount}` : ''}` +
      `${vp.screenshot ? ` shot=${vp.screenshot}` : ''}` +
      `${vp.error ? ` error=${vp.error}` : ''}`);
  }
  for (const error of model.errors || []) lines.push(`Error: ${error}`);
  if (model.nextSteps?.[0]) lines.push(`Next: ${model.nextSteps[0]}`);
  return lines.join('\n');
}

async function responsiveAuditStr(cdp, sid, session, targetId, consoleBuf, exceptionBuf, args = []) {
  const opts = parseResponsiveAuditArgs(args);
  const targetPrefix = targetPrefixForDisplay(targetId);
  const page = await pageInfoModel(cdp, sid, { targetPrefix });
  if (isPdfViewerContentType(page.contentType)) {
    throw pdfViewerError(page, { targetPrefix });
  }
  const originalViewport = await captureViewportSize(cdp, sid);
  const consoleHealth = {
    errors: consoleBuf.all().filter(entry => entry.level === 'error').length,
    warnings: consoleBuf.all().filter(entry => entry.level === 'warning' || entry.level === 'warn').length,
    exceptions: exceptionBuf.all().length,
  };
  const viewports = [];
  const errors = [];
  try {
    let screenshotTimedOut = false;
    for (const size of opts.viewports) {
      const entry = { viewport: size };
      try {
        if (screenshotTimedOut) {
          entry.error = 'skipped after previous screenshot timeout';
          errors.push(`${size}: ${entry.error}`);
          viewports.push(entry);
          continue;
        }
        await viewportStr(cdp, sid, size);
        const metricsRaw = await evalStr(cdp, sid, responsiveAuditViewportScript({ maxControls: opts.maxControls }));
        const metrics = JSON.parse(metricsRaw);
        Object.assign(entry, metrics);
        const shotDir = opts.outDir || session.screenshotDir || null;
        if (opts.outDir) {
          try { mkdirSync(opts.outDir, { recursive: true }); } catch {}
        } else {
          ensureSessionScreenshotDir(session);
        }
        const path = opts.outDir
          ? resolve(opts.outDir, `responsive-${size.replace(/[^0-9x]/gi, 'x')}-${Date.now()}.png`)
          : nextSessionScreenshotPath(session, `responsive-${size}`);
        let screenshotCapture = null;
        const shot = await shotStr(cdp, sid, path, targetId, { quiet: true, onCapture: capture => { screenshotCapture = capture; } });
        entry.screenshot = shot.split('\n')[0];
        if (screenshotCapture) {
          entry.screenshotCapture = {
            method: screenshotCapture.method,
            retryCount: screenshotCapture.retryCount || 0,
            sanity: screenshotCapture.sanity || null,
          };
        }
        appendSessionScreenshot(session, { kind: 'responsive-audit', path: entry.screenshot, note: size });
        if (!shotDir && !opts.outDir) {
          // default screenshots stay under session dir outside the repo
        }
      } catch (e) {
        entry.error = e.message || String(e);
        errors.push(`${size}: ${entry.error}`);
        if (isScreenshotTimeoutError(e)) screenshotTimedOut = true;
      }
      viewports.push(entry);
    }
    const model = buildResponsiveAuditModel({
      targetId,
      viewports,
      page: { title: page.title, url: page.url },
      console: consoleHealth,
      errors,
    });
    if (screenshotTimedOut) {
      const timeoutError = errors.find(msg => isScreenshotTimeoutError({ message: msg })) || errors[0];
      throw new Error(timeoutError);
    }
    return opts.format === 'json' ? formatJson(model) : formatResponsiveAuditReport(model);
  } finally {
    await restoreViewportSize(cdp, sid, originalViewport);
  }
}

function buildQaPageModel({ targetId = '', page = {}, pageHealth = null, console: consoleHealth = {}, perception = null, screenshots = {}, action = null, assertions = [], errors = [] } = {}) {
  const checks = {
    page: pageHealth?.isBlank ? 'fail' : pageHealth?.status === 'indeterminate' ? 'warn' : page?.url || page?.title ? 'pass' : 'fail',
    console: Number(consoleHealth.errors || 0) === 0 && Number(consoleHealth.exceptions || 0) === 0 ? 'pass' : 'fail',
    desktopScreenshot: screenshots.desktop?.path ? 'pass' : 'skip',
    mobileScreenshot: screenshots.mobile?.path ? 'pass' : 'skip',
    assertions: assertions.length ? (assertions.every(assertion => assertion.status === 'pass') ? 'pass' : 'fail') : 'skip',
    action: action ? action.verdict : 'skip',
  };
  if (errors.length) checks.errors = 'fail';
  const verdict = Object.values(checks).some(status => status === 'fail') ? 'fail' : 'pass';
  return {
    schema: 'chrome-cdp-ex.qa-page.v1',
    targetId,
    targetPrefix: targetPrefixForDisplay(targetId),
    page,
    pageHealth,
    console: consoleHealth,
    perception,
    screenshots,
    action,
    assertions,
    errors,
    checks,
    verdict,
    nextSteps: [
      `cdp report ${targetPrefixForDisplay(targetId)} --format json`,
      `cdp perceive ${targetPrefixForDisplay(targetId)} -C -d 8`,
    ],
  };
}

function formatQaPageReport(model) {
  const lines = [
    `QA page: ${model.page?.title || '(untitled)'}`,
    `URL: ${model.page?.url || '(unknown)'}`,
    `Page: ${model.checks.page}${model.pageHealth?.status ? ` (${model.pageHealth.status})` : ''}`,
    `Console: ${model.checks.console}${model.console ? ` (${model.console.errors || 0} errors, ${model.console.warnings || 0} warnings, ${model.console.exceptions || 0} exceptions)` : ''}`,
  ];
  if (model.screenshots?.desktop?.path) lines.push(`Desktop screenshot: ${model.screenshots.desktop.path}`);
  if (model.screenshots?.mobile?.path) lines.push(`Mobile screenshot: ${model.screenshots.mobile.path}`);
  if (model.action) {
    lines.push(`Action: ${model.action.verdict}`);
    for (const assertion of model.action.assertions || []) {
      lines.push(`  ${assertion.kind}: ${assertion.status} — ${assertion.message || assertion.expected}`);
    }
  }
  if (model.assertions?.length) {
    lines.push('Assertions:');
    for (const assertion of model.assertions) {
      lines.push(`  ${assertion.kind}: ${assertion.status} — ${assertion.message || assertion.expected}`);
    }
  }
  for (const error of model.errors || []) lines.push(`Error: ${error}`);
  lines.push(`Verdict: ${model.verdict}`);
  return lines.join('\n');
}

async function captureViewportSize(cdp, sid) {
  try {
    const dims = JSON.parse(await evalStr(
      cdp,
      sid,
      'JSON.stringify({w:window.innerWidth,h:window.innerHeight})',
    ));
    const width = Number(dims?.w);
    const height = Number(dims?.h);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
    return `${Math.round(width)}x${Math.round(height)}`;
  } catch {
    return null;
  }
}

async function restoreViewportSize(cdp, sid, size) {
  if (!size) return null;
  try {
    return await viewportStr(cdp, sid, size);
  } catch {
    return null;
  }
}

async function qaPageStr({
  cdp,
  sid,
  session,
  targetId,
  consoleBuf,
  exceptionBuf,
  refMap,
  lastPerceiveStore,
  refState,
  actionFeedback,
}, args = []) {
  const qopts = parseQaArgs(args);
  const errors = [];
  const page = await pageInfoModel(cdp, sid, { targetPrefix: targetPrefixForDisplay(targetId) });
  if (isPdfViewerContentType(page.contentType)) {
    const targetPrefix = targetPrefixForDisplay(targetId);
    return qopts.format === 'json'
      ? formatJson(pdfViewerHandoffModel(page, { targetPrefix }))
      : formatPdfViewerOutput(page, { targetPrefix });
  }
  const originalViewport = await captureViewportSize(cdp, sid);
  const consoleHealth = {
    errors: consoleBuf.all().filter(entry => entry.level === 'error').length,
    warnings: consoleBuf.all().filter(entry => entry.level === 'warning' || entry.level === 'warn').length,
    exceptions: exceptionBuf.all().length,
  };
  const screenshots = {};
  let screenshotTimedOut = false;
  try {
    for (const [kind, size] of [['desktop', qopts.desktop], ['mobile', qopts.mobile]]) {
      if (!size) continue;
      if (screenshotTimedOut) {
        errors.push(`${kind} screenshot: skipped after previous screenshot timeout`);
        continue;
      }
      try {
        await viewportStr(cdp, sid, size);
        ensureSessionScreenshotDir(session);
        const path = nextSessionScreenshotPath(session, kind);
        const shot = await shotStr(cdp, sid, path, targetId, {
          quiet: true,
          ...qaScreenshotCaptureOptions(),
        });
        appendSessionScreenshot(session, { kind: `qa-${kind}`, path: shot.split('\n')[0], note: size });
        screenshots[kind] = { viewport: size, path: shot.split('\n')[0] };
      } catch (error) {
        errors.push(`${kind} screenshot: ${error.message}`);
        if (isScreenshotTimeoutError(error)) screenshotTimedOut = true;
      }
    }
    let perception = null;
    try {
      const text = await perceiveStr(cdp, sid, consoleBuf, exceptionBuf, refMap, lastPerceiveStore, {
        cursorInteractive: true,
        maxDepth: 4,
        targetPrefix: targetPrefixForDisplay(targetId),
      }, refState);
      perception = { captured: true, summary: text.split('\n').slice(0, 6).join('\n') };
    } catch (error) {
      perception = { captured: false, error: error.message };
      errors.push(`perceive: ${error.message}`);
    }
    let action = null;
    const assertions = [];
    if (qopts.click) {
      let captured = null;
      await actionFeedback(
        'click',
        () => clickStr(cdp, sid, qopts.click, refMap, refState),
        { input: qopts.click, resolvedBy: 'selector-or-ref', label: qopts.click || '', commandArgs: [qopts.click] },
        'settle-diff',
        null,
        'json',
        result => { captured = result; },
      );
      const textMatched = qopts.expectText
        ? await pageContainsText(cdp, sid, qopts.expectText).catch(() => false)
        : false;
      action = buildSemanticInteractionModel(captured || {}, {
        selector: qopts.click,
        expectRequest: qopts.expectRequest,
        expectStatus: qopts.expectStatus,
        expectText: qopts.expectText,
        noConsoleErrors: qopts.noConsoleErrors,
        evidence: 'concise',
      }, { textMatched });
    } else {
      if (qopts.expectText) {
        const textMatched = await pageContainsText(cdp, sid, qopts.expectText).catch(() => false);
        assertions.push({
          kind: 'text',
          expected: qopts.expectText,
          status: textMatched ? 'pass' : 'fail',
          message: textMatched ? `"${qopts.expectText}" matched` : `"${qopts.expectText}" not found`,
        });
      }
      if (qopts.expectRequest) {
        assertions.push({
          kind: 'request',
          expected: qopts.expectRequest,
          status: 'fail',
          message: '--expect-request requires --click so the command can collect action network evidence',
        });
      }
    }
    const pageHealth = await collectPageHealth(cdp, sid).catch(() => null);
    const model = buildQaPageModel({
      targetId,
      page: { title: page.title, url: page.url },
      pageHealth,
      console: consoleHealth,
      perception,
      screenshots,
      action,
      assertions,
      errors,
    });
    return formatActionWorkflowCommandOutput(model, {
      format: qopts.format,
      text: () => formatQaPageReport(model),
    });
  } finally {
    await restoreViewportSize(cdp, sid, originalViewport);
  }
}

async function pageContainsText(cdp, sid, text) {
  if (!text) return false;
  const raw = await evalStr(cdp, sid, `(function() {
    const needle = ${JSON.stringify(String(text))};
    const body = document.body ? (document.body.innerText || document.body.textContent || '') : '';
    return JSON.stringify({ matched: body.includes(needle) });
  })()`);
  try {
    return JSON.parse(raw).matched === true;
  } catch {
    return false;
  }
}

async function runActionWithFeedback({ action, target = null, dispatch, feedbackPolicy, observe, dispatchMethod = action, nextHint = GENERIC_SINCE_ACTION_HINT, enrichActionResult = null, onActionResult = null, format = 'text' }) {
  const output = normalizeActionOutputOptions(format);
  const startedAt = Date.now();
  let dispatchText;
  try {
    dispatchText = await dispatch();
  } catch (e) {
    const failure = classifyActionFailure(e, { action, target });
    if (failure.kind === 'usage') throw e;
    const result = createActionResult({
      action,
      target: target || { input: '', resolvedBy: 'command', label: '' },
      dispatch: { ok: false, method: dispatchMethod, error: failure.originalMessage },
      settle: { ok: false, durationMs: Date.now() - startedAt },
      effects: { domDiff: null, console: [], network: [], navigation: null, failure },
      nextHint: failure.nextCommand,
    });
    await finalizeActionResult(result, { enrichActionResult, onActionResult });
    if (output.format === 'json') return formatActionResultOutput(result, output);
    throw new Error(formatActionFailure(e, { action, target }));
  }
  if (feedbackPolicy === 'none' || feedbackPolicy === 'report-only') {
    const result = createActionResult({
      action,
      target: target || { input: '', resolvedBy: 'command', label: '' },
      dispatch: { ok: true, method: dispatchMethod },
      settle: { ok: true, durationMs: Date.now() - startedAt },
      effects: { domDiff: null, console: [], network: [], navigation: null },
      nextHint: feedbackPolicy === 'report-only' ? nextHint : null,
    });
    await finalizeActionResult(result, { enrichActionResult, onActionResult });
    if (feedbackPolicy === 'none') return dispatchText;
    return formatActionResultOutput(result, { ...output, dispatchText });
  }
  try {
    const domDiff = await observe();
    const result = createActionResult({
      action,
      target: target || { input: '', resolvedBy: 'command', label: '' },
      dispatch: { ok: true, method: dispatchMethod },
      settle: { ok: true, durationMs: Date.now() - startedAt },
      effects: { domDiff, console: [], network: [], navigation: null },
      nextHint,
    });
    await finalizeActionResult(result, { enrichActionResult, onActionResult });
    return formatActionResultOutput(result, { ...output, dispatchText });
  } catch (e) {
    const observationError = isTimeoutError(e) ? null : compactObservationError(e);
    const result = createActionResult({
      action,
      target: target || { input: '', resolvedBy: 'command', label: '' },
      dispatch: { ok: true, method: dispatchMethod },
      settle: { ok: false, durationMs: Date.now() - startedAt },
      effects: {
        domDiff: null,
        console: [],
        network: [],
        navigation: null,
        ...(observationError ? { observationError } : {}),
      },
      nextHint,
    });
    await finalizeActionResult(result, { enrichActionResult, onActionResult });
    return formatActionResultOutput(result, {
      ...output,
      dispatchText,
      timeoutError: observationError ? null : e,
    });
  }
}

const HIGH_SIGNAL_ACTION_TEXT_RE = /\b(saved|success|succeeded|complete|completed|done|created|updated|deleted|failed|failure|error|warning|invalid|required)\b|成功|勝利|完成|已儲存|儲存|失敗|錯誤|警告|無效|必填/i;

function actionDomDiffSampleScore(line = '') {
  const trimmed = String(line || '').trim();
  let score = 0;
  if (trimmed.startsWith('+')) score += 2;
  if (/^\+\s+\[(alert|status|statustext|statictext|heading)\]/i.test(trimmed)) score += 2;
  if (HIGH_SIGNAL_ACTION_TEXT_RE.test(trimmed)) score += 4;
  if (/^-\s/.test(trimmed)) score -= 2;
  return score;
}

function chooseActionDomDiffSample(lines = []) {
  const samples = lines.filter(l => /^[+-]\s/.test(l));
  if (!samples.length) return null;
  return samples
    .map((line, index) => ({ line, index, score: actionDomDiffSampleScore(line) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)[0].line;
}

function summarizeActionDomDiff(domDiff) {
  const lines = String(domDiff || '').split('\n').map(l => l.trim()).filter(Boolean);
  const summary = lines.find(l =>
    l.startsWith('+++ Added') ||
    l.startsWith('--- Removed') ||
    l.startsWith('~~~ Text nodes updated') ||
    l.includes('no changes detected')
  ) || null;
  const sample = chooseActionDomDiffSample(lines);
  return { summary, sample };
}

function compactActionTargetModel(target = null) {
  if (!target || typeof target !== 'object') return target;
  const compact = {};
  for (const field of ['targetId', 'input', 'resolvedBy', 'label', 'frameRef', 'redacted', 'expectedOutcome']) {
    if (target[field] !== undefined && target[field] !== null && target[field] !== '') compact[field] = target[field];
  }
  return compact;
}

function compactActionDeltaModel(delta = {}, fields = []) {
  const compact = {
    count: numericDeltaCount(delta.count, 0),
  };
  for (const field of fields) {
    compact[field] = numericDeltaCount(delta[field], 0);
  }
  const entries = Array.isArray(delta.entries) ? delta.entries.filter(Boolean) : [];
  const signal = entries.find(entry => (
    entry?.level === 'error'
    || entry?.level === 'warning'
    || entry?.level === 'warn'
    || entry?.failed === true
    || entry?.errorText
    || Number(entry?.status) >= 400
    || entry?.pending === true
  )) || entries[0];
  if (signal) {
    compact.sample = Object.fromEntries(Object.entries(signal).filter(([, value]) => (
      value !== null && value !== undefined && value !== '' && value !== false
    )));
  }
  return compact;
}

function compactActionFailureModel(failure = null) {
  if (!failure || typeof failure !== 'object') return null;
  return {
    kind: failure.kind || 'unknown',
    reason: failure.reason || failure.originalMessage || null,
    nextCommand: failure.nextCommand || null,
  };
}

function compactActionRecommendationModel(recommendation = null) {
  if (!recommendation || typeof recommendation !== 'object') return null;
  const compact = {};
  for (const field of ['source', 'strategy', 'action', 'targetPrefix', 'outcomeStatus', 'diagnosisKind', 'priority', 'verifyCommand']) {
    if (recommendation[field] !== undefined && recommendation[field] !== null && recommendation[field] !== '') {
      compact[field] = recommendation[field];
    }
  }
  for (const field of ['commands', 'blockingSignals']) {
    if (Array.isArray(recommendation[field]) && recommendation[field].length) compact[field] = recommendation[field];
  }
  return compact;
}

function compactActionOutcomeModel(outcome = null) {
  if (!outcome || typeof outcome !== 'object') return null;
  return {
    status: outcome.status || 'unknown',
    changed: outcome.changed ?? null,
    needsAttention: outcome.needsAttention === true,
    evidence: outcome.evidence || null,
  };
}

function compactActionVerdictForJson(verdict = null) {
  if (!verdict || typeof verdict !== 'object') return null;
  return {
    status: verdict.status || 'verify',
    canContinue: verdict.canContinue === true,
    needsRecovery: verdict.needsRecovery === true,
    primaryNextStep: verdict.primaryNextStep || null,
  };
}

function receiptForCompactActionJson(receipt = null) {
  const base = receiptForActionJson(receipt);
  if (!base || typeof base !== 'object') return base;
  return {
    schema: base.schema || 'chrome-cdp-ex.action-receipt.v1',
    eventId: base.eventId || null,
    sequence: base.sequence ?? null,
    dispatch: base.dispatch || null,
    settlement: {
      state: base.settlement?.state || null,
      strategy: base.settlement?.strategy || null,
      durationMs: Number.isFinite(base.settlement?.durationMs) ? base.settlement.durationMs : null,
      signals: Array.isArray(base.settlement?.signals) ? base.settlement.signals : [],
    },
    outcome: base.outcome || null,
    observedDelta: Array.isArray(base.observedDelta) ? base.observedDelta.slice(0, 2) : [],
    observedDeltaDetails: Array.isArray(base.observedDeltaDetails) ? base.observedDeltaDetails.slice(0, 2) : [],
    blockingSignals: Array.isArray(base.blockingSignals) ? base.blockingSignals : [],
    recoveryHint: base.recoveryHint || null,
    nextSteps: Array.isArray(base.nextSteps) ? base.nextSteps : [],
  };
}

function compactActionEffectsModel(effects = {}) {
  const compact = {};
  if (typeof effects.domDiff === 'string') {
    const summary = effects.domDiffSummary || summarizeActionDomDiff(effects.domDiff).summary;
    const sample = effects.domDiffSample || summarizeActionDomDiff(effects.domDiff).sample;
    compact.domDiffChars = Number.isFinite(effects.domDiffChars) ? effects.domDiffChars : effects.domDiff.length;
    compact.domDiffSummary = summary || 'DOM observation captured';
    if (sample) compact.domDiffSample = sample;
    if (effects.domDiffTruncated === true || effects.domDiff.length > MAX_ACTION_JSON_DOM_DIFF_CHARS) {
      compact.domDiffTruncated = true;
    }
  } else if (Object.hasOwn(effects, 'domDiff')) {
    compact.domDiff = effects.domDiff ?? null;
    if (compact.domDiff == null) compact.domDiffSummary = 'DOM observation not captured';
  } else {
    compact.domDiff = null;
    compact.domDiffSummary = 'DOM observation not captured';
  }
  compact.consoleDelta = compactActionDeltaModel(normalizeConsoleDelta(effects.consoleDelta || {}), ['errors', 'warnings']);
  compact.exceptionDelta = compactActionDeltaModel(normalizeExceptionDelta(effects.exceptionDelta || {}));
  compact.networkDelta = compactActionDeltaModel(normalizeNetworkDelta(effects.networkDelta || {}), ['failures', 'pending']);
  const pageHealthIsActionable = effects.pageHealth && (
    effects.pageHealth.status !== 'populated'
    || effects.pageHealth.isBlank === true
    || effects.pageHealth.evidence?.changed === true
  );
  if (pageHealthIsActionable) {
    const healthEvidence = { changed: effects.pageHealth.evidence?.changed === true };
    if (effects.pageHealth.status !== 'populated') {
      Object.assign(healthEvidence, {
        readyState: effects.pageHealth.evidence?.readyState || null,
        visibleTextLength: effects.pageHealth.evidence?.visibleTextLength ?? null,
        elementCount: effects.pageHealth.evidence?.elementCount ?? null,
        visibleControlCount: effects.pageHealth.evidence?.visibleControlCount ?? null,
        bodyRect: effects.pageHealth.evidence?.bodyRect || null,
      });
    }
    compact.pageHealth = {
      status: effects.pageHealth.status || 'indeterminate',
      isBlank: effects.pageHealth.isBlank === true,
      confidence: effects.pageHealth.confidence || 'low',
      evidence: healthEvidence,
    };
  }
  const failure = compactActionFailureModel(effects.failure);
  if (failure) compact.failure = failure;
  const diagnosis = compactActionDiagnosisModel(effects.diagnosis);
  if (diagnosis && diagnosis.status !== 'ok') compact.diagnosis = diagnosis;
  if (effects.observationError?.message) compact.observationError = effects.observationError;
  return compact;
}

function compactActionHandoffForJson(result = {}) {
  return {
    schema: result.schema || 'chrome-cdp-ex.action.v1',
    mode: 'compact',
    action: result.action || null,
    target: compactActionTargetModel(result.target || null),
    dispatch: result.dispatch || null,
    settle: result.settle || null,
    effects: compactActionEffectsModel(result.effects || {}),
    outcome: compactActionOutcomeModel(result.outcome),
    verdict: compactActionVerdictForJson(result.verdict),
    recommendation: compactActionRecommendationModel(result.recommendation),
    nextSteps: Array.isArray(result.nextSteps) ? result.nextSteps : [],
    receipt: receiptForCompactActionJson(result.receipt),
  };
}

function compactActionResultForJson(result, { compact: compactMode = false } = {}) {
  const compact = JSON.parse(JSON.stringify(result));
  compact.target = sanitizeActionTargetForLog(compact.action, compact.target || null);
  compact.receipt = receiptForActionJson(compact.receipt);
  const effects = compact.effects || {};
  if (typeof effects.domDiff !== 'string') {
    const redacted = redactSensitiveArtifactValue(compact);
    return compactMode ? compactActionHandoffForJson(redacted) : redacted;
  }

  const original = effects.domDiff;
  const { summary, sample } = summarizeActionDomDiff(original);
  effects.domDiffChars = original.length;
  effects.domDiffSummary = summary;
  effects.domDiffSample = sample;
  effects.domDiffTruncated = original.length > MAX_ACTION_JSON_DOM_DIFF_CHARS;
  if (effects.domDiffTruncated) {
    effects.domDiff = [summary, sample].filter(Boolean).join('\n')
      || compactActionText(original, MAX_ACTION_JSON_DOM_DIFF_CHARS);
  }
  const redacted = redactSensitiveArtifactValue(compact);
  return compactMode ? compactActionHandoffForJson(redacted) : redacted;
}

const SENSITIVE_ACTION_TARGET_RE = /\b(pass(word)?|secret|token|api[-_]?key|credential|otp|2fa|mfa|auth(orization)?|pin|cvv|card|ssn)\b/i;

function isSensitiveActionTarget(action, target = {}) {
  if (action !== 'fill' && action !== 'type') return false;
  const probe = [
    target.input,
    target.label,
    ...(Array.isArray(target.commandArgs) ? target.commandArgs.slice(0, 1) : []),
  ].filter(Boolean).join(' ');
  return SENSITIVE_ACTION_TARGET_RE.test(probe);
}

function sensitiveActionSecret(action, target = {}) {
  if (!isSensitiveActionTarget(action, target)) return '';
  const args = Array.isArray(target.commandArgs) ? target.commandArgs : [];
  if (action === 'type') return args[0] == null ? '' : String(args[0]);
  if (args[0] === '--react') return args[2] == null ? '' : String(args[2]);
  return args[1] == null ? '' : String(args[1]);
}

function replaceSecretLiteral(value, secret) {
  if (!secret || secret === REDACTED_VALUE || value == null) return value;
  if (typeof value === 'string') return value.includes(secret) ? value.split(secret).join(REDACTED_VALUE) : value;
  if (Array.isArray(value)) return value.map(item => replaceSecretLiteral(item, secret));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entryValue]) => [
      key,
      replaceSecretLiteral(entryValue, secret),
    ]));
  }
  return value;
}

function redactSensitiveDispatchText(text) {
  return String(text || '')
    .replace(/with "(?:\\.|[^"\\])*"/g, `with "${REDACTED_VALUE}"`)
    .replace(/with '(?:\\.|[^'\\])*'/g, `with '${REDACTED_VALUE}'`);
}

function redactSensitiveCommandArgs(action, args = []) {
  if (action === 'type') return args.map((arg, index) => (index === 0 ? REDACTED_VALUE : arg));
  if (args[0] === '--react') return args.map((arg, index) => (index <= 1 ? arg : REDACTED_VALUE));
  return args.map((arg, index) => (index === 0 ? arg : REDACTED_VALUE));
}

function sanitizeActionTargetForLog(action, target = null) {
  if (!target || typeof target !== 'object') return target;
  const sanitized = {
    ...target,
    commandArgs: Array.isArray(target.commandArgs) ? [...target.commandArgs] : target.commandArgs,
  };
  if (!isSensitiveActionTarget(action, sanitized)) return sanitized;
  const secret = sensitiveActionSecret(action, sanitized);
  let next = secret && secret !== REDACTED_VALUE
    ? replaceSecretLiteral(sanitized, secret)
    : sanitized;
  const redacted = new Set(next.redacted || []);
  if (Array.isArray(next.commandArgs) && next.commandArgs.length) {
    next = { ...next, commandArgs: redactSensitiveCommandArgs(action, next.commandArgs) };
    redacted.add('commandArgs');
  }
  if (typeof next.dispatchText === 'string') {
    next = { ...next, dispatchText: redactSensitiveDispatchText(next.dispatchText) };
    redacted.add('dispatchText');
  }
  next.redacted = [...redacted];
  return next;
}

function sessionLogPath(targetId, runtimeDir = RUNTIME_DIR) {
  const safeTarget = String(targetId || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_');
  return resolve(runtimeDir, `cdp-${safeTarget}.log`);
}

function sessionScreenshotDir(targetId, runtimeDir = RUNTIME_DIR) {
  const safeTarget = String(targetId || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_');
  return resolve(runtimeDir, `cdp-${safeTarget}-screenshots`);
}

function directoryArtifactStats(dir) {
  let sizeBytes = 0;
  let fileCount = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = resolve(dir, entry.name);
    const stats = lstatSync(fullPath);
    if (stats.isDirectory()) {
      const child = directoryArtifactStats(fullPath);
      sizeBytes += child.sizeBytes;
      fileCount += child.fileCount;
    } else {
      sizeBytes += stats.size;
      fileCount += 1;
    }
  }
  return { sizeBytes, fileCount };
}

function artifactPathStats(path) {
  if (!path) {
    return {
      path: null,
      exists: false,
      kind: null,
      sizeBytes: null,
      fileCount: 0,
      error: null,
    };
  }
  try {
    const stats = lstatSync(path);
    if (stats.isDirectory()) {
      const dir = directoryArtifactStats(path);
      return {
        path,
        exists: true,
        kind: 'directory',
        sizeBytes: dir.sizeBytes,
        fileCount: dir.fileCount,
        error: null,
      };
    }
    return {
      path,
      exists: true,
      kind: stats.isSymbolicLink() ? 'symlink' : 'file',
      sizeBytes: stats.size,
      fileCount: 1,
      error: null,
    };
  } catch (e) {
    return {
      path,
      exists: false,
      kind: null,
      sizeBytes: null,
      fileCount: 0,
      error: e.message,
    };
  }
}

function buildSessionArtifactsSummary(session = {}) {
  const screenshots = session.screenshots || [];
  const screenshotItems = screenshots.map(entry => artifactPathStats(entry.path));
  const screenshotTotalBytes = screenshotItems.reduce((sum, item) => sum + (Number.isFinite(item.sizeBytes) ? item.sizeBytes : 0), 0);
  const log = artifactPathStats(session.logPath || null);
  const screenshotDir = artifactPathStats(session.screenshotDir || null);
  return {
    paths: {
      log: session.logPath || null,
      screenshotDir: session.screenshotDir || null,
    },
    counts: {
      actions: session.actionLog?.length || 0,
      screenshots: screenshots.length,
      records: session.records?.length || 0,
    },
    sizes: {
      log,
      screenshotDir,
      screenshots: {
        count: screenshots.length,
        totalBytes: screenshotTotalBytes,
        missing: screenshotItems.filter(item => !item.exists).length,
      },
    },
  };
}

function buildReportBudget(timelineWindow = {}) {
  const expensive = timelineWindow.limit == null;
  return {
    jsonBytesMax: DEFAULT_REPORT_JSON_BYTES_MAX,
    estimatedJsonBytes: null,
    defaultActionLimit: DEFAULT_REPORT_ACTION_LIMIT,
    actionLimit: timelineWindow.limit,
    allActionsOptIn: true,
    expensive,
    warning: expensive
      ? 'report --all includes the full action history and can be expensive for long sessions.'
      : 'Default report JSON is bounded; --all is opt-in and expensive for long sessions.',
  };
}

function buildArtifactCleanupWorkflow(session = {}) {
  const targets = [session.logPath || null, session.screenshotDir || null].filter(Boolean);
  return {
    staleAfterHours: DEFAULT_STALE_ARTIFACT_HOURS,
    targets,
    workflow: [
      'Remove stale session artifacts after preserving any evidence needed for handoff or debugging.',
      'Delete the listed log file and screenshot directory when the browser session is no longer active.',
      'Use report --format json to re-check artifact paths, counts, and sizes before cleanup.',
    ],
  };
}

function nextSessionScreenshotPath(session, kind = 'shot') {
  const safeKind = String(kind || 'shot').replace(/[^A-Za-z0-9_.-]/g, '_');
  const dir = session.screenshotDir || sessionScreenshotDir(session.targetId);
  const seq = String((session.screenshots?.length || 0) + 1).padStart(3, '0');
  return resolve(dir, `${safeKind}-${seq}.png`);
}

function ensureSessionScreenshotDir(session) {
  if (!session.screenshotDir) return null;
  try {
    mkdirSync(session.screenshotDir, { recursive: true, mode: 0o700 });
    return session.screenshotDir;
  } catch (e) {
    if (!session.logErrors) session.logErrors = [];
    session.logErrors.push({ ts: Date.now(), message: `screenshot-dir: ${e.message}` });
    return null;
  }
}

function appendSessionEventLog(session, event, { writer = appendFileSync } = {}) {
  if (!session.logPath) return null;
  const payload = {
    schema: 'chrome-cdp-ex.session-event.v1',
    targetId: session.targetId,
    sessionId: session.sessionId,
    ...event,
  };
  try {
    writer(session.logPath, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
    return payload;
  } catch (e) {
    if (!session.logErrors) session.logErrors = [];
    session.logErrors.push({ ts: Date.now(), message: e.message });
    return null;
  }
}

function appendSessionEnvironmentLog(session, event, { ts = Date.now() } = {}) {
  if (!session.environmentLog) session.environmentLog = [];
  const entry = { ...event, ts: event.ts ?? ts };
  session.environmentLog.push(entry);
  if (session.environmentLog.length > MAX_ENVIRONMENT_LOG_ENTRIES) {
    session.environmentLog.splice(0, session.environmentLog.length - MAX_ENVIRONMENT_LOG_ENTRIES);
  }
  appendSessionEventLog(session, entry);
  return entry;
}

function initializeSessionLog(session, { ts = session.createdAt || Date.now(), writer = writeFileSync } = {}) {
  if (!session.logPath) return null;
  const payload = {
    schema: 'chrome-cdp-ex.session-event.v1',
    kind: 'session-start',
    ts,
    targetId: session.targetId,
    sessionId: session.sessionId,
  };
  try {
    writer(session.logPath, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
    return payload;
  } catch (e) {
    if (!session.logErrors) session.logErrors = [];
    session.logErrors.push({ ts: Date.now(), message: e.message });
    return null;
  }
}

function nextSessionActionSequence(session) {
  const current = Number.isInteger(session.actionSeq) ? session.actionSeq : (session.actionLog?.length || 0);
  session.actionSeq = current + 1;
  return session.actionSeq;
}

function sessionActionEventId(session, sequence) {
  const target = targetPrefixForDisplay(session.targetId || 'target');
  return `act_${target}_${String(sequence).padStart(6, '0')}`;
}

function applyActionReceiptEvent(actionResult, { eventId, sequence, ts } = {}) {
  actionResult.receipt = {
    ...buildActionReceipt(actionResult),
    eventId,
    sequence,
    loggedAt: Number.isFinite(ts) ? new Date(ts).toISOString() : null,
  };
  return actionResult.receipt;
}

function appendSessionActionLog(session, actionResult, { ts = Date.now() } = {}) {
  if (!session.actionLog) session.actionLog = [];
  const sequence = nextSessionActionSequence(session);
  const eventId = sessionActionEventId(session, sequence);
  const receipt = applyActionReceiptEvent(actionResult, { eventId, sequence, ts });
  const domDiff = actionResult.effects?.domDiff || '';
  const { summary, sample } = summarizeActionDomDiff(domDiff);
  const diagnostics = summarizeActionObservationEffects(actionResult.effects || {});
  const secret = sensitiveActionSecret(actionResult.action, actionResult.target || {});
  const target = sanitizeActionTargetForLog(actionResult.action, actionResult.target || null);
  const entry = replaceSecretLiteral(redactSensitiveArtifactValue({
    sequence,
    eventId,
    ts,
    action: actionResult.action,
    target,
    dispatch: actionResult.dispatch || null,
    settle: actionResult.settle || null,
    effectSummary: summary,
    effectSample: sample,
    consoleSummary: diagnostics.consoleSummary,
    consoleSample: diagnostics.consoleSample,
    exceptionSummary: diagnostics.exceptionSummary,
    exceptionSample: diagnostics.exceptionSample,
    networkSummary: diagnostics.networkSummary,
    networkSample: diagnostics.networkSample,
    failure: actionResult.effects?.failure || null,
    diagnosis: actionResult.effects?.diagnosis || null,
    outcome: actionResult.outcome || buildActionOutcome(actionResult),
    verdict: actionResult.verdict || buildActionVerdict(actionResult),
    receipt,
    nextHint: actionResult.nextHint || null,
  }), secret);
  session.actionLog.push(entry);
  if (session.actionLog.length > MAX_ACTION_LOG_ENTRIES) {
    session.actionLog.splice(0, session.actionLog.length - MAX_ACTION_LOG_ENTRIES);
  }
  appendSessionEventLog(session, { kind: 'action', ts, action: entry });
  return entry;
}

function appendSessionScreenshot(session, { kind = 'shot', path = null, note = '', ts = Date.now() } = {}) {
  if (!session.screenshots) session.screenshots = [];
  const entry = {
    ts,
    kind,
    path: path || nextSessionScreenshotPath(session, kind),
    note,
  };
  session.screenshots.push(entry);
  if (session.screenshots.length > MAX_SCREENSHOT_ENTRIES) {
    session.screenshots.splice(0, session.screenshots.length - MAX_SCREENSHOT_ENTRIES);
  }
  appendSessionEventLog(session, { kind: 'screenshot', ts, screenshot: entry });
  return entry;
}

function reportActionStatus(entry = {}) {
  return entry.dispatch?.ok === false ? 'failed' : (entry.settle?.ok ? 'ok' : 'not-confirmed');
}

function buildLatestReportActionSummary(actionLog = []) {
  if (!actionLog.length) return null;
  const index = actionLog.length;
  const entry = actionLog[index - 1] || {};
  return {
    index,
    sequence: entry.sequence ?? index,
    eventId: entry.eventId || entry.receipt?.eventId || null,
    ts: entry.ts || null,
    action: entry.action || null,
    status: reportActionStatus(entry),
    outcomeStatus: entry.outcome?.status || null,
    verdictStatus: entry.verdict?.status || null,
    canContinue: entry.verdict?.canContinue ?? null,
    needsRecovery: entry.verdict?.needsRecovery ?? null,
    effectSummary: entry.effectSummary || null,
    effectSample: entry.effectSample || null,
    consoleSummary: entry.consoleSummary || null,
    networkSummary: entry.networkSummary || null,
    diagnosisKind: entry.diagnosis?.kind || null,
    nextHint: entry.nextHint || null,
  };
}

function compactReportActionTarget(target = null) {
  if (!target || typeof target !== 'object') return target;
  const compact = {};
  for (const field of ['input', 'label', 'resolvedBy', 'frameRef']) {
    if (target[field] !== undefined && target[field] !== null && target[field] !== '') compact[field] = target[field];
  }
  return compact;
}

function compactReportActionEvidence(entry = {}) {
  return {
    dispatchMethod: entry.dispatch?.method || null,
    settleOk: entry.settle?.ok ?? null,
    settleDurationMs: entry.settle?.durationMs ?? null,
    effectSummary: entry.effectSummary || null,
    effectSample: entry.effectSample || null,
    consoleSummary: entry.consoleSummary || null,
    exceptionSummary: entry.exceptionSummary || null,
    networkSummary: entry.networkSummary || null,
    failure: entry.failure?.kind || entry.failure || null,
    diagnosis: entry.diagnosis?.kind || entry.diagnosis || null,
  };
}

function reportActionModel(entry = {}, index = 1, { compact = false } = {}) {
  if (compact) {
    return {
      index,
      sequence: entry.sequence ?? index,
      eventId: entry.eventId || entry.receipt?.eventId || null,
      ts: entry.ts || null,
      action: entry.action,
      status: reportActionStatus(entry),
      target: compactReportActionTarget(entry.target || null),
      evidence: compactReportActionEvidence(entry),
      receipt: receiptForReport(entry.receipt),
      nextHint: entry.nextHint || null,
    };
  }
  return {
    index,
    sequence: entry.sequence ?? index,
    eventId: entry.eventId || entry.receipt?.eventId || null,
    ts: entry.ts || null,
    action: entry.action,
    status: reportActionStatus(entry),
    outcome: entry.outcome || null,
    verdict: entry.verdict || null,
    target: entry.target || null,
    dispatch: entry.dispatch || null,
    settle: entry.settle || null,
    receipt: receiptForReport(entry.receipt),
    evidence: {
      dispatchMethod: entry.dispatch?.method || null,
      settleOk: entry.settle?.ok ?? null,
      settleDurationMs: entry.settle?.durationMs ?? null,
      effectSummary: entry.effectSummary || null,
      effectSample: entry.effectSample || null,
      consoleSummary: entry.consoleSummary || null,
      consoleSample: entry.consoleSample || null,
      exceptionSummary: entry.exceptionSummary || null,
      exceptionSample: entry.exceptionSample || null,
      networkSummary: entry.networkSummary || null,
      networkSample: entry.networkSample || null,
      failure: entry.failure || null,
      diagnosis: entry.diagnosis || null,
    },
    nextHint: entry.nextHint || null,
  };
}

function compactReportBudgetModel(reportBudget = {}) {
  return {
    jsonBytesMax: reportBudget.jsonBytesMax ?? DEFAULT_REPORT_JSON_BYTES_MAX,
    estimatedJsonBytes: null,
    actionLimit: reportBudget.actionLimit ?? null,
  };
}

function compactReportArtifactsSummary(artifacts = {}) {
  return {
    paths: artifacts.paths || {},
    counts: artifacts.counts || {},
  };
}

function compactReportEnvironmentModel(environment = {}) {
  return {
    networkThrottleSummary: environment.networkThrottleSummary || 'none',
    networkMocksSummary: environment.networkMocksSummary || 'none',
    clockSummary: environment.clockSummary || 'real time',
  };
}

function reportScreenshotModel(entry = {}, index = 0, { compact = false } = {}) {
  if (compact) {
    return {
      index: index + 1,
      path: entry.path || null,
      kind: entry.kind || 'shot',
    };
  }
  return {
    index: index + 1,
    ts: entry.ts || null,
    kind: entry.kind || 'shot',
    path: entry.path || null,
    note: entry.note || '',
  };
}

function parseReportArgs(args = []) {
  let lastActions = DEFAULT_REPORT_ACTION_LIMIT;
  let compact = false;
  let qa = false;
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--all') {
      lastActions = null;
    } else if (arg === '--compact') {
      compact = true;
    } else if (arg === '--qa' || arg === '--summary') {
      qa = true;
      compact = true;
    } else if (arg === '--last') {
      const raw = args[++i];
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) throw new Error('report: --last requires a positive integer');
      lastActions = n;
    } else {
      rest.push(arg);
    }
  }
  return { lastActions, compact, qa, args: rest };
}

function reportActionTimelineWindow(actionLog = [], lastActions = DEFAULT_REPORT_ACTION_LIMIT) {
  const total = actionLog.length;
  const limit = lastActions == null ? null : Math.max(1, Math.floor(Number(lastActions) || DEFAULT_REPORT_ACTION_LIMIT));
  const startOffset = limit == null || total <= limit ? 0 : total - limit;
  const entries = actionLog.slice(startOffset);
  return {
    entries,
    total,
    shown: entries.length,
    omitted: startOffset,
    startIndex: entries.length ? startOffset + 1 : null,
    endIndex: entries.length ? total : null,
    limit,
    mode: limit == null ? 'all' : 'latest',
    expensive: limit == null,
  };
}

function buildSessionReportModel(session, { now = Date.now(), lastActions = DEFAULT_REPORT_ACTION_LIMIT, compact = false, page = null } = {}) {
  const actionLog = session.actionLog || [];
  const screenshots = session.screenshots || [];
  const timelineWindow = reportActionTimelineWindow(actionLog, lastActions);
  const uptimeMs = Math.max(0, now - (session.createdAt || now));
  const target = targetPrefixForDisplay(session.targetId);
  const artifacts = buildSessionArtifactsSummary(session);
  const reportBudget = buildReportBudget(timelineWindow);
  const cleanup = buildArtifactCleanupWorkflow(session);
  const actions = timelineWindow.entries.map((entry, offset) => {
    const index = (timelineWindow.startIndex || 1) + offset;
    return reportActionModel(entry, index, { compact });
  });
  const pdfViewer = isPdfViewerContentType(page?.contentType);
  const recommendation = pdfViewer
    ? pdfViewerReportRecommendation(target)
    : buildReportRecommendation(actionLog, target, session.targetId);
  const nextSteps = pdfViewer
    ? [pdfViewerNextCommand(target)]
    : uniqueNextStepCommands([
      ...(recommendation.commands || []),
      ...(actionLog.length > 0 ? [
        `cdp record-actions ${target} --format json`,
        `cdp export-playwright ${target}`,
      ] : []),
    ]);
  const environment = {
    networkThrottleSummary: formatThrottleSummary(session.networkThrottle),
    networkMocksSummary: formatNetworkMocksSummary(session),
    clockSummary: formatClockSummary(session.clock),
    controls: buildRecordEnvironmentModel(session),
  };
  const model = {
    schema: 'chrome-cdp-ex.report.v1',
    ...(compact ? { mode: 'compact' } : {}),
    targetId: session.targetId,
    targetPrefix: target,
    sessionId: session.sessionId,
    createdAt: session.createdAt || null,
    now,
    uptimeMs,
    paths: {
      log: session.logPath || null,
      screenshotDir: session.screenshotDir || null,
    },
    counts: {
      actions: actionLog.length,
      screenshots: screenshots.length,
      records: session.records?.length || 0,
    },
    artifacts: compact ? compactReportArtifactsSummary(artifacts) : artifacts,
    reportBudget: compact ? compactReportBudgetModel(reportBudget) : reportBudget,
    ...(!compact ? { cleanup } : {}),
    timelineWindow: {
      total: timelineWindow.total,
      shown: timelineWindow.shown,
      omitted: timelineWindow.omitted,
      startIndex: timelineWindow.startIndex,
      endIndex: timelineWindow.endIndex,
      limit: timelineWindow.limit,
      mode: timelineWindow.mode,
      expensive: timelineWindow.expensive,
    },
    latestAction: buildLatestReportActionSummary(actionLog),
    environment: compact ? compactReportEnvironmentModel(environment) : environment,
    actions,
    screenshots: screenshots.map((entry, index) => reportScreenshotModel(entry, index, { compact })),
    recommendation,
    nextSteps: nextSteps.length ? nextSteps : defaultReportNextSteps(target, actionLog.length > 0),
  };
  if (pdfViewer) model.pdfViewer = pdfViewerHandoffModel(page, { targetPrefix: target });
  model.reportBudget.estimatedJsonBytes = Buffer.byteLength(formatJson(model), 'utf8');
  return model;
}

function formatSessionReport(session, { now = Date.now(), format = 'text', lastActions = DEFAULT_REPORT_ACTION_LIMIT, compact = false, qa = false, page = null } = {}) {
  const jsonDefaultCompact = format === 'json' && lastActions != null;
  const effectiveCompact = compact || jsonDefaultCompact;
  const targetPrefix = targetPrefixForDisplay(session.targetId);
  if (isPdfViewerContentType(page?.contentType) && qa) {
    return format === 'json'
      ? formatJson(pdfViewerHandoffModel(page, { targetPrefix }))
      : formatPdfViewerOutput(page, { targetPrefix });
  }
  if (qa) {
    const model = buildSessionReportModel(session, { now, lastActions, compact: true, page });
    const latest = model.latestAction || null;
    const summary = buildQaSummaryModel({
      page: { url: page?.url || latest?.url || '', title: page?.title || '' },
      console: {
        errors: Number(latest?.consoleErrors || latest?.effects?.consoleDelta?.errors || 0),
        exceptions: Number(latest?.exceptions || latest?.effects?.exceptionDelta?.count || 0),
      },
      network: {
        failures: Number(latest?.networkFailures || latest?.effects?.networkDelta?.failures || 0),
      },
      action: latest ? {
        outcome: latest.outcome || latest.receipt?.outcome || null,
        dispatch: { ok: latest.dispatchOk !== false },
        changed: latest.outcome ? latest.outcome !== 'no-change' : undefined,
      } : null,
      targetPrefix: model.targetPrefix,
      nextCommand: model.nextSteps?.[0] || null,
      source: 'report',
    });
    if (format === 'json') {
      return formatJson({
        ...summary,
        report: {
          schema: model.schema,
          targetPrefix: model.targetPrefix,
          counts: model.counts,
          latestAction: model.latestAction,
          nextSteps: model.nextSteps,
        },
      });
    }
    return formatQaSummaryText(summary);
  }
  if (format === 'json') return formatJson(buildSessionReportModel(session, { now, lastActions, compact: effectiveCompact, page }));
  const model = buildSessionReportModel(session, { now, lastActions, compact: effectiveCompact, page });
  const actionLog = session.actionLog || [];
  const timelineWindow = reportActionTimelineWindow(actionLog, lastActions);
  const screenshots = session.screenshots || [];
  const uptimeMs = Math.max(0, now - (session.createdAt || now));
  const actionCountLine = timelineWindow.omitted > 0
    ? `Actions: ${actionLog.length} (showing last ${timelineWindow.shown}, ${timelineWindow.omitted} omitted)`
    : `Actions: ${actionLog.length}`;
  const lines = [
    `Session report: ${session.targetId}`,
    `CDP session: ${session.sessionId}`,
    `Uptime: ${formatDuration(uptimeMs)}`,
    `Log: ${session.logPath || '(disabled)'}`,
    `Screenshot dir: ${session.screenshotDir || '(disabled)'}`,
    actionCountLine,
    `Screenshots: ${screenshots.length}`,
    `Records: ${session.records?.length || 0}`,
  ];
  if (model.reportBudget?.warning != null && model.reportBudget.estimatedJsonBytes != null) {
    lines.push(`Report JSON budget: ${formatBytes(model.reportBudget.estimatedJsonBytes)} / ${formatBytes(model.reportBudget.jsonBytesMax)}; ${model.reportBudget.warning}`);
  }
  if (model.artifacts?.sizes?.log && model.artifacts?.sizes?.screenshotDir) {
    lines.push(`Artifact bytes: log ${formatBytes(model.artifacts.sizes.log.sizeBytes)}, screenshots ${formatBytes(model.artifacts.sizes.screenshotDir.sizeBytes)} (${model.artifacts.sizes.screenshotDir.fileCount} files)`);
  }
  if (model.cleanup?.workflow?.[0]) {
    lines.push(`Cleanup: ${model.cleanup.workflow[0]}`);
  }
  lines.push(
    `Network throttle: ${formatThrottleSummary(session.networkThrottle)}`,
    `Network mocks: ${formatNetworkMocksSummary(session)}`,
    `Clock: ${formatClockSummary(session.clock)}`,
    '',
    'Action timeline:',
  );
  if (actionLog.length === 0) {
    lines.push('No actions recorded yet. Run click/fill/press/nav/inject/reload, then report again.');
  } else {
    if (timelineWindow.omitted > 0) {
      lines.push(`Showing actions ${timelineWindow.startIndex}-${timelineWindow.endIndex}. Use report --all or inspect the JSONL log for the full action history.`);
    }
    for (const [offset, entry] of timelineWindow.entries.entries()) {
      const i = (timelineWindow.startIndex || 1) + offset;
      const label = entry.target?.label || entry.target?.input || '';
      const settleStatus = entry.dispatch?.ok === false ? 'failed' : (entry.settle?.ok ? 'ok' : 'not confirmed');
      const settleDuration = Number.isFinite(entry.settle?.durationMs) ? ` in ${entry.settle.durationMs}ms` : '';
      const sourceTarget = actionTargetCommandId(entry.target || {}) || session.targetId;
      lines.push(`${i}. ${entry.action}${label ? ` ${label}` : ''} — ${settleStatus}${settleDuration}`);
      if (entry.dispatch?.method) lines.push(`   Dispatch: ${entry.dispatch.method}`);
      if (entry.outcome?.status) lines.push(`   Outcome: ${entry.outcome.status}${entry.outcome.reason ? ` — ${entry.outcome.reason}` : ''}`);
      if (entry.verdict?.status) lines.push(`   Verdict: ${entry.verdict.status}${entry.verdict.reason ? ` — ${entry.verdict.reason}` : ''}`);
      if (effectiveCompact) {
        if (entry.nextHint) lines.push(`   Next: ${normalizeReportTargetCommand(entry.nextHint, sourceTarget, model.targetPrefix)}`);
        continue;
      }
      if (entry.failure?.kind) lines.push(`   Failure: ${entry.failure.kind} — ${entry.failure.reason}`);
      if (entry.diagnosis?.kind && entry.diagnosis.status !== 'ok') {
        lines.push(`   Diagnosis: ${entry.diagnosis.kind} — ${entry.diagnosis.reason}`);
      }
      if (entry.diagnosis?.recovery?.strategy && entry.diagnosis.status !== 'ok') {
        lines.push(`   Recovery: ${entry.diagnosis.recovery.strategy}`);
      }
      if (entry.effectSummary) lines.push(`   Effect: ${entry.effectSummary}`);
      if (entry.effectSample) lines.push(`   Sample: ${entry.effectSample}`);
      if (entry.consoleSummary) lines.push(`   ${entry.consoleSummary}`);
      if (entry.consoleSample) lines.push(`   Console sample: ${entry.consoleSample}`);
      if (entry.exceptionSummary) lines.push(`   ${entry.exceptionSummary}`);
      if (entry.exceptionSample) lines.push(`   Exception sample: ${entry.exceptionSample}`);
      if (entry.networkSummary) lines.push(`   ${entry.networkSummary}`);
      if (entry.networkSample) lines.push(`   Network sample: ${entry.networkSample}`);
      if (entry.diagnosis?.nextCommand && entry.diagnosis.status !== 'ok') {
        lines.push(`   Diagnostic next: ${normalizeReportTargetCommand(entry.diagnosis.nextCommand, sourceTarget, model.targetPrefix)}`);
      }
      if (entry.nextHint) lines.push(`   Next: ${normalizeReportTargetCommand(entry.nextHint, sourceTarget, model.targetPrefix)}`);
    }
  }
  if (screenshots.length > 0) {
    lines.push('', 'Attachments:');
    for (const [i, entry] of screenshots.entries()) {
      const note = entry.note ? ` (${entry.note})` : '';
      lines.push(`${i + 1}. ${entry.kind || 'shot'} — ${entry.path}${note}`);
    }
  }
  lines.push('', ...formatReportRecommendationLines(model.recommendation));
  lines.push('', ...formatReportNextStepLines(model.nextSteps));
  if (isPdfViewerContentType(page?.contentType)) {
    return [formatPdfViewerOutput(page, { targetPrefix: model.targetPrefix }), '', ...lines].join('\n');
  }
  return lines.join('\n');
}

function commandArgsFromTarget(entry, fallbackArgs = []) {
  const args = entry.target && Array.isArray(entry.target.commandArgs)
    ? entry.target.commandArgs
    : fallbackArgs;
  return args.filter(v => v !== undefined && v !== null).map(v => String(v));
}

function normalizeRecordCommandName(value = '') {
  const name = String(value || '').toLowerCase();
  if (name === 'diffshot') return 'diff-shot';
  if (name === 'dismissmodal') return 'dismiss-modal';
  return name;
}

function forcedRecordCommandNeedsInput(commandName, args = []) {
  const name = normalizeRecordCommandName(commandName);
  if (name === 'diff-shot') return ['live-visual-baseline'];
  if (name === 'upload') {
    if (args.includes('<redacted>') || args.length < 2) return ['file'];
  }
  return null;
}

function inferRecordActionCommand(entry) {
  const targetInput = entry.target?.input || '';
  const commandName = entry.target?.commandName || entry.action;
  const explicitArgs = entry.target && Array.isArray(entry.target.commandArgs);
  if (explicitArgs) {
    const args = commandArgsFromTarget(entry);
    const needsInput = forcedRecordCommandNeedsInput(commandName, args)
      || (args.includes('<redacted>') ? redactedCommandNeedsInput(commandName) : []);
    return { command: [commandName, ...args], replayable: needsInput.length === 0, needsInput };
  }

  switch (entry.action) {
    case 'click':
    case 'jsclick':
      return targetInput
        ? { command: [entry.action, targetInput], replayable: true, needsInput: [] }
        : { command: [entry.action, '<selector|@ref>'], replayable: false, needsInput: ['target'] };
    case 'clickxy': {
      const parts = targetInput.split(',').map(s => s.trim()).filter(Boolean);
      return parts.length >= 2
        ? { command: ['clickxy', parts[0], parts[1]], replayable: true, needsInput: [] }
        : { command: ['clickxy', '<x>', '<y>'], replayable: false, needsInput: ['coordinates'] };
    }
    case 'press':
    case 'scroll':
    case 'nav':
    case 'viewport':
      return targetInput
        ? { command: [entry.action, ...targetInput.split(/\s+/).filter(Boolean)], replayable: true, needsInput: [] }
        : { command: [entry.action, '<input>'], replayable: false, needsInput: ['input'] };
    case 'back':
    case 'forward':
    case 'reload':
    case 'dismiss-modal':
      return { command: [entry.action], replayable: true, needsInput: [] };
    case 'fill':
      return {
        command: ['fill', targetInput || '<selector|@ref>', '<text>'],
        replayable: false,
        needsInput: targetInput ? ['text'] : ['target', 'text'],
      };
    case 'select':
      return {
        command: ['select', targetInput || '<selector>', '<value>'],
        replayable: false,
        needsInput: targetInput ? ['value'] : ['target', 'value'],
      };
    case 'type':
      return { command: ['type', '<text>'], replayable: false, needsInput: ['text'] };
    case 'inject':
      return { command: ['inject', targetInput || '<type>', '<content>'], replayable: false, needsInput: ['content'] };
    case 'upload':
      return {
        command: ['upload', targetInput || '<selector>', '<file>'],
        replayable: false,
        needsInput: targetInput ? ['file'] : ['target', 'file'],
      };
    case 'diff-shot':
    case 'diffshot':
      return {
        command: ['diff-shot', targetInput || '<selector>'],
        replayable: false,
        needsInput: ['live-visual-baseline'],
      };
    default:
      return {
        command: targetInput ? [entry.action, targetInput] : [entry.action],
        replayable: false,
        needsInput: ['review'],
      };
  }
}

function redactedCommandNeedsInput(action) {
  if (action === 'fill' || action === 'type') return ['text'];
  if (action === 'select') return ['value'];
  if (action === 'inject') return ['content'];
  if (action === 'upload') return ['file'];
  return ['input'];
}

function mockEnvironmentCommand(entry = {}) {
  if (entry.action === 'clear') return ['mock', 'clear'];
  const rule = entry.rule || {};
  const command = ['mock', 'add', String(rule.urlPattern || '<urlPattern>'), '--status', String(rule.status ?? 200)];
  if (rule.body != null && rule.body !== '') command.push('--body', String(rule.body));
  if (rule.contentType) command.push('--content-type', String(rule.contentType));
  if (rule.method) command.push('--method', String(rule.method));
  return command;
}

function throttleEnvironmentCommand(entry = {}) {
  const throttle = entry.throttle || {};
  const profile = throttle.profile || 'off';
  if (profile === 'custom') {
    return [
      'throttle', 'custom',
      '--latency', String(throttle.latencyMs || 0),
      '--download', String(throttle.downloadKbps ?? 0),
      '--upload', String(throttle.uploadKbps ?? 0),
    ];
  }
  return ['throttle', profile];
}

function clockEnvironmentCommand(entry = {}) {
  if (entry.action === 'reset' || !entry.clock) return ['clock', 'reset'];
  const clock = entry.clock || {};
  if (clock.profile === 'freeze') return ['clock', 'freeze', '--at', new Date(clock.atMs).toISOString()];
  if (clock.profile === 'offset') return ['clock', 'offset', '--ms', String(clock.offsetMs || 0)];
  return ['clock', 'reset'];
}

function environmentCommandFromLogEntry(entry = {}) {
  switch (entry.kind || entry.type) {
    case 'mock':
      return mockEnvironmentCommand(entry);
    case 'throttle':
      return throttleEnvironmentCommand(entry);
    case 'clock':
      return clockEnvironmentCommand(entry);
    default:
      return [];
  }
}

function sanitizeEnvironmentDetails(entry = {}) {
  if ((entry.kind || entry.type) === 'mock' && entry.rule) {
    return {
      rule: {
        urlPattern: entry.rule.urlPattern,
        method: entry.rule.method || null,
        status: entry.rule.status,
        contentType: entry.rule.contentType,
        body: entry.rule.body || '',
      },
    };
  }
  if ((entry.kind || entry.type) === 'throttle' && entry.throttle) {
    return {
      throttle: {
        profile: entry.throttle.profile || 'off',
        offline: entry.throttle.offline === true,
        latencyMs: entry.throttle.latencyMs || 0,
        downloadKbps: entry.throttle.downloadKbps,
        uploadKbps: entry.throttle.uploadKbps,
      },
    };
  }
  if ((entry.kind || entry.type) === 'clock' && entry.clock) {
    return {
      clock: {
        profile: entry.clock.profile || 'real',
        atMs: entry.clock.atMs ?? null,
        offsetMs: entry.clock.offsetMs || 0,
      },
    };
  }
  return {};
}

function buildRecordEnvironmentModel(session) {
  return (session.environmentLog || []).map((entry, index) => {
    const command = environmentCommandFromLogEntry(entry);
    const type = entry.type || entry.kind || 'environment';
    return {
      index: index + 1,
      ts: entry.ts || null,
      type,
      action: entry.action || (type === 'throttle' ? 'apply' : 'set'),
      command,
      replayable: command.length > 0,
      needsInput: command.length > 0 ? [] : ['review'],
      ...sanitizeEnvironmentDetails(entry),
    };
  });
}

function buildRecordActionsModel(session) {
  const actions = (session.actionLog || []).map((entry, index) => {
    const inferred = inferRecordActionCommand(entry);
    const dispatchFailed = entry.dispatch?.ok === false;
    const needsInput = dispatchFailed
      ? [...new Set([...inferred.needsInput, 'successful-dispatch'])]
      : inferred.needsInput;
    const secret = sensitiveActionSecret(entry.action, entry.target || {});
    return replaceSecretLiteral({
      index: index + 1,
      ts: entry.ts,
      action: entry.action,
      target: sanitizeActionTargetForLog(entry.action, entry.target || null),
      command: inferred.command,
      replayable: dispatchFailed ? false : inferred.replayable,
      needsInput,
      evidence: {
        dispatchMethod: entry.dispatch?.method || null,
        settleOk: entry.settle?.ok ?? null,
        settleDurationMs: entry.settle?.durationMs ?? null,
        effectSummary: entry.effectSummary || null,
        effectSample: entry.effectSample || null,
        consoleSummary: entry.consoleSummary || null,
        consoleSample: entry.consoleSample || null,
        exceptionSummary: entry.exceptionSummary || null,
        exceptionSample: entry.exceptionSample || null,
        networkSummary: entry.networkSummary || null,
        networkSample: entry.networkSample || null,
        failure: entry.failure || null,
        diagnosis: entry.diagnosis || null,
        outcome: entry.outcome || null,
        verdict: entry.verdict || null,
        nextHint: entry.nextHint || null,
      },
    }, secret);
  });
  const environment = buildRecordEnvironmentModel(session);
  return {
    schema: 'chrome-cdp-ex.record-actions.v1',
    targetId: session.targetId,
    sessionId: session.sessionId,
    source: 'session-action-log',
    environmentCount: environment.length,
    environment,
    actionCount: actions.length,
    actions,
  };
}

function formatCommandLine(command) {
  return (command || []).map(arg => {
    const s = String(arg);
    return /^[^\s"']+$/.test(s) ? s : JSON.stringify(s);
  }).join(' ');
}

function formatRecordActions(session, { format = 'text' } = {}) {
  const model = buildRecordActionsModel(session);
  if (format === 'json') return formatJson(model);
  const lines = [
    `Recorded actions: ${model.actionCount}`,
    `Session: ${model.targetId}`,
    'Source: current daemon session action log',
  ];
  if (model.environment.length) {
    lines.push(`Environment controls: ${model.environmentCount}`);
    for (const entry of model.environment) {
      const status = entry.replayable ? 'replayable' : (entry.needsInput.length ? 'needs input' : 'review needed');
      lines.push(`Env ${entry.index}. ${formatCommandLine(entry.command)} — ${status}`);
      if (entry.needsInput.length) lines.push(`   Missing: ${entry.needsInput.join(', ')}`);
    }
  }
  if (model.actions.length === 0) {
    lines.push('No actions recorded yet. Run click/fill/press/nav/inject/reload, then record-actions again.');
    return lines.join('\n');
  }
  for (const step of model.actions) {
    const label = step.target?.label || step.target?.input || '';
    const status = step.replayable ? 'replayable' : (step.needsInput.length ? 'needs input' : 'review needed');
    lines.push(`${step.index}. ${step.action}${label ? ` ${label}` : ''} — ${status}`);
    lines.push(`   Replay: ${formatCommandLine(step.command)}`);
    if (step.needsInput.length) lines.push(`   Missing: ${step.needsInput.join(', ')}`);
    if (step.evidence.settleOk !== null) {
      const settle = step.evidence.settleOk ? 'ok' : 'not confirmed';
      const duration = Number.isFinite(step.evidence.settleDurationMs) ? ` in ${step.evidence.settleDurationMs}ms` : '';
      lines.push(`   Settle: ${settle}${duration}`);
    }
    if (step.evidence.effectSummary) lines.push(`   Evidence: ${step.evidence.effectSummary}`);
    if (step.evidence.effectSample) lines.push(`   Sample: ${step.evidence.effectSample}`);
    if (step.evidence.outcome?.status) lines.push(`   Outcome: ${step.evidence.outcome.status}`);
    if (step.evidence.verdict?.status) lines.push(`   Verdict: ${step.evidence.verdict.status}`);
    if (step.evidence.failure?.kind) lines.push(`   Failure: ${step.evidence.failure.kind}`);
    if (step.evidence.failure?.reason) lines.push(`   Reason: ${step.evidence.failure.reason}`);
    if (step.evidence.nextHint) lines.push(`   Next: ${step.evidence.nextHint}`);
    if (step.evidence.consoleSummary) lines.push(`   ${step.evidence.consoleSummary}`);
    if (step.evidence.consoleSample) lines.push(`   Console sample: ${step.evidence.consoleSample}`);
    if (step.evidence.exceptionSummary) lines.push(`   ${step.evidence.exceptionSummary}`);
    if (step.evidence.exceptionSample) lines.push(`   Exception sample: ${step.evidence.exceptionSample}`);
    if (step.evidence.networkSummary) lines.push(`   ${step.evidence.networkSummary}`);
    if (step.evidence.networkSample) lines.push(`   Network sample: ${step.evidence.networkSample}`);
  }
  return lines.join('\n');
}

function isPlaywrightPortableSelector(value) {
  const selector = String(value || '').trim();
  return selector && !selector.startsWith('@') && !selector.startsWith('<') && selector !== '<redacted>';
}

const PLAYWRIGHT_ASSERTION_TEXT_ROLES = new Set(['alert', 'status', 'statustext', 'statictext', 'heading']);

function cleanObservedTextForPlaywrightAssertion(text) {
  return String(text || '')
    .replace(/\s+@f?\d+(?::\d+)?\b.*$/u, '')
    .replace(/\s+\(-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?\s+\d+(?:\.\d+)?[×x]\d+(?:\.\d+)?.*$/u, '')
    .replace(/\s{2,}.*/u, '')
    .trim();
}

function observedTextAssertionFromEffectSample(sample) {
  const line = String(sample || '').trim();
  const match = line.match(/^\+\s+\[([^\]]+)\]\s+(.+)$/u);
  if (!match) return null;
  const role = match[1].replace(/\s+/g, '').toLowerCase();
  if (!PLAYWRIGHT_ASSERTION_TEXT_ROLES.has(role)) return null;
  const text = cleanObservedTextForPlaywrightAssertion(match[2]);
  if (!text || text.length < 2 || text.length > 160) return null;
  return text;
}

function playwrightAssertionLinesFromEvidence(evidence = {}) {
  const text = observedTextAssertionFromEffectSample(evidence.effectSample);
  if (!text) return [];
  return [`await expect(page.getByText(${JSON.stringify(text)})).toBeVisible();`];
}

function playwrightStepFromCommand(action = {}) {
  const command = Array.isArray(action.command) ? action.command.map(v => String(v)) : [];
  const commandText = command.length ? formatCommandLine(command) : `${action.action || 'action'} <missing command>`;
  const skip = (reason) => ({
    lines: [
      `// Not exported: ${commandText}`,
      `// Reason: ${reason}`,
    ],
    exported: false,
  });
  const finish = (lines) => ({
    lines: [...lines, ...playwrightAssertionLinesFromEvidence(action.evidence || {})],
    exported: true,
  });

  if (action.replayable !== true) {
    const missing = Array.isArray(action.needsInput) && action.needsInput.length
      ? action.needsInput.join(', ')
      : 'review';
    return skip(`not replayable; missing ${missing}`);
  }
  if (!command.length || !command[0]) return skip('missing command');
  if (command.includes('<redacted>')) return skip('redacted input');

  const [cmd, ...args] = command;
  switch (cmd) {
    case 'nav':
    case 'navigate':
      return args[0]
        ? finish([`await page.goto(${JSON.stringify(args[0])});`])
        : skip('missing URL');
    case 'click':
    case 'jsclick': {
      const selector = args[0] === '--js' || args[0] === '-j' ? args[1] : args[0];
      if (!isPlaywrightPortableSelector(selector)) return skip('needs stable selector; chrome-cdp-ex @refs are session-local');
      return finish([`await page.locator(${JSON.stringify(selector)}).click();`]);
    }
    case 'fill': {
      const usesReactFill = args[0] === '--react';
      const selector = usesReactFill ? args[1] : args[0];
      const text = usesReactFill ? args[2] : args[1];
      if (!isPlaywrightPortableSelector(selector)) return skip('needs stable selector; chrome-cdp-ex @refs are session-local');
      if (text == null || text === '<redacted>') return skip('missing fill text');
      return finish([`await page.locator(${JSON.stringify(selector)}).fill(${JSON.stringify(text)});`]);
    }
    case 'select': {
      const [selector, value] = args;
      if (!isPlaywrightPortableSelector(selector)) return skip('needs stable selector');
      if (value == null) return skip('missing select value');
      return finish([`await page.locator(${JSON.stringify(selector)}).selectOption(${JSON.stringify(value)});`]);
    }
    case 'type':
      return args[0]
        ? finish([`await page.keyboard.type(${JSON.stringify(args[0])});`])
        : skip('missing text');
    case 'press':
      return args[0]
        ? finish([`await page.keyboard.press(${JSON.stringify(args[0])});`])
        : skip('missing key');
    case 'clickxy': {
      const x = Number(args[0]);
      const y = Number(args[1]);
      return Number.isFinite(x) && Number.isFinite(y)
        ? finish([`await page.mouse.click(${x}, ${y});`, '// Coordinate click: review before committing as a regression test.'])
        : skip('missing coordinates');
    }
    case 'scroll': {
      let edge = null;
      try { edge = parseScrollEdge(args[0], args[1]); } catch { edge = null; }
      let container = null;
      try { container = parseScrollContainerArg(args.slice(2)); } catch { container = null; }
      if (edge === 'top' || edge === 'bottom') {
        if (container && !isPlaywrightPortableSelector(container)) {
          return skip('needs stable selector; chrome-cdp-ex @refs are session-local');
        }
        if (container) {
          const topExpr = edge === 'top'
            ? 'el.scrollTop = 0'
            : 'el.scrollTop = Math.max(0, (el.scrollHeight || 0) - (el.clientHeight || 0))';
          return finish([
            `await page.locator(${JSON.stringify(container)}).evaluate((el) => { ${topExpr}; });`,
          ]);
        }
        const dest = edge === 'top' ? '0' : 'edge';
        return finish([
          `await page.evaluate(() => { const tolerance = 2; const scrolling = document.scrollingElement || document.documentElement; const docMax = Math.max(0, Math.round((Number(scrolling && scrolling.scrollHeight) || 0) - window.innerHeight)); if (docMax > tolerance) { window.scrollTo(0, ${edge === 'top' ? '0' : 'docMax'}); return; } let best = null; let bestScore = 0; const nodes = document.querySelectorAll ? document.querySelectorAll('*') : []; for (let i = 0; i < nodes.length; i++) { const el = nodes[i]; if (el === document.documentElement || el === document.body || el === document.scrollingElement) continue; const max = Math.max(0, (el.scrollHeight || 0) - (el.clientHeight || 0)); if (max <= tolerance) continue; const style = window.getComputedStyle ? window.getComputedStyle(el) : null; if (!/(auto|scroll|overlay|hidden)/.test(String((style && (style.overflowY || style.overflow)) || ''))) continue; const score = max * Math.max(1, (el.clientWidth || 0) * (el.clientHeight || 0)); if (score > bestScore) { best = el; bestScore = score; } } if (best) best.scrollTop = ${dest === '0' ? '0' : 'Math.max(0, (best.scrollHeight || 0) - (best.clientHeight || 0))'}; });`,
        ]);
      }
      const direction = args[0] || '';
      const amount = Number(args[1] || 500);
      const dirMap = { down: [0, amount], up: [0, -amount], left: [-amount, 0], right: [amount, 0] };
      let xy = dirMap[direction.toLowerCase()];
      if (!xy && direction.includes(',')) xy = direction.split(',').map(Number);
      return xy && xy.every(Number.isFinite)
        ? finish([`await page.mouse.wheel(${xy[0]}, ${xy[1]});`])
        : skip('unsupported scroll arguments');
    }
    case 'viewport': case 'resize': {
      const match = String(args[0] || '').match(/^(\d+)[x×](\d+)$/);
      return match
        ? finish([`await page.setViewportSize({ width: ${Number(match[1])}, height: ${Number(match[2])} });`])
        : skip('unsupported viewport format');
    }
    case 'reload':
      return finish(['await page.reload();']);
    case 'back':
      return finish(['await page.goBack();']);
    case 'forward':
      return finish(['await page.goForward();']);
    case 'dismiss-modal':
    case 'dismissmodal':
      return finish(['await page.keyboard.press("Escape");', '// Review: chrome-cdp-ex may have clicked a specific close button instead.']);
    default:
      return skip(`unsupported command: ${cmd}`);
  }
}

function parseFlagArgs(args = []) {
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (String(token || '').startsWith('--')) {
      opts[token] = args[++i];
    }
  }
  return opts;
}

function playwrightStepFromEnvironment(entry = {}) {
  const command = Array.isArray(entry.command) ? entry.command.map(v => String(v)) : [];
  const commandText = command.length ? formatCommandLine(command) : `${entry.type || 'environment'} <missing command>`;
  const skip = (reason) => ({
    lines: [
      `// Environment not exported: ${commandText}`,
      `// Reason: ${reason}`,
    ],
    exported: false,
  });

  if (!command.length || !command[0]) return skip('missing command');
  if (command.includes('<redacted>')) return skip('redacted input');
  const [cmd, mode, pattern, ...rest] = command;
  if (cmd === 'mock' && mode === 'add') {
    if (!pattern || pattern.startsWith('<')) return skip('missing URL pattern');
    const flags = parseFlagArgs(rest);
    const status = Number(flags['--status'] || 200);
    const contentType = flags['--content-type'] || 'text/plain; charset=utf-8';
    const body = flags['--body'] || '';
    const method = flags['--method'];
    if (method) {
      return {
        lines: [
          `await page.route(${JSON.stringify(pattern)}, route => {`,
          `  if (route.request().method() !== ${JSON.stringify(method)}) return route.continue();`,
          `  return route.fulfill({ status: ${Number.isFinite(status) ? status : 200}, contentType: ${JSON.stringify(contentType)}, body: ${JSON.stringify(body)} });`,
          '});',
        ],
        exported: true,
      };
    }
    return {
      lines: [
        `await page.route(${JSON.stringify(pattern)}, route => route.fulfill({ status: ${Number.isFinite(status) ? status : 200}, contentType: ${JSON.stringify(contentType)}, body: ${JSON.stringify(body)} }));`,
      ],
      exported: true,
    };
  }
  if (cmd === 'mock' && mode === 'clear') return skip('Playwright routes are test-scoped; review whether unroute is needed');
  if (cmd === 'throttle') return skip('chrome-cdp-ex live network throttling has no portable exporter step yet');
  if (cmd === 'clock') return skip('chrome-cdp-ex live clock override has no portable exporter step yet');
  return skip(`unsupported environment command: ${cmd}`);
}

function formatPlaywrightSpecFromRecordActions(model, { title = 'chrome-cdp-ex exported workflow' } = {}) {
  const actions = Array.isArray(model?.actions) ? model.actions : [];
  const environment = Array.isArray(model?.environment) ? model.environment : [];
  const environmentSteps = environment.map(entry => playwrightStepFromEnvironment(entry));
  const actionSteps = actions.map(action => playwrightStepFromCommand(action));
  const hasAssertions = actionSteps.some(step => step.lines.some(line => /\bexpect\(/.test(line)));
  const lines = [
    `import { test${hasAssertions ? ', expect' : ''} } from '@playwright/test';`,
    '',
    '// Generated from chrome-cdp-ex record-actions.',
    '// Review selectors, assertions, auth state, and skipped steps before committing.',
    '',
    `test(${singleQuotedJsString(title)}, async ({ page }) => {`,
  ];
  let environmentExported = 0;
  let environmentSkipped = 0;
  for (const step of environmentSteps) {
    if (step.exported) environmentExported++;
    else environmentSkipped++;
    for (const line of step.lines) lines.push(`  ${line}`);
  }
  let exported = 0;
  let skipped = 0;
  for (const step of actionSteps) {
    if (step.exported) exported++;
    else skipped++;
    for (const line of step.lines) lines.push(`  ${line}`);
  }
  if (actions.length === 0 && environment.length === 0) {
    lines.push('  // No recorded actions yet. Run click/fill/nav, then export-playwright again.');
  }
  lines.push('});');
  lines.push('');
  if (environment.length) {
    lines.push(`// Environment exported ${environmentExported}/${environment.length} step(s); ${environmentSkipped} need review.`);
  }
  lines.push(`// Exported ${exported}/${actions.length} step(s); ${skipped} need review.`);
  return lines.join('\n');
}

function parseExportPlaywrightArgs(args = []) {
  const fopts = parseFormatArgs(args, ['text', 'json']);
  const opts = { title: 'chrome-cdp-ex exported workflow', format: fopts.format };
  for (let i = 0; i < fopts.args.length; i++) {
    if (fopts.args[i] === '--title') {
      opts.title = fopts.args[++i] || opts.title;
    }
  }
  return opts;
}

function singleQuotedJsString(value) {
  return `'${String(value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r/g, '\\r').replace(/\n/g, '\\n')}'`;
}

function playwrightExportReviewEntry(phase, index, sourceEntry = {}, step = {}) {
  const command = Array.isArray(sourceEntry.command) ? sourceEntry.command.map(v => String(v)) : [];
  const reasonLine = (step.lines || []).find(line => line.startsWith('// Reason: '));
  return {
    phase,
    index,
    exported: step.exported === true,
    command,
    commandText: command.length ? formatCommandLine(command) : null,
    reason: reasonLine ? reasonLine.slice('// Reason: '.length) : null,
  };
}

function buildExportPlaywrightModel(recordActionsModel, opts = {}) {
  const actions = Array.isArray(recordActionsModel?.actions) ? recordActionsModel.actions : [];
  const environment = Array.isArray(recordActionsModel?.environment) ? recordActionsModel.environment : [];
  const environmentSteps = environment.map(entry => playwrightStepFromEnvironment(entry));
  const actionSteps = actions.map(action => playwrightStepFromCommand(action));
  const environmentExported = environmentSteps.filter(step => step.exported).length;
  const actionsExported = actionSteps.filter(step => step.exported).length;
  const assertions = actionSteps.reduce((count, step) => (
    count + (step.lines || []).filter(line => /\bexpect\(/.test(line)).length
  ), 0);
  const review = [
    ...environmentSteps.map((step, i) => playwrightExportReviewEntry('environment', i + 1, environment[i], step)),
    ...actionSteps.map((step, i) => playwrightExportReviewEntry('action', i + 1, actions[i], step)),
  ].filter(entry => !entry.exported);
  const targetId = recordActionsModel?.targetId || '<target>';
  const skipped = review.length;
  const nextSteps = skipped > 0
    ? [
        'Review skipped steps and auth state before committing the Playwright spec.',
        `cdp record-actions ${targetId} --format json`,
        `cdp report ${targetId} --format json`,
      ]
    : [
        'Review auth state and selectors before committing the Playwright spec.',
        `cdp report ${targetId} --format json`,
      ];

  return {
    schema: 'chrome-cdp-ex.export-playwright.v1',
    targetId: recordActionsModel?.targetId || null,
    sessionId: recordActionsModel?.sessionId || null,
    source: 'record-actions',
    title: opts.title || 'chrome-cdp-ex exported workflow',
    counts: {
      environment: environment.length,
      environmentExported,
      environmentSkipped: environment.length - environmentExported,
      actions: actions.length,
      actionsExported,
      actionsSkipped: actions.length - actionsExported,
      assertions,
    },
    spec: formatPlaywrightSpecFromRecordActions(recordActionsModel, opts),
    review,
    nextSteps,
  };
}

function formatExportPlaywright(session, opts = {}) {
  const model = buildRecordActionsModel(session);
  if (opts.format === 'json') return formatJson(buildExportPlaywrightModel(model, opts));
  return formatPlaywrightSpecFromRecordActions(model, opts);
}

function createSessionState({ targetId, sessionId, logPath = sessionLogPath(targetId), screenshotDir = sessionScreenshotDir(targetId) }) {
  return {
    targetId,
    sessionId,
    createdAt: Date.now(),
    logPath,
    screenshotDir,
    logErrors: [],
    pageGeneration: 0,
    refGeneration: 0,
    refs: {
      map: new Map(),
      generation: 0,
      lastPerceiveAt: 0,
      invalidatedAt: Date.now(),
      invalidationReason: 'daemon-start',
    },
    lastPerceive: { output: null, model: null, snapshotOpts: null, cards: null },
    lastAction: null,
    buffers: {},
    pendingRequests: new Map(),
    networkThrottle: null,
    networkMocks: [],
    networkMockHits: [],
    clock: null,
    environmentLog: [],
    actionSeq: 0,
    actionLog: [],
    screenshots: [],
    diffShot: null,
    records: [],
    frames: [],
    injections: [],
    privacy: {
      redactCookies: true,
      redactStorage: true,
      redactAuthorizationHeaders: true,
    },
  };
}

function invalidateSessionRefs(session, reason) {
  session.refs.map.clear();
  if (session.refs.frameRefs instanceof Map) session.refs.frameRefs.clear();
  if (session.refs.frameLastOutputs instanceof Map) session.refs.frameLastOutputs.clear();
  session.refs.invalidatedAt = Date.now();
  session.refs.invalidationReason = reason;
  session.refGeneration += 1;
}

// Roles that get visual layout annotations in perceive output
const ENRICHED_ROLES = new Set([
  'banner', 'navigation', 'main', 'contentinfo', 'complementary',
  'heading', 'img', 'image', 'video', 'form', 'table', 'dialog',
  'region', 'article', 'alert',
]);

// Roles that get @ref indices in perceive output (interactive elements)
const INTERACTIVE_ROLES = new Set([
  'link', 'button', 'menuitem', 'tab', 'checkbox', 'radio', 'switch',
  'textbox', 'searchbox', 'combobox', 'listbox', 'spinbutton', 'slider',
  'menuitemcheckbox', 'menuitemradio', 'option', 'treeitem',
]);

// Content landmarks that should take early @refs (tweets, feed cards, etc.)
const CONTENT_REF_ROLES = new Set(['article', 'feed', 'listitem', 'status']);
const SKIP_LINK_NAME_RE = /skip\s+to\b|\bskip\b|keyboard|鍵盤|快速鍵|跳至/i;
const DOCTOR_LIST_TARGET_PLACEHOLDER = '<target-from-list>';

function axPropertyValue(node, name) {
  const want = String(name || '').toLowerCase();
  for (const prop of node?.properties || []) {
    if (String(prop?.name || '').toLowerCase() !== want) continue;
    const value = prop.value;
    if (value && typeof value === 'object' && 'value' in value) return String(value.value ?? '');
    return String(value ?? '');
  }
  return '';
}

function axNodeUrl(node) {
  return axPropertyValue(node, 'url');
}

function axNodeAccessibleName(node) {
  const name = String(node?.name?.value ?? '');
  if (name) return name;
  return axPropertyValue(node, 'name')
    || axPropertyValue(node, 'aria-label')
    || axPropertyValue(node, 'description')
    || '';
}

function isSkipLinkName(name) {
  return SKIP_LINK_NAME_RE.test(String(name || ''));
}

function isSkipLinkAxNode(node) {
  const role = String(node?.role?.value || '');
  const name = axNodeAccessibleName(node);
  const haystack = [
    name,
    axPropertyValue(node, 'aria-label'),
    axPropertyValue(node, 'description'),
  ].filter(Boolean).join('\n');
  const url = axNodeUrl(node);
  const fragmentOnly = url === '#' || url.startsWith('#');
  if (isSkipLinkName(haystack)) return true;
  if ((role === 'link' || role === 'button') && /^\s*(skip\s+to|跳至)/i.test(name)) return true;
  if (role === 'link' && fragmentOnly) return true;
  return false;
}

// Format a stale/unknown @ref error explaining the most likely root cause.
// `state` holds {generation, invalidationReason, lastPerceiveAt} from the daemon.
function formatUnknownRefError(ref, state = {}) {
  const reason = state.invalidationReason || (state.generation ? null : 'daemon-start');
  if (reason === 'navigation') {
    return `Unknown ref: ${ref}. Refs were cleared because the page navigated/reloaded after the last perceive (e.g. Vite HMR or in-app routing). Run "perceive" to refresh refs, or use a stable CSS selector for long loops.`;
  }
  if (reason === 'dom-mutation') {
    return `Unknown ref: ${ref}. Refs were invalidated by DOM changes after the last perceive. Run "perceive" again, or use a stable CSS selector in batch/loops.`;
  }
  if (reason === 'daemon-start' || (!state.generation)) {
    return `Unknown ref: ${ref}. No refs have been assigned in this daemon yet. Run "perceive" first, or use a CSS selector.`;
  }
  return `Unknown ref: ${ref}. Run "perceive" to refresh refs, or use a stable CSS selector for long loops.`;
}

function invalidateRefMapping(refMap, ref, refState) {
  if (refState) {
    refState.invalidatedAt = Date.now();
    refState.invalidationReason = 'dom-mutation';
  }
  const frameParsed = parseFrameRef(ref);
  if (frameParsed) frameScopedRefEntry(refState || {}, frameParsed)?.refs?.delete(frameParsed.refIndex);
  else refMap.delete(parseInt(ref.slice(1)));
}

const STALE_REF_ERROR_CODE = 'CDP_STALE_REF';

function isMissingDomNodeError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('no node with given id')
    || message.includes('could not find node')
    || /node with given id.*does not belong/.test(message)
    || /no node found for given backend/.test(message)
    || /backend node.*(?:not found|does not exist)/.test(message);
}

function staleRefError(refMap, ref, refState, cause) {
  invalidateRefMapping(refMap, ref, refState);
  const error = new Error(
    formatUnknownRefError(ref, refState || {}) + ` Original CDP error: ${cause.message}`,
    { cause },
  );
  error.code = STALE_REF_ERROR_CODE;
  return error;
}

function isStaleRefError(error) {
  return error?.code === STALE_REF_ERROR_CODE;
}

function trustedRefConnectivityFunctionDeclaration() {
  return `function() {
    try {
      const nodePrototype = Node.prototype;
      const connectedGetter = Object.getOwnPropertyDescriptor(nodePrototype, 'isConnected')?.get;
      const ownerDocumentGetter = Object.getOwnPropertyDescriptor(nodePrototype, 'ownerDocument')?.get;
      const getRootNode = Object.getOwnPropertyDescriptor(nodePrototype, 'getRootNode')?.value;
      if (typeof connectedGetter !== 'function' || typeof ownerDocumentGetter !== 'function' || typeof getRootNode !== 'function') {
        return { error: 'trusted connectivity primitives unavailable' };
      }
      const connected = Reflect.apply(connectedGetter, this, []);
      const ownerDocument = Reflect.apply(ownerDocumentGetter, this, []);
      const composedRoot = Reflect.apply(getRootNode, this, [{ composed: true }]);
      return { connected: connected === true && ownerDocument != null && composedRoot === ownerDocument };
    } catch (error) {
      return { error: String(error && error.message || error || 'trusted connectivity probe failed') };
    }
  }`;
}

function trustedRefPresenceFunctionDeclaration() {
  return `function() {
    try {
      const nodePrototype = Node.prototype;
      const elementPrototype = Element.prototype;
      const connectedGetter = Object.getOwnPropertyDescriptor(nodePrototype, 'isConnected')?.get;
      const ownerDocumentGetter = Object.getOwnPropertyDescriptor(nodePrototype, 'ownerDocument')?.get;
      const getRootNode = Object.getOwnPropertyDescriptor(nodePrototype, 'getRootNode')?.value;
      const getClientRects = Object.getOwnPropertyDescriptor(elementPrototype, 'getClientRects')?.value;
      if (typeof connectedGetter !== 'function' || typeof ownerDocumentGetter !== 'function'
        || typeof getRootNode !== 'function' || typeof getClientRects !== 'function') {
        return { error: 'trusted presence primitives unavailable' };
      }
      const connected = Reflect.apply(connectedGetter, this, []);
      const ownerDocument = Reflect.apply(ownerDocumentGetter, this, []);
      const composedRoot = Reflect.apply(getRootNode, this, [{ composed: true }]);
      if (connected !== true || ownerDocument == null || composedRoot !== ownerDocument) {
        return { connected: false, visible: false };
      }
      const rects = Reflect.apply(getClientRects, this, []);
      const style = getComputedStyle(this);
      const visible = rects.length > 0
        && style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.visibility !== 'collapse';
      return { connected: true, visible };
    } catch (error) {
      return { error: String(error && error.message || error || 'trusted presence probe failed') };
    }
  }`;
}

async function rootFrameId(cdp, sid) {
  const result = await cdpDomains(cdp).Page.getFrameTree({}, sid, REF_RESOLVE_TIMEOUT);
  const frameId = result.frameTree?.frame?.id;
  if (!frameId) throw new Error('Page.getFrameTree did not return a root frame id');
  return frameId;
}

async function createRefExecutionContext(cdp, sid, frameId) {
  if (!frameId) throw new Error('Ref frame id is unavailable');
  const result = await cdpDomains(cdp).Page.createIsolatedWorld({
    frameId,
    worldName: 'chrome-cdp-ex-ref-validation',
    grantUniveralAccess: false,
  }, sid, REF_RESOLVE_TIMEOUT);
  if (!Number.isSafeInteger(result.executionContextId)) {
    throw new Error('Page.createIsolatedWorld did not return an execution context id');
  }
  return result.executionContextId;
}

async function resolveRefNode(cdp, sid, refMap, ref, refState, options = {}) {
  const frameParsed = parseFrameRef(ref);
  let num = null;
  let backendNodeId;
  let frameId = null;
  if (frameParsed) {
    const scoped = frameScopedBackendNode(refState || {}, frameParsed);
    backendNodeId = scoped.backendNodeId;
    frameId = scoped.entry.frameId;
  } else {
    num = parseInt(ref.slice(1));
    if (isNaN(num) || !refMap.has(num)) {
      throw new Error(formatUnknownRefError(ref, refState || {}));
    }
    backendNodeId = refMap.get(num);
  }
  const executionContextId = await createRefExecutionContext(
    cdp,
    sid,
    frameId || await rootFrameId(cdp, sid),
  );
  let object;
  try {
    ({ object } = await cdpDomains(cdp).DOM.resolveNode({
      backendNodeId,
      executionContextId,
    }, sid, REF_RESOLVE_TIMEOUT));
  } catch (error) {
    if (isMissingDomNodeError(error)) throw staleRefError(refMap, ref, refState, error);
    throw error;
  }
  if (!object?.objectId) throw new Error('DOM.resolveNode did not return an object id');
  const validation = await cdpDomains(cdp).Runtime.callFunctionOn({
    objectId: object.objectId,
    functionDeclaration: trustedRefConnectivityFunctionDeclaration(),
    returnByValue: true,
  }, sid, REF_RESOLVE_TIMEOUT);
  if (validation.exceptionDetails) {
    throw new Error(runtimeExceptionMessage(validation.exceptionDetails));
  }
  const validationValue = validation.result?.value;
  if (validationValue?.error) throw new Error(`Trusted ref connectivity probe failed: ${validationValue.error}`);
  const connected = validationValue === true || validationValue?.connected === true;
  if (!connected && (validationValue === false || validationValue?.connected === false)) {
    throw staleRefError(
      refMap,
      ref,
      refState,
      new Error('resolved backend node is detached from its owning document'),
    );
  }
  if (!connected) throw new Error('Trusted ref connectivity probe returned no connectivity result');
  if (options.returnRealm === 'page') {
    let pageResult;
    try {
      pageResult = await cdpDomains(cdp).DOM.resolveNode({ backendNodeId }, sid, REF_RESOLVE_TIMEOUT);
    } catch (error) {
      if (isMissingDomNodeError(error)) throw staleRefError(refMap, ref, refState, error);
      throw error;
    }
    if (!pageResult.object?.objectId) throw new Error('DOM.resolveNode did not return a page-world object id');
    return pageResult.object.objectId;
  }
  return object.objectId;
}

function scrollSettledRectFunctionDeclaration() {
  return `async function() {
    const connectedToOwningDocument = () => {
      try {
        const nodePrototype = Node.prototype;
        const connectedGetter = Object.getOwnPropertyDescriptor(nodePrototype, 'isConnected')?.get;
        const ownerDocumentGetter = Object.getOwnPropertyDescriptor(nodePrototype, 'ownerDocument')?.get;
        const getRootNode = Object.getOwnPropertyDescriptor(nodePrototype, 'getRootNode')?.value;
        if (typeof connectedGetter !== 'function' || typeof ownerDocumentGetter !== 'function' || typeof getRootNode !== 'function') return false;
        const connected = Reflect.apply(connectedGetter, this, []);
        const ownerDocument = Reflect.apply(ownerDocumentGetter, this, []);
        const composedRoot = Reflect.apply(getRootNode, this, [{ composed: true }]);
        return connected === true && ownerDocument != null && composedRoot === ownerDocument;
      } catch {
        return false;
      }
    };
    if (!connectedToOwningDocument()) return { connected: false };
    const readRect = () => {
      const rect = this.getBoundingClientRect();
      return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
    };
    const initial = readRect();
    const fullyVisible = initial.x >= 0 && initial.y >= 0 &&
      initial.x + initial.w <= window.innerWidth && initial.y + initial.h <= window.innerHeight;
    if (!fullyVisible) this.scrollIntoView({ block: 'center', inline: 'center' });
    const deadline = Date.now() + 1800;
    const maxSamples = fullyVisible ? 2 : 60;
    let previous = readRect();
    let stableSamples = 0;
    for (let sample = 0; sample < maxSamples; sample++) {
      if (Date.now() >= deadline) break;
      await Promise.race([
        new Promise(resolve => {
          if (typeof requestAnimationFrame === 'function') requestAnimationFrame(resolve);
          else resolve();
        }),
        new Promise(resolve => setTimeout(resolve, 50)),
      ]);
      const current = readRect();
      const movement = Math.max(
        Math.abs(current.x - previous.x),
        Math.abs(current.y - previous.y),
        Math.abs(current.w - previous.w),
        Math.abs(current.h - previous.h),
      );
      const currentVisible = current.x >= 0 && current.y >= 0 &&
        current.x + current.w <= window.innerWidth && current.y + current.h <= window.innerHeight;
      previous = current;
      stableSamples = movement < 0.5 ? stableSamples + 1 : 0;
      if (currentVisible && stableSamples >= 2) break;
    }
    return {
      connected: connectedToOwningDocument(),
      ...previous,
      tag: this.tagName,
      href: this.tagName === 'A' ? (this.href || null) : null,
      pageHref: location.href,
      text: (this.getAttribute('aria-label') || this.getAttribute('title') || this.textContent || '').trim().substring(0, 80),
    };
  }`;
}

async function resolveRef(cdp, sid, refMap, ref, refState) {
  const frameParsed = parseFrameRef(ref);
  const objectId = await resolveRefNode(cdp, sid, refMap, ref, refState);
  let result;
  try {
    result = await cdpDomains(cdp).Runtime.callFunctionOn( {
      objectId,
      functionDeclaration: scrollSettledRectFunctionDeclaration(),
      returnByValue: true,
      awaitPromise: true,
    }, sid, REF_RESOLVE_TIMEOUT);
  } catch (error) {
    if (isTimeoutError(error, ['Runtime.callFunctionOn'])) {
      return resolveRefRectNoScroll(cdp, sid, refMap, ref, refState, { objectId });
    }
    throw error;
  }
  const value = result.result.value || {};
  if (value.connected !== true) {
    invalidateRefMapping(refMap, ref, refState);
    throw new Error(
      formatUnknownRefError(ref, refState || {}) +
      ' Original CDP error: resolved backend node is detached from its owning document.'
    );
  }
  if (frameParsed) {
    const { entry } = frameScopedBackendNode(refState || {}, frameParsed);
    const offset = await frameViewportOffset(cdp, sid, entry, { settle: true });
    value.x = (Number(value.x) || 0) + offset.x;
    value.y = (Number(value.y) || 0) + offset.y;
  }
  return value;
}

function isRef(s) { return /^@\d+$/.test(s) || /^@f\d+:\d+$/.test(s); }
function isCursorRef(s) { return /^@c\d+$/.test(String(s || '')); }

function resolveCursorRef(refMap, ref, refState) {
  const key = String(ref || '').slice(1);
  const entry = refMap.get(key);
  if (!entry) {
    throw new Error(`Unknown cursor ref: ${ref}. Run "perceive -C -d 8" to refresh cursor refs, or use a stable CSS selector.${refState?.invalidationReason ? ` Ref state: ${refState.invalidationReason}.` : ''}`);
  }
  const x = Number(entry.x);
  const y = Number(entry.y);
  const w = Number(entry.w);
  const h = Number(entry.h);
  if (![x, y, w, h].every(Number.isFinite)) {
    throw new Error(`Invalid cursor ref: ${ref}. Run "perceive -C -d 8" to refresh cursor refs, or use a stable CSS selector.`);
  }
  return {
    x,
    y,
    w,
    h,
    sel: entry.sel || 'cursor-ref',
    text: String(entry.text || '').trim().substring(0, 80),
  };
}

function parseFrameOnlyRef(s) {
  const m = String(s || '').match(/^@f(\d+)$/);
  if (!m) return null;
  const frameIndex = Number(m[1]);
  if (!Number.isSafeInteger(frameIndex) || frameIndex < 1) return null;
  return { frameRef: `@f${frameIndex}`, frameIndex };
}

function parseFrameRef(s) {
  const m = String(s || '').match(/^@f(\d+):(\d+)$/);
  if (!m) return null;
  const frameIndex = Number(m[1]);
  const refIndex = Number(m[2]);
  if (!Number.isSafeInteger(frameIndex) || frameIndex < 1 || !Number.isSafeInteger(refIndex) || refIndex < 1) return null;
  return {
    frameRef: `@f${frameIndex}`,
    frameIndex,
    ref: `@${refIndex}`,
    refIndex,
  };
}

function flattenFrameTree(frameTree, { startIndex = 1 } = {}) {
  const frames = [];
  function visit(node, depth = 0, parentRef = null) {
    if (!node?.frame) return;
    const ref = `@f${startIndex + frames.length}`;
    const frame = node.frame;
    frames.push({
      ref,
      index: startIndex + frames.length,
      id: frame.id || '',
      parentId: frame.parentId || null,
      parentRef,
      depth,
      name: frame.name || '',
      url: frame.url || '',
      securityOrigin: frame.securityOrigin || '',
      unreachableUrl: frame.unreachableUrl || '',
      mimeType: frame.mimeType || '',
    });
    for (const child of node.childFrames || []) visit(child, depth + 1, ref);
  }
  visit(frameTree);
  return frames;
}

function formatFrameTreeText(frames = []) {
  const lines = [`Frames: ${frames.length}`];
  if (frames.length === 0) {
    lines.push('No frames reported by Page.getFrameTree.');
    return lines.join('\n');
  }
  for (const frame of frames) {
    const indent = '  '.repeat(Math.min(frame.depth || 0, 8));
    const label = frame.name || '(anonymous)';
    const parent = frame.parentRef ? ` parent:${frame.parentRef}` : '';
    const origin = frame.securityOrigin ? ` origin:${frame.securityOrigin}` : '';
    const url = frame.url || frame.unreachableUrl || '(no url)';
    lines.push(`${indent}${frame.ref} ${label} ${frame.id}${parent} ${url}${origin}`);
  }
  lines.push('Hint: use frame refs to diagnose wrong-frame errors; element refs inside frames will use @fN:M syntax.');
  return lines.join('\n');
}

async function framesModel(cdp, sid) {
  const result = await cdpDomains(cdp).Page.getFrameTree( {}, sid);
  const frames = flattenFrameTree(result.frameTree);
  return {
    schema: 'chrome-cdp-ex.frames.v1',
    frameCount: frames.length,
    frames,
  };
}

async function framesStr(cdp, sid, { format = 'text' } = {}) {
  const model = await framesModel(cdp, sid);
  if (format === 'json') return formatJson(model);
  return formatFrameTreeText(model.frames);
}

async function resolveFrameRef(cdp, sid, frameRef) {
  const parsed = parseFrameOnlyRef(frameRef);
  if (!parsed) throw new Error(`Frame ref required (example: @f2), got: ${frameRef || '(empty)'}`);
  const model = await framesModel(cdp, sid);
  const frame = model.frames[parsed.frameIndex - 1];
  if (!frame || frame.ref !== parsed.frameRef) {
    throw new Error(`Unknown frame: ${parsed.frameRef}. Run "frame" to refresh the frame tree, then use a listed @fN ref.`);
  }
  return { frame, frames: model.frames };
}

async function createFrameExecutionContext(cdp, sid, frameId) {
  const res = await cdpDomains(cdp).Page.createIsolatedWorld( {
    frameId,
    worldName: 'chrome-cdp-ex',
    grantUniveralAccess: false,
  }, sid);
  return res.executionContextId;
}

function storeFrameScopedRefs(refState, frame, frames, scopedRefMap) {
  if (!refState || !frame) return;
  if (!(refState.frameRefs instanceof Map)) refState.frameRefs = new Map();
  refState.frameRefs.set(frame.ref, {
    frameRef: frame.ref,
    frameIndex: frame.index,
    frameId: frame.id,
    parentId: frame.parentId || null,
    parentRef: frame.parentRef || null,
    name: frame.name || '',
    url: frame.url || '',
    refs: new Map(scopedRefMap),
    frames: frames || [],
  });
}

function frameScopedRefEntry(refState, parsed) {
  const store = refState?.frameRefs;
  if (!(store instanceof Map)) return null;
  return store.get(parsed.frameRef) || null;
}

function frameScopedBackendNode(refState, parsed) {
  const entry = frameScopedRefEntry(refState, parsed);
  if (!entry) {
    throw new Error(`Unknown frame ref: ${parsed.frameRef}. Run "frame", then "perceive --frame ${parsed.frameRef}" to assign iframe-local refs.`);
  }
  if (!(entry.refs instanceof Map) || !entry.refs.has(parsed.refIndex)) {
    throw new Error(`Unknown ref: ${parsed.frameRef}:${parsed.refIndex}. Run "perceive --frame ${parsed.frameRef}" to refresh refs inside that frame.`);
  }
  return { entry, backendNodeId: entry.refs.get(parsed.refIndex) };
}

function qualifyFrameRefsInLines(lines, frameRef) {
  return lines.map(line => line.replace(/@(\d+)(?=\s*(?:\(|$))/, `${frameRef}:$1`));
}

function frameRefFromActionTarget(target = {}) {
  for (const value of [target.input, target.label, target.selector]) {
    const parsed = parseFrameRef(value);
    if (parsed) return parsed.frameRef;
  }
  return null;
}

function rememberFramePerceiveOutput(refState, frameRef, output) {
  if (!refState || !frameRef) return;
  if (!(refState.frameLastOutputs instanceof Map)) refState.frameLastOutputs = new Map();
  refState.frameLastOutputs.set(frameRef, output);
}

function baselineOutputForActionTarget(refState, fallbackOutput, target = {}) {
  const targetFrameRef = frameRefFromActionTarget(target);
  if (targetFrameRef && refState?.frameLastOutputs instanceof Map && refState.frameLastOutputs.has(targetFrameRef)) {
    return refState.frameLastOutputs.get(targetFrameRef);
  }
  return fallbackOutput;
}

async function frameViewportOffset(cdp, sid, frameEntry, { settle = false } = {}) {
  if (!frameEntry?.frameId || !frameEntry.parentId) return { x: 0, y: 0 };
  let x = 0;
  let y = 0;
  let current = frameEntry;
  for (let guard = 0; current?.frameId && current.parentId && guard < 8; guard++) {
    const owner = await cdpDomains(cdp).DOM.getFrameOwner( { frameId: current.frameId }, sid);
    const { object } = await cdpDomains(cdp).DOM.resolveNode( { backendNodeId: owner.backendNodeId }, sid);
    const res = await cdpDomains(cdp).Runtime.callFunctionOn( {
      objectId: object.objectId,
      functionDeclaration: settle ? scrollSettledRectFunctionDeclaration() : `function() {
        const r = this.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
      }`,
      returnByValue: true,
      awaitPromise: settle,
    }, sid);
    const rect = res.result.value || {};
    x += Number(rect.x) || 0;
    y += Number(rect.y) || 0;
    const parent = (current.frames || []).find(frame => frame.id === current.parentId);
    if (!parent) break;
    current = {
      ...parent,
      frameRef: parent.ref,
      frameId: parent.id,
      frames: current.frames || [],
    };
  }
  return { x, y };
}

async function resolveRefRectNoScroll(cdp, sid, refMap, ref, refState, options = {}) {
  const frameParsed = parseFrameRef(ref);
  const objectId = options.objectId || await resolveRefNode(cdp, sid, refMap, ref, refState);
  const result = await cdpDomains(cdp).Runtime.callFunctionOn( {
    objectId,
    functionDeclaration: options.functionDeclaration || `function() {
      const rect = this.getBoundingClientRect();
      const cs = (typeof getComputedStyle === 'function') ? getComputedStyle(this) : null;
      return {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
        tag: this.tagName,
        text: (this.getAttribute('aria-label') || this.getAttribute('title') || this.textContent || '').trim().substring(0, 80),
        position: cs ? cs.position : '',
        pointerEvents: cs ? cs.pointerEvents : '',
        visible: !!(rect.width && rect.height),
      };
    }`,
    returnByValue: true,
  }, sid, REF_RESOLVE_TIMEOUT);
  const value = result.result.value || {};
  if (options.functionDeclaration) return value;
  if (frameParsed) {
    const { entry } = frameScopedBackendNode(refState || {}, frameParsed);
    const offset = await frameViewportOffset(cdp, sid, entry);
    value.x = (Number(value.x) || 0) + offset.x;
    value.y = (Number(value.y) || 0) + offset.y;
  }
  return { rect: value, objectId };
}

// Wait for DOM mutations to stop after an action (350ms of silence = settled).
// Bound the CDP evaluate to the settle budget so a document replacement cannot
// hang until the default 15s CDP timeout.
async function waitForSettle(cdp, sid, timeoutMs = 3000) {
  const budget = Math.max(1, Number(timeoutMs) || 3000);
  let timer;
  try {
    const outcome = await Promise.race([
      evalStr(cdp, sid, `new Promise(resolve => {
    let timer;
    const done = () => { obs.disconnect(); resolve('stable'); };
    const reset = () => { clearTimeout(timer); timer = setTimeout(done, 350); };
    const obs = new MutationObserver(reset);
    obs.observe(document.body || document.documentElement, { childList: true, subtree: true, attributes: true });
    timer = setTimeout(done, 350);
    setTimeout(() => { clearTimeout(timer); obs.disconnect(); resolve('timeout'); }, ${budget});
  })`, false, { timeoutMs: budget + 50 }),
      new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), budget); }),
    ]);
    return outcome === 'timeout' ? 'timeout' : String(outcome || 'stable');
  } catch {
    return 'stable';
  } finally {
    clearTimeout(timer);
  }
}

async function waitForHoverDomChange(cdp, sid, timeoutMs = HOVER_MUTATION_TIMEOUT_MS) {
  // First MutationObserver callback from this hover, not 350ms of silence.
  // waitForSettle treats pre-hover idle as settled and recapture then writes
  // the idle AX tree (#286 live Chrome 151). Do not wait for mouseMoved ack.
  const budget = Math.max(1, Number(timeoutMs) || HOVER_MUTATION_TIMEOUT_MS);
  let timer;
  try {
    const outcome = await Promise.race([
      evalStr(cdp, sid, `new Promise(resolve => {
    const done = (value) => { obs.disconnect(); resolve(value); };
    const obs = new MutationObserver(() => done('hover-changed'));
    obs.observe(document.body || document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
    void ${JSON.stringify(HOVER_MUTATION_MARKER)};
    setTimeout(() => { obs.disconnect(); resolve('timeout'); }, ${budget});
  })`, false, { timeoutMs: budget + 50 }),
      new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), budget); }),
    ]);
    return String(outcome || '').includes('hover-changed') ? 'hover-changed' : 'timeout';
  } catch {
    return 'timeout';
  } finally {
    clearTimeout(timer);
  }
}

function hoverRecaptureShowsChange(before, after) {
  if (before == null || after == null) return false;
  if (before === after) return false;
  return actionDomDiffShowsChange(formatPerceiveDiffOutput(before, after, { mode: 'since-action' }));
}

function discardHoverIdleBaseline(lastPerceiveStore) {
  if (!lastPerceiveStore || typeof lastPerceiveStore !== 'object') return;
  lastPerceiveStore.output = null;
}

function validateUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error(`Invalid URL: ${url}`); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Only http/https URLs allowed, got: ${parsed.protocol}`);
  }
  // Block cloud metadata endpoints (AWS/GCP/Azure IMDS)
  const host = parsed.hostname;
  const metadataIPs = ['169.254.169.254', '169.254.170.2', 'fd00:ec2::254'];
  const metadataHosts = ['metadata.google.internal', 'metadata.gke.internal'];
  if (metadataIPs.includes(host) || metadataHosts.includes(host)) {
    throw new Error(`Blocked: cloud metadata endpoint (${host})`);
  }
  // Block link-local range (169.254.x.x)
  if (/^169\.254\.\d+\.\d+$/.test(host)) {
    throw new Error(`Blocked: link-local address (${host})`);
  }
}

// Perceive: enriched accessibility tree with inline visual layout annotations
// Options parsed from args: --diff, --selector <sel>, --interactive/-i, --depth <N>, --cursor-interactive/-C
const TYPEAHEAD_OMITTED_NOTICE = 'Focused search/typeahead — suggestions omitted. Next: press Escape or perceive -s main';
const TYPEAHEAD_FOCUS_ROLES = new Set(['searchbox', 'combobox']);
const TYPEAHEAD_POPUP_ROLES = new Set(['listbox', 'option']);

function pickPrimaryScrollMetrics(candidates, opts) {
  const significancePx = opts && Number.isFinite(opts.significancePx) ? opts.significancePx : 80;
  if (!candidates || candidates.length === 0) {
    return { scrollY: 0, scrollMax: 0, source: 'document' };
  }
  function metric(candidate, fallbackSource) {
    const scrollHeight = Number(candidate && candidate.scrollHeight) || 0;
    const clientHeight = Number(candidate && candidate.clientHeight) || 0;
    const scrollTop = Number(candidate && candidate.scrollTop) || 0;
    return {
      scrollY: Math.round(scrollTop),
      scrollMax: Math.round(Math.max(0, scrollHeight - clientHeight)),
      source: (candidate && candidate.source) || fallbackSource,
    };
  }
  let best = metric(candidates[0], 'document');
  for (let i = 1; i < candidates.length; i++) {
    const next = metric(candidates[i], 'inner');
    if (best.scrollMax === 0 && next.scrollMax > 0) best = next;
    else if (next.scrollMax > best.scrollMax + significancePx) best = next;
  }
  return best;
}

function axNodeRole(node) {
  return String(node?.role?.value || node?.role || '');
}

function axNodeProp(node, name) {
  const props = node?.properties;
  if (!Array.isArray(props)) return undefined;
  for (const prop of props) {
    const propName = prop?.name?.value || prop?.name;
    if (propName === name) return prop?.value?.value ?? prop?.value;
  }
  return undefined;
}

function isDomSearchFocus(focusedDesc) {
  if (!focusedDesc || focusedDesc === 'none') return false;
  const s = String(focusedDesc);
  if (!/^<(input|textarea)\b/i.test(s)) return false;
  const id = (s.match(/#([^>.\s]+)/) || [])[1] || '';
  const cls = (s.match(/\.([^>\s]+)/) || [])[1] || '';
  const tokens = `${id} ${cls}`.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return tokens.some(token => (
    token === 'search' || token === 'searchbox' || token === 'combobox'
    || token === 'typeahead' || token === 'autocomplete'
  ));
}

function selectorTargetsTypeaheadInput(selector) {
  if (selector == null) return false;
  const s = String(selector).trim().toLowerCase();
  if (!s) return false;
  if (s === 'main' || s === 'article' || s === 'body' || s === 'html') return false;
  if (/^(main|article|body|html)[.#:>[]/.test(s)) return false;
  if (/\b(?:input|textarea|select)\b/.test(s)) return true;
  if (/\[role\s*=\s*['"]?(?:searchbox|combobox|textbox|listbox)\b/.test(s)) return true;
  if (/\b(?:searchbox|combobox|typeahead|autocomplete)\b/.test(s)) return true;
  if (/(?:^|[\s.#:[])search\b/.test(s)) return true;
  return false;
}

function omitTypeaheadListboxNodes(nodes, opts = {}) {
  const list = Array.isArray(nodes) ? nodes : [];
  if (opts.keepTypeahead || selectorTargetsTypeaheadInput(opts.selector)) {
    return { nodes: list, omitted: false };
  }
  const focusedSearch = list.some(node => {
    const focused = axNodeProp(node, 'focused');
    return (focused === true || focused === 'true') && TYPEAHEAD_FOCUS_ROLES.has(axNodeRole(node));
  });
  if (!focusedSearch && !isDomSearchFocus(opts.focusedDesc)) {
    return { nodes: list, omitted: false };
  }
  const childrenByParent = new Map();
  for (const node of list) {
    if (!node?.parentId) continue;
    if (!childrenByParent.has(node.parentId)) childrenByParent.set(node.parentId, []);
    childrenByParent.get(node.parentId).push(node);
  }
  const omitIds = new Set();
  function markSubtree(nodeId) {
    if (omitIds.has(nodeId)) return;
    omitIds.add(nodeId);
    for (const child of (childrenByParent.get(nodeId) || [])) markSubtree(child.nodeId);
  }
  let foundPopup = false;
  for (const node of list) {
    if (!TYPEAHEAD_POPUP_ROLES.has(axNodeRole(node))) continue;
    foundPopup = true;
    markSubtree(node.nodeId);
  }
  if (!foundPopup) return { nodes: list, omitted: false };
  return { nodes: list.filter(node => !omitIds.has(node.nodeId)), omitted: true };
}

const PERCEIVE_COMPACT_FLAGS =
  '--last N | --adaptive | --qa | --summary | -i | -C | -d N | -x sel | -s sel | --keep-typeahead | --cards | --role feed';

function unknownPerceiveOption(token) {
  throw new Error(`unknown option ${token}\nperceive compact flags: ${PERCEIVE_COMPACT_FLAGS}`);
}

const PERCEIVE_SNAPSHOT_FLAGS = new Set([
  '-i', '--interactive', '-C', '--cursor-interactive', '-d', '--depth',
  '-s', '--selector', '-x', '--exclude', '--keep-typeahead', '--last',
  '--adaptive', '--cards', '--role', '-F', '--frame',
]);

function perceiveArgsIncludeSnapshotShape(args = []) {
  return args.some(token => PERCEIVE_SNAPSHOT_FLAGS.has(String(token)));
}

function perceiveSnapshotOpts(opts = {}) {
  return {
    interactive: Boolean(opts.interactive),
    maxDepth: opts.maxDepth === undefined ? Infinity : opts.maxDepth,
    cursorInteractive: Boolean(opts.cursorInteractive),
    selector: opts.selector || null,
    exclude: opts.exclude || null,
    keepTypeahead: Boolean(opts.keepTypeahead),
    last: opts.last ?? null,
    adaptive: Boolean(opts.adaptive),
    cards: Boolean(opts.cards),
    frameRef: opts.frameRef || null,
  };
}

function resolveSinceActionPerceiveOpts(popts = {}, lastAction = null, rawArgs = []) {
  if (!popts.sinceAction) return popts;
  const snapshot = lastAction?.baselineOpts;
  const userShaped = perceiveArgsIncludeSnapshotShape(rawArgs);
  return {
    ...popts,
    ...(userShaped || !snapshot ? {} : snapshot),
    sinceAction: true,
    keepTypeahead: true,
    diffBaseline: popts.diffBaseline ?? lastAction?.baselineOutput ?? null,
  };
}

function parsePerceiveArgs(args) {
  const opts = {
    diff: false, selector: null, exclude: null,
    interactive: false, maxDepth: Infinity, cursorInteractive: false,
    keepRefs: false, keepTypeahead: false, last: null, adaptive: false, sinceAction: false, frameRef: null,
    cards: false,
  };
  const requireValue = (flag, index, label) => {
    const value = args[index + 1];
    if (value === undefined || value === '' || String(value).startsWith('-')) {
      throw new Error(`${flag} requires ${label}`);
    }
    return value;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!String(a).startsWith('-')) continue;
    if (a === '--diff') opts.diff = true;
    else if (a === '--since-action') opts.sinceAction = true;
    else if (a === '--cards') opts.cards = true;
    else if (a === '--role') {
      const role = String(requireValue(a, i, 'a role')).trim().toLowerCase();
      i++;
      if (role === 'feed') opts.cards = true;
    } else if (a === '-F' || a === '--frame') {
      opts.frameRef = requireValue(a, i, 'a frame ref');
      i++;
    } else if (a === '-s' || a === '--selector') {
      opts.selector = requireValue(a, i, 'a CSS selector');
      i++;
    } else if (a === '-x' || a === '--exclude') {
      opts.exclude = requireValue(a, i, 'a CSS selector');
      i++;
    } else if (a === '-i' || a === '--interactive') opts.interactive = true;
    else if (a === '-d' || a === '--depth') {
      opts.maxDepth = parseInt(requireValue(a, i, 'a depth')) || Infinity;
      i++;
    } else if (a === '-C' || a === '--cursor-interactive') opts.cursorInteractive = true;
    else if (a === '--keep-typeahead') opts.keepTypeahead = true;
    else if (a === '--keep-refs') opts.keepRefs = true;
    else if (a === '--adaptive') opts.adaptive = true;
    else if (a === '--last') {
      const raw = requireValue(a, i, 'N or auto');
      i++;
      if (raw === 'auto') {
        opts.last = 'auto';
        opts.adaptive = true;
      } else {
        const n = parseInt(raw);
        opts.last = Number.isFinite(n) && n > 0 ? n : null;
      }
    } else {
      unknownPerceiveOption(a);
    }
  }
  return opts;
}

/**
 * Choose a perceive text-row budget from density + error state.
 * Explicit numeric --last still wins; this is for --adaptive / --last auto.
 */
function chooseAdaptivePerceiveLast({
  lineCount = 0,
  consoleErrors = 0,
  interactiveCount = 0,
  hasPriorityText = false,
} = {}) {
  let budget = 48;
  if (lineCount > 100) budget = 36;
  if (lineCount > 220) budget = 24;
  if (lineCount > 400) budget = 16;
  if (consoleErrors > 0 || hasPriorityText) budget = Math.max(budget, 28);
  if (interactiveCount > 40) budget = Math.min(budget, 22);
  if (interactiveCount > 80) budget = Math.min(budget, 16);
  return Math.max(8, Math.min(80, budget));
}

const PERCEIVE_CURSOR_SURFACE_DEFAULT_CAP = 8;
const PERCEIVE_CHROME_MAX_RELATIVE_DEPTH = 2;
const PERCEIVE_CHROME_LINE_CAP = 12;
const PERCEIVE_CONTENT_LANDMARK_ROLES = new Set(['main', 'article']);
const PERCEIVE_CHROME_LANDMARK_ROLES = new Set(['navigation', 'banner', 'complementary']);

function countsTowardPerceiveDepth(node) {
  const role = node.role?.value || '';
  return role !== 'none' && role !== 'generic' && role !== 'InlineTextBox';
}

function isPerceiveBodyTextRole(role) {
  return role === 'StaticText' || role === 'paragraph' || role === 'heading';
}

function perceiveCursorSurfaceLimit(opts = {}) {
  const defaultCap = PERCEIVE_CURSOR_SURFACE_DEFAULT_CAP;
  const { last = null, adaptive = false } = opts;
  if (Number.isFinite(last) && last > 0) return last;
  if (last === 'auto' || adaptive) {
    const budget = chooseAdaptivePerceiveLast({
      lineCount: Number(opts.lineCount || 0),
      consoleErrors: Number(opts.consoleErrors || 0),
      interactiveCount: Number(opts.interactiveCount || 0),
      hasPriorityText: Boolean(opts.hasPriorityText),
    });
    return Math.max(4, Math.min(defaultCap, Math.ceil(budget / 6)));
  }
  return defaultCap;
}

function perceiveCursorItemSkipHaystack(item, nameOf) {
  const named = typeof nameOf === 'function' ? nameOf(item) : '';
  return [
    named,
    item?.label,
    item?.ariaLabel,
    item?.text,
    item?.title,
    item?.sel,
    item?.selector,
  ].filter(Boolean).join('\n');
}

function rankPerceiveCursorItems(items, nameOf) {
  const skip = [];
  const rest = [];
  for (const item of items || []) {
    (isSkipLinkName(perceiveCursorItemSkipHaystack(item, nameOf)) ? skip : rest).push(item);
  }
  return rest.concat(skip);
}

function parseControlsArgs(args) {
  const opts = { selector: null, filter: null, limit: 30, compact: false };
  const requireValue = (flag, label, index) => {
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`controls: ${flag} requires ${label}`);
    return value;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-s' || a === '--selector' || a === '--scope') {
      opts.selector = requireValue(a, 'a CSS selector', i);
      i++;
    } else if (a === '--filter' || a === '-f') {
      opts.filter = requireValue(a, 'text', i);
      i++;
    } else if (a === '--limit' || a === '-n') {
      const raw = requireValue(a, 'a positive integer', i);
      i++;
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) throw new Error(`controls: ${a} requires a positive integer`);
      opts.limit = Math.min(n, 100);
    } else if (a === '--compact' || a === '--summary') {
      opts.compact = true;
    } else {
      throw new Error(`controls: unknown argument ${a}`);
    }
  }
  return opts;
}

function compactVisibleControlsModel(model = {}) {
  return {
    ...model,
    compact: true,
    controls: (model.controls || []).map(control => ({
      role: control.role || null,
      label: control.label || null,
      selector: control.selector || null,
      disabled: Boolean(control.disabled),
      clickable: Boolean(control.clickable),
      rect: control.rect || null,
    })),
  };
}

function visibleControlsCollectorSource() {
  return String.raw`
      function chromeCdpVisibleControls(options) {
        const vw = window.innerWidth || 0;
        const vh = window.innerHeight || 0;
        const limit = Math.max(1, Math.min(Number(options.limit) || 30, 100));
        const scope = options.selector || null;
        const filter = options.filter ? String(options.filter).toLowerCase() : null;
        const schema = 'chrome-cdp-ex.visible-controls.v1';
        let root = document;
        if (scope) {
          try {
            root = document.querySelector(scope);
          } catch (err) {
            return { schema, scope, filter: options.filter || null, limit, total: 0, returned: 0, truncated: false, controls: [], error: 'invalid-selector', message: String(err && err.message || err || 'Invalid selector') };
          }
        }
        if (!root) {
          return { schema, scope, filter: options.filter || null, limit, total: 0, returned: 0, truncated: false, controls: [], error: 'scope-not-found' };
        }

        const interactiveRoles = new Set(['button', 'link', 'menuitem', 'option', 'checkbox', 'radio', 'switch', 'tab', 'textbox', 'combobox', 'searchbox']);
        const nativeInteractive = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY']);
        const selector = [
          'a', 'button', 'input', 'select', 'textarea', 'summary',
          '[role="button"]', '[role="link"]', '[role="menuitem"]', '[role="option"]',
          '[role="checkbox"]', '[role="radio"]', '[role="switch"]', '[role="tab"]',
          '[role="textbox"]', '[role="combobox"]', '[role="searchbox"]',
          '[role]', '[contenteditable="true"]', '[onclick]', '[tabindex]',
          '[aria-label]', '[title]',
          'div', 'span', 'li', 'label', 'svg', 'img'
        ].join(',');

        function esc(value) {
          const text = String(value || '');
          return window.CSS && CSS.escape ? CSS.escape(text) : text.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
        }

        function compactText(value, max = 60) {
          return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
        }

        function roleFor(el) {
          const explicit = el.getAttribute('role');
          if (explicit) {
            const tokens = String(explicit).trim().toLowerCase().split(/\s+/).filter(Boolean);
            return tokens.find(token => interactiveRoles.has(token)) || tokens[0] || '';
          }
          const tag = el.tagName.toLowerCase();
          if (tag === 'a') return 'link';
          if (tag === 'button') return 'button';
          if (tag === 'textarea') return 'textbox';
          if (tag === 'select') return 'combobox';
          if (tag === 'input') {
            const type = String(el.getAttribute('type') || 'text').toLowerCase();
            if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
            if (['checkbox', 'radio'].includes(type)) return type;
            return 'textbox';
          }
          return '';
        }

        function selectorFor(el) {
          const tag = el.tagName.toLowerCase();
          if (el.id) return tag + '#' + esc(el.id);
          const aria = el.getAttribute('aria-label');
          if (aria) return tag + '[aria-label="' + String(aria).replace(/"/g, '\\"') + '"]';
          const title = el.getAttribute('title');
          if (title) return tag + '[title="' + String(title).replace(/"/g, '\\"') + '"]';
          if (typeof el.className === 'string' && el.className.trim()) {
            return tag + el.className.trim().split(/\s+/).slice(0, 2).map(c => '.' + esc(c)).join('');
          }
          return tag;
        }

        function nearestScrollable(el) {
          for (let parent = el.parentElement; parent && parent !== document.documentElement && parent !== document.body; parent = parent.parentElement) {
            const style = window.getComputedStyle(parent);
            const overflow = (style.overflowX || '') + ' ' + (style.overflowY || '');
            const clips = /(auto|scroll|hidden|clip)/.test(overflow);
            const scrollable = parent.scrollWidth > parent.clientWidth + 1 || parent.scrollHeight > parent.clientHeight + 1;
            if (clips && scrollable) return parent;
          }
          return null;
        }

        function isScrollportClipped(el, rect) {
          const container = nearestScrollable(el);
          if (!container) return false;
          const pr = container.getBoundingClientRect();
          const top = Math.max(rect.top, pr.top);
          const left = Math.max(rect.left, pr.left);
          const bottom = Math.min(rect.bottom, pr.bottom);
          const right = Math.min(rect.right, pr.right);
          const visibleW = Math.max(0, right - left);
          const visibleH = Math.max(0, bottom - top);
          // Fully (or nearly) clipped by an overflow ancestor → not actionable for hit-testing.
          return visibleW < 2 || visibleH < 2;
        }

        function isVisible(rect, cs) {
          if (!rect || rect.width < 4 || rect.height < 4) return false;
          if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
          return rect.bottom >= 0 && rect.right >= 0 && rect.top <= vh && rect.left <= vw;
        }

        function isClickable(el, cs, role) {
          const tagInteractive = nativeInteractive.has(el.tagName);
          const roleInteractive = interactiveRoles.has(role);
          return tagInteractive || roleInteractive || cs.cursor === 'pointer' || el.hasAttribute('onclick') || (el.hasAttribute('tabindex') && el.tabIndex >= 0);
        }

        const controls = [];
        const seen = new Set();
        const candidates = [];
        if (root.matches && root.matches(selector)) candidates.push(root);
        if (root.querySelectorAll) candidates.push(...root.querySelectorAll(selector));
        for (const el of candidates) {
          const cs = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          if (!isVisible(rect, cs)) continue;
          if (isScrollportClipped(el, rect)) continue;
          const role = roleFor(el);
          const clickable = isClickable(el, cs, role);
          const ariaLabel = compactText(el.getAttribute('aria-label'));
          const title = compactText(el.getAttribute('title'));
          const text = compactText(el.innerText || el.textContent || el.getAttribute('placeholder') || el.getAttribute('value'));
          const label = ariaLabel || title || text || role || el.tagName.toLowerCase();
          if (!clickable && !ariaLabel && !title) continue;
          const path = selectorFor(el);
          const key = path + '|' + Math.round(rect.left) + ',' + Math.round(rect.top);
          if (seen.has(key)) continue;
          seen.add(key);
          const haystack = [el.tagName, role, ariaLabel, title, text, path, el.id, el.className].join(' ').toLowerCase();
          if (filter && !haystack.includes(filter)) continue;
          const classes = typeof el.className === 'string'
            ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 3)
            : [];
          controls.push({
            tag: el.tagName.toLowerCase(),
            role,
            ariaLabel,
            title,
            label,
            text,
            disabled: Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true',
            clickable,
            rect: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) },
            selector: path,
            hints: { id: el.id || '', classes },
          });
        }
        const total = controls.length;
        return {
          schema,
          scope,
          filter: options.filter || null,
          limit,
          total,
          returned: Math.min(total, limit),
          truncated: total > limit,
          controls: controls.slice(0, limit),
        };
      }
  `;
}

function visibleControlsPageScript(opts = {}) {
  const options = {
    selector: opts.selector || null,
    filter: opts.filter || null,
    limit: opts.limit || 30,
  };
  return `(function() {
${visibleControlsCollectorSource()}
      return JSON.stringify(chromeCdpVisibleControls(${JSON.stringify(options)}));
    })()`;
}

function formatVisibleControlLine(control, index = null) {
  const role = control.role ? ` role=${control.role}` : '';
  const aria = control.ariaLabel ? ` aria-label="${control.ariaLabel}"` : '';
  const title = control.title && control.title !== control.label ? ` title="${control.title}"` : '';
  const label = control.label ? ` "${control.label}"` : '';
  const state = [
    control.clickable ? 'clickable' : null,
    control.disabled ? 'disabled' : null,
  ].filter(Boolean);
  const stateText = state.length ? ` [${state.join(',')}]` : '';
  const rect = control.rect ? ` (${control.rect.x},${control.rect.y} ${control.rect.w}×${control.rect.h})` : '';
  const ref = control.ref ? ` ${control.ref}` : '';
  const hints = [];
  if (control.hints?.id) hints.push(`#${control.hints.id}`);
  for (const cls of control.hints?.classes || []) hints.push(`.${cls}`);
  const hintText = hints.length ? ` ${hints.join('')}` : '';
  const prefix = index == null ? '' : `${index}. `;
  return `${prefix}${control.tag || '?'}${role}${aria}${title}${label}${stateText}${rect}${ref} ${control.selector || ''}${hintText}`.trimEnd();
}

function offsetCssRect(rect, offset) {
  if (!rect || typeof rect !== 'object') return rect;
  const dx = Number(offset?.x) || 0;
  const dy = Number(offset?.y) || 0;
  if (!dx && !dy) return rect;
  const next = { ...rect };
  if (rect.x != null) next.x = (Number(rect.x) || 0) + dx;
  if (rect.y != null) next.y = (Number(rect.y) || 0) + dy;
  return next;
}

function offsetCursorInteractiveItem(item, offset) {
  if (!item || typeof item !== 'object') return item;
  const dx = Number(offset?.x) || 0;
  const dy = Number(offset?.y) || 0;
  if (!dx && !dy) return item;
  return {
    ...item,
    x: (Number(item.x) || 0) + dx,
    y: (Number(item.y) || 0) + dy,
    ...(item.rect ? { rect: offsetCssRect(item.rect, offset) } : {}),
  };
}

function nativeVisibleControlTag(tag) {
  return new Set(['a', 'button', 'input', 'select', 'textarea']).has(String(tag || '').toLowerCase());
}

function refAnnotationsFromTreeLines(treeLines = []) {
  const out = [];
  for (const line of treeLines) {
    const text = String(line || '');
    const match = text.match(/\[([^\]]+)\](?:\s+(.*?))?\s+@((?:f\d+:)?\d+)(?:\s+\((-?\d+),(-?\d+) (\d+)×(\d+)\))?/);
    if (!match) continue;
    const name = String(match[2] || '').replace(/\s+=\s+\S.*$/, '').replace(/\s+checked=\S.*$/, '').trim();
    const idHint = name.split(/\s+/).find(Boolean) || '';
    out.push({
      role: match[1],
      name,
      id: idHint,
      selector: idHint ? `#${idHint}` : '',
      ref: `@${match[3]}`,
      x: match[4] != null ? Number(match[4]) : null,
      y: match[5] != null ? Number(match[5]) : null,
      w: match[6] != null ? Number(match[6]) : null,
      h: match[7] != null ? Number(match[7]) : null,
    });
  }
  return out;
}

function attachRefToVisibleControl(control, annotations = []) {
  if (!control || !annotations.length) return control;
  const id = String(control.hints?.id || '').trim();
  const selector = String(control.selector || '').trim();
  const byIdentity = annotations.find(item => {
    if (id && (item.id === id || item.selector === `#${id}` || String(item.name || '') === id)) return true;
    if (selector && item.selector && (item.selector === selector || selector.endsWith(item.selector))) return true;
    return false;
  });
  if (byIdentity) return { ...control, ref: byIdentity.ref };
  if (!control.rect) return control;
  const { x, y, w, h } = control.rect;
  const hit = annotations.find(item => (
    item.x != null
    && Math.abs(item.x - x) <= 1
    && Math.abs(item.y - y) <= 1
    && Math.abs(item.w - w) <= 1
    && Math.abs(item.h - h) <= 1
  ));
  if (hit) return { ...control, ref: hit.ref };
  return control;
}

function axRoleForDomControl(control = {}) {
  const tag = String(control.tag || '').toLowerCase();
  const type = String(control.type || '').toLowerCase();
  if (tag === 'a') return 'link';
  if (tag === 'button') return 'button';
  if (tag === 'textarea') return 'textbox';
  if (tag === 'select') return control.multiple ? 'listbox' : 'combobox';
  if (tag === 'input') {
    if (type === 'checkbox' || type === 'radio') return type;
    if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
    return 'textbox';
  }
  return control.role || 'generic';
}

function syntheticAxNodeFromDomControl(control, nodeId) {
  const role = control.role || axRoleForDomControl(control);
  const node = {
    nodeId,
    role: { value: role },
    name: { value: control.name || control.id || '' },
    backendDOMNodeId: control.backendNodeId,
  };
  if (control.parentId) node.parentId = control.parentId;
  if (control.value != null && control.value !== '') node.value = { value: control.value };
  if (control.checked === true || control.checked === false) node.checked = { value: control.checked };
  if (Array.isArray(control.selected) && control.selected.length) {
    node.value = { value: control.selected.join(', ') };
  }
  return node;
}

function isSynthesizableDomControl(control = {}) {
  const tag = String(control.tag || '').toLowerCase();
  if (!nativeVisibleControlTag(tag)) return false;
  const type = String(control.type || '').toLowerCase();
  if (type === 'hidden') return false;
  if (control.hidden === true) return false;
  const display = String(control.display || '').toLowerCase();
  const visibility = String(control.visibility || '').toLowerCase();
  if (display === 'none' || visibility === 'hidden') return false;
  return true;
}

function shouldSynthesizeMissingFrameInteractives(frame, axNodes = [], listed = []) {
  if (!frame) return false;
  const candidates = (listed || []).filter(isSynthesizableDomControl);
  if (!candidates.length) return false;
  return candidates.length > axInteractiveBackendCount(axNodes);
}

function mergeMissingDomInteractiveAxNodes(axNodes = [], domControls = []) {
  const have = new Set(
    (axNodes || [])
      .map(node => node?.backendDOMNodeId)
      .filter(id => id != null),
  );
  const extras = [];
  let index = 0;
  for (const control of domControls || []) {
    if (!isSynthesizableDomControl(control)) continue;
    if (control?.backendNodeId == null || have.has(control.backendNodeId)) continue;
    index += 1;
    extras.push(syntheticAxNodeFromDomControl(control, `dom-interactive-${index}`));
  }
  if (!extras.length) return axNodes || [];
  const nodes = (axNodes || []).map(node => (node?.childIds ? { ...node, childIds: [...node.childIds] } : { ...node }));
  const root = nodes.find(node => !node.parentId);
  if (root) {
    root.childIds = [...(root.childIds || []), ...extras.map(node => node.nodeId)];
    for (const extra of extras) extra.parentId = root.nodeId;
  }
  return [...nodes, ...extras];
}

function countedInteractiveElements(counts = {}) {
  return Object.values(counts).reduce((sum, value) => sum + (Number(value) || 0), 0);
}

function axInteractiveBackendCount(axNodes = []) {
  const ids = new Set();
  for (const node of axNodes) {
    const role = node?.role?.value || '';
    if (!INTERACTIVE_ROLES.has(role) || node.backendDOMNodeId == null) continue;
    ids.add(node.backendDOMNodeId);
  }
  return ids.size;
}

function domInteractiveListScript() {
  return `(function() {
    const chromeCdpDomInteractiveList = true;
    const els = Array.from(document.querySelectorAll('a, button, input, select, textarea'));
    const out = [];
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      const tag = el.tagName.toLowerCase();
      const type = String(el.type || '').toLowerCase();
      const cs = window.getComputedStyle(el);
      const hidden = Boolean(el.hidden)
        || el.getAttribute('hidden') != null
        || type === 'hidden'
        || cs.display === 'none'
        || cs.visibility === 'hidden';
      if (hidden) continue;
      let role = tag;
      if (tag === 'a') role = 'link';
      else if (tag === 'button') role = 'button';
      else if (tag === 'textarea') role = 'textbox';
      else if (tag === 'select') role = el.multiple ? 'listbox' : 'combobox';
      else if (tag === 'input') {
        if (type === 'checkbox' || type === 'radio') role = type;
        else if (['button', 'submit', 'reset', 'image'].includes(type)) role = 'button';
        else role = 'textbox';
      }
      out.push({
        chromeCdpDomInteractiveList: true,
        index: i,
        tag: tag,
        type: type,
        id: el.id || '',
        name: String(el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || el.id || '').slice(0, 80),
        value: el.value || '',
        checked: el.checked === true,
        multiple: tag === 'select' ? Boolean(el.multiple) : false,
        selected: tag === 'select' ? Array.from(el.selectedOptions || []).map(opt => opt.value) : null,
        role: role,
        hidden: false,
        display: cs.display,
        visibility: cs.visibility
      });
    }
    return JSON.stringify(out);
  })()`;
}

async function listDomInteractiveControls(cdp, sid, { contextId = null, limit = 40 } = {}) {
  let listed = [];
  try {
    const raw = await evalStr(cdp, sid, domInteractiveListScript(), false, contextId != null ? { contextId } : {});
    listed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(listed) || listed.length === 0) return [];
  const capped = listed.filter(isSynthesizableDomControl).slice(0, Math.max(1, Math.min(Number(limit) || 40, 80)));
  return capped;
}

async function collectDomInteractiveControls(cdp, sid, { contextId = null, limit = 40, listed = null } = {}) {
  const candidates = listed || await listDomInteractiveControls(cdp, sid, { contextId, limit });
  if (!Array.isArray(candidates) || candidates.length === 0) return [];
  const out = [];
  for (const item of candidates) {
    try {
      const params = {
        expression: `document.querySelectorAll('a, button, input, select, textarea')[${Number(item.index) || 0}]`,
        returnByValue: false,
        awaitPromise: false,
      };
      if (contextId != null) params.contextId = contextId;
      const remote = await cdpDomains(cdp).Runtime.evaluate(params, sid);
      const objectId = remote?.result?.objectId;
      if (!objectId) continue;
      const described = await cdpDomains(cdp).DOM.describeNode({ objectId }, sid);
      const backendNodeId = described?.node?.backendNodeId;
      if (backendNodeId == null) continue;
      out.push({ ...item, backendNodeId });
    } catch {
      // Best-effort: AX dump still renders whatever Chrome already exposed.
    }
  }
  return out;
}

function formatVisibleControlsText(model) {
  if (model.error === 'scope-not-found') {
    return `Visible controls: scope not found (${model.scope})`;
  }
  const scope = model.scope ? ` in ${model.scope}` : '';
  const filter = model.filter ? ` matching "${model.filter}"` : '';
  const suffix = model.truncated ? ` (truncated to ${model.limit})` : '';
  const lines = [`Visible controls: ${model.returned}/${model.total}${scope}${filter}${suffix}`];
  if (!model.controls?.length) {
    lines.push('  none');
    return lines.join('\n');
  }
  model.controls.forEach((control, index) => {
    lines.push(`  ${formatVisibleControlLine(control, index + 1)}`);
  });
  return lines.join('\n');
}

async function controlsStr(cdp, sid, opts = {}) {
  const result = await cdpDomains(cdp).Runtime.evaluate( {
    expression: visibleControlsPageScript(opts),
    returnByValue: true,
    awaitPromise: false,
  }, sid);
  if (result.exceptionDetails) {
    throw new Error(runtimeExceptionMessage(result.exceptionDetails));
  }
  const raw = result.result?.value ?? '{}';
  const model = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (model.error === 'invalid-selector') {
    throw new Error(`controls: invalid selector: ${model.scope}${model.message ? ` (${model.message})` : ''}`);
  }
  if (model.error === 'scope-not-found') {
    throw new Error(`controls: selector not found: ${model.scope}`);
  }
  const outputModel = opts.compact ? compactVisibleControlsModel(model) : model;
  return opts.format === 'json' ? formatJson(outputModel) : formatVisibleControlsText(outputModel);
}

function collectDomBackendNodeIds(node, out = new Set()) {
  if (!node || typeof node !== 'object') return out;
  const backendNodeId = node.backendNodeId ?? node.backendDOMNodeId;
  if (backendNodeId != null) out.add(backendNodeId);
  for (const key of ['children', 'shadowRoots', 'pseudoElements', 'distributedNodes']) {
    for (const child of node[key] || []) collectDomBackendNodeIds(child, out);
  }
  if (node.contentDocument) collectDomBackendNodeIds(node.contentDocument, out);
  if (node.templateContent) collectDomBackendNodeIds(node.templateContent, out);
  return out;
}

function filterAxNodesToBackendSubtree(axNodes, backendNodeIds) {
  if (!backendNodeIds || backendNodeIds.size === 0) return axNodes;
  const nodesById = new Map(axNodes.map(n => [n.nodeId, n]));
  const includeCache = new Map();
  function included(node) {
    if (!node) return false;
    if (includeCache.has(node.nodeId)) return includeCache.get(node.nodeId);
    let value = false;
    if (node.backendDOMNodeId != null && backendNodeIds.has(node.backendDOMNodeId)) {
      value = true;
    } else if (node.parentId) {
      value = included(nodesById.get(node.parentId));
    }
    includeCache.set(node.nodeId, value);
    return value;
  }
  return axNodes.filter(included);
}

function axRoleValue(node) {
  const role = node?.role;
  if (typeof role === 'string') return role.toLowerCase();
  if (role && typeof role.value === 'string') return role.value.toLowerCase();
  return '';
}

function isMainLandmarkRole(role) {
  const value = String(role || '').toLowerCase();
  return value === 'main' || value === 'article';
}

function parseDomAttributeMap(attributes) {
  const map = Object.create(null);
  if (!Array.isArray(attributes)) return map;
  for (let i = 0; i + 1 < attributes.length; i += 2) {
    map[String(attributes[i]).toLowerCase()] = String(attributes[i + 1]);
  }
  return map;
}

function isMainContentDomNode(node) {
  if (!node || typeof node !== 'object') return false;
  const name = String(node.nodeName || node.localName || '').toLowerCase();
  if (name === 'main' || name === 'article') return true;
  const attrs = parseDomAttributeMap(node.attributes);
  const role = String(attrs.role || '').toLowerCase();
  if (role === 'main' || role === 'article') return true;
  const className = String(attrs.class || attrs.classname || '');
  return className.split(/\s+/).includes('mdx-content');
}

function walkDescribedDomNodes(node, visit) {
  if (!node || typeof node !== 'object') return;
  visit(node);
  for (const key of ['children', 'shadowRoots', 'pseudoElements', 'distributedNodes']) {
    for (const child of node[key] || []) walkDescribedDomNodes(child, visit);
  }
  if (node.contentDocument) walkDescribedDomNodes(node.contentDocument, visit);
  if (node.templateContent) walkDescribedDomNodes(node.templateContent, visit);
}

function domNodeContainsMainContent(node) {
  let found = false;
  walkDescribedDomNodes(node, child => {
    if (!found && isMainContentDomNode(child)) found = true;
  });
  return found;
}

function axChildrenByParent(axNodes) {
  const childMap = new Map();
  for (const n of axNodes || []) {
    if (!n?.parentId) continue;
    if (!childMap.has(n.parentId)) childMap.set(n.parentId, []);
    childMap.get(n.parentId).push(n);
  }
  return childMap;
}

function axNodeOrDescendantIsMainLandmark(node, childMap) {
  if (!node) return false;
  if (isMainLandmarkRole(axRoleValue(node))) return true;
  for (const child of childMap.get(node.nodeId) || []) {
    if (axNodeOrDescendantIsMainLandmark(child, childMap)) return true;
  }
  return false;
}

function describedNodeForBackendId(describedNodesByBackendId, backendNodeId) {
  if (!describedNodesByBackendId) return null;
  if (describedNodesByBackendId instanceof Map) return describedNodesByBackendId.get(backendNodeId) || null;
  return describedNodesByBackendId[backendNodeId] || null;
}

function shouldPreserveExcludedBackendNode(backendNodeId, axNodes, describedNodesByBackendId, childMap) {
  const ax = (axNodes || []).find(n => n.backendDOMNodeId === backendNodeId);
  if (ax && axNodeOrDescendantIsMainLandmark(ax, childMap)) return true;
  const described = describedNodeForBackendId(describedNodesByBackendId, backendNodeId);
  return Boolean(described && domNodeContainsMainContent(described));
}

function filterAxNodesByExcludedBackendIds(axNodes, excludedBackendNodeIds) {
  const excludedAxIds = new Set();
  for (const n of axNodes) {
    if (n.backendDOMNodeId && excludedBackendNodeIds.has(n.backendDOMNodeId)) excludedAxIds.add(n.nodeId);
  }
  if (excludedAxIds.size === 0) return axNodes;
  const childIdsByParent = new Map();
  for (const n of axNodes) {
    if (!n.parentId) continue;
    if (!childIdsByParent.has(n.parentId)) childIdsByParent.set(n.parentId, []);
    childIdsByParent.get(n.parentId).push(n.nodeId);
  }
  const queue = [...excludedAxIds];
  while (queue.length) {
    const id = queue.pop();
    for (const child of (childIdsByParent.get(id) || [])) {
      excludedAxIds.add(child);
      queue.push(child);
    }
  }
  return axNodes.filter(n => !excludedAxIds.has(n.nodeId));
}

function filterPerceiveExcludedAxNodes(axNodes, excludedBackendNodeIds, describedNodesByBackendId) {
  if (!excludedBackendNodeIds || excludedBackendNodeIds.size === 0) return axNodes;
  const childMap = axChildrenByParent(axNodes);
  const safeExcluded = new Set();
  for (const id of excludedBackendNodeIds) {
    if (shouldPreserveExcludedBackendNode(id, axNodes, describedNodesByBackendId, childMap)) continue;
    safeExcluded.add(id);
  }
  return filterAxNodesByExcludedBackendIds(axNodes, safeExcluded);
}

function perceiveInteractiveNoiseHint(count) {
  return `(Hint: ${count} interactive elements found — most may be sidebar/nav noise. Exclude must not empty main; prefer \`text --auto\` or \`perceive -s main\`. \`perceive -x "nav, aside"\` only drops chrome that does not wrap main.)`;
}

function parsePerceiveHeader(output) {
  const lines = String(output || '').split('\n');
  const pageMatch = (lines[0] || '').match(/^Page: (.*) — (.*)$/);
  const viewportMatch = (lines[1] || '').match(/^Viewport: (\d+)×(\d+) \| Scroll: (\d+)\/(\d+)/);
  const consoleLine = lines.find(line => line.startsWith('Console: ')) || 'Console: clean';
  const consoleHealth = { errors: 0, warnings: 0, exceptions: 0 };
  for (const [key, pattern] of [
    ['errors', /(\d+) errors?/],
    ['warnings', /(\d+) warnings?/],
    ['exceptions', /(\d+) exceptions?/],
  ]) {
    const match = consoleLine.match(pattern);
    if (match) consoleHealth[key] = Number(match[1]);
  }
  return {
    page: {
      title: pageMatch ? pageMatch[1] : '',
      url: pageMatch ? pageMatch[2] : '',
    },
    viewport: {
      width: viewportMatch ? Number(viewportMatch[1]) : 0,
      height: viewportMatch ? Number(viewportMatch[2]) : 0,
      scrollY: viewportMatch ? Number(viewportMatch[3]) : 0,
      scrollMax: viewportMatch ? Number(viewportMatch[4]) : 0,
      coordinateSpace: 'viewport-css-px',
    },
    console: consoleHealth,
  };
}

function stripPerceiveRectChrome(line) {
  // Viewport-CSS @ref / Visible-control suffixes (`(24,180 160×22)`,
  // `(8,80 80×24, fixed)`) move on every scroll even when AX identities
  // are unchanged (#295). Identity compare ignores that chrome; displayed
  // leftover dumps still include the live rects.
  return String(line || '').replace(/\s+\(-?\d+,-?\d+ \d+×\d+(?:, [^)]+)?\)/g, '');
}

function stripPerceiveSelectorChrome(line) {
  // Title-only Visible-control dump lines reprint the quoted name as
  // `span[title="…"]` / `time[title="…"]` plus trailing CSS class hints
  // (` .mx-2.text-green-500.dark:text-green-600`). That duplicated
  // selector+class chrome is identity chrome (#303), like rects / fold tags.
  // Displayed leftover dumps still include the live selectors.
  return String(line || '')
    .replace(/\s+[a-z][\w-]*\[(?:title|aria-label)="[^"]*"\]/gi, '')
    .replace(/\s+(?:\.[^\s]+)+$/g, '');
}

function stripPerceiveIdentityChrome(line) {
  // Fold tags (`↑above fold` / `↓below fold`) are viewport chrome on the
  // same landmark identity (#297). Title-only selector+class chrome is
  // identity chrome (#303). Do not strip Visible-control membership.
  return stripPerceiveSelectorChrome(
    stripPerceiveRectChrome(line).replace(/\s+[↑↓](?:above|below) fold\b/g, ''),
  );
}

function isVisibleControlsSectionHeader(line) {
  return /^\s*\[Visible controls\]/.test(String(line || ''));
}

function isVisibleControlDumpLine(line) {
  const text = String(line || '').trim();
  if (!text || text.startsWith('[') || text.startsWith('...')) return false;
  if (!/^(?:[a-z][\w-]*|\?)\b/i.test(text)) return false;
  return /\brole=/.test(text) || /\[(?:clickable|disabled)\b/.test(text);
}

function isVisibleControlStructuralLine(line) {
  return isVisibleControlsSectionHeader(line) || isVisibleControlDumpLine(line);
}

function isPerceiveDecorativeTitleChrome(line) {
  // Collector includes `[title]` even when the node is not clickable.
  // After identity-chrome strip those rows are `span "…"` / `time "Fri, … GMT"`.
  // They are signed-commit / timestamp chrome, not a file / heading / link (#303).
  const text = stripPerceiveIdentityChrome(line).trim();
  if (!text || isVisibleControlsSectionHeader(text) || isVisibleControlDumpLine(text)) return false;
  if (/^\[/.test(text)) return false;
  return /^(?:[a-z][\w-]*)\s+"[^"]+"\s*$/i.test(text);
}

function isVisibleControlTimestampName(name) {
  // Relative-time / HTTP-date GMT strings are membership chrome, not sample
  // names (#305). Same family as #299 (tag/role fallbacks stay counted) and
  // #293 (timestamp is not an identity name). Do not treat `main` as a
  // special case.
  const text = String(name || '').trim();
  if (!text) return false;
  if (/^[A-Z][a-z]{2}, \d{1,2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/i.test(text)) {
    return true;
  }
  return /^(?:just now|\d+\s+(?:second|minute|hour|day|week|month|year)s?\s+ago)$/i.test(text);
}

function visibleControlNameFromLine(line) {
  const text = stripPerceiveIdentityChrome(line).trim();
  if (!text || isVisibleControlsSectionHeader(text)) return { name: null, named: false };
  // Live collector always sets label to ariaLabel || title || text || role ||
  // tagName, so formatVisibleControlLine prints `img "img"` / `a role=link
  // "link"`. Those quoted tag/role fallbacks are membership, not sample
  // names (#299). Do not treat selector href quotes (`a[href="/"]`) as a name.
  const tag = (text.match(/^(?:[a-z][\w-]*|\?)\b/i) || [])[0] || '';
  const role = (text.match(/\brole=([^\s]+)/i) || [])[1] || '';
  const aria = text.match(/\baria-label="([^"]*)"/);
  const title = text.match(/\btitle="([^"]*)"/);
  const labeled = text.match(/\s"([^"]+)"/);
  const name = (aria && aria[1].trim())
    || (title && title[1].trim())
    || (labeled && labeled[1].trim())
    || null;
  if (name) {
    // Collector fallbacks equal the printed tag or role= (`img "img"`,
    // `a role=link "link"`). Relative-time / GMT title strings occupy the
    // same membership-not-sample bucket (#305).
    const key = name.toLowerCase();
    const named = key !== tag.toLowerCase()
      && key !== role.toLowerCase()
      && !isVisibleControlTimestampName(name);
    return { name, named };
  }
  const fallback = text.replace(/\s+@[\w:-]+\b.*/, '').slice(0, 60) || null;
  return { name: fallback, named: false };
}

function extractVisibleControlLabels(lines = [], { namedOnly = false } = {}) {
  const labels = [];
  const seen = new Set();
  for (const line of lines) {
    const parsed = visibleControlNameFromLine(line);
    if (!parsed.name || (namedOnly && !parsed.named)) continue;
    if (seen.has(parsed.name)) continue;
    seen.add(parsed.name);
    labels.push(parsed.name);
  }
  return labels;
}

const VISIBLE_CONTROL_CAP_SWAP_SAMPLE = 4;

function uniqueVisibleControlCapSwapSamples(removedNamed = [], addedNamed = [], limit = VISIBLE_CONTROL_CAP_SWAP_SAMPLE) {
  // Names that appear on both sides (live: a shared commit title on every
  // HF file row) are still membership, but they are leftover sample chrome
  // when they occupy a named slot on both sides and push a unique file
  // name into `... and 1 more` (#307). Prefer unique names. Do not treat
  // `main` as a special case.
  const addedSet = new Set(addedNamed);
  const removedSet = new Set(removedNamed);
  return {
    removedSamples: removedNamed.filter(name => !addedSet.has(name)).slice(0, limit),
    addedSamples: addedNamed.filter(name => !removedSet.has(name)).slice(0, limit),
  };
}

function splitVisibleControlStructural(lines = []) {
  const visible = [];
  const rest = [];
  for (const line of lines) {
    (isVisibleControlStructuralLine(line) ? visible : rest).push(line);
  }
  return { visible, rest };
}

function visibleControlCapSwap(diff) {
  const removed = splitVisibleControlStructural(diff.removedStructural);
  const added = splitVisibleControlStructural(diff.addedStructural);
  const removedLabels = extractVisibleControlLabels(removed.visible);
  const addedLabels = extractVisibleControlLabels(added.visible);
  const removedNamed = extractVisibleControlLabels(removed.visible, { namedOnly: true });
  const addedNamed = extractVisibleControlLabels(added.visible, { namedOnly: true });
  const samples = uniqueVisibleControlCapSwapSamples(removedNamed, addedNamed);
  return {
    isCapSwap: removedLabels.length >= 2 && addedLabels.length >= 2,
    removedRest: removed.rest,
    addedRest: added.rest,
    removedLabels,
    addedLabels,
    removedNamed,
    addedNamed,
    ...samples,
  };
}

function visibleControlCapSwapHeadline(left, entered) {
  return `Visible-control cap swap: ${left} left, ${entered} entered`;
}

function formatVisibleControlCapSwapLines(swap) {
  const lines = [visibleControlCapSwapHeadline(swap.removedLabels.length, swap.addedLabels.length)];
  const removedSamples = swap.removedSamples || [];
  const addedSamples = swap.addedSamples || [];
  for (const label of removedSamples) lines.push(`- ${label}`);
  if (removedSamples.length && swap.removedLabels.length > removedSamples.length) {
    lines.push(`  ... and ${swap.removedLabels.length - removedSamples.length} more left`);
  }
  for (const label of addedSamples) lines.push(`+ ${label}`);
  if (addedSamples.length && swap.addedLabels.length > addedSamples.length) {
    lines.push(`  ... and ${swap.addedLabels.length - addedSamples.length} more entered`);
  }
  return lines;
}

function computePerceiveDiff(previousOutput, currentOutput) {
  const prev = previousOutput.split('\n');
  const curr = currentOutput.split('\n');
  // Skip header lines up to the first blank line. Frame-scoped perceive adds
  // a `Frame:` header, so avoid hard-coding the legacy 5-line header shape.
  const prevHeaderEnd = prev.findIndex(line => line === '');
  const currHeaderEnd = curr.findIndex(line => line === '');
  const prevTreeStart = prevHeaderEnd >= 0 ? prevHeaderEnd + 1 : 5;
  const currTreeStart = currHeaderEnd >= 0 ? currHeaderEnd + 1 : 5;
  const prevTree = prev.slice(prevTreeStart).map(stripPerceiveIdentityChrome);
  const currTree = curr.slice(currTreeStart).map(stripPerceiveIdentityChrome);
  // Line-level diff with StaticText noise filtering.
  const prevSet = new Set(prevTree);
  const currSet = new Set(currTree);
  const removed = prevTree.filter(l => !currSet.has(l));
  const added = currTree.filter(l => !prevSet.has(l));
  const isTextOnly = l => /^\s*\[StaticText\]/.test(l) && !isPriorityPerceiveTextLine(l);
  const isTextSummary = l => /^\s*\.\.\. \d+ earlier text node\(s\) omitted \(--last \d+\)/.test(l);
  const isCompactTextChange = l => isTextOnly(l) || isTextSummary(l);
  const isIdentityChrome = l => isCompactTextChange(l) || isPerceiveDecorativeTitleChrome(l);
  const removedStructural = removed.filter(l => !isIdentityChrome(l));
  const addedStructural = added.filter(l => !isIdentityChrome(l));
  const removedTextLines = removed.filter(isTextOnly);
  const addedTextLines = added.filter(isTextOnly);
  return {
    headerLines: curr.slice(0, currHeaderEnd >= 0 ? currHeaderEnd : 5),
    removedStructural,
    addedStructural,
    removedTextLines,
    addedTextLines,
  };
}

function buildPerceiveDiffRecommendation({ mode, changed, baselineAvailable = true, nextSteps = [] }) {
  const source = 'perceive-diff';
  const reason = !baselineAvailable
    ? 'No previous perceive baseline is available; capture a fresh perception before relying on diffs.'
    : changed
    ? 'The page changed; preserve the diff and action timeline before continuing.'
    : 'No page change was detected; use the report timeline or a fresh perceive before retrying the action.';
  return {
    source,
    mode,
    reason,
    commands: nextSteps,
    verifyCommand: nextSteps[0] || null,
  };
}

function perceiveFocusedFromOutput(output) {
  const lines = String(output || '').split('\n');
  const match = (lines[1] || '').match(/Focused: (.*)$/);
  return match ? match[1].trim() : '';
}

function perceiveTextboxValueFromOutput(output) {
  for (const line of String(output || '').split('\n')) {
    const match = line.match(/\[(?:textbox|searchbox|combobox)\][^=\n]*=\s*"([^"]*)"/i);
    if (match) return match[1];
  }
  return null;
}

function isTypeaheadDiffFocus(focused) {
  if (!focused || focused === 'none') return false;
  const s = String(focused);
  if (/textbox|searchbox|combobox/i.test(s)) return true;
  // Live perceive headers use document.activeElement, e.g. "Focused: <input>",
  // not the AX role. HuggingFace search is often a bare <input> with no id.
  return /^<(input|textarea)\b/i.test(s);
}

function shouldSummarizeTypeaheadDiff(diff, previousOutput, currentOutput, mode) {
  if (mode !== 'since-action') return false;
  const previous = parsePerceiveHeader(previousOutput);
  const current = parsePerceiveHeader(currentOutput);
  if (previous.page.url && current.page.url && previous.page.url !== current.page.url) return false;
  const focused = perceiveFocusedFromOutput(currentOutput);
  if (!isTypeaheadDiffFocus(focused)) return false;
  const suggestionCount = countTypeaheadLabels(diff.addedStructural);
  const hasListbox = [...diff.addedStructural, ...diff.removedStructural]
    .some(line => /\[listbox\]/i.test(line));
  const previousValue = perceiveTextboxValueFromOutput(previousOutput);
  const currentValue = perceiveTextboxValueFromOutput(currentOutput);
  const valueChanged = currentValue != null && previousValue !== currentValue;
  const structuralChurn = diff.removedStructural.length + diff.addedStructural.length;
  if (suggestionCount > 0 && (hasListbox || valueChanged || suggestionCount >= 2)) return true;
  if (valueChanged && hasListbox) return true;
  // perceive -i baseline vs a later snapshot can reroot; still print the one-liner.
  if (valueChanged && structuralChurn >= 40) return true;
  return false;
}

function typeaheadDiffHeadline(suggestionCount) {
  return `textbox value set; ${suggestionCount} suggestion links`;
}

function buildPerceiveDiffModel(previousOutput, currentOutput, { mode = 'diff', targetPrefix = '' } = {}) {
  const diff = computePerceiveDiff(previousOutput, currentOutput);
  const target = targetPrefix || '<target>';
  const removedText = diff.removedTextLines.length;
  const addedText = diff.addedTextLines.length;
  const changed = diff.removedStructural.length > 0 || diff.addedStructural.length > 0 || removedText > 0 || addedText > 0;
  const nextSteps = mode === 'since-action'
    ? [
        `cdp report ${target} --format json`,
        `cdp record-actions ${target} --format json`,
      ]
    : [
        `cdp report ${target} --format json`,
      ];
  const model = {
    schema: 'chrome-cdp-ex.perceive-diff.v1',
    mode,
    ...parsePerceiveHeader(currentOutput),
    summary: {
      changed,
      removed: diff.removedStructural.length,
      added: diff.addedStructural.length,
      textRemoved: removedText,
      textAdded: addedText,
    },
    removed: diff.removedStructural.slice(0, 20),
    added: diff.addedStructural.slice(0, 20),
    removedOmitted: Math.max(0, diff.removedStructural.length - 20),
    addedOmitted: Math.max(0, diff.addedStructural.length - 20),
    textRemovedSamples: diff.removedTextLines.slice(-3),
    textAddedSamples: diff.addedTextLines.slice(-3),
    recommendation: buildPerceiveDiffRecommendation({ mode, changed, nextSteps }),
    nextSteps,
  };
  if (shouldSummarizeTypeaheadDiff(diff, previousOutput, currentOutput, mode)) {
    const suggestionCount = countTypeaheadLabels(diff.addedStructural);
    const labels = extractTypeaheadLabels(diff.addedStructural);
    model.summary.kind = 'typeahead';
    model.summary.headline = typeaheadDiffHeadline(suggestionCount);
    model.added = labels;
    model.removed = [];
    model.removedOmitted = diff.removedStructural.length;
    model.addedOmitted = Math.max(0, suggestionCount - labels.length);
  } else {
    const swap = visibleControlCapSwap(diff);
    if (swap.isCapSwap) {
      model.summary.kind = 'visible-control-cap-swap';
      model.summary.headline = visibleControlCapSwapHeadline(
        swap.removedLabels.length,
        swap.addedLabels.length,
      );
      if (swap.removedRest.length === 0 && swap.addedRest.length === 0) {
        const removedSamples = swap.removedSamples || [];
        const addedSamples = swap.addedSamples || [];
        model.removed = removedSamples;
        model.added = addedSamples;
        model.removedOmitted = Math.max(0, swap.removedLabels.length - removedSamples.length);
        model.addedOmitted = Math.max(0, swap.addedLabels.length - addedSamples.length);
      } else {
        model.removed = swap.removedRest.slice(0, 20);
        model.added = swap.addedRest.slice(0, 20);
        model.removedOmitted = Math.max(0, swap.removedRest.length - 20);
        model.addedOmitted = Math.max(0, swap.addedRest.length - 20);
      }
    }
  }
  return model;
}

function formatPerceiveDiffOutput(previousOutput, currentOutput, { mode = 'diff' } = {}) {
  const diff = computePerceiveDiff(previousOutput, currentOutput);
  if (shouldSummarizeTypeaheadDiff(diff, previousOutput, currentOutput, mode)) {
    const suggestionCount = countTypeaheadLabels(diff.addedStructural);
    const labels = extractTypeaheadLabels(diff.addedStructural);
    const lines = [typeaheadDiffHeadline(suggestionCount), ...labels.map(label => `+ ${label}`)];
    if (suggestionCount > labels.length) {
      lines.push(`  ... and ${suggestionCount - labels.length} more`);
    }
    return diff.headerLines.join('\n') + '\n\n' + lines.join('\n');
  }
  const swap = visibleControlCapSwap(diff);
  const removedStructural = swap.isCapSwap ? swap.removedRest : diff.removedStructural;
  const addedStructural = swap.isCapSwap ? swap.addedRest : diff.addedStructural;
  const diffLines = [];
  const removedText = diff.removedTextLines.length;
  const addedText = diff.addedTextLines.length;
  if (
    removedStructural.length === 0
    && addedStructural.length === 0
    && removedText === 0
    && addedText === 0
    && !swap.isCapSwap
  ) {
    diffLines.push('(no changes detected in AX tree)');
  } else {
    if (removedStructural.length > 0) {
      diffLines.push(`--- Removed (${removedStructural.length}):`);
      for (const l of removedStructural.slice(0, 20)) diffLines.push(`- ${l}`);
      if (removedStructural.length > 20) diffLines.push(`  ... and ${removedStructural.length - 20} more`);
    }
    if (addedStructural.length > 0) {
      diffLines.push(`+++ Added (${addedStructural.length}):`);
      for (const l of addedStructural.slice(0, 20)) diffLines.push(`+ ${l}`);
      if (addedStructural.length > 20) diffLines.push(`  ... and ${addedStructural.length - 20} more`);
    }
    if (removedText > 0 || addedText > 0) {
      const parts = [];
      if (removedText > 0) parts.push(`${removedText} removed`);
      if (addedText > 0) parts.push(`${addedText} added`);
      diffLines.push(`~~~ Text nodes updated (${parts.join(', ')})`);
      if (addedText > 0 && removedStructural.length === 0 && addedStructural.length === 0 && !swap.isCapSwap) {
        const samples = diff.addedTextLines.slice(-3);
        for (const l of samples) diffLines.push(`+ ${l}`);
        if (addedText > samples.length) diffLines.push(`  ... and ${addedText - samples.length} more text additions`);
      }
    }
    if (swap.isCapSwap) {
      diffLines.push(...formatVisibleControlCapSwapLines(swap));
    }
  }
  return diff.headerLines.join('\n') + '\n\n' + diffLines.join('\n');
}

// Format a single @ref bounding-rect annotation. Adds `position` only for
// fixed/sticky elements so agents do not misread visible fixed UI as off-screen.
function formatRefRect(rect) {
  if (!rect) return '';
  const base = `(${rect.x},${rect.y} ${rect.w}×${rect.h}`;
  if (rect.position === 'fixed' || rect.position === 'sticky') {
    return `${base}, ${rect.position})`;
  }
  return `${base})`;
}

// Pure tree-building logic extracted from perceiveStr for testability.
// Takes raw AX nodes + page metadata, returns enriched tree lines and ref node IDs.
function buildPerceiveTree(nodes, meta, refMap, opts = {}) {
  const { maxDepth = Infinity, interactiveOnly = false, keepRefs = false, last = null } = opts;
  // opts.adaptive + opts.consoleErrors are used by the --last auto / --adaptive budget path
  // opts.cursorInteractive is accepted so -C ranking shares this path with last/adaptive.

  const nodesById = new Map(nodes.map(n => [n.nodeId, n]));
  const childrenByParent = new Map();
  for (const n of nodes) {
    if (!n.parentId) continue;
    if (!childrenByParent.has(n.parentId)) childrenByParent.set(n.parentId, []);
    childrenByParent.get(n.parentId).push(n);
  }

  // Layout consumption cursors (each role's entries are consumed in document order)
  const layoutCursors = {};
  for (const [role, entries] of Object.entries(meta.layoutMap || {})) {
    layoutCursors[role] = { entries, idx: 0 };
  }
  function consumeLayout(role) {
    const cursor = layoutCursors[role];
    if (!cursor || cursor.idx >= cursor.entries.length) return null;
    return cursor.entries[cursor.idx++];
  }

  // Track table rows to cap output
  const TABLE_ROW_LIMIT = 5;
  const tableRowCounts = new Map();
  const tableIdxMap = new Map();
  let nextTableIdx = 0;
  const rowCellIdx = new Map();
  const dataRowIdx = new Map();

  // Clear and rebuild ref map
  refMap.clear();
  let refCounter = 0;
  const refNodeIds = [];
  const pendingContentRefs = [];
  const pendingRestRefs = [];
  const pendingSkipRefs = [];
  const pendingChromeRefs = [];

  function refKind(node, skipLink, inChrome) {
    if (skipLink) return 'skip';
    if (inChrome) return 'chrome';
    const role = node.role?.value || '';
    if (CONTENT_REF_ROLES.has(role)) return 'content';
    return 'rest';
  }

  function queueRef(node, lineIndex, kind) {
    if (!node?.backendDOMNodeId) return;
    const entry = { lineIndex, backendDOMNodeId: node.backendDOMNodeId };
    if (kind === 'skip') pendingSkipRefs.push(entry);
    else if (kind === 'chrome') pendingChromeRefs.push(entry);
    else if (kind === 'content') pendingContentRefs.push(entry);
    else pendingRestRefs.push(entry);
  }

  const treeLines = [];
  const contentBodyLines = new Set();
  const visited = new Set();
  let chromeLinesEmitted = 0;
  let chromeTruncationNoted = false;

  function markSubtreeVisited(nodeId) {
    visited.add(nodeId);
    for (const child of (childrenByParent.get(nodeId) || [])) {
      markSubtreeVisited(child.nodeId);
    }
  }

  function assignInteractiveRef(node) {
    if (!node.backendDOMNodeId) return null;
    refCounter++;
    refMap.set(refCounter, node.backendDOMNodeId);
    refNodeIds.push({ ref: refCounter, backendDOMNodeId: node.backendDOMNodeId });
    return refCounter;
  }

  function childRegion(ctx, counts) {
    return {
      inContent: ctx.inContent,
      inChrome: ctx.inChrome,
      chromeDepth: ctx.inChrome && counts ? ctx.chromeDepth + 1 : ctx.chromeDepth,
      contentDepth: ctx.inContent && counts ? ctx.contentDepth + 1 : ctx.contentDepth,
    };
  }

  function visit(node, depth, parentNode = null, tableAncestorId = null, ctx = {
    inContent: false, inChrome: false, chromeDepth: 0, contentDepth: 0,
  }) {
    if (!node || visited.has(node.nodeId)) return;
    visited.add(node.nodeId);

    const role = node.role?.value || '';
    const name = node.name?.value ?? '';
    const skipLink = isSkipLinkAxNode(node);
    const enteringContent = PERCEIVE_CONTENT_LANDMARK_ROLES.has(role) && depth <= maxDepth;
    const inContent = ctx.inContent || enteringContent;
    const enteringChrome = !inContent && PERCEIVE_CHROME_LANDMARK_ROLES.has(role);
    const inChrome = !inContent && (ctx.inChrome || enteringChrome);
    const chromeDepth = enteringChrome ? 0 : ctx.chromeDepth;
    const contentDepth = enteringContent ? 0 : ctx.contentDepth;
    const region = { inContent, inChrome, chromeDepth, contentDepth };
    const counts = countsTowardPerceiveDepth(node);
    const childDepth = counts ? depth + 1 : depth;

    const overChrome = inChrome && chromeDepth > PERCEIVE_CHROME_MAX_RELATIVE_DEPTH;
    const overContent = inContent && contentDepth > maxDepth;
    const overGlobal = !inContent && depth > maxDepth;
    if (overChrome || overContent || overGlobal) {
      if ((INTERACTIVE_ROLES.has(role) || CONTENT_REF_ROLES.has(role)) && node.backendDOMNodeId) {
        queueRef(node, -1, refKind(node, skipLink, inChrome));
      }
      for (const child of orderedAxChildren(node, nodesById, childrenByParent)) {
        visit(child, childDepth, node, tableAncestorId, childRegion(region, counts));
      }
      return;
    }

    // Detect table context: track row counts per table ancestor
    if (role === 'table' || role === 'grid' || role === 'treegrid') {
      tableAncestorId = node.nodeId;
      tableRowCounts.set(tableAncestorId, 0);
      dataRowIdx.set(tableAncestorId, -1);
      if (!tableIdxMap.has(tableAncestorId)) {
        tableIdxMap.set(tableAncestorId, nextTableIdx++);
      }
    }
    if (tableAncestorId && role === 'row') {
      const count = tableRowCounts.get(tableAncestorId) || 0;
      tableRowCounts.set(tableAncestorId, count + 1);
      rowCellIdx.set(tableAncestorId, 0);
      if (count >= TABLE_ROW_LIMIT) {
        if (count === TABLE_ROW_LIMIT) {
          treeLines.push(formatAxNode({ role: { value: 'note' }, name: { value: '... more rows truncated' } }, depth));
        }
        markSubtreeVisited(node.nodeId);
        return;
      }
    }

    // Filter decorative icon images (short lowercase names like "thunderbolt", "check-circle")
    if (role === 'image') {
      if (name.length < 25 && name === name.toLowerCase() && !name.includes(' ')) {
        markSubtreeVisited(node.nodeId);
        return;
      }
    }

    // Track cell index unconditionally (even for filtered nodes) to stay aligned with browser-side
    const isCellRole = tableAncestorId && (role === 'cell' || role === 'gridcell' || role === 'columnheader' || role === 'rowheader');
    let cellColIdx = -1;
    if (isCellRole) {
      cellColIdx = rowCellIdx.get(tableAncestorId) || 0;
      rowCellIdx.set(tableAncestorId, cellColIdx + 1);
      if ((role === 'cell' || role === 'gridcell') && cellColIdx === 0) {
        dataRowIdx.set(tableAncestorId, (dataRowIdx.get(tableAncestorId) ?? -1) + 1);
      }
    }

    const isInteractive = INTERACTIVE_ROLES.has(role);

    // --interactive mode: only show interactive elements and their immediate structural parents
    if (interactiveOnly && !isInteractive && !ENRICHED_ROLES.has(role)) {
      for (const child of orderedAxChildren(node, nodesById, childrenByParent)) {
        visit(child, depth, node, tableAncestorId, region);
      }
      return;
    }

    if (shouldShowAxNode(node, true, parentNode)) {
      const chromeCapped = inChrome && chromeLinesEmitted >= PERCEIVE_CHROME_LINE_CAP;
      if (chromeCapped) {
        if (!chromeTruncationNoted) {
          treeLines.push(formatAxNode({ role: { value: 'note' }, name: { value: '... chrome truncated' } }, depth));
          chromeTruncationNoted = true;
        }
      } else {
        let line = formatAxNode(node, depth);

        // Assign @ref after the walk: content landmarks first, then other
        // controls, then chrome, then skip-links so 跳至 / Skip to never take @1.
        if ((isInteractive || CONTENT_REF_ROLES.has(role)) && node.backendDOMNodeId) {
          queueRef(node, treeLines.length, refKind(node, skipLink, inChrome));
        }

        // Enrich landmark/structural nodes with layout annotations
        if (ENRICHED_ROLES.has(role)) {
          const layout = consumeLayout(role);
          if (layout) {
            const parts = [];
            if (layout.w) parts.push(`${layout.w}×${layout.h}px`);
            else if (layout.h >= 40) parts.push(`↕${layout.h}px`);
            if (layout.bg) parts.push(`bg:${layout.bg}`);
            if (layout.font) parts.push(layout.font);
            if (layout.color) parts.push(`color:${layout.color}`);
            if (layout.display) {
              let d = layout.display;
              if (layout.gap) d += ` gap:${layout.gap}`;
              parts.push(d);
            }
            if (layout.opacity) parts.push(`opacity:${layout.opacity}`);
            if (layout.vis === 'above') parts.push('↑above fold');
            else if (layout.vis === 'below') parts.push('↓below fold');
            if (parts.length > 0) line += '  ' + parts.join('  ');
          }
        }

        // Enrich table cells with style hints (positional key: tableIdx:rowIdx:colIdx)
        if (isCellRole && meta.styleHints) {
          const ti = tableIdxMap.get(tableAncestorId);
          const ri = dataRowIdx.get(tableAncestorId) ?? -1;
          if (ti != null && ri >= 0) {
            const hint = meta.styleHints[ti + ':' + ri + ':' + cellColIdx];
            if (hint) line += '  ' + hint;
          }
        }
        treeLines.push(line);
        if (inChrome) chromeLinesEmitted++;
        if (inContent && isPerceiveBodyTextRole(role)) contentBodyLines.add(line);
      }
    }
    for (const child of orderedAxChildren(node, nodesById, childrenByParent)) {
      visit(child, childDepth, node, tableAncestorId, childRegion(region, counts));
    }
  }

  const roots = nodes.filter(n => !n.parentId || !nodesById.has(n.parentId));
  for (const root of roots) visit(root, 0);
  for (const node of nodes) visit(node, 0);

  for (const pending of [...pendingContentRefs, ...pendingRestRefs, ...pendingChromeRefs, ...pendingSkipRefs]) {
    const ref = assignInteractiveRef({ backendDOMNodeId: pending.backendDOMNodeId });
    if (ref != null && pending.lineIndex >= 0 && treeLines[pending.lineIndex] != null) {
      treeLines[pending.lineIndex] += `  @${ref}`;
    }
  }

  // --last N: keep only the last N StaticText / paragraph rows. Ref-bearing
  // lines (anything containing `@<digit>` or `@c<digit>`) and structural lines
  // (landmarks, headings, dialogs, etc.) are always kept.
  // --keep-refs: when truncating, ensure every line carrying an @ref survives.
  // --adaptive / --last auto: choose N from density + error/priority signals.
  // Content-landmark text is treated as priority so -C chrome cannot outrank the article.
  let outLines = treeLines;
  let effectiveLast = last;
  if (last === 'auto' || (opts.adaptive && (last == null || last === 'auto'))) {
    const interactiveCount = outLines.filter(ln => /@(c?\d+)/.test(ln)).length;
    const hasPriorityText = outLines.some(ln => isPriorityPerceiveTextLine(ln) || contentBodyLines.has(ln));
    effectiveLast = chooseAdaptivePerceiveLast({
      lineCount: outLines.length,
      consoleErrors: Number(opts.consoleErrors || 0),
      interactiveCount,
      hasPriorityText,
    });
  }
  if (effectiveLast && Number.isFinite(effectiveLast) && effectiveLast > 0) {
    const refLineRe = /@(c?\d+)/;
    const textRoleRe = /\[(StaticText|paragraph|listitem|note|description|comment|term|definition)\]/;
    // Walk backwards collecting the last N text lines while keeping all ref/structural lines
    const reversed = [];
    let textKept = 0;
    let priorityKept = 0;
    const priorityBudget = Math.max(effectiveLast, 12);
    let textOmitted = 0;
    for (let i = outLines.length - 1; i >= 0; i--) {
      const ln = outLines[i];
      const isRef = refLineRe.test(ln);
      const isText = textRoleRe.test(ln) && !isRef;
      if (isText) {
        if ((contentBodyLines.has(ln) || isPriorityPerceiveTextLine(ln)) && priorityKept < priorityBudget) {
          reversed.push(ln);
          priorityKept++;
        } else if (textKept < effectiveLast) { reversed.push(ln); textKept++; }
        else { textOmitted++; }
      } else {
        reversed.push(ln);
      }
    }
    outLines = reversed.reverse();
    if (textOmitted > 0) {
      const label = (last === 'auto' || opts.adaptive) ? `--adaptive last ${effectiveLast}` : `--last ${effectiveLast}`;
      outLines.push(`  ... ${textOmitted} earlier text node(s) omitted (${label})`);
    }
  } else if (keepRefs) {
    // No size budget enforced here; the caller chooses when to truncate, but
    // when --keep-refs is set we mark lines so downstream truncation can
    // protect them. We currently return the lines as-is (the truncation that
    // hid refs was happening elsewhere; --keep-refs is now a soft flag agents
    // can use to assert "do not drop my @ref lines"). The flag is honoured
    // upstream by perceiveStr which avoids cutting ref lines.
  }

  const hasContentBody = outLines.some(ln => contentBodyLines.has(ln));
  const emittedChromeOrSkip = outLines.some(ln =>
    /\[(navigation|banner|complementary)\]/.test(ln)
    || /\[(link|button)\].*(Skip\s+to|跳至)/i.test(ln)
  );
  if (!hasContentBody && Number.isFinite(maxDepth) && emittedChromeOrSkip) {
    const target = opts.targetPrefix || '<target>';
    outLines.push(`Body truncated. Next: cdp text ${target} --auto`);
  }

  return { treeLines: outLines, refNodeIds };
}

// Browser-side script for perceiveStr — extracted for readability and testability.
// Collects page metadata, layout map, style hints, and cursor-interactive elements.
function perceivePageScript(cursorInteractive) {
  return `(function() {
${visibleControlsCollectorSource()}
      const pickPrimaryScrollMetrics = ${pickPrimaryScrollMetrics.toString()};
      const vw = window.innerWidth, vh = window.innerHeight;
      const scrollingEl = document.scrollingElement || document.documentElement;
      const scrollCandidates = [];
      function pushScrollCandidate(el, source) {
        if (!el) return;
        const isDocument = el === scrollingEl || el === document.documentElement;
        scrollCandidates.push({
          scrollTop: isDocument ? (el.scrollTop || window.scrollY || 0) : (el.scrollTop || 0),
          scrollHeight: el.scrollHeight || 0,
          clientHeight: isDocument ? (el.clientHeight || window.innerHeight || 0) : (el.clientHeight || 0),
          source: source
        });
      }
      pushScrollCandidate(scrollingEl, 'document');
      if (document.body && document.body !== scrollingEl) pushScrollCandidate(document.body, 'body');
      const seenScrollers = new Set();
      const walk = [document.documentElement, document.body].filter(Boolean);
      let inspected = 0;
      while (walk.length && inspected < 400) {
        const el = walk.pop();
        if (!el || seenScrollers.has(el)) continue;
        seenScrollers.add(el);
        inspected++;
        let overflowY = '';
        try { overflowY = window.getComputedStyle(el).overflowY || ''; } catch {}
        if (el !== scrollingEl && /(auto|scroll|overlay)/.test(overflowY)) {
          pushScrollCandidate(el, 'inner');
        }
        const children = el.children;
        if (children) {
          for (let i = 0; i < children.length; i++) walk.push(children[i]);
        }
      }
      const scrollMetrics = pickPrimaryScrollMetrics(scrollCandidates);
      const scrollY = scrollMetrics.scrollY;
      const scrollMax = scrollMetrics.scrollMax;

      // Interactive element counts
      const counts = {};
      for (const el of document.querySelectorAll('a, button, input, select, textarea, [role="button"], [tabindex]')) {
        const tag = el.tagName.toLowerCase();
        const type = tag === 'input' ? 'input[' + (el.type || 'text') + ']' : tag;
        counts[type] = (counts[type] || 0) + 1;
      }

      // Build layout map keyed by ARIA role (matching AX tree roles)
      const TAG_ROLE = {
        header:'banner', nav:'navigation', main:'main', footer:'contentinfo',
        aside:'complementary', form:'form', table:'table', dialog:'dialog',
        article:'article', section:'region', img:'img', video:'video',
        h1:'heading', h2:'heading', h3:'heading', h4:'heading', h5:'heading', h6:'heading'
      };
      const selectors = 'header,nav,main,footer,aside,section,article,form,h1,h2,h3,h4,h5,h6,img,video,table,dialog,[role="banner"],[role="navigation"],[role="main"],[role="contentinfo"],[role="dialog"],[role="alert"],[role="region"],[role="complementary"]';
      const layoutMap = {};
      let count = 0;
      for (const el of document.querySelectorAll(selectors)) {
        const rect = el.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) continue;
        const cs = window.getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;

        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute('role') || TAG_ROLE[tag] || tag;
        const info = { h: Math.round(rect.height) };

        // Only include width if element is significantly narrower than viewport
        const w = Math.round(rect.width);
        if (w < vw * 0.9) info.w = w;

        // Key visual properties (only non-defaults)
        const bg = cs.backgroundColor;
        if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') info.bg = bg;
        if (tag.match(/^h[1-6]$/)) {
          info.font = cs.fontSize + ' ' + cs.fontWeight;
          if (cs.color && cs.color !== 'rgb(0, 0, 0)') info.color = cs.color;
        }
        if (cs.display === 'flex' || cs.display === 'grid') {
          info.display = cs.display;
          if (cs.gap && cs.gap !== 'normal' && cs.gap !== '0px') info.gap = cs.gap;
        }
        if (cs.opacity !== '1') info.opacity = cs.opacity;

        // Viewport visibility
        const top = rect.top, bot = rect.bottom;
        if (bot < 0) info.vis = 'above';
        else if (top > vh) info.vis = 'below';
        // else: in viewport (default, no annotation needed)

        if (!layoutMap[role]) layoutMap[role] = [];
        layoutMap[role].push(info);
        if (++count >= 150) break;
      }

      // === Style hints: detect visual anomalies on table cells ===
      const styleHints = {};
      let styleHintCount = 0;
      const CELL_SEL = 'td, th, [role="cell"], [role="gridcell"], [role="columnheader"], [role="rowheader"]';
      const BASELINE_ROW_CAP = 20; // enough rows for reliable baseline, avoids scanning huge tables
      function majority(counts) {
        let best = null, bestN = 0;
        for (const [v, n] of Object.entries(counts)) { if (n > bestN) { best = v; bestN = n; } }
        return best;
      }
      const allTables = document.querySelectorAll('table, [role="grid"], [role="treegrid"]');
      // Filter out presentation/hidden tables to match AX tree traversal order
      const visTables = [];
      for (const t of allTables) {
        const r = t.getAttribute('role');
        if (r === 'presentation' || r === 'none') continue;
        if (t.getAttribute('aria-hidden') === 'true') continue;
        const cs = window.getComputedStyle(t);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        visTables.push(t);
      }
      for (let ti = 0; ti < visTables.length && styleHintCount < 100; ti++) {
        const tbl = visTables[ti];
        const rows = tbl.querySelectorAll('tr, [role="row"]');
        const dataRows = [];
        for (const row of rows) {
          const firstCell = row.querySelector('td, [role="cell"], [role="gridcell"]');
          if (firstCell) dataRows.push(row);
        }
        if (dataRows.length === 0) continue;
        const smallTable = dataRows.length < 4;
        const scanRows = dataRows.slice(0, BASELINE_ROW_CAP);

        // Single pass: collect styles, build baselines, cache per-cell data
        const colBgs = {}, colWeights = {}, colColors = {};
        const cellCache = []; // [{cells: [{bg, fw, clr, ci}]}] per row
        for (const row of scanRows) {
          const cells = row.querySelectorAll(CELL_SEL);
          const rowData = [];
          let ci = 0;
          for (const cell of cells) {
            if (cell.colSpan > 1) { ci += cell.colSpan; continue; }
            const cs = window.getComputedStyle(cell);
            const bg = cs.backgroundColor;
            const fw = parseInt(cs.fontWeight) || 400;
            const clr = cs.color;
            if (!colBgs[ci]) { colBgs[ci] = {}; colWeights[ci] = {}; colColors[ci] = {}; }
            colBgs[ci][bg] = (colBgs[ci][bg] || 0) + 1;
            colWeights[ci][fw] = (colWeights[ci][fw] || 0) + 1;
            colColors[ci][clr] = (colColors[ci][clr] || 0) + 1;
            rowData.push({ bg, fw, clr, ci });
            ci++;
          }
          cellCache.push(rowData);
        }

        // Compute baselines from collected data
        const baseBg = {}, baseWeight = {}, baseColor = {};
        for (const ci of Object.keys(colBgs)) {
          baseBg[ci] = majority(colBgs[ci]);
          baseWeight[ci] = parseInt(majority(colWeights[ci])) || 400;
          baseColor[ci] = majority(colColors[ci]);
        }

        // Emit hints from cached styles (no second getComputedStyle pass)
        for (let ri = 0; ri < cellCache.length; ri++) {
          for (const { bg, fw, clr, ci } of cellCache[ri]) {
            const hints = [];
            if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
              if (smallTable || bg !== baseBg[ci]) hints.push('bg:' + bg);
            }
            if (fw > 400 && (smallTable || fw !== baseWeight[ci])) hints.push('bold');
            if (clr && clr !== 'rgb(0, 0, 0)') {
              if (smallTable || clr !== baseColor[ci]) hints.push('color:' + clr);
            }
            if (hints.length > 0) {
              styleHints[ti + ':' + ri + ':' + ci] = hints.join(' ');
              if (++styleHintCount >= 100) break;
            }
          }
          if (styleHintCount >= 100) break;
        }
      }

      // Focused element
      const focused = document.activeElement;
      const focusDesc = focused && focused !== document.body
        ? '<' + focused.tagName.toLowerCase() + (focused.id ? '#' + focused.id : '') + '>'
        : 'none';

      // Cursor-interactive scan: find non-ARIA clickable elements (cursor:pointer, onclick, tabindex)
      const cursorInteractives = [];
      let visibleControls = [];
      let visibleControlsTruncated = false;
      if (${cursorInteractive}) {
        const visibleControlsModel = chromeCdpVisibleControls({ limit: 30 });
        visibleControls = visibleControlsModel.controls || [];
        visibleControlsTruncated = Boolean(visibleControlsModel.truncated);

        const ARIA_INTERACTIVE = new Set(['A','BUTTON','INPUT','SELECT','TEXTAREA']);
        const seen = new Set();
        const candidates = document.querySelectorAll('div, span, li, td, tr, label, img, svg, i, p, section, article, [onclick], [tabindex]:not(a):not(button):not(input):not(select):not(textarea)');
        for (const el of candidates) {
          if (ARIA_INTERACTIVE.has(el.tagName)) continue;
          if (el.getAttribute('role')) continue;
          if (el.closest('a, button, input, select, textarea, [role]')) continue;
          const cs = window.getComputedStyle(el);
          const clickable = cs.cursor === 'pointer' || el.hasAttribute('onclick') || (el.hasAttribute('tabindex') && el.tabIndex >= 0);
          if (!clickable) continue;
          if (cs.display === 'none' || cs.visibility === 'hidden') continue;
          const rect = el.getBoundingClientRect();
          if (rect.width < 5 || rect.height < 5) continue;
          // Overflow scrollports can report on-screen rects that are clipped from hit-testing.
          {
            let clipped = false;
            for (let parent = el.parentElement; parent && parent !== document.documentElement && parent !== document.body; parent = parent.parentElement) {
              const style = window.getComputedStyle(parent);
              const overflow = (style.overflowX || '') + ' ' + (style.overflowY || '');
              const clips = /(auto|scroll|hidden|clip)/.test(overflow);
              const scrollable = parent.scrollWidth > parent.clientWidth + 1 || parent.scrollHeight > parent.clientHeight + 1;
              if (!(clips && scrollable)) continue;
              const pr = parent.getBoundingClientRect();
              const top = Math.max(rect.top, pr.top);
              const left = Math.max(rect.left, pr.left);
              const bottom = Math.min(rect.bottom, pr.bottom);
              const right = Math.min(rect.right, pr.right);
              if ((bottom - top) < 2 || (right - left) < 2) { clipped = true; break; }
            }
            if (clipped) continue;
          }
          // Build a CSS selector path for this element
          let sel = el.tagName.toLowerCase();
          if (el.id) sel += '#' + CSS.escape(el.id);
          else if (el.className && typeof el.className === 'string') {
            const cls = el.className.trim().split(/\\s+/).slice(0, 2).map(c => '.' + CSS.escape(c)).join('');
            sel += cls;
          }
          const key = sel + '|' + Math.round(rect.x) + ',' + Math.round(rect.y);
          if (seen.has(key)) continue;
          seen.add(key);
          const text = el.textContent.trim().substring(0, 60);
          cursorInteractives.push({ sel, text, x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) });
          if (cursorInteractives.length >= 50) break;
        }
      }

      const cardWindows = [];
      const cardEls = document.querySelectorAll('article, [role="article"], [role="listitem"]');
      for (const el of cardEls) {
        const rect = el.getBoundingClientRect();
        if (rect.width < 8 || rect.height < 8) continue;
        let vis = 'in';
        if (rect.bottom < 0) vis = 'above';
        else if (rect.top > vh) vis = 'below';
        const handleMatch = (el.textContent || '').match(/@[A-Za-z0-9_]{1,30}/);
        cardWindows.push({
          vis,
          text: (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 180),
          handle: handleMatch ? handleMatch[0] : '',
        });
        if (cardWindows.length >= 40) break;
      }

      return JSON.stringify({
        title: document.title, url: window.location.href,
        contentType: document.contentType || '',
        vw, vh, scrollY, scrollMax,
        counts, focused: focusDesc, layoutMap, styleHints, cursorInteractives,
        visibleControls, visibleControlsTruncated, cardWindows
      });
    })()`;
}

async function perceiveStr(cdp, sid, consoleBuf, exceptionBuf, refMap, lastPerceiveStore, opts = {}, refState = null) {
  const {
    diff: diffMode = false, selector: scopeSelector = null, exclude: excludeSelector = null,
    interactive: interactiveOnly = false, maxDepth = Infinity, cursorInteractive = false,
    keepRefs = false, keepTypeahead = false, last = null, adaptive = false, sinceAction = false, diffBaseline = null,
    frameRef = null, cards = false,
  } = opts;
  const frameContext = frameRef ? await resolveFrameRef(cdp, sid, frameRef) : null;
  const frame = frameContext?.frame || null;
  const frameExecutionContextId = frame ? await createFrameExecutionContext(cdp, sid, frame.id) : null;
  if (frame && (scopeSelector || excludeSelector)) {
    throw new Error('perceive --frame does not yet support --selector/--exclude; run frame-scoped perceive first, then use the listed @fN:M refs.');
  }

  const pdfProbeContext = frameExecutionContextId != null
    ? { contextId: frameExecutionContextId }
    : { timeoutMs: STATUS_PAGE_INFO_TIMEOUT };
  // --cards and -s previously skipped the PDF gate and treated the empty
  // embedder as a normal HTML/cards page. Probe before AX / scoped DOM queries.
  if (cards || scopeSelector) {
    try {
      const probe = JSON.parse(await evalStr(
        cdp,
        sid,
        'JSON.stringify({ title: document.title, url: window.location.href, contentType: document.contentType || "" })',
        false,
        pdfProbeContext,
      ));
      if (isPdfViewerContentType(probe.contentType)) {
        const output = formatPdfViewerOutput(probe, { targetPrefix: opts.targetPrefix });
        return pdfViewerPerceiveResult(lastPerceiveStore, opts, output);
      }
    } catch (error) {
      if (error?.code === 'pdf_viewer') throw error;
    }
  }

  // Get AX tree nodes and page metadata + layout map in parallel
  // Hoist DOM.getDocument so scope and exclude can share it
  const needsDocument = !frame && (scopeSelector || excludeSelector);
  const docRootPromise = needsDocument ? cdpDomains(cdp).DOM.getDocument( {}, sid) : null;
  let scopeBackendNodeIds = null;
  const axPromise = frame
    ? cdpDomains(cdp).Accessibility.getFullAXTree( { frameId: frame.id }, sid)
    : scopeSelector
    ? (async () => {
        const { root } = await docRootPromise;
        const { nodeId } = await cdpDomains(cdp).DOM.querySelector( { nodeId: root.nodeId, selector: scopeSelector }, sid);
        if (!nodeId) throw new Error(`Scope selector not found: ${scopeSelector}`);
        const { node } = await cdpDomains(cdp).DOM.describeNode( { nodeId, depth: -1, pierce: true }, sid);
        scopeBackendNodeIds = collectDomBackendNodeIds(node);
        return cdpDomains(cdp).Accessibility.getFullAXTree( {}, sid);
      })()
    : cdpDomains(cdp).Accessibility.getFullAXTree( {}, sid);
  const [axResult, metaJson] = await Promise.all([
    axPromise,
    evalStr(cdp, sid, perceivePageScript(cursorInteractive), false, frameExecutionContextId != null ? { contextId: frameExecutionContextId } : {})
  ]);

  const meta = JSON.parse(metaJson);

  if (isPdfViewerContentType(meta.contentType)) {
    const output = formatPdfViewerOutput(meta, { targetPrefix: opts.targetPrefix });
    return pdfViewerPerceiveResult(lastPerceiveStore, opts, output);
  }

  // Console health
  const allConsole = consoleBuf.all();
  let errors = 0, warnings = 0;
  for (const e of allConsole) {
    if (e.level === 'error') errors++;
    else if (e.level === 'warning' || e.level === 'warn') warnings++;
  }
  const exceptions = exceptionBuf.all().length;

  // Exclude filtering: remove AX subtrees rooted at excluded DOM nodes
  let axNodes = axResult.nodes;
  if (scopeBackendNodeIds) {
    axNodes = filterAxNodesToBackendSubtree(axNodes, scopeBackendNodeIds);
  }
  if (excludeSelector) {
    const { root } = await docRootPromise;
    const excludedBackendNodeIds = new Set();
    const describedNodesByBackendId = new Map();
    const exNodes = await cdpDomains(cdp).DOM.querySelectorAll( { nodeId: root.nodeId, selector: excludeSelector }, sid);
    if (exNodes.nodeIds) {
      const results = await Promise.allSettled(
        exNodes.nodeIds.map(nid => cdpDomains(cdp).DOM.describeNode( { nodeId: nid, depth: -1, pierce: true }, sid))
      );
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value.node?.backendNodeId) {
          excludedBackendNodeIds.add(r.value.node.backendNodeId);
          describedNodesByBackendId.set(r.value.node.backendNodeId, r.value.node);
        }
      }
    }
    axNodes = filterPerceiveExcludedAxNodes(axNodes, excludedBackendNodeIds, describedNodesByBackendId);
  }

  const typeaheadFilter = omitTypeaheadListboxNodes(axNodes, {
    keepTypeahead,
    selector: scopeSelector,
    focusedDesc: meta.focused,
  });
  axNodes = typeaheadFilter.nodes;

  if (frame) {
    const listed = await listDomInteractiveControls(cdp, sid, {
      contextId: frameExecutionContextId,
    });
    if (shouldSynthesizeMissingFrameInteractives(frame, axNodes, listed)) {
      const extras = await collectDomInteractiveControls(cdp, sid, {
        contextId: frameExecutionContextId,
        listed,
      });
      if (extras.length) axNodes = mergeMissingDomInteractiveAxNodes(axNodes, extras);
    }
  }

  const activeRefMap = frame ? new Map() : refMap;
  if (cards) {
    const model = buildCardsModel(axNodes, meta, activeRefMap, {
      last,
      targetPrefix: opts.targetPrefix,
      previousCards: lastPerceiveStore.cards?.cards,
      previousScrollY: lastPerceiveStore.cards?.scrollY,
    });
    if (frame) {
      storeFrameScopedRefs(refState, frame, frameContext.frames, activeRefMap);
      for (const card of model.cards || []) {
        if (typeof card.ref === 'string' && /^@\d+$/.test(card.ref)) {
          card.ref = `${frame.ref}:${card.ref.slice(1)}`;
        }
      }
    }
    const output = opts.format === 'json' ? formatCardsJson(model) : formatCardsText(model);
    lastPerceiveStore.output = output;
    lastPerceiveStore.cards = model;
    lastPerceiveStore.snapshotOpts = perceiveSnapshotOpts(opts);
    if (frame) rememberFramePerceiveOutput(refState, frame.ref, output);
    if (refState && typeof refState === 'object') {
      refState.generation = (refState.generation || 0) + 1;
      refState.lastPerceiveAt = Date.now();
      refState.invalidationReason = null;
    }
    return output;
  }
  const builtTree = buildPerceiveTree(axNodes, meta, activeRefMap, {
    maxDepth,
    interactiveOnly,
    keepRefs,
    last,
    adaptive,
    cursorInteractive,
    consoleErrors: errors + exceptions,
    targetPrefix: opts.targetPrefix || '<target>',
  });
  let treeLines = builtTree.treeLines;
  const { refNodeIds } = builtTree;
  if (frame) storeFrameScopedRefs(refState, frame, frameContext.frames, activeRefMap);

  // === Batch-resolve @ref bounding rects (parallel, non-scrolling) ===
  // Now also returns `position` (computed style) so fixed/sticky elements get
  // a clear annotation — agents previously saw negative document-relative Ys
  // and assumed elements were off-screen.
  const refRects = new Map(); // ref number → {x, y, w, h, position?}
  const frameOffset = frame
    ? await frameViewportOffset(cdp, sid, {
        ...frame,
        frameRef: frame.ref,
        frameId: frame.id,
        frames: frameContext.frames,
      })
    : { x: 0, y: 0 };
  if (frame && (frameOffset.x || frameOffset.y)) {
    if (Array.isArray(meta.cursorInteractives)) {
      meta.cursorInteractives = meta.cursorInteractives.map(item => offsetCursorInteractiveItem(item, frameOffset));
    }
    if (Array.isArray(meta.visibleControls)) {
      meta.visibleControls = meta.visibleControls.map(control => (
        control?.rect ? { ...control, rect: offsetCssRect(control.rect, frameOffset) } : control
      ));
    }
  }
  if (refNodeIds.length > 0) {
    const results = await Promise.allSettled(refNodeIds.map(async ({ ref, backendDOMNodeId }) => {
      const { object } = await cdpDomains(cdp).DOM.resolveNode( { backendNodeId: backendDOMNodeId }, sid);
      const res = await cdpDomains(cdp).Runtime.callFunctionOn( {
        objectId: object.objectId,
        functionDeclaration: `function() {
          const r = this.getBoundingClientRect();
          const cs = (typeof getComputedStyle === 'function') ? getComputedStyle(this) : null;
          return {
            x: Math.round(r.x),
            y: Math.round(r.y),
            w: Math.round(r.width),
            h: Math.round(r.height),
            position: cs ? cs.position : '',
          };
        }`,
        returnByValue: true,
      }, sid);
      const rect = res.result.value || {};
      if (frame) {
        rect.x = (Number(rect.x) || 0) + frameOffset.x;
        rect.y = (Number(rect.y) || 0) + frameOffset.y;
      }
      return { ref, rect };
    }));
    for (const r of results) {
      if (r.status === 'fulfilled') refRects.set(r.value.ref, r.value.rect);
    }
  }

  // Inject @ref coordinates into treeLines (top-level viewport CSS pixels; same space as clickxy)
  for (let i = 0; i < treeLines.length; i++) {
    const m = treeLines[i].match(/@(\d+)$/);
    if (m) {
      const rect = refRects.get(parseInt(m[1]));
      if (rect) treeLines[i] += `  ${formatRefRect(rect)}`;
    }
  }
  if (frame) treeLines = qualifyFrameRefsInLines(treeLines, frame.ref);

  // === Cursor-interactive @c refs (capped AFTER body; last/adaptive apply here) ===
  const cursorLimit = perceiveCursorSurfaceLimit({
    last,
    adaptive,
    lineCount: treeLines.length,
    consoleErrors: errors + exceptions,
    interactiveCount: refNodeIds.length + (meta.cursorInteractives?.length || 0) + (meta.visibleControls?.length || 0),
    hasPriorityText: treeLines.some(ln => isPriorityPerceiveTextLine(ln)),
  });
  let cRefCounter = 0;
  if (cursorInteractive && meta.cursorInteractives?.length > 0) {
    const ranked = rankPerceiveCursorItems(meta.cursorInteractives, item => item.text || item.sel);
    const capped = ranked.slice(0, cursorLimit);
    treeLines.push('');
    treeLines.push(`[Cursor-interactive elements] (non-ARIA clickable)${ranked.length > capped.length ? ' (truncated)' : ''}`);
    for (const ci of capped) {
      cRefCounter++;
      refMap.set(`c${cRefCounter}`, ci);
      treeLines.push(`  [clickable] ${ci.text || ci.sel}  @c${cRefCounter}  (${ci.x},${ci.y} ${ci.w}×${ci.h})`);
    }
  }
  if (cursorInteractive && meta.visibleControls?.length > 0) {
    const refAnns = refAnnotationsFromTreeLines(treeLines);
    const ranked = rankPerceiveCursorItems(
      meta.visibleControls,
      item => item.label || item.ariaLabel || item.text || item.title,
    ).map(control => attachRefToVisibleControl(control, refAnns));
    const capped = ranked.slice(0, cursorLimit);
    const truncated = ranked.length > capped.length || meta.visibleControlsTruncated;
    treeLines.push('');
    treeLines.push(`[Visible controls]${truncated ? ' (truncated)' : ''}`);
    for (const control of capped) {
      treeLines.push(`  ${formatVisibleControlLine(control)}`);
    }
  }

  // === Assemble output ===
  const lines = [];
  lines.push(`Page: ${meta.title} — ${meta.url}`);
  if (frame) {
    const label = frame.name || '(anonymous)';
    const url = frame.url || frame.unreachableUrl || '(no url)';
    lines.push(`Frame: ${frame.ref} ${label} ${frame.id} ${url}`);
  }

  const scrollPct = meta.scrollMax > 0 ? Math.round(meta.scrollY / meta.scrollMax * 100) : 0;
  lines.push(`Viewport: ${meta.vw}×${meta.vh} | Scroll: ${meta.scrollY}/${meta.scrollMax > 0 ? meta.scrollMax : 0} (${scrollPct}%) | Focused: ${meta.focused}`);
  if (typeaheadFilter.omitted) lines.push(TYPEAHEAD_OMITTED_NOTICE);

  const countParts = Object.entries(meta.counts).map(([k, v]) => `${v} ${k}`);
  lines.push(`Interactive: ${countParts.length > 0 ? countParts.join(', ') : 'none'}`);

  const healthParts = [];
  if (errors > 0) healthParts.push(`${errors} error${errors > 1 ? 's' : ''}`);
  if (warnings > 0) healthParts.push(`${warnings} warning${warnings > 1 ? 's' : ''}`);
  if (exceptions > 0) healthParts.push(`${exceptions} exception${exceptions > 1 ? 's' : ''}`);
  lines.push(`Console: ${healthParts.length > 0 ? healthParts.join(', ') : 'clean'}`);
  // Coordinate hint — top-level viewport CSS pixels match clickxy/Input events.
  // Fixed/sticky elements include a "fixed"/"sticky" tag so agents do not
  // misread negative scroll-relative Ys as off-screen.
  lines.push(`Coords: top-level viewport CSS px (use clickxy with these values; fixed/sticky elements are tagged)`);

  lines.push('');
  lines.push(...treeLines);

  const output = lines.join('\n');

  const markPerceived = () => {
    lastPerceiveStore.output = output;
    lastPerceiveStore.snapshotOpts = perceiveSnapshotOpts(opts);
    if (frame) rememberFramePerceiveOutput(refState, frame.ref, output);
    // Mark refs as freshly assigned (clears 'navigation'/'daemon-start' state).
    if (refState && typeof refState === 'object') {
      refState.generation = (refState.generation || 0) + 1;
      refState.lastPerceiveAt = Date.now();
      refState.invalidationReason = null;
    }
  };

  if (sinceAction) {
    markPerceived();
    if (!diffBaseline) {
      return output + '\n\n(no action baseline available; run `perceive` before a mutating command, or use `perceive --diff` after a normal perceive.)';
    }
    return formatPerceiveDiffOutput(diffBaseline, output, { mode: 'since-action' });
  }

  // Diff mode: compare with previous perceive output.
  if (diffMode && lastPerceiveStore.output) {
    const previousOutput = lastPerceiveStore.output;
    markPerceived();
    return formatPerceiveDiffOutput(previousOutput, output);
  }

  markPerceived();
  // Hint when perceive returns many interactive elements without exclude
  if (interactiveOnly && !excludeSelector && refNodeIds.length > 50) {
    return output + `\n\n${perceiveInteractiveNoiseHint(refNodeIds.length)}`;
  }
  return output;
}

function perceptionModelFromText(output, refState = {}, targetPrefix = '<target>', opts = {}) {
  const lines = String(output || '').split('\n');
  const header = parsePerceiveHeader(output);

  const nodes = [];
  for (const line of lines) {
    const refMatch = line.match(/\[(\w+)\]\s+(.+?)\s+(@f\d+:\d+|@\d+)(?:\s+\((-?\d+),(-?\d+) (\d+)×(\d+)(?:, [^)]+)?\))?$/);
    if (!refMatch) continue;
    const [, role, rawName, ref, x, y, width, height] = refMatch;
    const node = {
      ref,
      role,
      name: rawName.trim(),
    };
    if (x !== undefined) {
      node.rect = {
        x: Number(x),
        y: Number(y),
        width: Number(width),
        height: Number(height),
      };
    }
    nodes.push(node);
  }

  return createPerceptionModel({
    targetPrefix,
    page: header.page,
    viewport: header.viewport,
    consoleHealth: header.console,
    refs: { generation: refState.generation || 0 },
    nodes,
    limits: {
      truncated: output.includes('truncated'),
      ...(opts.last ? { lastTextRows: opts.last, outputTokenBudget: opts.last * 80 } : {}),
    },
  });
}

async function perceiveModel(cdp, sid, consoleBuf, exceptionBuf, refMap, lastPerceiveStore, opts = {}, refState = null) {
  const output = await perceiveStr(cdp, sid, consoleBuf, exceptionBuf, refMap, lastPerceiveStore, opts, refState);
  if (String(output || '').includes('chrome-cdp-ex.pdf-viewer.v1')) {
    return pdfViewerHandoffModelFromOutput(output, opts.targetPrefix || '<target>');
  }
  return perceptionModelFromText(output, refState || {}, opts.targetPrefix || '<target>', opts);
}

async function perceiveDiffModel(cdp, sid, consoleBuf, exceptionBuf, refMap, lastPerceiveStore, opts = {}, refState = null) {
  const mode = opts.sinceAction ? 'since-action' : 'diff';
  const baseline = opts.sinceAction ? opts.diffBaseline : lastPerceiveStore.output;
  const currentOutput = await perceiveStr(
    cdp,
    sid,
    consoleBuf,
    exceptionBuf,
    refMap,
    lastPerceiveStore,
    { ...opts, sinceAction: false, diff: false, diffBaseline: null },
    refState
  );
  if (!baseline) {
    const header = parsePerceiveHeader(currentOutput);
    const target = opts.targetPrefix || '<target>';
    const nextSteps = [
      `cdp perceive ${target} -C -d 8`,
      `cdp report ${target} --format json`,
    ];
    return {
      schema: 'chrome-cdp-ex.perceive-diff.v1',
      mode,
      baselineAvailable: false,
      ...header,
      summary: {
        changed: null,
        removed: 0,
        added: 0,
        textRemoved: 0,
        textAdded: 0,
      },
      removed: [],
      added: [],
      removedOmitted: 0,
      addedOmitted: 0,
      textRemovedSamples: [],
      textAddedSamples: [],
      recommendation: buildPerceiveDiffRecommendation({
        mode,
        changed: null,
        baselineAvailable: false,
        nextSteps,
      }),
      nextSteps,
    };
  }
  return buildPerceiveDiffModel(baseline, currentOutput, {
    mode,
    targetPrefix: opts.targetPrefix || '',
  });
}

// Element screenshot: targeted capture of a specific element by CSS selector or @ref
async function elshotStr(cdp, sid, selector, targetId, refMap, refState) {
  if (!selector) throw new Error('CSS selector or @ref required');
  if (isRef(selector)) {
    const r = await resolveRef(cdp, sid, refMap, selector, refState);
    const pad = 8;
    const clipX = Math.max(0, r.x - pad);
    const clipY = Math.max(0, r.y - pad);
    const clipW = r.w + pad * 2;
    const clipH = r.h + pad * 2;
    await sleep(100);
    const clip = { x: clipX, y: clipY, width: clipW, height: clipH, scale: 1 };
    const { data, fallback } = await captureScreenshot(cdp, sid, { format: 'png', clip });
    const prefix = (targetId || 'unknown').slice(0, 8);
    const out = resolve(RUNTIME_DIR, `elshot-${prefix}-ref${selector.slice(1)}.png`);
    writeFileSync(out, Buffer.from(data, 'base64'), { mode: 0o600 });
    const fb = fallback ? ' (fallback)' : '';
    return `${out}\nElement screenshot of <${r.tag}> "${r.text}" (${selector}) — ${Math.round(r.w)}×${Math.round(r.h)} CSS px${fb}`;
  }
  // Scroll element into view and get its bounding rect
  const expr = `
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, error: 'Element not found: ' + ${JSON.stringify(selector)} };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = el.getBoundingClientRect();
      return {
        ok: true,
        x: rect.x, y: rect.y, w: rect.width, h: rect.height,
        tag: el.tagName, id: el.id,
        text: el.textContent.trim().substring(0, 60)
      };
    })()
  `;
  const result = await evalStr(cdp, sid, expr);
  const r = JSON.parse(result);
  if (!r.ok) throw new Error(r.error);

  // Small padding around the element (clamped to viewport)
  const pad = 8;
  const clipX = Math.max(0, r.x - pad);
  const clipY = Math.max(0, r.y - pad);
  const clipW = r.w + pad * 2;
  const clipH = r.h + pad * 2;

  await sleep(100); // let scroll settle

  const clip = { x: clipX, y: clipY, width: clipW, height: clipH, scale: 1 };
  const { data, fallback } = await captureScreenshot(cdp, sid, { format: 'png', clip });

  const prefix = (targetId || 'unknown').slice(0, 8);
  const selSafe = selector.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 30);
  const out = resolve(RUNTIME_DIR, `elshot-${prefix}-${selSafe}.png`);
  writeFileSync(out, Buffer.from(data, 'base64'), { mode: 0o600 });

  const desc = `<${r.tag}>${r.id ? '#' + r.id : ''} "${r.text}"`;
  const fb = fallback ? ' (fallback)' : '';
  return `${out}\nElement screenshot of ${desc} — ${Math.round(r.w)}×${Math.round(r.h)} CSS px (clip: ${Math.round(clipW)}×${Math.round(clipH)} with padding)${fb}`;
}

async function dispatchMouseEventAllowingAckTimeout(cdp, sid, params) {
  try {
    await cdpDomains(cdp).Input.dispatchMouseEvent(params, sid, HOVER_MOUSE_ACK_TIMEOUT_MS);
  } catch (error) {
    // Same Chrome 151 compositor-ack stall as hover: the event is already
    // forwarded, so waiting out the default 15s RPC would separate press from
    // release by seconds and the link default action never runs.
    if (!isTimeoutError(error, ['Input.dispatchMouseEvent'])) throw error;
  }
}

async function dispatchClickMouseEvent(cdp, sid, params) {
  try {
    await cdpDomains(cdp).Input.dispatchMouseEvent(params, sid, CLICK_MOUSE_ACK_TIMEOUT_MS);
  } catch (error) {
    // Press/release may sit behind Chrome 151's ~5s hit-test/compositor stall.
    // Swallow only that timeout so overlapping events can still inject; the
    // page-side probe below fail-closes if nothing actually reached the DOM.
    if (!isTimeoutError(error, ['Input.dispatchMouseEvent'])) throw error;
  }
}

function clickEventProbeInstallOnViewSource() {
  return `function installOnView(view, scope) {
    const key = ${JSON.stringify(CLICK_EVENT_PROBE_KEY)};
    const types = ['pointerdown', 'mousedown', 'mouseup', 'pointerup', 'click'];
    if (!view || typeof view.addEventListener !== 'function') {
      return { cdpClickProbe: true, ok: false, installed: false };
    }
    const existing = view[key];
    if (existing && existing.handler) {
      for (const type of existing.types || types) {
        view.removeEventListener(type, existing.handler, true);
      }
    }
    const seen = [];
    const handler = function(event) { seen.push(event.type); };
    for (const type of types) view.addEventListener(type, handler, true);
    view[key] = { types: types, handler: handler, seen: seen };
    return { cdpClickProbe: true, ok: true, installed: true, scope: scope || 'target-document' };
  }`;
}

function clickEventProbeReadOnViewSource() {
  return `function readOnView(view) {
    const key = ${JSON.stringify(CLICK_EVENT_PROBE_KEY)};
    if (!view) return { cdpClickProbe: true, ok: false };
    const probe = view[key];
    if (!probe) return { cdpClickProbe: true, ok: false };
    const types = probe.types || ['pointerdown', 'mousedown', 'mouseup', 'pointerup', 'click'];
    if (probe.handler) {
      for (const type of types) view.removeEventListener(type, probe.handler, true);
    }
    const seen = Array.isArray(probe.seen) ? probe.seen.slice() : [];
    try { delete view[key]; } catch (err) { view[key] = undefined; }
    return { cdpClickProbe: true, ok: true, seen: seen };
  }`;
}

function clickEventProbeInstallOnNodeDeclaration() {
  return `function() {
    ${clickEventProbeInstallOnViewSource()}
    const view = this && this.ownerDocument && this.ownerDocument.defaultView;
    return installOnView(view, 'target-document');
  }`;
}

function clickEventProbeReadOnNodeDeclaration() {
  return `function() {
    ${clickEventProbeReadOnViewSource()}
    const view = this && this.ownerDocument && this.ownerDocument.defaultView;
    return readOnView(view);
  }`;
}

function clickEventProbeInstallAtPointScript(x, y) {
  return `(function() {
    ${clickEventProbeInstallOnViewSource()}
    const px0 = ${JSON.stringify(Number(x))};
    const py0 = ${JSON.stringify(Number(y))};
    let doc = document;
    let view = window;
    let px = px0;
    let py = py0;
    let opaqueFrame = false;
    for (let depth = 0; depth < 8; depth++) {
      const hit = doc.elementFromPoint ? doc.elementFromPoint(px, py) : null;
      if (!hit) break;
      const tag = String(hit.tagName || '').toUpperCase();
      if (tag !== 'IFRAME' && tag !== 'FRAME') {
        view = (hit.ownerDocument && hit.ownerDocument.defaultView) || view;
        break;
      }
      const nested = hit.contentDocument;
      if (!nested) {
        opaqueFrame = true;
        view = hit.contentWindow || view;
        break;
      }
      const rect = hit.getBoundingClientRect();
      px -= rect.left;
      py -= rect.top;
      doc = nested;
      view = hit.contentWindow || view;
    }
    if (opaqueFrame) return { cdpClickProbe: true, ok: true, installed: true, opaqueFrame: true, scope: 'opaque-frame' };
    const scope = (view && view !== window) ? 'target-document' : 'top';
    return installOnView(view || window, scope);
  })()`;
}

function clickEventProbeReadAtPointScript(x, y) {
  return `(function() {
    ${clickEventProbeReadOnViewSource()}
    const key = ${JSON.stringify(CLICK_EVENT_PROBE_KEY)};
    const px0 = ${JSON.stringify(Number(x))};
    const py0 = ${JSON.stringify(Number(y))};
    let doc = document;
    let view = window;
    let px = px0;
    let py = py0;
    for (let depth = 0; depth < 8; depth++) {
      if (view && view[key]) return readOnView(view);
      const hit = doc.elementFromPoint ? doc.elementFromPoint(px, py) : null;
      if (!hit) break;
      const tag = String(hit.tagName || '').toUpperCase();
      if (tag !== 'IFRAME' && tag !== 'FRAME') {
        view = (hit.ownerDocument && hit.ownerDocument.defaultView) || view;
        break;
      }
      const nested = hit.contentDocument;
      if (!nested) {
        view = hit.contentWindow || view;
        break;
      }
      const rect = hit.getBoundingClientRect();
      px -= rect.left;
      py -= rect.top;
      doc = nested;
      view = hit.contentWindow || view;
    }
    if (view && view[key]) return readOnView(view);
    if (window[key]) return readOnView(window);
    return { cdpClickProbe: true, ok: false };
  })()`;
}

function parseClickEventProbeOutput(raw) {
  if (raw && typeof raw === 'object' && raw.cdpClickProbe === true) return raw;
  const text = String(raw || '').trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || parsed.cdpClickProbe !== true) return null;
    return parsed;
  } catch {
    return null;
  }
}

function clickProbeSawPageEvent(seen) {
  if (!Array.isArray(seen) || seen.length === 0) return false;
  return seen.some(type => (
    type === 'mousedown'
    || type === 'pointerdown'
    || type === 'mouseup'
    || type === 'pointerup'
    || type === 'click'
  ));
}

function clickNoPageEventsError(x, y, selector = '') {
  const target = selector ? ` for ${selector}` : '';
  return new Error(
    `click: Input.dispatchMouseEvent completed but the page received no mousedown/click events at (${x}, ${y})${target}. The mouse path failed closed. Try jsclick or click --js.`
  );
}

async function installClickEventProbe(cdp, sid, { objectId = null, x = 0, y = 0 } = {}) {
  try {
    if (objectId) {
      const res = await cdpDomains(cdp).Runtime.callFunctionOn({
        objectId,
        functionDeclaration: clickEventProbeInstallOnNodeDeclaration(),
        returnByValue: true,
      }, sid);
      if (res.exceptionDetails) return { installed: false };
      const parsed = parseClickEventProbeOutput(res.result?.value);
      return {
        installed: Boolean(parsed?.ok && parsed?.installed),
        scope: parsed?.scope || 'target-document',
        opaqueFrame: parsed?.opaqueFrame === true,
        objectId,
        x,
        y,
      };
    }
    const raw = await evalStr(cdp, sid, clickEventProbeInstallAtPointScript(x, y));
    const parsed = parseClickEventProbeOutput(raw);
    return {
      installed: Boolean(parsed?.ok && parsed?.installed),
      scope: parsed?.scope || 'top',
      opaqueFrame: parsed?.opaqueFrame === true,
      objectId: null,
      x,
      y,
    };
  } catch {
    return { installed: false, scope: 'top', opaqueFrame: false, objectId, x, y };
  }
}

async function readClickEventProbe(cdp, sid, probe = {}) {
  try {
    if (probe.objectId) {
      const res = await cdpDomains(cdp).Runtime.callFunctionOn({
        objectId: probe.objectId,
        functionDeclaration: clickEventProbeReadOnNodeDeclaration(),
        returnByValue: true,
      }, sid);
      if (res.exceptionDetails) return null;
      return parseClickEventProbeOutput(res.result?.value);
    }
    const raw = await evalStr(cdp, sid, clickEventProbeReadAtPointScript(probe.x, probe.y));
    return parseClickEventProbeOutput(raw);
  } catch {
    return null;
  }
}

// Shared: dispatch a realistic mouse click at CSS pixel coordinates.
// Chrome's default action for <a href> requires the buttons bitmask
// (left=1 while pressed, 0 after release). Omitting it yields mousedown
// without a click, so the link never navigates.
//
// Chrome 151's Input.dispatchMouseEvent waits for an async widget hit-test
// before injecting. Serializing on that ack with a 250ms swallow left
// press/release uninjected (dispatch.ok, zero page events). Overlap the
// CDP commands, wait long enough for the ~5s stall, then fail closed unless a
// capture-phase probe on the target document saw mouse/click events. A missing
// probe is fail-closed for top-level clicks; framed targets must probe the
// iframe document instead of treating a top-level empty `seen` as proof.
async function dispatchClick(cdp, sid, x, y, probeTarget = {}) {
  const probe = await installClickEventProbe(cdp, sid, {
    objectId: probeTarget.objectId || null,
    x,
    y,
  });
  const point = { x, y, modifiers: 0, pointerType: 'mouse', clickCount: 1 };
  const moved = dispatchMouseEventAllowingAckTimeout(cdp, sid, { ...point, type: 'mouseMoved', button: 'none', buttons: 0 });
  const pressed = dispatchClickMouseEvent(cdp, sid, { ...point, type: 'mousePressed', button: 'left', buttons: 1 });
  await sleep(50);
  const released = dispatchClickMouseEvent(cdp, sid, { ...point, type: 'mouseReleased', button: 'left', buttons: 0 });
  await Promise.all([moved, pressed, released]);
  const framed = probeTarget.framed === true;
  if (probe.opaqueFrame && framed) return;
  if (!probe.installed) {
    if (framed) return;
    throw clickNoPageEventsError(x, y, probeTarget.selector);
  }
  if (probe.scope === 'top' && framed) return;
  const readout = await readClickEventProbe(cdp, sid, probe);
  if (readout?.ok && clickProbeSawPageEvent(readout.seen)) return;
  throw clickNoPageEventsError(x, y, probeTarget.selector);
}

function isNavigatingHref(href, pageHref = '') {
  const target = String(href || '').trim();
  if (!target) return false;
  const lower = target.toLowerCase();
  if (lower.startsWith('javascript:') || lower.startsWith('mailto:') || lower.startsWith('tel:')) return false;
  if (target.startsWith('#')) return false;
  try {
    const next = new URL(target, pageHref || 'https://example.invalid/');
    if (next.protocol !== 'http:' && next.protocol !== 'https:') return false;
    if (!pageHref) return true;
    return next.href !== new URL(pageHref).href;
  } catch {
    return false;
  }
}

async function evalPageHref(cdp, sid, timeoutMs = CLICK_HREF_PROBE_TIMEOUT_MS) {
  const requested = Number(timeoutMs);
  const budget = Math.max(1, Number.isFinite(requested) ? requested : CLICK_HREF_PROBE_TIMEOUT_MS);
  let timer;
  try {
    const href = await Promise.race([
      evalStr(cdp, sid, 'location.href', false, { timeoutMs: budget }),
      new Promise(resolve => { timer = setTimeout(() => resolve(''), budget); }),
    ]);
    return String(href || '').trim();
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

async function confirmClickFollowedHref(cdp, sid, target = {}) {
  if (String(target.tag || '').toUpperCase() !== 'A') return;
  if (!isNavigatingHref(target.href, target.pageHref)) return;
  const before = String(target.pageHref || '');
  const deadline = Date.now() + CLICK_NAVIGATION_WAIT_MS;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const current = await evalPageHref(cdp, sid, Math.min(CLICK_HREF_PROBE_TIMEOUT_MS, remaining));
    if (current && current !== before) return current;
    const pause = Math.min(40, deadline - Date.now());
    if (pause > 0) await sleep(pause);
  }
  throw new Error(
    `Click on <A href="${target.href}"> did not navigate. Try jsclick or click --js.`
  );
}

// Shared: get device pixel ratio
async function getDpr(cdp, sid) {
  try {
    const raw = await evalStr(cdp, sid, 'window.devicePixelRatio');
    const parsed = parseFloat(raw);
    if (parsed > 0) return parsed;
  } catch {}
  return 1;
}

async function resolveSelectorNode(cdp, sid, selector) {
  if (!selector) throw new Error('CSS selector required');
  try { await cdpDomains(cdp).DOM.enable( {}, sid); } catch {}
  const { root } = await cdpDomains(cdp).DOM.getDocument( {}, sid);
  let result;
  try {
    result = await cdpDomains(cdp).DOM.querySelector( { nodeId: root.nodeId, selector }, sid);
  } catch (e) {
    throw new Error(`Invalid selector: ${selector}. ${e.message}`);
  }
  if (!result.nodeId) throw new Error('Element not found: ' + selector);
  const { object } = await cdpDomains(cdp).DOM.resolveNode( { nodeId: result.nodeId }, sid);
  return object.objectId;
}

// JS-fallback click: uses HTMLElement.click() / dispatchEvent in the page
// instead of CDP Input.dispatchMouseEvent. Useful when the page intercepts
// real-pointer events with overlays, has misaligned hit testing under custom
// transforms, or when an MUD/game UI binds handlers only to synthetic clicks.
// This path is intentionally separate from clickStr — agents opt into it via
// `jsclick` or `click --js` so the default behaviour stays a realistic mouse
// dispatch.
async function jsClickStr(cdp, sid, selector, refMap, refState) {
  if (!selector) throw new Error('CSS selector or @ref required');
  const objectId = isRef(selector)
    ? await resolveRefNode(cdp, sid, refMap, selector, refState)
    : await resolveSelectorNode(cdp, sid, selector);
  try {
    const res = await cdpDomains(cdp).Runtime.callFunctionOn( {
      objectId,
      functionDeclaration: `function() {
        this.scrollIntoView({ block: 'center', inline: 'center' });
        if (typeof this.click === 'function') this.click();
        else this.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        return { tag: this.tagName, text: (this.textContent || '').trim().substring(0, 80) };
      }`,
      returnByValue: true,
    }, sid);
    const r = res.result.value || {};
    return `JS-clicked <${r.tag || '?'}> "${r.text || ''}"${isRef(selector) ? ` (${selector})` : ''}`;
  } catch (e) {
    if (isTimeoutError(e, ['Runtime.callFunctionOn'])) {
      return `JS-click dispatched for ${selector}; success but click acknowledgement timed out after dispatch (${e.message}). Run \`perceive --diff\` or \`status\` to refresh observation.`;
    }
    throw e;
  }
}

// Click element by CSS selector or @ref
async function clickStr(cdp, sid, selector, refMap, refState) {
  if (!selector) throw new Error('CSS selector or @ref required');
  if (isCursorRef(selector)) {
    const r = resolveCursorRef(refMap, selector, refState);
    await dispatchClick(cdp, sid, r.x + r.w / 2, r.y + r.h / 2, { selector, x: r.x + r.w / 2, y: r.y + r.h / 2 });
    await confirmClickFollowedHref(cdp, sid, r);
    return `Clicked <${r.sel}> "${r.text}" (${selector})`;
  }
  if (isRef(selector)) {
    const r = await resolveRef(cdp, sid, refMap, selector, refState);
    let objectId = null;
    try {
      objectId = await resolveRefNode(cdp, sid, refMap, selector, refState, { returnRealm: 'page' });
    } catch {
      objectId = null;
    }
    await dispatchClick(cdp, sid, r.x + r.w / 2, r.y + r.h / 2, {
      selector,
      objectId,
      framed: Boolean(parseFrameRef(selector)),
    });
    await confirmClickFollowedHref(cdp, sid, r);
    return `Clicked <${r.tag}> "${r.text}" (${selector})`;
  }
  const expr = `
    (async function() {
      let el;
      try {
        el = document.querySelector(${JSON.stringify(selector)});
      } catch (err) {
        return { ok: false, error: 'Invalid selector: ' + (err && err.message ? err.message : String(err)) };
      }
      if (!el) return { ok: false, error: 'Element not found: ' + ${JSON.stringify(selector)} };
      const rect = await (${scrollSettledRectFunctionDeclaration()}).call(el);
      return {
        ok: true,
        x: rect.x + rect.w / 2,
        y: rect.y + rect.h / 2,
        tag: rect.tag,
        text: rect.text,
        href: rect.href || (el.tagName === 'A' ? (el.href || null) : null),
        pageHref: rect.pageHref || location.href,
      };
    })()
  `;
  const result = await evalStr(cdp, sid, expr);
  const r = JSON.parse(result);
  if (!r.ok) throw new Error(r.error);
  await dispatchClick(cdp, sid, r.x, r.y, { selector, x: r.x, y: r.y });
  await confirmClickFollowedHref(cdp, sid, r);
  return `Clicked <${r.tag}> "${r.text}"`;
}

// Click at CSS pixel coordinates using Input.dispatchMouseEvent
async function clickXyStr(cdp, sid, x, y) {
  const cx = parseFloat(x);
  const cy = parseFloat(y);
  if (isNaN(cx) || isNaN(cy)) throw new Error('x and y must be numbers (CSS pixels)');
  await dispatchClick(cdp, sid, cx, cy, { x: cx, y: cy });
  return `Clicked at CSS (${cx}, ${cy})`;
}

// Type text using Input.insertText (works in cross-origin iframes, unlike eval)
async function typeStr(cdp, sid, text) {
  if (text == null || text === '') throw new Error('text required');
  await cdpDomains(cdp).Input.insertText( { text }, sid);
  return `Typed ${text.length} characters`;
}

const KEY_MAP = {
  enter:      { key: 'Enter',      code: 'Enter',      keyCode: 13 },
  tab:        { key: 'Tab',        code: 'Tab',        keyCode: 9 },
  escape:     { key: 'Escape',     code: 'Escape',     keyCode: 27 },
  backspace:  { key: 'Backspace',  code: 'Backspace',  keyCode: 8 },
  delete:     { key: 'Delete',     code: 'Delete',     keyCode: 46 },
  space:      { key: ' ',          code: 'Space',      keyCode: 32 },
  arrowup:    { key: 'ArrowUp',    code: 'ArrowUp',    keyCode: 38 },
  arrowdown:  { key: 'ArrowDown',  code: 'ArrowDown',  keyCode: 40 },
  arrowleft:  { key: 'ArrowLeft',  code: 'ArrowLeft',  keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
};

// Punctuation → CDP code/keyCode map for unshifted US keys
const PUNCT_KEY_MAP = {
  '`': { code: 'Backquote',    keyCode: 192 },
  '-': { code: 'Minus',        keyCode: 189 },
  '=': { code: 'Equal',        keyCode: 187 },
  '[': { code: 'BracketLeft',  keyCode: 219 },
  ']': { code: 'BracketRight', keyCode: 221 },
  '\\':{ code: 'Backslash',    keyCode: 220 },
  ';': { code: 'Semicolon',    keyCode: 186 },
  "'": { code: 'Quote',        keyCode: 222 },
  ',': { code: 'Comma',        keyCode: 188 },
  '.': { code: 'Period',       keyCode: 190 },
  '/': { code: 'Slash',        keyCode: 191 },
};

// Shifted printable punctuation on a US keyboard. `key` stays the visible
// character, while code/keyCode identify the physical base key.
const SHIFTED_PUNCT_KEY_MAP = {
  '~': { code: 'Backquote',    keyCode: 192 },
  '_': { code: 'Minus',        keyCode: 189 },
  '+': { code: 'Equal',        keyCode: 187 },
  '{': { code: 'BracketLeft',  keyCode: 219 },
  '}': { code: 'BracketRight', keyCode: 221 },
  '|': { code: 'Backslash',    keyCode: 220 },
  ':': { code: 'Semicolon',    keyCode: 186 },
  '"': { code: 'Quote',        keyCode: 222 },
  '<': { code: 'Comma',        keyCode: 188 },
  '>': { code: 'Period',       keyCode: 190 },
  '?': { code: 'Slash',        keyCode: 191 },
  '!': { code: 'Digit1',       keyCode: 49 },
  '@': { code: 'Digit2',       keyCode: 50 },
  '#': { code: 'Digit3',       keyCode: 51 },
  '$': { code: 'Digit4',       keyCode: 52 },
  '%': { code: 'Digit5',       keyCode: 53 },
  '^': { code: 'Digit6',       keyCode: 54 },
  '&': { code: 'Digit7',       keyCode: 55 },
  '*': { code: 'Digit8',       keyCode: 56 },
  '(': { code: 'Digit9',       keyCode: 57 },
  ')': { code: 'Digit0',       keyCode: 48 },
};

// Resolve a press argument (named key or single-character) to a CDP descriptor.
// Returns { key, code, keyCode, shift? } or null when unsupported.
function keyForPress(input) {
  if (!input || typeof input !== 'string') return null;
  const named = KEY_MAP[input.toLowerCase()];
  if (named) return { ...named };
  if (input.length !== 1) return null;
  // a-z
  if (/^[a-z]$/.test(input)) {
    return { key: input, code: 'Key' + input.toUpperCase(), keyCode: input.toUpperCase().charCodeAt(0) };
  }
  // A-Z (shift-modified)
  if (/^[A-Z]$/.test(input)) {
    return { key: input, code: 'Key' + input, keyCode: input.charCodeAt(0), shift: true };
  }
  // 0-9
  if (/^[0-9]$/.test(input)) {
    return { key: input, code: 'Digit' + input, keyCode: input.charCodeAt(0) };
  }
  if (Object.prototype.hasOwnProperty.call(PUNCT_KEY_MAP, input)) {
    const p = PUNCT_KEY_MAP[input];
    return { key: input, code: p.code, keyCode: p.keyCode };
  }
  if (Object.prototype.hasOwnProperty.call(SHIFTED_PUNCT_KEY_MAP, input)) {
    const p = SHIFTED_PUNCT_KEY_MAP[input];
    return { key: input, code: p.code, keyCode: p.keyCode, shift: true };
  }
  return null;
}

function pressUsageError(keyName) {
  if (!keyName) {
    return new Error('Key name required (Enter, Tab, Escape, Backspace, Space, Arrow*, or single character a-z/A-Z/0-9/punctuation)');
  }
  if (!keyForPress(keyName)) {
    return new Error(
      `Unknown key: ${keyName}. Supported: ${Object.keys(KEY_MAP).join(', ')}, single characters (a-z, A-Z, 0-9, common punctuation). Use \`type\` for multi-character text.`
    );
  }
  return null;
}

async function pressStr(cdp, sid, keyName) {
  const usage = pressUsageError(keyName);
  if (usage) throw usage;
  const mapped = keyForPress(keyName);
  const modifiers = mapped.shift ? 8 : 0;
  const base = {
    key: mapped.key,
    code: mapped.code,
    windowsVirtualKeyCode: mapped.keyCode,
    nativeVirtualKeyCode: mapped.keyCode,
    modifiers,
  };
  await cdpDomains(cdp).Input.dispatchKeyEvent( { ...base, type: 'keyDown' }, sid);
  // For printable single characters, send a `char` event so the page receives input
  // (mirrors what real keyboards do for letter / digit / punctuation keys).
  if (mapped.key.length === 1 && mapped.code !== 'Space' && mapped.key !== ' ') {
    await cdpDomains(cdp).Input.dispatchKeyEvent( { ...base, type: 'char', text: mapped.key, unmodifiedText: mapped.key }, sid);
  }
  await cdpDomains(cdp).Input.dispatchKeyEvent( { ...base, type: 'keyUp' }, sid);
  return `Pressed ${mapped.key}`;
}

const DOCUMENT_SCROLL_EDGE_TOLERANCE_PX = 2;

function parseScrollEdge(direction, amount) {
  const first = String(direction || '').trim().toLowerCase();
  if (first !== 'to') return null;
  const second = String(amount || '').trim().toLowerCase();
  if (second === 'top' || second === 'bottom') return second;
  throw new Error('Direction required: to top or to bottom');
}

function parseScrollContainerArg(args = []) {
  const list = Array.isArray(args) ? args : [];
  let container = null;
  for (let i = 0; i < list.length; i++) {
    const token = list[i];
    if (token === '--scroll-container') {
      const value = list[++i];
      if (value == null || String(value).startsWith('--')) {
        throw new Error('scroll: --scroll-container requires a selector');
      }
      if (container != null) throw new Error('scroll: duplicate --scroll-container');
      container = String(value);
      continue;
    }
    if (String(token).startsWith('--')) {
      throw new Error(`scroll: unknown argument ${token}`);
    }
    throw new Error(`scroll: unexpected argument ${token}`);
  }
  return container;
}

function scrollFeedbackPolicy(direction, amount) {
  return parseScrollEdge(direction, amount) ? 'report-only' : 'settle-diff';
}

function scrollActionTarget(args = [], extra = {}) {
  const direction = args[0];
  const amount = args[1];
  const edge = parseScrollEdge(direction, amount);
  const target = {
    input: extra.input ?? [direction, amount].filter(Boolean).join(' '),
    resolvedBy: extra.resolvedBy ?? 'scroll',
    label: extra.label ?? (edge ? `to ${edge}` : (direction || 'scroll')),
    commandArgs: extra.commandArgs ?? [direction, amount],
  };
  if (extra.targetId) target.targetId = extra.targetId;
  if (edge) target.expectedOutcome = DOCUMENT_SCROLL_EDGE_OUTCOME;
  return target;
}

function scrollEdgeLogicSource() {
  const tolerance = DOCUMENT_SCROLL_EDGE_TOLERANCE_PX;
  return `
    const tolerance = ${tolerance};
    const measureDocument = function() {
      const el = document.scrollingElement || document.documentElement;
      const scrollY = Math.round(window.scrollY);
      const scrollMax = Math.max(0, Math.round((Number(el && el.scrollHeight) || 0) - window.innerHeight));
      return {
        kind: 'document',
        scrollY: scrollY,
        scrollMax: scrollMax,
        atTop: scrollY <= tolerance,
        atBottom: scrollMax <= tolerance || scrollY >= scrollMax - tolerance,
      };
    };
    const measureEl = function(el) {
      const scrollTop = Math.round(Number(el && el.scrollTop) || 0);
      const clientHeight = Math.round(Number(el && el.clientHeight) || 0);
      const scrollHeight = Math.round(Number(el && el.scrollHeight) || 0);
      const scrollMax = Math.max(0, scrollHeight - clientHeight);
      return {
        scrollTop: scrollTop,
        scrollMax: scrollMax,
        atTop: scrollTop <= tolerance,
        atBottom: scrollMax <= tolerance || scrollTop >= scrollMax - tolerance,
      };
    };
    const clipsY = function(el) {
      const style = typeof window.getComputedStyle === 'function' ? window.getComputedStyle(el) : null;
      return /(auto|scroll|overlay|hidden)/.test(String((style && (style.overflowY || style.overflow)) || ''));
    };
    const isDocumentScroller = function(el) {
      return !el
        || el === document.documentElement
        || el === document.body
        || el === document.scrollingElement;
    };
    const isOverflow = function(el) {
      if (isDocumentScroller(el)) return false;
      const max = Math.max(0, (Number(el.scrollHeight) || 0) - (Number(el.clientHeight) || 0));
      return max > tolerance && clipsY(el);
    };
    const nearestOverflow = function(start) {
      for (let el = start; el && !isDocumentScroller(el); el = el.parentElement) {
        if (isOverflow(el)) return el;
      }
      return null;
    };
    const primaryOverflow = function() {
      const nodes = document.querySelectorAll ? document.querySelectorAll('*') : [];
      let best = null;
      let bestScore = 0;
      for (let i = 0; i < nodes.length; i++) {
        const el = nodes[i];
        if (!isOverflow(el)) continue;
        const max = Math.max(0, (Number(el.scrollHeight) || 0) - (Number(el.clientHeight) || 0));
        const area = (Number(el.clientWidth) || 0) * (Number(el.clientHeight) || 0);
        const score = max * Math.max(1, area);
        if (score > bestScore) {
          best = el;
          bestScore = score;
        }
      }
      return best;
    };
    const identityOf = function(el) {
      if (!el) return 'container';
      if (el.id) return '#' + String(el.id);
      return el.tagName ? String(el.tagName).toLowerCase() : 'container';
    };
    const applyEdge = function(el, dest) {
      const max = Math.max(0, (Number(el.scrollHeight) || 0) - (Number(el.clientHeight) || 0));
      el.scrollTop = dest === 'top' ? 0 : max;
      if (typeof Event === 'function' && typeof el.dispatchEvent === 'function') {
        try { el.dispatchEvent(new Event('scroll')); } catch {}
      }
    };
    const finishContainer = function(el) {
      const measured = measureEl(el);
      return {
        ok: true,
        kind: 'container',
        selector: identityOf(el),
        scrollTop: measured.scrollTop,
        scrollMax: measured.scrollMax,
        atTop: measured.atTop,
        atBottom: measured.atBottom,
      };
    };
    const resolveContainer = function(requested, startNode) {
      if (startNode) {
        if (isOverflow(startNode)) return { ok: true, el: startNode };
        const ancestor = nearestOverflow(startNode);
        if (ancestor) return { ok: true, el: ancestor };
        return { ok: false, error: 'scroll-container is not scrollable' };
      }
      if (!requested) return { ok: true, el: null };
      if (typeof document.querySelector !== 'function') {
        return { ok: false, error: 'scroll-container not found' };
      }
      const found = document.querySelector(requested);
      if (!found) return { ok: false, error: 'scroll-container not found' };
      if (isOverflow(found)) return { ok: true, el: found };
      const ancestor = nearestOverflow(found);
      if (ancestor) return { ok: true, el: ancestor };
      return { ok: false, error: 'scroll-container is not scrollable' };
    };
    const runScrollEdge = function(requested, dest, startNode) {
      const resolved = resolveContainer(requested, startNode);
      if (resolved.ok === false) return resolved;
      if (resolved.el) {
        applyEdge(resolved.el, dest);
        return finishContainer(resolved.el);
      }
      const doc = measureDocument();
      if (doc.scrollMax > tolerance) {
        window.scrollTo(0, dest === 'top' ? 0 : doc.scrollMax);
        return Object.assign({ ok: true }, measureDocument());
      }
      const overflow = primaryOverflow();
      if (!overflow) return Object.assign({ ok: true }, doc);
      applyEdge(overflow, dest);
      return finishContainer(overflow);
    };
  `;
}

function scrollEdgeExpression(edge, containerSelector = null) {
  const dest = edge === 'top' ? 'top' : 'bottom';
  const requested = containerSelector == null ? 'null' : JSON.stringify(containerSelector);
  return `(function() {
    /* chrome-cdp-ex.scroll-edge */
    ${scrollEdgeLogicSource()}
    return JSON.stringify(runScrollEdge(${requested}, ${JSON.stringify(dest)}, null));
  })()`;
}

function documentScrollEdgeExpression(edge, containerSelector = null) {
  return scrollEdgeExpression(edge, containerSelector);
}

function documentScrollReachedEdge(edge, pos = {}) {
  return edge === 'top' ? pos.atTop === true : pos.atBottom === true;
}

function formatDocumentScrollEdgeText(edge, pos = {}) {
  const flag = edge === 'top' ? 'at-top' : 'at-bottom';
  if (pos.kind === 'container') {
    const who = pos.selector ? `${pos.selector} ` : '';
    return `Scrolled to ${edge}. ${who}scrollTop: ${pos.scrollTop} / ${pos.scrollMax} max (${flag}: yes)`;
  }
  return `Scrolled to ${edge}. scrollY: ${pos.scrollY} / ${pos.scrollMax} max (${flag}: yes)`;
}

function formatDocumentScrollEdgeFailure(edge, pos = {}) {
  const flag = edge === 'top' ? 'at-top' : 'at-bottom';
  if (pos.kind === 'container') {
    const who = pos.selector ? `${pos.selector} ` : '';
    return `Did not reach container ${edge}. ${who}scrollTop: ${pos.scrollTop} / ${pos.scrollMax} max (${flag}: no)`;
  }
  return `Did not reach document ${edge}. scrollY: ${pos.scrollY} / ${pos.scrollMax} max (${flag}: no)`;
}

function parseScrollEdgePayload(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string' || !raw) throw new Error('scroll edge returned no result');
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('scroll edge returned no result');
  }
}

async function scrollStr(cdp, sid, direction, amount, extraArgs = []) {
  const rest = Array.isArray(extraArgs) ? extraArgs : [];
  const edge = parseScrollEdge(direction, amount);
  if (edge) {
    const container = parseScrollContainerArg(rest);
    if (container && isRef(container)) {
      throw new Error('scroll: --scroll-container requires a CSS selector (same as table --scroll-container)');
    }
    const raw = await evalStr(cdp, sid, scrollEdgeExpression(edge, container));
    const pos = parseScrollEdgePayload(raw);
    if (pos && pos.ok === false) throw new Error(pos.error || 'scroll failed');
    if (!documentScrollReachedEdge(edge, pos)) {
      throw new Error(formatDocumentScrollEdgeFailure(edge, pos));
    }
    return formatDocumentScrollEdgeText(edge, pos);
  }
  if (rest.includes('--scroll-container')) {
    throw new Error('scroll: --scroll-container is only valid with to top/to bottom');
  }
  const px = parseInt(amount) || 500;
  const dirMap = { down: [0, px], up: [0, -px], left: [-px, 0], right: [px, 0] };
  let dx, dy;
  if (dirMap[direction?.toLowerCase()]) {
    [dx, dy] = dirMap[direction.toLowerCase()];
  } else if (direction?.includes(',')) {
    [dx, dy] = direction.split(',').map(Number);
    if (isNaN(dx) || isNaN(dy)) throw new Error('Invalid coordinates. Use "down", "up", or "x,y"');
  } else {
    throw new Error('Direction required: down, up, left, right, x,y, or to top/to bottom');
  }
  const result = await evalStr(cdp, sid, `(window.scrollBy(${dx}, ${dy}), JSON.stringify({ x: Math.round(window.scrollX), y: Math.round(window.scrollY) }))`);
  const pos = JSON.parse(result);
  return `Scrolled by (${dx}, ${dy}). Position: (${pos.x}, ${pos.y})`;
}

async function dispatchHoverMove(cdp, sid, x, y) {
  try {
    await cdpDomains(cdp).Input.dispatchMouseEvent(
      { x, y, type: 'mouseMoved', button: 'none', modifiers: 0 },
      sid,
      HOVER_MOUSE_ACK_TIMEOUT_MS,
    );
  } catch (error) {
    // Chrome waits for a renderer/compositor ack on mouseMoved. On live Chrome 151
    // that ack is often withheld until a ~5s input timeout, then the RPC still
    // succeeds. The event was already forwarded; do not block hover on the ack.
    if (!isTimeoutError(error, ['Input.dispatchMouseEvent'])) throw error;
  }
}

async function hoverStr(cdp, sid, selector, refMap, refState) {
  if (!selector) throw new Error('CSS selector or @ref required');
  if (isRef(selector)) {
    const { rect: r } = await resolveRefRectNoScroll(cdp, sid, refMap, selector, refState);
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    await dispatchHoverMove(cdp, sid, cx, cy);
    return `Hovering over <${r.tag || '?'}> at CSS (${Math.round(cx)}, ${Math.round(cy)}) (${selector})`;
  }
  const expr = `
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, error: 'Element not found: ' + ${JSON.stringify(selector)} };
      const rect = el.getBoundingClientRect();
      return { ok: true, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, tag: el.tagName };
    })()
  `;
  const result = await evalStr(cdp, sid, expr);
  const r = JSON.parse(result);
  if (!r.ok) throw new Error(r.error);
  await dispatchHoverMove(cdp, sid, r.x, r.y);
  return `Hovering over <${r.tag}> at CSS (${Math.round(r.x)}, ${Math.round(r.y)})`;
}

async function rememberHoverSettleBaseline(
  cdp,
  sid,
  consoleBuf,
  exceptionBuf,
  refMap,
  lastPerceiveStore,
  refState,
  targetId,
  dispatchHover = null,
) {
  // Hover mutates live DOM (tooltips, :hover text) but historically printed a
  // one-liner and left last-perceive stale. Recapture default AX so the next
  // mutator does not steal hover's delta (#286). Snapshot settle-shape AX
  // before mouseMoved — leftover perceive -C -d 8 is a different line-set
  // than default recapture even when both still say hover:0, so that leftover
  // must not be the KEEP baseline. After dispatch, recapture immediately; if
  // the same shape already changed, KEEP. If it is still idle, discard
  // unconditionally (#291). Do not sit waitForHoverDomChange /
  // HOVER_MUTATION_TIMEOUT_MS: Chrome 151 mouseenter can land after that
  // window, and discard already keeps the next no-op scroll honest. Do not
  // emit ActionResult. Do not lengthen waitForSettle. Do not wait for the
  // compositor mouseMoved ack.
  const settleOpts = actionObservationPerceiveOpts(targetId);
  await perceiveStr(
    cdp,
    sid,
    consoleBuf,
    exceptionBuf,
    refMap,
    lastPerceiveStore,
    settleOpts,
    refState,
  );
  const before = lastPerceiveStore.output;
  if (typeof dispatchHover === 'function') {
    await dispatchHover();
  }
  await perceiveStr(
    cdp,
    sid,
    consoleBuf,
    exceptionBuf,
    refMap,
    lastPerceiveStore,
    settleOpts,
    refState,
  );
  if (hoverRecaptureShowsChange(before, lastPerceiveStore.output)) {
    return;
  }
  discardHoverIdleBaseline(lastPerceiveStore);
}

async function waitForStr(cdp, sid, args, refMap, refState) {
  // Shared polling loop
  async function poll(jsExpr, formatResult, interval, timeoutMs, label) {
    const timeout = Math.min(Math.max(timeoutMs, 500), 300000);
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const found = await evalStr(cdp, sid, jsExpr);
      if (found !== 'null' && found !== '') return formatResult(JSON.parse(found));
      await sleep(interval);
    }
    throw new Error(`Timeout: ${label} not found within ${timeout}ms`);
  }

  // --any-of: regex-OR text wait, returns the first matching alternative.
  if (args[0] === '--any-of') {
    const pattern = args[1];
    if (!pattern) throw new Error('Pattern required after --any-of (e.g. "win|lose|escape")');
    let scope = 'body';
    let timeoutMs = 30000;
    for (let i = 2; i < args.length; i++) {
      if (args[i] === '--scope' || args[i] === '-s') scope = args[++i];
      else if (/^\d+$/.test(args[i])) timeoutMs = parseInt(args[i]);
    }
    const alternatives = pattern.split('|').filter(Boolean);
    if (alternatives.length === 0) throw new Error('--any-of pattern must contain at least one alternative');
    const altsJson = JSON.stringify(alternatives);
    return poll(
      `(function() {
        const el = document.querySelector(${JSON.stringify(scope)});
        if (!el) return null;
        const t = el.innerText || el.textContent || '';
        const alts = ${altsJson};
        for (const a of alts) {
          const idx = t.indexOf(a);
          if (idx !== -1) return { matched: a, snippet: t.substring(Math.max(0, idx - 20), idx + a.length + 60).trim(), len: t.length };
        }
        return null;
      })()`,
      r => `Found "${r.matched}" (page has ${r.len} chars): "...${r.snippet}..."`,
      400, timeoutMs, `any of [${alternatives.join(', ')}]`
    );
  }

  // --selector-stable: wait for selector's textContent to stop changing for stableMs.
  if (args[0] === '--selector-stable') {
    const selector = args[1];
    if (!selector) throw new Error('Selector required after --selector-stable');
    const stableMs = parseInt(args[2]) || 3000;
    const timeoutMs = parseInt(args[3]) || 30000;
    const deadline = Date.now() + Math.min(Math.max(timeoutMs, 500), 300000);
    let lastText = null;
    let stableSince = null;
    while (Date.now() < deadline) {
      const raw = await evalStr(cdp, sid, `(function() {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const t = el.innerText || el.textContent || '';
        return JSON.stringify({ len: t.length, hash: t });
      })()`);
      if (raw === 'null' || raw === '') {
        // selector not present yet — keep polling
        lastText = null; stableSince = null;
        await sleep(300);
        continue;
      }
      const cur = JSON.parse(raw);
      if (lastText !== null && cur.hash === lastText) {
        if (stableSince == null) stableSince = Date.now();
        if (Date.now() - stableSince >= stableMs) {
          return `Selector "${selector}" stable for ${stableMs}ms (${cur.len} chars)`;
        }
      } else {
        lastText = cur.hash;
        stableSince = null;
      }
      await sleep(Math.min(300, stableMs / 4));
    }
    throw new Error(`Timeout: "${selector}" did not stabilise within ${timeoutMs}ms`);
  }

  // --gone: wait for element to DISAPPEAR (e.g. stop button after streaming)
  if (args[0] === '--gone') {
    const selector = args[1];
    if (!selector) throw new Error('CSS selector or @ref required after --gone');
    const timeoutMs = parseInt(args[2]) || 30000;
    const timeout = Math.min(Math.max(timeoutMs, 500), 300000);
    const deadline = Date.now() + timeout;

    // Resolve @ref in a tool-owned isolated world so page code cannot forge
    // connectivity or visibility while we wait.
    if (isRef(selector) && refMap) {
      const frameParsed = parseFrameRef(selector);
      if (frameParsed) {
        frameScopedBackendNode(refState || {}, frameParsed);
      } else {
        const num = parseInt(selector.slice(1));
        if (!refMap.has(num)) throw new Error(formatUnknownRefError(selector, refState || {}));
      }
      while (Date.now() < deadline) {
        try {
          const objectId = await resolveRefNode(cdp, sid, refMap, selector, refState);
          const res = await cdpDomains(cdp).Runtime.callFunctionOn( {
            objectId,
            functionDeclaration: trustedRefPresenceFunctionDeclaration(),
            returnByValue: true,
          }, sid, REF_RESOLVE_TIMEOUT);
          if (res.exceptionDetails) throw new Error(runtimeExceptionMessage(res.exceptionDetails));
          const presence = res.result?.value;
          if (presence?.error) throw new Error(`Trusted ref presence probe failed: ${presence.error}`);
          if (presence?.connected !== true) {
            if (presence?.connected !== false) {
              throw new Error('Trusted ref presence probe returned no connectivity result');
            }
            invalidateRefMapping(refMap, selector, refState);
            return `Element ${selector} is gone (disconnected)`;
          }
          if (presence.visible !== true) return `Element ${selector} is gone (hidden)`;
        } catch (error) {
          if (isStaleRefError(error)) return `Element ${selector} is gone (removed from DOM)`;
          throw error;
        }
        await sleep(300);
      }
      throw new Error(`Timeout: ${selector} still present after ${timeout}ms`);
    }

    // CSS selector mode
    while (Date.now() < deadline) {
      const found = await evalStr(cdp, sid, `document.querySelector(${JSON.stringify(selector)}) ? 'yes' : null`);
      if (found === 'null' || found === '') return `Element "${selector}" is gone`;
      await sleep(300);
    }
    throw new Error(`Timeout: "${selector}" still present after ${timeout}ms`);
  }

  // Parse args: waitfor <selector> [timeout] OR waitfor --text <text> [--scope <sel>] [timeout]
  if (args[0] === '--text') {
    const text = args[1];
    if (!text) throw new Error('Text string required after --text');
    let scope = 'body';
    let timeoutMs = 30000;
    for (let i = 2; i < args.length; i++) {
      if (args[i] === '--scope' || args[i] === '-s') scope = args[++i];
      else timeoutMs = parseInt(args[i]) || 30000;
    }
    return poll(
      `(function() {
        const el = document.querySelector(${JSON.stringify(scope)});
        if (!el) return null;
        const t = el.innerText;
        const idx = t.indexOf(${JSON.stringify(text)});
        if (idx === -1) return null;
        return { len: t.length, snippet: t.substring(Math.max(0, idx - 20), idx + ${text.length} + 80).trim() };
      })()`,
      r => `Found text (page has ${r.len} chars): "...${r.snippet}..."`,
      500, timeoutMs, `text "${text}"`
    );
  }
  // CSS selector mode
  const selector = args[0];
  if (!selector) throw new Error('CSS selector or --text required');
  const timeoutMs = parseInt(args[1]) || 10000;
  try {
    return await poll(
      `(function() {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        return { tag: el.tagName, text: el.textContent.trim().substring(0, 80) };
      })()`,
      r => `Found <${r.tag}> "${r.text}"`,
      200, timeoutMs, `"${selector}"`
    );
  } catch (e) {
    throw new Error(e.message + ' — to wait for specific text content instead, use: waitfor --text "expected text" 120000');
  }
}

function formatInputTextPreview(text) {
  return `${text.substring(0, 40)}${text.length > 40 ? '...' : ''}`;
}

const NON_FILLABLE_INPUT_TYPES = [
  'button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'hidden', 'range', 'color',
];

function fillableControlProbeDeclaration() {
  return `function() {
    const el = this;
    const tag = el && el.tagName ? String(el.tagName).toUpperCase() : '?';
    const type = String(el && el.type || '').toLowerCase();
    const role = String(el && el.getAttribute && el.getAttribute('role') || '').toLowerCase();
    const fillable = !!(el && (
      el.isContentEditable
      || tag === 'TEXTAREA'
      || (tag === 'INPUT' && ${JSON.stringify(NON_FILLABLE_INPUT_TYPES)}.indexOf(type) === -1)
      || role === 'textbox' || role === 'searchbox' || role === 'combobox'
    ));
    return { ok: fillable, fillable, tag, type, role };
  }`;
}

function formControlStateProbeDeclaration() {
  return `function() {
    const el = this;
    if (!el || !el.tagName) return null;
    const tag = String(el.tagName).toLowerCase();
    const type = String(el.type || '').toLowerCase();
    const state = { tag: tag, type: type, id: el.id || '' };
    if (type === 'checkbox' || type === 'radio') state.checked = el.checked === true;
    if (tag === 'select') {
      state.multiple = Boolean(el.multiple);
      state.selected = Array.from(el.selectedOptions || []).map(opt => String(opt.value || ''));
      state.value = String(el.value || '');
    }
    return state;
  }`;
}

function parseFormControlStateSnapshot(raw) {
  if (raw == null || raw === '' || raw === 'null' || raw === 'undefined') return null;
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function shouldSnapshotFormControlState(action, target = {}) {
  const name = String(action || '').toLowerCase();
  if (!['click', 'jsclick', 'select'].includes(name)) return false;
  const input = String(target.input || '').trim();
  if (!input) return false;
  if (target.resolvedBy === 'coordinates' || target.resolvedBy === 'key' || target.resolvedBy === 'history') {
    return false;
  }
  return isRef(input) || isCursorRef(input) || /^[#.[a-zA-Z*]/.test(input);
}

function formControlStateChanged(before, after) {
  if (!before || !after) return false;
  if (Object.prototype.hasOwnProperty.call(before, 'checked')
    || Object.prototype.hasOwnProperty.call(after, 'checked')) {
    if (Boolean(before.checked) !== Boolean(after.checked)) return true;
  }
  const beforeSelected = Array.isArray(before.selected) ? before.selected.join('\0') : null;
  const afterSelected = Array.isArray(after.selected) ? after.selected.join('\0') : null;
  if (beforeSelected != null || afterSelected != null) {
    return beforeSelected !== afterSelected;
  }
  return false;
}

function formatFormControlStateDiff(before, after) {
  const id = after?.id || before?.id || after?.tag || before?.tag || 'control';
  const label = id ? `#${id}` : (after?.tag || 'control');
  if (Object.prototype.hasOwnProperty.call(before || {}, 'checked')
    || Object.prototype.hasOwnProperty.call(after || {}, 'checked')) {
    return `${after?.type || before?.type || 'checkbox'} ${label} checked ${Boolean(before?.checked)} → ${Boolean(after?.checked)}`;
  }
  return `select ${label} selected ${JSON.stringify(before?.selected || [])} → ${JSON.stringify(after?.selected || [])}`;
}

async function snapshotFormControlState(cdp, sid, selector, refMap, refState) {
  if (!selector) return null;
  try {
    if (isRef(selector)) {
      const objectId = await resolveRefNode(cdp, sid, refMap, selector, refState);
      const res = await cdpDomains(cdp).Runtime.callFunctionOn({
        objectId,
        functionDeclaration: `function() { return (${formControlStateProbeDeclaration()}).call(this); }`,
        returnByValue: true,
      }, sid);
      return parseFormControlStateSnapshot(res.result?.value);
    }
    const raw = await evalStr(cdp, sid, `(function() {
      let el;
      try { el = document.querySelector(${JSON.stringify(selector)}); }
      catch (err) { return null; }
      if (!el) return null;
      return (${formControlStateProbeDeclaration()}).call(el);
    })()`);
    return parseFormControlStateSnapshot(raw);
  } catch {
    return null;
  }
}

function fillableControlPageProbe(selector) {
  return `(function() {
    const probe = ${fillableControlProbeDeclaration()};
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { ok: false, error: 'Element not found: ' + ${JSON.stringify(selector)} };
    const info = probe.call(el);
    if (!info.fillable) {
      return {
        ok: false,
        error: 'fill: ' + ${JSON.stringify(selector)} + ' is not a fillable control (<' + info.tag + '>). Use click for links/buttons.',
        tag: info.tag,
      };
    }
    el.scrollIntoView({ block: 'center', inline: 'center' });
    el.focus();
    if (el.isContentEditable) el.textContent = '';
    else el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return { ok: true, tag: info.tag };
  })()`;
}

function notFillableControlError(selector, tag) {
  const shown = selector || '<element>';
  const tagPart = tag ? ` (<${String(tag).toUpperCase()}>)` : '';
  return new Error(`fill: ${shown} is not a fillable control${tagPart}. Use click for links/buttons.`);
}

function fillValueRejectedError(selector, text) {
  const shown = selector || '<element>';
  return new Error(
    `fill: ${shown} did not accept "${formatInputTextPreview(String(text ?? ''))}"; live value is still empty`
  );
}

function fillLiveValueDeclaration() {
  return `function() {
    const el = this;
    const cdpFillLiveValue = true;
    const value = el && el.isContentEditable
      ? String(el.innerText || el.textContent || '')
      : String((el && el.value != null) ? el.value : (el && el.textContent) || '');
    return {
      ok: true,
      cdpFillLiveValue,
      tag: el && el.tagName ? String(el.tagName).toUpperCase() : '?',
      value,
      textContent: String(el && el.textContent || ''),
    };
  }`;
}

function fillLiveValuePageScript(selector) {
  return `(function() {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { ok: false, cdpFillLiveValue: true, error: 'Element not found: ' + ${JSON.stringify(selector)} };
    return (${fillLiveValueDeclaration()}).call(el);
  })()`;
}

function parseFillLiveSnapshot(raw) {
  let parsed = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); } catch { parsed = null; }
  }
  if (!parsed || typeof parsed !== 'object') return { ok: false, value: '', textContent: '' };
  return {
    ok: parsed.ok !== false,
    tag: parsed.tag || '?',
    value: String(parsed.value ?? ''),
    textContent: String(parsed.textContent ?? ''),
  };
}

function fillLiveValueAccepted(snapshot, wanted) {
  const expected = String(wanted ?? '');
  if (!snapshot || snapshot.ok !== true) return false;
  return snapshot.value === expected || snapshot.textContent === expected;
}

async function readFillLiveValue(cdp, sid, selector, refMap, refState) {
  if (isRef(selector)) {
    const objectId = await resolveRefNode(cdp, sid, refMap, selector, refState);
    const res = await cdpDomains(cdp).Runtime.callFunctionOn({
      objectId,
      functionDeclaration: fillLiveValueDeclaration(),
      returnByValue: true,
    }, sid);
    return parseFillLiveSnapshot(res.result?.value);
  }
  const raw = await evalStr(cdp, sid, fillLiveValuePageScript(selector));
  return parseFillLiveSnapshot(raw);
}

async function fillLiveValueAcceptedNow(cdp, sid, selector, text, refMap, refState) {
  try {
    return fillLiveValueAccepted(await readFillLiveValue(cdp, sid, selector, refMap, refState), text);
  } catch {
    return false;
  }
}

async function assertFillLiveValue(cdp, sid, selector, text, refMap, refState) {
  const snapshot = await readFillLiveValue(cdp, sid, selector, refMap, refState).catch(() => ({
    ok: false,
    value: '',
    textContent: '',
  }));
  if (!fillLiveValueAccepted(snapshot, text)) throw fillValueRejectedError(selector, text);
}

async function fillReactStr(cdp, sid, selector, text, refMap, refState) {
  const objectId = isRef(selector)
    ? await resolveRefNode(cdp, sid, refMap, selector, refState)
    : await resolveSelectorNode(cdp, sid, selector);
  const probe = await cdpDomains(cdp).Runtime.callFunctionOn({
    objectId,
    functionDeclaration: fillableControlProbeDeclaration(),
    returnByValue: true,
  }, sid);
  const probed = probe.result?.value || {};
  if (probed.fillable !== true) throw notFillableControlError(selector, probed.tag);
  const res = await cdpDomains(cdp).Runtime.callFunctionOn( {
    objectId,
    functionDeclaration: `function(value) {
      const el = this;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.focus();
      if (el.isContentEditable) {
        el.textContent = value;
      } else {
        const proto = el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : el instanceof HTMLSelectElement
            ? HTMLSelectElement.prototype
            : HTMLInputElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(proto, 'value')
          || Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'value');
        if (descriptor && descriptor.set) descriptor.set.call(el, value);
        else el.value = value;
      }
      const inputEvent = typeof InputEvent === 'function'
        ? new InputEvent('input', { bubbles: true, cancelable: true, composed: true, inputType: 'insertText', data: value })
        : new Event('input', { bubbles: true, cancelable: true });
      el.dispatchEvent(inputEvent);
      el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
      return { tag: el.tagName, value: el.isContentEditable ? el.textContent : el.value };
    }`,
    arguments: [{ value: text }],
    returnByValue: true,
  }, sid);
  const tag = res.result.value?.tag || '?';
  return `React-filled ${isRef(selector) ? selector : `<${tag}>`} with "${formatInputTextPreview(text)}"`;
}

async function fillStr(cdp, sid, selector, text, refMap, refState, opts = {}) {
  if (!selector) throw new Error('CSS selector or @ref required');
  if (text == null) throw new Error('Text required');
  if (opts.react) {
    const out = await fillReactStr(cdp, sid, selector, text, refMap, refState);
    await assertFillLiveValue(cdp, sid, selector, text, refMap, refState);
    return out;
  }
  if (isRef(selector)) {
    const objectId = await resolveRefNode(cdp, sid, refMap, selector, refState);
    const probe = await cdpDomains(cdp).Runtime.callFunctionOn({
      objectId,
      functionDeclaration: `function() {
        const info = (${fillableControlProbeDeclaration()}).call(this);
        if (!info.fillable) return info;
        this.scrollIntoView({block:'center'});
        this.focus();
        if (this.isContentEditable) this.textContent = '';
        else this.value = '';
        this.dispatchEvent(new Event('input',{bubbles:true}));
        return info;
      }`,
      returnByValue: true,
    }, sid);
    const probed = probe.result?.value || {};
    if (probed.fillable !== true) throw notFillableControlError(selector, probed.tag);
    await cdpDomains(cdp).Input.insertText( { text }, sid);
    if (!(await fillLiveValueAcceptedNow(cdp, sid, selector, text, refMap, refState))) {
      await fillReactStr(cdp, sid, selector, text, refMap, refState);
    }
    await assertFillLiveValue(cdp, sid, selector, text, refMap, refState);
    return `Filled ${selector} with "${formatInputTextPreview(text)}"`;
  }
  const result = await evalStr(cdp, sid, fillableControlPageProbe(selector));
  const r = JSON.parse(result);
  if (!r.ok) throw new Error(r.error);
  await cdpDomains(cdp).Input.insertText( { text }, sid);
  if (!(await fillLiveValueAcceptedNow(cdp, sid, selector, text, refMap, refState))) {
    await fillReactStr(cdp, sid, selector, text, refMap, refState);
  }
  await assertFillLiveValue(cdp, sid, selector, text, refMap, refState);
  return `Filled <${r.tag}> with "${formatInputTextPreview(text)}"`;
}

async function selectStr(cdp, sid, selector, value) {
  if (!selector) throw new Error('CSS selector required');
  if (value == null || String(value) === '') throw new Error('Value required');
  const wanted = String(value);
  const expr = `
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, error: 'Element not found: ' + ${JSON.stringify(selector)} };
      if (el.tagName !== 'SELECT') return { ok: false, error: 'Not a <select>: ' + el.tagName };
      const wanted = ${JSON.stringify(wanted)};
      const match = Array.from(el.options).find(opt => opt.value === wanted || String(opt.textContent || '').trim() === wanted);
      if (!match) return { ok: false, error: 'No option value=' + wanted };
      match.selected = true;
      el.value = match.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, text: String(match.textContent || '').trim() || match.value || wanted };
    })()
  `;
  const result = await evalStr(cdp, sid, expr);
  const r = JSON.parse(result);
  if (!r.ok) throw new Error(r.error);
  return `Selected "${r.text}"`;
}

async function fullshotStr(cdp, sid, filePath, targetId) {
  const targetPrefix = targetPrefixForDisplay(targetId);
  await assertNotPdfViewerPage(cdp, sid, { targetPrefix });
  const dpr = await getDpr(cdp, sid);
  const metrics = await cdpDomains(cdp).Page.getLayoutMetrics( {}, sid);
  const width = metrics.cssContentSize?.width || metrics.contentSize?.width || 1280;
  const height = metrics.cssContentSize?.height || metrics.contentSize?.height || 800;
  let viewport = null;
  try {
    viewport = JSON.parse(await evalStr(
      cdp,
      sid,
      'JSON.stringify({w:window.innerWidth,h:window.innerHeight})',
    ));
  } catch {}
  const fitsViewport = fullshotFitsViewport({ width, height }, viewport);
  const params = fitsViewport
    ? { format: 'png' }
    : {
        format: 'png',
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width, height, scale: 1 },
      };
  const hooks = fitsViewport
    ? {}
    : {
        timeoutMs: FULLSHOT_TIMEOUT_MS,
        skipSanityRetry: true,
        failFastOnTimeout: true,
      };

  let capture;
  try {
    capture = await captureScreenshot(cdp, sid, params, hooks);
  } catch (error) {
    if (isScreenshotTimeoutError(error)) {
      throw new Error('fullshot: full-page capture timed out; screenshot is untrusted');
    }
    throw error;
  }
  if (!fitsViewport && capture.fallback === true) {
    throw new Error('fullshot: full-page capture timed out; screenshot is untrusted');
  }

  const out = filePath || resolve(RUNTIME_DIR, `fullshot-${(targetId || 'unknown').slice(0, 8)}.png`);
  writeFileSync(out, Buffer.from(capture.data, 'base64'), { mode: 0o600 });

  const diagnostics = formatScreenshotCaptureDiagnostics(capture);
  const fb = diagnostics ? ` ${diagnostics}` : '';
  return `${out}\nFull-page screenshot saved. Size: ${width}x${height} CSS px, DPR: ${dpr}${fb}\nNote: large pages produce tiny text. Use 'scanshot' for readable segmented capture.`;
}

function fullshotFitsViewport(content = {}, viewport = null) {
  const width = Number(content.width);
  const height = Number(content.height);
  const viewportWidth = Number(viewport?.w);
  const viewportHeight = Number(viewport?.h);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return true;
  if (!Number.isFinite(viewportWidth) || !Number.isFinite(viewportHeight) || viewportWidth <= 0 || viewportHeight <= 0) {
    return true;
  }
  return width <= viewportWidth + 1 && height <= viewportHeight + 1;
}

async function scanshotStr(cdp, sid, targetId) {
  // Get viewport and page dimensions
  const dims = await evalStr(cdp, sid, `JSON.stringify({
    vw: window.innerWidth, vh: window.innerHeight,
    scrollH: document.documentElement.scrollHeight,
    scrollY: Math.round(window.scrollY)
  })`);
  const { vw, vh, scrollH, scrollY: originalY } = JSON.parse(dims);

  // Calculate segments (overlap by 10% to avoid cutting content at boundaries)
  const overlap = Math.round(vh * 0.1);
  const step = vh - overlap;
  const segments = [];
  for (let y = 0; y < scrollH; y += step) {
    segments.push(y);
  }
  // If the last segment is tiny (< 30% viewport), replace it with a
  // bottom-aligned capture so no content is clipped
  if (segments.length > 1) {
    const lastY = segments[segments.length - 1];
    const lastH = scrollH - lastY;
    if (lastH < vh * 0.3) {
      segments.pop();
      // Scroll the last capture so the viewport's bottom edge aligns with page bottom
      const bottomY = Math.max(0, scrollH - vh);
      if (bottomY > segments[segments.length - 1]) {
        segments.push(bottomY);
      }
    }
  }

  const files = [];
  const prefix = (targetId || 'unknown').slice(0, 8);

  let usedFallback = false;
  for (let i = 0; i < segments.length; i++) {
    const y = segments[i];
    // Scroll to segment
    await evalStr(cdp, sid, `window.scrollTo(0, ${y})`);
    await sleep(150); // let rendering settle

    const { data, fallback } = await captureScreenshot(cdp, sid, { format: 'png' });
    if (fallback) usedFallback = true;
    const out = resolve(RUNTIME_DIR, `scanshot-${prefix}-${i + 1}.png`);
    writeFileSync(out, Buffer.from(data, 'base64'), { mode: 0o600 });
    files.push(out);
  }

  // Restore original scroll position
  await evalStr(cdp, sid, `window.scrollTo(0, ${originalY})`);

  const lines = [`Captured ${files.length} segment(s) of ${vw}x${vh} viewport (page height: ${scrollH}px)`];
  if (usedFallback) lines.push('(screenshot fallback — Page.captureScreenshot timed out)');
  for (let i = 0; i < files.length; i++) {
    lines.push(`  [${i + 1}/${files.length}] ${files[i]}`);
  }
  lines.push(`Use the Read tool to view each segment image.`);
  return lines.join('\n');
}

async function stylesStr(cdp, sid, selectorOrArgs, extra = {}) {
  // Share root/selector resolution with text/html for consistent diagnostics.
  let opts;
  if (Array.isArray(selectorOrArgs)) opts = parseTextArgs(selectorOrArgs);
  else if (typeof selectorOrArgs === 'string' || selectorOrArgs == null) {
    opts = parseTextArgs(selectorOrArgs ? [selectorOrArgs] : []);
  } else opts = { selectors: [], root: null };
  const targetPrefix = extra.targetPrefix || opts.targetPrefix || '<target>';
  await assertNotPdfViewerPage(cdp, sid, { targetPrefix });
  const selector = opts.selectors[0] || null;
  if (!selector) throw new Error('CSS selector required');
  const root = opts.root || 'document';
  const expr = `
    (function() {
      function safeQuery(root, sel) { try { return root?.querySelector?.(sel) || null; } catch { return null; } }
      let scope = document.documentElement;
      const rootSetting = ${JSON.stringify(root)};
      if (rootSetting === 'body') scope = document.body || document.documentElement;
      else if (rootSetting === 'auto' || rootSetting === 'default') {
        scope = safeQuery(document, '#root') || safeQuery(document, '[data-reactroot]') || safeQuery(document, 'main') || document.body || document.documentElement;
      } else if (rootSetting !== 'document') {
        scope = safeQuery(document, rootSetting);
        if (!scope) return JSON.stringify({ ok: false, root: rootSetting, reason: 'root-not-found' });
      }
      const el = scope === document || scope === document.documentElement
        ? safeQuery(document, ${JSON.stringify(selector)})
        : (scope.matches && scope.matches(${JSON.stringify(selector)}) ? scope : safeQuery(scope, ${JSON.stringify(selector)}));
      if (!el) return JSON.stringify({ ok: false, root: rootSetting, selector: ${JSON.stringify(selector)} });
      const cs = window.getComputedStyle(el);
      const props = {};
      const keep = [
        'display','visibility','opacity','position','top','right','bottom','left',
        'width','height','min-width','min-height','max-width','max-height',
        'margin','padding','border','box-sizing','overflow','z-index',
        'flex','flex-direction','flex-wrap','align-items','justify-content','gap',
        'grid-template-columns','grid-template-rows',
        'color','background-color','background','font-size','font-weight','font-family',
        'line-height','text-align','text-decoration','text-overflow','white-space',
        'transform','transition','animation','cursor','pointer-events','user-select',
        'box-shadow','border-radius','outline',
      ];
      const skip = new Set([
        'none','normal','auto','0px','0','visible','static','content-box',
        'start','baseline','inherit','default','clip','row','nowrap',
        'rgb(0, 0, 0)','rgba(0, 0, 0, 0)',
      ]);
      const skipPatterns = [
        /^0px /,
        /^rgba\\(0, ?0, ?0, ?0\\)/,
        /^0 [01]+ auto$/,
        /none 0px$/,
        /^all$/,
      ];
      for (const p of keep) {
        const v = cs.getPropertyValue(p);
        if (!v || skip.has(v)) continue;
        if (skipPatterns.some(re => re.test(v))) continue;
        props[p] = v;
      }
      return JSON.stringify({
        ok: true,
        root: rootSetting,
        tag: el.tagName,
        id: el.id,
        cls: el.className?.toString().substring(0, 80),
        props,
      });
    })()
  `;
  const result = await evalStr(cdp, sid, expr);
  let parsed;
  try { parsed = JSON.parse(result); } catch { parsed = null; }
  if (!parsed || parsed.ok === false) {
    const rootLabel = parsed?.root || root || 'document';
    throw new Error(
      `styles: no element matched within root "${rootLabel}" for selector ${selector}. ` +
      `Fallback: cdp eval ${targetPrefix} "getComputedStyle(document.querySelector(${JSON.stringify(selector)}))"`
    );
  }
  // Legacy path: eval may still return a plain object if script changes.
  const r = typeof parsed === 'object' && parsed.props ? parsed : JSON.parse(result);
  const header = '<' + r.tag + '>' + (r.id ? '#' + r.id : '') + (r.cls ? '.' + r.cls.split(' ').join('.') : '');
  const lines = [header];
  for (const [k, v] of Object.entries(r.props || {})) {
    lines.push('  ' + k + ': ' + v);
  }
  return lines.join('\n');
}


// ---------------------------------------------------------------------------
// components — React/Vue component tree + state (MVP)
// ---------------------------------------------------------------------------

function parseComponentsArgs(args = []) {
  const fopts = parseFormatArgs(args, ['text', 'json']);
  const opts = {
    format: fopts.format,
    depth: 6,
    ref: null,
    selector: null,
    unsafeFull: false,
    maxChars: 2000,
  };
  const positional = [];
  for (let i = 0; i < fopts.args.length; i++) {
    const a = fopts.args[i];
    if (a === '--depth' || a === '-d') {
      const n = parseInt(fopts.args[++i], 10);
      if (!Number.isFinite(n) || n <= 0) throw new Error('components: --depth requires a positive integer');
      opts.depth = Math.min(n, 20);
    } else if (a === '--unsafe-full') {
      opts.unsafeFull = true;
    } else if (a === '--max-chars') {
      const n = Number(fopts.args[++i]);
      if (!Number.isInteger(n) || n < 80 || n > 20000) {
        throw new Error('components: --max-chars requires an integer between 80 and 20000');
      }
      opts.maxChars = n;
    } else if (/^@(?:\d+|c\d+|f\d+:\d+)$/.test(String(a))) {
      opts.ref = a;
    } else if (String(a).startsWith('@')) {
      throw new Error(`components: invalid ref ${a}`);
    } else if (String(a).startsWith('-')) {
      throw new Error(`components: unknown argument ${a}`);
    } else {
      positional.push(a);
    }
  }
  if (!opts.ref && positional[0]) {
    opts.selector = positional[0];
  }
  return opts;
}

function sanitizeComponentValue(value, { unsafeFull = false, maxChars = 2000 } = {}) {
  const safeValue = unsafeFull ? value : redactSensitiveArtifactValue(value);
  let serialized;
  try {
    serialized = JSON.stringify(safeValue);
  } catch {
    serialized = String(safeValue);
  }
  if (serialized === undefined) serialized = 'undefined';
  const originalChars = serialized.length;
  if (unsafeFull || originalChars <= maxChars) {
    return { value: safeValue, truncated: false, originalChars };
  }
  return {
    value: {
      truncated: true,
      originalChars,
      preview: serialized.slice(0, maxChars),
    },
    truncated: true,
    originalChars,
  };
}

function sanitizeComponentResult(parsed = {}, opts = {}) {
  if (!parsed?.ok) return parsed;
  const props = sanitizeComponentValue(parsed.props || {}, opts);
  const state = sanitizeComponentValue(parsed.state || {}, opts);
  return {
    ...parsed,
    props: props.value,
    state: state.value,
    privacy: {
      redaction: opts.unsafeFull ? 'unsafe-full' : 'default-redacted',
    },
    limits: {
      maxCharsPerSection: opts.unsafeFull ? null : opts.maxChars,
      props: { truncated: props.truncated, originalChars: props.originalChars },
      state: { truncated: state.truncated, originalChars: state.originalChars },
    },
  };
}

function frameworkDetectorScript() {
  return `(function() {
    try {
      const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
      if (hook?.renderers?.size > 0) {
        const renderer = Array.from(hook.renderers.values())[0];
        return JSON.stringify({ framework: 'react', version: renderer?.version || 'unknown', source: 'devtools-hook' });
      }
    } catch {}
    try {
      if (window.__VUE__) return JSON.stringify({ framework: 'vue', version: window.__VUE__.version || 'unknown', source: '__VUE__' });
    } catch {}
    try {
      const vueApp = document.querySelector('#app')?.__vue_app__ || document.querySelector('[data-v-app]')?.__vue_app__;
      if (vueApp) return JSON.stringify({ framework: 'vue', version: vueApp.version || '3', source: 'vue_app' });
    } catch {}
    try {
      const el = document.querySelector('[ng-version]');
      if (el) return JSON.stringify({ framework: 'angular', version: el.getAttribute('ng-version') || 'unknown', source: 'ng-version' });
    } catch {}
    // Fiber present without DevTools hook (dev builds)
    try {
      const roots = document.querySelectorAll('[data-reactroot], #root, #__next, #app, [data-reactroot]');
      for (const root of roots) {
        const key = Object.keys(root).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
        if (key) return JSON.stringify({ framework: 'react', version: 'fiber', source: 'fiber-key' });
      }
    } catch {}
    return JSON.stringify({ framework: null });
  })()`;
}

function componentTreeRedactionHelpersScript() {
  return `
    const sensitiveKey = key => /(?:pass(?:word)?|secret|token|api[_-]?key|auth|session|cookie|credential|private[_-]?key)/i.test(String(key || ''));
    function redactString(value) {
      return String(value)
        .replace(/(authorization\\s*[:=]\\s*(?:bearer\\s+)?)[^\\s,;]+/ig, '$1[REDACTED]')
        .replace(/(bearer\\s+)[A-Za-z0-9._~+\\/=-]+/ig, '$1[REDACTED]');
    }
    function redactNested(value, key = '', depth = 0, seen = new WeakSet()) {
      if (sensitiveKey(key)) return '[REDACTED]';
      if (value == null) return value;
      if (typeof value === 'string') return redactString(value);
      if (typeof value !== 'object') return value;
      if (seen.has(value)) return '[circular]';
      if (depth >= 4) return '[nested]';
      seen.add(value);
      if (Array.isArray(value)) return value.slice(0, 20).map(item => redactNested(item, '', depth + 1, seen));
      const out = {};
      for (const [entryKey, entryValue] of Object.entries(value).slice(0, 20)) {
        out[entryKey] = redactNested(entryValue, entryKey, depth + 1, seen);
      }
      return out;
    }
  `;
}

function reactComponentsTreeScript(maxDepth = 6, { redactSensitive = true } = {}) {
  return `(function() {
    const maxDepth = ${Number(maxDepth) || 6};
    const redactSensitive = ${redactSensitive ? 'true' : 'false'};
    ${componentTreeRedactionHelpersScript()}
    function safeName(type) {
      if (!type) return null;
      if (typeof type === 'string') return type;
      return type.displayName || type.name || null;
    }
    function summarizeProps(props) {
      if (!props || typeof props !== 'object') return '';
      const parts = [];
      for (const [k, v] of Object.entries(props)) {
        if (k === 'children' || typeof v === 'function') continue;
        let s;
        try {
          const safeValue = redactSensitive ? redactNested(v, k) : v;
          s = typeof safeValue === 'string' ? JSON.stringify(safeValue) : (typeof safeValue === 'object' ? JSON.stringify(safeValue) : String(safeValue));
        }
        catch { s = '[unserializable]'; }
        if (s.length > 40) s = s.slice(0, 37) + '...';
        parts.push(k + '=' + s);
        if (parts.length >= 4) { parts.push('...'); break; }
      }
      return parts.length ? ' ' + parts.join(' ') : '';
    }
    function walk(fiber, depth, lines, seen) {
      if (!fiber || depth > maxDepth) return;
      const id = fiber._debugID || fiber.actualStartTime || Math.random();
      if (seen.has(fiber)) return;
      seen.add(fiber);
      const name = safeName(fiber.type);
      if (name && name.length <= 60 && !/^[a-z]/.test(name)) {
        lines.push('  '.repeat(depth) + '<' + name + summarizeProps(fiber.memoizedProps) + '>');
        if (fiber.child) walk(fiber.child, depth + 1, lines, seen);
      } else {
        if (fiber.child) walk(fiber.child, depth, lines, seen);
      }
      if (fiber.sibling) walk(fiber.sibling, depth, lines, seen);
    }
    const roots = document.querySelectorAll('[data-reactroot], #root, #__next, #app, body > div');
    for (const root of roots) {
      const key = Object.keys(root).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
      if (!key) continue;
      let fiber = root[key];
      // Climb to root fiber
      let guard = 0;
      while (fiber?.return && guard++ < 50) fiber = fiber.return;
      const lines = [];
      walk(fiber, 0, lines, new Set());
      if (lines.length) {
        return JSON.stringify({ ok: true, framework: 'react', lines: lines.slice(0, 200), truncated: lines.length > 200 });
      }
    }
    return JSON.stringify({ ok: false, framework: 'react', reason: 'fiber-tree-not-found' });
  })()`;
}

function vueComponentsTreeScript(maxDepth = 6, { redactSensitive = true } = {}) {
  return `(function() {
    const maxDepth = ${Number(maxDepth) || 6};
    const redactSensitive = ${redactSensitive ? 'true' : 'false'};
    ${componentTreeRedactionHelpersScript()}
    function walk(vm, depth, lines) {
      if (!vm || depth > maxDepth) return;
      const name = vm.$options?.name || vm.type?.name || vm.$.type?.name || 'Anonymous';
      const props = vm.$props || vm.props || {};
      const propParts = [];
      try {
        for (const [k, v] of Object.entries(props || {})) {
          if (typeof v === 'function') continue;
          const safeValue = redactSensitive ? redactNested(v, k) : v;
          let s = typeof safeValue === 'object' ? JSON.stringify(safeValue) : String(safeValue);
          if (s.length > 30) s = s.slice(0, 27) + '...';
          propParts.push(k + '=' + s);
          if (propParts.length >= 3) break;
        }
      } catch {}
      lines.push('  '.repeat(depth) + '<' + name + (propParts.length ? ' ' + propParts.join(' ') : '') + '>');
      const children = vm.$children || vm.subTree?.component?.subTree?.children || [];
      if (Array.isArray(children)) {
        for (const child of children) {
          const next = child?.component || child;
          if (next) walk(next, depth + 1, lines);
        }
      }
    }
    const lines = [];
    const appEl = document.querySelector('#app') || document.querySelector('[data-v-app]');
    const app = appEl?.__vue_app__;
    if (app?._instance) {
      walk(app._instance, 0, lines);
    } else if (appEl?.__vue__) {
      walk(appEl.__vue__, 0, lines);
    }
    if (!lines.length) return JSON.stringify({ ok: false, framework: 'vue', reason: 'vue-tree-not-found' });
    return JSON.stringify({ ok: true, framework: 'vue', lines: lines.slice(0, 200), truncated: lines.length > 200 });
  })()`;
}

function reactComponentAtElementScript() {
  return `function(el) {
    if (!el) return JSON.stringify({ ok: false, reason: 'no-element' });
    const key = Object.keys(el).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
    if (!key) return JSON.stringify({ ok: false, reason: 'no-fiber-on-element' });
    let fiber = el[key];
    let guard = 0;
    while (fiber && guard++ < 40) {
      const name = fiber.type?.displayName || fiber.type?.name;
      if (typeof name === 'string' && name.length && name[0] === name[0].toUpperCase()) {
        const props = {};
        try {
          for (const [k, v] of Object.entries(fiber.memoizedProps || {})) {
            if (k === 'children' || typeof v === 'function') continue;
            try { props[k] = typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v; }
            catch { props[k] = String(v).slice(0, 80); }
            if (Object.keys(props).length >= 12) break;
          }
        } catch {}
        const state = {};
        try {
          let hook = fiber.memoizedState;
          let i = 0;
          while (hook && i < 8) {
            if (hook.memoizedState !== undefined && typeof hook.memoizedState !== 'function') {
              try { state['hook' + i] = JSON.parse(JSON.stringify(hook.memoizedState)); }
              catch { state['hook' + i] = String(hook.memoizedState).slice(0, 80); }
            }
            hook = hook.next;
            i++;
          }
        } catch {}
        return JSON.stringify({ ok: true, name, props, state });
      }
      fiber = fiber.return;
    }
    return JSON.stringify({ ok: false, reason: 'no-named-component' });
  }`;
}

async function resolveComponentRefObjectId(cdp, sid, ref, refMap, refState) {
  if (!isCursorRef(ref)) {
    return resolveRefNode(cdp, sid, refMap, ref, refState, { returnRealm: 'page' });
  }
  const rect = resolveCursorRef(refMap, ref, refState);
  const result = await cdpDomains(cdp).Runtime.evaluate( {
    expression: `document.elementFromPoint(${rect.x + rect.w / 2}, ${rect.y + rect.h / 2})`,
    returnByValue: false,
    awaitPromise: false,
  }, sid, REF_RESOLVE_TIMEOUT);
  if (result.exceptionDetails) throw new Error(runtimeExceptionMessage(result.exceptionDetails));
  const objectId = result.result?.objectId;
  if (!objectId) throw new Error(`Unknown cursor ref: ${ref}. Run "perceive -C -d 8" to refresh cursor refs, or use a stable CSS selector.`);
  return objectId;
}

async function componentsStr(cdp, sid, args = [], refMap = new Map(), refState = null) {
  const opts = parseComponentsArgs(args);
  const detectionRaw = await evalStr(cdp, sid, frameworkDetectorScript());
  let detection;
  try { detection = JSON.parse(detectionRaw); } catch { detection = { framework: null }; }
  if (!detection.framework) {
    const msg = 'No supported framework detected (React fiber/DevTools, Vue, or Angular ng-version).';
    return opts.format === 'json'
      ? formatJson({ schema: 'chrome-cdp-ex.components.v1', framework: null, ok: false, message: msg })
      : msg;
  }
  if (detection.framework === 'angular') {
    const msg = `Angular ${detection.version} detected; tree extraction not yet supported. Use eval for ng probes.`;
    return opts.format === 'json'
      ? formatJson({ schema: 'chrome-cdp-ex.components.v1', framework: 'angular', version: detection.version, ok: false, message: msg })
      : msg;
  }

  if ((opts.ref || opts.selector) && detection.framework !== 'react') {
    const target = opts.ref || opts.selector;
    const reason = 'target-inspection-unsupported';
    const message = `Targeted component props/state inspection is not supported for ${detection.framework}; inspect the component tree or use a React dev build.`;
    return opts.format === 'json'
      ? formatJson({
          schema: 'chrome-cdp-ex.components.v1',
          framework: detection.framework,
          version: detection.version,
          target,
          ok: false,
          reason,
          message,
        })
      : `components: ${message}`;
  }

  if (opts.ref || opts.selector) {
    if (opts.ref) {
      try {
        const objectId = await resolveComponentRefObjectId(cdp, sid, opts.ref, refMap, refState);
        if (objectId && detection.framework === 'react') {
            const result = await cdpDomains(cdp).Runtime.callFunctionOn( {
              objectId,
              functionDeclaration: `function() { return (${reactComponentAtElementScript()})(this); }`,
              returnByValue: true,
            }, sid);
            if (result.exceptionDetails) throw new Error(runtimeExceptionMessage(result.exceptionDetails));
            let parsed;
            try { parsed = JSON.parse(result.result?.value || '{}'); } catch { parsed = { ok: false }; }
            parsed = sanitizeComponentResult(parsed, opts);
            if (opts.format === 'json') {
              return formatJson({ schema: 'chrome-cdp-ex.components.v1', framework: detection.framework, version: detection.version, target: opts.ref, ...parsed });
            }
            if (!parsed.ok) return `components: could not resolve component for ${opts.ref} (${parsed.reason || 'unknown'})`;
            const lines = [`Component: <${parsed.name}>`];
            lines.push(`  Props: ${JSON.stringify(parsed.props || {})}`);
            lines.push(`  State/hooks: ${JSON.stringify(parsed.state || {})}`);
            return lines.join('\n');
        }
      } catch (e) {
        if (opts.format === 'json') {
          return formatJson({ schema: 'chrome-cdp-ex.components.v1', framework: detection.framework, ok: false, error: e.message });
        }
        return `components: ${e.message}`;
      }
    }
    if (opts.selector) {
      const raw = await evalStr(cdp, sid, `(${reactComponentAtElementScript()})(document.querySelector(${JSON.stringify(opts.selector)}))`);
      let parsed;
      try { parsed = JSON.parse(raw); } catch { parsed = { ok: false, reason: 'parse-failed' }; }
      parsed = sanitizeComponentResult(parsed, opts);
      if (opts.format === 'json') {
        return formatJson({ schema: 'chrome-cdp-ex.components.v1', framework: detection.framework, version: detection.version, target: opts.selector, ...parsed });
      }
      if (!parsed.ok) return `components: could not resolve component for ${opts.selector} (${parsed.reason || 'unknown'})`;
      return [`Component: <${parsed.name}>`, `  Props: ${JSON.stringify(parsed.props || {})}`, `  State/hooks: ${JSON.stringify(parsed.state || {})}`].join('\n');
    }
  }

  const treeRaw = detection.framework === 'vue'
    ? await evalStr(cdp, sid, vueComponentsTreeScript(opts.depth, { redactSensitive: !opts.unsafeFull }))
    : await evalStr(cdp, sid, reactComponentsTreeScript(opts.depth, { redactSensitive: !opts.unsafeFull }));
  let tree;
  try { tree = JSON.parse(treeRaw); } catch { tree = { ok: false, reason: 'parse-failed' }; }
  if (opts.format === 'json') {
    return formatJson({
      schema: 'chrome-cdp-ex.components.v1',
      framework: detection.framework,
      version: detection.version,
      source: detection.source,
      depth: opts.depth,
      privacy: { redaction: opts.unsafeFull ? 'unsafe-full' : 'default-redacted' },
      ...tree,
    });
  }
  if (!tree.ok) {
    return `${detection.framework} ${detection.version || ''} detected but component tree not found (${tree.reason || 'unknown'}). Use a dev build or framework DevTools hooks.`.replace(/\\s+/g, ' ').trim();
  }
  const header = `[${detection.framework} ${detection.version || ''} detected]`;
  return [header, '', ...(tree.lines || []), tree.truncated ? `... truncated` : null].filter(Boolean).join('\n');
}

async function cookiesStr(cdp, sid) {
  const { cookies } = await cdpDomains(cdp).Network.getCookies( {}, sid);
  if (!cookies || cookies.length === 0) return 'No cookies';
  // Dynamic column width based on actual cookie names
  const nameW = Math.min(Math.max(...cookies.map(c => c.name.length)) + 2, 32);
  const lines = [];
  for (const c of cookies) {
    const val = c.value.length > 30 ? c.value.substring(0, 30) + '...' : c.value;
    const flags = [c.httpOnly && 'HttpOnly', c.secure && 'Secure', c.sameSite].filter(Boolean).join(' ');
    const exp = c.expires > 0 ? new Date(c.expires * 1000).toISOString().slice(0, 19) : 'session';
    lines.push(`${c.name.padEnd(nameW)} ${val.padEnd(34)} ${c.domain.padEnd(20)} ${exp.padEnd(20)} ${flags}`);
  }
  return lines.join('\n');
}

// Checkpoint/restore: serialize the minimum browser state needed to resume a
// real-page exploration flow without pretending to snapshot the whole browser.
function checkpointPageScript() {
  return `(function() {
    function dumpStorage(storage) {
      const out = {};
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        out[key] = storage.getItem(key);
      }
      return out;
    }
    return JSON.stringify({
      url: location.href,
      title: document.title,
      origin: location.origin,
      localStorage: dumpStorage(localStorage),
      sessionStorage: dumpStorage(sessionStorage)
    });
  })()`;
}

function sanitizeCheckpointCookies(cookies = [], { redactValues = true } = {}) {
  return cookies.map(cookie => {
    const out = {};
    for (const key of ['name', 'value', 'domain', 'path', 'secure', 'httpOnly', 'sameSite']) {
      if (cookie[key] !== undefined) out[key] = key === 'value' && redactValues ? REDACTED_VALUE : cookie[key];
    }
    if (Number.isFinite(cookie.expires) && cookie.expires > 0) out.expires = cookie.expires;
    if (redactValues && out.value !== undefined) out.redacted = ['value'];
    return out;
  }).filter(cookie => cookie.name);
}

function sanitizeCheckpointStorage(storage = {}, { redactValues = true } = {}) {
  if (!storage || typeof storage !== 'object') return {};
  if (!redactValues) return { ...storage };
  return Object.fromEntries(Object.entries(storage).map(([key, value]) => [
    key,
    isSensitiveDataKey(key) ? REDACTED_VALUE : redactSensitiveArtifactValue(value, key),
  ]));
}

function parseCheckpointArgs(args = []) {
  const rest = [];
  let unsafeFullCapture = false;
  for (const arg of args || []) {
    if (arg === '--unsafe-full' || arg === '--full' || arg === '--include-secrets') {
      unsafeFullCapture = true;
    } else {
      rest.push(arg);
    }
  }
  return { unsafeFullCapture, args: rest };
}

async function checkpointModel(cdp, sid, { now = Date.now(), unsafeFullCapture = false } = {}) {
  const raw = await evalStr(cdp, sid, checkpointPageScript());
  let pageState;
  try {
    pageState = JSON.parse(raw);
  } catch (e) {
    throw new Error(`checkpoint: failed to read page state (${e.message})`);
  }
  let cookies = [];
  try {
    const res = await cdpDomains(cdp).Network.getCookies( {}, sid);
    cookies = sanitizeCheckpointCookies(res.cookies || [], { redactValues: !unsafeFullCapture });
  } catch {}
  return {
    schema: 'chrome-cdp-ex.checkpoint.v1',
    ts: now,
    privacy: {
      redaction: unsafeFullCapture ? 'unsafe-full' : 'default-redacted',
      cookies: !unsafeFullCapture,
      storage: !unsafeFullCapture,
      warning: unsafeFullCapture
        ? 'This checkpoint intentionally includes raw cookie and storage values. Treat it as a secret artifact.'
        : 'Cookie values and sensitive storage values are redacted by default. Use --unsafe-full only when restore fidelity is required and the artifact can be protected.',
    },
    page: {
      url: pageState.url || '',
      title: pageState.title || '',
      origin: pageState.origin || '',
    },
    storage: {
      localStorage: sanitizeCheckpointStorage(pageState.localStorage || {}, { redactValues: !unsafeFullCapture }),
      sessionStorage: sanitizeCheckpointStorage(pageState.sessionStorage || {}, { redactValues: !unsafeFullCapture }),
    },
    cookies,
  };
}

async function checkpointStr(cdp, sid, { format = 'text', now = Date.now(), unsafeFullCapture = false } = {}) {
  const model = await checkpointModel(cdp, sid, { now, unsafeFullCapture });
  if (format === 'json') return formatJson(model);
  const localCount = Object.keys(model.storage.localStorage || {}).length;
  const sessionCount = Object.keys(model.storage.sessionStorage || {}).length;
  return [
    'Checkpoint captured',
    `URL: ${model.page.url}`,
    `Privacy: ${model.privacy.redaction}`,
    `Storage: local ${localCount}, session ${sessionCount}`,
    `Cookies: ${model.cookies.length}`,
    unsafeFullCapture
      ? 'Warning: raw cookie and storage values are included. Protect this artifact like a secret.'
      : 'Values: cookie values and sensitive storage values are redacted by default.',
    unsafeFullCapture
      ? 'Next: save `checkpoint --unsafe-full --format json` output and restore with `restore --file <path>`.'
      : 'Next: use `checkpoint --unsafe-full --format json` only when restore fidelity is required.',
  ].join('\n');
}

function parseCheckpointArtifact(raw) {
  let artifact;
  try {
    artifact = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) {
    throw new Error(`restore: invalid checkpoint JSON (${e.message})`);
  }
  if (!artifact || typeof artifact !== 'object') throw new Error('restore: checkpoint artifact must be a JSON object');
  if (artifact.schema !== 'chrome-cdp-ex.checkpoint.v1') {
    throw new Error(`restore: unsupported checkpoint schema ${artifact.schema || '(missing)'}`);
  }
  if (!artifact.page?.url) throw new Error('restore: checkpoint.page.url is required');
  validateUrl(artifact.page.url);
  return artifact;
}

function parseRestoreArgs(args, { reader = readFileSync } = {}) {
  const fopts = parseFormatArgs((args || []).filter(a => a !== undefined && a !== null), ['text', 'json']);
  const tokens = fopts.args;
  const positional = [];
  const finish = (result) => ({ ...result, format: fopts.format });
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '--json') {
      const raw = tokens.slice(i + 1).join(' ').trim();
      if (!raw) throw new Error('restore --json requires a checkpoint JSON payload');
      return finish({ artifact: parseCheckpointArtifact(raw), source: 'inline JSON' });
    }
    if (token === '--file' || token === '-f') {
      const filePath = tokens[++i];
      if (!filePath) throw new Error('restore --file requires a checkpoint JSON path');
      return finish({ artifact: parseCheckpointArtifact(reader(filePath, 'utf8')), source: filePath });
    }
    positional.push(token);
  }
  const raw = positional.join(' ').trim();
  if (!raw) throw new Error('restore requires --file <path> or --json <checkpoint-json>');
  if (raw.startsWith('{')) return finish({ artifact: parseCheckpointArtifact(raw), source: 'inline JSON' });
  return finish({ artifact: parseCheckpointArtifact(reader(positional[0], 'utf8')), source: positional[0] });
}

function redactRestoreCommandArgs(args = []) {
  const positionalRaw = args.join(' ').trim();
  if (args.length && !args.some(arg => arg === '--json' || arg === '--file' || arg === '-f')) {
    return [positionalRaw.startsWith('{') ? '[checkpoint-json-redacted]' : '[checkpoint-path-redacted]'];
  }
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    out.push(arg);
    if (arg === '--json') {
      out.push('[checkpoint-json-redacted]');
      break;
    }
    if (arg === '--file' || arg === '-f') {
      if (args[i + 1]) {
        i += 1;
        out.push('[checkpoint-path-redacted]');
      }
    }
  }
  return out.length ? out : ['restore'];
}

function collectExternalInputStrings(value, out, depth = 0) {
  if (depth > 8 || out.length >= 64) return;
  if (typeof value === 'string') {
    if (value) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectExternalInputStrings(item, out, depth + 1);
    return;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectExternalInputStrings(item, out, depth + 1);
  }
}

function redactExternalInputActionError(error, action, args = []) {
  const original = actionFailureMessage(error);
  let message = original;
  const replacements = [];
  if (action === 'upload' && args[1]) {
    replacements.push([args[1], '[upload-path-redacted]']);
    for (const filePath of args[1].split(',').map(value => value.trim()).filter(Boolean)) {
      replacements.push([filePath, '[upload-path-redacted]']);
    }
  } else if (action === 'inject' && args.length > 1) {
    const payload = args.slice(1).join(' ').trim();
    if (payload) {
      const marker = args[0] === '--css' ? '[inject-content-redacted]' : '[inject-url-redacted]';
      replacements.push([payload, marker]);
    }
  } else if (action === 'restore') {
    let inlineJson = null;
    for (let i = 0; i < args.length; i += 1) {
      if ((args[i] === '--file' || args[i] === '-f') && args[i + 1]) {
        replacements.push([args[i + 1], '[checkpoint-path-redacted]']);
        i += 1;
      } else if (args[i] === '--json') {
        inlineJson = args.slice(i + 1).join(' ').trim();
        break;
      }
    }
    if (!args.some(arg => arg === '--json' || arg === '--file' || arg === '-f')) {
      const positional = args.join(' ').trim();
      if (positional.startsWith('{')) inlineJson = positional;
      else if (args[0]) replacements.push([args[0], '[checkpoint-path-redacted]']);
    }
    if (inlineJson) {
      replacements.push([inlineJson, '[checkpoint-json-redacted]']);
      try {
        const values = [];
        collectExternalInputStrings(JSON.parse(inlineJson), values);
        for (const value of values) replacements.push([value, '[checkpoint-value-redacted]']);
      } catch {}
    }
  }
  replacements.sort((left, right) => right[0].length - left[0].length);
  for (const [value, marker] of replacements) {
    if (value) message = message.split(value).join(marker);
  }
  message = message
    .replace(/\b(?:https?|file):\/\/[^\s'"\])]+/gi, '[external-url-redacted]')
    .replace(/(^|[\s'"])((?:\/(?!\/)[^\s'"]+)+|[A-Za-z]:\\[^\s'"]+)/g, '$1[external-path-redacted]');
  if (message === original) return error;
  const redacted = new Error(message, { cause: error });
  redacted.name = error?.name || 'Error';
  if (error?.code !== undefined) redacted.code = error.code;
  return redacted;
}

function redactRestoreActionError(error, args = []) {
  return redactExternalInputActionError(error, 'restore', args);
}

function checkpointCookieToSetCookieParams(cookie, url) {
  const params = { url };
  for (const key of ['name', 'value', 'domain', 'path', 'secure', 'httpOnly', 'sameSite', 'expires']) {
    if (cookie[key] !== undefined) params[key] = cookie[key];
  }
  return params;
}

function isRestorableCheckpointCookie(cookie) {
  if (!cookie || typeof cookie !== 'object') return false;
  if (!cookie.name) return false;
  if (cookie.value === undefined || cookie.value === null) return false;
  if (cookie.value === REDACTED_VALUE) return false;
  if (Array.isArray(cookie.redacted) && cookie.redacted.includes('value')) return false;
  return true;
}

function cookiesForRestore(cookies = []) {
  return cookies.filter(isRestorableCheckpointCookie);
}

function restoreStorageScript(storage = {}) {
  const local = storage.localStorage || {};
  const session = storage.sessionStorage || {};
  return `(function() {
    const localItems = ${JSON.stringify(local)};
    const sessionItems = ${JSON.stringify(session)};
    localStorage.clear();
    for (const [key, value] of Object.entries(localItems)) localStorage.setItem(key, value);
    sessionStorage.clear();
    for (const [key, value] of Object.entries(sessionItems)) sessionStorage.setItem(key, value);
    return JSON.stringify({ localStorage: Object.keys(localItems).length, sessionStorage: Object.keys(sessionItems).length });
  })()`;
}

async function navigateForRestore(cdp, sid, url) {
  await cdpDomains(cdp).Page.enable( {}, sid).catch(() => {});
  let loadEvent = cdp.waitForEvent('Page.loadEventFired', NAVIGATION_TIMEOUT);
  try {
    const nav = await cdpDomains(cdp).Page.navigate( { url }, sid, 5000);
    if (nav.errorText) {
      loadEvent.cancel();
      throw new Error(nav.errorText);
    }
    if (nav.loaderId) {
      await loadEvent.promise;
    } else {
      loadEvent.cancel();
    }
    return 'Page.navigate';
  } catch (e) {
    loadEvent.cancel();
    if (!isTimeoutError(e, ['Page.navigate'])) throw e;
    loadEvent = cdp.waitForEvent('Page.loadEventFired', NAVIGATION_TIMEOUT);
    await evalStr(cdp, sid, `(function() { location.assign(${JSON.stringify(url)}); return 'navigating'; })()`);
    await loadEvent.promise.catch(() => {});
    return 'location.assign fallback';
  }
}

async function restoreCheckpointStr(cdp, sid, args) {
  const { artifact } = parseRestoreArgs(args);
  const url = artifact.page.url;
  const cookies = cookiesForRestore(artifact.cookies || []);
  let cookieSet = 0;
  for (const cookie of cookies) {
    const result = await cdpDomains(cdp).Network.setCookie( checkpointCookieToSetCookieParams(cookie, url), sid);
    if (result && result.success === false) throw new Error(`restore: failed to set cookie ${cookie.name}`);
    cookieSet++;
  }

  let currentUrl = null;
  try { currentUrl = await evalStr(cdp, sid, 'location.href'); } catch {}
  const navigationMethod = currentUrl === url
    ? 'already at checkpoint URL'
    : await navigateForRestore(cdp, sid, url);
  await evalStr(cdp, sid, restoreStorageScript(artifact.storage || {}));

  const localCount = Object.keys(artifact.storage?.localStorage || {}).length;
  const sessionCount = Object.keys(artifact.storage?.sessionStorage || {}).length;
  return [
    `Restored checkpoint: ${url}`,
    `Navigation: ${navigationMethod}`,
    `Storage: local ${localCount}, session ${sessionCount}; cookies: ${cookieSet}`,
    'Refs were invalidated; run `perceive` before using @refs again.',
  ].join('\n');
}

function parseLoadAllArgs(args = []) {
  const positional = [];
  let timeoutMs = LOADALL_DEFAULT_TIMEOUT_MS;
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === '--timeout-ms') {
      timeoutMs = parseNonNegativeInteger(args[++i], 'loadall: --timeout-ms');
    } else if (String(token).startsWith('--timeout-ms=')) {
      timeoutMs = parseNonNegativeInteger(String(token).slice('--timeout-ms='.length), 'loadall: --timeout-ms');
    } else if (String(token).startsWith('-')) {
      throw new Error(`loadall: unknown argument ${token}`);
    } else {
      positional.push(token);
    }
  }
  const selector = positional[0];
  if (!selector) throw new Error('CSS selector required');
  let intervalMs = LOADALL_DEFAULT_INTERVAL_MS;
  if (positional[1] != null) {
    intervalMs = parseNonNegativeInteger(positional[1], 'loadall: interval-ms');
  }
  if (positional.length > 2) throw new Error(`loadall: unknown argument ${positional[2]}`);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('loadall: --timeout-ms must be a positive integer');
  }
  return {
    selector,
    intervalMs,
    timeoutMs: Math.min(timeoutMs, LOADALL_MAX_TIMEOUT_MS),
  };
}

// Load-more: repeatedly click a button/selector until it disappears
async function loadAllStr(cdp, sid, selector, intervalMs = LOADALL_DEFAULT_INTERVAL_MS, options = {}) {
  if (!selector) throw new Error('CSS selector required');
  const timeoutMs = Math.min(
    Math.max(Number(options.timeoutMs) || LOADALL_DEFAULT_TIMEOUT_MS, 1),
    LOADALL_MAX_TIMEOUT_MS,
  );
  let clicks = 0;
  let seen = false;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    throwIfRequestAborted('loadall: aborted');
    if (Date.now() >= deadline) {
      if (!seen) throw new Error(`Element not found: ${selector}`);
      throw new Error(`loadall: "${selector}" still present after ${clicks} click(s) (timeout ${timeoutMs}ms)`);
    }
    const expr = `
      (function() {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const rect = el.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      })()
    `;
    const result = await evalStr(cdp, sid, expr);
    if (result === 'null' || result === '') {
      if (!seen) throw new Error(`Element not found: ${selector}`);
      return `Clicked "${selector}" ${clicks} time(s) until it disappeared`;
    }
    seen = true;
    const r = JSON.parse(result);
    await dispatchClick(cdp, sid, r.x, r.y, { selector, x: r.x, y: r.y });
    clicks++;
    throwIfRequestAborted('loadall: aborted');
    const remaining = deadline - Date.now();
    if (remaining <= 0) continue;
    await sleep(Math.min(Math.max(0, intervalMs), remaining));
  }
}

async function annotshotStr(cdp, sid, targetId, refMap) {
  if (refMap.size === 0) throw new Error('No refs available. Run "perceive" first.');

  // Resolve all refs in parallel to get bounding rects
  const refEntries = [...refMap.entries()];
  const settled = await Promise.allSettled(refEntries.map(async ([num, backendNodeId]) => {
    const { object } = await cdpDomains(cdp).DOM.resolveNode( { backendNodeId }, sid);
    const result = await cdpDomains(cdp).Runtime.callFunctionOn( {
      objectId: object.objectId,
      functionDeclaration: `function() { const r = this.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }`,
      returnByValue: true,
    }, sid);
    return { num, ...result.result.value };
  }));
  const entries = settled.filter(s => s.status === 'fulfilled').map(s => s.value);

  // Inject overlay + draw labels + screenshot + cleanup in try/finally
  await evalStr(cdp, sid, `(function() {
    const overlay = document.createElement('div');
    overlay.id = '__cdp_annot_overlay__';
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:2147483647;';
    document.body.appendChild(overlay);
  })()`);

  try {
    await evalStr(cdp, sid, `(function() {
      const overlay = document.getElementById('__cdp_annot_overlay__');
      if (!overlay) return;
      const entries = ${JSON.stringify(entries)};
      for (const e of entries) {
        const box = document.createElement('div');
        box.style.cssText = 'position:fixed;border:2px solid red;pointer-events:none;' +
          'left:' + e.x + 'px;top:' + e.y + 'px;width:' + e.w + 'px;height:' + e.h + 'px;';
        const label = document.createElement('span');
        label.textContent = '@' + e.num;
        label.style.cssText = 'position:absolute;top:-16px;left:0;background:red;color:white;font:bold 11px monospace;padding:1px 3px;border-radius:2px;line-height:14px;';
        box.appendChild(label);
        overlay.appendChild(box);
      }
    })()`);

    await sleep(100);

    const { data, fallback } = await captureScreenshot(cdp, sid, { format: 'png' });
    const prefix = (targetId || 'unknown').slice(0, 8);
    const out = resolve(RUNTIME_DIR, `annotshot-${prefix}.png`);
    writeFileSync(out, Buffer.from(data, 'base64'), { mode: 0o600 });

    const fb = fallback ? ' (fallback)' : '';
    return `${out}\nAnnotated screenshot with ${entries.length} ref labels. Use refs (@1, @2...) from perceive output to identify elements.${fb}`;
  } finally {
    await evalStr(cdp, sid, `(function() { const el = document.getElementById('__cdp_annot_overlay__'); if (el) el.remove(); })()`).catch(() => {});
  }
}

// Send a raw CDP command and return the result as JSON
async function evalRawStr(cdp, sid, method, paramsJson, authorization) {
  if (!method) throw new Error('CDP method required (e.g. "DOM.getDocument")');
  let params = {};
  if (paramsJson) {
    try { params = JSON.parse(paramsJson); }
    catch { throw new Error(`Invalid JSON params: ${paramsJson}`); }
  }
  const gateway = createRawCdpGateway(bindCdpTransport(cdp), authorization);
  const result = await gateway.execute(params, sid);
  return JSON.stringify(result, null, 2);
}

function dialogStr(dialogBuf, dialogAutoAcceptRef, flag) {
  if (flag === 'accept') { dialogAutoAcceptRef.value = true; return 'Dialog auto-accept: ON (default)'; }
  if (flag === 'dismiss') { dialogAutoAcceptRef.value = false; return 'Dialog auto-accept: OFF (dialogs will be dismissed/rejected)'; }
  if (flag) throw new Error(`Unknown dialog flag: "${flag}". Use "accept" or "dismiss".`);
  const mode = dialogAutoAcceptRef.value ? 'ON' : 'OFF';
  const entries = dialogBuf.all();
  if (entries.length === 0) return `No dialogs recorded. Auto-accept: ${mode}`;
  const lines = [`Dialogs (${entries.length}, auto-accept: ${mode}):`];
  for (const e of entries) {
    const ago = Math.round((Date.now() - e.ts) / 1000);
    lines.push(`  [${e.type}] "${e.message}" (${ago}s ago)`);
  }
  return lines.join('\n');
}

function javascriptDialogHandleParams(params = {}, accept) {
  return {
    accept: Boolean(accept),
    // Chrome prompt() handling fails when promptText is omitted, including dismiss.
    promptText: String(params?.defaultPrompt || ''),
  };
}

function createJavaScriptDialogSession() {
  const pending = new Set();
  let failedHandle = false;
  let lastHandle = null;
  return {
    pending,
    track(promise) {
      const tracked = Promise.resolve(promise).then((result) => {
        lastHandle = result && typeof result === 'object' ? result : { ok: true, value: result };
        if (result && result.ok === false) failedHandle = true;
        return result;
      }, (error) => {
        failedHandle = true;
        lastHandle = { ok: false, error };
        throw error;
      }).finally(() => {
        pending.delete(tracked);
      });
      pending.add(tracked);
      return tracked;
    },
    async waitForPending(timeoutMs = 1000) {
      if (pending.size === 0) return;
      const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
      while (pending.size > 0 && Date.now() < deadline) {
        await Promise.race([
          Promise.allSettled([...pending]),
          sleep(Math.max(1, deadline - Date.now())),
        ]);
      }
    },
    hasPending() {
      return pending.size > 0;
    },
    hasFailedHandle() {
      return failedHandle;
    },
    lastHandle() {
      return lastHandle;
    },
  };
}

function shouldSkipActionPageEvaluate(dialogSession) {
  return Boolean(dialogSession && typeof dialogSession.hasFailedHandle === 'function' && dialogSession.hasFailedHandle());
}

function formatDialogBlockedObserveText(dialogSession = null) {
  const handle = dialogSession && typeof dialogSession.lastHandle === 'function' ? dialogSession.lastHandle() : null;
  const detail = handle?.error?.message ? `: ${handle.error.message}` : '';
  return `JavaScript dialog still open; skipped page evaluate to avoid blocking the tab daemon${detail}`;
}

async function observeAfterActionGuardingDialogs(jsDialogs, observeAfterAction) {
  if (jsDialogs && typeof jsDialogs.hasPending === 'function' ? jsDialogs.hasPending() : jsDialogs?.pending?.size > 0) {
    await jsDialogs.waitForPending(1500);
  }
  if (shouldSkipActionPageEvaluate(jsDialogs)) {
    return formatDialogBlockedObserveText(jsDialogs);
  }
  return observeAfterAction();
}

async function handleOpeningJavaScriptDialog(cdp, fallbackSessionId, params, msg, {
  accept = true,
  dialogBuf = null,
  retries = 8,
  delayMs = 25,
} = {}) {
  if (dialogBuf && typeof dialogBuf.push === 'function') {
    dialogBuf.push({
      type: params?.type || 'alert',
      message: params?.message || '',
      defaultPrompt: params?.defaultPrompt || '',
      ts: Date.now(),
    });
  }
  const payload = javascriptDialogHandleParams(params, accept);
  const sessions = [];
  if (msg?.sessionId) sessions.push(msg.sessionId);
  if (fallbackSessionId && fallbackSessionId !== msg?.sessionId) sessions.push(fallbackSessionId);
  let lastError = null;
  if (sessions.length === 0) {
    return { ok: false, error: new Error('No page session available for JavaScript dialog handling') };
  }
  for (let attempt = 0; attempt < retries; attempt++) {
    for (const sid of sessions) {
      try {
        await cdpDomains(cdp).Page.handleJavaScriptDialog(payload, sid);
        return { ok: true, sessionId: sid, attempt };
      } catch (error) {
        lastError = error;
      }
    }
    if (attempt + 1 < retries) await sleep(delayMs);
  }
  return { ok: false, error: lastError };
}

function filterNetlogEntries(entries = [], { lastNavigationTs = null, lookbackMs = 2500 } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  if (!Number.isFinite(Number(lastNavigationTs))) return [...list];
  const since = Number(lastNavigationTs) - (Number.isFinite(Number(lookbackMs)) ? Number(lookbackMs) : 2500);
  return list.filter(entry => Number(entry?.ts) >= since);
}

function netlogStr(netReqBuf, flag, options = {}) {
  if (flag === '--clear') { netReqBuf.clear(); return 'Network log cleared'; }
  const entries = filterNetlogEntries(netReqBuf.all(), options);
  if (entries.length === 0) return 'No network requests captured (tracking action-relevant requests; static assets are skipped)';
  const lines = [`Network requests (${entries.length}):`];
  for (const e of entries) {
    const ago = Math.round((Date.now() - e.ts) / 1000);
    const size = e.size > 1024 ? `${(e.size / 1024).toFixed(1)}KB` : `${e.size}B`;
    lines.push(`  ${e.method} ${e.url} → ${e.status} (${e.duration}ms, ${size}) ${ago}s ago`);
  }
  return lines.join('\n');
}

function parseHttpStatus(value, label = '--status') {
  const status = Number(value);
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new Error(`mock ${label} requires an HTTP status code from 100 to 599`);
  }
  return status;
}

function parseMockArgs(args = []) {
  const fopts = parseFormatArgs(args, ['text', 'json']);
  const tokens = fopts.args || [];
  if (tokens.length === 0) return { mode: 'status', format: fopts.format };
  const mode = String(tokens[0] || '').toLowerCase();
  if (mode === 'clear' || mode === 'off' || mode === 'reset') {
    if (tokens.length > 1) throw new Error(`mock ${tokens[0]} does not accept extra arguments`);
    return { mode: 'clear', format: fopts.format };
  }
  if (mode !== 'add') {
    throw new Error(`Unknown mock command: ${tokens[0]}. Use add, clear, or no args for status.`);
  }
  const urlPattern = tokens[1];
  if (!urlPattern) throw new Error('mock add requires a URL pattern, e.g. **/api/items*');
  const rule = {
    id: `mock-${Date.now().toString(36)}`,
    urlPattern,
    method: null,
    status: 200,
    body: '',
    contentType: 'text/plain; charset=utf-8',
  };
  for (let i = 2; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '--status') rule.status = parseHttpStatus(tokens[++i], '--status');
    else if (token === '--body') rule.body = tokens[++i] ?? '';
    else if (token === '--content-type' || token === '--type') rule.contentType = tokens[++i] || rule.contentType;
    else if (token === '--method') rule.method = String(tokens[++i] || '').toUpperCase();
    else throw new Error(`mock add: unknown option ${token}`);
  }
  if (rule.method === '') rule.method = null;
  return { mode: 'add', format: fopts.format, rule };
}

function wildcardToRegExp(pattern) {
  const escaped = String(pattern || '').replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
}

function mockRuleMatches(rule, request = {}) {
  if (!rule) return false;
  if (rule.method && String(request.method || '').toUpperCase() !== rule.method) return false;
  return wildcardToRegExp(rule.urlPattern).test(String(request.url || ''));
}

function findNetworkMockRule(session, request = {}) {
  return (session.networkMocks || []).find(rule => mockRuleMatches(rule, request));
}

function formatNetworkMocksSummary(session = {}) {
  const rules = session.networkMocks || [];
  if (rules.length === 0) return 'off';
  const first = rules[0];
  const hits = (session.networkMockHits || []).filter(hit => hit.ruleId === first.id).length;
  const suffix = rules.length > 1 ? ` (+${rules.length - 1} more)` : '';
  return `${rules.length} rule${rules.length === 1 ? '' : 's'} — ${first.urlPattern} -> ${first.status} (${hits} hit${hits === 1 ? '' : 's'})${suffix}`;
}

function buildMockModel(session, parsed) {
  const rules = session.networkMocks || [];
  const hits = session.networkMockHits || [];
  return {
    schema: 'chrome-cdp-ex.mock.v1',
    targetId: session.targetId,
    mode: parsed.mode,
    rules: rules.map(rule => ({
      id: rule.id,
      urlPattern: rule.urlPattern,
      method: rule.method,
      status: rule.status,
      contentType: rule.contentType,
      bodyBytes: Buffer.byteLength(rule.body || '', 'utf8'),
      hits: hits.filter(hit => hit.ruleId === rule.id).length,
    })),
    recentHits: hits.slice(-10),
  };
}

function formatMockText(model) {
  if (!model.rules.length) {
    return [
      'Network mock: off',
      `Next: cdp mock ${model.targetId} add "**/api/*" --status 503 --body '{"ok":false}' --content-type application/json`,
    ].join('\n');
  }
  const lines = [`Network mock: ${model.rules.length} rule${model.rules.length === 1 ? '' : 's'}`];
  for (const [i, rule] of model.rules.entries()) {
    const method = rule.method ? `${rule.method} ` : '';
    lines.push(`${i + 1}. ${method}${rule.urlPattern} -> ${rule.status} ${rule.contentType} (${rule.hits} hit${rule.hits === 1 ? '' : 's'})`);
  }
  if (model.recentHits.length) {
    const hit = model.recentHits[model.recentHits.length - 1];
    lines.push(`Last hit: ${hit.method} ${hit.url} -> ${hit.status}`);
  }
  lines.push(`Next: cdp mock ${model.targetId} clear`);
  return lines.join('\n');
}

async function applyNetworkMocks(cdp, sid, session) {
  const rules = session.networkMocks || [];
  if (!rules.length) {
    await cdpDomains(cdp).Fetch.disable( {}, sid);
    return;
  }
  await cdpDomains(cdp).Fetch.enable( {
    patterns: rules.map(rule => ({ urlPattern: rule.urlPattern, requestStage: 'Request' })),
  }, sid);
}

async function handleMockRequestPaused(cdp, sid, session, params = {}) {
  const request = params.request || {};
  const rule = findNetworkMockRule(session, request);
  if (!rule) {
    await cdpDomains(cdp).Fetch.continueRequest( { requestId: params.requestId }, sid);
    return null;
  }
  await cdpDomains(cdp).Fetch.fulfillRequest( {
    requestId: params.requestId,
    responseCode: rule.status,
    responseHeaders: [{ name: 'content-type', value: rule.contentType }],
    body: Buffer.from(rule.body || '', 'utf8').toString('base64'),
  }, sid);
  const hit = {
    ruleId: rule.id,
    method: request.method || '',
    url: request.url || '',
    status: rule.status,
    ts: Date.now(),
  };
  session.networkMockHits.push(hit);
  if (session.networkMockHits.length > MAX_NETWORK_MOCK_HITS) {
    session.networkMockHits.splice(0, session.networkMockHits.length - MAX_NETWORK_MOCK_HITS);
  }
  return hit;
}

async function mockStr(cdp, sid, session, args = []) {
  const parsed = parseMockArgs(args);
  if (!Array.isArray(session.networkMocks)) session.networkMocks = [];
  if (!Array.isArray(session.networkMockHits)) session.networkMockHits = [];
  if (parsed.mode === 'add') {
    session.networkMocks.push(parsed.rule);
    await applyNetworkMocks(cdp, sid, session);
    appendSessionEnvironmentLog(session, { kind: 'mock', ts: Date.now(), action: 'add', rule: parsed.rule });
  } else if (parsed.mode === 'clear') {
    session.networkMocks = [];
    session.networkMockHits = [];
    await applyNetworkMocks(cdp, sid, session);
    appendSessionEnvironmentLog(session, { kind: 'mock', ts: Date.now(), action: 'clear' });
  }
  const model = buildMockModel(session, parsed);
  return parsed.format === 'json' ? formatJson(model) : formatMockText(model);
}

function parseClockTimestamp(value) {
  if (value == null || value === '') throw new Error('clock freeze requires --at <date|epoch-ms>');
  const numeric = Number(value);
  const atMs = Number.isFinite(numeric) ? numeric : Date.parse(String(value));
  if (!Number.isFinite(atMs)) throw new Error('clock freeze --at requires a valid date or epoch milliseconds');
  return atMs;
}

function parseClockOffsetMs(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms)) throw new Error('clock offset --ms requires a finite millisecond value');
  return ms;
}

function parseClockArgs(args = []) {
  const fopts = parseFormatArgs(args, ['text', 'json']);
  const tokens = fopts.args || [];
  if (tokens.length === 0) return { mode: 'status', format: fopts.format };
  const cmd = String(tokens[0] || '').toLowerCase();
  if (cmd === 'reset' || cmd === 'off' || cmd === 'real') {
    if (tokens.length > 1) throw new Error(`clock ${tokens[0]} does not accept extra arguments`);
    return { mode: 'reset', format: fopts.format, profile: 'real' };
  }
  if (cmd === 'freeze') {
    let atMs = null;
    for (let i = 1; i < tokens.length; i++) {
      const token = tokens[i];
      if (token === '--at') atMs = parseClockTimestamp(tokens[++i]);
      else throw new Error(`clock freeze: unknown option ${token}`);
    }
    if (atMs == null) throw new Error('clock freeze requires --at <date|epoch-ms>');
    return { mode: 'apply', format: fopts.format, profile: 'freeze', atMs };
  }
  if (cmd === 'offset') {
    let offsetMs = null;
    for (let i = 1; i < tokens.length; i++) {
      const token = tokens[i];
      if (token === '--ms') offsetMs = parseClockOffsetMs(tokens[++i]);
      else if (token === '--seconds') offsetMs = parseClockOffsetMs(tokens[++i]) * 1000;
      else throw new Error(`clock offset: unknown option ${token}`);
    }
    if (offsetMs == null) throw new Error('clock offset requires --ms <milliseconds>');
    return { mode: 'apply', format: fopts.format, profile: 'offset', offsetMs };
  }
  throw new Error(`Unknown clock command: ${tokens[0]}. Use freeze, offset, reset, or no args for status.`);
}

function clockPageScript(config) {
  return `(${function installCdpClock(cfg) {
    const g = globalThis;
    const existing = g.__cdpClockOriginals;
    const originals = existing || {
      Date: g.Date,
      performanceNow: g.performance && typeof g.performance.now === 'function'
        ? g.performance.now.bind(g.performance)
        : null,
    };
    if (!existing) {
      Object.defineProperty(g, '__cdpClockOriginals', {
        value: originals,
        configurable: true,
        writable: true,
      });
    }

    if (cfg.profile === 'real' || cfg.mode === 'reset') {
      if (originals.Date) g.Date = originals.Date;
      if (g.performance && originals.performanceNow) {
        try {
          Object.defineProperty(g.performance, 'now', {
            value: originals.performanceNow,
            configurable: true,
          });
        } catch {}
      }
      try { delete g.__cdpClock; } catch {}
      return { ok: true, profile: 'real', now: originals.Date.now() };
    }

    const OriginalDate = originals.Date;
    const profile = cfg.profile;
    const atMs = Number(cfg.atMs);
    const offsetMs = Number(cfg.offsetMs || 0);
    const installedAtPerfMs = originals.performanceNow ? originals.performanceNow() : 0;
    const currentNow = () => profile === 'freeze' ? atMs : OriginalDate.now() + offsetMs;

    function MockDate(...args) {
      if (this instanceof MockDate) {
        return args.length ? new OriginalDate(...args) : new OriginalDate(currentNow());
      }
      return new OriginalDate(currentNow()).toString();
    }
    Object.setPrototypeOf(MockDate, OriginalDate);
    MockDate.prototype = OriginalDate.prototype;
    MockDate.now = currentNow;
    MockDate.parse = OriginalDate.parse.bind(OriginalDate);
    MockDate.UTC = OriginalDate.UTC.bind(OriginalDate);
    try { Object.defineProperty(MockDate, 'name', { value: 'Date', configurable: true }); } catch {}
    g.Date = MockDate;

    if (g.performance && originals.performanceNow) {
      try {
        Object.defineProperty(g.performance, 'now', {
          value: () => profile === 'freeze' ? installedAtPerfMs : originals.performanceNow() + offsetMs,
          configurable: true,
        });
      } catch {}
    }

    const now = currentNow();
    g.__cdpClock = {
      profile,
      atMs: profile === 'freeze' ? atMs : null,
      offsetMs: profile === 'offset' ? offsetMs : 0,
      iso: new OriginalDate(now).toISOString(),
    };
    return { ok: true, ...g.__cdpClock, now };
  }.toString()})(${JSON.stringify(config)});`;
}

function formatSignedMs(ms) {
  return `${ms >= 0 ? '+' : ''}${ms}ms`;
}

function formatClockSummary(clock = null) {
  if (!clock || clock.profile === 'real') return 'real time';
  if (clock.profile === 'freeze') return `frozen at ${new Date(clock.atMs).toISOString()}`;
  if (clock.profile === 'offset') return `offset ${formatSignedMs(clock.offsetMs || 0)}`;
  return 'real time';
}

function buildClockModel(session, parsed) {
  const clock = parsed.mode === 'status' ? session.clock : (session.clock || null);
  return {
    schema: 'chrome-cdp-ex.clock.v1',
    targetId: session.targetId,
    mode: parsed.mode,
    profile: clock?.profile || 'real',
    atMs: clock?.atMs ?? null,
    offsetMs: clock?.offsetMs ?? 0,
    scriptIdentifier: clock?.scriptIdentifier || null,
  };
}

function formatClockText(model) {
  const lines = [`Clock: ${formatClockSummary(model)}`];
  if (model.profile === 'real') {
    lines.push(`Next: cdp clock ${model.targetId} freeze --at 2020-01-02T03:04:05.000Z`);
    lines.push(`Next: cdp clock ${model.targetId} offset --ms 3600000`);
  } else {
    lines.push(`Next: cdp clock ${model.targetId} reset`);
  }
  return lines.join('\n');
}

async function removeClockScriptIfNeeded(cdp, sid, session) {
  const identifier = session.clock?.scriptIdentifier;
  if (identifier) {
    await cdpDomains(cdp).Page.removeScriptToEvaluateOnNewDocument( { identifier }, sid);
  }
}

async function clockStr(cdp, sid, session, args = []) {
  const parsed = parseClockArgs(args);
  if (parsed.mode === 'apply') {
    await removeClockScriptIfNeeded(cdp, sid, session);
    const source = clockPageScript(parsed);
    const added = await cdpDomains(cdp).Page.addScriptToEvaluateOnNewDocument( { source }, sid);
    await cdpDomains(cdp).Runtime.evaluate( { expression: source, returnByValue: true, awaitPromise: true }, sid);
    session.clock = {
      profile: parsed.profile,
      atMs: parsed.profile === 'freeze' ? parsed.atMs : null,
      offsetMs: parsed.profile === 'offset' ? parsed.offsetMs : 0,
      scriptIdentifier: added.identifier || null,
      appliedAt: Date.now(),
    };
    appendSessionEnvironmentLog(session, { kind: 'clock', ts: session.clock.appliedAt, action: 'apply', clock: session.clock });
  } else if (parsed.mode === 'reset') {
    await removeClockScriptIfNeeded(cdp, sid, session);
    await cdpDomains(cdp).Runtime.evaluate( { expression: clockPageScript(parsed), returnByValue: true, awaitPromise: true }, sid);
    appendSessionEnvironmentLog(session, { kind: 'clock', ts: Date.now(), action: 'reset' });
    session.clock = null;
  }
  const model = buildClockModel(session, parsed);
  return parsed.format === 'json' ? formatJson(model) : formatClockText(model);
}

const THROTTLE_PRESETS = Object.freeze({
  off: { profile: 'off', offline: false, latencyMs: 0, downloadKbps: null, uploadKbps: null },
  offline: { profile: 'offline', offline: true, latencyMs: 0, downloadKbps: 0, uploadKbps: 0 },
  'slow-3g': { profile: 'slow-3g', offline: false, latencyMs: 400, downloadKbps: 400, uploadKbps: 400 },
  'fast-3g': { profile: 'fast-3g', offline: false, latencyMs: 150, downloadKbps: 1600, uploadKbps: 750 },
  lte: { profile: 'lte', offline: false, latencyMs: 40, downloadKbps: 12000, uploadKbps: 12000 },
});

function kbpsToBytesPerSecond(kbps) {
  const n = Number(kbps);
  return Number.isFinite(n) ? Math.round(n * 1000 / 8) : -1;
}

function throttleCdpParams(profile) {
  if (profile.profile === 'off') {
    return { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 };
  }
  return {
    offline: profile.offline === true,
    latency: Number(profile.latencyMs || 0),
    downloadThroughput: profile.offline ? 0 : kbpsToBytesPerSecond(profile.downloadKbps),
    uploadThroughput: profile.offline ? 0 : kbpsToBytesPerSecond(profile.uploadKbps),
  };
}

function parseNonNegativeNumber(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`throttle ${label} requires a non-negative number`);
  return n;
}

function parseThrottleArgs(args = []) {
  const fopts = parseFormatArgs(args, ['text', 'json']);
  const tokens = fopts.args || [];
  if (tokens.length === 0) return { mode: 'status', format: fopts.format };
  let profileName = String(tokens[0] || '').toLowerCase();
  if (profileName === 'reset' || profileName === 'none') profileName = 'off';
  let profile;
  if (profileName === 'custom') {
    const custom = { profile: 'custom', offline: false, latencyMs: 0, downloadKbps: null, uploadKbps: null };
    for (let i = 1; i < tokens.length; i++) {
      const token = tokens[i];
      if (token === '--latency') custom.latencyMs = parseNonNegativeNumber(tokens[++i], '--latency');
      else if (token === '--download' || token === '--down') custom.downloadKbps = parseNonNegativeNumber(tokens[++i], token);
      else if (token === '--upload' || token === '--up') custom.uploadKbps = parseNonNegativeNumber(tokens[++i], token);
      else throw new Error(`throttle custom: unknown option ${token}`);
    }
    if (custom.downloadKbps == null || custom.uploadKbps == null) {
      throw new Error('throttle custom requires --download <kbps> and --upload <kbps>');
    }
    profile = custom;
  } else {
    profile = THROTTLE_PRESETS[profileName];
    if (!profile) {
      throw new Error(`Unknown throttle profile: ${tokens[0]}. Use off, offline, slow-3g, fast-3g, lte, or custom.`);
    }
    if (tokens.length > 1) {
      throw new Error(`throttle ${tokens[0]} does not accept extra arguments. Use custom --latency <ms> --download <kbps> --upload <kbps>.`);
    }
    profile = { ...profile };
  }
  const cdpParams = throttleCdpParams(profile);
  return { mode: 'apply', format: fopts.format, ...profile, cdpParams };
}

function formatThrottleSummary(profile = null) {
  if (!profile || profile.profile === 'off') return 'off';
  if (profile.offline) return 'offline';
  return `${profile.profile} — latency ${profile.latencyMs}ms, ${profile.downloadKbps} kbps down, ${profile.uploadKbps} kbps up`;
}

function throttleModel(session, parsed) {
  const current = parsed.mode === 'status'
    ? (session.networkThrottle || { profile: 'off', offline: false, latencyMs: 0, downloadKbps: null, uploadKbps: null })
    : parsed;
  return {
    schema: 'chrome-cdp-ex.throttle.v1',
    targetId: session.targetId,
    mode: parsed.mode,
    profile: current.profile || 'off',
    offline: current.offline === true,
    latencyMs: current.latencyMs || 0,
    downloadKbps: current.downloadKbps,
    uploadKbps: current.uploadKbps,
    cdpParams: current.cdpParams || throttleCdpParams(current),
  };
}

function formatThrottleText(model) {
  const lines = [`Network throttle: ${formatThrottleSummary(model)}`];
  if (model.mode === 'status') {
    lines.push(`Next: cdp throttle ${model.targetId} slow-3g  # apply a preset`);
  } else if (model.profile === 'off') {
    lines.push('Network conditions reset to browser defaults.');
    lines.push(`Next: cdp throttle ${model.targetId} slow-3g  # re-apply a preset`);
  } else {
    lines.push(`Next: cdp throttle ${model.targetId} off`);
  }
  return lines.join('\n');
}

async function throttleStr(cdp, sid, session, args = []) {
  const parsed = parseThrottleArgs(args);
  if (parsed.mode === 'apply') {
    await cdpDomains(cdp).Network.enable( {}, sid);
    await cdpDomains(cdp).Network.emulateNetworkConditions( parsed.cdpParams, sid);
    session.networkThrottle = {
      profile: parsed.profile,
      offline: parsed.offline,
      latencyMs: parsed.latencyMs,
      downloadKbps: parsed.downloadKbps,
      uploadKbps: parsed.uploadKbps,
      cdpParams: parsed.cdpParams,
      appliedAt: Date.now(),
    };
    appendSessionEnvironmentLog(session, { kind: 'throttle', ts: session.networkThrottle.appliedAt, action: 'apply', throttle: session.networkThrottle });
  }
  const model = throttleModel(session, parsed);
  return parsed.format === 'json' ? formatJson(model) : formatThrottleText(model);
}

function clearObservationBuffers({ consoleBuf, exceptionBuf, navBuf, netReqBuf, pendingReqs, lastReadSeq }) {
  consoleBuf?.clear();
  exceptionBuf?.clear();
  navBuf?.clear();
  netReqBuf?.clear();
  pendingReqs?.clear();
  if (lastReadSeq) {
    lastReadSeq.console = consoleBuf?.latest?.() || 0;
    lastReadSeq.exception = exceptionBuf?.latest?.() || 0;
  }
}

async function waitForActionNetworkQuiet(pendingReqs, { quietMs = 150, timeoutMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let quietSince = pendingReqs?.size ? 0 : Date.now();
  while (Date.now() < deadline) {
    if (pendingReqs?.size) {
      quietSince = 0;
    } else {
      if (!quietSince) quietSince = Date.now();
      if (Date.now() - quietSince >= quietMs) return true;
    }
    await sleep(50);
  }
  return !pendingReqs?.size;
}

function appendPendingActionNetworkEntries(pendingReqs, netReqBuf, sinceTs, { now = Date.now() } = {}) {
  if (!pendingReqs || !netReqBuf) return 0;
  let count = 0;
  for (const req of pendingReqs.values()) {
    if (!req || req.actionEvidenceReported || req.ts < sinceTs) continue;
    req.actionEvidenceReported = true;
    netReqBuf.push({
      method: req.method,
      url: req.url,
      status: 'pending',
      type: req.type,
      duration: now - req.ts,
      size: 0,
      pending: true,
      ts: req.ts,
    });
    count += 1;
  }
  return count;
}

async function viewportStr(cdp, sid, size) {
  if (!size) {
    const dims = await evalStr(cdp, sid, `JSON.stringify({w:window.innerWidth,h:window.innerHeight,dpr:window.devicePixelRatio})`);
    const d = JSON.parse(dims);
    return `Viewport: ${d.w}×${d.h} (DPR: ${d.dpr})`;
  }
  const match = size.match(/^(\d+)[x×](\d+)$/);
  if (!match) throw new Error('Format: <width>x<height> (e.g. 375x812, 1280x720)');
  const width = parseInt(match[1]), height = parseInt(match[2]);
  await cdpDomains(cdp).Emulation.setDeviceMetricsOverride( {
    width, height, deviceScaleFactor: 0, mobile: width <= 768,
  }, sid);
  return `Viewport resized to ${width}×${height}${width <= 768 ? ' (mobile mode)' : ''}`;
}

async function cookieSetStr(cdp, sid, cookieStr) {
  if (!cookieStr) throw new Error('Cookie string required: "name=value" or "name=value; domain=.example.com"');
  const parts = cookieStr.split(';').map(s => s.trim());
  const [name, ...valParts] = parts[0].split('=');
  const value = valParts.join('='); // handle values with = in them
  if (!name) throw new Error('Cookie name required');

  const cookie = { name: name.trim(), value };
  for (const part of parts.slice(1)) {
    const [k, ...v] = part.split('=');
    const key = k.trim().toLowerCase();
    const val = v.join('=').trim();
    if (key === 'domain') cookie.domain = val;
    else if (key === 'path') cookie.path = val;
    else if (key === 'secure') cookie.secure = true;
    else if (key === 'httponly') cookie.httpOnly = true;
    else if (key === 'samesite') cookie.sameSite = val;
  }

  // Batch location queries into a single eval round-trip
  const loc = JSON.parse(await evalStr(cdp, sid, 'JSON.stringify({hostname:location.hostname,href:location.href})'));
  if (!cookie.domain) cookie.domain = loc.hostname;
  cookie.url = loc.href;

  const { success } = await cdpDomains(cdp).Network.setCookie( cookie, sid);
  if (!success) throw new Error(`Failed to set cookie: ${name}`);
  return `Cookie set: ${name}=${value.substring(0, 30)}${value.length > 30 ? '...' : ''} (domain: ${cookie.domain})`;
}

function cookieDeleteParams(cookie, pageUrl = '') {
  const params = { name: cookie.name };
  if (cookie.domain) params.domain = cookie.domain;
  else if (pageUrl) params.url = pageUrl;
  if (cookie.path) params.path = cookie.path;
  if (cookie.partitionKey) params.partitionKey = cookie.partitionKey;
  return params;
}

async function cookieDelStr(cdp, sid, name) {
  if (!name) throw new Error('Cookie name required');
  const { cookies } = await cdpDomains(cdp).Network.getCookies( {}, sid);
  const matches = (cookies || []).filter(cookie => cookie.name === name);
  if (!matches.length) throw new Error(`Cookie not found: ${name}`);
  const needsUrl = matches.some(cookie => !cookie.domain);
  const pageUrl = needsUrl ? await evalStr(cdp, sid, 'window.location.href') : '';
  for (const cookie of matches) {
    await cdpDomains(cdp).Network.deleteCookies( cookieDeleteParams(cookie, pageUrl), sid);
  }
  const { cookies: remaining } = await cdpDomains(cdp).Network.getCookies( {}, sid);
  const leftover = (remaining || []).some(cookie => cookie.name === name);
  if (leftover) throw new Error(`Cookie still present: ${name}`);
  return `Cookie deleted: ${name}`;
}

function assertReadableUploadFiles(filePaths) {
  const files = String(filePaths || '').split(',').map(f => f.trim()).filter(Boolean);
  if (!files.length) throw new Error('File path(s) required (comma-separated for multiple)');
  for (const file of files) {
    let stat;
    try {
      stat = statSync(file);
    } catch {
      throw new Error(`upload: file not found: ${file}`);
    }
    if (!stat.isFile()) throw new Error(`upload: file not found: ${file}`);
  }
  return files;
}

async function uploadStr(cdp, sid, selector, filePaths) {
  if (!selector) throw new Error('CSS selector for <input type="file"> required');
  if (!filePaths) throw new Error('File path(s) required (comma-separated for multiple)');
  const files = assertReadableUploadFiles(filePaths);
  const { root } = await cdpDomains(cdp).DOM.getDocument( {}, sid);
  const { nodeId } = await cdpDomains(cdp).DOM.querySelector( { nodeId: root.nodeId, selector }, sid);
  if (!nodeId) throw new Error('Element not found: ' + selector);
  // Validate it's a file input — attributes is a flat [name, value, name, value, ...] array
  const { node } = await cdpDomains(cdp).DOM.describeNode( { nodeId }, sid);
  const attrs = node.attributes || [];
  const typeIdx = attrs.indexOf('type');
  if (node.nodeName !== 'INPUT' || typeIdx === -1 || attrs[typeIdx + 1] !== 'file')
    throw new Error('Element is not an <input type="file">');
  await cdpDomains(cdp).DOM.setFileInputFiles( { files, nodeId }, sid);
  return `Uploaded ${files.length} file(s) to ${selector}: ${files.join(', ')}`;
}

// --- Clean text extraction ---
// Parse `text` arguments. Supports:
//   text                          → full body
//   text "main, [role=main]"      → fallback chain (try first, then next…)
//   text --auto                   → auto-pick main content (excludes nav/aside/script/style)
//   text --root auto|body|document|<sel>  → scope extraction root
//   text --auto --exclude "nav,.sidebar"  → custom extra exclusions
function parseTextArgs(args) {
  const opts = { selectors: [], auto: false, exclude: null, root: null };
  const tokens = Array.isArray(args) ? args.filter(a => a !== undefined && a !== null) : [];
  for (let i = 0; i < tokens.length; i++) {
    const a = tokens[i];
    if (a === '--auto') opts.auto = true;
    else if (a === '--root') opts.root = tokens[++i] || 'auto';
    else if (a === '--exclude' || a === '-x') opts.exclude = tokens[++i];
    else if (typeof a === 'string' && a.startsWith('--')) {
      throw new Error(`text: unknown argument ${a}`);
    } else if (typeof a === 'string') {
      // Comma list = fallback chain (try each until one matches)
      const parts = a.split(',').map(s => s.trim()).filter(Boolean);
      if (parts.length === 0) continue;
      opts.selectors.push(...parts);
    }
  }
  return opts;
}

function formatTextNoMatchError(parsed = {}, opts = {}) {
  const tried = (parsed.tried || []).join(', ') || '(no candidates)';
  const root = parsed.root || opts.root || 'auto';
  const selector = (opts.selectors && opts.selectors[0]) || parsed.sel || '';
  const lines = [
    `text: no element matched within root "${root}". Tried: ${tried}.`,
    `Scope: root=${root}${selector ? `; selector=${selector}` : ''}.`,
  ];
  if (selector) {
    lines.push(`Fallback: cdp eval <target> "document.querySelector(${JSON.stringify(selector)})?.textContent"`);
  } else {
    lines.push('Try `text <target> --auto` or `text <target> "main, [role=main], body"`.');
  }
  lines.push('Tip: `text --root body|document|auto|<css>` changes the search root.');
  return lines.join(' ');
}

function textPageScript(opts) {
  const { selectors = [], auto = false, exclude = null, root = null } = opts || {};
  const extraExcludes = exclude ? exclude.split(',').map(s => s.trim()).filter(Boolean) : [];
  // Explicit selectors default to document-wide search so they match eval's
  // document.querySelector behavior. Full-page / --auto extraction still uses
  // auto root candidates to reduce nav/shell noise.
  const defaultRoot = (selectors.length > 0 && !auto) ? 'document' : 'auto';
  return `(function() {
    const STRIP = ['script','style','noscript','svg','link','meta','template'];
    const AUTO_NOISE = ['nav','aside','footer','[role="navigation"]','[role="complementary"]','[role="contentinfo"]'];
    const ROOT_CANDIDATES = ['#root', '[data-reactroot]', 'main', 'body'];
    const AUTO_CANDIDATES = ['main', '[role="main"]', 'article', '#root main', '#app main', '#root', '[data-reactroot]', '#app', 'body'];
    const EXTRA_EXCLUDES = ${JSON.stringify(extraExcludes)};
    function safeMatches(el, sel) { try { return !!el?.matches?.(sel); } catch { return false; } }
    function safeQuery(root, sel) { try { return root?.querySelector?.(sel) || null; } catch { return null; } }
    function selectorFallbacks(sel) {
      const s = String(sel || '').trim();
      if (s.toLowerCase() === 'header') {
        return ['header', '[role="banner"]', '[data-testid*="header" i]', '[class*="header" i]', '[id*="header" i]', 'h1', 'h2'];
      }
      return [s];
    }
    function pickRoot() {
      const setting = ${JSON.stringify(root || defaultRoot)};
      if (!setting || setting === 'auto' || setting === 'default') {
        for (const sel of ROOT_CANDIDATES) {
          const found = safeQuery(document, sel);
          if (found) return { el: found, sel };
        }
        return { el: document.body || document.documentElement, sel: 'body' };
      }
      if (setting === 'document') {
        return { el: document.documentElement || document.body, sel: 'document' };
      }
      if (setting === 'body') {
        return { el: document.body || document.documentElement, sel: 'body' };
      }
      const found = safeQuery(document, setting);
      return found ? { el: found, sel: setting } : { el: null, sel: setting };
    }
    function shouldSkipElement(el, rootEl, skipSelectors) {
      if (!el || el === rootEl) return false;
      if (el.hidden || el.getAttribute('aria-hidden') === 'true') return true;
      for (const sel of skipSelectors) if (safeMatches(el, sel)) return true;
      const style = window.getComputedStyle(el);
      return style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse';
    }
    function clean(rootEl, stripNoise) {
      if (!rootEl) return '';
      const skipSelectors = STRIP.concat(EXTRA_EXCLUDES, stripNoise ? AUTO_NOISE : []);
      const parts = [];
      const blockish = new Set(['ADDRESS','ARTICLE','ASIDE','BLOCKQUOTE','BR','DIV','DL','FIELDSET','FIGCAPTION','FIGURE','FOOTER','FORM','H1','H2','H3','H4','H5','H6','HEADER','HR','LI','MAIN','NAV','OL','P','PRE','SECTION','TABLE','TR','UL']);
      function walk(node) {
        if (!node) return;
        if (node.nodeType === Node.TEXT_NODE) {
          parts.push(node.nodeValue || '');
          return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_NODE) return;
        const el = node.nodeType === Node.ELEMENT_NODE ? node : null;
        if (el && shouldSkipElement(el, rootEl, skipSelectors)) return;
        if (el?.tagName === 'BR') { parts.push('\\n'); return; }
        for (const child of node.childNodes) walk(child);
        if (el && blockish.has(el.tagName)) parts.push('\\n');
      }
      walk(rootEl);
      return parts.join('')
        .replace(/[ \\t\\f\\v]+/g, ' ')
        .replace(/ *\\n */g, '\\n')
        .replace(/(\\n\\s*){3,}/g, '\\n\\n')
        .trim();
    }
    function findWithin(scope, sel, tried) {
      for (const candidate of selectorFallbacks(sel)) {
        tried.push(candidate);
        if (safeMatches(scope, candidate)) return { el: scope, sel: candidate };
        const found = safeQuery(scope, candidate);
        if (found) return { el: found, sel: candidate === sel ? candidate : candidate + ' (fallback for ' + sel + ')' };
      }
      return null;
    }
    const tried = [];
    const rootInfo = pickRoot();
    if (!rootInfo.el) return JSON.stringify({ ok: false, root: rootInfo.sel, tried: ['--root ' + rootInfo.sel] });
    const scope = rootInfo.el;
    const selectors = ${JSON.stringify(selectors)};
    for (const sel of selectors) {
      const found = findWithin(scope, sel, tried);
      if (found) return JSON.stringify({ ok: true, sel: found.sel, root: rootInfo.sel, text: clean(found.el, false) });
    }
    if (${auto ? 'true' : 'false'}) {
      for (const sel of AUTO_CANDIDATES) {
        const found = findWithin(scope, sel, tried);
        if (!found) continue;
        const text = clean(found.el, true);
        if (text.length > 0) return JSON.stringify({ ok: true, sel: found.sel + ' (auto)', root: rootInfo.sel, text });
        tried.push(sel + ' (auto)');
      }
    }
    if (selectors.length === 0 && !${auto ? 'true' : 'false'}) {
      return JSON.stringify({ ok: true, sel: rootInfo.sel, root: rootInfo.sel, text: clean(scope, false) });
    }
    return JSON.stringify({ ok: false, root: rootInfo.sel, tried });
  })()`;
}

async function textStr(cdp, sid, args, extra = {}) {
  // Support legacy single-string call: textStr(cdp, sid, 'main') — wrap into args[]
  let optsArgs = args;
  if (typeof args === 'string' || args == null) optsArgs = args ? [args] : [];
  else if (!Array.isArray(args)) optsArgs = [];
  const opts = parseTextArgs(optsArgs);
  if (extra.targetPrefix && !opts.targetPrefix) opts.targetPrefix = extra.targetPrefix;
  await assertNotPdfViewerPage(cdp, sid, { targetPrefix: opts.targetPrefix || extra.targetPrefix || '<target>' });
  const result = await evalStr(cdp, sid, textPageScript(opts));
  let parsed;
  try { parsed = JSON.parse(result); }
  catch { return result; }
  if (!parsed.ok) {
    throw new Error(formatTextNoMatchError(parsed, opts));
  }
  const out = parsed.text || '';
  // Hint when no scope was given and text is large.
  const noScope = opts.selectors.length === 0 && !opts.auto;
  if (noScope && out.length > 2000) {
    return out + '\n\n(Hint: output is large — use `text <target> --auto` or `text <target> "main"` / `text <target> "main, [role=main], #app .main"` to scope to a specific area)';
  }
  return out;
}

// --- Truthful bounded table observation ---
function boundedTableRuntimeDiagnostic(exceptionDetails) {
  const raw = String(runtimeExceptionMessage(exceptionDetails));
  let bounded = '';
  for (let index = 0; index < raw.length && bounded.length < 128; index += 1) {
    const unit = raw.charCodeAt(index);
    if (unit >= 0xD800 && unit <= 0xDBFF) {
      const next = raw.charCodeAt(index + 1);
      if (next >= 0xDC00 && next <= 0xDFFF && bounded.length <= 126) {
        bounded += raw[index] + raw[index + 1];
        index += 1;
      } else {
        bounded += '\uFFFD';
      }
    } else if (unit >= 0xDC00 && unit <= 0xDFFF) {
      bounded += '\uFFFD';
    } else {
      bounded += raw[index];
    }
  }
  return canonicalizeTableCells([bounded]);
}

async function sampleRootFrameTables(cdp, sid, selector) {
  const expression = buildTableSamplerExpression(selector || 'table');
  const frameTree = await cdpDomains(cdp).Page.getFrameTree({}, sid);
  const frameId = frameTree?.frameTree?.frame?.id;
  if (typeof frameId !== 'string' || frameId.length === 0) throw new Error('table: root frame id is unavailable');
  const world = await cdpDomains(cdp).Page.createIsolatedWorld({
    frameId,
    worldName: 'chrome-cdp-ex-table-sampler-v1',
    grantUniveralAccess: false,
  }, sid);
  if (!Number.isSafeInteger(world?.executionContextId) || world.executionContextId < 1) {
    throw new Error('table: isolated execution context is unavailable');
  }
  const evaluated = await cdpDomains(cdp).Runtime.evaluate({
    expression,
    contextId: world.executionContextId,
    returnByValue: true,
    awaitPromise: false,
  }, sid);
  if (evaluated?.exceptionDetails) {
    throw new Error(`table: isolated sampler failed: ${boundedTableRuntimeDiagnostic(evaluated.exceptionDetails)}`);
  }
  if (evaluated?.result?.type !== 'string' || typeof evaluated.result.value !== 'string') {
    throw new Error('table: isolated sampler returned a non-string result');
  }
  return parseTableSamplerResult(evaluated.result.value);
}

function validAriaIdentity(sample) {
  const headerCount = sample.headerRows.length;
  const rawCount = sample.ariaRowCount;
  if (sample.headerRowsSeen !== headerCount
    || !Number.isSafeInteger(rawCount)
    || rawCount < headerCount
    || rawCount === -1) return null;
  for (let index = 0; index < headerCount; index += 1) {
    if (sample.headerRows[index].rawAriaRowIndex !== index + 1) return null;
  }
  let previous = headerCount;
  for (let index = 0; index < sample.dataRows.length; index += 1) {
    const raw = sample.dataRows[index].rawAriaRowIndex;
    if (!Number.isSafeInteger(raw) || raw <= previous || raw > rawCount) return null;
    previous = raw;
  }
  const logicalRows = rawCount - headerCount;
  const coverageComplete = sample.dataRows.length === logicalRows
    && sample.dataRows.every((row, index) => row.rawAriaRowIndex === headerCount + index + 1);
  return Object.freeze({ headerCount, logicalRows, coverageComplete });
}

function observedTableEntry(sample, index) {
  const ariaIdentity = validAriaIdentity(sample);
  const accumulator = createTableAccumulator({
    logicalRows: ariaIdentity ? ariaIdentity.logicalRows : null,
    logicalCountSource: ariaIdentity ? 'aria-rowcount' : 'none',
    identitySource: ariaIdentity ? 'aria-rowindex' : 'snapshot-order',
    orderingSource: ariaIdentity ? 'aria-rowindex' : 'dom-order',
  });
  const admitted = [];
  let truncationReason = sample.truncationReason;
  for (let rowIndex = 0; rowIndex < sample.dataRows.length; rowIndex += 1) {
    const row = sample.dataRows[rowIndex];
    try {
      const canonical = canonicalizeTableCells(row.cells);
      if (Buffer.byteLength(canonical, 'utf8') > TABLE_EXTRACTION_LIMITS.maxCanonicalRowBytes
        || Buffer.byteLength(JSON.stringify(row), 'utf8') > 8194) {
        truncationReason = 'row-too-large';
        break;
      }
      admitted.push({
        mountedNodeId: `snapshot-${index + 1}-row-${rowIndex + 1}`,
        key: ariaIdentity ? row.rawAriaRowIndex - ariaIdentity.headerCount : admitted.length + 1,
        cells: row.cells,
      });
    } catch (error) {
      if (/bound|4096|item/i.test(error.message || '')) {
        truncationReason = row.cells.length > 256 ? 'cell-limit' : 'row-too-large';
        break;
      }
      throw error;
    }
  }
  const admission = addTableSampleBatch(accumulator, admitted);
  if (!admission.admitted && !truncationReason) truncationReason = admission.reason;
  const safeComplete = ariaIdentity?.coverageComplete
    && !truncationReason
    && admitted.length === ariaIdentity.logicalRows;
  const result = finalizeTableExtraction(accumulator, {
    termination: safeComplete ? 'logical-count-reached' : 'observation',
  });
  const caption = canonicalizeTableCells([sample.caption || `Table ${index + 1}`]);
  const headers = sample.headerRows.map(row => Object.freeze(
    row.cells.map(cell => canonicalizeTableCells([cell])),
  ));
  return Object.freeze({
    ...result,
    caption,
    headers: Object.freeze(headers),
    snapshot: Object.freeze({
      directRowsSeen: sample.directRowsSeen,
      headerRowsSeen: sample.headerRowsSeen,
      dataRowsSeen: sample.dataRowsSeen,
      rowsAdmitted: admitted.length,
      truncated: Boolean(sample.truncated || truncationReason),
      truncationReason: truncationReason || null,
    }),
  });
}

function tableObservationModel(sample) {
  return Object.freeze({
    schema: 'chrome-cdp-ex.tables.v1',
    snapshot: Object.freeze({
      tablesSeen: sample.tablesSeen,
      tablesReturned: sample.tables.length,
      truncated: sample.truncated,
      truncationReason: sample.truncationReason,
    }),
    tables: Object.freeze(sample.tables.map(observedTableEntry)),
  });
}

function orderedTableObservationEnvelope(model) {
  return {
    schema: model.schema,
    snapshot: model.snapshot,
    ...(Object.hasOwn(model, 'targetResolution') ? { targetResolution: model.targetResolution } : {}),
    tables: model.tables,
  };
}

function trimTrailingTableObservationPreview(model) {
  const table = model.tables[model.tables.length - 1];
  if (table?.inline?.rows?.length > 0) {
    table.inline.rows.pop();
    table.inline.rowCount = table.inline.rows.length;
    table.inline.bytes = Buffer.byteLength(table.inline.rows.join('\n'), 'utf8');
    table.inline.truncated = true;
    return true;
  }
  if (model.tables.length > 0) {
    model.tables.pop();
    model.snapshot.tablesReturned = model.tables.length;
    model.snapshot.truncated = true;
    model.snapshot.truncationReason = 'sample-byte-limit';
    return true;
  }
  return false;
}

function boundedTableObservationJson(model) {
  const mutable = structuredClone(model);
  let output = formatJson(orderedTableObservationEnvelope(mutable));
  while (Buffer.byteLength(output, 'utf8') > 16384) {
    if (!trimTrailingTableObservationPreview(mutable)) {
      throw new RangeError('table: observation metadata exceeds the JSON response byte ceiling');
    }
    output = formatJson(orderedTableObservationEnvelope(mutable));
  }
  return output;
}

function boundedTableObservationText(model, target = '<target>') {
  const summary = `Table snapshot: ${model.tables.length} mounted table(s); ${model.snapshot.truncated ? 'truncated' : 'bounded root-frame sample'}`;
  const footer = 'Snapshot provenance: bounded root-frame observation.';
  const sections = [];
  for (let index = 0; index < model.tables.length; index += 1) {
    const table = model.tables[index];
    const metadata = [
      `${table.caption} — ${table.completeness.state}; mounted ${table.mountedRows}; observed ${table.collectedRows}${table.logicalRows === null ? '' : `/${table.logicalRows}`}`,
    ];
    for (let headerIndex = 0; headerIndex < table.headers.length; headerIndex += 1) {
      metadata.push(`${headerIndex === 0 ? 'Header' : `Header ${headerIndex + 1}`}: ${table.headers[headerIndex].join('\t')}`);
    }
    sections.push({ metadata, rows: [...table.inline.rows] });
  }
  const hint = model.tables.some(table => table.completeness.state !== 'complete')
    ? `Mounted snapshot only. For explicit virtual collection: cdp table ${target} --collect --scroll-container <selector>`
    : null;
  let emissionTruncated = false;
  const render = () => [
    summary,
    ...sections.flatMap(section => [...section.metadata, ...section.rows]),
    ...(emissionTruncated ? ['Table preview truncated at complete row boundaries by the 8,192-byte emission limit.'] : []),
    ...(hint ? [hint] : []),
    footer,
  ].join('\n');
  let output = render();
  while (Buffer.byteLength(output, 'utf8') > 8192) {
    const section = sections[sections.length - 1];
    if (!section) throw new RangeError('table: observation summary exceeds the text response byte ceiling');
    if (section.rows.length > 0) section.rows.pop();
    else sections.pop();
    emissionTruncated = true;
    output = render();
  }
  return output;
}

function boundedTableObservationEmissionJson(result) {
  if (typeof result !== 'string') return result;
  let model;
  try { model = JSON.parse(result); } catch { return result; }
  if (!model || typeof model !== 'object' || Array.isArray(model)
    || model.schema !== 'chrome-cdp-ex.tables.v1'
    || !Array.isArray(model.tables)) return result;
  return boundedTableObservationJson(model);
}

function boundedTableObservationEmissionText(result) {
  if (typeof result !== 'string' || Buffer.byteLength(result, 'utf8') <= 8192) return result;
  const marker = 'Table preview truncated at complete row boundaries by the 8,192-byte emission limit.';
  const lines = result.split('\n');
  while (lines.length > 1 && Buffer.byteLength([...lines, marker].join('\n'), 'utf8') > 8192) lines.pop();
  if (Buffer.byteLength([...lines, marker].join('\n'), 'utf8') > 8192) {
    return 'Table snapshot unavailable: summary exceeded the 8,192-byte emission limit.';
  }
  return [...lines, marker].join('\n');
}

async function tableObservationStr(cdp, sid, request) {
  const sample = await sampleRootFrameTables(cdp, sid, request.selector || 'table');
  const model = tableObservationModel(sample);
  return request.format === 'json'
    ? boundedTableObservationJson(model)
    : boundedTableObservationText(model);
}

const TABLE_COLLECTOR_WORLD = 'chrome-cdp-ex-table-collector-v1';
const TABLE_COLLECTOR_OBJECT_GROUP = 'chrome-cdp-ex-table-collector';

function tableCollectorError(message) {
  return new Error(`table: ${message}`);
}

function buildTableCollectorBootstrapExpression() {
  return String.raw`(() => {
    'use strict';
    const O = Object;
    const A = Array;
    const S = String;
    const N = Number;
    const J = JSON;
    const WM = WeakMap;
    const EventCtor = globalThis.Event;
    const getOwnPropertyDescriptor = O.getOwnPropertyDescriptor;
    const reflectApply = Reflect.apply;
    const nodeProto = Node.prototype;
    const elementProto = Element.prototype;
    const documentProto = Document.prototype;
    const parentNodeGetter = getOwnPropertyDescriptor(nodeProto, 'parentNode').get;
    const firstChildGetter = getOwnPropertyDescriptor(nodeProto, 'firstChild').get;
    const nextSiblingGetter = getOwnPropertyDescriptor(nodeProto, 'nextSibling').get;
    const nodeTypeGetter = getOwnPropertyDescriptor(nodeProto, 'nodeType').get;
    const nodeValueGetter = getOwnPropertyDescriptor(nodeProto, 'nodeValue').get;
    const localNameGetter = getOwnPropertyDescriptor(elementProto, 'localName').get;
    const getAttribute = getOwnPropertyDescriptor(elementProto, 'getAttribute').value;
    const getBoundingClientRect = getOwnPropertyDescriptor(elementProto, 'getBoundingClientRect').value;
    const queryDocument = getOwnPropertyDescriptor(documentProto, 'querySelector').value;
    const queryAllDocument = getOwnPropertyDescriptor(documentProto, 'querySelectorAll').value;
    const apply = (fn, receiver, args) => reflectApply(fn, receiver, args);
    const nodeIds = new WM();
    let nextId = 1;
    let savedScroll = null;
    const idOf = node => {
      let id = nodeIds.get(node);
      if (id === undefined) {
        id = nextId;
        nextId += 1;
        nodeIds.set(node, id);
      }
      return S(id);
    };
    const query = selector => apply(queryDocument, document, [selector]);
    const queryAll = selector => apply(queryAllDocument, document, [selector]);
    const nameOf = node => apply(localNameGetter, node, []);
    const attr = (node, key) => apply(getAttribute, node, [key]);
    const parseIndex = raw => {
      if (raw === null || raw === '') return null;
      if (raw === '-1') return -1;
      if (raw.length > 1 && raw[0] === '0') return null;
      const value = N(raw);
      if (!N.isSafeInteger(value) || value < 1) return null;
      return value;
    };
    const cellText = root => {
      let value = '';
      let current = apply(firstChildGetter, root, []);
      while (current) {
        const type = apply(nodeTypeGetter, current, []);
        if (type === 3) value += apply(nodeValueGetter, current, []) || '';
        const first = type === 1 ? apply(firstChildGetter, current, []) : null;
        if (first) current = first;
        else {
          let next = null;
          while (current && current !== root) {
            next = apply(nextSiblingGetter, current, []);
            if (next) break;
            current = apply(parentNodeGetter, current, []);
          }
          current = current === root ? null : next;
        }
      }
      return value;
    };
    const rowCells = tr => {
      const cells = [];
      let child = apply(firstChildGetter, tr, []);
      while (child) {
        if (apply(nodeTypeGetter, child, []) === 1) {
          const tag = nameOf(child);
          if (tag === 'th' || tag === 'td') cells[cells.length] = cellText(child);
        }
        child = apply(nextSiblingGetter, child, []);
      }
      return cells;
    };
    const collectRows = (parent, kind) => {
      const rows = [];
      let child = apply(firstChildGetter, parent, []);
      while (child) {
        if (apply(nodeTypeGetter, child, []) === 1 && nameOf(child) === 'tr') {
          rows[rows.length] = {
            kind: kind,
            mountedNodeId: idOf(child),
            rawAriaRowIndex: parseIndex(attr(child, 'aria-rowindex')),
            cells: rowCells(child),
          };
        }
        child = apply(nextSiblingGetter, child, []);
      }
      return rows;
    };
    const rememberScroll = container => {
      if (savedScroll) return;
      savedScroll = { container: container, top: container.scrollTop };
    };
    const sampleScroll = container => O.freeze({
      top: container.scrollTop,
      height: container.scrollHeight,
      clientHeight: container.clientHeight,
    });
    const loadMoreState = selector => {
      if (!selector) return O.freeze({ present: false, x: 0, y: 0 });
      const node = query(selector);
      if (!node || apply(parentNodeGetter, node, []) === null) {
        return O.freeze({ present: false, x: 0, y: 0 });
      }
      const rect = apply(getBoundingClientRect, node, []);
      return O.freeze({
        present: true,
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2,
      });
    };
    globalThis.__chromeCdpExTableCollector = {
      sample(tableSelector, scrollSelector, loadMoreSelector) {
        const list = queryAll(tableSelector);
        const matches = [];
        for (let i = 0; i < list.length; i += 1) matches[matches.length] = list[i];
        if (matches.length !== 1 || nameOf(matches[0]) !== 'table') {
          return J.stringify({ ok: false, error: 'collection requires exactly one HTML table' });
        }
        const table = matches[0];
        if (apply(parentNodeGetter, table, []) === null) {
          return J.stringify({ ok: false, error: 'table is detached' });
        }
        const container = query(scrollSelector);
        if (!container) return J.stringify({ ok: false, error: 'scroll-container not found' });
        rememberScroll(container);
        const headerRows = [];
        const dataRows = [];
        let child = apply(firstChildGetter, table, []);
        while (child) {
          if (apply(nodeTypeGetter, child, []) === 1) {
            const tag = nameOf(child);
            if (tag === 'thead') {
              const rows = collectRows(child, 'header');
              for (let index = 0; index < rows.length; index += 1) headerRows[headerRows.length] = rows[index];
            } else if (tag === 'tbody') {
              const rows = collectRows(child, 'data');
              for (let index = 0; index < rows.length; index += 1) dataRows[dataRows.length] = rows[index];
            }
          }
          child = apply(nextSiblingGetter, child, []);
        }
        const scroll = sampleScroll(container);
        return J.stringify({
          ok: true,
          ariaRowCount: parseIndex(attr(table, 'aria-rowcount')),
          headerRows: headerRows,
          dataRows: dataRows,
          scroll: scroll,
          scrollable: scroll.height > scroll.clientHeight,
          loadMore: loadMoreState(loadMoreSelector),
        });
      },
      scrollTo(scrollSelector, top) {
        const container = query(scrollSelector);
        if (!container) return J.stringify({ ok: false, error: 'scroll-container not found' });
        rememberScroll(container);
        container.scrollTop = top;
        if (typeof EventCtor === 'function') {
          const dispatch = container.dispatchEvent;
          if (typeof dispatch === 'function') apply(dispatch, container, [new EventCtor('scroll')]);
        }
        return J.stringify({ ok: true, scroll: sampleScroll(container) });
      },
      restore() {
        if (savedScroll) {
          savedScroll.container.scrollTop = savedScroll.top;
          if (typeof EventCtor === 'function') {
            const dispatch = savedScroll.container.dispatchEvent;
            if (typeof dispatch === 'function') apply(dispatch, savedScroll.container, [new EventCtor('scroll')]);
          }
        }
        return true;
      },
    };
    return true;
  })()`;
}

function parseCollectorPayload(value, fallback = 'isolated collector failed') {
  if (typeof value !== 'string') throw tableCollectorError(fallback);
  let parsed;
  try { parsed = JSON.parse(value); } catch { throw tableCollectorError(fallback); }
  if (!parsed || parsed.ok !== true) {
    throw tableCollectorError(parsed?.error || fallback);
  }
  return parsed;
}

function collectorIdentity(request, sample) {
  if (request.rowKeyColumn !== null && request.rowKeyColumn !== undefined) {
    return {
      identitySource: 'row-key-column',
      orderingSource: 'row-key-column',
      logicalRows: null,
      logicalCountSource: 'none',
      headerCount: sample.headerRows.length,
    };
  }
  const headerCount = sample.headerRows.length;
  for (let index = 0; index < headerCount; index += 1) {
    if (sample.headerRows[index].rawAriaRowIndex !== index + 1) {
      throw tableCollectorError('header aria-rowindex coverage is not contiguous from 1');
    }
  }
  const hasAria = sample.dataRows.every(row => Number.isSafeInteger(row.rawAriaRowIndex) && row.rawAriaRowIndex >= 1);
  if (!hasAria) {
    throw tableCollectorError('virtual collection requires aria-rowindex or --row-key-column');
  }
  return {
    identitySource: 'aria-rowindex',
    orderingSource: 'aria-rowindex',
    logicalRows: null,
    logicalCountSource: 'none',
    headerCount,
  };
}

function nextAriaLogicalRows(sample, headerCount, previousCount) {
  const raw = sample.ariaRowCount;
  if (raw === null || raw === -1) {
    if (previousCount !== undefined && previousCount !== null) {
      throw tableCollectorError('aria-rowcount drifted from a stable integer');
    }
    return null;
  }
  if (!Number.isSafeInteger(raw) || raw < headerCount) {
    throw tableCollectorError('aria-rowcount is not a stable safe integer');
  }
  if (previousCount !== undefined && previousCount !== raw - headerCount) {
    throw tableCollectorError('aria-rowcount drifted from a stable integer');
  }
  return raw - headerCount;
}

function collectorSamples(sample, identity) {
  return sample.dataRows.map(row => {
    let key;
    if (identity.identitySource === 'row-key-column') {
      key = row.cells[identity.rowKeyColumn];
      if (typeof key !== 'string') throw tableCollectorError('row-key-column is missing from a mounted row');
    } else {
      key = row.rawAriaRowIndex - identity.headerCount;
    }
    return {
      mountedNodeId: row.mountedNodeId,
      key,
      cells: row.cells,
    };
  });
}

function collectorProgress(before, after, admittedNew) {
  if (admittedNew) return true;
  if (before.scroll.top !== after.scroll.top) return true;
  if (before.scroll.height !== after.scroll.height) return true;
  if (before.loadMore.present && !after.loadMore.present) return true;
  return false;
}

function boundedCollectJson(model) {
  const mutable = structuredClone(model);
  let output = JSON.stringify(orderedCollectEnvelope(mutable), null, 2);
  while (Buffer.byteLength(output, 'utf8') > TABLE_EXTRACTION_LIMITS.maxResponseBytes) {
    if (!mutable.inline?.rows?.length) {
      throw new RangeError('table: collection metadata exceeds the JSON response byte ceiling');
    }
    mutable.inline.rows.pop();
    mutable.inline.rowCount = mutable.inline.rows.length;
    mutable.inline.bytes = Buffer.byteLength(mutable.inline.rows.join('\n'), 'utf8');
    mutable.inline.truncated = true;
    output = JSON.stringify(orderedCollectEnvelope(mutable), null, 2);
  }
  return output;
}

function orderedCollectEnvelope(model) {
  return {
    schema: model.schema,
    logicalRows: model.logicalRows,
    logicalCountSource: model.logicalCountSource,
    identitySource: model.identitySource,
    orderingSource: model.orderingSource,
    mountedRows: model.mountedRows,
    collectedRows: model.collectedRows,
    recycledMountedNodes: model.recycledMountedNodes,
    completeness: model.completeness,
    artifact: model.artifact,
    inline: model.inline,
    continuation: model.continuation,
  };
}

function boundedCollectText(model) {
  const rows = [...(model.inline?.rows || [])];
  const lines = () => [
    `Table collection: ${model.completeness.state}; collected ${model.collectedRows}`
      + (model.logicalRows === null ? '' : `/${model.logicalRows}`),
    ...rows,
    model.continuation?.token ? `Continuation: ${model.continuation.token}` : 'Continuation: none',
  ];
  let output = lines().join('\n');
  while (Buffer.byteLength(output, 'utf8') > 8192 && rows.length > 0) {
    rows.pop();
    output = lines().join('\n');
  }
  return output;
}

function formatCollectedTable(bundle, publication, continuation, format) {
  const manifest = bundle.manifest;
  const model = {
    schema: 'chrome-cdp-ex.table.v1',
    logicalRows: manifest.logicalRows,
    logicalCountSource: manifest.logicalCountSource,
    identitySource: manifest.identitySource,
    orderingSource: manifest.orderingSource,
    mountedRows: manifest.mountedRows,
    collectedRows: manifest.collectedRows,
    recycledMountedNodes: manifest.recycledMountedNodes,
    completeness: manifest.completeness,
    artifact: {
      id: publication.artifactId,
      rows: publication.artifact.rows,
      bytes: publication.artifact.bytes,
      checksum: publication.artifact.checksum,
      checksumScope: publication.artifact.checksumScope,
    },
    inline: manifest.inline,
    continuation: continuation.continuation,
  };
  return format === 'json' ? boundedCollectJson(model) : boundedCollectText(model);
}

async function tableCollectionStr(cdp, sid, request, execution, options = {}) {
  const store = options.store;
  const session = options.session || { collector: null };
  if (!store) throw tableCollectorError('artifact store is required for collection');
  if ((options.platform || process.platform) === 'win32') {
    throw tableCollectorError('private table artifacts are unavailable on Windows in v2.16');
  }
  if (session.collector) throw tableCollectorError('collector-busy');
  session.collector = true;
  let worldId = null;
  let restored = false;
  const listeners = [];
  let invalidated = null;
  const invalidate = error => {
    if (!invalidated) invalidated = error;
  };
  const throwIfInvalid = () => {
    if (invalidated) throw invalidated;
  };
  const runPage = async (runtime, operation) => runtime.runCdpOperation(async ({ timeoutMs }) => {
    throwIfInvalid();
    runtime.throwIfAborted();
    const result = await operation(timeoutMs);
    throwIfInvalid();
    runtime.throwIfAborted();
    return result;
  });
  const evaluate = (runtime, expression) => runPage(runtime, timeoutMs => cdpDomains(cdp).Runtime.evaluate({
    expression,
    contextId: worldId,
    objectGroup: TABLE_COLLECTOR_OBJECT_GROUP,
    returnByValue: true,
    awaitPromise: false,
  }, sid, timeoutMs).then(evaluated => {
    if (evaluated?.exceptionDetails) {
      throw tableCollectorError(boundedTableRuntimeDiagnostic(evaluated.exceptionDetails));
    }
    return evaluated?.result?.value;
  }));
  const samplePage = async runtime => parseCollectorPayload(
    await evaluate(
      runtime,
      `__chromeCdpExTableCollector.sample(${JSON.stringify(request.selector || 'table')},`
        + `${JSON.stringify(request.scrollContainer)},${JSON.stringify(request.loadMore || null)})`,
    ),
    'isolated collector sample failed',
  );
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    while (listeners.length) {
      try { listeners.pop()(); } catch {}
    }
    try {
      cdpDomains(cdp).Runtime.releaseObjectGroup({ objectGroup: TABLE_COLLECTOR_OBJECT_GROUP }, sid);
    } catch {}
    session.collector = false;
  };

  let cleaned = false;
  session.collector = true;
  try {
    return await runTableCollectionLifecycle(execution, {
      collect: async runtime => {
        runtime.throwIfAborted();
        if (runtime.remainingPageMs() <= 0) throw new TableCollectionDeadlineError('page');
        const frameTree = await runPage(runtime, timeoutMs => cdpDomains(cdp).Page.getFrameTree({}, sid, timeoutMs));
        const frameId = frameTree?.frameTree?.frame?.id;
        if (typeof frameId !== 'string' || frameId.length === 0) {
          throw tableCollectorError('root frame id is unavailable');
        }
        const world = await runPage(runtime, timeoutMs => cdpDomains(cdp).Page.createIsolatedWorld({
          frameId,
          worldName: TABLE_COLLECTOR_WORLD,
          grantUniveralAccess: false,
        }, sid, timeoutMs));
        worldId = world?.executionContextId;
        if (!Number.isSafeInteger(worldId) || worldId < 1) {
          throw tableCollectorError('isolated execution context is unavailable');
        }
        listeners.push(cdp.onEvent('Runtime.executionContextDestroyed', params => {
          if (params.executionContextId === worldId) {
            invalidate(tableCollectorError('isolated execution context was destroyed'));
          }
        }));
        listeners.push(cdp.onEvent('Page.frameNavigated', params => {
          if (!params?.frame?.parentId) {
            invalidate(tableCollectorError('root frame navigated during collection'));
          }
        }));
        listeners.push(cdp.onEvent('Target.detachedFromTarget', () => {
          invalidate(tableCollectorError('target detached during collection'));
        }));
        await evaluate(runtime, buildTableCollectorBootstrapExpression());
        let sample = await samplePage(runtime);
        const identity = collectorIdentity(request, sample);
        identity.rowKeyColumn = request.rowKeyColumn;
        if (identity.identitySource === 'aria-rowindex') {
          identity.logicalRows = nextAriaLogicalRows(sample, identity.headerCount);
          identity.logicalCountSource = identity.logicalRows === null ? 'none' : 'aria-rowcount';
        }
        const accumulator = createTableAccumulator({
          logicalRows: identity.logicalRows,
          logicalCountSource: identity.logicalCountSource,
          identitySource: identity.identitySource,
          orderingSource: identity.orderingSource,
        });
        const admit = current => {
          const batch = collectorSamples(current, identity);
          const admission = addTableSampleBatch(accumulator, batch);
          if (!admission.admitted) return admission;
          return { admitted: true, added: batch.length, collectedRows: admission.collectedRows };
        };
        let previousCollected = 0;
        let admission = admit(sample);
        if (!admission.admitted) {
          return { accumulator, termination: admission.reason, interactions: 0 };
        }
        previousCollected = admission.collectedRows;
        let interactions = 0;
        let noProgress = 0;
        const complete = () => {
          if (identity.identitySource !== 'aria-rowindex' || identity.logicalRows === null) return false;
          const result = finalizeTableExtraction(accumulator, { termination: 'logical-count-reached' });
          return result.completeness.state === 'complete';
        };
        try {
          while (!complete()) {
            runtime.throwIfAborted();
            throwIfInvalid();
            if (runtime.remainingPageMs() <= 0) {
              return { accumulator, termination: 'time-limit', interactions };
            }
            if (interactions >= TABLE_EXTRACTION_LIMITS.maxInteractions) {
              return { accumulator, termination: 'interaction-limit', interactions };
            }
            if (noProgress >= TABLE_EXTRACTION_LIMITS.maxNoProgressCycles) {
              return { accumulator, termination: 'no-progress-limit', interactions };
            }
            const before = sample;
            const maxTop = Math.max(0, before.scroll.height - before.scroll.clientHeight);
            if (before.loadMore.present && before.scroll.top >= maxTop) {
              await runPage(runtime, async timeoutMs => {
                const base = {
                  x: before.loadMore.x,
                  y: before.loadMore.y,
                  button: 'left',
                  clickCount: 1,
                  modifiers: 0,
                };
                await cdpDomains(cdp).Input.dispatchMouseEvent({ ...base, type: 'mouseMoved' }, sid, timeoutMs);
                await cdpDomains(cdp).Input.dispatchMouseEvent({ ...base, type: 'mousePressed' }, sid, timeoutMs);
                await cdpDomains(cdp).Input.dispatchMouseEvent({ ...base, type: 'mouseReleased' }, sid, timeoutMs);
              });
            } else if (before.scroll.top < maxTop) {
              const nextTop = Math.min(maxTop, before.scroll.top + Math.max(1, before.scroll.clientHeight));
              parseCollectorPayload(await evaluate(
                runtime,
                `__chromeCdpExTableCollector.scrollTo(${JSON.stringify(request.scrollContainer)},${nextTop})`,
              ), 'scroll-container is not scrollable');
            } else if (!before.scrollable && !before.loadMore.present) {
              const needsMore = identity.logicalRows !== null && previousCollected < identity.logicalRows;
              if (needsMore) throw tableCollectorError('scroll-container is not scrollable');
              return {
                accumulator,
                termination: identity.logicalRows === null ? 'no-progress-limit' : 'logical-count-reached',
                interactions,
              };
            } else {
              noProgress += 1;
              sample = await samplePage(runtime);
              continue;
            }
            interactions += 1;
            sample = await samplePage(runtime);
            if (identity.identitySource === 'aria-rowindex') {
              nextAriaLogicalRows(sample, identity.headerCount, identity.logicalRows);
            }
            if (sample.headerRows.length !== identity.headerCount) {
              throw tableCollectorError('header aria-rowindex coverage drifted');
            }
            for (let index = 0; index < identity.headerCount; index += 1) {
              if (sample.headerRows[index]?.rawAriaRowIndex !== index + 1) {
                throw tableCollectorError('header aria-rowindex coverage drifted');
              }
            }
            const collectedBefore = previousCollected;
            admission = admit(sample);
            if (!admission.admitted) {
              return { accumulator, termination: admission.reason, interactions };
            }
            previousCollected = admission.collectedRows;
            if (collectorProgress(before, sample, previousCollected > collectedBefore)) noProgress = 0;
            else noProgress += 1;
          }
        } catch (error) {
          if (error?.code === 'TABLE_COLLECTION_PAGE_DEADLINE') {
            runtime.clearLatePageInvocation();
            return { accumulator, termination: 'time-limit', interactions };
          }
          throw error;
        }
        if (runtime.remainingPageMs() > 0 && worldId !== null && !restored) {
          try {
            await evaluate(runtime, '__chromeCdpExTableCollector.restore()');
            restored = true;
          } catch {}
        }
        return { accumulator, termination: 'logical-count-reached', interactions };
      },
      finalize: async collection => {
        if (!collection?.accumulator) {
          throw collection?.error || new TableCollectionDeadlineError('page');
        }
        const bundle = buildTableExportBundle(collection.accumulator, {
          termination: collection.termination || 'error',
        });
        const publication = await store.publish(bundle, execution);
        const continuation = publication.artifact.rows > 0
          ? await store.readContinuation(publication.token)
          : {
            continuation: {
              token: null,
              offset: 0,
              rowCount: 0,
              rows: [],
              bytes: 0,
              nextToken: null,
            },
          };
        return formatCollectedTable(bundle, publication, continuation, request.format);
      },
      cleanup,
    });
  } finally {
    cleanup();
  }
}

// --- Navigation history ---
async function historyNavStr(cdp, sid, direction) {
  const { currentIndex, entries } = await cdpDomains(cdp).Page.getNavigationHistory( {}, sid);
  const targetIdx = currentIndex + direction;
  if (targetIdx < 0) throw new Error('No previous page in history');
  if (targetIdx >= entries.length) throw new Error('No forward page in history');
  await cdpDomains(cdp).Page.navigateToHistoryEntry( { entryId: entries[targetIdx].id }, sid);
  await sleep(500);
  const url = await evalStr(cdp, sid, 'window.location.href');
  return `Navigated ${direction < 0 ? 'back' : 'forward'} to: ${url}`;
}

async function reloadStr(cdp, sid) {
  await cdpDomains(cdp).Page.enable( {}, sid);
  const loadEvent = cdp.waitForEvent('Page.loadEventFired', RELOAD_EVENT_TIMEOUT);
  try {
    await cdpDomains(cdp).Page.reload( {}, sid, RELOAD_DISPATCH_TIMEOUT);
  } catch (e) {
    if (!isTimeoutError(e, ['Page.reload'])) throw e;
  }
  try {
    await Promise.race([
      loadEvent.promise,
      waitForDocumentReady(cdp, sid, RELOAD_READY_TIMEOUT, { probeTimeoutMs: RELOAD_READY_PROBE_TIMEOUT }),
    ]);
  } catch {
    // Some embedded/live targets do not reliably emit Page.loadEventFired after
    // reload. Action feedback still performs a bounded post-reload observation.
  } finally {
    loadEvent.cancel?.();
  }
  return 'Page reloaded';
}

async function observeReloadPage(cdp, sid) {
  return observePageState(cdp, sid, 'Reload observation');
}

async function observeNavPage(cdp, sid) {
  return observePageState(cdp, sid, 'Navigation observation');
}

async function observePageState(cdp, sid, heading = 'Page observation') {
  const result = await cdpDomains(cdp).Runtime.evaluate( {
    expression: `JSON.stringify({
      title: document.title || '',
      url: window.location.href || '',
      readyState: document.readyState || '',
      contentType: document.contentType || ''
    })`,
    returnByValue: true,
    awaitPromise: true,
  }, sid, RELOAD_OBSERVE_TIMEOUT);
  if (result.exceptionDetails) {
    throw new Error(runtimeExceptionMessage(result.exceptionDetails));
  }
  const value = result.result?.value;
  const parsed = typeof value === 'string' ? JSON.parse(value) : (value || {});
  return [
    `${heading}:`,
    `Page: ${parsed.title || '(untitled)'}`,
    `URL: ${parsed.url || '(unknown)'}`,
    `Ready state: ${parsed.readyState || '(unknown)'}`,
    parsed.contentType ? `contentType: ${parsed.contentType}` : null,
  ].filter(Boolean).join('\n');
}

async function reloadActionDispatch({ cdp, sessionId, session, consoleBuf, exceptionBuf, navBuf, netReqBuf, pendingReqs, lastReadSeq }) {
  const reloadResult = await reloadStr(cdp, sessionId);
  clearObservationBuffers({ consoleBuf, exceptionBuf, navBuf, netReqBuf, pendingReqs, lastReadSeq });
  invalidateSessionRefs(session, 'navigation');
  return `${reloadResult} (console/exception/navigation buffers cleared)`;
}

// --- Inject: live CSS/JS injection with tracking ---
async function injectStr(cdp, sid, args) {
  const type = args[0];
  const content = args.slice(1).join(' ');

  if (type === '--remove') {
    const selector = content
      ? `[data-cdp-inject="${content}"]`
      : '[data-cdp-inject]';
    return evalStr(cdp, sid, `(() => {
      const els = document.querySelectorAll(${JSON.stringify(selector)});
      els.forEach(el => el.remove());
      return els.length + ' element(s) removed';
    })()`);
  }

  if (type === '--css') {
    if (!content) throw new Error('CSS text required: inject --css "body { background: red }"');
    return evalStr(cdp, sid, `(() => {
      const id = 'inject-' + (document.querySelectorAll('[data-cdp-inject]').length + 1);
      const s = document.createElement('style');
      s.setAttribute('data-cdp-inject', id);
      s.textContent = ${JSON.stringify(content)};
      document.head.appendChild(s);
      return id;
    })()`);
  }

  if (type === '--css-file') {
    if (!content) throw new Error('URL required: inject --css-file https://example.com/style.css');
    validateUrl(content);
    return evalStr(cdp, sid, `new Promise((resolve, reject) => {
      const id = 'inject-' + (document.querySelectorAll('[data-cdp-inject]').length + 1);
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = ${JSON.stringify(content)};
      link.setAttribute('data-cdp-inject', id);
      link.onload = () => resolve(id);
      link.onerror = () => reject(new Error('Failed to load stylesheet: ' + ${JSON.stringify(content)}));
      document.head.appendChild(link);
    })`);
  }

  if (type === '--js-file') {
    if (!content) throw new Error('URL required: inject --js-file https://example.com/lib.js');
    validateUrl(content);
    return evalStr(cdp, sid, `new Promise((resolve, reject) => {
      const id = 'inject-' + (document.querySelectorAll('[data-cdp-inject]').length + 1);
      const s = document.createElement('script');
      s.src = ${JSON.stringify(content)};
      s.setAttribute('data-cdp-inject', id);
      s.onload = () => resolve(id);
      s.onerror = () => reject(new Error('Failed to load script: ' + ${JSON.stringify(content)}));
      document.head.appendChild(s);
    })`);
  }

  throw new Error('inject requires --css, --css-file, --js-file, or --remove\n  inject --css "body { color: red }"   inject inline CSS\n  inject --css-file <url>              load external stylesheet\n  inject --js-file <url>               load external script\n  inject --remove [id]                 remove injected element(s)');
}

// --- Record: short timeline capture around actions / waits ---
function formatRecordEvent(e, startTs) {
  const rel = Math.max(0, e.ts - startTs).toString().padStart(5, ' ');
  if (e.kind === 'dom') return `  +${rel}ms DOM ${e.summary}`;
  if (e.kind === 'console') return `  +${rel}ms console.${e.level}: ${e.text}${e.loc ? ' (' + e.loc + ')' : ''}`;
  if (e.kind === 'exception') return `  +${rel}ms exception: ${e.msg}${e.loc ? ' (' + e.loc + ')' : ''}`;
  if (e.kind === 'network') return `  +${rel}ms ${e.method} ${e.url} → ${e.status} (${e.duration}ms)`;
  if (e.kind === 'navigation') return `  +${rel}ms navigation ${e.url}`;
  if (e.kind === 'action') return `  +${rel}ms action ${e.summary}`;
  return `  +${rel}ms ${e.kind || 'event'} ${e.summary || ''}`.trimEnd();
}

function parseRecordArgs(args) {
  const opts = { durationMs: 1000, until: null, action: null, actionArgs: [], explicitDuration: false };
  const setUntil = (val) => {
    const v = (val || '').toLowerCase();
    if (!['dom stable', 'network idle', 'auto settle'].includes(v)) throw new Error('record --until supports "dom stable" or "network idle"');
    opts.until = v;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--action') {
      opts.action = args[++i];
      if (!opts.action) throw new Error('record --action requires an action command (click, press, fill, select, type, scroll, nav)');
      const rest = args.slice(i + 1);
      const actionArgs = [];
      for (let j = 0; j < rest.length; j++) {
        const a = rest[j];
        if (a === '--until') { setUntil(rest[++j]); continue; }
        if (/^\d+$/.test(a) && j === rest.length - 1) {
          opts.durationMs = Math.min(Math.max(parseInt(a), 100), 30000);
          opts.explicitDuration = true;
          continue;
        }
        actionArgs.push(a);
      }
      opts.actionArgs = actionArgs;
      break;
    }
    if (arg === '--until') { setUntil(args[++i]); continue; }
    if (/^\d+$/.test(arg)) {
      opts.durationMs = Math.min(Math.max(parseInt(arg), 100), 30000);
      opts.explicitDuration = true;
      continue;
    }
    throw new Error(`Unknown record argument: ${arg}`);
  }
  // --action with no explicit duration and no --until: auto-settle (DOM/network quiet)
  // Cap: 5s for DOM-only, 10s if network activity observed.
  if (opts.action && !opts.until && !opts.explicitDuration) {
    opts.until = 'auto settle';
    opts.durationMs = 10000;
  } else if (opts.until && !opts.explicitDuration) {
    opts.durationMs = 30000;
  }
  return opts;
}

async function collectDomMutationSummary(cdp, sid) {
  const raw = await evalStr(cdp, sid, `(function() {
    const bucket = window.__cdp_record_mutations || [];
    window.__cdp_record_mutations = [];
    const totals = { added: 0, removed: 0, attributes: 0, characterData: 0 };
    const labels = [];
    for (const m of bucket) {
      if (m.type === 'childList') { totals.added += m.added || 0; totals.removed += m.removed || 0; }
      else if (m.type === 'attributes') totals.attributes += 1;
      else if (m.type === 'characterData') totals.characterData += 1;
      if (m.label && labels.length < 4) labels.push(m.label);
    }
    return JSON.stringify({ totals, labels, count: bucket.length });
  })()`);
  const parsed = JSON.parse(raw || '{}');
  if (!parsed.count) return null;
  const parts = [];
  if (parsed.totals.added) parts.push(`${parsed.totals.added} added`);
  if (parsed.totals.removed) parts.push(`${parsed.totals.removed} removed`);
  if (parsed.totals.attributes) parts.push(`${parsed.totals.attributes} attr`);
  if (parsed.totals.characterData) parts.push(`${parsed.totals.characterData} text`);
  const labelText = parsed.labels?.length ? ` [${parsed.labels.join('; ')}]` : '';
  return `${parts.join(', ') || parsed.count + ' mutation(s)'}${labelText}`;
}

async function installRecordMutationObserver(cdp, sid) {
  await evalStr(cdp, sid, `(function() {
    if (window.__cdp_record_observer) { window.__cdp_record_mutations = []; return 'already'; }
    window.__cdp_record_mutations = [];
    const label = (node) => {
      if (!node || node.nodeType !== 1) return '';
      const el = node;
      const id = el.id ? '#' + el.id : '';
      const cls = typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\\s+/).slice(0,2).join('.') : '';
      const text = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40);
      return '<' + el.tagName.toLowerCase() + id + cls + '>' + (text ? ' "' + text + '"' : '');
    };
    window.__cdp_record_observer = new MutationObserver((mutations) => {
      const out = window.__cdp_record_mutations || (window.__cdp_record_mutations = []);
      for (const m of mutations) {
        out.push({
          type: m.type,
          added: m.addedNodes ? m.addedNodes.length : 0,
          removed: m.removedNodes ? m.removedNodes.length : 0,
          attr: m.attributeName || '',
          label: label(m.target) || label(m.addedNodes && m.addedNodes[0]) || label(m.removedNodes && m.removedNodes[0]),
        });
      }
      if (out.length > 200) out.splice(0, out.length - 200);
    });
    window.__cdp_record_observer.observe(document.documentElement || document, { subtree: true, childList: true, attributes: true, characterData: true });
    return 'installed';
  })()`);
}

async function recordStr(cdp, sid, args, refs) {
  const opts = parseRecordArgs(args);
  const startTs = Date.now();
  const events = [];
  const offConsole = cdp.onEvent?.('Runtime.consoleAPICalled', (params) => {
    const text = (params.args || []).map(a => a.value ?? a.description ?? JSON.stringify(a)).join(' ');
    events.push({ kind: 'console', level: params.type || 'log', text, ts: Date.now() });
  });
  const offException = cdp.onEvent?.('Runtime.exceptionThrown', (params) => {
    events.push({ kind: 'exception', msg: params.exceptionDetails?.exception?.description || params.exceptionDetails?.text || 'Unknown error', ts: Date.now() });
  });
  const pending = new Map();
  const offReq = cdp.onEvent?.('Network.requestWillBeSent', (params) => {
    if (['XHR','Fetch','Document'].includes(params.type)) pending.set(params.requestId, { method: params.request.method, url: params.request.url.substring(0, 160), ts: Date.now() });
  });
  const offRes = cdp.onEvent?.('Network.responseReceived', (params) => {
    const req = pending.get(params.requestId);
    if (!req) return;
    pending.delete(params.requestId);
    events.push({ kind: 'network', ...req, status: params.response.status, duration: Date.now() - req.ts, ts: Date.now() });
  });
  const offNav = cdp.onEvent?.('Page.frameNavigated', (params) => {
    if (!params.frame?.parentId) events.push({ kind: 'navigation', url: params.frame?.url || '', ts: Date.now() });
  });

  // Wrap setup/action/loop in try/finally so the temporary listeners are
  // always detached — including when an action throws (unsupported action,
  // click/fill failure, CDP error). Leaking listeners would pollute future
  // record/timeline runs on the same daemon.
  try {
    try { await cdpDomains(cdp).Runtime.enable( {}, sid); } catch {}
    try { await cdpDomains(cdp).Page.enable( {}, sid); } catch {}
    try { await cdpDomains(cdp).DOM.enable( {}, sid); } catch {}
    try { await cdpDomains(cdp).Network.enable( {}, sid); } catch {}
    await installRecordMutationObserver(cdp, sid);

    let actionText = null;
    if (opts.action) {
      if (opts.action === 'click') actionText = await clickStr(cdp, sid, opts.actionArgs[0], refs);
      else if (opts.action === 'press') actionText = await pressStr(cdp, sid, opts.actionArgs[0]);
      else if (opts.action === 'fill') actionText = await fillStr(cdp, sid, opts.actionArgs[0], opts.actionArgs.slice(1).join(' '), refs);
      else if (opts.action === 'select') actionText = await selectStr(cdp, sid, opts.actionArgs[0], opts.actionArgs[1]);
      else if (opts.action === 'type') actionText = await typeStr(cdp, sid, opts.actionArgs.join(' '));
      else if (opts.action === 'scroll') actionText = await scrollStr(cdp, sid, opts.actionArgs[0], opts.actionArgs[1], opts.actionArgs.slice(2));
      else if (opts.action === 'nav' || opts.action === 'navigate') actionText = await navStr(cdp, sid, opts.actionArgs[0]);
      else throw new Error(`record --action does not support: ${opts.action}`);
      events.push({ kind: 'action', summary: actionText.split('\n')[0], ts: Date.now() });
    }

    let quietSince = Date.now();
    let networkSeen = false;
    const deadline = Date.now() + opts.durationMs;
    // Auto-settle cap: 5s if no network activity has been observed yet, else 10s.
    const autoCap = () => Date.now() - startTs >= (networkSeen ? 10000 : 5000);
    while (Date.now() < deadline) {
      await sleep(Math.min(100, deadline - Date.now()));
      const domSummary = await collectDomMutationSummary(cdp, sid);
      if (domSummary) { events.push({ kind: 'dom', summary: domSummary, ts: Date.now() }); quietSince = Date.now(); }
      if (pending.size > 0 || events.some(e => e.kind === 'network')) networkSeen = true;
      if (opts.until === 'network idle' && pending.size === 0 && Date.now() - quietSince >= 500) break;
      if (opts.until === 'dom stable' && Date.now() - quietSince >= 500) break;
      if (opts.until === 'auto settle' && pending.size === 0 && Date.now() - quietSince >= 500) break;
      if (opts.until === 'auto settle' && autoCap()) break;
      if (!opts.until && Date.now() >= deadline) break;
    }

    const lines = [`Record timeline (${Date.now() - startTs}ms${opts.action ? `, action: ${opts.action}` : ''}${opts.until ? `, until: ${opts.until}` : ''})`];
    if (actionText) lines.push(`Action: ${actionText.split('\n')[0]}`);
    if (events.length === 0) lines.push('  (no DOM, console, exception, navigation, or XHR/Fetch/Document network events observed)');
    else for (const e of events.sort((a,b) => a.ts - b.ts)) lines.push(formatRecordEvent(e, startTs));
    return lines.join('\n');
  } finally {
    offConsole?.();
    offException?.();
    offReq?.();
    offRes?.();
    offNav?.();
  }
}

// --- Cascade: CSS origin tracing via CSS.getMatchedStylesForNode ---
const INHERITABLE_PROPS = new Set([
  'color', 'font-family', 'font-size', 'font-weight', 'font-style',
  'line-height', 'letter-spacing', 'text-align', 'text-indent',
  'text-transform', 'white-space', 'word-spacing', 'visibility',
  'cursor', 'direction', 'list-style',
]);

// Strip Vite/CSS Module query suffixes (?vue&type=style&lang.css, ?direct, ?used)
function stripVitePathQuery(url) {
  if (!url) return url;
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

const _B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function decodeVLQ(str) {
  const out = [];
  let value = 0, shift = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = _B64.indexOf(str[i]);
    if (ch === -1) return out;
    const cont = ch & 32;
    const digit = ch & 31;
    value += digit << shift;
    shift += 5;
    if (!cont) {
      const negate = value & 1;
      out.push(negate ? -(value >> 1) : (value >> 1));
      value = 0; shift = 0;
    }
  }
  return out;
}

// Walk source-map mappings to find first segment on generated line `genLine0`
function mapLineToSource(mappings, genLine0) {
  if (typeof mappings !== 'string' || !mappings) return null;
  const lines = mappings.split(';');
  if (genLine0 < 0 || genLine0 >= lines.length) return null;
  let srcIdx = 0, origLine = 0, origCol = 0;
  let result = null;
  for (let i = 0; i <= genLine0; i++) {
    const segments = lines[i].split(',');
    for (const seg of segments) {
      if (!seg) continue;
      const vals = decodeVLQ(seg);
      if (vals.length >= 4) {
        srcIdx += vals[1];
        origLine += vals[2];
        origCol += vals[3];
        if (i === genLine0 && result === null) {
          result = { srcIdx, origLine, origCol };
        }
      }
    }
  }
  return result;
}

function mapInlineSourceMap(sheetText, genLine0) {
  const m = sheetText.match(/sourceMappingURL=data:application\/json[^,]*?base64,([A-Za-z0-9+/=]+)/);
  if (!m) return null;
  let json;
  try {
    const decoded = Buffer.from(m[1], 'base64').toString('utf8');
    json = JSON.parse(decoded);
  } catch { return null; }
  const sources = json.sources || [];
  if (sources.length === 0) return null;
  const mapping = mapLineToSource(json.mappings || '', genLine0);
  const srcIdx = mapping ? Math.max(0, Math.min(mapping.srcIdx, sources.length - 1)) : 0;
  const origLine = mapping ? mapping.origLine : genLine0;
  const sourceRoot = (json.sourceRoot || '').replace(/\/$/, '');
  const rawSrc = sources[srcIdx] || '';
  if (!rawSrc) return null;
  const fullPath = sourceRoot ? `${sourceRoot}/${rawSrc}` : rawSrc;
  return `${stripVitePathQuery(fullPath)}:${origLine + 1}`;
}

// Map a stylesheet line to the most-informative source location available
function mapStyleSource(sheetText, sheetId, genLine0) {
  const text = sheetText || '';
  const inline = mapInlineSourceMap(text, genLine0);
  if (inline) return inline;
  const sourceUrl = text.match(/\/\*#?\s*sourceURL=([^*\n]+)\s*\*\//)?.[1]
    || text.match(/\/\/# sourceURL=([^\n]+)/)?.[1];
  if (sourceUrl) return `${stripVitePathQuery(sourceUrl.trim())}:${genLine0 + 1}`;
  const mapUrl = text.match(/sourceMappingURL=([^\s*]+)/)?.[1];
  if (mapUrl && !mapUrl.startsWith('data:')) {
    return `${stripVitePathQuery(mapUrl.trim().replace(/\.map$/, ''))}:${genLine0 + 1}`;
  }
  return `${sheetId}:${genLine0 + 1}`;
}

async function resolveStyleSource(cdp, sid, rule) {
  const origin = rule.origin;
  if (origin === 'user-agent') return 'user-agent stylesheet';
  const sheetId = rule.style?.styleSheetId;
  if (!sheetId) return origin === 'regular' ? 'inline style' : (origin || 'unknown stylesheet');
  const range = rule.style.range;
  const genLine0 = range ? range.startLine : 0;
  let header;
  try { header = await cdpDomains(cdp).CSS.getStyleSheetText( { styleSheetId: sheetId }, sid); } catch {}
  return mapStyleSource(header?.text || '', sheetId, genLine0);
}

function cssDeclarationImportant(prop = {}) {
  if (prop.important === true) return true;
  if (String(prop.important || '').toLowerCase() === 'important') return true;
  return /\s!important\s*$/i.test(String(prop.text || ''));
}

function cascadeDeclarationRank(rule = {}) {
  const important = rule.important === true;
  const inline = rule.origin === 'inline';
  const userAgent = rule.origin === 'user-agent';
  if (userAgent && important) return 50;
  if (inline && important) return 40;
  if (important) return 30;
  if (inline) return 20;
  if (userAgent) return 0;
  return 10;
}

async function cascadeStr(cdp, sid, selector, property, refMap, refState, opts = {}) {
  if (!selector) throw new Error('CSS selector or @ref required');
  const targetPrefix = opts.targetPrefix || '<target>';
  await assertNotPdfViewerPage(cdp, sid, { targetPrefix });

  // CSS.getMatchedStylesForNode requires these domains/document state. Enable
  // them inside cascade so the first call works even before evalraw/perceive.
  try { await cdpDomains(cdp).DOM.enable( {}, sid); } catch {}
  try { await cdpDomains(cdp).CSS.enable( {}, sid); } catch {}
  const { root } = await cdpDomains(cdp).DOM.getDocument( {}, sid);

  // Resolve element to DOM nodeId
  let nodeId;
  if (isRef(selector)) {
    const frameParsed = parseFrameRef(selector);
    let backendNodeId;
    if (frameParsed) {
      backendNodeId = frameScopedBackendNode(refState || {}, frameParsed).backendNodeId;
    } else {
      const num = parseInt(selector.slice(1));
      backendNodeId = refMap.get(num);
      if (!backendNodeId) throw new Error(formatUnknownRefError(selector, refState || {}));
    }
    const { nodeIds } = await cdpDomains(cdp).DOM.pushNodesByBackendIdsToFrontend(
      { backendNodeIds: [backendNodeId] }, sid);
    nodeId = nodeIds[0];
  } else {
    const result = await cdpDomains(cdp).DOM.querySelector(
      { nodeId: root.nodeId, selector }, sid);
    if (!result.nodeId) throw new Error('Element not found: ' + selector);
    nodeId = result.nodeId;
  }

  // Get matched styles + computed style in parallel
  const [matched, computed] = await Promise.all([
    cdpDomains(cdp).CSS.getMatchedStylesForNode( { nodeId }, sid),
    cdpDomains(cdp).CSS.getComputedStyleForNode( { nodeId }, sid),
  ]);

  // Build computed value lookup
  const computedMap = new Map();
  for (const c of computed.computedStyle || []) {
    computedMap.set(c.name, c.value);
  }

  // Collect rules by property
  const propRules = new Map();
  for (const match of matched.matchedCSSRules || []) {
    const rule = match.rule;
    const selectorText = rule.selectorList?.text || '?';
    const origin = rule.origin; // 'regular', 'user-agent', 'injected', 'inspector'
    const source = await resolveStyleSource(cdp, sid, rule);

    for (const prop of rule.style?.cssProperties || []) {
      if (prop.disabled || !prop.value) continue;
      if (prop.name.startsWith('-webkit-') || prop.name.startsWith('-moz-')) continue;
      if (property && prop.name !== property) continue;
      if (!propRules.has(prop.name)) propRules.set(prop.name, []);
      propRules.get(prop.name).push({
        value: prop.value,
        selector: selectorText,
        source,
        origin,
        important: cssDeclarationImportant(prop),
      });
    }
  }

  // Inline styles (highest specificity — style="" attribute)
  for (const prop of matched.inlineStyle?.cssProperties || []) {
    if (prop.disabled || !prop.value) continue;
    if (prop.name.startsWith('-webkit-') || prop.name.startsWith('-moz-')) continue;
    if (property && prop.name !== property) continue;
    if (!propRules.has(prop.name)) propRules.set(prop.name, []);
    // Inline styles beat non-important stylesheet rules. Keep them last so
    // same-rank ties still follow cascade order; !important is ranked separately.
    propRules.get(prop.name).push({
      value: prop.value,
      selector: '[inline]',
      source: 'inline style attribute',
      origin: 'inline',
      important: cssDeclarationImportant(prop),
    });
  }

  const normalizeCssValue = (v) => String(v || '')
    .trim()
    .replace(/\s*,\s*/g, ', ')
    .replace(/\s+/g, ' ');
  const cssValuesEquivalent = (specified, computed) => {
    const a = normalizeCssValue(specified).toLowerCase();
    const b = normalizeCssValue(computed).toLowerCase();
    if (a === b) return true;
    const aliases = { bold: '700', normal: '400' };
    return aliases[a] === b || aliases[b] === a;
  };
  const cascadeWinnerIndex = (rules, computedVal) => {
    let bestRank = -1;
    for (const rule of rules) {
      const rank = cascadeDeclarationRank(rule);
      if (rank > bestRank) bestRank = rank;
    }
    let equivalent = -1;
    let lastAtRank = -1;
    for (let i = 0; i < rules.length; i++) {
      if (cascadeDeclarationRank(rules[i]) !== bestRank) continue;
      lastAtRank = i;
      if (cssValuesEquivalent(rules[i].value, computedVal)) equivalent = i;
    }
    return equivalent >= 0 ? equivalent : lastAtRank;
  };

  // Dedupe identical (selector, normalized value, source, origin) entries per property.
  // CDP can return repeated matchedCSSRules / cssProperties (e.g. same rule
  // matched via multiple selectors in the selectorList, or authored vs normalized
  // values like rgb(37,99,235) vs rgb(37, 99, 235)); rendering them twice
  // misleadingly implies multiple independent winning rules.
  for (const [name, rules] of propRules) {
    const seen = new Set();
    const deduped = [];
    for (const r of rules) {
      const key = `${r.selector}\u0000${normalizeCssValue(r.value)}\u0000${r.source}\u0000${r.origin}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(r);
    }
    propRules.set(name, deduped);
  }

  const hasInherited = (matched.inherited || []).some(inh =>
    inh.matchedCSSRules?.some(m =>
      m.rule.style?.cssProperties?.some(p => !p.disabled && p.value && INHERITABLE_PROPS.has(p.name))));

  if (propRules.size === 0 && !hasInherited && !property) {
    if (opts.format === 'json') {
      return formatJson({
        schema: 'chrome-cdp-ex.cascade.v1',
        input: { selector, property: null },
        propertyCount: 0,
        properties: [],
        inherited: [],
        editTarget: null,
        message: 'No matching CSS rules found for this element',
      });
    }
    return 'No matching CSS rules found for this element';
  }
  if (propRules.size === 0 && !hasInherited && property) {
    const computed = computedMap.get(property);
    if (opts.format === 'json') {
      return formatJson({
        schema: 'chrome-cdp-ex.cascade.v1',
        input: { selector, property },
        propertyCount: computed ? 1 : 0,
        properties: computed ? [{
          name: property,
          computedValue: computed,
          winner: null,
          rules: [],
          note: 'computed, no explicit rule found',
        }] : [],
        inherited: [],
        editTarget: null,
        message: computed
          ? `${property}: ${computed} (computed, no explicit rule found)`
          : `Property "${property}" not found on this element`,
      });
    }
    return computed
      ? `${property}: ${computed} (computed, no explicit rule found)`
      : `Property "${property}" not found on this element`;
  }

  // Format output
  const lines = [];
  const properties = [];
  for (const [prop, rules] of propRules) {
    const computedVal = computedMap.get(prop);
    if (!computedVal) continue;

    lines.push(`${prop}: ${computedVal}`);
    const ruleModels = [];
    let winner = null;
    const winnerIndex = cascadeWinnerIndex(rules, computedVal);
    for (const [index, r] of rules.entries()) {
      const isWinner = index === winnerIndex;
      const mark = isWinner ? '✓' : '✗';
      const note = isWinner ? '' : '  [overridden]';
      const ruleModel = {
        selector: r.selector,
        value: r.value,
        source: r.source,
        origin: r.origin || null,
        winner: isWinner,
        overridden: !isWinner,
      };
      ruleModels.push(ruleModel);
      if (isWinner && !winner) winner = {
        selector: r.selector,
        value: r.value,
        source: r.source,
        origin: r.origin || null,
      };
      lines.push(`  ${mark} ${r.selector} { ${prop}: ${r.value} }${note}`);
      lines.push(`    → ${r.source}`);
    }
    properties.push({
      name: prop,
      computedValue: computedVal,
      winner,
      rules: ruleModels,
    });
    lines.push('');
  }

  // Inherited properties
  const inherited = matched.inherited || [];
  const inheritedLines = [];
  const inheritedModels = [];
  for (const inh of inherited) {
    for (const match of inh.matchedCSSRules || []) {
      const rule = match.rule;
      for (const prop of rule.style?.cssProperties || []) {
        if (prop.disabled || !prop.value) continue;
        if (!INHERITABLE_PROPS.has(prop.name)) continue;
        if (property && prop.name !== property) continue;
        const selectorText = rule.selectorList?.text || '?';
        const source = await resolveStyleSource(cdp, sid, rule);
        inheritedLines.push(`  ${prop.name}: ${prop.value}  ← ${selectorText}  → ${source}`);
        inheritedModels.push({
          name: prop.name,
          value: prop.value,
          selector: selectorText,
          source,
          origin: rule.origin || null,
        });
      }
    }
  }
  if (inheritedLines.length > 0) {
    lines.push('Inherited:');
    // Deduplicate identical lines (CDP can repeat the same inherited rule
    // across multiple ancestors / selectors); distinct (selector, source)
    // entries with the same property+value are still preserved.
    const seen = new Set();
    for (const l of inheritedLines) {
      if (seen.has(l)) continue;
      seen.add(l);
      lines.push(l);
    }
  }

  if (opts.format === 'json') {
    const editProperty = property
      ? properties.find(entry => entry.name === property)
      : properties.find(entry => entry.winner);
    const editTarget = editProperty?.winner
      ? {
        property: editProperty.name,
        selector: editProperty.winner.selector,
        value: editProperty.winner.value,
        source: editProperty.winner.source,
        origin: editProperty.winner.origin || null,
      }
      : null;
    return formatJson({
      schema: 'chrome-cdp-ex.cascade.v1',
      input: { selector, property: property || null },
      propertyCount: properties.length,
      properties,
      inherited: inheritedModels,
      editTarget,
      recommendation: editTarget
        ? {
          source: 'cascade',
          strategy: 'edit-winning-source',
          property: editTarget.property,
          selector: editTarget.selector,
          sourceLocation: editTarget.source,
        }
        : {
          source: 'cascade',
          strategy: 'inspect-computed-style',
        },
    });
  }

  return lines.join('\n').trim() || 'No matching CSS rules found';
}

// --- Tab close ---
async function closetabStr(cdp, targetId) {
  await cdpDomains(cdp).Target.closeTarget( { targetId });
  return `Closed tab: ${targetId.slice(0, 8)}`;
}

// --- Batch result formatting ---
function firstNonEmptyLine(value, limit = 240) {
  const line = String(value ?? '').split('\n').map(s => s.trim()).find(Boolean) || '';
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

function maybeParseJson(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return null;
  try { return JSON.parse(trimmed); } catch { return null; }
}

function actionDispatchSemanticsFromModel(model = null) {
  if (!model || typeof model !== 'object' || Array.isArray(model)) {
    return { action: null, dispatch: null };
  }
  if (model.schema === 'chrome-cdp-ex.action.v1') {
    return { action: model, dispatch: model.dispatch || null };
  }
  if (model.schema === 'chrome-cdp-ex.semantic-interaction.v1') {
    const action = model.actionEvidence?.schema === 'chrome-cdp-ex.action.v1'
      ? model.actionEvidence
      : null;
    return { action, dispatch: model.dispatch || action?.dispatch || null };
  }
  if (model.schema === 'chrome-cdp-ex.qa-page.v1'
    && model.action?.schema === 'chrome-cdp-ex.semantic-interaction.v1') {
    return actionDispatchSemanticsFromModel(model.action);
  }
  if (model.action?.schema === 'chrome-cdp-ex.action.v1') {
    return { action: model.action, dispatch: model.action.dispatch || null };
  }
  return { action: null, dispatch: null };
}

function actionDispatchFailureMessage(action = null, dispatch = null) {
  return dispatch?.error
    || action?.effects?.failure?.originalMessage
    || action?.effects?.failure?.reason
    || 'Action dispatch failed';
}

function commandOwnsActionEvidence(command = null) {
  const record = COMMAND_SURFACE.resolve(command);
  return record?.kind === 'mutation'
    && record.evidencePolicy === 'action-receipt'
    && record.feedbackPolicy !== null;
}

function commandCatalogName(command = null) {
  return COMMAND_SURFACE.resolve(command)?.name || command || '';
}

function batchOutputHasFailure(output, parsed = maybeParseJson(output)) {
  if (parsed?.schema === 'chrome-cdp-ex.batch.v1') return Number(parsed.counts?.failed) > 0;
  if (Array.isArray(parsed)) return parsed.some(step => step && step.ok === false);
  return / \(error\)|: ERROR /m.test(String(output || ''));
}

function semanticAssertionFailureMessage(model = null, output = '') {
  const failed = (model?.assertions || [])
    .filter(assertion => assertion?.status === 'fail')
    .map(assertion => assertion.message)
    .filter(Boolean);
  if (failed.length) return failed.join('; ');
  if (/^Verdict:\s*fail$/m.test(String(output || ''))) return 'Verdict: fail';
  return 'assertion failed';
}

function classifyCommandResultSemantics(result = null, { command = null } = {}) {
  const transportOk = result?.ok === true
    || (Number.isInteger(result?.code) && result.code === 0);
  const output = Object.hasOwn(result || {}, 'result') ? result.result : result?.stdout;
  const parsed = maybeParseJson(output);
  const ownsAction = commandOwnsActionEvidence(command);
  const catalogName = commandCatalogName(command);
  const model = ownsAction || catalogName === 'batch' ? parsed : null;
  const { action, dispatch } = actionDispatchSemanticsFromModel(ownsAction ? parsed : null);
  const dispatchFailed = dispatch?.ok === false;
  const assertionFailed = catalogName === 'verify-click' && (
    parsed?.verdict === 'fail'
    || /^Verdict:\s*fail$/m.test(String(output || ''))
  );
  const batchFailed = catalogName === 'batch' && batchOutputHasFailure(output, parsed);
  const error = result?.error
    || (dispatchFailed
      ? actionDispatchFailureMessage(action, dispatch)
      : null)
    || (assertionFailed ? semanticAssertionFailureMessage(parsed, output) : null)
    || (batchFailed ? 'batch step failed' : null);
  return {
    ok: transportOk && !dispatchFailed && !assertionFailed && !batchFailed,
    transportOk,
    dispatchFailed,
    assertionFailed,
    batchFailed,
    error,
    model,
    action,
    dispatch,
  };
}

function extractLabeledLine(text, label) {
  const re = new RegExp(`^${label}:\\s*(.+)$`, 'm');
  return String(text || '').match(re)?.[1]?.trim() || null;
}

function compactActionDiagnosisModel(diagnosis = null) {
  if (!diagnosis || typeof diagnosis !== 'object') return null;
  return {
    schema: diagnosis.schema || 'chrome-cdp-ex.action-diagnosis.v1',
    status: diagnosis.status || 'ok',
    kind: diagnosis.kind || 'ok',
    confidence: diagnosis.confidence || 'medium',
    source: diagnosis.source || 'action',
    reason: diagnosis.reason || '',
    nextCommand: diagnosis.nextCommand || null,
    recovery: diagnosis.recovery || null,
    signals: diagnosis.signals || {},
  };
}

function compactActionVerdictModel(verdict = null) {
  if (!verdict || typeof verdict !== 'object') return null;
  const nextSteps = Array.isArray(verdict.nextSteps) ? verdict.nextSteps.filter(Boolean) : [];
  return {
    schema: verdict.schema || 'chrome-cdp-ex.action-verdict.v1',
    status: verdict.status || 'verify',
    source: verdict.source || 'outcome',
    confidence: verdict.confidence || 'medium',
    canContinue: verdict.canContinue === true,
    needsRecovery: verdict.needsRecovery === true,
    primaryNextStep: verdict.primaryNextStep || null,
    nextSteps,
    reason: verdict.reason || null,
  };
}

function diagnosisFromActionModel(actionModel = null) {
  if (actionModel?.schema !== 'chrome-cdp-ex.action.v1') return null;
  return compactActionDiagnosisModel(actionModel.effects?.diagnosis || null);
}

function verdictFromActionModel(actionModel = null) {
  if (actionModel?.schema !== 'chrome-cdp-ex.action.v1') return null;
  return compactActionVerdictModel(actionModel.verdict || null);
}

function isAttentionDiagnosis(diagnosis = null) {
  return diagnosis?.status === 'attention';
}

function isAttentionVerdict(verdict = null) {
  if (!verdict || typeof verdict !== 'object') return false;
  if (verdict.needsRecovery === true) return true;
  return ['investigate', 'recover', 'blocked'].includes(verdict.status);
}

function recoveryCommandsFromVerdict(verdict = null) {
  const commands = Array.isArray(verdict?.nextSteps) ? verdict.nextSteps.filter(Boolean) : [];
  if (commands.length) return commands;
  return verdict?.primaryNextStep ? [verdict.primaryNextStep] : [];
}

function commandMeta(cmd) {
  return COMMANDS.find(command => command.name === cmd || (command.aliases || []).includes(cmd)) || null;
}

const BATCH_PARALLEL_SAFE_SCRIPT_COMMANDS = new Set(['eval', 'eval64', 'call']);

function isParallelSafeCookieList(command) {
  return command.name === 'cookies'
    && command.kind === 'sensitive-read'
    && command.authorization === 'sensitive-read'
    && command.mutates === false;
}

function isViewportMutationArg(value) {
  return /^\d+x\d+$/i.test(String(value || ''));
}

function isBatchParallelUnsafeCommand(cmd, args = []) {
  const command = COMMAND_SURFACE.resolve(cmd);
  if (!command) return true;
  if (command.name === 'table') {
    if (command.kind !== 'conditional-mutation'
      || command.authorization !== 'conditional'
      || command.evidencePolicy !== 'none') return true;
    return isTableCollectArgs(args);
  }
  if (command.name === 'console' || command.name === 'netlog') {
    return args.some(arg => arg === '--clear');
  }
  if (command.name === 'dialog') {
    return args.some(arg => arg === 'accept' || arg === 'dismiss');
  }
  if (command.name === 'viewport' || command.name === 'resize') {
    return args.some(arg => isViewportMutationArg(arg));
  }
  if (BATCH_PARALLEL_SAFE_SCRIPT_COMMANDS.has(command.name)) return false;
  if (isParallelSafeCookieList(command)) return false;
  if (command.kind !== 'read'
    || command.authorization !== 'standard'
    || command.evidencePolicy !== 'none') return true;
  return false;
}

function autoActionJsonArgs(cmd, args = [], enabled = false) {
  return autoActionJsonArgsForCommands(cmd, args, enabled, { commands: COMMANDS });
}

function batchStepModel(result = {}, index = 0) {
  const semantics = classifyCommandResultSemantics(result, { command: result.cmd });
  const actionModel = semantics.action;
  const actionFailure = semantics.dispatchFailed;
  const diagnosis = diagnosisFromActionModel(actionModel);
  const verdict = verdictFromActionModel(actionModel);
  const errorText = semantics.error || '';
  const ok = semantics.ok;
  const failureKind = actionFailure
    ? actionModel?.effects?.failure?.kind || null
    : extractLabeledLine(errorText, 'Action failure');
  const nextCommand = actionFailure
    ? actionModel?.nextHint || actionModel?.effects?.failure?.nextCommand || null
    : extractLabeledLine(errorText, 'Next');
  const step = {
    index: index + 1,
    cmd: result.cmd || '',
    ok,
  };
  if (ok) {
    step.resultPreview = firstNonEmptyLine(result.result);
  } else {
    step.error = errorText || 'unknown error';
    if (failureKind) step.failureKind = failureKind;
    if (nextCommand) step.nextCommand = nextCommand;
  }
  if (diagnosis) step.diagnosis = diagnosis;
  if (verdict) step.verdict = verdict;
  return step;
}

function buildBatchResultModel(results = [], { targetId = null, mode = 'sequential' } = {}) {
  const steps = results.map((result, index) => batchStepModel(result, index));
  const failedSteps = steps.filter(step => !step.ok);
  const diagnosisAttentionSteps = steps.filter(step => step.ok && isAttentionDiagnosis(step.diagnosis));
  const verdictAttentionSteps = steps.filter(step => step.ok && isAttentionVerdict(step.verdict));
  const attentionSteps = [...new Set([...diagnosisAttentionSteps, ...verdictAttentionSteps])];
  const nextSteps = [];
  const pushNext = (command) => {
    if (command && !nextSteps.includes(command)) nextSteps.push(command);
  };
  for (const step of failedSteps) {
    for (const command of recoveryCommandsFromDiagnosis(step.diagnosis)) pushNext(command);
    for (const command of recoveryCommandsFromVerdict(step.verdict)) pushNext(command);
    pushNext(step.nextCommand);
  }
  for (const step of attentionSteps) {
    for (const command of recoveryCommandsFromDiagnosis(step.diagnosis)) pushNext(command);
    for (const command of recoveryCommandsFromVerdict(step.verdict)) pushNext(command);
  }
  if (failedSteps.length && nextSteps.length === 0) {
    const unknownCommand = failedSteps.some(step => /unknown command/i.test(step.error || ''));
    nextSteps.push(unknownCommand
      ? 'cdp help'
      : (targetId ? `cdp status ${targetId}` : 'cdp status <target>'));
  }
  return {
    schema: 'chrome-cdp-ex.batch.v1',
    targetId,
    mode,
    counts: {
      steps: steps.length,
      ok: steps.length - failedSteps.length,
      failed: failedSteps.length,
      attention: attentionSteps.length,
    },
    steps,
    failedStep: failedSteps[0] || null,
    nextSteps,
  };
}

function parseBatchArgs(args = []) {
  const fopts = parseFormatArgs(args, ['text', 'json']);
  const tokens = fopts.args;
  const parallel = tokens.includes('--parallel');
  const plain = tokens.includes('--plain');
  const compact = tokens.includes('--compact');
  const input = tokens.filter(a => a !== '--parallel' && a !== '--plain' && a !== '--compact').join(' ') || '';
  let commands;
  if (input.startsWith('[')) {
    try { commands = JSON.parse(input); } catch { throw new Error('batch: invalid JSON array'); }
    if (!Array.isArray(commands)) throw new Error('batch argument must be a JSON array');
  } else {
    commands = input.split('|').map(segment => {
      const parts = segment.trim().split(/\s+/);
      return { cmd: parts[0], args: parts.slice(1) };
    }).filter(c => c.cmd);
  }
  return {
    commands,
    parallel,
    output: fopts.format === 'json' ? 'model' : (plain ? 'plain' : compact ? 'compact' : 'legacy-json'),
  };
}

function formatBatchResults(results, format = 'json', options = {}) {
  if (format && typeof format === 'object') {
    return formatJson(buildBatchResultModel(results, format));
  }
  if (format === 'model') {
    return formatJson(buildBatchResultModel(results, options));
  }
  if (format === 'plain') {
    const lines = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      lines.push(`[${i + 1}/${results.length}] ${r.cmd}${r.ok ? '' : ' (error)'}`);
      if (r.ok) {
        const body = (r.result ?? '').toString();
        if (body) lines.push(...body.split('\n').map(l => '  ' + l));
      } else {
        lines.push(`  ${r.error}`);
      }
    }
    return lines.join('\n');
  }
  if (format === 'compact') {
    return results.map((r, i) => {
      const head = `[${i + 1}] ${r.cmd}`;
      if (!r.ok) return `${head}: ERROR ${r.error}`;
      const body = (r.result ?? '').toString().split('\n')[0].slice(0, 200);
      return body ? `${head}: ${body}` : `${head}: ok`;
    }).join('\n');
  }
  return JSON.stringify(results, null, 2);
}

async function runBatchCommands({ run }, commands = [], { parallel = false } = {}) {
  const runOne = async (command) => {
    const nested = await run(command);
    const semantics = classifyCommandResultSemantics(nested, { command: command.cmd });
    return {
      cmd: command.cmd,
      ok: semantics.ok,
      result: nested.result,
      error: semantics.ok ? nested.error : semantics.error,
    };
  };
  if (parallel) return Promise.all(commands.map(runOne));
  const results = [];
  for (const command of commands) {
    const result = await runOne(command);
    results.push(result);
  }
  return results;
}

// --- Repeat: bounded loop primitive ---
// `repeat <count> <cmd> [args...]` runs the inner command up to count times.
// Defaults to fail-fast (halt on first error) so a stale @ref or missing
// element does not waste 50 round-trips silently. `--continue` (or `-c`) keeps
// going through errors and reports the tally at the end. The cap is
// intentionally low — repeat is for "press c 5 times to advance through MUD
// dialogue", not for unbounded loops; agents that need more should drive their
// own loop with state checks between iterations.
const REPEAT_CAP = 50;
// `flow` is intentionally allowed: `repeat N flow "step1; step2; ..."` is the
// documented pattern for bounded multi-step loops (combat turns, multi-phase
// dialogues). Nesting is a single level — the inner flow runs through the
// same daemon dispatcher and cannot recurse back into repeat. `batch` stays
// blocked because its parallel/JSON modes are awkward to compose linearly,
// and `repeat`/`stop` are blocked to avoid recursion and IPC corruption.
const REPEAT_BLOCKED = new Set(['repeat', 'batch', 'stop']);

function parsePageConditionArgs(args = []) {
  const flags = new Map([
    ['--until-selector', 'selector-exists'],
    ['--until-selector-missing', 'selector-missing'],
    ['--until-text', 'text'],
  ]);
  const remainingArgs = [];
  let condition = null;
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (!flags.has(token)) {
      remainingArgs.push(token);
      continue;
    }
    const value = args[++i];
    if (value == null || value === '' || String(value).startsWith('--')) {
      throw new Error(`repeat: ${token} requires a value.`);
    }
    if (condition) {
      throw new Error('repeat: choose exactly one until condition.');
    }
    condition = { kind: flags.get(token), value: String(value) };
  }
  return { condition, remainingArgs };
}

function pageConditionDescription(condition = {}) {
  if (condition.kind === 'selector-exists') return `selector ${condition.value} exists`;
  if (condition.kind === 'selector-missing') return `selector ${condition.value} is missing`;
  if (condition.kind === 'text') return `text includes ${JSON.stringify(condition.value)}`;
  return 'unknown page condition';
}

async function probePageCondition(cdp, sid, condition) {
  if (!condition?.kind || !condition?.value) throw new Error('page condition requires a kind and value');
  const value = JSON.stringify(condition.value);
  let expression;
  if (condition.kind === 'selector-exists' || condition.kind === 'selector-missing') {
    const negate = condition.kind === 'selector-missing';
    expression = `JSON.stringify({ matched: ${negate ? '!' : '!!'}document.querySelector(${value}) })`;
  } else if (condition.kind === 'text') {
    expression = `JSON.stringify({ matched: ((document.body && document.body.innerText) || '').includes(${value}) })`;
  } else {
    throw new Error(`Unknown page condition: ${condition.kind}`);
  }
  const raw = await evalStr(cdp, sid, expression);
  const result = JSON.parse(raw);
  return { matched: result.matched === true, description: pageConditionDescription(condition) };
}

function parseRepeatArgs(args) {
  if (!Array.isArray(args) || args.length < 1) {
    throw new Error('repeat requires <count> <cmd> [args...]');
  }
  const parsedCondition = parsePageConditionArgs(args);
  const opts = { count: 0, cmd: null, args: [], continueOnError: false, condition: parsedCondition.condition };
  const positional = [];
  for (const a of parsedCondition.remainingArgs) {
    if (a === '--continue' || a === '-c') opts.continueOnError = true;
    else positional.push(a);
  }
  if (positional.length < 1) throw new Error('repeat requires <count> <cmd> [args...]');
  const count = parseInt(positional[0], 10);
  if (!Number.isFinite(count) || count < 1 || String(count) !== String(positional[0]).trim()) {
    throw new Error(`repeat: count must be a positive integer, got "${positional[0]}"`);
  }
  if (count > REPEAT_CAP) {
    throw new Error(`repeat: count ${count} exceeds cap ${REPEAT_CAP}. Run multiple repeats or drive your own loop with state checks.`);
  }
  opts.count = count;
  if (positional.length < 2) throw new Error('repeat: command name required after count');
  opts.cmd = positional[1];
  opts.args = positional.slice(2);
  if (REPEAT_BLOCKED.has(opts.cmd)) {
    throw new Error(`repeat: cannot wrap "${opts.cmd}" (would recurse or break IPC). Use a single-shot command (click, press, fill, ...).`);
  }
  return opts;
}

async function repeatStr({ run, probeCondition }, args) {
  const opts = parseRepeatArgs(args);
  const head = `Repeat ${opts.count}× ${opts.cmd}${opts.args.length ? ' ' + opts.args.join(' ') : ''}${opts.continueOnError ? ' (--continue)' : ''}`;
  const lines = [head];
  let okCount = 0, failCount = 0;
  let haltedEarly = false;
  for (let i = 1; i <= opts.count; i++) {
    const r = await run({ cmd: opts.cmd, args: opts.args.slice() });
    const semantics = classifyCommandResultSemantics(r, { command: opts.cmd });
    if (semantics.ok) {
      okCount++;
      const body = (r.result || '').toString().split('\n')[0].slice(0, 200);
      lines.push(body ? `[${i}/${opts.count}] ok: ${body}` : `[${i}/${opts.count}] ok`);
      if (opts.condition) {
        if (typeof probeCondition !== 'function') throw new Error('repeat: condition probe is unavailable');
        const conditionResult = await probeCondition(opts.condition);
        lines.push(`  Condition: ${conditionResult.description} — ${conditionResult.matched ? 'matched' : 'not matched'}`);
        if (conditionResult.matched) {
          lines.push(`Condition satisfied after iteration ${i}/${opts.count}`);
          lines.push(`Done: ${okCount} ok, ${failCount} failed`);
          return lines.join('\n');
        }
      }
    } else {
      failCount++;
      const errText = semantics.error || 'unknown error';
      lines.push(`[${i}/${opts.count}] ✗ ${errText}`);
      if (!opts.continueOnError) {
        lines.push(`Repeat halted at iteration ${i}/${opts.count} (use --continue to keep going).`);
        haltedEarly = true;
        break;
      }
    }
  }
  lines.push(`Done: ${okCount} ok, ${failCount} failed`);
  if (haltedEarly) throw new Error(lines.join('\n'));
  if (opts.condition && !haltedEarly) {
    lines.push(`repeat: condition not satisfied after ${opts.count} iterations`);
    throw new Error(lines.join('\n'));
  }
  return lines.join('\n');
}

// --- Flow: sequential step runner ---
function parseFlowSteps(input) {
  if (typeof input !== 'string' || !input.trim()) return [];
  return input.split(';').map(s => s.trim()).filter(Boolean).map(line => {
    const parts = line.split(/\s+/);
    const head = parts[0];
    if (head === 'wait') {
      const what = parts.slice(1).join(' ').toLowerCase();
      return { kind: 'wait', what };
    }
    if (head === 'assert') {
      const assertionKind = parts[1];
      const value = parts.slice(2).join(' ').replace(/^(['"])(.*)\1$/, '$2');
      const kinds = {
        selector: 'selector-exists',
        'selector-missing': 'selector-missing',
        text: 'text',
      };
      if (!kinds[assertionKind] || !value) {
        throw new Error('flow assert: use "assert selector <css>", "assert selector-missing <css>", or "assert text <value>".');
      }
      return { kind: 'assert', condition: { kind: kinds[assertionKind], value } };
    }
    return { kind: 'command', cmd: head, args: parts.slice(1) };
  });
}

function flowStepModel(step = {}, index = 0, state = {}) {
  const semantics = classifyCommandResultSemantics(state, { command: step.cmd });
  const base = {
    index: index + 1,
    kind: step.kind || 'command',
    ok: semantics.ok,
  };
  if (step.kind === 'wait') base.wait = step.what || '';
  else if (step.kind === 'assert') base.condition = step.condition || null;
  else {
    base.cmd = step.cmd || '';
    base.args = Array.isArray(step.args) ? step.args : [];
  }
  if (state.skipped) {
    base.ok = false;
    base.skipped = true;
    return base;
  }
  const actionModel = semantics.action;
  const diagnosis = diagnosisFromActionModel(actionModel);
  const verdict = verdictFromActionModel(actionModel);
  if (diagnosis) base.diagnosis = diagnosis;
  if (verdict) base.verdict = verdict;
  if (base.ok) {
    base.resultPreview = firstNonEmptyLine(state.result);
    return base;
  }
  const errorText = String(semantics.error || 'unknown error');
  base.error = errorText;
  if (step.kind === 'assert') {
    base.failureKind = 'assertion';
    base.nextCommand = 'cdp help flow';
    return base;
  }
  const failureKind = semantics.dispatchFailed
    ? actionModel?.effects?.failure?.kind || null
    : extractLabeledLine(errorText, 'Action failure');
  const nextCommand = semantics.dispatchFailed
    ? actionModel?.nextHint || actionModel?.effects?.failure?.nextCommand || null
    : extractLabeledLine(errorText, 'Next');
  if (failureKind) base.failureKind = failureKind;
  if (nextCommand) base.nextCommand = nextCommand;
  return base;
}

function buildFlowResultModel({ targetId = null, input = '', steps = [], stepResults = [] } = {}) {
  const failedStep = stepResults.find(step => step.ok === false && step.skipped !== true) || null;
  const skipped = stepResults.filter(step => step.skipped === true).length;
  const failed = failedStep ? 1 : 0;
  const ok = stepResults.filter(step => step.ok === true).length;
  const diagnosisAttentionSteps = stepResults.filter(step => step.ok && isAttentionDiagnosis(step.diagnosis));
  const verdictAttentionSteps = stepResults.filter(step => step.ok && isAttentionVerdict(step.verdict));
  const attentionSteps = [...new Set([...diagnosisAttentionSteps, ...verdictAttentionSteps])];
  const nextSteps = [];
  const pushNext = (command) => {
    if (command && !nextSteps.includes(command)) nextSteps.push(command);
  };
  if (failedStep) {
    for (const command of recoveryCommandsFromDiagnosis(failedStep.diagnosis)) pushNext(command);
    for (const command of recoveryCommandsFromVerdict(failedStep.verdict)) pushNext(command);
    pushNext(failedStep.nextCommand);
  }
  if (failedStep && nextSteps.length === 0) {
    if (failedStep.kind === 'assert' || failedStep.failureKind === 'assertion') {
      pushNext('cdp help flow');
    } else {
      pushNext(targetId ? `cdp status ${targetId}` : 'cdp status <target>');
    }
  }
  for (const step of attentionSteps) {
    for (const command of recoveryCommandsFromDiagnosis(step.diagnosis)) pushNext(command);
    for (const command of recoveryCommandsFromVerdict(step.verdict)) pushNext(command);
  }
  return {
    schema: 'chrome-cdp-ex.flow.v1',
    targetId,
    input,
    halted: !!failedStep,
    counts: {
      steps: steps.length,
      ok,
      failed,
      skipped,
      attention: attentionSteps.length,
    },
    steps: stepResults,
    failedStep,
    nextSteps,
  };
}

async function settleFlow(cdp, sid, what, pendingReqs, opts = {}) {
  const max = opts.maxMs || 10000;
  const quiet = opts.quietMs || 500;
  if (what === 'dom stable') {
    const outcome = await waitForSettle(cdp, sid, max);
    if (outcome === 'timeout') throw new Error(`wait dom stable timed out after ${max}ms`);
    return 'dom stable';
  }
  if (what === 'network idle') {
    const deadline = Date.now() + max;
    let lastBusy = Date.now();
    while (Date.now() < deadline) {
      const size = pendingReqs?.size || 0;
      if (size > 0) lastBusy = Date.now();
      else if (Date.now() - lastBusy >= quiet) return 'network idle';
      await sleep(100);
    }
    throw new Error(`wait network idle timed out after ${max}ms (${pendingReqs?.size || 0} pending requests)`);
  }
  throw new Error(`Unknown wait: "${what}". Use "dom stable" or "network idle".`);
}

async function flowStr({ run, settle, assertCondition }, input, { format = 'text', targetId = null, throwOnFailure = false } = {}) {
  const steps = parseFlowSteps(input);
  if (steps.length === 0) throw new Error('flow: no steps. Example: flow <target> "click @1; wait dom stable; summary"');
  const lines = [`Flow: ${steps.length} step(s)`];
  const stepResults = [];
  const finish = () => {
    const model = buildFlowResultModel({ targetId, input, steps, stepResults });
    const output = format === 'json' ? formatJson(model) : lines.join('\n');
    if (throwOnFailure && model.halted) {
      const error = new Error(output);
      error.code = 'FLOW_HALTED';
      throw error;
    }
    return output;
  };
  const markSkippedAfter = (startIndex) => {
    for (let j = startIndex; j < steps.length; j++) {
      stepResults.push(flowStepModel(steps[j], j, { skipped: true }));
    }
  };
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const head = step.kind === 'wait'
      ? `[${i + 1}/${steps.length}] wait ${step.what}`
      : step.kind === 'assert'
      ? `[${i + 1}/${steps.length}] assert ${pageConditionDescription(step.condition)}`
      : `[${i + 1}/${steps.length}] ${step.cmd}${step.args.length ? ' ' + step.args.join(' ') : ''}`;
    lines.push(head);
    try {
      let body;
      if (step.kind === 'wait') {
        body = await settle(step.what);
      } else if (step.kind === 'assert') {
        if (typeof assertCondition !== 'function') throw new Error('flow: assertion probe is unavailable');
        const assertion = await assertCondition(step.condition);
        if (!assertion.matched) throw new Error(`Assertion failed: ${assertion.description}`);
        body = `Assertion passed: ${assertion.description}`;
      } else {
        const r = await run(step);
        if (!r.ok) {
          stepResults.push(flowStepModel(step, i, {
            ok: false,
            result: r.result,
            error: r.error,
          }));
          markSkippedAfter(i + 1);
          lines.push(`  ✗ ${r.error}`);
          lines.push(`Flow halted at step ${i + 1}/${steps.length}`);
          return finish();
        }
        body = r.result ?? '';
      }
      const stepModel = flowStepModel(step, i, { ok: true, result: body });
      stepResults.push(stepModel);
      const text = (body || '').toString();
      if (text) for (const ln of text.split('\n')) lines.push('  ' + ln);
      if (!stepModel.ok) {
        markSkippedAfter(i + 1);
        lines.push(`Flow halted at step ${i + 1}/${steps.length}`);
        return finish();
      }
    } catch (e) {
      if (e?.code === 'FLOW_HALTED') throw e;
      stepResults.push(flowStepModel(step, i, { ok: false, error: e.message }));
      markSkippedAfter(i + 1);
      lines.push(`  ✗ ${e.message}`);
      lines.push(`Flow halted at step ${i + 1}/${steps.length}`);
      return finish();
    }
  }
  return finish();
}

// --- Replay: execute record-actions artifacts ---
const REPLAY_BLOCKED = new Set(['replay', 'record-actions', 'recordactions', 'batch', 'flow', 'repeat', 'stop']);

function parseReplayArgs(args, { reader = readFileSync } = {}) {
  const fopts = parseFormatArgs((args || []).filter(a => a !== undefined && a !== null), ['text', 'json']);
  const tokens = fopts.args;
  const opts = { continueOnError: false, artifact: null, source: 'inline JSON', format: fopts.format };
  const positional = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '--continue' || token === '-c') {
      opts.continueOnError = true;
    } else if (token === '--json') {
      const raw = tokens.slice(i + 1).join(' ').trim();
      if (!raw) throw new Error('replay --json requires a record-actions JSON payload');
      opts.artifact = parseReplayArtifact(raw);
      opts.source = 'inline JSON';
      break;
    } else if (token === '--file' || token === '-f') {
      const filePath = tokens[++i];
      if (!filePath) throw new Error('replay --file requires a path to a record-actions JSON artifact');
      opts.artifact = parseReplayArtifact(reader(filePath, 'utf8'));
      opts.source = filePath;
    } else {
      positional.push(token);
    }
  }
  if (!opts.artifact) {
    const raw = positional.join(' ').trim();
    if (!raw) throw new Error('replay requires --json <record-actions-json> or --file <path>');
    if (raw.startsWith('{') || raw.startsWith('[')) {
      opts.artifact = parseReplayArtifact(raw);
      opts.source = 'inline JSON';
    } else {
      opts.artifact = parseReplayArtifact(reader(positional[0], 'utf8'));
      opts.source = positional[0];
    }
  }
  return opts;
}

function parseReplayArtifact(raw) {
  let artifact;
  try {
    artifact = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) {
    throw new Error(`replay: invalid JSON artifact (${e.message})`);
  }
  if (Array.isArray(artifact)) {
    artifact = { schema: 'chrome-cdp-ex.record-actions.v1', actions: artifact };
  }
  if (!artifact || typeof artifact !== 'object') throw new Error('replay: artifact must be a record-actions JSON object');
  if (artifact.schema !== 'chrome-cdp-ex.record-actions.v1') {
    throw new Error(`replay: unsupported artifact schema ${artifact.schema || '(missing)'}`);
  }
  if (!Array.isArray(artifact.actions)) throw new Error('replay: artifact.actions must be an array');
  if (artifact.environment != null && !Array.isArray(artifact.environment)) throw new Error('replay: artifact.environment must be an array when provided');
  return artifact;
}

function replayCommandMissingFields(action = {}, command = []) {
  const declared = Array.isArray(action.needsInput) ? action.needsInput.filter(Boolean) : [];
  const inferred = [];
  const cmd = command[0];
  if (cmd === 'fill') {
    try {
      const parsed = parseFillArgs(command.slice(1));
      const textTokens = parsed.args.slice(1);
      if (!parsed.selector) inferred.push('target');
      if (textTokens.length === 0) inferred.push('text');
    } catch {
      inferred.push('text');
    }
  } else if (cmd === 'type') {
    try {
      const fopts = parseCompactFormatArgs(command.slice(1), ['text', 'json']);
      if (!fopts.args.length) inferred.push('text');
    } catch {
      inferred.push('text');
    }
  } else if (cmd === 'select' && command.length < 3) {
    inferred.push('value');
  }
  return [...new Set([...declared, ...inferred])];
}

function replayStepFromAction(action = {}) {
  const command = Array.isArray(action.command) ? action.command.map(v => String(v)) : [];
  const commandText = command.length ? formatCommandLine(command) : `${action.action || 'action'} <missing command>`;
  const missing = replayCommandMissingFields(action, command);
  if (action.replayable !== true) {
    return {
      skip: true,
      command,
      commandText,
      missing: missing.length ? missing : ['review'],
      reason: 'not replayable',
    };
  }
  if (!command.length || !command[0]) {
    return { skip: true, command, commandText, missing: ['command'], reason: 'missing command' };
  }
  if (command.includes('<redacted>')) {
    return {
      skip: true,
      command,
      commandText,
      missing: missing.length ? missing : redactedCommandNeedsInput(action.action || command[0]),
      reason: 'redacted input',
    };
  }
  if (REPLAY_BLOCKED.has(command[0])) {
    return { skip: true, command, commandText, missing: ['safe command'], reason: `blocked command: ${command[0]}` };
  }
  if (missing.length) {
    return { skip: true, command, commandText, missing, reason: 'missing input' };
  }
  return { cmd: command[0], args: command.slice(1), command, commandText };
}

function replayRecoveryNextSteps(targetId) {
  const target = targetId || '<target>';
  return [
    `cdp perceive ${target} -C -d 8`,
    `cdp report ${target} --format json`,
  ];
}

async function replayActionsStr({ run }, args) {
  const opts = parseReplayArgs(args);
  const actions = opts.artifact.actions;
  const environment = Array.isArray(opts.artifact.environment) ? opts.artifact.environment : [];
  const total = actions.length;
  const model = {
    schema: 'chrome-cdp-ex.replay.v1',
    source: opts.source,
    sourceTargetId: opts.artifact.targetId || null,
    sourceSessionId: opts.artifact.sessionId || null,
    continueOnError: opts.continueOnError,
    halted: false,
    counts: {
      environment: environment.length,
      actions: total,
      total: environment.length + total,
      ok: 0,
      failed: 0,
      skipped: 0,
    },
    steps: [],
    failedStep: null,
    nextSteps: [],
  };
  const lines = [
    `Replay: ${total} step(s)`,
    `Source: ${opts.source}`,
  ];
  if (environment.length) lines.push(`Environment: ${environment.length} step(s)`);
  const finish = () => {
    lines.push(`Done: ${model.counts.ok} ok, ${model.counts.failed} failed, ${model.counts.skipped} skipped`);
    if (model.failedStep) model.nextSteps = replayRecoveryNextSteps(model.sourceTargetId);
    return opts.format === 'json' ? formatJson(model) : lines.join('\n');
  };
  const recordStep = (phase, index, totalCount, step, details) => {
    const entry = {
      phase,
      index,
      total: totalCount,
      command: step.command || [],
      commandText: step.commandText,
      ok: details.ok === true,
      skipped: details.skipped === true,
    };
    if (details.resultPreview) entry.resultPreview = details.resultPreview;
    if (details.error) entry.error = details.error;
    if (step.reason) entry.reason = step.reason;
    if (step.missing?.length) entry.missing = step.missing;
    model.steps.push(entry);
    return entry;
  };
  const runReplayStep = async (step, phase, index, totalCount, label, haltText) => {
    if (step.skip) {
      model.counts.skipped++;
      lines.push(`${label} skip ${step.commandText}`);
      if (step.reason) lines.push(`  Reason: ${step.reason}`);
      if (step.missing?.length) lines.push(`  Missing: ${step.missing.join(', ')}`);
      recordStep(phase, index, totalCount, step, { skipped: true });
      return true;
    }
    lines.push(`${label} ${step.commandText}`);
    const result = await run({ cmd: step.cmd, args: step.args });
    const semantics = classifyCommandResultSemantics(result, { command: step.cmd });
    if (semantics.ok) {
      model.counts.ok++;
      const body = (result.result || '').toString().split('\n')[0].slice(0, 240);
      if (body) lines.push(`  ok: ${body}`);
      else lines.push('  ok');
      recordStep(phase, index, totalCount, step, { ok: true, resultPreview: body || null });
      return true;
    }
    model.counts.failed++;
    const error = semantics.error || 'unknown error';
    lines.push(`  ✗ ${error}`);
    const failedStep = recordStep(phase, index, totalCount, step, { ok: false, error });
    if (!model.failedStep) model.failedStep = failedStep;
    if (!opts.continueOnError) {
      model.halted = true;
      lines.push(`${haltText} (use --continue to keep going).`);
      return false;
    }
    return true;
  };
  for (let i = 0; i < environment.length; i++) {
    const step = replayStepFromAction(environment[i]);
    const keepGoing = await runReplayStep(step, 'environment', i + 1, environment.length, `[env ${i + 1}/${environment.length}]`, `Replay halted at environment step ${i + 1}/${environment.length}`);
    if (!keepGoing) {
      return finish();
    }
  }
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    const step = replayStepFromAction(action);
    const keepGoing = await runReplayStep(step, 'action', i + 1, total, `[${i + 1}/${total}]`, `Replay halted at step ${i + 1}/${total}`);
    if (!keepGoing) break;
  }
  return finish();
}

// --- Doctor: one-call diagnostics ---
function checkNode(version = process.version, opts = {}) {
  const major = nodeMajor(version);
  if (major >= 22) return { status: 'OK', label: 'Node', detail: `${version} (>= 22)` };
  const cdpScriptPath = opts.cdpScriptPath || fileURLToPath(import.meta.url);
  const found = typeof opts.discover === 'function'
    ? opts.discover()
    : discoverNode22({
      home: opts.home,
      env: opts.env,
      fs: opts.fs,
      spawnSync: opts.spawnSync,
      execPath: opts.execPath || process.execPath,
      execVersion: version,
      timeout: opts.timeout,
    });
  if (found?.binary) {
    const rerunCommand = formatNodeRerunCommand(found.binary, cdpScriptPath, 'doctor');
    return {
      status: 'WARN',
      severity: 'advisory',
      label: 'Node',
      detail: `${version} (runtime) ; Node 22 found at ${found.binary}`,
      hint: `Rerun: ${rerunCommand}`,
      recommendedBinary: found.binary,
      recommendedVersion: found.version,
      cdpScriptPath,
      rerunCommand,
    };
  }
  return {
    status: 'FAIL',
    label: 'Node',
    detail: `${version} (need >= 22)`,
    hint: NODE22_MISSING_HINT,
  };
}

function hostSkillInstallPaths({ home = homedir(), env = process.env } = {}) {
  const hermesHome = env.HERMES_HOME || resolve(home, '.hermes');
  return [...new Set([
    resolve(hermesHome, 'skills', 'chrome-cdp-ex'),
    resolve(home, '.hermes', 'skills', 'chrome-cdp-ex'),
    resolve(home, '.claude', 'skills', 'chrome-cdp-ex'),
    resolve(home, '.codex', 'skills', 'chrome-cdp-ex'),
  ])];
}

function doctorCliPrefix(node) {
  if (node?.recommendedBinary && node.cdpScriptPath) {
    return `${node.recommendedBinary} ${node.cdpScriptPath}`;
  }
  return 'cdp';
}

function checkSkillSymlink({ home = homedir(), env = process.env, fs = { existsSync, lstatSync: null } } = {}) {
  const candidates = hostSkillInstallPaths({ home, env });
  const target = candidates.find(path => fs.existsSync(path));
  if (!target) {
    return {
      status: 'WARN', label: 'Skill install', detail: `${candidates.join(', ')} not found`,
      hint: 'Install with: cp -r skills/chrome-cdp-ex ~/.hermes/skills/  (or ~/.claude/skills/, ~/.codex/skills/, or use the plugin loader)',
    };
  }
  let kind = 'directory';
  try {
    const lstat = fs.lstatSync ? fs.lstatSync(target) : null;
    if (lstat?.isSymbolicLink?.()) kind = 'symlink';
  } catch {}
  const binPath = resolve(target, 'bin', 'chrome-cdp');
  if (!fs.existsSync(binPath)) {
    return {
      status: 'WARN',
      label: 'Skill launcher',
      detail: `${target} is missing bin/chrome-cdp`,
      hint: 'Installed skill copies should include bin/chrome-cdp wrapping scripts/cdp.mjs. From a checkout use repo-root ./bin/chrome-cdp.',
    };
  }
  return { status: 'OK', label: 'Skill install', detail: `${kind}: ${target}` };
}

function checkDaemonSockets({ list = listDaemonSockets } = {}) {
  const daemons = list();
  if (!daemons || daemons.length === 0) {
    return { status: 'OK', label: 'Daemons', detail: 'no live tab daemons', targetPrefixes: [] };
  }
  const ids = daemons.map(d => (d.targetId || '').slice(0, 8)).filter(Boolean);
  return {
    status: 'OK', label: 'Daemons',
    detail: `${daemons.length} live: ${ids.join(', ')}`,
    targetPrefixes: ids,
  };
}

function detectFdLimit({ runner = spawnSync } = {}) {
  if (IS_WINDOWS) return null;
  try {
    const res = runner('/bin/sh', ['-lc', 'ulimit -n'], { encoding: 'utf8', timeout: 1000 });
    if (res.status !== 0) return null;
    const raw = String(res.stdout || '').trim();
    if (raw === 'unlimited') return Number.POSITIVE_INFINITY;
    const limit = Number(raw);
    return Number.isFinite(limit) ? limit : null;
  } catch {
    return null;
  }
}

function fdLimitRecovery({ platform = process.platform } = {}) {
  const commands = [
    {
      scope: 'current-shell',
      command: 'ulimit -n 4096',
      reason: 'Raise the open-files limit for this terminal before starting long chrome-cdp-ex sessions.',
      requiresAdmin: false,
    },
  ];
  if (platform === 'darwin') {
    commands.push({
      scope: 'macos-login-session',
      command: 'sudo launchctl limit maxfiles 65536 200000',
      reason: 'Raise the macOS launchd limit for GUI apps and future shells; rerun doctor afterwards.',
      requiresAdmin: true,
    });
  }
  return {
    schema: 'chrome-cdp-ex.fd-limit-recovery.v1',
    strategy: 'raise-open-files-limit',
    commands,
  };
}

function checkFdLimit({ limit = detectFdLimit(), platform = process.platform } = {}) {
  const recovery = fdLimitRecovery({ platform });
  if (limit == null) {
    return {
      status: 'WARN',
      label: 'FD limit',
      detail: 'open-files limit unavailable',
      hint: 'If you see "Too many open files", rerun commands with: ulimit -n 4096',
      recovery,
    };
  }
  if (limit >= 1024) {
    const text = limit === Number.POSITIVE_INFINITY ? 'unlimited' : String(limit);
    return { status: 'OK', label: 'FD limit', detail: `${text} open files` };
  }
  return {
    status: 'WARN',
    label: 'FD limit',
    detail: `${limit} open files (low for long browser sessions)`,
    hint: 'Raise for this shell with: ulimit -n 4096',
    recovery,
  };
}

async function checkCdpReachability({
  env = process.env,
  fetcher = fetch,
  host = env.CDP_HOST || process.env.CDP_HOST || '127.0.0.1',
  lastEndpoint,
  readLastEndpoint = readLastCdpEndpoint,
  rememberEndpoint = rememberLastCdpEndpoint,
  connectWebSocket,
} = {}) {
  const port = env.CDP_PORT;
  const remembered = lastEndpoint !== undefined ? lastEndpoint : readLastEndpoint();
  const rememberReachable = (record) => {
    try { rememberEndpoint(record); } catch {}
  };
  const unreachable = (p, cause) => {
    const profileDir = remembered?.profileDir || null;
    const relaunch = formatCdpRelaunchCommand(remembered, { port: p });
    const hint = relaunch || 'Profile is unknown — do not invent a new --user-data-dir. Enable remote debugging on the existing Chrome via chrome://inspect/#remote-debugging.';
    return {
      status: 'FAIL',
      label: 'CDP',
      detail: `cannot reach ${host}:${p} (${cause})`,
      hint,
      error: 'cdp_unreachable',
      host,
      port: String(p),
      profileDir,
      relaunch,
      exe: remembered?.exe || null,
      browser: remembered?.browser || null,
    };
  };
  const tryFetch = async (p) => {
    const res = await fetcher(`http://${host}:${p}/json/version`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  };
  const describe = (info) => {
    const product = info.Browser || info.product || 'unknown browser';
    const ua = info['User-Agent'] || '';
    const m = ua.match(/Electron\/([\d.]+)/);
    return m ? `${product} (Electron ${m[1]})` : product;
  };
  if (port) {
    try {
      const info = await tryFetch(port);
      if (!info.webSocketDebuggerUrl) {
        return {
          status: 'WARN', label: 'CDP', detail: `port ${port}: no webSocketDebuggerUrl`,
          hint: 'Browser exposes /json/version but not the debugger WebSocket — toggle remote debugging again',
          host,
          port: String(port),
        };
      }
      rememberReachable({ host, port });
      return { status: 'OK', label: 'CDP', detail: `${host}:${port} → ${describe(info)}`, host, port: String(port) };
    } catch (e) {
      // Chrome 136+ / websocket-only: HTTP 404 still has a live /devtools/browser socket.
      // Connection refused, timeout, and other HTTP failures must fail fast.
      if (isCdpHttp404(e)) {
        try {
          const wsOpen = await openCdpWebSocket(`ws://${host}:${port}/devtools/browser`, { connectWebSocket });
          if (wsOpen) {
            rememberReachable({ host, port });
            return { status: 'OK', label: 'CDP', detail: `${host}:${port} → connected via WebSocket fallback`, host, port: String(port) };
          }
        } catch {}
      }
      return unreachable(port, e.message);
    }
  }
  // Auto-discover via DevToolsActivePort (light reuse — avoids full ws connect)
  const home = homedir();
  const localAppData = env.LOCALAPPDATA || process.env.LOCALAPPDATA || '';
  const tryPaths = [
    env.CDP_PORT_FILE,
    resolve(home, 'Library/Application Support/Google/Chrome/DevToolsActivePort'),
    resolve(home, 'Library/Application Support/Google/Chrome/Default/DevToolsActivePort'),
    resolve(home, '.config/google-chrome/DevToolsActivePort'),
    resolve(home, '.config/chromium/DevToolsActivePort'),
    resolve(localAppData, 'Google\\Chrome\\User Data\\DevToolsActivePort'),
  ].filter(Boolean);
  const found = tryPaths.find(p => existsSync(p));
  if (!found) {
    if (remembered?.profileDir && remembered?.port) {
      return unreachable(remembered.port, 'no DevToolsActivePort and no CDP_PORT set');
    }
    return {
      status: 'FAIL', label: 'CDP', detail: 'no DevToolsActivePort and no CDP_PORT set',
      hint: 'Toggle chrome://inspect/#remote-debugging in Chrome, or set CDP_PORT=<port> for an Electron app',
    };
  }
  let lines;
  try {
    lines = readFileSync(found, 'utf8').trim().split('\n');
  } catch (e) {
    return { status: 'WARN', label: 'CDP', detail: `cannot read ${found}: ${e.message}`, host };
  }
  if (lines.length < 2 || !lines[0]) {
    return { status: 'WARN', label: 'CDP', detail: `invalid DevToolsActivePort at ${found}`, host };
  }
  const discoveredPort = lines[0];
  const discoveredProfile = profileDirFromDevToolsActivePort(found);
  try {
    const info = await tryFetch(discoveredPort);
    rememberReachable({ host, port: discoveredPort, profileDir: discoveredProfile });
    return { status: 'OK', label: 'CDP', detail: `${host}:${discoveredPort} → ${describe(info)} (auto-discovered)`, host, port: String(discoveredPort) };
  } catch (e) {
    return {
      status: 'WARN', label: 'CDP',
      detail: `DevToolsActivePort points to ${discoveredPort} but /json/version unreachable: ${e.message}`,
      hint: 'Browser may have stopped — re-toggle chrome://inspect/#remote-debugging',
      host,
      port: String(discoveredPort),
    };
  }
}

function normalizeBrowserTargetInfo(target) {
  return {
    targetId: target.targetId || target.id || '',
    type: target.type || '',
    title: target.title || '',
    url: target.url || '',
  };
}

function isDebuggablePageTarget(target) {
  return target.type === 'page'
    && target.targetId
    && !target.url.startsWith('chrome://')
    && !target.url.startsWith('edge://')
    && !target.url.startsWith('devtools://');
}

async function checkBrowserTargets({ cdp = null, env = process.env, fetcher = fetch, host = env.CDP_HOST || process.env.CDP_HOST || '127.0.0.1' } = {}) {
  if (cdp?.status !== 'OK') {
    return {
      status: 'WARN',
      label: 'Tabs',
      detail: 'skipped until CDP is reachable',
      hint: 'Fix CDP first, then rerun: cdp doctor',
      targetPrefixes: [],
    };
  }
  const port = cdp.port || env.CDP_PORT;
  const cdpHost = cdp.host || host;
  if (!port) {
    return {
      status: 'WARN',
      label: 'Tabs',
      detail: 'cannot list tabs without a CDP port',
      hint: 'Rerun: cdp doctor, then use the printed CDP/open path.',
      targetPrefixes: [],
    };
  }

  let targets = [];
  try {
    const res = await fetcher(`http://${cdpHost}:${port}/json/list`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json();
    targets = Array.isArray(raw) ? raw.map(normalizeBrowserTargetInfo).filter(isDebuggablePageTarget) : [];
  } catch (e) {
    try {
      const wsUrl = `ws://${cdpHost}:${port}/devtools/browser`;
      const ws = new WebSocket(wsUrl);
      const targetsResult = await new Promise((resolveWs, rejectWs) => {
        ws.onopen = () => {
          ws.send(JSON.stringify({ id: 1, method: 'Target.getTargets' }));
        };
        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data.id === 1 && data.result?.targetInfos) {
              resolveWs(data.result.targetInfos);
            }
          } catch {}
        };
        ws.onerror = (err) => rejectWs(err);
        setTimeout(() => { ws.close(); rejectWs(new Error('WebSocket timeout')); }, 3000);
      });
      ws.close();
      targets = Array.isArray(targetsResult) ? targetsResult.map(normalizeBrowserTargetInfo).filter(isDebuggablePageTarget) : [];
    } catch {
      return {
        status: 'WARN',
        label: 'Tabs',
        detail: `cannot list debuggable page targets (${e.message})`,
        hint: 'Run: cdp list. If it is empty, run: cdp open https://example.com',
        targetPrefixes: [],
      };
    }
  }

  if (targets.length === 0) {
    return {
      status: 'WARN',
      label: 'Tabs',
      detail: 'no debuggable page targets',
      hint: 'Create one with: cdp open https://example.com',
      targetPrefixes: [],
      noTargets: true,
    };
  }
  const ranked = rankPageTargets(targets);
  const prefixLen = getDisplayPrefixLength(targets.map(target => target.targetId));
  const targetPrefixes = ranked.map(target => target.targetId.slice(0, prefixLen));
  const labels = ranked.slice(0, 3).map((target, index) => {
    const title = target.title || (target.url === 'about:blank' ? '(blank tab)' : target.url || '(untitled)');
    return `${targetPrefixes[index]} ${title}`.trim();
  });
  const suffix = ranked.length > labels.length ? `, +${ranked.length - labels.length} more` : '';
  return {
    status: 'OK',
    label: 'Tabs',
    detail: `${targets.length} debuggable page target${targets.length === 1 ? '' : 's'}: ${labels.join(', ')}${suffix}`,
    targetPrefixes,
    pages: ranked.map(target => ({
      targetId: target.targetId,
      title: target.title,
      url: target.url,
      type: target.type,
    })),
  };
}

function doctorTabCount(tabs = {}, daemons = {}, permission = {}) {
  if (Array.isArray(tabs.pages) && tabs.pages.length) return tabs.pages.length;
  if (Array.isArray(tabs.targetPrefixes) && tabs.targetPrefixes.length) return tabs.targetPrefixes.length;
  if (Array.isArray(permission.targetPrefixes) && permission.targetPrefixes.length) {
    return permission.targetPrefixes.length;
  }
  return (daemons.targetPrefixes || []).length;
}

function doctorRankedTargetPrefix(tabs = {}, daemons = {}, permission = {}) {
  const pages = Array.isArray(tabs.pages) ? tabs.pages : [];
  if (pages.length) {
    const ranked = rankPageTargets(pages);
    const prefixLen = getDisplayPrefixLength(pages.map(page => page.targetId || page.id || ''));
    const id = ranked[0]?.targetId || ranked[0]?.id || '';
    if (id) return id.slice(0, prefixLen);
  }
  return tabs.targetPrefixes?.[0]
    || permission.targetPrefixes?.[0]
    || daemons.targetPrefixes?.[0]
    || null;
}

function doctorProbeFromTargets({ tabs = {}, daemons = {}, permission = {}, prefix = 'cdp' } = {}) {
  const tabCount = doctorTabCount(tabs, daemons, permission);
  const targetPrefix = doctorRankedTargetPrefix(tabs, daemons, permission);
  const multi = tabCount > 1;
  const exampleTarget = multi ? DOCTOR_LIST_TARGET_PLACEHOLDER : (targetPrefix || '<target>');
  return {
    tabCount,
    targetPrefix,
    exampleTarget,
    multi,
    provenCommand: multi
      ? `${prefix} list`
      : (targetPrefix ? `${prefix} perceive ${targetPrefix} -C -d 8` : `${prefix} list`),
    probeNote: multi ? `${tabCount} tabs — pick with ${prefix} list / ${prefix} target --url` : null,
    listIsSourceOfTruth: tabCount > 0,
  };
}

function doctorProbeFromChecks(checks = []) {
  const node = checks.find(check => check.label === 'Node');
  return doctorProbeFromTargets({
    tabs: checks.find(check => check.label === 'Tabs') || {},
    daemons: checks.find(check => check.label === 'Daemons') || {},
    permission: checks.find(check => check.label === 'Permission') || {},
    prefix: doctorCliPrefix(node),
  });
}

function checkBrowserPermission({ daemons = null, tabs = null, cdp = null, environment = null } = {}) {
  const daemonPrefixes = daemons?.targetPrefixes || [];
  const probe = doctorProbeFromTargets({ tabs: tabs || {}, daemons: daemons || {} });
  if (daemonPrefixes.length > 0) {
    return {
      status: 'OK',
      label: 'Permission',
      detail: `debugging approved for ${daemonPrefixes.join(', ')}`,
      severity: 'ok',
      provenCommand: probe.provenCommand,
      probeNote: probe.probeNote,
      targetPrefixes: daemonPrefixes,
    };
  }

  const tabPrefixes = tabs?.targetPrefixes || [];
  const headless = Boolean(environment?.environment?.headlessLikely || environment?.headlessLikely);
  const cdpReachable = cdp?.status === 'OK';
  if (tabPrefixes.length > 0) {
    const target = probe.targetPrefix || tabPrefixes[0];
    const perceive = `cdp perceive ${target} -C -d 8`;
    const next = probe.provenCommand;
    // CDP + tabs are enough for agents to proceed; missing daemon approval is advisory.
    return {
      status: 'WARN',
      label: 'Permission',
      detail: headless && cdpReachable
        ? `headless CDP is reachable; tab daemon not attached yet for ${target}`
        : `browser debugging approval not confirmed for ${target}`,
      hint: headless && cdpReachable
        ? `Non-blocking. Run: ${next} (or cdp list). UI "Allow debugging?" is not required for headless sessions when CDP works.`
        : `Run: ${probe.multi ? 'cdp list' : perceive}; if Chrome asks "Allow debugging?", click Allow`,
      severity: 'advisory',
      provenCommand: cdpReachable ? next : null,
      nextProbe: probe.multi ? 'cdp list' : perceive,
      probeNote: probe.probeNote,
      targetPrefixes: tabPrefixes,
    };
  }

  if (tabs?.noTargets || /no debuggable page targets/i.test(tabs?.detail || '')) {
    return {
      status: 'WARN',
      label: 'Permission',
      detail: 'no target available to request browser debugging approval',
      hint: 'Run: cdp open https://example.com; if Chrome asks "Allow debugging?", click Allow',
      severity: 'warning',
      targetPrefixes: [],
    };
  }

  return {
    status: 'WARN',
    label: 'Permission',
    detail: 'skipped until CDP and tabs are reachable',
    hint: 'Fix CDP/tabs first, then rerun: cdp doctor',
    severity: 'warning',
    targetPrefixes: [],
  };
}

function detectRuntimeEnvironment({ platform = process.platform, env = process.env, fs = { existsSync } } = {}) {
  const displayAvailable = Boolean(env?.DISPLAY || env?.WAYLAND_DISPLAY);
  const remoteSignals = [
    env?.SSH_CONNECTION,
    env?.SSH_CLIENT,
    env?.REMOTE_CONTAINERS,
    env?.CODESPACES,
    env?.CI,
    env?.CONTAINER,
  ].filter(Boolean);
  const headlessLikely = platform === 'linux' && !displayAvailable;
  const browserCandidates = ['chrome', 'edge', 'brave']
    .map(browser => ({ browser, executable: detectBrowserPath(browser, platform, fs, env) }))
    .filter(candidate => candidate.executable);
  const preferred = browserCandidates.find(candidate => candidate.browser === 'chrome') || browserCandidates[0] || null;
  return {
    platform,
    displayAvailable,
    remoteLikely: remoteSignals.length > 0,
    headlessLikely,
    sandboxMayNeedNoSandbox: platform === 'linux' && (headlessLikely || Boolean(env?.CI) || Boolean(env?.CONTAINER)),
    browserCandidates,
    preferredBrowser: preferred,
  };
}

function environmentRecoveryCommand(envInfo) {
  const candidate = envInfo.preferredBrowser;
  if (!candidate) return null;
  const args = ['cdp spawn-debug-browser', candidate.browser];
  if (envInfo.headlessLikely) args.push('--headless');
  if (envInfo.sandboxMayNeedNoSandbox) args.push('--no-sandbox');
  args.push('--port', '9222');
  args.push('--exe', candidate.executable);
  args.push('--url', 'https://example.com');
  return args.join(' ');
}

function checkRuntimeEnvironment(opts = {}) {
  const info = detectRuntimeEnvironment(opts);
  const command = environmentRecoveryCommand(info);
  if (info.headlessLikely || info.remoteLikely) {
    const traits = [
      info.platform,
      info.remoteLikely ? 'remote/container-like' : null,
      info.headlessLikely ? 'headless/no DISPLAY' : null,
      info.preferredBrowser ? `${info.preferredBrowser.browser} at ${info.preferredBrowser.executable}` : 'no browser executable detected',
    ].filter(Boolean).join(', ');
    return {
      status: info.preferredBrowser ? 'WARN' : 'FAIL',
      label: 'Environment',
      detail: `detected ${traits}`,
      hint: command || 'Install Chrome/Chromium or pass --exe to spawn-debug-browser.',
      environment: info,
      recovery: command ? {
        strategy: 'spawn-headless-debug-browser',
        command,
        requiresUserAction: true,
        consentRequired: true,
      } : null,
    };
  }
  return {
    status: 'OK',
    label: 'Environment',
    detail: `${info.platform}${info.displayAvailable ? ', display available' : ''}`,
    environment: info,
    recovery: null,
  };
}

function reconcileRuntimeEnvironmentCheck(environment, cdp) {
  if (environment?.label !== 'Environment' || environment.status === 'OK') {
    return environment;
  }
  if (cdp?.status === 'OK') {
    return {
      ...environment,
      status: 'OK',
      detail: `${environment.detail}; CDP reachable`,
      hint: null,
      recovery: null,
    };
  }
  // Configured CDP is down. Do not advertise a blank isolated profile.
  if (cdp?.port || cdp?.profileDir) {
    return {
      ...environment,
      hint: 'CDP_PORT is set; enable remote debugging on that existing browser. Do not spawn a new user-data-dir.',
      recovery: null,
    };
  }
  return environment;
}

function doctorWizardSummary(checks) {
  const wizard = doctorWizardModel(checks);
  return [
    'Wizard:',
    `  Status: ${wizard.status}`,
    `  Current step: ${wizard.currentStep}`,
    `  Golden path: ${wizard.goldenPath.join(' -> ')}`,
  ];
}

function doctorWizardModel(checks) {
  const node = checks.find(c => c.label === 'Node');
  const cdp = checks.find(c => c.label === 'CDP');
  const tabs = checks.find(c => c.label === 'Tabs');
  const permission = checks.find(c => c.label === 'Permission');
  const probe = doctorProbeFromChecks(checks);
  const target = probe.exampleTarget || probe.targetPrefix || '<target>';
  const noTargets = tabs?.noTargets || /no debuggable page targets/i.test(tabs?.detail || '');
  const prefix = doctorCliPrefix(node);

  let status = 'ready for live browser perception';
  let currentStep = probe.multi ? `${prefix} list` : `${prefix} perceive ${target} -C -d 8`;
  if (node?.status === 'FAIL') {
    status = 'blocked at Node.js';
    currentStep = node.hint || NODE22_MISSING_HINT;
  } else if (cdp?.status === 'FAIL') {
    status = 'blocked at browser CDP';
    currentStep = cdp.relaunch
      ? cdp.relaunch
      : `enable browser remote debugging, then rerun: ${prefix} doctor`;
  } else if (cdp?.status === 'WARN') {
    status = 'waiting for stable browser CDP';
    currentStep = `re-toggle browser remote debugging, then rerun: ${prefix} doctor`;
  } else if (noTargets) {
    status = 'waiting for a debuggable page';
    currentStep = `${prefix} open https://example.com`;
  } else if (permission?.status === 'WARN') {
    const severity = doctorCheckSeverity(permission);
    if (severity === 'advisory') {
      status = 'usable with advisory notes (CDP reachable)';
      currentStep = probe.multi ? `${prefix} list` : `${prefix} list; ${prefix} perceive ${target} -C -d 8`;
    } else {
      status = 'waiting for browser debugging approval';
      currentStep = probe.multi
        ? `${prefix} list`
        : `${prefix} perceive ${target} -C -d 8  # click Allow if Chrome asks`;
    }
  }

  return {
    status,
    currentStep,
    goldenPath: ['doctor', 'list/open', 'perceive', 'click/fill', 'since-action evidence', 'report'],
    commands: doctorNextStepCommands(checks),
  };
}

function doctorWarningCommands(checks) {
  const fd = checks.find(c => c.label === 'FD limit');
  const warnings = [];
  if (fd?.status === 'WARN') {
    const commands = Array.isArray(fd.recovery?.commands) && fd.recovery.commands.length
      ? fd.recovery.commands
      : [{ scope: 'current-shell', command: 'ulimit -n 4096', reason: fd.detail || 'open-files limit is low for long browser sessions', requiresAdmin: false }];
    warnings.push({
      label: 'FD limit',
      command: commands[0].command,
      reason: fd.detail || 'open-files limit is low for long browser sessions',
      commands,
    });
  }
  return warnings;
}

function doctorRecommendationModel(checks) {
  const node = checks.find(c => c.label === 'Node');
  const cdp = checks.find(c => c.label === 'CDP');
  const environment = checks.find(c => c.label === 'Environment');
  const tabs = checks.find(c => c.label === 'Tabs');
  const permission = checks.find(c => c.label === 'Permission');
  const probe = doctorProbeFromChecks(checks);
  const target = probe.exampleTarget || probe.targetPrefix || '<target>';
  const noTargets = tabs?.noTargets || /no debuggable page targets/i.test(tabs?.detail || '');
  const prefix = doctorCliPrefix(node);
  const base = {
    source: 'doctor-onboarding',
    stage: 'perceive',
    run: probe.multi ? `${prefix} list` : `${prefix} perceive ${target} -C -d 8`,
    ask: null,
    after: `${prefix} click ${target} @ref  # or: ${prefix} fill ${target} <selector> <text>`,
    requiresUserAction: false,
    consentRequired: false,
    reason: probe.multi
      ? `${probe.probeNote}. list is the source of truth for which tab.`
      : 'ready for live browser perception. For "what does this page say", run cdp text ' + target + ' --auto',
    commands: doctorNextStepCommands(checks),
    warnings: doctorWarningCommands(checks),
  };

  if (node?.status === 'FAIL') {
    return {
      ...base,
      stage: 'node',
      run: null,
      ask: NODE22_MISSING_HINT,
      after: `${prefix} doctor`,
      requiresUserAction: true,
      reason: node.detail || null,
    };
  }
  if (cdp?.status === 'FAIL') {
    if (cdp.profileDir && cdp.relaunch) {
      return {
        ...base,
        stage: 'browser-cdp',
        strategy: 'relaunch-same-profile',
        run: cdp.relaunch,
        ask: 'Relaunch the same debug browser profile. Do not invent DISPLAY, a new user-data-dir, or a second Chrome profile.',
        after: `${prefix} list`,
        requiresUserAction: true,
        consentRequired: false,
        reason: cdp.detail || null,
      };
    }
    if (cdp.port) {
      return {
        ...base,
        stage: 'browser-cdp',
        strategy: 'enable-existing-debugging',
        run: cdp.relaunch || null,
        ask: `Open chrome://inspect/#remote-debugging or edge://inspect, enable remote debugging, then run: ${prefix} doctor. Do not invent a new --user-data-dir.`,
        after: `${prefix} list`,
        requiresUserAction: true,
        consentRequired: true,
        reason: cdp.detail || null,
      };
    }
    if (environment?.recovery?.command) {
      return {
        ...base,
        stage: 'browser-cdp',
        run: environment.recovery.command,
        ask: `Approve launching an isolated local debug browser profile, then run: ${prefix} list.`,
        after: `${prefix} list`,
        requiresUserAction: true,
        consentRequired: true,
        reason: `${cdp.detail || 'Chrome is not reachable.'} Environment looks ${environment.detail || 'headless/remote'}.`,
      };
    }
    return {
      ...base,
      stage: 'browser-cdp',
      strategy: 'enable-existing-debugging',
      run: `${prefix} spawn-debug-browser edge --port 9222 --url https://example.com`,
      ask: `Open chrome://inspect/#remote-debugging or edge://inspect, enable remote debugging, then run: ${prefix} doctor.`,
      after: `${prefix} list`,
      requiresUserAction: true,
      consentRequired: true,
      reason: cdp.detail || null,
    };
  }
  if (cdp?.status === 'WARN') {
    return {
      ...base,
      stage: 'browser-cdp',
      run: `${prefix} doctor`,
      ask: 'Re-toggle browser remote debugging, or restart the app with CDP_PORT set.',
      after: `${prefix} list`,
      requiresUserAction: true,
      reason: cdp.detail || null,
    };
  }
  if (noTargets) {
    return {
      ...base,
      stage: 'open-page',
      run: `${prefix} open https://example.com`,
      ask: null,
      after: `${prefix} perceive <target-from-open> -C -d 8`,
      reason: tabs?.detail || null,
    };
  }
  if (permission?.status === 'WARN') {
    const severity = doctorCheckSeverity(permission);
    if (severity === 'advisory') {
      return {
        ...base,
        stage: 'perceive',
        run: probe.multi ? `${prefix} list` : `${prefix} perceive ${target} -C -d 8`,
        ask: null,
        after: `${prefix} click ${target} @ref  # or: ${prefix} fill ${target} <selector> <text>`,
        requiresUserAction: false,
        reason: permission.detail || 'CDP is usable; permission approval is advisory until a tab daemon attaches.',
      };
    }
    return {
      ...base,
      stage: 'browser-permission',
      run: probe.multi ? `${prefix} list` : `${prefix} perceive ${target} -C -d 8`,
      ask: 'Click Allow if Chrome asks.',
      after: `${prefix} click ${target} @ref  # or: ${prefix} fill ${target} <selector> <text>`,
      requiresUserAction: true,
      reason: permission.detail || null,
    };
  }
  return base;
}

function doctorRecommendationLines(checks) {
  const recommendation = doctorRecommendationModel(checks);
  const lines = ['Recommendation:'];
  if (recommendation.run) {
    const consent = recommendation.consentRequired ? '  (ask user first)' : '';
    lines.push(`  Run: ${recommendation.run}${consent}`);
  }
  if (recommendation.ask) lines.push(`  Ask: ${recommendation.ask}`);
  if (recommendation.after) lines.push(`  Then: ${recommendation.after}`);
  for (const warning of recommendation.warnings || []) {
    const commands = Array.isArray(warning.commands) && warning.commands.length
      ? warning.commands
      : [{ command: warning.command, reason: warning.reason, requiresAdmin: false }];
    for (const command of commands) {
      if (!command.command) continue;
      const admin = command.requiresAdmin ? ' (requires admin)' : '';
      lines.push(`  Long session note: ${command.command}${admin}  # ${command.reason || warning.reason}`);
    }
  }
  return lines;
}

function doctorNextSteps(checks) {
  const failures = checks.filter(c => c.status === 'FAIL');
  const cdp = checks.find(c => c.label === 'CDP');
  const node = checks.find(c => c.label === 'Node');
  const environment = checks.find(c => c.label === 'Environment');
  const fd = checks.find(c => c.label === 'FD limit');
  const tabs = checks.find(c => c.label === 'Tabs');
  const probe = doctorProbeFromChecks(checks);
  const liveTarget = probe.exampleTarget || probe.targetPrefix || '<target>';
  const noTargets = tabs?.noTargets || /no debuggable page targets/i.test(tabs?.detail || '');
  const prefix = doctorCliPrefix(node);
  const lines = ['', 'Next steps:'];
  if (node?.status === 'FAIL') {
    lines.push(`  1. ${NODE22_MISSING_HINT}`);
    return lines;
  }
  if (cdp?.status === 'FAIL') {
    if (cdp.relaunch && cdp.profileDir) {
      lines.push(`  1. ${cdp.relaunch}`);
      lines.push(`  2. Then run: ${prefix} list`);
    } else if (cdp.port) {
      lines.push(`  1. Existing browser: open chrome://inspect/#remote-debugging, enable remote debugging, then rerun: ${prefix} doctor`);
      lines.push('  2. Do not invent a new --user-data-dir or a second Chrome profile; relaunch the same browser/profile that last served this CDP port.');
      lines.push(`  3. Then run: ${prefix} list`);
    } else if (environment?.recovery?.command) {
      lines.push(`  1. ${environment.recovery.command}`);
      lines.push(`  2. Then run: ${prefix} list`);
      lines.push(`  3. Existing browser alternative: open chrome://inspect/#remote-debugging, enable remote debugging, then rerun: ${prefix} doctor`);
    } else {
      lines.push(`  1. Existing browser: open chrome://inspect/#remote-debugging, enable remote debugging, then rerun: ${prefix} doctor`);
      lines.push(`  2. Isolated profile: ${prefix} spawn-debug-browser edge --port 9222 --url https://example.com`);
      lines.push(`  3. Then run: ${prefix} list`);
    }
    return lines;
  }
  if (cdp?.status === 'WARN') {
    lines.push('  1. Re-toggle browser remote debugging, or restart the app with CDP_PORT set.');
    lines.push(`  2. If Chrome asks "Allow debugging?", click Allow, then rerun: ${prefix} list`);
  } else {
    if (noTargets) {
      lines.push(`  1. ${prefix} open https://example.com`);
      lines.push('  2. If Chrome asks "Allow debugging?", click Allow; open waits up to 5s (use --attach-timeout-ms 60000 if needed).');
      lines.push(`  3. Use the target id printed by open: ${prefix} perceive <target-from-open> -C -d 8`);
      lines.push(`  Note: for "what does this page say", run: ${prefix} text <target-from-open> --auto`);
      lines.push(`  4. ${prefix} click <target-from-open> @ref  # or: ${prefix} fill <target-from-open> <selector> <text>`);
      lines.push(`  5. ${prefix} perceive <target-from-open> --since-action`);
      lines.push(`  6. ${prefix} report <target-from-open>`);
    } else {
      lines.push(`  1. ${prefix} list`);
      if (probe.multi) {
        lines.push(`     ${probe.probeNote}`);
        lines.push('     list is the source of truth for which tab');
      }
      if (!tabs?.targetPrefixes?.length) lines.push(`  2. If list is empty: ${prefix} open https://example.com`);
      lines.push(`  ${tabs?.targetPrefixes?.length ? '2' : '3'}. ${prefix} perceive ${liveTarget} -C -d 8`);
      if (probe.multi) lines.push('     (sample after list — not a next-probe)');
      lines.push(`  Note: for "what does this page say", run: ${prefix} text ${liveTarget} --auto`);
      lines.push(`  ${tabs?.targetPrefixes?.length ? '3' : '4'}. ${prefix} click ${liveTarget} @ref  # or: ${prefix} fill ${liveTarget} <selector> <text>`);
      lines.push(`  ${tabs?.targetPrefixes?.length ? '4' : '5'}. ${prefix} perceive ${liveTarget} --since-action`);
      lines.push(`  ${tabs?.targetPrefixes?.length ? '5' : '6'}. ${prefix} report ${liveTarget}`);
    }
  }
  if (fd?.status === 'WARN') {
    lines.push('  Note: for long sessions, use: ulimit -n 4096');
  }
  if (failures.length === 0) {
    lines.push('  Goal: doctor -> list/open -> perceive -> click/fill -> since-action evidence -> report');
  }
  return lines;
}

function formatDoctorReport(checks) {
  const model = buildDoctorModel(checks);
  const lines = ['chrome-cdp-ex doctor'];
  lines.push(...doctorWizardSummary(checks), '', ...doctorRecommendationLines(checks), '', 'Checks:');
  for (const c of model.checks) {
    const tag = c.status.padEnd(4);
    lines.push(`  [${tag}] ${c.label}: ${c.detail}`);
    if (c.severity && c.severity !== 'ok') lines.push(`         severity: ${c.severity}`);
    if (c.hint) lines.push(`         hint: ${c.hint}`);
  }
  if (model.readiness === 'ready') lines.push('Ready.');
  else if (model.readiness === 'usable-with-warnings') {
    lines.push(`Usable with warnings (${model.warnings} warning${model.warnings === 1 ? '' : 's'}, ${model.advisories} advisor${model.advisories === 1 ? 'y' : 'ies'}).`);
  } else {
    lines.push(`Blocked: ${model.failures} failure${model.failures === 1 ? '' : 's'}${model.warnings ? `, ${model.warnings} warning${model.warnings === 1 ? '' : 's'}` : ''}.`);
  }
  if (model.provenCommand) lines.push(`Proven / next probe: ${model.provenCommand}`);
  if (model.probeNote) lines.push(`  ${model.probeNote}`);
  if (model.listIsSourceOfTruth) lines.push('  list is the source of truth for which tab');
  lines.push(...doctorNextSteps(checks));
  return lines.join('\n');
}

function doctorCheckSeverity(check = {}) {
  if (check.severity) return check.severity;
  if (check.status === 'FAIL') return 'blocking';
  if (check.status === 'WARN') {
    // Direct checkout invocation is operationally valid even when the skill is
    // not copied into the conventional Claude installation directory.
    if (check.label === 'Skill install') return 'advisory';
    // Permission without a live daemon is advisory when CDP/tabs are otherwise usable.
    if (check.label === 'Permission' && !/no target|skipped until/i.test(check.detail || '')) return 'advisory';
    return 'warning';
  }
  return 'ok';
}

function doctorStatusSummary(checks) {
  const annotated = (checks || []).map(check => ({
    ...check,
    severity: doctorCheckSeverity(check),
  }));
  const failures = annotated.filter(c => c.status === 'FAIL' || c.severity === 'blocking').length;
  const warnings = annotated.filter(c => c.severity === 'warning').length;
  const advisories = annotated.filter(c => c.severity === 'advisory').length;
  let readiness = 'ready';
  if (failures > 0) readiness = 'blocked';
  else if (warnings > 0 || advisories > 0) readiness = 'usable-with-warnings';
  return {
    status: readiness,
    readiness,
    ready: failures === 0 && warnings === 0,
    operationalReady: failures === 0 && warnings === 0,
    failures,
    warnings,
    actionableWarnings: warnings,
    advisories,
  };
}

function stripDoctorStepPrefix(line) {
  return String(line || '')
    .trim()
    .replace(/^\d+\.\s*/, '')
    .replace(/^Then run:\s*/i, '')
    .replace(/^If list is empty:\s*/i, '')
    .replace(/^Use the target id printed by open:\s*/i, '')
    .trim();
}

function doctorNextStepCommands(checks) {
  return doctorNextSteps(checks)
    .map(stripDoctorStepPrefix)
    .filter(line => line.startsWith('cdp ') || /\bcdp\.mjs\b/.test(line) || /--remote-debugging-port=/.test(line));
}

function buildDoctorModel(checks) {
  const summary = doctorStatusSummary(checks);
  const annotatedChecks = checks.map(check => ({ ...check, severity: doctorCheckSeverity(check) }));
  const recommendation = doctorRecommendationModel(checks);
  const node = annotatedChecks.find(c => c.label === 'Node');
  const cdpOk = annotatedChecks.find(c => c.label === 'CDP')?.status === 'OK';
  const tabsOk = annotatedChecks.find(c => c.label === 'Tabs')?.status === 'OK';
  const probe = doctorProbeFromChecks(annotatedChecks);
  const provenCommand = cdpOk && tabsOk
    ? probe.provenCommand
    : (recommendation?.run || node?.rerunCommand || null);
  return {
    schema: 'chrome-cdp-ex.doctor.v1',
    ...summary,
    provenCommand,
    probeNote: cdpOk && tabsOk ? probe.probeNote : null,
    listIsSourceOfTruth: Boolean(cdpOk && tabsOk && probe.listIsSourceOfTruth),
    recommendedTargetPrefix: cdpOk && tabsOk ? probe.targetPrefix : null,
    wizard: doctorWizardModel(checks),
    recommendation,
    routeRecommendation: {
      schema: 'chrome-cdp-ex.route-recommendation.v1',
      claude: 'cli',
      cursor: 'mcp',
      'claude-code-skill': 'cli',
      'claude-desktop-mcp': 'mcp',
      codex: 'cli',
      hermes: 'cli',
      'hermes-shell': 'cli',
      openclaw: 'mcp',
      pi: 'cli',
      notes: 'Matched MCP/CLI campaigns favor CLI for output tokens; MCP is the portable host socket.',
    },
    checks: annotatedChecks,
    nextSteps: doctorNextStepCommands(checks),
  };
}

function formatDoctorOutput(checks, { format = 'text' } = {}) {
  if (format === 'json') return formatJson(buildDoctorModel(checks));
  return formatDoctorReport(checks);
}

async function runDoctorChecks(opts = {}) {
  const safeLstat = (p) => { try { return lstatSync(p); } catch { return null; } };
  const fs = opts.fs || { existsSync, lstatSync: safeLstat };
  const checks = [];
  checks.push(checkNode(opts.nodeVersion, {
    home: opts.home,
    env: opts.env,
    fs,
    spawnSync: opts.spawnSync,
    execPath: opts.execPath,
    cdpScriptPath: opts.cdpScriptPath,
    discover: opts.discoverNode22,
  }));
  checks.push(checkSkillSymlink({ home: opts.home, env: opts.env, fs }));
  checks.push(checkDaemonSockets({ list: opts.listDaemons }));
  checks.push(checkFdLimit({ limit: opts.fdLimit, platform: opts.platform }));
  checks.push(checkRuntimeEnvironment({ platform: opts.platform, env: opts.env, fs }));
  const cdp = await checkCdpReachability({
    env: opts.env,
    fetcher: opts.fetcher,
    host: opts.host,
    lastEndpoint: opts.lastEndpoint,
    readLastEndpoint: opts.readLastEndpoint,
    connectWebSocket: opts.connectWebSocket,
  });
  checks[4] = reconcileRuntimeEnvironmentCheck(checks[4], cdp);
  checks.push(cdp);
  const tabs = await checkBrowserTargets({ cdp, env: opts.env, fetcher: opts.fetcher, host: opts.host });
  checks.push(tabs);
  checks.push(checkBrowserPermission({
    daemons: checks.find(c => c.label === 'Daemons'),
    tabs,
    cdp,
    environment: checks.find(c => c.label === 'Environment'),
  }));
  return checks;
}

async function doctorStr(opts = {}) {
  const checks = await runDoctorChecks(opts);
  return formatDoctorOutput(checks, { format: opts.format || 'text' });
}

// ---------------------------------------------------------------------------
// spawn-debug-browser: launch a browser with --remote-debugging-port using a
// disposable user-data-dir. macOS reviewer feedback: previous skill docs said
// to never suggest --remote-debugging-port, but the only way to debug a
// fresh-install Chrome/Edge without touching the user's main profile is to
// spawn an isolated debug profile. This helper keeps that path predictable.
// ---------------------------------------------------------------------------

const DEFAULT_BROWSER_PATHS = {
  darwin: {
    edge:   ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
    chrome: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    brave:  ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
  },
  linux: {
    edge:   ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable', '/usr/bin/microsoft-edge-dev'],
    chrome: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
    brave:  ['/usr/bin/brave-browser', '/usr/bin/brave'],
  },
  win32: {
    edge:   [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ],
    chrome: [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ],
    brave: [
      'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      'C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    ],
  },
};

function parseSpawnDebugBrowserArgs(args, env = process.env) {
  const fopts = parseFormatArgs(args || [], ['text', 'json']);
  const opts = {
    browser: (env && env.CDP_DEBUG_BROWSER) || 'edge',
    port: 9222,
    host: DEFAULT_CDP_HOST,
    url: null,
    profileDir: null,
    executable: null,
    headless: false,
    noSandbox: false,
    disableGpu: false,
    waitMs: DEFAULT_SPAWN_READY_TIMEOUT_MS,
    format: fopts.format,
  };
  const tokens = (fopts.args || []).filter(a => a !== undefined && a !== null);
  for (let i = 0; i < tokens.length; i++) {
    const a = tokens[i];
    if (a === '--port' || a === '-p') opts.port = parseInt(tokens[++i]) || 9222;
    else if (a === '--host') opts.host = tokens[++i] || opts.host;
    else if (a === '--url' || a === '-u') opts.url = tokens[++i];
    else if (a === '--profile-dir' || a === '--user-data-dir') opts.profileDir = tokens[++i];
    else if (a === '--browser') opts.browser = (tokens[++i] || opts.browser).toLowerCase();
    else if (a === '--exe' || a === '--executable') opts.executable = tokens[++i];
    else if (a === '--headless') opts.headless = 'new';
    else if (String(a).startsWith('--headless=')) opts.headless = String(a).slice('--headless='.length) || 'new';
    else if (a === '--no-sandbox') opts.noSandbox = true;
    else if (a === '--disable-gpu') opts.disableGpu = true;
    else if (a === '--wait-ms') opts.waitMs = parseNonNegativeInteger(tokens[++i], 'spawn-debug-browser: --wait-ms');
    else if (String(a).startsWith('--wait-ms=')) opts.waitMs = parseNonNegativeInteger(String(a).slice('--wait-ms='.length), 'spawn-debug-browser: --wait-ms');
    else if (['edge','chrome','brave','google-chrome','msedge','chromium'].includes(a.toLowerCase())) {
      const norm = a.toLowerCase();
      if (norm === 'msedge') opts.browser = 'edge';
      else if (norm === 'google-chrome' || norm === 'chromium') opts.browser = 'chrome';
      else opts.browser = norm;
    }
  }
  if (!opts.profileDir) {
    const tmp = (env && env.TMPDIR) || '/tmp';
    opts.profileDir = `${tmp.replace(/\/$/, '')}/chrome-cdp-ex-${opts.browser}-debug-profile-${opts.port}`;
  }
  return opts;
}

async function listSpawnedDebugTargets({ port, host = DEFAULT_CDP_HOST, fetcher = fetch } = {}) {
  try {
    const res = await fetcher(`http://${host}:${port}/json/list`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      const raw = await res.json();
      return Array.isArray(raw)
        ? raw.map(normalizeBrowserTargetInfo).filter(isDebuggablePageTarget)
        : [];
    }
  } catch {}
  try {
    const wsUrl = `ws://${host}:${port}/devtools/browser`;
    const ws = new WebSocket(wsUrl);
    const targetsResult = await new Promise((resolveWs, rejectWs) => {
      ws.onopen = () => {
        ws.send(JSON.stringify({ id: 1, method: 'Target.getTargets' }));
      };
      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.id === 1 && data.result?.targetInfos) {
            resolveWs(data.result.targetInfos);
          }
        } catch {}
      };
      ws.onerror = (err) => rejectWs(err);
      setTimeout(() => { ws.close(); rejectWs(new Error('timeout')); }, 1500);
    });
    ws.close();
    return Array.isArray(targetsResult)
      ? targetsResult.map(normalizeBrowserTargetInfo).filter(isDebuggablePageTarget)
      : [];
  } catch {
    return [];
  }
}

function pickSpawnedTarget(pages = [], url = null) {
  if (!pages.length) return null;
  if (url) {
    try {
      return selectPageTarget(pages, { url, exact: false }).page;
    } catch {
      // fall through to ranked pick
    }
  }
  return rankPageTargets(pages)[0] || null;
}

function buildSpawnDebugBrowserModel(plan, readiness, { child = null, target = null } = {}) {
  const targetId = target?.targetId || null;
  const targetPrefix = targetId ? String(targetId).slice(0, getDisplayPrefixLength([targetId])) : null;
  const nextCommand = targetPrefix
    ? `CDP_PORT=${plan.port} cdp perceive ${targetPrefix} -C -d 8`
    : `CDP_PORT=${plan.port} cdp list`;
  const disposable = isDisposableSpawnProfileDir(plan.profileDir);
  return {
    schema: 'chrome-cdp-ex.spawn-debug-browser.v1',
    ready: readiness?.ok === true,
    browser: plan.browser,
    pid: child?.pid || null,
    profileDir: plan.profileDir,
    host: plan.host,
    port: plan.port,
    url: plan.url || target?.url || null,
    product: readiness?.product || null,
    targetId,
    targetPrefix,
    title: target?.title || null,
    nextCommand,
    cleanup: {
      stopHint: `CDP_PORT=${plan.port} cdp stop${targetPrefix ? ` ${targetPrefix}` : ''}`,
      deleteProfile: disposable ? `rm -rf ${plan.profileDir}` : null,
    },
  };
}

function formatSpawnDebugBrowserOutput(model, { format = 'text' } = {}) {
  if (format === 'json') return formatJson(model);
  const lines = [
    `Spawned ${model.browser} debug profile on CDP_PORT=${model.port} (pid ${model.pid || '?'})`,
    `  CDP ready:  ${model.product || `${model.host}:${model.port}`}`,
    `  Executable: (see profile)`,
    `  Profile:    ${model.profileDir}`,
  ];
  if (model.url) lines.push(`  URL:        ${model.url}`);
  if (model.targetPrefix) {
    lines.push(`  Target:     ${model.targetPrefix}${model.title ? `  ${model.title}` : ''}`);
  }
  lines.push('');
  lines.push(`Next: ${model.nextCommand}`);
  if (model.cleanup?.deleteProfile) {
    lines.push(`Stop/cleanup: ${model.cleanup.stopHint}; then ${model.cleanup.deleteProfile}`);
    lines.push(`(Profile is disposable — delete ${model.profileDir} to reset.)`);
  } else {
    lines.push(`Stop: ${model.cleanup?.stopHint || `CDP_PORT=${model.port} cdp stop`}`);
    lines.push('(Reused existing profile — do not delete this user-data-dir.)');
  }
  return lines.join('\n');
}

const BROWSER_COMMANDS = {
  edge: ['microsoft-edge', 'microsoft-edge-stable', 'microsoft-edge-dev', 'msedge'],
  chrome: ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome'],
  brave: ['brave-browser', 'brave'],
};

function findOnPath(commands, env = process.env, fs = { existsSync }) {
  const dirs = String(env?.PATH || '').split(delimiter).filter(Boolean);
  for (const cmd of commands || []) {
    for (const dir of dirs) {
      const candidate = resolve(dir, cmd);
      if (fs.existsSync(candidate)) return candidate;
      if (IS_WINDOWS && fs.existsSync(candidate + '.exe')) return candidate + '.exe';
    }
  }
  return null;
}

function detectBrowserPath(browser, platform = process.platform, fs = { existsSync }, env = process.env) {
  const list = (DEFAULT_BROWSER_PATHS[platform] || {})[browser] || [];
  for (const candidate of list) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return findOnPath(BROWSER_COMMANDS[browser] || [], env, fs);
}

function buildSpawnDebugBrowserPlan(opts, platform = process.platform, fs = { existsSync }, env = process.env) {
  const exe = opts.executable || detectBrowserPath(opts.browser, platform, fs, env);
  if (!exe || !fs.existsSync(exe)) {
    const list = [
      ...((DEFAULT_BROWSER_PATHS[platform] || {})[opts.browser] || []),
      ...((BROWSER_COMMANDS[opts.browser] || []).map(c => `$PATH:${c}`)),
    ];
    const tried = list.length ? list.join(', ') : '(no candidates configured for this platform)';
    throw new Error(`spawn-debug-browser: cannot find ${opts.browser} executable. Tried: ${tried}. Use --exe /path/to/browser, set CDP_DEBUG_BROWSER, or install it on PATH.`);
  }
  const args = [
    `--remote-debugging-address=${opts.host || DEFAULT_CDP_HOST}`,
    `--remote-debugging-port=${opts.port}`,
    `--user-data-dir=${opts.profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];
  if (opts.headless) args.push(`--headless=${opts.headless === true ? 'new' : opts.headless}`);
  if (opts.noSandbox) args.push('--no-sandbox');
  if (opts.disableGpu) args.push('--disable-gpu');
  if (opts.url) args.push(opts.url);
  return { exe, args, profileDir: opts.profileDir, port: opts.port, host: opts.host || DEFAULT_CDP_HOST, url: opts.url, browser: opts.browser, waitMs: opts.waitMs };
}

function captureSpawnOutput(child, maxBytes = 4096) {
  const output = { stdout: '', stderr: '' };
  for (const key of ['stdout', 'stderr']) {
    const stream = child?.[key];
    if (!stream?.on) continue;
    try { stream.setEncoding?.('utf8'); } catch {}
    stream.on('data', chunk => {
      output[key] = (output[key] + String(chunk)).slice(-maxBytes);
    });
  }
  return output;
}

async function waitForSpawnedCdp({ port, host = DEFAULT_CDP_HOST, timeoutMs = DEFAULT_SPAWN_READY_TIMEOUT_MS, child = null, fetcher = fetch, output = null } = {}) {
  const timeout = Math.min(Math.max(Number(timeoutMs) || DEFAULT_SPAWN_READY_TIMEOUT_MS, 0), 120000);
  const deadline = Date.now() + timeout;
  let exited = false;
  let exitCode = null;
  let signal = null;
  let lastError = null;
  if (child?.once) {
    child.once('exit', (code, sig) => {
      exited = true;
      exitCode = code;
      signal = sig || null;
    });
  }
  while (Date.now() <= deadline) {
    if (exited) {
      return {
        ok: false,
        exited: true,
        exitCode,
        signal,
        stdout: output?.stdout || '',
        stderr: output?.stderr || '',
      };
    }
    try {
      const res = await fetcher(`http://${host}:${port}/json/version`, { signal: AbortSignal.timeout(500) });
      if (res.ok) {
        const info = await res.json().catch(() => ({}));
        return {
          ok: true,
          port,
          host,
          product: info.Browser || info.product || null,
          webSocketDebuggerUrl: info.webSocketDebuggerUrl || null,
        };
      }
      lastError = `HTTP ${res.status}`;
      // Fallback check: if HTTP fails, try websocket check
      try {
        const wsUrl = `ws://${host}:${port}/devtools/browser`;
        const ws = new WebSocket(wsUrl);
        const wsOpen = await new Promise((resolveWs, rejectWs) => {
          ws.onopen = () => { resolveWs(true); ws.close(); };
          ws.onerror = (err) => rejectWs(err);
          setTimeout(() => { ws.close(); rejectWs(new Error('timeout')); }, 300);
        });
        if (wsOpen) {
          return {
            ok: true,
            port,
            host,
            product: 'Chrome (WebSocket Fallback)',
            webSocketDebuggerUrl: wsUrl,
          };
        }
      } catch {}
    } catch (e) {
      lastError = e.message || String(e);
      // Fallback check on error
      try {
        const wsUrl = `ws://${host}:${port}/devtools/browser`;
        const ws = new WebSocket(wsUrl);
        const wsOpen = await new Promise((resolveWs, rejectWs) => {
          ws.onopen = () => { resolveWs(true); ws.close(); };
          ws.onerror = (err) => rejectWs(err);
          setTimeout(() => { ws.close(); rejectWs(new Error('timeout')); }, 300);
        });
        if (wsOpen) {
          return {
            ok: true,
            port,
            host,
            product: 'Chrome (WebSocket Fallback)',
            webSocketDebuggerUrl: wsUrl,
          };
        }
      } catch {}
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await sleep(Math.min(100, remainingMs));
  }
  return {
    ok: false,
    timeout: true,
    port,
    host,
    timeoutMs: timeout,
    error: lastError,
    stdout: output?.stdout || '',
    stderr: output?.stderr || '',
  };
}

function formatSpawnDebugBrowserReadinessFailure(plan, readiness) {
  const lines = [];
  if (readiness?.exited) {
    lines.push(`spawn-debug-browser: ${plan.browser} exited early before CDP became reachable (exit ${readiness.exitCode ?? 'unknown'}${readiness.signal ? `, signal ${readiness.signal}` : ''}).`);
  } else {
    lines.push(`spawn-debug-browser: CDP was not reachable on ${plan.host}:${plan.port} within ${formatDuration(readiness?.timeoutMs || plan.waitMs)}.`);
  }
  if (readiness?.stderr) lines.push(`stderr: ${readiness.stderr.trim()}`);
  if (readiness?.stdout) lines.push(`stdout: ${readiness.stdout.trim()}`);
  lines.push(`Try: cdp spawn-debug-browser ${plan.browser} --headless --no-sandbox --port ${plan.port} --exe ${plan.exe}${plan.url ? ` --url ${plan.url}` : ''}`);
  return lines.join('\n');
}

async function probeTcpPort({ host = DEFAULT_CDP_HOST, port, timeoutMs = 500, connect = options => net.createConnection(options) } = {}) {
  if (!Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error(`spawn-debug-browser: invalid port ${port}`);
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = connect({ host, port: Number(port) });
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.removeAllListeners?.();
      socket?.on?.('error', () => {});
      try { socket?.destroy?.(); } catch {}
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error(`spawn-debug-browser: could not determine whether ${host}:${port} is free (probe timed out).`)), timeoutMs);
    socket.once('connect', () => finish(resolve, { occupied: true }));
    socket.once('error', error => {
      if (error?.code === 'ECONNREFUSED') finish(resolve, { occupied: false });
      else finish(reject, new Error(`spawn-debug-browser: could not probe ${host}:${port} (${error?.message || error}).`));
    });
  });
}

async function spawnDebugBrowserStr(args, env = process.env, deps = {}) {
  const platform = deps.platform || process.platform;
  const fs = deps.fs || { existsSync, mkdirSync };
  const launcher = deps.spawn || spawn;
  const probePort = deps.probeTcpPort || probeTcpPort;
  const waitForCdp = deps.waitForSpawnedCdp || waitForSpawnedCdp;
  const listTargets = deps.listSpawnedDebugTargets || listSpawnedDebugTargets;
  const fetcher = deps.fetcher || fetch;
  const opts = parseSpawnDebugBrowserArgs(args, env);
  const plan = buildSpawnDebugBrowserPlan(opts, platform, fs, env);
  const portState = await probePort({ host: plan.host, port: plan.port });
  if (portState?.occupied) {
    throw new Error(`spawn-debug-browser: port ${plan.port} is already in use on ${plan.host}. Choose another port with --port <N>.`);
  }
  try { fs.mkdirSync(plan.profileDir, { recursive: true }); } catch {}
  const child = launcher(plan.exe, plan.args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const output = captureSpawnOutput(child);
  const readiness = await waitForCdp({
    port: plan.port,
    host: plan.host,
    timeoutMs: plan.waitMs,
    child,
    output,
    fetcher,
  });
  if (!readiness.ok) {
    throw new Error(formatSpawnDebugBrowserReadinessFailure(plan, readiness));
  }
  child.stdout?.unref?.();
  child.stderr?.unref?.();
  child.unref?.();
  const pages = await listTargets({ port: plan.port, host: plan.host, fetcher });
  const target = pickSpawnedTarget(pages, plan.url);
  const remember = deps.rememberLastCdpEndpoint || rememberLastCdpEndpoint;
  try {
    remember({
      host: plan.host,
      port: plan.port,
      profileDir: plan.profileDir,
      exe: plan.exe,
      browser: plan.browser,
    });
  } catch {}
  const model = buildSpawnDebugBrowserModel(plan, readiness, { child, target });
  // Prefer executable path in text mode for operators.
  if (opts.format !== 'json') {
    const text = formatSpawnDebugBrowserOutput(model, { format: 'text' })
      .replace('  Executable: (see profile)', `  Executable: ${plan.exe}`);
    return text;
  }
  return formatSpawnDebugBrowserOutput(model, { format: 'json' });
}

function overlayDetectorScript({ targetPoint = null, objectBoundTarget = false } = {}) {
  const targetJson = JSON.stringify(targetPoint && ['input', 'x', 'y', 'descriptor'].reduce((snapshot, key) => { const property = Object.getOwnPropertyDescriptor(targetPoint, key); if (property && Object.hasOwn(property, 'value')) snapshot[key] = property.value; return snapshot; }, Object.create(null))); return `(function() {
    const targetPoint = ${targetJson};
    const vw = window.innerWidth || 0;
    const vh = window.innerHeight || 0;
    const layoutW = (document.documentElement && document.documentElement.clientWidth) || vw;
    const layoutH = (document.documentElement && document.documentElement.clientHeight) || vh;
    const slackX = Math.max(8, vw - layoutW);
    const slackY = Math.max(8, vh - layoutH);
    function visible(el) {
      if (!el || el.id === '__cdp_annot_overlay__') return false;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width >= 2 && r.height >= 2 && r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
    }
    function selectorFor(el) {
      if (!el) return '';
      if (el.id) return '#' + CSS.escape(el.id);
      const tag = el.tagName ? el.tagName.toLowerCase() : 'node';
      const cls = typeof el.className === 'string' && el.className.trim()
        ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).map(CSS.escape).join('.')
        : '';
      return tag + cls;
    }
    function shortText(el) {
      return (el?.getAttribute?.('aria-label') || el?.textContent || '').trim().replace(/\\s+/g, ' ').substring(0, 80);
    }
    function pointInRect(point, rect) {
      return !!point && point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
    }
    function elementInfo(el, kind, target) {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const cx = Math.min(Math.max(r.left + r.width / 2, 0), Math.max(vw - 1, 0));
      const cy = Math.min(Math.max(r.top + r.height / 2, 0), Math.max(vh - 1, 0));
      const topAtCenter = document.elementFromPoint(cx, cy);
      const topAtTarget = target ? document.elementFromPoint(target.x, target.y) : null;
      return {
        kind,
        selector: selectorFor(el),
        role: el.getAttribute('role') || '',
        label: el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || '',
        text: shortText(el),
        tag: el.tagName,
        position: cs.position,
        pointerEvents: cs.pointerEvents,
        zIndex: cs.zIndex,
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        coversViewport: (r.left <= slackX && r.top <= slackY && r.right >= vw - slackX && r.bottom >= vh - slackY)
          || (r.left <= 8 && r.top <= 8 && r.right >= layoutW - 8 && r.bottom >= layoutH - 8),
        coversTarget: pointInRect(target, r),
        topAtCenter: topAtCenter === el || el.contains(topAtCenter),
        topAtTarget: topAtTarget === el || el.contains(topAtTarget),
      };
    }
    function isDialog(el) {
      return el.matches('[role="dialog"], dialog, [aria-modal="true"]');
    }
    const targetElement = ${objectBoundTarget ? 'this' : 'null'} || (targetPoint && typeof targetPoint.input === 'string' && !targetPoint.input.startsWith('@') ? document.querySelector(targetPoint.input) : null);
    const seen = new Set(), overlays = [];
    function add(el, kind) {
      const dialog = isDialog(el); if (!visible(el) || seen.has(el) || (!dialog && targetElement && (el === targetElement || targetElement.contains(el)))) return;
      seen.add(el);
      const info = elementInfo(el, kind, targetPoint);
      const hasPointer = info.pointerEvents !== 'none';
      const blocksTarget = !!targetPoint && info.coversTarget && hasPointer && (info.topAtTarget || dialog);
      const blocksPage = !targetPoint && hasPointer && (dialog || info.coversViewport);
      if (dialog || blocksTarget || blocksPage) overlays.push(Object.defineProperty({ ...info, blocking: blocksTarget || blocksPage || dialog }, 'targetSelf', { value: dialog && el === targetElement }));
    }
    for (const el of document.querySelectorAll('[role="dialog"], dialog, [aria-modal="true"]')) add(el, 'dialog');
    for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
      add(el, el.getAttribute('aria-modal') === 'true' ? 'dialog' : 'overlay');
      if (overlays.length >= 20) break;
    }
    overlays.sort((a, b) => {
      const za = Number.parseInt(a.zIndex, 10);
      const zb = Number.parseInt(b.zIndex, 10);
      const zcmp = (Number.isFinite(zb) ? zb : 0) - (Number.isFinite(za) ? za : 0);
      if (zcmp) return zcmp;
      return (b.rect.w * b.rect.h) - (a.rect.w * a.rect.h);
    });
    const target = targetPoint ? { ...targetPoint, blocked: false, topElement: null } : null;
    if (targetPoint) {
      const top = document.elementFromPoint(targetPoint.x, targetPoint.y);
      if (top) target.topElement = elementInfo(top, isDialog(top) ? 'dialog' : 'top-element', targetPoint);
      const blocker = overlays.find(o => !o.targetSelf && o.coversTarget && (o.topAtTarget || o.kind === 'dialog' || o.blocking));
      if (blocker) {
        target.blocked = true;
        target.topElement = { kind: blocker.kind, selector: blocker.selector, text: blocker.label || blocker.text || blocker.tag };
      }
    }
    const blocking = overlays.some(o => o.blocking) || !!target?.blocked;
    return JSON.stringify({
      schema: 'chrome-cdp-ex.overlays.v1',
      viewport: { width: vw, height: vh },
      target,
      overlayCount: overlays.length,
      blocking,
      overlays: overlays.slice(0, 10),
      nextCommand: null,
    });
  }).call(this)`; }

function formatOverlayRect(rect = {}) {
  return `(${Math.round(rect.x || 0)},${Math.round(rect.y || 0)} ${Math.round(rect.w || 0)}×${Math.round(rect.h || 0)})`;
}

function overlayElementLabel(element = {}) {
  const selector = element.selector || '<unknown>';
  const label = element.label || element.text || element.tag || '';
  return `[${element.kind || 'overlay'}] ${selector}${label ? ` "${label}"` : ''}`;
}

function formatOverlayReport(model, targetId) {
  const lines = [`Overlay detector: ${model.blocking ? 'blocking' : 'clear'}`];
  if (model.target) {
    const target = model.target;
    const status = target.blocked && target.topElement
      ? `blocked by ${overlayElementLabel(target.topElement)}`
      : 'not blocked';
    lines.push(`Target: ${target.input || '(point)'} at (${Math.round(target.x)},${Math.round(target.y)}) — ${status}`);
  }
  if (!model.overlays || model.overlays.length === 0) {
    lines.push('No visible blocking overlays/dialogs detected.');
  } else {
    lines.push(`Overlays: ${model.overlays.length}`);
    for (const [i, overlay] of model.overlays.entries()) {
      const role = overlay.role ? ` role=${overlay.role}` : '';
      const z = overlay.zIndex != null ? ` z=${overlay.zIndex}` : '';
      const pointer = overlay.pointerEvents ? ` pointer=${overlay.pointerEvents}` : '';
      const target = overlay.coversTarget ? ' covers-target' : '';
      lines.push(`${i + 1}. [${overlay.kind || 'overlay'}] ${overlay.selector || '<unknown>'}${role}${z}${pointer} rect=${formatOverlayRect(overlay.rect)}${target}`);
      const text = overlay.label || overlay.text;
      if (text) lines.push(`   Text: ${text}`);
    }
  }
  const next = model.blocking
    ? (model.nextCommand || `cdp dismiss-modal ${targetId}`)
    : 'continue; if click still fails, run `status` or `perceive --since-action` before retrying';
  lines.push(`Next: ${next}`);
  return lines.join('\n');
}

async function resolveOverlayTargetPoint(cdp, sid, targetArg, refMap, refState) {
  if (!targetArg) return { targetPoint: null, objectId: null };
  if (isRef(targetArg)) {
    const { rect, objectId } = await resolveRefRectNoScroll(cdp, sid, refMap, targetArg, refState);
    return { targetPoint: {
      input: targetArg,
      x: Math.round((Number(rect.x) || 0) + (Number(rect.w) || 0) / 2),
      y: Math.round((Number(rect.y) || 0) + (Number(rect.h) || 0) / 2),
      descriptor: `<${rect.tag || '?'}> "${rect.text || ''}"`,
    }, objectId };
  }
  const raw = await evalStr(cdp, sid, `(function() {
    const el = document.querySelector(${JSON.stringify(targetArg)});
    if (!el) return JSON.stringify({ ok: false, error: 'Element not found: ' + ${JSON.stringify(targetArg)} });
    const rect = el.getBoundingClientRect();
    return JSON.stringify({
      ok: true,
      input: ${JSON.stringify(targetArg)},
      x: Math.round(rect.x + rect.width / 2),
      y: Math.round(rect.y + rect.height / 2),
      descriptor: '<' + el.tagName + '> "' + (el.textContent || '').trim().substring(0, 80) + '"'
    });
  })()`);
  const parsed = JSON.parse(raw);
  if (!parsed.ok) throw new Error(parsed.error);
  delete parsed.ok;
  return { targetPoint: parsed, objectId: null };
}

async function overlayStr(cdp, sid, targetId, args = [], refMap = new Map(), refState = null) {
  const fopts = parseFormatArgs(args, ['text', 'json']), targetArg = fopts.args[0] || null;
  const { targetPoint, objectId } = await resolveOverlayTargetPoint(cdp, sid, targetArg, refMap, refState);
  const raw = objectId && !parseFrameRef(targetArg)
    ? await resolveRefRectNoScroll(cdp, sid, refMap, targetArg, refState, { objectId, functionDeclaration: `function() { return ${overlayDetectorScript({ targetPoint, objectBoundTarget: true })}; }` })
    : await evalStr(cdp, sid, overlayDetectorScript({ targetPoint }));
  const model = JSON.parse(raw);
  if (model.blocking && !model.nextCommand) model.nextCommand = `cdp dismiss-modal ${targetId}`;
  if (fopts.format === 'json') return formatJson(model);
  return formatOverlayReport(model, targetId);
}

// ---------------------------------------------------------------------------
// dismiss-modal: close common dialog/modal patterns without firing background
// shortcuts. Reviewer feedback: pressing Space to close a "press any key" MOTD
// also triggered the underlying game's `space` shortcut. dismiss-modal favours
// safer signals (Escape / explicit close button / aria-modal click target)
// over global-key presses.
// ---------------------------------------------------------------------------

function dismissModalScript() {
  return `(function() {
    function visible(el) {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return false;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return false;
      return true;
    }
    function findCloseButton(root) {
      const candidates = root.querySelectorAll('button, [role="button"], a, [aria-label], [data-dismiss], [data-close]');
      const labels = ['close', 'dismiss', 'cancel', 'ok', '關閉', '取消', '確認', '繼續', '×', '✕'];
      for (const el of candidates) {
        if (!visible(el)) continue;
        const aria = (el.getAttribute('aria-label') || '').toLowerCase();
        const txt  = (el.textContent || '').trim().toLowerCase();
        const data = (el.getAttribute('data-dismiss') || el.getAttribute('data-close') || '').toLowerCase();
        for (const lab of labels) {
          if (aria.includes(lab) || txt === lab || txt.includes(lab) || data.includes(lab)) {
            return { el, label: lab };
          }
        }
      }
      return null;
    }
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], dialog, [aria-modal="true"]')).filter(visible);
    if (dialogs.length === 0) {
      const vw = window.innerWidth || 0;
      const vh = window.innerHeight || 0;
      const layoutW = (document.documentElement && document.documentElement.clientWidth) || vw;
      const layoutH = (document.documentElement && document.documentElement.clientHeight) || vh;
      const slackX = Math.max(8, vw - layoutW);
      const slackY = Math.max(8, vh - layoutH);
      const overlays = [];
      for (const el of document.querySelectorAll('body *')) {
        if (!el || el.id === '__cdp_annot_overlay__') continue;
        const cs = getComputedStyle(el);
        if ((cs.position !== 'fixed' && cs.position !== 'sticky') || !visible(el) || cs.pointerEvents === 'none') continue;
        const r = el.getBoundingClientRect();
        const coversViewport = (r.left <= slackX && r.top <= slackY && r.right >= vw - slackX && r.bottom >= vh - slackY)
          || (r.left <= 8 && r.top <= 8 && r.right >= layoutW - 8 && r.bottom >= layoutH - 8);
        if (!coversViewport) continue;
        overlays.push(el.id ? ('#' + (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(el.id) : el.id)) : (el.tagName || 'overlay'));
        if (overlays.length >= 5) break;
      }
      if (overlays.length) return JSON.stringify({ ok: false, reason: 'overlay-not-dialog', overlays });
      return JSON.stringify({ ok: false, reason: 'no-dialog' });
    }
    // Prefer an explicit close button inside a visible dialog.
    for (const d of dialogs) {
      const hit = findCloseButton(d);
      if (hit) {
        hit.el.click();
        return JSON.stringify({ ok: true, action: 'click', label: hit.label, sel: d.tagName.toLowerCase() });
      }
    }
    // Fall through: signal that the caller should send Escape next.
    return JSON.stringify({ ok: false, reason: 'no-close-button', dialogs: dialogs.length });
  })()`;
}

async function dismissModalStr(cdp, sid) {
  const raw = await evalStr(cdp, sid, dismissModalScript());
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { parsed = { ok: false, reason: 'parse-error' }; }
  if (parsed.ok) {
    return `Dismissed modal via close button "${parsed.label}" (${parsed.sel})`;
  }
  if (parsed.reason === 'no-dialog') {
    return 'No visible modal/dialog detected.';
  }
  if (parsed.reason === 'overlay-not-dialog') {
    const names = (parsed.overlays || []).filter(Boolean).join(', ') || 'overlay';
    return `dismiss-modal only handles dialog/modal patterns; blocking overlay still visible (${names}).`;
  }
  // Fallback: send Escape (does not fire window-level shortcuts the way Space does).
  await pressStr(cdp, sid, 'escape');
  return `No close button found in ${parsed.dialogs || 0} dialog(s); sent Escape as fallback.`;
}

// ---------------------------------------------------------------------------
// Per-tab daemon
// ---------------------------------------------------------------------------

const DAEMON_HANDLER_BUILDERS = Object.freeze({
  perceive: context => createPerceiveCommandHandler(context),
  click: context => createClickCommandHandler(context),
  report: context => createReportCommandHandler(context.session, context),
  evalraw: context => createEvalrawCommandHandler(context),
  html: capabilities => createDaemonReadHandlers(capabilities).html,
  text: capabilities => createDaemonReadHandlers(capabilities).text,
  table: capabilities => createDaemonReadHandlers(capabilities).table,
  net: capabilities => createDaemonReadHandlers(capabilities).net,
  status: capabilities => createDaemonReadHandlers(capabilities).status,
  summary: capabilities => createDaemonReadHandlers(capabilities).summary,
  snap: capabilities => createDaemonReadHandlers(capabilities).snap,
  controls: capabilities => createDaemonReadHandlers(capabilities).controls,
  frame: capabilities => createDaemonReadHandlers(capabilities).frame,
  overlay: capabilities => createDaemonReadHandlers(capabilities).overlay,
  styles: capabilities => createDaemonReadHandlers(capabilities).styles,
  components: capabilities => createDaemonReadHandlers(capabilities).components,
  'record-actions': capabilities => createDaemonReadHandlers(capabilities)['record-actions'],
  'export-playwright': capabilities => createDaemonReadHandlers(capabilities)['export-playwright'],
  wait: capabilities => createDaemonReadHandlers(capabilities).wait,
  waitfor: capabilities => createDaemonReadHandlers(capabilities).waitfor,
  cascade: capabilities => createDaemonReadHandlers(capabilities).cascade,
  checkpoint: capabilities => createDaemonReadHandlers(capabilities).checkpoint,
  cookies: capabilities => createDaemonReadHandlers(capabilities).cookies,
  fill: capabilities => createDaemonActionHandlers(capabilities).fill,
  hover: capabilities => createDaemonActionHandlers(capabilities).hover,
  press: capabilities => createDaemonActionHandlers(capabilities).press,
  scroll: capabilities => createDaemonActionHandlers(capabilities).scroll,
  select: capabilities => createDaemonActionHandlers(capabilities).select,
  clickxy: capabilities => createDaemonActionHandlers(capabilities).clickxy,
  'dismiss-modal': capabilities => createDaemonActionHandlers(capabilities)['dismiss-modal'],
  jsclick: capabilities => createDaemonActionHandlers(capabilities).jsclick,
  type: capabilities => createDaemonActionHandlers(capabilities).type,
  'verify-click': capabilities => createDaemonActionHandlers(capabilities)['verify-click'],
  back: capabilities => createDaemonActionHandlers(capabilities).back,
  forward: capabilities => createDaemonActionHandlers(capabilities).forward,
  nav: capabilities => createDaemonActionHandlers(capabilities).nav,
  reload: capabilities => createDaemonActionHandlers(capabilities).reload,
  clock: capabilities => createDaemonActionHandlers(capabilities).clock,
  mock: capabilities => createDaemonActionHandlers(capabilities).mock,
  throttle: capabilities => createDaemonActionHandlers(capabilities).throttle,
  emulate: capabilities => createDaemonActionHandlers(capabilities).emulate,
  viewport: capabilities => createDaemonActionHandlers(capabilities).viewport,
  cookiedel: capabilities => createDaemonActionHandlers(capabilities).cookiedel,
  cookieset: capabilities => createDaemonActionHandlers(capabilities).cookieset,
  dialog: capabilities => createDaemonActionHandlers(capabilities).dialog,
  keepalive: capabilities => createDaemonActionHandlers(capabilities).keepalive,
  netlog: capabilities => createDaemonActionHandlers(capabilities).netlog,
  eval: capabilities => async ({ args }) => capabilities.eval(args),
  eval64: capabilities => async ({ args }) => capabilities.eval64(args),
  call: capabilities => async ({ args }) => capabilities.call(args),
  console: capabilities => createDaemonReadHandlers(capabilities).console,
  record: capabilities => createDaemonReadHandlers(capabilities).record,
  batch: capabilities => async ({ args }) => commandResult(await capabilities.batch(args), null),
  flow: capabilities => async ({ args }) => commandResult(await capabilities.flow(args), null),
  repeat: capabilities => async ({ args }) => commandResult(await capabilities.repeat(args), null),
  replay: capabilities => async ({ args }) => commandResult(
    await capabilities.replay(args),
    { kind: 'action-receipt' },
  ),
  inject: capabilities => createDaemonActionHandlers(capabilities).inject,
  restore: capabilities => createDaemonActionHandlers(capabilities).restore,
  upload: capabilities => createDaemonActionHandlers(capabilities).upload,
  shot: capabilities => createDaemonReadHandlers(capabilities).shot,
  'diff-shot': capabilities => createDaemonReadHandlers(capabilities)['diff-shot'],
  elshot: capabilities => createDaemonReadHandlers(capabilities).elshot,
  fullshot: capabilities => createDaemonReadHandlers(capabilities).fullshot,
  scanshot: capabilities => createDaemonReadHandlers(capabilities).scanshot,
  qa: capabilities => createDaemonActionHandlers(capabilities).qa,
  'responsive-audit': capabilities => createDaemonActionHandlers(capabilities)['responsive-audit'],
  closetab: capabilities => createDaemonActionHandlers(capabilities).closetab,
  loadall: capabilities => createDaemonActionHandlers(capabilities).loadall,
});
const DAEMON_APPLICATION_COMMANDS = Object.freeze(Object.keys(DAEMON_HANDLER_BUILDERS).sort());

function preflightDaemonApplication(input = {}) {
  const options = snapshotApplicationDataObject(input, 'application preflight options');
  const allowedOptions = new Set(['commands', 'handlerBuilders']);
  for (const key of Object.keys(options)) {
    if (!allowedOptions.has(key)) throw new Error(`application preflight options.${key}: is not allowed`);
  }
  const commands = Object.hasOwn(options, 'commands') ? options.commands : COMMANDS;
  const handlerBuilders = Object.hasOwn(options, 'handlerBuilders')
    ? options.handlerBuilders
    : DAEMON_HANDLER_BUILDERS;
  const registry = createApplicationCommandRegistry(commands);
  const builders = snapshotApplicationDataObject(handlerBuilders, 'handlerBuilders');
  const builderNames = Object.keys(builders).sort();
  const expectedNames = registry.list()
    .filter(command => command.needsTarget)
    .map(command => command.name)
    .sort();
  if (!sameStringArray(builderNames, expectedNames)) {
    throw new Error(`handlerBuilders: must exactly own all ${expectedNames.length} target application commands`);
  }
  for (const name of expectedNames) {
    if (typeof builders[name] !== 'function') throw new Error(`handlerBuilders.${name}: handler factory is required`);
    if (!registry.resolve(name)) throw new Error(`handlerBuilders.${name}: command is missing from registry`);
  }
  if (registry.list().length !== COMMAND_SURFACE.commands.length) {
    throw new Error('commands: application registry must own the complete command surface');
  }
  const routeOwners = Object.freeze(Object.fromEntries(
    registry.list().map(command => [command.name, command.needsTarget ? 'application' : 'adapter']),
  ));
  return Object.freeze({
    registry,
    routeOwners,
    handlerBuilders: Object.freeze(builders),
  });
}

async function enableDaemonDomains(cdp, sessionId) {
  try { await cdpDomains(cdp).Runtime.enable( {}, sessionId); } catch {}
  try { await cdpDomains(cdp).Page.enable( {}, sessionId); } catch {}
  try { await cdpDomains(cdp).DOM.enable( {}, sessionId); } catch {}
  try { await cdpDomains(cdp).CSS.enable( {}, sessionId); } catch {}
  try { await cdpDomains(cdp).Network.enable( {}, sessionId); } catch {}
}

async function runDaemon(targetId, applicationPreflight = preflightDaemonApplication()) {
  resetScreenshotTier();
  const sp = sockPath(targetId);
  const daemonMetadata = {
    ...collectDaemonMetadata(),
    requestedTargetId: targetId,
    boundTargetId: targetId,
  };

  const cdp = new CDP();
  try {
    await cdp.connect(await getWsUrl());
    try { await rememberLiveCdpEndpointFromSession(cdp); } catch {}
  } catch (e) {
    process.stderr.write(`Daemon: cannot connect to Chrome: ${e.message}\n`);
    process.exit(1);
  }

  let sessionId;
  try {
    // Wake up the tab first (avoids timeouts on suspended/inactive background tabs)
    await cdpDomains(cdp).Target.activateTarget( { targetId }).catch(() => {});
    const res = await cdpDomains(cdp).Target.attachToTarget( { targetId, flatten: true });
    sessionId = res.sessionId;
  } catch (e) {
    process.stderr.write(`Daemon: attach failed: ${e.message}\n`);
    cdp.close();
    process.exit(1);
  }

  const session = createSessionState({ targetId, sessionId });
  const tableArtifactStore = createTableArtifactStore({
    runtimeDir: RUNTIME_DIR,
    targetId,
    sessionId: randomBytes(16).toString('hex'),
    platform: process.platform,
  });
  const tableCollectorSession = { collector: null };
  initializeSessionLog(session);
  ensureSessionScreenshotDir(session);

  // --- Background observation ---
  const consoleBuf = new RingBuffer(200);
  const exceptionBuf = new RingBuffer(50);
  const navBuf = new RingBuffer(10);
  const netReqBuf = new RingBuffer(100); // network request/response pairs
  const pendingReqs = session.pendingRequests; // requestId → {method, url, ts}
  const networkStatusByRequest = new Map(); // requestId → statusCode from ExtraInfo that arrived first
  let lastReadSeq = { console: 0, exception: 0 };

  // --- Ref system & perceive diff state ---
  const refMap = session.refs.map;              // ref number → backendDOMNodeId
  const lastPerceiveStore = session.lastPerceive; // stores last perceive output for diff
  const refState = session.refs;                // ref lifecycle for stale @ref errors
  session.buffers = {
    console: consoleBuf,
    exception: exceptionBuf,
    navigation: navBuf,
    network: netReqBuf,
  };

  // Enable domains for background collection and ref resolution
  await enableDaemonDomains(cdp, sessionId);

  cdp.onEvent('Runtime.consoleAPICalled', (params) => {
    const level = params.type || 'log';
    const text = (params.args || []).map(a => a.value ?? a.description ?? JSON.stringify(a)).join(' ');
    const stack = params.stackTrace?.callFrames?.[0];
    const file = stack?.url?.split('/').pop() || '';
    const loc = file && stack.lineNumber > 0 ? `${file}:${stack.lineNumber}` : '';
    consoleBuf.push({ level, text, loc, ts: Date.now() });
  });

  cdp.onEvent('Runtime.exceptionThrown', (params) => {
    const detail = params.exceptionDetails;
    // exception.description has full message (e.g. "Error: foo"); text is just "Uncaught"
    const msg = detail?.exception?.description || detail?.text || 'Unknown error';
    const stack = detail?.stackTrace?.callFrames?.[0];
    const file = stack?.url?.split('/').pop() || '';
    const loc = file && stack.lineNumber > 0 ? `${file}:${stack.lineNumber}` : '';
    exceptionBuf.push({ msg, loc, ts: Date.now() });
  });

  cdp.onEvent('Page.frameNavigated', (params) => {
    if (!params.frame.parentId) { // main frame only
      navBuf.push({ url: params.frame.url, ts: Date.now() });
      // Top-level navigation (or Vite HMR full reload) invalidates all @refs.
      session.pageGeneration += 1;
      invalidateSessionRefs(session, 'navigation');
    }
  });

  // --- Network request/response tracking ---
  function appendNetworkResponse(requestId, req, { status = null, type = req.type, size = 0, failed = false, errorText = null } = {}) {
    pendingReqs.delete(requestId);
    netReqBuf.push({
      method: req.method,
      url: req.url,
      status,
      type,
      duration: Date.now() - req.ts,
      size,
      ...(failed ? { failed: true } : {}),
      ...(errorText ? { errorText } : {}),
      ts: req.ts,
    });
  }

  cdp.onEvent('Network.requestWillBeSent', (params) => {
    // Track action-relevant traffic while skipping static asset noise.
    if (shouldTrackActionNetworkRequest(params.type)) {
      const req = {
        method: params.request.method,
        url: params.request.url.substring(0, 200),
        type: params.type,
        ts: Date.now(),
      };
      if (networkStatusByRequest.has(params.requestId)) {
        const status = networkStatusByRequest.get(params.requestId);
        networkStatusByRequest.delete(params.requestId);
        appendNetworkResponse(params.requestId, req, { status });
      } else {
        pendingReqs.set(params.requestId, req);
      }
    }
  });
  cdp.onEvent('Network.responseReceived', (params) => {
    const req = pendingReqs.get(params.requestId);
    if (!req) return;
    appendNetworkResponse(params.requestId, req, {
      status: params.response.status,
      type: params.type,
      size: params.response.encodedDataLength || 0,
    });
  });

  cdp.onEvent('Network.responseReceivedExtraInfo', (params) => {
    const req = pendingReqs.get(params.requestId);
    if (!Number.isFinite(Number(params.statusCode))) return;
    const status = Number(params.statusCode);
    if (!req) {
      networkStatusByRequest.set(params.requestId, status);
      return;
    }
    appendNetworkResponse(params.requestId, req, { status });
  });

  cdp.onEvent('Network.loadingFinished', (params) => {
    const req = pendingReqs.get(params.requestId);
    if (!req) return;
    appendNetworkResponse(params.requestId, req, {
      status: null,
      size: params.encodedDataLength || 0,
    });
  });

  cdp.onEvent('Network.loadingFailed', (params) => {
    const req = pendingReqs.get(params.requestId);
    if (!req) return;
    appendNetworkResponse(params.requestId, req, {
      status: null,
      type: params.type,
      failed: true,
      errorText: params.errorText || 'loadingFailed',
    });
  });

  cdp.onEvent('Fetch.requestPaused', (params) => {
    handleMockRequestPaused(cdp, sessionId, session, params).catch(() => {
      cdpDomains(cdp).Fetch.continueRequest( { requestId: params.requestId }, sessionId).catch(() => {});
    });
  });

  // --- Dialog handling (alert/confirm/prompt/beforeunload) ---
  const dialogBuf = new RingBuffer(20);
  session.buffers.dialog = dialogBuf;
  const dialogAutoAcceptRef = { value: true }; // auto-dismiss by default to prevent page lockups
  const jsDialogs = createJavaScriptDialogSession();
  cdp.onEvent('Page.javascriptDialogOpening', (params, msg) => {
    jsDialogs.track(handleOpeningJavaScriptDialog(cdp, sessionId, params, msg, {
      accept: dialogAutoAcceptRef.value,
      dialogBuf,
    }));
  });

  // Shutdown helpers
  let server = null;
  const requestConnections = new Set();
  const shutdown = createDaemonShutdown({
    requestConnections,
    getServer: () => server,
    socketPath: sp,
    cleanupSession: () => tableArtifactStore.cleanupSession(),
    closeCdp: () => cdp.close(),
  });

  // Exit if target goes away or Chrome disconnects
  cdp.onEvent('Target.targetDestroyed', (params) => {
    if (params.targetId === targetId) shutdown();
  });
  cdp.onEvent('Target.detachedFromTarget', (params) => {
    if (params.sessionId === sessionId) shutdown();
  });
  cdp.onClose(() => shutdown());
  process.on('SIGTERM', () => shutdown());
  process.on('SIGINT', () => shutdown());

  // Idle timer
  let keepaliveUntil = 0;
  let idleTimer = setTimeout(shutdown, IDLE_TIMEOUT);
  function scheduleIdle() {
    clearTimeout(idleTimer);
    const delay = Math.max(IDLE_TIMEOUT, keepaliveUntil - Date.now(), 1000);
    idleTimer = setTimeout(shutdown, delay);
  }
  function resetIdle() {
    scheduleIdle();
  }
  function extendKeepalive(ms) {
    keepaliveUntil = Math.max(keepaliveUntil, Date.now() + ms);
    scheduleIdle();
    return `Daemon keepalive extended for ${ms}ms (until ${new Date(keepaliveUntil).toISOString()})`;
  }

  // Action feedback: wait for DOM to settle, then return structured evidence.
  const BATCH_BLOCKED = new Set(['batch', 'stop', 'repeat', 'flow']);
  async function observeActionDiffForTarget(target = {}, baselineOutput = null, baselineOpts = null) {
    const targetFrameRef = frameRefFromActionTarget(target);
    await waitForSettle(cdp, sessionId);
    if (!baselineOutput) {
      const after = await perceiveStr(
        cdp,
        sessionId,
        consoleBuf,
        exceptionBuf,
        refMap,
        lastPerceiveStore,
        actionObservationPerceiveOpts(targetId, {
          ...(targetFrameRef ? { frameRef: targetFrameRef } : {}),
        }),
        refState,
      );
      if (isPdfViewerPerceiveOutput(after)) return pdfViewerSettleDiffText();
      return noBaselineActionDiffText();
    }
    const snapshot = actionSettleObserveOpts(targetId, target, baselineOutput, baselineOpts);
    return perceiveStr(
      cdp,
      sessionId,
      consoleBuf,
      exceptionBuf,
      refMap,
      lastPerceiveStore,
      snapshot,
      refState
    );
  }
  async function observeFullPerceive() {
    await waitForSettle(cdp, sessionId);
    return perceiveStr(
      cdp,
      sessionId,
      consoleBuf,
      exceptionBuf,
      refMap,
      lastPerceiveStore,
      actionObservationPerceiveOpts(targetId),
      refState,
    );
  }
  async function actionFeedback(action, actionDispatch, target = {}, feedbackPolicy = 'settle-diff', observe = null, format = 'text', captureActionResult = null) {
    const dispatch = typeof actionDispatch === 'function' ? actionDispatch : async () => actionDispatch;
    const actionTarget = target && typeof target === 'object'
      ? { ...target, targetId }
      : { input: String(target || ''), label: String(target || ''), targetId };
    const baselineFromTarget = baselineOutputForActionTarget(refState, lastPerceiveStore.output, actionTarget);
    let settleBaseline = actionSettleBaseline(
      baselineFromTarget,
      lastPerceiveStore.snapshotOpts || null,
      actionTarget,
    );
    if (isPdfViewerPerceiveOutput(baselineFromTarget)) {
      actionTarget.expectedOutcome = actionTarget.expectedOutcome || 'pdf-viewer-no-change';
    }
    tagScrollLeftoverSettle(
      action,
      actionTarget,
      baselineFromTarget,
      lastPerceiveStore.snapshotOpts,
    );
    if (
      !settleBaseline.output
      && shouldCaptureTopLevelActionSettle(
        lastPerceiveStore.snapshotOpts,
        baselineFromTarget,
        actionTarget,
      )
    ) {
      const topLevelOpts = actionObservationPerceiveOpts(targetId, {
        ...(settleBaseline.opts || {}),
        frameRef: null,
      });
      const before = await perceiveStr(
        cdp,
        sessionId,
        consoleBuf,
        exceptionBuf,
        refMap,
        lastPerceiveStore,
        topLevelOpts,
        refState,
      );
      settleBaseline = {
        output: before,
        opts: perceiveSnapshotOpts(topLevelOpts),
      };
    }
    const baselineOutput = settleBaseline.output;
    const baselineOpts = settleBaseline.opts;
    const observationBaseline = createActionObservationBaseline({ consoleBuf, exceptionBuf, netReqBuf });
    const actionStartedAt = Date.now();
    const observeAfterAction = observe || (() => observeActionDiffForTarget(actionTarget, baselineOutput, baselineOpts));
    let postActionPageHealth = null;
    const watchNavigation = action === 'click' || action === 'jsclick' || action === 'clickxy';
    let beforePage = actionTarget.page || { title: '', url: '', contentType: '' };
    const pageInfoPromise = pageInfoModel(cdp, sessionId, { targetPrefix: targetPrefixForDisplay(targetId) })
      .then((page) => {
        beforePage = {
          title: page?.title || beforePage.title || '',
          url: page?.url || beforePage.url || '',
          contentType: page?.contentType || beforePage.contentType || '',
        };
        actionTarget.page = beforePage;
        return beforePage;
      })
      .catch(() => actionTarget.page || beforePage);
    const wrappedDispatch = async () => {
      try {
        const snapshotControls = shouldSnapshotFormControlState(action, actionTarget);
        const beforeControl = snapshotControls
          ? await snapshotFormControlState(cdp, sessionId, actionTarget.input, refMap, refState)
          : null;
        const text = await dispatch();
        if ((action === 'click' || action === 'jsclick' || action === 'clickxy') && jsDialogs.hasPending()) {
          await jsDialogs.waitForPending(1500);
        }
        if (shouldSkipActionPageEvaluate(jsDialogs)) {
          actionTarget.dialogBlocked = true;
          actionTarget.dispatchText = String(text || '');
          return text;
        }
        if (snapshotControls) {
          const afterControl = await snapshotFormControlState(cdp, sessionId, actionTarget.input, refMap, refState);
          if (formControlStateChanged(beforeControl, afterControl)) {
            actionTarget.controlStateChanged = true;
            actionTarget.controlStateDiff = formatFormControlStateDiff(beforeControl, afterControl);
          }
        }
        actionTarget.dispatchText = String(text || '');
        if (looksLikeClipboardControl(text) || isExpectedClipboardNoChange(actionTarget, text)) {
          actionTarget.expectedOutcome = 'clipboard-no-change';
        }
        if (action === 'dismiss-modal' && /no visible modal\/dialog detected/i.test(String(text || ''))) {
          actionTarget.expectedOutcome = 'no-modal';
        }
        if (action === 'press' || actionTarget.resolvedBy === 'key') {
          actionTarget.expectedOutcome = actionTarget.expectedOutcome || 'press-no-change';
        }
        if (watchNavigation) {
          await pageInfoPromise;
          const afterUrl = await evalPageHref(cdp, sessionId);
          const beforeUrl = beforePage.url || '';
          if (shouldSkipActionDomSettle(beforeUrl, afterUrl)) {
            actionTarget.navigated = true;
            actionTarget.pageHrefBefore = beforeUrl;
            actionTarget.pageHrefAfter = afterUrl;
          }
        }
        return text;
      } catch (error) {
        await jsDialogs.waitForPending(1500).catch(() => {});
        if (shouldSkipActionPageEvaluate(jsDialogs)) {
          actionTarget.dialogBlocked = true;
        }
        await pageInfoPromise;
        throw error;
      }
    };
    const observeThenFlush = async () => {
      if (actionTarget.expectedOutcome === 'clipboard-no-change') {
        appendPendingActionNetworkEntries(pendingReqs, netReqBuf, actionStartedAt);
        return 'No changes detected (clipboard action).';
      }
      if (actionTarget.expectedOutcome === 'no-modal') {
        appendPendingActionNetworkEntries(pendingReqs, netReqBuf, actionStartedAt);
        return 'No changes detected (no modal).';
      }
      if (actionTarget.navigated) {
        appendPendingActionNetworkEntries(pendingReqs, netReqBuf, actionStartedAt);
        await waitForActionNetworkQuiet(pendingReqs, { quietMs: 50, timeoutMs: 250 });
        appendPendingActionNetworkEntries(pendingReqs, netReqBuf, actionStartedAt);
        postActionPageHealth = await collectPageHealth(cdp, sessionId, { changed: true }).catch(() => null);
        return formatActionNavigationDiff(actionTarget.pageHrefBefore, actionTarget.pageHrefAfter);
      }
      let text = await observeAfterActionGuardingDialogs(jsDialogs, observeAfterAction);
      if (actionTarget.dialogBlocked || shouldSkipActionPageEvaluate(jsDialogs)) {
        appendPendingActionNetworkEntries(pendingReqs, netReqBuf, actionStartedAt);
        return text;
      }
      if (actionTarget.controlStateChanged) {
        const note = `Control state changed: ${actionTarget.controlStateDiff}`;
        text = actionDomDiffShowsChange(text) ? `${note}\n${text}` : note;
      }
      await waitForActionNetworkQuiet(pendingReqs);
      appendPendingActionNetworkEntries(pendingReqs, netReqBuf, actionStartedAt);
      postActionPageHealth = await collectPageHealth(cdp, sessionId, {
        changed: actionDomDiffShowsChange(text) || Boolean(actionTarget.controlStateChanged),
      }).catch(() => null);
      return text;
    };
    session.lastAction = { action, target: actionTarget, feedbackPolicy, ts: actionStartedAt, baselineOutput, baselineOpts };
    return runActionWithFeedback({
      action,
      target: actionTarget,
      dispatch: wrappedDispatch,
      feedbackPolicy,
      observe: observeThenFlush,
      enrichActionResult: async (actionResult) => {
        await pageInfoPromise;
        applyActionObservationDelta(actionResult, buildActionObservationDelta(
          { consoleBuf, exceptionBuf, netReqBuf },
          observationBaseline
        ));
        if (postActionPageHealth) actionResult.effects.pageHealth = postActionPageHealth;
        else if (actionTarget.page && (actionTarget.page.title || actionTarget.page.url)) {
          actionResult.effects.pageHealth = actionResult.effects.pageHealth || {
            status: 'populated',
            isBlank: false,
            evidence: {
              url: actionTarget.page.url || '',
              title: actionTarget.page.title || '',
            },
          };
        }
        if (actionTarget.navigated) {
          actionResult.effects.navigation = {
            from: actionTarget.pageHrefBefore,
            to: actionTarget.pageHrefAfter,
            changed: true,
          };
        }
        const livePage = livePageIdentity({
          page: actionTarget.page || {},
          pageHealth: actionResult.effects.pageHealth,
          navigation: actionResult.effects.navigation,
        });
        if (livePage.url || livePage.title) {
          const contentType = actionResult.effects.navigation?.changed
            ? ''
            : actionTarget.page?.contentType;
          actionResult.effects.page = contentType ? { ...livePage, contentType } : livePage;
        } else if (actionTarget.page) actionResult.effects.page = actionTarget.page;
        return actionResult;
      },
      onActionResult: (actionResult) => {
        appendSessionActionLog(session, actionResult, { ts: session.lastAction.ts });
        captureActionResult?.(actionResult);
      },
      format,
    });
  }

  const applicationRegistry = applicationPreflight.registry;
  const readCapabilities = {
    cascade: args => {
      const fopts = parseFormatArgs(args, ['text', 'json']);
      return cascadeStr(cdp, sessionId, fopts.args[0], fopts.args[1], refMap, refState, {
        format: fopts.format,
        targetPrefix: targetPrefixForDisplay(targetId),
      });
    },
    checkpoint: async args => {
      const fopts = parseFormatArgs(args, ['text', 'json']);
      const copts = parseCheckpointArgs(fopts.args);
      if (copts.args.length) throw new Error(`checkpoint: unknown argument ${copts.args[0]}`);
      const output = await checkpointStr(cdp, sessionId, {
        format: fopts.format,
        unsafeFullCapture: copts.unsafeFullCapture,
      });
      appendSessionEventLog(session, {
        kind: 'checkpoint',
        url: output.includes('URL: ') ? output.split('URL: ')[1]?.split('\n')[0] : undefined,
      });
      return output;
    },
    components: args => componentsStr(cdp, sessionId, args, refMap, refState),
    console: async args => {
      const opts = parseConsoleArgs(args);
      if (opts.mode === 'clear') {
        const model = clearConsoleBaseline(consoleBuf, exceptionBuf, lastReadSeq);
        return opts.format === 'json' ? formatJson(model) : model.message;
      }
      if (opts.format === 'json') {
        const output = formatJson(buildConsoleModel(consoleBuf, exceptionBuf, lastReadSeq, opts.mode));
        if (opts.mode === 'new') {
          lastReadSeq.console = consoleBuf.latest();
          lastReadSeq.exception = exceptionBuf.latest();
        }
        return output;
      }
      return consoleStr(consoleBuf, exceptionBuf, lastReadSeq, opts.mode);
    },
    controls: async args => {
      const fopts = parseFormatArgs(args, ['text', 'json']);
      const copts = parseControlsArgs(fopts.args);
      return controlsStr(cdp, sessionId, { ...copts, format: fopts.format });
    },
    cookies: () => cookiesStr(cdp, sessionId),
    'diff-shot': args => diffShotStr(cdp, sessionId, session, parseDiffShotArgs(args)),
    elshot: args => elshotStr(cdp, sessionId, args[0], targetId, refMap, refState),
    'export-playwright': args => formatExportPlaywright(session, parseExportPlaywrightArgs(args)),
    frame: async args => {
      const fopts = parseFormatArgs(args, ['text', 'json']);
      return framesStr(cdp, sessionId, { format: fopts.format });
    },
    fullshot: args => fullshotStr(cdp, sessionId, args[0], targetId),
    html: args => htmlStr(cdp, sessionId, args, { targetPrefix: targetPrefixForDisplay(targetId) }),
    text: args => textStr(cdp, sessionId, args, { targetPrefix: targetPrefixForDisplay(targetId) }),
    table: async (request, execution) => request.mode === 'continue'
      ? JSON.stringify(await tableArtifactStore.readContinuation(request.continuation), null, 2)
      : request.mode === 'collect'
        ? tableCollectionStr(cdp, sessionId, request, execution, { store: tableArtifactStore, session: tableCollectorSession })
        : tableObservationStr(cdp, sessionId, request),
    net: () => netStr(cdp, sessionId),
    overlay: args => overlayStr(cdp, sessionId, targetId, args, refMap, refState),
    record: args => recordStr(cdp, sessionId, args, refMap),
    'record-actions': args => {
      const fopts = parseFormatArgs(args, ['text', 'json']);
      return formatRecordActions(session, { format: fopts.format });
    },
    scanshot: () => scanshotStr(cdp, sessionId, targetId),
    shot: async args => {
      if (args[0] === '--annotate' || args[0] === '-a') {
        const output = await annotshotStr(cdp, sessionId, targetId, refMap);
        appendSessionScreenshot(session, {
          kind: 'annotshot',
          path: output.split('\n')[0],
          note: 'annotated refs',
        });
        return output;
      }
      const sopts = parseShotArgs(args);
      const filePath = sopts.filePath || nextSessionScreenshotPath(session, 'shot');
      if (!sopts.filePath) ensureSessionScreenshotDir(session);
      const output = await shotStr(cdp, sessionId, filePath, targetId, { quiet: sopts.quiet, verbose: sopts.verbose });
      appendSessionScreenshot(session, {
        kind: 'shot',
        path: output.split('\n')[0],
        note: sopts.filePath ? 'custom path' : 'session screenshot',
      });
      return output;
    },
    snap: args => snapshotStr(cdp, sessionId, args[0] !== '--full', { targetPrefix: targetPrefixForDisplay(targetId) }),
    status: async args => {
      const fopts = parseFormatArgs(args, ['text', 'json']);
      if (fopts.format === 'json') {
        const runtime = fopts.args.includes('--runtime')
          ? await runtimeMetricsStr(cdp, sessionId).catch(e => ({ unavailable: e.message }))
          : null;
        const page = await pageInfoModel(cdp, sessionId, { targetPrefix: targetPrefixForDisplay(targetId) });
        const output = formatJson(buildStatusModel({
          targetId,
          page: { title: page.title, url: page.url },
          consoleBuf,
          exceptionBuf,
          navBuf,
          lastReadSeq,
          runtime,
          diagnostic: page.diagnostic || null,
        }));
        lastReadSeq.console = consoleBuf.latest();
        lastReadSeq.exception = exceptionBuf.latest();
        return output;
      }
      return statusStr(cdp, sessionId, consoleBuf, exceptionBuf, navBuf, lastReadSeq, {
        runtime: fopts.args.includes('--runtime'),
        targetPrefix: targetPrefixForDisplay(targetId),
      });
    },
    styles: args => stylesStr(cdp, sessionId, args, { targetPrefix: targetPrefixForDisplay(targetId) }),
    summary: async args => {
      const fopts = parseFormatArgs(args, ['text', 'json']);
      const extra = { targetPrefix: targetPrefixForDisplay(targetId) };
      return fopts.format === 'json'
        ? formatJson(await summaryModel(cdp, sessionId, consoleBuf, exceptionBuf, extra))
        : summaryStr(cdp, sessionId, consoleBuf, exceptionBuf, extra);
    },
    wait: args => waitStr(args[0]),
    waitfor: args => waitForStr(cdp, sessionId, args, refMap, refState),
  };
  Object.freeze(readCapabilities);
  const recordActionsBuilder = applicationPreflight.handlerBuilders['record-actions'];
  const exportPlaywrightBuilder = applicationPreflight.handlerBuilders['export-playwright'];
  const dismissModalBuilder = applicationPreflight.handlerBuilders['dismiss-modal'];
  const verifyClickBuilder = applicationPreflight.handlerBuilders['verify-click'];
  const diffShotBuilder = applicationPreflight.handlerBuilders['diff-shot'];
  const responsiveAuditBuilder = applicationPreflight.handlerBuilders['responsive-audit'];
  const scriptCapabilities = {
    eval: async args => {
      const eopts = parseEvalArgs(args);
      let value;
      if (eopts.fireAndForget) {
        value = await evalFireAndForgetStr(cdp, sessionId, eopts.expression, true);
        value += `\n${extendKeepalive(FIRE_AND_FORGET_KEEPALIVE)} (fire-and-forget default)`;
      } else {
        value = await evalStr(cdp, sessionId, eopts.expression, true, { raw: eopts.raw });
      }
      return commandResult(value, null);
    },
    eval64: async args => commandResult(
      await evalStr(cdp, sessionId, evalBase64Decode(args[0]), true),
      null,
    ),
    call: async args => commandResult(await callStr(cdp, sessionId, args.join(' ')), null),
  };
  const actionCapabilities = {
    back: async args => {
      const fopts = parseCompactFormatArgs(args, ['text', 'json']);
      const value = await actionFeedback('back', () => historyNavStr(cdp, sessionId, -1), { input: 'back', resolvedBy: 'history', label: 'back', commandArgs: [] }, 'full-perceive', observeFullPerceive, fopts);
      return commandResult(value, { kind: 'action-receipt' });
    },
    clickxy: async args => {
      const fopts = parseCompactFormatArgs(args, ['text', 'json']);
      const value = await actionFeedback('clickxy', () => clickXyStr(cdp, sessionId, fopts.args[0], fopts.args[1]), { input: `${fopts.args[0]},${fopts.args[1]}`, resolvedBy: 'coordinates', label: `${fopts.args[0]},${fopts.args[1]}`, commandArgs: [fopts.args[0], fopts.args[1]] }, 'settle-diff', null, fopts);
      return commandResult(value, { kind: 'action-receipt' });
    },
    clock: async args => commandResult(
      await clockStr(cdp, sessionId, session, args),
      { kind: 'action-receipt' },
    ),
    closetab: async () => commandResult(
      await closetabStr(cdp, targetId),
      { kind: 'action-receipt' },
    ),
    cookiedel: async args => commandResult(
      await cookieDelStr(cdp, sessionId, args[0]),
      { kind: 'action-receipt' },
    ),
    cookieset: async args => commandResult(
      await cookieSetStr(cdp, sessionId, args[0]),
      { kind: 'action-receipt' },
    ),
    dialog: async args => commandResult(
      dialogStr(dialogBuf, dialogAutoAcceptRef, args[0]),
      null,
    ),
    'dismiss-modal': async args => {
      const fopts = parseCompactFormatArgs(args, ['text', 'json']);
      const value = await actionFeedback('dismiss-modal', () => dismissModalStr(cdp, sessionId), { input: 'modal', resolvedBy: 'dialog', label: 'modal', commandArgs: [] }, 'settle-diff', null, fopts);
      return commandResult(value, { kind: 'action-receipt' });
    },
    emulate: async args => commandResult(
      await emulateStr(cdp, sessionId, session, args, { targetPrefix: targetPrefixForDisplay(targetId) }),
      { kind: 'action-receipt' },
    ),
    fill: async args => {
      const parsed = parseFillArgs(args);
      const value = parsed.react
        ? await actionFeedback('fill', () => fillStr(cdp, sessionId, parsed.selector, parsed.text, refMap, refState, { react: true }), { input: parsed.selector, resolvedBy: 'selector-or-ref', label: parsed.selector || '', commandArgs: ['--react', parsed.selector, parsed.text] }, 'settle-diff', null, parsed.fopts)
        : await actionFeedback('fill', () => fillStr(cdp, sessionId, parsed.selector, parsed.text, refMap, refState), { input: parsed.selector, resolvedBy: 'selector-or-ref', label: parsed.selector || '', commandArgs: [parsed.selector, parsed.text] }, 'settle-diff', null, parsed.fopts);
      return commandResult(value, { kind: 'action-receipt' });
    },
    hover: async args => {
      let text;
      await rememberHoverSettleBaseline(
        cdp,
        sessionId,
        consoleBuf,
        exceptionBuf,
        refMap,
        lastPerceiveStore,
        refState,
        targetId,
        async () => {
          text = await hoverStr(cdp, sessionId, args[0], refMap, refState);
        },
      );
      return commandResult(text, null);
    },
    inject: async args => {
      const fopts = parseCompactFormatArgs(args, ['text', 'json']);
      const safeCommandArgs = fopts.args.map((arg, index) => index === 0 ? arg : '<redacted>');
      const value = await actionFeedback(
        'inject',
        async () => {
          try {
            return await injectStr(cdp, sessionId, fopts.args);
          } catch (error) {
            throw redactExternalInputActionError(error, 'inject', fopts.args);
          }
        },
        {
          input: fopts.args[0] || '',
          resolvedBy: 'command',
          label: fopts.args[0] || 'inject',
          commandArgs: safeCommandArgs,
          redacted: ['commandArgs'],
        },
        'state-change',
        null,
        fopts,
      );
      return commandResult(value, { kind: 'action-receipt' });
    },
    jsclick: async args => {
      const fopts = parseCompactFormatArgs(args, ['text', 'json']);
      const value = await actionFeedback('jsclick', () => jsClickStr(cdp, sessionId, fopts.args[0], refMap, refState), { input: fopts.args[0], resolvedBy: 'selector-or-ref', label: fopts.args[0] || '', commandArgs: [fopts.args[0]] }, 'settle-diff', null, fopts);
      return commandResult(value, { kind: 'action-receipt' });
    },
    keepalive: async args => commandResult(
      extendKeepalive(parseDelayMs(args[0], { name: 'keepalive duration' })),
      null,
    ),
    loadall: async args => {
      const parsed = parseLoadAllArgs(args);
      return commandResult(
        await loadAllStr(cdp, sessionId, parsed.selector, parsed.intervalMs, { timeoutMs: parsed.timeoutMs }),
        null,
      );
    },
    mock: async args => commandResult(
      await mockStr(cdp, sessionId, session, args),
      { kind: 'action-receipt' },
    ),
    forward: async args => {
      const fopts = parseCompactFormatArgs(args, ['text', 'json']);
      const value = await actionFeedback('forward', () => historyNavStr(cdp, sessionId, +1), { input: 'forward', resolvedBy: 'history', label: 'forward', commandArgs: [] }, 'full-perceive', observeFullPerceive, fopts);
      return commandResult(value, { kind: 'action-receipt' });
    },
    nav: async args => {
      const fopts = parseCompactFormatArgs(args, ['text', 'json']);
      const positional = [];
      let perceive = false;
      for (const arg of fopts.args) {
        if (arg === '--perceive') perceive = true;
        else if (String(arg).startsWith('--')) throw new Error(`nav: unknown argument ${arg}`);
        else positional.push(arg);
      }
      const url = positional[0];
      const value = await actionFeedback('nav', () => navStr(cdp, sessionId, url, {
        targetId,
        onSessionId(nextSid) { sessionId = nextSid; },
      }), { input: url, resolvedBy: 'url', label: url || '', commandArgs: [url] }, perceive ? 'full-perceive' : 'state-change', perceive ? observeFullPerceive : () => observeNavPage(cdp, sessionId), fopts);
      return commandResult(value, { kind: 'action-receipt' });
    },
    netlog: async args => commandResult(netlogStr(netReqBuf, args[0], {
      lastNavigationTs: navBuf.all().at(-1)?.ts ?? null,
    }), null),
    press: async args => {
      const fopts = parseCompactFormatArgs(args, ['text', 'json']);
      const usage = pressUsageError(fopts.args[0]);
      if (usage) throw usage;
      const value = await actionFeedback('press', () => pressStr(cdp, sessionId, fopts.args[0]), { input: fopts.args[0], resolvedBy: 'key', label: fopts.args[0] || '', commandArgs: [fopts.args[0]], expectedOutcome: 'press-no-change' }, 'settle-diff', null, fopts);
      return commandResult(value, { kind: 'action-receipt' });
    },
    qa: async args => commandResult(await qaPageStr({
      cdp,
      sid: sessionId,
      session,
      targetId,
      consoleBuf,
      exceptionBuf,
      refMap,
      lastPerceiveStore,
      refState,
      actionFeedback,
    }, args), { kind: 'action-receipt' }),
    reload: async args => {
      const fopts = parseCompactFormatArgs(args, ['text', 'json']);
      const value = await actionFeedback('reload', () => reloadActionDispatch({
        cdp,
        sessionId,
        session,
        consoleBuf,
        exceptionBuf,
        navBuf,
        netReqBuf,
        pendingReqs,
        lastReadSeq,
      }), { input: 'reload', resolvedBy: 'page', label: 'reload', commandArgs: [] }, 'state-change', () => observeReloadPage(cdp, sessionId), fopts);
      return commandResult(value, { kind: 'action-receipt' });
    },
    'responsive-audit': async args => commandResult(
      await responsiveAuditStr(cdp, sessionId, session, targetId, consoleBuf, exceptionBuf, args),
      { kind: 'action-receipt' },
    ),
    restore: async args => {
      const fopts = parseCompactFormatArgs(args, ['text', 'json']);
      const safeCommandArgs = redactRestoreCommandArgs(fopts.args);
      const value = await actionFeedback(
        'restore',
        async () => {
          let restoreResult;
          try {
            restoreResult = await restoreCheckpointStr(cdp, sessionId, fopts.args);
          } catch (error) {
            throw redactRestoreActionError(error, fopts.args);
          }
          clearObservationBuffers({ consoleBuf, exceptionBuf, navBuf, netReqBuf, pendingReqs, lastReadSeq });
          session.pageGeneration += 1;
          invalidateSessionRefs(session, 'navigation');
          return restoreResult;
        },
        {
          input: 'checkpoint',
          resolvedBy: 'artifact',
          label: 'checkpoint',
          commandArgs: safeCommandArgs,
          redacted: ['commandArgs'],
        },
        'report-only',
        null,
        fopts,
      );
      return commandResult(value, { kind: 'action-receipt' });
    },
    scroll: async args => {
      const fopts = parseCompactFormatArgs(args, ['text', 'json']);
      const value = await actionFeedback(
        'scroll',
        () => scrollStr(cdp, sessionId, fopts.args[0], fopts.args[1], fopts.args.slice(2)),
        scrollActionTarget(fopts.args),
        scrollFeedbackPolicy(fopts.args[0], fopts.args[1]),
        null,
        fopts,
      );
      return commandResult(value, { kind: 'action-receipt' });
    },
    select: async args => {
      const fopts = parseCompactFormatArgs(args, ['text', 'json']);
      const value = await actionFeedback('select', () => selectStr(cdp, sessionId, fopts.args[0], fopts.args[1]), { input: fopts.args[0], resolvedBy: 'selector', label: fopts.args[0] || '', commandArgs: [fopts.args[0], fopts.args[1]] }, 'settle-diff', null, fopts);
      return commandResult(value, { kind: 'action-receipt' });
    },
    throttle: async args => commandResult(
      await throttleStr(cdp, sessionId, session, args),
      { kind: 'action-receipt' },
    ),
    type: async args => {
      const fopts = parseCompactFormatArgs(args, ['text', 'json']);
      const value = await actionFeedback('type', () => typeStr(cdp, sessionId, fopts.args[0]), { input: 'current focus', resolvedBy: 'focus', label: 'current focus', commandArgs: [fopts.args[0]] }, 'settle-diff', null, fopts);
      return commandResult(value, { kind: 'action-receipt' });
    },
    upload: async args => {
      const fopts = parseCompactFormatArgs(args, ['text', 'json']);
      const value = await actionFeedback(
        'upload',
        async () => {
          try {
            return await uploadStr(cdp, sessionId, fopts.args[0], fopts.args[1]);
          } catch (error) {
            throw redactExternalInputActionError(error, 'upload', fopts.args);
          }
        },
        {
          input: fopts.args[0],
          resolvedBy: 'selector',
          label: fopts.args[0] || '',
          commandArgs: [fopts.args[0], '<redacted>'],
          redacted: ['commandArgs'],
        },
        'state-change',
        null,
        fopts,
      );
      return commandResult(value, { kind: 'action-receipt' });
    },
    'verify-click': async args => {
      const vopts = parseVerifyClickArgs(args);
      let captured = null;
      const observeAssertions = async () => {
        if (vopts.expectRequest) {
          await waitForActionNetworkQuiet(pendingReqs, { timeoutMs: VERIFY_CLICK_REQUEST_WAIT_MS });
          return '(verify-click request window)';
        }
        await waitForSettle(cdp, sessionId, VERIFY_CLICK_SETTLE_MS);
        return '(verify-click assertion window)';
      };
      await actionFeedback(
        'click',
        () => clickStr(cdp, sessionId, vopts.selector, refMap, refState),
        { input: vopts.selector, resolvedBy: 'selector-or-ref', label: vopts.selector || '', commandArgs: [vopts.selector] },
        'settle-diff',
        observeAssertions,
        'json',
        result => { captured = result; },
      );
      const textMatched = vopts.expectText
        ? await pageContainsText(cdp, sessionId, vopts.expectText).catch(() => false)
        : false;
      const model = buildSemanticInteractionModel(captured || {}, vopts, { textMatched });
      const value = formatActionWorkflowCommandOutput(model, {
        format: vopts.format,
        text: () => `${formatSemanticInteractionResult(model)}${vopts.evidence === 'full' && captured ? `\n---\n${formatActionText(captured)}` : ''}`,
      });
      return commandResult(value, { kind: 'action-receipt' });
    },
    viewport: async args => {
      const fopts = parseCompactFormatArgs(args, ['text', 'json']);
      const value = fopts.args[0]
        ? await actionFeedback('viewport', () => viewportStr(cdp, sessionId, fopts.args[0]), { input: fopts.args[0], resolvedBy: 'viewport', label: fopts.args[0], commandArgs: [fopts.args[0]] }, 'settle-diff', null, fopts)
        : await viewportStr(cdp, sessionId);
      return commandResult(value, { kind: 'action-receipt' });
    },
  };
  const workflowCapabilities = {
    batch: async args => {
      const parsedBatch = parseBatchArgs(args);
      const { commands, parallel } = parsedBatch;
      if (!commands.length) throw new Error('batch: no commands provided');
      const blocked = commands.filter(command => BATCH_BLOCKED.has(command.cmd));
      if (blocked.length) throw new Error(`batch: ${blocked.map(command => command.cmd).join(', ')} not allowed inside batch`);
      if (parallel) {
        const unsafe = commands.filter(command => isBatchParallelUnsafeCommand(command.cmd, command.args || []));
        if (unsafe.length) throw new Error(`batch --parallel: ${[...new Set(unsafe.map(command => command.cmd))].join(', ')} mutate shared state — use sequential batch`);
      }
      const autoActionJson = parsedBatch.output === 'model';
      const runOne = command => handleCommand({
          cmd: command.cmd,
          args: autoActionJsonArgs(command.cmd, command.args || [], autoActionJson),
        });
      const results = await runBatchCommands({ run: runOne }, commands, { parallel });
      const format = parsedBatch.output === 'legacy-json' ? 'json' : parsedBatch.output;
      return formatBatchResults(results, format, { targetId, mode: parallel ? 'parallel' : 'sequential' });
    },
    flow: async args => {
      const fopts = parseFormatArgs(args, ['text', 'json']);
      return flowStr({
        run: step => handleCommand({
          cmd: step.cmd,
          args: autoActionJsonArgs(step.cmd, step.args || [], fopts.format === 'json'),
        }),
        settle: what => settleFlow(cdp, sessionId, what, pendingReqs),
        assertCondition: condition => probePageCondition(cdp, sessionId, condition),
      }, fopts.args.join(' '), { format: fopts.format, targetId, throwOnFailure: true });
    },
    repeat: args => repeatStr({
      run: step => handleCommand({ cmd: step.cmd, args: step.args || [] }),
      probeCondition: condition => probePageCondition(cdp, sessionId, condition),
    }, args),
    replay: args => replayActionsStr({
      run: step => handleCommand({ cmd: step.cmd, args: step.args || [] }),
    }, args),
  };
  const applicationHandlers = {
    report: applicationPreflight.handlerBuilders.report({ session, cdp, sessionId }),
    click: applicationPreflight.handlerBuilders.click({
      actionFeedback,
      click: selector => clickStr(cdp, sessionId, selector, refMap, refState),
      jsClick: selector => jsClickStr(cdp, sessionId, selector, refMap, refState),
    }),
    evalraw: applicationPreflight.handlerBuilders.evalraw({
      evalRaw: (method, params, authorization) => evalRawStr(cdp, sessionId, method, params, authorization),
    }),
    perceive: applicationPreflight.handlerBuilders.perceive({
      cdp,
      sessionId,
      targetId,
      session,
      consoleBuf,
      exceptionBuf,
      netReqBuf,
      refMap,
      lastPerceiveStore,
      refState,
    }),
    html: applicationPreflight.handlerBuilders.html(readCapabilities),
    text: applicationPreflight.handlerBuilders.text(readCapabilities),
    table: applicationPreflight.handlerBuilders.table(readCapabilities),
    net: applicationPreflight.handlerBuilders.net(readCapabilities),
    status: applicationPreflight.handlerBuilders.status(readCapabilities),
    summary: applicationPreflight.handlerBuilders.summary(readCapabilities),
    snap: applicationPreflight.handlerBuilders.snap(readCapabilities),
    controls: applicationPreflight.handlerBuilders.controls(readCapabilities),
    frame: applicationPreflight.handlerBuilders.frame(readCapabilities),
    overlay: applicationPreflight.handlerBuilders.overlay(readCapabilities),
    styles: applicationPreflight.handlerBuilders.styles(readCapabilities),
    components: applicationPreflight.handlerBuilders.components(readCapabilities),
    'record-actions': recordActionsBuilder(readCapabilities),
    'export-playwright': exportPlaywrightBuilder(readCapabilities),
    wait: applicationPreflight.handlerBuilders.wait(readCapabilities),
    waitfor: applicationPreflight.handlerBuilders.waitfor(readCapabilities),
    cascade: applicationPreflight.handlerBuilders.cascade(readCapabilities),
    checkpoint: applicationPreflight.handlerBuilders.checkpoint(readCapabilities),
    cookies: applicationPreflight.handlerBuilders.cookies(readCapabilities),
    fill: applicationPreflight.handlerBuilders.fill(actionCapabilities),
    hover: applicationPreflight.handlerBuilders.hover(actionCapabilities),
    press: applicationPreflight.handlerBuilders.press(actionCapabilities),
    scroll: applicationPreflight.handlerBuilders.scroll(actionCapabilities),
    select: applicationPreflight.handlerBuilders.select(actionCapabilities),
    clickxy: applicationPreflight.handlerBuilders.clickxy(actionCapabilities),
    'dismiss-modal': dismissModalBuilder(actionCapabilities),
    jsclick: applicationPreflight.handlerBuilders.jsclick(actionCapabilities),
    type: applicationPreflight.handlerBuilders.type(actionCapabilities),
    'verify-click': verifyClickBuilder(actionCapabilities),
    back: applicationPreflight.handlerBuilders.back(actionCapabilities),
    forward: applicationPreflight.handlerBuilders.forward(actionCapabilities),
    nav: applicationPreflight.handlerBuilders.nav(actionCapabilities),
    reload: applicationPreflight.handlerBuilders.reload(actionCapabilities),
    clock: applicationPreflight.handlerBuilders.clock(actionCapabilities),
    mock: applicationPreflight.handlerBuilders.mock(actionCapabilities),
    throttle: applicationPreflight.handlerBuilders.throttle(actionCapabilities),
    emulate: applicationPreflight.handlerBuilders.emulate(actionCapabilities),
    viewport: applicationPreflight.handlerBuilders.viewport(actionCapabilities),
    cookiedel: applicationPreflight.handlerBuilders.cookiedel(actionCapabilities),
    cookieset: applicationPreflight.handlerBuilders.cookieset(actionCapabilities),
    dialog: applicationPreflight.handlerBuilders.dialog(actionCapabilities),
    keepalive: applicationPreflight.handlerBuilders.keepalive(actionCapabilities),
    netlog: applicationPreflight.handlerBuilders.netlog(actionCapabilities),
    eval: applicationPreflight.handlerBuilders.eval(scriptCapabilities),
    eval64: applicationPreflight.handlerBuilders.eval64(scriptCapabilities),
    call: applicationPreflight.handlerBuilders.call(scriptCapabilities),
    console: applicationPreflight.handlerBuilders.console(readCapabilities),
    record: applicationPreflight.handlerBuilders.record(readCapabilities),
    batch: applicationPreflight.handlerBuilders.batch(workflowCapabilities),
    flow: applicationPreflight.handlerBuilders.flow(workflowCapabilities),
    repeat: applicationPreflight.handlerBuilders.repeat(workflowCapabilities),
    replay: applicationPreflight.handlerBuilders.replay(workflowCapabilities),
    inject: applicationPreflight.handlerBuilders.inject(actionCapabilities),
    restore: applicationPreflight.handlerBuilders.restore(actionCapabilities),
    upload: applicationPreflight.handlerBuilders.upload(actionCapabilities),
    shot: applicationPreflight.handlerBuilders.shot(readCapabilities),
    'diff-shot': diffShotBuilder(readCapabilities),
    elshot: applicationPreflight.handlerBuilders.elshot(readCapabilities),
    fullshot: applicationPreflight.handlerBuilders.fullshot(readCapabilities),
    scanshot: applicationPreflight.handlerBuilders.scanshot(readCapabilities),
    qa: applicationPreflight.handlerBuilders.qa(actionCapabilities),
    'responsive-audit': responsiveAuditBuilder(actionCapabilities),
    closetab: applicationPreflight.handlerBuilders.closetab(actionCapabilities),
    loadall: applicationPreflight.handlerBuilders.loadall(actionCapabilities),
  };
  Object.freeze(applicationHandlers);
  const applicationDispatcher = createCommandDispatcher({
    registry: applicationRegistry,
    owners: applicationPreflight.routeOwners,
    handlers: applicationHandlers,
    authorize: authorizeDaemonApplicationCommand,
  });

  // Handle a command
  async function handleCommand({ cmd, args }, execution = undefined) {
  resetIdle();
  if (daemonRequestStorage.getStore() === undefined) {
    return daemonRequestStorage.run(execution || null, () => handleCommand({ cmd, args }, execution));
  }
    try {
      enforceDaemonTableCollectionGate({ cmd, args }, execution);
      let result;
      const applicationRoute = applicationDispatcher.route(cmd);
      if (applicationRoute?.owner === 'application') {
        const route = await executeDaemonApplicationRoute({
          cmd,
          args,
          targetBound: Boolean(targetId),
        }, applicationDispatcher, cmd === 'table' && execution?.deadline ? execution : undefined);
        if (route.ok === false) {
          return { ok: false, result: route.result, error: route.error };
        }
        return { ok: true, result: route.result ?? '' };
      }
      switch (cmd) {
        case 'meta': {
          result = formatJson(daemonMetadata);
          break;
        }
        case 'list': {
          const pages = await getPages(cdp);
          result = formatPageList(pages, _browserInfo);
          break;
        }
        case 'list_raw': {
          const pages = await getPages(cdp);
          result = JSON.stringify(pages);
          break;
        }
        case 'stop': return { ok: true, result: '', stopAfter: true };
        default: return { ok: false, error: `Unknown command: ${cmd}` };
      }
      return { ok: true, result: result ?? '' };
    } catch (e) {
      const rawError = actionFailureMessage(e);
      const commandMeta = COMMANDS.find(command => command.name === cmd || (command.aliases || []).includes(cmd));
      const isMutatingCommand = commandMeta?.mutates === true;
      const alreadyClassified = rawError.startsWith('Action failure:');
      const lastAction = session.lastAction || {};
      const context = {
        action: isMutatingCommand && lastAction.action ? lastAction.action : cmd,
        target: isMutatingCommand && lastAction.target ? lastAction.target : { targetId, input: args?.[0], label: args?.[0] },
      };
      const failure = classifyActionFailure(e, context);
      const error = alreadyClassified || (isMutatingCommand && failure.kind !== 'unknown' && failure.kind !== 'usage')
        ? formatActionFailure(e, context)
        : rawError;
      return { ok: false, error };
    }
  }

  // Unix socket server — NDJSON protocol
  // Wire format: each message is one JSON object followed by \n (newline-delimited JSON).
  // Request:  { "id": <number>, "cmd": "<command>", "args": ["arg1", "arg2", ...] }
  // Response: { "id": <number>, "ok": <boolean>, "result": "<string>" }
  //           or { "id": <number>, "ok": false, "error": "<message>" }
  server = net.createServer((conn) => {
    let requestConnection;
    requestConnection = createDaemonRequestConnection(conn, {
      handleRequest: handleCommand,
      cleanup: (_request, execution) => tableArtifactStore.rollbackRequest(execution),
      onFlushed: (_request, execution) => tableArtifactStore.releaseRequest(execution),
      onDispose: () => {
        if (requestConnection.activeRequestCount() === 0 && conn.destroyed) {
          requestConnections.delete(requestConnection);
        }
      },
      onDisconnect: () => requestConnections.delete(requestConnection),
      onFatal: () => shutdown(1),
      onStop: shutdown,
    });
    requestConnections.add(requestConnection);
  });

  server.on('error', (e) => {
    process.stderr.write(`Daemon server listen failed: ${e.message}\n`);
    shutdown(1);
  });

  if (!IS_WINDOWS) try { unlinkSync(sp); } catch {}
  server.listen(sp);
}

// ---------------------------------------------------------------------------
// CLI ↔ daemon communication
// ---------------------------------------------------------------------------

function connectToSocket(sp, { timeoutMs = 5000 } = {}) {
  return connectToDaemon(sp, { timeoutMs });
}

async function getOrStartTabDaemon(targetId, opts = {}) {
  const platform = opts.platform || process.platform;
  const sp = daemonEndpointForPlatform(targetId, {
    platform,
    runtimeDir: opts.runtimeDir || RUNTIME_DIR,
  });
  const connect = opts.connect || connectToSocket;
  const unlink = opts.unlink || unlinkSync;
  const spawnProcess = opts.spawnProcess || spawn;
  const delay = opts.delay || sleep;
  const retries = opts.retries ?? DAEMON_CONNECT_RETRIES;
  const retryDelayMs = opts.retryDelayMs ?? DAEMON_CONNECT_DELAY;
  const execPath = opts.execPath || process.execPath;
  const scriptPath = opts.scriptPath || process.argv[1];
  // Try existing daemon
  let lastError = null;
  try { return await connect(sp); } catch (error) { lastError = error; }

  // Clean stale socket
  if (platform !== 'win32') try { unlink(sp); } catch {}

  // Spawn daemon
  const child = spawnProcess(execPath, [scriptPath, '_daemon', targetId], {
    detached: true,
    stdio: 'ignore',
    env: opts.env || process.env,
  });
  child.unref();

  // Wait for socket (includes time for user to click Allow when the tab is not yet live)
  for (let i = 0; i < retries; i++) {
    await delay(retryDelayMs);
    try { return await connect(sp); } catch (error) { lastError = error; }
  }
  throw new Error(formatDaemonStartFailure({
    lastError,
    liveTargetPresent: opts.liveTargetPresent === true,
    targetId,
  }));
}

function sendCommand(conn, req) {
  return requestDaemon(conn, req, {
    runtimeDir: RUNTIME_DIR,
    mayHaveSideEffects: daemonRequestMayHaveSideEffects(req),
  });
}

const DAEMON_SIDE_EFFECT_AUTHORIZATIONS = new Set([
  'mutation',
  'conditional',
  'composite',
  'raw-script',
  'raw-cdp',
]);

function daemonRequestMayHaveSideEffects(request = {}) {
  const command = COMMAND_SURFACE.resolve(request.cmd);
  if (command?.name === 'table') {
    if (command.kind !== 'conditional-mutation'
      || command.authorization !== 'conditional'
      || command.evidencePolicy !== 'none') return true;
    return isTableCollectArgs(request.args || []);
  }
  return Boolean(command && DAEMON_SIDE_EFFECT_AUTHORIZATIONS.has(command.authorization));
}

async function assertFreshDaemonConnection(conn, { targetPrefix, expectedTargetId = null, currentMetadata }) {
  const response = await sendCommand(conn, { cmd: 'meta', args: [] });
  const daemonMetadata = response?.ok ? parseDaemonMetadataResult(response.result) : null;
  const assessment = assessDaemonFreshness({
    targetPrefix,
    expectedTargetId,
    current: currentMetadata,
    daemon: daemonMetadata,
  });
  if (assessment.stale) {
    const error = new Error(formatStaleDaemonMessage(assessment));
    error.assessment = assessment;
    throw error;
  }
  return assessment;
}

// Find any running daemon socket to reuse for list
function findAnyDaemonSocket() {
  return listDaemonSockets()[0]?.socketPath || null;
}

async function discoverLivePagesForTargetResolution({
  env = process.env,
  pinCdpPort = false,
  findSocket = findAnyDaemonSocket,
  connect = connectToSocket,
  request = sendCommand,
  resolveWsUrl = getWsUrl,
  connectCdp,
  listPages = getPages,
  rememberEndpoint = rememberLiveCdpEndpointFromSession,
} = {}) {
  if (!pinCdpPort) {
    const existingSocket = findSocket();
    if (existingSocket) {
      try {
        const conn = await connect(existingSocket);
        const response = await request(conn, { cmd: 'list_raw' });
        if (response.ok) {
          const pages = JSON.parse(response.result);
          if (Array.isArray(pages)) return pages;
        }
      } catch {}
    }
  }
  const openCdp = connectCdp || (async (wsUrl) => {
    const cdp = new CDP();
    await cdp.connect(wsUrl);
    return cdp;
  });
  const cdp = await openCdp(await resolveWsUrl({ env }));
  try {
    try { await rememberEndpoint(cdp, { env }); } catch {}
    return await listPages(cdp);
  } finally {
    try { cdp.close(); } catch {}
  }
}

async function readDaemonBinding(targetId) {
  const daemon = listDaemonSockets().find(entry => entry.targetId === targetId);
  if (!daemon) return null;
  try {
    const conn = await connectToSocket(daemon.socketPath);
    const response = await sendCommand(conn, { cmd: 'meta', args: [] });
    const metadata = response?.ok ? parseDaemonMetadataResult(response.result) : null;
    return metadata ? { targetId: daemon.targetId, ...metadata } : { targetId: daemon.targetId };
  } catch {
    return { targetId: daemon.targetId };
  }
}

// ---------------------------------------------------------------------------
// Stop daemons
// ---------------------------------------------------------------------------

function buildStopResult({ requestedTarget = null, daemons = [], stoppedDaemons = [], removedDaemons = stoppedDaemons, failedDaemons = [] } = {}) {
  const targetIds = daemons.map(daemon => daemon.targetId).filter(Boolean);
  const prefixLength = targetIds.length ? getDisplayPrefixLength(targetIds) : MIN_TARGET_PREFIX_LEN;
  const removedIds = new Set(removedDaemons.map(daemon => daemon.targetId));
  const stoppedTargets = stoppedDaemons.map(daemon => daemon.targetId.slice(0, prefixLength));
  const failedTargets = failedDaemons.map(daemon => daemon.targetId.slice(0, prefixLength));
  const remainingTargets = daemons
    .filter(daemon => !removedIds.has(daemon.targetId))
    .map(daemon => daemon.targetId.slice(0, prefixLength));
  return {
    schema: 'chrome-cdp-ex.stop.v1',
    requestedTarget,
    stopped: stoppedTargets.length > 0,
    stoppedTargets,
    failedTargets,
    remainingSessions: remainingTargets.length,
    remainingTargets,
    noop: stoppedTargets.length === 0 && failedTargets.length === 0,
  };
}

function formatStopResult(model, { format = 'text' } = {}) {
  if (format === 'json') return formatJson(model);
  if (model.failedTargets?.length) {
    if (model.requestedTarget) {
      return `Failed to stop daemon ${model.failedTargets.join(', ')}; ${model.remainingSessions} remaining session(s).`;
    }
    const stopped = model.stoppedTargets?.length
      ? `Stopped ${model.stoppedTargets.length} daemon(s): ${model.stoppedTargets.join(', ')}; `
      : '';
    return `${stopped}Failed to stop daemon(s): ${model.failedTargets.join(', ')}; ${model.remainingSessions} remaining session(s).`;
  }
  if (!model.stopped) {
    const scope = model.requestedTarget ? ` for ${model.requestedTarget}` : 's';
    return `No active daemon${scope}; ${model.remainingSessions} remaining session(s).`;
  }
  if (model.requestedTarget) {
    return `Stopped daemon ${model.stoppedTargets.join(', ')}; ${model.remainingSessions} remaining session(s).`;
  }
  return `Stopped ${model.stoppedTargets.length} daemon(s): ${model.stoppedTargets.join(', ')}; ${model.remainingSessions} remaining session(s).`;
}

async function stopDaemons(targetPrefix, deps = {}) {
  const list = deps.list || listDaemonSockets;
  const connect = deps.connect || connectToSocket;
  const send = deps.send || sendCommand;
  const unlink = deps.unlink || unlinkSync;
  const daemons = list();
  if (!daemons.length) return buildStopResult({ requestedTarget: targetPrefix || null });

  let selected = daemons;
  if (targetPrefix) {
    const matches = daemons.filter(daemon => daemon.targetId.toLowerCase().startsWith(String(targetPrefix).toLowerCase()));
    if (!matches.length) return buildStopResult({ requestedTarget: targetPrefix, daemons });
    const targetId = resolvePrefix(targetPrefix, daemons.map(daemon => daemon.targetId), 'daemon');
    selected = [daemons.find(daemon => daemon.targetId === targetId)];
  }
  const stoppedDaemons = [];
  const removedDaemons = [];
  const failedDaemons = [];
  for (const daemon of selected) {
    let response;
    try {
      const conn = await connect(daemon.socketPath);
      response = await send(conn, { cmd: 'stop', args: [] });
    } catch {
      if (!IS_WINDOWS) {
        try {
          unlink(daemon.socketPath);
          removedDaemons.push(daemon);
        } catch {
          failedDaemons.push(daemon);
        }
      } else {
        failedDaemons.push(daemon);
      }
      continue;
    }
    if (response?.ok === false) throw new Error(response.error || 'daemon rejected stop');
    stoppedDaemons.push(daemon);
    removedDaemons.push(daemon);
  }
  return buildStopResult({ requestedTarget: targetPrefix || null, daemons, stoppedDaemons, removedDaemons, failedDaemons });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const CLI_HELP_LAYOUT = Object.freeze([
  {
    "name": "help",
    "headGap": 1,
    "summaryGap": 20,
    "summaryIndent": null
  },
  {
    "name": "list",
    "headGap": 1,
    "summaryGap": 6,
    "summaryIndent": null
  },
  {
    "name": "target",
    "headGap": 1,
    "summaryGap": null,
    "summaryIndent": 36
  },
  {
    "name": "tab-group",
    "headGap": 1,
    "summaryGap": null,
    "summaryIndent": 36
  },
  {
    "name": "broadcast",
    "headGap": 1,
    "summaryGap": null,
    "summaryIndent": 36
  },
  {
    "name": "use",
    "headGap": 1,
    "summaryGap": 8,
    "summaryIndent": null
  },
  {
    "name": "attach",
    "headGap": 1,
    "summaryGap": 2,
    "summaryIndent": null
  },
  {
    "name": "current",
    "headGap": 1,
    "summaryGap": 12,
    "summaryIndent": null
  },
  {
    "name": "forget",
    "headGap": 1,
    "summaryGap": 21,
    "summaryIndent": null
  },
  {
    "name": "perceive",
    "headGap": 1,
    "summaryGap": 2,
    "summaryIndent": null
  },
  {
    "name": "snap",
    "headGap": 2,
    "summaryGap": 11,
    "summaryIndent": null
  },
  {
    "name": "controls",
    "headGap": 1,
    "summaryGap": null,
    "summaryIndent": 36
  },
  {
    "name": "eval",
    "headGap": 2,
    "summaryGap": 13,
    "summaryIndent": null
  },
  {
    "name": "eval64",
    "headGap": 1,
    "summaryGap": 10,
    "summaryIndent": null
  },
  {
    "name": "call",
    "headGap": 2,
    "summaryGap": 10,
    "summaryIndent": null
  },
  {
    "name": "elshot",
    "headGap": 1,
    "summaryGap": 8,
    "summaryIndent": null
  },
  {
    "name": "shot",
    "headGap": 2,
    "summaryGap": 2,
    "summaryIndent": null
  },
  {
    "name": "diff-shot",
    "headGap": 1,
    "summaryGap": 2,
    "summaryIndent": null
  },
  {
    "name": "html",
    "headGap": 2,
    "summaryGap": 9,
    "summaryIndent": null
  },
  {
    "name": "nav",
    "headGap": 3,
    "summaryGap": 2,
    "summaryIndent": null
  },
  {
    "name": "mock",
    "headGap": 2,
    "summaryGap": 8,
    "summaryIndent": null
  },
  {
    "name": "clock",
    "headGap": 1,
    "summaryGap": 2,
    "summaryIndent": null
  },
  {
    "name": "throttle",
    "headGap": 1,
    "summaryGap": 2,
    "summaryIndent": null
  },
  {
    "name": "status",
    "headGap": 1,
    "summaryGap": 8,
    "summaryIndent": null
  },
  {
    "name": "console",
    "headGap": 1,
    "summaryGap": 1,
    "summaryIndent": null
  },
  {
    "name": "summary",
    "headGap": 1,
    "summaryGap": 18,
    "summaryIndent": null
  },
  {
    "name": "report",
    "headGap": 1,
    "summaryGap": null,
    "summaryIndent": 36
  },
  {
    "name": "checkpoint",
    "headGap": 1,
    "summaryGap": 2,
    "summaryIndent": null
  },
  {
    "name": "restore",
    "headGap": 1,
    "summaryGap": 2,
    "summaryIndent": null
  },
  {
    "name": "record-actions",
    "headGap": 1,
    "summaryGap": 11,
    "summaryIndent": null
  },
  {
    "name": "export-playwright",
    "headGap": 1,
    "summaryGap": 2,
    "summaryIndent": null
  },
  {
    "name": "replay",
    "headGap": 1,
    "summaryGap": 2,
    "summaryIndent": null
  },
  {
    "name": "frame",
    "headGap": 1,
    "summaryGap": 5,
    "summaryIndent": null
  },
  {
    "name": "overlay",
    "headGap": 1,
    "summaryGap": 2,
    "summaryIndent": null
  },
  {
    "name": "qa",
    "headGap": 1,
    "summaryGap": 2,
    "summaryIndent": null
  },
  {
    "name": "responsive-audit",
    "headGap": 1,
    "summaryGap": null,
    "summaryIndent": 36
  },
  {
    "name": "verify-click",
    "headGap": 1,
    "summaryGap": 2,
    "summaryIndent": null
  },
  {
    "name": "net",
    "headGap": 3,
    "summaryGap": 20,
    "summaryIndent": null
  },
  {
    "name": "click",
    "headGap": 3,
    "summaryGap": 2,
    "summaryIndent": null
  },
  {
    "name": "jsclick",
    "headGap": 1,
    "summaryGap": 7,
    "summaryIndent": null
  },
  {
    "name": "clickxy",
    "headGap": 1,
    "summaryGap": 2,
    "summaryIndent": null
  },
  {
    "name": "type",
    "headGap": 4,
    "summaryGap": 2,
    "summaryIndent": null
  },
  {
    "name": "press",
    "headGap": 1,
    "summaryGap": 2,
    "summaryIndent": null
  },
  {
    "name": "scroll",
    "headGap": 2,
    "summaryGap": 2,
    "summaryIndent": null
  },
  {
    "name": "hover",
    "headGap": 3,
    "summaryGap": 7,
    "summaryIndent": null
  },
  {
    "name": "waitfor",
    "headGap": 1,
    "summaryGap": 2,
    "summaryIndent": null
  },
  {
    "name": "loadall",
    "headGap": 1,
    "summaryGap": 2,
    "summaryIndent": null
  },
  {
    "name": "wait",
    "headGap": 4,
    "summaryGap": 13,
    "summaryIndent": null
  },
  {
    "name": "fill",
    "headGap": 4,
    "summaryGap": 1,
    "summaryIndent": null
  },
  {
    "name": "select",
    "headGap": 2,
    "summaryGap": 1,
    "summaryIndent": null
  },
  {
    "name": "fullshot",
    "headGap": 1,
    "summaryGap": 10,
    "summaryIndent": null
  },
  {
    "name": "scanshot",
    "headGap": 1,
    "summaryGap": 17,
    "summaryIndent": null
  },
  {
    "name": "styles",
    "headGap": 2,
    "summaryGap": null,
    "summaryIndent": 36
  },
  {
    "name": "components",
    "headGap": 1,
    "summaryGap": null,
    "summaryIndent": 36
  },
  {
    "name": "cookies",
    "headGap": 1,
    "summaryGap": 18,
    "summaryIndent": null
  },
  {
    "name": "cookieset",
    "headGap": 1,
    "summaryGap": 7,
    "summaryIndent": null
  },
  {
    "name": "cookiedel",
    "headGap": 1,
    "summaryGap": 9,
    "summaryIndent": null
  },
  {
    "name": "dialog",
    "headGap": 2,
    "summaryGap": 1,
    "summaryIndent": null
  },
  {
    "name": "viewport",
    "headGap": 1,
    "summaryGap": 4,
    "summaryIndent": null
  },
  {
    "name": "emulate",
    "headGap": 1,
    "summaryGap": null,
    "summaryIndent": 36
  },
  {
    "name": "upload",
    "headGap": 2,
    "summaryGap": 2,
    "summaryIndent": null
  },
  {
    "name": "text",
    "headGap": 4,
    "summaryGap": 1,
    "summaryIndent": null
  },
  {
    "name": "table",
    "headGap": 3,
    "summaryGap": 7,
    "summaryIndent": null
  },
  {
    "name": "back",
    "headGap": 4,
    "summaryGap": 18,
    "summaryIndent": null
  },
  {
    "name": "forward",
    "headGap": 1,
    "summaryGap": 18,
    "summaryIndent": null
  },
  {
    "name": "reload",
    "headGap": 2,
    "summaryGap": 18,
    "summaryIndent": null
  },
  {
    "name": "closetab",
    "headGap": 1,
    "summaryGap": 17,
    "summaryIndent": null
  },
  {
    "name": "netlog",
    "headGap": 2,
    "summaryGap": 8,
    "summaryIndent": null
  },
  {
    "name": "inject",
    "headGap": 1,
    "summaryGap": 3,
    "summaryIndent": null
  },
  {
    "name": "cascade",
    "headGap": 1,
    "summaryGap": 1,
    "summaryIndent": null
  },
  {
    "name": "record",
    "headGap": 1,
    "summaryGap": 14,
    "summaryIndent": null
  },
  {
    "name": "evalraw",
    "headGap": 1,
    "summaryGap": 2,
    "summaryIndent": null
  },
  {
    "name": "batch",
    "headGap": 1,
    "summaryGap": 1,
    "summaryIndent": null
  },
  {
    "name": "flow",
    "headGap": 2,
    "summaryGap": 2,
    "summaryIndent": null
  },
  {
    "name": "repeat",
    "headGap": 1,
    "summaryGap": 2,
    "summaryIndent": null
  },
  {
    "name": "doctor",
    "headGap": 1,
    "summaryGap": 4,
    "summaryIndent": null
  },
  {
    "name": "keepalive",
    "headGap": 1,
    "summaryGap": 11,
    "summaryIndent": null
  },
  {
    "name": "open",
    "headGap": 2,
    "summaryGap": null,
    "summaryIndent": 36
  },
  {
    "name": "spawn-debug-browser",
    "headGap": 1,
    "summaryGap": null,
    "summaryIndent": 36
  },
  {
    "name": "dismiss-modal",
    "headGap": 1,
    "summaryGap": 12,
    "summaryIndent": null
  },
  {
    "name": "stop",
    "headGap": 2,
    "summaryGap": 4,
    "summaryIndent": null
  }
].map(record => Object.freeze(record)));

const CLI_HELP_TEMPLATE = `cdp - lightweight Chrome DevTools Protocol CLI (no Puppeteer)

Usage: cdp <command> [args]

{{command:help}}
{{command:list}}
                                    JSON includes schema/pages/recommendation/nextSteps for agents.
                                    Prefers non-blank pages when recommending the next target (* marker).
{{command:target}}
                                    Ambiguous matches return candidate URLs/titles and follow-up commands.
{{command:tab-group}}
                                    create <name> [targets...] | add/remove <name> <target> | show/delete <name>
{{command:broadcast}}
                                    JSON bounds per-target previews; --full-results opts into complete payloads.
{{command:use}}
                                    Accepts 9222/<target> to bind a CDP port to the alias.
{{command:attach}}
{{command:current}}
{{command:forget}}
{{command:perceive}}
                                    --diff: show only changes since last perceive
                                    --since-action: show changes caused by the last mutating command
                                    --qa / --summary: compact QA summary (url/title/blank/console/next)
                                    --max-diff-lines N: truncate long text output
                                    --adaptive / --last auto: density+error aware text-row budget
                                    --last N: keep last N text rows (explicit wins over adaptive)
                                    JSON includes structured refs plus recommendation/nextSteps.
                                    JSON with --diff/--since-action returns chrome-cdp-ex.perceive-diff.v1
                                    --frame @fN / -F @fN: perceive inside an iframe; refs become @fN:M
                                    -s <sel> / --selector: scope to CSS selector subtree
                                    -x <sel> / --exclude: drop matching chrome (must not empty main; prefer text --auto or -s main)
                                    -i / --interactive: only show interactive elements
                                    -d N / --depth N: limit tree depth
                                    -C / --cursor-interactive: include non-ARIA clickable elements (@c refs)
                                    --keep-typeahead: keep focused search suggestion listbox in the tree
                                    --cards / --role feed: compact article/listitem cards (chrome-cdp-ex.cards.v1)
{{command:snap}}
{{command:controls}}
{{command:eval}}
                                    --b64 / -b <base64>: decode UTF-8 base64 first
                                    (safe transport for CJK / shell-hostile expressions)
                                    --raw: compact JSON for objects (skip pretty multi-line stringify)
                                    --fire-and-forget: dispatch without awaiting returned promise
{{command:eval64}}
{{command:call}}
{{command:elshot}}
{{command:shot}}
{{command:diff-shot}}
{{command:html}}
{{command:nav}}
{{command:mock}}
                                    add <urlPattern> --status code --body text [--content-type type]
{{command:clock}}
                                    freeze --at date-or-epoch-ms | offset --ms delta
{{command:throttle}}
                                    custom --latency ms --download kbps --upload kbps
{{command:status}}
                                    --runtime: include Performance.getMetrics counters
{{command:console}}
{{command:summary}}
{{command:report}}
                                    --qa/--summary returns a compact chrome-cdp-ex.qa-summary.v1 handoff
{{command:checkpoint}}
{{command:restore}}
  restore <target> --json <json> [--format json]  Restore an inline checkpoint JSON artifact
{{command:record-actions}}
{{command:export-playwright}}
{{command:replay}}
  replay <target> --json <json> [--format json]  Replay an inline record-actions JSON artifact
{{command:frame}}
{{command:overlay}}
{{command:qa}}
                                    Optional: --click <sel|@ref> --expect-text text --expect-request pattern
{{command:responsive-audit}}
                                    Defaults to desktop 1440x900 + mobile 390x844.
                                    Collects screenshot, overflow-x, scroll metrics, controls, blank/console signals.
{{command:verify-click}}
                                    --expect-text text --expect-request pattern --expect-status code --no-console-errors
{{command:net}}
{{command:click}}
                                    --js / -j: use HTMLElement.click() (JS fallback)
                                    --qa/--summary: compact pass/fail QA receipt without full DOM dump
{{command:jsclick}}
                                    Use when overlays or hit-testing block the realistic mouse path.
{{command:clickxy}}
{{command:type}}
                                    Works in cross-origin iframes unlike eval-based approaches
{{command:press}}
{{command:scroll}}
{{command:hover}}
{{command:waitfor}}
  waitfor <target> --gone <sel|@ref> [ms]  Wait for element to DISAPPEAR (streaming end)
  waitfor <target> --text "str" [--scope sel] [ms]  Wait for text to appear on page
{{command:loadall}}
                                    [interval-ms] is the click interval (default 1500), not a timeout.
                                    --timeout-ms N: fail if the control is still present (default 30000, max 5 min).
{{command:wait}}
{{command:fill}}
                                    --react: native value setter + input/change events
                                    JSON defaults to chrome-cdp-ex.fill.v1; --full restores action.v1
{{command:select}}
{{command:fullshot}}
{{command:scanshot}}
{{command:styles}}
                                    On no-match, error includes root/scope and an eval fallback
{{command:components}}
                                    Props/state are bounded and redacted unless --unsafe-full is explicit.
{{command:cookies}}
{{command:cookieset}}
{{command:cookiedel}}
{{command:dialog}}
{{command:viewport}}
{{command:emulate}}
                                    color-scheme dark|light|no-preference
                                    reduced-motion reduce|no-preference
                                    off/reset clears overrides; JSON returns chrome-cdp-ex.emulate.v1
{{command:upload}}
{{command:text}}
                                    --auto: extract main content (strips nav/aside/script/style)
                                    -x / --exclude: extra CSS selectors to strip
                                    --root auto|body|document|default|<sel>: search root for selector resolution
                                    On no-match, error includes root/scope and an eval fallback
{{command:table}}
{{command:back}}
{{command:forward}}
{{command:reload}}
{{command:closetab}}
{{command:netlog}}
{{command:inject}}
                                    --css "<text>"   Inject inline <style>
                                    --css-file <url> Inject <link rel="stylesheet">
                                    --js-file <url>  Inject <script src> and wait for load
                                    --remove [id]    Remove injected element(s) (all, or by id)
{{command:cascade}}
                                    Optional: filter to one property (e.g. "background-color"); JSON returns chrome-cdp-ex.cascade.v1
{{command:record}}
  record <target> --action click @5 Record events around an action (click/press/fill/select/type/scroll/nav)
  record <target> --until "dom stable"|"network idle"  Record until page quiets (max 30s)
{{command:evalraw}}
                                    e.g. evalraw <t> "DOM.getDocument" '{}'
{{command:batch}}
                                    --format json returns chrome-cdp-ex.batch.v1 failure handoff
                                    Pipe syntax: 'fill @3 hello | fill @5 world | click @7'
                                    JSON syntax: '[{"cmd":"click","args":["@1"]},{"cmd":"perceive","args":["--diff"]}]'
                                    --parallel  Run read-only/extraction commands concurrently (mutating commands are rejected as Kind:usage / cdp help batch)
                                    --plain     Human-readable per-step output (default: pretty JSON)
                                    --compact   One line per step (head + first line of result)
{{command:flow}}
                                    Each step is a normal command (e.g. "click @1") or a wait alias:
                                    "wait dom stable" / "wait network idle" — uses settle helper.
                                    Assertions: "assert selector <css>", "assert selector-missing <css>", "assert text <value>".
                                    Halts and exits non-zero on the first failing step; JSON preserves chrome-cdp-ex.flow.v1.
                                    Example: flow A7BA "click @1; wait dom stable; summary; console --errors"
{{command:repeat}}
                                    --continue / -c: keep going through errors and report tally.
                                    --until-selector <css> | --until-selector-missing <css> | --until-text <text>
                                    re-checks after each settled iteration; cap exhaustion exits non-zero.
                                    Cannot wrap repeat/batch/stop (recursion / IPC corruption).
                                    Can wrap flow for multi-step turn loops, e.g.
                                    repeat A7BA 3 flow "click @1; wait dom stable; text .log"
                                    Useful for advancing MUD dialogue ("repeat 5 press space"),
                                    retry-style probes, or short keypress sequences. Re-perceive
                                    between iterations if the DOM changes — refs are not auto-remapped.
                                    Example: repeat A7BA 5 press c
{{command:doctor}}
                                    daemon socket state, fd limit, CDP_PORT/DevToolsActivePort reachability,
                                    debuggable tab inventory, browser permission, Recommendation, and onboarding next steps.
                                    Readiness: ready | usable-with-warnings | blocked.
                                    Checks expose severity: blocking | warning | advisory | ok.
                                    Headless CDP sessions treat unconfirmed permission as advisory, not a blocker.
                                    When CDP is unreachable, FAIL hint is one same-profile relaunch line from the
                                    last known --user-data-dir; do not invent a new profile or DISPLAY.
                                    No target required. Exits 1 if any check FAILs.
{{command:keepalive}}
{{command:open}}
                                    JSON includes schema/target/approval/recommendation/nextSteps for agents.
                                    Default open returns the target prefix and a follow-up perceive command.
                                    --perceive dumps the full page after attach (opt-in).
                                    --reuse-url reuses an existing tab matching the URL when unique.
                                    Default attach wait is fail-fast (5s). Use --attach-timeout-ms 60000
                                    when Chrome may still prompt "Allow debugging?".
                                    --attach-timeout-ms 0 returns the target handoff without waiting.
                                    --ready-timeout-ms bounds document.readyState waiting after attach.
                                    --ready-selector also waits for a CSS selector before returning.
                                    Note: each new tab triggers a fresh "Allow debugging?" prompt
{{command:spawn-debug-browser}}
                                    Rejects an occupied listener before spawning; choose another --port.
                                    --host HOST binds remote debugging address (default 127.0.0.1).
                                    --headless [new|old], --no-sandbox, --disable-gpu help CI/container/headless runs.
                                    --wait-ms N bounds the readiness probe before success.
                                    Returns ready target prefix + next perceive command when a page is available.
                                    JSON includes pid/profileDir/port/url/targetId/targetPrefix/readiness/cleanup.
                                    Uses --remote-debugging-port + --user-data-dir; does not touch your main profile.
                                    "spawn" is a short alias.
{{command:dismiss-modal}}
                                    avoids triggering background shortcuts the way a bare "press Space" does.
{{command:stop}}

ACTION FEEDBACK
  click, verify-click, jsclick, clickxy, fill, type, press, select, scroll,
  upload, inject, dismiss-modal, and viewport (when resizing) automatically wait for DOM to
  settle and return compact action evidence plus a perceive diff.
  qa returns a semantic QA report and includes action evidence when --click is used.
  back, forward, and nav return action evidence plus a full perceive.
  reload returns action evidence plus a bounded lightweight page observation.
  Each mutating action also snapshots console/exception/network buffers before
  dispatch and reports compact deltas such as console errors, failed requests,
  or requests still pending after the action observation window.
  If that post-action observation times out after the action was sent, the
  command reports success with "observation timed out" instead of a pure timeout.
  No need to manually run perceive or perceive --diff after these actions.
  To re-check what the last action changed, run perceive --since-action.

<target> is a unique targetId prefix from "cdp list" or a saved alias from
"cdp use <target> --name app". If a prefix is ambiguous, use more characters.

COORDINATE SYSTEM
  shot captures the viewport at the device's native resolution.
  The screenshot image size = CSS pixels × DPR (device pixel ratio).
  For CDP Input events (clickxy, etc.) you need CSS pixels, not image pixels.

    CSS pixels = screenshot image pixels / DPR

  shot prints the DPR and an example conversion for the current page.
  Typical Retina (DPR=2): CSS px ≈ screenshot px × 0.5
  If your viewer rescales the image further, account for that scaling too.

EVAL SAFETY NOTE
  Avoid index-based DOM selection (querySelectorAll(...)[i]) across multiple
  eval calls when the list can change between calls (e.g. after clicking
  "Ignore" buttons on a feed — indices shift). Prefer stable selectors or
  collect all data in a single eval.

DAEMON IPC (for advanced use / scripting)
  Each tab runs a persistent daemon at Unix socket in the runtime dir (see below).
  Protocol: newline-delimited JSON (one JSON object per line, UTF-8).
    Request:  {"id":<number>, "cmd":"<command>", "args":["arg1","arg2",...]}
    Response: {"id":<number>, "ok":true,  "result":"<string>"}
           or {"id":<number>, "ok":false, "error":"<message>"}
  Commands mirror the CLI: perceive, status, summary, console, frame, snap, controls, eval, eval64, call, wait, keepalive, shot, diff-shot,
  elshot, fullshot, scanshot, html, nav, net, mock, clock, throttle, click, jsclick, clickxy, hover, type, press,
  scroll, fill, select, waitfor, loadall, styles, cookies, cookieset, cookiedel, dialog,
  viewport, emulate, upload, text, table, components, back, forward, reload, closetab, netlog, inject, cascade,
  record, checkpoint, restore, record-actions, export-playwright, replay, report, qa, responsive-audit,
  verify-click, evalraw, batch, flow, repeat, stop.
  The socket disappears after 20 min of inactivity or when the tab closes.
`;

function renderCliHelp(surface = COMMAND_SURFACE, template = CLI_HELP_TEMPLATE) {
  if (!isCommandSurface(surface)) {
    throw new Error('CLI help surface: validated command surface required');
  }
  const markers = [...String(template).matchAll(/\{\{command:([^}]+)}}/g)].map(match => match[1]);
  if (surface.commands.length !== CLI_HELP_LAYOUT.length) {
    throw new Error(`CLI help surface: expected exactly ${CLI_HELP_LAYOUT.length} commands`);
  }
  const expected = [...surface.commands]
    .sort((left, right) => left.help.order - right.help.order)
    .map(command => command.name);
  for (const name of markers) {
    if (!surface.resolve(name)) throw new Error(`CLI help template: unknown command marker ${name}`);
  }
  if (markers.length !== expected.length || new Set(markers).size !== markers.length) {
    throw new Error('CLI help template: every help marker must appear exactly once');
  }
  if (!markers.every((name, index) => name === expected[index])) {
    throw new Error('CLI help template: command marker order drifted');
  }
  let output = String(template);
  const layoutByName = new Map(CLI_HELP_LAYOUT.map(record => [record.name, record]));
  if (layoutByName.size !== CLI_HELP_LAYOUT.length) throw new Error('CLI help layout: duplicate command name');
  for (const name of expected) {
    const record = layoutByName.get(name);
    if (!record) throw new Error(`CLI help layout: missing whitespace record for ${name}`);
    const command = surface.resolve(name);
    const tokens = command.help.synopsis.trim().split(/\s+/);
    const synopsis = tokens.length === 1
      ? tokens[0]
      : `${tokens[0]}${' '.repeat(record.headGap)}${tokens.slice(1).join(' ')}`;
    const row = record.summaryGap === null
      ? `  ${synopsis}\n${' '.repeat(record.summaryIndent)}${command.help.summary}`
      : `  ${synopsis}${' '.repeat(record.summaryGap)}${command.help.summary}`;
    output = output.replace(`{{command:${record.name}}}`, row);
  }
  if (/\{\{command:/.test(output)) throw new Error('CLI help template: unresolved command marker');
  return output;
}

const USAGE = renderCliHelp(COMMAND_SURFACE);

function helpStr() {
  return USAGE;
}

function helpTopicStr(topic) {
  const raw = String(topic || '').trim();
  if (!raw || raw === 'help' || raw === '--help' || raw === '-h') return helpStr();
  const needle = raw.replace(/^-+/, '').toLowerCase();
  const record = COMMAND_SURFACE.resolve(needle);
  if (!record) throw new Error(unknownCommandMessage(raw));
  const lines = [`cdp ${record.help.synopsis}`, record.help.summary];
  if (record.aliases?.length) lines.push(`Aliases: ${record.aliases.join(', ')}`);
  lines.push('Run `cdp help` for the full command reference.');
  return `${lines.join('\n')}\n`;
}

const COMMANDS = projectCliCommands(COMMAND_SURFACE);

function sameStringArray(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function snapshotApplicationDataObject(input, path) {
  if (!input || Array.isArray(input) || typeof input !== 'object') throw new Error(`${path}: must be a plain data object`);
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${path}: must be a plain data object without a custom prototype`);
  const snapshot = Object.create(null);
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key === 'symbol') throw new Error(`${path}: symbol keys are not allowed`);
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new Error(`${path}.${key}: must be an own data property, not an accessor`);
    if (descriptor.enumerable !== true) throw new Error(`${path}.${key}: must be enumerable`);
    Object.defineProperty(snapshot, key, {
      value: descriptor.value,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return snapshot;
}

function snapshotApplicationArray(input, path, { max = 256 } = {}) {
  if (!Array.isArray(input)) throw new Error(`${path}: must be an array`);
  if (Object.getPrototypeOf(input) !== Array.prototype) throw new Error(`${path}: must be a plain array`);
  if (!Number.isSafeInteger(input.length) || input.length > max) throw new Error(`${path}: exceeds the ${max}-item array limit`);
  const descriptors = Object.getOwnPropertyDescriptors(input);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key === 'symbol') throw new Error(`${path}: symbol keys are not allowed`);
    if (key === 'length') continue;
    if (!/^\d+$/.test(key)) throw new Error(`${path}.${key}: is not allowed`);
    if (!Object.hasOwn(descriptors[key], 'value')) throw new Error(`${path}[${key}]: must be a data property, not an accessor`);
  }
  const values = [];
  for (let index = 0; index < input.length; index += 1) {
    const descriptor = descriptors[index];
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new Error(`${path}[${index}]: must be an own data property`);
    values.push(descriptor.value);
  }
  return values;
}

function buildApplicationCommandSpecs(commands) {
  const authority = new Map(COMMAND_SURFACE.commands.map(command => [command.name, command]));
  const candidates = snapshotApplicationArray(commands, 'commands', { max: authority.size })
    .map((command, index) => snapshotApplicationDataObject(command, `commands[${index}]`));
  if (candidates.length !== authority.size) throw new Error(`commands: expected exactly ${authority.size} authoritative records`);
  const allowedKeys = new Set(['name', 'aliases', 'needsTarget', 'mutates', 'feedbackPolicy', 'outputFormats']);
  const requiredKeys = new Set(['name', 'aliases', 'needsTarget', 'mutates', 'outputFormats']);
  for (const [index, command] of candidates.entries()) {
    for (const key of Reflect.ownKeys(command)) {
      if (!allowedKeys.has(key)) throw new Error(`commands[${index}].${key}: is not allowed`);
    }
    for (const key of requiredKeys) {
      if (!Object.hasOwn(command, key)) throw new Error(`commands[${index}].${key}: is required`);
    }
    if (!authority.has(command.name)) throw new Error(`commands[${index}].name: unknown command ${command.name}`);
  }
  const specs = [];
  for (const name of [...authority.keys()].sort()) {
    const matches = candidates.filter(command => command.name === name);
    if (matches.length !== 1) throw new Error(`${name}.name: expected exactly one command from command-surface authority`);
    const command = matches[0];
    const canonical = authority.get(name);
    const hasFeedbackPolicy = Object.hasOwn(command, 'feedbackPolicy');
    const expectsFeedbackPolicy = canonical.feedbackPolicy !== null;
    if (hasFeedbackPolicy !== expectsFeedbackPolicy) {
      throw new Error(`${name}.feedbackPolicy: ${expectsFeedbackPolicy ? 'is required' : 'is not allowed'}`);
    }
    for (const field of ['needsTarget', 'mutates']) {
      if (command[field] !== canonical[field]) throw new Error(`${name}.${field}: drifted from COMMANDS authority`);
    }
    const feedbackPolicy = command.feedbackPolicy ?? null;
    if (feedbackPolicy !== (canonical.feedbackPolicy ?? null)) {
      throw new Error(`${name}.feedbackPolicy: drifted from COMMANDS authority`);
    }
    const arrays = {};
    for (const field of ['aliases', 'outputFormats']) {
      arrays[field] = snapshotApplicationArray(command[field], `${name}.${field}`);
      if (!sameStringArray(arrays[field], canonical[field])) {
        throw new Error(`${name}.${field}: drifted from COMMANDS authority`);
      }
    }
    specs.push(defineCommandSpec({
      name: command.name,
      aliases: arrays.aliases,
      needsTarget: command.needsTarget,
      mutates: command.mutates,
      feedbackPolicy,
      outputFormats: arrays.outputFormats,
      kind: canonical.kind,
      authorization: canonical.authorization,
      evidencePolicy: canonical.evidencePolicy,
    }));
  }
  return Object.freeze(specs);
}

function createApplicationCommandRegistry(commands) {
  return createCommandRegistry(buildApplicationCommandSpecs(commands));
}

function createReportCommandHandler(session, { cdp = null, sessionId = null, pageInfo = pageInfoModel } = {}) {
  return async ({ args }) => {
    const fopts = parseFormatArgs(args, ['text', 'json']);
    const ropts = parseReportArgs(fopts.args);
    if (ropts.args.length) throw new Error(`report: unknown argument ${ropts.args[0]}`);
    let page = null;
    if (cdp && sessionId) {
      try {
        page = await pageInfo(cdp, sessionId, { targetPrefix: targetPrefixForDisplay(session.targetId) });
      } catch {}
    }
    return commandResult(formatSessionReport(session, {
      format: fopts.format,
      lastActions: ropts.lastActions,
      compact: ropts.compact,
      qa: ropts.qa,
      page,
    }), { kind: 'session-report' });
  };
}

function createPerceiveCommandHandler({
  cdp,
  sessionId,
  targetId,
  session,
  consoleBuf,
  exceptionBuf,
  netReqBuf,
  refMap,
  lastPerceiveStore,
  refState,
  ops = {},
}) {
  const pageInfo = ops.pageInfoModel || pageInfoModel;
  const collectHealth = ops.collectPageHealth || collectPageHealth;
  const perceiveText = ops.perceiveText || perceiveStr;
  const buildPerceiveModel = ops.perceiveModel || perceiveModel;
  const buildPerceiveDiff = ops.perceiveDiffModel || perceiveDiffModel;
  return async ({ args }) => {
    const fopts = parseQaModeArgs(args, ['text', 'json']);
    const popts = resolveSinceActionPerceiveOpts(
      parsePerceiveArgs(fopts.args),
      session.lastAction,
      fopts.args,
    );
    await ensurePerceiveTargetReady({ cdp, sessionId, targetId, ops });
    const targetPrefix = targetPrefixForDisplay(targetId);
    popts.targetPrefix = targetPrefix;
    if (popts.sinceAction) popts.diffBaseline = popts.diffBaseline || session.lastAction?.baselineOutput || null;
    const page = await pageInfo(cdp, sessionId, { targetPrefix });
    if (isPdfViewerContentType(page.contentType)) {
      return commandResult(
        fopts.format === 'json'
          ? formatJson(pdfViewerHandoffModel(page, { targetPrefix }))
          : formatPdfViewerOutput(page, { targetPrefix }),
        null,
      );
    }
    let value;
    if (fopts.qa) {
      const consoleHealth = {
        errors: consoleBuf.all().filter(entry => entry.level === 'error').length,
        warnings: consoleBuf.all().filter(entry => entry.level === 'warning' || entry.level === 'warn').length,
        exceptions: exceptionBuf.all().length,
      };
      const pageHealth = await collectHealth(cdp, sessionId).catch(() => null);
      let text = '';
      try {
        text = await perceiveText(cdp, sessionId, consoleBuf, exceptionBuf, refMap, lastPerceiveStore, {
          ...popts,
          interactive: true,
          maxDepth: Math.min(popts.maxDepth || 8, 6),
        }, refState);
      } catch (error) {
        text = error.message || String(error);
      }
      const summary = buildQaSummaryModel({
        page: { title: page.title, url: page.url },
        pageHealth,
        console: consoleHealth,
        network: { failures: countNetworkFailures(netReqBuf) },
        targetPrefix,
        nextCommand: `cdp report ${targetPrefix}`,
        source: 'perceive',
      });
      value = fopts.format === 'json'
        ? formatJson({
            summary,
            perceptionPreview: truncateTextLines(text, fopts.maxDiffLines ?? 20),
          })
        : formatQaSummaryText(summary);
    } else if (popts.cards) {
      value = await perceiveText(cdp, sessionId, consoleBuf, exceptionBuf, refMap, lastPerceiveStore, {
        ...popts,
        format: fopts.format,
      }, refState);
      if (fopts.maxDiffLines != null && fopts.format !== 'json') {
        value = truncateTextLines(value, fopts.maxDiffLines);
      }
    } else {
      value = fopts.format === 'json' && (popts.sinceAction || popts.diff)
        ? formatJson(await buildPerceiveDiff(cdp, sessionId, consoleBuf, exceptionBuf, refMap, lastPerceiveStore, popts, refState))
        : fopts.format === 'json'
        ? formatPerceptionJson(await buildPerceiveModel(cdp, sessionId, consoleBuf, exceptionBuf, refMap, lastPerceiveStore, popts, refState))
        : await perceiveText(cdp, sessionId, consoleBuf, exceptionBuf, refMap, lastPerceiveStore, popts, refState);
      if (fopts.maxDiffLines != null && fopts.format !== 'json') {
        value = truncateTextLines(value, fopts.maxDiffLines);
      }
    }
    return commandResult(value, null);
  };
}

function parseFillArgs(args = []) {
  const fopts = parseCompactFormatArgs(args, ['text', 'json']);
  let react = false;
  const positional = [];
  for (const token of fopts.args) {
    if (token === '--react') {
      react = true;
      continue;
    }
    if (token === '--help' || token === '-h') {
      const err = new Error('fill: help requested');
      err.code = 'help_requested';
      err.helpTopic = 'fill';
      throw err;
    }
    if (String(token).startsWith('--')) {
      throw new Error(`fill: unknown argument ${token}`);
    }
    positional.push(token);
  }
  const selector = positional[0] || '';
  const text = positional.slice(1).join(' ');
  return {
    format: fopts.format,
    compact: fopts.compact,
    qa: fopts.qa,
    full: fopts.full,
    maxDiffLines: fopts.maxDiffLines,
    react,
    selector,
    text,
    args: positional,
    fopts: { ...fopts, args: positional },
  };
}

function parseClickArgs(args = []) {
  const fopts = parseCompactFormatArgs(args, ['text', 'json']);
  let js = false;
  const positional = [];
  for (const token of fopts.args) {
    if (token === '--js' || token === '-j') {
      js = true;
      continue;
    }
    if (token === '--help' || token === '-h') {
      const err = new Error('click: help requested');
      err.code = 'help_requested';
      err.helpTopic = 'click';
      throw err;
    }
    if (String(token).startsWith('--')) {
      throw new Error(`click: unknown argument ${token}`);
    }
    positional.push(token);
  }
  return {
    format: fopts.format,
    compact: fopts.compact,
    qa: fopts.qa,
    full: fopts.full,
    maxDiffLines: fopts.maxDiffLines,
    js,
    selector: positional[0] || '',
    args: positional,
    fopts: { ...fopts, args: positional },
  };
}

function createClickCommandHandler({ actionFeedback, click, jsClick }) {
  return async ({ args }) => {
    const parsed = parseClickArgs(args);
    const selector = parsed.selector;
    const value = parsed.js
      ? await actionFeedback(
        'click',
        () => jsClick(selector),
        {
          input: selector,
          resolvedBy: 'selector-or-ref',
          label: selector || '',
          commandArgs: ['--js', selector],
        },
        'settle-diff',
        null,
        parsed.fopts
      )
      : await actionFeedback(
        'click',
        () => click(selector),
        {
          input: selector,
          resolvedBy: 'selector-or-ref',
          label: selector || '',
          commandArgs: [selector],
        },
        'settle-diff',
        null,
        parsed.fopts
      );
    return commandResult(value, { kind: 'action-receipt' });
  };
}

function createEvalrawCommandHandler({ evalRaw }) {
  return async ({ args, authorization }) => {
    const method = args[0];
    const value = await evalRaw(method, args[1], authorization);
    return commandResult(value, {
      kind: 'raw-audit',
      method,
      sideEffectClass: classifyRawCdpMethod(method),
    });
  };
}

function authorizeDaemonApplicationCommand({ command, args = [], policy, mutates, targetBound }) {
  if (!targetBound) return { allowed: false, code: 'target-not-bound' };
  const actionMutates = ['dialog', 'hover', 'keepalive', 'loadall'].includes(command)
    ? mutates === false
    : mutates === true;
  const tablePolicyMatches = command === 'table' && policy === 'conditional' && mutates === false;
  if (tablePolicyMatches) parseTableArgs(args);
  const allowed = ([
    'back', 'click', 'clickxy', 'clock', 'closetab', 'dismiss-modal', 'fill', 'forward', 'hover',
    'cookiedel', 'cookieset', 'dialog', 'emulate', 'jsclick', 'keepalive', 'mock',
    'inject', 'loadall', 'nav', 'press', 'qa', 'reload', 'responsive-audit', 'restore', 'scroll',
    'select', 'throttle', 'type', 'upload', 'verify-click', 'viewport',
  ].includes(command)
      && policy === 'mutation' && actionMutates)
    || (['console', 'diff-shot', 'fullshot', 'netlog', 'record', 'shot'].includes(command)
      && policy === 'conditional' && mutates === false)
    || tablePolicyMatches
    || (['batch', 'flow', 'repeat'].includes(command)
      && policy === 'composite' && mutates === false)
    || (command === 'replay' && policy === 'mutation' && mutates === true)
    || (['eval', 'eval64', 'call'].includes(command)
      && policy === 'raw-script' && mutates === false)
    || (command === 'evalraw' && policy === 'raw-cdp' && mutates === false)
    || (['components', 'checkpoint', 'cookies'].includes(command)
      && policy === 'sensitive-read' && mutates === false);
  return allowed
    ? { allowed: true, code: 'daemon-application' }
    : { allowed: false, code: 'policy-denied' };
}

async function executeDaemonApplicationRoute(requestInput, context, execution = undefined) {
  inspectCommandDispatcher(context);
  const request = snapshotApplicationDataObject(requestInput, 'daemon route request');
  const expectedKeys = new Set(['cmd', 'args', 'targetBound']);
  for (const key of Object.keys(request)) {
    if (!expectedKeys.has(key)) throw new Error(`daemon route request.${key}: is not allowed`);
  }
  for (const key of expectedKeys) {
    if (!Object.hasOwn(request, key)) throw new Error(`daemon route request.${key}: is required`);
  }
  const route = await context.execute({
    name: request.cmd,
    args: request.args,
    targetBound: request.targetBound,
  }, execution);
  const semantics = classifyCommandResultSemantics(
    { ok: true, result: route.result },
    { command: request.cmd },
  );
  if (!semantics.ok) {
    return {
      handled: route.handled,
      ok: false,
      result: route.result,
      error: semantics.error,
    };
  }
  return {
    handled: route.handled,
    result: route.result,
  };
}

const NEEDS_TARGET = new Set(
  COMMANDS
    .filter(command => command.needsTarget)
    .flatMap(command => [command.name, ...command.aliases])
);

function editDistance(a, b) {
  const s = String(a || '');
  const t = String(b || '');
  const rows = s.length + 1;
  const cols = t.length + 1;
  const dp = Array.from({ length: rows }, () => Array(cols).fill(0));
  for (let i = 0; i < rows; i++) dp[i][0] = i;
  for (let j = 0; j < cols; j++) dp[0][j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[s.length][t.length];
}

function suggestCommands(input, { limit = 3, maxDistance = 2 } = {}) {
  const needle = String(input || '').trim().toLowerCase();
  if (!needle) return [];
  // Exact alias → suggest the canonical command name.
  const exact = commandMeta(needle);
  if (exact && exact.name !== needle) return [exact.name];

  const scored = [];
  for (const command of COMMANDS) {
    const candidates = [command.name, ...(command.aliases || [])];
    let best = Infinity;
    for (const name of candidates) {
      if (name === needle) { best = 0; break; }
      let score = editDistance(needle, name);
      if (name.startsWith(needle) || needle.startsWith(name)) score = Math.min(score, 1);
      if (name.includes(needle) || needle.includes(name)) score = Math.min(score, 2);
      best = Math.min(best, score);
    }
    if (best > 0 && best <= maxDistance) scored.push({ name: command.name, score: best });
  }
  scored.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
  return scored.slice(0, limit).map(entry => entry.name);
}

function unknownCommandMessage(cmd) {
  const suggestions = suggestCommands(cmd);
  const base = `Unknown command: ${cmd}`;
  if (!suggestions.length) return base;
  return `${base}\nDid you mean: ${suggestions.join(' / ')}?`;
}

function parseTargetAndCommandArgs(cmd, args) {
  let targetPrefix = args[0];
  let cmdArgs = args.slice(1);
  if (cmd === 'wait' && /^\d+$/.test(args[0] || '') && args[1] && !/^\d+$/.test(args[1] || '')) {
    targetPrefix = args[1];
    cmdArgs = [args[0], ...args.slice(2)];
  }
  return { targetPrefix, cmdArgs };
}

function detectCliErrorFormat(args = []) {
  try {
    return parseFormatArgs(args, ['text', 'json']).format;
  } catch {
    return 'text';
  }
}

function targetCommandCliErrorFormat(targetPrefix, cmdArgs = [], originalArgs = []) {
  const targetLooksLikeFlag = targetPrefix && String(targetPrefix).startsWith('--');
  return detectCliErrorFormat(targetLooksLikeFlag ? originalArgs : cmdArgs);
}

function formatArgSuffix(format, { compact = false, full = false } = {}) {
  return [
    ...(format && format !== 'text' ? ['--format', format] : []),
    ...(compact ? ['--compact'] : []),
    ...(full ? ['--full'] : []),
  ];
}

function normalizeTargetCommandArgs(cmd, cmdArgs = []) {
  const args = [...cmdArgs];
  if (cmd === 'type') {
    const fopts = parseCompactFormatArgs(args, ['text', 'json']);
    return [fopts.args.join(' '), ...formatArgSuffix(fopts.format, fopts)];
  }
  if (cmd === 'fill') {
    const parsed = parseFillArgs(args);
    const suffix = formatArgSuffix(parsed.format, parsed);
    if (parsed.react) return ['--react', parsed.selector, parsed.text, ...suffix];
    return [parsed.selector, parsed.text, ...suffix];
  }
  return args;
}

function commandUsageTemplate(cmd = '', targetPrefix = '') {
  const target = targetPrefix || '<target>';
  switch (cmd) {
    case 'nav':
    case 'navigate':
      return `cdp nav ${target} https://example.com`;
    case 'click':
    case 'jsclick':
      return `cdp ${cmd} ${target} <selector|@ref>`;
    case 'clickxy':
      return `cdp clickxy ${target} <x> <y>`;
    case 'fill':
      return `cdp fill ${target} <selector|@ref> <text>`;
    case 'type':
      return `cdp type ${target} <text>`;
    case 'press':
    case 'key':
      return 'cdp help press';
    case 'elshot':
      return `cdp elshot ${target} <selector|@ref>`;
    case 'eval':
      return 'cdp help eval';
    case 'eval64':
      return `cdp eval64 ${target} <base64-expression>`;
    case 'call':
      return `cdp call ${target} <async-function-expression>`;
    case 'evalraw':
      return `cdp evalraw ${target} <CDP.method> [json]`;
    case 'cookieset':
      return `cdp cookieset ${target} "name=value; domain=.example.com"`;
    case 'cookiedel':
      return `cdp cookiedel ${target} <name>`;
    case 'upload':
      return `cdp upload ${target} <selector> <file-path>`;
    case 'batch':
      return 'cdp help batch';
    case 'flow':
      return `cdp flow ${target} "click @1; wait dom stable; summary"`;
    case 'replay':
      return 'cdp help replay';
    case 'restore':
      return 'cdp help restore';
    case 'inject':
      return `cdp inject ${target} --css "body { outline: 1px solid red }"`;
    case 'stop':
      return 'cdp stop [target|--all]';
    case 'target':
      return 'cdp help target';
    case 'text':
      return 'cdp help text';
    case 'waitfor':
      return 'cdp help waitfor';
    case 'wait':
      return 'cdp help wait';
    case 'repeat':
      return 'cdp help repeat';
    case 'loadall':
      return 'cdp help loadall';
    case 'verify-click':
    case 'verifyclick':
      return 'cdp help verify-click';
    case 'tab-group':
    case 'tabgroup':
      return 'cdp help tab-group';
    case 'select':
      return 'cdp help select';
    case 'forget':
      return 'cdp help forget';
    default:
      return `cdp ${cmd || '<command>'}${targetPrefix ? ` ${target}` : ''} <required-args>`;
  }
}

function jsclickSelectorFromCliError(message, { cmd = '', args = [], err = null } = {}) {
  const fromTarget = String(err?.target?.input || err?.clickSelector || '').trim();
  if (fromTarget && !/^\d+(?:\.\d+)?\s*,\s*\d+/.test(fromTarget)) return fromTarget;
  const fromMessage = String(message || '').match(
    /no mousedown\/click events at \([^)]*\)(?: for (.+?))?\. The mouse path/i
  );
  if (fromMessage?.[1]) return fromMessage[1];
  const cmdName = String(cmd || '').toLowerCase();
  const first = args?.[0];
  if ((cmdName === 'click' || cmdName === 'jsclick') && first && !/^\d+(\.\d+)?$/.test(String(first))) {
    return String(first);
  }
  return '';
}

function buildCliErrorRecovery(message, { cmd = '', targetPrefix = '', platform = process.platform, err = null, args = [] } = {}) {
  const lower = String(message || '').toLowerCase();
  const target = targetPrefix || '<target>';
  if (lower.includes('emfile') || lower.includes('too many open files')) {
    const recovery = fdLimitRecovery({ platform });
    const commands = recovery.commands || [];
    return {
      kind: 'fd-limit',
      strategy: recovery.strategy,
      run: commands[0]?.command || 'ulimit -n 4096',
      then: commands[1]?.command || null,
      reason: 'The process ran out of file descriptors while managing Chrome, sockets, screenshots, or session files.',
      commands,
    };
  }
  if (
    err?.code === 'cdp_unreachable'
    || lower.includes('cannot reach cdp')
    || lower.includes('no devtoolsactiveport')
    || lower.includes('websocket error')
    || lower.includes('remote-debugging-port')
  ) {
    if (err?.profileDir && err?.relaunch) {
      return {
        kind: 'browser-cdp',
        strategy: 'relaunch-same-profile',
        run: err.relaunch,
        reason: 'Chrome debugging endpoint is down. Relaunch the same user-data-dir; do not invent a new profile.',
      };
    }
    if (err?.code === 'cdp_unreachable' || lower.includes('cannot reach cdp')) {
      return {
        kind: 'browser-cdp',
        strategy: 'enable-existing-debugging',
        run: err?.relaunch || 'cdp doctor',
        reason: 'Chrome debugging endpoint is down. Do not invent a new --user-data-dir; enable remote debugging on the existing browser via chrome://inspect/#remote-debugging.',
      };
    }
    return {
      kind: 'browser-cdp',
      strategy: 'run-doctor',
      run: 'cdp doctor',
      reason: 'Chrome is not reachable through the configured debugging endpoint.',
    };
  }
  if (
    err?.code === 'unknown_alias'
    || lower.includes('unknown alias')
  ) {
    return {
      kind: 'target-resolution',
      strategy: 'list-aliases',
      run: 'cdp list',
      then: 'cdp current',
      reason: 'The named alias is not saved. List tabs or inspect current aliases.',
    };
  }
  if (
    lower.includes('target id required') ||
    lower.includes('no page list cached') ||
    lower.includes('no target matching prefix') ||
    lower.includes('no live target matching prefix') ||
    lower.includes('no live target matching alias') ||
    lower.includes('no page matched')
  ) {
    return {
      kind: 'target-resolution',
      strategy: 'rediscover-target',
      run: 'cdp list  # if empty: cdp open https://example.com',
      then: 'cdp open https://example.com',
      reason: 'The requested tab target could not be resolved from the current page list.',
    };
  }
  if (
    lower.includes('ambiguous prefix')
    || lower.includes('is ambiguous')
    || lower.includes('pages matched')
    || /target:\s+\d+\s+pages matched/i.test(message)
  ) {
    return {
      kind: 'target-resolution',
      strategy: 'choose-longer-prefix',
      run: 'cdp list  # copy a longer target prefix',
      reason: 'More than one tab matches the provided target prefix.',
    };
  }
  if (cmd === 'target' && (lower.includes('provide --url') || lower.includes('and/or --title'))) {
    return {
      kind: 'usage',
      strategy: 'show-help',
      run: 'cdp help target',
      reason: 'target requires --url and/or --title. Print usage instead of probing doctor.',
    };
  }
  if (
    (cmd === 'press' || cmd === 'key')
    && (lower.includes('unknown key') || lower.includes('key name required'))
  ) {
    return {
      kind: 'usage',
      strategy: 'show-help',
      run: 'cdp help press',
      reason: 'press requires a supported key name. Print usage instead of wrapping as an unclassified action failure.',
    };
  }
  if (
    (cmd === 'wait' || lower.includes('wait duration'))
    && (
      lower.includes('wait duration')
      || lower.includes('positive integer')
      || lower.includes('at least')
    )
  ) {
    return {
      kind: 'usage',
      strategy: 'show-help',
      run: 'cdp help wait',
      reason: 'wait requires a positive millisecond duration. Print usage instead of probing doctor/status.',
    };
  }
  if (
    (cmd === 'repeat'
      || lower.includes('repeat requires')
      || lower.includes('repeat: count')
      || lower.includes('repeat: command name required'))
    && (
      lower.includes('repeat requires')
      || lower.includes('count must be a positive integer')
      || lower.includes('command name required')
      || lower.includes('exceeds cap')
    )
  ) {
    return {
      kind: 'usage',
      strategy: 'show-help',
      run: 'cdp help repeat',
      reason: 'repeat requires a positive count and a command. Print usage instead of probing status.',
    };
  }
  if (
    (cmd === 'verify-click' || cmd === 'verifyclick' || lower.includes('verify-click:'))
    && (
      lower.includes('requires')
      || lower.includes('exactly one selector')
      || lower.includes('unknown argument')
    )
  ) {
    return {
      kind: 'usage',
      strategy: 'show-help',
      run: 'cdp help verify-click',
      reason: 'verify-click needs a selector and paired network assertions. --expect-status alone is not a check.',
    };
  }
  if (
    (cmd === 'restore' || cmd === 'replay'
      || lower.includes('restore:')
      || lower.includes('replay:'))
    && (
      lower.includes('enoent')
      || lower.includes('no such file')
      || lower.includes('unsupported') && lower.includes('schema')
      || lower.includes('requires --file')
      || lower.includes('requires --json')
      || lower.includes('invalid checkpoint')
      || lower.includes('invalid json artifact')
      || lower.includes('artifact must be')
      || lower.includes('checkpoint artifact must')
    )
  ) {
    const helpCmd = cmd === 'replay' || lower.includes('replay') ? 'replay' : 'restore';
    return {
      kind: 'usage',
      strategy: 'show-help',
      run: `cdp help ${helpCmd}`,
      reason: `${helpCmd} needs an existing artifact with a supported schema. Missing files are local usage, not a page failure.`,
    };
  }
  if (
    (cmd === 'diff-shot' || cmd === 'diffshot' || lower.includes('diff-shot:'))
    && (
      lower.includes('timed out')
      || lower.includes('untrusted')
      || lower.includes('capture timed out')
      || lower.includes('timeout: page.capturescreenshot')
    )
  ) {
    return {
      kind: 'timeout',
      strategy: 'retry-or-use-shot',
      run: 'cdp help diff-shot',
      reason: 'Screenshot capture timed out. Do not treat a missing capture as 0% changed.',
    };
  }
  if (
    (cmd === 'tab-group' || cmd === 'tabgroup' || cmd === 'broadcast')
    && (lower.includes('unknown group') || lower.includes('unknown action'))
  ) {
    return {
      kind: 'usage',
      strategy: 'show-help',
      run: cmd === 'broadcast' ? 'cdp help broadcast' : 'cdp tab-group list',
      reason: 'The named tab group is not stored. List groups instead of probing doctor.',
    };
  }
  if (
    (cmd === 'select' || lower.includes('not a <select>') || lower.includes('no option value'))
    && (
      lower.includes('not a <select>')
      || lower.includes('no option value')
      || lower.includes('css selector required')
      || lower.includes('value required')
    )
  ) {
    return {
      kind: 'usage',
      strategy: 'show-help',
      run: 'cdp help select',
      reason: 'select requires a <select> control and an existing option value.',
    };
  }
  if (
    (cmd === 'upload' || lower.includes('upload:'))
    && (
      lower.includes('file not found')
      || lower.includes('not a readable file')
      || lower.includes('is not an <input type="file">')
    )
  ) {
    return {
      kind: 'usage',
      strategy: 'show-help',
      run: 'cdp help upload',
      reason: 'upload requires an existing readable file and a file input. Do not plant a ghost file.',
    };
  }
  if (
    (cmd === 'cookiedel' || lower.includes('cookie not found') || lower.includes('cookie still present'))
    && (lower.includes('cookie not found') || lower.includes('cookie still present'))
  ) {
    return {
      kind: 'usage',
      strategy: 'show-help',
      run: targetPrefix ? `cdp cookies ${targetPrefix}` : 'cdp help cookiedel',
      reason: lower.includes('cookie still present')
        ? 'The named cookie is still present after delete. Do not claim deletion.'
        : 'The named cookie is not present. List cookies instead of claiming a delete.',
    };
  }
  if (
    lower.includes('unknown option')
    || lower.includes('unknown argument')
    || lower.includes('unknown flag')
  ) {
    return {
      kind: 'usage',
      strategy: 'show-help',
      run: cmd ? `cdp help ${cmd}` : 'cdp help',
      reason: 'The command received an unknown flag or argument. Print usage instead of probing doctor/status.',
    };
  }
  if (
    (cmd === 'eval' || cmd === 'eval64' || cmd === 'call')
    && /syntaxerror|referenceerror|typeerror|evalerror|rangeerror|urierror/i.test(message)
  ) {
    return {
      kind: 'eval',
      strategy: 'fix-expression',
      run: 'cdp help eval',
      reason: 'The JavaScript expression threw. Fix the expression; the tab is still live.',
    };
  }
  if (err?.code === 'pdf_viewer' || lower.includes('pdf viewer') || lower.includes('application/pdf')) {
    return {
      kind: 'pdf-viewer',
      strategy: 'do-not-probe-ax',
      run: `cdp eval ${target} "document.contentType"`,
      reason: 'Chrome PDF viewer has no accessibility tree. text/perceive cannot extract the PDF body.',
    };
  }
  if (
    lower.includes('target closed') ||
    lower.includes('target destroyed') ||
    lower.includes('inspector.detached') ||
    lower.includes('detached from target') ||
    lower.includes('no target with given id') ||
    lower.includes('session closed') ||
    lower.includes('page, context or browser has been closed')
  ) {
    return {
      kind: 'target-closed',
      strategy: 'rediscover-target',
      run: 'cdp list',
      then: 'cdp open https://example.com',
      reason: 'The tab target appears to be closed, detached, or no longer present in Chrome.',
    };
  }
  if (lower.includes('stale daemon')) {
    const staleTarget = targetPrefix || String(message || '').match(/stale daemon for\s+([A-Za-z0-9_-]+)/i)?.[1] || '<target>';
    return {
      kind: 'stale-daemon',
      strategy: 'restart-target-daemon',
      run: `cdp stop ${staleTarget}`,
      then: 'rerun the original command',
      reason: `The per-target daemon was started from an older checkout or cannot report metadata; restart it before using this target. Use ${ALLOW_STALE_DAEMON_FLAG} only for intentional long-running daemon sessions.`,
    };
  }
  if (
    lower.includes('connection closed before response') ||
    lower.includes('econnrefused') ||
    lower.includes('connect enoent') ||
    lower.includes('connect econnreset') ||
    lower.includes('timed out connecting to daemon socket') ||
    lower.includes('daemon failed to start') ||
    lower.includes('ipc timeout')
  ) {
    return {
      kind: 'daemon-disconnect',
      strategy: 'restart-tab-daemon',
      run: `cdp perceive ${target} -C -d 8`,
      reason: 'The per-tab daemon did not return a usable response.',
    };
  }
  if (lower.includes('unknown command')) {
    const guessed = String(message || '').match(/unknown command:\s*(\S+)/i)?.[1]
      || cmd
      || '';
    const suggestions = suggestCommands(guessed);
    if (suggestions.length) {
      return {
        kind: 'usage',
        strategy: 'suggest-command',
        run: `cdp ${suggestions[0]}`,
        reason: `Did you mean: ${suggestions.join(' / ')}? Run \`cdp help ${suggestions[0]}\` for usage.`,
      };
    }
    return {
      kind: 'usage',
      strategy: 'show-help',
      run: 'cdp help',
      reason: 'The command name does not match the registered CLI commands.',
    };
  }
  if ((cmd === 'nav' || cmd === 'navigate') && lower.includes('url required')) {
    return {
      kind: 'navigation',
      strategy: 'provide-url',
      run: `cdp nav ${target} https://example.com`,
      reason: 'Navigation commands need an explicit http or https URL.',
    };
  }
  if (cmd && lower.includes('required')) {
    return {
      kind: 'usage',
      strategy: 'provide-required-argument',
      run: commandUsageTemplate(cmd, targetPrefix),
      reason: 'The command is missing required input; provide the required argument instead of retrying unchanged.',
    };
  }
  if (
    (cmd === 'waitfor' && (lower.includes('timeout') || lower.includes('not found within') || lower.includes('still present') || lower.includes('did not stabilise')))
    || /timeout:\s*.+\bnot found within\b/i.test(message)
    || /timeout:\s*.+\bstill present after\b/i.test(message)
    || /timeout:\s*.+\bdid not stabilise\b/i.test(message)
  ) {
    return {
      kind: 'timeout',
      strategy: 'adjust-wait',
      run: 'cdp help waitfor',
      reason: 'The wait condition was not met before the timeout. Increase the bound or use --text / --any-of; the tab is still live.',
    };
  }
  if (
    lower.includes('assertion failed')
    || (cmd === 'flow' && lower.includes('flow halted') && lower.includes('assert'))
  ) {
    return {
      kind: 'assertion',
      strategy: 'inspect-assertion',
      run: 'cdp help flow',
      reason: 'A flow assertion did not hold. The page is still live; inspect the selector or text, or run perceive.',
    };
  }
  if (lower.includes('unknown wait:')) {
    return {
      kind: 'usage',
      strategy: 'show-help',
      run: 'cdp help flow',
      reason: 'flow wait only accepts "dom stable" or "network idle". Print usage instead of probing status.',
    };
  }
  if (lower.includes('batch --parallel:')) {
    return {
      kind: 'usage',
      strategy: 'show-help',
      run: 'cdp help batch',
      reason: 'batch --parallel only runs read-only/extraction commands. Use sequential batch or flow for mutations.',
    };
  }
  if (
    cmd === 'loadall'
    && (
      lower.includes('still present')
      || lower.includes('aborted')
      || (lower.includes('timeout') && !lower.includes('element not found'))
    )
  ) {
    return {
      kind: 'timeout',
      strategy: 'show-help',
      run: 'cdp help loadall',
      reason: 'loadall stopped before the control disappeared. [interval-ms] is the click interval; pass --timeout-ms to raise the cap.',
    };
  }
  if (
    (cmd === 'loadall' || cmd === 'click' || cmd === 'jsclick')
    && (lower.includes('element not found') || lower.includes('css selector required'))
  ) {
    return {
      kind: cmd === 'loadall' && lower.includes('css selector required') ? 'usage' : 'selector',
      strategy: cmd === 'loadall' && lower.includes('css selector required') ? 'show-help' : 'refresh-perception',
      run: lower.includes('css selector required')
        ? 'cdp help loadall'
        : (targetPrefix ? `cdp perceive ${targetPrefix} -C -d 8` : 'cdp help loadall'),
      reason: 'No current element matched the selector. A missing load-more control is not a successful disappear.',
    };
  }
  if (
    lower.includes('received no mousedown/click events')
    || (lower.includes('mouse path failed closed') && lower.includes('jsclick'))
  ) {
    const selector = jsclickSelectorFromCliError(message, { cmd, args, err });
    return {
      kind: 'no-input-events',
      strategy: 'use-jsclick',
      run: (targetPrefix && selector)
        ? `cdp jsclick ${targetPrefix} ${selector}`
        : 'cdp help click',
      reason: 'The realistic mouse click did not deliver page events. Retry with jsclick instead of treating dispatch.ok as success.',
    };
  }
  if (lower.includes('did not navigate') || (lower.includes('try jsclick') && lower.includes('<a href'))) {
    return {
      kind: 'no-navigation',
      strategy: 'use-jsclick',
      run: targetPrefix ? `cdp jsclick ${targetPrefix} a` : 'cdp help click',
      reason: 'The realistic mouse click dispatched but the link default action did not run.',
    };
  }
  return lower.includes('target/document readiness mismatch') ? perceiveReadinessRecovery(target)
    : targetPrefix ? {
        kind: 'unknown',
        strategy: 'inspect-status',
        run: `cdp status ${targetPrefix}`,
        reason: 'The failure was not classified; inspect the target status before retrying.',
      }
    : {
        kind: 'unknown',
        strategy: 'run-doctor',
        run: 'cdp doctor',
        reason: 'The failure was not classified; check browser setup and available targets.',
      };
}

function formatCliErrorRecovery(recovery) {
  const lines = [
    'Recovery:',
    `  Kind: ${recovery.kind}`,
    `  Strategy: ${recovery.strategy}`,
    `  Run: ${recovery.run}`,
  ];
  if (recovery.then) lines.push(`  Then: ${recovery.then}`);
  if (recovery.reason) lines.push(`  Reason: ${recovery.reason}`);
  return lines;
}

function cliErrorMessage(err) {
  return String(err?.message || err || '').trim() || 'unknown failure';
}

function buildCliErrorModel(err, { cmd = '', targetPrefix = '', platform = process.platform, args = [] } = {}) {
  const completionUnknown = err?.code === 'DAEMON_COMPLETION_UNKNOWN'
    && err?.completion === 'unknown'
    && err?.sideEffectMayHaveOccurred === true;
  const message = completionUnknown
    ? 'The daemon did not return a validated Action Result. The action may have taken effect; do not repeat it until page state is verified.'
    : cliErrorMessage(err);
  const target = targetPrefix || '<target>';
  const recovery = completionUnknown
    ? {
        kind: 'ambiguous-action-completion',
        strategy: 'verify-before-retry',
        run: `cdp perceive ${target} -C -d 8`,
        reason: 'The action may have occurred. Inspect current page state first; do not repeat the action until its effect is verified.',
      }
      : buildCliErrorRecovery(message, { cmd, targetPrefix, platform, err, args });
  const nextSteps = [];
  const commandSteps = Array.isArray(recovery.commands) && recovery.commands.length
    ? recovery.commands.map(command => command?.command).filter(Boolean)
    : [recovery.run, recovery.then];
  for (const step of commandSteps) {
    if (step && !nextSteps.includes(step)) nextSteps.push(step);
  }
  const model = {
    schema: 'chrome-cdp-ex.cli-error.v1',
    ok: false,
    command: cmd || null,
    targetPrefix: targetPrefix || null,
    error: { message },
    recovery,
    nextSteps,
  };
  if (err?.code === 'cdp_unreachable' || recovery.strategy === 'relaunch-same-profile' || recovery.strategy === 'enable-existing-debugging') {
    if (err?.code === 'cdp_unreachable' || /cannot reach cdp/i.test(message)) {
      model.error.code = 'cdp_unreachable';
      model.host = err?.host || null;
      model.port = err?.port || null;
      model.profileDir = err?.profileDir ?? null;
      model.relaunch = err?.relaunch ?? null;
    }
  }
  if (completionUnknown) {
    model.completion = 'unknown';
    model.sideEffectMayHaveOccurred = true;
    model.retrySafe = false;
    model.diagnostics = {
      transport: {
        phase: err.transportCause?.phase || 'awaiting-response',
        kind: err.transportCause?.kind || 'unknown',
        message: String(err.transportCause?.message || 'unknown transport failure').slice(0, 512),
        ...(err.transportCause?.code ? { code: String(err.transportCause.code).slice(0, 64) } : {}),
      },
    };
  }
  return model;
}

function formatCliError(err, { cmd = '', targetPrefix = '', format = 'text', platform = process.platform, args = [] } = {}) {
  if (format === 'json') return formatJson(buildCliErrorModel(err, { cmd, targetPrefix, platform, args }));
  if (err?.code === 'DAEMON_COMPLETION_UNKNOWN') {
    const model = buildCliErrorModel(err, { cmd, targetPrefix, platform, args });
    return [
      `Error: ${model.error.message}`,
      'Completion: unknown',
      'Side effect may have occurred: yes',
      'Retry safe: no',
      ...formatCliErrorRecovery(model.recovery),
      `Transport: ${model.diagnostics.transport.phase}/${model.diagnostics.transport.kind}: ${model.diagnostics.transport.message}`,
      `Next: ${model.recovery.run}`,
    ].join('\n');
  }
  const message = String(err?.message || err || '').trim();
  if (!message) {
    const recovery = buildCliErrorRecovery('unknown failure', { cmd, targetPrefix, platform, args });
    return ['Error: unknown failure', ...formatCliErrorRecovery(recovery), `Next: ${recovery.run}`].join('\n');
  }
  if (message.startsWith('Action failure:')) return message;
  const lines = [message.startsWith('Error:') ? message : `Error: ${message}`];
  if (/^Next:/m.test(message)) return lines.join('\n');

  const recovery = buildCliErrorRecovery(message, { cmd, targetPrefix, platform, err, args });
  lines.push(...formatCliErrorRecovery(recovery));
  lines.push(`Next: ${recovery.run}`);
  return lines.join('\n');
}

function formatDaemonCommandError(err, options = {}) {
  const model = options.format === 'json' && options.cmd === 'flow'
    ? maybeParseJson(cliErrorMessage(err))
    : null;
  if (model?.schema === 'chrome-cdp-ex.flow.v1' && model.halted === true) {
    return formatJson(model);
  }
  return formatCliError(err, options);
}

function argsWithoutFormat(args = []) {
  try {
    return parseFormatArgs(args, ['text', 'json']).args;
  } catch {
    return args;
  }
}

function targetPrefixForDisplay(targetId) {
  return String(targetId || '').slice(0, 8) || '<target>';
}

function parseNonNegativeInteger(value, label) {
  const raw = String(value ?? '').trim();
  if (!/^\d+$/.test(raw)) throw new Error(`${label} must be a non-negative integer`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative integer`);
  return parsed;
}

function parseOpenArgs(args = []) {
  const fopts = parseFormatArgs(args, ['text', 'json']);
  const positional = [];
  let attachTimeoutMs = DEFAULT_OPEN_ATTACH_TIMEOUT_MS;
  let readyTimeoutMs = null;
  let readySelector = null;
  let reuseUrl = false;
  let perceive = false;
  for (let i = 0; i < fopts.args.length; i++) {
    const token = fopts.args[i];
    if (token === '--attach-timeout-ms') {
      attachTimeoutMs = parseNonNegativeInteger(fopts.args[++i], 'open: --attach-timeout-ms');
    } else if (String(token).startsWith('--attach-timeout-ms=')) {
      attachTimeoutMs = parseNonNegativeInteger(String(token).slice('--attach-timeout-ms='.length), 'open: --attach-timeout-ms');
    } else if (token === '--ready-timeout-ms') {
      readyTimeoutMs = parseNonNegativeInteger(fopts.args[++i], 'open: --ready-timeout-ms');
    } else if (String(token).startsWith('--ready-timeout-ms=')) {
      readyTimeoutMs = parseNonNegativeInteger(String(token).slice('--ready-timeout-ms='.length), 'open: --ready-timeout-ms');
    } else if (token === '--ready-selector') {
      readySelector = fopts.args[++i];
      if (!readySelector) throw new Error('open: --ready-selector requires a CSS selector');
    } else if (String(token).startsWith('--ready-selector=')) {
      readySelector = String(token).slice('--ready-selector='.length);
      if (!readySelector) throw new Error('open: --ready-selector requires a CSS selector');
    } else if (token === '--reuse-url') {
      reuseUrl = true;
    } else if (token === '--perceive') {
      perceive = true;
    } else if (String(token).startsWith('-')) {
      throw new Error(`open: unknown argument ${token}`);
    } else {
      positional.push(token);
    }
  }
  if (positional.length > 1) throw new Error(`open: unknown argument ${positional[1]}`);
  return {
    url: positional[0] || 'about:blank',
    format: fopts.format,
    attachTimeoutMs,
    readyTimeoutMs: readyTimeoutMs ?? (attachTimeoutMs > 0 ? DEFAULT_OPEN_READY_TIMEOUT_MS : 0),
    readySelector,
    reuseUrl,
    perceive,
  };
}

function openReadyProbeScript(selector = null) {
  return `JSON.stringify({ href: location.href, readyState: document.readyState, selectorFound: ${selector ? `Boolean(document.querySelector(${JSON.stringify(selector)}))` : 'true'} })`;
}

async function waitForOpenReady(targetId, {
  timeoutMs = DEFAULT_OPEN_READY_TIMEOUT_MS,
  url = '',
  selector = null,
  createCdp = () => new CDP(),
  getWsUrlFn = getWsUrl,
} = {}) {
  const timeout = Math.min(Math.max(timeoutMs, 0), 300000);
  if (timeout <= 0) {
    return { attempted: false, ok: false, reason: 'disabled', href: null, readyState: null, selector, selectorFound: false, timeoutMs: timeout };
  }
  const deadline = Date.now() + timeout;
  let lastState = null;
  while (true) {
    const cdp = createCdp();
    try {
      const probeTimeoutMs = Math.min(1000, Math.max(100, deadline - Date.now()));
      await cdp.connect(await getWsUrlFn());
      const attached = await cdpDomains(cdp).Target.attachToTarget( { targetId, flatten: true }, undefined, probeTimeoutMs);
      const result = await cdpDomains(cdp).Runtime.evaluate( {
        expression: openReadyProbeScript(selector),
        returnByValue: true,
        awaitPromise: false,
      }, attached.sessionId, probeTimeoutMs);
      if (result.exceptionDetails) {
        throw new Error(runtimeExceptionMessage(result.exceptionDetails));
      }
      const raw = result.result?.value ?? '{}';
      try {
        lastState = typeof raw === 'string' ? JSON.parse(raw) : raw;
      } catch {
        lastState = { href: null, readyState: String(raw || '').trim() || null };
      }
      const readyState = lastState?.readyState || null;
      const href = lastState?.href || null;
      const selectorReady = lastState?.selectorFound === true;
      const urlReady = !url || url === 'about:blank' || href === url;
      if (urlReady && selectorReady && /^(interactive|complete)$/.test(readyState || '')) {
        return { attempted: true, ok: true, href, readyState, selector, selectorFound: true, timeoutMs: timeout };
      }
    } catch (e) {
      lastState = { error: e.message || String(e) };
    } finally {
      try { cdp.close(); } catch {}
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await sleep(Math.min(100, remainingMs));
  }
  return { attempted: true, ok: false, href: lastState?.href || null, readyState: lastState?.readyState || null, selector, selectorFound: lastState?.selectorFound === true, error: lastState?.error || null, timeoutMs: timeout };
}

function openNavigationScript(url) {
  return `(function() {
    location.assign(${JSON.stringify(url)});
    return JSON.stringify({ method: 'location.assign', target: ${JSON.stringify(url)} });
  })()`;
}

async function waitForOpenTargetUrl(targetId, url, timeoutMs = 1000, {
  createCdp = () => new CDP(),
  getWsUrlFn = getWsUrl,
  now = Date.now,
  sleepFn = sleep,
} = {}) {
  if (!url || url === 'about:blank') return { ok: true, href: 'about:blank' };
  const deadline = now() + Math.max(0, timeoutMs);
  let lastHref = null;
  let lastError = null;
  while (now() <= deadline) {
    const cdp = createCdp();
    try {
      await cdp.connect(await getWsUrlFn());
      const { targetInfos } = await cdpDomains(cdp).Target.getTargets( {}, undefined, Math.min(1000, Math.max(100, deadline - now() + 100)));
      const target = (targetInfos || []).find(t => t.targetId === targetId);
      lastHref = target?.url || null;
      if (lastHref === url) return { ok: true, href: lastHref };
    } catch (e) {
      lastError = e.message || String(e);
    } finally {
      try { cdp.close(); } catch {}
    }
    const remainingMs = deadline - now();
    if (remainingMs <= 0) break;
    await sleepFn(Math.min(100, remainingMs));
  }
  return { ok: false, href: lastHref, error: lastError };
}

async function navigateOpenTarget(targetId, sp, url, {
  createCdp = () => new CDP(),
  getWsUrlFn = getWsUrl,
  waitForOpenTargetUrlFn = waitForOpenTargetUrl,
  connectToSocketFn = connectToSocket,
  sendCommandFn = sendCommand,
} = {}) {
  if (!url || url === 'about:blank') return { attempted: false, ok: true, reason: 'about:blank' };
  const attempts = [];
  const initialUrl = await waitForOpenTargetUrlFn(targetId, url, 1500);
  if (initialUrl.ok) {
    return { attempted: true, ok: true, method: 'Target.createTarget', href: initialUrl.href, error: null };
  }
  const cdp = createCdp();
  try {
    await cdp.connect(await getWsUrlFn());
    await cdpDomains(cdp).Target.activateTarget( { targetId }, undefined, 5000).catch(() => {});
    const attached = await cdpDomains(cdp).Target.attachToTarget( { targetId, flatten: true }, undefined, 5000);
    const sid = attached.sessionId;
    await cdpDomains(cdp).Page.enable( {}, sid, 2000).catch(() => {});
    try {
      const nav = await cdpDomains(cdp).Page.navigate( { url }, sid, 5000);
      if (nav?.errorText) throw new Error(nav.errorText);
      return { attempted: true, ok: true, method: 'Page.navigate', error: null };
    } catch (e) {
      attempts.push({ method: 'Page.navigate', error: e.message || String(e) });
    }
    try {
      await cdpDomains(cdp).Runtime.evaluate( {
        expression: openNavigationScript(url),
        returnByValue: false,
        awaitPromise: false,
      }, sid, 5000);
      return { attempted: true, ok: true, method: 'Runtime.evaluate location.assign', error: null, attempts };
    } catch (e) {
      attempts.push({ method: 'Runtime.evaluate location.assign', error: e.message || String(e) });
    }
  } catch (e) {
    attempts.push({ method: 'direct-cdp', error: e.message || String(e) });
  } finally {
    try { cdp.close(); } catch {}
  }

  const afterDirectUrl = await waitForOpenTargetUrlFn(targetId, url, 1500);
  if (afterDirectUrl.ok) {
    return { attempted: true, ok: true, method: 'Target.url-observed', href: afterDirectUrl.href, attempts, error: null };
  }

  let conn = null;
  try {
    conn = await connectToSocketFn(sp);
    const resp = await sendCommandFn(conn, { cmd: 'eval', args: [openNavigationScript(url)] });
    return {
      attempted: true,
      ok: resp.ok === true,
      method: 'daemon eval location.assign',
      attempts,
      error: resp.ok ? null : (resp.error || 'navigation failed'),
    };
  } catch (e) {
    attempts.push({ method: 'daemon eval location.assign', error: e.message || String(e) });
    const afterDaemonUrl = await waitForOpenTargetUrlFn(targetId, url, 1500);
    if (afterDaemonUrl.ok) {
      return { attempted: true, ok: true, method: 'Target.url-observed', href: afterDaemonUrl.href, attempts, error: null };
    }
    return { attempted: true, ok: false, method: 'daemon eval location.assign', attempts, error: e.message || String(e) };
  } finally {
    try { conn?.end(); } catch {}
  }
}

function formatOpenNextPerceiveCommand(targetId) {
  return `Next: cdp text ${targetPrefixForDisplay(targetId)} --auto`;
}

function formatOpenAttachWaitMessage(timeoutMs) {
  return `Waiting for "Allow debugging?" approval in Chrome... (up to ${formatDuration(timeoutMs)})`;
}

function shouldAnnounceOpenAttachWait({ failedConnects = 0, elapsedMs = 0 } = {}) {
  return failedConnects >= 3 || elapsedMs >= 1000;
}

function formatOpenReadyMessage(targetId, url = '') {
  const target = targetPrefixForDisplay(targetId);
  const lines = [
    'Tab ready — debugging approved.',
    `Target: ${target}${url ? `  ${url}` : ''}`,
    `Next: cdp click ${target} @ref  # choose a ref from the perception below`,
    `Then: cdp perceive ${target} --since-action`,
    `Report: cdp report ${target}`,
  ];
  return lines.join('\n');
}

function buildOpenModel({ targetId, url = '', attached = false, autoPerceive = null, ready = null, navigation = null } = {}) {
  const target = targetPrefixForDisplay(targetId);
  const approved = attached === true;
  const defaultAutoPerceive = approved
    ? { attempted: false, ok: false, reason: 'not-run' }
    : { attempted: false, ok: false, reason: 'not-attached' };
  const autoPerceiveModel = autoPerceive || defaultAutoPerceive;
  const recommendation = approved && autoPerceiveModel.ok
    ? goldenPathActRecommendation(target, { fromPerceptionBelow: true })
    : approved
    ? goldenPathReadPageRecommendation(target)
    : goldenPathBrowserPermissionRecommendation(target);
  const nextSteps = recommendation.commands;
  return {
    schema: 'chrome-cdp-ex.open.v1',
    targetId,
    targetPrefix: target,
    url,
    attached: approved,
    approval: approved ? 'approved' : 'pending',
    navigation,
    ready,
    autoPerceive: autoPerceiveModel,
    recommendation,
    nextSteps,
  };
}

function formatOpenTimeoutMessage(targetId) {
  const target = targetPrefixForDisplay(targetId);
  return [
    'Timeout waiting for debugging approval. Tab created but daemon not connected.',
    `Target: ${target}`,
    'If Chrome asks "Allow debugging?", click Allow first.',
    formatOpenNextPerceiveCommand(targetId),
  ].join('\n');
}

function formatOpenAutoPerceiveFailure(err, targetId) {
  const target = targetPrefixForDisplay(targetId);
  return [
    'Auto-perceive failed after the tab was attached.',
    formatCliError(err, { cmd: 'perceive', targetPrefix: target }),
  ].join('\n');
}

function buildExactTargetSupervisorCandidates(pages, currentTargetId, browserIdentity) {
  return pages.map(page => ({
    resource: {
      schema: 'chrome-cdp-ex.resource-ref.v1',
      kind: 'page',
      id: `page-${createHash('sha256').update(String(page.targetId)).digest('hex').slice(0, 16)}`,
      revision: 0,
      capabilities: ['execute'],
      links: [{ relation: 'browser', ...browserIdentity }],
    },
    targetId: page.targetId,
    aliases: [],
    // Exact-target CLI routing does not need arbitrary page URLs. Keeping
    // them out avoids unrelated long/data URLs influencing target binding.
    url: '',
    current: page.targetId === currentTargetId,
    browser: browserIdentity,
  }));
}

function cdpRuntimeIdentity(processLike = process) {
  return Object.freeze({
    execPath: processLike.execPath,
    scriptPath: fileURLToPath(import.meta.url),
  });
}

class CliExitSignal extends Error {
  constructor(code) {
    super(`CLI exit ${code}`);
    this.code = Number(code) || 0;
  }
}

export async function executeCdpCli(command, { runMain = main, hostProcess = process } = {}) {
  const argv = [...command];
  let stdout = '';
  let stderr = '';
  const write = channel => (chunk, encoding, callback) => {
    if (typeof encoding === 'function') callback = encoding;
    if (channel === 'stdout') stdout += String(chunk);
    else stderr += String(chunk);
    callback?.();
    return true;
  };
  const cliProcess = Object.create(hostProcess);
  Object.defineProperties(cliProcess, {
    argv: { value: [hostProcess.execPath, fileURLToPath(import.meta.url), ...argv], writable: true },
    env: { value: hostProcess.env, writable: true },
    exitCode: { value: 0, writable: true },
    stdout: { value: Object.freeze({ write: write('stdout') }) },
    stderr: { value: Object.freeze({ write: write('stderr') }) },
    exit: { value: code => { throw new CliExitSignal(code); } },
  });
  const cliConsole = Object.freeze({
    log: (...values) => { stdout += `${formatValue(...values)}\n`; },
    error: (...values) => { stderr += `${formatValue(...values)}\n`; },
  });
  let code = 0;
  try {
    await runMain({ argv, process: cliProcess, console: cliConsole });
    code = Number(cliProcess.exitCode) || 0;
  } catch (error) {
    if (error instanceof CliExitSignal) {
      code = error.code;
    } else {
      const [cmd, ...args] = argv;
      cliConsole.error(formatCliError(error, { cmd, format: detectCliErrorFormat(args) }));
      code = 1;
    }
  }
  const normalized = { code, stdout: stdout.trim(), stderr: stderr.trim() };
  if (normalized.code === 0
    && !classifyCommandResultSemantics(normalized, { command: command[0] }).ok) {
    normalized.code = 1;
  }
  return normalized;
}

function emitTargetCommandResponse(response, {
  cmd,
  targetPrefix,
  format = 'text',
  targetResolution = null,
  console = globalThis.console,
  process = globalThis.process,
} = {}) {
  const hasResult = response?.result !== undefined
    && response?.result !== null
    && response.result !== '';
  if (hasResult) {
    let output = format === 'json' && targetResolution
      && !isDeterministicTableContinuationResult(cmd, response.result)
      ? attachTargetResolutionDiagnostics(response.result, targetResolution)
      : response.result;
    if (cmd === 'table' && !isDeterministicTableContinuationResult(cmd, response.result)) {
      output = format === 'json'
        ? boundedTableObservationEmissionJson(output)
        : boundedTableObservationEmissionText(output);
    }
    console.log(output);
    const semantics = classifyCommandResultSemantics(
      { ok: response?.ok === true, result: output },
      { command: cmd },
    );
    if (response?.ok === false || !semantics.ok) process.exitCode = 1;
    return;
  }
  if (response?.ok === false) {
    console.error(formatDaemonCommandError(response.error, { cmd, targetPrefix, format }));
    process.exitCode = 1;
  }
}

function isDeterministicTableContinuationResult(cmd, result) {
  if (cmd !== 'table' || typeof result !== 'string') return false;
  let model;
  try { model = JSON.parse(result); } catch { return false; }
  if (!model || typeof model !== 'object' || Array.isArray(model)
    || model.schema !== 'chrome-cdp-ex.table.v1'
    || !model.continuation || typeof model.continuation !== 'object'
    || Array.isArray(model.continuation)) return false;
  try {
    parseTableContinuationToken(model.continuation.token);
    return true;
  } catch {
    return false;
  }
}

async function main(options = {}) {
  const process = options.process || globalThis.process;
  const console = options.console || globalThis.console;
  const finish = code => options.process ? (process.exitCode = code) : process.exit(code);
  const runtimeIdentity = cdpRuntimeIdentity(process);
  const applicationPreflight = preflightDaemonApplication();
  ensureRuntimeDir();
  const exitCliError = (err, { cmd = '', targetPrefix = '', format = 'text', platform = process.platform } = {}) => {
    console.error(formatCliError(err, { cmd, targetPrefix, format, platform }));
    process.exit(1);
  };
  let [cmd, ...args] = options.argv || process.argv.slice(2);

  // Daemon mode (internal)
  if (cmd === '_daemon') { await runDaemon(args[0], applicationPreflight); return; }

  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log(helpStr()); return finish(0);
  }
  if (cmd === 'help') {
    try {
      console.log(args[0] ? helpTopicStr(args[0]) : helpStr());
      return finish(0);
    } catch (e) {
      console.error(formatCliError(e, { cmd: 'help' }));
      return finish(1);
    }
  }

  // List — use existing daemon if available, otherwise direct
  if (cmd === 'list' || cmd === 'ls' || cmd === 'tabs') {
    const fopts = parseFormatArgs(args, ['text', 'json']);
    if (fopts.args.length) {
      console.error(formatCliError(`list: unknown argument ${fopts.args[0]}`, { cmd, format: fopts.format }));
      return finish(1);
    }
    let pages;
    const existingSock = findAnyDaemonSocket();
    if (existingSock) {
      try {
        const conn = await connectToSocket(existingSock);
        const resp = await sendCommand(conn, { cmd: 'list_raw' });
        if (resp.ok) pages = JSON.parse(resp.result);
      } catch {}
    }
    if (!pages) {
      // No daemon running — connect directly (will trigger one Allow)
      const cdp = new CDP();
      await cdp.connect(await getWsUrl());
      try { await rememberLiveCdpEndpointFromSession(cdp); } catch {}
      pages = await getPages(cdp);
      cdp.close();
    }
    writeFileSync(PAGES_CACHE, JSON.stringify(pages), { mode: 0o600 });
    const aliasStore = readTargetAliases();
    console.log(formatPageListOutput(pages, _browserInfo, { format: fopts.format, aliases: aliasStore.aliases }));
    await new Promise(resolveWrite => process.stdout.write('', resolveWrite));
    return finish(0);
  }

  // tab-group management (no target required)
  if (cmd === 'tab-group' || cmd === 'tabgroup') {
    try {
      const opts = parseTabGroupArgs(args);
      let store = readTabGroups();
      if (opts.action === 'list') {
        console.log(formatTabGroupStore(store, { format: opts.format }));
        return finish(0);
      }
      if (opts.action === 'create') {
        const [name, ...members] = opts.args;
        if (!name) throw new Error('tab-group create: name required');
        const liveTargetIds = listKnownLiveTargetIds();
        store = upsertTabGroup(store, {
          name,
          members: resolveTabGroupMembers(members, { targetIds: liveTargetIds }),
        });
        writeTabGroups(store);
        console.log(formatTabGroup(store.groups[normalizeTabGroupName(name)], { format: opts.format }));
        return finish(0);
      }
      if (opts.action === 'add') {
        const [name, member] = opts.args;
        if (!name || !member) throw new Error('tab-group add: name and target required');
        store = upsertTabGroup(store, {
          name,
          members: resolveTabGroupMembers([member], { targetIds: listKnownLiveTargetIds() }),
        });
        writeTabGroups(store);
        console.log(formatTabGroup(store.groups[normalizeTabGroupName(name)], { format: opts.format }));
        return finish(0);
      }
      if (opts.action === 'remove') {
        const [name, member] = opts.args;
        if (!name || !member) throw new Error('tab-group remove: name and target required');
        store = removeTabGroupMember(store, name, member);
        writeTabGroups(store);
        console.log(formatTabGroup(store.groups[normalizeTabGroupName(name)], { format: opts.format }));
        return finish(0);
      }
      if (opts.action === 'delete') {
        const [name] = opts.args;
        if (!name) throw new Error('tab-group delete: name required');
        store = deleteTabGroup(store, name);
        writeTabGroups(store);
        console.log(opts.format === 'json'
          ? formatJson({ schema: 'chrome-cdp-ex.tab-group-delete.v1', removed: normalizeTabGroupName(name) })
          : `Deleted tab group ${normalizeTabGroupName(name)}`);
        return finish(0);
      }
      if (opts.action === 'show') {
        const [name] = opts.args;
        if (!name) throw new Error('tab-group show: name required');
        const group = getTabGroup(store, name);
        if (!group) throw new Error(`tab-group: unknown group "${normalizeTabGroupName(name)}"`);
        console.log(formatTabGroup(group, { format: opts.format }));
        return finish(0);
      }
    } catch (e) {
      console.error(formatCliError(e, { cmd: 'tab-group', format: detectCliErrorFormat(args) }));
      return finish(1);
    }
  }

  // broadcast a command to every member of a tab-group
  if (cmd === 'broadcast') {
    try {
      const opts = parseBroadcastArgs(args);
      const group = getTabGroup(readTabGroups(), opts.groupName);
      if (!group) throw new Error(`broadcast: unknown group "${opts.groupName}"`);
      if (!group.members.length) throw new Error(`broadcast: group "${opts.groupName}" has no members`);
      const results = [];
      for (const member of group.members) {
        const entry = { target: member, targetPrefix: String(member).slice(0, 8), ok: false, result: null, error: null };
        try {
          // Resolve alias or prefix to a live target, then run via daemon IPC.
          let targetId = null;
          const alias = resolveTargetAlias(member);
          if (alias?.targetId) targetId = alias.targetId;
          else {
            const daemonIds = listDaemonSockets().map(d => d.targetId);
            const matches = daemonIds.filter(id => id.toUpperCase().startsWith(String(member).toUpperCase()));
            if (matches.length === 1) targetId = matches[0];
            else if (existsSync(PAGES_CACHE)) {
              const pages = JSON.parse(readFileSync(PAGES_CACHE, 'utf8'));
              targetId = resolvePrefix(member, pages.map(p => p.targetId), 'target');
            } else {
              throw new Error(`cannot resolve target ${member}; run cdp list`);
            }
          }
          entry.targetPrefix = targetPrefixForDisplay(targetId);
          const conn = await getOrStartTabDaemon(targetId, {
            env: aliasEnv(alias),
            ...runtimeIdentity,
          });
          const resp = await sendCommand(conn, { cmd: opts.command, args: opts.commandArgs });
          try { conn.end(); } catch {}
          if (resp.ok) {
            entry.ok = true;
            entry.result = resp.result;
          } else {
            entry.error = resp.error || 'command failed';
          }
        } catch (e) {
          entry.error = e.message || String(e);
          if (e?.code === 'DAEMON_COMPLETION_UNKNOWN') {
            entry.completion = 'unknown';
            entry.sideEffectMayHaveOccurred = e.sideEffectMayHaveOccurred === true;
            entry.retrySafe = false;
            entry.transportCause = e.transportCause || null;
          }
        }
        results.push(entry);
      }
      const model = buildBroadcastModel({
        groupName: opts.groupName,
        command: opts.command,
        commandArgs: opts.commandArgs,
        results,
        fullResults: opts.fullResults,
      });
      console.log(opts.format === 'json' ? formatJson(model) : formatBroadcastResult(model));
      return finish(model.failed ? 1 : 0);
    } catch (e) {
      console.error(formatCliError(e, { cmd: 'broadcast', format: detectCliErrorFormat(args) }));
      return finish(1);
    }
  }

  // Target selection by URL/title (no target prefix required)
  if (cmd === 'target') {
    try {
      const opts = parseTargetSelectArgs(args);
      let pages;
      const existingSock = findAnyDaemonSocket();
      if (existingSock) {
        try {
          const conn = await connectToSocket(existingSock);
          const resp = await sendCommand(conn, { cmd: 'list_raw' });
          if (resp.ok) pages = JSON.parse(resp.result);
        } catch {}
      }
      if (!pages) {
        const cdp = new CDP();
        await cdp.connect(await getWsUrl());
        pages = await getPages(cdp);
        cdp.close();
      }
      writeFileSync(PAGES_CACHE, JSON.stringify(pages), { mode: 0o600 });
      const selection = selectPageTarget(pages, opts);
      console.log(formatTargetSelect(selection, pages, { format: opts.format }));
      await new Promise(resolveWrite => process.stdout.write('', resolveWrite));
      return finish(0);
    } catch (e) {
      console.error(formatCliError(e, { cmd, format: detectCliErrorFormat(args) }));
      return finish(1);
    }
  }

  // Open new tab
  if (cmd === 'open') {
    const opts = parseOpenArgs(args);
    const url = opts.url;
    if (url !== 'about:blank') validateUrl(url);

    // Reuse an existing tab with the same/similar URL when requested.
    if (opts.reuseUrl && url !== 'about:blank') {
      let pages;
      const existingSock = findAnyDaemonSocket();
      if (existingSock) {
        try {
          const conn = await connectToSocket(existingSock);
          const resp = await sendCommand(conn, { cmd: 'list_raw' });
          if (resp.ok) pages = JSON.parse(resp.result);
        } catch {}
      }
      if (!pages) {
        const cdp = new CDP();
        await cdp.connect(await getWsUrl());
        pages = await getPages(cdp);
        cdp.close();
      }
      writeFileSync(PAGES_CACHE, JSON.stringify(pages), { mode: 0o600 });
      try {
        const selection = selectPageTarget(pages, { url, exact: false });
        const model = buildOpenModel({
          targetId: selection.targetId,
          url: selection.page.url || url,
          attached: true,
          navigation: { attempted: false, ok: true, method: 'reuse-url', href: selection.page.url || url },
          ready: { attempted: false, ok: true, reason: 'reused-existing-tab' },
          autoPerceive: { attempted: false, ok: false, reason: 'reuse-url' },
        });
        model.reused = true;
        if (opts.format === 'json') {
          console.log(formatJson(model));
          return;
        }
        console.log(`Reused existing tab: ${selection.targetPrefix}  ${selection.page.url || url}`);
        console.log(formatOpenNextPerceiveCommand(selection.targetId));
        return;
      } catch (e) {
        // Zero matches: fall through and open a new tab.
        // Ambiguous matches: fail closed so agents do not open yet another duplicate.
        if (/pages matched/i.test(e.message || '')) {
          console.error(formatCliError(e, { cmd: 'open', format: opts.format }));
          return finish(1);
        }
      }
    }

    const cdp = new CDP();
    await cdp.connect(await getWsUrl());
    const { targetId } = await cdpDomains(cdp).Target.createTarget( { url: 'about:blank' });
    // Refresh cache; new tab may not appear in getTargets immediately, so add it manually
    const pages = await getPages(cdp);
    if (!pages.some(p => p.targetId === targetId)) {
      pages.push({ targetId, title: url, url });
    }
    cdp.close();
    writeFileSync(PAGES_CACHE, JSON.stringify(pages), { mode: 0o600 });
    if (opts.format === 'text') {
      console.log(`Opened new tab: ${targetId.slice(0, 8)}  ${url}`);
    }

    // Auto-attach: start daemon and wait for user to click "Allow debugging?"
    const sp = sockPath(targetId);
    if (!IS_WINDOWS) try { unlinkSync(sp); } catch {}
    const child = spawn(runtimeIdentity.execPath, [runtimeIdentity.scriptPath, '_daemon', targetId], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    let attached = false;
    let announcedWait = false;
    let failedConnects = 0;
    const attachStartedAt = Date.now();
    const attachDeadline = attachStartedAt + opts.attachTimeoutMs;
    while (Date.now() < attachDeadline) {
      const remainingMs = attachDeadline - Date.now();
      try {
        const conn = await connectToSocket(sp, { timeoutMs: Math.min(DAEMON_ALLOW_DELAY, Math.max(1, remainingMs)) });
        conn.end();
        attached = true;
        break;
      } catch {
        failedConnects += 1;
        if (opts.format === 'text' && !announcedWait && shouldAnnounceOpenAttachWait({
          failedConnects,
          elapsedMs: Date.now() - attachStartedAt,
        })) {
          console.log(formatOpenAttachWaitMessage(opts.attachTimeoutMs));
          announcedWait = true;
        }
      }
      await sleep(Math.min(DAEMON_ALLOW_DELAY, remainingMs));
    }
    const navigation = attached
      ? await navigateOpenTarget(targetId, sp, url)
      : { attempted: false, ok: false, reason: 'not-attached' };
    const ready = attached
      ? await waitForOpenReady(targetId, { timeoutMs: opts.readyTimeoutMs, url, selector: opts.readySelector })
      : { attempted: false, ok: false, reason: 'not-attached', timeoutMs: opts.readyTimeoutMs };
    if (opts.format === 'json') {
      console.log(formatJson(buildOpenModel({
        targetId,
        url,
        attached,
        navigation,
        ready,
        autoPerceive: attached
          ? { attempted: false, ok: false, reason: 'json-output' }
          : { attempted: false, ok: false, reason: 'not-attached' },
      })));
      return;
    }
    if (attached) {
      if (opts.perceive) {
        console.log(formatOpenReadyMessage(targetId, url));
        try {
          const conn = await connectToSocket(sp);
          const resp = await sendCommand(conn, { cmd: 'perceive', args: [] });
          conn.end();
          if (resp.ok && resp.result) console.log('---\n' + resp.result);
        } catch (e) {
          console.error(formatOpenAutoPerceiveFailure(e, targetId));
        }
      } else {
        console.log(formatOpenNextPerceiveCommand(targetId));
      }
    } else {
      console.log(formatOpenTimeoutMessage(targetId));
    }
    return;
  }

  // Stop
  if (cmd === 'stop') {
    const fopts = parseFormatArgs(args, ['text', 'json']);
    if (fopts.args.includes('--help') || fopts.args.includes('-h')) {
      console.log(helpTopicStr('stop'));
      return finish(0);
    }
    if (fopts.args.length > 1) exitCliError(`stop: unknown argument ${fopts.args[1]}`, { cmd, format: fopts.format });
    try {
      const requested = fopts.args[0] === '--all' ? undefined : fopts.args[0];
      const result = await stopDaemons(requested);
      console.log(formatStopResult(result, { format: fopts.format }));
      return finish(0);
    } catch (e) {
      console.error(formatCliError(e, { cmd, format: fopts.format }));
      return finish(1);
    }
  }

  // Doctor / ready — one-call diagnostics, no target needed
  if (cmd === 'doctor' || cmd === 'ready') {
    const fopts = parseFormatArgs(args, ['text', 'json']);
    if (fopts.args.length) {
      console.error(formatCliError(`doctor: unknown argument ${fopts.args[0]}`, { cmd, format: fopts.format }));
      return finish(1);
    }
    const checks = await runDoctorChecks();
    console.log(formatDoctorOutput(checks, { format: fopts.format }));
    return finish(checks.some(check => check.status === 'FAIL') ? 1 : 0);
  }

  // spawn-debug-browser / spawn — launch isolated debug profile (no target)
  if (cmd === 'spawn-debug-browser' || cmd === 'spawn') {
    try {
      const out = await spawnDebugBrowserStr(args);
      console.log(out);
      return finish(0);
    } catch (e) {
      console.error(formatCliError(e, { cmd }));
      return finish(1);
    }
  }

  if (cmd === 'attach' || cmd === 'use') {
    try {
      const parsed = parseAliasCommandArgs(args, cmd);
      const attachEnv = parsed.port ? {
        ...process.env,
        CDP_PORT: String(parsed.port),
        CDP_HOST: parsed.host || process.env.CDP_HOST || DEFAULT_CDP_HOST,
      } : null;
      if (parsed.port) {
        const check = await checkCdpReachability({ env: attachEnv, host: attachEnv.CDP_HOST });
        if (check.status === 'FAIL') {
          throw cdpUnreachableError({
            host: check.host || attachEnv.CDP_HOST,
            port: check.port || attachEnv.CDP_PORT,
            cause: check.detail,
            lastEndpoint: {
              host: check.host,
              port: check.port,
              profileDir: check.profileDir,
              exe: check.exe,
              browser: check.browser,
            },
          });
        }
      }
      const store = readTargetAliases();
      const next = await bindAndSaveTargetAlias(parsed, {
        store,
        env: process.env,
      });
      console.log(formatAliasRecord(next.aliases[normalizeAliasName(parsed.name)], { format: parsed.format }));
      return finish(0);
    } catch (e) {
      const format = detectCliErrorFormat(args);
      console.error(formatCliError(e, { cmd, format }));
      return finish(1);
    }
  }

  if (cmd === 'forget') {
    const fopts = parseFormatArgs(args, ['text', 'json']);
    const name = fopts.args[0];
    if (!name) exitCliError('forget requires an alias name', { cmd, format: fopts.format });
    try {
      const store = readTargetAliases();
      const { next, removed } = forgetTargetAlias(store, name);
      writeTargetAliases(next);
      console.log(fopts.format === 'json'
        ? formatJson({ schema: 'chrome-cdp-ex.alias-forget.v1', removed: removed.name, current: next.current })
        : `Forgot @${removed.name}`);
      return finish(0);
    } catch (e) {
      console.error(formatCliError(e, { cmd, format: fopts.format }));
      return finish(1);
    }
  }

  if (cmd === 'current') {
    const fopts = parseFormatArgs(args, ['text', 'json']);
    if (fopts.args.length) exitCliError(`current: unknown argument ${fopts.args[0]}`, { cmd, format: fopts.format });
    console.log(formatCurrentAlias(readTargetAliases(), { format: fopts.format }));
    return finish(0);
  }

  // Targetless wait: avoids shell sleep policy for simple delays.
  if (cmd === 'wait' && /^\d+$/.test(args[0] || '') && !args[1]) {
    try {
      console.log(await waitStr(args[0]));
      return finish(0);
    } catch (e) {
      console.error(formatCliError(e, { cmd: 'wait' }));
      return finish(1);
    }
  }

  // Page commands — need target prefix
  if (!NEEDS_TARGET.has(cmd)) {
    const cliErrorFormat = detectCliErrorFormat(args);
    console.error(formatCliError(unknownCommandMessage(cmd), { cmd, format: cliErrorFormat }));
    return finish(1);
  }

  // Canonicalize aliases (key→press, resize→viewport, …) before daemon IPC.
  cmd = commandMeta(cmd)?.name || cmd;

  const targetCommandArgs = [...args];
  let allowStaleDaemon = process.env.CDP_ALLOW_STALE_DAEMON === '1';
  const allowStaleDaemonFlagIndex = targetCommandArgs.indexOf(ALLOW_STALE_DAEMON_FLAG);
  if (allowStaleDaemonFlagIndex !== -1) {
    allowStaleDaemon = true;
    targetCommandArgs.splice(allowStaleDaemonFlagIndex, 1);
  }

  let { targetPrefix, cmdArgs } = parseTargetAndCommandArgs(cmd, targetCommandArgs);
  let cliErrorFormat = targetCommandCliErrorFormat(targetPrefix, cmdArgs, targetCommandArgs);
  if (
    targetPrefix === '--help'
    || targetPrefix === '-h'
    || cmdArgs.includes('--help')
    || cmdArgs.includes('-h')
    || targetCommandArgs.includes('--help')
    || targetCommandArgs.includes('-h')
  ) {
    console.log(helpTopicStr(cmd));
    return finish(0);
  }
  if (targetPrefix && String(targetPrefix).startsWith('--')) {
    try {
      const fopts = parseFormatArgs(targetCommandArgs, ['text', 'json']);
      cliErrorFormat = fopts.format;
      targetPrefix = fopts.args[0];
      cmdArgs = fopts.args.slice(1);
    } catch (e) {
      console.error(formatCliError(e, { cmd }));
      return finish(1);
    }
  }
  if (targetPrefix && String(targetPrefix).startsWith('--')) {
    console.error(formatCliError(`${cmd}: target prefix is required`, { cmd, format: cliErrorFormat }));
    return finish(1);
  }
  if (!targetPrefix) {
    console.error(formatCliError('target ID required. Run "cdp list" first.', { cmd, format: cliErrorFormat }));
    return finish(1);
  }

  // Resolve against live discovery before trusting daemon or cache state.
  const targetAlias = resolveTargetAlias(targetPrefix);
  if (!targetAlias && looksLikeAliasToken(targetPrefix)) {
    console.error(formatCliError(unknownAliasError(targetPrefix), { cmd, format: cliErrorFormat }));
    return finish(1);
  }
  const livePages = await livePagesForTargetCommand(targetAlias);
  writeFileSync(PAGES_CACHE, JSON.stringify(livePages), { mode: 0o600 });
  const requestedTargetId = targetAlias?.targetId || targetPrefix;
  const preliminaryMatches = livePages.filter(page => String(page.targetId || '').toUpperCase().startsWith(String(requestedTargetId).toUpperCase()));
  const preliminaryTargetId = preliminaryMatches.length === 1 ? preliminaryMatches[0].targetId : null;
  const daemonBinding = preliminaryTargetId ? await readDaemonBinding(preliminaryTargetId) : null;
  let targetResolution = resolveLiveTargetBinding({
    requested: targetPrefix,
    livePages,
    daemonBinding,
    alias: targetAlias,
  });
  const targetId = targetResolution.resolvedTargetId;

  let rebound = false;
  let daemonAssessment = null;
  const browserIdentity = { kind: 'browser', id: 'browser-runtime', revision: 0 };
  const runtimeSupervisor = createBrowserSupervisor({
    discover: async () => {
      const pages = targetAlias?.port
        ? livePages
        : await discoverLivePagesForTargetResolution();
      return buildExactTargetSupervisorCandidates(pages, targetId, browserIdentity);
    },
    endpointFor: resolvedTargetId => sockPath(resolvedTargetId),
    open: async (resolvedTargetId, endpoint) => ({
      targetId: resolvedTargetId,
      endpoint,
      initialConnection: await getOrStartTabDaemon(resolvedTargetId, {
        env: aliasEnv(targetAlias),
        liveTargetPresent: livePages.some(page => page.targetId === resolvedTargetId),
        ...runtimeIdentity,
      }),
    }),
    inspect: async runtime => {
      if (allowStaleDaemon) return { boundTargetId: runtime.targetId, endpoint: runtime.endpoint };
      daemonAssessment = await assertFreshDaemonConnection(runtime.initialConnection, {
        targetPrefix: targetPrefixForDisplay(runtime.targetId),
        expectedTargetId: runtime.targetId,
        currentMetadata: collectDaemonMetadata({ scriptPath: runtimeIdentity.scriptPath }),
      });
      return {
        boundTargetId: daemonAssessment?.daemon?.boundTargetId || runtime.targetId,
        endpoint: runtime.endpoint,
      };
    },
    request: async (runtime, request) => {
      if (allowStaleDaemon && runtime.initialConnection) {
        const connection = runtime.initialConnection;
        runtime.initialConnection = null;
        return sendCommand(connection, request);
      }
      return sendCommand(await connectToSocket(runtime.endpoint), request);
    },
    stop: async resolvedTargetId => {
      await stopDaemons(resolvedTargetId);
      await sleep(100);
      rebound = true;
    },
  });
  const runtimeHandle = await runtimeSupervisor.resolve(createLocatorPlan({
    schema: 'chrome-cdp-ex.locator-plan.v1',
    strategy: 'exact-target',
    value: targetId,
    scope: browserIdentity,
    fallbacks: [],
  }));
  if (cmd === 'eval') {
    try {
      cmdArgs = normalizeEvalCliArgs(cmdArgs);
    } catch (error) {
      exitCliError(error.message, { cmd, targetPrefix, format: cliErrorFormat });
    }
  } else if (cmd === 'eval64') {
    const b64 = cmdArgs.join('').trim();
    if (!b64) exitCliError('base64 expression required', { cmd, targetPrefix, format: cliErrorFormat });
    cmdArgs.splice(0, cmdArgs.length, b64);
  } else if (cmd === 'call') {
    const expr = cmdArgs.join(' ');
    if (!expr) exitCliError('expression required', { cmd, targetPrefix, format: cliErrorFormat });
    cmdArgs.splice(0, cmdArgs.length, expr);
  } else if (cmd === 'elshot') {
    const checkArgs = argsWithoutFormat(cmdArgs);
    if (!checkArgs[0]) exitCliError('CSS selector required', { cmd, targetPrefix, format: cliErrorFormat });
  } else if (cmd === 'type') {
    const checkArgs = argsWithoutFormat(cmdArgs);
    if (!checkArgs[0]) exitCliError('text required', { cmd, targetPrefix, format: cliErrorFormat });
    cmdArgs = normalizeTargetCommandArgs(cmd, cmdArgs);
  } else if (cmd === 'fill') {
    const checkArgs = argsWithoutFormat(cmdArgs);
    if (checkArgs[0] === '--react') {
      if (!checkArgs[1]) exitCliError('selector required', { cmd, targetPrefix, format: cliErrorFormat });
      if (!checkArgs[2]) exitCliError('text required', { cmd, targetPrefix, format: cliErrorFormat });
    } else {
      if (!checkArgs[0]) exitCliError('selector required', { cmd, targetPrefix, format: cliErrorFormat });
      if (!checkArgs[1]) exitCliError('text required', { cmd, targetPrefix, format: cliErrorFormat });
    }
    cmdArgs = normalizeTargetCommandArgs(cmd, cmdArgs);
  } else if (cmd === 'evalraw') {
    // args: [method, ...jsonParts] — join json parts in case of spaces
    if (!cmdArgs[0]) exitCliError('CDP method required', { cmd, targetPrefix, format: cliErrorFormat });
    if (cmdArgs.length > 2) cmdArgs[1] = cmdArgs.slice(1).join(' ');
  } else if (cmd === 'cookieset') {
    if (!cmdArgs[0]) exitCliError('cookie string required (e.g. "name=value; domain=.example.com")', { cmd, targetPrefix, format: cliErrorFormat });
    cmdArgs[0] = cmdArgs.join(' '); // join in case of spaces in cookie string
  } else if (cmd === 'cookiedel') {
    if (!cmdArgs[0]) exitCliError('cookie name required', { cmd, targetPrefix, format: cliErrorFormat });
  } else if (cmd === 'upload') {
    if (!cmdArgs[0] || !cmdArgs[1]) exitCliError('selector and file path(s) required', { cmd, targetPrefix, format: cliErrorFormat });
    // args[0] = selector, args[1] = comma-separated file paths (no join needed)
  } else if (cmd === 'batch') {
    const filtered = cmdArgs.filter(a => a !== '--parallel' && a !== '--plain' && a !== '--compact');
    if (!filtered[0]) exitCliError('commands required (pipe syntax or JSON array)', { cmd, targetPrefix, format: cliErrorFormat });
  } else if (cmd === 'flow') {
    const fopts = parseFormatArgs(cmdArgs, ['text', 'json']);
    if (!fopts.args[0]) exitCliError('flow steps required (semicolon-separated). Example: flow <target> "click @1; wait dom stable; summary"', { cmd, targetPrefix, format: cliErrorFormat });
    // Preserve multi-word/unquoted step recipes as one daemon argument.
    cmdArgs.splice(0, cmdArgs.length, ...formatArgSuffix(fopts.format), fopts.args.join(' '));
  } else if (cmd === 'replay') {
    const jsonIndex = cmdArgs.findIndex(a => a === '--json');
    if (jsonIndex !== -1) {
      const jsonPayload = cmdArgs.slice(jsonIndex + 1).join(' ').trim();
      if (!jsonPayload) exitCliError('replay --json requires a record-actions JSON payload', { cmd, targetPrefix, format: cliErrorFormat });
      cmdArgs.splice(jsonIndex + 1, cmdArgs.length - jsonIndex - 1, jsonPayload);
    } else if (!cmdArgs[0]) {
      exitCliError('replay requires --file <path> or --json <record-actions-json>', { cmd, targetPrefix, format: cliErrorFormat });
    }
  } else if (cmd === 'restore') {
    const jsonIndex = cmdArgs.findIndex(a => a === '--json');
    if (jsonIndex !== -1) {
      const jsonPayload = cmdArgs.slice(jsonIndex + 1).join(' ').trim();
      if (!jsonPayload) exitCliError('restore --json requires a checkpoint JSON payload', { cmd, targetPrefix, format: cliErrorFormat });
      cmdArgs.splice(jsonIndex + 1, cmdArgs.length - jsonIndex - 1, jsonPayload);
    } else if (!cmdArgs[0]) {
      exitCliError('restore requires --file <path> or --json <checkpoint-json>', { cmd, targetPrefix, format: cliErrorFormat });
    }
  }

  if (cmd === 'nav' || cmd === 'navigate') {
    const checkArgs = argsWithoutFormat(cmdArgs);
    if (!checkArgs[0]) exitCliError('URL required', { cmd, targetPrefix, format: cliErrorFormat });
  }

  let response;
  try {
    response = await runtimeSupervisor.execute(runtimeHandle, { cmd, args: cmdArgs });
  } catch (error) {
    console.error(formatCliError(error, { cmd, targetPrefix: targetPrefixForDisplay(targetId), format: cliErrorFormat, args: cmdArgs }));
    return finish(1);
  }
  targetResolution = completeTargetResolution(targetResolution, {
    boundTargetId: daemonAssessment?.daemon?.boundTargetId || targetId,
    rebound,
  });

  emitTargetCommandResponse(response, {
    cmd,
    targetPrefix,
    format: cliErrorFormat,
    targetResolution,
    console,
    process,
  });
}

function perceiveReadinessRecovery(target) {
  return {
    kind: 'loading',
    strategy: 'retry-perceive',
    run: `cdp perceive ${target} -C -d 8`,
    reason: 'Target metadata advertises an HTTP(S) page, but the renderer stayed blank through bounded readiness sampling. Retry perceive without navigating.',
  };
}

const PERCEIVE_READINESS_DELAYS_MS = Object.freeze([0, 250, 500, 1000]);

async function readPerceiveTargetMetadata(cdp, targetId) {
  const pages = await getPages(cdp);
  return pages.find(page => page.targetId === targetId) || null;
}

async function readPerceiveDocumentState(cdp, sid) {
  const value = await evalStr(
    cdp,
    sid,
    'JSON.stringify({ url: window.location.href, readyState: document.readyState })',
    false,
    { timeoutMs: STATUS_PAGE_INFO_TIMEOUT },
  );
  const state = JSON.parse(value);
  return {
    url: String(state?.url || ''),
    readyState: String(state?.readyState || 'unknown'),
  };
}

async function ensurePerceiveTargetReady({ cdp, sessionId, targetId, ops = {} }) {
  const readTargetMetadata = ops.readPerceiveTargetMetadata || readPerceiveTargetMetadata;
  const readDocumentState = ops.readPerceiveDocumentState || readPerceiveDocumentState;
  const sampleDelaysMs = ops.perceiveReadinessDelaysMs || PERCEIVE_READINESS_DELAYS_MS;
  const wait = ops.sleep || sleep;
  const now = ops.now || Date.now;
  let target;
  try {
    target = await readTargetMetadata(cdp, targetId);
  } catch {
    return;
  }
  const advertisedUrl = String(target?.url || '').trim();
  if (!/^https?:\/\//i.test(advertisedUrl)) return;

  const delays = Array.isArray(sampleDelaysMs) && sampleDelaysMs.length
    ? sampleDelaysMs
    : PERCEIVE_READINESS_DELAYS_MS;
  const startedAt = now();
  let observed = { url: '', readyState: 'unknown' };
  for (let index = 0; index < delays.length; index++) {
    const delayMs = Math.max(0, Number(delays[index]) || 0);
    if (delayMs > 0) await wait(delayMs);
    observed = await readDocumentState(cdp, sessionId);
    if (!isBlankPageUrl(observed?.url)) return;
  }

  const observedUrl = String(observed?.url || '');
  const readyState = String(observed?.readyState || 'unknown');
  throw new Error(
    'perceive: target/document readiness mismatch; ' +
    `targetId=${targetId}; requestedTargetId=${targetId}; resolvedTargetId=${targetId}; ` +
    `boundTargetId=${targetId}; advertisedUrl=${advertisedUrl}; observedUrl=${observedUrl}; ` +
    `readyState=${readyState}; attempts=${delays.length}/${delays.length}; elapsedMs=${Math.max(0, now() - startedAt)}. ` +
    'The target metadata advertises a loaded HTTP(S) page while its renderer is still blank; retry the same perceive command.'
  );
}

const isDirectRun = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  main().catch(e => {
    const [cmd, ...args] = process.argv.slice(2);
    console.error(formatCliError(e, { cmd, format: detectCliErrorFormat(args) }));
    process.exit(1);
  });
}
export const __test__ = process.env.NODE_ENV === 'test' ? {
  // Data structures
  RingBuffer, CDP,
  // Utilities
  resolvePrefix, getDisplayPrefixLength, daemonEndpointForPlatform, sockPath, isRef, validateUrl,
  emptyAliasStore, readTargetAliases, writeTargetAliases, upsertTargetAlias,
  removeTargetAlias, forgetTargetAlias, resolveTargetAlias, aliasesForTarget, parseAliasCommandArgs,
  aliasEnv, discoverOptionsForTargetAlias, selectLivePagesForAliasResolution, bindAliasTargetFromPages,
  bindAndSaveTargetAlias, livePagesForTargetCommand, discoverLivePagesForTargetResolution,
  formatDaemonStartFailure,
  aliasLookupKey, looksLikeAliasToken, looksLikeHexTargetPrefix, unknownAliasError, formatCurrentAlias,
  // AX tree helpers
  shouldShowAxNode, formatAxNode, axNodeTokenState, orderedAxChildren,
  // Perceive & snapshot
  parsePerceiveArgs, pickPrimaryScrollMetrics, omitTypeaheadListboxNodes, TYPEAHEAD_OMITTED_NOTICE,
  buildPerceiveDiffModel, formatPerceiveDiffOutput, buildPerceiveTree, perceivePageScript, perceiveStr,
  perceiveTextboxValueFromOutput,
  filterPerceiveExcludedAxNodes, perceiveInteractiveNoiseHint,
  buildCardsModel, formatCardsJson, formatCardsText,
  parseControlsArgs, visibleControlsCollectorSource, visibleControlsPageScript, compactVisibleControlsModel, formatVisibleControlLine, formatVisibleControlsText, controlsStr,
  offsetCssRect, offsetCursorInteractiveItem, mergeMissingDomInteractiveAxNodes, syntheticAxNodeFromDomControl,
  attachRefToVisibleControl, refAnnotationsFromTreeLines, nativeVisibleControlTag,
  isSynthesizableDomControl, shouldSynthesizeMissingFrameInteractives, listDomInteractiveControls,
  collectDomInteractiveControls, countedInteractiveElements, axInteractiveBackendCount,
  rankPerceiveCursorItems,
  createPerceptionModel, formatPerceptionJson, perceptionModelFromText, perceiveModel, perceiveDiffModel,
  createSessionState, invalidateSessionRefs,
  classifyActionFailure, formatActionFailure,
  buildActionRecoveryPlan, buildNoChangeOutcomeRecommendation,
  isExpectedNoChange, overlaySelectorArg,
  createActionResult, buildActionReceipt, formatActionText, formatActionResultOutput, runActionWithFeedback,
  stripLeftoverAxScrollCensusChrome, stripLeftoverAxScrollNoChangeIdentityChrome,
  stripLeftoverAxScrollNoChangeAxBodyChrome,
  parseVerifyClickArgs, buildSemanticInteractionModel, formatSemanticInteractionResult, formatActionWorkflowCommandOutput,
  parseQaArgs, buildQaPageModel, formatQaPageReport, qaPageStr,
  captureViewportSize, restoreViewportSize,
  qaScreenshotCaptureOptions, QA_SCREENSHOT_TIMEOUT_MS,
  diffShotScreenshotCaptureOptions,
  FULLSHOT_TIMEOUT_MS, screenshotCaptureUsesSessionTier, fullshotFitsViewport, fullshotStr,
  VERIFY_CLICK_SETTLE_MS, VERIFY_CLICK_REQUEST_WAIT_MS,
  HOVER_MOUSE_ACK_TIMEOUT_MS, HOVER_MUTATION_TIMEOUT_MS, HOVER_MUTATION_MARKER, CLICK_MOUSE_ACK_TIMEOUT_MS,
  LOADALL_DEFAULT_INTERVAL_MS, LOADALL_DEFAULT_TIMEOUT_MS, LOADALL_MAX_TIMEOUT_MS,
  CLICK_NAVIGATION_WAIT_MS, CLICK_HREF_PROBE_TIMEOUT_MS,
  daemonRequestStorage, sleep,
  dispatchClick, dispatchMouseEventAllowingAckTimeout, dispatchClickMouseEvent,
  parseClickEventProbeOutput, clickProbeSawPageEvent,
  isNavigatingHref, confirmClickFollowedHref, evalPageHref, waitForSettle,
  waitForHoverDomChange, hoverRecaptureShowsChange, discardHoverIdleBaseline,
  shouldSkipActionDomSettle, formatActionNavigationDiff, actionNavigationEvidence,
  actionFailurePage,
  createActionObservationBaseline, buildActionObservationDelta, applyActionObservationDelta,
  summarizeActionObservationEffects, shouldTrackActionNetworkRequest, isNetworkFailure,
  appendSessionActionLog, appendSessionEventLog, appendSessionScreenshot,
  appendSessionEnvironmentLog, buildRecordEnvironmentModel,
  initializeSessionLog, parseReportArgs, buildSessionReportModel, formatSessionReport, sessionScreenshotDir,
  ensureSessionScreenshotDir, nextSessionScreenshotPath,
  buildRecordActionsModel, formatRecordActions,
  playwrightStepFromCommand, formatPlaywrightSpecFromRecordActions, formatExportPlaywright,
  parseDiffShotArgs, diffShotCompareScript, formatDiffShotResult, diffShotStr,
  checkpointPageScript, sanitizeCheckpointCookies, sanitizeCheckpointStorage, parseCheckpointArgs, checkpointModel, checkpointStr,
  parseCheckpointArtifact, parseRestoreArgs, redactRestoreCommandArgs, redactExternalInputActionError, redactRestoreActionError,
  checkpointCookieToSetCookieParams, isRestorableCheckpointCookie, cookiesForRestore,
  restoreStorageScript, restoreCheckpointStr,
  // Command implementations
  getPages, formatPageList, buildPageListModel, formatPageListOutput, dialogStr, netlogStr, filterNetlogEntries,
  javascriptDialogHandleParams, createJavaScriptDialogSession, handleOpeningJavaScriptDialog,
  shouldSkipActionPageEvaluate, formatDialogBlockedObserveText, observeAfterActionGuardingDialogs,
  parseMockArgs, formatNetworkMocksSummary, buildMockModel, formatMockText, mockStr, handleMockRequestPaused,
  parseClockArgs, clockPageScript, formatClockSummary, buildClockModel, formatClockText, clockStr,
  parseThrottleArgs, formatThrottleSummary, throttleModel, formatThrottleText, throttleStr,
  injectStr, cascadeStr, recordStr, parseRecordArgs,
  isTimeoutError, parseDelayMs, waitStr, ipcTimeoutForRequest, sendCommand, parseTargetAndCommandArgs, normalizeTargetCommandArgs,
  parseFormatArgs, formatJson, parseConsoleArgs, clearConsoleBaseline, buildConsoleModel, buildStatusModel, summaryModel, formatSummaryText, summaryStr,
  evalStr, evalFireAndForgetStr, parseEvalArgs, normalizeEvalCliArgs, formatEvalValue, wrapAwaitExpression, callStr, formatCallResult, evalBase64Decode,
  parseEmulateArgs, buildEmulateFeatures, buildEmulateModel, formatEmulateText, emulateStr, emptyEmulateState, viewportStr,
  cookieDelStr, cookieDeleteParams, uploadStr, assertReadableUploadFiles,
  navStr, reloadStr, reloadActionDispatch, observeReloadPage, observeNavPage, observePageState, clickStr, clickXyStr, jsClickStr, fillStr, fillReactStr, waitForStr, hoverStr, dispatchHoverMove, rememberHoverSettleBaseline, parseScrollEdge, parseScrollContainerArg, scrollFeedbackPolicy, scrollActionTarget, documentScrollEdgeExpression, scrollEdgeExpression, documentScrollReachedEdge, formatDocumentScrollEdgeText, formatDocumentScrollEdgeFailure, DOCUMENT_SCROLL_EDGE_TOLERANCE_PX, DOCUMENT_SCROLL_EDGE_OUTCOME, scrollStr, selectStr, loadAllStr, parseLoadAllArgs, closetabStr, snapshotStr,
  statusStr, runtimeMetricsStr, clearObservationBuffers,
  parsePageConditionArgs, pageConditionDescription, probePageCondition, parseRepeatArgs, repeatStr, autoActionJsonArgs,
  classifyCommandResultSemantics,
  emitTargetCommandResponse,
  isBatchParallelUnsafeCommand,
  parseReplayArgs, parseReplayArtifact, replayStepFromAction, replayActionsStr,
  collectDaemonMetadata, assessDaemonFreshness, formatStaleDaemonMessage, resolveScriptIdentityPath,
  enableDaemonDomains,
  getOrStartTabDaemon,
  suggestCommands, unknownCommandMessage, editDistance, commandUsageTemplate,
  resolveLiveTargetBinding, completeTargetResolution, attachTargetResolutionDiagnostics,
  buildExactTargetSupervisorCandidates,
  cdpRuntimeIdentity,
  // 3y-mud feedback additions
  KEY_MAP, PUNCT_KEY_MAP, SHIFTED_PUNCT_KEY_MAP, keyForPress, pressStr, pressUsageError,
  formatUnknownRefError, resolveRefNode, scrollSettledRectFunctionDeclaration, formatRefRect, isPriorityPerceiveTextLine,
  parseFrameOnlyRef, parseFrameRef, flattenFrameTree, formatFrameTreeText, framesModel, framesStr,
  resolveFrameRef, storeFrameScopedRefs, qualifyFrameRefsInLines, frameRefFromActionTarget,
  rememberFramePerceiveOutput, baselineOutputForActionTarget, frameViewportOffset,
  parseTextArgs, textPageScript, textStr, formatTextNoMatchError, htmlStr,
  isPdfViewerContentType, formatPdfViewerOutput, pdfViewerError, assertNotPdfViewerPage, pageInfoModel,
  pdfViewerHandoffModelFromOutput,
  actionObservationPerceiveOpts, actionResultPdfViewerMeta, actionSettleBaseline, isCardsPerceiveOutput,
  leftoverCardsCount, isScrollActionTarget, isLeftoverFeedCardsSettle,
  isDocumentScrollEdgeTarget, tagScrollLeftoverSettle,
  isLeftoverDefaultAxScrollSettle, stripPerceiveRectChrome, stripPerceiveIdentityChrome,
  isPerceiveDecorativeTitleChrome, isVisibleControlTimestampName, visibleControlNameFromLine, extractVisibleControlLabels,
  uniqueVisibleControlCapSwapSamples,
  isPdfViewerPerceiveOutput, pdfViewerSettleDiffText,
  isFramedPerceiveOutput, shouldCaptureTopLevelActionSettle, actionSettleObserveOpts,
  actionDomDiffShowsChange, noBaselineActionDiffText,
  formControlStateChanged, formatFormControlStateDiff, shouldSnapshotFormControlState,
  parseFormControlStateSnapshot, snapshotFormControlState,
  sampleRootFrameTables, tableObservationStr, tableCollectionStr,
  parseShotArgs, shotStr, formatScreenshotCaptureDiagnostics,
  parseSpawnDebugBrowserArgs, detectBrowserPath, buildSpawnDebugBrowserPlan,
  probeTcpPort,
  getWsUrl, waitForSpawnedCdp, formatSpawnDebugBrowserReadinessFailure, spawnDebugBrowserStr,
  listSpawnedDebugTargets, pickSpawnedTarget, buildSpawnDebugBrowserModel, formatSpawnDebugBrowserOutput,
  readLastCdpEndpoint, writeLastCdpEndpoint, rememberLastCdpEndpoint, formatCdpRelaunchCommand,
  cdpUnreachableError, profileDirFromCommandLine, profileDirFromDevToolsActivePort,
  overlayDetectorScript, formatOverlayReport, resolveOverlayTargetPoint, overlayStr,
  dismissModalStr, dismissModalScript,
  // Screenshot
  captureScreenshot, screencastFallback,
  resetScreenshotTier, getScreenshotTier, SCREENSHOT_TIMEOUT,
  // Constants
  ENRICHED_ROLES, INTERACTIVE_ROLES, CONTENT_REF_ROLES,
  isSkipLinkAxNode, isSkipLinkName, isLicenseBlobUrl,
  perceiveSnapshotOpts, resolveSinceActionPerceiveOpts, perceiveArgsIncludeSnapshotShape,
  DOCTOR_LIST_TARGET_PLACEHOLDER,
  // Cascade source mapping
  decodeVLQ, mapLineToSource, mapInlineSourceMap, stripVitePathQuery, mapStyleSource,
  // Batch / flow / doctor
  formatBatchResults, runBatchCommands, parseBatchArgs, parseFlowSteps, settleFlow, flowStr,
  formatCliError, formatDaemonCommandError, buildCliErrorModel, parseOpenArgs, openNavigationScript, openReadyProbeScript, waitForOpenReady, waitForOpenTargetUrl, navigateOpenTarget, buildOpenModel, formatOpenReadyMessage, formatOpenNextPerceiveCommand, formatOpenAttachWaitMessage, shouldAnnounceOpenAttachWait, formatOpenTimeoutMessage, formatOpenAutoPerceiveFailure,
  DEFAULT_OPEN_ATTACH_TIMEOUT_MS,
  CLI_HELP_LAYOUT, CLI_HELP_TEMPLATE, renderCliHelp, helpStr, helpTopicStr,
  checkNode, checkSkillSymlink, checkDaemonSockets, checkFdLimit, checkCdpReachability, checkBrowserTargets, checkBrowserPermission,
  detectRuntimeEnvironment, checkRuntimeEnvironment,
  discoverNode22, resolveChromeCdpNodeLaunch, formatNodeRerunCommand, nodeMajor,
  doctorWizardModel, doctorWizardSummary, doctorCheckSeverity,
  doctorNextSteps, doctorStatusSummary, buildDoctorModel, formatDoctorOutput,
  formatDoctorReport, runDoctorChecks, doctorStr,
  doctorProbeFromTargets, doctorProbeFromChecks,
  buildStopResult, formatStopResult, stopDaemons,
  // Issues #82-#87 helpers
  isBlankPageUrl, pageTargetScore, rankPageTargets, matchPageTargets, selectPageTarget,
  parseTargetSelectArgs, buildTargetSelectModel, formatTargetSelect,
  parseQaModeArgs, buildQaSummaryModel, formatQaSummaryText, livePageIdentity, truncateTextLines,
  pdfViewerNextCommand, pdfViewerHandoffModel, pdfViewerReportRecommendation,
  classifyPageHealth, pageHealthScript, collectPageHealth,
  parseResponsiveAuditArgs, buildResponsiveAuditModel, formatResponsiveAuditReport,
  responsiveAuditViewportScript, responsiveAuditStr, countNetworkFailures,
  stylesStr,
  emptyTabGroupStore, normalizeTabGroupName, normalizeTabGroupStore, readTabGroups, writeTabGroups,
  upsertTabGroup, removeTabGroupMember, deleteTabGroup, getTabGroup,
  parseTabGroupArgs, formatTabGroupStore, formatTabGroup,
  listKnownLiveTargetIds, resolveTabGroupMember, resolveTabGroupMembers,
  parseBroadcastArgs, buildBroadcastModel, formatBroadcastResult,
  parseComponentsArgs, frameworkDetectorScript, reactComponentsTreeScript, vueComponentsTreeScript,
  sanitizeComponentValue, sanitizeComponentResult, componentsStr, chooseAdaptivePerceiveLast,
  COMMANDS, NEEDS_TARGET, commandMeta, buildApplicationCommandSpecs, createApplicationCommandRegistry,
  DAEMON_APPLICATION_COMMANDS, DAEMON_HANDLER_BUILDERS, preflightDaemonApplication,
  createReportCommandHandler, createPerceiveCommandHandler,
  createClickCommandHandler, parseClickArgs, parseFillArgs, createEvalrawCommandHandler,
  buildCliErrorRecovery,
  authorizeDaemonApplicationCommand, executeDaemonApplicationRoute,
  daemonRequestMayHaveSideEffects,
  fillableControlProbeDeclaration, notFillableControlError,
  fillLiveValueAccepted, fillValueRejectedError, fillLiveValuePageScript,
  looksLikeClipboardControl, isExpectedClipboardNoChange,
  TABLE_COLLECTION_DEADLINES, TableCollectionDeadlineError,
  createDaemonRequestExecutionContext, createTableCollectionRuntime,
  runTableCollectionLifecycle, createDaemonRequestConnection,
  createDaemonShutdown, enforceDaemonTableCollectionGate,
} : undefined;
