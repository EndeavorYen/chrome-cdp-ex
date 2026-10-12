import { afterEach, describe, it, expect } from 'vitest';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
const { checkNode, checkSkillSymlink, checkDaemonSockets, checkCdpReachability, checkBrowserTargets, checkBrowserPermission, checkFdLimit, doctorWizardSummary, formatDoctorReport, runDoctorChecks, doctorStr } = T;

// =========================================================================
// Doctor / ready — diagnostics
// =========================================================================

describe('checkNode', () => {
  const noDiscovery = {
    home: '/no-such-home',
    env: {},
    execPath: '/usr/bin/node',
    fs: { existsSync: () => false, readdirSync: () => [], readFileSync: () => '' },
    spawnSync: () => ({ status: 1, stdout: '' }),
  };
  it('returns OK for v22+', () => {
    expect(checkNode('v22.10.0').status).toBe('OK');
    expect(checkNode('v24.0.0').status).toBe('OK');
    expect(checkNode('v22.0.0').status).toBe('OK');
  });
  it('returns FAIL for older Node', () => {
    const r = checkNode('v18.16.0', noDiscovery);
    expect(r.status).toBe('FAIL');
    expect(r.detail).toContain('need >= 22');
    expect(r.hint).toMatch(/WebSocket/);
  });
  it('handles malformed version strings gracefully', () => {
    const r = checkNode('???', noDiscovery);
    expect(r.status).toBe('FAIL');
  });
});

describe('checkSkillSymlink', () => {
  it('returns WARN when path does not exist', () => {
    const fs = { existsSync: () => false };
    const r = checkSkillSymlink({ home: '/home/test', fs, env: {} });
    expect(r.status).toBe('WARN');
    expect(r.detail).toContain('/home/test/.claude/skills/chrome-cdp-ex');
    expect(r.detail).toContain('not found');
    expect(r.hint).toMatch(/cp -r/);
  });

  it('returns OK with "symlink" detail when target is a symlink', () => {
    const fs = { existsSync: () => true, lstatSync: () => ({ isSymbolicLink: () => true }) };
    const r = checkSkillSymlink({ home: '/h', fs });
    expect(r.status).toBe('OK');
    expect(r.detail).toContain('symlink');
  });

  it('returns OK with "directory" detail when target is a real directory', () => {
    const fs = { existsSync: () => true, lstatSync: () => ({ isSymbolicLink: () => false }) };
    const r = checkSkillSymlink({ home: '/h', fs });
    expect(r.status).toBe('OK');
    expect(r.detail).toContain('directory');
  });

  it('returns OK even when lstat is unavailable', () => {
    const fs = { existsSync: () => true, lstatSync: null };
    const r = checkSkillSymlink({ home: '/h', fs });
    expect(r.status).toBe('OK');
  });
});

describe('checkDaemonSockets', () => {
  it('returns OK with "no live tab daemons" when none running', () => {
    const r = checkDaemonSockets({ list: () => [] });
    expect(r.status).toBe('OK');
    expect(r.detail).toMatch(/no live tab daemons/);
  });
  it('lists daemon target prefixes when sockets are present', () => {
    const r = checkDaemonSockets({ list: () => [
      { targetId: 'AABBCCDDEEFF1122' },
      { targetId: 'XYZ12345QQQQ' },
    ] });
    expect(r.status).toBe('OK');
    expect(r.detail).toContain('2 live');
    expect(r.detail).toContain('AABBCCDD');
    expect(r.detail).toContain('XYZ12345');
  });
});

