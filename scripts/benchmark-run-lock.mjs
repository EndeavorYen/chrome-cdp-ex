import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';
import { createHash } from 'crypto';

const DEFAULT_STALE_MS = 15 * 60 * 1000;

function lockScopeId(scope = process.cwd()) {
  return createHash('sha1').update(resolve(scope)).digest('hex').slice(0, 12);
}

function lockPath({ lockRoot = tmpdir(), scope = process.cwd() } = {}) {
  return resolve(lockRoot, `chrome-cdp-ex-live-benchmark-${lockScopeId(scope)}.lock`);
}

function readLockMetadata(dir) {
  try {
    return JSON.parse(readFileSync(resolve(dir, 'owner.json'), 'utf8'));
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function lockErrorMessage(dir, owner = {}) {
  const ownerText = owner?.name ? `${owner.name} pid=${owner.pid || 'unknown'}` : 'unknown owner';
  return [
    `Another live benchmark is already running (${ownerText}).`,
    `Lock: ${dir}`,
    'Run `npm run benchmark:campaign` for multi-round live testing, or wait for the current benchmark to finish.',
    'If the previous run was interrupted, the lock will be replaced automatically after the stale window.',
  ].join('\n');
}

export function acquireLiveBenchmarkLock({
  name = 'live-benchmark',
  lockRoot = tmpdir(),
  scope = process.cwd(),
  staleMs = DEFAULT_STALE_MS,
  now = Date.now(),
} = {}) {
  const dir = lockPath({ lockRoot, scope });
  const metadata = {
    schema: 'chrome-cdp-ex.live-benchmark-lock.v1',
    name,
    pid: process.pid,
    startedAt: new Date(now).toISOString(),
    startedAtMs: now,
    staleAfterMs: staleMs,
    scope: resolve(scope),
  };

  const tryAcquire = () => {
    mkdirSync(dir, { recursive: false, mode: 0o700 });
    writeFileSync(resolve(dir, 'owner.json'), `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
    return {
      lockDir: dir,
      metadata,
      release() {
        rmSync(dir, { recursive: true, force: true });
      },
    };
  };

  try {
    return tryAcquire();
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }

  const owner = readLockMetadata(dir);
  const startedAtMs = Number(owner?.startedAtMs);
  const ageMs = Number.isFinite(startedAtMs) ? now - startedAtMs : Number.POSITIVE_INFINITY;
  if (ageMs > staleMs && !isProcessAlive(owner?.pid)) {
    rmSync(dir, { recursive: true, force: true });
    return tryAcquire();
  }
  throw new Error(lockErrorMessage(dir, owner));
}

export async function withLiveBenchmarkLock(options, fn) {
  const lock = acquireLiveBenchmarkLock(options);
  try {
    return await fn(lock);
  } finally {
    lock.release();
  }
}
