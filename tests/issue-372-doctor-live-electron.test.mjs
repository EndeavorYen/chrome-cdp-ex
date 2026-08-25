import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

const LIVE_PREFIX = 'AABBCCDD';

function chromeEnvironmentCheck() {
  return {
    status: 'OK',
    label: 'Environment',
    detail: 'darwin, display available',
    environment: {
      preferredBrowser: {
        browser: 'chrome',
        executable: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        major: 139,
      },
    },
  };
}

function liveElectronDoctorChecks() {
  return [
    { status: 'OK', label: 'Node', detail: 'v22' },
    chromeEnvironmentCheck(),
    { status: 'OK', label: 'Daemons', detail: `1 live: ${LIVE_PREFIX}`, targetPrefixes: [LIVE_PREFIX] },
    { status: 'FAIL', label: 'CDP', detail: 'no DevToolsActivePort and no CDP_PORT set' },
    { status: 'WARN', label: 'Tabs', detail: 'skipped until CDP is reachable', targetPrefixes: [] },
    {
      status: 'OK',
      label: 'Permission',
      detail: `debugging approved for ${LIVE_PREFIX}`,
      targetPrefixes: [LIVE_PREFIX],
    },
  ];
}

function mentionsOccupy9222(text) {
  return /spawn-debug-browser[^\n]*--port 9222/i.test(String(text || ''));
}

describe('#372 doctor must not occupy 9222 while a live Electron tab daemon exists', () => {
  it('does not recommend spawn --port 9222 when a live tab daemon already exists', () => {
    const checks = liveElectronDoctorChecks();
    const model = T.buildDoctorModel(checks);
    const wizard = T.doctorWizardModel(checks);
    const report = T.formatDoctorReport(checks);
    const recText = [
      model.recommendation.run,
      model.recommendation.ask,
      model.recommendation.after,
      model.provenCommand,
      wizard.currentStep,
      report,
      ...(model.nextSteps || []),
    ].join('\n');

    expect(mentionsOccupy9222(recText)).toBe(false);
    expect(model.recommendation.run).not.toMatch(/spawn-debug-browser/);
    expect(wizard.currentStep).not.toMatch(/spawn-debug-browser/);
    expect(report).not.toMatch(/spawn-debug-browser[^\n]*--port 9222/);
  });

  it('acknowledges the live session or tells the operator to set CDP_PORT', () => {
    const checks = liveElectronDoctorChecks();
    const model = T.buildDoctorModel(checks);
    const wizard = T.doctorWizardModel(checks);
    const report = T.formatDoctorReport(checks);
    const recText = [
      model.recommendation.run,
      model.recommendation.ask,
      model.recommendation.reason,
      model.provenCommand,
      wizard.currentStep,
      wizard.status,
      report,
    ].join('\n');

    expect(recText).toMatch(/CDP_PORT=<port> cdp doctor|CDP_PORT=<port> cdp list|cdp perceive AABBCCDD/);
    expect(model.readiness).not.toBe('blocked');
    expect(model.operationalReady || model.readiness === 'usable-with-warnings').toBe(true);
  });

  it('keeps empty-9222 daily-profile advice when no tab daemon is live', () => {
    const checks = [
      { status: 'OK', label: 'Node', detail: 'v22' },
      chromeEnvironmentCheck(),
      { status: 'OK', label: 'Daemons', detail: 'no live tab daemons', targetPrefixes: [] },
      { status: 'FAIL', label: 'CDP', detail: 'no DevToolsActivePort and no CDP_PORT set' },
    ];
    const model = T.buildDoctorModel(checks);
    expect(model.recommendation.run).toMatch(/spawn-debug-browser chrome --port 9222/);
    expect(model.readiness).toBe('blocked');
  });

  it('runDoctorChecks / doctorStr stay usable and skip 9222 spawn when a daemon is live', async () => {
    const fetcher = async (url) => {
      const err = new Error(`connect ECONNREFUSED ${url}`);
      err.code = 'ECONNREFUSED';
      throw err;
    };
    const opts = {
      nodeVersion: 'v22.10.0',
      home: '/tmp/chrome-cdp-ex-no-devtools-home',
      fs: { existsSync: () => false, lstatSync: null },
      listDaemons: () => [{ targetId: `${LIVE_PREFIX}EEFF001122334455` }],
      fdLimit: 4096,
      platform: 'darwin',
      env: {},
      lastEndpoint: null,
      fetcher,
    };

    const checks = await T.runDoctorChecks(opts);
    const cdp = checks.find(c => c.label === 'CDP');
    const daemons = checks.find(c => c.label === 'Daemons');
    const model = T.buildDoctorModel(checks);
    const out = await T.doctorStr(opts);

    expect(daemons.detail).toMatch(/1 live: AABBCCDD/i);
    expect(cdp.status).not.toBe('FAIL');
    expect(model.readiness).not.toBe('blocked');
    expect(model.recommendation.run).not.toMatch(/spawn-debug-browser/);
    expect(out).not.toMatch(/spawn-debug-browser[^\n]*--port 9222/);
    expect(`${model.recommendation.run}\n${model.recommendation.ask || ''}\n${out}`).toMatch(
      /CDP_PORT=<port> cdp doctor|CDP_PORT=<port> cdp list|cdp perceive AABBCCDD/,
    );
  });
});
