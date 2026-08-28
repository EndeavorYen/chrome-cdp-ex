import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildEvidenceBundle,
  buildRegressionSeed,
  buildValidationSourceDigest,
  executeScenario,
  writeRegressionSeed,
} from '../scripts/lib/validation-lab.mjs';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const tempPaths = [];
const fixtureEntrypoint = 'validation/fixtures/controlled-failure.mjs';
const fixtureSourceDigest = buildValidationSourceDigest({ rootDir, entrypoint: fixtureEntrypoint });

afterEach(() => {
  for (const path of tempPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function tempDir() {
  const path = mkdtempSync(join(tmpdir(), 'chrome-cdp-regression-test-'));
  tempPaths.push(path);
  return path;
}

function scenario(overrides = {}) {
  return {
    id: 'repeatable-product',
    title: 'Repeatable product fixture',
    owner: 'maintainers',
    tags: ['fixture-only'],
    runner: { kind: 'node', entrypoint: fixtureEntrypoint, args: [], sourceDigest: fixtureSourceDigest },
    expect: { exitCodes: [0], stdoutIncludes: ['ready'] },
    risk: {
      units: 1,
      timeoutMs: 1000,
      maxOutputBytes: 1024,
      network: 'none',
      browser: 'none',
      mutation: 'none',
      maxAttempts: 2,
    },
    ...overrides,
  };
}

function processResult(overrides = {}) {
  return {
    status: 23,
    signal: null,
    stdout: 'not ready',
    stderr: 'repeatable assertion failure',
    timedOut: false,
    outputOverflow: false,
    spawnError: null,
    cleanupError: null,
    durationMs: 5,
    ...overrides,
  };
}

async function bundleFor(subject = scenario(), results = [processResult(), processResult()]) {
  let index = 0;
  const execution = await executeScenario(subject, {
    rootDir,
    sandboxDir: tempDir(),
    runProcess: async () => results[Math.min(index++, results.length - 1)],
  });
  return buildEvidenceBundle({
    scenario: subject,
    registryDigest: `sha256:${'a'.repeat(64)}`,
    execution,
  });
}

describe('explicit regression promotion gate', () => {
  it('builds deterministic minimal seeds only for confirmed repeatable product failures', async () => {
    const bundle = await bundleFor();
    const first = buildRegressionSeed(bundle, { confirmed: true, rootDir });
    const second = buildRegressionSeed(structuredClone(bundle), { confirmed: true, rootDir });

    expect(first).toEqual(second);
    expect(first.schema).toBe('chrome-cdp-ex.validation-regression.v1');
    expect(first.classification).toBe('product');
    expect(first.fingerprint).toBe(bundle.fingerprint);
    expect(first.sourceBundleDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first).not.toHaveProperty('attempts');
    expect(JSON.stringify(first)).not.toContain('durationMs');
  });

  it('requires the exact confirmation', async () => {
    const bundle = await bundleFor();
    expect(() => buildRegressionSeed(bundle, { confirmed: false, rootDir })).toThrow('confirm-product-regression');
    expect(() => buildRegressionSeed(bundle, { rootDir })).toThrow('confirm-product-regression');
  });

  it.each([
    ['pass', async () => bundleFor(scenario(), [processResult({ status: 0, stdout: 'ready', stderr: '' })]), 'failed product'],
    ['flake', async () => bundleFor(scenario(), [processResult(), processResult({ status: 0, stdout: 'ready', stderr: '' })]), 'failed product'],
    ['environment', async () => bundleFor(scenario(), [processResult({ spawnError: 'ENOSPC' }), processResult({ spawnError: 'ENOSPC' })]), 'classification'],
    ['scenario', async () => bundleFor(scenario({ classificationHints: ['scenario'] })), 'classification'],
    ['ambiguous single failure', async () => bundleFor(scenario({ risk: { ...scenario().risk, maxAttempts: 1 } }), [processResult()]), 'repeatable'],
    ['duplicate only', async () => { const value = structuredClone(await bundleFor()); value.duplicateOf = 'prior.json'; return value; }, 'duplicate'],
    ['tampered scenario', async () => { const value = structuredClone(await bundleFor()); value.scenario.title = 'tampered'; return value; }, 'scenarioDigest'],
    ['fingerprint mismatch', async () => { const value = structuredClone(await bundleFor()); value.fingerprint = `sha256:${'b'.repeat(64)}`; return value; }, 'fingerprint'],
    ['secret-bearing', async () => { const value = structuredClone(await bundleFor()); value.attempts[0].stderr.preview = 'Bearer raw-secret'; return value; }, 'secret'],
    ['token-header-bearing', async () => { const value = structuredClone(await bundleFor()); value.attempts[0].stderr.preview = 'X-GitHub-Token: raw-secret'; return value; }, 'secret'],
    ['prefixed-token-bearing', async () => { const value = structuredClone(await bundleFor()); value.attempts[0].stderr.preview = 'Error: githubToken=raw-secret'; return value; }, 'secret'],
    ['qualified-token-bearing', async () => { const value = structuredClone(await bundleFor()); value.attempts[0].stderr.preview = 'process.env.GITHUB_TOKEN=raw-secret'; return value; }, 'secret'],
    ['quoted-token-bearing', async () => { const value = structuredClone(await bundleFor()); value.attempts[0].stderr.preview = 'Error: clientSecret="alpha,beta;gamma#delta"'; return value; }, 'secret'],
    ['unterminated-quoted-token-bearing', async () => { const value = structuredClone(await bundleFor()); value.attempts[0].stderr.preview = 'Error: clientSecret="alpha,beta;UNTERMINATED_REMAINDER'; return value; }, 'secret'],
    ['split-cli-token-bearing', async () => { const value = structuredClone(await bundleFor()); value.attempts[0].stderr.preview = 'cmd --authorization Bearer TOPSECRET'; return value; }, 'secret'],
    ['redacted-prefix-suffix-bearing', async () => { const value = structuredClone(await bundleFor()); value.attempts[0].stderr.preview = 'password=<redacted>TOPSECRET'; return value; }, 'secret'],
    ['redacted-prefix-delimiter-suffix-bearing', async () => { const value = structuredClone(await bundleFor()); value.attempts[0].stderr.preview = 'password=<redacted>,TOPSECRET'; return value; }, 'secret'],
    ['redacted-query-prefix-suffix-bearing', async () => { const value = structuredClone(await bundleFor()); value.attempts[0].stderr.preview = '/?token=<redacted>TOPSECRET&safe=yes'; return value; }, 'secret'],
  ])('rejects %s evidence', async (_label, build, message) => {
    const bundle = await build();
    expect(() => buildRegressionSeed(bundle, { confirmed: true, rootDir })).toThrow(message);
  });

  it('writes only the explicit in-root path, mode 0600, with exclusive create', async () => {
    const bundle = await bundleFor();
    const seed = buildRegressionSeed(bundle, { confirmed: true, rootDir });
    const allowedRoot = tempDir();
    const outPath = join(allowedRoot, 'seed.json');
    const written = writeRegressionSeed(outPath, seed, { allowedRoot });

    expect(written).toBe(outPath);
    if (process.platform !== 'win32') expect(statSync(outPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(outPath, 'utf8'))).toEqual(seed);
    expect(() => writeRegressionSeed(outPath, seed, { allowedRoot })).toThrow(/exists|EEXIST/);
  });

  it('rejects path escape and preserves an existing output', async () => {
    const seed = buildRegressionSeed(await bundleFor(), { confirmed: true, rootDir });
    const allowedRoot = tempDir();
    const existing = join(allowedRoot, 'existing.json');
    writeFileSync(existing, 'keep', { mode: 0o600 });

    expect(() => writeRegressionSeed(join(allowedRoot, '..', 'escape.json'), seed, { allowedRoot })).toThrow('escape');
    expect(() => writeRegressionSeed(existing, seed, { allowedRoot })).toThrow(/exists|EEXIST/);
    expect(readFileSync(existing, 'utf8')).toBe('keep');
  });

  it.skipIf(process.platform === 'win32')('rejects a symlinked promotion parent that resolves outside the allowed root', async () => {
    const seed = buildRegressionSeed(await bundleFor(), { confirmed: true, rootDir });
    const allowedRoot = tempDir();
    const outsideRoot = tempDir();
    symlinkSync(outsideRoot, join(allowedRoot, 'linked-outside'));
    expect(() => writeRegressionSeed(join(allowedRoot, 'linked-outside', 'seed.json'), seed, { allowedRoot }))
      .toThrow(/escape|outside|symlink/);
  });
});
