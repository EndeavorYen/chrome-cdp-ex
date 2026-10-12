import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { unfoldedFragmentsBlockRelease } from '../scripts/check-release-package.mjs';
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

function linesOf(text) {
  const normalized = String(text).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return normalized.endsWith('\n') ? normalized.slice(0, -1).split('\n') : normalized.split('\n');
}

function isSubsequence(needles, haystack) {
  let index = 0;
  for (const line of haystack) {
    if (index < needles.length && line === needles[index]) index += 1;
  }
  return index === needles.length;
}

function unreleasedSectionTexts(text) {
  const lines = linesOf(text);
  const start = lines.findIndex(line => line.startsWith('## [Unreleased]'));
  if (start === -1) return [];
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].startsWith('## [')) {
      end = index;
      break;
    }
  }
  const sections = [];
  for (let index = start + 1; index < end; index += 1) {
    if (!lines[index].startsWith('### ')) continue;
    let next = index + 1;
    while (next < end && !lines[next].startsWith('### ')) next += 1;
    sections.push(lines.slice(index, next).join('\n'));
    index = next - 1;
  }
  return sections;
}

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

  it.each(['fix.txt', 'fix.MD', 'fix.markdown', 'Bad_Name.md'])('rejects changelog.d/%s from check and fold', (name) => {
    const dir = tempRoot();
    const before = readFileSync(join(dir, 'CHANGELOG.md'), 'utf8');
    writeFileSync(join(dir, 'changelog.d', name), '### Bug Fixes\n\n* nope\n');
    for (const flag of ['--check', '--fold']) {
      let stderr = '';
      expect(runChangelogFragments([flag], {
        rootDir: dir,
        stdout: () => {},
        stderr: (text) => { stderr += text; },
      })).toBe(1);
      expect(stderr).toContain(name);
    }
    expect(readFileSync(join(dir, 'CHANGELOG.md'), 'utf8')).toBe(before);
    expect(readFileSync(join(dir, 'changelog.d', name), 'utf8')).toContain('* nope');
    expect(readFileSync(join(dir, 'changelog.d', 'README.md'), 'utf8')).toContain('ignore me');
  });

  it('rejects a subdirectory of changelog.d from check and fold', () => {
    const dir = tempRoot();
    const before = readFileSync(join(dir, 'CHANGELOG.md'), 'utf8');
    mkdirSync(join(dir, 'changelog.d', 'nested'));
    for (const flag of ['--check', '--fold']) {
      let stderr = '';
      expect(runChangelogFragments([flag], {
        rootDir: dir,
        stdout: () => {},
        stderr: (text) => { stderr += text; },
      })).toBe(1);
      expect(stderr).toContain('nested');
    }
    expect(readFileSync(join(dir, 'CHANGELOG.md'), 'utf8')).toBe(before);
  });

  it('rejects a heading that has no bullets', () => {
    expect(() => parseFragment('### Bug Fixes\n\n### Features\n\n* y\n', {
      filename: 'empty-section.md',
      knownSections: ['Features', 'Bug Fixes'],
    })).toThrow(/empty-section\.md: section Bug Fixes has no bullets/);
  });

  it('does not insert a blank line between adjacent existing bullets', () => {
    const changelog = [
      '# Changelog',
      '',
      '## [Unreleased]',
      '',
      '### Bug Fixes',
      '',
      '* one',
      '* two',
      '',
      '## [1.0.0] (2020-01-01)',
      '',
    ].join('\n');
    const alpha = parseFragment('### Bug Fixes\n\n* alpha\n', {
      filename: 'a.md',
      knownSections: ['Bug Fixes'],
    });
    const beta = parseFragment('### Bug Fixes\n\n* beta\n', {
      filename: 'b.md',
      knownSections: ['Bug Fixes'],
    });
    const folded = foldFragments(changelog, [beta, alpha]);
    expect(folded).toContain('* one\n* two\n\n* alpha\n\n* beta\n');
    expect(folded).not.toContain('* one\n\n* two');
    expect(foldFragments(folded, [])).toBe(folded);
    expect(foldFragments(changelog, [alpha, beta])).toBe(folded);
  });

  it('inserts a missing section in canonical order without moving existing bullets', () => {
    const changelog = [
      '# Changelog',
      '',
      '## [1.0.0] (2020-01-01)',
      '',
      '### Performance',
      '',
      '* published perf',
      '',
      '### Features',
      '',
      '* published feat',
      '',
      '## [Unreleased]',
      '',
      '### Bug Fixes',
      '',
      '* kept',
      '* kept two',
      '',
    ].join('\n');
    const fragment = parseFragment([
      '### Bug Fixes',
      '',
      '* bug frag',
      '',
      '### Features',
      '',
      '* feat frag',
      '',
      '### Performance',
      '',
      '* perf frag',
      '',
    ].join('\n'), {
      filename: 'mix.md',
      knownSections: ['Performance', 'Features', 'Bug Fixes'],
    });
    const folded = foldFragments(changelog, [fragment]);
    const unreleased = folded.slice(folded.indexOf('## [Unreleased]'));
    expect(unreleased.indexOf('### Performance')).toBeLessThan(unreleased.indexOf('### Features'));
    expect(unreleased.indexOf('### Features')).toBeLessThan(unreleased.indexOf('### Bug Fixes'));
    expect(unreleased).toContain('### Bug Fixes\n\n* kept\n* kept two\n');
    expect(folded.indexOf('* published perf')).toBeLessThan(folded.indexOf('## [Unreleased]'));
    expect(foldFragments(folded, [])).toBe(folded);
  });

  it('keeps a CRLF changelog adjacent pair together when folding', () => {
    const dir = tempRoot();
    const published = [
      '# Changelog',
      '',
      '## [Unreleased]',
      '',
      '### Bug Fixes',
      '',
      '* one',
      '* two',
      '',
      '## [1.0.0] (2020-01-01)',
      '',
    ].join('\r\n');
    writeFileSync(join(dir, 'CHANGELOG.md'), published);
    writeFileSync(join(dir, 'changelog.d', 'a.md'), '### Bug Fixes\r\n\r\n* three\r\n');
    let stderr = '';
    expect(runChangelogFragments(['--fold'], {
      rootDir: dir,
      stdout: () => {},
      stderr: (text) => { stderr += text; },
    })).toBe(0);
    expect(stderr).toBe('');
    const folded = readFileSync(join(dir, 'CHANGELOG.md'), 'utf8');
    expect(folded).toContain('* one\r\n* two\r\n');
    expect(folded).toContain('* three\r\n');
    expect(folded.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    expect(runChangelogFragments(['--fold'], {
      rootDir: dir,
      stdout: () => {},
      stderr: (text) => { stderr += text; },
    })).toBe(0);
    expect(stderr).toBe('');
    expect(readFileSync(join(dir, 'CHANGELOG.md'), 'utf8')).toBe(folded);
  });

  it('concatenates same-section fragments into one new section in filename order', () => {
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
      '### Performance',
      '',
      '* old',
      '',
    ].join('\n');
    const knownSections = ['Bug Fixes', 'Performance'];
    const beta = parseFragment('### Performance\n\n* beta\n', { filename: 'b.md', knownSections });
    const alpha = parseFragment('### Performance\n\n* alpha\n', { filename: 'a.md', knownSections });
    const folded = foldFragments(changelog, [beta, alpha]);
    const unreleased = folded.slice(folded.indexOf('## [Unreleased]'), folded.indexOf('## [1.0.0]'));
    expect(unreleased.match(/### Performance/g)).toHaveLength(1);
    expect(unreleased).toContain('* kept\n\n### Performance\n\n* alpha\n\n* beta\n');
    expect(foldFragments(changelog, [alpha, beta])).toBe(folded);
    expect(foldFragments(folded, [])).toBe(folded);
  });

  it('leaves CHANGELOG.md untouched when changelog.d is missing', () => {
    const dir = tempRoot();
    rmSync(join(dir, 'changelog.d'), { recursive: true, force: true });
    const before = readFileSync(join(dir, 'CHANGELOG.md'), 'utf8');
    expect(runChangelogFragments(['--fold'], {
      rootDir: dir,
      stdout: () => {},
      stderr: () => {},
    })).toBe(0);
    expect(runChangelogFragments(['--check'], {
      rootDir: dir,
      stdout: () => {},
      stderr: () => {},
    })).toBe(0);
    expect(readFileSync(join(dir, 'CHANGELOG.md'), 'utf8')).toBe(before);
  });

  it('folds into the repository changelog without rewriting existing lines', () => {
    const original = readFileSync(join(rootDir, 'CHANGELOG.md'), 'utf8');
    const fragment = parseFragment('### Bug Fixes\n\n* folded preservation probe\n', {
      filename: 'preserve.md',
    });
    const folded = foldFragments(original, [fragment]);
    expect(isSubsequence(linesOf(original), linesOf(folded))).toBe(true);
    const normalizedFold = folded.replace(/\r\n/g, '\n');
    for (const section of unreleasedSectionTexts(original)) {
      expect(normalizedFold).toContain(section);
    }
    const originalLines = linesOf(original);
    let adjacent = 0;
    for (let index = 0; index < originalLines.length - 1; index += 1) {
      if (!originalLines[index].startsWith('* ') || !originalLines[index + 1].startsWith('* ')) continue;
      adjacent += 1;
      expect(normalizedFold).toContain(`${originalLines[index]}\n${originalLines[index + 1]}`);
    }
    expect(adjacent).toBeGreaterThan(0);
    expect(folded).toContain('* folded preservation probe');
    expect(foldFragments(folded, [])).toBe(folded);
    expect(foldFragments(original, [fragment])).toBe(folded);
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

  it('fails the release gate when fragments and the version heading both exist', () => {
    const errors = unfoldedFragmentsBlockRelease({
      version: '1.2.3',
      changelogText: '# Changelog\r\n\r\n## [1.2.3](https://example.com) (2026-10-12)\r\n',
      fragmentNames: ['README.md', '.gitkeep', 'b.md', 'a.md'],
    });
    expect(errors.join('\n')).toContain('run npm run changelog:fold before tagging');
    expect(errors.join('\n')).toContain('a.md');
    expect(errors.join('\n')).toContain('b.md');
    expect(errors.join('\n')).not.toContain('README.md');
    expect(errors.join('\n')).not.toContain('.gitkeep');
    expect(unfoldedFragmentsBlockRelease({
      version: '1.2.3',
      changelogText: '## [1X2Y3] (2020-01-01)\n',
      fragmentNames: ['a.md'],
    })).toEqual([]);
  });

  it('passes the release gate when changelog.d has no fragments', () => {
    expect(unfoldedFragmentsBlockRelease({
      version: '1.2.3',
      changelogText: '## [1.2.3] (2020-01-01)\n',
      fragmentNames: ['README.md', '.gitkeep'],
    })).toEqual([]);
    expect(unfoldedFragmentsBlockRelease({
      version: '1.2.3',
      changelogText: '## [1.2.3] (2020-01-01)\n',
      fragmentNames: [],
    })).toEqual([]);
  });

  it('passes the release gate when fragments exist but the version heading does not', () => {
    expect(unfoldedFragmentsBlockRelease({
      version: '9.9.9',
      changelogText: '## [1.2.3] (2020-01-01)\n\n## [Unreleased]\n',
      fragmentNames: ['note.md'],
    })).toEqual([]);
  });

  it('runs the release gate from the changelog CLI without rewriting files', () => {
    const dir = tempRoot();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '1.0.0' }));
    const before = readFileSync(join(dir, 'CHANGELOG.md'), 'utf8');
    writeFileSync(join(dir, 'changelog.d', 'note.md'), '### Bug Fixes\n\n* pending\n');
    let stderr = '';
    expect(runChangelogFragments(['--release'], {
      rootDir: dir,
      stdout: () => {},
      stderr: (text) => { stderr += text; },
    })).toBe(1);
    expect(stderr).toContain('note.md');
    expect(stderr).toContain('run npm run changelog:fold before tagging');
    expect(readFileSync(join(dir, 'CHANGELOG.md'), 'utf8')).toBe(before);
    expect(readFileSync(join(dir, 'changelog.d', 'note.md'), 'utf8')).toContain('* pending');

    rmSync(join(dir, 'changelog.d', 'note.md'));
    let stdout = '';
    expect(runChangelogFragments(['--release'], {
      rootDir: dir,
      stdout: (text) => { stdout += text; },
      stderr: () => {},
    })).toBe(0);
    expect(stdout).toContain('Changelog release fold OK');

    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '9.9.9' }));
    writeFileSync(join(dir, 'changelog.d', 'note.md'), '### Bug Fixes\n\n* pending\n');
    expect(runChangelogFragments(['--release'], {
      rootDir: dir,
      stdout: () => {},
      stderr: () => {},
    })).toBe(0);
  });

  it('runs the release gate only when a new tag would be published', () => {
    const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));
    expect(pkg.scripts['check:release-package']).toContain('node scripts/changelog-fragments.mjs --release &&');
    expect(pkg.scripts['check:release-package']).toContain('node scripts/check-release-package.mjs');
    const workflow = readFileSync(join(rootDir, '.github', 'workflows', 'release.yml'), 'utf8');
    const publishIf = "if: steps.readiness.outputs.ready == 'true' && steps.check.outputs.exists == 'false'";
    const readiness = workflow.slice(workflow.indexOf('id: readiness'), workflow.indexOf('id: check'));
    expect(readiness).not.toContain('changelog-fragments.mjs');
    expect(readiness).toContain('ready=true');
    const gateAt = workflow.indexOf('name: Check changelog fragments are folded');
    expect(gateAt).toBeGreaterThan(workflow.indexOf('id: check'));
    const gateStep = workflow.slice(gateAt, workflow.indexOf('actions/setup-node'));
    expect(gateStep).toContain(publishIf);
    expect(gateStep).toContain('node scripts/changelog-fragments.mjs --release');
    const pack = workflow.slice(workflow.indexOf('name: Validate and pack release tarball'));
    expect(pack.startsWith('name: Validate and pack release tarball')).toBe(true);
    expect(pack.slice(0, pack.indexOf('run:'))).toContain(publishIf);
    expect(pack).toContain('npm run check:release-package -- "$TARBALL"');
  });
});
