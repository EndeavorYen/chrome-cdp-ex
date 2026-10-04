import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
const { CDP_METHODS } = await import('../skills/chrome-cdp-ex/scripts/lib/cdp-domains.mjs');

function recordingCdp() {
  const calls = [];
  return {
    calls,
    send(method, params = {}) {
      calls.push({ method, params });
      return Promise.resolve({});
    },
  };
}

const session = () => T.createSessionState({ targetId: 'ABCDEF0123456789ABCDEF0123456789', sessionId: 'sid' });

describe('#536 emulate --focus', () => {
  it('T1: --focus parses and enables focus emulation', async () => {
    expect(T.parseEmulateArgs(['--focus'])).toMatchObject({ mode: 'set', focus: true });
    const cdp = recordingCdp();
    await T.emulateStr(cdp, 'sid', session(), ['--focus'], { targetPrefix: 'ABCDEF01' });
    expect(cdp.calls).toContainEqual({ method: 'Emulation.setFocusEmulationEnabled', params: { enabled: true } });
    expect(CDP_METHODS).toContain('Emulation.setFocusEmulationEnabled');
  });

  it('T2: off disables focus emulation and clears media features', async () => {
    const cdp = recordingCdp();
    const state = session();
    await T.emulateStr(cdp, 'sid', state, ['--focus'], { targetPrefix: 'ABCDEF01' });
    cdp.calls.length = 0;
    await T.emulateStr(cdp, 'sid', state, ['off'], { targetPrefix: 'ABCDEF01' });
    expect(cdp.calls).toContainEqual({ method: 'Emulation.setFocusEmulationEnabled', params: { enabled: false } });
    expect(cdp.calls).toContainEqual({ method: 'Emulation.setEmulatedMedia', params: { features: [] } });
    expect(state.emulate.focus).toBe(false);
  });

  it('T2: off without focus on does not touch focus emulation', async () => {
    const cdp = recordingCdp();
    await T.emulateStr(cdp, 'sid', session(), ['off'], { targetPrefix: 'ABCDEF01' });
    expect(cdp.calls.map(call => call.method)).toEqual(['Emulation.setEmulatedMedia']);
  });

  it('T3: the receipts show the focus state; focus alone makes emulation active', async () => {
    const text = await T.emulateStr(recordingCdp(), 'sid', session(), ['--focus'], { targetPrefix: 'ABCDEF01' });
    expect(text).toMatch(/^Emulation: active$/m);
    expect(text).toMatch(/^ {2}focus: emulated/m);
    const json = JSON.parse(await T.emulateStr(recordingCdp(), 'sid', session(), ['--focus', '--format', 'json'], { targetPrefix: 'ABCDEF01' }));
    expect(json).toMatchObject({ schema: 'chrome-cdp-ex.emulate.v1', focus: true, active: true, features: [] });
    const plain = JSON.parse(await T.emulateStr(recordingCdp(), 'sid', session(), ['dark', '--format', 'json'], { targetPrefix: 'ABCDEF01' }));
    expect(plain.focus).toBe(false);
  });

  it('T4: --focus combines with --color-scheme and keeps the media state', async () => {
    const cdp = recordingCdp();
    const state = session();
    await T.emulateStr(cdp, 'sid', state, ['--color-scheme', 'dark'], { targetPrefix: 'ABCDEF01' });
    const json = JSON.parse(await T.emulateStr(cdp, 'sid', state, ['--focus', '--format', 'json'], { targetPrefix: 'ABCDEF01' }));
    expect(json).toMatchObject({ colorScheme: 'dark', focus: true });
    const both = JSON.parse(await T.emulateStr(recordingCdp(), 'sid', session(), ['--color-scheme', 'light', '--focus', '--format', 'json'], { targetPrefix: 'ABCDEF01' }));
    expect(both).toMatchObject({ colorScheme: 'light', focus: true });
  });

  it('T4: a --focus-only call sends no media change; a later media call keeps focus', async () => {
    const cdp = recordingCdp();
    const state = session();
    await T.emulateStr(cdp, 'sid', state, ['dark'], { targetPrefix: 'ABCDEF01' });
    cdp.calls.length = 0;
    await T.emulateStr(cdp, 'sid', state, ['--focus'], { targetPrefix: 'ABCDEF01' });
    expect(cdp.calls.map(call => call.method)).toEqual(['Emulation.setFocusEmulationEnabled']);
    const json = JSON.parse(await T.emulateStr(cdp, 'sid', state, ['light', '--format', 'json'], { targetPrefix: 'ABCDEF01' }));
    expect(json).toMatchObject({ colorScheme: 'light', focus: true });
  });

  it('off or status combined with a setting is an error, not a silent drop', () => {
    expect(() => T.parseEmulateArgs(['--focus', 'off'])).toThrow(/off cannot be combined/);
    expect(() => T.parseEmulateArgs(['off', 'dark'])).toThrow(/off cannot be combined/);
    expect(() => T.parseEmulateArgs(['dark', 'status'])).toThrow(/status cannot be combined/);
    expect(T.parseEmulateArgs(['status']).mode).toBe('status');
    expect(T.parseEmulateArgs(['off', '--format', 'json']).mode).toBe('off');
  });

  it('emulate argument errors are usage errors that point at help', () => {
    for (const args of [['off', 'dark'], ['--color-scheme', 'blue'], ['--bogus']]) {
      let message = '';
      try { T.parseEmulateArgs(args); } catch (error) { message = error.message; }
      const recovery = T.buildCliErrorRecovery(message, { cmd: 'emulate', targetPrefix: 'ABCDEF01' });
      expect(recovery, args.join(' ')).toMatchObject({ kind: 'usage', run: 'cdp help emulate' });
    }
  });

  it('T5: the synopsis and reference docs name --focus', () => {
    for (const path of ['../skills/chrome-cdp-ex/references/commands.md', '../docs/reference.md']) {
      expect(readFileSync(new URL(path, import.meta.url), 'utf8')).toMatch(/emulate <target> \[[^\]]*--focus/);
    }
  });
});
