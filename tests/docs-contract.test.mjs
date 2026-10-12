import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import {
  checkCommandCardContract,
  checkDefaultHelpContract,
  checkReleaseMetadataContract,
  runDocsContract,
  SURVIVOR_COMMANDS,
} from '../scripts/check-docs-contract.mjs';

process.env.NODE_ENV = 'test';
const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const ciWorkflow = read('.github/workflows/ci.yml');
const releaseWorkflow = read('.github/workflows/release.yml');

describe('docs contract', () => {
  it('passes on this checkout', () => {
    expect(runDocsContract()).toEqual([]);
  });

  it('requires survivors on SKILL.md and every other command in the reference docs', () => {
    const commands = [{ name: SURVIVOR_COMMANDS[0], aliases: [] }, { name: 'not-documented-cmd', aliases: [] }];
    expect(checkCommandCardContract({ skill: '', reference: '', skillCommands: '' }, commands)).toEqual([
      `Always-loaded SKILL.md is missing survivor command: ${SURVIVOR_COMMANDS[0]}`,
      'Missing command docs for not-documented-cmd (references/commands.md or docs/reference.md)',
    ]);
  });

  it('requires every survivor command in the default help', () => {
    expect(checkDefaultHelpContract('')).toHaveLength(SURVIVOR_COMMANDS.length);
    expect(checkDefaultHelpContract(T.helpStr())).toEqual([]);
  });

  it('requires package and plugin versions to match and README to link the published tag', () => {
    const docs = {
      packageJson: '{"version":"9.9.9"}',
      pluginManifest: '{"version":"9.9.8"}',
      changelogPublished: '## [9.9.8] - 2026-01-01\n',
      readme: '',
    };
    expect(checkReleaseMetadataContract(docs)).toEqual([
      'Release metadata version mismatch: package.json 9.9.9 != .claude-plugin/plugin.json 9.9.8',
      'README.md does not link the published release tag v9.9.8',
    ]);
  });
});

describe('release gates', () => {
  it('runs the docs contract in CI on pull requests to main and dev', () => {
    expect(ciWorkflow).toMatch(/pull_request:\s*\n\s*branches:\s*\[[^\]]*\bmain\b[^\]]*\bdev\b[^\]]*\]/);
    expect(ciWorkflow).toContain('npm run check:docs');
  });

  it('checks the packed tarball and publishes CHANGELOG.md notes', () => {
    expect(releaseWorkflow).toContain('npm run check:release-package -- "$TARBALL"');
    expect(releaseWorkflow).toContain('--notes-file');
    expect(releaseWorkflow).not.toContain('--generate-notes');
  });
});

describe('help and read-this-page docs (#161)', () => {
  it('documents text --auto and perceive -x in CLI help', () => {
    const usage = T.helpStr();
    expect(usage).toContain('--auto');
    expect(usage).toMatch(/-x <sel> \/ --exclude/);
    expect(usage).not.toMatch(/\bjsclick\s+</);
    expect(usage).not.toMatch(/\beval64\s+</);
    expect(T.helpTopicStr('jsclick')).toMatch(/^cdp jsclick /);
  });

  it('lists text --auto and eval on the always-loaded card', () => {
    const skill = read('skills/chrome-cdp-ex/SKILL.md');
    expect(skill).toContain('text --auto');
    expect(skill).toMatch(/`eval`/);
  });
});
