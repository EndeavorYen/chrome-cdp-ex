import { describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
const { resolveGitHead } = await import('../skills/chrome-cdp-ex/scripts/lib/git-head.mjs');

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CDP_SCRIPT = join(REPO_ROOT, 'skills', 'chrome-cdp-ex', 'scripts', 'cdp.mjs');
const SHA_A = 'a'.repeat(40);
const SHA_B = '0123456789abcdef0123456789abcdef01234567';
const SHA_256 = 'c'.repeat(64);

// A fake fs over { absolutePath: string | DIR }; `set` lets a test move a ref like a commit would.
const DIR = Symbol('dir');
function fakeFs(tree) {
  const files = new Map(Object.entries(tree).map(([p, v]) => [resolve(p), v]));
  const enoent = p => Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
  const fs = {
    set(p, v) { files.set(resolve(p), v); },
    statSync(p) {
      const v = files.get(resolve(p));
      if (v === undefined) throw enoent(p);
      return { isDirectory: () => v === DIR, isFile: () => v !== DIR };
    },
    readFileSync(p) {
      const v = files.get(resolve(p));
      if (v === undefined || v === DIR) throw enoent(p);
      return v;
    },
  };
  return fs;
}

function gitAvailable() {
  try {
    return spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

function git(cwd, ...args) {
  const res = spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', ...args], { encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout.trim();
}

describe('#461 resolveGitHead reads .git without spawning git', () => {
  it('returns a detached HEAD sha as-is', () => {
    const fs = fakeFs({ '/repo/.git': DIR, '/repo/.git/HEAD': `${SHA_A}\n` });
    expect(resolveGitHead('/repo', { fs })).toBe(SHA_A);
  });

  it('follows a symbolic ref to a loose ref, from a nested directory', () => {
    const fs = fakeFs({
      '/repo/.git': DIR,
      '/repo/.git/HEAD': 'ref: refs/heads/main\n',
      '/repo/.git/refs/heads/main': `${SHA_B}\n`,
    });
    expect(resolveGitHead('/repo/skills/chrome-cdp-ex', { fs })).toBe(SHA_B);
  });

  it('falls back to packed-refs, skipping comments and peeled tag lines', () => {
    const fs = fakeFs({
      '/repo/.git': DIR,
      '/repo/.git/HEAD': 'ref: refs/heads/feature/x\n',
      '/repo/.git/packed-refs': [
        '# pack-refs with: peeled fully-peeled sorted ',
        `${SHA_A} refs/heads/feature/xy`,
        `${SHA_B} refs/heads/feature/x`,
        `${SHA_A} refs/tags/v1`,
        `^${SHA_A}`,
        '',
      ].join('\n'),
    });
    expect(resolveGitHead('/repo', { fs })).toBe(SHA_B);
  });

  it('prefers a loose ref over a stale packed-refs entry', () => {
    const fs = fakeFs({
      '/repo/.git': DIR,
      '/repo/.git/HEAD': 'ref: refs/heads/main\n',
      '/repo/.git/refs/heads/main': `${SHA_B}\n`,
      '/repo/.git/packed-refs': `${SHA_A} refs/heads/main\n`,
    });
    expect(resolveGitHead('/repo', { fs })).toBe(SHA_B);
  });

  it('follows a worktree `gitdir:` file and its commondir to the shared refs', () => {
    const fs = fakeFs({
      '/main/.git': DIR,
      '/main/.git/worktrees/wt': DIR,
      '/main/.git/worktrees/wt/HEAD': 'ref: refs/heads/topic\n',
      '/main/.git/worktrees/wt/commondir': '../..\n',
      '/main/.git/packed-refs': `${SHA_A} refs/heads/topic\n`,
      '/elsewhere/wt/.git': 'gitdir: /main/.git/worktrees/wt\n',
    });
    expect(resolveGitHead('/elsewhere/wt/skills', { fs })).toBe(SHA_A);
  });

  it('resolves a relative `gitdir:` against the directory holding the .git file', () => {
    const fs = fakeFs({
      '/super/.git/modules/sub': DIR,
      '/super/.git/modules/sub/HEAD': `${SHA_B}\n`,
      '/super/sub/.git': 'gitdir: ../.git/modules/sub\n',
    });
    expect(resolveGitHead('/super/sub', { fs })).toBe(SHA_B);
  });

  it('accepts a SHA-256 object id', () => {
    const fs = fakeFs({ '/repo/.git': DIR, '/repo/.git/HEAD': `${SHA_256}\n` });
    expect(resolveGitHead('/repo', { fs })).toBe(SHA_256);
  });

  it('returns null with no repository, an unborn branch, a reftable stub, or a malformed HEAD', () => {
    expect(resolveGitHead('/nowhere/pkg', { fs: fakeFs({}) })).toBeNull();
    expect(resolveGitHead('/repo', {
      fs: fakeFs({ '/repo/.git': DIR, '/repo/.git/HEAD': 'ref: refs/heads/main\n' }),
    })).toBeNull();
    expect(resolveGitHead('/repo', {
      fs: fakeFs({ '/repo/.git': DIR, '/repo/.git/HEAD': 'ref: refs/heads/.invalid\n' }),
    })).toBeNull();
    expect(resolveGitHead('/repo', {
      fs: fakeFs({ '/repo/.git': DIR, '/repo/.git/HEAD': 'not a ref\n' }),
    })).toBeNull();
    expect(resolveGitHead('/repo', {
      fs: fakeFs({ '/repo/.git': DIR, '/repo/.git/HEAD': 'ref: ../../outside\n', '/outside': `${SHA_A}\n` }),
    })).toBeNull();
    expect(resolveGitHead('/repo', { fs: fakeFs({ '/repo/.git': 'not a gitdir pointer\n' }) })).toBeNull();
  });

  it('is not memoised: a long-lived process (the in-process MCP server) sees a new commit', () => {
    const fs = fakeFs({
      '/repo/.git': DIR,
      '/repo/.git/HEAD': 'ref: refs/heads/main\n',
      '/repo/.git/refs/heads/main': `${SHA_A}\n`,
    });
    expect(resolveGitHead('/repo', { fs })).toBe(SHA_A);
    fs.set('/repo/.git/refs/heads/main', `${SHA_B}\n`);
    expect(resolveGitHead('/repo', { fs })).toBe(SHA_B);
  });
});

describe('#461 daemon metadata no longer spawns git', () => {
  it('cdp.mjs has no git subprocess left', () => {
    const source = readFileSync(CDP_SCRIPT, 'utf8');
    expect(source).not.toMatch(/spawn(?:Sync)?\(\s*['"]git['"]/);
    expect(source).toContain("import { resolveGitHead } from './lib/git-head.mjs';");
  });

  it.skipIf(!gitAvailable())('matches `git rev-parse HEAD` for this checkout, keeping the 12-char gitCommit shape', () => {
    const expected = git(REPO_ROOT, 'rev-parse', 'HEAD');
    expect(resolveGitHead(REPO_ROOT)).toBe(expected);
    expect(resolveGitHead(join(REPO_ROOT, 'skills', 'chrome-cdp-ex', 'scripts'))).toBe(expected);
    const meta = T.collectDaemonMetadata({ scriptPath: CDP_SCRIPT, now: 0, pid: 1 });
    expect(meta.gitCommit).toBe(expected.slice(0, 12));
    expect(meta.gitCommit).toBe(git(REPO_ROOT, 'rev-parse', '--short=12', 'HEAD'));
  });

  it.skipIf(!gitAvailable())('matches real git for a fresh repo, a packed ref, and a linked worktree', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'cdp-issue-461-'));
    try {
      const main = join(tmp, 'main');
      git(tmp, 'init', '-q', '-b', 'main', main);
      writeFileSync(join(main, 'a.txt'), 'a\n');
      git(main, 'add', 'a.txt');
      git(main, 'commit', '-q', '-m', 'a');
      expect(resolveGitHead(main)).toBe(git(main, 'rev-parse', 'HEAD'));

      git(main, 'pack-refs', '--all', '--prune');
      expect(resolveGitHead(main)).toBe(git(main, 'rev-parse', 'HEAD'));

      const wt = join(tmp, 'wt');
      git(main, 'worktree', 'add', '-q', '-b', 'topic', wt);
      writeFileSync(join(wt, 'b.txt'), 'b\n');
      git(wt, 'add', 'b.txt');
      git(wt, 'commit', '-q', '-m', 'b');
      expect(resolveGitHead(wt)).toBe(git(wt, 'rev-parse', 'HEAD'));
      expect(resolveGitHead(wt)).not.toBe(resolveGitHead(main));

      git(wt, 'checkout', '-q', '--detach', 'main');
      expect(resolveGitHead(wt)).toBe(git(wt, 'rev-parse', 'HEAD'));

      // Daemon metadata from a script inside the repo follows a new commit within one process.
      writeFileSync(join(main, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }));
      writeFileSync(join(main, 'cdp.mjs'), '// fixture\n');
      const before = T.collectDaemonMetadata({ scriptPath: join(main, 'cdp.mjs'), now: 0, pid: 1 }).gitCommit;
      expect(before).toBe(git(main, 'rev-parse', '--short=12', 'HEAD'));
      git(main, 'add', 'package.json', 'cdp.mjs');
      git(main, 'commit', '-q', '-m', 'c');
      const after = T.collectDaemonMetadata({ scriptPath: join(main, 'cdp.mjs'), now: 0, pid: 1 }).gitCommit;
      expect(after).toBe(git(main, 'rev-parse', '--short=12', 'HEAD'));
      expect(after).not.toBe(before);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
