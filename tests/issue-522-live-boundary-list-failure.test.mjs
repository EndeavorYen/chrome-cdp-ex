import { spawnSync } from 'child_process';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

import { describeCdpListFailure } from '../scripts/validation-live-boundary.mjs';

// #522: the live-boundary poll reported a timed-out `cdp list` as "exited null" and crashed on
// `stderr.trim()` when the child could not start. These feed real spawnSync results as well as
// shaped ones, so the cases stay pinned to what Node actually returns.
describe('#522 validation-live-boundary names why cdp list failed', () => {
  it('reports a real timeout as a timeout', () => {
    const result = spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { encoding: 'utf8', timeout: 200 });
    expect(describeCdpListFailure(result, 200)).toBe('cdp list timed out after 200 ms');
  });

  it('reports a real spawn failure instead of crashing on missing stderr', () => {
    const result = spawnSync(join(process.cwd(), 'no-such-dir', 'node'), ['x'], { encoding: 'utf8' });
    expect(describeCdpListFailure(result, 5000)).toMatch(/^cdp list could not run: .*ENOENT/);
  });

  it('reports stderr, then the exit code or signal', () => {
    expect(describeCdpListFailure({ status: 1, stderr: 'No browser found\n' }, 5000)).toBe('No browser found');
    expect(describeCdpListFailure({ status: 3, stderr: '' }, 5000)).toBe('cdp list exited 3');
    expect(describeCdpListFailure({ status: null, signal: 'SIGKILL', stderr: '' }, 5000)).toBe('cdp list was killed by SIGKILL');
  });
});
