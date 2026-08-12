import net from 'net';
import { resolve } from 'path';

const IPC_TIMEOUT = 120000;
const DEFAULT_CONNECT_TIMEOUT = 5000;
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

export function daemonEndpointForPlatform(targetId, {
  platform = process.platform,
  runtimeDir,
} = {}) {
  if (platform === 'win32') return `\\\\.\\pipe\\cdp-${targetId}`;
  return resolve(runtimeDir, `cdp-${targetId}.sock`);
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

function parseWaitMilliseconds(value) {
  const raw = String(value ?? '').trim();
  if (!/^\d+$/.test(raw)) return null;
  const milliseconds = Number(raw);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1 || milliseconds > 60 * 60 * 1000) return null;
  return milliseconds;
}

export function ipcTimeoutForRequest(request) {
  if (Number.isFinite(request?.timeoutMs) && request.timeoutMs > 0) {
    return Math.min(Math.max(100, Math.trunc(request.timeoutMs)), IPC_TIMEOUT);
  }
  if (request?.cmd !== 'wait') return IPC_TIMEOUT;
  const waitMs = parseWaitMilliseconds(request.args?.[0]);
  return waitMs == null ? IPC_TIMEOUT : Math.max(IPC_TIMEOUT, waitMs + 5000);
}

export function requestDaemon(conn, request, {
  runtimeDir = '',
  timeoutMs = ipcTimeoutForRequest(request),
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
} = {}) {
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
    const closeDiagnostic = () => new Error(
      `Connection closed before response. The daemon for this tab may have crashed or exited (idle timeout, page closed, or browser disconnect). Re-run "perceive <target>" to restart it; check ${runtimeDir} for stale sockets if this repeats.`,
    );
    const onData = chunk => {
      const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      const newline = incoming.indexOf(10);
      const nextFrameBytes = bufferedBytes + (newline === -1 ? incoming.length : newline);
      if (nextFrameBytes > maxResponseBytes) {
        settle(() => {
          conn.destroy();
          reject(new Error(`Daemon response exceeded ${maxResponseBytes} bytes`));
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
          reject(error);
        });
        return;
      }
      const hasResponseId = response !== null
        && (typeof response === 'object' || typeof response === 'function')
        && Object.hasOwn(response, 'id');
      if (hasResponseId && response.id !== requestId) {
        settle(() => {
          try { conn.end(); } catch {}
          reject(new Error(`Daemon response id ${response.id} did not match request id ${requestId}`));
        });
        return;
      }
      settle(() => {
        resolveResponse(response);
        try { conn.end(); } catch {}
      });
    };
    const onError = error => settle(() => reject(error));
    const onEnd = () => settle(() => reject(closeDiagnostic()));
    const onClose = () => settle(() => reject(closeDiagnostic()));
    const timer = setTimeout(() => {
      settle(() => {
        conn.destroy();
        reject(new Error(`IPC timeout: command "${request.cmd}" took longer than ${timeoutMs / 1000}s`));
      });
    }, timeoutMs);

    conn.on('data', onData);
    conn.on('error', onError);
    conn.on('end', onEnd);
    conn.on('close', onClose);
    try {
      request.id = requestId;
      conn.write(`${JSON.stringify(request)}\n`);
    } catch (error) {
      settle(() => reject(error));
    }
  });
}
