import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { fileURLToPath } from 'url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  boundedStream,
  buildEvidenceBundle,
  buildValidationSourceDigest,
  executeScenario,
  findDuplicateEvidence,
  replayEvidenceBundle,
  runBoundedProcess,
  validateScenarioRegistry,
  verifyEvidenceBundle,
  writeEvidenceBundle,
} from '../scripts/lib/validation-lab.mjs';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const cliPath = join(rootDir, 'scripts/validation-lab.mjs');
const registryPath = join(rootDir, 'validation/scenarios.v1.json');
const tempPaths = [];
const fixtureEntrypoint = 'validation/fixtures/controlled-failure.mjs';
const fixtureSourceDigest = buildValidationSourceDigest({ rootDir, entrypoint: fixtureEntrypoint });

afterEach(() => {
  for (const path of tempPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function tempDir() {
  const path = mkdtempSync(join(tmpdir(), 'chrome-cdp-validation-test-'));
  tempPaths.push(path);
  return path;
}

function seedSourceIdentityFixture(root) {
  for (const path of [
    'package.json',
    'package-lock.json',
    'README.md',
    'docs/reference.md',
    'scripts/source-fixture.mjs',
    'skills/chrome-cdp-ex/references/commands.md',
    'skills/chrome-cdp-ex/scripts/source-fixture.mjs',
  ]) {
    const target = join(root, path);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, `source identity fixture: ${path}\n`);
  }
}

function scenario(overrides = {}) {
  return {
    id: 'fixture',
    title: 'Fixture',
    owner: 'maintainers',
    tags: ['fixture-only'],
    runner: { kind: 'node', entrypoint: fixtureEntrypoint, args: [], sourceDigest: fixtureSourceDigest },
    expect: { exitCodes: [0], stdoutIncludes: ['expected'] },
    risk: {
      units: 1,
      timeoutMs: 1000,
      maxOutputBytes: 128,
      network: 'none',
      browser: 'none',
      mutation: 'none',
      maxAttempts: 1,
    },
    ...overrides,
  };
}

function result(overrides = {}) {
  return {
    status: 0,
    signal: null,
    stdout: 'expected output',
    stderr: '',
    timedOut: false,
    outputOverflow: false,
    spawnError: null,
    cleanupError: null,
    durationMs: 4,
    ...overrides,
  };
}

describe('bounded validation scenario runner', () => {
  it('settles after bounded TERM/KILL cleanup even when a child never closes', async () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.exitCode = null;
    child.signalCode = null;
    const signals = [];
    child.kill = signal => {
      signals.push(signal);
      child.killed = true;
      return true;
    };
    const observed = await runBoundedProcess({
      executable: process.execPath,
      args: [],
      cwd: rootDir,
      env: {},
      timeoutMs: 5,
      maxOutputBytes: 128,
      killGraceMs: 5,
      spawnImpl: () => child,
    });
    expect(observed.timedOut).toBe(true);
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(observed.cleanupError).toContain('did not close');
  });

  it('preserves accurate head/tail metadata for real streaming overflow', async () => {
    const observed = await runBoundedProcess({
      executable: process.execPath,
      args: ['-e', "process.stdout.write('HEAD-' + 'x'.repeat(10000) + '-TAIL')"],
      cwd: rootDir,
      env: {},
      timeoutMs: 1000,
      maxOutputBytes: 128,
    });
    expect(observed.outputOverflow).toBe(true);
    expect(observed.stdout).toMatchObject({ truncated: true });
    expect(observed.stdout.bytes).toBeGreaterThan(10000);
    expect(observed.stdout.omittedBytes).toBeGreaterThan(0);
    expect(observed.stdout.preview).toContain('HEAD-');
    expect(observed.stdout.preview).toContain('-TAIL');
    expect(Buffer.byteLength(observed.stdout.preview)).toBeLessThanOrEqual(128);
  });

  it.each([
    ['pass', result(), true, null],
    ['non-zero exit', result({ status: 7 }), false, 'exitCodes'],
    ['signal', result({ status: null, signal: 'SIGTERM' }), false, 'signal'],
    ['spawn error', result({ status: null, spawnError: 'ENOENT' }), false, 'spawn'],
    ['timeout', result({ status: null, signal: 'SIGTERM', timedOut: true }), false, 'timeout'],
    ['output overflow', result({ outputOverflow: true }), false, 'output'],
    ['stdout assertion', result({ stdout: 'wrong' }), false, 'stdoutIncludes[0]'],
    ['stderr assertion', result({ stderr: 'wrong' }), false, 'stderrIncludes[0]'],
  ])('records %s deterministically', async (_label, processResult, ok, failedCheck) => {
    const subject = failedCheck === 'stderrIncludes[0]'
      ? scenario({ expect: { exitCodes: [0], stderrIncludes: ['needle'] } })
      : scenario();
    const execution = await executeScenario(subject, {
      rootDir,
      sandboxDir: tempDir(),
      runProcess: async invocation => {
        expect(invocation.executable).toBe(process.execPath);
        expect(invocation.args).toEqual([join(rootDir, subject.runner.entrypoint), ...subject.runner.args]);
        expect(invocation.shell).toBe(false);
        expect(invocation.cwd).toBe(rootDir);
        expect(invocation.env).not.toHaveProperty('GITHUB_TOKEN');
        return processResult;
      },
    });

    expect(execution.ok).toBe(ok);
    expect(execution.attempts).toHaveLength(1);
    expect(execution.attempts[0].failedCheck).toBe(failedCheck);
  });

  it('runs no more than the declared attempt bound and stops on pass', async () => {
    let calls = 0;
    const execution = await executeScenario(scenario({
      risk: { ...scenario().risk, maxAttempts: 3 },
    }), {
      rootDir,
      sandboxDir: tempDir(),
      runProcess: async () => (++calls === 1 ? result({ status: 7 }) : result()),
    });
    expect(calls).toBe(2);
    expect(execution.ok).toBe(true);
    expect(execution.attempts.map(attempt => attempt.ok)).toEqual([false, true]);
  });

  it('uses production runtime mode only for explicitly authorized disposable-browser scenarios', async () => {
    const liveScenario = scenario({
      risk: {
        ...scenario().risk,
        network: 'loopback',
        browser: 'disposable-local',
        mutation: 'task-created-files',
      },
    });
    let observedEnv;
    await executeScenario(liveScenario, {
      rootDir,
      sandboxDir: tempDir(),
      runProcess: async invocation => {
        observedEnv = invocation.env;
        expect(invocation.killGraceMs).toBeGreaterThan(1500);
        return result();
      },
    });
    expect(observedEnv.NODE_ENV).toBe('production');
    expect(observedEnv.HOME).toContain('chrome-cdp-validation-test-');
  });

  it('reports cleanup errors separately without erasing the observation', async () => {
    const execution = await executeScenario(scenario(), {
      rootDir,
      sandboxDir: tempDir(),
      runProcess: async () => result({ cleanupError: 'kill ESRCH' }),
    });
    expect(execution.ok).toBe(false);
    expect(execution.attempts[0]).toMatchObject({ failedPhase: 'cleanup', failedCheck: 'cleanup', cleanupError: 'kill ESRCH' });
    expect(execution.attempts[0].stdout.preview).toContain('expected');
  });
});

describe('validation evidence writer', () => {
  async function fixtureBundle() {
    const subject = scenario();
    const execution = await executeScenario(subject, {
      rootDir,
      sandboxDir: tempDir(),
      runProcess: async () => result({
        status: 23,
        stdout: 'Authorization: Bearer fixture-token-do-not-keep',
        stderr: 'failure /Users/example/private port=49321',
      }),
    });
    return buildEvidenceBundle({
      scenario: subject,
      registryDigest: `sha256:${'b'.repeat(64)}`,
      execution,
      redactionContext: { homeDir: '/Users/example', ports: [49321] },
    });
  }

  it('builds a bounded redacted bundle with exact replay argv', async () => {
    const bundle = await fixtureBundle();
    const text = JSON.stringify(bundle);
    expect(bundle.schema).toBe('chrome-cdp-ex.validation-evidence.v1');
    expect(bundle.redacted).toBe(true);
    expect(bundle.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(bundle.replay).toEqual([
      'node', 'scripts/validation-lab.mjs', 'replay', '--bundle', '<bundle>', '--out-dir', '<out-dir>',
    ]);
    expect(text).not.toContain('fixture-token-do-not-keep');
    expect(text).not.toContain('/Users/example');
    expect(text).not.toContain('49321');
    expect(bundle.attempts[0].stdout.digestScope).toBe('redacted-preview');
    expect(bundle.attempts[0].stdout.sha256).not.toBe(
      `sha256:${createHash('sha256').update('Authorization: Bearer fixture-token-do-not-keep').digest('hex')}`,
    );
  });

  it('redacts credentials split by an omitted boundary and re-applies the byte cap', async () => {
    const subject = scenario({
      risk: { ...scenario().risk, maxOutputBytes: 96 },
      expect: { exitCodes: [23] },
    });
    const token = 'SECRET'.repeat(200);
    const execution = await executeScenario(subject, {
      rootDir,
      sandboxDir: tempDir(),
      runProcess: async () => result({
        status: 23,
        outputOverflow: true,
        stdout: `Authorization: Bearer ${token}`,
      }),
    });
    const bundle = buildEvidenceBundle({
      scenario: subject,
      registryDigest: `sha256:${'b'.repeat(64)}`,
      execution,
    });
    expect(bundle.attempts[0].stdout.preview).not.toContain('SECRET');
    expect(Buffer.byteLength(bundle.attempts[0].stdout.preview)).toBeLessThanOrEqual(96);
  });

  it('suppresses both boundary lines when a credential prefix is itself split', async () => {
    const subject = scenario({
      risk: { ...scenario().risk, maxOutputBytes: 96 },
      expect: { exitCodes: [23] },
    });
    const execution = await executeScenario(subject, {
      rootDir,
      sandboxDir: tempDir(),
      runProcess: async () => result({
        status: 23,
        outputOverflow: true,
        stdout: `${' '.repeat(17)}Authorization: Bearer ${'SECRET'.repeat(100)}`,
      }),
    });
    const bundle = buildEvidenceBundle({
      scenario: subject,
      registryDigest: `sha256:${'b'.repeat(64)}`,
      execution,
    });
    expect(bundle.attempts[0].stdout.preview).not.toContain('SECRET');
    expect(Buffer.byteLength(bundle.attempts[0].stdout.preview)).toBeLessThanOrEqual(96);
    expect(() => verifyEvidenceBundle(bundle, { rootDir })).not.toThrow();
  });

  it('accounts for every raw byte suppressed at a single-line boundary', async () => {
    const subject = scenario({
      risk: { ...scenario().risk, maxOutputBytes: 96 },
      expect: { exitCodes: [23] },
    });
    const execution = await executeScenario(subject, {
      rootDir,
      sandboxDir: tempDir(),
      runProcess: async () => result({ status: 23, outputOverflow: true, stdout: 'x'.repeat(1000) }),
    });
    const bundle = buildEvidenceBundle({
      scenario: subject,
      registryDigest: `sha256:${'b'.repeat(64)}`,
      execution,
    });
    const stream = bundle.attempts[0].stdout;
    expect(stream.observedBytes).toBe(1000);
    expect(stream.observedOmittedBytes + stream.redactedOmittedBytes).toBe(1000);
    expect(stream.preview).toContain(`<${stream.observedBytes} bytes omitted>`);
    expect(() => verifyEvidenceBundle(bundle, { rootDir })).not.toThrow();
  });

  it('fails closed when a truncated stream lacks structural head/tail provenance', () => {
    const subject = scenario({ risk: { ...scenario().risk, maxOutputBytes: 96 } });
    expect(() => buildEvidenceBundle({
      scenario: subject,
      registryDigest: `sha256:${'b'.repeat(64)}`,
      execution: {
        ok: false,
        attempts: [{
          ...result({ status: 23, outputOverflow: true }),
          ok: false,
          failedPhase: 'execution',
          failedCheck: 'output',
          failureMessage: 'output exceeded 96 bytes',
          stdout: {
            preview: 'Authorization: Be\n<100 bytes omitted>\narer TOPSECRET',
            bytes: 150,
            sha256: `sha256:${'a'.repeat(64)}`,
            truncated: true,
            omittedBytes: 100,
          },
          stderr: boundedStream('', 96),
        }],
      },
    })).toThrow(/head.*tail|structural provenance/);
  });

  it('escapes literal omission-marker text in an untruncated child stream', async () => {
    const subject = scenario({ expect: { exitCodes: [0] } });
    const execution = await executeScenario(subject, {
      rootDir,
      sandboxDir: tempDir(),
      runProcess: async () => result({ stdout: 'before\n<12 bytes omitted>\nafter' }),
    });
    const bundle = buildEvidenceBundle({
      scenario: subject,
      registryDigest: `sha256:${'b'.repeat(64)}`,
      execution,
    });
    expect(bundle.attempts[0].stdout.preview).toContain('<literal omission marker: 12 bytes>');
    expect(() => verifyEvidenceBundle(bundle, { rootDir })).not.toThrow();
  });

  it('keeps the structural omission boundary distinct from literal child markers', async () => {
    const subject = scenario({
      risk: { ...scenario().risk, maxOutputBytes: 96 },
      expect: { exitCodes: [23] },
    });
    const execution = await executeScenario(subject, {
      rootDir,
      sandboxDir: tempDir(),
      runProcess: async () => result({
        status: 23,
        outputOverflow: true,
        stdout: `head\n<31 bytes omitted>\n${'middle'.repeat(100)}\ntail`,
      }),
    });
    const bundle = buildEvidenceBundle({
      scenario: subject,
      registryDigest: `sha256:${'b'.repeat(64)}`,
      execution,
    });
    expect([...bundle.attempts[0].stdout.preview.matchAll(/\n<(\d+) bytes omitted>\n/g)]).toHaveLength(1);
    expect(() => verifyEvidenceBundle(bundle, { rootDir })).not.toThrow();
  });

  it('keeps post-redaction expansion within the declared byte cap', async () => {
    const subject = scenario({
      risk: { ...scenario().risk, maxOutputBytes: 96 },
      expect: { exitCodes: [0] },
    });
    const execution = await executeScenario(subject, {
      rootDir,
      sandboxDir: tempDir(),
      runProcess: async () => result({ stdout: '?token=x&'.repeat(10) }),
    });
    const bundle = buildEvidenceBundle({
      scenario: subject,
      registryDigest: `sha256:${'b'.repeat(64)}`,
      execution,
    });
    expect(Buffer.byteLength(bundle.attempts[0].stdout.preview)).toBeLessThanOrEqual(96);
    expect(bundle.attempts[0].stdout.preview).not.toContain('token=x');
  });

  it('does not trust a redaction placeholder that prefixes secret material', async () => {
    const subject = scenario({ expect: { exitCodes: [0] } });
    const execution = await executeScenario(subject, {
      rootDir,
      sandboxDir: tempDir(),
      runProcess: async () => result({ stdout: 'password=<redacted>,TOPSECRET' }),
    });
    const bundle = buildEvidenceBundle({
      scenario: subject,
      registryDigest: `sha256:${'b'.repeat(64)}`,
      execution,
    });
    expect(bundle.attempts[0].stdout.preview).toBe('password=<redacted>');
    expect(() => verifyEvidenceBundle(bundle, { rootDir })).not.toThrow();

    const tampered = structuredClone(bundle);
    tampered.attempts[0].stdout.preview = 'password=<redacted>TOPSECRET';
    expect(() => verifyEvidenceBundle(tampered, { rootDir })).toThrow('secret-bearing');
  });

  it('builds and verifies a redacted URL while preserving safe query fields', async () => {
    const subject = scenario({ expect: { exitCodes: [0] } });
    const execution = await executeScenario(subject, {
      rootDir,
      sandboxDir: tempDir(),
      runProcess: async () => result({ stdout: 'https://example.test/?token=TOPSECRET&safe=yes' }),
    });
    const bundle = buildEvidenceBundle({
      scenario: subject,
      registryDigest: `sha256:${'b'.repeat(64)}`,
      execution,
    });
    expect(bundle.attempts[0].stdout.preview).toBe('https://example.test/?token=<redacted>&safe=yes');
    expect(() => verifyEvidenceBundle(bundle, { rootDir })).not.toThrow();

    const tampered = structuredClone(bundle);
    tampered.attempts[0].stdout.preview = 'https://example.test/?token=<redacted>TOPSECRET&safe=yes';
    expect(() => verifyEvidenceBundle(tampered, { rootDir })).toThrow('secret-bearing');
  });

  it('writes mode-0600 evidence atomically and treats identical output as a duplicate', async () => {
    const outDir = tempDir();
    const bundle = await fixtureBundle();
    const first = writeEvidenceBundle(outDir, bundle, { rootDir });
    const second = writeEvidenceBundle(outDir, bundle, { rootDir });

    expect(first.duplicate).toBe(false);
    expect(second).toMatchObject({ duplicate: true, path: first.path });
    expect(statSync(first.path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(first.path, 'utf8'))).toEqual(bundle);
    expect(readFileSync(first.path, 'utf8')).toMatch(/\n$/);
  });

  it('never overwrites a different existing bundle or adopts a partial temp file', async () => {
    const outDir = tempDir();
    const bundle = await fixtureBundle();
    const expectedName = `${bundle.scenario.id}-${bundle.fingerprint.slice(7, 23)}.json`;
    const target = join(outDir, expectedName);
    writeFileSync(target, '{"different":true}\n', { mode: 0o600 });
    writeFileSync(join(outDir, `.${expectedName}.partial`), 'partial', { mode: 0o600 });

    expect(() => writeEvidenceBundle(outDir, bundle, { rootDir })).toThrow('different bundle');
    expect(readFileSync(target, 'utf8')).toBe('{"different":true}\n');
  });

  it('does not accept a malformed candidate as duplicate evidence', async () => {
    const outDir = tempDir();
    const bundle = await fixtureBundle();
    writeFileSync(join(outDir, 'malformed.json'), `${JSON.stringify({
      schema: bundle.schema,
      scenario: bundle.scenario,
      scenarioDigest: bundle.scenarioDigest,
      fingerprint: bundle.fingerprint,
      ok: bundle.ok,
    })}\n`, { mode: 0o600 });
    expect(findDuplicateEvidence(outDir, bundle)).toBe(null);
    expect(findDuplicateEvidence(outDir, bundle, { rootDir })).toBe(null);
    expect(writeEvidenceBundle(outDir, bundle, { rootDir })).toMatchObject({ duplicate: false });
  });

  it('requires verification context before the first evidence write', async () => {
    const bundle = await fixtureBundle();
    expect(() => writeEvidenceBundle(tempDir(), bundle)).toThrow(/rootDir|verification context/);
  });

  it('collapses volatile variants but not different checks or pass outcomes', async () => {
    const outDir = tempDir();
    const bundle = await fixtureBundle();
    const first = writeEvidenceBundle(outDir, bundle, { rootDir });
    const volatileVariant = structuredClone(bundle);
    volatileVariant.attempts[0].durationMs = 999;
    expect(findDuplicateEvidence(outDir, volatileVariant, { rootDir })).toMatchObject({ path: first.path });
    expect(writeEvidenceBundle(outDir, volatileVariant, { rootDir })).toMatchObject({
      duplicate: true,
      duplicateOf: expect.stringContaining(first.path.split('/').at(-1)),
    });

    const differentCheck = structuredClone(bundle);
    differentCheck.fingerprint = `sha256:${'c'.repeat(64)}`;
    expect(findDuplicateEvidence(outDir, differentCheck, { rootDir })).toBe(null);
    const passing = structuredClone(bundle);
    passing.ok = true;
    expect(findDuplicateEvidence(outDir, passing, { rootDir })).toBe(null);
  });
});

describe('digest-checked evidence replay', () => {
  it('rejects evidence after its runner source changes', async () => {
    const isolatedRoot = tempDir();
    seedSourceIdentityFixture(isolatedRoot);
    writeFileSync(join(isolatedRoot, 'runner.mjs'), 'console.log("first");\n');
    const raw = scenario({
      runner: { kind: 'node', entrypoint: 'runner.mjs', args: [] },
    });
    const registry = validateScenarioRegistry({
      schema: 'chrome-cdp-ex.validation-registry.v1',
      scenarios: [raw],
    }, { rootDir: isolatedRoot });
    const subject = registry.scenarios[0];
    const execution = await executeScenario(subject, {
      rootDir: isolatedRoot,
      sandboxDir: tempDir(),
      runProcess: async () => result(),
    });
    const bundle = buildEvidenceBundle({
      scenario: subject,
      registryDigest: `sha256:${'d'.repeat(64)}`,
      execution,
    });

    writeFileSync(join(isolatedRoot, 'runner.mjs'), 'console.log("second");\n');
    expect(() => verifyEvidenceBundle(bundle, { rootDir: isolatedRoot }))
      .toThrow(/runner\.sourceDigest.*current source/);
  });

  it('rejects evidence after a shipped runtime dependency changes', async () => {
    const isolatedRoot = tempDir();
    seedSourceIdentityFixture(isolatedRoot);
    const runtimeDir = join(isolatedRoot, 'skills/chrome-cdp-ex/scripts');
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(join(isolatedRoot, 'runner.mjs'), 'console.log("proof");\n');
    writeFileSync(join(runtimeDir, 'runtime.mjs'), 'export const revision = 1;\n');
    const raw = scenario({ runner: { kind: 'node', entrypoint: 'runner.mjs', args: [] } });
    const registry = validateScenarioRegistry({
      schema: 'chrome-cdp-ex.validation-registry.v1',
      scenarios: [raw],
    }, { rootDir: isolatedRoot });
    const subject = registry.scenarios[0];
    const execution = await executeScenario(subject, {
      rootDir: isolatedRoot,
      sandboxDir: tempDir(),
      runProcess: async () => result(),
    });
    const bundle = buildEvidenceBundle({
      scenario: subject,
      registryDigest: `sha256:${'d'.repeat(64)}`,
      execution,
    });

    writeFileSync(join(runtimeDir, 'runtime.mjs'), 'export const revision = 2;\n');
    expect(() => verifyEvidenceBundle(bundle, { rootDir: isolatedRoot }))
      .toThrow(/runner\.sourceDigest.*current source/);
  });

  it('rejects evidence after the live cleanup lock dependency changes', async () => {
    const isolatedRoot = tempDir();
    seedSourceIdentityFixture(isolatedRoot);
    const scriptsDir = join(isolatedRoot, 'scripts');
    mkdirSync(scriptsDir, { recursive: true });
    writeFileSync(join(isolatedRoot, 'runner.mjs'), 'console.log("proof");\n');
    const lockPath = join(scriptsDir, 'benchmark-run-lock.mjs');
    writeFileSync(lockPath, 'export const cleanupRevision = 1;\n');
    const raw = scenario({ runner: { kind: 'node', entrypoint: 'runner.mjs', args: [] } });
    const registry = validateScenarioRegistry({
      schema: 'chrome-cdp-ex.validation-registry.v1',
      scenarios: [raw],
    }, { rootDir: isolatedRoot });
    const subject = registry.scenarios[0];
    const execution = await executeScenario(subject, {
      rootDir: isolatedRoot,
      sandboxDir: tempDir(),
      runProcess: async () => result(),
    });
    const bundle = buildEvidenceBundle({
      scenario: subject,
      registryDigest: `sha256:${'d'.repeat(64)}`,
      execution,
    });

    writeFileSync(lockPath, 'export const cleanupRevision = 2;\n');
    expect(() => verifyEvidenceBundle(bundle, { rootDir: isolatedRoot }))
      .toThrow(/runner\.sourceDigest.*current source/);
  });

  async function failedBundle() {
    const subject = scenario();
    const execution = await executeScenario(subject, {
      rootDir,
      sandboxDir: tempDir(),
      runProcess: async () => result({ status: 23, stdout: 'wrong' }),
    });
    return buildEvidenceBundle({
      scenario: subject,
      registryDigest: `sha256:${'d'.repeat(64)}`,
      execution,
    });
  }

  it('replays the exact embedded argv and reproduces the fingerprint', async () => {
    const bundle = await failedBundle();
    let invocation;
    const replayed = await replayEvidenceBundle(bundle, {
      rootDir,
      sandboxDir: tempDir(),
      allowLive: false,
      runProcess: async value => {
        invocation = value;
        return result({ status: 23, stdout: 'wrong' });
      },
    });
    expect(invocation.args).toEqual([join(rootDir, bundle.scenario.runner.entrypoint), ...bundle.scenario.runner.args]);
    expect(replayed.bundle.fingerprint).toBe(bundle.fingerprint);
  });

  it('records fail-then-pass evidence as a flake rather than a plain pass', async () => {
    const subject = scenario({ risk: { ...scenario().risk, maxAttempts: 2 } });
    let calls = 0;
    const execution = await executeScenario(subject, {
      rootDir,
      sandboxDir: tempDir(),
      runProcess: async () => (++calls === 1 ? result({ status: 23, stdout: 'wrong' }) : result()),
    });
    const bundle = buildEvidenceBundle({
      scenario: subject,
      registryDigest: `sha256:${'d'.repeat(64)}`,
      execution,
    });
    expect(bundle).toMatchObject({ ok: true, classification: 'flake', classificationConfidence: 'high' });
    expect(() => verifyEvidenceBundle(bundle, { rootDir })).not.toThrow();
  });

  it('rejects evidence with attempts after the first pass', async () => {
    const subject = scenario({ risk: { ...scenario().risk, maxAttempts: 3 } });
    let calls = 0;
    const execution = await executeScenario(subject, {
      rootDir,
      sandboxDir: tempDir(),
      runProcess: async () => (++calls === 1 ? result({ status: 23, stdout: 'wrong' }) : result()),
    });
    const bundle = structuredClone(buildEvidenceBundle({
      scenario: subject,
      registryDigest: `sha256:${'d'.repeat(64)}`,
      execution,
    }));
    bundle.attempts.push(structuredClone(bundle.attempts[0]));
    bundle.ok = false;
    expect(() => verifyEvidenceBundle(bundle, { rootDir })).toThrow(/attempt.*after.*pass|sequence/i);
  });

  it.each([
    ['tampered scenario', bundle => { bundle.scenario.runner.args.push('--changed'); }, 'scenarioDigest'],
    ['changed digest', bundle => { bundle.scenarioDigest = `sha256:${'e'.repeat(64)}`; }, 'scenarioDigest'],
    ['missing redaction marker', bundle => { bundle.redacted = false; }, 'redacted'],
    ['wrong schema', bundle => { bundle.schema = 'wrong'; }, 'schema'],
    ['missing complete evidence field', bundle => { delete bundle.ok; }, 'bundle.ok'],
    ['non-canonical replay argv', bundle => { bundle.replay.push('--allow-live'); }, 'bundle.replay'],
    ['impossible stream byte metadata', bundle => {
      bundle.attempts[0].stdout.observedBytes = bundle.scenario.risk.maxOutputBytes + 1;
      bundle.attempts[0].stdout.observedOmittedBytes = 0;
      bundle.attempts[0].stdout.truncated = false;
    }, 'stdout'],
    ['mismatched omitted marker', bundle => {
      bundle.attempts[0].stdout.truncated = true;
      bundle.attempts[0].stdout.redactedOmittedBytes = 9;
    }, 'stdout'],
    ['under-cap observed truncation', bundle => {
      const stream = bundle.attempts[0].stdout;
      stream.preview = '\n<1 bytes omitted>\n';
      stream.previewBytes = Buffer.byteLength(stream.preview);
      stream.observedBytes = 1;
      stream.observedOmittedBytes = 1;
      stream.redactedOmittedBytes = 0;
      stream.truncated = true;
      stream.sha256 = `sha256:${createHash('sha256').update(stream.preview).digest('hex')}`;
    }, 'stdout'],
  ])('rejects %s before execution', async (_label, mutate, message) => {
    const bundle = structuredClone(await failedBundle());
    mutate(bundle);
    expect(() => verifyEvidenceBundle(bundle, { rootDir })).toThrow(message);
  });

  it('rejects live replay without explicit authorization', async () => {
    const subject = scenario({
      risk: {
        ...scenario().risk,
        browser: 'disposable-local',
        network: 'loopback',
        mutation: 'task-created-files',
      },
    });
    const execution = await executeScenario(subject, {
      rootDir,
      sandboxDir: tempDir(),
      runProcess: async () => result({ status: 23, stdout: 'wrong' }),
    });
    const bundle = buildEvidenceBundle({
      scenario: subject,
      registryDigest: `sha256:${'d'.repeat(64)}`,
      execution,
    });
    await expect(replayEvidenceBundle(bundle, {
      rootDir,
      sandboxDir: tempDir(),
      allowLive: false,
      runProcess: async () => result(),
    })).rejects.toThrow('allowLive');
  });
});

describe('validation lab CLI boundaries', () => {
  function run(args) {
    return spawnSync(process.execPath, [cliPath, ...args], { cwd: rootDir, encoding: 'utf8' });
  }

  it.each([
    [[], '--out-dir'],
    [['run', '--registry', registryPath, '--scenario', 'docs-contract'], '--out-dir'],
    [['run', '--registry', registryPath, '--out-dir', '/tmp/x', '--wat'], 'unknown argument'],
    [['run', '--registry', registryPath, '--scenario', 'missing', '--out-dir', '/tmp/x'], 'unknown scenario'],
  ])('rejects invalid invocation %#', (args, message) => {
    const executed = run(args);
    expect(executed.status).not.toBe(0);
    expect(executed.stderr).toContain(message);
  });

  it('refuses a live scenario without explicit authorization before execution', () => {
    const outDir = tempDir();
    const executed = run(['run', '--registry', registryPath, '--scenario', 'disposable-live-boundary', '--out-dir', outDir]);
    expect(executed.status).not.toBe(0);
    expect(executed.stderr).toContain('allowLive');
    expect(readFileSync(registryPath, 'utf8')).toContain('disposable-live-boundary');
  });

  it('writes evidence and exits non-zero when a controlled scenario fails', () => {
    const outDir = tempDir();
    chmodSync(outDir, 0o700);
    const executed = run(['run', '--registry', registryPath, '--scenario', 'controlled-failure', '--out-dir', outDir]);
    expect(executed.status).toBe(1);
    expect(executed.stdout).toContain('controlled-failure');
    const files = spawnSync('find', [outDir, '-maxdepth', '1', '-name', '*.json'], { encoding: 'utf8' })
      .stdout.trim().split('\n').filter(Boolean);
    expect(files).toHaveLength(1);
    const evidence = readFileSync(files[0], 'utf8');
    expect(evidence).not.toContain('fixture-token-do-not-keep');
    expect(evidence).not.toContain('/Users/example');
  });

  it('replays a controlled bundle and reports its duplicate relation', () => {
    const outDir = tempDir();
    const first = run(['run', '--registry', registryPath, '--scenario', 'controlled-failure', '--out-dir', outDir]);
    expect(first.status).toBe(1);
    const bundlePath = JSON.parse(first.stdout.trim()).evidence;
    const replayed = run(['replay', '--bundle', bundlePath, '--out-dir', outDir]);
    expect(replayed.status).toBe(1);
    const summary = JSON.parse(replayed.stdout.trim());
    expect(summary).toMatchObject({ scenario: 'controlled-failure', duplicate: true });
    expect(summary.duplicateOf).toContain(bundlePath.split('/').at(-1));
  });

  it('rejects a self-digested scenario that is not the registry scenario', async () => {
    const outDir = tempDir();
    const first = run(['run', '--registry', registryPath, '--scenario', 'controlled-failure', '--out-dir', outDir]);
    const bundlePath = JSON.parse(first.stdout.trim()).evidence;
    const forged = JSON.parse(readFileSync(bundlePath, 'utf8'));
    forged.scenario.runner.entrypoint = 'scripts/check-docs-contract.mjs';
    const { digestValue } = await import('../scripts/lib/validation-lab.mjs');
    forged.scenarioDigest = digestValue(forged.scenario);
    const forgedPath = join(outDir, 'forged.json');
    writeFileSync(forgedPath, `${JSON.stringify(forged)}\n`, { mode: 0o600 });
    const replayed = run(['replay', '--bundle', forgedPath, '--out-dir', outDir]);
    expect(replayed.status).not.toBe(0);
    expect(replayed.stderr).toMatch(/sourceDigest|registryDigest|scenarioDigest|registry scenario/);
  });

  it('rejects a missing replay bundle', () => {
    const executed = run(['replay', '--bundle', join(tempDir(), 'missing.json'), '--out-dir', tempDir()]);
    expect(executed.status).not.toBe(0);
    expect(executed.stderr).toMatch(/ENOENT|does not exist/);
  });
});
