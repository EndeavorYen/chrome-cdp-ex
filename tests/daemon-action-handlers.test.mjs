import { describe, expect, it, vi } from 'vitest';

import { createDaemonActionHandlers } from '../skills/chrome-cdp-ex/scripts/lib/daemon-action-handlers.mjs';

const ACTION_COMMANDS = Object.freeze([
  'clickxy', 'dismiss-modal', 'fill', 'hover', 'jsclick',
  'press', 'scroll', 'select', 'type', 'verify-click',
]);

function fixture() {
  const capabilities = Object.fromEntries(
    ACTION_COMMANDS.map(name => [
      name, vi.fn(async args => ({ value: `${name}:${args.join('|')}`, evidence: { kind: 'action-receipt' } })),
    ]),
  );
  return { capabilities, handlers: createDaemonActionHandlers(capabilities) };
}

describe('daemon action handlers', () => {
  it('constructs the exact immutable accepted action cohorts', () => {
    const { handlers } = fixture();
    expect(Object.keys(handlers)).toEqual(ACTION_COMMANDS);
    expect(Object.isFrozen(handlers)).toBe(true);
    expect(Object.values(handlers).every(Object.isFrozen)).toBe(true);
  });

  it('preserves ordered repeated argv and exact capability result/evidence', async () => {
    const { capabilities, handlers } = fixture();
    for (const name of Object.keys(handlers)) {
      await expect(handlers[name]({ args: ['x', '', 'x'] })).resolves.toEqual({
        value: `${name}:x||x`, evidence: { kind: 'action-receipt' },
      });
      expect(capabilities[name]).toHaveBeenCalledWith(['x', '', 'x']);
    }
  });

  it('preserves thrown identity and never invokes another action', async () => {
    const { capabilities, handlers } = fixture();
    const sentinel = new Error('press sentinel');
    capabilities.press.mockRejectedValueOnce(sentinel);
    await expect(handlers.press({ args: ['Enter'] })).rejects.toBe(sentinel);
    expect(capabilities.fill).not.toHaveBeenCalled();
  });

  it('rejects missing, extra, accessor, symbol, prototype, sparse, and non-function input before effects', async () => {
    const { capabilities, handlers } = fixture();
    expect(() => createDaemonActionHandlers({ ...capabilities, planted: vi.fn() })).toThrow(/exactly/);
    expect(() => createDaemonActionHandlers(Object.create(capabilities))).toThrow(/plain data/);
    const getter = vi.fn(() => capabilities.fill);
    const accessor = { ...capabilities };
    delete accessor.fill;
    Object.defineProperty(accessor, 'fill', { enumerable: true, get: getter });
    expect(() => createDaemonActionHandlers(accessor)).toThrow(/data property/);
    expect(getter).not.toHaveBeenCalled();
    expect(() => createDaemonActionHandlers({ ...capabilities, [Symbol('x')]: vi.fn() })).toThrow(/symbol/);
    expect(() => createDaemonActionHandlers({ ...capabilities, fill: true })).toThrow(/function/);
    await expect(handlers.fill({ args: new Array(1) })).rejects.toThrow(/own data/);
    expect(capabilities.fill).not.toHaveBeenCalled();
  });

  it('rejects hidden data and oversized argv before invoking a capability', async () => {
    const { capabilities, handlers } = fixture();
    const hidden = { ...capabilities };
    Object.defineProperty(hidden, 'fill', {
      value: capabilities.fill,
      enumerable: false,
    });
    expect(() => createDaemonActionHandlers(hidden)).toThrow(/enumerable/);

    const hiddenArg = ['fixture'];
    Object.defineProperty(hiddenArg, '0', { value: 'fixture', enumerable: false });
    await expect(handlers.fill({ args: hiddenArg })).rejects.toThrow(/enumerable/);
    await expect(handlers.fill({ args: Array(257).fill('x') })).rejects.toThrow(/at most 256/);
    await expect(handlers.fill({ args: ['x'.repeat(65_537)] })).rejects.toThrow(/at most 65536/);
    expect(capabilities.fill).not.toHaveBeenCalled();
  });
});
