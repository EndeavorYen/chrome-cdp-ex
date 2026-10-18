import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  isRegistryMiss,
  planNpmPublish,
  publishReleaseTarball,
  versionAtLeast,
} from '../scripts/npm-publish-tarball.mjs';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const scriptPath = join(rootDir, 'scripts', 'npm-publish-tarball.mjs');
const releaseWorkflow = readFileSync(join(rootDir, '.github', 'workflows', 'release.yml'), 'utf8');
const scriptSource = readFileSync(scriptPath, 'utf8');

const temps = [];

afterEach(() => {
  while (temps.length) rmSync(temps.pop(), { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'npm-publish-'));
  temps.push(dir);
  return dir;
}

const registryMiss = {
  status: 1,
  stdout: `${JSON.stringify({
    error: {
      code: 'E404',
      summary: 'Not Found - GET https://registry.npmjs.org/example-pkg - Not found',
    },
  })}\n`,
  stderr: [
    'npm error code E404',
    'npm error 404 Not Found - GET https://registry.npmjs.org/example-pkg - Not found',
    "npm error 404  The requested resource 'example-pkg@*' could not be found or you do not have permission to access it.",
    '',
  ].join('\n'),
};

function fakeNpm({ version = '11.5.1', onView = registryMiss, onPublish = { status: 0, stdout: 'ok\n', stderr: '' } } = {}) {
  const calls = [];
  const spawn = (_cmd, args) => {
    calls.push(args);
    if (args[0] === '--version') return { status: 0, stdout: `${version}\n`, stderr: '' };
    if (args[0] === 'view') return onView;
    if (args[0] === 'publish') return onPublish;
    return { status: 1, stdout: '', stderr: 'unexpected npm args' };
  };
  return { calls, spawn };
}

function runPublish(overrides = {}) {
  const dir = tempDir();
  const tarball = join(dir, 'example-pkg-1.2.3.tgz');
  writeFileSync(tarball, 'not a real tarball');
  const logs = [];
  const errors = [];
  const npm = overrides.npm ?? fakeNpm();
  const exitCode = publishReleaseTarball({
    tarball,
    packageJsonText: JSON.stringify({ name: 'example-pkg', version: '1.2.3' }),
    nodeVersion: '22.14.0',
    env: {},
    spawn: npm.spawn,
    log: line => logs.push(line),
    error: line => errors.push(line),
    ...overrides,
  });
  return { exitCode, logs, errors, calls: npm.calls, tarball };
}

describe('npm trusted publish skip rules', () => {
  it('accepts Node 22.14 and npm 11.5.1, and newer majors', () => {
    expect(versionAtLeast('22.14.0', '22.14.0')).toBe(true);
    expect(versionAtLeast('v22.14.0', '22.14.0')).toBe(true);
    expect(versionAtLeast('24.0.0', '22.14.0')).toBe(true);
    expect(versionAtLeast('22.13.1', '22.14.0')).toBe(false);
    expect(versionAtLeast('11.5.1', '11.5.1')).toBe(true);
    expect(versionAtLeast('11.21.1', '11.5.1')).toBe(true);
    expect(versionAtLeast('11.5.0', '11.5.1')).toBe(false);
  });

  it('treats the npm 11 registry 404 as a missing package', () => {
    expect(isRegistryMiss(registryMiss.stdout, registryMiss.stderr)).toBe(true);
    expect(isRegistryMiss('', 'npm error code ECONNRESET')).toBe(false);
  });

  it('skips a package that is not on npm yet and does not publish', () => {
    const result = runPublish();
    expect(result.exitCode).toBe(0);
    expect(result.logs).toEqual([
      'Notice: example-pkg is not on npm yet. The first publish is manual.',
    ]);
    expect(result.calls.some(args => args[0] === 'publish')).toBe(false);
    expect(result.calls).toContainEqual(['view', 'example-pkg', 'versions', '--json']);
  });

  it('skips a version that is already on npm', () => {
    const result = runPublish({
      npm: fakeNpm({
        onView: { status: 0, stdout: '["1.2.3","1.2.2"]\n', stderr: '' },
      }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.logs[0]).toBe('Notice: example-pkg@1.2.3 is already on npm. Skipping publish.');
    expect(result.calls.some(args => args[0] === 'publish')).toBe(false);
  });

  it('treats a single published version string as that version', () => {
    const plan = planNpmPublish({
      identity: { name: 'example-pkg', version: '0.0.1' },
      view: { missing: false, versions: ['0.0.1'] },
      tarball: 'example-pkg-0.0.1.tgz',
    });
    expect(plan.action).toBe('skip');
  });

  it('publishes the given tarball with provenance when the version is new', () => {
    const result = runPublish({
      npm: fakeNpm({
        onView: { status: 0, stdout: '["1.0.0"]\n', stderr: '' },
      }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.logs.at(-1)).toBe('Published example-pkg@1.2.3');
    const publish = result.calls.find(args => args[0] === 'publish');
    expect(publish).toEqual(['publish', result.tarball, '--provenance', '--access', 'public']);
  });

  it('fails the release when npm view fails for a reason other than 404', () => {
    const result = runPublish({
      npm: fakeNpm({
        onView: { status: 1, stdout: '', stderr: 'npm error code ECONNRESET\n' },
      }),
    });
    expect(result.exitCode).toBe(1);
    expect(result.errors.join('\n')).toContain('ECONNRESET');
    expect(result.calls.some(args => args[0] === 'publish')).toBe(false);
  });

  it('returns the npm publish status when publish fails', () => {
    const result = runPublish({
      npm: fakeNpm({
        onView: { status: 0, stdout: '["1.0.0"]\n', stderr: '' },
        onPublish: { status: 1, stdout: '', stderr: 'ENEEDAUTH\n' },
      }),
    });
    expect(result.exitCode).toBe(1);
    expect(result.logs.some(line => line.startsWith('Published '))).toBe(false);
  });

  it('refuses an npm token, an old Node, an old npm, and a missing tarball', () => {
    const dir = tempDir();
    const tarball = join(dir, 'pkg.tgz');
    writeFileSync(tarball, 'tarball');
    const base = {
      tarball,
      packageJsonText: '{"name":"example-pkg","version":"1.2.3"}',
      env: {},
      spawn: fakeNpm().spawn,
      log: () => {},
      error: () => {},
    };
    expect(publishReleaseTarball({ ...base, nodeVersion: '22.13.0' })).toBe(1);
    expect(publishReleaseTarball({ ...base, nodeVersion: '22.14.0', npmVersion: '11.5.0' })).toBe(1);
    expect(publishReleaseTarball({
      ...base,
      nodeVersion: '22.14.0',
      npmVersion: '11.5.1',
      env: { NPM_TOKEN: 'secret' },
    })).toBe(1);
    expect(publishReleaseTarball({
      ...base,
      nodeVersion: '22.14.0',
      npmVersion: '11.5.1',
      tarball: join(dir, 'missing.tgz'),
    })).toBe(1);
  });
});

describe('release workflow npm publish', () => {
  const publishJob = releaseWorkflow.slice(releaseWorkflow.indexOf('\n  npm-publish:'));
  const releaseJob = releaseWorkflow.slice(0, releaseWorkflow.indexOf('\n  npm-publish:'));

  it('keeps the packed tarball name in the release job and publishes that output', () => {
    expect(releaseJob).toContain('TARBALL="pi-chrome-cdp-${VERSION}.tgz"');
    expect(releaseJob).toContain('echo "tarball=$TARBALL" >> "$GITHUB_OUTPUT"');
    expect(releaseJob).toContain('path: ${{ steps.pack.outputs.tarball }}');
    expect(publishJob).not.toContain('pi-chrome-cdp');
    expect(publishJob).not.toContain('chrome-cdp-ex-');
    expect(publishJob).toContain('needs.release.outputs.tarball');
    expect(publishJob).toContain('steps.pack.outputs.tarball');
    expect(publishJob).toContain('rows[0].filename');
    expect(publishJob).toContain('node "$GITHUB_WORKSPACE/scripts/npm-publish-tarball.mjs" "$TARBALL"');
    expect(publishJob).toContain('path: release-src');
    expect(publishJob).toContain("working-directory: ${{ github.event_name == 'workflow_dispatch' && 'release-src' || '.' }}");
  });

  it('publishes with trusted publishing only from the npm job, after the GitHub Release', () => {
    expect(releaseWorkflow.indexOf('gh release create')).toBeLessThan(releaseWorkflow.indexOf('npm-publish:'));
    expect(releaseJob).not.toContain('id-token:');
    expect(publishJob).toContain('id-token: write');
    expect(releaseWorkflow.match(/id-token:\s*write/g)).toEqual(['id-token: write']);
    expect(publishJob).toContain("npm install -g 'npm@^11.5.1'");
    expect(publishJob).toContain('older than 22.14');
    expect(scriptSource).toContain("'--provenance'");
    expect(scriptSource).toContain("'--access'");
    expect(scriptSource).toContain("'public'");
    expect(scriptSource).not.toContain('pi-chrome-cdp');
    expect(releaseWorkflow).not.toContain('NPM_TOKEN');
    expect(releaseWorkflow).not.toContain('NODE_AUTH_TOKEN');
    expect(releaseWorkflow).not.toContain('secrets.');
  });

  it('re-runs only the npm publish for an existing tag', () => {
    expect(releaseWorkflow).toMatch(/workflow_dispatch:\n\s+inputs:\n\s+version:/);
    expect(releaseJob).toContain("if: github.event_name == 'push'");
    expect(publishJob).toContain("github.event_name == 'workflow_dispatch'");
    expect(publishJob).toContain('git rev-parse --verify "refs/tags/${TAG}^{commit}"');
    expect(publishJob).toContain('npm ci');
    expect(publishJob).toContain('npm pack --json');
    expect(publishJob).not.toContain('gh release create');
  });
});

describe('npm publish CLI', () => {
  it.skipIf(process.platform === 'win32')('skips a 404 from the CLI without calling publish', () => {
    const dir = tempDir();
    const tarball = join(dir, 'example-pkg-1.2.3.tgz');
    writeFileSync(tarball, 'tarball');
    writeFileSync(join(dir, 'package.json'), '{"name":"example-pkg","version":"1.2.3"}\n');
    const log = join(dir, 'npm-args.log');
    writeFileSync(join(dir, 'fake-npm.mjs'), `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify(args) + '\\n');
if (args[0] === '--version') { process.stdout.write('11.6.0\\n'); process.exit(0); }
if (args[0] === 'view') {
  process.stderr.write('npm error code E404\\nnpm error 404 Not Found - GET https://registry.npmjs.org/example-pkg - Not found\\n');
  process.exit(1);
}
process.exit(2);
`);
    writeFileSync(join(dir, 'npm'), `#!/bin/sh
exec node ${JSON.stringify(join(dir, 'fake-npm.mjs'))} "$@"
`);
    chmodSync(join(dir, 'npm'), 0o755);
    const result = spawnSync(process.execPath, [scriptPath, tarball], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FAKE_NPM_LOG: log },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('The first publish is manual.');
    const calls = readFileSync(log, 'utf8');
    expect(calls).not.toContain('"publish"');
  });
});
