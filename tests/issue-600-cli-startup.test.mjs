import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { __test__ as T } from '../skills/chrome-cdp-ex/scripts/cdp.mjs';
import {
  enableChromeCdpCompileCache,
  startChromeCdpCli,
} from '../skills/chrome-cdp-ex/scripts/lib/node-runtime.mjs';

const root = resolve(import.meta.dirname, '..');
const cdp = resolve(root, 'skills/chrome-cdp-ex/scripts/cdp.mjs');
const runtime = resolve(root, 'skills/chrome-cdp-ex/scripts/lib/node-runtime.mjs');
const probe = resolve(root, 'tests/fixtures/issue-600-launch-probe.mjs');
const bins = ['bin/chrome-cdp', 'skills/chrome-cdp-ex/bin/chrome-cdp'];
const temps = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'issue-600-'));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  while (temps.length) rmSync(temps.pop(), { recursive: true, force: true });
});

function launcherSource(relativePath) {
  return readFileSync(resolve(root, relativePath), 'utf8').replace(/\r\n/g, '\n');
}

function baseEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.NODE_COMPILE_CACHE;
  delete env.NODE_DISABLE_COMPILE_CACHE;
  return env;
}

function run(args, env = baseEnv()) {
  const start = performance.now();
  const result = spawnSync(args[0], args.slice(1), { encoding: 'utf8', env });
  result.ms = performance.now() - start;
  return result;
}

// chrome-cdp.cmd starts the extensionless launcher with `node`. Windows refuses
// to spawn that extensionless file directly, so tests use the same node entry.
function launcherArgs(relativePath, args = []) {
  return [process.execPath, resolve(root, relativePath), ...args];
}

function writeRunner(dir) {
  const runner = join(dir, 'runner.mjs');
  writeFileSync(runner, `import { startChromeCdpCli } from ${JSON.stringify(pathToFileURL(runtime).href)};
const scriptPath = process.argv[2];
const userArgs = process.argv.slice(3);
process.argv = [process.execPath, process.argv[1], ...userArgs];
await startChromeCdpCli({
  scriptPath,
  ...(process.env.PROBE_CACHE_DIR ? { cacheDir: process.env.PROBE_CACHE_DIR } : {}),
  ...(process.env.PROBE_NO_CACHE_API === '1' ? { enableCompileCache: null } : {}),
});
`);
  return runner;
}

function runProbe({ args = [], env = {}, cacheDir, noCacheApi = false } = {}) {
  const dir = tempDir();
  const runner = writeRunner(dir);
  const out = join(dir, 'probe.json');
  const childEnv = baseEnv({
    ...env,
    PROBE_OUT: out,
    ...(cacheDir ? { PROBE_CACHE_DIR: cacheDir } : {}),
    ...(noCacheApi ? { PROBE_NO_CACHE_API: '1' } : {}),
  });
  const res = spawnSync(process.execPath, [runner, probe, ...args], {
    encoding: 'utf8',
    env: childEnv,
  });
  const recorded = res.status === 0 || exists(out) ? JSON.parse(readFileSync(out, 'utf8')) : null;
  return { ...res, recorded, out };
}

function exists(file) {
  try {
    readFileSync(file);
    return true;
  } catch {
    return false;
  }
}

