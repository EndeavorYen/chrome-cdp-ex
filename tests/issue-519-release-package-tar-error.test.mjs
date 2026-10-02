import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { listTarEntries, runTar } from '../scripts/check-release-package.mjs';

const checkerPath = resolve(import.meta.dirname, '../scripts/check-release-package.mjs');
const tempRoot = mkdtempSync(join(tmpdir(), 'cdp-519-'));
afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));

// #519: a tar that could not start returned { error, status: null, stderr: null }, and the
// checker crashed on `stderr.trim()` instead of naming the real cause.
describe('#519 check-release-package reports why tar failed', () => {
  it('reports a tar that cannot start', () => {
    const spawn = () => ({ status: null, stdout: null, stderr: null, error: new Error('spawnSync tar ENOENT') });
    expect(listTarEntries('/x/pkg.tgz', { spawn })).toEqual({
      entries: [],
      error: 'tar could not start: spawnSync tar ENOENT',
    });
  });

  it('falls back to the exit status or signal when tar printed nothing', () => {
    expect(runTar('-tzf', '/x/pkg.tgz', { spawn: () => ({ status: 2, stdout: null, stderr: null }) }).error)
      .toBe('tar exited with status 2');
    expect(runTar('-tzf', '/x/pkg.tgz', { spawn: () => ({ status: null, signal: 'SIGKILL', stdout: null, stderr: null }) }).error)
      .toBe('tar exited with status SIGKILL');
    expect(runTar('-tzf', '/x/pkg.tgz', { spawn: () => ({ status: 2, stdout: '', stderr: 'tar: bad archive\n' }) }).error)
      .toBe('tar: bad archive');
  });

  it('puts the archive before the entries and runs in its directory (#463)', () => {
    const calls = [];
    const spawn = (command, args, options) => {
      calls.push({ command, args, cwd: options.cwd });
      return { status: 0, stdout: 'text', stderr: '' };
    };
    const archive = join(tempRoot, 'pkg.tgz');
    expect(runTar('-xOzf', archive, { entries: ['package/README.md'], spawn })).toEqual({ stdout: 'text', error: null });
    expect(calls).toEqual([{ command: 'tar', args: ['-xOzf', './pkg.tgz', 'package/README.md'], cwd: tempRoot }]);
  });

  it('exits with a readable error when no tar is on PATH', () => {
    const emptyBin = join(tempRoot, 'empty-bin');
    mkdirSync(emptyBin);
    const archive = join(tempRoot, 'not-really.tgz');
    writeFileSync(archive, 'x');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
    const result = spawnSync(process.execPath, [checkerPath, archive], { env: { ...env, PATH: emptyBin }, encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Unable to list release package ${archive}: tar could not start:`);
    expect(result.stderr).toContain('ENOENT');
    expect(result.stderr).not.toContain('TypeError');
  });
});
