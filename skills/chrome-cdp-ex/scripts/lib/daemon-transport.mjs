import { lstatSync, statSync } from 'fs';
import net from 'net';
import { posix as posixPath } from 'path';
import { isTableCollectArgs } from './table-contract.mjs';
import { expectDownloadIpcTimeoutMs } from './click-download.mjs';

const IPC_TIMEOUT = 120000;
const TABLE_COLLECTION_IPC_TIMEOUT = 315000;
const DEFAULT_CONNECT_TIMEOUT = 5000;
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_TRANSPORT_DIAGNOSTIC_CHARS = 512;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

function boundedDiagnostic(value, maxChars = MAX_TRANSPORT_DIAGNOSTIC_CHARS) {
  const text = String(value ?? '').trim() || 'unknown transport failure';
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

function transportCause(error, { phase, kind }) {
  const cause = {
    phase,
    kind,
    message: boundedDiagnostic(error?.message || error),
  };
  if (typeof error?.code === 'string' && error.code) {
    cause.code = boundedDiagnostic(error.code, 64);
  }
  return Object.freeze(cause);
}

export class DaemonTransportError extends Error {
  constructor(error, { phase, kind }) {
    super('The daemon did not return a validated Action Result. The action may have taken effect; do not repeat it until page state is verified.', { cause: error });
    this.name = 'DaemonTransportError';
    this.code = 'DAEMON_COMPLETION_UNKNOWN';
    this.completion = 'unknown';
    this.sideEffectMayHaveOccurred = true;
    this.retrySafe = false;
    this.transportCause = transportCause(error, { phase, kind });
  }
}

function responseFailure(error, { mayHaveSideEffects, phase = 'awaiting-response', kind }) {
  return mayHaveSideEffects
    ? new DaemonTransportError(error, { phase, kind })
    : error;
}

function validateDaemonResponse(response, request) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw new Error('Invalid daemon response: expected an object');
  }
  if (typeof response.ok !== 'boolean') {
    throw new Error('Invalid daemon response: expected boolean ok');
  }
  const legacyResultlessStop = request?.cmd === 'stop'
    && response.stopAfter === true
    && !Object.hasOwn(response, 'result');
  if (response.ok === true && typeof response.result !== 'string' && !legacyResultlessStop) {
    throw new Error('Invalid daemon response: successful response requires a string result');
  }
  if (response.ok === false && typeof response.error !== 'string') {
    throw new Error('Invalid daemon response: failed response requires error');
  }
  return response;
}

// sun_path holds 108 bytes on Linux and 104 on macOS/BSD, including the trailing NUL. libuv
// silently truncates a longer path on both listen and connect, so two tabs' sockets can collapse
// into one (#444). Windows named pipes have no such limit.
const UNIX_SOCKET_PATH_MAX_BYTES = { linux: 107, default: 103 };

export function daemonEndpointTooLongError(endpoint, { platform = process.platform } = {}) {
  if (platform === 'win32') return null;
  const max = UNIX_SOCKET_PATH_MAX_BYTES[platform] ?? UNIX_SOCKET_PATH_MAX_BYTES.default;
  const bytes = Buffer.byteLength(String(endpoint || ''));
  if (bytes <= max) return null;
  const err = new Error(
    `Daemon socket path is ${bytes} bytes, over the ${max}-byte Unix socket limit: ${endpoint}. `
    + 'The OS would truncate it and tabs could share one socket. Set a shorter XDG_RUNTIME_DIR '
    + '(e.g. XDG_RUNTIME_DIR=/tmp/cdp-rt) and retry.'
  );
  err.code = 'daemon_socket_path_too_long';
  return err;
}

export function daemonEndpointForPlatform(targetId, {
  platform = process.platform,
  runtimeDir,
} = {}) {
  if (platform === 'win32') return `\\\\.\\pipe\\cdp-${targetId}`;
  return posixPath.resolve(runtimeDir, `cdp-${targetId}.sock`);
}

