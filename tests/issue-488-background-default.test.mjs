// #488: background mode is the default; an explicit opt-out restores the old focusing behaviour,
// and a capture on a hidden tab fails fast with Kind: hidden-tab instead of stalling for 30 s.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
const { classifyActionFailure } = await import('../skills/chrome-cdp-ex/scripts/lib/action-recovery.mjs');

const FOCUS_METHODS = ['Target.activateTarget', 'Page.bringToFront'];
const methodsOf = cdp => cdp.send.mock.calls.map(call => call[0]);
const scratch = () => mkdtempSync(join(tmpdir(), 'cdp-runtime-488-'));

function fakeCdp(responses = {}) {
  const send = vi.fn(async (method, params) => {
    const response = responses[method];
    return typeof response === 'function' ? response(params) : (response ?? {});
  });
  return { connect: vi.fn(async () => {}), close: vi.fn(), send };
}

describe('background mode is the default', () => {
  it('is on with no variable, and on for unknown values', () => {
    expect(T.isBackgroundMode({})).toBe(true);
    expect(T.isBackgroundMode({ CDP_BACKGROUND: '' })).toBe(true);
    expect(T.isBackgroundMode({ CDP_BACKGROUND: 'maybe' })).toBe(true);
    expect(T.explicitBackgroundChoice({})).toBe(null);
  });

  it('CDP_BACKGROUND=0/false/no/off and CDP_FOREGROUND=1 turn it off', () => {
    for (const value of ['0', 'false', 'NO', ' off ']) {
      expect(T.isBackgroundMode({ CDP_BACKGROUND: value }), value).toBe(false);
      expect(T.explicitBackgroundChoice({ CDP_BACKGROUND: value }), value).toBe(false);
    }
    expect(T.isBackgroundMode({ CDP_FOREGROUND: '1' })).toBe(false);
    expect(T.isBackgroundMode({ CDP_FOREGROUND: '0' })).toBe(true);
    // An opt-out is never ignored, even next to CDP_BACKGROUND=1.
    expect(T.isBackgroundMode({ CDP_BACKGROUND: '1', CDP_FOREGROUND: 'true' })).toBe(false);
    expect(T.explicitBackgroundChoice({ CDP_BACKGROUND: 'yes' })).toBe(true);
  });

  it('a daemon attach with no variable sends no Target.activateTarget', async () => {
    const runtimeDir = scratch();
    const background = T.daemonBackgroundMode('TAB', { env: {}, runtimeDir });
    expect(background).toBe(true);
    const cdp = fakeCdp({ 'Target.attachToTarget': { sessionId: 'S1' } });
    await T.attachDaemonTarget(cdp, 'TAB', { background });
    expect(methodsOf(cdp)).toEqual(['Target.attachToTarget']);
    rmSync(runtimeDir, { recursive: true, force: true });
  });

  it('CDP_BACKGROUND=0 or CDP_FOREGROUND=1 restores the activating attach', async () => {
    const runtimeDir = scratch();
    for (const env of [{ CDP_BACKGROUND: '0' }, { CDP_FOREGROUND: '1' }]) {
      const background = T.daemonBackgroundMode('TAB', { env, runtimeDir });
      expect(background).toBe(false);
      const cdp = fakeCdp({ 'Target.attachToTarget': { sessionId: 'S1' } });
      await T.attachDaemonTarget(cdp, 'TAB', { background });
      expect(methodsOf(cdp)).toEqual(['Target.activateTarget', 'Target.attachToTarget']);
    }
    rmSync(runtimeDir, { recursive: true, force: true });
  });
});

