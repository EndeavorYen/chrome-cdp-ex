import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildRuntimeDispatchInventory,
  renderRuntimeDispatchFixture,
} from '../scripts/runtime-dispatch-inventory.mjs';
import {
  capturePositionFreeInventory,
  expectInventoryDrift,
  MULTI_BUILD_TIMEOUT,
  packageVersion,
  rootDir,
  source,
  yieldToEventLoop,
} from './runtime-v3-dispatch-test-helpers.mjs';

const STOP_CASE = "        case 'stop': return { ok: true, result: '', stopAfter: true };";
const SHOT_HANDLER = '  shot: capabilities => createDaemonReadHandlers(capabilities).shot,';
const TOP_MARK = '// parallel-merge-probe-top';
const END_MARK = '// parallel-merge-probe-end';

const temps = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'parallel-merge-'));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  while (temps.length) rmSync(temps.pop(), { recursive: true, force: true });
});

function gitEnv(cwd) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key === 'GIT_CONFIG_PARAMETERS' || key === 'GIT_CONFIG_COUNT' || key.startsWith('GIT_CONFIG_KEY_') || key.startsWith('GIT_CONFIG_VALUE_')) {
      delete env[key];
    }
  }
  env.GIT_CONFIG_GLOBAL = join(cwd, 'no-global-gitconfig');
  env.GIT_CONFIG_NOSYSTEM = '1';
  return env;
}

function git(cwd, args) {
  // Inherited Windows autocrlf/safecrlf must not rewrite this repo. safecrlf=true
  // rejects the CRLF fragment this test commits; eol=lf stores that file as LF.
  return execFileSync('git', [
    '-c', 'user.name=changelog-test',
    '-c', 'user.email=changelog-test@example.com',
    '-c', 'core.autocrlf=false',
    '-c', 'core.safecrlf=false',
    '-c', 'core.eol=lf',
    ...args,
  ], {
    cwd,
    encoding: 'utf8',
    env: gitEnv(cwd),
  });
}

function insertTop(text) {
  const shebang = '#!/usr/bin/env node\n';
  if (!text.startsWith(shebang)) throw new Error('cdp.mjs is missing its shebang');
  return `${shebang}\n${TOP_MARK}\n\n${text.slice(shebang.length)}`;
}

function insertEnd(text) {
  const normalized = text.endsWith('\n') ? text : `${text}\n`;
  return `${normalized}\n${END_MARK}\n`;
}

function committedFixtureText() {
  return readFileSync(join(
    rootDir,
    'docs',
    'contracts',
    `v${packageVersion}`,
    'runtime-dispatch.v1.json',
  ), 'utf8');
}

