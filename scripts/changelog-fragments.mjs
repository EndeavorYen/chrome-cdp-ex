#!/usr/bin/env node

import { readdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { unfoldedFragmentsBlockRelease } from './check-release-package.mjs';

const defaultRoot = fileURLToPath(new URL('..', import.meta.url));
const IGNORED_FRAGMENT_NAMES = new Set(['README.md', '.gitkeep']);
const FRAGMENT_FILENAME = /^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const REPO_COMPARE = 'https://github.com/EndeavorYen/chrome-cdp-ex/compare';
const USAGE = 'Usage: node scripts/changelog-fragments.mjs [--check|--fold|--print|--release]';

export function normalizeNewlines(text) {
  return String(text).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function compareByteOrder(left, right) {
  return Buffer.compare(Buffer.from(String(left)), Buffer.from(String(right)));
}

export function sectionOrderFromChangelog(changelogText) {
  const seen = [];
  const known = new Set();
  for (const line of normalizeNewlines(changelogText).split('\n')) {
    const match = /^### (.+?)\s*$/.exec(line);
    if (!match || known.has(match[1])) continue;
    known.add(match[1]);
    seen.push(match[1]);
  }
  return seen;
}

function asFragmentEntry(entry) {
  if (typeof entry === 'string') return { name: entry, kind: 'file' };
  const name = entry.name;
  if (typeof entry.isDirectory === 'function' && entry.isDirectory()) return { name, kind: 'directory' };
  if (typeof entry.isFile === 'function' && entry.isFile()) return { name, kind: 'file' };
  if (typeof entry.isSymbolicLink === 'function' && entry.isSymbolicLink()) return { name, kind: 'file' };
  return { name, kind: 'other' };
}

function readFragmentEntries(dir, readDirectory) {
  return readDirectory(dir, { withFileTypes: true }).map(asFragmentEntry);
}

function fragmentNameError(entry) {
  if (IGNORED_FRAGMENT_NAMES.has(entry.name)) return '';
  if (entry.kind === 'file' && FRAGMENT_FILENAME.test(entry.name)) return '';
  return `${entry.name}: changelog fragment must be named <slug>.md`;
}

function trimEdgeBlankLines(lines) {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start] === '') start += 1;
  while (end > start && lines[end - 1] === '') end -= 1;
  return lines.slice(start, end);
}

function parseBullets(lines, filename) {
  const bullets = [];
  let current = null;
  const flush = () => {
    if (!current) return;
    while (current.length && current.at(-1) === '') current.pop();
    const text = current.join('\n');
    if (!/^\* \S/.test(text)) throw new Error(`${filename}: bullet is empty`);
    bullets.push(text);
    current = null;
  };
  for (const line of lines) {
    if (line.startsWith('* ')) {
      flush();
      current = [line];
      continue;
    }
    if (line === '') {
      if (current) current.push(line);
      continue;
    }
    if (current && /^[ \t]/.test(line)) {
      current.push(line);
      continue;
    }
    throw new Error(`${filename}: expected a section heading or a bullet`);
  }
  flush();
  return bullets;
}

export function parseFragment(text, { filename = 'fragment', knownSections = null } = {}) {
  const normalized = normalizeNewlines(text);
  if (!normalized.trim()) throw new Error(`${filename}: fragment is empty`);
  if (/^## [^#]/m.test(normalized) || /^##\[/m.test(normalized)) {
    throw new Error(`${filename}: fragment sections must use ### headings`);
  }
  const lines = normalized.split('\n');
  let index = 0;
  while (index < lines.length && lines[index] === '') index += 1;
  if (index >= lines.length || !/^### /.test(lines[index])) {
    throw new Error(`${filename}: fragment has no sections`);
  }
  const known = knownSections ? new Set(knownSections) : null;
  const sections = [];
  while (index < lines.length) {
    if (lines[index] === '') {
      index += 1;
      continue;
    }
    const header = /^### (.+?)\s*$/.exec(lines[index]);
    if (!header) throw new Error(`${filename}: expected a section heading or a bullet`);
    const title = header[1];
    if (known && !known.has(title)) {
      throw new Error(`${filename}: unknown section ${title}`);
    }
    index += 1;
    const content = [];
    while (index < lines.length && !/^### /.test(lines[index])) {
      content.push(lines[index]);
      index += 1;
    }
    const bullets = parseBullets(content, filename);
    if (!bullets.length) throw new Error(`${filename}: section ${title} has no bullets`);
    sections.push({ title, bullets });
  }
  if (!sections.length) throw new Error(`${filename}: fragment has no sections`);
  return { filename, sections };
}

