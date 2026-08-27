import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

import {
  buildValidationSourceDigest,
  planValidationRun,
  validateScenarioRegistry,
} from '../scripts/lib/validation-lab.mjs';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const registryPath = join(rootDir, 'validation/scenarios.v1.json');

function scenario(overrides = {}) {
  return {
    id: 'fixture-pass',
    title: 'Fixture pass',
    owner: 'maintainers',
    tags: ['default', 'contract'],
    runner: {
      kind: 'node',
      entrypoint: 'scripts/check-docs-contract.mjs',
      args: [],
    },
    expect: { exitCodes: [0] },
    risk: {
      units: 1,
      timeoutMs: 10_000,
      maxOutputBytes: 65_536,
      network: 'none',
      browser: 'none',
      mutation: 'none',
      maxAttempts: 1,
    },
    ...overrides,
  };
}

function registry(scenarios = [scenario()]) {
  return {
    schema: 'chrome-cdp-ex.validation-registry.v1',
    scenarios,
  };
}

function budget(overrides = {}) {
  return {
    maxRiskUnits: 10,
    maxDurationMs: 60_000,
    maxOutputBytes: 200_000,
    maxScenarios: 5,
    allowLive: false,
    ...overrides,
  };
}

describe('validation lab registry contract', () => {
  it('ships parseable versioned schemas and a safe canonical registry', () => {
    for (const name of ['scenario.v1.json', 'evidence.v1.json']) {
      const document = JSON.parse(readFileSync(join(rootDir, 'validation/schemas', name), 'utf8'));
      expect(document.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
      expect(document.$id).toMatch(/^https:\/\/github\.com\/EndeavorYen\/chrome-cdp-ex\//);
      expect(document.additionalProperties).toBe(false);
      if (name === 'evidence.v1.json') {
        expect(document.required).toEqual(expect.arrayContaining([
          'ok', 'attempts', 'classificationConfidence', 'classificationReasons', 'duplicateOf', 'redactionCounts',
        ]));
        expect(document.$defs.attempt.additionalProperties).toBe(false);
        expect(document.$defs.stream.properties.digestScope.const).toBe('redacted-preview');
      }
    }

    const actual = validateScenarioRegistry(JSON.parse(readFileSync(registryPath, 'utf8')), { rootDir });
    expect(actual.schema).toBe('chrome-cdp-ex.validation-registry.v1');
    expect(actual.scenarios.map(entry => entry.id)).toEqual([
      'controlled-failure',
      'disposable-live-boundary',
      'docs-contract',
      'host-validation',
      'phase4-core-slices',
      'phase5-supervisor',
      'phase6-convergence',
      'phase7-runtime-v3',
      'public-contracts',
    ]);
    expect(actual.scenarios.filter(entry => entry.tags.includes('default')).every(entry =>
      entry.risk.browser === 'none' && entry.risk.network === 'none')).toBe(true);
    expect(Object.isFrozen(actual)).toBe(true);
    expect(Object.isFrozen(actual.scenarios[0])).toBe(true);
    for (const entry of actual.scenarios) {
      const expected = buildValidationSourceDigest({ rootDir, entrypoint: entry.runner.entrypoint });
      expect(entry.runner.sourceDigest).toBe(expected);
    }
  });

  it('rejects a supplied runner digest that does not match current source', () => {
    const input = registry();
    input.scenarios[0].runner.sourceDigest = `sha256:${'0'.repeat(64)}`;
    expect(() => validateScenarioRegistry(input, { rootDir })).toThrow(/runner\.sourceDigest.*current source/);
  });

  it('binds Phase 6 evidence to catalog, MCP, generated docs, domains, runner, and runtime inputs', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'chrome-cdp-phase6-source-'));
    const files = [
      'package.json',
      'package-lock.json',
      'README.md',
      'docs/reference.md',
      'docs/contracts/v2.16.0/runtime-dispatch.v1.json',
      'docs/contracts/v2.16.0/package-entries.v1.json',
      'docs/contracts/v2.16.0/public-contracts.v1.json',
      'skills/chrome-cdp-ex/references/commands.md',
      'scripts/candidate-identity.mjs',
      'scripts/benchmark-run-lock.mjs',
      'scripts/lib/validation-lab.mjs',
      'scripts/validation-lab.mjs',
      'scripts/validation-live-boundary.mjs',
      'scripts/validation-phase5-supervisor.mjs',
      'scripts/validation-phase6-convergence.mjs',
      'scripts/smoke-page.html',
      'skills/chrome-cdp-ex/scripts/lib/command-surface.mjs',
      'skills/chrome-cdp-ex/scripts/lib/cdp-domains.mjs',
      'skills/chrome-cdp-ex/scripts/cdp.mjs',
    ];
    try {
      for (const [index, name] of files.entries()) {
        mkdirSync(dirname(join(fixtureRoot, name)), { recursive: true });
        writeFileSync(join(fixtureRoot, name), name === 'package.json'
          ? '{"version":"2.16.0"}\n'
          : `fixture-${index}\n`);
      }
      const options = {
        rootDir: fixtureRoot,
        entrypoint: 'scripts/validation-phase6-convergence.mjs',
      };
      let prior = buildValidationSourceDigest(options);
      for (const name of [
        'skills/chrome-cdp-ex/scripts/lib/command-surface.mjs',
        'skills/chrome-cdp-ex/scripts/lib/cdp-domains.mjs',
        'skills/chrome-cdp-ex/scripts/cdp.mjs',
        'README.md',
        'docs/reference.md',
        'docs/contracts/v2.16.0/runtime-dispatch.v1.json',
        'docs/contracts/v2.16.0/package-entries.v1.json',
        'docs/contracts/v2.16.0/public-contracts.v1.json',
        'skills/chrome-cdp-ex/references/commands.md',
        'scripts/validation-phase5-supervisor.mjs',
        'scripts/validation-phase6-convergence.mjs',
      ]) {
        appendFileSync(join(fixtureRoot, name), `mutated-${name}\n`);
        const next = buildValidationSourceDigest(options);
        expect(next, name).not.toBe(prior);
        prior = next;
      }
      rmSync(join(fixtureRoot, 'skills/chrome-cdp-ex/references/commands.md'));
      expect(() => buildValidationSourceDigest(options)).toThrow(/required source/);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it.each([
    ['wrong registry schema', registry(), value => { value.schema = 'v2'; }, 'registry.schema'],
    ['duplicate id', registry([scenario(), scenario()]), () => {}, 'duplicate scenario id'],
    ['absolute entrypoint', registry(), value => { value.scenarios[0].runner.entrypoint = '/tmp/run.mjs'; }, 'runner.entrypoint'],
    ['path escape', registry(), value => { value.scenarios[0].runner.entrypoint = '../run.mjs'; }, 'runner.entrypoint'],
    ['missing entrypoint', registry(), value => { value.scenarios[0].runner.entrypoint = 'scripts/not-real.mjs'; }, 'runner.entrypoint'],
    ['arbitrary executable', registry(), value => { value.scenarios[0].runner.executable = 'bash'; }, 'runner.executable'],
    ['shell metacharacter', registry(), value => { value.scenarios[0].runner.args = ['ok; rm', 'x']; }, 'runner.args[0]'],
    ['split password argument', registry(), value => { value.scenarios[0].runner.args = ['--password', 'hunter2']; }, 'runner.args[0]'],
    ['split API key argument', registry(), value => { value.scenarios[0].runner.args = ['--api-key', 'abc123']; }, 'runner.args[0]'],
    ['assigned token argument', registry(), value => { value.scenarios[0].runner.args = ['--token=ghp_secret']; }, 'runner.args[0]'],
    ['split cookie argument', registry(), value => { value.scenarios[0].runner.args = ['--cookie', 'sid=TOPSECRET']; }, 'runner.args[0]'],
    ['split authorization argument', registry(), value => { value.scenarios[0].runner.args = ['--authorization', 'Bearer TOPSECRET']; }, 'runner.args[0]'],
    ['split auth argument', registry(), value => { value.scenarios[0].runner.args = ['--auth', 'TOPSECRET']; }, 'runner.args[0]'],
    ['split proxy authorization argument', registry(), value => { value.scenarios[0].runner.args = ['--proxy-authorization', 'Basic TOPSECRET']; }, 'runner.args[0]'],
    ['split session argument', registry(), value => { value.scenarios[0].runner.args = ['--session', 'TOPSECRET']; }, 'runner.args[0]'],
    ['split key argument', registry(), value => { value.scenarios[0].runner.args = ['--key', 'TOPSECRET']; }, 'runner.args[0]'],
    ['unknown network scope', registry(), value => { value.scenarios[0].risk.network = 'internet'; }, 'risk.network'],
    ['personal browser scope', registry(), value => { value.scenarios[0].risk.browser = 'personal'; }, 'risk.browser'],
    ['zero risk units', registry(), value => { value.scenarios[0].risk.units = 0; }, 'risk.units'],
    ['tiny output cap', registry(), value => { value.scenarios[0].risk.maxOutputBytes = 16; }, 'risk.maxOutputBytes'],
    ['fractional attempts', registry(), value => { value.scenarios[0].risk.maxAttempts = 1.5; }, 'risk.maxAttempts'],
    ['unknown field', registry(), value => { value.scenarios[0].surprise = true; }, 'surprise'],
  ])('rejects %s with a path-oriented error', (_label, input, mutate, message) => {
    mutate(input);
    expect(() => validateScenarioRegistry(input, { rootDir })).toThrow(message);
  });

  it('rejects unsafe root paths', () => {
    expect(() => validateScenarioRegistry(registry(), { rootDir: '' })).toThrow('rootDir');
  });

  it.skipIf(process.platform === 'win32')('rejects entrypoint symlinks and symlink escapes after filesystem resolution', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'chrome-cdp-registry-root-'));
    const outsideRoot = mkdtempSync(join(tmpdir(), 'chrome-cdp-registry-outside-'));
    try {
      writeFileSync(join(fixtureRoot, 'inside.mjs'), 'export {};\n');
      writeFileSync(join(outsideRoot, 'outside.mjs'), 'export {};\n');
      symlinkSync(join(outsideRoot, 'outside.mjs'), join(fixtureRoot, 'link.mjs'));
      const input = registry();
      input.scenarios[0].runner.entrypoint = 'link.mjs';
      expect(() => validateScenarioRegistry(input, { rootDir: fixtureRoot })).toThrow(/symlink|outside repository/);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });
});

