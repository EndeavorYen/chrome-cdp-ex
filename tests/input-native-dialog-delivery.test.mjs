
import { describe, expect, it } from 'vitest';
import { classifyActionFailure, formatActionFailure } from '../skills/chrome-cdp-ex/scripts/lib/action-recovery.mjs';
import { runtimeSource } from './runtime-source.mjs';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

const TARGET_ID = 'ABCDEF1234567890';
const PREFIX = 'ABCDEF12';
const DELETE_MESSAGE = 'Delete this item?';

function target(input, commandArgs = [input]) {
  return { targetId: TARGET_ID, input, commandArgs };
}

function nextLines(text) {
  return String(text || '').split('\n').filter(line => line.startsWith('Next:'));
}

function dialogBuf(entry) {
  const buf = new T.RingBuffer(20);
  if (entry) buf.push(entry);
  return buf;
}

function dismissedConfirm(message = DELETE_MESSAGE) {
  return dialogBuf({ type: 'confirm', message, accepted: false, handled: true });
}

function pressNotDelivered(key = 'Enter') {
  const err = new Error(`press: ${key} was not delivered. The page received no keydown.`);
  err.pressNotDelivered = { key, visibility: 'visible' };
  return err;
}

function clickNoPageEvents(selector = '#delete') {
  return new Error(
    `click: Input.dispatchMouseEvent completed but the page received no mousedown/click events at (12, 18) for ${selector}. The mouse path failed closed. Try jsclick or click --js.`,
  );
}

function clickNoChange(selector = '#delete') {
  const err = new Error(`click: the control did not react (Outcome: no-change). Clicked <BUTTON> "Delete"`);
  err.clickNoChange = { dispatchText: `Clicked <BUTTON> "Delete" ${selector}` };
  return err;
}

function noClickBox(selector = '#hidden') {
  const err = new Error(`click: ${selector} (0×0) has no clickable box in the viewport. Nothing was clicked.`);
  err.noClickBox = { selector, w: 0, h: 0, inViewport: false };
  return err;
}

function fillRejected(selector = '#name') {
  const err = new Error(`fill: ${selector} did not accept "new"; value stayed ""`);
  err.fillValue = { before: '', after: '', requested: 'new', changed: false, inputType: 'text' };
  return err;
}

function receipt(err, action, input, commandArgs) {
  return formatActionFailure(err, { action, target: target(input, commandArgs) });
}

