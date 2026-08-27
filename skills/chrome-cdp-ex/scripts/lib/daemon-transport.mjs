import net from 'net';
import { posix as posixPath } from 'path';
import { isTableCollectArgs } from './table-contract.mjs';

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
} = {}) {
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
  if (request?.cmd !== 'wait') return IPC_TIMEOUT;
  const waitMs = parseWaitMilliseconds(request.args?.[0]);
  return waitMs == null ? IPC_TIMEOUT : Math.max(IPC_TIMEOUT, waitMs + 5000);
}

export function requestDaemon(conn, request, options = {}) {
  const {
    runtimeDir = '',
    timeoutMs: requestedTimeoutMs,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
    mayHaveSideEffects = false,
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
    const closeDiagnostic = kind => responseFailure(new Error(
      `Connection closed before response. The daemon for this tab may have crashed or exited (idle timeout, page closed, or browser disconnect). Re-run "perceive <target>" to restart it; check ${runtimeDir} for stale sockets if this repeats.`,
    ), { mayHaveSideEffects, kind });
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
          try { conn.end(); } catch {}
          reject(responseFailure(error, { mayHaveSideEffects, kind: 'invalid-response' }));
        });
        return;
      }
      const hasResponseId = response !== null
        && (typeof response === 'object' || typeof response === 'function')
        && Object.hasOwn(response, 'id');
      if (hasResponseId && response.id !== requestId) {
        settle(() => {
          try { conn.end(); } catch {}
          const error = new Error(`Daemon response id ${response.id} did not match request id ${requestId}`);
          reject(responseFailure(error, { mayHaveSideEffects, kind: 'invalid-response' }));
        });
        return;
      }
      try {
        response = validateDaemonResponse(response, request);
      } catch (error) {
        settle(() => {
          try { conn.end(); } catch {}
          reject(responseFailure(error, { mayHaveSideEffects, kind: 'invalid-response' }));
        });
        return;
      }
      settle(() => {
        resolveResponse(response);
        try { conn.end(); } catch {}
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