describe('open', () => {
  it('opens in the background by default; --foreground and the env opt-outs restore focus', () => {
    expect(T.parseOpenArgs(['https://example.test/'], {})).toMatchObject({ background: true, backgroundExplicit: false });
    expect(T.parseOpenArgs(['https://example.test/', '--foreground'], {})).toMatchObject({ background: false, backgroundExplicit: true });
    expect(T.parseOpenArgs(['https://example.test/'], { CDP_BACKGROUND: '0' })).toMatchObject({ background: false, backgroundExplicit: true });
    expect(T.parseOpenArgs(['https://example.test/'], { CDP_FOREGROUND: '1' }).background).toBe(false);
    // The flag on the command line beats the environment.
    expect(T.parseOpenArgs(['https://example.test/', '--background'], { CDP_FOREGROUND: '1' })).toMatchObject({ background: true, backgroundExplicit: true });
    expect(T.parseOpenArgs(['https://example.test/', '--foreground'], { CDP_BACKGROUND: '1' }).background).toBe(false);
  });

  it('with no variable, open creates an unfocused window and its navigate fallback sends no focus call', async () => {
    const { background } = T.parseOpenArgs(['https://example.test/'], {});
    const create = fakeCdp({ 'Target.createTarget': { targetId: 'NEW' } });
    await T.createOpenTarget(create, { background });
    expect(create.send.mock.calls).toEqual([['Target.createTarget', { url: 'about:blank', newWindow: true, background: true }]]);
    const nav = fakeCdp({ 'Target.attachToTarget': { sessionId: 'NAV' }, 'Page.navigate': { loaderId: 'L' } });
    await T.navigateOpenTarget('NEW', '/tmp/unused.sock', 'https://example.test/', {
      createCdp: () => nav,
      getWsUrlFn: async () => 'ws://127.0.0.1/devtools/browser/x',
      waitForOpenTargetUrlFn: async () => ({ ok: false, href: null }),
      background,
    });
    for (const method of FOCUS_METHODS) expect(methodsOf(nav)).not.toContain(method);
  });

  it('open --foreground creates a focused tab and activates it in the navigate fallback', async () => {
    const { background } = T.parseOpenArgs(['https://example.test/', '--foreground'], {});
    const create = fakeCdp({ 'Target.createTarget': { targetId: 'NEW' } });
    await T.createOpenTarget(create, { background });
    expect(create.send.mock.calls).toEqual([['Target.createTarget', { url: 'about:blank' }]]);
    const nav = fakeCdp({ 'Target.attachToTarget': { sessionId: 'NAV' }, 'Page.navigate': { loaderId: 'L' } });
    await T.navigateOpenTarget('NEW', '/tmp/unused.sock', 'https://example.test/', {
      createCdp: () => nav,
      getWsUrlFn: async () => 'ws://127.0.0.1/devtools/browser/x',
      waitForOpenTargetUrlFn: async () => ({ ok: false, href: null }),
      background,
    });
    expect(methodsOf(nav)[0]).toBe('Target.activateTarget');
  });

  it('passes the chosen mode to the tab daemon it starts', () => {
    const env = { PATH: '/bin', CDP_FOREGROUND: '1' };
    expect(T.backgroundDaemonEnv(true, env)).toEqual({ PATH: '/bin', CDP_BACKGROUND: '1' });
    expect(T.backgroundDaemonEnv(false, { PATH: '/bin' })).toEqual({ PATH: '/bin', CDP_BACKGROUND: '0' });
    expect(env).toEqual({ PATH: '/bin', CDP_FOREGROUND: '1' });
  });
});

