import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
const { formatActionFailure } = await import('../skills/chrome-cdp-ex/scripts/lib/action-recovery.mjs');

const TARGET_ID = 'ABCDEF1234567890';
const PREFIX = 'ABCDEF12';
const DELETE_MESSAGE = 'Delete this item?';

// The page's confirm()/prompt() return value is the boolean the daemon sent to
// Page.handleJavaScriptDialog. The destructive request runs only on accept.
function confirmThenDelete(daemonAccept) {
  const requests = [];
  if (daemonAccept === true) requests.push({ method: 'DELETE', url: '/items/1' });
  return requests;
}

function promptThenPost(daemonAccept) {
  const requests = [];
  const value = daemonAccept === true ? 'yes' : null;
  if (value != null) requests.push({ method: 'POST', url: '/items', body: value });
  return requests;
}

function fakeCdp() {
  const calls = [];
  return {
    calls,
    send(method, params = {}, sessionId) {
      calls.push({ method, params, sessionId });
      return Promise.resolve({});
    },
  };
}

describe('#658 native confirm() is dismissed unless accept is explicit', () => {
  it('default mode does not send the DELETE that runs only after confirm() OK', () => {
    const accept = T.savedDialogAccepts({ status: 'absent' });
    expect(confirmThenDelete(accept)).toEqual([]);
    expect(accept).toBe(false);
    expect(T.environmentRestoreOutcome({ status: 'absent' }).dialog).toBe('dismiss');
    expect(T.createSessionState({ targetId: TARGET_ID, sessionId: 'sid' }).dialogMode).toBe('dismiss');
  });

  it('default mode does not submit the POST that runs only after prompt() OK', () => {
    const accept = T.savedDialogAccepts({ status: 'absent' });
    expect(promptThenPost(accept)).toEqual([]);
  });

  it('an unreadable saved record still dismisses', () => {
    expect(T.savedDialogAccepts({ status: 'unreadable' })).toBe(false);
    expect(T.savedDialogAccepts(null)).toBe(false);
  });

  it('answers a default confirm with accept:false and names Kind: native-dialog', async () => {
    const accept = T.savedDialogAccepts({ status: 'absent' });
    const dialogBuf = new T.RingBuffer(20);
    const cdp = fakeCdp();
    const handled = await T.handleOpeningJavaScriptDialog(cdp, 'sid', {
      type: 'confirm',
      message: DELETE_MESSAGE,
      url: 'https://app.example/items/1',
    }, { sessionId: 'sid' }, { accept, dialogBuf, retries: 1, delayMs: 1 });
    expect(handled.ok).toBe(true);
    expect(cdp.calls.at(-1)).toMatchObject({
      method: 'Page.handleJavaScriptDialog',
      params: { accept: false },
    });
    expect(confirmThenDelete(cdp.calls.at(-1).params.accept)).toEqual([]);

    const entry = dialogBuf.all().at(-1);
    const err = T.nativeDialogDismissedError(entry, {
      action: 'click',
      target: { targetId: TARGET_ID, input: '#delete', commandArgs: ['#delete'] },
    });
    const text = formatActionFailure(err, {
      action: 'click',
      target: { targetId: TARGET_ID, input: '#delete', commandArgs: ['#delete'] },
    });
    expect(text).toMatch(/^Error: .*Delete this item\?/);
    expect(text).toContain('Kind: native-dialog');
    expect(text).toContain('Dialog: confirm "Delete this item?"');
    expect(text).toContain(`Next: cdp click ${PREFIX} "#delete" --accept-dialog`);
    expect(text).not.toContain('Next: cdp dialog');
  });

  it('a dismissed prompt fails with Kind: native-dialog and does not look like success', () => {
    const err = T.nativeDialogDismissedError({
      type: 'prompt',
      message: 'Rename to?',
      accepted: false,
      handled: true,
    }, {
      action: 'fill',
      target: { targetId: TARGET_ID, input: '#name', commandArgs: ['#name', 'new'] },
    });
    const text = formatActionFailure(err, {
      action: 'fill',
      target: { targetId: TARGET_ID, input: '#name', commandArgs: ['#name', 'new'] },
    });
    expect(text).toContain('Kind: native-dialog');
    expect(text).toContain('Rename to?');
    expect(text).toContain(`Next: cdp fill ${PREFIX} "#name" new --accept-dialog`);
  });

  it('a dismissed beforeunload on reload names --accept-dialog, not persistent auto-accept', () => {
    const err = T.navigationCancelledError('reload', { url: 'https://app.example/items/1' });
    const text = formatActionFailure(err, {
      action: 'reload',
      target: { targetId: TARGET_ID, input: 'reload', commandArgs: [] },
    });
    expect(text).toContain('Kind: navigation-cancelled');
    expect(text).toContain(`Next: cdp reload ${PREFIX} --accept-dialog`);
    expect(text).not.toContain(`Next: cdp dialog ${PREFIX} accept`);
  });

  it('alert is closed without failing the command; explicit accept still sends DELETE', () => {
    const entries = [
      { type: 'alert', message: 'Saved', accepted: false, handled: true },
    ];
    expect(T.dismissedDecisionDialogSince({ since: () => entries }, 0)).toBeNull();
    expect(T.nativeDialogShouldAccept({ commandAccept: false, savedAccept: false })).toBe(false);
    expect(T.nativeDialogShouldAccept({ commandAccept: true, savedAccept: false })).toBe(true);
    expect(T.savedDialogAccepts({ status: 'ok', dialog: 'accept' })).toBe(true);
    expect(T.savedDialogAccepts({ status: 'ok', dialog: 'dismiss' })).toBe(false);
    expect(confirmThenDelete(T.nativeDialogShouldAccept({ commandAccept: true, savedAccept: false }))).toEqual([
      { method: 'DELETE', url: '/items/1' },
    ]);
    expect(promptThenPost(true)).toEqual([{ method: 'POST', url: '/items', body: 'yes' }]);
  });

  it('the daemon source cannot silently return to auto-accept (#658 guard)', () => {
    const source = readFileSync(new URL('../skills/chrome-cdp-ex/scripts/cdp.mjs', import.meta.url), 'utf8');
    const saved = source.slice(
      source.indexOf('function savedDialogAccepts'),
      source.indexOf('function environmentRestoreOutcome'),
    );
    expect(saved).toMatch(/status !== 'ok'\) return false/);
    expect(saved).not.toMatch(/absent'\) return true/);
    expect(saved).toContain("return record.dialog === 'accept'");
    const handler = source.slice(
      source.indexOf("cdp.onEvent('Page.javascriptDialogOpening'"),
      source.indexOf('// Shutdown helpers'),
    );
    expect(handler).toContain('nativeDialogShouldAccept');
    expect(handler).not.toMatch(/accept:\s*true/);
    expect(source).toContain('nativeDialogDismissedError');
    expect(source).toContain('throwIfDecisionDialogDismissed');
  });
});