describe('#600 launcher startup', () => {
  it('enables the compile cache before importing the runtime, and does not spawn', () => {
    for (const relativePath of bins) {
      const text = launcherSource(relativePath);
      const cacheAt = text.indexOf('enableCompileCache');
      const importAt = text.indexOf('await import(');
      expect(cacheAt, relativePath).toBeGreaterThan(-1);
      expect(importAt, relativePath).toBeGreaterThan(cacheAt);
      expect(text, relativePath).toContain('startChromeCdpCli');
      expect(text, relativePath).toContain("'cdp.mjs'");
      expect(text, relativePath).not.toMatch(/child_process/);
      expect(text, relativePath).toContain('enableCompileCache?.()');
    }
  });

  it('keeps the Windows cmd launchers pointed at the sibling chrome-cdp', () => {
    for (const relativePath of ['bin/chrome-cdp.cmd', 'skills/chrome-cdp-ex/bin/chrome-cdp.cmd']) {
      expect(launcherSource(relativePath)).toBe('@echo off\nnode "%~dp0chrome-cdp" %*\n');
    }
  });

  it('rewrites argv to the cdp script and imports it before any spawn', async () => {
    const order = [];
    const argv = [process.execPath, '/repo/bin/chrome-cdp', 'help', 'click'];
    const scriptPath = '/repo/skills/chrome-cdp-ex/scripts/cdp.mjs';
    const env = {};
    const result = await startChromeCdpCli({
      scriptPath,
      version: 'v22.14.0',
      execPath: process.execPath,
      argv,
      env,
      enableCompileCache: () => {
        order.push('cache');
        return { status: 1, directory: '/cache/top/v22' };
      },
      flushCompileCache: () => { order.push('flush'); },
      importModule: async href => { order.push(['import', href]); },
      spawnProcess: () => { throw new Error('use-current must not spawn'); },
      discover: () => { throw new Error('use-current must not discover a Node binary'); },
      exit: () => { throw new Error('use-current must not exit'); },
      cacheDir: '/cache/top',
    });
    expect(result).toEqual({ action: 'use-current' });
    expect(order.map(entry => Array.isArray(entry) ? entry[0] : entry)).toEqual(['cache', 'import', 'flush']);
    expect(order[1][1]).toBe(pathToFileURL(scriptPath).href);
    expect(argv).toEqual([process.execPath, scriptPath, 'help', 'click']);
    expect(env.NODE_COMPILE_CACHE).toBe('/cache/top');
  });

  it('keeps a caller-supplied NODE_COMPILE_CACHE and stores the top directory when already enabled', () => {
    const userEnv = { NODE_COMPILE_CACHE: '/user/cache' };
    let userArgs = null;
    const user = enableChromeCdpCompileCache({
      env: userEnv,
      cacheDir: '/other',
      enableCompileCache: (...args) => {
        userArgs = args;
        return { status: 2, directory: '/user/cache/v22.14.0' };
      },
    });
    expect(user.enabled).toBe(true);
    expect(user.directory).toBe('/user/cache');
    expect(userArgs).toEqual([]);
    expect(userEnv.NODE_COMPILE_CACHE).toBe('/user/cache');

    const env = {};
    const enabled = enableChromeCdpCompileCache({
      env,
      cacheDir: '/cache/top',
      enableCompileCache: () => ({ status: 2, directory: '/cache/top/v22.14.0' }),
    });
    expect(enabled.enabled).toBe(true);
    expect(env.NODE_COMPILE_CACHE).toBe('/cache/top');
  });

  it('falls back silently when the cache API is missing, throws, or reports failure', async () => {
    for (const enableCompileCache of [null, () => { throw new Error('disk full'); }, () => ({ status: 0, message: 'Cannot create cache directory: permission denied' })]) {
      const stderr = [];
      const env = {};
      let imported = false;
      const result = await startChromeCdpCli({
        scriptPath: cdp,
        version: 'v22.14.0',
        execPath: process.execPath,
        argv: [process.execPath, '/repo/bin/chrome-cdp', 'help'],
        env,
        enableCompileCache,
        flushCompileCache: null,
        importModule: async () => { imported = true; },
        spawnProcess: () => { throw new Error('must not spawn'); },
        exit: () => { throw new Error('must not exit'); },
        stderr: line => stderr.push(String(line)),
      });
      expect(result.action).toBe('use-current');
      expect(imported).toBe(true);
      expect(stderr).toEqual([]);
      expect(env.NODE_COMPILE_CACHE).toBeUndefined();
    }
  });

  it('re-execs Node before 22 without importing cdp.mjs', async () => {
    const calls = [];
    const argv = ['/usr/bin/node20', '/repo/bin/chrome-cdp', 'doctor', '--format', 'json'];
    const result = await startChromeCdpCli({
      scriptPath: cdp,
      version: 'v20.19.2',
      execPath: '/usr/bin/node20',
      argv,
      env: { PATH: '/usr/bin' },
      discover: () => ({ binary: '/opt/node22/bin/node', version: 'v22.14.0' }),
      enableCompileCache: () => { throw new Error('cache must not run on re-exec'); },
      importModule: async () => { throw new Error('cdp.mjs must not load on re-exec'); },
      spawnProcess: (binary, args, options) => {
        calls.push({ binary, args, env: options.env, stdio: options.stdio });
        return { on() {} };
      },
      exit: () => { calls.push('exit'); },
    });
    expect(result).toEqual({ action: 'reexec' });
    expect(calls).toEqual([{
      binary: '/opt/node22/bin/node',
      args: ['/repo/bin/chrome-cdp', 'doctor', '--format', 'json'],
      env: { PATH: '/usr/bin', CHROME_CDP_NODE_REEXEC: '1' },
      stdio: 'inherit',
    }]);
    expect(argv).toEqual(['/usr/bin/node20', '/repo/bin/chrome-cdp', 'doctor', '--format', 'json']);
  });

  it('still fails closed on Node before 22 when no Node 22 binary exists', async () => {
    const stderr = [];
    let code = null;
    const result = await startChromeCdpCli({
      scriptPath: cdp,
      version: 'v20.19.2',
      execPath: '/usr/bin/node20',
      argv: ['/usr/bin/node20', '/repo/bin/chrome-cdp', 'doctor'],
      env: {},
      discover: () => null,
      importModule: async () => { throw new Error('must not import'); },
      spawnProcess: () => { throw new Error('must not spawn'); },
      exit: value => { code = value; },
      stderr: line => stderr.push(String(line)),
    });
    expect(result).toEqual({ action: 'fail' });
    expect(code).toBe(1);
    expect(stderr.join('\n')).toMatch(/Node\.js 22|PATH|Hermes|fnm|nvm/);
  });

  it('records the imported script as argv[1] so daemon scriptPath matches a direct run', () => {
    const probed = runProbe({ args: ['help'] });
    expect(probed.status, probed.stderr).toBe(0);
    expect(probed.stderr).toBe('');
    expect(probed.recorded.direct).toBe(true);
    expect(resolve(probed.recorded.argv[1])).toBe(resolve(probe));
    expect(probed.recorded.argv.slice(2)).toEqual(['help']);
    expect(probed.recorded.argv[1]).not.toContain(`${join('bin', 'chrome-cdp')}`);

    const meta = T.collectDaemonMetadata({ scriptPath: cdp, now: 0, pid: 1 });
    expect(meta.scriptPath).toBe(realpathSync(cdp));
    const assessment = T.assessDaemonFreshness({
      targetPrefix: 'AABBCCDD',
      current: meta,
      daemon: { ...meta, pid: 99 },
    });
    expect(assessment.stale).toBe(false);
    expect(assessment.mismatches).toEqual([]);
  });

  it('passes stdin through and returns the script exit code', () => {
    const dir = tempDir();
    const runner = writeRunner(dir);
    const out = join(dir, 'probe.json');
    const child = spawnSync(process.execPath, [runner, probe], {
      encoding: 'utf8',
      input: 'hello-stdin\n',
      env: baseEnv({ PROBE_OUT: out, PROBE_READ_STDIN: '1', PROBE_CODE: '3' }),
    });
    expect(child.status, child.stderr).toBe(3);
    expect(child.stderr).toBe('');
    expect(JSON.parse(readFileSync(out, 'utf8')).stdin).toBe('hello-stdin\n');
  });

  it('delivers SIGINT to the in-process script the same way a direct node run does', async () => {
    const dir = tempDir();
    const runner = writeRunner(dir);
    const [viaLauncher, direct] = await Promise.all([
      signalExit([process.execPath, runner, probe], baseEnv({ PROBE_OUT: join(dir, 'launcher.json'), PROBE_HOLD: '1' })),
      signalExit([process.execPath, probe], baseEnv({ PROBE_OUT: join(dir, 'direct.json'), PROBE_HOLD: '1' })),
    ]);
    expect(viaLauncher).toEqual(direct);
    // Windows child.kill('SIGINT') terminates the process without running the handler.
    if (process.platform !== 'win32') expect(viaLauncher).toEqual({ code: 0, signal: null });
  }, 20_000);

  it('matches direct node help, errors, wait, and signal exit', async () => {
    const commands = [
      ['help'],
      ['help', 'click'],
      ['not-a-command'],
      ['wait', '1'],
      ['wait', 'nope'],
    ];
    for (const args of commands) {
      const direct = run([process.execPath, cdp, ...args]);
      for (const relativePath of bins) {
        const launched = run(launcherArgs(relativePath, args));
        const detail = `${relativePath} ${args.join(' ')} ${launched.error?.message || ''} ${launched.stderr}`;
        expect(launched.status, detail).toBe(direct.status);
        expect(launched.stdout, `${relativePath} ${args.join(' ')}`).toBe(direct.stdout);
        expect(launched.stderr, `${relativePath} ${args.join(' ')}`).toBe(direct.stderr);
      }
    }

    const env = baseEnv();
    const [binSignal, directSignal] = await Promise.all([
      signalExit(launcherArgs('bin/chrome-cdp', ['wait', '5000']), env),
      signalExit([process.execPath, cdp, 'wait', '5000'], env),
    ]);
    expect(binSignal).toEqual(directSignal);
    expect(binSignal.signal).toBe('SIGINT');
  }, 20_000);

  it('prints help when the compile cache directory cannot be created', () => {
    const dir = tempDir();
    const blocked = join(dir, 'not-a-directory');
    writeFileSync(blocked, 'x');
    const direct = run([process.execPath, cdp, 'help']);
    for (const relativePath of bins) {
      const launched = run(launcherArgs(relativePath, ['help']), baseEnv({ NODE_COMPILE_CACHE: blocked }));
      expect(launched.status, `${launched.error?.message || ''} ${launched.stderr}`).toBe(0);
      expect(launched.stderr).toBe('');
      expect(launched.stdout).toBe(direct.stdout);
    }
  });

  it('keeps a warm bin/chrome-cdp help ahead of a direct node help', () => {
    const env = baseEnv();
    const bareCmd = [process.execPath, '-e', ''];
    const directCmd = [process.execPath, cdp, 'help'];
    const binCmd = launcherArgs('bin/chrome-cdp', ['help']);
    for (let i = 0; i < 2; i += 1) {
      for (const cmd of [bareCmd, directCmd, binCmd]) {
        const sample = run(cmd, env);
        expect(sample.status, sample.stderr).toBe(0);
      }
    }
    const samples = { bare: [], direct: [], bin: [] };
    let directOut = '';
    let binOut = '';
    // The budget is a quiet-host Linux comparison. Windows runners are too
    // noisy for an 8% floor, and Node will not spawn the extensionless file.
    const rounds = process.platform === 'win32' ? 3 : 15;
    for (let i = 0; i < rounds; i += 1) {
      const bare = run(bareCmd, env);
      const direct = run(directCmd, env);
      const bin = run(binCmd, env);
      expect(bare.status).toBe(0);
      expect(direct.status, direct.stderr).toBe(0);
      expect(bin.status, bin.stderr).toBe(0);
      expect(bin.stdout).toBe(direct.stdout);
      expect(bin.stderr).toBe(direct.stderr);
      samples.bare.push(bare.ms);
      samples.direct.push(direct.ms);
      samples.bin.push(bin.ms);
      directOut = direct.stdout;
      binOut = bin.stdout;
    }
    const bare = summarize(samples.bare);
    const direct = summarize(samples.direct);
    const bin = summarize(samples.bin);
    const detail = JSON.stringify({ bare, direct, bin, out: binOut.length });
    // Minimum, not median: load on a shared runner only adds time, and the
    // fastest interleaved run is the one it missed. A warm in-process launch
    // has to beat compiling cdp.mjs on every call. Spawning a second Node
    // process loses that comparison.
    if (process.platform !== 'win32') {
      expect(bin.min, detail).toBeLessThan(direct.min * 0.92);
      expect(bin.min, detail).toBeLessThan(bare.min * 8);
    }
    expect(binOut).toBe(directOut);
    expect(directOut.length).toBeGreaterThan(100);
  }, 30_000);
});

function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = p => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
  return {
    median: round(at(0.5)),
    p25: round(at(0.25)),
    p75: round(at(0.75)),
    min: round(sorted[0]),
    max: round(sorted.at(-1)),
  };
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function signalExit(args, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(args[0], args.slice(1), { env, stdio: 'ignore' });
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      clearInterval(arm);
      fn();
    };
    const send = () => child.kill('SIGINT');
    const killer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(new Error(`timed out waiting for ${args.join(' ')}`)));
    }, 12000);
    const arm = env.PROBE_OUT
      ? setInterval(() => {
        try {
          if (readFileSync(env.PROBE_OUT, 'utf8')) {
            clearInterval(arm);
            send();
          }
        } catch { /* probe has not written the ready file yet */ }
      }, 15)
      : setTimeout(send, 200);
    child.on('exit', (code, signal) => finish(() => resolvePromise({ code, signal })));
    child.on('error', error => finish(() => reject(error)));
  });
}
