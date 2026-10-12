import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

describe('issue #157 Node 22 discovery', () => {
  const hermesBinary = '/home/box/.hermes/node/bin/node';
  const cdpScriptPath = '/repo/skills/chrome-cdp-ex/scripts/cdp.mjs';
  const isolatedFs = {
    existsSync: () => false,
    readdirSync: () => [],
    readFileSync: () => '',
  };
  const isolatedSpawn = () => ({ status: 1, stdout: '' });

  function hermesDiscoverOpts(extra = {}) {
    return {
      home: '/home/box',
      env: {},
      execPath: '/usr/bin/node',
      cdpScriptPath,
      fs: {
        existsSync: path => path === hermesBinary,
        readdirSync: () => [],
        readFileSync: () => '',
      },
      spawnSync: (bin) => {
        if (bin === hermesBinary) return { status: 0, stdout: 'v22.23.2\n' };
        return { status: 1, stdout: '' };
      },
      ...extra,
    };
  }

  it('discovers Hermes Node 22 when PATH runtime is v20', () => {
    const found = T.discoverNode22(hermesDiscoverOpts());
    expect(found).toMatchObject({
      binary: hermesBinary,
      version: 'v22.23.2',
    });
  });

  it('checkNode with v20 + Hermes Node 22 is WARN with recommendedBinary, not a blocking FAIL', () => {
    const result = T.checkNode('v20.19.2', hermesDiscoverOpts());
    expect(result.status).toBe('WARN');
    expect(result.recommendedBinary).toBe(hermesBinary);
    expect(result.detail).toContain('v20.19.2 (runtime)');
    expect(result.detail).toContain(hermesBinary);
    expect(result.hint).toBe(`Rerun: ${hermesBinary} ${cdpScriptPath} doctor`);

    const model = T.buildDoctorModel([
      result,
      { status: 'OK', label: 'CDP', detail: 'reachable' },
      { status: 'OK', label: 'Tabs', detail: '1', targetPrefixes: ['AABBCCDD'] },
      { status: 'OK', label: 'Permission', detail: 'approved', targetPrefixes: ['AABBCCDD'] },
    ]);
    expect(model).toMatchObject({
      ready: true,
      operationalReady: true,
      failures: 0,
    });
    expect(model.wizard.status).not.toMatch(/blocked at Node/i);
    expect(model.provenCommand).toContain(hermesBinary);
    expect(model.provenCommand).toContain(cdpScriptPath);
    expect(T.doctorNextSteps([
      result,
      { status: 'OK', label: 'CDP', detail: 'reachable' },
      { status: 'OK', label: 'Tabs', detail: '1', targetPrefixes: ['AABBCCDD'] },
    ]).join('\n')).toContain(hermesBinary);
  });

  it('provenCommand uses discovered Node 22 when Permission is WARN (first-run, no daemon)', () => {
    const node = T.checkNode('v20.19.2', hermesDiscoverOpts());
    const model = T.buildDoctorModel([
      node,
      { status: 'OK', label: 'CDP', detail: 'reachable' },
      { status: 'OK', label: 'Tabs', detail: '1', targetPrefixes: ['AABBCCDD'] },
      {
        status: 'WARN',
        label: 'Permission',
        detail: 'browser debugging approval not confirmed for AABBCCDD',
        hint: 'Run: cdp list; if Chrome asks "Allow debugging?", click Allow',
        severity: 'advisory',
        provenCommand: 'cdp list',
        nextProbe: 'cdp list',
        targetPrefixes: ['AABBCCDD'],
      },
    ]);
    expect(model.provenCommand).toContain(hermesBinary);
    expect(model.provenCommand).toContain(cdpScriptPath);
    expect(model.provenCommand).toContain('list');
    expect(model.provenCommand).not.toMatch(/perceive AABBCCDD/);
    expect(model.provenCommand).not.toMatch(/^cdp /);
  });

  it('doctor ask and currentStep use the Node 22 prefix instead of bare cdp doctor/list', () => {
    const node = T.checkNode('v20.19.2', hermesDiscoverOpts());
    const model = T.buildDoctorModel([
      node,
      { status: 'FAIL', label: 'CDP', detail: 'cannot reach 127.0.0.1:9222' },
    ]);
    expect(model.wizard.currentStep).toContain(hermesBinary);
    expect(model.wizard.currentStep).not.toMatch(/\bcdp doctor\b/);
    expect(model.recommendation.ask).toContain(hermesBinary);
    expect(model.recommendation.ask).not.toMatch(/\bcdp doctor\b/);
    expect(model.recommendation.after).toContain(hermesBinary);
    expect(model.recommendation.after).not.toMatch(/^cdp /);
  });

  it('checkNode with v20 and no candidates stays FAIL and blocked', () => {
    const result = T.checkNode('v20.19.2', {
      home: '/home/box',
      env: {},
      execPath: '/usr/bin/node',
      cdpScriptPath,
      fs: isolatedFs,
      spawnSync: isolatedSpawn,
    });
    expect(result.status).toBe('FAIL');
    expect(result.recommendedBinary).toBeFalsy();
    expect(result.hint).not.toMatch(/install Node\.js 22\+/i);
    expect(result.hint).toMatch(/PATH|Hermes|fnm|nvm/i);

    const model = T.buildDoctorModel([
      result,
      { status: 'OK', label: 'CDP', detail: 'reachable' },
      { status: 'OK', label: 'Tabs', detail: '1', targetPrefixes: ['AABBCCDD'] },
    ]);
    expect(model.ready).toBe(false);
    expect(model.operationalReady).toBe(false);
    expect(model.wizard.status).toMatch(/blocked at Node/i);
    expect(T.doctorNextSteps([result]).join('\n')).not.toMatch(/install Node\.js 22\+/i);
  });

  it('checkNode with v22 is OK and does not probe other binaries', () => {
    const result = T.checkNode('v22.23.2', {
      execPath: hermesBinary,
      spawnSync: () => {
        throw new Error('should not probe Node 22 candidates');
      },
    });
    expect(result.status).toBe('OK');
    expect(result.recommendedBinary).toBeFalsy();
  });

  it('bin re-exec helper spawns the discovered Node 22 binary with original args', () => {
    const decision = T.resolveChromeCdpNodeLaunch({
      version: 'v20.19.2',
      execPath: '/usr/bin/node',
      argv: ['/usr/bin/node', '/repo/bin/chrome-cdp', 'doctor', '--format', 'json'],
      scriptPath: cdpScriptPath,
      env: {},
      discover: () => ({ binary: hermesBinary, version: 'v22.23.2' }),
    });
    expect(decision).toMatchObject({
      action: 'reexec',
      binary: hermesBinary,
    });
    expect(decision.args).toEqual(['/repo/bin/chrome-cdp', 'doctor', '--format', 'json']);
    expect(decision.env.CHROME_CDP_NODE_REEXEC).toBe('1');
  });

  it('bin re-exec helper keeps the current binary on Node 22 and does not reexec', () => {
    const decision = T.resolveChromeCdpNodeLaunch({
      version: 'v22.23.2',
      execPath: hermesBinary,
      argv: [hermesBinary, '/repo/bin/chrome-cdp', 'list'],
      scriptPath: cdpScriptPath,
      env: {},
      discover: () => {
        throw new Error('should not discover when already on Node 22');
      },
    });
    expect(decision).toMatchObject({
      action: 'use-current',
      binary: hermesBinary,
    });
  });

  it('bin re-exec helper fails closed when Node 20 has no Node 22 candidate', () => {
    const decision = T.resolveChromeCdpNodeLaunch({
      version: 'v20.19.2',
      execPath: '/usr/bin/node',
      argv: ['/usr/bin/node', '/repo/bin/chrome-cdp', 'doctor'],
      scriptPath: cdpScriptPath,
      env: {},
      discover: () => null,
    });
    expect(decision.action).toBe('fail');
    expect(decision.message).not.toMatch(/install Node\.js 22\+/i);
    expect(decision.message).toMatch(/PATH|Hermes|fnm|nvm/i);
  });
});
