#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIN_NODE = '22.14.0';
const MIN_NPM = '11.5.1';
const PUBLISH_NAME = 'chrome-cdp-ex';

function versionParts(value) {
  return String(value).trim().replace(/^v/, '').split('.').map(part => {
    const digits = /^(\d+)/.exec(part);
    return digits ? Number(digits[1]) : 0;
  });
}

export function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (a[index] || 0) - (b[index] || 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

export function versionAtLeast(actual, minimum) {
  return compareVersions(actual, minimum) >= 0;
}

export function readPackageIdentity(packageJsonText) {
  const pkg = JSON.parse(String(packageJsonText));
  if (typeof pkg.name !== 'string' || pkg.name === '' || typeof pkg.version !== 'string' || pkg.version === '') {
    throw new Error('package.json must include a name and a version');
  }
  return { name: pkg.name, version: pkg.version };
}

// npm 11 prints `npm error code E404` on stderr and a JSON error on stdout.
export function isRegistryMiss(stdout, stderr) {
  return /\bE404\b/.test(`${stdout ?? ''}\n${stderr ?? ''}`);
}

export function versionsFromNpmView(stdout) {
  const text = String(stdout ?? '').trim();
  if (!text) throw new Error('npm view returned no version list');
  const parsed = JSON.parse(text);
  if (Array.isArray(parsed)) return parsed.map(item => String(item));
  if (typeof parsed === 'string' && parsed !== '') return [parsed];
  throw new Error('npm view returned no version list');
}

export function planNpmPublish({ identity, view, tarball }) {
  if (identity.name !== PUBLISH_NAME) {
    return {
      action: 'skip',
      message: `Notice: ${identity.name} is not ${PUBLISH_NAME}. Skipping publish.`,
    };
  }
  if (view.missing) {
    return {
      action: 'skip',
      message: `Notice: ${identity.name} is not on npm yet. The first publish is manual.`,
    };
  }
  if (view.versions.includes(identity.version)) {
    return {
      action: 'skip',
      message: `Notice: ${identity.name}@${identity.version} is already on npm. Skipping publish.`,
    };
  }
  return {
    action: 'publish',
    message: `Publishing ${identity.name}@${identity.version}`,
    args: ['publish', tarball, '--provenance', '--access', 'public'],
  };
}

function runNpm(spawn, args) {
  const result = spawn('npm', args, { encoding: 'utf8' });
  return {
    status: result?.status ?? 1,
    stdout: result?.stdout ?? '',
    stderr: result?.stderr ?? '',
    error: result?.error ?? null,
  };
}

export function publishReleaseTarball({
  tarball,
  packageJsonText,
  nodeVersion = process.versions.node,
  npmVersion,
  env = process.env,
  spawn = spawnSync,
  log = console.log,
  error = console.error,
} = {}) {
  if (!versionAtLeast(nodeVersion, MIN_NODE)) {
    error(`Node ${nodeVersion} is older than ${MIN_NODE}.`);
    return 1;
  }
  if (env.NPM_TOKEN || env.NODE_AUTH_TOKEN) {
    error('Refusing npm publish: NPM_TOKEN or NODE_AUTH_TOKEN is set. Trusted publishing does not use an npm token.');
    return 1;
  }
  if (npmVersion == null) {
    const reported = runNpm(spawn, ['--version']);
    if (reported.error || reported.status !== 0) {
      error(reported.stderr.trim() || 'npm --version failed');
      return 1;
    }
    npmVersion = String(reported.stdout).trim();
  }
  if (!versionAtLeast(npmVersion, MIN_NPM)) {
    error(`npm ${npmVersion} is older than ${MIN_NPM}.`);
    return 1;
  }

  let identity;
  try {
    identity = readPackageIdentity(packageJsonText);
  } catch (err) {
    error(err instanceof SyntaxError ? 'package.json is not valid JSON' : err.message);
    return 1;
  }

  const resolved = resolve(String(tarball ?? ''));
  if (!tarball || !existsSync(resolved)) {
    error(`Tarball does not exist: ${resolved}`);
    return 1;
  }

  if (identity.name !== PUBLISH_NAME) {
    const skipped = planNpmPublish({ identity, view: { missing: true, versions: [] }, tarball: resolved });
    log(skipped.message);
    return 0;
  }

  const view = runNpm(spawn, ['view', identity.name, 'versions', '--json']);
  if (view.error) {
    error(`npm view could not start: ${view.error.message}`);
    return 1;
  }
  let registryView;
  if (view.status !== 0) {
    if (!isRegistryMiss(view.stdout, view.stderr)) {
      error(String(view.stderr).trim() || `npm view exited ${view.status}`);
      return view.status || 1;
    }
    registryView = { missing: true, versions: [] };
  } else {
    try {
      registryView = { missing: false, versions: versionsFromNpmView(view.stdout) };
    } catch (err) {
      error(err.message);
      return 1;
    }
  }

  const plan = planNpmPublish({ identity, view: registryView, tarball: resolved });
  log(plan.message);
  if (plan.action === 'skip') return 0;

  const published = runNpm(spawn, plan.args);
  if (published.error) {
    error(`npm publish could not start: ${published.error.message}`);
    return 1;
  }
  if (published.stdout) log(String(published.stdout).trimEnd());
  if (published.status !== 0) {
    if (published.stderr) error(String(published.stderr).trimEnd());
    return published.status || 1;
  }
  log(`Published ${identity.name}@${identity.version}`);
  return 0;
}

function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1) {
    console.error('Usage: node scripts/npm-publish-tarball.mjs <tarball>');
    return 1;
  }
  let packageJsonText;
  try {
    packageJsonText = readFileSync(resolve('package.json'), 'utf8');
  } catch (err) {
    console.error(`Could not read package.json: ${err.message}`);
    return 1;
  }
  return publishReleaseTarball({ tarball: argv[0], packageJsonText });
}

const isDirectRun = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) process.exitCode = main();
