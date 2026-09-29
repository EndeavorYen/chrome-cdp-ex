import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

function gitLines(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
}

describe('line endings are pinned to LF (#399)', () => {
  it('ships a .gitattributes', () => {
    expect(existsSync(resolve(root, '.gitattributes'))).toBe(true);
  });

  it('pins eol=lf for every tracked file that starts with a shebang', () => {
    const shebangFiles = gitLines(['grep', '-l', '-I', '^#!', '--', 'bin', 'scripts', 'skills']);
    expect(shebangFiles.length).toBeGreaterThan(0);
    const attrs = gitLines(['check-attr', 'eol', '--', ...shebangFiles]);
    const notLf = attrs.filter((line) => !line.endsWith(': eol: lf'));
    expect(notLf).toEqual([]);
  });

  it('pins eol=lf for source, JSON, Markdown and SVG that tests compare byte for byte', () => {
    const attrs = gitLines(['check-attr', 'eol', '--', 'package.json', 'AGENTS.md', 'skills/chrome-cdp-ex/scripts/cdp.mjs']);
    expect(attrs.every((line) => line.endsWith(': eol: lf'))).toBe(true);
  });
});
