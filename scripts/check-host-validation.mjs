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
const HISTORICAL_CANDIDATE_IDENTITIES = Object.freeze({
  '2.15.0': 'sha256:802f7add9391ab693f2cb9e477914ece3b81cc20ada08023706f4f212120675f',
});

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

function recordedHistoricalIdentity(version) {
  return HISTORICAL_CANDIDATE_IDENTITIES[version] || null;
}

function isRecordedHistoricalEvidence(manifest) {
  const identity = recordedHistoricalIdentity(manifest?.productVersion);
  return Boolean(identity)
    && manifest?.environment?.evidenceScope === 'historical-candidate'
    && manifest?.environment?.currentTree === false
    && manifest?.environment?.candidateIdentity === identity;
}

export function validateHostValidation(manifest, {
  packageVersion,
  publishedVersion = packageVersion,
  supportedHosts = SUPPORTED_HOSTS,
  rootDir = REPO_ROOT,
} = {}) {
  const errors = [];
  if (manifest?.schema !== 'chrome-cdp-ex.host-validation.v1') {
    errors.push(`Host validation schema must be chrome-cdp-ex.host-validation.v1`);
  }
  const historicalLabel = Object.keys(HISTORICAL_CANDIDATE_IDENTITIES).join(', ') || publishedVersion;
  if (manifest?.productVersion !== packageVersion && !isRecordedHistoricalEvidence(manifest)) {
    errors.push(`Host validation productVersion ${manifest?.productVersion || 'missing'} matches neither package version ${packageVersion} nor published historical version ${historicalLabel}`);
  }
  for (const [version, identity] of Object.entries(HISTORICAL_CANDIDATE_IDENTITIES)) {
    if (manifest?.environment?.candidateIdentity === identity && manifest?.productVersion !== version) {
      errors.push(`Host validation historical evidence must bind published version ${version} to candidate identity ${identity}`);
    }
  }
  const publishedCandidateIdentity = recordedHistoricalIdentity(publishedVersion);
  if (packageVersion !== publishedVersion
    && manifest?.environment?.evidenceScope === 'historical-candidate'
    && !isRecordedHistoricalEvidence(manifest)
    && (manifest?.productVersion !== publishedVersion
      || !publishedCandidateIdentity
      || manifest?.environment?.candidateIdentity !== publishedCandidateIdentity)) {
    errors.push(`Host validation historical evidence must bind published version ${publishedVersion} to candidate identity ${publishedCandidateIdentity || 'missing'}`);
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
  const changelog = readFileSync(resolve(rootDir, 'CHANGELOG.md'), 'utf8');
  const publishedVersion = changelog.match(/^## \[(\d+\.\d+\.\d+)\]/m)?.[1] || null;
  if (!publishedVersion) throw new Error('CHANGELOG.md is missing the latest published semantic version');
  const errors = validateHostValidation(manifest, {
    packageVersion: packageJson.version,
    publishedVersion,
    supportedHosts: SUPPORTED_HOSTS,
    rootDir,
  });
  return {
    manifest,
    errors,
    packageVersion: packageJson.version,
    publishedVersion,
  };
}

function main() {
  const { manifest, errors, packageVersion, publishedVersion } = checkHostValidation();
  if (errors.length) {
    process.stderr.write(`${errors.join('\n')}\n`);
    process.exitCode = 1;
    return;
  }
  const relation = packageVersion === publishedVersion ? 'package' : 'candidate';
  const scope = manifest.productVersion === packageVersion
    ? `product v${manifest.productVersion}`
    : `historical product v${manifest.productVersion} under ${relation} v${packageVersion}`;
  process.stdout.write(`Host validation OK: ${manifest.hosts.length} hosts, ${scope}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main();
}
