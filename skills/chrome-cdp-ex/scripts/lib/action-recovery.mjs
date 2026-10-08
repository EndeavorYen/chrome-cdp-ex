import { classifyPolicyMessage } from './session-policy.mjs';

export function isTimeoutError(err, methods = []) {
  const msg = err?.message || String(err || '');
  if (!msg.startsWith('Timeout:')) return false;
  return methods.length === 0 || methods.some(method => msg.includes(method));
}

export function actionFailureMessage(err) {
  return err?.message || String(err || '');
}

export function actionFailureTargetId(target = {}) {
  return target?.targetId || target?.id || target?.target || '<target>';
}

// #559: printed recovery commands name a tab the way `list` does: a target id becomes its
// 8-character prefix. Aliases (@name), short prefixes and the placeholder pass through.
export function actionFailureCommandTarget(target = {}) {
  const id = String(actionFailureTargetId(target) || '');
  if (id.startsWith('@') || id === '<target>') return id;
  return id.slice(0, 8);
}

export function actionFailureInput(target = {}) {
  return target?.input || target?.label || target?.selector || '';
}

export function actionTargetCommandId(target = {}) {
  return actionFailureTargetId(target);
}

// One rule for every printed command (#559): a full hex id becomes its prefix, an alias stays whole.
export function actionTargetCommandPrefix(target = {}) {
  return actionFailureCommandTarget(target) || '<target>';
}

export function isPdfViewerActionTarget(target = {}) {
  const contentType = String(target?.page?.contentType || target?.contentType || '');
  return contentType.toLowerCase().includes('application/pdf');
}

export function pdfViewerActionNextCommand(target = {}) {
  return evalCommand(actionTargetCommandPrefix(target), 'document.contentType');
}

// Characters that change meaning inside a double-quoted POSIX shell word (or trigger history
// expansion in an interactive bash), plus line breaks.
const DOUBLE_QUOTED_SHELL_UNSAFE_RE = /["$`\\!\r\n]/;

// `cdp eval <prefix> <expression>` as one pasteable shell command. The common case keeps the
// familiar "..." form; anything a double-quoted word would reinterpret goes in single quotes.
export function evalCommand(prefix, expression) {
  const expr = String(expression ?? '');
  if (!DOUBLE_QUOTED_SHELL_UNSAFE_RE.test(expr)) return `cdp eval ${prefix} "${expr}"`;
  return `cdp eval ${prefix} '${expr.replace(/'/g, `'\\''`)}'`;
}

// A single-quoted JavaScript string literal for any selector text.
export function jsSingleQuotedString(value) {
  const escaped = String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return `'${escaped}'`;
}

export function isActionRef(value) {
  return /^@(?:f\d+:)?\d+$/.test(String(value || '').trim());
}

// `cdp eval <prefix> "document.querySelector('<selector>')<accessor>"`, shell-safe for any CSS
// selector. `wrap` names a function to call on the element (getComputedStyle). Returns null for an
// @ref: refs are not CSS, so callers must resolve the ref or point at perceive instead.
export function querySelectorEvalCommand(prefix, selector, accessor = '', { wrap = '' } = {}) {
  const sel = String(selector ?? '');
  if (!sel || isActionRef(sel)) return null;
  const query = `document.querySelector(${jsSingleQuotedString(sel)})`;
  return evalCommand(prefix, wrap ? `${wrap}(${query})${accessor}` : `${query}${accessor}`);
}

function applyPdfViewerActionRecovery(failure, target = {}) {
  if (!failure || !isPdfViewerActionTarget(target)) return failure;
  const nextCommand = pdfViewerActionNextCommand(target);
  return {
    ...failure,
    nextCommand,
    hints: [
      'Chrome is rendering a PDF plugin, not an HTML document. Do not retry perceive/text as a next-probe.',
      `Confirm the plugin with \`${nextCommand}\`.`,
    ],
  };
}

// Input types whose value the browser sanitizes: text it cannot parse becomes "".
const SANITIZED_FILL_INPUT_TYPES = new Set(['number', 'date', 'time', 'datetime-local', 'month', 'week', 'color', 'range']);

function fillFailureValue(err) {
  const raw = err?.fillValue;
  if (!raw || typeof raw !== 'object') return null;
  const str = v => (v == null ? null : String(v));
  return {
    before: str(raw.before),
    after: str(raw.after),
    requested: str(raw.requested),
    inputType: raw.inputType ? String(raw.inputType) : null,
    changed: typeof raw.changed === 'boolean' ? raw.changed : null,
    ...(raw.redacted ? { redacted: true } : {}),
    ...(raw.selector ? { selector: String(raw.selector) } : {}),
  };
}

function quotedFillValue(value, redacted = false) {
  if (value == null) return '(unknown)';
  return redacted && value === '<redacted>' ? value : JSON.stringify(value);
}

export function formatFillValueTransition(value = {}) {
  return `${quotedFillValue(value.before, value.redacted)} → ${quotedFillValue(value.after, value.redacted)}`;
}

function fillValueMismatchNote(value = {}) {
  const type = String(value.inputType || '').toLowerCase();
  if (SANITIZED_FILL_INPUT_TYPES.has(type)) {
    return value.after === ''
      ? `<input type=${type}> rejected the text`
      : `<input type=${type}> sanitized the text`;
  }
  return 'the page or input rewrote the text';
}

// One receipt line: what the control held before and after fill, and what was asked for.
export function formatFillValueLine(failure = {}) {
  const value = failure.value;
  if (!value) return null;
  const note = failure.kind === 'fill-value-mismatch' ? fillValueMismatchNote(value) : 'value did not change';
  return `Value: ${formatFillValueTransition(value)} (requested ${quotedFillValue(value.requested, value.redacted)}; ${note})`;
}

// fill reached the control but the live value is not the requested text. `err.fillValue` (set by
// fillStr) carries the real before/after values, so the receipt says whether the page changed.
function classifyFillValueFailure(err, { base, target, input, perceiveCommand }) {
  const prefix = actionTargetCommandPrefix(target);
  const value = fillFailureValue(err);
  // An @ref is not CSS: inspect through the selector fill resolved for it, else re-perceive.
  const inspectSelector = isActionRef(input) ? value?.selector || '' : input;
  // A sensitive field's check reads the length, so running it does not print the secret (#485).
  const sensitive = value?.redacted === true || target?.sensitiveValue === true;
  const inspect = inspectSelector
    ? querySelectorEvalCommand(prefix, inspectSelector, sensitive ? '?.value.length' : '?.value') || 'cdp help fill'
    : (isActionRef(input) ? perceiveCommand : 'cdp help fill');
  if (value && value.changed === true) {
    return {
      ...base,
      kind: 'fill-value-mismatch',
      reason: 'fill changed the control, but not to the requested text: the input type rejected it or the page rewrote it.',
      pageChanged: true,
      value,
      nextCommand: inspect,
      hints: [
        `The control value changed ${formatFillValueTransition(value)}; the page was mutated even though the requested text was not applied.`,
        `${fillValueMismatchNote(value).replace(/^the /, 'The ')}.`,
        `Confirm the live value with \`${inspect}\`, then fill text the control accepts.`,
      ],
    };
  }
  return {
    ...base,
    kind: 'fill-no-change',
    reason: 'The control value did not change after fill. A framework may own the value.',
    ...(value ? { value } : {}),
    nextCommand: inspect,
    hints: [
      'Do not claim Filled when the live node value did not change.',
      `Inspect the live value with \`${inspect}\`.`,
      'Retry with `fill --react` only if the control is a native input that still needs a setter.',
    ],
  };
}

const COVERED_CLICK_MESSAGE_RE = /^click point \(-?[\d.]+, -?[\d.]+\) of <[^>]*>.* is covered by /;
const MISDIRECTED_CLICK_MESSAGE_RE = /did not reach the intended element|mouse click was misdirected/i;
const CLICK_NO_CHANGE_MESSAGE_RE = /did not react \(Outcome: no-change\)/;
const COVERED_DRAG_MESSAGE_RE = /^drag (start|drop) point \(-?[\d.]+, -?[\d.]+\) of <[^>]*>.* is covered by /;

// #471: a covered drag start or drop point. There is no JS fallback for a drag, so the
// recovery is to clear the covering layer (or close the dialog) and drag again.
function classifyCoveredDragFailure(err, { base, targetId, input, message }) {
  const raw = err?.dragCovered && typeof err.dragCovered === 'object' ? err.dragCovered : {};
  const point = raw.point === 'start' || raw.point === 'drop'
    ? raw.point
    : (String(message || '').match(COVERED_DRAG_MESSAGE_RE)?.[1] || 'start');
  const covering = {
    point,
    by: raw.by ? String(raw.by) : null,
    within: raw.within ? String(raw.within) : null,
    withinPosition: raw.withinPosition ? String(raw.withinPosition) : null,
    dialog: raw.dialog === true,
    recentred: raw.recentred === true,
  };
  const pointInput = raw.input ? String(raw.input) : (point === 'start' ? input : '');
  const coordinates = /^\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*$/.test(pointInput);
  const arg = pointInput && !coordinates ? recoveryCommandArg(pointInput) : '';
  const overlay = arg ? `cdp overlay ${targetId} ${arg}` : `cdp overlay ${targetId}`;
  const dismiss = `cdp dismiss-modal ${targetId}`;
  return {
    ...base,
    kind: 'covered',
    dispatched: false,
    covering,
    reason: `Another element covers the drag ${point} point, so a real mouse drag would ${point === 'start' ? 'start on' : 'drop onto'} it instead. Nothing was dragged.`,
    nextCommand: covering.dialog ? dismiss : overlay,
    hints: [
      ...(covering.dialog
        ? [`A dialog covers the ${point} point: close it with \`${dismiss}\`, then drag again.`]
        : []),
      `See what covers the ${point} point with \`${overlay}\`.`,
      'Scroll or close the covering layer so both points are clear, or drop at x,y CSS pixels that are not covered.',
      'Do not retry the same drag: it would hit the covering element again.',
    ],
  };
}