export function connectToDaemon(endpoint, {
  connect = path => net.connect(path),
  timeoutMs = DEFAULT_CONNECT_TIMEOUT,
  platform = process.platform,
} = {}) {
  const tooLong = daemonEndpointTooLongError(endpoint, { platform });
  if (tooLong) return Promise.reject(tooLong);
  return new Promise((resolveConnection, reject) => {
    let settled = false;
    const conn = connect(endpoint);
    const settle = (operation) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.off('connect', onConnect);
      conn.off('error', onError);
      operation();
    };
    const onConnect = () => settle(() => resolveConnection(conn));
    const onError = error => settle(() => reject(error));
    const timer = setTimeout(() => {
      settle(() => {
        conn.destroy();
        reject(new Error(`Timed out connecting to daemon socket: ${endpoint}`));
      });
    }, timeoutMs);
    conn.on('connect', onConnect);
    conn.on('error', onError);
  });
}

// A connect that fails with one of these proves no daemon listens at the endpoint.
export const DAEMON_ENDPOINT_ABSENT_CODES = new Set(['ENOENT', 'ECONNREFUSED', 'ENOTSOCK']);
const DAEMON_PROBE_TIMEOUT_MS = 1000;
const DAEMON_SOCKET_WATCH_MS = 5000;

// 'answers' (a daemon accepted), 'absent' (proved empty or stale) or 'unknown' (a timeout or
// EACCES could be a slow but live daemon, so the path must not be taken over).
export async function probeDaemonEndpoint(endpoint, {
  connect = (path, options) => connectToDaemon(path, options),
  timeoutMs = DAEMON_PROBE_TIMEOUT_MS,
} = {}) {
  try {
    const conn = await connect(endpoint, { timeoutMs });
    try { conn?.destroy?.(); } catch {}
    return 'answers';
  } catch (error) {
    return DAEMON_ENDPOINT_ABSENT_CODES.has(error?.code) ? 'absent' : 'unknown';
  }
}

// dev+ino (+ change time) of the socket file now at `endpoint`. A daemon records it once
// bound, so it can later tell its own socket from one a newer daemon bound at the same path
// (#458). ext4 hands a just-freed inode number straight back to the next bind, so dev+ino
// alone cannot tell a stale file from its replacement; the nanosecond ctime can.
export function daemonSocketIdentity(endpoint, { stat = statSync } = {}) {
  try {
    const stats = stat(endpoint, { bigint: true });
    const identity = { dev: stats.dev, ino: stats.ino };
    const ctime = stats.ctimeNs ?? stats.ctimeMs;
    if (ctime !== undefined) identity.ctime = ctime;
    return identity;
  } catch {
    return null;
  }
}

export function sameDaemonSocket(a, b) {
  if (!a || !b || a.dev !== b.dev || a.ino !== b.ino) return false;
  return a.ctime === undefined || b.ctime === undefined || a.ctime === b.ctime;
}

// Binds a daemon endpoint without taking it from a live daemon (#458). A POSIX socket path
// outlives its process, so `listen` fails with EADDRINUSE on a stale file as well as on a
// live daemon's socket; only a probe that proves the path absent lets the stale file go.
// A live (or unprovable) holder is reported, never unlinked, and the caller exits.
// The stale file is unlinked only if it is still the file that was probed (same dev/ino
// before the probe and right before the unlink): when another daemon replaced it meanwhile,
// listening again fails and the next probe finds that daemon. That leaves only the gap
// between two back-to-back syscalls for a takeover.
// Windows named pipes vanish with their process and a second listen fails by itself, so
// win32 keeps its plain listen. `listen(endpoint)` resolves once listening, rejects on error.
const MAX_DAEMON_CLAIM_ATTEMPTS = 3;

export async function claimDaemonEndpoint(endpoint, {
  platform = process.platform,
  listen,
  probe = path => probeDaemonEndpoint(path),
  unlink,
  stat = statSync,
  lstat = lstatSync,
} = {}) {
  if (platform === 'win32') {
    await listen(endpoint);
    return { claimed: true, identity: null };
  }
  for (let attempt = 1; ; attempt++) {
    try {
      await listen(endpoint);
      return { claimed: true, identity: daemonSocketIdentity(endpoint, { stat }) };
    } catch (error) {
      if (error?.code !== 'EADDRINUSE') throw error;
      const probed = daemonSocketIdentity(endpoint, { stat: lstat });
      const holder = await probe(endpoint);
      if (holder !== 'absent') return { claimed: false, holder, identity: null };
      // Still stale after repeated cleanups: something other than a daemon keeps re-creating the path.
      if (attempt >= MAX_DAEMON_CLAIM_ATTEMPTS) throw error;
      if (probed && sameDaemonSocket(probed, daemonSocketIdentity(endpoint, { stat: lstat }))) {
        try { unlink(endpoint); } catch (unlinkError) {
          if (unlinkError?.code !== 'ENOENT') throw unlinkError;
        }
      }
    }
  }
}

