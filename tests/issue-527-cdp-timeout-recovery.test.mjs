// #527: a CDP-method timeout (`Timeout: Runtime.evaluate` from a slow eval) must not
// fall through to `Kind: unknown`, and an unclassified failure must name its command.
import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';
const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

describe('CDP timeout recovery (#527)', () => {
  it('T1: eval timeout names the 15 s limit and the fire-and-forget + poll path', () => {
    const text = T.formatCliError(new Error('Timeout: Runtime.evaluate'), { cmd: 'eval', targetPrefix: '0334A718' });
    expect(text).toContain('Error: Timeout: Runtime.evaluate');
    expect(text).toContain('Kind: timeout');
    expect(text).toContain('Strategy: poll-in-page');
    expect(text).toContain('15 s');
    expect(text).toContain('eval --fire-and-forget');
    expect(text).toContain('Next: cdp eval 0334A718 --fire-and-forget');
    expect(text).toContain('Then: cdp eval 0334A718 "<read the progress from window>"');
    expect(text).not.toContain('not classified');

    const wrapped = T.buildCliErrorRecovery('RuntimeError: Error: Timeout: Runtime.callFunctionOn', { cmd: 'call', targetPrefix: '0334A718' });
    expect(wrapped).toMatchObject({ kind: 'timeout', strategy: 'poll-in-page' });
  });

  it('T2: a non-eval CDP-method timeout is a timeout that names the method', () => {
    const recovery = T.buildCliErrorRecovery('Timeout: Page.navigate', { cmd: 'nav', targetPrefix: '0334A718' });
    expect(recovery.kind).toBe('timeout');
    expect(recovery.strategy).toBe('inspect-status');
    expect(recovery.run).toBe('cdp status 0334A718');
    expect(recovery.reason).toContain('Page.navigate');

    const model = T.buildCliErrorModel(new Error('Timeout: Runtime.evaluate'), { cmd: 'eval', targetPrefix: '0334A718' });
    expect(model).toMatchObject({ command: 'eval', error: { message: 'Timeout: Runtime.evaluate' }, recovery: { kind: 'timeout' } });
  });

  it('T3: an unclassified targeted failure names the command', () => {
    const recovery = T.buildCliErrorRecovery('something odd happened', { cmd: 'eval', targetPrefix: '0334A718' });
    expect(recovery.kind).toBe('unknown');
    expect(recovery.run).toBe('cdp status 0334A718');
    expect(recovery.reason).toContain('eval');
    expect(recovery.reason).toContain('Error line');
  });

  it('T4: waitfor and selector-shaped timeouts keep their own mapping', () => {
    expect(T.buildCliErrorRecovery('Timeout: #f not found within 5000ms', { cmd: 'waitfor', targetPrefix: '0334A718' }))
      .toMatchObject({ kind: 'timeout', strategy: 'adjust-wait' });
    expect(T.buildCliErrorRecovery('Timeout: div.main not found within 5000ms', { cmd: 'flow', targetPrefix: '0334A718' }))
      .toMatchObject({ kind: 'timeout', strategy: 'adjust-wait' });
  });
});
