import {
  constants as FS_CONSTANTS,
  lstatSync,
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

async function ensurePrivateDirectory(path, parentPath, parentReal, state, request) {
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
  if (created) await fsyncDirectory(state, request, parentPath);
  return actual;
}

async function initializeStore(state, request) {
  if (state.initialized) return;
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
  const sessionReal = await ensurePrivateDirectory(
    state.sessionDir, state.targetDir, targetReal, state, request,
  );
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

function safeOwnedDirectory(path) {
  try {
    const stats = lstatSync(path);
    return stats.isDirectory() && !stats.isSymbolicLink() && stats.uid === currentUid()
      && modeBits(stats) === 0o700;
  } catch {
    return false;
  }
}

function verifyCleanupDirectory(state, entry = null) {
  if (!state.initialized) return false;
  if (entry && (entry.path !== join(state.sessionDir, entry.id)
    || !/^[0-9a-f]{32}$/.test(entry.id))) return false;
  const paths = [state.runtimeDir, state.ownerDir, state.targetDir, state.sessionDir];
  if (entry) paths.push(entry.path);
  let parentReal = null;
  try {
    for (const path of paths) {
      if (!safeOwnedDirectory(path)) return false;
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

function cleanupEntry(state, entry) {
  if (!entry.directoryCreated) return true;
  try {
    lstatSync(entry.path);
  } catch (error) {
    return error?.code === 'ENOENT';
  }
  if (!verifyCleanupDirectory(state, entry)) return false;
  const paths = entryPaths(entry);
  for (const path of [paths.manifest, paths.rows]) {
    if (safeOwnedFile(path)) {
      try { unlinkSync(path); } catch {}
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

function cleanupEmptySessionDirectory(state) {
  if (!state.initialized) return true;
  try {
    lstatSync(state.sessionDir);
  } catch (error) {
    return error?.code === 'ENOENT';
  }
  try {
    if (!verifyCleanupDirectory(state)) return false;
    if (readdirSync(state.sessionDir).length !== 0) return false;
    rmdirSync(state.sessionDir);
    return true;
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
    const actual = await state.fs.realpath(path);
    if (parentReal && (!isContained(parentReal, actual) || actual === parentReal)) {
      fail('TABLE_ARTIFACT_READ_FAILED', 'artifact containment verification failed');
    }
  }
}

async function readPrivateFile(state, path, { expectedBytes = null, maxBytes }) {
  const flags = FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_NOFOLLOW;
  let handle;
  try {
    handle = await state.fs.open(path, flags);
    const stats = await handle.stat();
    assertReadableFileStats(stats, { expectedBytes, maxBytes });
    const bytes = await handle.readFile();
    const after = await handle.stat();
    assertReadableFileStats(after, { expectedBytes, maxBytes });
    if (!Buffer.isBuffer(bytes) || bytes.length !== stats.size) {
      fail('TABLE_ARTIFACT_READ_FAILED', 'private artifact verification failed');
    }
    if (!stableFileIdentity(stats, after)) {
      fail('TABLE_ARTIFACT_READ_FAILED', 'private artifact changed while it was read');
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
    const manifestBytes = await readPrivateFile(state, paths.manifest, { maxBytes: MAX_MANIFEST_BYTES });
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
      maxBytes: TABLE_EXTRACTION_LIMITS.maxArtifactBytes,
    });
    const checksum = createHash('sha256').update(dataBytes).digest('hex');
    if (checksum !== manifest.artifact.checksum) {
      fail('TABLE_ARTIFACT_READ_FAILED', 'artifact checksum verification failed');
    }
    const allRows = artifactRows(fatalUtf8(dataBytes), manifest.artifact.rows);
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
      const cleaned = cleanupEntry(state, entry);
      if (cleaned) {
        entry.request.entries.delete(entry);
        state.entries.delete(entry.id);
      } else {
        throw cleanupFailed();
      }
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

function cleanupSession(state) {
  for (const request of state.requests.values()) request.rolledBack = true;
  let failed = false;
  for (const entry of [...state.entries.values()]) {
    if (cleanupEntry(state, entry)) {
      entry.request?.entries.delete(entry);
      state.entries.delete(entry.id);
    } else failed = true;
  }
  for (const [context, request] of state.requests) {
    if (request.entries.size === 0) state.requests.delete(context);
  }
  if (state.entries.size === 0 && !cleanupEmptySessionDirectory(state)) failed = true;
  if (failed) throw cleanupFailed();
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
    readContinuation: token => readContinuation(state, token),
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
    activeRequestCount: state.requests.size,
    registeredArtifactIds: Object.freeze([...state.entries.keys()]),
  });
}

export const __test__ = process.env.NODE_ENV === 'test' ? Object.freeze({
  createTableArtifactStoreWithDependencies,
  inspectTableArtifactStore,
}) : undefined;
