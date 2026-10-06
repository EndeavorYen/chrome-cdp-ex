import { describe, expect, it } from 'vitest';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

function recordingCdp() {
  const calls = [];
  return {
    calls,
    send(method, params = {}, sessionId) {
      calls.push({ method, params, sessionId });
      return Promise.resolve({});
    },
  };
}

function keyEvents(cdp) {
  return cdp.calls
    .filter(call => call.method === 'Input.dispatchKeyEvent')
    .map(call => call.params);
}

describe('issue #576 press Enter implicit form submission', () => {
  it('T1: Enter keyDown carries carriage-return text and does not send char', async () => {
    const cdp = recordingCdp();
    const out = await T.pressStr(cdp, 'sid', 'Enter');
    expect(out).toBe('Pressed Enter');
    const events = keyEvents(cdp);
    expect(events.map(event => event.type)).toEqual(['keyDown', 'keyUp']);
    expect(events[0]).toMatchObject({
      type: 'keyDown',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      text: '\r',
      unmodifiedText: '\r',
    });
    expect(events[1]).toMatchObject({
      type: 'keyUp',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    });
    expect(events[1].text).toBeUndefined();
    expect(events[1].unmodifiedText).toBeUndefined();
  });

  it('T2: Space and Tab stay keyDown plus keyUp without text', async () => {
    for (const [name, key, code, keyCode] of [
      ['Space', ' ', 'Space', 32],
      ['Tab', 'Tab', 'Tab', 9],
    ]) {
      const cdp = recordingCdp();
      await T.pressStr(cdp, 'sid', name);
      const events = keyEvents(cdp);
      expect(events.map(event => event.type)).toEqual(['keyDown', 'keyUp']);
      expect(events[0]).toMatchObject({ key, code, windowsVirtualKeyCode: keyCode });
      expect(events[0].text).toBeUndefined();
      expect(events[1].text).toBeUndefined();
    }
  });

  it('T2: a printable letter stays keyDown, char, keyUp and keyDown has no text', async () => {
    const cdp = recordingCdp();
    const out = await T.pressStr(cdp, 'sid', 'x');
    expect(out).toBe('Pressed x');
    const events = keyEvents(cdp);
    expect(events.map(event => event.type)).toEqual(['keyDown', 'char', 'keyUp']);
    expect(events[0].text).toBeUndefined();
    expect(events[1]).toMatchObject({ type: 'char', key: 'x', text: 'x', unmodifiedText: 'x' });
  });
});
