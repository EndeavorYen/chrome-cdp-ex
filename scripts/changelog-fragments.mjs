#!/usr/bin/env node

import { readdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const defaultRoot = fileURLToPath(new URL('..', import.meta.url));
const FRAGMENT_README = 'README.md';
const REPO_COMPARE = 'https://github.com/EndeavorYen/chrome-cdp-ex/compare';

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

function isFragmentName(name) {
  return name.endsWith('.md') && name !== FRAGMENT_README && !name.startsWith('.');
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
  let names;
  try {
    names = readDirectory(dir);
  } catch (error) {
    if (error?.code === 'ENOENT') return { fragments, errors, knownSections };
    throw error;
  }
  for (const filename of names.filter(isFragmentName).sort(compareByteOrder)) {
    let text;
    try {
      text = readFile(join(dir, filename), 'utf8');
    } catch (error) {
      errors.push(`${filename}: ${error.code || 'unreadable'}`);
      continue;
    }
    try {
      fragments.push(parseFragment(text, { filename, knownSections }));
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

export function foldFragments(changelogText, fragments = [], options = {}) {
  return assemble(changelogText, fragments, options).folded;
}

export function renderUnreleased(changelogText, fragments = [], options = {}) {
  return assemble(changelogText, fragments, { ...options, version: undefined, date: undefined }).block;
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

export function runChangelogFragments(args, {
  rootDir = defaultRoot,
  stdout = process.stdout,
  stderr = process.stderr,
  readDirectory = readdirSync,
  readFile = readFileSync,
  writeFile = writeFileSync,
  removeFile = unlinkSync,
} = {}) {
  if (args.length !== 1 || !['--check', '--fold', '--print'].includes(args[0])) {
    throw new Error('Usage: node scripts/changelog-fragments.mjs [--check|--fold|--print]');
  }
  const changelogPath = join(rootDir, 'CHANGELOG.md');
  const fragmentDir = join(rootDir, 'changelog.d');
  let published = '';
  try {
    published = normalizeNewlines(readFile(changelogPath, 'utf8'));
  } catch (error) {
    if (args[0] === '--fold') {
      let names = [];
      try {
        names = readDirectory(fragmentDir).filter(isFragmentName);
      } catch (dirError) {
        if (dirError?.code === 'ENOENT') return 0;
        throw dirError;
      }
      if (!names.length) return 0;
    }
    writeStderr(stderr, `CHANGELOG.md cannot be read: ${error.code || 'unreadable'}\n`);
    return 1;
  }
  const inspected = inspectFragments(fragmentDir, published, { readDirectory, readFile });
  if (inspected.errors.length) {
    writeStderr(stderr, `${inspected.errors.join('\n')}\n`);
    return 1;
  }
  if (args[0] === '--print') {
    try {
      writeStdout(stdout, renderUnreleased(published, inspected.fragments));
    } catch (error) {
      writeStderr(stderr, `${error.message}\n`);
      return 1;
    }
    return 0;
  }
  if (inspected.fragments.length) {
    const folded = foldOrError(published, inspected.fragments);
    if (folded.error) {
      writeStderr(stderr, `${folded.error}\n`);
      return 1;
    }
    if (args[0] === '--fold') {
      writeFile(changelogPath, folded.folded);
      for (const fragment of inspected.fragments) {
        removeFile(join(fragmentDir, fragment.filename));
      }
      writeStdout(stdout, `Folded ${inspected.fragments.length} changelog fragment(s)\n`);
      return 0;
    }
  }
  if (args[0] === '--check') {
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