describe('per-tab mode record keeps an explicit choice across daemon restarts (#441)', () => {
  it('open --foreground records foreground, so a daemon restarted with no variable still activates', () => {
    const runtimeDir = scratch();
    expect(T.writeTabBackgroundMode('FG', { runtimeDir, background: false })).toBe(true);
    expect(T.readTabMode('FG', { runtimeDir })).toBe(false);
    expect(T.readTabBackgroundMode('FG', { runtimeDir })).toBe(false);
    expect(T.daemonBackgroundMode('FG', { env: {}, runtimeDir })).toBe(false);
    // No record: the default.
    expect(T.readTabMode('OTHER', { runtimeDir })).toBe(null);
    expect(T.daemonBackgroundMode('OTHER', { env: {}, runtimeDir })).toBe(true);
    rmSync(runtimeDir, { recursive: true, force: true });
  });

  it('an explicit choice in the environment beats the record', () => {
    const runtimeDir = scratch();
    T.writeTabBackgroundMode('BG', { runtimeDir });
    T.writeTabBackgroundMode('FG', { runtimeDir, background: false });
    expect(T.daemonBackgroundMode('BG', { env: { CDP_BACKGROUND: '0' }, runtimeDir })).toBe(false);
    expect(T.daemonBackgroundMode('FG', { env: { CDP_BACKGROUND: '1' }, runtimeDir })).toBe(true);
    expect(T.daemonBackgroundMode('BG', { env: {}, runtimeDir })).toBe(true);
    rmSync(runtimeDir, { recursive: true, force: true });
  });
});

describe('explicit foreground on a call brings a hidden tab forward first', () => {
  it('asks the daemon to activate only when the call opts out', () => {
    expect(T.foregroundActivationRequest({})).toBe(null);
    expect(T.foregroundActivationRequest({ CDP_BACKGROUND: '1' })).toBe(null);
    expect(T.foregroundActivationRequest({ CDP_BACKGROUND: '0' })).toEqual({ cmd: '_activate', args: [] });
    expect(T.foregroundActivationRequest({ CDP_FOREGROUND: '1' })).toEqual({ cmd: '_activate', args: [] });
  });

  const visibilityCdp = (states) => {
    const queue = [...states];
    return fakeCdp({
      'Runtime.evaluate': () => ({ result: { value: queue.length > 1 ? queue.shift() : queue[0] } }),
    });
  };

  it('leaves a visible tab alone (no focus call)', async () => {
    const cdp = visibilityCdp(['visible']);
    await expect(T.revealHiddenTab(cdp, 'S1', 'TAB', { sleep: async () => {} })).resolves.toMatchObject({ activated: false, visibility: 'visible' });
    for (const method of FOCUS_METHODS) expect(methodsOf(cdp)).not.toContain(method);
  });

  it('activates a hidden tab and waits until it reports visible', async () => {
    const cdp = visibilityCdp(['hidden', 'hidden', 'visible']);
    await expect(T.revealHiddenTab(cdp, 'S1', 'TAB', { sleep: async () => {} })).resolves.toMatchObject({ activated: true, visibility: 'visible' });
    expect(cdp.send.mock.calls.find(call => call[0] === 'Target.activateTarget')[1]).toEqual({ targetId: 'TAB' });
  });
});

