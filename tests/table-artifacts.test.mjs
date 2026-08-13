import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  lstat as lstatAsync,
  mkdir as mkdirAsync,
  open,
  realpath as realpathAsync,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createCommandExecutionContext } from '../skills/chrome-cdp-ex/scripts/lib/command-application.mjs';
import {
  addTableSample,
  buildTableExportBundle,
  createTableAccumulator,
} from '../skills/chrome-cdp-ex/scripts/lib/table-extraction.mjs';
import {
  __test__ as artifactTest,
  createTableArtifactStore,
} from '../skills/chrome-cdp-ex/scripts/lib/table-artifacts.mjs';

const created = [];
const ID_A = '0123456789abcdef0123456789abcdef';
const ID_B = 'fedcba9876543210fedcba9876543210';

afterEach(() => {
  while (created.length) rmSync(created.pop(), { recursive: true, force: true });
});

function privateRuntimeRoot() {
  const path = mkdtempSync(join(tmpdir(), 'cdp-table-artifacts-'));
  chmodSync(path, 0o700);
  created.push(path);
  return path;
}

function execution() {
  return createCommandExecutionContext({ signal: new AbortController().signal, deadline: null });
}

function bundleForRows(rows = [['one'], ['two']]) {
  const accumulator = createTableAccumulator({
    logicalRows: rows.length,
    logicalCountSource: 'aria-rowcount',
    identitySource: 'aria-rowindex',
    orderingSource: 'aria-rowindex',
  });
  rows.forEach((cells, index) => addTableSample(accumulator, {
    mountedNodeId: `node-${index}`,
    key: index + 1,
    cells,
  }));
  return buildTableExportBundle(accumulator, { termination: 'logical-count-reached' });
}

function deterministicBytes(...ids) {
  let index = 0;
  return size => {
    expect(size).toBe(16);
    const id = ids[index++];
    if (!id) throw new Error('unexpected random ID request');
    return Buffer.from(id, 'hex');
  };
}

