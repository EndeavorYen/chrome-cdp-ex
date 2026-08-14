import { spawnSync as defaultSpawnSync } from 'child_process';
import { existsSync as defaultExistsSync, readdirSync as defaultReaddirSync, readFileSync as defaultReadFileSync } from 'fs';
import { homedir as defaultHomedir } from 'os';
import { join } from 'path';

export const NODE_REEXEC_ENV = 'CHROME_CDP_NODE_REEXEC';
export const NODE_PROBE_TIMEOUT_MS = 1500;
export const NODE22_MISSING_HINT = 'Install Node.js 22 or set PATH to a Node 22 binary (Hermes ~/.hermes/node/bin/node, fnm, or nvm). chrome-cdp-ex uses built-in WebSocket which requires Node 22.';

export function nodeMajor(version) {
  return parseInt(String(version || '').replace(/^v/, '').split('.')[0], 10) || 0;
}

export function formatNodeRerunCommand(binary, scriptPath, command = 'doctor') {
  return `${binary} ${scriptPath} ${command}`;
}

function probeNodeVersion(binary, spawnSyncFn, timeout = NODE_PROBE_TIMEOUT_MS) {
  try {
    const res = spawnSyncFn(binary, ['-p', 'process.version'], {
      encoding: 'utf8',
      timeout,
      windowsHide: true,
    });
    if (res.status !== 0) return null;
    const version = String(res.stdout || '').trim();
    if (nodeMajor(version) < 22) return null;
    return { binary, version };
  } catch {
    return null;
  }
}

function versionTuple(version) {
  const parts = String(version || '').replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

function cmpVersion(a, b) {
  const left = versionTuple(a);
  const right = versionTuple(b);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

function readText(fs, path) {
  try {
    return String(fs.readFileSync(path, 'utf8')).trim();
  } catch {
    return '';
  }
}

function listDir(fs, path) {
  try {
    return fs.readdirSync(path);
  } catch {
    return [];
  }
}

function nvmVersionNames(entries) {
  return entries.map(entry => (typeof entry === 'string' ? entry : entry?.name)).filter(Boolean);
}

function nvmNodeBinary(nvmDir, versionName) {
  const dir = String(versionName || '').startsWith('v') ? versionName : `v${versionName}`;
  return join(nvmDir, 'versions', 'node', dir, 'bin', 'node');
}

function collectNode22Candidates({ home, env, execPath, execVersion, fs }) {
  const candidates = [];
  const add = (path) => {
    if (path && !candidates.includes(path)) candidates.push(path);
  };

  const execMajor = nodeMajor(execVersion);
  if (execPath && (execVersion == null || execMajor >= 22)) add(execPath);

  add(join(home, '.hermes', 'node', 'bin', 'node'));
  if (env.HERMES_HOME) add(join(env.HERMES_HOME, 'node', 'bin', 'node'));

  add(join(home, '.local', 'share', 'fnm', 'aliases', 'default', 'bin', 'node'));
  add(join(home, '.fnm', 'aliases', 'default', 'bin', 'node'));
  if (env.FNM_DIR) add(join(env.FNM_DIR, 'aliases', 'default', 'bin', 'node'));
  if (env.XDG_DATA_HOME) add(join(env.XDG_DATA_HOME, 'fnm', 'aliases', 'default', 'bin', 'node'));
  if (env.FNM_MULTISHELL_PATH) add(join(env.FNM_MULTISHELL_PATH, 'node'));

  const nvmDirs = [];
  if (env.NVM_DIR) nvmDirs.push(env.NVM_DIR);
  nvmDirs.push(join(home, '.nvm'));
  const seenNvm = new Set();
  for (const nvmDir of nvmDirs) {
    if (!nvmDir || seenNvm.has(nvmDir)) continue;
    seenNvm.add(nvmDir);
    const alias = readText(fs, join(nvmDir, 'alias', 'default'));
    if (alias && !alias.includes('/') && !alias.includes('*') && /\d/.test(alias)) {
      add(nvmNodeBinary(nvmDir, alias));
    }
    const names = nvmVersionNames(listDir(fs, join(nvmDir, 'versions', 'node')))
      .filter(name => nodeMajor(name) >= 22)
      .sort((a, b) => cmpVersion(b, a));
    for (const name of names) add(nvmNodeBinary(nvmDir, name));
  }

  return candidates.filter(path => {
    try {
      return fs.existsSync(path);
    } catch {
      return false;
    }
  });
}

export function discoverNode22(opts = {}) {
  const home = opts.home ?? defaultHomedir();
  const env = opts.env ?? process.env;
  const execPath = opts.execPath ?? process.execPath;
  const execVersion = opts.execVersion;
  const fs = {
    existsSync: opts.fs?.existsSync ?? defaultExistsSync,
    readdirSync: opts.fs?.readdirSync ?? defaultReaddirSync,
    readFileSync: opts.fs?.readFileSync ?? defaultReadFileSync,
  };
  const spawnSyncFn = opts.spawnSync ?? defaultSpawnSync;

  if (nodeMajor(execVersion) >= 22 && execPath) {
    return { binary: execPath, version: execVersion };
  }

  const timeout = opts.timeout ?? NODE_PROBE_TIMEOUT_MS;
  for (const binary of collectNode22Candidates({ home, env, execPath, execVersion, fs })) {
    const found = probeNodeVersion(binary, spawnSyncFn, timeout);
    if (found) return found;
  }
  return null;
}

export function resolveChromeCdpNodeLaunch({
  version = process.version,
  execPath = process.execPath,
  argv = process.argv,
  env = process.env,
  discover,
  home,
  fs,
  spawnSync: spawnSyncFn,
} = {}) {
  if (nodeMajor(version) >= 22) {
    return { action: 'use-current', binary: execPath };
  }
  if (env?.[NODE_REEXEC_ENV]) {
    return { action: 'fail', message: NODE22_MISSING_HINT };
  }
  const found = typeof discover === 'function'
    ? discover()
    : discoverNode22({
      home,
      env,
      fs,
      spawnSync: spawnSyncFn,
      execPath,
      execVersion: version,
    });
  if (found?.binary && found.binary !== execPath) {
    return {
      action: 'reexec',
      binary: found.binary,
      args: argv.slice(1),
      env: { ...env, [NODE_REEXEC_ENV]: '1' },
    };
  }
  return { action: 'fail', message: NODE22_MISSING_HINT };
}
