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
} from 'node:fs';
import { open } from 'node:fs/promises';
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
    targetId: 'target/full/identity',
    sessionId: 'private-session-identity',
    platform: 'darwin',
    ...overrides,
  }, {
    randomBytes: deterministicBytes(ID_A),
    ...dependencies,
  });
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
    const store = testStore(runtimeDir);
    const publication = await store.publish(bundleForRows(), execution());
    const layout = artifactTest.inspectTableArtifactStore(store);
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
  });

  it('remints an exclusive artifact directory collision without replacing or cleaning it', async () => {
    const runtimeDir = privateRuntimeRoot();
    const store = artifactTest.createTableArtifactStoreWithDependencies({
      runtimeDir,
      targetId: 'target/full/identity',
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
  });

  it('does not create the manifest when data fsync fails and rolls back only its owned directory', async () => {
    const runtimeDir = privateRuntimeRoot();
    const store = testStore(runtimeDir, {}, {
      open: async (...args) => {
        const handle = await open(...args);
        if (basename(args[0]) !== 'rows.tsv') return handle;
        return new Proxy(handle, {
          get(target, property, receiver) {
            if (property === 'sync') return async () => { throw new Error(`host path ${runtimeDir}`); };
            return Reflect.get(target, property, receiver);
          },
        });
      },
    });
    let error;
    try { await store.publish(bundleForRows(), execution()); } catch (caught) { error = caught; }
    const layout = artifactTest.inspectTableArtifactStore(store);

    expect(error?.code).toBe('TABLE_ARTIFACT_PUBLICATION_FAILED');
    expect(error?.message).not.toContain(runtimeDir);
    expect(existsSync(join(layout.sessionDir, ID_A))).toBe(false);
  });

  it('rejects forged bundles and aborts before allocating artifact storage', async () => {
    const runtimeDir = privateRuntimeRoot();
    const store = testStore(runtimeDir);
    const forged = structuredClone(bundleForRows());

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