// #614: the target has no positive box inside the viewport. jsclick runs the handler
// without a mouse point. One Next.
function classifyNoClickBoxFailure(err, { base, targetId, input }) {
  const raw = err?.noClickBox && typeof err.noClickBox === 'object' ? err.noClickBox : {};
  const selector = String(raw.selector || input || '').trim();
  const arg = selector ? recoveryCommandArg(selector) : '';
  const jsClick = arg ? `cdp jsclick ${targetId} ${arg}` : `cdp perceive ${targetId} -C -d 8`;
  return {
    ...base,
    kind: 'no-click-box',
    dispatched: false,
    reason: 'The target has no positive-size box inside the viewport, so no mouse click was sent.',
    nextCommand: jsClick,
    hints: [
      `Run the handler without a mouse point: \`${jsClick}\`.`,
      'A closed dialog and a zero-size control have no viewport box. Do not click at (0, 0).',
    ],
  };
}

// #607: the key was not observed on the page. A hidden tab's Next activates that
// tab; it does not raise a covered window.
function classifyPressNotDeliveredFailure(err, { base, targetId, input, perceiveCommand, message }) {
  const raw = err?.pressNotDelivered && typeof err.pressNotDelivered === 'object' ? err.pressNotDelivered : {};
  const hidden = raw.visibility === 'hidden' || String(message || '').toLowerCase().includes('visibilitystate is hidden');
  const key = String(raw.key || input || '').trim();
  const keyArg = key ? recoveryCommandArg(key) : '';
  const foreground = keyArg
    ? `CDP_BACKGROUND=0 cdp press ${targetId} ${keyArg}`
    : `CDP_BACKGROUND=0 cdp press ${targetId}`;
  return {
    ...base,
    kind: 'press-not-delivered',
    dispatched: false,
    visibility: hidden ? 'hidden' : (raw.visibility || 'unknown'),
    reason: hidden
      ? 'The tab is hidden, so the keydown was not delivered. The recovery activates the tab and does not raise a covered window.'
      : 'The key was not delivered. The page received no keydown.',
    nextCommand: hidden ? foreground : perceiveCommand,
    hints: [
      ...(hidden ? [`\`${foreground}\` activates the tab first. It does not raise a window other windows cover.`] : []),
      `Re-read the page with \`${perceiveCommand}\`.`,
      'Do not treat a Pressed line as success when the page received no keydown.',
    ],
  };
}

// #552: the gesture was sent (or the target disappeared before it could be) and the
// intended element did not receive it. Distinct from covered, which sends nothing.
function classifyMisdirectedClickFailure(err, { base, targetId }) {
  const raw = err?.clickMisdirected && typeof err.clickMisdirected === 'object' ? err.clickMisdirected : {};
  const sent = raw.sent !== false;
  const landedOn = raw.landedOn ? String(raw.landedOn) : '';
  const sinceAction = `cdp perceive ${targetId} --since-action`;
  const perceive = `cdp perceive ${targetId} -C -d 8`;
  return {
    ...base,
    kind: 'misdirected',
    dispatched: sent,
    ...(landedOn ? { landedOn } : {}),
    reason: sent
      ? 'The mouse click was delivered, but the intended element did not receive it.'
      : 'The intended element was gone before the mouse click was sent. Nothing was clicked.',
    nextCommand: sent ? sinceAction : perceive,
    hints: [
      'Inspect the page before retrying the same click.',
      ...(sent ? ['Use `cdp click <target> <sel> --js` when the intended handler still needs to run.'] : []),
      'Do not treat this click as proof the control ran.',
    ],
  };
}

// #552: the click reached a control that should react, and settle observed no change.
function classifyClickNoChangeFailure(err, { base, targetId }) {
  const sinceAction = `cdp perceive ${targetId} --since-action`;
  return {
    ...base,
    kind: 'click-no-change',
    dispatched: true,
    detailLines: ['Outcome: no-change'],
    reason: 'The click reached a control that should react, but nothing visible changed.',
    nextCommand: sinceAction,
    hints: [
      `See what the click changed with \`${sinceAction}\` before retrying.`,
      'Do not treat the receipt as success: the control did not react.',
    ],
  };
}

// #436: another element is on top at the click point, so the mouse click was not sent. A covering
// dialog is dismissed first; fixed/sticky layout (sidebar, header, toast) is bypassed with a JS
// click, which calls HTMLElement.click() without hit-testing.
function classifyCoveredClickFailure(err, { base, targetId, input }) {
  const raw = err?.clickCovered && typeof err.clickCovered === 'object' ? err.clickCovered : {};
  const covering = {
    by: raw.by ? String(raw.by) : null,
    within: raw.within ? String(raw.within) : null,
    withinPosition: raw.withinPosition ? String(raw.withinPosition) : null,
    dialog: raw.dialog === true,
    recentred: raw.recentred === true,
    clipped: raw.clipped === true,
  };
  const arg = recoveryCommandArg(input);
  const jsClick = arg ? `cdp click ${targetId} ${arg} --js` : 'cdp help click';
  const overlay = arg ? `cdp overlay ${targetId} ${arg}` : `cdp overlay ${targetId}`;
  const dismiss = `cdp dismiss-modal ${targetId}`;
  return {
    ...base,
    kind: 'covered',
    dispatched: false,
    covering,
    reason: 'Another element covers the click point, so a real mouse click would land on it instead of the target. Nothing was clicked.',
    nextCommand: covering.dialog ? dismiss : jsClick,
    hints: [
      ...(covering.dialog
        ? [`A dialog covers the target: close it with \`${dismiss}\`, then click again.`]
        : []),
      // #551: the target's own scroll container cuts it off at the click point.
      ...(covering.clipped
        ? ['The target is clipped by its scroll container: scroll that container until the target shows, then click again.']
        : []),
      `See what covers the target with \`${overlay}\`.`,
      `\`${jsClick}\` runs the target's click handler without hit-testing; use it when the cover is page layout (a fixed sidebar or sticky header), not a dialog the user must close first.`,
      'Do not retry the same mouse click: it would hit the covering element again.',
    ],
  };
}

// #490: dialog handling is set to dismiss and the page's beforeunload prompt cancelled reload / nav.
function classifyNavigationCancelledFailure(err, { base, targetId, input }) {
  const action = err.navigationCancelled.action === 'reload' ? 'reload' : 'nav';
  const arg = recoveryCommandArg(input);
  const retry = action === 'reload' ? `cdp reload ${targetId}` : `cdp nav ${targetId}${arg ? ` ${arg}` : ''}`;
  const accept = `cdp dialog ${targetId} accept`;
  const retryLine = `Accepting discards the page's unsaved changes; then retry \`${retry}\`.`;
  // The non-destructive branch: dismiss mode was set on purpose, the draft may matter (#500 review).
  const keepLine = `To keep the unsaved changes, leave dialog handling at dismiss and check the page with \`cdp status ${targetId}\`.`;
  return {
    ...base,
    kind: 'navigation-cancelled',
    reason: `Dialog handling is set to dismiss, so the page's beforeunload prompt cancelled the ${action === 'reload' ? 'reload' : 'navigation'}. The page did not change and keeps its unsaved changes.`,
    nextCommand: accept,
    detailLines: [retryLine, keepLine],
    hints: [
      `Switch dialog handling back to accept with \`${accept}\` only if the page's unsaved changes may be discarded.`,
      retryLine,
      keepLine,
      'Do not retry while dialog handling is dismiss: the prompt cancels it again.',
    ],
  };
}

