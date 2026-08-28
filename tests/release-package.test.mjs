import { spawnSync } from 'child_process';
import {
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
  validatePackageInventory,
  validateReadmeLinks,
} from '../scripts/check-release-package.mjs';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const checkerPath = join(rootDir, 'scripts/check-release-package.mjs');
const requiredEntries = [
  '.claude-plugin/plugin.json',
  'INTEGRATIONS.md',
  'bin/chrome-cdp',
  'docs/benchmarks/host-validation.v1.json',
  'docs/architecture/runtime-v3.md',
  'docs/adr/0001-runtime-v3-contract-first-strangler.md',
  'docs/adr/0003-runtime-v3-application-dispatch.md',
  'docs/contracts/README.md',
  'docs/contracts/v2.15.0/public-contracts.v1.json',
  'docs/contracts/v2.15.0/package-entries.v1.json',
  'docs/contracts/v2.15.0/runtime-dispatch.v1.json',
  'docs/contracts/v2.16.0/public-contracts.v1.json',
  'docs/contracts/v2.16.0/package-entries.v1.json',
  'docs/contracts/v2.16.0/runtime-dispatch.v1.json',
  'docs/contracts/v2.17.0/public-contracts.v1.json',
  'docs/contracts/v2.17.0/package-entries.v1.json',
  'docs/contracts/v2.17.0/runtime-dispatch.v1.json',
  'docs/examples/codex-killer-path.md',
  'experiment/codex-killer-path-demo-poster.png',
  'experiment/codex-killer-path-demo.html',
  'experiment/codex-killer-path-demo.mp4',
  'scripts/check-host-validation.mjs',
  'scripts/check-release-package.mjs',
  'scripts/check-public-contracts.mjs',
  'scripts/setup.mjs',
  'README.md',
  'package.json',
  'skills/chrome-cdp-ex/SKILL.md',
  'skills/chrome-cdp-ex/scripts/cdp.mjs',
  'skills/chrome-cdp-ex/scripts/mcp-server.mjs',
  'skills/chrome-cdp-ex/scripts/lib/action-evidence.mjs',
  'skills/chrome-cdp-ex/scripts/lib/action-receipt-surfaces.mjs',
  'skills/chrome-cdp-ex/scripts/lib/action-recovery.mjs',
  'skills/chrome-cdp-ex/scripts/lib/browser-resources.mjs',
  'skills/chrome-cdp-ex/scripts/lib/browser-supervisor.mjs',
  'skills/chrome-cdp-ex/scripts/lib/cdp-domains.mjs',
  'skills/chrome-cdp-ex/scripts/lib/command-application.mjs',
  'skills/chrome-cdp-ex/scripts/lib/command-dispatch.mjs',
  'skills/chrome-cdp-ex/scripts/lib/command-surface.mjs',
  'skills/chrome-cdp-ex/scripts/lib/daemon-action-handlers.mjs',
  'skills/chrome-cdp-ex/scripts/lib/daemon-read-handlers.mjs',
  'skills/chrome-cdp-ex/scripts/lib/daemon-transport.mjs',
  'skills/chrome-cdp-ex/scripts/lib/mcp-adapter.mjs',
  'skills/chrome-cdp-ex/scripts/lib/page-health.mjs',
  'skills/chrome-cdp-ex/scripts/lib/pdf-text.mjs',
  'skills/chrome-cdp-ex/scripts/lib/perception-model.mjs',
  'skills/chrome-cdp-ex/scripts/lib/responsive-audit.mjs',
  'skills/chrome-cdp-ex/scripts/lib/runtime-client.mjs',
  'skills/chrome-cdp-ex/scripts/lib/screenshot-health.mjs',
  'skills/chrome-cdp-ex/scripts/lib/session-report.mjs',
  'skills/chrome-cdp-ex/scripts/lib/target-binding.mjs',
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
  const archived = spawnSync('tar', ['-czf', incompleteTarball, '-C', fixtureRoot, 'package'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  expect(archived.status, archived.stderr).toBe(0);
  expect(readFileSync(incompleteTarball).length).toBeGreaterThan(0);
});

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

  it('rejects duplicate non-directory tar entries instead of deduplicating them', () => {
    expect(validatePackageInventory(
      ['package/a', 'package/a'],
      { schema: 'chrome-cdp-ex.package-entries.v1', productVersion: '2.15.0', entries: ['package/a'] },
      '2.15.0',
    )).toContain('Release package inventory contains duplicate file entries');
  });

  it('accepts the actual npm package only when every release-critical entry is present', () => {
    const result = spawnSync(process.execPath, [checkerPath, packedTarball], {
      cwd: rootDir,
      encoding: 'utf8',
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Release package OK: 51 required entries');
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
});