// Calls `onLost` once when the socket at `endpoint` is no longer the one this daemon bound
// (replaced or removed). Such a daemon is unreachable, and staying up would leave an attached
// orphan that only the idle timer ends. A stat error other than ENOENT is not proof.
export function watchDaemonSocket(endpoint, {
  identity,
  onLost,
  stat = statSync,
  intervalMs = DAEMON_SOCKET_WATCH_MS,
  setTimer = setInterval,
  clearTimer = clearInterval,
} = {}) {
  if (!identity) return () => {};
  let timer = null;
  const stop = () => {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  };
  timer = setTimer(() => {
    if (timer === null) return;
    let current;
    try {
      current = stat(endpoint);
    } catch (error) {
      if (error?.code !== 'ENOENT') return;
      current = null;
    }
    if (sameDaemonSocket(identity, current)) return;
    stop();
    onLost();
  }, intervalMs);
  timer?.unref?.();
  return stop;
}

function parseLoadAllTimeoutMilliseconds(args = []) {
  for (let i = 0; i < args.length; i++) {
    const token = String(args[i] || '');
    let raw = null;
    if (token === '--timeout-ms') raw = args[i + 1];
    else if (token.startsWith('--timeout-ms=')) raw = token.slice('--timeout-ms='.length);
    if (raw == null) continue;
    const milliseconds = Number(raw);
    if (Number.isSafeInteger(milliseconds) && milliseconds >= 1) return milliseconds;
  }
  return 30_000;
}

function parseWaitMilliseconds(value) {
  const raw = String(value ?? '').trim();
  if (!/^\d+$/.test(raw)) return null;
  const milliseconds = Number(raw);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1 || milliseconds > 60 * 60 * 1000) return null;
  return milliseconds;
}

export function ipcTimeoutForRequest(request) {
  const tableCollect = request?.cmd === 'table'
    ? isTableCollectArgs(request.args || [])
    : false;
  const timeoutCeiling = tableCollect ? TABLE_COLLECTION_IPC_TIMEOUT : IPC_TIMEOUT;
  if (Number.isFinite(request?.timeoutMs) && request.timeoutMs > 0) {
    return Math.min(Math.max(100, Math.trunc(request.timeoutMs)), timeoutCeiling);
  }
  if (tableCollect) return TABLE_COLLECTION_IPC_TIMEOUT;
  if (request?.cmd === 'loadall') {
    const loadallMs = parseLoadAllTimeoutMilliseconds(request.args || []);
    return Math.max(IPC_TIMEOUT, Math.min(loadallMs + 5000, 5 * 60 * 1000 + 5000));
  }
  if (request?.cmd === 'click') {
    // click --expect-download waits up to its --timeout for the file (#472).
    const downloadMs = expectDownloadIpcTimeoutMs(request.args || []);
    return downloadMs == null ? IPC_TIMEOUT : Math.max(IPC_TIMEOUT, downloadMs);
  }
  if (request?.cmd !== 'wait') return IPC_TIMEOUT;
  const waitMs = parseWaitMilliseconds(request.args?.[0]);
  return waitMs == null ? IPC_TIMEOUT : Math.max(IPC_TIMEOUT, waitMs + 5000);
}

// Close the client side of a one-shot daemon connection after its reply frame.
// Why destroy() and not end(): the protocol is one request, one newline-terminated
// response frame per connection. This runs only after that whole frame (up to and
// including its terminating newline) has been received and parsed, and the daemon has already
// consumed the request (it replied). Nothing the client needs can still be in
// flight, so no response is ever truncated; any later bytes (a duplicate frame)
// were ignored before too. end() waits for a graceful half-close, which on a
// Windows named pipe held the process ~51 ms after every reply
// (docs/perf/2026-09-30-cli-preamble.md, local result). The daemon treats the
// client's reset exactly like a FIN: createDaemonRequestConnection routes 'end',
// 'close' and 'error' to the same disconnect path, after the reply write flushed.
function closeAfterFrame(conn) {
  try { conn.destroy(); } catch {}
}