// `<BUTTON> "Save" is disabled (disabled attribute)…` from click/fill/select, and the older
// `click --pointer: element is disabled (BUTTON "Save")`.
const DISABLED_ACTION_MESSAGE_RE = /^(?:<[^>]*>.* is disabled \((?:disabled attribute|aria-disabled="true"|inside a disabled <fieldset>|disabled)\)|click --pointer: element is disabled \()/;

// `<sel>:not(:disabled):not([aria-disabled="true"])`, so `waitfor` waits until the control is
// enabled by either measure (`:not(:disabled)` alone already matches an aria-disabled control, and
// the retry would fail the same way). Only offered when the selector matched exactly one element:
// with several matches a sibling could satisfy `waitfor` while the first match, the one the action
// resolves, stays disabled. null for @refs, selector lists and unknown match counts.
function enabledSelector(selector, matches) {
  const sel = String(selector || '').trim();
  if (!sel || isActionRef(sel) || sel.includes(',') || matches !== 1) return null;
  return `${sel}:not(:disabled):not([aria-disabled="true"])`;
}

// #468: the target is disabled, so nothing was dispatched. Next waits for that control to be
// enabled (a unique CSS selector) or refreshes perception; a disabled control usually waits on input.
// aria-disabled is not enforced by browsers, and some design systems keep such controls clickable
// (to show validation or a tooltip), so the hints name `click --js` as the deliberate escape.
function classifyDisabledFailure(err, { base, targetId, input, action, perceiveCommand }) {
  const raw = err?.actionDisabled && typeof err.actionDisabled === 'object' ? err.actionDisabled : {};
  const ariaFromMessage = /\(aria-disabled="true"\)/.test(base.originalMessage);
  const disabled = {
    tag: raw.tag ? String(raw.tag) : null,
    text: raw.text ? String(raw.text) : null,
    reason: raw.reason ? String(raw.reason) : (ariaFromMessage ? 'aria-disabled="true"' : null),
  };
  const matches = Number.isInteger(raw.matches) ? raw.matches : null;
  if (matches != null) disabled.matches = matches;
  const selector = raw.selector || input;
  const enabled = enabledSelector(selector, matches);
  const waitfor = enabled ? `cdp waitfor ${targetId} ${recoveryCommandArg(enabled)}` : null;
  const aria = disabled.reason === 'aria-disabled="true"';
  const arg = recoveryCommandArg(selector);
  const jsClick = arg ? `cdp click ${targetId} ${arg} --js` : 'cdp help click';
  return {
    ...base,
    kind: 'disabled',
    dispatched: false,
    disabled,
    reason: `The target is disabled, so ${action || 'the action'} was not dispatched.`,
    nextCommand: waitfor || perceiveCommand,
    hints: [
      ...(waitfor ? [`Wait for the control to become enabled with \`${waitfor}\`.`] : []),
      ...(matches != null && matches > 1
        ? [`The selector matches ${matches} elements and ${action || 'the action'} uses the first; pick the control by @ref from \`${perceiveCommand}\` so a sibling cannot stand in for it.`]
        : []),
      `A disabled control usually waits on something else (an empty required field, an unchecked box, a pending request): check the form with \`${perceiveCommand}\`.`,
      ...(aria
        ? [`aria-disabled="true" is not enforced by the browser, and some design systems keep such controls clickable (to show validation or a tooltip). To trigger it anyway, \`${jsClick}\` clicks without the disabled check.`]
        : disabled.reason
          ? ['Do not retry the same action, or a JS click, while the control is disabled: the browser does not deliver it to a disabled form control.']
          : ['Do not retry the same action unchanged while the control is disabled.']),
    ],
  };
}

// #472: `click --expect-download` clicked (except `unsupported`), then the download did not arrive.
function classifyDownloadFailure(err, { base, targetId, input }) {
  const info = err.download;
  const sinceAction = `cdp perceive ${targetId} --since-action`;
  const retry = input ? `cdp click ${targetId} ${recoveryCommandArg(input)} --expect-download --timeout <ms>` : 'cdp help click';
  if (info.kind === 'usage') {
    return { ...base, kind: 'usage', reason: 'click --expect-download could not use the download folder.', nextCommand: 'cdp help click', hints: ['Pass --out with a folder you can write to.'] };
  }
  if (info.kind === 'unsupported') {
    return {
      ...base,
      kind: 'download-unsupported',
      dispatched: false,
      reason: 'This browser endpoint does not accept Browser.setDownloadBehavior, so the download cannot be captured. Nothing was clicked.',
      nextCommand: input ? `cdp click ${targetId} ${recoveryCommandArg(input)}` : 'cdp help click',
      hints: ['Click without --expect-download and fetch a known URL with the download.mjs helper instead.'],
    };
  }
  if (info.kind === 'canceled') {
    return {
      ...base,
      kind: 'download-canceled',
      dispatched: true,
      reason: 'The click started a download, but the browser canceled it (a network error, a blocked file type, a full disk, or a server that ended the response).',
      nextCommand: sinceAction,
      hints: [
        `See what the click changed with \`${sinceAction}\`.`,
        `Check the request with \`cdp netlog ${targetId}\` before clicking again.`,
        'The default folder sits in the runtime directory, which on Linux is a small RAM-backed tmpfs: for a large file pass --out <folder on disk>.',
      ],
    };
  }
  if (info.kind === 'save-failed') {
    return {
      ...base,
      kind: 'download-save-failed',
      dispatched: true,
      reason: 'The download completed, but the file could not be renamed or written in the download folder, so its data was removed.',
      nextCommand: 'cdp help click',
      hints: [
        'Pass --out with a writable folder on a disk with free space, then click again.',
        `See what the click changed with \`${sinceAction}\`.`,
      ],
    };
  }
  if (info.kind === 'timeout') {
    const started = info.phase === 'progress';
    return {
      ...base,
      kind: 'timeout',
      dispatched: true,
      reason: started
        ? 'The click started a download, but it did not finish in time; the unfinished download was cancelled.'
        : 'The click was sent, but no download started in time.',
      nextCommand: sinceAction,
      hints: [
        `See what the click did instead with \`${sinceAction}\` (a menu or dialog may stand between the click and the file).`,
        started
          ? `A large file needs a longer wait: \`${retry}\`.`
          : `If the server builds the file slowly, raise --timeout: \`${retry}\`.`,
      ],
    };
  }
  return {
    ...base,
    kind: 'download-missing',
    dispatched: true,
    reason: 'The browser reported the download complete, but the file was not in the download folder.',
    nextCommand: sinceAction,
    hints: ['Check that nothing else (an antivirus scanner, a sync client) moved the file out of the folder.'],
  };
}

export function classifyActionFailure(err, context = {}) {
  return applyPdfViewerActionRecovery(classifyActionFailureKind(err, context), context.target || {});
}

function classifyActionFailureKind(err, { action = 'action', target = {} } = {}) {
  const originalMessage = actionFailureMessage(err);
  const lower = originalMessage.toLowerCase();
  const targetId = actionFailureCommandTarget(target);
  const input = actionFailureInput(target);
  const frameRef = String(input).match(/^(@f\d+):\d+$/)?.[1] || null;
  const perceiveCommand = frameRef
    ? `cdp perceive ${targetId} --frame ${frameRef}`
    : `cdp perceive ${targetId} -C -d 8`;
  const statusCommand = `cdp status ${targetId}`;
  const base = {
    schema: 'chrome-cdp-ex.action-failure.v1',
    action,
    target: target || null,
    originalMessage,
    kind: 'unknown',
    reason: 'The browser rejected the action for a reason chrome-cdp-ex does not classify yet.',
    nextCommand: perceiveCommand,
    hints: [`Refresh page perception with \`${perceiveCommand}\`, then choose the next action from fresh refs.`],
  };

  if (action === 'fill' && err?.fillValue && typeof err.fillValue === 'object') {
    // Structured fill state wins over message matching: the requested text is part of the message.
    return classifyFillValueFailure(err, { base, target, input, perceiveCommand });
  }

  if (err?.navigationCancelled && typeof err.navigationCancelled === 'object') {
    return classifyNavigationCancelledFailure(err, { base, targetId, input });
  }

  // #466: a session-policy refusal names URLs and commands that the checks below would misread.
  const policy = classifyPolicyMessage(originalMessage);
  if (policy) {
    return {
      ...base,
      kind: 'policy',
      reason: policy.navigated
        ? 'The action navigated the tab to an origin CDP_ALLOWED_ORIGINS does not allow; the navigation already happened.'
        : `An opt-in session policy (${policy.rule === 'deny-actions' ? 'CDP_DENY_ACTIONS' : 'CDP_ALLOWED_ORIGINS'}) refused the action before it touched the page.`,
      nextCommand: policy.navigated ? `cdp back ${targetId}` : statusCommand,
      hints: policy.navigated
        ? [`Go back with \`cdp back ${targetId}\`, or nav to an allowed origin, before acting on the page.`]
        : ['Use a command or origin the policy allows, or ask the user to change it. Do not work around it with eval or evalraw.'],
    };
  }

  // #468: checked before message matching because the message quotes page text.
  if ((err?.actionDisabled && typeof err.actionDisabled === 'object') || DISABLED_ACTION_MESSAGE_RE.test(originalMessage)) {
    return classifyDisabledFailure(err, { base, targetId, input, action, perceiveCommand });
  }

  // #471: same hit test as #436, for the drag start and drop points.
  if ((err?.dragCovered && typeof err.dragCovered === 'object') || COVERED_DRAG_MESSAGE_RE.test(originalMessage)) {
    return classifyCoveredDragFailure(err, { base, targetId, input, message: originalMessage });
  }

  // #436: checked before message matching because the message quotes page text.
  if ((err?.clickCovered && typeof err.clickCovered === 'object') || COVERED_CLICK_MESSAGE_RE.test(originalMessage)) {
    return classifyCoveredClickFailure(err, { base, targetId, input });
  }

  // #614: nothing was sent. A zero-size or off-viewport target is not a click at (0, 0).
  if ((err?.noClickBox && typeof err.noClickBox === 'object') || /has no clickable box/i.test(originalMessage)) {
    return classifyNoClickBoxFailure(err, { base, targetId, input });
  }

  // #552: after covered, before the generic overlay/"hit test" matcher.
  if ((err?.clickMisdirected && typeof err.clickMisdirected === 'object') || MISDIRECTED_CLICK_MESSAGE_RE.test(originalMessage)) {
    return classifyMisdirectedClickFailure(err, { base, targetId });
  }
  if ((err?.clickNoChange && typeof err.clickNoChange === 'object') || CLICK_NO_CHANGE_MESSAGE_RE.test(originalMessage)) {
    return classifyClickNoChangeFailure(err, { base, targetId });
  }

  // #472: click --expect-download; the message quotes the page's file name.
  if (err?.download && typeof err.download === 'object') {
    return classifyDownloadFailure(err, { base, targetId, input });
  }

  if (lower.includes('unknown ref') || lower.includes('refs were cleared') || lower.includes('refs were invalidated')) {
    return {
      ...base,
      kind: 'stale-ref',
      reason: 'The @ref no longer maps to the current DOM.',
      nextCommand: perceiveCommand,
      hints: [
        `Refresh refs with \`${perceiveCommand}\`.`,
        'Use a stable CSS selector instead of @ref for long loops or replayable workflows.',
      ],
    };
  }

  if (
    lower.includes('other element would receive') ||
    lower.includes('click intercepted') ||
    lower.includes('intercepted by another element') ||
    lower.includes('hit test') ||
    lower.includes('not clickable at point')
  ) {
    const jsClick = input ? `cdp jsclick ${targetId} ${recoveryCommandArg(input)}` : null;
    return {
      ...base,
      kind: 'overlay',
      reason: 'A visible overlay or hit-test interception blocked the realistic mouse action.',
      nextCommand: `cdp dismiss-modal ${targetId}`,
      hints: [
        `Close obvious dialogs or overlays with \`cdp dismiss-modal ${targetId}\`.`,
        `Refresh refs after the overlay changes with \`${perceiveCommand}\`.`,
        ...(jsClick ? [`If the overlay is intentional and the target is still correct, try \`${jsClick}\`.`] : []),
      ],
    };
  }

  if (
    lower.includes('no frame for given id') ||
    lower.includes('frame was detached') ||
    lower.includes('target frame detached') ||
    lower.includes('wrong frame')
  ) {
    return {
      ...base,
      kind: 'wrong-frame',
      reason: 'The action targeted a frame or execution context that is no longer current.',
      nextCommand: perceiveCommand,
      hints: [
        `Refresh page and frame context with \`${perceiveCommand}\`.`,
        'If the control is inside an iframe, prefer a fresh perceive/coordinate target until frame-scoped refs are available.',
      ],
    };
  }

  if (
    lower.includes('cannot find context') ||
    lower.includes('execution context was destroyed') ||
    lower.includes('inspected target navigated') ||
    lower.includes('target closed')
  ) {
    return {
      ...base,
      kind: 'navigation',
      reason: 'The page navigated, reloaded, or recreated its JavaScript context during the action.',
      nextCommand: perceiveCommand,
      hints: [
        `Refresh the current page state with \`${perceiveCommand}\`.`,
        `Use \`cdp status ${targetId}\` if navigation or console failures may explain the change.`,
      ],
    };
  }

  if (
    lower.includes('no node with given id') ||
    lower.includes('could not find node') ||
    lower.includes('node is detached from document') ||
    lower.includes('cannot find node with given id')
  ) {
    return {
      ...base,
      kind: 'dom-rewrite',
      reason: 'The DOM node disappeared or was rewritten after it was resolved.',
      nextCommand: perceiveCommand,
      hints: [
        `Refresh refs with \`${perceiveCommand}\`.`,
        'For React/Vue rerenders or HMR, prefer a stable CSS selector over an old @ref.',
      ],
    };
  }

  if (action === 'drag' && lower.includes('received no mouse or drag events')) {
    const hidden = lower.includes('visibilitystate is hidden');
    const dragArgs = Array.isArray(target?.commandArgs) && target.commandArgs.length
      ? target.commandArgs.map(arg => recoveryCommandArg(arg)).join(' ')
      : '<from> <to>';
    // Background mode (the default) leaves the tab hidden; a foreground rerun activates it first.
    const foreground = `CDP_BACKGROUND=0 cdp drag ${targetId} ${dragArgs}`;
    return {
      ...base,
      kind: 'no-input-events',
      visibility: hidden ? 'hidden' : 'unknown',
      dispatched: false,
      reason: hidden
        ? 'The tab is hidden (window covered or minimised), so Input.* events are dropped and the page received no mouse or drag events.'
        : 'The mouse drag completed without delivering any mouse or drag events to the page.',
      nextCommand: hidden ? foreground : statusCommand,
      hints: [
        ...(hidden ? [`The tab is hidden: \`${foreground}\` activates it first; that does not raise a window other windows cover.`] : []),
        `Check the tab with \`${statusCommand}\` (a pending dialog or a busy page also swallows input).`,
        'Do not treat the drag as done: the page saw no events.',
      ],
    };
  }

  if (action === 'drag' && ((err?.dragIncomplete && typeof err.dragIncomplete === 'object')
    || lower.includes('the drag never finished') || lower.includes('only after the mouse was released'))) {
    const sinceAction = `cdp perceive ${targetId} --since-action`;
    const late = err?.dragIncomplete?.reason === 'late' || lower.includes('only after the mouse was released');
    return {
      ...base,
      kind: 'drag-incomplete',
      dispatched: true,
      reason: late
        ? 'The page started an HTML5 drag only after the mouse was released, so nothing was dropped; the drag was cancelled.'
        : 'The page started an HTML5 drag that never got a drop or dragend; it was cancelled.',
      nextCommand: sinceAction,
      hints: [
        `See what the gesture changed with \`${sinceAction}\` before retrying.`,
        ...(late ? ['The dragstart handler is slow: retry with a longer gesture, for example `--steps 60` (about one second of moves).'] : []),
        'Do not report the item as moved: no drop reached the destination.',
      ],
    };
  }

  if (action === 'drag' && ((err?.dragOffViewport && typeof err.dragOffViewport === 'object') || lower.includes('is outside the viewport'))) {
    return {
      ...base,
      kind: 'not-in-viewport',
      dispatched: false,
      reason: 'A drag point is outside the viewport, so a real mouse drag cannot reach it. Nothing was sent.',
      nextCommand: perceiveCommand,
      hints: [
        'Scroll so the source and the destination are both visible (the source is scrolled into view; the destination is not), then drag again with fresh refs.',
        'Or drop at x,y CSS pixels inside the viewport.',
      ],
    };
  }

  if (action === 'drag' && lower.includes('drop point is stale')) {
    const perceiveCursor = `cdp perceive ${targetId} -C -d 8`;
    return {
      ...base,
      kind: 'stale-ref',
      dispatched: false,
      reason: 'The @c drop point was measured before the source was scrolled into view, so it no longer points at the same element.',
      nextCommand: perceiveCursor,
      hints: [`Refresh cursor refs with \`${perceiveCursor}\`, or drop at x,y CSS pixels.`],
    };
  }

  if (action === 'drag' && lower.includes('did not start an html5 drag')) {
    const sinceAction = `cdp perceive ${targetId} --since-action`;
    return {
      ...base,
      kind: 'drag-not-started',
      dispatched: true,
      reason: 'drag --html5 was requested, but the page did not start an HTML5 drag from the source; the pointer press, moves, and release were still sent.',
      nextCommand: sinceAction,
      hints: [
        `See what the pointer gesture changed with \`${sinceAction}\` before retrying.`,
        'Drop --html5 for libraries that drag with pointer or mouse events (sortable lists, sliders, splitters).',
        'For HTML5 drag-and-drop, drag the element that is draggable (draggable="true", or a link or image).',
      ],
    };
  }

  // #607: dispatchKeyEvent resolved, but the page's keydown listener did not run.
  if (
    (err?.pressNotDelivered && typeof err.pressNotDelivered === 'object')
    || (/was not delivered/i.test(originalMessage) && /no keydown/i.test(originalMessage))
  ) {
    return classifyPressNotDeliveredFailure(err, { base, targetId, input, perceiveCommand, message: originalMessage });
  }

  if (
    lower.includes('received no mousedown/click events')
    || (lower.includes('mouse path failed closed') && lower.includes('jsclick'))
  ) {
    const jsClick = input ? `cdp jsclick ${targetId} ${recoveryCommandArg(input)}` : 'cdp help click';
    // #402: a hidden tab (window covered or minimised) drops Input.* events; the page saw nothing,
    // so a JS click is safe to try and the mouse path will keep failing until the window is visible.
    const hidden = lower.includes('visibilitystate is hidden');
    return {
      ...base,
      kind: 'no-input-events',
      visibility: hidden ? 'hidden' : 'unknown',
      dispatched: false,
      reason: hidden
        ? 'The tab is hidden (window covered or minimised), so Input.* events are dropped and the page received no mouse or click events.'
        : 'The realistic mouse click completed without delivering page mouse or click events.',
      nextCommand: jsClick,
      hints: [
        ...(hidden ? [`The tab is hidden: Input.* events are dropped while hidden. Bring the browser window to the front, or use a JS click instead of retrying the mouse path. For a background tab, \`CDP_BACKGROUND=0 cdp click ${targetId} ${input ? recoveryCommandArg(input) : '<selector>'}\` activates it first; that does not raise a window other windows cover.`] : []),
        `Retry with \`${jsClick}\` or \`cdp click ${targetId} ${input || '<selector>'} --js\`.`,
        'Do not treat dispatch.ok as success when the live handler or form control did not change.',
      ],
    };
  }

  if (isTimeoutError(err) || lower.includes('timed out') || lower.includes('timeout')) {
    return {
      ...base,
      kind: 'timeout',
      // #402: on a busy or hidden tab the input can run even though the acknowledgement times out.
      dispatched: 'unknown',
      reason: 'The action or its CDP acknowledgement exceeded the timeout window. The action may still have run.',
      nextCommand: statusCommand,
      hints: [
        `Check whether the tab is still responsive with \`${statusCommand}\`.`,
        `If the action may have dispatched, run \`cdp perceive ${targetId} --since-action\` before retrying.`,
        'Do not resend a non-idempotent action (submit, purchase, send) until you have confirmed it did not run.',
      ],
    };
  }

  if (
    lower.includes('did not navigate')
    || (lower.includes('try jsclick') && lower.includes('<a href'))
  ) {
    const jsClick = input ? `cdp jsclick ${targetId} ${recoveryCommandArg(input)}` : 'cdp help click';
    return {
      ...base,
      kind: 'no-navigation',
      reason: 'The realistic mouse click dispatched but the link default action did not run.',
      nextCommand: jsClick,
      hints: [
        `Retry with \`${jsClick}\` or \`cdp click ${targetId} ${input || '<selector>'} --js\`.`,
        'Do not treat a no-change overlay probe as the next step on a plain <a href>.',
      ],
    };
  }

  if (
    lower.includes('is not a valid selector') ||
    lower.includes('invalid selector') ||
    lower.includes(':has-text(') ||
    lower.includes(':text(') ||
    lower.includes(':text-is(') ||
    (lower.includes('syntaxerror') && lower.includes('selector'))
  ) {
    const usage = `cdp ${action || 'click'} ${targetId} <css|#id|[data-testid]|@ref>`;
    return {
      ...base,
      kind: 'invalid-selector',
      reason: 'The selector is not valid CSS. Playwright text selectors like :has-text() are not supported.',
      nextCommand: usage,
      hints: [
        'Use a CSS selector, data-testid attribute, or an @ref from perceive — not Playwright :has-text()/ :text().',
        `Discover stable targets with \`${perceiveCommand}\` once, then click by @ref or CSS.`,
      ],
    };
  }

  if (
    lower.includes('element not found') ||
    lower.includes('could not resolve selector') ||
    lower.includes('failed to find element') ||
    // #427: a named / text= click miss is a selector miss, not an unclassified browser rejection.
    lower.includes('named control not found') ||
    lower.includes('named control is not unique')
  ) {
    return {
      ...base,
      kind: 'selector',
      reason: 'No current element matched the requested selector, @ref, or visible name.',
      nextCommand: perceiveCommand,
      hints: [
        `Refresh available controls with \`${perceiveCommand}\`.`,
        'Check whether the element is below the fold, inside a modal, or renamed by the framework.',
      ],
    };
  }

  if (
    lower.includes('not a fillable control')
    || lower.includes('not fillable')
  ) {
    return {
      ...base,
      kind: 'not-fillable',
      reason: 'fill requires an input, textarea, or contenteditable control.',
      nextCommand: `cdp help fill`,
      hints: [
        'Use fill on <input>, <textarea>, or contenteditable controls.',
        'Use click for links and buttons.',
      ],
    };
  }

  if (
    action === 'fill'
    && (
      lower.includes('did not accept')
      || lower.includes('live value is still empty')
    )
  ) {
    return classifyFillValueFailure(err, { base, target, input, perceiveCommand });
  }

  if (
    lower.includes('unknown key')
    || lower.includes('key name required')
  ) {
    return {
      ...base,
      kind: 'usage',
      reason: 'press requires a supported key name.',
      nextCommand: 'cdp help press',
      hints: [
        'Use Enter, Tab, Escape, Backspace, Space, Arrow*, or a single character.',
        'Use `type` for multi-character text.',
      ],
    };
  }

  if (
    action === 'select'
    && (
      lower.includes('css selector required')
      || lower.includes('value required')
      || lower.includes('not a <select>')
      || lower.includes('no option value')
    )
  ) {
    return {
      ...base,
      kind: 'usage',
      reason: 'select requires a <select> element and an existing option value.',
      nextCommand: 'cdp help select',
      hints: [
        'Pass a CSS selector for a <select> and an option value or visible label that exists.',
        'Use perceive to inspect available controls before selecting.',
      ],
    };
  }

  if (lower.includes('closetab: refusing to close the last open tab') || lower.includes('closetab: unknown argument')) {
    return {
      ...base,
      kind: 'usage',
      reason: 'closetab refuses to close the only open tab because closing it can quit the browser.',
      nextCommand: 'cdp help closetab',
      hints: [
        'Open or keep another tab first, then close this one.',
        'Pass --force only when quitting the browser is intended.',
      ],
    };
  }

  if (
    action === 'upload'
    && (
      lower.includes('file not found')
      || lower.includes('file path')
      || lower.includes('not a readable file')
      || lower.includes('is not an <input type="file">')
      || lower.includes('css selector for <input type="file"> required')
      || lower.includes('refusing to guess')
      || lower.includes('does not accept several files')
    )
  ) {
    return {
      ...base,
      kind: 'usage',
      reason: 'upload requires exactly one matching file input and a path to an existing readable file.',
      nextCommand: 'cdp help upload',
      hints: [
        'Pass a real filesystem path; missing paths are not uploaded as empty ghost files.',
        'Target an <input type="file">, not another control.',
        'If the selector matches several inputs, make it match one (an id, a container, or :nth-of-type(N)); several files need an input with `multiple`.',
      ],
    };
  }

  if (
    (action === 'cookiedel' || action === 'cookie')
    && (lower.includes('cookie not found') || lower.includes('cookie name required'))
  ) {
    return {
      ...base,
      kind: 'usage',
      reason: 'cookiedel requires the name of a cookie that exists on the current page.',
      nextCommand: 'cdp help cookiedel',
      hints: [
        'List cookies with `cdp cookies` before deleting.',
        'Do not treat a missing cookie as a successful delete.',
      ],
    };
  }

  if (
    (action === 'verify-click' || action === 'verifyclick' || lower.includes('verify-click:'))
    && (
      lower.includes('requires')
      || lower.includes('exactly one selector')
    )
  ) {
    return {
      ...base,
      kind: 'usage',
      reason: 'verify-click needs a selector and paired network assertions.',
      nextCommand: 'cdp help verify-click',
      hints: [
        'Pass one selector or @ref.',
        '--expect-status only applies together with --expect-request.',
      ],
    };
  }

  if (
    (action === 'restore' || action === 'replay'
      || lower.includes('restore:')
      || lower.includes('replay:'))
    && (
      lower.includes('enoent')
      || lower.includes('no such file')
      || (lower.includes('unsupported') && lower.includes('schema'))
      || lower.includes('requires --file')
      || lower.includes('requires --json')
      || lower.includes('invalid checkpoint')
      || lower.includes('invalid json artifact')
      || lower.includes('artifact must be')
      || lower.includes('checkpoint artifact must')
    )
  ) {
    const helpCmd = action === 'replay' || lower.includes('replay') ? 'replay' : 'restore';
    return {
      ...base,
      kind: 'usage',
      reason: `${helpCmd} needs an existing artifact with a supported schema.`,
      nextCommand: `cdp help ${helpCmd}`,
      hints: [
        `Provide --file or --json. Missing paths are not opened as empty artifacts.`,
        `Run \`cdp help ${helpCmd}\` for the artifact contract.`,
      ],
    };
  }

  return base;
}

export function actionFailurePage(target = {}, extra = {}) {
  const page = extra.page || target.page || target.pageHealth?.evidence || {};
  const title = String(page.title || '').trim();
  const url = String(page.url || '').trim();
  if (!title && !url) return null;
  return { title, url };
}

const CLASSIFIED_ERROR_LINE_RE = /^Error: [^\n]*\nKind: /;

export function isClassifiedActionFailureText(message) {
  const text = String(message || '').trim();
  return text.startsWith('Action failure:')
    || text.startsWith('Kind:')
    || CLASSIFIED_ERROR_LINE_RE.test(text);
}

const ACTION_FAILURE_ERROR_MAX_CHARS = 600;

// #427: a failed action must always say what went wrong. `Kind: unknown` plus a Next
// command reads like a receipt, so agents took it for success. The Error line is the
// original message on one bounded line, without a doubled `Error:` prefix.
export function actionFailureErrorLine(message, fallback = '') {
  const oneLine = String(message || '').replace(/\s+/g, ' ').trim().replace(/^Error:\s*/i, '')
    || String(fallback || '').replace(/\s+/g, ' ').trim()
    || 'action failed';
  const bounded = oneLine.length > ACTION_FAILURE_ERROR_MAX_CHARS
    ? `${oneLine.slice(0, ACTION_FAILURE_ERROR_MAX_CHARS - 1)}…`
    : oneLine;
  return `Error: ${bounded}`;
}

// `detailLines` sit between Kind and Next (e.g. fill's `Value: "0.5" → ""`); empty entries are dropped.
export function formatActionFailureLines({ message = '', reason = '', kind = 'unknown', detailLines = [], nextCommand = '' } = {}) {
  return [
    actionFailureErrorLine(message, reason),
    `Kind: ${kind || 'unknown'}`,
    ...detailLines.filter(Boolean),
    ...(nextCommand ? [`Next: ${nextCommand}`] : []),
  ].join('\n');
}

export function formatActionFailure(err, context = {}) {
  const message = actionFailureMessage(err);
  if (isClassifiedActionFailureText(message)) return message;
  const failure = classifyActionFailure(err, context);
  return formatActionFailureLines({
    message: failure.originalMessage,
    reason: failure.reason,
    kind: failure.kind,
    detailLines: [formatFillValueLine(failure), ...(Array.isArray(failure.detailLines) ? failure.detailLines : [])],
    nextCommand: failure.nextCommand,
  });
}

// One shell word for a selector/ref in a pasteable recovery command (#445). Refs and plain words stay
// bare; a leading `#` (a comment in sh) or any space/quote gets "..." when that is safe; anything a
// double-quoted word would expand ($, `, \\, !) goes in single quotes.
export function recoveryCommandArg(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^@[a-z0-9:]+$/i.test(text)) return text;
  if (/^[^\s"'`\\$!#;&|<>()*?[\]{}~]+$/.test(text)) return text;
  if (!/["$`\\!\r\n]/.test(text)) return `"${text}"`;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function recoveryCommand(command, reason) {
  return { command, reason };
}

function uniqueRecoveryCommands(commands = []) {
  const seen = new Set();
  const out = [];
  for (const entry of commands) {
    if (!entry?.command || seen.has(entry.command)) continue;
    seen.add(entry.command);
    out.push(entry);
  }
  return out;
}

export function uniqueNextStepCommands(commands = []) {
  const out = [];
  for (const command of commands) {
    if (!command || out.includes(command)) continue;
    out.push(command);
  }
  return out;
}

export function looksLikeClipboardControl(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return false;
  if (/^copy$/i.test(text)) return true;
  if (/\bclipboard\b/i.test(text)) return true;
  if (/\bcopied!?\b/i.test(text)) return true;
  return /\bcopy\b/i.test(text)
    && /\b(name|link|id|text|url|code|token|json|model|path|sha)\b/i.test(text);
}

export function isExpectedClipboardNoChange(target = {}, extraText = '') {
  if (target?.expectedOutcome === 'clipboard-no-change') return true;
  return looksLikeClipboardControl(target?.label)
    || looksLikeClipboardControl(target?.input)
    || looksLikeClipboardControl(target?.dispatchText)
    || looksLikeClipboardControl(extraText);
}

const NON_SELECTOR_RESOLVED_BY = new Set([
  'key', 'dialog', 'coordinates', 'scroll', 'history', 'url', 'viewport', 'focus', 'command',
]);

const NAMED_PRESS_KEYS = /^(enter|tab|escape|esc|space|backspace|shift|ctrl|control|alt|meta|arrow(up|down|left|right)|page(up|down)|home|end|delete|insert)$/i;

export function isExpectedPressNoChange(target = {}, action = null) {
  if (target?.expectedOutcome === 'press-no-change') return true;
  if (String(target?.resolvedBy || '') === 'key') return true;
  return String(action || target?.action || '').toLowerCase() === 'press';
}

export function isExpectedPdfViewerNoChange(target = {}, extraText = '') {
  if (target?.expectedOutcome === 'pdf-viewer-no-change') return true;
  if (isPdfViewerActionTarget(target)) return true;
  const blob = [
    extraText,
    target?.dispatchText,
    target?.label,
    target?.domDiff,
  ].filter(Boolean).join('\n');
  return /settle shape was pdf-viewer\.v1/i.test(blob)
    || blob.includes('chrome-cdp-ex.pdf-viewer.v1');
}

export function isExpectedCardsWindowNoChange(target = {}, extraText = '') {
  if (target?.expectedOutcome === 'cards-window-no-change') return true;
  const blob = [
    extraText,
    target?.dispatchText,
    target?.domDiff,
  ].filter(Boolean).join('\n');
  return /unchanged; still first cards/i.test(blob)
    || (/\bunchanged\b/i.test(blob) && /virtualized window/i.test(blob));
}

export function isExpectedLeftoverAxScrollNoChange(target = {}) {
  return target?.expectedOutcome === 'leftover-ax-scroll-no-change';
}

export function isExpectedFillValueNoChange(target = {}) {
  return target?.expectedOutcome === 'fill-value-unchanged';
}

export function isExpectedNoChange(target = {}, extraText = '', action = null) {
  if (isExpectedClipboardNoChange(target, extraText)) return true;
  if (isExpectedFillValueNoChange(target)) return true;
  if (target?.expectedOutcome === 'no-modal') return true;
  if (isExpectedPdfViewerNoChange(target, extraText)) return true;
  if (isExpectedCardsWindowNoChange(target, extraText)) return true;
  if (isExpectedLeftoverAxScrollNoChange(target)) return true;
  return isExpectedPressNoChange(target, action);
}

export function expectedNoChangeReason(target = {}, action = null, extraText = '') {
  if (isExpectedClipboardNoChange(target)) {
    return 'Clipboard / copy action; no visible AX tree change is expected.';
  }
  if (target?.expectedOutcome === 'no-modal') {
    return 'No visible modal/dialog was present; nothing was dismissed.';
  }
  if (isExpectedFillValueNoChange(target)) {
    return 'The control already held the requested value; fill left it unchanged.';
  }
  if (isExpectedPdfViewerNoChange(target, extraText)) {
    return 'Settle shape was pdf-viewer.v1 (empty AX); continue without overlay/perceive recovery.';
  }
  if (isExpectedCardsWindowNoChange(target, extraText)) {
    return 'Settle shape was leftover feed --cards; virtualized window did not replace cards.';
  }
  if (isExpectedLeftoverAxScrollNoChange(target)) {
    return 'Settle shape was leftover golden-path AX; viewport rect chrome did not replace identities.';
  }
  if (isExpectedPressNoChange(target, action)) {
    return 'Key press produced no visible AX tree change; continue without overlay recovery.';
  }
  return 'No visible AX tree change observed after action.';
}

export function overlaySelectorArg(targetInput = '', targetInfo = {}) {
  const resolvedBy = String(targetInfo?.resolvedBy || '');
  if (NON_SELECTOR_RESOLVED_BY.has(resolvedBy)) return '';
  const raw = String(targetInput || targetInfo?.input || '').trim();
  if (!raw) return '';
  if (NAMED_PRESS_KEYS.test(raw)) return '';
  if (/^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/.test(raw)) return '';
  if (/^modal$/i.test(raw)) return '';
  return recoveryCommandArg(raw);
}

function overlayCheckCommand(target, targetInput = '', targetInfo = {}) {
  const selector = overlaySelectorArg(targetInput, targetInfo);
  return selector
    ? `cdp overlay ${target} ${selector} --format json`
    : `cdp overlay ${target} --format json`;
}

function noChangeNeedsOverlay(action, targetInfo = {}) {
  if (isExpectedNoChange(targetInfo, '', action)) return false;
  if (/clicked\s+<a\b/i.test(String(targetInfo.dispatchText || targetInfo.label || ''))) return false;
  return new Set(['click', 'jsclick', 'clickxy', 'fill', 'select', 'upload', 'press', 'dismiss-modal'])
    .has(String(action || '').toLowerCase());
}

function noChangeNeedsFrameContext(targetInput = '', targetInfo = {}) {
  const input = String(targetInput || targetInfo.input || '');
  return /^@f\d+:/i.test(input)
    || Boolean(targetInfo.frameRef)
    || Boolean(targetInfo.frameId)
    || targetInfo.resolvedBy === 'frame-ref';
}

function noChangeBlockingSignals({ action = null, targetInput = '', targetInfo = {} } = {}) {
  const signals = [];
  if (noChangeNeedsOverlay(action, targetInfo)) signals.push('overlay-check-needed');
  if (noChangeNeedsFrameContext(targetInput, targetInfo)) signals.push('frame-check-needed');
  if (!isExpectedNoChange(targetInfo, targetInput, action)) signals.push('fresh-perception-needed');
  return [...new Set(signals)];
}

function noChangeRecoveryHint(signals = []) {
  const topics = [];
  if (signals.includes('overlay-check-needed')) topics.push('overlays');
  if (signals.includes('frame-check-needed')) topics.push('frame context');
  if (signals.includes('fresh-perception-needed')) topics.push('fresh refs');
  const phrase = topics.length <= 1
    ? topics[0] || 'fresh page state'
    : `${topics.slice(0, -1).join(', ')} and ${topics.at(-1)}`;
  return `Action dispatched but produced no visible AX tree change; inspect ${phrase} before retrying.`;
}

export function buildNoChangeOutcomeRecommendation({
  action = null,
  actionIndex = null,
  target = '<target>',
  targetInput = '',
  targetInfo = {},
  extraText = '',
  source = 'action-outcome',
} = {}) {
  const blockingSignals = noChangeBlockingSignals({ action, targetInput, targetInfo });
  if (isExpectedPdfViewerNoChange(targetInfo, extraText)) {
    const nextCommand = pdfViewerActionNextCommand({
      ...targetInfo,
      targetId: targetInfo.targetId || target,
    });
    return {
      source,
      actionIndex,
      action,
      outcomeStatus: 'no-change',
      strategy: 'continue',
      priority: 'low',
      reason: 'Settle shape was pdf-viewer.v1 (empty AX); continue without overlay/perceive recovery.',
      blockingSignals: [],
      recoveryHint: 'PDF plugin empty-AX settle; confirm with eval document.contentType.',
      verifyCommand: nextCommand,
      commands: uniqueNextStepCommands([nextCommand]),
    };
  }
  if (isExpectedCardsWindowNoChange(targetInfo, extraText)) {
    const nextCommand = `cdp perceive ${target} --cards`;
    return {
      source,
      actionIndex,
      action,
      outcomeStatus: 'no-change',
      strategy: 'continue',
      priority: 'low',
      reason: 'Settle shape was leftover feed --cards; virtualized window did not replace cards.',
      blockingSignals: [],
      recoveryHint: 'Feed window unchanged; re-run perceive --cards instead of a full AX dump.',
      verifyCommand: nextCommand,
      commands: uniqueNextStepCommands([nextCommand]),
    };
  }
  if (isExpectedLeftoverAxScrollNoChange(targetInfo)) {
    const nextCommand = `cdp perceive ${target} -C -d 8`;
    return {
      source,
      actionIndex,
      action,
      outcomeStatus: 'no-change',
      strategy: 'continue',
      priority: 'low',
      reason: 'Settle shape was leftover golden-path AX; viewport rect chrome did not replace identities.',
      blockingSignals: [],
      // Next is already perceive -C -d 8. "re-run perceive instead of report"
      // restates that command (#311). formatActionText also drops this
      // settle-shape Outcome reason on honest no-change (#313), the
      // reprinted Page / Viewport identity header (#316), the
      // tautological AX body "(no changes detected in AX tree)" (#318),
      // and the tautological "scroll: dispatched via scroll" /
      // "Target: down" restatement (#320) because Outcome already states
      // no-change, Position already states scroll identity, and Next is
      // already perceive. Keep Outcome/Verdict/Next; do not author a
      // Recovery hint that tells the model to do what Next already says.
      recoveryHint: null,
      verifyCommand: nextCommand,
      commands: uniqueNextStepCommands([nextCommand]),
    };
  }
  if (isExpectedNoChange(targetInfo, targetInput, action)) {
    const reason = isExpectedClipboardNoChange(targetInfo, targetInput)
      ? 'Clipboard / copy actions do not rewrite the AX tree; continue without overlay recovery.'
      : expectedNoChangeReason(targetInfo, action);
    const recoveryHint = isExpectedClipboardNoChange(targetInfo, targetInput)
      ? 'Clipboard action dispatched; no visible AX change is expected.'
      : targetInfo?.expectedOutcome === 'no-modal'
        ? 'No visible modal/dialog; continue without overlay recovery.'
        : isExpectedFillValueNoChange(targetInfo)
          ? 'The control already held the requested value; continue without overlay recovery.'
          : 'Key press dispatched; no visible AX change is expected for a no-op key.';
    return {
      source,
      actionIndex,
      action,
      outcomeStatus: 'no-change',
      strategy: 'continue',
      priority: 'low',
      reason,
      blockingSignals,
      recoveryHint,
      verifyCommand: `cdp report ${target} --format json`,
      commands: uniqueNextStepCommands([`cdp report ${target} --format json`]),
    };
  }
  const overlayCommand = overlayCheckCommand(target, targetInput, targetInfo);
  const perceiveCommand = `cdp perceive ${target} -C -d 8`;
  const commands = [];
  if (blockingSignals.includes('overlay-check-needed')) commands.push(overlayCommand);
  if (blockingSignals.includes('frame-check-needed')) commands.push(`cdp frame ${target} --format json`);
  commands.push(perceiveCommand, `cdp report ${target} --format json`);
  return {
    source,
    actionIndex,
    action,
    outcomeStatus: 'no-change',
    strategy: 'investigate-no-change',
    priority: 'medium',
    reason: 'The action dispatched but produced no visible AX tree change; check blockers, frame context, or refreshed refs before retrying.',
    blockingSignals,
    recoveryHint: noChangeRecoveryHint(blockingSignals),
    verifyCommand: perceiveCommand,
    commands: uniqueNextStepCommands(commands),
  };
}

/**
 * Data-driven recovery policy registry.
 * Templates describe strategy/priority/verify + ordered command intents.
 * Concrete CLI strings are resolved in buildActionRecoveryPlan().
 */
export const RECOVERY_POLICY_REGISTRY = Object.freeze({
  'network-failure': {
    strategy: 'inspect-network',
    priority: 'high',
    verify: 'since-action',
    intents: [
      { key: 'netlog', reason: 'Inspect failed or pending requests caused by the action.' },
      { key: 'since-action', reason: 'Verify what the action changed before retrying.' },
      { key: 'report', reason: 'Preserve the action timeline and diagnostics for handoff.' },
    ],
    avoid: ['retrying the same action before checking network state'],
  },
  'network-pending': {
    strategy: 'inspect-network',
    priority: 'medium',
    verify: 'since-action',
    intents: [
      // #533: pending requests are normal after a load (SSE, long poll); check the page first.
      { key: 'next-or-perceive', reason: 'Requests still pending after a load are often long-lived (SSE, long poll); check the page first.' },
      { key: 'netlog', reason: 'Inspect failed or pending requests caused by the action.' },
      { key: 'since-action', reason: 'Verify what the action changed before retrying.' },
      { key: 'report', reason: 'Preserve the action timeline and diagnostics for handoff.' },
    ],
    avoid: ['retrying the same action before checking network state'],
  },
  exception: {
    strategy: 'inspect-runtime-errors',
    priority: 'high',
    verify: 'since-action',
    intents: [
      { key: 'console', reason: 'Inspect page errors triggered by the action.' },
      { key: 'since-action', reason: 'Verify visible UI changes from the action.' },
      { key: 'report', reason: 'Preserve the action timeline and diagnostics for handoff.' },
    ],
    avoid: [],
  },
  'console-error': {
    strategy: 'inspect-runtime-errors',
    priority: 'high',
    verify: 'since-action',
    intents: [
      { key: 'console', reason: 'Inspect page errors triggered by the action.' },
      { key: 'since-action', reason: 'Verify visible UI changes from the action.' },
      { key: 'report', reason: 'Preserve the action timeline and diagnostics for handoff.' },
    ],
    avoid: [],
  },
  overlay: {
    strategy: 'clear-overlay',
    priority: 'high',
    verify: 'perceive',
    intents: [
      { key: 'overlay', reason: 'Confirm which overlay or dialog blocks the target.' },
      { key: 'next-or-dismiss', reason: 'Dismiss the blocking modal or overlay safely.' },
      { key: 'perceive', reason: 'Refresh refs after the overlay changes.' },
    ],
    avoid: ['retrying the same click before clearing or re-checking the overlay'],
  },
  covered: {
    strategy: 'bypass-hit-test',
    priority: 'high',
    verify: 'since-action',
    intents: [
      { key: 'overlay', reason: 'See which element covers the click point.' },
      { key: 'next-or-perceive', reason: 'Close a covering dialog, or JS-click past fixed layout.' },
      { key: 'since-action', reason: 'Confirm the target handler ran.' },
    ],
    avoid: ['retrying the same mouse click while another element covers the click point'],
  },
  misdirected: {
    strategy: 'inspect-misdirected-click',
    priority: 'high',
    verify: 'since-action',
    intents: [
      { key: 'since-action', reason: 'See where the click landed before retrying.' },
      { key: 'next-or-perceive', reason: 'Refresh the page, or retry with jsclick when the intended handler still needs to run.' },
    ],
    avoid: ['treating a misdirected click as proof the control ran'],
  },
  'click-no-change': {
    strategy: 'inspect-unchanged-control',
    priority: 'high',
    verify: 'since-action',
    intents: [
      { key: 'since-action', reason: 'See whether the control reacted before retrying.' },
      { key: 'perceive', reason: 'Refresh refs if the control is stale.' },
    ],
    avoid: ['treating Outcome: no-change on a control that should react as success'],
  },
  'navigation-cancelled': {
    strategy: 'accept-beforeunload-then-retry',
    priority: 'high',
    verify: 'status',
    intents: [
      { key: 'next-or-status', reason: 'Switch dialog handling to accept (discards the page\'s unsaved changes), then retry.' },
      { key: 'status', reason: 'Confirm which page the tab is on.' },
    ],
    avoid: ['retrying reload / nav while dialog handling is dismiss: the beforeunload prompt cancels it again'],
  },
  disabled: {
    strategy: 'wait-or-inspect',
    priority: 'medium',
    verify: 'perceive',
    intents: [
      { key: 'next-or-perceive', reason: 'Wait for the control to become enabled.' },
      { key: 'perceive', reason: 'See which input or state the control is waiting on.' },
    ],
    avoid: ['retrying the same action unchanged while the control is disabled'],
  },
  'no-click-box': {
    strategy: 'use-jsclick',
    priority: 'high',
    verify: 'since-action',
    intents: [
      { key: 'next-or-perceive', reason: 'Run the control with jsclick. A closed dialog has no mouse point.' },
    ],
    avoid: ['clicking at (0, 0) when the target has no box in the viewport'],
  },
  'press-not-delivered': {
    strategy: 'confirm-key-delivery',
    priority: 'high',
    verify: 'perceive',
    intents: [
      { key: 'next-or-perceive', reason: 'Retry a hidden tab with CDP_BACKGROUND=0, or re-read the page.' },
    ],
    avoid: ['treating Pressed as success when the page received no keydown', 'raising the browser window'],
  },
  'no-input-events': {
    strategy: 'use-jsclick',
    priority: 'high',
    verify: 'since-action',
    intents: [
      { key: 'next-or-perceive', reason: 'Retry with jsclick so the page handler actually runs.' },
      { key: 'since-action', reason: 'Confirm the live handler or form control changed.' },
    ],
    avoid: ['treating mouse dispatch.ok as a successful click when the page received no events'],
  },
  'drag-incomplete': {
    strategy: 'inspect-cancelled-drag',
    priority: 'high',
    verify: 'since-action',
    intents: [
      { key: 'since-action', reason: 'See what the cancelled drag changed before retrying.' },
      { key: 'next-or-perceive', reason: 'Retry with a longer gesture or a different source.' },
    ],
    avoid: ['reporting a drag as done when the page never received a drop'],
  },
  'not-in-viewport': {
    strategy: 'bring-into-view',
    priority: 'high',
    verify: 'perceive',
    intents: [
      { key: 'perceive', reason: 'Refresh refs after scrolling both drag points into view.' },
    ],
    avoid: ['retrying a drag whose destination is outside the viewport'],
  },
  'drag-not-started': {
    strategy: 'inspect-pointer-drag',
    priority: 'high',
    verify: 'since-action',
    intents: [
      { key: 'since-action', reason: 'See what the pointer drag changed before retrying.' },
      { key: 'next-or-perceive', reason: 'Pick the draggable element, or drag without --html5.' },
    ],
    avoid: ['retrying drag --html5 on an element that does not start an HTML5 drag'],
  },
  'wrong-frame': {
    strategy: 'refresh-frame-context',
    priority: 'high',
    verify: 'next-or-perceive',
    intents: [
      { key: 'frame', reason: 'List frames and choose the correct frame context.' },
      { key: 'next-or-perceive', reason: 'Refresh page perception before using refs again.' },
    ],
    avoid: ['retrying top-level refs when the control may be inside an iframe'],
  },
  'stale-ref': {
    strategy: 'refresh-perception',
    priority: 'high',
    verify: 'next-or-perceive',
    intents: [
      { key: 'next-or-perceive', reason: 'Refresh current controls and refs.' },
      { key: 'status', reason: 'Check navigation, console, and target health if the page changed.' },
    ],
    avoid: ['retrying stale @refs before refreshing perception'],
  },
  'dom-rewrite': {
    strategy: 'refresh-perception',
    priority: 'high',
    verify: 'next-or-perceive',
    intents: [
      { key: 'next-or-perceive', reason: 'Refresh current controls and refs.' },
      { key: 'status', reason: 'Check navigation, console, and target health if the page changed.' },
    ],
    avoid: ['retrying stale @refs before refreshing perception'],
  },
  navigation: {
    strategy: 'refresh-perception',
    priority: 'high',
    verify: 'next-or-perceive',
    intents: [
      { key: 'next-or-perceive', reason: 'Refresh current controls and refs.' },
      { key: 'status', reason: 'Check navigation, console, and target health if the page changed.' },
    ],
    avoid: ['retrying stale @refs before refreshing perception'],
  },
  selector: {
    strategy: 'refresh-perception',
    priority: 'medium',
    verify: 'next-or-perceive',
    intents: [
      { key: 'next-or-perceive', reason: 'Refresh current controls and refs.' },
      { key: 'status', reason: 'Check navigation, console, and target health if the page changed.' },
    ],
    avoid: ['retrying stale @refs before refreshing perception'],
  },
  timeout: {
    strategy: 'check-tab-health',
    priority: 'medium',
    verify: 'status',
    intents: [
      { key: 'next-or-status', reason: 'Check whether the tab and CDP session are still responsive.' },
      { key: 'since-action', reason: 'If dispatch may have happened, inspect the last-action diff.' },
      { key: 'report', reason: 'Preserve any partial diagnostics already captured.' },
    ],
    avoid: [],
  },
  'observation-timeout': {
    strategy: 'check-tab-health',
    priority: 'medium',
    verify: 'status',
    intents: [
      { key: 'next-or-status', reason: 'Check whether the tab and CDP session are still responsive.' },
      { key: 'since-action', reason: 'If dispatch may have happened, inspect the last-action diff.' },
      { key: 'report', reason: 'Preserve any partial diagnostics already captured.' },
    ],
    avoid: [],
  },
  'observation-error': {
    strategy: 'check-tab-health',
    priority: 'medium',
    verify: 'status',
    intents: [
      { key: 'next-or-status', reason: 'Check whether the tab and CDP session are still responsive.' },
      { key: 'since-action', reason: 'If dispatch may have happened, inspect the last-action diff.' },
      { key: 'report', reason: 'Preserve any partial diagnostics already captured.' },
    ],
    avoid: [],
  },
  // #466: CDP_DENY_ACTIONS / CDP_ALLOWED_ORIGINS refused the command, or it reached a disallowed origin.
  policy: {
    strategy: 'respect-policy',
    priority: 'high',
    verify: 'next-or-status',
    intents: [
      { key: 'next-or-status', reason: 'Go back to an allowed origin, or check where the tab is now.' },
      { key: 'perceive', reason: 'Re-read the page before choosing a command the policy allows.' },
    ],
    avoid: ['retrying the refused command or navigation', 'working around the policy with eval, evalraw, or another command'],
  },
  default: {
    strategy: 'refresh-perception',
    priority: 'medium',
    verify: 'next-or-perceive',
    intents: [
      { key: 'next-or-perceive', reason: 'Refresh perception before choosing the next action.' },
    ],
    avoid: [],
  },
});

export function listRecoveryPolicyKinds() {
  return Object.keys(RECOVERY_POLICY_REGISTRY).filter(kind => kind !== 'default').sort();
}

export function getRecoveryPolicyTemplate(kind) {
  return RECOVERY_POLICY_REGISTRY[kind] || RECOVERY_POLICY_REGISTRY.default;
}

export function buildActionRecoveryPlan(diagnosis = {}, { targetId = '<target>', targetInput = '' } = {}) {
  const target = targetId || '<target>';
  const commandMap = {
    perceive: `cdp perceive ${target} -C -d 8`,
    'since-action': `cdp perceive ${target} --since-action`,
    status: `cdp status ${target}`,
    report: `cdp report ${target} --format json`,
    netlog: `cdp netlog ${target}`,
    console: `cdp console ${target} --errors`,
    frame: `cdp frame ${target} --format json`,
    overlay: overlayCheckCommand(target, targetInput),
    dismiss: `cdp dismiss-modal ${target}`,
  };
  const nextCommand = diagnosis.nextCommand || null;
  const resolveIntent = (key) => {
    if (key === 'next-or-dismiss') return nextCommand || commandMap.dismiss;
    if (key === 'next-or-perceive') return nextCommand || commandMap.perceive;
    if (key === 'next-or-status') return nextCommand || commandMap.status;
    return commandMap[key] || null;
  };
  const template = getRecoveryPolicyTemplate(diagnosis.kind);
  const priority = diagnosis.status === 'blocked'
    ? 'high'
    : (template.priority || 'medium');
  const commands = uniqueRecoveryCommands(
    (template.intents || []).map(intent => {
      const command = resolveIntent(intent.key);
      return command ? recoveryCommand(command, intent.reason) : null;
    }).filter(Boolean),
  );
  const verifyKey = template.verify || 'perceive';
  const verifyCommand = resolveIntent(verifyKey) || commandMap.perceive;
  return {
    schema: 'chrome-cdp-ex.recovery-policy.v1',
    strategy: template.strategy || 'refresh-perception',
    priority,
    commands,
    verifyCommand,
    avoid: Array.isArray(template.avoid) ? [...template.avoid] : [],
    kind: diagnosis.kind || 'unknown',
  };
}

export function recoveryCommandsFromDiagnosis(diagnosis = null) {
  const commands = diagnosis?.recovery?.commands;
  if (Array.isArray(commands) && commands.length) {
    return commands.map(entry => entry?.command).filter(Boolean);
  }
  return diagnosis?.nextCommand ? [diagnosis.nextCommand] : [];
}
