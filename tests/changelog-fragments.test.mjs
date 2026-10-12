import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  collectFragments,
  compareByteOrder,
  foldFragments,
  loadChangelogTexts,
  parseFragment,
  renderUnreleased,
  runChangelogFragments,
} from '../scripts/changelog-fragments.mjs';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const scriptPath = join(rootDir, 'scripts', 'changelog-fragments.mjs');
const knownChangelog = [
  '# Changelog',
  '',
  '## [Unreleased]',
  '',
  '### Features',
  '',
  '* kept',
  '',
  '## [1.0.0] (2020-01-01)',
  '',
  '### Bug Fixes',
  '',
  '* published fix',
  '',
].join('\n');

const temps = [];

function tempRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'changelog-fragments-'));
  temps.push(dir);
  mkdirSync(join(dir, 'changelog.d'));
  writeFileSync(join(dir, 'CHANGELOG.md'), knownChangelog);
  writeFileSync(join(dir, 'changelog.d', 'README.md'), '### Not A Section\n\n* ignore me\n');
  writeFileSync(join(dir, 'changelog.d', '.gitkeep'), '\n');
  return dir;
}

afterEach(() => {
  while (temps.length) rmSync(temps.pop(), { recursive: true, force: true });
});

describe('changelog fragments', () => {
  it('sorts fragment filenames by byte order', () => {
    expect(['b.md', 'A.md', 'a.md'].sort(compareByteOrder)).toEqual(['A.md', 'a.md', 'b.md']);
    expect(compareByteOrder('A.md', 'a.md')).toBeLessThan(0);
  });

  it('parses a CRLF fragment into LF bullets', () => {
    const parsed = parseFragment('\uFEFF### Features\r\n\r\n* alpha\r\n  continued\r\n', {
      filename: 'crlf.md',
      knownSections: ['Features', 'Bug Fixes'],
    });
    expect(parsed).toEqual({
      filename: 'crlf.md',
      sections: [{ title: 'Features', bullets: ['* alpha\n  continued'] }],
    });
  });

  it('rejects an unknown section', () => {
    expect(() => parseFragment('### Not A Section\n\n* nope\n', {
      filename: 'bad.md',
      knownSections: ['Features', 'Bug Fixes'],
    })).toThrow(/bad\.md: unknown section Not A Section/);
  });

  it('concatenates one section in filename order, ignoring readdir order', () => {
    const files = new Map([
      ['b.md', '### Features\n\n* beta\n'],
      ['a.md', '### Features\n\n* alpha\n'],
    ]);
    const fragments = collectFragments(join('changelog.d'), {
      changelogText: knownChangelog,
      readDirectory: () => ['b.md', 'README.md', '.gitkeep', 'a.md'],
      readFile: (filePath) => files.get(basename(filePath)),
    });
    expect(fragments.map(fragment => fragment.filename)).toEqual(['a.md', 'b.md']);
    const folded = foldFragments(knownChangelog, fragments);
    expect(folded).toContain([
      '### Features',
      '',
      '* kept',
      '',
      '* alpha',
      '',
      '* beta',
    ].join('\n'));
    expect(folded.indexOf('* kept')).toBeLessThan(folded.indexOf('* alpha'));
    expect(folded.indexOf('* alpha')).toBeLessThan(folded.indexOf('* beta'));
    expect(foldFragments(folded, [])).toBe(folded);
  });

  it('orders sections by their first appearance in CHANGELOG.md', () => {
    const fragment = parseFragment([
      '### Bug Fixes',
      '',
      '* second section',
      '',
      '### Features',
      '',
      '* first section',
      '',
    ].join('\n'), {
      filename: 'mix.md',
      knownSections: ['Features', 'Bug Fixes'],
    });
    const block = renderUnreleased(knownChangelog, [fragment]);
    expect(block.indexOf('### Features')).toBeLessThan(block.indexOf('### Bug Fixes'));
    expect(block).toContain('* kept');
    expect(block).toContain('* first section');
    expect(block).toContain('* second section');
  });

  it('leaves an empty fragment directory unchanged', () => {
    const dir = tempRoot();
    const before = readFileSync(join(dir, 'CHANGELOG.md'), 'utf8');
    let stdout = '';
    const code = runChangelogFragments(['--fold'], {
      rootDir: dir,
      stdout: (text) => { stdout += text; },
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(stdout).toBe('');
    expect(readFileSync(join(dir, 'CHANGELOG.md'), 'utf8')).toBe(before);
    expect(readFileSync(join(dir, 'changelog.d', 'README.md'), 'utf8')).toContain('ignore me');
  });

  it('folds fragments, deletes them, and is idempotent', () => {
    const dir = tempRoot();
    writeFileSync(join(dir, 'changelog.d', 'b.md'), '### Features\r\n\r\n* beta\r\n');
    writeFileSync(join(dir, 'changelog.d', 'a.md'), '### Features\n\n* alpha\n');
    let stdout = '';
    let stderr = '';
    expect(runChangelogFragments(['--fold'], {
      rootDir: dir,
      stdout: (text) => { stdout += text; },
      stderr: (text) => { stderr += text; },
    })).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toContain('Folded 2');
    const folded = readFileSync(join(dir, 'CHANGELOG.md'), 'utf8');
    expect(folded).not.toMatch(/\r/);
    expect(folded.indexOf('* kept')).toBeLessThan(folded.indexOf('* alpha'));
    expect(folded.indexOf('* alpha')).toBeLessThan(folded.indexOf('* beta'));
    expect(() => readFileSync(join(dir, 'changelog.d', 'a.md'))).toThrow();
    expect(() => readFileSync(join(dir, 'changelog.d', 'b.md'))).toThrow();
    expect(readFileSync(join(dir, 'changelog.d', 'README.md'), 'utf8')).toContain('ignore me');
    stdout = '';
    expect(runChangelogFragments(['--fold'], {
      rootDir: dir,
      stdout: (text) => { stdout += text; },
    })).toBe(0);
    expect(stdout).toBe('');
    expect(readFileSync(join(dir, 'CHANGELOG.md'), 'utf8')).toBe(folded);
  });

  it('does not require an Unreleased block when changelog.d has no fragments', () => {
    const dir = tempRoot();
    const published = '# Changelog\r\n\r\n## [1.0.0] (2020-01-01)\r\n\r\n### Bug Fixes\r\n\r\n* old\r\n';
    writeFileSync(join(dir, 'CHANGELOG.md'), published);
    writeFileSync(join(dir, 'changelog.d', 'notes.txt'), '### Bug Fixes\n\n* not a fragment\n');
    let stderr = '';
    expect(runChangelogFragments(['--check'], {
      rootDir: dir,
      stdout: () => {},
      stderr: (text) => { stderr += text; },
    })).toBe(0);
    expect(stderr).toBe('');
    expect(runChangelogFragments(['--fold'], {
      rootDir: dir,
      stdout: () => {},
      stderr: (text) => { stderr += text; },
    })).toBe(0);
    expect(stderr).toBe('');
    expect(readFileSync(join(dir, 'CHANGELOG.md'), 'utf8')).toBe(published);
    expect(readFileSync(join(dir, 'changelog.d', 'README.md'), 'utf8')).toContain('ignore me');
    const loaded = loadChangelogTexts(dir);
    expect(loaded.errors).toEqual([]);
    expect(loaded.current).toBe(published.replace(/\r\n/g, '\n'));
  });

  it('fails check and fold when fragments exist and Unreleased is missing', () => {
    const dir = tempRoot();
    const published = '# Changelog\n\n## [1.0.0] (2020-01-01)\n\n### Bug Fixes\n\n* old\n';
    writeFileSync(join(dir, 'CHANGELOG.md'), published);
    writeFileSync(join(dir, 'changelog.d', 'a.md'), '### Bug Fixes\n\n* new\n');
    let stderr = '';
    expect(runChangelogFragments(['--check'], {
      rootDir: dir,
      stdout: () => {},
      stderr: (text) => { stderr += text; },
    })).toBe(1);
    expect(stderr).toMatch(/CHANGELOG\.md is missing ## \[Unreleased\]/);
    stderr = '';
    expect(runChangelogFragments(['--fold'], {
      rootDir: dir,
      stdout: () => {},
      stderr: (text) => { stderr += text; },
    })).toBe(1);
    expect(stderr).toMatch(/CHANGELOG\.md is missing ## \[Unreleased\]/);
    expect(readFileSync(join(dir, 'CHANGELOG.md'), 'utf8')).toBe(published);
    expect(readFileSync(join(dir, 'changelog.d', 'a.md'), 'utf8')).toContain('* new');
    expect(loadChangelogTexts(dir).errors.join('\n')).toMatch(/missing ## \[Unreleased\]/);
  });

  it('fails check:changelog for an invalid fragment', () => {
    const dir = tempRoot();
    writeFileSync(join(dir, 'changelog.d', 'bad.md'), '### Not A Section\n\n* nope\n');
    let stderr = '';
    expect(runChangelogFragments(['--check'], {
      rootDir: dir,
      stdout: () => {},
      stderr: (text) => { stderr += text; },
    })).toBe(1);
    expect(stderr).toMatch(/unknown section Not A Section/);
  });

  it('can publish the folded unreleased notes under a version heading', () => {
    const fragment = parseFragment('### Features\n\n* shipped\n', {
      filename: 'ship.md',
      knownSections: ['Features', 'Bug Fixes'],
    });
    const folded = foldFragments(knownChangelog, [fragment], { version: '1.2.0', date: '2026-10-12' });
    expect(folded).toContain('## [Unreleased]\n\n## [1.2.0]');
    expect(folded).toContain('## [1.2.0](https://github.com/EndeavorYen/chrome-cdp-ex/compare/v1.0.0...v1.2.0) (2026-10-12)');
    expect(folded.indexOf('* kept')).toBeLessThan(folded.indexOf('## [1.0.0]'));
    expect(folded.indexOf('* shipped')).toBeLessThan(folded.indexOf('## [1.0.0]'));
  });

  it('accepts the repository fragments from the changelog CLI', () => {
    const child = execFileSync(process.execPath, [scriptPath, '--check'], {
      cwd: rootDir,
      encoding: 'utf8',
    });
    expect(child).toContain('Changelog fragments OK:');
  });
});