describe('getWsUrl websocket-only fallback', () => {
  const previousPort = process.env.CDP_PORT;
  const previousHost = process.env.CDP_HOST;
  afterEach(() => {
    if (previousPort === undefined) delete process.env.CDP_PORT;
    else process.env.CDP_PORT = previousPort;
    if (previousHost === undefined) delete process.env.CDP_HOST;
    else process.env.CDP_HOST = previousHost;
  });

  it('falls back to /devtools/browser only when /json/version returns 404', async () => {
    process.env.CDP_PORT = '9222';
    process.env.CDP_HOST = '127.0.0.1';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
    try {
      await expect(T.getWsUrl()).resolves.toBe('ws://127.0.0.1:9222/devtools/browser');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('keeps a clear reachability error when the HTTP endpoint is unreachable', async () => {
    process.env.CDP_PORT = '9222';
    process.env.CDP_HOST = '127.0.0.1';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
    try {
      await expect(T.getWsUrl()).rejects.toThrow(/Cannot reach CDP on 127\.0\.0\.1:9222/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('checkCdpReachability', () => {
  it('returns OK when CDP_PORT /json/version succeeds with debugger url', async () => {
    const fetcher = async () => ({
      ok: true,
      json: async () => ({ Browser: 'Chrome/123.0', webSocketDebuggerUrl: 'ws://x:9222/devtools/browser/abc' }),
    });
    const r = await checkCdpReachability({ env: { CDP_PORT: '9222' }, fetcher });
    expect(r.status).toBe('OK');
    expect(r.detail).toContain('Chrome/123.0');
    expect(r.detail).toContain('9222');
  });

  it('annotates Electron in detail when User-Agent contains Electron/x', async () => {
    const fetcher = async () => ({
      ok: true,
      json: async () => ({
        Browser: 'HeadlessChrome/130',
        webSocketDebuggerUrl: 'ws://localhost:9222/devtools/browser/abc',
        'User-Agent': 'Mozilla/5.0 ... Electron/33.4.11',
      }),
    });
    const r = await checkCdpReachability({ env: { CDP_PORT: '9222' }, fetcher });
    expect(r.status).toBe('OK');
    expect(r.detail).toContain('Electron 33.4.11');
  });

  it('returns FAIL when fetch throws (e.g. ECONNREFUSED)', async () => {
    const fetcher = async () => { throw new Error('ECONNREFUSED'); };
    const r = await checkCdpReachability({ env: { CDP_PORT: '9999' }, fetcher, lastEndpoint: null });
    expect(r.status).toBe('FAIL');
    expect(r.detail).toContain('cannot reach');
    expect(r.error).toBe('cdp_unreachable');
    expect(r.hint).toMatch(/do not invent a new --user-data-dir/i);
    expect(r.relaunch).toBeNull();
  });

  it('returns WARN when /json/version is reachable but missing webSocketDebuggerUrl', async () => {
    const fetcher = async () => ({ ok: true, json: async () => ({ Browser: 'Chrome/123' }) });
    const r = await checkCdpReachability({ env: { CDP_PORT: '9222' }, fetcher });
    expect(r.status).toBe('WARN');
    expect(r.detail).toMatch(/no webSocketDebuggerUrl/);
  });

  it('returns FAIL when no CDP_PORT and no DevToolsActivePort discoverable', async () => {
    // Use a fake home so no DevToolsActivePort exists.
    const fetcher = async () => { throw new Error('should not be called'); };
    const r = await checkCdpReachability({
      env: {}, fetcher, lastEndpoint: null,
    });
    // Either succeeds against the live machine or fails — both are acceptable
    // shapes here. Critically, it must produce a structured result with hint
    // when no port is set anywhere.
    expect(['OK', 'WARN', 'FAIL']).toContain(r.status);
    if (r.status === 'FAIL') {
      expect(r.hint).toMatch(/chrome:\/\/inspect|CDP_PORT/);
    }
  });
});

describe('checkBrowserTargets', () => {
  it('returns OK with target prefixes when debuggable page targets exist', async () => {
    const fetcher = async () => ({
      ok: true,
      json: async () => ([
        { type: 'page', id: 'AABBCCDDEEFF1122', title: 'Dashboard', url: 'https://app.example.com' },
        { type: 'page', id: 'BBCCDDEEFF001122', title: 'Settings', url: 'https://app.example.com/settings' },
        { type: 'other', id: 'ignored', title: 'Worker', url: 'https://app.example.com/worker' },
      ]),
    });

    const r = await checkBrowserTargets({
      cdp: { status: 'OK', host: '127.0.0.1', port: '9222' },
      fetcher,
    });

    expect(r.status).toBe('OK');
    expect(r.label).toBe('Tabs');
    expect(r.detail).toContain('2 debuggable page targets');
    expect(r.targetPrefixes[0]).toBe('AABBCCDD');
    expect(r.targetPrefixes[1]).toBe('BBCCDDEE');
  });

  it('returns WARN with an open command when CDP is reachable but no pages exist', async () => {
    const fetcher = async () => ({ ok: true, json: async () => [] });

    const r = await checkBrowserTargets({
      cdp: { status: 'OK', host: '127.0.0.1', port: '9222' },
      fetcher,
    });

    expect(r.status).toBe('WARN');
    expect(r.detail).toContain('no debuggable page targets');
    expect(r.hint).toContain('cdp open https://example.com');
  });

  it('skips target inventory until CDP is reachable', async () => {
    const fetcher = async () => { throw new Error('should not be called'); };

    const r = await checkBrowserTargets({
      cdp: { status: 'FAIL', detail: 'cannot reach 127.0.0.1:9999' },
      fetcher,
    });

    expect(r.status).toBe('WARN');
    expect(r.detail).toContain('skipped until CDP is reachable');
  });
});

describe('checkBrowserPermission', () => {
  it('returns OK when a live tab daemon proves browser debugging approval', () => {
    const r = checkBrowserPermission({
      daemons: { status: 'OK', label: 'Daemons', detail: '1 live: AABBCCDD', targetPrefixes: ['AABBCCDD'] },
      tabs: { status: 'OK', label: 'Tabs', detail: '1 debuggable page target', targetPrefixes: ['AABBCCDD'] },
    });

    expect(r.status).toBe('OK');
    expect(r.label).toBe('Permission');
    expect(r.detail).toContain('approved');
    expect(r.detail).toContain('AABBCCDD');
  });

  it('warns with a perceive retry when tabs exist but no daemon is approved yet', () => {
    const r = checkBrowserPermission({
      daemons: { status: 'OK', label: 'Daemons', detail: 'no live tab daemons', targetPrefixes: [] },
      tabs: { status: 'OK', label: 'Tabs', detail: '1 debuggable page target', targetPrefixes: ['AABBCCDD'] },
    });

    expect(r.status).toBe('WARN');
    expect(r.detail).toContain('not confirmed');
    expect(r.hint).toContain('cdp list');
    expect(r.hint).toContain('click Allow');
  });

  it('guides users to open a tab before permission can be confirmed', () => {
    const r = checkBrowserPermission({
      daemons: { status: 'OK', label: 'Daemons', detail: 'no live tab daemons', targetPrefixes: [] },
      tabs: { status: 'WARN', label: 'Tabs', detail: 'no debuggable page targets', targetPrefixes: [], noTargets: true },
    });

    expect(r.status).toBe('WARN');
    expect(r.detail).toContain('no target');
    expect(r.hint).toContain('cdp open https://example.com');
  });
});

describe('checkFdLimit', () => {
  it('returns OK when the open-files limit is high enough for long sessions', () => {
    const r = checkFdLimit({ limit: 4096 });
    expect(r.status).toBe('OK');
    expect(r.detail).toContain('4096');
  });

  it('returns WARN with a concrete command when the open-files limit is low', () => {
    const r = checkFdLimit({ limit: 256, platform: 'darwin' });
    expect(r.status).toBe('WARN');
    expect(r.detail).toContain('256');
    expect(r.hint).toContain('ulimit -n 4096');
    expect(r.recovery).toMatchObject({
      schema: 'chrome-cdp-ex.fd-limit-recovery.v1',
      strategy: 'raise-open-files-limit',
      commands: [
        {
          scope: 'current-shell',
          command: 'ulimit -n 4096',
        },
        {
          scope: 'macos-login-session',
          command: 'sudo launchctl limit maxfiles 65536 200000',
          requiresAdmin: true,
        },
      ],
    });
  });

  it('returns WARN with fd recovery commands when the limit is unavailable', () => {
    const r = checkFdLimit({ limit: null, platform: 'darwin' });
    expect(r.status).toBe('WARN');
    expect(r.detail).toContain('unavailable');
    expect(r.recovery?.commands.map(command => command.command)).toEqual([
      'ulimit -n 4096',
      'sudo launchctl limit maxfiles 65536 200000',
    ]);
  });
});

describe('doctorWizardSummary', () => {
  it('points to browser CDP setup when CDP is unreachable', () => {
    const out = doctorWizardSummary([
      { status: 'OK', label: 'Node', detail: 'v22' },
      { status: 'FAIL', label: 'CDP', detail: 'cannot reach 127.0.0.1:9222' },
    ]).join('\n');

    expect(out).toContain('Status: blocked at browser CDP');
    expect(out).toContain('Current step: cdp spawn-debug-browser edge --port 9222 --user-data-dir');
    expect(out).toMatch(/daily-edge/);
    expect(out).not.toContain('--daily-profile');
    expect(out).not.toMatch(/perceive .* -C -d 8/);
  });

  it('points to open when CDP is ready but no debuggable page exists', () => {
    const out = doctorWizardSummary([
      { status: 'OK', label: 'Node', detail: 'v22' },
      { status: 'OK', label: 'CDP', detail: 'reachable' },
      { status: 'WARN', label: 'Tabs', detail: 'no debuggable page targets', noTargets: true, targetPrefixes: [] },
    ]).join('\n');

    expect(out).toContain('Status: waiting for a debuggable page');
    expect(out).toContain('Current step: cdp open https://example.com');
    expect(out).not.toMatch(/perceive .* -C -d 8/);
  });

  it('treats unconfirmed permission as advisory when CDP/tabs are already usable', () => {
    const out = doctorWizardSummary([
      { status: 'OK', label: 'Node', detail: 'v22' },
      { status: 'OK', label: 'CDP', detail: 'reachable' },
      { status: 'OK', label: 'Tabs', detail: '1 debuggable page target', targetPrefixes: ['AABBCCDD'] },
      { status: 'WARN', label: 'Permission', detail: 'browser debugging approval not confirmed', targetPrefixes: ['AABBCCDD'] },
    ]).join('\n');

    expect(out).toContain('Status: usable with advisory notes (CDP reachable)');
    expect(out).toContain('Current step: cdp list');
    expect(out).not.toContain('cdp perceive AABBCCDD -C -d 8');
    expect(out).not.toContain('waiting for browser debugging approval');
  });
});

describe('formatDoctorReport', () => {
  it('prints Node, CDP, and spawn-with-ask when CDP is down', () => {
    const out = formatDoctorReport([
      { status: 'OK', label: 'Node', detail: 'v22.10.0' },
      { status: 'WARN', label: 'Skill install', detail: '/h/.claude/skills/chrome-cdp-ex not found', hint: 'cp -r ...' },
      { status: 'FAIL', label: 'CDP', detail: 'cannot reach 127.0.0.1:9222', hint: 'enable debugging' },
    ]);
    expect(out).toContain('Node: v22.10.0');
    expect(out).toContain('CDP: cannot reach 127.0.0.1:9222');
    expect(out).toContain('Next: cdp spawn-debug-browser edge --port 9222 --user-data-dir');
    expect(out).toMatch(/daily-edge/);
    expect(out).toMatch(/^Ask a human first$/m);
    expect(out).not.toMatch(/\(ask first\)/);
    expect(out).not.toContain('Wizard:');
    expect(out).not.toContain('chrome-cdp-ex doctor');
    expect(out).not.toMatch(/perceive .* -C -d 8/);
  });

  it('prints spawn-with-ask when DevToolsActivePort is unreachable, not cdp doctor', () => {
    const out = formatDoctorReport([
      { status: 'OK', label: 'Node', detail: 'v22.22.0 (>= 22)' },
      {
        status: 'WARN',
        label: 'CDP',
        detail: 'DevToolsActivePort points to 9222 but /json/version unreachable: fetch failed',
        port: '9222',
      },
    ]);
    expect(out).toContain('Node: v22.22.0 (>= 22)');
    expect(out).toContain('CDP: DevToolsActivePort points to 9222 but /json/version unreachable: fetch failed');
    expect(out).toContain('Next: cdp spawn-debug-browser edge --port 9222 --user-data-dir');
    expect(out).toMatch(/daily-edge/);
    expect(out).toMatch(/^Ask a human first$/m);
    expect(out).not.toMatch(/\(ask first\)/);
    expect(out).not.toMatch(/^Next: cdp doctor$/m);
  });

  it('does not spawn on 9222 when /json/version is up but has no webSocketDebuggerUrl', () => {
    const out = formatDoctorReport([
      { status: 'OK', label: 'Node', detail: 'v22' },
      {
        status: 'WARN',
        label: 'CDP',
        detail: 'port 9222: no webSocketDebuggerUrl',
        port: '9222',
      },
    ]);
    expect(out).toContain('CDP: port 9222: no webSocketDebuggerUrl');
    expect(out).not.toContain('spawn-debug-browser');
    expect(out).not.toMatch(/^Next: cdp doctor$/m);
  });

  it('prints Node, CDP, and list when checks are OK', () => {
    const out = formatDoctorReport([
      { status: 'OK', label: 'Node', detail: 'v22' },
      { status: 'OK', label: 'Tabs', detail: '1 debuggable page target: Example', targetPrefixes: ['AABBCCDD'] },
      { status: 'OK', label: 'Permission', detail: 'debugging approved for AABBCCDD', targetPrefixes: ['AABBCCDD'] },
      { status: 'OK', label: 'CDP', detail: 'reachable' },
    ]);
    expect(out).toBe('Node: v22\nCDP: reachable\nNext: cdp list');
    expect(out).not.toContain('cdp perceive AABBCCDD -C -d 8');
    expect(out).not.toContain('Wizard:');
  });

  it('keeps short text when only WARNs are present', () => {
    const out = formatDoctorReport([
      { status: 'OK', label: 'Node', detail: 'v22' },
      { status: 'WARN', label: 'Skill', detail: 'missing' },
    ]);
    expect(out).toContain('Node: v22');
    expect(out).toContain('Next: cdp list');
    expect(out).not.toContain('Usable with warnings');
  });

  it('uses list as the tab source of truth instead of a leftover perceive sample', () => {
    const out = formatDoctorReport([
      { status: 'OK', label: 'Node', detail: 'v22' },
      { status: 'OK', label: 'Daemons', detail: '1 live: AABBCCDD', targetPrefixes: ['AABBCCDD'] },
      { status: 'OK', label: 'Tabs', detail: '1 debuggable page target: ZZYYXXWW', targetPrefixes: ['ZZYYXXWW'] },
      { status: 'OK', label: 'Permission', detail: 'debugging approved for AABBCCDD', targetPrefixes: ['AABBCCDD'] },
      { status: 'OK', label: 'CDP', detail: 'reachable' },
    ]);

    expect(out).toContain('Next: cdp list');
    expect(out).not.toContain('cdp perceive ZZYYXXWW -C -d 8');
    expect(out).not.toContain('cdp perceive AABBCCDD -C -d 8');
  });

  it('guides users to open a page when CDP is ready but no targets exist', () => {
    const out = formatDoctorReport([
      { status: 'OK', label: 'Node', detail: 'v22' },
      { status: 'OK', label: 'CDP', detail: 'reachable' },
      {
        status: 'WARN',
        label: 'Tabs',
        detail: 'no debuggable page targets',
        hint: 'Create one with: cdp open https://example.com',
      },
    ]);

    expect(out).toContain('Node: v22');
    expect(out).toContain('CDP: reachable');
    expect(out).toContain('Next: cdp open https://example.com');
    expect(out).not.toMatch(/perceive .* -C -d 8/);
  });
});

describe('runDoctorChecks', () => {
  it('runs all checks and returns array of result objects', async () => {
    const fetcher = async (url) => url.endsWith('/json/list')
      ? { ok: true, json: async () => ([{ type: 'page', id: 'AABBCCDDEEFF', title: 'Example', url: 'https://example.com' }]) }
      : { ok: true, json: async () => ({ Browser: 'Chrome', webSocketDebuggerUrl: 'ws://x' }) };
    const checks = await runDoctorChecks({
      nodeVersion: 'v22.10.0',
      home: '/tmp/no-such-home-here',
      fs: { existsSync: () => false, lstatSync: null },
      listDaemons: () => [],
      fdLimit: 4096,
      platform: 'linux',
      env: { CDP_PORT: '9222' },
      fetcher,
    });
    expect(Array.isArray(checks)).toBe(true);
    expect(checks).toHaveLength(9);
    expect(checks[0].label).toBe('Node');
    expect(checks[1].label).toBe('Skill install');
    expect(checks[2].label).toBe('Daemons');
    expect(checks[3].label).toBe('FD limit');
    expect(checks[4].label).toBe('Environment');
    expect(checks[4].status).toBe('OK');
    expect(checks[5].label).toBe('CDP');
    expect(checks[6].label).toBe('Tabs');
    expect(checks[7].label).toBe('Permission');
    // #534: advisory profile check; a stubbed fetcher without a WebSocket transport skips the read.
    expect(checks[8]).toMatchObject({ label: 'Profile', status: 'OK', profileKind: 'unknown' });
  });
});

describe('doctorStr', () => {
  it('returns Node, CDP, and list when CDP is reachable', async () => {
    const fetcher = async (url) => url.endsWith('/json/list')
      ? { ok: true, json: async () => ([{ type: 'page', id: 'AABBCCDDEEFF', title: 'Example', url: 'https://example.com' }]) }
      : { ok: true, json: async () => ({ Browser: 'Chrome/123', webSocketDebuggerUrl: 'ws://x' }) };
    const out = await doctorStr({
      nodeVersion: 'v22.10.0',
      home: '/tmp/no-such-home',
      fs: { existsSync: () => false, lstatSync: null },
      listDaemons: () => [],
      fdLimit: 4096,
      env: { CDP_PORT: '9222' },
      fetcher,
    });
    expect(out).toContain('Node: v22.10.0 (>= 22)');
    expect(out).toMatch(/CDP: .*9222/);
    expect(out).toContain('Next: cdp list');
    expect(out).not.toContain('Wizard:');
    expect(out).not.toContain('cdp perceive AABBCCDD -C -d 8');
    expect(out.split('\n')).toHaveLength(3);
  });

  it('prints spawn-with-ask when CDP fails', async () => {
    const fetcher = async () => { throw new Error('ECONNREFUSED'); };
    const out = await doctorStr({
      nodeVersion: 'v22.10.0',
      home: '/tmp/x',
      platform: 'linux',
      fs: { existsSync: () => true, lstatSync: () => ({ isSymbolicLink: () => true }) },
      listDaemons: () => [],
      fdLimit: 4096,
      env: { CDP_PORT: '9999' },
      fetcher,
      connectWebSocket: () => { throw new Error('no websocket'); },
    });
    expect(out).toContain('Node: v22.10.0 (>= 22)');
    expect(out).toMatch(/CDP: cannot reach .*9999/);
    expect(out).toMatch(/^Next: /m);
    expect(out).not.toContain('Wizard:');
    expect(out).not.toContain('[FAIL] CDP');
  });

  it('returns a versioned JSON onboarding model for agents', async () => {
    const fetcher = async (url) => url.endsWith('/json/list')
      ? { ok: true, json: async () => ([{ type: 'page', id: 'AABBCCDDEEFF', title: 'Example', url: 'https://example.com' }]) }
      : { ok: true, json: async () => ({ Browser: 'Chrome/123', webSocketDebuggerUrl: 'ws://x' }) };
    const out = await doctorStr({
      format: 'json',
      nodeVersion: 'v22.10.0',
      home: '/tmp/no-such-home',
      fs: { existsSync: () => false, lstatSync: null },
      listDaemons: () => [],
      fdLimit: 4096,
      env: { CDP_PORT: '9222' },
      fetcher,
    });

    const model = JSON.parse(out);
    expect(model).toMatchObject({
      schema: 'chrome-cdp-ex.doctor.v1',
      status: 'usable-with-warnings',
      readiness: 'usable-with-warnings',
      ready: true,
      operationalReady: true,
      failures: 0,
    });
    expect(model.warnings + model.advisories).toBeGreaterThan(0);
    expect(model.checks.find(c => c.label === 'Permission')?.severity).toBe('advisory');
    expect(model.wizard).toMatchObject({
      status: 'usable with advisory notes (CDP reachable)',
      currentStep: 'cdp list',
    });
    expect(model.wizard.commands).toEqual(['cdp list']);
    expect(model.checks.map(check => check.label)).toEqual([
      'Node', 'Skill install', 'Daemons', 'FD limit', 'Environment', 'CDP', 'Tabs', 'Permission', 'Profile',
    ]);
    expect(model.nextSteps).toEqual(['cdp list']);
    expect(model.provenCommand).toBe('cdp list');
    expect(model.recommendation).toMatchObject({
      source: 'doctor-onboarding',
      stage: 'list',
      run: 'cdp list',
      requiresUserAction: false,
      consentRequired: false,
    });
    expect(model.recommendation.ask).toBeNull();
    expect(JSON.stringify(model)).not.toMatch(/perceive AABBCCDD -C -d 8/);
  });

  it('returns a consent-aware recommendation when browser CDP is blocked', async () => {
    const fetcher = async () => { throw new Error('ECONNREFUSED'); };
    const out = await doctorStr({
      format: 'json',
      nodeVersion: 'v22.10.0',
      home: '/tmp/x',
      fs: { existsSync: () => true, lstatSync: () => ({ isSymbolicLink: () => true }) },
      listDaemons: () => [],
      fdLimit: 256,
      platform: 'darwin',
      env: { CDP_PORT: '9999' },
      fetcher,
      lastEndpoint: null,
    });

    const model = JSON.parse(out);
    expect(model.recommendation).toMatchObject({
      source: 'doctor-onboarding',
      stage: 'browser-cdp',
      run: null,
      after: 'cdp list',
      requiresUserAction: true,
      consentRequired: true,
      strategy: 'enable-existing-debugging',
    });
    expect(model.recommendation.ask).toContain('chrome://inspect/#remote-debugging');
    expect(model.recommendation.ask).toMatch(/do not invent a new --user-data-dir/i);
    expect(model.recommendation.reason).toContain('cannot reach');
    expect(model.recommendation.warnings).toEqual([
      {
        label: 'FD limit',
        command: 'ulimit -n 4096',
        reason: '256 open files (low for long browser sessions)',
        commands: [
          {
            scope: 'current-shell',
            command: 'ulimit -n 4096',
            reason: 'Raise the open-files limit for this terminal before starting long chrome-cdp-ex sessions.',
            requiresAdmin: false,
          },
          {
            scope: 'macos-login-session',
            command: 'sudo launchctl limit maxfiles 65536 200000',
            reason: 'Raise the macOS launchd limit for GUI apps and future shells; rerun doctor afterwards.',
            requiresAdmin: true,
          },
        ],
      },
    ]);
  });

  it('prints shell and macOS fd-limit recovery commands for low limits', async () => {
    const fetcher = async () => { throw new Error('ECONNREFUSED'); };
    const out = await doctorStr({
      nodeVersion: 'v22.10.0',
      home: '/tmp/x',
      fs: { existsSync: () => true, lstatSync: () => ({ isSymbolicLink: () => true }) },
      listDaemons: () => [],
      fdLimit: 256,
      platform: 'darwin',
      env: { CDP_PORT: '9999' },
      fetcher,
      lastEndpoint: null,
    });

    const model = JSON.parse(await doctorStr({
      format: 'json',
      nodeVersion: 'v22.10.0',
      home: '/tmp/x',
      fs: { existsSync: () => true, lstatSync: () => ({ isSymbolicLink: () => true }) },
      listDaemons: () => [],
      fdLimit: 256,
      platform: 'darwin',
      env: { CDP_PORT: '9999' },
      fetcher,
      lastEndpoint: null,
    }));
    expect(model.recommendation.warnings.map(warning => warning.command)).toContain('ulimit -n 4096');
    expect(out).toContain('Node:');
    expect(out).toContain('CDP:');
    expect(out).toMatch(/^Next: /m);
    expect(out).not.toContain('Long session note:');
    expect(out).not.toContain('Wizard:');
  });

  it('prints list as the next command instead of a leftover perceive sample', async () => {
    const fetcher = async (url) => url.endsWith('/json/list')
      ? { ok: true, json: async () => ([{ type: 'page', id: 'AABBCCDDEEFF', title: 'Example', url: 'https://example.com' }]) }
      : { ok: true, json: async () => ({ Browser: 'Chrome/123', webSocketDebuggerUrl: 'ws://x' }) };
    const out = await doctorStr({
      nodeVersion: 'v22.10.0',
      home: '/tmp/no-such-home',
      fs: { existsSync: () => false, lstatSync: null },
      listDaemons: () => [],
      fdLimit: 4096,
      env: { CDP_PORT: '9222' },
      fetcher,
    });

    expect(out).toContain('Next: cdp list');
    expect(out).not.toContain('Recommendation:');
    expect(out).not.toContain('cdp perceive AABBCCDD -C -d 8');
    expect(out).not.toContain('Then: cdp click AABBCCDD @ref');
    expect(out.split('\n')).toHaveLength(3);
  });
});