describe('validation lab risk planner', () => {
  const live = scenario({
    id: 'live',
    tags: ['live'],
    risk: {
      units: 3,
      timeoutMs: 20_000,
      maxOutputBytes: 40_000,
      network: 'loopback',
      browser: 'disposable-local',
      mutation: 'task-created-files',
      maxAttempts: 1,
    },
  });

  it('selects default scenarios deterministically and explains policy skips', () => {
    const canonical = validateScenarioRegistry(registry([
      live,
      scenario({ id: 'z-default' }),
      scenario({ id: 'a-default' }),
      scenario({ id: 'fixture-only', tags: ['fixture-only'] }),
    ]), { rootDir });
    const first = planValidationRun(canonical, { mode: 'default' }, budget());
    const second = planValidationRun(canonical, { mode: 'default' }, budget());

    expect(first).toEqual(second);
    expect(first.selected.map(entry => entry.id)).toEqual(['a-default', 'z-default']);
    expect(first.skipped).toEqual([
      { id: 'fixture-only', reason: 'not tagged default' },
      { id: 'live', reason: 'not tagged default' },
    ]);
    expect(first.totals).toEqual({
      scenarios: 2,
      riskUnits: 2,
      durationMs: 20_000,
      outputBytes: 131_072,
    });
  });

  it('requires explicit authorization before selecting a live scenario', () => {
    const canonical = validateScenarioRegistry(registry([live]), { rootDir });
    expect(() => planValidationRun(canonical, { ids: ['live'] }, budget()))
      .toThrow('live requires allowLive');
    expect(planValidationRun(canonical, { ids: ['live'] }, budget({ allowLive: true })).selected)
      .toHaveLength(1);
  });

  it('keeps the shipped Phase 4 slice proof live-only and explicitly authorized', () => {
    const canonical = validateScenarioRegistry(JSON.parse(readFileSync(registryPath, 'utf8')), { rootDir });
    const phase4 = canonical.scenarios.find(entry => entry.id === 'phase4-core-slices');
    expect(phase4.tags).toEqual(['live', 'phase4']);
    expect(phase4.risk).toMatchObject({
      network: 'loopback',
      browser: 'disposable-local',
      mutation: 'task-created-files',
      maxAttempts: 1,
    });
    expect(() => planValidationRun(canonical, { ids: ['phase4-core-slices'] }, budget({
      maxRiskUnits: 20,
      maxDurationMs: 300_000,
      maxOutputBytes: 300_000,
    }))).toThrow('live requires allowLive');
    expect(planValidationRun(canonical, { ids: ['phase4-core-slices'] }, budget({
      maxRiskUnits: 20,
      maxDurationMs: 300_000,
      maxOutputBytes: 300_000,
      allowLive: true,
    })).selected).toHaveLength(1);
  });

  it('keeps the shipped Phase 5 supervisor proof live-only and explicitly authorized', () => {
    const canonical = validateScenarioRegistry(JSON.parse(readFileSync(registryPath, 'utf8')), { rootDir });
    const phase5 = canonical.scenarios.find(entry => entry.id === 'phase5-supervisor');
    expect(phase5.tags).toEqual(['live', 'phase5']);
    expect(phase5.risk).toMatchObject({
      network: 'loopback',
      browser: 'disposable-local',
      mutation: 'task-created-files',
      maxAttempts: 1,
    });
    const limits = {
      maxRiskUnits: 20,
      maxDurationMs: 360_000,
      maxOutputBytes: 300_000,
    };
    expect(() => planValidationRun(canonical, { ids: ['phase5-supervisor'] }, budget(limits)))
      .toThrow('live requires allowLive');
    expect(planValidationRun(canonical, { ids: ['phase5-supervisor'] }, budget({
      ...limits,
      allowLive: true,
    })).selected).toHaveLength(1);
  });

  it('keeps the shipped Phase 6 convergence proof live-only and explicitly authorized', () => {
    const canonical = validateScenarioRegistry(JSON.parse(readFileSync(registryPath, 'utf8')), { rootDir });
    const phase6 = canonical.scenarios.find(entry => entry.id === 'phase6-convergence');
    expect(phase6.tags).toEqual(['live', 'phase6']);
    expect(phase6.risk).toMatchObject({
      network: 'loopback',
      browser: 'disposable-local',
      mutation: 'task-created-files',
      maxAttempts: 1,
    });
    const limits = {
      maxRiskUnits: 20,
      maxDurationMs: 360_000,
      maxOutputBytes: 300_000,
    };
    expect(() => planValidationRun(canonical, { ids: ['phase6-convergence'] }, budget(limits)))
      .toThrow('live requires allowLive');
    expect(planValidationRun(canonical, { ids: ['phase6-convergence'] }, budget({
      ...limits,
      allowLive: true,
    })).selected).toHaveLength(1);
  });

  it('keeps the shipped Phase 7 Runtime v3 proof live-only, one-attempt, and explicitly authorized', () => {
    const canonical = validateScenarioRegistry(JSON.parse(readFileSync(registryPath, 'utf8')), { rootDir });
    const phase7 = canonical.scenarios.find(entry => entry.id === 'phase7-runtime-v3');
    expect(phase7.tags).toEqual(['live', 'phase7']);
    expect(phase7.runner.entrypoint).toBe('scripts/validation-phase7-runtime-v3.mjs');
    expect(phase7.risk).toEqual({
      units: 20,
      timeoutMs: 600_000,
      maxOutputBytes: 262_144,
      network: 'loopback',
      browser: 'disposable-local',
      mutation: 'task-created-files',
      maxAttempts: 1,
    });
    const limits = {
      maxRiskUnits: 20,
      maxDurationMs: 600_000,
      maxOutputBytes: 300_000,
    };
    expect(() => planValidationRun(canonical, { ids: ['phase7-runtime-v3'] }, budget(limits)))
      .toThrow('live requires allowLive');
    expect(planValidationRun(canonical, { ids: ['phase7-runtime-v3'] }, budget({
      ...limits,
      allowLive: true,
    })).selected).toHaveLength(1);
  });

  it.each([
    ['risk units', { maxRiskUnits: 2 }, 'maxRiskUnits'],
    ['duration', { maxDurationMs: 19_999 }, 'maxDurationMs'],
    ['output', { maxOutputBytes: 39_999 }, 'maxOutputBytes'],
    ['scenario count', { maxScenarios: 0 }, 'maxScenarios'],
  ])('rejects explicit selection over the %s budget', (_label, limits, message) => {
    const canonical = validateScenarioRegistry(registry([live]), { rootDir });
    expect(() => planValidationRun(canonical, { ids: ['live'] }, budget({ allowLive: true, ...limits })))
      .toThrow(message);
  });

  it('rejects missing ids and malformed positive-integer budgets', () => {
    const canonical = validateScenarioRegistry(registry(), { rootDir });
    expect(() => planValidationRun(canonical, { ids: ['missing'] }, budget())).toThrow('unknown scenario');
    expect(() => planValidationRun(canonical, { mode: 'default' }, budget({ maxRiskUnits: 1.5 })))
      .toThrow('maxRiskUnits');
  });
});
