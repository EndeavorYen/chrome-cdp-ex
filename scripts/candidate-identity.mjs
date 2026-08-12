import { createHash } from 'crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, resolve, sep } from 'path';
import { fileURLToPath } from 'url';

const DEFAULT_ROOT = fileURLToPath(new URL('..', import.meta.url));

export const DEFAULT_CANDIDATE_IDENTITY_PATHS = Object.freeze([
  'package.json',
  'package-lock.json',
  'scripts/candidate-identity.mjs',
  'scripts/benchmark-live-campaign.mjs',
  'scripts/benchmark-killer-path.mjs',
  'scripts/benchmark-mcp-path.mjs',
  'scripts/benchmark-run-lock.mjs',
  'scripts/live-smoke.mjs',
  'scripts/setup.mjs',
  'scripts/smoke-page.html',
  'skills/chrome-cdp-ex/SKILL.md',
  'skills/chrome-cdp-ex/scripts',
]);

function rootPath(rootDir) {
  return rootDir instanceof URL ? fileURLToPath(rootDir) : resolve(String(rootDir));
}

function collectFiles(root, candidatePath, files) {
  const absolute = resolve(root, candidatePath);
  if (!existsSync(absolute)) throw new Error(`candidate identity path does not exist: ${candidatePath}`);
  const stat = statSync(absolute);
  if (stat.isFile()) {
    files.push(absolute);
    return;
  }
  if (!stat.isDirectory()) throw new Error(`candidate identity path is not a file or directory: ${candidatePath}`);
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    collectFiles(root, join(candidatePath, entry.name), files);
  }
}

function portableRelative(root, file) {
  return relative(root, file).split(sep).join('/');
}

export function buildCandidateIdentity({
  rootDir = DEFAULT_ROOT,
  identityPaths = DEFAULT_CANDIDATE_IDENTITY_PATHS,
} = {}) {
  const root = rootPath(rootDir);
  const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const files = [];
  for (const candidatePath of identityPaths) collectFiles(root, candidatePath, files);
  const uniqueFiles = [...new Set(files)].sort((a, b) => portableRelative(root, a).localeCompare(portableRelative(root, b)));
  const hash = createHash('sha256');
  for (const file of uniqueFiles) {
    hash.update(portableRelative(root, file));
    hash.update('\0');
    hash.update(readFileSync(file));
    hash.update('\0');
  }
  return {
    schema: 'chrome-cdp-ex.candidate-identity.v1',
    productVersion: String(packageJson.version || ''),
    algorithm: 'sha256',
    sourceDigest: `sha256:${hash.digest('hex')}`,
    fileCount: uniqueFiles.length,
  };
}
