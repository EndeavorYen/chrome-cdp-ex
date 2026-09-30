import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { checkTestPort } from '../scripts/lib/port-guard.mjs';

describe('checkTestPort', () => {
  it('accepts an integer port of a test browser, trimming spaces', () => {
    expect(checkTestPort('9336')).toEqual({ ok: true, port: 9336 });
    expect(checkTestPort(' 9336 ')).toEqual({ ok: true, port: 9336 });
    expect(checkTestPort('1')).toEqual({ ok: true, port: 1 });
    expect(checkTestPort('65535')).toEqual({ ok: true, port: 65535 });
  });

  it('refuses unset and empty', () => {
    for (const value of [undefined, null, '', '   ']) {
      expect(checkTestPort(value)).toMatchObject({ ok: false, reason: expect.stringMatching(/not set/) });
    }
  });

  it('refuses the user Chrome ports compared as numbers, so a leading zero does not slip through', () => {
    for (const value of ['9222', '9224', '09222', '009224', ' 9222 ']) {
      expect(checkTestPort(value)).toMatchObject({ ok: false, reason: expect.stringMatching(/9222 or 9224/) });
    }
  });

  it('refuses anything that is not an integer from 1 to 65535', () => {
    for (const value of ['0', '65536', 'abc', '9336.5', '-1', '1e4', '0x2490']) {
      expect(checkTestPort(value)).toMatchObject({ ok: false, reason: expect.stringMatching(/integer from 1 to 65535/) });
    }
  });
});

describe('live scripts refuse a bad CDP_PORT before spawning anything', () => {
  const scripts = [
    ['scripts/verify-session-live.mjs', ['ABCD']],
    ['scripts/verify-session-hidden.mjs', ['ABCD']],
    ['scripts/benchmark-cli-overhead.mjs', ['ABCD']],
    ['scripts/profile-cli-call.mjs', ['ABCD']],
    ['scripts/probe-cli-preamble.mjs', ['skills/chrome-cdp-ex/scripts/cdp.mjs', 'ABCD']],
  ];
  const ROOT = fileURLToPath(new URL('..', import.meta.url));
  for (const [script, args] of scripts) {
    for (const port of [undefined, '09222', '9224']) {
      it(`${script} exits 2 with CDP_PORT=${port ?? '(unset)'}`, () => {
        const env = { ...process.env, CDP_PORT_FILE: join(ROOT, 'no-such-DevToolsActivePort') };
        delete env.CDP_PORT;
        if (port !== undefined) env.CDP_PORT = port;
        const r = spawnSync(process.execPath, [join(ROOT, script), ...args], { cwd: ROOT, encoding: 'utf8', env, timeout: 20000 });
        expect(r.status).toBe(2);
        expect(r.stdout).toBe('');
        expect(r.stderr).toMatch(/refusing to run/);
      });
    }
  }
});
