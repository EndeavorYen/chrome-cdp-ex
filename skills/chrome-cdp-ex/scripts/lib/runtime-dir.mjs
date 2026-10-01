// The per-user directory the CLI and its tab daemons write sockets, caches and screenshots to.
// cdp.mjs and the MCP server both resolve it here, so the MCP server can tell whether a
// screenshot path a command printed is one of the CLI's own output files (#465).
import { homedir as defaultHomedir } from 'os';
import { resolve } from 'path';

export function resolveRuntimeDir({ platform = process.platform, env = process.env, homedir = defaultHomedir } = {}) {
  if (platform === 'win32') return resolve(env.LOCALAPPDATA || resolve(homedir(), 'AppData', 'Local'), 'cdp');
  return env.XDG_RUNTIME_DIR
    ? resolve(env.XDG_RUNTIME_DIR, 'cdp')
    : resolve(homedir(), '.cache', 'cdp');
}