function testStore(runtimeDir, overrides = {}, dependencies = {}) {
  return artifactTest.createTableArtifactStoreWithDependencies({
    runtimeDir,
    targetId: 'target-full-identity',
    sessionId: 'private-session-identity',
    platform: 'darwin',
    ...overrides,
  }, {
    randomBytes: deterministicBytes(ID_A),
    ...dependencies,
  });
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function tracedHandle(handle, label, trace, overrides = {}) {
  return {
    async writeFile(...args) {
      trace.push(`${label}:write`);
      return overrides.writeFile ? overrides.writeFile(handle, ...args) : handle.writeFile(...args);
    },
    async stat(...args) {
      trace.push(`${label}:fstat`);
      return overrides.stat ? overrides.stat(handle, ...args) : handle.stat(...args);
    },
    async sync(...args) {
      trace.push(`${label}:fsync`);
      return overrides.sync ? overrides.sync(handle, ...args) : handle.sync(...args);
    },
    async close(...args) {
      trace.push(`${label}:close`);
      return overrides.close ? overrides.close(handle, ...args) : handle.close(...args);
    },
  };
}

describe('private table artifact publication', () => {
  it('creates an opaque frozen lazy store without touching the filesystem', () => {
    const runtimeDir = join(tmpdir(), `missing-table-root-${process.pid}-${Date.now()}`);
    const store = createTableArtifactStore({
      runtimeDir,
      targetId: 'target-1',
      sessionId: 'private-session-1',
      platform: 'darwin',
    });

    expect(Object.isFrozen(store)).toBe(true);
    expect(Object.keys(store).sort()).toEqual([
      'cleanupSession',
      'publish',
      'readContinuation',
      'releaseRequest',
      'rollbackRequest',
      'sweepCrashResidue',
    ]);
    expect(existsSync(runtimeDir)).toBe(false);
  });

  it('fails path-free on missing, symlinked, or wrong-mode runtime roots', async () => {
    const missing = join(tmpdir(), `missing-table-root-${process.pid}-${Date.now()}`);
    const realRoot = privateRuntimeRoot();
    const symlink = `${realRoot}-link`;
    symlinkSync(realRoot, symlink);
    created.push(symlink);
    const wrongMode = privateRuntimeRoot();
    chmodSync(wrongMode, 0o755);

    for (const runtimeDir of [missing, symlink, wrongMode]) {
      const store = testStore(runtimeDir);
      let error;
      try { await store.publish(bundleForRows(), execution()); } catch (caught) { error = caught; }
      expect(error?.code).toBe('TABLE_ARTIFACT_STORAGE_INVALID');
      expect(error?.message).not.toContain(runtimeDir);
      expect(error?.message).not.toContain(tmpdir());
    }
  });

  it('publishes data durably before a manifest commit marker with exact private modes', async () => {
    const runtimeDir = privateRuntimeRoot();
    const trace = [];
    const store = testStore(runtimeDir, {}, {
      open: async (...args) => {
        const handle = await open(...args);
        const path = args[0];
        const label = basename(path) === 'rows.tsv'
          ? 'data'
          : basename(path) === 'manifest.json'
            ? 'manifest'
            : basename(path) === ID_A
              ? 'artifact-dir'
              : path === runtimeDir
                ? 'runtime-root'
                : path === layout.ownerDir
                  ? 'owner-dir'
                  : path === layout.targetDir
                    ? 'target-dir'
                    : 'session-dir';
        trace.push(`${label}:open`);
        return tracedHandle(handle, label, trace);
      },
    });
    const layout = artifactTest.inspectTableArtifactStore(store);
    const publication = await store.publish(bundleForRows(), execution());
    const artifactDir = join(layout.sessionDir, ID_A);
    const rowsPath = join(artifactDir, 'rows.tsv');
    const manifestPath = join(artifactDir, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

    expect(Object.isFrozen(publication)).toBe(true);
    expect(publication).toMatchObject({
      artifactId: ID_A,
      token: `ct1.${ID_A}.0`,
      artifact: {
        rows: 2,
        bytes: 7,
        checksumScope: 'canonical-data-rows-tsv-utf8',
      },
    });
    expect(JSON.stringify(publication)).not.toContain(runtimeDir);
    expect(readFileSync(rowsPath, 'utf8')).toBe('one\ntwo');
    expect(readdirSync(artifactDir).sort()).toEqual(['manifest.json', 'rows.tsv']);
    expect(lstatSync(layout.ownerDir).mode & 0o7777).toBe(0o700);
    expect(lstatSync(layout.targetDir).mode & 0o7777).toBe(0o700);
    expect(lstatSync(layout.sessionDir).mode & 0o7777).toBe(0o700);
    expect(lstatSync(artifactDir).mode & 0o7777).toBe(0o700);
    expect(lstatSync(rowsPath).mode & 0o7777).toBe(0o600);
    expect(lstatSync(manifestPath).mode & 0o7777).toBe(0o600);
    expect(realpathSync(artifactDir).startsWith(`${realpathSync(runtimeDir)}/`)).toBe(true);
    expect(manifest).toMatchObject({
      schema: 'chrome-cdp-ex.table-export.v1',
      ownership: {
        artifactId: ID_A,
        targetDigest: layout.targetDigest,
        sessionDigest: layout.sessionDigest,
      },
      artifact: publication.artifact,
    });
    expect(trace).toEqual([
      'runtime-root:open', 'runtime-root:fstat', 'runtime-root:fsync', 'runtime-root:close',
      'owner-dir:open', 'owner-dir:fstat', 'owner-dir:fsync', 'owner-dir:close',
      'target-dir:open', 'target-dir:fstat', 'target-dir:fsync', 'target-dir:close',
      'data:open', 'data:write', 'data:fstat', 'data:fsync', 'data:close',
      'manifest:open', 'manifest:write', 'manifest:fstat', 'manifest:fsync', 'manifest:close',
      'artifact-dir:open', 'artifact-dir:fstat', 'artifact-dir:fsync', 'artifact-dir:close',
      'session-dir:open', 'session-dir:fstat', 'session-dir:fsync', 'session-dir:close',
    ]);
  });

  it('remints an exclusive artifact directory collision without replacing or cleaning it', async () => {
    const runtimeDir = privateRuntimeRoot();
    const store = artifactTest.createTableArtifactStoreWithDependencies({
      runtimeDir,
      targetId: 'target-full-identity',
      sessionId: 'private-session-identity',
      platform: 'darwin',
    }, { randomBytes: deterministicBytes(ID_A, ID_A, ID_B) });
    const firstExecution = execution();
    await store.publish(bundleForRows([['first']]), firstExecution);
    store.releaseRequest(firstExecution);
    const layout = artifactTest.inspectTableArtifactStore(store);
    const publication = await store.publish(bundleForRows([['second']]), execution());

    expect(publication.artifactId).toBe(ID_B);
    expect(readFileSync(join(layout.sessionDir, ID_A, 'rows.tsv'), 'utf8')).toBe('first');
    expect(readFileSync(join(layout.sessionDir, ID_B, 'rows.tsv'), 'utf8')).toBe('second');
    expect(artifactTest.inspectTableArtifactStore(store).registeredArtifactIds).toEqual([ID_A, ID_B]);
  });

  it('does not create the manifest when data fsync fails and rolls back only its owned directory', async () => {
    const runtimeDir = privateRuntimeRoot();
    let dataFsyncCalls = 0;
    const store = testStore(runtimeDir, {}, {
      open: async (...args) => {
        const handle = await open(...args);
        if (basename(args[0]) !== 'rows.tsv') return handle;
        return tracedHandle(handle, 'data', [], {
          sync: async () => {
            dataFsyncCalls += 1;
            throw new Error(`host path ${runtimeDir}`);
          },
        });
      },
    });
    let error;
    try { await store.publish(bundleForRows(), execution()); } catch (caught) { error = caught; }
    const layout = artifactTest.inspectTableArtifactStore(store);

    expect(error?.code).toBe('TABLE_ARTIFACT_PUBLICATION_FAILED');
    expect(error?.message).not.toContain(runtimeDir);
    expect(dataFsyncCalls).toBe(1);
    expect(existsSync(join(layout.sessionDir, ID_A))).toBe(false);
  });

  it('returns no token and rolls back when durability fails after the manifest file is fsynced', async () => {
    const runtimeDir = privateRuntimeRoot();
    const trace = [];
    const store = testStore(runtimeDir, {}, {
      open: async (...args) => {
        const handle = await open(...args);
        const label = basename(args[0]) === 'rows.tsv'
          ? 'data'
          : basename(args[0]) === 'manifest.json'
            ? 'manifest'
            : basename(args[0]) === ID_A
              ? 'artifact-dir'
              : 'session-dir';
        return tracedHandle(handle, label, trace, label === 'artifact-dir' ? {
          sync: async () => { throw new Error(`artifact fsync ${runtimeDir}`); },
        } : {});
      },
    });

    await expect(store.publish(bundleForRows(), execution())).rejects.toMatchObject({
      code: 'TABLE_ARTIFACT_PUBLICATION_FAILED',
    });
    const layout = artifactTest.inspectTableArtifactStore(store);
    expect(trace).toContain('manifest:fsync');
    expect(existsSync(join(layout.sessionDir, ID_A))).toBe(false);
  });

  it.each(['rows.tsv', 'manifest.json', ID_A, 'session-dir'])(
    'returns no token and rolls back when %s close reports delayed I/O failure',
    async closeFault => {
      const runtimeDir = privateRuntimeRoot();
      let layout;
      const store = testStore(runtimeDir, {}, {
        open: async (...args) => {
          const handle = await open(...args);
          const path = args[0];
          const label = basename(path) === 'rows.tsv'
            ? 'rows.tsv'
            : basename(path) === 'manifest.json'
              ? 'manifest.json'
              : basename(path) === ID_A
                ? ID_A
                : layout && path === layout.sessionDir
                  ? 'session-dir'
                  : 'other';
          if (label !== closeFault) return handle;
          return tracedHandle(handle, label, [], {
            close: async realHandle => {
              await realHandle.close();
              throw new Error(`delayed close failure at ${runtimeDir}`);
            },
          });
        },
      });
      layout = artifactTest.inspectTableArtifactStore(store);

      let publication;
      let error;
      try { publication = await store.publish(bundleForRows(), execution()); } catch (caught) { error = caught; }

      expect(publication).toBeUndefined();
      expect(error?.code).toBe('TABLE_ARTIFACT_PUBLICATION_FAILED');
      expect(error?.message).not.toContain(runtimeDir);
      expect(existsSync(join(layout.sessionDir, ID_A))).toBe(false);
    },
  );

  it('tombstones an in-flight publish on rollback and self-cleans when the awaited fsync resumes', async () => {
    const runtimeDir = privateRuntimeRoot();
    let resumeFsync;
    let fsyncStarted;
    const fsyncReached = new Promise(resolve => { fsyncStarted = resolve; });
    const fsyncGate = new Promise(resolve => { resumeFsync = resolve; });
    const store = testStore(runtimeDir, {}, {
      open: async (...args) => {
        const handle = await open(...args);
        if (basename(args[0]) !== 'rows.tsv') return handle;
        return tracedHandle(handle, 'data', [], {
          sync: async real => {
            fsyncStarted();
            await fsyncGate;
            await real.sync();
          },
        });
      },
    });
    const request = execution();
    const pending = store.publish(bundleForRows(), request);
    await fsyncReached;

    expect(store.rollbackRequest(request)).toBeUndefined();
    resumeFsync();
    await expect(pending).rejects.toMatchObject({ code: 'TABLE_ARTIFACT_REQUEST_ABORTED' });
    const layout = artifactTest.inspectTableArtifactStore(store);
    expect(existsSync(join(layout.sessionDir, ID_A))).toBe(false);
  });

  it.each(['mkdir', 'lstat', 'realpath'])(
    'tombstones an in-flight artifact directory %s and leaves no registered residue',
    async blockedStep => {
      const runtimeDir = privateRuntimeRoot();
      let resume;
      let reached;
      const stepReached = new Promise(resolve => { reached = resolve; });
      const gate = new Promise(resolve => { resume = resolve; });
      const maybeBlock = async (step, path, operation) => {
        const result = await operation();
        if (step === blockedStep && basename(path) === ID_A) {
          reached();
          await gate;
        }
        return result;
      };
      const store = artifactTest.createTableArtifactStoreWithDependencies({
        runtimeDir,
        targetId: 'target',
        sessionId: 'session',
        platform: 'darwin',
      }, {
        randomBytes: deterministicBytes(ID_A),
        fs: {
          mkdir: (path, options) => maybeBlock('mkdir', path, () => mkdirAsync(path, options)),
          lstat: path => maybeBlock('lstat', path, () => lstatAsync(path)),
          realpath: path => maybeBlock('realpath', path, () => realpathAsync(path)),
        },
      });
      const request = execution();
      const pending = store.publish(bundleForRows(), request);
      await stepReached;

      expect(store.rollbackRequest(request)).toBeUndefined();
      resume();
      await expect(pending).rejects.toMatchObject({ code: 'TABLE_ARTIFACT_REQUEST_ABORTED' });
      const layout = artifactTest.inspectTableArtifactStore(store);
      expect(existsSync(join(layout.sessionDir, ID_A))).toBe(false);
      expect(layout.registeredArtifactIds).toEqual([]);
    },
  );

  it('rejects forged bundles and aborts before allocating artifact storage', async () => {
    const runtimeDir = privateRuntimeRoot();
    const store = testStore(runtimeDir);
    const forged = deepFreeze(structuredClone(bundleForRows()));

    await expect(store.publish(forged, execution())).rejects.toThrow(/trusted export bundle/i);
    expect(artifactTest.inspectTableArtifactStore(store).registeredArtifactIds).toEqual([]);
  });

  it('publishes zero-row exports without minting an EOF continuation token', async () => {
    const runtimeDir = privateRuntimeRoot();
    const store = testStore(runtimeDir);
    const publication = await store.publish(bundleForRows([]), execution());

    expect(publication.artifact.rows).toBe(0);
    expect(publication.token).toBeNull();
  });

  it('rejects caller-controlled path-like target and session identities before filesystem effects', () => {
    const runtimeDir = privateRuntimeRoot();
    for (const [targetId, sessionId] of [
      ['', 'session'],
      ['target', ''],
      ['target', '../session'],
      ['../target', 'session'],
      ['target', '%2e%2e%2fsession'],
      ['/absolute', 'session'],
    ]) {
      expect(() => createTableArtifactStore({ runtimeDir, targetId, sessionId, platform: 'darwin' }))
        .toThrow(/identity/i);
    }
    expect(readdirSync(runtimeDir)).toEqual([]);
  });
});

describe('immutable row-aligned table continuation', () => {
  it('rejects hostile tokens before every filesystem operation', async () => {
    const runtimeDir = privateRuntimeRoot();
    let fsCalls = 0;
    const failIfCalled = async () => { fsCalls += 1; throw new Error('filesystem must not be reached'); };
    const store = artifactTest.createTableArtifactStoreWithDependencies({
      runtimeDir,
      targetId: 'target',
      sessionId: 'session',
      platform: 'darwin',
    }, { fs: { lstat: failIfCalled, mkdir: failIfCalled, open: failIfCalled, realpath: failIfCalled } });

    for (const token of [
      `ct1.${ID_A}.100000`,
      `ct1.${ID_A}.01`,
      `ct1.${ID_A}.+1`,
      `ct1.${ID_A}.1.extra`,
      `ct1.${ID_A.toUpperCase()}.1`,
      `../ct1.${ID_A}.1`,
    ]) {
      await expect(store.readContinuation(token)).rejects.toThrow(/continuation token/i);
    }
    expect(fsCalls).toBe(0);
  });

  it('returns at most twenty whole rows with immutable idempotent next tokens', async () => {
    const runtimeDir = privateRuntimeRoot();
    const store = testStore(runtimeDir);
    const rows = Array.from({ length: 25 }, (_, index) => [`row-${index + 1}`]);
    const publication = await store.publish(bundleForRows(rows), execution());

    const first = await store.readContinuation(publication.token);
    const repeated = await store.readContinuation(publication.token);
    const second = await store.readContinuation(first.continuation.nextToken);

    expect(first).toEqual({
      schema: 'chrome-cdp-ex.table.v1',
      logicalRows: 25,
      logicalCountSource: 'aria-rowcount',
      identitySource: 'aria-rowindex',
      orderingSource: 'aria-rowindex',
      mountedRows: 25,
      collectedRows: 25,
      recycledMountedNodes: 0,
      completeness: { state: 'complete', termination: 'logical-count-reached' },
      artifact: {
        id: ID_A,
        rows: 25,
        bytes: 165,
        checksum: publication.artifact.checksum,
        checksumScope: 'canonical-data-rows-tsv-utf8',
      },
      continuation: {
        token: `ct1.${ID_A}.0`,
        offset: 0,
        rowCount: 20,
        rows: Array.from({ length: 20 }, (_, index) => `row-${index + 1}`),
        bytes: 130,
        nextToken: `ct1.${ID_A}.20`,
      },
    });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.continuation.rows)).toBe(true);
    expect(JSON.stringify(repeated, null, 2)).toBe(JSON.stringify(first, null, 2));
    expect(second.continuation).toMatchObject({
      token: `ct1.${ID_A}.20`,
      offset: 20,
      rowCount: 5,
      rows: ['row-21', 'row-22', 'row-23', 'row-24', 'row-25'],
      nextToken: null,
    });
    expect(Buffer.byteLength(JSON.stringify(first, null, 2), 'utf8')).toBeLessThanOrEqual(16384);
    await expect(store.readContinuation(`ct1.${ID_A}.25`)).rejects.toThrow(/offset/i);
  });

  it('uses exact pretty JSON size and retains a valid prefix under two 1973-backslash rows', async () => {
    const runtimeDir = privateRuntimeRoot();
    const store = testStore(runtimeDir);
    const publication = await store.publish(bundleForRows([
      ['\\'.repeat(1973)],
      ['\\'.repeat(1973)],
    ]), execution());

    const first = await store.readContinuation(publication.token);
    const second = await store.readContinuation(first.continuation.nextToken);

    expect(first.continuation.rows).toEqual(['\\\\'.repeat(1973)]);
    expect(first.continuation.nextToken).toBe(`ct1.${ID_A}.1`);
    expect(second.continuation.rows).toEqual(['\\\\'.repeat(1973)]);
    expect(second.continuation.nextToken).toBeNull();
    expect(Buffer.byteLength(JSON.stringify(first, null, 2), 'utf8')).toBeLessThanOrEqual(16384);
  });

  it('preserves empty and trailing-empty rows using the authoritative manifest row count', async () => {
    const runtimeDir = privateRuntimeRoot();
    const store = testStore(runtimeDir);
    const publication = await store.publish(bundleForRows([['value'], [''], ['']]), execution());
    const result = await store.readContinuation(publication.token);

    expect(result.continuation.rows).toEqual(['value', '', '']);
    expect(result.continuation.bytes).toBe(7);
    expect(result.continuation.nextToken).toBeNull();
  });

  it('rejects unknown-session tokens without searching global artifact directories', async () => {
    const runtimeDir = privateRuntimeRoot();
    const store = testStore(runtimeDir);

    await expect(store.readContinuation(`ct1.${ID_A}.0`)).rejects.toThrow(/not available/i);
    expect(readdirSync(runtimeDir)).toEqual([]);
  });

  it('rejects a same-file mutation observed between pre-read and post-read fstat', async () => {
    const runtimeDir = privateRuntimeRoot();
    let dataReads = 0;
    const store = artifactTest.createTableArtifactStoreWithDependencies({
      runtimeDir,
      targetId: 'target',
      sessionId: 'session',
      platform: 'darwin',
    }, {
      randomBytes: deterministicBytes(ID_A),
      open: async (...args) => {
        const handle = await open(...args);
        if (basename(args[0]) !== 'rows.tsv' || (args[1] & 3) !== 0) return handle;
        const wrapped = tracedHandle(handle, 'data-read', [], {
          stat: real => real.stat(),
        });
        wrapped.readFile = async () => {
          dataReads += 1;
          const bytes = await handle.readFile();
          writeFileSync(args[0], 'tampered-after-read');
          return bytes;
        };
        return wrapped;
      },
    });
    const publication = await store.publish(bundleForRows(), execution());

    await expect(store.readContinuation(publication.token)).rejects.toMatchObject({
      code: 'TABLE_ARTIFACT_READ_FAILED',
    });
    expect(dataReads).toBe(1);
  });

  it('fails the read when a private file close reports delayed I/O failure', async () => {
    const runtimeDir = privateRuntimeRoot();
    let reading = false;
    const store = testStore(runtimeDir, {}, {
      open: async (...args) => {
        const handle = await open(...args);
        if (!reading || basename(args[0]) !== 'manifest.json') return handle;
        return tracedHandle(handle, 'manifest', [], {
          close: async realHandle => {
            await realHandle.close();
            throw new Error(`delayed close failure at ${runtimeDir}`);
          },
        });
      },
    });
    const publication = await store.publish(bundleForRows(), execution());
    reading = true;

    let error;
    try { await store.readContinuation(publication.token); } catch (caught) { error = caught; }
    expect(error?.code).toBe('TABLE_ARTIFACT_READ_FAILED');
    expect(error?.message).not.toContain(runtimeDir);
  });

  it.each(['missing-manifest', 'manifest-symlink', 'wrong-target', 'wrong-session', 'data-size', 'data-checksum'])(
    'fails path-free when committed artifact state is tampered: %s',
    async tamper => {
      const runtimeDir = privateRuntimeRoot();
      const store = testStore(runtimeDir);
      const publication = await store.publish(bundleForRows(), execution());
      const layout = artifactTest.inspectTableArtifactStore(store);
      const artifactDir = join(layout.sessionDir, ID_A);
      const manifestPath = join(artifactDir, 'manifest.json');
      const rowsPath = join(artifactDir, 'rows.tsv');
      if (tamper === 'missing-manifest') unlinkSync(manifestPath);
      else if (tamper === 'manifest-symlink') {
        const external = join(runtimeDir, 'external-manifest');
        writeFileSync(external, readFileSync(manifestPath));
        unlinkSync(manifestPath);
        symlinkSync(external, manifestPath);
      } else if (tamper === 'data-size') writeFileSync(rowsPath, 'one\ntwo!');
      else if (tamper === 'data-checksum') writeFileSync(rowsPath, 'uno\ntwo');
      else {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        if (tamper === 'wrong-target') manifest.ownership.targetDigest = '0'.repeat(64);
        else manifest.ownership.sessionDigest = 'f'.repeat(64);
        writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      }

      let error;
      try { await store.readContinuation(publication.token); } catch (caught) { error = caught; }
      expect(error?.code).toBe('TABLE_ARTIFACT_READ_FAILED');
      expect(error?.message).not.toContain(runtimeDir);
      expect(error?.message).not.toContain(artifactDir);
    },
  );
});