export function requestDaemon(conn, request, options = {}) {
  const {
    runtimeDir = '',
    timeoutMs: requestedTimeoutMs,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
    mayHaveSideEffects = false,
    crashReport = null,
  } = options;
  const timeoutCeiling = ipcTimeoutForRequest(request);
  const timeoutMs = Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0
    ? Math.min(Math.max(1, Math.trunc(requestedTimeoutMs)), timeoutCeiling)
    : timeoutCeiling;
  return new Promise((resolveResponse, reject) => {
    const requestId = 1;
    const chunks = [];
    let bufferedBytes = 0;
    let settled = false;
    const cleanup = () => {
      conn.off('data', onData);
      conn.off('error', onError);
      conn.off('end', onEnd);
      conn.off('close', onClose);
    };
    const settle = (operation) => {
      if (settled) return;
      settled = true;
      cleanup();
      clearTimeout(timer);
      operation();
    };
    const closeDiagnostic = kind => {
      let crash = null;
      try { crash = typeof crashReport === 'function' ? crashReport() : null; } catch {}
      return responseFailure(new Error(crash
        ? `Connection closed before response: the daemon for this tab crashed (${crash}). Re-run "perceive <target>" to restart it.`
        : `Connection closed before response. The daemon for this tab may have crashed or exited (idle timeout, page closed, or browser disconnect). Re-run "perceive <target>" to restart it; check ${runtimeDir} for stale sockets if this repeats.`,
      ), { mayHaveSideEffects, kind });
    };
    const onData = chunk => {
      const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      const newline = incoming.indexOf(10);
      const nextFrameBytes = bufferedBytes + (newline === -1 ? incoming.length : newline);
      if (nextFrameBytes > maxResponseBytes) {
        settle(() => {
          conn.destroy();
          const error = new Error(`Daemon response exceeded ${maxResponseBytes} bytes`);
          reject(responseFailure(error, { mayHaveSideEffects, kind: 'response-too-large' }));
        });
        return;
      }
      if (newline === -1) {
        chunks.push(incoming);
        bufferedBytes = nextFrameBytes;
        return;
      }
      chunks.push(incoming.subarray(0, newline));
      const frame = Buffer.concat(chunks, nextFrameBytes);
      let response;
      try {
        response = JSON.parse(UTF8_DECODER.decode(frame));
      } catch (error) {
        settle(() => {
          closeAfterFrame(conn);
          reject(responseFailure(error, { mayHaveSideEffects, kind: 'invalid-response' }));
        });
        return;
      }
      const hasResponseId = response !== null
        && (typeof response === 'object' || typeof response === 'function')
        && Object.hasOwn(response, 'id');
      if (hasResponseId && response.id !== requestId) {
        settle(() => {
          closeAfterFrame(conn);
          const error = new Error(`Daemon response id ${response.id} did not match request id ${requestId}`);
          reject(responseFailure(error, { mayHaveSideEffects, kind: 'invalid-response' }));
        });
        return;
      }
      try {
        response = validateDaemonResponse(response, request);
      } catch (error) {
        settle(() => {
          closeAfterFrame(conn);
          reject(responseFailure(error, { mayHaveSideEffects, kind: 'invalid-response' }));
        });
        return;
      }
      settle(() => {
        resolveResponse(response);
        closeAfterFrame(conn);
      });
    };
    const onError = error => settle(() => reject(responseFailure(error, {
      mayHaveSideEffects,
      kind: 'peer-error',
    })));
    const onEnd = () => settle(() => reject(closeDiagnostic('peer-end')));
    const onClose = () => settle(() => reject(closeDiagnostic('peer-close')));
    const timer = setTimeout(() => {
      settle(() => {
        conn.destroy();
        const error = new Error(`IPC timeout: command "${request.cmd}" took longer than ${timeoutMs / 1000}s`);
        reject(responseFailure(error, { mayHaveSideEffects, kind: 'timeout' }));
      });
    }, timeoutMs);

    conn.on('data', onData);
    conn.on('error', onError);
    conn.on('end', onEnd);
    conn.on('close', onClose);
    let payload;
    try {
      request.id = requestId;
      payload = `${JSON.stringify(request)}\n`;
    } catch (error) {
      settle(() => reject(error));
      return;
    }
    try {
      conn.write(payload);
    } catch (error) {
      settle(() => reject(responseFailure(error, {
        mayHaveSideEffects,
        phase: 'sending-request',
        kind: 'write-error',
      })));
    }
  });
}
