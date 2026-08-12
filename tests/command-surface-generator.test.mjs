import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  GENERATED_FILES,
  generateCommandSurfaces,
  renderGeneratedRegion,
  replaceGeneratedRegion,
} from '../scripts/generate-command-surfaces.mjs';
import { COMMAND_SURFACE, defineCommandSurface } from '../skills/chrome-cdp-ex/scripts/lib/command-surface.mjs';

const START = '<!-- chrome-cdp-ex:generated-command-surface:start -->';
const END = '<!-- chrome-cdp-ex:generated-command-surface:end -->';

describe('command-surface documentation generator', () => {
  it('renders every canonical command once in catalog help order without behavioral invention', () => {
    for (const target of GENERATED_FILES) {
      const block = renderGeneratedRegion(target, COMMAND_SURFACE);
      const names = [...COMMAND_SURFACE.commands]
        .sort((left, right) => left.help.order - right.help.order)
        .map(command => command.name);
      expect(block).toContain('Generated from the immutable command catalog');
      for (const name of names) expect(block).toContain(`\`${name}\``);
      expect(block.match(/^\| `[^`]+` /gm)).toHaveLength(81);
      expect(block).not.toMatch(/best|guarantee|faster|recommended/i);
      expect(block).not.toContain('One-call diagnostics: Node version, skill install path,');
      expect(block).not.toContain('Close common dialog/modal patterns safely');
    }
  });

  it('escapes Markdown table, HTML, and code-span metacharacters from a branded catalog', () => {
    const commands = structuredClone(COMMAND_SURFACE.commands);
    const help = commands.find(command => command.name === 'help');
    help.help.synopsis = 'help `tick` | pipe';
    help.help.summary = 'Use <select> & <input> safely.';
    const block = renderGeneratedRegion('README.md', defineCommandSurface(commands));
    expect(block).toContain('``help `tick` \\| pipe``');
    expect(block).not.toContain('Use &lt;select&gt;');
    expect(block).not.toContain('<select>');
  });

  it('replaces exactly one bounded region and preserves all outside bytes', () => {
    const source = `before\n${START}\nstale\n${END}\nafter\n`;
    const output = replaceGeneratedRegion(source, 'README.md', 'fresh');
    expect(output).toBe(`before\n${START}\nfresh\n${END}\nafter\n`);
    for (const invalid of [
      'no markers',
      `${START}\nmissing end`,
      `${END}\n${START}`,
      `${START}\na\n${START}\nb\n${END}`,
      `${START}\na\n${END}\n${END}`,
      `${START}\n${START}\n${END}\n${END}`,
    ]) expect(() => replaceGeneratedRegion(invalid, 'README.md', 'fresh')).toThrow(/marker/i);
  });

  it('defaults to read-only check, writes explicitly, and is idempotent', () => {
    const root = mkdtempSync(join(tmpdir(), 'chrome-cdp-doc-generator-'));
    try {
      for (const path of GENERATED_FILES) {
        const full = join(root, path);
        const parent = full.slice(0, full.lastIndexOf('/'));
        mkdirSync(parent, { recursive: true });
        writeFileSync(full, `before\n${START}\nstale\n${END}\nafter\n`);
        chmodSync(full, 0o644);
      }
      expect(() => generateCommandSurfaces({ rootDir: root })).toThrow(/stale generated region/i);
      expect(readFileSync(join(root, GENERATED_FILES[0]), 'utf8')).toContain('stale');
      const first = generateCommandSurfaces({ rootDir: root, write: true });
      const bytes = GENERATED_FILES.map(path => readFileSync(join(root, path), 'utf8'));
      const second = generateCommandSurfaces({ rootDir: root, write: true });
      expect(first.written).toEqual(GENERATED_FILES);
      expect(second.written).toEqual([]);
      expect(GENERATED_FILES.map(path => readFileSync(join(root, path), 'utf8'))).toEqual(bytes);
      expect(generateCommandSurfaces({ rootDir: root }).stale).toEqual([]);
      for (const path of GENERATED_FILES) expect(lstatSync(join(root, path)).mode & 0o777).toBe(0o644);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts explicit --check', () => {
    const child = spawnSync(process.execPath, ['scripts/generate-command-surfaces.mjs', '--check'], {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8',
    });
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toContain('OK');
  });

  it('preserves mode under a restrictive umask and removes temp files after a failed rename', () => {
    const root = mkdtempSync(join(tmpdir(), 'chrome-cdp-doc-generator-'));
    try {
      for (const path of GENERATED_FILES) {
        const full = join(root, path);
        mkdirSync(full.slice(0, full.lastIndexOf('/')), { recursive: true });
        writeFileSync(full, `before\n${START}\nstale\n${END}\nafter\n`);
        chmodSync(full, 0o666);
      }
      const previous = process.umask(0o077);
      try {
        generateCommandSurfaces({ rootDir: root, write: true });
      } finally {
        process.umask(previous);
      }
      for (const path of GENERATED_FILES) expect(lstatSync(join(root, path)).mode & 0o777).toBe(0o666);

      writeFileSync(join(root, 'README.md'), `before\n${START}\nstale\n${END}\nafter\n`);
      expect(() => generateCommandSurfaces({
        rootDir: root,
        write: true,
        files: ['README.md'],
        io: { rename: () => { throw new Error('rename failed'); } },
      })).toThrow('rename failed');
      expect(readFileSync(join(root, 'README.md'), 'utf8')).toContain('stale');
      expect(readdirSync(root).filter(name => name.endsWith('.tmp'))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects path escape and symlink traversal before writing', () => {
    const root = mkdtempSync(join(tmpdir(), 'chrome-cdp-doc-generator-'));
    const outside = mkdtempSync(join(tmpdir(), 'chrome-cdp-doc-outside-'));
    try {
      writeFileSync(join(outside, 'README.md'), `${START}\nstale\n${END}\n`);
      symlinkSync(join(outside, 'README.md'), join(root, 'README.md'));
      expect(() => generateCommandSurfaces({ rootDir: root, write: true, files: ['README.md'] }))
        .toThrow(/symlink|containment/i);
      expect(lstatSync(join(root, 'README.md')).isSymbolicLink()).toBe(true);
      expect(readFileSync(join(outside, 'README.md'), 'utf8')).toContain('stale');
      expect(() => generateCommandSurfaces({ rootDir: root, files: ['../outside.md'] }))
        .toThrow(/allowlist|containment/i);
      expect(existsSync(join(root, '..', 'outside.md'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