export function collectFragments(dir, {
  changelogText = '',
  readDirectory = readdirSync,
  readFile = readFileSync,
} = {}) {
  const inspected = inspectFragments(dir, changelogText, { readDirectory, readFile });
  if (inspected.errors.length) {
    throw new Error(inspected.errors.join('\n'));
  }
  return inspected.fragments;
}

export function inspectFragments(dir, changelogText, {
  readDirectory = readdirSync,
  readFile = readFileSync,
} = {}) {
  const knownSections = sectionOrderFromChangelog(changelogText);
  const errors = [];
  const fragments = [];
  let entries;
  try {
    entries = readFragmentEntries(dir, readDirectory);
  } catch (error) {
    if (error?.code === 'ENOENT') return { fragments, errors, knownSections };
    throw error;
  }
  entries.sort((left, right) => compareByteOrder(left.name, right.name));
  for (const entry of entries) {
    const nameError = fragmentNameError(entry);
    if (IGNORED_FRAGMENT_NAMES.has(entry.name)) continue;
    if (nameError) {
      errors.push(nameError);
      continue;
    }
    let text;
    try {
      text = readFile(join(dir, entry.name), 'utf8');
    } catch (error) {
      errors.push(`${entry.name}: ${error.code || 'unreadable'}`);
      continue;
    }
    try {
      fragments.push(parseFragment(text, { filename: entry.name, knownSections }));
    } catch (error) {
      errors.push(error.message);
    }
  }
  return { fragments, errors, knownSections };
}

function splitUnreleased(changelogText) {
  const text = normalizeNewlines(changelogText);
  const match = /^## \[Unreleased\][^\n]*$/m.exec(text);
  if (!match) throw new Error('CHANGELOG.md is missing ## [Unreleased]');
  const heading = match[0];
  const prefix = text.slice(0, match.index);
  const after = text.slice(match.index + heading.length);
  const rest = after.startsWith('\n') ? after.slice(1) : after;
  const nextIndex = rest.search(/^## \[/m);
  const body = nextIndex === -1 ? rest : rest.slice(0, nextIndex);
  const suffix = nextIndex === -1 ? '' : rest.slice(nextIndex);
  return { prefix, heading, body, suffix };
}

function parseUnreleasedBody(body) {
  const lines = body.split('\n');
  let index = 0;
  const preamble = [];
  while (index < lines.length && !/^### /.test(lines[index])) {
    preamble.push(lines[index]);
    index += 1;
  }
  const sections = [];
  while (index < lines.length) {
    if (lines[index] === '' && index === lines.length - 1) break;
    const header = /^### (.+?)\s*$/.exec(lines[index]);
    if (!header) {
      throw new Error(`CHANGELOG.md Unreleased section has an unexpected line: ${lines[index]}`);
    }
    const title = header[1];
    index += 1;
    const content = [];
    while (index < lines.length && !/^### /.test(lines[index])) {
      content.push(lines[index]);
      index += 1;
    }
    sections.push({ title, bullets: parseBullets(content, 'CHANGELOG.md') });
  }
  return { preamble: trimEdgeBlankLines(preamble), sections };
}

function renderBody(preamble, sections) {
  const parts = [];
  if (preamble.length) parts.push(preamble.join('\n'));
  const rendered = sections
    .filter(section => section.bullets.length)
    .map(section => `### ${section.title}\n\n${section.bullets.join('\n\n')}`)
    .join('\n\n');
  if (rendered) parts.push(rendered);
  return parts.join('\n\n');
}

function mergeSections(existing, fragments, knownOrder) {
  const buckets = new Map();
  for (const section of existing) {
    buckets.set(section.title, [...(buckets.get(section.title) || []), ...section.bullets]);
  }
  const sorted = [...fragments].sort((left, right) => compareByteOrder(left.filename, right.filename));
  for (const fragment of sorted) {
    for (const section of fragment.sections) {
      const bucket = buckets.get(section.title) || [];
      bucket.push(...section.bullets);
      buckets.set(section.title, bucket);
    }
  }
  const ordered = [];
  const seen = new Set();
  for (const title of knownOrder) {
    if (!buckets.has(title)) continue;
    seen.add(title);
    ordered.push({ title, bullets: buckets.get(title) });
  }
  for (const [title, bullets] of buckets) {
    if (seen.has(title)) continue;
    ordered.push({ title, bullets });
  }
  return ordered;
}

function joinReleased(prefix, block, suffix) {
  const withBreak = suffix
    ? `${prefix}${block.endsWith('\n') ? block : `${block}\n`}\n${suffix}`
    : `${prefix}${block.endsWith('\n') ? block : `${block}\n`}`;
  return withBreak.endsWith('\n') ? withBreak : `${withBreak}\n`;
}

function releaseHeading(version, date, suffix) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error('version must be a semantic version');
  }
  const when = date || new Date().toISOString().slice(0, 10);
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('date must be YYYY-MM-DD');
  }
  const previous = /^## \[(\d+\.\d+\.\d+)\]/m.exec(suffix)?.[1] || '';
  if (!previous) return `## [${version}] (${when})`;
  return `## [${version}](${REPO_COMPARE}/v${previous}...v${version}) (${when})`;
}

