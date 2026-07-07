import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';
import { createHash } from 'crypto';

const DEFAULT_STALE_MS = 15 * 60 * 1000;
const RUN_SCHEMA = 'chrome-cdp-ex.live-benchmark-run.v1';

function lockScopeId(scope = process.cwd()) {
  return createHash('sha1').update(resolve(scope)).digest('hex').slice(0, 12);
}

function lockPath({ lockRoot = tmpdir(), scope = process.cwd() } = {}) {
  return resolve(lockRoot, `chrome-cdp-ex-live-benchmark-${lockScopeId(scope)}.lock`);
}

function ownerPath(dir) {
  return resolve(dir, 'owner.json');
}

function readLockMetadata(dir) {
  try {
    return JSON.parse(readFileSync(ownerPath(dir), 'utf8'));
  } catch {
    return null;
  }
}

function writeLockMetadata(dir, metadata) {
  writeFileSync(ownerPath(dir), `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
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

function slugifyName(name) {
  return String(name || 'live-benchmark')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'live-benchmark';
}

function normalizePositiveInteger(value, fallback) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return fallback;
  return n;
}

function normalizeNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function lastSeenMs(owner) {
  const heartbeatAtMs = Number(owner?.heartbeatAtMs);
  if (Number.isFinite(heartbeatAtMs)) return heartbeatAtMs;
  const startedAtMs = Number(owner?.startedAtMs);
  return Number.isFinite(startedAtMs) ? startedAtMs : Number.NaN;
}

function shouldReclaimOwner(owner, { now, staleMs }) {
  const pid = Number(owner?.pid);
  const hasPid = Number.isInteger(pid) && pid > 0;
  const live = isProcessAlive(pid);
  if (live) return false;
  const seenAtMs = lastSeenMs(owner);
  const stale = Number.isFinite(seenAtMs) ? now - seenAtMs > staleMs : true;
  return hasPid || stale;
}

function slotLockDir(managerDir, slot, maxSlots) {
  return maxSlots === 1 ? managerDir : resolve(managerDir, `slot-${slot}`);
}

function buildRunMetadata({
  name = 'live-benchmark',
  scope = process.cwd(),
  staleMs = DEFAULT_STALE_MS,
  now = Date.now(),
  slot = 0,
  maxSlots = 1,
  managerDir,
  runDir,
  port,
  portStart = 9334,
  serverPort,
  serverPortStart = 41738,
  browser = 'auto',
  profileDir,
  profileRoot = tmpdir(),
  profilePrefix = 'chrome-cdp-ex-live-benchmark',
} = {}) {
  const slug = slugifyName(name);
  const runId = `${slug}-${slot}-${now}-${process.pid}`;
  const defaultPort = normalizeNumber(portStart, 9334) + slot;
  const defaultServerPort = normalizeNumber(serverPortStart, 41738) + slot;
  const explicitPort = Number(port);
  const explicitServerPort = Number(serverPort);
  const allocatedPort = Number.isFinite(explicitPort)
    ? explicitPort + (maxSlots > 1 ? slot : 0)
    : defaultPort;
  const allocatedServerPort = Number.isFinite(explicitServerPort)
    ? explicitServerPort + (maxSlots > 1 ? slot : 0)
    : defaultServerPort;
  const allocatedProfileDir = profileDir || resolve(profileRoot, `${profilePrefix}-${runId}`);
  return {
    schema: RUN_SCHEMA,
    name,
    runId,
    slot,
    maxSlots,
    pid: process.pid,
    startedAt: new Date(now).toISOString(),
    startedAtMs: now,
    heartbeatAt: new Date(now).toISOString(),
    heartbeatAtMs: now,
    staleAfterMs: staleMs,
    scope: resolve(scope),
    port: allocatedPort,
    serverPort: allocatedServerPort,
    browser,
    profileDir: allocatedProfileDir,
    managerDir,
    lockDir: runDir,
    ownerPath: ownerPath(runDir),
  };
}

function runHandle({ managerDir, runDir, metadata }) {
  return {
    lockDir: runDir,
    managerDir,
    ownerPath: ownerPath(runDir),
    metadata,
    heartbeat(now = Date.now()) {
      metadata.heartbeatAt = new Date(now).toISOString();
      metadata.heartbeatAtMs = now;
      writeLockMetadata(runDir, metadata);
      return metadata;
    },
    release() {
      rmSync(runDir, { recursive: true, force: true });
    },
  };
}

function maybeClearLegacyManager(managerDir, { now, staleMs }) {
  const legacyOwner = readLockMetadata(managerDir);
  if (!legacyOwner) return null;
  if (shouldReclaimOwner(legacyOwner, { now, staleMs })) {
    rmSync(managerDir, { recursive: true, force: true });
    return null;
  }
  return legacyOwner;
}

export function acquireLiveBenchmarkRun({
  name = 'live-benchmark',
  lockRoot = tmpdir(),
  scope = process.cwd(),
  staleMs = DEFAULT_STALE_MS,
  now = Date.now(),
  maxSlots = 1,
  port,
  portStart = 9334,
  serverPort,
  serverPortStart = 41738,
  browser = 'auto',
  profileDir,
  profileRoot = tmpdir(),
  profilePrefix = 'chrome-cdp-ex-live-benchmark',
} = {}) {
  const normalizedMaxSlots = normalizePositiveInteger(maxSlots, 1);
  const managerDir = lockPath({ lockRoot, scope });
  const legacyOwner = normalizedMaxSlots > 1
    ? maybeClearLegacyManager(managerDir, { now, staleMs })
    : null;
  if (legacyOwner) throw new Error(lockErrorMessage(managerDir, legacyOwner));
  if (normalizedMaxSlots > 1) mkdirSync(managerDir, { recursive: true, mode: 0o700 });

  let blockingOwner = null;

  for (let slot = 0; slot < normalizedMaxSlots; slot += 1) {
    const runDir = slotLockDir(managerDir, slot, normalizedMaxSlots);
    const metadata = buildRunMetadata({
      name,
      scope,
      staleMs,
      now,
      slot,
      maxSlots: normalizedMaxSlots,
      managerDir,
      runDir,
      port,
      portStart,
      serverPort,
      serverPortStart,
      browser,
      profileDir,
      profileRoot,
      profilePrefix,
    });

    const tryAcquire = () => {
      mkdirSync(runDir, { recursive: false, mode: 0o700 });
      writeLockMetadata(runDir, metadata);
      return runHandle({ managerDir, runDir, metadata });
    };

    try {
      return tryAcquire();
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }

    const owner = readLockMetadata(runDir);
    if (!blockingOwner && owner) blockingOwner = owner;
    if (shouldReclaimOwner(owner, { now, staleMs })) {
      rmSync(runDir, { recursive: true, force: true });
      try {
        return tryAcquire();
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }
    }
  }

  throw new Error(lockErrorMessage(managerDir, blockingOwner));
}

export function acquireLiveBenchmarkLock(options = {}) {
  return acquireLiveBenchmarkRun(options);
}

export async function withLiveBenchmarkLock(options, fn) {
  const lock = acquireLiveBenchmarkLock(options);
  try {
    return await fn(lock);
  } finally {
    lock.release();
  }
}
