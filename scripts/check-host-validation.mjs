#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync, statSync } from 'fs';
import { isAbsolute, relative, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import { SUPPORTED_HOSTS } from './setup.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_MANIFEST = resolve(REPO_ROOT, 'docs', 'benchmarks', 'host-validation.v1.json');

const STATUS_VALUES = new Set(['documented', 'setup-smoke', 'live-validated']);
const LIVE_CAPABILITIES = Object.freeze([
  'install',
  'doctor',
  'perceive',
  'act',
  'actionReceipt',
  'sinceAction',
  'report',
]);

function rootPath(rootDir) {
  return rootDir instanceof URL ? fileURLToPath(rootDir) : String(rootDir);
}

function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function staysWithin(rootDir, candidate) {
  const pathFromRoot = relative(rootDir, candidate);
  return pathFromRoot !== '..'
    && !pathFromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    && !isAbsolute(pathFromRoot);
}

export function validateHostValidation(manifest, {
  packageVersion,
  supportedHosts = SUPPORTED_HOSTS,
  rootDir = REPO_ROOT,
} = {}) {
  const errors = [];
  if (manifest?.schema !== 'chrome-cdp-ex.host-validation.v1') {
    errors.push(`Host validation schema must be chrome-cdp-ex.host-validation.v1`);
  }
  if (manifest?.productVersion !== packageVersion) {
    errors.push(`Host validation productVersion ${manifest?.productVersion || 'missing'} does not match package version ${packageVersion}`);
  }
  if (!isIsoDate(manifest?.validatedAt)) {
    errors.push('Host validation validatedAt must be an ISO date (YYYY-MM-DD)');
  }
  if (manifest?.environment?.evidenceScope !== 'historical-candidate'
    || manifest?.environment?.currentTree !== false
    || !/^sha256:[a-f0-9]{64}$/.test(manifest?.environment?.candidateIdentity || '')) {
    errors.push('Host validation must bind its historical candidate identity and currentTree=false');
  }

  const hosts = Array.isArray(manifest?.hosts) ? manifest.hosts : [];
  const repositoryRoot = resolve(rootPath(rootDir));
  const realRepositoryRoot = realpathSync(repositoryRoot);
  const seen = new Set();
  for (const host of hosts) {
    const name = String(host?.name || 'missing');
    if (seen.has(name)) errors.push(`Host validation contains duplicate host ${name}`);
    seen.add(name);
    if (!STATUS_VALUES.has(host?.status)) {
      errors.push(`Host ${name} has unsupported status ${host?.status || 'missing'}`);
    }
    const evidence = Array.isArray(host?.evidence) ? host.evidence : [];
    if (evidence.length === 0) {
      errors.push(`Host ${name} evidence must be a non-empty array of repository-relative files`);
    }
    for (const evidencePath of evidence) {
      if (typeof evidencePath !== 'string' || evidencePath.length === 0 || isAbsolute(evidencePath)) {
        errors.push(`Host ${name} evidence path must be repository-relative: ${String(evidencePath)}`);
        continue;
      }
      const resolvedEvidencePath = resolve(repositoryRoot, evidencePath);
      if (!staysWithin(repositoryRoot, resolvedEvidencePath)) {
        errors.push(`Host ${name} evidence path must stay within the repository: ${evidencePath}`);
        continue;
      }
      if (!existsSync(resolvedEvidencePath)) {
        errors.push(`Host ${name} evidence path does not exist: ${evidencePath}`);
        continue;
      }
      if (!staysWithin(realRepositoryRoot, realpathSync(resolvedEvidencePath))) {
        errors.push(`Host ${name} evidence path must stay within the repository: ${evidencePath}`);
        continue;
      }
      if (!statSync(resolvedEvidencePath).isFile()) {
        errors.push(`Host ${name} evidence path must be a file: ${evidencePath}`);
      }
    }
    if (host?.status === 'live-validated') {
      if (host?.evidenceScope !== manifest?.environment?.evidenceScope) {
        errors.push(`Host ${name} live validation scope must match the manifest environment`);
      }
      for (const capability of LIVE_CAPABILITIES) {
        if (host?.capabilities?.[capability] !== true) {
          errors.push(`Host ${name} is live-validated without capability ${capability}`);
        }
      }
    }
  }

  for (const host of supportedHosts) {
    if (!seen.has(host)) errors.push(`Host validation is missing supported host ${host}`);
  }
  return errors;
}

export function checkHostValidation({
  manifestPath = DEFAULT_MANIFEST,
  rootDir = REPO_ROOT,
} = {}) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const packageJson = JSON.parse(readFileSync(resolve(rootDir, 'package.json'), 'utf8'));
  const errors = validateHostValidation(manifest, {
    packageVersion: packageJson.version,
    supportedHosts: SUPPORTED_HOSTS,
    rootDir,
  });
  return { manifest, errors };
}

function main() {
  const { manifest, errors } = checkHostValidation();
  if (errors.length) {
    process.stderr.write(`${errors.join('\n')}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`Host validation OK: ${manifest.hosts.length} hosts, product v${manifest.productVersion}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main();
}
