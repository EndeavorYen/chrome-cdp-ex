import {
  constants as FS_CONSTANTS,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readFileSync,
  readdirSync,
  realpathSync,
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
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_OWNER_RECORD_BYTES = 4096;
const UNCOMMITTED_SWEEP_TTL_MS = 15 * 60 * 1000;
const COMMITTED_SWEEP_TTL_MS = 24 * 60 * 60 * 1000;
const SWEEP_LIMITS = Object.freeze({ targets: 64, sessions: 32, artifacts: 256, files: 3 });
const OWNER_RECORD_NAME = 'owner.json';
const OWNER_RECORD_SCHEMA = 'chrome-cdp-ex.table-artifact-owner.v1';
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

function assertReadableFileStats(stats, { expectedBytes = null, maxBytes }) {
  if (!stats.isFile() || stats.isSymbolicLink() || stats.uid !== currentUid()
    || modeBits(stats) !== 0o600 || stats.nlink !== 1
    || stats.size > maxBytes || (expectedBytes !== null && stats.size !== expectedBytes)) {
    fail('TABLE_ARTIFACT_READ_FAILED', 'private artifact verification failed');
  }
}

function stableFileIdentity(before, after) {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.mode === after.mode
    && before.uid === after.uid
    && before.nlink === after.nlink
    && before.size === after.size
    && before.mtimeMs === after.mtimeMs
    && before.ctimeMs === after.ctimeMs;
}

function storedDirectoryIdentity(stats) {
  return Object.freeze({
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode,
    uid: stats.uid,
    nlink: stats.nlink,
  });
}

function storedFileIdentity(stats) {
  return Object.freeze({
    ...storedDirectoryIdentity(stats),
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
  });
}

function matchesStoredIdentity(stats, expected, { file = false } = {}) {
  if (!expected) return true;
  return stats.dev === expected.dev
    && stats.ino === expected.ino
    && (!file || (stats.mode === expected.mode
      && stats.uid === expected.uid
      && stats.nlink === expected.nlink
      && stats.size === expected.size
      && stats.mtimeMs === expected.mtimeMs
      && stats.ctimeMs === expected.ctimeMs));
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

async function ensurePrivateDirectory(
  path,
  parentPath,
  parentReal,
  state,
  request,
  onCreated = () => {},
) {
  let created = false;
  try {
    await checkedStep(request, () => state.fs.mkdir(path, { mode: 0o700 }));
    created = true;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const stats = await checkedStep(request, () => state.fs.lstat(path));
  assertDirectoryStats(stats);
  const actual = await checkedStep(request, () => state.fs.realpath(path));
  if (!isContained(parentReal, actual) || actual === parentReal) {
    fail('TABLE_ARTIFACT_STORAGE_INVALID', 'private artifact containment validation failed');
  }
  if (created) {
    onCreated(storedDirectoryIdentity(stats));
    await fsyncDirectory(state, request, parentPath);
  }
  return actual;
}

function resetInitializationState(state) {
  state.rootReal = null;
  state.ownerReal = null;
  state.targetReal = null;
  state.sessionReal = null;
  state.createdAtMs = null;
  state.initialization = null;
  state.initialized = false;
}

function cleanupPartialInitialization(state) {
  const partial = state.initialization;
  if (!partial) return true;
  if (!partial.sessionIdentity) {
    resetInitializationState(state);
    return true;
  }
  const paths = [state.runtimeDir, state.ownerDir, state.targetDir, state.sessionDir];
  let parentReal = null;
  try {
    for (const path of paths) {
      const stats = lstatSync(path);
      assertDirectoryStats(stats);
      if (path === state.sessionDir
        && !matchesStoredIdentity(stats, partial.sessionIdentity)) return false;
      const actual = realpathSync(path);
      if (parentReal && (!isContained(parentReal, actual) || actual === parentReal)) return false;
      parentReal = actual;
    }
    const listing = readdirSync(state.sessionDir);
    if (listing.some(name => name !== OWNER_RECORD_NAME)) return false;
    if (listing.includes(OWNER_RECORD_NAME)) {
      if (!partial.ownerIdentity
        || !safeOwnedFile(state.ownerRecordPath, partial.ownerIdentity)) return false;
      unlinkSync(state.ownerRecordPath);
    } else if (partial.ownerIdentity) {
      return false;
    }
    if (partial.sessionCreated) {
      if (readdirSync(state.sessionDir).length !== 0) return false;
      rmdirSync(state.sessionDir);
    }
    resetInitializationState(state);
    return true;
  } catch {
    return false;
  }
}

async function initializeStore(state, request) {
  if (state.initialized) return;
  if (state.initialization && !cleanupPartialInitialization(state)) throw cleanupFailed();
  state.initialization = {
    ownerIdentity: null,
    sessionCreated: false,
    sessionIdentity: null,
  };
  let initializationStarted = false;
  try {
    throwIfPublicationStopped(request);
    const rootStats = await checkedStep(request, () => state.fs.lstat(state.runtimeDir));
    assertDirectoryStats(rootStats);
    const rootReal = await checkedStep(request, () => state.fs.realpath(state.runtimeDir));
    const ownerReal = await ensurePrivateDirectory(
      state.ownerDir, state.runtimeDir, rootReal, state, request,
    );
    const targetReal = await ensurePrivateDirectory(
      state.targetDir, state.ownerDir, ownerReal, state, request,
    );
    initializationStarted = true;
    const sessionReal = await ensurePrivateDirectory(
      state.sessionDir,
      state.targetDir,
      targetReal,
      state,
      request,
      identity => {
        state.initialization.sessionCreated = true;
        state.initialization.sessionIdentity = identity;
      },
    );
    throwIfPublicationStopped(request);
    state.rootReal = rootReal;
    state.ownerReal = ownerReal;
    state.targetReal = targetReal;
    state.sessionReal = sessionReal;
    if (!state.initialization.sessionIdentity) {
      state.initialization.sessionIdentity = storedDirectoryIdentity(
        await checkedStep(request, () => state.fs.lstat(state.sessionDir)),
      );
    }
    state.createdAtMs = state.now();
    if (!nonNegativeSafeInteger(state.createdAtMs)) {
      fail('TABLE_ARTIFACT_STORAGE_INVALID', 'artifact store clock is invalid');
    }
    const ownerBytes = Buffer.from(`${JSON.stringify(ownerRecordForState(state), null, 2)}\n`, 'utf8');
    await writePrivateFile(
      state,
      request,
      state.ownerRecordPath,
      ownerBytes,
      identity => { state.initialization.ownerIdentity = identity; },
    );
    await fsyncDirectory(state, request, state.sessionDir);
  } catch (error) {
    if (!cleanupPartialInitialization(state)) throw cleanupFailed();
    if (initializationStarted) throw wrapError(error);
    if (error instanceof TableArtifactStorageError) throw error;
    throw wrapError(error, 'TABLE_ARTIFACT_STORAGE_INVALID');
  }
  state.initialized = true;
  state.initialization = null;
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

function safeOwnedFile(path, expectedIdentity = null) {
  try {
    const stats = lstatSync(path);
    return stats.isFile() && !stats.isSymbolicLink() && stats.uid === currentUid()
      && modeBits(stats) === 0o600 && stats.nlink === 1
      && matchesStoredIdentity(stats, expectedIdentity, { file: true });
  } catch {
    return false;
  }
}

function safeOwnedDirectory(path) {
  try {
    const stats = lstatSync(path);
    return stats.isDirectory() && !stats.isSymbolicLink() && stats.uid === currentUid()
      && modeBits(stats) === 0o700;
  } catch {
    return false;
  }
}

function verifyCleanupDirectory(
  state,
  entry = null,
  sessionDir = state.sessionDir,
  targetDir = state.targetDir,
) {
  if (!state.initialized) return false;
  if (entry && (entry.path !== join(sessionDir, entry.id)
    || !/^[0-9a-f]{32}$/.test(entry.id))) return false;
  const paths = [state.runtimeDir, state.ownerDir, targetDir, sessionDir];
  if (entry) paths.push(entry.path);
  let parentReal = null;
  try {
    for (const path of paths) {
      if (!safeOwnedDirectory(path)) return false;
      if (entry && path === entry.path) {
        const stats = lstatSync(path);
        if (!matchesStoredIdentity(stats, entry.directoryIdentity)) return false;
      }
      const actual = realpathSync(path);
      if (parentReal && (!isContained(parentReal, actual) || actual === parentReal)) return false;
      parentReal = actual;
    }
    return true;
  } catch {
    return false;
  }
}

function cleanupFailed() {
  return new TableArtifactStorageError(
    'TABLE_ARTIFACT_CLEANUP_FAILED',
    'table: private artifact cleanup failed',
  );
}

function readDirectoryBounded(path, limit) {
  let directory;
  let closeError = null;
  const entries = [];
  let truncated = false;
  try {
    directory = opendirSync(path);
    for (let index = 0; index <= limit; index += 1) {
      const entry = directory.readSync();
      if (!entry) break;
      if (index === limit) {
        truncated = true;
        break;
      }
      entries.push(entry.name);
    }
  } finally {
    try { directory?.closeSync(); } catch (error) { closeError = error; }
  }
  if (closeError) throw closeError;
  return { entries, truncated };
}

function readPrivateFileSync(path, maxBytes) {
  let fd;
  let result;
  let primaryError = null;
  let closeError = null;
  try {
    fd = openSync(path, FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_NOFOLLOW);
    const before = fstatSync(fd);
    assertReadableFileStats(before, { maxBytes });
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    assertReadableFileStats(after, { maxBytes });
    if (!Buffer.isBuffer(bytes) || bytes.length !== before.size || !stableFileIdentity(before, after)) {
      throw cleanupFailed();
    }
    result = bytes;
  } catch (error) {
    primaryError = error;
  } finally {
    try { if (fd !== undefined) closeSync(fd); } catch (error) { closeError = error; }
  }
  if (primaryError || closeError) throw cleanupFailed();
  return result;
}

function ownerRecordForState(state) {
  return {
    schema: OWNER_RECORD_SCHEMA,
    pid: state.pid,
    createdAtMs: state.createdAtMs,
    targetDigest: state.targetDigest,
    sessionDigest: state.sessionDigest,
  };
}

function validateOwnerRecord(value, { targetDigest, sessionDigest }) {
  if (!exactObject(value, ['schema', 'pid', 'createdAtMs', 'targetDigest', 'sessionDigest'])
    || value.schema !== OWNER_RECORD_SCHEMA
    || !Number.isSafeInteger(value.pid) || value.pid <= 0
    || !nonNegativeSafeInteger(value.createdAtMs)
    || value.targetDigest !== targetDigest
    || value.sessionDigest !== sessionDigest) throw cleanupFailed();
  return value;
}

function readOwnerRecord(path, authority) {
  try {
    return validateOwnerRecord(
      JSON.parse(fatalUtf8(readPrivateFileSync(path, MAX_OWNER_RECORD_BYTES))),
      authority,
    );
  } catch {
    throw cleanupFailed();
  }
}

function cleanupEntry(
  state,
  entry,
  sessionDir = state.sessionDir,
  targetDir = state.targetDir,
) {
  if (!entry.directoryCreated) return true;
  try {
    lstatSync(entry.path);
  } catch (error) {
    return error?.code === 'ENOENT';
  }
  if (!verifyCleanupDirectory(state, entry, sessionDir, targetDir)) return false;
  const paths = entryPaths(entry);
  let listing;
  try { listing = readdirSync(entry.path); } catch { return false; }
  if (listing.some(name => !['rows.tsv', 'manifest.json'].includes(name))) return false;
  for (const [name, path] of [['manifest', paths.manifest], ['rows', paths.rows]]) {
    const present = listing.includes(name === 'manifest' ? 'manifest.json' : 'rows.tsv');
    if (present && !safeOwnedFile(path, entry.fileIdentities?.[name])) return false;
    if (!present && entry.fileIdentities?.[name]) return false;
  }
  for (const path of [paths.manifest, paths.rows]) {
    try { unlinkSync(path); } catch (error) {
      if (error?.code !== 'ENOENT') return false;
    }
  }
  try {
    if (readdirSync(entry.path).length === 0) rmdirSync(entry.path);
  } catch {}
  try {
    lstatSync(entry.path);
    return false;
  } catch (error) {
    return error?.code === 'ENOENT';
  }
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
      directoryIdentity: null,
      fileIdentities: Object.create(null),
      committed: false,
    };
    try {
      await state.fs.mkdir(entry.path, { mode: 0o700 });
      entry.directoryCreated = true;
      state.entries.set(id, entry);
      request.entries.add(entry);
      throwIfPublicationStopped(request);
      const stats = await state.fs.lstat(entry.path);
      throwIfPublicationStopped(request);
      assertDirectoryStats(stats);
      entry.directoryIdentity = storedDirectoryIdentity(stats);
      const actual = await state.fs.realpath(entry.path);
      throwIfPublicationStopped(request);
      if (!isContained(state.sessionReal, actual) || actual === state.sessionReal) {
        fail('TABLE_ARTIFACT_PUBLICATION_FAILED', 'artifact containment validation failed');
      }
      return entry;
    } catch (error) {
      if (error?.code === 'EEXIST' && !entry.directoryCreated) {
        continue;
      }
      const cleaned = !entry.directoryCreated || cleanupEntry(state, entry);
      if (cleaned) {
        request.entries.delete(entry);
        state.entries.delete(id);
      }
      if (!cleaned) throw cleanupFailed();
      if (request.rolledBack && error?.code !== 'TABLE_ARTIFACT_REQUEST_ABORTED') {
        fail('TABLE_ARTIFACT_REQUEST_ABORTED', 'artifact request was aborted');
      }
      throw error;
    }
  }
  fail('TABLE_ARTIFACT_PUBLICATION_FAILED', 'artifact ID collision limit reached');
}

async function closeHandle(handle) {
  if (handle) await handle.close();
}

async function writePrivateFile(state, request, path, bytes, onIdentity = () => {}) {
  const flags = FS_CONSTANTS.O_WRONLY | FS_CONSTANTS.O_CREAT | FS_CONSTANTS.O_EXCL | FS_CONSTANTS.O_NOFOLLOW;
  let handle;
  try {
    handle = await checkedStep(request, () => state.fs.open(path, flags, 0o600));
    await checkedStep(request, () => handle.writeFile(bytes));
    const stats = await checkedStep(request, () => handle.stat());
    assertFileStats(stats, bytes.length);
    const identity = storedFileIdentity(stats);
    onIdentity(identity);
    await checkedStep(request, () => handle.sync());
    return identity;
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

function exactObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function nonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validateCommittedManifest(value, state, artifactId) {
  const rootKeys = [
    'schema', 'logicalRows', 'logicalCountSource', 'identitySource', 'orderingSource',
    'mountedRows', 'collectedRows', 'recycledMountedNodes', 'completeness', 'artifact',
    'inline', 'ownership',
  ];
  if (!exactObject(value, rootKeys)
    || value.schema !== 'chrome-cdp-ex.table-export.v1'
    || !(value.logicalRows === null || nonNegativeSafeInteger(value.logicalRows))
    || !['aria-rowcount', 'none'].includes(value.logicalCountSource)
    || !['aria-rowindex', 'row-key-column'].includes(value.identitySource)
    || value.orderingSource !== value.identitySource
    || !nonNegativeSafeInteger(value.mountedRows)
    || !nonNegativeSafeInteger(value.collectedRows)
    || !nonNegativeSafeInteger(value.recycledMountedNodes)) {
    fail('TABLE_ARTIFACT_READ_FAILED', 'artifact manifest verification failed');
  }
  if (!exactObject(value.completeness, ['state', 'termination'])
    || !['complete', 'incomplete', 'unknown'].includes(value.completeness.state)
    || typeof value.completeness.termination !== 'string') {
    fail('TABLE_ARTIFACT_READ_FAILED', 'artifact manifest verification failed');
  }
  if (!exactObject(value.artifact, ['rows', 'bytes', 'checksum', 'checksumScope'])
    || !nonNegativeSafeInteger(value.artifact.rows)
    || value.artifact.rows > TABLE_EXTRACTION_LIMITS.maxRows
    || !nonNegativeSafeInteger(value.artifact.bytes)
    || value.artifact.bytes > TABLE_EXTRACTION_LIMITS.maxArtifactBytes
    || !/^[0-9a-f]{64}$/.test(value.artifact.checksum)
    || value.artifact.checksumScope !== 'canonical-data-rows-tsv-utf8'
    || value.collectedRows !== value.artifact.rows) {
    fail('TABLE_ARTIFACT_READ_FAILED', 'artifact manifest verification failed');
  }
  if (!exactObject(value.ownership, ['artifactId', 'targetDigest', 'sessionDigest'])
    || value.ownership.artifactId !== artifactId
    || value.ownership.targetDigest !== state.targetDigest
    || value.ownership.sessionDigest !== state.sessionDigest) {
    fail('TABLE_ARTIFACT_READ_FAILED', 'artifact ownership verification failed');
  }
  if (!exactObject(value.inline, ['rows', 'rowCount', 'bytes', 'truncated'])
    || !Array.isArray(value.inline.rows)
    || value.inline.rows.some(row => typeof row !== 'string')
    || !nonNegativeSafeInteger(value.inline.rowCount)
    || value.inline.rowCount !== value.inline.rows.length
    || !nonNegativeSafeInteger(value.inline.bytes)
    || typeof value.inline.truncated !== 'boolean') {
    fail('TABLE_ARTIFACT_READ_FAILED', 'artifact manifest verification failed');
  }
  return value;
}

async function verifyOwnedLayers(state, entry) {
  const layers = [
    [state.runtimeDir, null],
    [state.ownerDir, state.rootReal],
    [state.targetDir, state.ownerReal],
    [state.sessionDir, state.targetReal],
    [entry.path, state.sessionReal],
  ];
  for (const [path, parentReal] of layers) {
    const stats = await state.fs.lstat(path);
    assertDirectoryStats(stats);
    if (path === entry.path && !matchesStoredIdentity(stats, entry.directoryIdentity)) {
      fail('TABLE_ARTIFACT_READ_FAILED', 'artifact directory identity verification failed');
    }
    const actual = await state.fs.realpath(path);
    if (parentReal && (!isContained(parentReal, actual) || actual === parentReal)) {
      fail('TABLE_ARTIFACT_READ_FAILED', 'artifact containment verification failed');
    }
  }
}

async function readPrivateFile(state, path, {
  expectedBytes = null,
  expectedHash = null,
  expectedIdentity = null,
  maxBytes,
}) {
  const flags = FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_NOFOLLOW;
  let handle;
  try {
    handle = await state.fs.open(path, flags);
    const stats = await handle.stat();
    assertReadableFileStats(stats, { expectedBytes, maxBytes });
    if (!matchesStoredIdentity(stats, expectedIdentity, { file: true })) {
      fail('TABLE_ARTIFACT_READ_FAILED', 'private artifact identity verification failed');
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    assertReadableFileStats(after, { expectedBytes, maxBytes });
    if (!Buffer.isBuffer(bytes) || bytes.length !== stats.size) {
      fail('TABLE_ARTIFACT_READ_FAILED', 'private artifact verification failed');
    }
    if (!stableFileIdentity(stats, after)) {
      fail('TABLE_ARTIFACT_READ_FAILED', 'private artifact changed while it was read');
    }
    if (expectedHash && createHash('sha256').update(bytes).digest('hex') !== expectedHash) {
      fail('TABLE_ARTIFACT_READ_FAILED', 'private artifact content verification failed');
    }
    return bytes;
  } finally {
    await closeHandle(handle);
  }
}

function fatalUtf8(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('TABLE_ARTIFACT_READ_FAILED', 'artifact UTF-8 verification failed');
  }
}

function artifactRows(rowsTsv, count) {
  const rows = count === 0 ? [] : rowsTsv.split('\n');
  if (rows.length !== count || rows.join('\n') !== rowsTsv) {
    fail('TABLE_ARTIFACT_READ_FAILED', 'artifact row count verification failed');
  }
  for (const row of rows) {
    if (Buffer.byteLength(row, 'utf8') > TABLE_EXTRACTION_LIMITS.maxCanonicalRowBytes
      || Buffer.byteLength(JSON.stringify(row), 'utf8') > 8194) {
      fail('TABLE_ARTIFACT_READ_FAILED', 'artifact contains a row that is too large');
    }
  }
  return rows;
}

function validateInlineManifestRows(manifest, rows) {
  const inlineRows = rows.slice(0, manifest.inline.rowCount);
  const inlineBytes = Buffer.byteLength(inlineRows.join('\n'), 'utf8');
  if (manifest.inline.rowCount > TABLE_EXTRACTION_LIMITS.maxInlineRows
    || manifest.inline.bytes > TABLE_EXTRACTION_LIMITS.maxInlineBytes
    || manifest.inline.bytes !== inlineBytes
    || manifest.inline.truncated !== (inlineRows.length < rows.length)
    || manifest.inline.rows.some((row, index) => row !== inlineRows[index])) {
    fail('TABLE_ARTIFACT_READ_FAILED', 'artifact inline manifest verification failed');
  }
}

function continuationResult(manifest, artifactId, token, offset, rows, nextToken) {
  return {
    schema: 'chrome-cdp-ex.table.v1',
    logicalRows: manifest.logicalRows,
    logicalCountSource: manifest.logicalCountSource,
    identitySource: manifest.identitySource,
    orderingSource: manifest.orderingSource,
    mountedRows: manifest.mountedRows,
    collectedRows: manifest.collectedRows,
    recycledMountedNodes: manifest.recycledMountedNodes,
    completeness: { ...manifest.completeness },
    artifact: {
      id: artifactId,
      rows: manifest.artifact.rows,
      bytes: manifest.artifact.bytes,
      checksum: manifest.artifact.checksum,
      checksumScope: manifest.artifact.checksumScope,
    },
    continuation: {
      token,
      offset,
      rowCount: rows.length,
      rows,
      bytes: Buffer.byteLength(rows.join('\n'), 'utf8'),
      nextToken,
    },
  };
}

async function readContinuation(state, token) {
  const parsed = parseTableContinuationToken(token);
  if (state.platform === 'win32') {
    fail('TABLE_ARTIFACT_UNSUPPORTED_PLATFORM', 'private table artifacts are unavailable on Windows in v2.16');
  }
  const entry = state.entries.get(parsed.artifactId);
  if (!entry?.committed) {
    fail('TABLE_ARTIFACT_READ_FAILED', 'artifact is not available in this session');
  }
  try {
    await verifyOwnedLayers(state, entry);
    const paths = entryPaths(entry);
    const manifestBytes = await readPrivateFile(state, paths.manifest, {
      expectedBytes: entry.manifestBytes,
      expectedHash: entry.manifestHash,
      expectedIdentity: entry.fileIdentities.manifest,
      maxBytes: MAX_MANIFEST_BYTES,
    });
    let parsedManifest;
    try {
      parsedManifest = JSON.parse(fatalUtf8(manifestBytes));
    } catch (error) {
      if (error instanceof TableArtifactStorageError) throw error;
      fail('TABLE_ARTIFACT_READ_FAILED', 'artifact manifest verification failed');
    }
    const manifest = validateCommittedManifest(parsedManifest, state, entry.id);
    if (parsed.offset >= manifest.artifact.rows) {
      fail('TABLE_ARTIFACT_READ_FAILED', 'continuation offset is outside the artifact');
    }
    const dataBytes = await readPrivateFile(state, paths.rows, {
      expectedBytes: manifest.artifact.bytes,
      expectedHash: entry.rowsHash,
      expectedIdentity: entry.fileIdentities.rows,
      maxBytes: TABLE_EXTRACTION_LIMITS.maxArtifactBytes,
    });
    const checksum = createHash('sha256').update(dataBytes).digest('hex');
    if (checksum !== manifest.artifact.checksum) {
      fail('TABLE_ARTIFACT_READ_FAILED', 'artifact checksum verification failed');
    }
    const allRows = artifactRows(fatalUtf8(dataBytes), manifest.artifact.rows);
    validateInlineManifestRows(manifest, allRows);
    let count = Math.min(TABLE_EXTRACTION_LIMITS.maxInlineRows, allRows.length - parsed.offset);
    let result;
    while (count > 0) {
      const rows = allRows.slice(parsed.offset, parsed.offset + count);
      const nextOffset = parsed.offset + count;
      const nextToken = nextOffset < allRows.length ? `ct1.${entry.id}.${nextOffset}` : null;
      result = continuationResult(manifest, entry.id, parsed.token, parsed.offset, rows, nextToken);
      if (Buffer.byteLength(JSON.stringify(result, null, 2), 'utf8') <= TABLE_EXTRACTION_LIMITS.maxResponseBytes) break;
      count -= 1;
    }
    if (count === 0 || !result) {
      fail('TABLE_ARTIFACT_READ_FAILED', 'artifact row cannot fit the continuation response');
    }
    return freezeDeep(result);
  } catch (error) {
    if (error instanceof TableArtifactStorageError) {
      if (error.code === 'TABLE_ARTIFACT_READ_FAILED') throw error;
      throw new TableArtifactStorageError('TABLE_ARTIFACT_READ_FAILED', 'table: private artifact read failed');
    }
    throw new TableArtifactStorageError('TABLE_ARTIFACT_READ_FAILED', 'table: private artifact read failed');
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
    try {
      sweepCrashResidue(state);
    } catch (error) {
      if (error?.code !== 'TABLE_ARTIFACT_CLEANUP_FAILED') throw error;
    }
    entry = await mintEntry(state, request);
    const paths = entryPaths(entry);
    const rowsBytes = Buffer.from(verified.rowsTsv, 'utf8');
    entry.fileIdentities.rows = await writePrivateFile(state, request, paths.rows, rowsBytes);
    entry.rowsHash = createHash('sha256').update(rowsBytes).digest('hex');
    const committedManifest = freezeDeep({
      ...verified.manifest,
      ownership: {
        artifactId: entry.id,
        targetDigest: state.targetDigest,
        sessionDigest: state.sessionDigest,
      },
    });
    const manifestBytes = Buffer.from(`${JSON.stringify(committedManifest, null, 2)}\n`, 'utf8');
    entry.fileIdentities.manifest = await writePrivateFile(state, request, paths.manifest, manifestBytes);
    entry.manifestBytes = manifestBytes.length;
    entry.manifestHash = createHash('sha256').update(manifestBytes).digest('hex');
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
      const cleaned = cleanupEntry(state, entry);
      if (cleaned) {
        entry.request.entries.delete(entry);
        state.entries.delete(entry.id);
      } else {
        throw cleanupFailed();
      }
    }
    if (!entry && request.entries.size === 0) state.requests.delete(request.context);
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
  let failed = false;
  for (const entry of [...request.entries]) {
    if (cleanupEntry(state, entry)) {
      request.entries.delete(entry);
      state.entries.delete(entry.id);
    } else failed = true;
  }
  if (request.entries.size === 0) state.requests.delete(context);
  if (failed) throw cleanupFailed();
}

function releaseRequest(state, execution) {
  const context = inspectCommandExecutionContext(execution);
  const request = state.requests.get(context);
  if (!request) return;
  for (const entry of request.entries) entry.request = null;
  request.entries.clear();
  state.requests.delete(context);
}

function provenDeadProcess(state, pid) {
  try {
    state.processAlive(pid);
    return false;
  } catch (error) {
    return error?.code === 'ESRCH';
  }
}

function safeContainedChildDirectory(parent, name) {
  const path = join(parent, name);
  if (!safeOwnedDirectory(path)) return false;
  try {
    const parentReal = realpathSync(parent);
    const actual = realpathSync(path);
    return isContained(parentReal, actual) && actual !== parentReal;
  } catch {
    return false;
  }
}

function closeSweepDirectory(directory) {
  if (!directory) return true;
  try {
    directory.closeSync();
    return true;
  } catch {
    return false;
  }
}

function closeActiveSweepTarget(state) {
  const active = state.sweepCursor.activeTarget;
  state.sweepCursor.activeTarget = null;
  return closeSweepDirectory(active?.directory);
}

function closeSweepCursor(state) {
  const activeClosed = closeActiveSweepTarget(state);
  const ownerDirectory = state.sweepCursor.ownerDirectory;
  state.sweepCursor.ownerDirectory = null;
  return closeSweepDirectory(ownerDirectory) && activeClosed;
}

function sweepFileStats(path, maxBytes) {
  try {
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.uid !== currentUid()
      || modeBits(stats) !== 0o600 || stats.nlink !== 1 || stats.size > maxBytes) return null;
    return stats;
  } catch {
    return null;
  }
}

function sweepArtifact(state, targetDir, targetDigest, sessionDir, sessionDigest, artifactId, now) {
  const directoryStats = lstatSync(join(sessionDir, artifactId));
  const entry = {
    id: artifactId,
    path: join(sessionDir, artifactId),
    directoryCreated: true,
    directoryIdentity: storedDirectoryIdentity(directoryStats),
    fileIdentities: Object.create(null),
    committed: false,
    request: null,
  };
  if (!verifyCleanupDirectory(state, entry, sessionDir, targetDir)) return false;
  let listing;
  try { listing = readDirectoryBounded(entry.path, SWEEP_LIMITS.files); } catch { return false; }
  if (listing.truncated || listing.entries.some(name => !['rows.tsv', 'manifest.json'].includes(name))) {
    return false;
  }
  const paths = entryPaths(entry);
  const rowsPresent = listing.entries.includes('rows.tsv');
  const manifestPresent = listing.entries.includes('manifest.json');
  const stats = [lstatSync(entry.path)];
  if (rowsPresent) {
    const rowsStats = sweepFileStats(paths.rows, TABLE_EXTRACTION_LIMITS.maxArtifactBytes);
    if (!rowsStats) return false;
    entry.fileIdentities.rows = storedFileIdentity(rowsStats);
    stats.push(rowsStats);
  }
  if (manifestPresent) {
    const manifestStats = sweepFileStats(paths.manifest, MAX_MANIFEST_BYTES);
    if (!manifestStats || !rowsPresent) return false;
    let manifest;
    try {
      manifest = validateCommittedManifest(
        JSON.parse(fatalUtf8(readPrivateFileSync(paths.manifest, MAX_MANIFEST_BYTES))),
        { targetDigest, sessionDigest },
        artifactId,
      );
    } catch {
      return false;
    }
    let dataBytes;
    let rows;
    try {
      dataBytes = readPrivateFileSync(paths.rows, TABLE_EXTRACTION_LIMITS.maxArtifactBytes);
      if (manifest.artifact.bytes !== dataBytes.length
        || manifest.artifact.bytes !== stats[1].size
        || createHash('sha256').update(dataBytes).digest('hex') !== manifest.artifact.checksum) {
        return false;
      }
      rows = artifactRows(fatalUtf8(dataBytes), manifest.artifact.rows);
      validateInlineManifestRows(manifest, rows);
    } catch {
      return false;
    }
    entry.fileIdentities.manifest = storedFileIdentity(manifestStats);
    stats.push(manifestStats);
  }
  const newestMtime = Math.max(...stats.map(value => value.mtimeMs));
  const ttl = manifestPresent ? COMMITTED_SWEEP_TTL_MS : UNCOMMITTED_SWEEP_TTL_MS;
  if (!Number.isFinite(newestMtime) || now < newestMtime || now - newestMtime < ttl) return null;
  return cleanupEntry(state, entry, sessionDir, targetDir);
}

function removeOwnerAndEmptySession(
  state,
  targetDir,
  targetDigest,
  sessionDir,
  sessionDigest,
  expectedOwner = null,
) {
  try {
    lstatSync(sessionDir);
  } catch (error) {
    return error?.code === 'ENOENT';
  }
  if (!verifyCleanupDirectory(state, null, sessionDir, targetDir)) return false;
  let listing;
  try { listing = readDirectoryBounded(sessionDir, SWEEP_LIMITS.artifacts); } catch { return false; }
  if (listing.truncated || listing.entries.length !== 1 || listing.entries[0] !== OWNER_RECORD_NAME) {
    return false;
  }
  const ownerPath = join(sessionDir, OWNER_RECORD_NAME);
  let owner;
  try {
    owner = readOwnerRecord(ownerPath, { targetDigest, sessionDigest });
  } catch {
    return false;
  }
  if (expectedOwner && (owner.pid !== expectedOwner.pid
    || owner.createdAtMs !== expectedOwner.createdAtMs)) return false;
  try {
    unlinkSync(ownerPath);
    if (readdirSync(sessionDir).length !== 0) return false;
    rmdirSync(sessionDir);
    return true;
  } catch {
    return false;
  }
}

function sweepDeadSession(state, targetDir, targetDigest, sessionDigest, now) {
  const sessionDir = join(targetDir, sessionDigest);
  if (!verifyCleanupDirectory(state, null, sessionDir, targetDir)) return false;
  let owner;
  try {
    owner = readOwnerRecord(join(sessionDir, OWNER_RECORD_NAME), {
      targetDigest,
      sessionDigest,
    });
  } catch {
    return false;
  }
  if (!provenDeadProcess(state, owner.pid)) return null;
  let sessionEligible;
  try {
    const ownerStats = lstatSync(join(sessionDir, OWNER_RECORD_NAME));
    const sessionStats = lstatSync(sessionDir);
    const newestSessionAuthority = Math.max(
      owner.createdAtMs,
      ownerStats.mtimeMs,
      sessionStats.mtimeMs,
    );
    sessionEligible = Number.isFinite(newestSessionAuthority)
      && now >= newestSessionAuthority
      && now - newestSessionAuthority >= UNCOMMITTED_SWEEP_TTL_MS;
  } catch {
    return false;
  }
  let listing;
  try { listing = readDirectoryBounded(sessionDir, SWEEP_LIMITS.artifacts); } catch { return false; }
  let failed = listing.truncated;
  for (const name of listing.entries) {
    if (name === OWNER_RECORD_NAME) continue;
    if (!/^[0-9a-f]{32}$/.test(name)) {
      failed = true;
      continue;
    }
    const cleaned = sweepArtifact(
      state, targetDir, targetDigest, sessionDir, sessionDigest, name, now,
    );
    if (cleaned === false) failed = true;
  }
  let remaining;
  try { remaining = readDirectoryBounded(sessionDir, SWEEP_LIMITS.artifacts); } catch { return false; }
  if (!remaining.truncated && remaining.entries.length === 1
    && remaining.entries[0] === OWNER_RECORD_NAME && sessionEligible) {
    if (!removeOwnerAndEmptySession(
      state, targetDir, targetDigest, sessionDir, sessionDigest, owner,
    )) failed = true;
  }
  return failed ? false : true;
}

function sweepCrashResidue(state) {
  if (state.platform === 'win32' || !state.initialized) return;
  if (!verifyCleanupDirectory(state)) {
    fail('TABLE_ARTIFACT_STORAGE_INVALID', 'private artifact session authority is invalid');
  }
  let failed = false;
  try {
    const now = state.now();
    if (!Number.isFinite(now) || now < 0) throw cleanupFailed();
    let targetCount = 0;
    let sessionCount = 0;
    while (targetCount < SWEEP_LIMITS.targets && sessionCount < SWEEP_LIMITS.sessions) {
      if (!state.sweepCursor.activeTarget) {
        if (!state.sweepCursor.ownerDirectory) {
          state.sweepCursor.ownerDirectory = opendirSync(state.ownerDir);
        }
        const targetEntry = state.sweepCursor.ownerDirectory.readSync();
        if (!targetEntry) {
          if (!closeSweepDirectory(state.sweepCursor.ownerDirectory)) failed = true;
          state.sweepCursor.ownerDirectory = null;
          break;
        }
        targetCount += 1;
        const targetDigest = targetEntry.name;
        if (!/^[0-9a-f]{64}$/.test(targetDigest)
          || !safeContainedChildDirectory(state.ownerDir, targetDigest)) {
          failed = true;
          continue;
        }
        const targetDir = join(state.ownerDir, targetDigest);
        try {
          state.sweepCursor.activeTarget = {
            targetDigest,
            targetDir,
            directory: opendirSync(targetDir),
          };
        } catch {
          failed = true;
          state.sweepCursor.activeTarget = null;
          continue;
        }
      }
      const active = state.sweepCursor.activeTarget;
      let sessionEntry;
      try {
        sessionEntry = active.directory.readSync();
      } catch {
        failed = true;
        closeActiveSweepTarget(state);
        continue;
      }
      if (!sessionEntry) {
        if (!closeActiveSweepTarget(state)) failed = true;
        continue;
      }
      sessionCount += 1;
      const sessionDigest = sessionEntry.name;
      if (active.targetDigest === state.targetDigest && sessionDigest === state.sessionDigest) continue;
      if (!/^[0-9a-f]{64}$/.test(sessionDigest)) {
        failed = true;
        continue;
      }
      const result = sweepDeadSession(
        state, active.targetDir, active.targetDigest, sessionDigest, now,
      );
      if (result === false) failed = true;
    }
  } catch (error) {
    if (error instanceof TableArtifactStorageError
      && error.code === 'TABLE_ARTIFACT_STORAGE_INVALID') throw error;
    failed = true;
  }
  if (failed) throw cleanupFailed();
}

function cleanupSession(state) {
  for (const request of state.requests.values()) request.rolledBack = true;
  let failed = !closeSweepCursor(state);
  if (!state.initialized && state.initialization && !cleanupPartialInitialization(state)) {
    failed = true;
  }
  for (const entry of [...state.entries.values()]) {
    if (cleanupEntry(state, entry)) {
      entry.request?.entries.delete(entry);
      state.entries.delete(entry.id);
    } else failed = true;
  }
  for (const [context, request] of state.requests) {
    if (request.entries.size === 0) state.requests.delete(context);
  }
  if (state.initialized && state.entries.size === 0 && !removeOwnerAndEmptySession(
    state,
    state.targetDir,
    state.targetDigest,
    state.sessionDir,
    state.sessionDigest,
    ownerRecordForState(state),
  )) failed = true;
  if (failed) throw cleanupFailed();
}

function makeStore(input, dependencies) {
  const options = validateFactoryInput(input);
  if (!Number.isSafeInteger(dependencies.pid) || dependencies.pid <= 0
    || typeof dependencies.now !== 'function'
    || typeof dependencies.processAlive !== 'function') {
    fail('TABLE_ARTIFACT_STORAGE_INVALID', 'artifact store runtime dependencies are invalid');
  }
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
    ownerRecordPath: join(sessionDir, OWNER_RECORD_NAME),
    pid: dependencies.pid,
    now: dependencies.now,
    processAlive: dependencies.processAlive,
    sweepCursor: { ownerDirectory: null, activeTarget: null },
    createdAtMs: null,
    initialization: null,
    initialized: false,
    entries: new Map(),
    requests: new Map(),
    randomBytes: dependencies.randomBytes,
    fs: dependencies.fs,
  };
  const store = Object.freeze({
    publish: (bundle, execution) => publish(state, bundle, execution),
    readContinuation: token => readContinuation(state, token),
    rollbackRequest: execution => rollbackRequest(state, execution),
    releaseRequest: execution => releaseRequest(state, execution),
    cleanupSession: () => cleanupSession(state),
    sweepCrashResidue: () => sweepCrashResidue(state),
  });
  STORE_STATES.set(store, state);
  return store;
}

const DEFAULT_DEPENDENCIES = Object.freeze({
  randomBytes: secureRandomBytes,
  fs: Object.freeze({ lstat, mkdir, open: openFile, realpath }),
  now: Date.now,
  pid: process.pid,
  processAlive: pid => process.kill(pid, 0),
});

export function createTableArtifactStore(input) {
  return makeStore(input, DEFAULT_DEPENDENCIES);
}

function createTableArtifactStoreWithDependencies(input, dependencies = {}) {
  return makeStore(input, {
    randomBytes: dependencies.randomBytes || DEFAULT_DEPENDENCIES.randomBytes,
    now: dependencies.now || DEFAULT_DEPENDENCIES.now,
    pid: dependencies.pid || DEFAULT_DEPENDENCIES.pid,
    processAlive: dependencies.processAlive || DEFAULT_DEPENDENCIES.processAlive,
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
    ownerRecordPath: state.ownerRecordPath,
    activeRequestCount: state.requests.size,
    registeredArtifactIds: Object.freeze([...state.entries.keys()]),
  });
}

export const __test__ = process.env.NODE_ENV === 'test' ? Object.freeze({
  createTableArtifactStoreWithDependencies,
  inspectTableArtifactStore,
}) : undefined;
