import {
  constants as FS_CONSTANTS,
  lstatSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
} from 'node:fs';
import {
  lstat,
  mkdir,
  open as openFile,
  realpath,
} from 'node:fs/promises';
import { createHash, randomBytes as secureRandomBytes } from 'node:crypto';
import { isAbsolute, join, relative, sep } from 'node:path';
import { isProxy } from 'node:util/types';

import { inspectCommandExecutionContext } from './command-application.mjs';
import { inspectTableExportBundle, TABLE_EXTRACTION_LIMITS } from './table-extraction.mjs';
import { parseTableContinuationToken } from './table-contract.mjs';

const ARTIFACT_OWNER_DIR = 'table-artifacts-v1';
const ARTIFACT_ID_ATTEMPTS = 16;
const STORE_STATES = new WeakMap();
const IDENTITY_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;

export class TableArtifactStorageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TableArtifactStorageError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new TableArtifactStorageError(code, `table: ${message}`);
}

function validateFactoryInput(input) {
  if (isProxy(input)) fail('TABLE_ARTIFACT_STORAGE_INVALID', 'artifact store options are invalid');
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.getPrototypeOf(input) !== Object.prototype) {
    fail('TABLE_ARTIFACT_STORAGE_INVALID', 'artifact store options are invalid');
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const allowed = new Set(['runtimeDir', 'targetId', 'sessionId', 'platform']);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key === 'symbol' || !allowed.has(key) || !descriptors[key].enumerable
      || !Object.hasOwn(descriptors[key], 'value')) {
      fail('TABLE_ARTIFACT_STORAGE_INVALID', 'artifact store options are invalid');
    }
  }
  for (const key of allowed) {
    if (!descriptors[key]) fail('TABLE_ARTIFACT_STORAGE_INVALID', 'artifact store options are invalid');
  }
  const values = Object.fromEntries([...allowed].map(key => [key, descriptors[key].value]));
  if (typeof values.runtimeDir !== 'string' || values.runtimeDir.length === 0) {
    fail('TABLE_ARTIFACT_STORAGE_INVALID', 'artifact runtime root is invalid');
  }
  for (const key of ['targetId', 'sessionId']) {
    if (typeof values[key] !== 'string' || !IDENTITY_RE.test(values[key])
      || values[key].includes('..') || /%2e|%2f|%5c/i.test(values[key])) {
      fail('TABLE_ARTIFACT_STORAGE_INVALID', 'artifact identity is invalid');
    }
  }
  if (typeof values.platform !== 'string' || values.platform.length === 0) {
    fail('TABLE_ARTIFACT_STORAGE_INVALID', 'artifact platform is invalid');
  }
  return values;
}

function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function modeBits(stats) {
  return stats.mode & 0o7777;
}

function currentUid() {
  if (typeof process.getuid !== 'function') {
    fail('TABLE_ARTIFACT_STORAGE_INVALID', 'artifact ownership verification is unavailable');
  }
  return process.getuid();
}

