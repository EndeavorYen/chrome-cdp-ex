import { spawnSync } from 'child_process';
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  listTarEntries,
  validateReadmeLinks,
} from '../scripts/check-release-package.mjs';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const checkerPath = join(rootDir, 'scripts/check-release-package.mjs');
const requiredEntries = [
  '.claude-plugin/plugin.json',
  'INTEGRATIONS.md',
  'README.md',
  'bin/chrome-cdp',
  'package.json',
  'scripts/check-release-package.mjs',
  'scripts/setup.mjs',
  'skills/chrome-cdp-ex/SKILL.md',
  'skills/chrome-cdp-ex/scripts/cdp.mjs',
  'skills/chrome-cdp-ex/scripts/download.mjs',
  'skills/chrome-cdp-ex/scripts/mcp-server.mjs',
  'skills/chrome-cdp-ex/scripts/session.mjs',
];

let tempRoot;
let packedTarball;
let incompleteTarball;

beforeAll(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'chrome-cdp-release-package-'));

  const packed = spawnSync('npm', ['pack', '--json', '--pack-destination', tempRoot], {
    cwd: rootDir,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  expect(packed.status, packed.stderr).toBe(0);
  const packResult = JSON.parse(packed.stdout)[0];
  packedTarball = join(tempRoot, packResult.filename);

  const fixtureRoot = join(tempRoot, 'incomplete');
  const packageRoot = join(fixtureRoot, 'package');
  for (const entry of requiredEntries.filter(path => path !== 'skills/chrome-cdp-ex/scripts/cdp.mjs')) {
    const path = join(packageRoot, entry);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, entry);
  }
  incompleteTarball = join(tempRoot, 'incomplete.tgz');
  // Relative paths with cwd: GNU tar (Git for Windows) reads an absolute
  // `C:\...` archive path as `host:path`, and bsdtar rejects `--force-local`.
  const archived = spawnSync('tar', ['-czf', 'incomplete.tgz', '-C', 'incomplete', 'package'], {
    cwd: tempRoot,
    encoding: 'utf8',
  });
  expect(archived.status, archived.stderr).toBe(0);
  expect(readFileSync(incompleteTarball).length).toBeGreaterThan(0);
  // A real npm pack plus tar; the 10 s default hook budget is too tight on a loaded hosted runner.
}, 120_000);

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('release package checker', () => {
  it('requires every repository-relative README target in the tarball', () => {
    const errors = validateReadmeLinks([
      'package/README.md',
      'package/docs/present.md',
      'package/experiment/demo.png',
    ], `
[present](docs/present.md)
[missing](docs/missing.md#section)
<img src="experiment/demo.png">
[external](https://example.com/not-in-package)
`);

    expect(errors).toEqual([
      'README relative link is missing from release package: package/docs/missing.md',
    ]);
  });

  it('rejects README targets that escape the packaged repository root', () => {
    const errors = validateReadmeLinks([
      'package/README.md',
    ], `
[outside](../outside.md)
`);

    expect(errors).toEqual([
      'README relative link escapes release package: ../outside.md',
    ]);
  });

  it('accepts the actual npm package only when every release-critical entry is present', () => {
    const result = spawnSync(process.execPath, [checkerPath, packedTarball], {
      cwd: rootDir,
      encoding: 'utf8',
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Release package OK: 12 required entries');
  });

  it('rejects an artifact that omits a release-critical entry', () => {
    const result = spawnSync(process.execPath, [checkerPath, incompleteTarball], {
      cwd: rootDir,
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'Release package is missing required entry: package/skills/chrome-cdp-ex/scripts/cdp.mjs',
    );
  });

  // tar must never read the archive name as an option (`-x.tgz`) or a remote `host:path` (#463).
  it.each([
    ['-leading-dash.tgz'],
    ...(process.platform === 'win32' ? [] : [['host:colon.tgz']]),
  ])('lists an archive named %s by its local path', name => {
    const archive = join(tempRoot, name);
    copyFileSync(incompleteTarball, archive);
    const listed = listTarEntries(archive);
    expect(listed.error).toBeNull();
    expect(listed.entries).toContain('package/README.md');
  });
});
