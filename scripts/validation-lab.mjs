#!/usr/bin/env node

import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir, userInfo } from 'os';
import { isAbsolute, resolve } from 'path';
import { fileURLToPath } from 'url';

import {
  buildEvidenceBundle,
  buildRegressionSeed,
  executeScenario,
  planValidationRun,
  replayEvidenceBundle,
  validateScenarioRegistry,
  writeEvidenceBundle,
  writeRegressionSeed,
} from './lib/validation-lab.mjs';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const USAGE = `Usage:
  node scripts/validation-lab.mjs run --registry <registry.json> --out-dir <dir> [--scenario <id>...] [--allow-live]
  node scripts/validation-lab.mjs replay --bundle <bundle.json> --out-dir <dir> [--registry <registry.json>] [--allow-live]
  node scripts/validation-lab.mjs promote --bundle <bundle.json> --out <seed.json> [--registry <registry.json>] --confirm-product-regression`;

function requiredValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

export function parseValidationArgs(argv) {
  const command = argv[0];
  if (!['run', 'replay', 'promote'].includes(command)) throw new Error(`${USAGE}\n--out-dir is required for run and replay`);
  const options = { command, scenarios: [], allowLive: false, confirmProductRegression: false };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--allow-live') options.allowLive = true;
    else if (arg === '--confirm-product-regression') options.confirmProductRegression = true;
    else if (['--registry', '--scenario', '--out-dir', '--bundle', '--out'].includes(arg)) {
      const value = requiredValue(argv, index, arg);
      index += 1;
      if (arg === '--scenario') options.scenarios.push(value);
      else options[arg.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())] = value;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function absoluteInput(path, label) {
  if (typeof path !== 'string' || path === '') throw new Error(`${label} is required`);
  return isAbsolute(path) ? path : resolve(rootDir, path);
}

async function runCommand(options) {
  const registryPath = absoluteInput(options.registry, '--registry');
  const outDir = absoluteInput(options.outDir, '--out-dir');
  const registry = validateScenarioRegistry(JSON.parse(readFileSync(registryPath, 'utf8')), { rootDir });
  const plan = planValidationRun(registry, options.scenarios.length ? { ids: options.scenarios } : { mode: 'default' }, {
    maxRiskUnits: 20,
    maxDurationMs: 600_000,
    maxOutputBytes: 2_000_000,
    maxScenarios: 20,
    allowLive: options.allowLive,
  });
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  let failed = false;
  for (const scenario of plan.selected) {
    const sandboxDir = mkdtempSync(resolve(tmpdir(), `chrome-cdp-validation-${scenario.id}-`));
    try {
      const execution = await executeScenario(scenario, { rootDir, sandboxDir });
      const bundle = buildEvidenceBundle({
        scenario,
        registryDigest: plan.registryDigest,
        execution,
        redactionContext: {
          homeDirs: [sandboxDir, userInfo().homedir],
          tempDirs: [sandboxDir, tmpdir()],
          paths: [rootDir],
        },
      });
      const written = writeEvidenceBundle(outDir, bundle, { rootDir, registry });
      console.log(JSON.stringify({
        scenario: scenario.id,
        ok: execution.ok,
        evidence: written.path,
        duplicate: written.duplicate,
        duplicateOf: written.duplicateOf || null,
      }));
      if (!execution.ok) failed = true;
    } finally {
      rmSync(sandboxDir, { recursive: true, force: true });
    }
  }
  return failed ? 1 : 0;
}

async function replayCommand(options) {
  const bundlePath = absoluteInput(options.bundle, '--bundle');
  const outDir = absoluteInput(options.outDir, '--out-dir');
  const sourceBundle = JSON.parse(readFileSync(bundlePath, 'utf8'));
  const registryPath = absoluteInput(options.registry || 'validation/scenarios.v1.json', '--registry');
  const registry = validateScenarioRegistry(JSON.parse(readFileSync(registryPath, 'utf8')), { rootDir });
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const sandboxDir = mkdtempSync(resolve(tmpdir(), `chrome-cdp-validation-replay-${sourceBundle.scenario?.id || 'unknown'}-`));
  try {
    const replayed = await replayEvidenceBundle(sourceBundle, {
      rootDir,
      sandboxDir,
      allowLive: options.allowLive,
      registry,
      redactionContext: {
        homeDirs: [sandboxDir, userInfo().homedir],
        tempDirs: [sandboxDir, tmpdir()],
        paths: [rootDir],
      },
    });
    const written = writeEvidenceBundle(outDir, replayed.bundle, { rootDir, registry });
    console.log(JSON.stringify({
      scenario: replayed.bundle.scenario.id,
      ok: replayed.execution.ok,
      evidence: written.path,
      duplicate: written.duplicate,
      duplicateOf: written.duplicateOf || null,
    }));
    return replayed.execution.ok ? 0 : 1;
  } finally {
    rmSync(sandboxDir, { recursive: true, force: true });
  }
}

function promoteCommand(options) {
  const bundlePath = absoluteInput(options.bundle, '--bundle');
  const outPath = absoluteInput(options.out, '--out');
  const allowedRoot = resolve(rootDir, 'validation/regressions');
  const bundle = JSON.parse(readFileSync(bundlePath, 'utf8'));
  const registryPath = absoluteInput(options.registry || 'validation/scenarios.v1.json', '--registry');
  const registry = validateScenarioRegistry(JSON.parse(readFileSync(registryPath, 'utf8')), { rootDir });
  const seed = buildRegressionSeed(bundle, {
    confirmed: options.confirmProductRegression,
    rootDir,
    registry,
  });
  const written = writeRegressionSeed(outPath, seed, { allowedRoot });
  console.log(JSON.stringify({ promoted: written, fingerprint: seed.fingerprint }));
  return 0;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseValidationArgs(argv);
  if (options.command === 'run') return runCommand(options);
  if (options.command === 'replay') return replayCommand(options);
  if (options.command === 'promote') return promoteCommand(options);
  throw new Error(`unknown command: ${options.command}`);
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  main().then(status => {
    process.exitCode = status;
  }).catch(error => {
    console.error(`Validation Lab: ${error.message}`);
    process.exitCode = 1;
  });
}
