import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { afterEach, describe, expect, it } from 'vitest';

import { sanitizeReleaseNotes } from '../scripts/sanitize-release-notes.mjs';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const scriptPath = join(rootDir, 'scripts/sanitize-release-notes.mjs');
const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
const releaseWorkflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');

const MENTION_BREAK = '\u200B';
const tempDirs = [];

afterEach(() => {
  while (tempDirs.length) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function githubMentionUsernames(text) {
  const names = [];
  const mention = /(^|[^\w])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)(?![A-Za-z0-9-])/g;
  let match;
  while ((match = mention.exec(text))) names.push(match[2]);
  return names;
}

describe('release notes CLI @token sanitizer (#354)', () => {
  it('does not emit a raw @ref mention from click @ref', () => {
    const notes = 'then a failed mouse `click @ref` then `jsclick`.';
    const sanitized = sanitizeReleaseNotes(notes);

    expect(githubMentionUsernames(sanitized)).not.toContain('ref');
    expect(sanitized).not.toMatch(/(^|[^\w])@ref(?![A-Za-z0-9-])/);
    expect(sanitized).toContain(`click @${MENTION_BREAK}ref`);
  });

  it('covers the same-class CLI tokens @refs and @fN', () => {
    const notes = [
      'Skip-links get late @refs; article nodes get @1.',
      'Leftover `perceive --frame @fN` dumps are not reused.',
      'Frame-local `@fN:M` actions still settle inside that frame.',
    ].join('\n');
    const sanitized = sanitizeReleaseNotes(notes);
    const mentions = githubMentionUsernames(sanitized);

    expect(mentions).not.toContain('refs');
    expect(mentions).not.toContain('fN');
    expect(sanitized).toContain(`@${MENTION_BREAK}refs`);
    expect(sanitized).toContain(`@${MENTION_BREAK}fN`);
    expect(sanitized).toContain(`@${MENTION_BREAK}fN:M`);
  });

  it('leaves real GitHub @mentions and CHANGELOG command spelling alone', () => {
    const notes = 'Thanks @EndeavorYen. Mouse `click @ref` / CSS is unchanged.';
    const sanitized = sanitizeReleaseNotes(notes);

    expect(githubMentionUsernames(sanitized)).toEqual(['EndeavorYen']);
    expect(changelog).toContain('click @ref');
    expect(changelog).not.toContain(`@${MENTION_BREAK}ref`);
  });

  it('rewrites a notes file in place the way release.yml will call it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sanitize-release-notes-'));
    tempDirs.push(dir);
    const notesPath = join(dir, 'release-notes.md');
    writeFileSync(notesPath, 'Next:`click @ref`.\n');

    const child = spawnSync(process.execPath, [scriptPath, notesPath], { encoding: 'utf8' });
    expect(child.status, child.stderr).toBe(0);
    expect(githubMentionUsernames(readFileSync(notesPath, 'utf8'))).not.toContain('ref');
  });

  it('sanitizes extracted v2.16.0 changelog notes without rewriting CHANGELOG.md', () => {
    const extracted = spawnSync(
      'awk',
      [
        '-v',
        'version=2.16.0',
        `index($0, "## [" version "]") == 1 { capture = 1; next }
         capture && /^## \\[/ { exit }
         capture { print }`,
        'CHANGELOG.md',
      ],
      { cwd: rootDir, encoding: 'utf8' },
    );
    expect(extracted.status, extracted.stderr).toBe(0);
    expect(extracted.stdout).toContain('click @ref');

    const sanitized = sanitizeReleaseNotes(extracted.stdout);
    const mentions = githubMentionUsernames(sanitized);
    expect(mentions).not.toContain('ref');
    expect(mentions).not.toContain('refs');
    expect(mentions).not.toContain('fN');
    expect(changelog).toContain('click @ref');
    expect(changelog).not.toContain(`@${MENTION_BREAK}ref`);
  });
});

describe('release workflow notes pipeline (#354)', () => {
  it('sanitizes extracted changelog notes before gh release create', () => {
    expect(releaseWorkflow).toContain('scripts/sanitize-release-notes.mjs');
    expect(releaseWorkflow.indexOf('scripts/sanitize-release-notes.mjs'))
      .toBeLessThan(releaseWorkflow.indexOf('gh release create'));
    expect(releaseWorkflow).toContain('--notes-file');
    expect(releaseWorkflow).not.toContain('--generate-notes');
  });
});
