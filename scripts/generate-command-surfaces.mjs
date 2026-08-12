#!/usr/bin/env node
import {
  chmodSync,
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { COMMAND_SURFACE, isCommandSurface } from '../skills/chrome-cdp-ex/scripts/lib/command-surface.mjs';

export const GENERATED_FILES = Object.freeze([
  'README.md',
  'docs/reference.md',
  'skills/chrome-cdp-ex/references/commands.md',
]);
const START = '<!-- chrome-cdp-ex:generated-command-surface:start -->';
const END = '<!-- chrome-cdp-ex:generated-command-surface:end -->';

function codeSpan(value) {
  const content = String(value).replaceAll('|', '\\|');
  const runs = content.match(/`+/g) || [];
  const fence = '`'.repeat(Math.max(1, ...runs.map(run => run.length + 1)));
  const padded = /^`|`$|^ | $/.test(content) ? ` ${content} ` : content;
  return `${fence}${padded}${fence}`;
}

export function renderGeneratedRegion(target, surface = COMMAND_SURFACE) {
  if (!GENERATED_FILES.includes(target)) throw new Error(`Generated path is not in the exact allowlist: ${target}`);
  if (!isCommandSurface(surface) || surface.commands.length !== 81) {
    throw new Error('Generated command surface requires the branded 81-command catalog');
  }
  const commands = [...surface.commands].sort((left, right) => left.help.order - right.help.order);
  const rows = commands.map(command => [
    `| ${codeSpan(command.name)} `,
    `${codeSpan(command.help.synopsis)} `,
    `${codeSpan(`${command.kind} / ${command.authorization}`)} |`,
  ].join('| '));
  return [
    '_Generated from the immutable command catalog; edit command metadata at its source, not this region._',
    '',
    '| Command | Synopsis | Catalog policy |',
    '|---|---|---|',
    ...rows,
  ].join('\n');
}

export function replaceGeneratedRegion(source, target, rendered) {
  const starts = [...source.matchAll(new RegExp(START, 'g'))];
  const ends = [...source.matchAll(new RegExp(END, 'g'))];
  if (starts.length !== 1 || ends.length !== 1 || starts[0].index >= ends[0].index) {
    throw new Error(`${target}: generated marker pair must appear exactly once in start/end order`);
  }
  const between = source.slice(starts[0].index + START.length, ends[0].index);
  if (between.includes(START) || between.includes(END)) throw new Error(`${target}: nested generated marker`);
  return `${source.slice(0, starts[0].index + START.length)}\n${rendered}\n${source.slice(ends[0].index)}`;
}

function assertContained(rootDir, target) {
  if (!GENERATED_FILES.includes(target)) throw new Error(`Generated path is not in the exact allowlist: ${target}`);
  const root = realpathSync(rootDir);
  const path = resolve(root, target);
  const rel = relative(root, path);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || resolve(root, rel) !== path) {
    throw new Error(`${target}: containment check failed`);
  }
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`${target}: symlink targets are not allowed`);
  const parent = realpathSync(dirname(path));
  if (parent !== root && !parent.startsWith(`${root}${sep}`)) throw new Error(`${target}: parent containment check failed`);
  if (!stat.isFile()) throw new Error(`${target}: must be a regular file`);
  return { path, mode: stat.mode & 0o777 };
}

function writeAtomic(path, content, mode, io = {}) {
  const rename = io.rename || renameSync;
  const unlink = io.unlink || unlinkSync;
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  let fd = null;
  try {
    fd = openSync(temp, 'wx', mode);
    writeFileSync(fd, content, 'utf8');
    chmodSync(temp, mode);
    closeSync(fd);
    fd = null;
    rename(temp, path);
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch {}
    }
    try { unlink(temp); } catch {}
  }
}

export function generateCommandSurfaces({
  rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  write = false,
  files = GENERATED_FILES,
  surface = COMMAND_SURFACE,
  io = {},
} = {}) {
  if (!Array.isArray(files) || files.some(path => !GENERATED_FILES.includes(path))) {
    throw new Error('Generated files must be a subset of the exact allowlist');
  }
  const stale = [];
  const written = [];
  for (const target of files) {
    const { path, mode } = assertContained(rootDir, target);
    const source = readFileSync(path, 'utf8');
    const expected = replaceGeneratedRegion(source, target, renderGeneratedRegion(target, surface));
    if (expected === source) continue;
    stale.push(target);
    if (write) {
      writeAtomic(path, expected, mode, io);
      written.push(target);
    }
  }
  if (stale.length && !write) throw new Error(`Stale generated region: ${stale.join(', ')}`);
  return Object.freeze({ stale: Object.freeze(stale), written: Object.freeze(written) });
}

function main(args) {
  if (args.some(arg => arg !== '--write' && arg !== '--check')) {
    throw new Error(`Unknown argument: ${args.find(arg => arg !== '--write' && arg !== '--check')}`);
  }
  if (args.includes('--write') && args.includes('--check')) throw new Error('--write and --check are mutually exclusive');
  const result = generateCommandSurfaces({ write: args.includes('--write') });
  console.log(result.written.length ? `Generated command surfaces: ${result.written.join(', ')}` : 'Generated command surfaces OK');
}

const isDirect = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  try { main(process.argv.slice(2)); } catch (error) {
    console.error(error.message || String(error));
    process.exitCode = 1;
  }
}
