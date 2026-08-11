import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

import { validateHostValidation } from '../scripts/check-host-validation.mjs';

const rootDir = new URL('..', import.meta.url);
const checkedInManifest = JSON.parse(readFileSync(
  new URL('../docs/benchmarks/host-validation.v1.json', import.meta.url),
  'utf8',
));
const supportedHosts = ['claude', 'codex', 'cursor', 'openclaw', 'hermes', 'pi'];

function validate(manifest) {
  return validateHostValidation(manifest, {
    packageVersion: '2.14.0',
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
    expect(result.stdout).toContain('Host validation OK: 6 hosts, product v2.14.0');
    expect(result.stderr).toBe('');
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
      'Host validation productVersion 2.13.1 does not match package version 2.14.0',
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

  it('rejects missing repository evidence paths', () => {
    const manifest = structuredClone(checkedInManifest);
    manifest.hosts[1].evidence = ['docs/examples/not-present.md'];

    expect(validate(manifest)).toContain(
      'Host codex evidence path does not exist: docs/examples/not-present.md',
    );
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
});
