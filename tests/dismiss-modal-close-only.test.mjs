import { describe, expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
const { classifyActionFailure } = await import('../skills/chrome-cdp-ex/scripts/lib/action-recovery.mjs');

// #653: dismiss-modal pressed the first control whose text or label contained any of close,
// dismiss, cancel, ok, 關閉, 取消, 確認, 繼續, × or ✕. In a "Delete project?" dialog that is
// "OK, delete it" (or 確認), and the project was deleted. When no control matched it sent Escape
// and exited 0 although the dialog stayed open. dismiss-modal now presses only controls
// whose job is to close, and fails when the dialog is still there after Escape.

const BOX = { x: 10, y: 10, left: 10, top: 10, right: 110, bottom: 40, width: 100, height: 30 };

function element({ tag = 'button', text = '', attrs = {}, dialogForm = false } = {}) {
  const el = {
    tagName: tag.toUpperCase(),
    textContent: text,
    value: attrs.value,
    clicked: 0,
    getBoundingClientRect: () => BOX,
    getAttribute: name => (Object.hasOwn(attrs, name) ? String(attrs[name]) : null),
    hasAttribute: name => Object.hasOwn(attrs, name),
    closest: sel => (dialogForm && sel === 'form[method="dialog"]' ? {} : null),
    click() { el.clicked += 1; },
  };
  return el;
}

// One visible role=dialog holding `buttons`; `heading` names it unless aria-label does.
function fakeDialogPage({ buttons = [], label = null, heading = null } = {}) {
  const headingEl = heading ? element({ tag: 'h2', text: heading }) : null;
  const dialog = {
    tagName: 'DIV',
    textContent: [heading, ...buttons.map(b => b.textContent)].filter(Boolean).join(' '),
    getBoundingClientRect: () => ({ ...BOX, width: 400, height: 200, right: 410, bottom: 210 }),
    getAttribute: name => (name === 'aria-label' ? label : name === 'role' ? 'dialog' : null),
    hasAttribute: () => false,
    querySelector: () => headingEl,
    querySelectorAll: () => buttons,
  };
  const document = {
    documentElement: { clientWidth: 1200, clientHeight: 800 },
    querySelectorAll: sel => (sel.includes('[role="dialog"]') ? [dialog] : []),
    getElementById: () => null,
  };
  const style = { display: 'block', visibility: 'visible', opacity: '1', position: 'static', pointerEvents: 'auto' };
  return {
    buttons,
    run: () => JSON.parse(runInNewContext(T.dismissModalScript(), {
      document,
      window: { innerWidth: 1200, innerHeight: 800 },
      getComputedStyle: () => style,
      CSS: { escape: value => String(value) },
    })),
  };
}

describe('#653 dismiss-modal presses only a control whose job is to close', () => {
  it('clicks Cancel, not "OK, delete it"', () => {
    const ok = element({ text: 'OK, delete it' });
    const cancel = element({ text: 'Cancel' });
    const parsed = fakeDialogPage({ buttons: [ok, cancel], label: 'Delete project' }).run();
    expect(parsed).toMatchObject({ ok: true, label: 'cancel' });
    expect(ok.clicked).toBe(0);
    expect(cancel.clicked).toBe(1);
  });

  it('clicks 取消, not 確認', () => {
    const confirm = element({ text: '確認' });
    const cancel = element({ text: '取消' });
    expect(fakeDialogPage({ buttons: [confirm, cancel], heading: '刪除專案' }).run()).toMatchObject({ ok: true, label: '取消' });
    expect(confirm.clicked).toBe(0);
    expect(cancel.clicked).toBe(1);
  });

  it('does not read "Book now" as "ok", and takes the × button', () => {
    const book = element({ text: 'Book now' });
    const close = element({ text: '×' });
    expect(fakeDialogPage({ buttons: [book, close] }).run()).toMatchObject({ ok: true, label: '×' });
    expect(book.clicked).toBe(0);
  });

  it('takes an icon button labelled "Close dialog", a data-dismiss control, and a <dialog> form cancel', () => {
    const icon = element({ text: '', attrs: { 'aria-label': 'Close dialog' } });
    expect(fakeDialogPage({ buttons: [element({ text: 'Continue' }), icon] }).run()).toMatchObject({ ok: true, label: 'close dialog' });
    expect(icon.clicked).toBe(1);
    const bootstrap = element({ text: '', attrs: { 'data-bs-dismiss': 'modal' } });
    expect(fakeDialogPage({ buttons: [bootstrap] }).run()).toMatchObject({ ok: true, label: 'data-dismiss' });
    const formCancel = element({ text: 'Never mind', attrs: { value: 'cancel' }, dialogForm: true });
    expect(fakeDialogPage({ buttons: [element({ text: 'Delete' }), formCancel] }).run()).toMatchObject({ ok: true, label: 'cancel' });
  });

  it('does not take a label that only contains a close word', () => {
    const cancelPlan = element({ text: 'Cancel subscription' });
    const keep = element({ text: 'Keep plan' });
    const parsed = fakeDialogPage({ buttons: [cancelPlan, keep], heading: 'Your plan' }).run();
    expect(parsed).toEqual({ ok: false, reason: 'no-close-button', dialogs: 1, name: 'Your plan', buttons: ['Cancel subscription', 'Keep plan'] });
    expect(cancelPlan.clicked).toBe(0);
  });

  // #653: CLOSE_LABEL_RE's Chinese alternative was `^(關閉|取消)` with no end anchor, so a
  // title or aria-label that only starts with a close word was pressed.
  it('does not press a control whose title is "關閉帳號"', () => {
    const closeAccount = element({ text: '關閉帳號', attrs: { title: '關閉帳號' } });
    const parsed = fakeDialogPage({ buttons: [closeAccount], heading: '帳號設定' }).run();
    expect(closeAccount.clicked).toBe(0);
    expect(parsed).toEqual({
      ok: false, reason: 'no-close-button', dialogs: 1,
      name: '帳號設定', buttons: ['關閉帳號'],
    });
  });

  it('does not press a control whose aria-label is "取消訂閱"', () => {
    const unsubscribe = element({ attrs: { 'aria-label': '取消訂閱' } });
    const parsed = fakeDialogPage({ buttons: [unsubscribe], heading: '訂閱方案' }).run();
    expect(unsubscribe.clicked).toBe(0);
    expect(parsed).toEqual({
      ok: false, reason: 'no-close-button', dialogs: 1,
      name: '訂閱方案', buttons: ['取消訂閱'],
    });
  });

  it('uses one visible() for the close search and the open-dialog count', () => {
    const source = T.dialogVisibleFunctionSource();
    expect(source).toMatch(/^function visible\(el\) \{/);
    expect(T.dismissModalScript()).toContain(source);
    expect(T.openDialogCountScript()).toContain(source);
    expect(T.dismissModalScript().match(/function visible\(el\)/g)).toHaveLength(1);
    expect(T.openDialogCountScript().match(/function visible\(el\)/g)).toHaveLength(1);
  });

  it('presses a Chinese close label that names the dialog', () => {
    for (const label of ['關閉', '取消', '關閉對話框', '關閉視窗', '關閉此視窗', '取消彈窗']) {
      const close = element({ attrs: { 'aria-label': label } });
      const parsed = fakeDialogPage({ buttons: [element({ text: '繼續' }), close], heading: '提示' }).run();
      expect(parsed, label).toMatchObject({ ok: true, label });
      expect(close.clicked, label).toBe(1);
    }
  });

  it('lists a single-symbol button by its aria-label', () => {
    const letter = element({ text: '訂', attrs: { 'aria-label': '不要用這個' } });
    const icons = element({ text: '🗑★', attrs: { 'aria-label': '不要用這個' } });
    const titled = element({ text: '⚙', attrs: { title: '設定' } });
    const trash = element({ text: '🗑', attrs: { 'aria-label': '取消訂閱' } });
    const trashVs = element({ text: '🗑\uFE0F', attrs: { 'aria-label': '刪除' } });
    const parsed = fakeDialogPage({
      buttons: [letter, icons, titled, trash, trashVs],
      heading: '訂閱方案',
    }).run();
    expect(trash.clicked).toBe(0);
    expect(trashVs.clicked).toBe(0);
    expect(parsed).toEqual({
      ok: false, reason: 'no-close-button', dialogs: 1, name: '訂閱方案',
      buttons: ['訂', '🗑★', '設定', '取消訂閱', '刪除'],
    });
  });

  // #668: a single-symbol button with only a title was listed as the symbol.
  // The title names it in the button list and does not make it a close control.
  it('lists a single-symbol button by its title when it has no aria-label', () => {
    const gear = element({ text: '⚙', attrs: { title: '設定' } });
    const parsed = fakeDialogPage({ buttons: [gear], heading: '偏好' }).run();
    expect(gear.clicked).toBe(0);
    expect(parsed).toEqual({
      ok: false, reason: 'no-close-button', dialogs: 1, name: '偏好',
      buttons: ['設定'],
    });
  });

  it('names the dialog and its buttons when it has no close control', () => {
    const parsed = fakeDialogPage({
      buttons: [element({ text: 'Stay signed in' }), element({ text: 'Sign out' })],
      heading: 'Your session is about to expire',
    }).run();
    expect(parsed).toEqual({
      ok: false, reason: 'no-close-button', dialogs: 1,
      name: 'Your session is about to expire', buttons: ['Stay signed in', 'Sign out'],
    });
  });
});

describe('#653 dismiss-modal exits 0 only when the dialog is gone', () => {
  const noClose = { ok: false, reason: 'no-close-button', dialogs: 1, name: 'Your session is about to expire', buttons: ['Stay signed in', 'Sign out'] };

  function cdpWithOpenCounts(counts) {
    const calls = [];
    return {
      calls,
      send(method, params = {}) {
        calls.push(method);
        if (method === 'Input.dispatchKeyEvent') return Promise.resolve({});
        if (method !== 'Runtime.evaluate') return Promise.resolve({});
        const expression = String(params.expression || '');
        if (expression.includes('no-close-button')) return Promise.resolve({ result: { value: JSON.stringify(noClose) } });
        return Promise.resolve({ result: { value: counts.length > 1 ? counts.shift() : counts[0] } });
      },
    };
  }

  it('says the dialog closed when Escape closed it', async () => {
    const cdp = cdpWithOpenCounts([1, 0]);
    expect(await T.dismissModalStr(cdp, 'sid', { checkDelayMs: 0 }))
      .toBe('No close button found in 1 dialog(s); sent Escape as fallback, and the dialog closed.');
    expect(cdp.calls.filter(method => method === 'Input.dispatchKeyEvent').length).toBeGreaterThan(0);
  });

  it('fails with the dialog\'s name and buttons when Escape left it open, and clicks nothing', async () => {
    const cdp = cdpWithOpenCounts([1]);
    let error;
    try { await T.dismissModalStr(cdp, 'sid', { checkDelayMs: 0 }); } catch (caught) { error = caught; }
    expect(error?.message).toBe('dismiss-modal: the dialog "Your session is about to expire" has no close or cancel control, and Escape did not close it. Its buttons: "Stay signed in", "Sign out". Choosing one is the user\'s decision: click the button that matches what they asked for.');
    const failure = classifyActionFailure(error, { action: 'dismiss-modal', target: { targetId: 'ABCDEF1234567890', input: 'modal' } });
    expect(failure).toMatchObject({ kind: 'dialog-open', nextCommand: 'cdp perceive ABCDEF12 -C -d 8' });
    expect(failure.nextCommand).not.toMatch(/click|dismiss-modal/);
  });

  it('counts visible dialogs with the page-side check', () => {
    const shown = { getBoundingClientRect: () => BOX };
    const hidden = { getBoundingClientRect: () => ({ ...BOX, width: 0, height: 0 }) };
    const count = runInNewContext(T.openDialogCountScript(), {
      document: { querySelectorAll: () => [shown, hidden] },
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    });
    expect(count).toBe(1);
  });
});
