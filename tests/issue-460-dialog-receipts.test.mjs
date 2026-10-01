import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

const PAGE_URL = 'https://app.example/projects/1';
const NEXT_URL = 'https://app.example/projects';

// Page.handleJavaScriptDialog always succeeds unless `fail` is set.
function fakeCdp({ fail = false } = {}) {
  return {
    send(method) {
      if (method === 'Page.handleJavaScriptDialog' && fail) return Promise.reject(new Error('No dialog is showing'));
      return Promise.resolve({});
    },
  };
}

// The daemon's Page.javascriptDialogOpening handler, as wired in the daemon.
function openDialog(dialogBuf, params, { accept = true, fail = false } = {}) {
  return T.handleOpeningJavaScriptDialog(fakeCdp({ fail }), 'sid', params, { sessionId: 'sid' }, {
    accept,
    dialogBuf,
    retries: 1,
    delayMs: 1,
  });
}

// Mirrors the daemon's actionFeedback: baseline before dispatch, delta after.
async function runAction({
  action = 'click',
  dialogBuf,
  duringDispatch = async () => {},
  domDiff = '+++ Added (1):\n+   [status] Project deleted',
  dispatchText = 'Clicked <BUTTON> "Delete"',
  format = 'text',
}) {
  const consoleBuf = new T.RingBuffer(10);
  const exceptionBuf = new T.RingBuffer(10);
  const netReqBuf = new T.RingBuffer(10);
  const baseline = T.createActionObservationBaseline({ consoleBuf, exceptionBuf, netReqBuf, dialogBuf });
  let captured = null;
  const output = await T.runActionWithFeedback({
    action,
    target: { input: '#delete', resolvedBy: 'selector', label: 'Delete', targetId: 'ABCDEF123456' },
    dispatch: async () => {
      await duringDispatch();
      return dispatchText;
    },
    feedbackPolicy: 'settle-diff',
    observe: async () => domDiff,
    enrichActionResult: async (result) => {
      T.applyActionObservationDelta(result, T.buildActionObservationDelta(
        { consoleBuf, exceptionBuf, netReqBuf, dialogBuf },
        baseline,
      ));
      return result;
    },
    onActionResult: (result) => { captured = result; },
    format,
  });
  return { output, result: captured };
}