describe('parallel merge of shared files', () => {
  it('merges changelog fragments and distant source insertions without conflicts', () => {
    const cwd = tempDir();
    const changelog = [
      '# Changelog',
      '',
      '## [Unreleased]',
      '',
      '### Bug Fixes',
      '',
      '* kept',
      '',
      '## [1.0.0] (2020-01-01)',
      '',
      '### Bug Fixes',
      '',
      '* published',
      '',
    ].join('\n');
    const fixtureText = committedFixtureText();
    mkdirSync(join(cwd, 'changelog.d'));
    writeFileSync(join(cwd, 'CHANGELOG.md'), changelog);
    writeFileSync(join(cwd, 'changelog.d', 'README.md'), '# fragments\n');
    writeFileSync(join(cwd, 'changelog.d', '.gitkeep'), '\n');
    writeFileSync(join(cwd, '.gitattributes'), '* text=auto eol=lf\n');
    const dispatchDir = join(cwd, 'docs', 'contracts', `v${packageVersion}`);
    mkdirSync(dispatchDir, { recursive: true });
    writeFileSync(join(dispatchDir, 'runtime-dispatch.v1.json'), fixtureText);
    const cdpDir = join(cwd, 'skills', 'chrome-cdp-ex', 'scripts');
    mkdirSync(cdpDir, { recursive: true });
    const cdpFile = join(cdpDir, 'cdp.mjs');
    writeFileSync(cdpFile, source);

    git(cwd, ['init', '-b', 'base']);
    git(cwd, ['add', '--', '.']);
    git(cwd, ['commit', '-m', 'base']);

    git(cwd, ['checkout', '-b', 'branch-a']);
    writeFileSync(join(cwd, 'changelog.d', 'a.md'), '### Bug Fixes\r\n\r\n* alpha change\r\n');
    writeFileSync(cdpFile, insertTop(source));
    git(cwd, ['add', '--', '.']);
    git(cwd, ['commit', '-m', 'branch a']);

    git(cwd, ['checkout', 'base']);
    git(cwd, ['checkout', '-b', 'branch-b']);
    writeFileSync(join(cwd, 'changelog.d', 'b.md'), '### Bug Fixes\n\n* beta change\n');
    writeFileSync(cdpFile, insertEnd(source));
    git(cwd, ['add', '--', '.']);
    git(cwd, ['commit', '-m', 'branch b']);

    git(cwd, ['checkout', 'base']);
    const mergedA = git(cwd, ['merge', '--no-edit', 'branch-a']);
    const mergedB = git(cwd, ['merge', '--no-edit', 'branch-b']);
    expect(`${mergedA}\n${mergedB}`).not.toMatch(/CONFLICT/);
    expect(git(cwd, ['status', '--porcelain'])).toBe('');
    expect(readFileSync(join(cwd, 'CHANGELOG.md'), 'utf8')).toBe(changelog);
    expect(readFileSync(join(cwd, 'changelog.d', 'a.md'), 'utf8')).toContain('* alpha change');
    expect(readFileSync(join(cwd, 'changelog.d', 'b.md'), 'utf8')).toContain('* beta change');
    expect(readFileSync(join(dispatchDir, 'runtime-dispatch.v1.json'), 'utf8')).toBe(fixtureText);

    const mergedSource = readFileSync(cdpFile, 'utf8');
    expect(mergedSource).toContain(TOP_MARK);
    expect(mergedSource).toContain(END_MARK);
    expect(mergedSource).not.toContain('<<<<<<<');
    expect(insertEnd(insertTop(source))).toBe(mergedSource);
  }, 120_000);

  it('keeps a line-only inventory equal and reports a digest change as drift', () => {
    const frozen = { owner: 'cli-direct', sourceDigest: 'sha256:abc' };
    const shifted = capturePositionFreeInventory(() => ({ line: 10, endLine: 20, ...frozen }));
    expect(shifted.ok).toBe(true);
    expect(shifted.inventory).toEqual(frozen);
    const drifted = capturePositionFreeInventory(() => ({ line: 10, owner: 'application-handler', sourceDigest: 'sha256:def' }));
    expect(drifted.ok).toBe(true);
    expect(drifted.inventory).not.toEqual(frozen);
    const rejected = capturePositionFreeInventory(() => {
      throw new Error('duplicate daemon route labels: report');
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.error).toBeInstanceOf(Error);
  });

  it('rejects a drift mutation that leaves the source unchanged', async () => {
    await expect(expectInventoryDrift(source)).rejects.toThrow(/missed its source needle/);
  });

  it('renders the same position-free dispatch fixture after line-only edits', async () => {
    const baseline = committedFixtureText();
    await yieldToEventLoop();
    const unmodified = renderRuntimeDispatchFixture(buildRuntimeDispatchInventory(source));
    expect(unmodified).toBe(baseline);
    await yieldToEventLoop();
    const branchA = renderRuntimeDispatchFixture(buildRuntimeDispatchInventory(insertTop(source)));
    expect(branchA).toBe(baseline);
    await yieldToEventLoop();
    const branchB = renderRuntimeDispatchFixture(buildRuntimeDispatchInventory(insertEnd(source)));
    expect(branchB).toBe(baseline);
    await yieldToEventLoop();
    const merged = renderRuntimeDispatchFixture(buildRuntimeDispatchInventory(insertEnd(insertTop(source))));
    expect(merged).toBe(baseline);
  }, MULTI_BUILD_TIMEOUT);

  it('makes the dispatch render stale when a command case or owner changes', async () => {
    expect(source.includes(STOP_CASE)).toBe(true);
    expect(source.includes(SHOT_HANDLER)).toBe(true);
    const baseline = committedFixtureText();
    await yieldToEventLoop();
    const removed = renderRuntimeDispatchFixture(buildRuntimeDispatchInventory(source.replace(STOP_CASE, '')));
    expect(removed).not.toBe(baseline);
    await yieldToEventLoop();
    const reowned = renderRuntimeDispatchFixture(buildRuntimeDispatchInventory(source.replace(
      SHOT_HANDLER,
      '  shot: capabilities => createDaemonReadHandlers(capabilities).fullshot,',
    )));
    expect(reowned).not.toBe(baseline);
  }, MULTI_BUILD_TIMEOUT);
});
