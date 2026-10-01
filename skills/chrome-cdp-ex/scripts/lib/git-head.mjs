// Resolves the commit checked out in the repository that contains a directory by reading .git
// files directly, so daemon metadata never pays for a `git` child process (#461).
// Covers what `git rev-parse HEAD` needs for the files ref backend: a .git directory or a
// `gitdir:` file (linked worktrees, submodules), `commondir`, symbolic refs, loose refs and
// packed-refs. Anything it cannot read (no repo, unborn branch, reftable) resolves to null.
import { readFileSync as defaultReadFileSync, statSync as defaultStatSync } from 'fs';
import { dirname, join, resolve } from 'path';

const DEFAULT_FS = { readFileSync: defaultReadFileSync, statSync: defaultStatSync };
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
// Same limit git uses for symref chains (SYMREF_MAXDEPTH).
const MAX_SYMREF_DEPTH = 5;
// Refs git keeps per worktree; every other ref lives in the common dir.
const PER_WORKTREE_REF = /^refs\/(?:bisect|worktree|rewritten)\//;

function readText(fs, path) {
  try {
    return String(fs.readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function statKind(fs, path) {
  try {
    const st = fs.statSync(path);
    if (st.isDirectory()) return 'dir';
    if (st.isFile()) return 'file';
  } catch {
    // missing or unreadable
  }
  return null;
}

// Walks up from startDir like git's discovery and returns { gitDir, commonDir } or null.
export function findGitDir(startDir, { fs = DEFAULT_FS } = {}) {
  let dir = resolve(String(startDir || process.cwd()));
  for (;;) {
    const candidate = join(dir, '.git');
    const kind = statKind(fs, candidate);
    let gitDir = null;
    if (kind === 'dir') {
      // A .git directory without HEAD is not a repository; git keeps walking up past it.
      if (readText(fs, join(candidate, 'HEAD')) !== null) gitDir = candidate;
    } else if (kind === 'file') {
      const match = /^gitdir:\s*(.+?)\s*$/m.exec(readText(fs, candidate) || '');
      // git stops with "not a git repository" on a bad .git file instead of walking further.
      if (!match) return null;
      gitDir = resolve(dir, match[1]);
    }
    if (gitDir) {
      const common = readText(fs, join(gitDir, 'commondir'));
      const commonDir = common && common.trim() ? resolve(gitDir, common.trim()) : gitDir;
      return { gitDir, commonDir };
    }
    const parent = dirname(dir);
    if (!parent || parent === dir) return null;
    dir = parent;
  }
}

function validRefName(name) {
  return name.startsWith('refs/')
    && !name.includes('\\')
    && name.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

function readPackedRef(fs, commonDir, name) {
  const packed = readText(fs, join(commonDir, 'packed-refs'));
  if (!packed) return null;
  for (const line of packed.split('\n')) {
    if (!line || line.startsWith('#') || line.startsWith('^')) continue;
    const space = line.indexOf(' ');
    if (space > 0 && line.slice(space + 1).trimEnd() === name) return line.slice(0, space);
  }
  return null;
}

function resolveRefValue(fs, repo, value, depth) {
  const text = String(value || '').trim();
  if (OBJECT_ID.test(text)) return text;
  const match = /^ref:\s*(\S+)$/.exec(text);
  if (!match || depth >= MAX_SYMREF_DEPTH) return null;
  const name = match[1];
  if (!validRefName(name)) return null;
  const refDir = PER_WORKTREE_REF.test(name) ? repo.gitDir : repo.commonDir;
  const loose = readText(fs, join(refDir, ...name.split('/')));
  if (loose !== null) return resolveRefValue(fs, repo, loose, depth + 1);
  const packed = refDir === repo.commonDir ? readPackedRef(fs, repo.commonDir, name) : null;
  return packed && OBJECT_ID.test(packed) ? packed : null;
}

// Full 40-hex (SHA-1) or 64-hex (SHA-256) object id of HEAD, or null.
export function resolveGitHead(startDir, { fs = DEFAULT_FS } = {}) {
  try {
    const repo = findGitDir(startDir, { fs });
    if (!repo) return null;
    return resolveRefValue(fs, repo, readText(fs, join(repo.gitDir, 'HEAD')), 0);
  } catch {
    return null;
  }
}
