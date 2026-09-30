// One CDP WebSocket for the whole session: request/reply by id, events by method.
// `ws` is any object with addEventListener('message'|'close'), send(text), close().
import { readFileSync } from 'node:fs';

const DEFAULT_TIMEOUT_MS = 30000;

export function createTransport(ws) {
  let nextId = 0;
  let closed = false;
  const pending = new Map();
  const listeners = new Map();

  function failAll(error) {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    pending.clear();
  }

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject, timer } = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(timer);
      if (msg.error) reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
      else resolve(msg.result ?? {});
    } else if (msg.method) {
      for (const handler of [...(listeners.get(msg.method) || [])]) handler(msg.params, msg.sessionId);
    }
  });
  ws.addEventListener('close', () => {
    closed = true;
    failAll(new Error('connection closed'));
  });

  return {
    send(method, params = {}, sessionId, timeoutMs = DEFAULT_TIMEOUT_MS) {
      if (closed) return Promise.reject(new Error('connection closed'));
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} timed out after ${timeoutMs} ms`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        const message = { id, method, params };
        if (sessionId) message.sessionId = sessionId;
        ws.send(JSON.stringify(message));
      });
    },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(handler);
      return () => listeners.get(event)?.delete(handler);
    },
    close() {
      ws.close();
    },
  };
}

function defaultPortFile(env, platform) {
  if (env.CDP_PORT_FILE) return env.CDP_PORT_FILE;
  if (platform === 'win32') return `${env.LOCALAPPDATA || ''}/Google/Chrome/User Data/DevToolsActivePort`.replaceAll('\\', '/');
  if (platform === 'darwin') return `${env.HOME || ''}/Library/Application Support/Google/Chrome/DevToolsActivePort`;
  return `${env.HOME || ''}/.config/google-chrome/DevToolsActivePort`;
}

export async function resolveWsUrl({ host = '127.0.0.1', port, fetchImpl = fetch, readFile = (p) => readFileSync(p, 'utf8'), env = process.env, platform = process.platform, timeoutMs = 3000 }) {
  let httpStatus = null;
  try {
    const res = await fetchImpl(`http://${host}:${port}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
    httpStatus = res.status;
    if (res.ok) {
      const info = await res.json();
      // Keep only the path: the reported host may be "localhost" while `host` points elsewhere (as cdp.mjs does).
      if (info.webSocketDebuggerUrl) return `ws://${host}:${port}${new URL(info.webSocketDebuggerUrl).pathname}`;
    }
  } catch {
    // fall through to DevToolsActivePort
  }
  try {
    const [filePort, path] = readFile(defaultPortFile(env, platform)).trim().split(/\r?\n/);
    // The file may name another browser (e.g. the main one on 9222 while 9224 is down). CDP_PORT_FILE only
    // chooses which file to read; its port must still equal the requested one.
    if (filePort && path && filePort === String(port)) return `ws://${host}:${filePort}${path}`;
  } catch {
    // fall through below
  }
  // Websocket-only mode (Chrome 136+ toggle, SSH tunnel): /json/version is 404 but /devtools/browser answers.
  // Other HTTP failures usually mean a non-CDP service holds the port, so they do not fall back.
  if (httpStatus === 404) return `ws://${host}:${port}/devtools/browser`;
  throw new Error(`cannot reach CDP on ${host}:${port} (no /json/version and no readable DevToolsActivePort)`);
}

export async function attachToTarget(transport, prefix) {
  const { targetInfos } = await transport.send('Target.getTargets');
  const wanted = String(prefix).toUpperCase();
  const matches = targetInfos.filter((t) => t.type === 'page' && t.targetId.toUpperCase().startsWith(wanted));
  if (matches.length === 0) throw new Error(`no page matches target prefix "${prefix}"`);
  if (matches.length > 1) {
    const list = matches.map((t) => `${t.targetId.slice(0, 8)} ${t.url}`).join(', ');
    throw new Error(`target prefix "${prefix}" matches ${matches.length} pages: ${list}`);
  }
  const { sessionId } = await transport.send('Target.attachToTarget', { targetId: matches[0].targetId, flatten: true });
  return { sessionId, targetId: matches[0].targetId };
}

export async function connect({ host = '127.0.0.1', port, target, WebSocketImpl = WebSocket, fetchImpl = fetch, readFile, env, platform, openTimeoutMs = 10000 } = {}) {
  const url = await resolveWsUrl({ host, port, fetchImpl, readFile, env, platform });
  const ws = new WebSocketImpl(url);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* already closed */ }
      reject(new Error(`WebSocket connection to ${url} timed out after ${openTimeoutMs} ms`));
    }, openTimeoutMs);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error(`WebSocket connection to ${url} failed`)); }, { once: true });
  });
  const transport = createTransport(ws);
  try {
    const { sessionId, targetId } = await attachToTarget(transport, target);
    return { transport, sessionId, targetId, close: () => transport.close() };
  } catch (error) {
    transport.close();
    throw error;
  }
}