function isContained(parent, candidate) {
  const rel = relative(parent, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function assertDirectoryStats(stats) {
  if (!stats.isDirectory() || stats.isSymbolicLink() || stats.uid !== currentUid()
    || modeBits(stats) !== 0o700) {
    fail('TABLE_ARTIFACT_STORAGE_INVALID', 'private artifact directory validation failed');
  }
}

function assertFileStats(stats, expectedBytes) {
  if (!stats.isFile() || stats.isSymbolicLink() || stats.uid !== currentUid()
    || modeBits(stats) !== 0o600 || stats.nlink !== 1 || stats.size !== expectedBytes) {
    fail('TABLE_ARTIFACT_PUBLICATION_FAILED', 'private artifact file validation failed');
  }
}

function freezeDeep(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function wrapError(error, fallbackCode = 'TABLE_ARTIFACT_PUBLICATION_FAILED') {
  if (error instanceof TableArtifactStorageError) return error;
  return new TableArtifactStorageError(fallbackCode, 'table: private artifact operation failed');
}

function storeState(store) {
  if (isProxy(store)) fail('TABLE_ARTIFACT_STORAGE_INVALID', 'artifact store is invalid');
  const state = STORE_STATES.get(store);
  if (!state) fail('TABLE_ARTIFACT_STORAGE_INVALID', 'artifact store is invalid');
  return state;
}

function requestState(state, execution) {
  const context = inspectCommandExecutionContext(execution);
  let request = state.requests.get(context);
  if (!request) {
    request = { context, rolledBack: false, entries: new Set() };
    state.requests.set(context, request);
  }
  return request;
}

function throwIfPublicationStopped(request) {
  if (request.rolledBack || request.context.signal.aborted) {
    fail('TABLE_ARTIFACT_REQUEST_ABORTED', 'artifact request was aborted');
  }
  const deadline = request.context.deadline;
  if (deadline && deadline.now() >= deadline.serverAt) {
    fail('TABLE_ARTIFACT_REQUEST_ABORTED', 'artifact request exceeded its server deadline');
  }
}

async function checkedStep(request, operation) {
  throwIfPublicationStopped(request);
  const result = await operation();
  throwIfPublicationStopped(request);
  return result;
}

async function ensurePrivateDirectory(path, parentReal, state) {
  try {
    await state.fs.mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const stats = await state.fs.lstat(path);
  assertDirectoryStats(stats);
  const actual = await state.fs.realpath(path);
  if (!isContained(parentReal, actual) || actual === parentReal) {
    fail('TABLE_ARTIFACT_STORAGE_INVALID', 'private artifact containment validation failed');
  }
  return actual;
}

async function initializeStore(state, request) {
  if (state.initialized) return;
  throwIfPublicationStopped(request);
  const rootStats = await state.fs.lstat(state.runtimeDir);
  assertDirectoryStats(rootStats);
  const rootReal = await state.fs.realpath(state.runtimeDir);
  const ownerReal = await ensurePrivateDirectory(state.ownerDir, rootReal, state);
  const targetReal = await ensurePrivateDirectory(state.targetDir, ownerReal, state);
  const sessionReal = await ensurePrivateDirectory(state.sessionDir, targetReal, state);
  throwIfPublicationStopped(request);
  state.rootReal = rootReal;
  state.ownerReal = ownerReal;
  state.targetReal = targetReal;
  state.sessionReal = sessionReal;
  state.initialized = true;
}

function validateBundle(bundle) {
  let trusted;
  try {
    trusted = inspectTableExportBundle(bundle);
  } catch {
    fail('TABLE_ARTIFACT_PUBLICATION_FAILED', 'trusted export bundle is required');
  }
  const { manifest, rowsTsv } = trusted;
  if (typeof rowsTsv !== 'string' || manifest?.schema !== 'chrome-cdp-ex.table-export.v1') {
    fail('TABLE_ARTIFACT_PUBLICATION_FAILED', 'trusted export bundle is invalid');
  }
  const bytes = Buffer.byteLength(rowsTsv, 'utf8');
  const checksum = createHash('sha256').update(Buffer.from(rowsTsv, 'utf8')).digest('hex');
  if (manifest.artifact?.checksumScope !== 'canonical-data-rows-tsv-utf8'
    || manifest.artifact.bytes !== bytes
    || manifest.artifact.rows < 0
    || manifest.artifact.rows > TABLE_EXTRACTION_LIMITS.maxRows
    || bytes > TABLE_EXTRACTION_LIMITS.maxArtifactBytes
    || manifest.artifact.checksum !== checksum) {
    fail('TABLE_ARTIFACT_PUBLICATION_FAILED', 'trusted export bundle verification failed');
  }
  const rows = manifest.artifact.rows === 0 ? [] : rowsTsv.split('\n');
  if (rows.length !== manifest.artifact.rows || rows.join('\n') !== rowsTsv
    || rows.some(row => Buffer.byteLength(row, 'utf8') > TABLE_EXTRACTION_LIMITS.maxCanonicalRowBytes)) {
    fail('TABLE_ARTIFACT_PUBLICATION_FAILED', 'trusted export row verification failed');
  }
  return { manifest, rowsTsv, bytes, rows };
}

function entryPaths(entry) {
  return {
    rows: join(entry.path, 'rows.tsv'),
    manifest: join(entry.path, 'manifest.json'),
  };
}

function safeOwnedFile(path) {
  try {
    const stats = lstatSync(path);
    return stats.isFile() && !stats.isSymbolicLink() && stats.uid === currentUid()
      && modeBits(stats) === 0o600 && stats.nlink === 1;
  } catch {
    return false;
  }
}

function cleanupEntry(entry) {
  if (!entry.directoryCreated) return;
  const paths = entryPaths(entry);
  for (const path of [paths.manifest, paths.rows]) {
    if (safeOwnedFile(path)) {
      try { unlinkSync(path); } catch {}
    }
  }
  try {
    if (readdirSync(entry.path).length === 0) rmdirSync(entry.path);
  } catch {}
}

async function mintEntry(state, request) {
  for (let attempt = 0; attempt < ARTIFACT_ID_ATTEMPTS; attempt += 1) {
    throwIfPublicationStopped(request);
    const id = state.randomBytes(16).toString('hex');
    if (!/^[0-9a-f]{32}$/.test(id)) {
      fail('TABLE_ARTIFACT_PUBLICATION_FAILED', 'secure artifact ID generation failed');
    }
    if (state.entries.has(id)) continue;
    const entry = {
      id,
      path: join(state.sessionDir, id),
      request,
      directoryCreated: false,
      committed: false,
    };
    state.entries.set(id, entry);
    request.entries.add(entry);
    try {
      await state.fs.mkdir(entry.path, { mode: 0o700 });
      entry.directoryCreated = true;
      const stats = await state.fs.lstat(entry.path);
      assertDirectoryStats(stats);
      const actual = await state.fs.realpath(entry.path);
      if (!isContained(state.sessionReal, actual) || actual === state.sessionReal) {
        fail('TABLE_ARTIFACT_PUBLICATION_FAILED', 'artifact containment validation failed');
      }
      throwIfPublicationStopped(request);
      return entry;
    } catch (error) {
      if (error?.code === 'EEXIST' && !entry.directoryCreated) {
        request.entries.delete(entry);
        state.entries.delete(id);
        continue;
      }
      throw error;
    }
  }
  fail('TABLE_ARTIFACT_PUBLICATION_FAILED', 'artifact ID collision limit reached');
}

async function closeHandle(handle) {
  try { await handle?.close?.(); } catch {}
}

async function writePrivateFile(state, request, path, bytes) {
  const flags = FS_CONSTANTS.O_WRONLY | FS_CONSTANTS.O_CREAT | FS_CONSTANTS.O_EXCL | FS_CONSTANTS.O_NOFOLLOW;
  let handle;
  try {
    handle = await checkedStep(request, () => state.fs.open(path, flags, 0o600));
    await checkedStep(request, () => handle.writeFile(bytes));
    const stats = await checkedStep(request, () => handle.stat());
    assertFileStats(stats, bytes.length);
    await checkedStep(request, () => handle.sync());
  } finally {
    await closeHandle(handle);
  }
}

async function fsyncDirectory(state, request, path) {
  const flags = FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_DIRECTORY | FS_CONSTANTS.O_NOFOLLOW;
  let handle;
  try {
    handle = await checkedStep(request, () => state.fs.open(path, flags));
    const stats = await checkedStep(request, () => handle.stat());
    assertDirectoryStats(stats);
    await checkedStep(request, () => handle.sync());
  } finally {
    await closeHandle(handle);
  }
}

async function publish(state, bundle, execution) {
  if (state.platform === 'win32') {
    fail('TABLE_ARTIFACT_UNSUPPORTED_PLATFORM', 'private table artifacts are unavailable on Windows in v2.16');
  }
  const request = requestState(state, execution);
  let entry = null;
  try {
    const verified = validateBundle(bundle);
    await initializeStore(state, request);
    entry = await mintEntry(state, request);
    const paths = entryPaths(entry);
    await writePrivateFile(state, request, paths.rows, Buffer.from(verified.rowsTsv, 'utf8'));
    const committedManifest = freezeDeep({
      ...verified.manifest,
      ownership: {
        artifactId: entry.id,
        targetDigest: state.targetDigest,
        sessionDigest: state.sessionDigest,
      },
    });
    const manifestBytes = Buffer.from(`${JSON.stringify(committedManifest, null, 2)}\n`, 'utf8');
    await writePrivateFile(state, request, paths.manifest, manifestBytes);
    await fsyncDirectory(state, request, entry.path);
    await fsyncDirectory(state, request, state.sessionDir);
    throwIfPublicationStopped(request);
    entry.committed = true;
    entry.manifest = committedManifest;
    return freezeDeep({
      artifactId: entry.id,
      token: verified.manifest.artifact.rows === 0 ? null : `ct1.${entry.id}.0`,
      artifact: { ...verified.manifest.artifact },
    });
  } catch (error) {
    if (entry) {
      cleanupEntry(entry);
      entry.request.entries.delete(entry);
      state.entries.delete(entry.id);
    }
    if (error instanceof TableArtifactStorageError) throw error;
    if (!state.initialized && !entry) {
      throw wrapError(error, 'TABLE_ARTIFACT_STORAGE_INVALID');
    }
    throw wrapError(error);
  }
}

function rollbackRequest(state, execution) {
  const context = inspectCommandExecutionContext(execution);
  const request = state.requests.get(context);
  if (!request) return;
  request.rolledBack = true;
  for (const entry of request.entries) cleanupEntry(entry);
}

function releaseRequest(state, execution) {
  const context = inspectCommandExecutionContext(execution);
  const request = state.requests.get(context);
  if (!request) return;
  for (const entry of request.entries) entry.request = null;
  request.entries.clear();
  state.requests.delete(context);
}

function cleanupSession(state) {
  for (const request of state.requests.values()) request.rolledBack = true;
  for (const entry of state.entries.values()) cleanupEntry(entry);
}

function makeStore(input, dependencies) {
  const options = validateFactoryInput(input);
  const targetDigest = digest(options.targetId);
  const sessionDigest = digest(options.sessionId);
  const ownerDir = join(options.runtimeDir, ARTIFACT_OWNER_DIR);
  const targetDir = join(ownerDir, targetDigest);
  const sessionDir = join(targetDir, sessionDigest);
  const state = {
    ...options,
    ownerDir,
    targetDir,
    sessionDir,
    targetDigest,
    sessionDigest,
    initialized: false,
    entries: new Map(),
    requests: new Map(),
    randomBytes: dependencies.randomBytes,
    fs: dependencies.fs,
  };
  const store = Object.freeze({
    publish: (bundle, execution) => publish(state, bundle, execution),
    readContinuation(token) {
      parseTableContinuationToken(token);
      fail('TABLE_ARTIFACT_CONTINUATION_UNAVAILABLE', 'table continuation is not installed yet');
    },
    rollbackRequest: execution => rollbackRequest(state, execution),
    releaseRequest: execution => releaseRequest(state, execution),
    cleanupSession: () => cleanupSession(state),
    sweepCrashResidue() {},
  });
  STORE_STATES.set(store, state);
  return store;
}

const DEFAULT_DEPENDENCIES = Object.freeze({
  randomBytes: secureRandomBytes,
  fs: Object.freeze({ lstat, mkdir, open: openFile, realpath }),
});

export function createTableArtifactStore(input) {
  return makeStore(input, DEFAULT_DEPENDENCIES);
}

function createTableArtifactStoreWithDependencies(input, dependencies = {}) {
  return makeStore(input, {
    randomBytes: dependencies.randomBytes || DEFAULT_DEPENDENCIES.randomBytes,
    fs: {
      ...DEFAULT_DEPENDENCIES.fs,
      ...(dependencies.fs || {}),
      ...(dependencies.open ? { open: dependencies.open } : {}),
    },
  });
}

function inspectTableArtifactStore(store) {
  const state = storeState(store);
  return Object.freeze({
    ownerDir: state.ownerDir,
    targetDir: state.targetDir,
    sessionDir: state.sessionDir,
    targetDigest: state.targetDigest,
    sessionDigest: state.sessionDigest,
    registeredArtifactIds: Object.freeze([...state.entries.keys()]),
  });
}

export const __test__ = process.env.NODE_ENV === 'test' ? Object.freeze({
  createTableArtifactStoreWithDependencies,
  inspectTableArtifactStore,
}) : undefined;