describe('hidden-tab fast failure for captures', () => {
  afterEach(() => T.setBackgroundCaptureGuard(false));

  const captureCdp = ({ visibility = 'hidden', capture = 'timeout' } = {}) => fakeCdp({
    'Runtime.evaluate': params => (String(params.expression).includes('visibilityState')
      ? { result: { value: visibility } }
      : { result: { value: JSON.stringify({ retry: false }) } }),
    'Page.captureScreenshot': () => {
      if (capture === 'timeout') throw new Error('Timeout: Page.captureScreenshot');
      return { data: 'FRAME' };
    },
  });
  const captureCalls = cdp => cdp.send.mock.calls.filter(call => call[0] === 'Page.captureScreenshot');

  it('fails with a hidden-tab error after one bounded attempt, with no fallback tier', async () => {
    T.setBackgroundCaptureGuard(true);
    const cdp = captureCdp();
    const error = await T.captureScreenshot(cdp, 'S1', { format: 'png' }).catch(e => e);
    expect(T.isHiddenTabCaptureError(error)).toBe(true);
    expect(error.message).toMatch(/visibilityState=hidden/);
    const calls = captureCalls(cdp);
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toEqual({ format: 'png' });
    expect(calls[0][3]).toBe(T.HIDDEN_TAB_CAPTURE_TIMEOUT_MS);
    expect(T.HIDDEN_TAB_CAPTURE_TIMEOUT_MS).toBeLessThan(T.SCREENSHOT_TIMEOUT);
  });

  it('keeps a frame a hidden tab does render, without the fromSurface:false retry (wrong window pixels)', async () => {
    T.setBackgroundCaptureGuard(true);
    const cdp = captureCdp({ capture: 'ok' });
    await expect(T.captureScreenshot(cdp, 'S1', { format: 'png' })).resolves.toMatchObject({ data: 'FRAME', fallback: false, hiddenTab: true });
    expect(captureCalls(cdp)).toHaveLength(1);
  });

  it('a visible tab takes the unchanged path', async () => {
    T.setBackgroundCaptureGuard(true);
    const cdp = captureCdp({ visibility: 'visible', capture: 'ok' });
    const result = await T.captureScreenshot(cdp, 'S1', { format: 'png' });
    expect(result.hiddenTab).toBeUndefined();
    expect(captureCalls(cdp)[0][3]).toBe(T.SCREENSHOT_TIMEOUT);
  });

  it('foreground mode (guard off) does not even read visibility', async () => {
    const cdp = captureCdp({ capture: 'ok' });
    await T.captureScreenshot(cdp, 'S1', { format: 'png' });
    const reads = cdp.send.mock.calls.filter(call => call[0] === 'Runtime.evaluate' && String(call[1].expression).includes('visibilityState'));
    expect(reads).toHaveLength(0);
  });

  it('shot on a hidden tab surfaces the hidden-tab error, not a timeout', async () => {
    T.setBackgroundCaptureGuard(true);
    const cdp = captureCdp();
    const error = await T.shotStr(cdp, 'S1', null, 'TARGET488').catch(e => e);
    expect(T.isHiddenTabCaptureError(error)).toBe(true);
  });
});

describe('Kind: hidden-tab recovery', () => {
  it('reruns the same command with CDP_BACKGROUND=0', () => {
    const message = T.hiddenTabCaptureError().message;
    const recovery = T.buildCliErrorRecovery(message, { cmd: 'shot', targetPrefix: 'ABCD1234', args: ['/tmp/out.png'] });
    expect(recovery).toMatchObject({ kind: 'hidden-tab', run: 'CDP_BACKGROUND=0 cdp shot ABCD1234 /tmp/out.png' });
    const text = T.formatCliError(new Error(message), { cmd: 'elshot', targetPrefix: 'ABCD1234', args: ['#hero'] });
    expect(text).toMatch(/Kind: hidden-tab/);
    expect(text).toMatch(/^Next: CDP_BACKGROUND=0 cdp elshot ABCD1234 "#hero" \(Kind: hidden-tab\)$/m);
  });

  it('a daemon error printed by the CLI keeps the command arguments in Next', () => {
    const errors = [];
    const proc = { exitCode: 0 };
    T.emitTargetCommandResponse({ ok: false, error: T.hiddenTabCaptureError().message }, {
      cmd: 'shot',
      targetPrefix: 'ABCD1234',
      args: ['/tmp/out.png'],
      console: { log: () => {}, error: line => errors.push(line) },
      process: proc,
    });
    expect(errors.join('\n')).toMatch(/^Next: CDP_BACKGROUND=0 cdp shot ABCD1234 \/tmp\/out\.png \(Kind: hidden-tab\)$/m);
    expect(proc.exitCode).toBe(1);
  });
});

describe('no-input-events on a hidden tab names the opt-out', () => {
  it('mentions CDP_BACKGROUND=0 in the CLI recovery and the action receipt hint', () => {
    const message = 'click: Input.dispatchMouseEvent completed but the page received no mousedown/click events at (1, 2). The mouse path failed closed. Try jsclick or click --js. The tab\'s document.visibilityState is hidden (window covered or minimised): Input.* events are dropped while hidden, so retrying the mouse path will not help.';
    const recovery = T.buildCliErrorRecovery(message, { cmd: 'click', targetPrefix: 'ABCD1234', args: ['#send'] });
    expect(recovery.reason).toMatch(/CDP_BACKGROUND=0/);
    const failure = classifyActionFailure(new Error(message), { action: 'click', target: { targetId: 'ABCD1234', input: '#send' } });
    expect(failure.hints.join(' ')).toMatch(/CDP_BACKGROUND=0/);
  });
});

