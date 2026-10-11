import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PREFIX = 'chrome-cdp-ex-vitest-';
const probe = fileURLToPath(new URL('./fixtures/issue-676-signal-probe.mjs', import.meta.url));
const runner = fileURLToPath(new URL('../scripts/run-vitest.mjs', import.meta.url));

function sleep(ms) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms));
}

function groupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('#676 interrupted vitest removes the run runtime directory', () => {
  it.each(['SIGINT', 'SIGTERM'])(
    'removes the directory when %s hits a Vitest-style re-entrant exit',
    signal => {
      const out = join(tmpdir(), `chrome-cdp-ex-676-${signal}-${process.pid}`);
      const result = spawnSync(process.execPath, [probe, signal], {
        encoding: 'utf8',
        env: { ...process.env, CHROME_CDP_EX_SIGNAL_PROBE_OUT: out },
        timeout: 30_000,
      });
      try {
        expect(result.status, result.stderr || result.stdout).toBe(signal === 'SIGINT' ? 130 : 143);
        const names = existsSync(out) ? readFileSync(out, 'utf8').split('\n').filter(Boolean) : [];
        expect(names.length, 'config did not create a run directory').toBeGreaterThan(0);
        for (const name of names) {
          expect(existsSync(join(tmpdir(), name)), `${signal} left ${name}`).toBe(false);
        }
      } finally {
        if (existsSync(out)) {
          for (const name of readFileSync(out, 'utf8').split('\n').filter(Boolean)) {
            rmSync(join(tmpdir(), name), { recursive: true, force: true });
          }
        }
        rmSync(out, { force: true });
      }
    },
  );
});

describe.skipIf(process.platform === 'win32')('#676 npm test process group', () => {
  it.each(['SIGINT', 'SIGTERM'])(
    'removes the directory when %s interrupts a running vitest',
    async signal => {
      const ready = join(tmpdir(), `chrome-cdp-ex-676-ready-${signal}-${process.pid}`);
      rmSync(ready, { force: true });
      const outer = process.env.CHROME_CDP_EX_VITEST_RUN_RUNTIME || '';
      const child = spawn(process.execPath, [runner, 'tests/issue-676-hold.test.mjs', '--testTimeout=120000'], {
        detached: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          CHROME_CDP_EX_VITEST_HOLD: '1',
          CHROME_CDP_EX_SIGNAL_READY: ready,
        },
      });
      let root = '';
      try {
        const started = Date.now();
        while (Date.now() - started < 30_000) {
          if (existsSync(ready)) {
            root = readFileSync(ready, 'utf8');
            if (root) break;
          }
          await sleep(30);
        }
        expect(root.length > 0, 'hold test did not report a run directory').toBe(true);
        expect(basename(root).startsWith(PREFIX), 'hold test reported an unexpected directory name').toBe(true);
        expect(resolve(root) === resolve(outer), 'hold test reported the parent run directory').toBe(false);
        process.kill(-child.pid, signal);
        const deadline = Date.now() + 8_000;
        while (groupAlive(child.pid) && Date.now() < deadline) await sleep(30);
        expect(groupAlive(child.pid), `${signal} did not stop the vitest process group`).toBe(false);
        expect(existsSync(root), `${signal} left the run directory`).toBe(false);
      } finally {
        try { process.kill(-child.pid, 'SIGKILL'); } catch {}
        if (root && resolve(root) !== resolve(outer) && basename(root).startsWith(PREFIX)) {
          rmSync(root, { recursive: true, force: true });
        }
        rmSync(ready, { force: true });
      }
    },
    45_000,
  );
});
