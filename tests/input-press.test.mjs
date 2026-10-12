import { describe, it, expect } from 'vitest';
import { createMockCDP } from './mock-cdp.mjs';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

// =========================================================================
// CDP mock helper — lightweight fake for testing command functions
// =========================================================================


// =========================================================================
// 3y-Mud feedback fixes — keyForPress + single-character press
// =========================================================================

describe('keyForPress (3y-mud feedback)', () => {
  const { keyForPress } = T;

  it('maps lowercase letters to KeyX with the right keyCode', () => {
    expect(keyForPress('c')).toEqual({ key: 'c', code: 'KeyC', keyCode: 67 });
    expect(keyForPress('z')).toEqual({ key: 'z', code: 'KeyZ', keyCode: 90 });
  });

  it('maps uppercase letters preserving the visible key + shift modifier', () => {
    expect(keyForPress('C')).toEqual({ key: 'C', code: 'KeyC', keyCode: 67, shift: true });
  });

  it('maps digits to DigitN', () => {
    expect(keyForPress('1')).toEqual({ key: '1', code: 'Digit1', keyCode: 49 });
    expect(keyForPress('9')).toEqual({ key: '9', code: 'Digit9', keyCode: 57 });
  });

  it('keeps named keys case-insensitive', () => {
    expect(keyForPress('Enter').code).toBe('Enter');
    expect(keyForPress('escape').code).toBe('Escape');
  });

  it('maps common punctuation', () => {
    expect(keyForPress('-').code).toBe('Minus');
    expect(keyForPress('/').code).toBe('Slash');
  });

  it('maps shifted punctuation with shift modifier', () => {
    expect(keyForPress('?')).toEqual({ key: '?', code: 'Slash', keyCode: 191, shift: true });
    expect(keyForPress('!')).toEqual({ key: '!', code: 'Digit1', keyCode: 49, shift: true });
    expect(keyForPress(':')).toEqual({ key: ':', code: 'Semicolon', keyCode: 186, shift: true });
  });

  it('returns null for unsupported multi-character input', () => {
    expect(keyForPress('hello')).toBeNull();
    expect(keyForPress('')).toBeNull();
  });
});

describe('pressStr — single-character keys', () => {
  const { pressStr } = T;

  it('dispatches keyDown + char + keyUp for letter keys', async () => {
    const cdp = createMockCDP({ 'Input.dispatchKeyEvent': () => ({}) });
    const out = await pressStr(cdp, 'sid1', 'c');
    expect(out).toContain('Pressed c');
    const types = cdp.calls.filter(c => c.method === 'Input.dispatchKeyEvent').map(c => c.params.type);
    expect(types).toContain('keyDown');
    expect(types).toContain('char');
    expect(types).toContain('keyUp');
  });

  it('rejects unsupported keys with an actionable error mentioning single characters', async () => {
    const cdp = createMockCDP({});
    await expect(pressStr(cdp, 'sid1', 'F13'))
      .rejects.toThrow(/single characters|Unknown key/);
  });
});