describe('spawn-debug-browser keeps --background explicit', () => {
  const THROTTLE_FLAGS = [
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
  ];
  const fs = { existsSync: () => true, mkdirSync: () => {} };
  const plan = (args, env = { TMPDIR: '/tmp' }) =>
    T.buildSpawnDebugBrowserPlan(T.parseSpawnDebugBrowserArgs(['chrome', '--exe', '/x/chrome', ...args], env), 'linux', fs, env);

  it('the default does not add anti-throttling flags or minimize the window', () => {
    const off = plan([]);
    expect(off.background).toBe(false);
    // The occluded-windows flag is a spawn default of its own (see below); the throttling ones are not.
    for (const flag of THROTTLE_FLAGS.slice(1)) expect(off.args).not.toContain(flag);
    expect(plan([], { TMPDIR: '/tmp', CDP_BACKGROUND: '1' }).background).toBe(true);
    expect(plan(['--background']).background).toBe(true);
  });

  it('the next command after a minimized spawn is a plain open (background is the default)', () => {
    const base = { port: 9341, profileDir: '/tmp/p', browser: 'chrome', host: '127.0.0.1' };
    expect(T.buildSpawnDebugBrowserModel({ ...base, background: true, headless: false }, { ok: true }, { target: { targetId: 'PAGE1ABCDEF' } }).nextCommand)
      .toBe('CDP_PORT=9341 cdp open <url>');
  });
});