describe('artifact request and session ownership', () => {
  it('rolls back a request before flush but keeps a flushed artifact until session cleanup', async () => {
    const runtimeDir = privateRuntimeRoot();
    const store = artifactTest.createTableArtifactStoreWithDependencies({
      runtimeDir,
      targetId: 'target',
      sessionId: 'session',
      platform: 'darwin',
    }, { randomBytes: deterministicBytes(ID_A, ID_B) });
    const abandoned = execution();
    const flushed = execution();
    const abandonedPublication = await store.publish(bundleForRows([['abandoned']]), abandoned);
    const flushedPublication = await store.publish(bundleForRows([['flushed']]), flushed);
    const layout = artifactTest.inspectTableArtifactStore(store);

    expect(store.rollbackRequest(abandoned)).toBeUndefined();
    expect(existsSync(join(layout.sessionDir, abandonedPublication.artifactId))).toBe(false);
    expect(artifactTest.inspectTableArtifactStore(store).activeRequestCount).toBe(1);
    expect(store.releaseRequest(flushed)).toBeUndefined();
    expect(existsSync(join(layout.sessionDir, flushedPublication.artifactId))).toBe(true);
    expect(store.rollbackRequest(flushed)).toBeUndefined();
    expect(existsSync(join(layout.sessionDir, flushedPublication.artifactId))).toBe(true);

    expect(store.cleanupSession()).toBeUndefined();
    expect(store.cleanupSession()).toBeUndefined();
    expect(existsSync(join(layout.sessionDir, flushedPublication.artifactId))).toBe(false);
    expect(existsSync(layout.sessionDir)).toBe(false);
    expect(artifactTest.inspectTableArtifactStore(store).registeredArtifactIds).toEqual([]);
    expect(artifactTest.inspectTableArtifactStore(store).activeRequestCount).toBe(0);
  });

  it('reports a bounded path-free error without recursively removing unknown or tampered entries', async () => {
    const runtimeDir = privateRuntimeRoot();
    const store = testStore(runtimeDir);
    const publication = await store.publish(bundleForRows(), execution());
    const layout = artifactTest.inspectTableArtifactStore(store);
    const artifactDir = join(layout.sessionDir, publication.artifactId);
    const unknown = join(artifactDir, 'unknown.bin');
    writeFileSync(unknown, 'preserve me', { mode: 0o600 });
    unlinkSync(join(artifactDir, 'rows.tsv'));
    mkdirSync(join(artifactDir, 'rows.tsv'), { mode: 0o700 });

    let error;
    try { store.cleanupSession(); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ code: 'TABLE_ARTIFACT_CLEANUP_FAILED' });
    expect(error?.message).not.toContain(runtimeDir);
    expect(error?.message).not.toContain(artifactDir);
    expect(existsSync(artifactDir)).toBe(true);
    expect(readFileSync(unknown, 'utf8')).toBe('preserve me');
    expect(lstatSync(join(artifactDir, 'rows.tsv')).isDirectory()).toBe(true);
  });

  it('best-effort rolls back every safe sibling before reporting one tampered entry', async () => {
    const runtimeDir = privateRuntimeRoot();
    const store = artifactTest.createTableArtifactStoreWithDependencies({
      runtimeDir,
      targetId: 'target',
      sessionId: 'session',
      platform: 'darwin',
    }, { randomBytes: deterministicBytes(ID_A, ID_B) });
    const request = execution();
    await store.publish(bundleForRows([['tampered']]), request);
    await store.publish(bundleForRows([['safe']]), request);
    const layout = artifactTest.inspectTableArtifactStore(store);
    const tamperedDir = join(layout.sessionDir, ID_A);
    const safeDir = join(layout.sessionDir, ID_B);
    writeFileSync(join(tamperedDir, 'unknown.bin'), 'preserve me', { mode: 0o600 });

    let error;
    try { store.rollbackRequest(request); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ code: 'TABLE_ARTIFACT_CLEANUP_FAILED' });
    expect(existsSync(tamperedDir)).toBe(true);
    expect(existsSync(safeDir)).toBe(false);
    expect(artifactTest.inspectTableArtifactStore(store)).toMatchObject({
      activeRequestCount: 1,
      registeredArtifactIds: [ID_A],
    });
  });

  it('isolates stores by private session namespace for reads and cleanup', async () => {
    const runtimeDir = privateRuntimeRoot();
    const first = artifactTest.createTableArtifactStoreWithDependencies({
      runtimeDir,
      targetId: 'target',
      sessionId: 'session-a',
      platform: 'darwin',
    }, { randomBytes: deterministicBytes(ID_A) });
    const second = artifactTest.createTableArtifactStoreWithDependencies({
      runtimeDir,
      targetId: 'target',
      sessionId: 'session-b',
      platform: 'darwin',
    }, { randomBytes: deterministicBytes(ID_B) });
    const firstRequest = execution();
    const published = await first.publish(bundleForRows(), firstRequest);
    first.releaseRequest(firstRequest);
    const secondRequest = execution();
    await second.publish(bundleForRows([['other']]), secondRequest);
    second.releaseRequest(secondRequest);

    await expect(second.readContinuation(published.token)).rejects.toThrow(/not available/i);
    expect(second.cleanupSession()).toBeUndefined();
    expect(existsSync(join(artifactTest.inspectTableArtifactStore(first).sessionDir, ID_A))).toBe(true);
  });

  it('fails artifact-producing and continuation modes on Windows before filesystem effects', async () => {
    let fsCalls = 0;
    const failIfCalled = async () => { fsCalls += 1; throw new Error('filesystem must not be reached'); };
    const store = artifactTest.createTableArtifactStoreWithDependencies({
      runtimeDir: 'C:\\private-runtime',
      targetId: 'target',
      sessionId: 'session',
      platform: 'win32',
    }, {
      fs: { lstat: failIfCalled, mkdir: failIfCalled, open: failIfCalled, realpath: failIfCalled },
    });

    await expect(store.publish(bundleForRows(), execution())).rejects.toMatchObject({
      code: 'TABLE_ARTIFACT_UNSUPPORTED_PLATFORM',
    });
    await expect(store.readContinuation(`ct1.${ID_A}.0`)).rejects.toMatchObject({
      code: 'TABLE_ARTIFACT_UNSUPPORTED_PLATFORM',
    });
    expect(fsCalls).toBe(0);
  });
});
