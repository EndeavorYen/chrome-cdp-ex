import { spawn as defaultSpawn, spawnSync as defaultSpawnSync } from 'child_process';
import { existsSync as defaultExistsSync, readdirSync as defaultReaddirSync, readFileSync as defaultReadFileSync } from 'fs';
import * as nodeModule from 'node:module';
import { homedir as defaultHomedir, tmpdir as defaultTmpdir } from 'os';
import { join as defaultJoin, posix as posixPath, win32 as win32Path } from 'path';
import { pathToFileURL } from 'url';

function pathApiForRoot(root, platform = process.platform) {
  const text = String(root ?? '');
  if (text.startsWith('/')) return posixPath;
  if (/^[A-Za-z]:[\\/]/.test(text) || text.startsWith('\\\\')) return win32Path;
  return platform === 'win32' ? win32Path : posixPath;
}

function joinRoot(root, ...parts) {
  return pathApiForRoot(root).join(root, ...parts);
}

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
  return joinRoot(nvmDir, 'versions', 'node', dir, 'bin', 'node');
}

function collectNode22Candidates({ home, env, execPath, execVersion, fs }) {
  const candidates = [];
  const add = (path) => {
    if (path && !candidates.includes(path)) candidates.push(path);
  };

  const execMajor = nodeMajor(execVersion);
  if (execPath && (execVersion == null || execMajor >= 22)) add(execPath);

  add(joinRoot(home, '.hermes', 'node', 'bin', 'node'));
  if (env.HERMES_HOME) add(joinRoot(env.HERMES_HOME, 'node', 'bin', 'node'));

  add(joinRoot(home, '.local', 'share', 'fnm', 'aliases', 'default', 'bin', 'node'));
  add(joinRoot(home, '.fnm', 'aliases', 'default', 'bin', 'node'));
  if (env.FNM_DIR) add(joinRoot(env.FNM_DIR, 'aliases', 'default', 'bin', 'node'));
  if (env.XDG_DATA_HOME) add(joinRoot(env.XDG_DATA_HOME, 'fnm', 'aliases', 'default', 'bin', 'node'));
  if (env.FNM_MULTISHELL_PATH) add(joinRoot(env.FNM_MULTISHELL_PATH, 'node'));

  const nvmDirs = [];
  if (env.NVM_DIR) nvmDirs.push(env.NVM_DIR);
  nvmDirs.push(joinRoot(home, '.nvm'));
  const seenNvm = new Set();
  for (const nvmDir of nvmDirs) {
    if (!nvmDir || seenNvm.has(nvmDir)) continue;
    seenNvm.add(nvmDir);
    const alias = readText(fs, joinRoot(nvmDir, 'alias', 'default'));
    if (alias && !alias.includes('/') && !alias.includes('*') && /\d/.test(alias)) {
      add(nvmNodeBinary(nvmDir, alias));
    }
    const names = nvmVersionNames(listDir(fs, joinRoot(nvmDir, 'versions', 'node')))
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

const COMPILE_CACHE_STATUS = nodeModule.constants?.compileCacheStatus ?? {
  FAILED: 0,
  ENABLED: 1,
  ALREADY_ENABLED: 2,
  DISABLED: 3,
};

// Node's own default. Children must inherit this directory, not the versioned
// subdirectory enableCompileCache() reports after the cache is already on.
export function defaultChromeCdpCompileCacheDir(tmpdir = defaultTmpdir, join = defaultJoin) {
  return join(tmpdir(), 'node-compile-cache');
}

function compileCacheIsEnabled(result) {
  return result?.status === COMPILE_CACHE_STATUS.ENABLED
    || result?.status === COMPILE_CACHE_STATUS.ALREADY_ENABLED;
}

// Best-effort. A missing API, a thrown call, or an unwritable directory must
// not print and must not change how the command runs.
export function enableChromeCdpCompileCache({
  enableCompileCache = nodeModule.enableCompileCache,
  env = process.env,
  cacheDir,
  tmpdir = defaultTmpdir,
  join = defaultJoin,
} = {}) {
  try {
    if (typeof enableCompileCache !== 'function') return { enabled: false, reason: 'unavailable' };
    const userDir = env?.NODE_COMPILE_CACHE;
    const requestedDir = userDir || cacheDir || defaultChromeCdpCompileCacheDir(tmpdir, join);
    const result = userDir ? enableCompileCache() : enableCompileCache(requestedDir);
    const enabled = compileCacheIsEnabled(result);
    if (enabled && env && !env.NODE_COMPILE_CACHE) env.NODE_COMPILE_CACHE = requestedDir;
    return { enabled, directory: enabled ? (userDir || requestedDir) : undefined, result };
  } catch {
    return { enabled: false, reason: 'threw' };
  }
}

function spawnInherited(spawnProcess, binary, args, env, exit, stderr) {
  const child = spawnProcess(binary, args, {
    stdio: 'inherit',
    env,
  });
  if (!child || typeof child.on !== 'function') return child;
  child.on('exit', code => exit(code ?? 1));
  child.on('error', error => {
    stderr(error?.message || error);
    exit(1);
  });
  return child;
}

// Node >= 22 runs cdp.mjs in this process. argv[1] has to be that script:
// daemon metadata defaults scriptPath to argv[1], and cdp.mjs only enters
// main when argv[1] is itself. Node < 22 still re-execs and does not import.
export async function startChromeCdpCli({
  scriptPath,
  version = process.version,
  execPath = process.execPath,
  argv = process.argv,
  env = process.env,
  spawnProcess = defaultSpawn,
  importModule,
  enableCompileCache,
  flushCompileCache = nodeModule.flushCompileCache,
  cacheDir,
  discover,
  home,
  fs,
  spawnSync: spawnSyncFn,
  exit = code => process.exit(code),
  stderr = (...args) => console.error(...args),
} = {}) {
  if (!scriptPath) throw new Error('chrome-cdp launcher requires scriptPath');
  const launch = resolveChromeCdpNodeLaunch({
    version,
    execPath,
    argv,
    env,
    discover,
    home,
    fs,
    spawnSync: spawnSyncFn,
  });
  if (launch.action === 'reexec') {
    spawnInherited(spawnProcess, launch.binary, launch.args, launch.env, exit, stderr);
    return { action: 'reexec' };
  }
  if (launch.action === 'fail') {
    stderr(launch.message);
    exit(1);
    return { action: 'fail' };
  }
  enableChromeCdpCompileCache({
    env,
    cacheDir,
    // Undefined keeps the real API. Null stands for a Node build without it.
    ...(enableCompileCache !== undefined ? { enableCompileCache } : {}),
  });
  const nextArgv = [execPath, scriptPath, ...argv.slice(2)];
  argv.splice(0, argv.length, ...nextArgv);
  const load = importModule || (href => import(href));
  await load(pathToFileURL(scriptPath).href);
  try { flushCompileCache?.(); } catch { /* cache flush is optional */ }
  return { action: 'use-current' };
}