// Review of #499.
describe('hidden-tab recovery never replays steps that already ran', () => {
  const message = () => T.hiddenTabCaptureError().message;

  it('a composite command names the capture alone', () => {
    for (const [cmd, args] of [
      ['flow', ['click #buy; shot']],
      ['repeat', ['2', 'shot']],
      ['replay', ['--file', '/tmp/actions.json']],
      ['batch', ['click #buy | shot']],
    ]) {
      const recovery = T.buildCliErrorRecovery(message(), { cmd, targetPrefix: 'ABCD1234', args });
      expect(recovery.kind, cmd).toBe('hidden-tab');
      expect(recovery.run, cmd).toBe('CDP_BACKGROUND=0 cdp shot ABCD1234');
      expect(recovery.reason, cmd).toMatch(/do not rerun the whole command/i);
    }
    const text = T.formatCliError(new Error(`Flow halted at step 2/2: ${message()}`), { cmd: 'flow', targetPrefix: 'ABCD1234', args: ['click #buy; shot'] });
    expect(text).toMatch(/^Next: CDP_BACKGROUND=0 cdp shot ABCD1234 \(Kind: hidden-tab\)$/m);
    expect(text).not.toMatch(/Next: .*click #buy/);
  });

  it('a capture command (or its alias) is rerun whole', () => {
    expect(T.buildCliErrorRecovery(message(), { cmd: 'screenshot', targetPrefix: 'ABCD1234', args: ['/tmp/a.png'] }).run)
      .toBe('CDP_BACKGROUND=0 cdp screenshot ABCD1234 /tmp/a.png');
    expect(T.buildCliErrorRecovery(message(), { cmd: 'diff-shot', targetPrefix: 'ABCD1234', args: ['--reset'] }).run)
      .toBe('CDP_BACKGROUND=0 cdp diff-shot ABCD1234 --reset');
  });

  it('says a hidden tab may get no frames', () => {
    expect(message()).toMatch(/may render no frames/);
  });
});

describe('_activate is internal: no composite step can reach it', () => {
  it('is blocked in batch, repeat, replay and flow', () => {
    expect(T.BATCH_BLOCKED.has('_activate')).toBe(true);
    expect(T.REPEAT_BLOCKED.has('_activate')).toBe(true);
    expect(T.REPLAY_BLOCKED.has('_activate')).toBe(true);
    expect(() => T.parseRepeatArgs(['2', '_activate'])).toThrow(/cannot wrap "_activate"/);
    expect(() => T.parseFlowSteps('click #a; _activate')).toThrow(/internal/);
    expect(T.replayStepFromAction({ replayable: true, command: ['_activate'] }))
      .toMatchObject({ skip: true, reason: 'blocked command: _activate' });
  });
});

describe('_activate does not wait again where activation cannot help', () => {
  const sequenceCdp = (states) => {
    const queue = [...states];
    return fakeCdp({ 'Runtime.evaluate': () => ({ result: { value: queue.length > 1 ? queue.shift() : queue[0] } }) });
  };

  it('polls at most REVEAL_POLL_TIMEOUT_MS, and skips the wait after an activation left the tab hidden', async () => {
    const state = { activationIneffective: false };
    let clock = 0;
    const timing = { now: () => clock, sleep: async ms => { clock += ms; } };
    await expect(T.revealHiddenTab(sequenceCdp(['hidden']), 'S1', 'TAB', { state, ...timing }))
      .resolves.toMatchObject({ activated: true, visibility: 'hidden', polled: true });
    expect(T.REVEAL_POLL_TIMEOUT_MS).toBeLessThanOrEqual(300);
    expect(clock).toBeLessThanOrEqual(T.REVEAL_POLL_TIMEOUT_MS + 50);
    expect(state.activationIneffective).toBe(true);
    clock = 0;
    const second = sequenceCdp(['hidden']);
    await expect(T.revealHiddenTab(second, 'S1', 'TAB', { state, ...timing }))
      .resolves.toMatchObject({ activated: true, polled: false });
    expect(clock).toBe(0);
    // Once the tab reports visible again, the next activation waits as usual.
    await T.revealHiddenTab(sequenceCdp(['visible']), 'S1', 'TAB', { state, ...timing });
    expect(state.activationIneffective).toBe(false);
  });
});

describe('covered windows keep rendering: --disable-backgrounding-occluded-windows', () => {
  const OCCLUDED = '--disable-backgrounding-occluded-windows';
  const fs = { existsSync: () => true, mkdirSync: () => {} };
  const plan = args => T.buildSpawnDebugBrowserPlan(
    T.parseSpawnDebugBrowserArgs(['chrome', '--exe', '/x/chrome', ...args], { TMPDIR: '/tmp' }), 'linux', fs, { TMPDIR: '/tmp' });

  it('spawn-debug-browser passes it by default, without the throttling flags; --allow-occlusion drops it', () => {
    const args = plan([]).args;
    expect(args).toContain(OCCLUDED);
    expect(args).not.toContain('--disable-renderer-backgrounding');
    expect(args).not.toContain('--disable-background-timer-throttling');
    expect(plan(['--allow-occlusion']).args).not.toContain(OCCLUDED);
    expect(plan(['--background']).args.filter(flag => flag === OCCLUDED)).toHaveLength(1);
  });

  it('the flag alone maps to the spawn default in relaunch hints, never to --background', () => {
    const entry = { port: '9342', profileDir: '/home/me/p', exe: '/opt/chrome', browser: 'chrome', via: 'spawn-debug-browser' };
    expect(T.formatCdpRelaunchCommand({ ...entry, launchFlags: [OCCLUDED] }))
      .toBe('cdp spawn-debug-browser chrome --port 9342 --profile-dir /home/me/p --exe /opt/chrome');
    // A hand-launched daily browser keeps the flag on its raw relaunch line.
    expect(T.formatCdpRelaunchCommand({ port: '9222', profileDir: '/home/me/daily', exe: '/opt/chrome', launchFlags: [OCCLUDED] }))
      .toBe(`/opt/chrome --remote-debugging-port=9222 --user-data-dir=/home/me/daily ${OCCLUDED}`);
  });
});
