import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

// The profile path spawn-debug-browser records for an isolated Edge on 9222 (#366).
const ISOLATED_PROFILE = '/tmp/chrome-cdp-ex-edge-debug-profile-9222';

describe('#645 endpoint record writer', () => {
  it('persists an isolated 9222 occupant the way a successful spawn does', () => {
    const stored = T.rememberLastCdpEndpoint({
      host: '127.0.0.1',
      port: 9222,
      profileDir: ISOLATED_PROFILE,
      exe: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      browser: 'edge',
      via: 'spawn-debug-browser',
    });

    expect(stored).toMatchObject({ port: '9222', profileDir: ISOLATED_PROFILE });
    expect(T.readLastCdpEndpoint()).toMatchObject({ port: '9222', profileDir: ISOLATED_PROFILE });
  });
});