function assemble(changelogText, fragments, { version, date } = {}) {
  const { prefix, heading, body, suffix } = splitUnreleased(changelogText);
  const parsed = parseUnreleasedBody(body);
  const knownOrder = sectionOrderFromChangelog(changelogText);
  for (const fragment of fragments) {
    for (const section of fragment.sections) {
      if (!knownOrder.includes(section.title)) {
        throw new Error(`${fragment.filename}: unknown section ${section.title}`);
      }
    }
  }
  const merged = mergeSections(parsed.sections, fragments, knownOrder);
  const content = renderBody(parsed.preamble, merged);
  const unreleasedBlock = content ? `${heading}\n\n${content}\n` : `${heading}\n`;
  if (!version) {
    return {
      block: unreleasedBlock,
      folded: joinReleased(prefix, unreleasedBlock, suffix),
    };
  }
  const releasedContent = content ? `${releaseHeading(version, date, suffix)}\n\n${content}\n` : `${releaseHeading(version, date, suffix)}\n`;
  const folded = joinReleased(prefix, `## [Unreleased]\n\n${releasedContent}`, suffix);
  return { block: '## [Unreleased]\n', folded };
}

function splitChangelogLines(normalized) {
  const endsWithNewline = normalized.endsWith('\n');
  const lines = normalized.split('\n');
  if (endsWithNewline) lines.pop();
  return { lines, endsWithNewline };
}

function joinChangelogLines(lines, endsWithNewline) {
  const text = lines.join('\n');
  return endsWithNewline ? `${text}\n` : text;
}

function restoreNewlines(original, lfText) {
  const body = original.startsWith('\uFEFF') ? original.slice(1) : original;
  const withoutCrlf = body.replace(/\r\n/g, '');
  const crlfOnly = body.includes('\r\n') && !withoutCrlf.includes('\n') && !withoutCrlf.includes('\r');
  const restored = crlfOnly ? lfText.replace(/\n/g, '\r\n') : lfText;
  return original.startsWith('\uFEFF') ? `\uFEFF${restored}` : restored;
}

