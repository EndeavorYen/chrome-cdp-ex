import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

import { validateHostValidation } from '../scripts/check-host-validation.mjs';

const rootDir = new URL('..', import.meta.url);
const packageJson = JSON.parse(readFileSync(
  new URL('../package.json', import.meta.url),
  'utf8',
));
const checkedInManifest = JSON.parse(readFileSync(
  new URL('../docs/benchmarks/host-validation.v1.json', import.meta.url),
  'utf8',
));
const supportedHosts = ['claude', 'codex', 'cursor', 'openclaw', 'hermes', 'pi'];

function validate(manifest) {
  return validateHostValidation(manifest, {
    packageVersion: packageJson.version,
    supportedHosts,
    rootDir,
  });
}

describe('host validation CLI', () => {
  it('accepts the checked-in current-release evidence manifest', () => {
    const result = spawnSync(process.execPath, ['scripts/check-host-validation.mjs'], {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Host validation OK: 6 hosts, product v${packageJson.version}`);
    expect(result.stderr).toBe('');
  });

  it('ships the checker and every newly linked evidence asset in the package', () => {
    const result = spawnSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    const packedPaths = JSON.parse(result.stdout)[0].files.map(file => file.path);
    expect(packedPaths).toEqual(expect.arrayContaining([
      'docs/benchmarks/host-validation.v1.json',
      'docs/examples/codex-killer-path.md',
      'experiment/codex-killer-path-demo-poster.png',
      'experiment/codex-killer-path-demo.html',
      'experiment/codex-killer-path-demo.mp4',
      'scripts/check-host-validation.mjs',
    ]));
  });
});

describe('host validation manifest', () => {
  it('accepts the complete supported-host set', () => {
    expect(validate(checkedInManifest)).toEqual([]);
  });

  it('rejects evidence recorded for a different product version', () => {
    const manifest = structuredClone(checkedInManifest);
    manifest.productVersion = '2.13.1';

    expect(validate(manifest)).toContain(
      `Host validation productVersion 2.13.1 does not match package version ${packageJson.version}`,
    );
  });

  it('rejects unknown statuses instead of silently promoting a host', () => {
    const manifest = structuredClone(checkedInManifest);
    manifest.hosts[0].status = 'verified';

    expect(validate(manifest)).toContain(
      'Host claude has unsupported status verified',
    );
  });

  it('rejects duplicate and missing supported hosts', () => {
    const manifest = structuredClone(checkedInManifest);
    manifest.hosts[5] = structuredClone(manifest.hosts[0]);

    expect(validate(manifest)).toEqual(expect.arrayContaining([
      'Host validation contains duplicate host claude',
      'Host validation is missing supported host pi',
    ]));
  });

  it('rejects invalid validation dates', () => {
    const manifest = structuredClone(checkedInManifest);
    manifest.validatedAt = '12/08/2026';

    expect(validate(manifest)).toContain(
      'Host validation validatedAt must be an ISO date (YYYY-MM-DD)',
    );
  });

  it('reports semantically invalid ISO dates without throwing', () => {
    const manifest = structuredClone(checkedInManifest);
    manifest.validatedAt = '2026-13-01';

    expect(() => validate(manifest)).not.toThrow();
    expect(validate(manifest)).toContain(
      'Host validation validatedAt must be an ISO date (YYYY-MM-DD)',
    );
  });

  it('rejects missing repository evidence paths', () => {
    const manifest = structuredClone(checkedInManifest);
    manifest.hosts[1].evidence = ['docs/examples/not-present.md'];

    expect(validate(manifest)).toContain(
      'Host codex evidence path does not exist: docs/examples/not-present.md',
    );
  });

  it.each([
    [[], 'Host codex evidence must be a non-empty array of repository-relative files'],
    [['/tmp/evidence.md'], 'Host codex evidence path must be repository-relative: /tmp/evidence.md'],
    [['../outside.md'], 'Host codex evidence path must stay within the repository: ../outside.md'],
    [['docs'], 'Host codex evidence path must be a file: docs'],
  ])('rejects non-portable evidence %j', (evidence, expectedError) => {
    const manifest = structuredClone(checkedInManifest);
    manifest.hosts[1].evidence = evidence;

    expect(validate(manifest)).toContain(expectedError);
  });

  it('requires the full evidence loop before live-validated status', () => {
    const manifest = structuredClone(checkedInManifest);
    manifest.hosts[1].status = 'live-validated';
    manifest.hosts[1].capabilities = {
      install: true,
      doctor: true,
      perceive: true,
      act: true,
      actionReceipt: true,
      sinceAction: false,
      report: true,
    };

    expect(validate(manifest)).toContain(
      'Host codex is live-validated without capability sinceAction',
    );
  });

  it('binds live validation to the historical candidate instead of the current tree', () => {
    expect(checkedInManifest.environment).toMatchObject({
      evidenceScope: 'historical-candidate',
      currentTree: false,
      candidateIdentity: 'sha256:802f7add9391ab693f2cb9e477914ece3b81cc20ada08023706f4f212120675f',
    });
    const manifest = structuredClone(checkedInManifest);
    manifest.environment.currentTree = true;
    delete manifest.environment.candidateIdentity;
    expect(validate(manifest)).toContain(
      'Host validation must bind its historical candidate identity and currentTree=false',
    );
  });
});
