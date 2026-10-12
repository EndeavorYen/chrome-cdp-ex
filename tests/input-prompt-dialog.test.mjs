import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

describe('issue #263 prompt() JavaScript dialog handling', () => {
  it('#263 dismiss still sends promptText so Chrome can close prompt()', () => {
    expect(T.javascriptDialogHandleParams({ type: 'prompt', defaultPrompt: 'def' }, false)).toEqual({
      accept: false,
      promptText: 'def',
    });
    expect(T.javascriptDialogHandleParams({ type: 'prompt' }, true)).toEqual({
      accept: true,
      promptText: '',
    });
    expect(T.javascriptDialogHandleParams({ type: 'confirm', message: 'p16-confirm' }, true)).toEqual({
      accept: true,
      promptText: '',
    });
  });

  it('#263 retries handleJavaScriptDialog until the prompt is visible to CDP', async () => {
    const calls = [];
    const cdp = {
      send(method, params = {}, sessionId) {
        calls.push({ method, params, sessionId });
        if (method === 'Page.handleJavaScriptDialog' && calls.filter(c => c.method === method).length < 3) {
          return Promise.reject(new Error('No dialog is showing'));
        }
        return Promise.resolve({});
      },
    };
    const buf = new T.RingBuffer(8);
    const result = await T.handleOpeningJavaScriptDialog(
      cdp,
      'sid-page',
      { type: 'prompt', message: 'p16-prompt', defaultPrompt: 'def' },
      { sessionId: 'sid-page' },
      { accept: false, dialogBuf: buf, retries: 6, delayMs: 1 },
    );
    expect(result.ok).toBe(true);
    expect(calls.some(c => c.method === 'Page.handleJavaScriptDialog' && c.params.accept === false && c.params.promptText === 'def')).toBe(true);
    expect(buf.all()[0]).toMatchObject({ type: 'prompt', message: 'p16-prompt', defaultPrompt: 'def' });
  });

  it('#263 tracks in-flight dialog handles so click can wait instead of orphaning the daemon', async () => {
    const session = T.createJavaScriptDialogSession();
    let released = false;
    const pending = new Promise(resolve => setTimeout(() => {
      released = true;
      resolve({ ok: true });
    }, 20));
    session.track(pending);
    expect(session.pending.size).toBe(1);
    await session.waitForPending(500);
    expect(released).toBe(true);
    expect(session.pending.size).toBe(0);
  });

  it('#263 failed handleJavaScriptDialog does not Runtime.evaluate', async () => {
    const session = T.createJavaScriptDialogSession();
    session.track(Promise.resolve({ ok: false, error: new Error('No dialog is showing') }));
    await session.waitForPending(100);
    expect(session.hasFailedHandle()).toBe(true);
    expect(T.shouldSkipActionPageEvaluate(session)).toBe(true);
    let evaluated = false;
    const text = await T.observeAfterActionGuardingDialogs(session, async () => {
      evaluated = true;
      return 'AX snapshot';
    });
    expect(evaluated).toBe(false);
    expect(text).toMatch(/JavaScript dialog still open/i);
    expect(text).toMatch(/skipped page evaluate/i);
  });

  it('#263 click still returns an observe receipt when javascriptDialogOpening never fires', async () => {
    const session = T.createJavaScriptDialogSession();
    const started = Date.now();
    let evaluated = false;
    const text = await T.observeAfterActionGuardingDialogs(session, async () => {
      evaluated = true;
      return '(no changes detected in AX tree)';
    });
    expect(Date.now() - started).toBeLessThan(200);
    expect(session.hasPending()).toBe(false);
    expect(session.hasFailedHandle()).toBe(false);
    expect(evaluated).toBe(true);
    expect(text).toContain('no changes detected');
  });

  it('#263 retries handleJavaScriptDialog only on the event/page session, never the browser session', async () => {
    const calls = [];
    const cdp = {
      send(method, params = {}, sessionId) {
        calls.push({ method, params, sessionId });
        return Promise.reject(new Error('No dialog is showing'));
      },
    };
    const result = await T.handleOpeningJavaScriptDialog(
      cdp,
      'sid-page',
      { type: 'prompt', message: 'p16-prompt', defaultPrompt: 'def' },
      { sessionId: 'sid-event' },
      { accept: false, retries: 2, delayMs: 1 },
    );
    expect(result.ok).toBe(false);
    const dialogCalls = calls.filter(item => item.method === 'Page.handleJavaScriptDialog');
    expect(dialogCalls.length).toBeGreaterThan(0);
    expect(dialogCalls.every(item => item.sessionId === 'sid-event' || item.sessionId === 'sid-page')).toBe(true);
    expect(dialogCalls.some(item => item.sessionId == null)).toBe(false);
    expect(dialogCalls.every(item => item.params.promptText === 'def')).toBe(true);
  });
});