describe('#658 dismissed dialog stays native-dialog on click, fill, and press', () => {
  it('a click that opens a dismissed confirm is delivered: not click-no-change, and --accept-dialog survives', () => {
    const input = '#delete';
    const raw = clickNoChange(input);
    expect(classifyActionFailure(raw, { action: 'click', target: target(input) }).kind).toBe('click-no-change');

    const yielded = T.errorYieldingToDismissedDialog(raw, {
      dialogBuf: dismissedConfirm(),
      action: 'click',
      target: target(input),
    });
    const text = receipt(yielded, 'click', input);
    expect(text).toContain('Kind: native-dialog');
    expect(text).toContain(`Dialog: confirm "${DELETE_MESSAGE}"`);
    expect(nextLines(text)).toEqual([`Next: cdp click ${PREFIX} "#delete" --accept-dialog`]);
    expect(text).not.toMatch(/Kind: click-no-change/);
    expect(text).not.toMatch(/Kind: no-input-events/);
    expect(text).not.toMatch(/Kind: no-click-box/);

    const printed = T.formatCliError(new Error(text), { cmd: 'click', targetPrefix: PREFIX, args: [input] });
    expect(printed.split('\n').at(-1)).toBe(`Next: cdp click ${PREFIX} "#delete" --accept-dialog`);
    expect(printed).toMatch(/^Kind: native-dialog$/m);
    expect(printed).not.toMatch(/\(Kind:/);
    expect(printed).not.toMatch(/Kind: click-no-change/);
    expect(printed).not.toMatch(/Next:.*jsclick/);
  });

  it('a click reported as no-input-events yields to the dismissed confirm', () => {
    const input = '#delete';
    const raw = clickNoPageEvents(input);
    expect(classifyActionFailure(raw, { action: 'click', target: target(input) }).kind).toBe('no-input-events');
    const text = receipt(T.errorYieldingToDismissedDialog(raw, {
      dialogBuf: dismissedConfirm(),
      action: 'click',
      target: target(input),
    }), 'click', input);
    expect(text).toContain('Kind: native-dialog');
    expect(nextLines(text)).toEqual([`Next: cdp click ${PREFIX} "#delete" --accept-dialog`]);
    expect(text).not.toMatch(/Kind: no-input-events/);
  });

  it('a formatted click-no-change receipt still yields, so the hint is not already lost', () => {
    const input = '#delete';
    const formatted = receipt(clickNoChange(input), 'click', input);
    expect(formatted).toContain('Kind: click-no-change');
    const text = receipt(T.errorYieldingToDismissedDialog(new Error(formatted), {
      dialogBuf: dismissedConfirm(),
      action: 'click',
      target: target(input),
    }), 'click', input);
    expect(nextLines(text)).toEqual([`Next: cdp click ${PREFIX} "#delete" --accept-dialog`]);
    expect(text).not.toContain('Kind: click-no-change');
  });

  it('press-not-delivered yields to a dismissed confirm and the Next hint survives the CLI', () => {
    const raw = pressNotDelivered('Enter');
    expect(classifyActionFailure(raw, { action: 'press', target: target('Enter') }).kind).toBe('press-not-delivered');
    const text = receipt(T.errorYieldingToDismissedDialog(raw, {
      dialogBuf: dismissedConfirm('Submit this form?'),
      action: 'press',
      target: target('Enter'),
    }), 'press', 'Enter');
    expect(text).toContain('Kind: native-dialog');
    expect(text).toContain('Submit this form?');
    expect(nextLines(text)).toEqual([`Next: cdp press ${PREFIX} Enter --accept-dialog`]);
    expect(text).not.toMatch(/Kind: press-not-delivered/);
    const printed = T.formatCliError(new Error(text), { cmd: 'press', targetPrefix: PREFIX, args: ['Enter'] });
    expect(printed.split('\n').at(-1)).toBe(`Next: cdp press ${PREFIX} Enter --accept-dialog`);
    expect(printed).toMatch(/^Kind: native-dialog$/m);
    expect(printed).not.toMatch(/\(Kind:/);
    expect(printed).not.toMatch(/CDP_BACKGROUND=0/);
    expect(printed).not.toMatch(/Kind: press-not-delivered/);
  });

  it('fill that a dismissed prompt rewrote stays native-dialog, not a fill value failure', () => {
    const input = '#name';
    const args = [input, 'new'];
    const raw = fillRejected(input);
    expect(classifyActionFailure(raw, { action: 'fill', target: target(input, args) }).kind).toBe('fill-no-change');
    const both = fillRejected(input);
    both.nativeDialog = {
      type: 'prompt',
      message: 'Rename to?',
      action: 'fill',
      commandArgs: args,
    };
    const fromBoth = receipt(both, 'fill', input, args);
    expect(fromBoth).toContain('Kind: native-dialog');
    expect(fromBoth).not.toMatch(/Kind: fill-/);
    expect(nextLines(fromBoth)).toEqual([`Next: cdp fill ${PREFIX} "#name" new --accept-dialog`]);

    const text = receipt(T.errorYieldingToDismissedDialog(raw, {
      dialogBuf: dialogBuf({ type: 'prompt', message: 'Rename to?', accepted: false, handled: true }),
      action: 'fill',
      target: target(input, args),
    }), 'fill', input, args);
    expect(text).toContain('Kind: native-dialog');
    expect(nextLines(text)).toEqual([`Next: cdp fill ${PREFIX} "#name" new --accept-dialog`]);
    expect(text).not.toMatch(/Kind: fill-/);
  });

  it('no-click-box, press-not-delivered, and fill-no-change stay when no decision dialog was dismissed', () => {
    const empty = dialogBuf();
    expect(T.errorYieldingToDismissedDialog(noClickBox('#hidden'), {
      dialogBuf: empty, action: 'click', target: target('#hidden'),
    })).toMatchObject({ noClickBox: { selector: '#hidden' } });
    expect(classifyActionFailure(noClickBox('#hidden'), { action: 'click', target: target('#hidden') }).kind).toBe('no-click-box');

    const press = T.errorYieldingToDismissedDialog(pressNotDelivered('Enter'), {
      dialogBuf: empty, action: 'press', target: target('Enter'),
    });
    expect(classifyActionFailure(press, { action: 'press', target: target('Enter') }).kind).toBe('press-not-delivered');

    const fill = T.errorYieldingToDismissedDialog(fillRejected('#name'), {
      dialogBuf: empty, action: 'fill', target: target('#name', ['#name', 'new']),
    });
    expect(classifyActionFailure(fill, { action: 'fill', target: target('#name', ['#name', 'new']) }).kind).toBe('fill-no-change');
  });

  it('an alert, an accepted confirm, a failed handle, and a dialog from before the action do not rewrite press', () => {
    const cases = [
      { type: 'alert', message: 'Saved', accepted: false, handled: true },
      { type: 'confirm', message: DELETE_MESSAGE, accepted: true, handled: true },
      { type: 'confirm', message: DELETE_MESSAGE, accepted: false, handled: false },
    ];
    for (const entry of cases) {
      const yielded = T.errorYieldingToDismissedDialog(pressNotDelivered('a'), {
        dialogBuf: dialogBuf(entry),
        action: 'press',
        target: target('a'),
      });
      expect(classifyActionFailure(yielded, { action: 'press', target: target('a') }).kind, entry.type).toBe('press-not-delivered');
    }

    const buf = dialogBuf({ type: 'confirm', message: 'earlier', accepted: false, handled: true });
    const since = buf.latest();
    const yielded = T.errorYieldingToDismissedDialog(pressNotDelivered('a'), {
      dialogBuf: buf,
      sinceSeq: since,
      action: 'press',
      target: target('a'),
    });
    expect(classifyActionFailure(yielded, { action: 'press', target: target('a') }).kind).toBe('press-not-delivered');
  });

  it('a covered click is not rewritten, and reload beforeunload stays navigation-cancelled', () => {
    const covered = new Error('Error: click point (10, 12) of <BUTTON#save> "Save" is covered by <DIV#overlay>\nKind: covered\nNext: cdp overlay ABCDEF12 "#save"');
    const kept = T.errorYieldingToDismissedDialog(covered, {
      dialogBuf: dismissedConfirm(),
      action: 'click',
      target: target('#save'),
    });
    expect(kept).toBe(covered);

    const reload = T.navigationCancelledError('reload', { url: 'https://app.example/items/1' });
    const yielded = T.errorYieldingToDismissedDialog(reload, {
      dialogBuf: dialogBuf({ type: 'beforeunload', message: '', accepted: false, handled: true }),
      action: 'reload',
      target: { targetId: TARGET_ID, input: 'reload', commandArgs: [] },
    });
    expect(yielded).toBe(reload);
    const text = formatActionFailure(yielded, {
      action: 'reload',
      target: { targetId: TARGET_ID, input: 'reload', commandArgs: [] },
    });
    expect(text).toContain('Kind: navigation-cancelled');
    expect(text).toContain(`Next: cdp reload ${PREFIX} --accept-dialog`);
  });

  it('an already printed native-dialog receipt is not classified again as not-delivered', () => {
    const text = receipt(T.nativeDialogDismissedError({
      type: 'confirm',
      message: DELETE_MESSAGE,
      accepted: false,
      handled: true,
    }, { action: 'click', target: target('#delete') }), 'click', '#delete');
    const again = T.errorYieldingToDismissedDialog(new Error(text), {
      dialogBuf: dismissedConfirm(),
      action: 'click',
      target: target('#delete'),
    });
    expect(again.message).toBe(text);
    expect(formatActionFailure(again, { action: 'click', target: target('#delete') })).toBe(text);
    expect(nextLines(text)).toEqual([`Next: cdp click ${PREFIX} "#delete" --accept-dialog`]);
  });

  it('the dispatch catch and the command catch both prefer the dismissed dialog', () => {
    const source = runtimeSource();
    const feedback = source.slice(
      source.indexOf('async function actionFeedback('),
      source.indexOf('const applicationRegistry = applicationPreflight.registry'),
    );
    expect(feedback).toContain('throw errorYieldingToDismissedDialog(error,');
    const handler = source.slice(
      source.indexOf('async function handleCommand('),
      source.indexOf('// Unix socket server'),
    );
    expect(handler).toContain('return daemonCommandCatchResult(');
    const caught = source.slice(
      source.indexOf('async function daemonCommandCatchResult('),
      source.indexOf('async function handleCommand('),
    );
    expect(caught).toContain('const actionError = errorYieldingToDismissedDialog(e,');
    expect(caught.indexOf('errorYieldingToDismissedDialog')).toBeLessThan(caught.indexOf('formatActionFailure(actionError, context)'));
  });
});