describe('#460 auto-handled JavaScript dialogs appear in action receipts', () => {
  it('reports a confirm() answered during a click in JSON and in the text receipt', async () => {
    const dialogBuf = new T.RingBuffer(20);
    const run = (format) => runAction({
      dialogBuf,
      format,
      duringDispatch: () => openDialog(dialogBuf, { type: 'confirm', message: 'Delete project?', url: PAGE_URL }),
    });

    const json = JSON.parse((await run('json')).output);
    expect(json.schema).toBe('chrome-cdp-ex.action.v1');
    expect(json.effects.dialogs).toEqual([
      { type: 'confirm', message: 'Delete project?', accepted: true, url: PAGE_URL },
    ]);

    const { output: text } = await run('text');
    expect(text).toContain('Dialog: confirm "Delete project?" → accepted');
  });

  it('keeps dialogs in the compact JSON handoff', async () => {
    const dialogBuf = new T.RingBuffer(20);
    const { output } = await runAction({
      dialogBuf,
      format: { format: 'json', compact: true },
      duringDispatch: () => openDialog(dialogBuf, { type: 'alert', message: 'Saved', url: PAGE_URL }),
    });
    const json = JSON.parse(output);
    expect(json.mode).toBe('compact');
    expect(json.effects.dialogs).toEqual([{ type: 'alert', message: 'Saved', accepted: true, url: PAGE_URL }]);
  });

  it('reports a beforeunload prompt accepted during nav as discarded unsaved changes', async () => {
    const dialogBuf = new T.RingBuffer(20);
    const run = (format) => runAction({
      action: 'nav',
      dialogBuf,
      format,
      dispatchText: `Navigated to ${NEXT_URL}`,
      domDiff: `Navigation observation:\nPage: Projects\nURL: ${NEXT_URL}\nReady state: complete`,
      duringDispatch: () => openDialog(dialogBuf, { type: 'beforeunload', message: '', url: PAGE_URL }),
    });

    const { output: text } = await run('text');
    expect(text).toContain(`URL: ${NEXT_URL}`);
    expect(text).toContain('Dialog: beforeunload → accepted (any unsaved changes on the page being left were discarded)');

    const json = JSON.parse((await run('json')).output);
    expect(json.effects.dialogs).toEqual([
      { type: 'beforeunload', message: '', accepted: true, url: PAGE_URL },
    ]);
  });

  it('reports a dismissed beforeunload during reload as a cancelled navigation', async () => {
    const dialogBuf = new T.RingBuffer(20);
    const { output } = await runAction({
      action: 'reload',
      dialogBuf,
      dispatchText: 'Reloaded',
      domDiff: 'Navigation observation:\nPage: Project 1\nURL: https://app.example/projects/1',
      duringDispatch: () => openDialog(dialogBuf, { type: 'beforeunload', message: '' }, { accept: false }),
    });
    expect(output).toContain('Dialog: beforeunload → dismissed (navigation was cancelled; the page stayed)');
  });

  it('does not report dialogs that opened before the action baseline', async () => {
    const dialogBuf = new T.RingBuffer(20);
    await openDialog(dialogBuf, { type: 'alert', message: 'old alert from an earlier command' });
    const json = JSON.parse((await runAction({ dialogBuf, format: 'json' })).output);
    expect(json.effects.dialogs).toBeUndefined();
    const { output: text } = await runAction({ dialogBuf });
    expect(text).not.toContain('Dialog:');
    expect(text).not.toContain('old alert');
  });

  it('bounds and redacts the dialog message', async () => {
    const dialogBuf = new T.RingBuffer(20);
    const long = `Session expired. token=abc123secret ${'x'.repeat(400)}`;
    const { output } = await runAction({
      dialogBuf,
      format: 'json',
      duringDispatch: () => openDialog(dialogBuf, { type: 'alert', message: long, url: `${PAGE_URL}?token=zzz` }),
    });
    const [dialog] = JSON.parse(output).effects.dialogs;
    expect(dialog.message.length).toBeLessThanOrEqual(200);
    expect(dialog.message.endsWith('…')).toBe(true);
    expect(dialog.message).toContain('token=<redacted>');
    expect(dialog.message).not.toContain('abc123secret');
    expect(dialog.url).not.toContain('zzz');
  });

  it('prints at most three dialog lines and counts the rest', async () => {
    const dialogBuf = new T.RingBuffer(20);
    const { output, result } = await runAction({
      dialogBuf,
      duringDispatch: async () => {
        for (let i = 1; i <= 5; i++) await openDialog(dialogBuf, { type: 'alert', message: `step ${i}` });
      },
    });
    expect(output.match(/^Dialog: alert/gm)).toHaveLength(3);
    expect(output).toContain('Dialog: alert "step 1" → accepted');
    expect(output).not.toContain('"step 4"');
    expect(output).toContain('Dialog: and 2 more');
    expect(result.effects.dialogs).toHaveLength(5);
  });

  it('verify-click carries the dialog into its model and text', async () => {
    const dialogBuf = new T.RingBuffer(20);
    const { result } = await runAction({
      dialogBuf,
      duringDispatch: () => openDialog(dialogBuf, { type: 'confirm', message: 'Delete project?' }),
    });
    const model = T.buildSemanticInteractionModel(result, { selector: '#delete' });
    expect(model.dialogs).toEqual([{ type: 'confirm', message: 'Delete project?', accepted: true }]);
    expect(T.formatSemanticInteractionResult(model)).toContain('Dialog: confirm "Delete project?" → accepted');
  });

  it('names the dialog on a failed dispatch too', async () => {
    const dialogBuf = new T.RingBuffer(20);
    const err = await runAction({
      dialogBuf,
      duringDispatch: async () => {
        await openDialog(dialogBuf, { type: 'confirm', message: 'Discard draft?' });
        throw new Error('Element not found: #delete');
      },
    }).catch(error => error);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('Dialog: confirm "Discard draft?" → accepted');
  });

  it('carries dialogsOmitted into fill.v1 and the verify-click model', async () => {
    const dialogBuf = new T.RingBuffer(20);
    const { result } = await runAction({
      action: 'fill',
      dialogBuf,
      duringDispatch: async () => {
        for (let i = 1; i <= 7; i++) await openDialog(dialogBuf, { type: 'alert', message: `step ${i}` });
      },
    });
    expect(result.effects.dialogs).toHaveLength(5);
    expect(result.effects.dialogsOmitted).toBe(2);
    const fill = JSON.parse(T.formatActionResultOutput(result, { format: 'json' }));
    expect(fill.schema).toBe('chrome-cdp-ex.fill.v1');
    expect(fill.dialogs).toHaveLength(5);
    expect(fill.dialogsOmitted).toBe(2);
    const model = T.buildSemanticInteractionModel(result, { selector: '#delete' });
    expect(model.dialogsOmitted).toBe(2);
    expect(T.formatSemanticInteractionResult(model)).toContain('Dialog: and 4 more');
  });

  it('report lists the dialogs answered during each action (text and JSON)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cdp-460-'));
    try {
      const dialogBuf = new T.RingBuffer(20);
      const { result } = await runAction({
        dialogBuf,
        duringDispatch: () => openDialog(dialogBuf, { type: 'confirm', message: 'Delete project? token=abc123secret' }),
      });
      const state = T.createSessionState({
        targetId: 'ABCDEF123456',
        sessionId: 'sid',
        logPath: join(dir, 'session.jsonl'),
        screenshotDir: join(dir, 'shots'),
      });
      T.appendSessionActionLog(state, result);
      expect(state.actionLog[0].dialogs).toEqual([
        { type: 'confirm', message: 'Delete project? token=<redacted>', accepted: true },
      ]);
      for (const compact of [false, true]) {
        const text = T.formatSessionReport(state, { compact });
        expect(text).toContain('Dialog: confirm "Delete project? token=<redacted>" → accepted');
        expect(text).not.toContain('abc123secret');
        const json = JSON.parse(T.formatSessionReport(state, { format: 'json', compact }));
        expect(JSON.stringify(json)).toContain('"type":"confirm"');
        expect(JSON.stringify(json)).not.toContain('abc123secret');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('says so when the dialog could not be answered', async () => {
    const dialogBuf = new T.RingBuffer(20);
    const { output, result } = await runAction({
      dialogBuf,
      duringDispatch: () => openDialog(dialogBuf, { type: 'confirm', message: 'Leave?' }, { fail: true }),
    });
    expect(result.effects.dialogs[0]).toMatchObject({ type: 'confirm', accepted: true, handled: false });
    expect(output).toContain('Dialog: confirm "Leave?" → accept failed; the dialog may still be open');
  });
});