function findUnreleasedRange(lines) {
  const start = lines.findIndex(line => /^## \[Unreleased\][^\n]*$/.test(line));
  if (start === -1) throw new Error('CHANGELOG.md is missing ## [Unreleased]');
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^## \[/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return { start, end };
}

function unreleasedSectionSpans(lines, start, end) {
  const sections = [];
  for (let index = start + 1; index < end; index += 1) {
    const header = /^### (.+?)\s*$/.exec(lines[index]);
    if (!header) continue;
    let contentEnd = index + 1;
    while (contentEnd < end && !/^### /.test(lines[contentEnd])) contentEnd += 1;
    sections.push({ title: header[1], heading: index, contentEnd });
    index = contentEnd - 1;
  }
  return sections;
}

function bulletsToLines(bullets) {
  const lines = [];
  for (let index = 0; index < bullets.length; index += 1) {
    if (index > 0) lines.push('');
    lines.push(...String(bullets[index]).split('\n'));
  }
  return lines;
}

function newSectionIndex(title, sections, canonical, end) {
  const position = canonical.indexOf(title);
  for (const section of sections) {
    const existing = canonical.indexOf(section.title);
    if (position !== -1 && (existing === -1 || existing > position)) return section.heading;
  }
  return end;
}

// Insert fragment bullets into the existing Unreleased text. Existing lines stay
// in order; new bullets are appended after a section's current text, and a
// missing section is added at its canonical heading position.
function insertFragmentBullets(changelogText, fragments) {
  if (!fragments?.length) return String(changelogText);
  const normalized = normalizeNewlines(changelogText);
  const { lines, endsWithNewline } = splitChangelogLines(normalized);
  const range = findUnreleasedRange(lines);
  const sections = unreleasedSectionSpans(lines, range.start, range.end);
  const canonical = sectionOrderFromChangelog(normalized);
  for (const fragment of fragments) {
    for (const section of fragment.sections) {
      if (!canonical.includes(section.title)) {
        throw new Error(`${fragment.filename}: unknown section ${section.title}`);
      }
    }
  }
  const grouped = new Map();
  const sorted = [...fragments].sort((left, right) => compareByteOrder(left.filename, right.filename));
  for (const fragment of sorted) {
    for (const section of fragment.sections) {
      const bucket = grouped.get(section.title) || [];
      bucket.push(...section.bullets);
      grouped.set(section.title, bucket);
    }
  }
  const ops = [];
  for (const [title, bullets] of grouped) {
    const block = bulletsToLines(bullets);
    const existing = sections.find(section => section.title === title);
    const order = canonical.indexOf(title);
    if (existing) {
      const inserted = [];
      if (lines[existing.contentEnd - 1] !== '') inserted.push('');
      inserted.push(...block);
      if (existing.contentEnd < lines.length && inserted.at(-1) !== '') inserted.push('');
      ops.push({ index: existing.contentEnd, lines: inserted, order });
      continue;
    }
    const inserted = [`### ${title}`, '', ...block];
    const index = newSectionIndex(title, sections, canonical, range.end);
    if (index > 0 && lines[index - 1] !== '') inserted.unshift('');
    if (inserted.at(-1) !== '') inserted.push('');
    ops.push({ index, lines: inserted, order });
  }
  ops.sort((left, right) => left.index - right.index || left.order - right.order);
  for (let index = ops.length - 1; index >= 0; index -= 1) {
    lines.splice(ops[index].index, 0, ...ops[index].lines);
  }
  return restoreNewlines(changelogText, joinChangelogLines(lines, endsWithNewline));
}

export function foldFragments(changelogText, fragments = [], options = {}) {
  if (options.version) return assemble(changelogText, fragments, options).folded;
  return insertFragmentBullets(changelogText, fragments);
}

export function renderUnreleased(changelogText, fragments = []) {
  const folded = normalizeNewlines(insertFragmentBullets(changelogText, fragments));
  const { lines } = splitChangelogLines(folded);
  const { start, end } = findUnreleasedRange(lines);
  const block = lines.slice(start, end).join('\n');
  return block.endsWith('\n') ? block : `${block}\n`;
}

function foldOrError(changelogText, fragments) {
  try {
    return { folded: foldFragments(changelogText, fragments), error: '' };
  } catch (error) {
    return { folded: '', error: error.message };
  }
}

export function loadChangelogTexts(rootDir = defaultRoot) {
  const changelogPath = join(rootDir, 'CHANGELOG.md');
  let published;
  try {
    published = normalizeNewlines(readFileSync(changelogPath, 'utf8'));
  } catch (error) {
    return { published: '', current: '', errors: [`CHANGELOG.md cannot be read: ${error.code || 'unreadable'}`] };
  }
  const inspected = inspectFragments(join(rootDir, 'changelog.d'), published);
  if (inspected.errors.length) {
    return { published, current: published, errors: inspected.errors };
  }
  if (!inspected.fragments.length) {
    return { published, current: published, errors: [] };
  }
  const folded = foldOrError(published, inspected.fragments);
  if (folded.error) return { published, current: published, errors: [folded.error] };
  return { published, current: folded.folded, errors: [] };
}

export function readCurrentFacingChangelog(rootDir = defaultRoot) {
  const loaded = loadChangelogTexts(rootDir);
  if (loaded.errors.length) throw new Error(loaded.errors.join('\n'));
  return loaded.current;
}

export function checkChangelogFragments(rootDir = defaultRoot) {
  return loadChangelogTexts(rootDir).errors;
}

function writeStdout(stdout, text) {
  if (typeof stdout === 'function') stdout(text);
  else if (stdout && typeof stdout.write === 'function') stdout.write(text);
}

function writeStderr(stderr, text) {
  if (typeof stderr === 'function') stderr(text);
  else if (stderr && typeof stderr.write === 'function') stderr.write(text);
}

function releaseFoldErrors(rootDir, readFile, readDirectory) {
  let version = '';
  try {
    const parsed = JSON.parse(readFile(join(rootDir, 'package.json'), 'utf8'));
    version = parsed.version;
  } catch (error) {
    return [`package.json cannot be read: ${error.code || 'unreadable'}`];
  }
  let changelogText = '';
  try {
    changelogText = readFile(join(rootDir, 'CHANGELOG.md'), 'utf8');
  } catch (error) {
    return [`CHANGELOG.md cannot be read: ${error.code || 'unreadable'}`];
  }
  let names = [];
  try {
    names = readFragmentEntries(join(rootDir, 'changelog.d'), readDirectory).map(entry => entry.name);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return unfoldedFragmentsBlockRelease({ version, changelogText, fragmentNames: names });
}

function pendingFragmentEntries(fragmentDir, readDirectory) {
  try {
    return readFragmentEntries(fragmentDir, readDirectory)
      .filter(entry => !IGNORED_FRAGMENT_NAMES.has(entry.name));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

export function runChangelogFragments(args, {
  rootDir = defaultRoot,
  stdout = process.stdout,
  stderr = process.stderr,
  readDirectory = readdirSync,
  readFile = readFileSync,
  writeFile = writeFileSync,
  removeFile = unlinkSync,
} = {}) {
  const allowed = new Set(['--check', '--fold', '--print', '--release']);
  if (args.length === 0 || args.some(arg => !allowed.has(arg)) || new Set(args).size !== args.length) {
    throw new Error(USAGE);
  }
  const release = args.includes('--release');
  const modes = args.filter(arg => arg !== '--release');
  if (modes.length > 1 || (release && modes.some(mode => mode !== '--check')) || (!release && modes.length !== 1)) {
    throw new Error(USAGE);
  }
  const changelogPath = join(rootDir, 'CHANGELOG.md');
  const fragmentDir = join(rootDir, 'changelog.d');
  if (release && modes.length === 0) {
    const errors = releaseFoldErrors(rootDir, readFile, readDirectory);
    if (errors.length) {
      writeStderr(stderr, `${errors.join('\n')}\n`);
      return 1;
    }
    writeStdout(stdout, 'Changelog release fold OK\n');
    return 0;
  }
  const mode = modes[0];
  let publishedRaw = '';
  try {
    publishedRaw = readFile(changelogPath, 'utf8');
  } catch (error) {
    if (mode === '--fold') {
      const pending = pendingFragmentEntries(fragmentDir, readDirectory);
      if (!pending.length) return 0;
      const invalid = pending.map(fragmentNameError).filter(Boolean);
      if (invalid.length) {
        writeStderr(stderr, `${invalid.join('\n')}\n`);
        return 1;
      }
    }
    writeStderr(stderr, `CHANGELOG.md cannot be read: ${error.code || 'unreadable'}\n`);
    return 1;
  }
  const inspected = inspectFragments(fragmentDir, normalizeNewlines(publishedRaw), { readDirectory, readFile });
  if (inspected.errors.length) {
    writeStderr(stderr, `${inspected.errors.join('\n')}\n`);
    return 1;
  }
  if (mode === '--print') {
    try {
      writeStdout(stdout, renderUnreleased(publishedRaw, inspected.fragments));
    } catch (error) {
      writeStderr(stderr, `${error.message}\n`);
      return 1;
    }
    return 0;
  }
  if (inspected.fragments.length) {
    const folded = foldOrError(publishedRaw, inspected.fragments);
    if (folded.error) {
      writeStderr(stderr, `${folded.error}\n`);
      return 1;
    }
    if (mode === '--fold') {
      writeFile(changelogPath, folded.folded);
      for (const fragment of inspected.fragments) {
        removeFile(join(fragmentDir, fragment.filename));
      }
      writeStdout(stdout, `Folded ${inspected.fragments.length} changelog fragment(s)\n`);
      return 0;
    }
  }
  if (mode === '--check') {
    if (release) {
      const errors = releaseFoldErrors(rootDir, readFile, readDirectory);
      if (errors.length) {
        writeStderr(stderr, `${errors.join('\n')}\n`);
        return 1;
      }
    }
    writeStdout(stdout, `Changelog fragments OK: ${inspected.fragments.length}\n`);
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    const code = runChangelogFragments(process.argv.slice(2));
    if (code) process.exitCode = code;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
