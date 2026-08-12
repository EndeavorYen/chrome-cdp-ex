import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { buildCandidateIdentity } from '../scripts/candidate-identity.mjs';

const temporaryRoots = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), 'chrome-cdp-candidate-'));
  temporaryRoots.push(root);
  mkdirSync(join(root, 'runtime'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"version":"1.2.3"}\n');
  writeFileSync(join(root, 'runtime', 'entry.mjs'), 'export const value = 1;\n');
  return root;
}

describe('candidate identity', () => {
  it('is deterministic and changes when a covered candidate file changes', () => {
    const root = fixtureRoot();
    const options = { rootDir: root, identityPaths: ['package.json', 'runtime'] };

    const first = buildCandidateIdentity(options);
    const second = buildCandidateIdentity(options);
    writeFileSync(join(root, 'runtime', 'entry.mjs'), 'export const value = 2;\n');
    const changed = buildCandidateIdentity(options);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      schema: 'chrome-cdp-ex.candidate-identity.v1',
      productVersion: '1.2.3',
      algorithm: 'sha256',
      fileCount: 2,
    });
    expect(first.sourceDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(changed.sourceDigest).not.toBe(first.sourceDigest);
  });

  it('fails when an identity-owned path is missing', () => {
    const root = fixtureRoot();

    expect(() => buildCandidateIdentity({
      rootDir: root,
      identityPaths: ['package.json', 'missing-runtime'],
    })).toThrow('candidate identity path does not exist');
  });
});
