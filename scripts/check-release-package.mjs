#!/usr/bin/env node

import { spawnSync } from 'child_process';
import { statSync } from 'fs';
import { basename, dirname, posix, resolve } from 'path';
import { fileURLToPath } from 'url';

// `files` ships skills/ whole, so the runtime entry points stand in for its lib/ helpers.
export const REQUIRED_RELEASE_ENTRIES = [
  'package/.claude-plugin/plugin.json',
  'package/INTEGRATIONS.md',
  'package/README.md',
  'package/bin/chrome-cdp',
  'package/package.json',
  'package/scripts/check-release-package.mjs',
  'package/scripts/setup.mjs',
  'package/skills/chrome-cdp-ex/SKILL.md',
  'package/skills/chrome-cdp-ex/scripts/cdp.mjs',
  'package/skills/chrome-cdp-ex/scripts/download.mjs',
  'package/skills/chrome-cdp-ex/scripts/mcp-server.mjs',
  'package/skills/chrome-cdp-ex/scripts/session.mjs',
];

const RELEASE_FRAGMENT_KEEP = new Set(['README.md', '.gitkeep']);

// Pure: pending changelog.d entries plus the package version's heading means the
// tag would ship without those notes. README.md and .gitkeep are not fragments.
export function unfoldedFragmentsBlockRelease({ version, changelogText, fragmentNames } = {}) {
  const pending = [];
  for (const name of fragmentNames || []) {
    const filename = String(name);
    if (!RELEASE_FRAGMENT_KEEP.has(filename)) pending.push(filename);
  }
  if (!pending.length) return [];
  const text = String(changelogText || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const escaped = String(version || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!escaped || !new RegExp(`^## \\[${escaped}\\]`, 'm').test(text)) return [];
  pending.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  return [`${pending.join(', ')}: run npm run changelog:fold before tagging`];
}

export function validateReleaseEntries(entries) {
  const available = new Set(entries);
  return REQUIRED_RELEASE_ENTRIES.filter(entry => !available.has(entry));
}

// Give tar a bare file name and run it in the archive's directory. GNU tar (first
// on PATH under Git for Windows) reads `C:\dir\x.tgz` as `host:path` and tries a
// remote host named `C`. `--force-local` fixes that only for GNU tar; bsdtar
// (macOS, Windows System32) rejects the flag. A relative name works for both. The `./` prefix keeps
// a name that starts with `-` from reading as an option, and one with `:` from reading as host:path.
function tarArchive(tarballPath) {
  const absolute = resolve(tarballPath);
  return { file: `./${basename(absolute)}`, cwd: dirname(absolute) };
}

// Run tar on the archive and return its stdout or the reason it failed (#519). A tar that
// cannot start (none on PATH) gives `error` with no status and no output, so check that first;
// a started tar can also end in `error` (output over maxBuffer), which has a pid.
export function runTar(flags, tarballPath, { entries = [], spawn = spawnSync } = {}) {
  const archive = tarArchive(tarballPath);
  const result = spawn('tar', [flags, archive.file, ...entries], { cwd: archive.cwd, encoding: 'utf8' });
  if (result.error) {
    return { stdout: '', error: `tar ${result.pid ? 'failed' : 'could not start'}: ${result.error.message}` };
  }
  if (result.status !== 0) {
    const detail = String(result.stderr ?? '').trim();
    const exit = result.status === null ? `was killed by ${result.signal}` : `exited with status ${result.status}`;
    return { stdout: '', error: detail || `tar ${exit}` };
  }
  return { stdout: String(result.stdout ?? ''), error: null };
}

export function listTarEntries(tarballPath, { spawn } = {}) {
  const listed = runTar('-tzf', tarballPath, { spawn });
  if (listed.error) return { entries: [], error: listed.error };
  return {
    entries: listed.stdout.split('\n').map(line => line.trim()).filter(line => line && !line.endsWith('/')).sort(),
    error: null,
  };
}

function extractTarText(tarballPath, entry) {
  const extracted = runTar('-xOzf', tarballPath, { entries: [entry] });
  return { text: extracted.stdout, error: extracted.error };
}

function readmeTargets(readme) {
  const targets = [];
  const markdownLink = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^)]*)?\)/g;
  const htmlLink = /\b(?:href|src)="([^"]+)"/g;
  for (const pattern of [markdownLink, htmlLink]) {
    for (const match of readme.matchAll(pattern)) targets.push(match[1]);
  }
  return targets;
}

function packagedReadmeTarget(target) {
  const value = target.trim().replace(/^<|>$/g, '');
  if (!value || value.startsWith('#') || value.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(value)) {
    return null;
  }
  const pathOnly = value.split(/[?#]/, 1)[0];
  if (!pathOnly) return null;
  const packaged = posix.normalize(posix.join('package', pathOnly));
  return packaged.startsWith('package/') ? packaged : false;
}

export function validateReadmeLinks(entries, readme) {
  const available = new Set(entries.map(entry => entry.replace(/\/$/, '')));
  const missing = new Set();
  for (const target of readmeTargets(readme)) {
    const packaged = packagedReadmeTarget(target);
    if (packaged === false) {
      missing.add(`README relative link escapes release package: ${target}`);
      continue;
    }
    if (packaged && !available.has(packaged)) missing.add(packaged);
  }
  return [...missing]
    .sort()
    .map(entry => entry.startsWith('README ')
      ? entry
      : `README relative link is missing from release package: ${entry}`);
}

export function inspectReleasePackage(tarballPath) {
  const resolvedPath = resolve(tarballPath);
  try {
    if (!statSync(resolvedPath).isFile()) {
      return { errors: [`Release package is not a file: ${resolvedPath}`], resolvedPath };
    }
  } catch {
    return { errors: [`Release package does not exist: ${resolvedPath}`], resolvedPath };
  }

  const listed = listTarEntries(resolvedPath);
  if (listed.error) {
    const detail = listed.error;
    return { errors: [`Unable to list release package ${resolvedPath}: ${detail}`], resolvedPath };
  }

  const entries = listed.entries;
  const errors = validateReleaseEntries(entries).map(
    entry => `Release package is missing required entry: ${entry}`,
  );
  if (entries.includes('package/README.md')) {
    const extractedReadme = extractTarText(resolvedPath, 'package/README.md');
    if (extractedReadme.error) {
      const detail = extractedReadme.error;
      errors.push(`Unable to read packaged README.md: ${detail}`);
    } else {
      errors.push(...validateReadmeLinks(entries, extractedReadme.text));
    }
  }
  return { errors, resolvedPath };
}

function main(args) {
  if (args.length !== 1) {
    console.error('Usage: node scripts/check-release-package.mjs <tarball.tgz>');
    process.exitCode = 1;
    return;
  }

  const result = inspectReleasePackage(args[0]);
  if (result.errors.length > 0) {
    for (const error of result.errors) console.error(error);
    process.exitCode = 1;
    return;
  }

  console.log(
    `Release package OK: ${REQUIRED_RELEASE_ENTRIES.length} required entries in ${basename(result.resolvedPath)}`,
  );
}

const isDirectRun = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) main(process.argv.slice(2));
