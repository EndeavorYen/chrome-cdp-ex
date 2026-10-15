// Moved from cdp.mjs without changes (#688). cdp.mjs is the entry point and re-exports for tests.
import { actionFailureInput, actionFailureMessage, actionTargetCommandPrefix, buildActionRecoveryPlan, buildNoChangeOutcomeRecommendation, expectedNoChangeReason, formatActionFailureLines, formatFillValueLine, isExpectedLeftoverAxScrollNoChange, isExpectedNoChange, recoveryCommandsFromDiagnosis, uniqueNextStepCommands } from './action-recovery.mjs';
import { CARDS_SCHEMA } from './cards-model.mjs';
import { downloadOutcomeReason, downloadReceiptLines } from './click-download.mjs';
import { summarizeResponseBody } from './netlog.mjs';
import { REDACTED_VALUE, isSensitiveKey, redactSensitiveString, redactUrl, scrubSecretValues } from './redaction.mjs';
import { secretMarker } from './secrets.mjs';
import { formatGeneratedFrame } from './source-maps.mjs';
import { ACTION_JSON_IDENTIFIER_KEYS, ACTION_TEXT_REDACT_WINDOW, DEFAULT_SKINNY_MUTATING_ACTIONS, DOCUMENT_NAV_PLACEHOLDER_RE, DOCUMENT_SCROLL_EDGE_DISPATCH_RE, DOCUMENT_SCROLL_EDGE_OUTCOME, FAILED_REQUEST_BODY_CHARS, FILL_TYPEAHEAD_LIMIT, FILL_TYPEAHEAD_MAX_CHARS, GENERIC_CHANGED_REASON, GENERIC_SINCE_ACTION_HINT, LEFTOVER_AX_SCROLL_CENSUS_RE, LEFTOVER_AX_SCROLL_IDENTITY_HEADER_RE, LEFTOVER_AX_SCROLL_NO_CHANGE_BODY_RE, LEFTOVER_AX_SCROLL_NO_CHANGE_REASON, MAX_ACTION_DELTA_ENTRIES, MAX_ACTION_DIALOG_ENTRIES, MAX_ACTION_DIALOG_MESSAGE_CHARS, MAX_ACTION_DIALOG_TEXT_LINES, MAX_FAILED_REQUEST_DETAILS, NAVIGATION_OBSERVATION_HEADING_RE, NOISY_ACTION_NETWORK_TYPES, SENSITIVE_METADATA_KEY_ALLOWLIST, SOURCE_MAPPED_CONSOLE_LEVELS, STALE_NAVIGATION_BASELINE_REASON } from './cdp-base.mjs';
import { buildQaSummaryModel, formatJson, formatQaSummaryText, parseFormatArgs, truncateTextLines } from './cdp-browser.mjs';
import { targetPrefixForDisplay } from './cdp-cli.mjs';
import { displayLocation, displayObservedText, displayUrl, sliceAtCodePoint } from './cdp-core.mjs';
import { ariaControlStateReceiptClause, keepWithinMaxLength } from './cdp-input.mjs';
import { formatPdfViewerOutput, isPdfViewerContentType, pdfViewerHandoffModel } from './cdp-page.mjs';
import { baselineOutputForActionTarget, formatPerceiveDiffOutput, frameRefFromActionTarget, isCursorRef, isRef, perceiveSnapshotOpts, perceiveStr, resolveSinceActionPerceiveOpts } from './cdp-perceive.mjs';
import { commandArgsNameSecret, compactActionResultForJson, isSensitiveActionTarget, sensitiveActionValues, summarizeActionDomDiff } from './cdp-session-report.mjs';

// Source-maps the entries an agent debugs from (errors, warnings, exceptions). `locate` is the
// daemon resolver's locateEntries; any failure means the generated frames are printed unchanged.
export async function locateObservedEntries(locate, consoleEntries = [], exceptionEntries = []) {
  if (typeof locate !== 'function') return new Map();
  const wanted = [
    ...consoleEntries.filter(entry => SOURCE_MAPPED_CONSOLE_LEVELS.has(String(entry?.level || '').toLowerCase())),
    ...exceptionEntries,
  ].filter(entry => Array.isArray(entry?.frames) && entry.frames.length > 0);
  if (wanted.length === 0) return new Map();
  try {
    const located = await locate(wanted);
    return located instanceof Map ? located : new Map();
  } catch {
    return new Map();
  }
}
export function locatedEntry(located, entry) {
  return located instanceof Map ? located.get(entry) || null : null;
}
export function locatedLoc(located, entry) {
  return locatedEntry(located, entry)?.loc ?? entry?.loc ?? '';
}
// JSON view of a buffer entry: raw frame URLs stay inside the daemon; `stack` carries the
// bounded display frames (source-mapped when resolved).
export function observedJsonEntry(entry, located) {
  const { frames, ...rest } = entry || {};
  const hit = locatedEntry(located, entry);
  const stack = hit?.stack || (Array.isArray(frames) ? frames.map(formatGeneratedFrame).filter(Boolean) : []);
  return { ...rest, ...(hit ? { loc: hit.loc } : {}), ...(stack.length ? { stack } : {}) };
}
export function redactObservedEntry(entry, located, { unsafeFull = false } = {}) {
  const json = observedJsonEntry(entry, located);
  if (unsafeFull || !json || typeof json !== 'object') return json;
  const next = { ...json };
  if (typeof next.text === 'string') next.text = displayObservedText(next.text, entry);
  if (typeof next.msg === 'string') next.msg = displayObservedText(next.msg, entry);
  if (typeof next.message === 'string') next.message = displayObservedText(next.message, entry);
  if (typeof next.loc === 'string') next.loc = displayLocation(next.loc);
  if (Array.isArray(next.stack)) next.stack = next.stack.map(frame => displayLocation(frame));
  return next;
}
export function redactDisplayedPage(page, { unsafeFull = false } = {}) {
  if (!page || typeof page.url !== 'string' || unsafeFull) return page;
  const url = displayUrl(page.url);
  return url === page.url ? page : { ...page, url };
}
export function redactNavigationEntries(entries, { unsafeFull = false } = {}) {
  return (entries || []).map(entry => {
    if (unsafeFull || !entry || typeof entry.url !== 'string') return entry;
    const url = displayUrl(entry.url);
    return url === entry.url ? entry : { ...entry, url };
  });
}
// Caller frames below a source-mapped top frame (at most two more, see SOURCE_MAP_LIMITS).
export function locatedCallerLines(located, entry, { unsafeFull = false } = {}) {
  return (locatedEntry(located, entry)?.stack || []).slice(1).map(frame => `    at ${displayLocation(frame, { unsafeFull })}`);
}
export function formatSummaryText(model) {
  const lines = [];
  lines.push(`Title: ${model.page.title}`);
  lines.push(`URL: ${model.page.url}`);
  lines.push(`Viewport: ${model.viewport.size}`);

  const countParts = Object.entries(model.interactive).map(([k, v]) => `${v} ${k}`);
  lines.push(`Interactive: ${countParts.length > 0 ? countParts.join(', ') : 'none found'}`);

  lines.push(`Focused: ${model.focused}`);

  if (model.viewport.scrollMax > 0) {
    const pct = Math.round(model.viewport.scrollY / model.viewport.scrollMax * 100);
    lines.push(`Scroll: ${model.viewport.scrollY} / ${model.viewport.scrollMax} max (${pct}%)`);
  } else {
    lines.push('Scroll: no scroll');
  }

  const parts = [];
  if (model.console.errors > 0) parts.push(`${model.console.errors} error${model.console.errors > 1 ? 's' : ''}`);
  if (model.console.warnings > 0) parts.push(`${model.console.warnings} warning${model.console.warnings > 1 ? 's' : ''}`);
  if (model.console.exceptions > 0) parts.push(`${model.console.exceptions} exception${model.console.exceptions > 1 ? 's' : ''}`);
  lines.push(`Console: ${parts.length > 0 ? parts.join(', ') : 'clean'}`);

  return lines.join('\n');
}
export function isSensitiveDataKey(key = '') {
  const name = String(key || '');
  if (!name || SENSITIVE_METADATA_KEY_ALLOWLIST.has(name)) return false;
  return isSensitiveKey(name);
}
export function redactSensitiveArtifactValue(value, key = '') {
  if (value == null) return value;
  if (isSensitiveDataKey(key)) return REDACTED_VALUE;
  if (typeof value === 'string') return redactSensitiveString(value);
  if (Array.isArray(value)) return value.map(item => redactSensitiveArtifactValue(item));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      redactSensitiveArtifactValue(entryValue, entryKey),
    ]));
  }
  return value;
}
export function createActionResult({ action, target, dispatch, settle, effects, nextHint }) {
  return applyActionReceipt(applyActionVerdict(applyActionRecommendation(applyActionOutcome(applyActionDiagnosis({
    schema: 'chrome-cdp-ex.action.v1',
    action,
    target,
    dispatch,
    settle,
    effects,
    nextHint,
  })))));
}
export function createActionObservationBaseline({ consoleBuf = null, exceptionBuf = null, netReqBuf = null, dialogBuf = null } = {}) {
  return {
    console: typeof consoleBuf?.latest === 'function' ? consoleBuf.latest() : 0,
    exception: typeof exceptionBuf?.latest === 'function' ? exceptionBuf.latest() : 0,
    network: typeof netReqBuf?.latest === 'function' ? netReqBuf.latest() : 0,
    dialog: typeof dialogBuf?.latest === 'function' ? dialogBuf.latest() : 0,
  };
}
export function compactActionText(value, max = 220) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${sliceAtCodePoint(text, max - 1)}…`;
}
// Redact the whole URL first, then drop scheme://authority and bound it, so a
// secret never survives truncation or re-encoding (#455).
export function compactActionUrl(value) {
  const raw = redactUrl(String(value ?? '').replace(/\s+/g, ' ').trim());
  if (!raw) return '';
  const authority = raw.match(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i);
  if (authority) return compactActionText(raw.slice(authority[0].length) || '/', 180);
  try {
    const url = new URL(raw);
    return compactActionText(`${url.pathname}${url.search}${url.hash}`, 180);
  } catch {
    return compactActionText(raw, 180);
  }
}
export function compactObservationError(err) {
  const message = compactActionText(redactSensitiveString(actionFailureMessage(err)), 240);
  return {
    name: compactActionText(err?.name || err?.constructor?.name || 'Error', 80),
    message: message || 'Post-action observation failed.',
  };
}
export function compactRedactedText(value, { max = 220, truncated = false } = {}) {
  const raw = String(value ?? '');
  const cut = truncated || raw.length > ACTION_TEXT_REDACT_WINDOW;
  const redacted = redactSensitiveString(sliceAtCodePoint(raw, ACTION_TEXT_REDACT_WINDOW), { truncated: cut });
  const text = compactActionText(redacted, max);
  if (!cut || text.endsWith('…')) return text;
  return text.length < max ? `${text}…` : `${sliceAtCodePoint(text, max - 1)}…`;
}
// `located` (#470) maps a buffer entry to its source-mapped location; a source-mapped loc is
// `src/…:line:col (bundle.js:line:col)`, so the bound leaves room for both halves.
export function compactConsoleDeltaEntry(entry = {}, located = null) {
  return {
    level: compactActionText(entry.level || 'log', 30),
    text: compactRedactedText(entry.text || entry.msg || entry.message || '', { truncated: entry.truncated === true }),
    loc: compactActionText(locatedLoc(located, entry), 180),
  };
}
export function compactExceptionDeltaEntry(entry = {}, located = null) {
  return {
    message: compactRedactedText(entry.msg || entry.message || entry.text || 'Unknown exception', { truncated: entry.truncated === true }),
    loc: compactActionText(locatedLoc(located, entry), 180),
  };
}
export function isGitHubWebUrl(url) {
  try {
    const host = new URL(String(url || '')).hostname.toLowerCase();
    return host === 'github.com' || host.endsWith('.github.com');
  } catch {
    return false;
  }
}
export function isIgnorableTelemetryFailure(entry = {}) {
  const url = String(entry.url || '');
  const type = String(entry.type || '');
  if (/\/copilot\/agent-sessions(?:\/|$|\?)/i.test(url)) return true;
  if (/github\.com\/_private\//i.test(url) && Number(entry.status) === 404) return true;
  // GitHub issue/pr chrome (agent_tasks, hovercards, copilot) 404s are not a failed document.
  if (Number(entry.status) === 404 && type !== 'Document' && isGitHubWebUrl(url)) return true;
  if (Number(entry.status) === 404 && type && type !== 'Document') {
    if (/telemetry|collector|analytics|client-events/i.test(url)) return true;
  }
  return false;
}
export function isNetworkFailure(entry = {}) {
  if (isIgnorableTelemetryFailure(entry)) return false;
  if (entry.failed === true || entry.errorText) return true;
  const status = Number(entry.status);
  return Number.isFinite(status) && status >= 400;
}
export function shouldTrackActionNetworkRequest(type) {
  return !NOISY_ACTION_NETWORK_TYPES.has(String(type || ''));
}
export function compactNetworkDeltaEntry(entry = {}) {
  const status = entry.pending ? 'pending' : (entry.errorText ? 'failed' : entry.status);
  return {
    method: compactActionText(entry.method || 'GET', 20).toUpperCase(),
    url: compactActionUrl(entry.url || ''),
    status,
    type: compactActionText(entry.type || '', 40),
    duration: Number.isFinite(entry.duration) ? entry.duration : null,
    errorText: entry.errorText ? compactActionText(entry.errorText, 120) : null,
    pending: entry.pending === true,
  };
}
export function responseHeaderValue(headers, name) {
  if (!headers || typeof headers !== 'object') return null;
  const wanted = String(name).toLowerCase();
  const key = Object.keys(headers).find(header => header.toLowerCase() === wanted);
  return key == null ? null : String(headers[key]);
}
// #648: a request the action sent that failed (status >= 400, or a network error) is named on the
// receipt with its status text, Retry-After and a short redacted body: what `netlog --id N --body`
// prints. At most two, newest last. `readBody(detail)` resolves like readNetlogResponseBody.
export async function describeFailedActionRequests(entries = [], { store = null, readBody = null } = {}) {
  const latest = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry?.requestId || !isNetworkFailure(entry)) continue;
    latest.delete(entry.requestId);
    latest.set(entry.requestId, entry);
  }
  const described = [];
  for (const entry of [...latest.values()].slice(-MAX_FAILED_REQUEST_DETAILS)) {
    const id = store?.idFor?.(entry.requestId) ?? null;
    const detail = id != null ? store.get(id) : null;
    const errorText = entry.errorText ? compactActionText(String(entry.errorText), 120) : null;
    const rawStatus = entry.status ?? detail?.status ?? null;
    const item = {
      id,
      method: compactActionText(String(entry.method || detail?.method || 'GET'), 20).toUpperCase(),
      url: compactActionText(redactUrl(String(detail?.url || entry.url || '')), 160),
      status: errorText || rawStatus == null || !Number.isFinite(Number(rawStatus)) ? null : Number(rawStatus),
      statusText: detail?.statusText ? compactActionText(String(detail.statusText), 60) : null,
      retryAfter: compactActionText(responseHeaderValue(detail?.responseHeaders, 'retry-after') || '', 40) || null,
      errorText,
      body: null,
    };
    if (!errorText && detail && typeof readBody === 'function') {
      try {
        const { result } = await readBody(detail);
        const { model } = summarizeResponseBody(result, { mimeType: detail.mimeType, previewBytes: FAILED_REQUEST_BODY_CHARS * 4 });
        if (model.kind === 'text') {
          const flat = redactSensitiveString(String(model.text || '')).replace(/\s+/g, ' ').trim();
          item.body = { text: flat.slice(0, FAILED_REQUEST_BODY_CHARS), truncated: model.truncated === true || flat.length > FAILED_REQUEST_BODY_CHARS };
        } else {
          item.body = { text: null, truncated: false, summary: model.summary };
        }
      } catch {
        // No body: the line still names the request and its status.
      }
    }
    described.push(item);
  }
  return described;
}
export function formatFailedRequestLine(item = {}) {
  const outcome = item.errorText
    ? `failed (${item.errorText})`
    : `${item.status ?? '?'}${item.statusText ? ` ${item.statusText}` : ''}`;
  const parts = [`Request failed: ${item.id != null ? `#${item.id} ` : ''}${item.method || 'GET'} ${item.url || ''} → ${outcome}`];
  if (item.retryAfter) parts.push(`Retry-After: ${item.retryAfter}`);
  if (item.body?.text != null) parts.push(`body: ${item.body.text || '(empty)'}${item.body.truncated ? ' …' : ''}`);
  else if (item.body?.summary) parts.push(`body: ${item.body.summary}`);
  return parts.join('; ');
}
export function failedRequestLines(result = {}) {
  const list = result.effects?.failedRequests;
  return Array.isArray(list) ? list.map(formatFailedRequestLine) : [];
}
// With the failed request's status and body on the receipt, the next look is how the page
// reacted; without the body, the request detail.
export function failedRequestNextCommand(failedRequests, targetId) {
  const list = Array.isArray(failedRequests) ? failedRequests : [];
  if (!list.length) return `cdp netlog ${targetId}`;
  const missing = list.find(item => !item.errorText && !item.body);
  if (!missing) return `cdp perceive ${targetId} --since-action`;
  return missing.id != null ? `cdp netlog ${targetId} --id ${missing.id} --body` : `cdp netlog ${targetId}`;
}
// Puts lines just before the receipt's Next, so Next stays the last line (#533).
export function insertBeforeNextLine(text, extra = []) {
  if (!extra.length) return text;
  const lines = String(text).split('\n');
  const at = lines.findIndex(line => /(?:^|\.\s)Next: /.test(line));
  if (at === -1) return [...lines, ...extra].join('\n');
  const split = lines[at].match(/^(.*?\S)\.\s+(Next: .*)$/);
  return [
    ...lines.slice(0, at),
    ...(split ? [`${split[1]}.`] : []),
    ...extra,
    split ? split[2] : lines[at],
    ...lines.slice(at + 1),
  ].join('\n');
}
// Keeps the origin (which site raised the dialog); secrets go through the shared URL redactor (#455).
export function compactDialogUrl(value) {
  return compactActionText(redactUrl(String(value ?? '').trim()), 240);
}
// A JavaScript dialog the daemon answered on the user's behalf during the action (#460).
export function compactDialogDeltaEntry(entry = {}) {
  const url = compactDialogUrl(entry.url);
  return {
    type: compactActionText(entry.type || 'alert', 30),
    message: compactActionText(redactSensitiveString(entry.message || ''), MAX_ACTION_DIALOG_MESSAGE_CHARS),
    accepted: entry.accepted !== false,
    ...(url ? { url } : {}),
    ...(entry.handled === false ? { handled: false } : {}),
  };
}
export function normalizeDialogDelta(delta = {}) {
  const entries = (Array.isArray(delta.entries) ? delta.entries : [])
    .slice(0, MAX_ACTION_DIALOG_ENTRIES)
    .map(compactDialogDeltaEntry);
  return {
    count: Math.max(numericDeltaCount(delta.count, entries.length), entries.length),
    entries,
  };
}
export function actionDialogLine(dialog = {}) {
  const message = dialog.message ? ` "${dialog.message}"` : '';
  const answer = dialog.accepted === false ? 'dismiss' : 'accept';
  if (dialog.handled === false) {
    return `Dialog: ${dialog.type}${message} → ${answer} failed; the dialog may still be open`;
  }
  let note = '';
  if (dialog.type === 'beforeunload') {
    note = dialog.accepted === false
      ? ' (navigation was cancelled; the page stayed)'
      : ' (any unsaved changes on the page being left were discarded)';
  }
  return `Dialog: ${dialog.type}${message} → ${answer}ed${note}`;
}
// Optional `dialogs` / `dialogsOmitted` fields for models derived from an action result.
export function actionDialogFields(effects = {}) {
  const dialogs = Array.isArray(effects?.dialogs) ? effects.dialogs : [];
  if (!dialogs.length) return {};
  const omitted = numericDeltaCount(effects.dialogsOmitted, 0);
  return { dialogs, ...(omitted > 0 ? { dialogsOmitted: omitted } : {}) };
}
export function actionDialogLines(effects = {}) {
  const dialogs = Array.isArray(effects.dialogs) ? effects.dialogs : [];
  if (!dialogs.length) return [];
  const lines = dialogs.slice(0, MAX_ACTION_DIALOG_TEXT_LINES).map(actionDialogLine);
  const more = dialogs.length - lines.length + numericDeltaCount(effects.dialogsOmitted, 0);
  if (more > 0) lines.push(`Dialog: and ${more} more`);
  return lines;
}
export function buildActionObservationDelta({ consoleBuf = null, exceptionBuf = null, netReqBuf = null, dialogBuf = null } = {}, baseline = {}, located = null) {
  const consoleEntries = typeof consoleBuf?.since === 'function' ? consoleBuf.since(baseline.console || 0) : [];
  const exceptionEntries = typeof exceptionBuf?.since === 'function' ? exceptionBuf.since(baseline.exception || 0) : [];
  const networkEntries = typeof netReqBuf?.since === 'function' ? netReqBuf.since(baseline.network || 0) : [];
  const dialogEntries = typeof dialogBuf?.since === 'function' ? dialogBuf.since(baseline.dialog || 0) : [];
  // The ring buffer may have rotated out early dialogs; the sequence counter still counts them.
  const dialogCount = typeof dialogBuf?.latest === 'function'
    ? Math.max(dialogEntries.length, dialogBuf.latest() - (baseline.dialog || 0))
    : dialogEntries.length;
  const consoleCompact = consoleEntries.slice(-MAX_ACTION_DELTA_ENTRIES).map(entry => compactConsoleDeltaEntry(entry, located));
  const exceptionCompact = exceptionEntries.slice(-MAX_ACTION_DELTA_ENTRIES).map(entry => compactExceptionDeltaEntry(entry, located));
  const networkCompact = networkEntries.slice(-MAX_ACTION_DELTA_ENTRIES).map(compactNetworkDeltaEntry);
  return {
    console: {
      count: consoleEntries.length,
      errors: consoleEntries.filter(entry => ['error', 'assert'].includes(String(entry.level || '').toLowerCase())).length,
      warnings: consoleEntries.filter(entry => ['warning', 'warn'].includes(String(entry.level || '').toLowerCase())).length,
      entries: consoleCompact,
    },
    exceptions: {
      count: exceptionEntries.length,
      entries: exceptionCompact,
    },
    network: {
      count: networkEntries.length,
      failures: networkEntries.filter(isNetworkFailure).length,
      pending: networkEntries.filter(entry => entry.pending === true).length,
      entries: networkCompact,
    },
    dialogs: normalizeDialogDelta({ count: dialogCount, entries: dialogEntries }),
  };
}
// Same delta, with the receipt's console errors and exceptions source-mapped first (#470).
export async function buildLocatedActionObservationDelta(buffers = {}, baseline = {}, locate = null) {
  const { consoleBuf = null, exceptionBuf = null } = buffers;
  const consoleEntries = typeof consoleBuf?.since === 'function' ? consoleBuf.since(baseline.console || 0) : [];
  const exceptionEntries = typeof exceptionBuf?.since === 'function' ? exceptionBuf.since(baseline.exception || 0) : [];
  const located = await locateObservedEntries(
    locate,
    consoleEntries.slice(-MAX_ACTION_DELTA_ENTRIES),
    exceptionEntries.slice(-MAX_ACTION_DELTA_ENTRIES),
  );
  return buildActionObservationDelta(buffers, baseline, located);
}
export function numericDeltaCount(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
export function normalizeConsoleDelta(delta = {}) {
  const entries = (delta.entries || []).slice(-MAX_ACTION_DELTA_ENTRIES).map(entry => compactConsoleDeltaEntry(entry));
  return {
    count: numericDeltaCount(delta.count, entries.length),
    errors: numericDeltaCount(delta.errors, entries.filter(entry => ['error', 'assert'].includes(String(entry.level || '').toLowerCase())).length),
    warnings: numericDeltaCount(delta.warnings, entries.filter(entry => ['warning', 'warn'].includes(String(entry.level || '').toLowerCase())).length),
    entries,
  };
}
export function normalizeExceptionDelta(delta = {}) {
  const entries = (delta.entries || []).slice(-MAX_ACTION_DELTA_ENTRIES).map(entry => compactExceptionDeltaEntry(entry));
  return {
    count: numericDeltaCount(delta.count, entries.length),
    entries,
  };
}
export function normalizeNetworkDelta(delta = {}) {
  const rawEntries = (delta.entries || []).slice(-MAX_ACTION_DELTA_ENTRIES);
  const computedFailures = rawEntries.filter(isNetworkFailure).length;
  const entries = rawEntries.map(compactNetworkDeltaEntry);
  return {
    count: numericDeltaCount(delta.count, entries.length),
    failures: Number.isFinite(Number(delta.failures))
      ? numericDeltaCount(delta.failures, computedFailures)
      : computedFailures,
    pending: numericDeltaCount(delta.pending, entries.filter(entry => entry.pending === true).length),
    entries,
  };
}
export function noBaselineActionDiffText() {
  return 'No changes detected.';
}
// The settle result of an action that had no baseline. When the first-action
// snapshot failed (#504) nothing was compared, so the DOM observation is null
// (Outcome: dispatched) rather than a no-change the page never showed.
export function noBaselineActionDiff(afterOutput, { captureFailed = false } = {}) {
  if (isPdfViewerPerceiveOutput(afterOutput)) return pdfViewerSettleDiffText();
  if (captureFailed) return null;
  return noBaselineActionDiffText();
}
// `perceive -i` prints controls only, so two -i trees cannot show a click whose
// only effect is page text such as a status <p> (#487). The diff source of a
// perceive is its printed output plus the StaticText the -i filter hid; action
// settle, --since-action and --diff compare diff sources, not printed trees.
export function perceiveDiffSourceText(output, hiddenTextLines = []) {
  if (!output || !hiddenTextLines?.length) return output;
  return `${output}\n${hiddenTextLines.join('\n')}`;
}
export function rememberPerceiveDiffSource(store, output, hiddenTextLines = [], identityOutput = null) {
  // `identityOutput` is the same tree with a backend-node mark on each @ref
  // line. Diffs use it so a replaced node is not the same line as its twin
  // (#651). The printed perceive stays `output`.
  const base = identityOutput && identityOutput !== output ? identityOutput : output;
  const text = perceiveDiffSourceText(base, hiddenTextLines);
  store.diffSource = text !== output ? { output, text } : null;
}
// Paths that overwrite `store.output` without a tree (cards, pdf-viewer, hover
// discard) leave a stale diffSource behind; it only applies to its own output.
export function perceiveStoreDiffSource(store) {
  const output = store?.output ?? null;
  if (output && store.diffSource?.output === output) return store.diffSource.text;
  return output;
}
export function isPdfViewerPerceiveOutput(output) {
  return String(output || '').includes('chrome-cdp-ex.pdf-viewer.v1');
}
export function pdfViewerSettleDiffText() {
  return 'No changes detected (settle shape was pdf-viewer.v1; empty AX).';
}
export function rememberPdfViewerPerceive(lastPerceiveStore, opts, output) {
  lastPerceiveStore.output = output;
  lastPerceiveStore.snapshotOpts = perceiveSnapshotOpts({ ...opts, cards: false });
}
export function pdfViewerPerceiveResult(lastPerceiveStore, opts, output) {
  rememberPdfViewerPerceive(lastPerceiveStore, opts, output);
  if (!opts.sinceAction) return output;
  if (!opts.diffBaseline || isPdfViewerPerceiveOutput(opts.diffBaseline)) {
    return pdfViewerSettleDiffText();
  }
  return formatPerceiveDiffOutput(opts.diffBaseline, output, { mode: 'since-action' });
}
export function isCardsPerceiveOutput(output) {
  return String(output || '').includes(CARDS_SCHEMA);
}
export function leftoverCardsCount(output) {
  const match = String(output || '').match(/chrome-cdp-ex\.cards\.v1\s+(\d+)\s+cards?\b/i);
  return match ? Number(match[1]) : 0;
}
export function isScrollActionTarget(actionTarget = {}) {
  return String(actionTarget.resolvedBy || '').toLowerCase() === 'scroll'
    || String(actionTarget.action || '').toLowerCase() === 'scroll';
}
export function isLeftoverDefaultAxScrollSettle(output, snapshotOpts = null, actionTarget = {}) {
  // Leftover golden-path / default AX (`perceive -C -d 8`) is the settle
  // shape for the next scroll (#295/#297/#299/#301/#311/#313). Viewport @ref rect chrome and
  // fold tags are not a page mutation. Visible-control cap-swap membership
  // is still changed, but the receipt summarizes it with unique named samples
  // (shared commit titles do not occupy both sides, #307) and
  // Next `-C -d 8` without Hint `--since-action` or a generic Recovery hint.
  // Honest leftover-ax-scroll no-change whose Next is already perceive does
  // not reprint "re-run perceive -C -d 8 instead of report" (#311), the
  // settle-shape Outcome reason essay (#313), the reprinted Page /
  // Viewport identity header (#316), the tautological AX body
  // "(no changes detected in AX tree)" (#318), or the tautological
  // "scroll: dispatched via scroll" / "Target: down" restatement (#320).
  // Outcome already states no-change. Position already states scroll
  // identity. Leftover-ax-scroll changed still prints dispatched/Target.
  // Cards / pdf-viewer / framed leftovers keep their own settle gates.
  if (!isScrollActionTarget(actionTarget)) return false;
  if (isPdfViewerPerceiveOutput(output)) return false;
  if (snapshotOpts?.cards === true || isCardsPerceiveOutput(output)) return false;
  if (snapshotOpts?.frameRef || isFramedPerceiveOutput(output)) return false;
  const text = String(output || '');
  return /^Page: /m.test(text) && /^Viewport: /m.test(text);
}
export function isDocumentScrollEdgeTarget(actionTarget = {}) {
  return actionTarget?.expectedOutcome === DOCUMENT_SCROLL_EDGE_OUTCOME;
}
export function tagScrollLeftoverSettle(action, actionTarget, output, snapshotOpts = null) {
  // Edge forms are report-only (`to top` / `to bottom` for the window
  // document or nested overflow). After leftover `perceive -C -d 8` they
  // must not inherit leftover-ax-scroll-no-change (or leftover cards) so
  // the receipt does not grow Next: perceive -C -d 8.
  // Relative `scroll down N` still uses settle-diff leftover tagging.
  if (!actionTarget || action !== 'scroll') return actionTarget;
  if (isDocumentScrollEdgeTarget(actionTarget)) return actionTarget;
  if (isLeftoverFeedCardsSettle(output, snapshotOpts, actionTarget)) {
    actionTarget.expectedOutcome = actionTarget.expectedOutcome || 'cards-window-no-change';
  }
  if (isLeftoverDefaultAxScrollSettle(output, snapshotOpts, actionTarget)) {
    actionTarget.expectedOutcome = actionTarget.expectedOutcome || 'leftover-ax-scroll-no-change';
  }
  return actionTarget;
}
export function isLeftoverFeedCardsSettle(output, snapshotOpts = null, actionTarget = {}) {
  // Leftover --cards / --role feed with a real feed window is the settle
  // shape for the next scroll (#293). 0-card leftovers still recapture
  // default AX (#257/#279). Non-scroll mutators still recapture AX so a
  // like/click is not hidden behind cards.
  if (!isScrollActionTarget(actionTarget)) return false;
  if (!(snapshotOpts?.cards === true || isCardsPerceiveOutput(output))) return false;
  return leftoverCardsCount(output) > 0;
}
export function framedPerceiveRefFromOutput(output) {
  const match = String(output || '').match(/^Frame: (@f\d+)\b/m);
  return match ? match[1] : null;
}
export function isFramedPerceiveOutput(output) {
  return framedPerceiveRefFromOutput(output) != null;
}
export function shouldCaptureTopLevelActionSettle(snapshotOpts = null, output = null, actionTarget = {}) {
  // Frame-scoped settle is only for actions that targeted @fN / @fN:M.
  if (frameRefFromActionTarget(actionTarget)) return false;
  // Leftover pdf-viewer.v1 is an empty-AX plugin stub, not a tree. Recapturing
  // it would re-poison settle with the same stub (#282). Do not treat it as
  // leftover cards/frames, which recapture a real AX baseline (#257/#279).
  if (isPdfViewerPerceiveOutput(output)) return false;
  // Leftover --cards / --role feed dumps are a feed view, not an AX settle
  // shape. Discarding them (#257) without a before-snapshot made a mutating
  // click --js report no-change / "No visible AX tree change" while the
  // handler ran (#279). Recapture default AX so live text changes are
  // Outcome:changed. Leftover-cards + Escape still settles as no-change
  // against that recaptured tree. Leftover N>0 cards then scroll keeps the
  // cards window (#293) and must not recapture full AX.
  if (isLeftoverFeedCardsSettle(output, snapshotOpts, actionTarget)) return false;
  if (snapshotOpts?.cards === true || isCardsPerceiveOutput(output)) return true;
  return Boolean(snapshotOpts?.frameRef) || isFramedPerceiveOutput(output);
}
export function actionSettleBaseline(output, snapshotOpts = null, actionTarget = {}) {
  // Leftover pdf-viewer.v1 is not an AX settle baseline. Reusing the empty
  // stub after perceive makes no-op press (Escape / Arrow*) look like a page
  // change (#282). Discard it and do not recapture — the next perceive is
  // still the same stub.
  if (isPdfViewerPerceiveOutput(output)) {
    return { output: null, opts: snapshotOpts || null };
  }
  // Compact --cards dumps are a feed view, not an AX settle baseline. Reusing
  // them after a 0-card page makes no-op press/type/clickxy look like a DOM
  // change (#257). Recapture default AX before the action (#279) instead of
  // settling as "No changes detected." Leftover N>0 cards then scroll keeps
  // that feed window so timestamp chrome is not a fake AX change (#293).
  if (isLeftoverFeedCardsSettle(output, snapshotOpts, actionTarget)) {
    return {
      output: output || null,
      opts: snapshotOpts ? { ...snapshotOpts, cards: true } : { cards: true },
    };
  }
  if (snapshotOpts?.cards === true || isCardsPerceiveOutput(output)) {
    return {
      output: null,
      opts: snapshotOpts ? { ...snapshotOpts, cards: false } : null,
    };
  }
  const actionFrame = frameRefFromActionTarget(actionTarget);
  const outputFrame = framedPerceiveRefFromOutput(output);
  const opts = snapshotOpts
    ? { ...snapshotOpts, frameRef: actionFrame }
    : snapshotOpts;
  // Leftover perceive --frame dumps are an iframe view. Reusing them after a
  // top-level fill/select/upload/click makes a real page mutation look like a
  // no-op against the child AX tree.
  if (outputFrame && outputFrame !== actionFrame) {
    return { output: null, opts: opts || null };
  }
  if (!actionFrame && snapshotOpts?.frameRef) {
    return { output: null, opts: opts || null };
  }
  return { output: output || null, opts: opts || null };
}
export function actionSkipsSettleBaseline(actionTarget = {}, feedbackPolicy = 'settle-diff', observe = null) {
  // Report-only receipts and custom observers never diff against the baseline.
  if (observe || feedbackPolicy === 'none' || feedbackPolicy === 'report-only') return true;
  // A fresh daemon has no live refs: the @ref dispatch fails as stale anyway.
  const input = String(actionTarget?.input || '');
  return isRef(input) || isCursorRef(input) || Boolean(frameRefFromActionTarget(actionTarget));
}
export function shouldCaptureFirstActionBaseline(lastPerceiveStore, actionTarget = {}, feedbackPolicy = 'settle-diff', observe = null) {
  // #504: a daemon that has not perceived yet (fresh attach or restart) has no
  // leftover tree to diff against. Without a before-snapshot the settle step
  // only saw the page after the action and reported no-change for a click that
  // changed it. An idle-hover discard leaves snapshotOpts set; it is not a
  // fresh daemon and keeps its own rule (#291).
  if (lastPerceiveStore?.output != null || lastPerceiveStore?.snapshotOpts != null) return false;
  if (actionSkipsSettleBaseline(actionTarget, feedbackPolicy, observe)) return false;
  return true;
}
export function shouldRecaptureNavigatedBaseline(lastPerceiveStore, refState, actionTarget = {}, feedbackPolicy = 'settle-diff', observe = null) {
  // #589: Page.frameNavigated on the main frame (a page script reload,
  // location.href assignment, or the tool's own nav) invalidates refs and
  // leaves the previous document's AX snapshot in place. The next settle
  // must compare against the document that is loaded. A menu that was open,
  // then the page reloaded, then the click opens it again, otherwise diffs
  // as no-change. An idle-hover discard is not a navigation (#291).
  if (refState?.invalidationReason !== 'navigation') return false;
  if (lastPerceiveStore?.output == null && lastPerceiveStore?.snapshotOpts == null) return false;
  if (actionSkipsSettleBaseline(actionTarget, feedbackPolicy, observe)) return false;
  return true;
}
// The capture writes to its own store and ref map. Assigning session refs here
// would let a leftover @ref from the previous daemon resolve against numbers
// the agent never saw, and clear the daemon-start stale-ref state.
export async function captureFirstActionBaseline(cdp, sid, consoleBuf, exceptionBuf, targetId) {
  const store = { output: null, model: null, snapshotOpts: null, cards: null };
  const opts = actionObservationPerceiveOpts(targetId);
  const output = await perceiveStr(cdp, sid, consoleBuf, exceptionBuf, new Map(), store, opts, null);
  return {
    output: perceiveStoreDiffSource(store) ?? output,
    snapshotOpts: store.snapshotOpts || perceiveSnapshotOpts(opts),
  };
}
// One capture of the loaded document. If a main-frame navigation commits
// while that capture is in flight, the first tree can still be the previous
// document; take one more after the commit.
export async function captureActionDocumentBaseline(cdp, sid, consoleBuf, exceptionBuf, targetId, pageGeneration) {
  const readGeneration = () => (typeof pageGeneration === 'function' ? pageGeneration() : pageGeneration);
  const before = readGeneration();
  let captured = await captureFirstActionBaseline(cdp, sid, consoleBuf, exceptionBuf, targetId);
  const after = readGeneration();
  if (before != null && after != null && before !== after) {
    captured = await captureFirstActionBaseline(cdp, sid, consoleBuf, exceptionBuf, targetId);
  }
  return captured;
}
// What an action's settle step diffs against: the leftover perceive in its own
// shape, a recaptured top-level tree when the leftover is a cards/frame view
// (#257/#279), a fresh capture when the daemon has not perceived yet (#504),
// or a fresh capture when that leftover tree belongs to a document the page
// has since navigated away from (#589).
export async function resolveActionSettleBaseline({
  cdp, sid, consoleBuf, exceptionBuf, refMap, refState, lastPerceiveStore, targetId,
  action, actionTarget, feedbackPolicy = 'settle-diff', observe = null, pageGeneration = null,
}) {
  let baselineFromTarget = baselineOutputForActionTarget(refState, perceiveStoreDiffSource(lastPerceiveStore), actionTarget);
  let baselineSnapshotOpts = lastPerceiveStore.snapshotOpts || null;
  if (shouldCaptureFirstActionBaseline(lastPerceiveStore, actionTarget, feedbackPolicy, observe)) {
    let first;
    try {
      first = await captureActionDocumentBaseline(cdp, sid, consoleBuf, exceptionBuf, targetId, pageGeneration);
    } catch {
      // A failed snapshot must not fail the action: dispatch it without a
      // baseline, and let the receipt say the DOM change was not observed.
      return { output: null, opts: null, captureFailed: true };
    }
    baselineFromTarget = first.output;
    baselineSnapshotOpts = first.snapshotOpts;
  } else if (shouldRecaptureNavigatedBaseline(lastPerceiveStore, refState, actionTarget, feedbackPolicy, observe)) {
    let fresh;
    try {
      fresh = await captureActionDocumentBaseline(cdp, sid, consoleBuf, exceptionBuf, targetId, pageGeneration);
    } catch {
      // Keep the previous document's tree out of the comparison. The receipt
      // says the baseline is stale instead of reporting a failed click.
      return { output: null, opts: null, captureFailed: true, baselineStale: true };
    }
    baselineFromTarget = fresh.output;
    baselineSnapshotOpts = fresh.snapshotOpts;
  }
  let settleBaseline = actionSettleBaseline(
    baselineFromTarget,
    baselineSnapshotOpts,
    actionTarget,
  );
  if (isPdfViewerPerceiveOutput(baselineFromTarget)) {
    actionTarget.expectedOutcome = actionTarget.expectedOutcome || 'pdf-viewer-no-change';
  }
  tagScrollLeftoverSettle(
    action,
    actionTarget,
    baselineFromTarget,
    baselineSnapshotOpts,
  );
  if (
    !settleBaseline.output
    && shouldCaptureTopLevelActionSettle(
      baselineSnapshotOpts,
      baselineFromTarget,
      actionTarget,
    )
  ) {
    const topLevelOpts = actionObservationPerceiveOpts(targetId, {
      ...(settleBaseline.opts || {}),
      frameRef: null,
    });
    const before = await perceiveStr(
      cdp,
      sid,
      consoleBuf,
      exceptionBuf,
      refMap,
      lastPerceiveStore,
      topLevelOpts,
      refState,
    );
    settleBaseline = {
      output: perceiveStoreDiffSource(lastPerceiveStore) ?? before,
      opts: perceiveSnapshotOpts(topLevelOpts),
    };
  }
  return settleBaseline;
}
export function actionDomDiffShowsChange(domDiff) {
  const text = String(domDiff || '').trim();
  if (!text) return false;
  if (/no changes detected/i.test(text)) return false;
  if (/no action baseline available/i.test(text)) return false;
  if (/unchanged; still first cards/i.test(text)) return false;
  if (/\bunchanged\b/i.test(text) && /virtualized window/i.test(text)) return false;
  // Empty-AX PDF plugin stubs are not an AX diff. Identical leftover
  // pdf-viewer.v1 reprints are not evidence of a page change (#282).
  if (isPdfViewerPerceiveOutput(text)) return false;
  return true;
}
export function comparableActionHref(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    url.hash = '';
    return url.href;
  } catch {
    return raw;
  }
}
export function shouldSkipActionDomSettle(beforeUrl, afterUrl) {
  const from = comparableActionHref(beforeUrl);
  const to = comparableActionHref(afterUrl);
  return Boolean(from && to && from !== to);
}
export function formatActionNavigationDiff(fromUrl, toUrl) {
  return `Navigated ${String(fromUrl || '').trim()} -> ${String(toUrl || '').trim()}`;
}
export function actionNetworkShowsDocumentNavigation(networkDelta = {}) {
  return (networkDelta.entries || []).some((entry) => {
    const type = String(entry.type || '');
    const method = String(entry.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') return false;
    if (type !== 'Document') return false;
    if (entry.failed === true || entry.errorText) return false;
    return true;
  });
}
export function actionNavigationEvidence(actionResult = {}) {
  const effects = actionResult.effects || {};
  const nav = effects.navigation;
  let from = '';
  let to = '';
  if (nav && typeof nav === 'object') {
    from = String(nav.from || nav.before || nav.pageHref || '');
    to = String(nav.to || nav.after || nav.url || nav.href || '');
  } else if (typeof nav === 'string') {
    to = nav;
  }
  const before = from
    || String(effects.page?.url || actionResult.target?.pageHrefBefore || actionResult.target?.pageHref || actionResult.target?.page?.url || '');
  const after = to
    || String(effects.pageHealth?.evidence?.url || effects.pageHealth?.url || actionResult.target?.pageHrefAfter || '');
  const hrefChanged = shouldSkipActionDomSettle(before, after) || nav?.changed === true;
  const documentNavigation = actionNetworkShowsDocumentNavigation(effects.networkDelta || {});
  return {
    from: before,
    to: after,
    hrefChanged,
    documentNavigation,
    navigated: Boolean(hrefChanged || documentNavigation),
  };
}
export function actionHasDomObservation(actionResult = {}) {
  return Object.prototype.hasOwnProperty.call(actionResult.effects || {}, 'domDiff')
    && actionResult.effects.domDiff !== null
    && actionResult.effects.domDiff !== undefined;
}
export function viewportApplicationOf(actionResult = {}) {
  if (String(actionResult.action || '').toLowerCase() !== 'viewport') return null;
  const app = actionResult.target?.viewportApplication;
  if (!app || typeof app !== 'object' || !app.requested) return null;
  return app;
}
export function isViewportSizeMismatch(actionResult = {}) {
  const app = viewportApplicationOf(actionResult);
  return Boolean(app && app.applied === false);
}
export function buildActionOutcome(actionResult = {}) {
  const effects = actionResult.effects || {};
  const diagnosis = effects.diagnosis || null;
  const domObserved = actionHasDomObservation(actionResult);
  const navigation = actionNavigationEvidence(actionResult);
  const controlStateChanged = Boolean(
    actionResult.target?.controlStateChanged
    || effects.controlStateChanged
  );
  const changed = actionDomDiffShowsChange(effects.domDiff) || navigation.navigated || controlStateChanged;
  const base = {
    schema: 'chrome-cdp-ex.action-outcome.v1',
    changed: domObserved || navigation.navigated || controlStateChanged ? changed : null,
    needsAttention: false,
  };

  if (actionResult.dispatch?.ok === false || effects.failure?.kind) {
    return {
      ...base,
      status: 'failed',
      // A failed fill can still have mutated the control (fill-value-mismatch): say so.
      changed: effects.failure?.pageChanged === true,
      needsAttention: true,
      evidence: 'dispatch',
      reason: effects.failure?.reason || 'Action failed before dispatch completed.',
    };
  }

  if (diagnosis?.kind === 'observation-error' || effects.observationError?.message) {
    return {
      ...base,
      status: 'attention',
      needsAttention: true,
      evidence: 'observation',
      reason: diagnosis.reason || 'Action dispatched, but post-action observation failed.',
    };
  }

  if (actionResult.dispatch?.ok === true && actionResult.settle?.ok === false) {
    return {
      ...base,
      status: 'timeout',
      needsAttention: true,
      evidence: 'settle',
      reason: 'Action dispatched, but post-action observation timed out.',
    };
  }

  if (diagnosis && diagnosis.status !== 'ok') {
    return {
      ...base,
      status: 'attention',
      needsAttention: true,
      evidence: diagnosis.source || 'diagnosis',
      reason: diagnosis.reason || 'Action needs follow-up.',
    };
  }

  if (effects.openedTab) {
    return {
      ...base,
      status: 'changed',
      changed: true,
      evidence: 'new-tab',
      reason: `The link opened ${effects.openedTab.existing ? 'in tab' : 'a new tab'} ${effects.openedTab.targetPrefix} (${effects.openedTab.url}).`,
    };
  }

  // #472: a file the click downloaded is the click's result, even when the page itself did not change.
  if (effects.download?.state === 'completed') {
    return {
      ...base,
      status: 'changed',
      changed: true,
      evidence: 'download',
      reason: downloadOutcomeReason(effects.download),
    };
  }

  // #639: a download the browser started, or a download attribute with no event.
  // Neither is an AX change, and neither may be retried.
  if (effects.download?.state === 'started') {
    return {
      ...base,
      status: 'changed',
      changed: true,
      evidence: 'download',
      reason: `Download started "${effects.download.filename}".`,
    };
  }
  if (effects.download?.state === 'unobserved') {
    return {
      ...base,
      status: 'dispatched',
      changed: null,
      needsAttention: false,
      evidence: 'download',
      reason: 'The link asks for a download and no download event was observed.',
    };
  }

  if (effects.childFrame) {
    if (effects.childFrame.delivered === true) {
      return {
        ...base,
        status: 'changed',
        changed: true,
        evidence: 'child-frame',
        reason: 'Mouse and click events were delivered to a child frame.',
      };
    }
    return {
      ...base,
      status: 'dispatched',
      changed: null,
      needsAttention: false,
      evidence: 'child-frame',
      reason: 'The click point is a child frame, and events in that frame could not be observed.',
    };
  }

  if (navigation.navigated) {
    return {
      ...base,
      status: 'changed',
      changed: true,
      evidence: 'navigation',
      reason: navigation.hrefChanged && navigation.from && navigation.to
        ? `Page navigated from ${navigation.from} to ${navigation.to}.`
        : 'Observed a document navigation after the action.',
    };
  }

  // #578: a viewport resize succeeds when the page reads back the requested
  // size. An unchanged AX tree is not a failure, and a mismatch is not an
  // AX no-change investigation.
  const viewport = viewportApplicationOf(actionResult);
  if (viewport) {
    if (viewport.applied) {
      return {
        ...base,
        status: 'changed',
        changed: true,
        needsAttention: false,
        evidence: 'viewport',
        reason: viewport.reason || `Viewport ${viewport.requested.width}x${viewport.requested.height} applied.`,
      };
    }
    return {
      ...base,
      status: 'attention',
      changed: false,
      needsAttention: true,
      evidence: 'viewport',
      reason: viewport.reason || `Requested ${viewport.requested.width}x${viewport.requested.height}; read back did not match.`,
    };
  }

  if (changed) {
    return {
      ...base,
      status: 'changed',
      changed: true,
      evidence: 'dom',
      reason: 'Observed page change after action.',
    };
  }

  if (domObserved) {
    const expectedNoChange = isExpectedNoChange(
      actionResult.target,
      actionResult.effects?.domDiff,
      actionResult.action,
    );
    return {
      ...base,
      status: 'no-change',
      changed: false,
      needsAttention: !expectedNoChange,
      evidence: 'dom',
      reason: expectedNoChange
        ? expectedNoChangeReason(actionResult.target, actionResult.action, actionResult.effects?.domDiff)
        : 'No visible AX tree change observed after action.',
    };
  }

  const baselineStale = actionResult.target?.baselineStale === true || effects.baselineStale === true;
  return {
    ...base,
    status: 'dispatched',
    evidence: 'dispatch',
    reason: baselineStale
      ? STALE_NAVIGATION_BASELINE_REASON
      : 'Action dispatched; no DOM observation was captured for this command.',
  };
}
export function applyActionOutcome(actionResult) {
  actionResult.outcome = buildActionOutcome(actionResult);
  return actionResult;
}
export function stableActionHash(value = {}) {
  const text = JSON.stringify(value, Object.keys(value || {}).sort());
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
export function buildActionId(actionResult = {}) {
  const seed = {
    action: actionResult.action || '',
    target: actionResult.target?.label || actionResult.target?.input || '',
    dispatch: actionResult.dispatch?.method || '',
    settle: actionResult.settle?.durationMs || 0,
    outcome: actionResult.outcome?.status || '',
  };
  const first = stableActionHash(seed);
  const second = stableActionHash({ ...seed, dispatchOk: actionResult.dispatch?.ok === true });
  return `act_${first}${second.slice(0, 4)}`;
}
export function actionTargetSummary(actionResult = {}) {
  const target = actionResult.target || {};
  return compactActionText(target.label || target.input || target.selector || target.resolvedBy || actionResult.action || '', 160) || null;
}
export function actionSettlementStrategy(actionResult = {}) {
  if (actionResult.dispatch?.ok === false) return 'dispatch-failed';
  if (actionResult.effects?.failure?.kind) return 'dispatch-failed';
  if (actionResult.effects?.observationError?.message) return 'observation-error';
  if (actionResult.settle?.ok === false) return 'timeout';
  if (actionResult.effects?.domDiff != null) return 'dom-observation';
  return 'report-only';
}
export function actionSettlementObservedChannels(actionResult = {}) {
  const effects = actionResult.effects || {};
  const channels = [];
  if (actionResult.dispatch?.ok === false || effects.failure?.kind) channels.push('dispatch');
  if (effects.domDiff != null) channels.push('ax-diff');
  if (Object.hasOwn(effects, 'consoleDelta')) channels.push('console');
  if (Object.hasOwn(effects, 'exceptionDelta')) channels.push('exceptions');
  if (Object.hasOwn(effects, 'networkDelta')) channels.push('network');
  if (effects.observationError?.message) channels.push('observation');
  return [...new Set(channels)];
}
export function actionSettlementSignals(actionResult = {}, strategy = actionSettlementStrategy(actionResult)) {
  if (strategy === 'dispatch-failed') return ['dispatch-failed'];
  if (strategy === 'observation-error') return ['observation-error'];
  if (strategy === 'timeout') return ['settlement-timeout'];
  if (strategy === 'report-only') return ['report-only'];
  return [];
}
export function actionSettlementState(actionResult = {}, strategy = actionSettlementStrategy(actionResult)) {
  if (strategy === 'dispatch-failed') return 'failed';
  if (strategy === 'report-only') return 'not-applicable';
  if (actionResult.settle?.ok === true) return 'settled';
  return 'not-confirmed';
}
export function actionSettlementReason(actionResult = {}, strategy = actionSettlementStrategy(actionResult)) {
  if (strategy === 'dispatch-failed') return 'Action failed before dispatch completed.';
  if (strategy === 'observation-error') return 'Action dispatched, but post-action observation failed.';
  if (strategy === 'timeout') return 'Action dispatched, but post-action observation did not confirm settlement.';
  if (strategy === 'report-only') return 'Action dispatched without post-action DOM observation.';
  if (strategy === 'dom-observation') return 'Post-action DOM observation completed.';
  return 'Action settlement status is not confirmed.';
}
export function buildSettlementReceipt(actionResult = {}) {
  const strategy = actionSettlementStrategy(actionResult);
  return {
    ok: actionResult.settle?.ok ?? null,
    state: actionSettlementState(actionResult, strategy),
    strategy,
    durationMs: Number.isFinite(actionResult.settle?.durationMs) ? actionResult.settle.durationMs : null,
    timeoutMs: Number.isFinite(actionResult.settle?.timeoutMs) ? actionResult.settle.timeoutMs : null,
    observedChannels: actionSettlementObservedChannels(actionResult),
    signals: actionSettlementSignals(actionResult, strategy),
    reason: actionSettlementReason(actionResult, strategy),
  };
}
export function actionDeltaDetails(actionResult = {}) {
  const effects = actionResult.effects || {};
  const details = [];
  const outcome = actionResult.outcome || buildActionOutcome(actionResult);

  if (effects.failure?.kind) {
    details.push({
      type: 'dispatch',
      status: 'failed',
      summary: `Dispatch failed: ${effects.failure.kind}`,
      ...(effects.failure.reason ? { sample: effects.failure.reason } : {}),
    });
  } else if (outcome.evidence === 'new-tab' && effects.openedTab) {
    details.push({
      type: 'tab',
      status: effects.openedTab.existing ? 'reused' : 'opened',
      summary: `${effects.openedTab.existing ? 'Opened in tab' : 'Opened new tab'} ${effects.openedTab.targetPrefix}: ${effects.openedTab.url}`,
    });
  } else if (outcome.evidence === 'download' && effects.download) {
    const state = effects.download.state === 'started' || effects.download.state === 'unobserved'
      ? effects.download.state
      : 'completed';
    details.push({
      type: 'download',
      status: state,
      summary: outcome.reason || (state === 'completed' ? downloadOutcomeReason(effects.download) : 'Download'),
    });
  } else if (outcome.evidence === 'child-frame') {
    details.push({
      type: 'frame',
      status: effects.childFrame?.delivered === true ? 'delivered' : 'unobserved',
      summary: outcome.reason || 'Child frame click',
    });
  } else if (outcome.evidence === 'viewport') {
    const viewport = viewportApplicationOf(actionResult);
    details.push({
      type: 'viewport',
      status: viewport?.applied ? 'applied' : 'mismatch',
      summary: outcome.reason || (viewport?.applied ? 'Viewport size applied.' : 'Viewport size did not match the request.'),
    });
    if (actionDomDiffShowsChange(effects.domDiff)) {
      const sample = summarizeActionDomDiff(effects.domDiff).sample;
      details.push({
        type: 'dom',
        status: 'changed',
        summary: 'DOM changed after action',
        ...(sample ? { sample } : {}),
      });
    }
  } else if (outcome.status === 'changed') {
    const sample = summarizeActionDomDiff(effects.domDiff).sample;
    details.push({
      type: 'dom',
      status: 'changed',
      summary: 'DOM changed after action',
      ...(sample ? { sample } : {}),
    });
  } else if (outcome.status === 'no-change') {
    details.push({
      type: 'dom',
      status: 'no-change',
      summary: 'No visible AX tree change observed',
    });
  } else if (effects.domDiff == null) {
    details.push({
      type: 'dom',
      status: 'not-captured',
      summary: 'DOM observation not captured',
    });
  }

  const consoleDelta = normalizeConsoleDelta(effects.consoleDelta || {});
  const consoleSummary = summarizeActionConsoleDelta(consoleDelta);
  details.push({
    type: 'console',
    status: consoleDelta.count > 0 ? 'changed' : 'unchanged',
    count: Number(consoleDelta.count || 0),
    errors: Number(consoleDelta.errors || 0),
    warnings: Number(consoleDelta.warnings || 0),
    summary: consoleSummary.summary || 'Console unchanged',
    ...(consoleSummary.sample ? { sample: consoleSummary.sample } : {}),
  });

  const exceptionDelta = normalizeExceptionDelta(effects.exceptionDelta || {});
  const exceptionSummary = summarizeActionExceptionDelta(exceptionDelta);
  details.push({
    type: 'exception',
    status: exceptionDelta.count > 0 ? 'changed' : 'unchanged',
    count: Number(exceptionDelta.count || 0),
    summary: exceptionSummary.summary || 'Exceptions unchanged',
    ...(exceptionSummary.sample ? { sample: exceptionSummary.sample } : {}),
  });

  const networkDelta = normalizeNetworkDelta(effects.networkDelta || {});
  const networkSummary = summarizeActionNetworkDelta(networkDelta);
  details.push({
    type: 'network',
    status: networkDelta.count > 0 ? 'changed' : 'unchanged',
    count: Number(networkDelta.count || 0),
    failures: Number(networkDelta.failures || 0),
    pending: Number(networkDelta.pending || 0),
    summary: networkSummary.summary || 'Network unchanged',
    ...(networkSummary.sample ? { sample: networkSummary.sample } : {}),
  });

  if (effects.observationError?.message) {
    details.push({
      type: 'observation',
      status: 'error',
      summary: `Observation error: ${effects.observationError.message}`,
    });
  }
  return details;
}
export function actionDeltaLines(actionResult = {}) {
  const lines = [];
  for (const detail of actionDeltaDetails(actionResult)) {
    if (detail.summary) lines.push(detail.summary);
    if (!detail.sample) continue;
    if (detail.type === 'dom') lines.push(`DOM sample: ${detail.sample}`);
    else if (detail.type === 'console') lines.push(`Console sample: ${detail.sample}`);
    else if (detail.type === 'exception') lines.push(`Exception sample: ${detail.sample}`);
    else if (detail.type === 'network') lines.push(`Network sample: ${detail.sample}`);
  }
  return lines;
}
export function actionBlockingSignals(actionResult = {}) {
  const signals = [];
  const diagnosis = actionResult.effects?.diagnosis || null;
  const recommendation = actionResult.recommendation || {};
  if (Array.isArray(recommendation.blockingSignals)) signals.push(...recommendation.blockingSignals);
  if (diagnosis?.kind && diagnosis.status !== 'ok') signals.push(diagnosis.kind);
  if (actionResult.outcome?.status === 'timeout') signals.push('settlement-timeout');
  if (actionResult.effects?.observationError?.message) signals.push('observation-error');
  return [...new Set(signals)];
}
export function leftoverAxScrollNextIsPerceive(actionResult = {}) {
  const next = String(
    actionResult.recommendation?.commands?.[0]
    || actionResult.recommendation?.verifyCommand
    || '',
  );
  return /\bperceive\s+\S+\s+-C\s+-d\s+8\b/.test(next);
}
export function actionRecoveryHint(actionResult = {}) {
  const recommendation = actionResult.recommendation || {};
  const diagnosis = actionResult.effects?.diagnosis || null;
  const outcome = actionResult.outcome || buildActionOutcome(actionResult);
  const leftoverAxScroll = isExpectedLeftoverAxScrollNoChange(actionResult.target || {});
  // Leftover-ax-scroll whose Next is already perceive -C -d 8:
  // no-change "AX identities unchanged; re-run perceive -C -d 8 instead of
  // report." restates Next (#311). changed generic "Continue from the
  // observed action evidence." is leftover chrome (#301). Do not drop a
  // Recovery hint on generic non-leftover actions, or when Next is report /
  // investigate.
  if (
    leftoverAxScroll
    && leftoverAxScrollNextIsPerceive(actionResult)
    && (outcome.status === 'no-change' || outcome.status === 'changed')
  ) {
    return null;
  }
  // Successful bounded document nav already prints URL + title. Generic
  // "Continue from the observed action evidence." is leftover chrome (#343).
  if (isSuccessfulBoundedDocumentNav(actionResult)) return null;
  // Successful document-scroll-edge already prints scrollY / scrollMax /
  // at-bottom. "Capture a fresh observation…" restates Hint perceive (#345).
  if (isSuccessfulBoundedDocumentScrollEdge(actionResult)) return null;
  // Verdict already names the requested and read-back sizes (#578).
  // A harder diagnosis (exception, network, console) keeps its own hint.
  if (actionResult.recommendation?.strategy === 'investigate-viewport-size') return null;
  if (typeof recommendation.recoveryHint === 'string' && recommendation.recoveryHint.trim()) return recommendation.recoveryHint;
  if (diagnosis?.reason && diagnosis.status !== 'ok') return diagnosis.reason;
  // Leftover golden-path AX scroll already prints Outcome:changed, the compact
  // named cap-swap/structural diff, and Next `-C -d 8` (#301). The generic
  // "Continue from the observed action evidence." line is leftover chrome.
  if (
    outcome.status === 'changed'
    && leftoverAxScroll
  ) {
    return null;
  }
  if (outcome.status === 'changed') return 'Continue from the observed action evidence.';
  if (outcome.status === 'failed') return 'Run the recovery command before retrying the action.';
  if (outcome.status === 'timeout') return 'Verify the post-action state before retrying; the action may have dispatched.';
  if (outcome.status === 'dispatched') return 'Capture a fresh observation before assuming task progress.';
  return recommendation.reason || outcome.reason || actionResult.nextHint || null;
}
export function buildActionReceipt(actionResult = {}) {
  const outcome = actionResult.outcome || buildActionOutcome(actionResult);
  const recommendation = actionResult.recommendation || {};
  const nextSteps = uniqueNextStepCommands(actionResult.nextSteps || recommendation.commands || []);
  return {
    schema: 'chrome-cdp-ex.action-receipt.v1',
    actionId: buildActionId(actionResult),
    actionName: actionResult.action || null,
    targetSummary: actionTargetSummary(actionResult),
    dispatch: actionResult.dispatch || null,
    settlement: buildSettlementReceipt(actionResult),
    outcome: outcome.status || 'unknown',
    observedDelta: actionDeltaLines(actionResult),
    observedDeltaDetails: actionDeltaDetails(actionResult),
    blockingSignals: actionBlockingSignals(actionResult),
    recoveryHint: actionRecoveryHint(actionResult),
    nextSteps,
    recovery: {
      strategy: recommendation.strategy || actionResult.effects?.diagnosis?.recovery?.strategy || null,
      priority: recommendation.priority || actionResult.effects?.diagnosis?.recovery?.priority || null,
      verifyCommand: recommendation.verifyCommand || actionResult.effects?.diagnosis?.recovery?.verifyCommand || null,
    },
  };
}
export function applyActionReceipt(actionResult) {
  actionResult.receipt = buildActionReceipt(actionResult);
  return actionResult;
}
export function applyActionObservationDelta(actionResult, delta = {}) {
  if (!actionResult.effects) actionResult.effects = {};
  const consoleDelta = normalizeConsoleDelta(delta.console || {});
  const exceptionDelta = normalizeExceptionDelta(delta.exceptions || {});
  const networkDelta = normalizeNetworkDelta(delta.network || {});
  actionResult.effects.consoleDelta = consoleDelta;
  actionResult.effects.exceptionDelta = exceptionDelta;
  actionResult.effects.networkDelta = networkDelta;
  actionResult.effects.console = consoleDelta.entries || [];
  actionResult.effects.exceptions = exceptionDelta.entries || [];
  actionResult.effects.network = networkDelta.entries || [];
  // Optional (#460): present only when a dialog was answered during the action window.
  const dialogDelta = normalizeDialogDelta(delta.dialogs || {});
  if (dialogDelta.count > 0) {
    actionResult.effects.dialogs = dialogDelta.entries;
    if (dialogDelta.count > dialogDelta.entries.length) {
      actionResult.effects.dialogsOmitted = dialogDelta.count - dialogDelta.entries.length;
    }
  }
  return applyActionReceipt(applyActionVerdict(applyActionRecommendation(applyActionOutcome(applyActionDiagnosis(actionResult)))));
}
export function actionDiagnosisSignals(actionResult = {}) {
  const effects = actionResult.effects || {};
  const consoleDelta = normalizeConsoleDelta(effects.consoleDelta || {});
  const exceptionDelta = normalizeExceptionDelta(effects.exceptionDelta || {});
  const networkDelta = normalizeNetworkDelta(effects.networkDelta || {});
  return {
    dispatchOk: actionResult.dispatch?.ok !== false,
    settleOk: actionResult.settle?.ok ?? null,
    domChanged: actionDomDiffShowsChange(effects.domDiff) || actionNavigationEvidence(actionResult).navigated,
    consoleErrors: consoleDelta.errors,
    consoleWarnings: consoleDelta.warnings,
    exceptions: exceptionDelta.count,
    networkFailures: networkDelta.failures,
    networkPending: networkDelta.pending,
    observationError: Boolean(effects.observationError?.message),
  };
}
export function createActionDiagnosis(actionResult = {}) {
  const effects = actionResult.effects || {};
  // #533: Next lines name the 8-character prefix like every other receipt, not the full target id.
  const targetId = actionTargetCommandPrefix(actionResult.target || {});
  const targetInput = actionFailureInput(actionResult.target || effects.failure?.target || {});
  const signals = actionDiagnosisSignals(actionResult);
  const finish = (diagnosis) => ({
    ...diagnosis,
    recovery: buildActionRecoveryPlan(diagnosis, { targetId, targetInput }),
  });
  const base = {
    schema: 'chrome-cdp-ex.action-diagnosis.v1',
    status: 'ok',
    kind: 'ok',
    confidence: 'medium',
    source: 'action',
    reason: 'Action dispatched without captured runtime failures.',
    nextCommand: actionResult.nextHint || null,
    signals,
  };

  if (effects.failure?.kind) {
    return finish({
      ...base,
      status: 'blocked',
      kind: effects.failure.kind,
      confidence: 'high',
      source: 'dispatch',
      reason: effects.failure.reason || 'The action failed before dispatch completed.',
      nextCommand: effects.failure.nextCommand || actionResult.nextHint || `cdp status ${targetId}`,
    });
  }

  if (signals.observationError) {
    return finish({
      ...base,
      status: 'attention',
      kind: 'observation-error',
      confidence: 'medium',
      source: 'observation',
      reason: `The action was dispatched, but post-action observation failed: ${effects.observationError.message}`,
      nextCommand: `cdp status ${targetId}`,
    });
  }

  if (signals.exceptions > 0) {
    return finish({
      ...base,
      status: 'attention',
      kind: 'exception',
      confidence: 'high',
      source: 'exception',
      reason: 'The action triggered one or more page exceptions.',
      nextCommand: `cdp console ${targetId} --errors`,
    });
  }

  if (signals.networkFailures > 0) {
    return finish({
      ...base,
      status: 'attention',
      kind: 'network-failure',
      confidence: 'high',
      source: 'network',
      reason: 'The action triggered one or more failed network requests.',
      nextCommand: failedRequestNextCommand(effects.failedRequests, targetId),
    });
  }

  if (signals.networkPending > 0) {
    return finish({
      ...base,
      status: 'attention',
      kind: 'network-pending',
      confidence: 'medium',
      source: 'network',
      reason: 'The action left network requests pending after the settle window.',
      // #533: pending requests are normal after a load (SSE, long poll); check the page, not the network log.
      nextCommand: `cdp perceive ${targetId}`,
    });
  }

  if (signals.consoleErrors > 0) {
    return finish({
      ...base,
      status: 'attention',
      kind: 'console-error',
      confidence: 'high',
      source: 'console',
      reason: 'The action triggered one or more console errors.',
      nextCommand: `cdp console ${targetId} --errors`,
    });
  }

  if (actionResult.dispatch?.ok === true && actionResult.settle?.ok === false) {
    return finish({
      ...base,
      status: 'attention',
      kind: 'observation-timeout',
      confidence: 'medium',
      source: 'settle',
      reason: 'The action was dispatched, but post-action observation did not finish cleanly.',
      nextCommand: `cdp perceive ${targetId} --since-action`,
    });
  }

  if (signals.domChanged) {
    return finish({
      ...base,
      status: 'ok',
      kind: 'dom-changed',
      confidence: 'medium',
      source: 'dom',
      reason: 'The action dispatched and changed the perceived DOM.',
      nextCommand: actionResult.nextHint || `cdp perceive ${targetId} --since-action`,
    });
  }

  return base;
}
export function applyActionDiagnosis(actionResult) {
  if (!actionResult.effects) actionResult.effects = {};
  const diagnosis = createActionDiagnosis(actionResult);
  if (diagnosis.status === 'ok' && diagnosis.kind === 'ok') delete actionResult.effects.diagnosis;
  else actionResult.effects.diagnosis = diagnosis;
  return actionResult;
}
export function buildActionRecommendation(actionResult = {}) {
  const target = actionTargetCommandPrefix(actionResult.target || {});
  const diagnosis = actionResult.effects?.diagnosis || null;
  if (diagnosis && diagnosis.status !== 'ok') {
    const commands = recoveryCommandsFromDiagnosis(diagnosis);
    return {
      source: 'action-diagnosis',
      action: actionResult.action || null,
      targetPrefix: target,
      diagnosisKind: diagnosis.kind || null,
      strategy: diagnosis.recovery?.strategy || diagnosis.kind || 'recover-action',
      priority: diagnosis.recovery?.priority || (diagnosis.status === 'blocked' ? 'high' : 'medium'),
      verifyCommand: diagnosis.recovery?.verifyCommand || diagnosis.nextCommand || null,
      commands,
    };
  }
  if (isViewportSizeMismatch(actionResult)) {
    const readCommand = `cdp viewport ${target}`;
    return {
      source: 'action-evidence',
      action: actionResult.action || 'viewport',
      targetPrefix: target,
      outcomeStatus: 'attention',
      strategy: 'investigate-viewport-size',
      priority: 'medium',
      reason: viewportApplicationOf(actionResult)?.reason
        || 'The viewport read back did not match the requested size.',
      blockingSignals: [],
      recoveryHint: null,
      verifyCommand: readCommand,
      commands: uniqueNextStepCommands([readCommand]),
    };
  }
  const childFrame = actionResult.effects?.childFrame;
  if (childFrame) {
    const shot = `cdp shot ${target}`;
    return {
      source: 'action-evidence',
      action: actionResult.action || null,
      targetPrefix: target,
      strategy: 'inspect-child-frame',
      priority: 'medium',
      reason: childFrame.delivered === true
        ? 'Mouse events were delivered to a child frame. Inspect that frame with shot; do not repeat the click.'
        : 'The click point is a child frame whose events could not be observed. Inspect it with shot; do not repeat the click.',
      commands: uniqueNextStepCommands([shot]),
      optionalCommands: [],
    };
  }
  const openedTab = actionResult.effects?.openedTab;
  if (openedTab?.targetPrefix) {
    // #437: the click's result is in the other tab; look there, not at this one.
    return {
      source: 'action-evidence',
      action: actionResult.action || null,
      targetPrefix: target,
      strategy: 'continue-in-opened-tab',
      priority: 'medium',
      reason: `The link opened ${openedTab.existing ? 'in tab' : 'a new tab'} ${openedTab.targetPrefix}; perceive that tab to continue.`,
      commands: uniqueNextStepCommands([`cdp perceive ${openedTab.targetPrefix} -C -d 8`]),
      optionalCommands: [],
    };
  }
  const outcome = actionResult.outcome || buildActionOutcome(actionResult);
  if (outcome.status === 'no-change') {
    return buildNoChangeOutcomeRecommendation({
      action: actionResult.action || null,
      target,
      targetInput: actionFailureInput(actionResult.target || {}),
      targetInfo: {
        ...(actionResult.target || {}),
        page: actionResult.target?.page || actionResult.effects?.page,
      },
      extraText: String(actionResult.effects?.domDiff || ''),
    });
  }
  if (isExpectedLeftoverAxScrollNoChange(actionResult.target || {})) {
    const nextCommand = `cdp perceive ${target} -C -d 8`;
    return {
      source: 'action-evidence',
      action: actionResult.action || null,
      targetPrefix: target,
      strategy: 'continue-from-evidence',
      priority: 'medium',
      reason: 'Leftover golden-path AX already includes observed evidence; re-run perceive -C -d 8 instead of report.',
      commands: uniqueNextStepCommands([nextCommand]),
      optionalCommands: [],
    };
  }

  return {
    source: 'action-evidence',
    action: actionResult.action || null,
    targetPrefix: target,
    strategy: actionResult.effects?.domDiff ? 'continue-from-evidence' : 'continue-or-handoff',
    priority: 'medium',
    reason: actionResult.effects?.domDiff
      ? 'The action already includes observed page evidence; continue from that evidence without an extra verify call.'
      : 'The action dispatched without captured runtime trouble; use report or record-actions when handing off.',
    commands: uniqueNextStepCommands([
      `cdp report ${target} --format json`,
      `cdp record-actions ${target} --format json`,
    ]),
    optionalCommands: uniqueNextStepCommands([
      `cdp perceive ${target} --since-action`,
    ]),
  };
}
export function isGenericSinceActionHint(hint) {
  return String(hint || '').trim() === GENERIC_SINCE_ACTION_HINT;
}
export function applyActionRecommendation(actionResult) {
  const recommendation = buildActionRecommendation(actionResult);
  actionResult.recommendation = recommendation;
  actionResult.nextSteps = uniqueNextStepCommands(recommendation.commands || []);
  if (
    isExpectedLeftoverAxScrollNoChange(actionResult.target || {})
    && isGenericSinceActionHint(actionResult.nextHint)
  ) {
    actionResult.nextHint = null;
  }
  if (
    isSuccessfulBoundedDocumentNav(actionResult)
    && isGenericSinceActionHint(actionResult.nextHint)
  ) {
    actionResult.nextHint = null;
  }
  if (
    isSuccessfulBoundedDocumentScrollEdge(actionResult)
    && isGenericSinceActionHint(actionResult.nextHint)
  ) {
    actionResult.nextHint = null;
  }
  // A matching or mismatched readback already decides the viewport receipt.
  // The generic since-action hint would send the agent to investigate a size
  // change that did not need a fresh AX tree (#578).
  if (viewportApplicationOf(actionResult) && isGenericSinceActionHint(actionResult.nextHint)) {
    actionResult.nextHint = null;
  }
  return actionResult;
}
export function buildActionVerdict(actionResult = {}) {
  const diagnosis = actionResult.effects?.diagnosis || null;
  const outcome = actionResult.outcome || buildActionOutcome(actionResult);
  const recommendation = actionResult.recommendation || {};
  const nextSteps = uniqueNextStepCommands(recommendation.commands || []);
  const primaryNextStep = nextSteps[0] || recommendation.verifyCommand || actionResult.nextHint || null;
  const base = {
    schema: 'chrome-cdp-ex.action-verdict.v1',
    source: diagnosis && diagnosis.status !== 'ok' ? 'diagnosis' : 'outcome',
    primaryNextStep,
    nextSteps,
    reason: diagnosis && diagnosis.status !== 'ok'
      ? diagnosis.reason || outcome.reason || null
      : outcome.reason || recommendation.reason || null,
  };

  if (diagnosis && diagnosis.status !== 'ok') {
    const blocked = diagnosis.status === 'blocked' || outcome.status === 'failed';
    return {
      ...base,
      status: blocked ? 'blocked' : 'recover',
      confidence: diagnosis.confidence || (blocked ? 'high' : 'medium'),
      canContinue: false,
      needsRecovery: true,
    };
  }

  // Other attention outcomes stay `recover`. A viewport size miss is the
  // investigate verdict the receipt already uses for "look at this result",
  // and it names requested vs actual via outcome.reason (#578).
  if (isViewportSizeMismatch(actionResult)) {
    return {
      ...base,
      status: 'investigate',
      confidence: 'high',
      canContinue: false,
      needsRecovery: false,
    };
  }

  switch (outcome.status) {
    case 'changed':
      return {
        ...base,
        status: 'continue',
        confidence: 'medium',
        canContinue: true,
        needsRecovery: false,
      };
    case 'no-change': {
      const expectedNoChange = isExpectedNoChange(
        actionResult.target,
        actionResult.effects?.domDiff,
        actionResult.action,
      );
      return {
        ...base,
        status: expectedNoChange ? 'continue' : 'investigate',
        confidence: 'medium',
        canContinue: expectedNoChange,
        needsRecovery: !expectedNoChange,
      };
    }
    case 'failed':
      return {
        ...base,
        status: 'blocked',
        confidence: 'high',
        canContinue: false,
        needsRecovery: true,
      };
    case 'timeout':
      return {
        ...base,
        status: 'verify',
        confidence: 'low',
        canContinue: false,
        needsRecovery: true,
      };
    case 'attention':
      return {
        ...base,
        status: 'recover',
        confidence: 'medium',
        canContinue: false,
        needsRecovery: true,
      };
    case 'dispatched':
    default:
      return {
        ...base,
        status: 'verify',
        confidence: 'low',
        canContinue: false,
        needsRecovery: false,
      };
  }
}
export function applyActionVerdict(actionResult) {
  actionResult.verdict = buildActionVerdict(actionResult);
  return actionResult;
}
export function countLabel(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}
export function formatConsoleDeltaSample(entry) {
  if (!entry) return null;
  const level = entry.level || 'log';
  const loc = entry.loc ? ` @ ${entry.loc}` : '';
  return `[${level}] ${redactSensitiveString(entry.text || '(empty)')}${loc}`;
}
export function formatExceptionDeltaSample(entry) {
  if (!entry) return null;
  const loc = entry.loc ? ` @ ${entry.loc}` : '';
  return `${redactSensitiveString(entry.message || 'Unknown exception')}${loc}`;
}
export function formatNetworkDeltaSample(entry) {
  if (!entry) return null;
  const status = entry.errorText || entry.status || 'pending';
  const duration = Number.isFinite(entry.duration) ? ` in ${entry.duration}ms` : '';
  return `${entry.method || 'GET'} ${redactUrl(entry.url || '(unknown URL)')} -> ${status}${duration}`;
}
export function summarizeActionConsoleDelta(delta = {}) {
  const count = Number(delta.count || 0);
  if (count === 0) return { summary: null, sample: null };
  const parts = [];
  if (delta.errors) parts.push(countLabel(delta.errors, 'error'));
  if (delta.warnings) parts.push(countLabel(delta.warnings, 'warning'));
  const summary = `Console: ${countLabel(count, 'entry', 'entries')}${parts.length ? ` (${parts.join(', ')})` : ''}`;
  const prioritized = [...(delta.entries || [])].find(entry => ['error', 'assert'].includes(String(entry.level || '').toLowerCase()))
    || [...(delta.entries || [])].find(entry => ['warning', 'warn'].includes(String(entry.level || '').toLowerCase()))
    || (delta.entries || [])[0];
  return { summary, sample: formatConsoleDeltaSample(prioritized) };
}
export function summarizeActionExceptionDelta(delta = {}) {
  const count = Number(delta.count || 0);
  if (count === 0) return { summary: null, sample: null };
  return {
    summary: `Exception: ${count} thrown`,
    sample: formatExceptionDeltaSample((delta.entries || [])[0]),
  };
}
export function summarizeActionNetworkDelta(delta = {}) {
  const count = Number(delta.count || 0);
  if (count === 0) return { summary: null, sample: null };
  const failures = Number(delta.failures || 0);
  const pending = Number(delta.pending || 0);
  const parts = [];
  if (failures) parts.push(countLabel(failures, 'failed', 'failed'));
  if (pending) parts.push(countLabel(pending, 'pending', 'pending'));
  const summary = `Network: ${countLabel(count, 'request')}${parts.length ? ` (${parts.join(', ')})` : ''}`;
  const prioritized = [...(delta.entries || [])].find(isNetworkFailure) || (delta.entries || [])[0];
  return { summary, sample: formatNetworkDeltaSample(prioritized) };
}
export function summarizeActionObservationEffects(effects = {}) {
  const consoleSummary = summarizeActionConsoleDelta(effects.consoleDelta);
  const exceptionSummary = summarizeActionExceptionDelta(effects.exceptionDelta);
  const networkSummary = summarizeActionNetworkDelta(effects.networkDelta);
  return {
    consoleSummary: consoleSummary.summary,
    consoleSample: consoleSummary.sample,
    exceptionSummary: exceptionSummary.summary,
    exceptionSample: exceptionSummary.sample,
    networkSummary: networkSummary.summary,
    networkSample: networkSummary.sample,
  };
}
export function stripLeftoverAxScrollCensusChrome(diff) {
  // Leftover-ax-scroll Next is already `perceive -C -d 8`. Interactive census,
  // Console: clean, and the clickxy Coords tutorial do not change that step
  // (#309). Do not rewrite the leftover perceive dump itself.
  return String(diff || '')
    .split('\n')
    .filter(line => !LEFTOVER_AX_SCROLL_CENSUS_RE.test(line))
    .join('\n');
}
export function stripLeftoverAxScrollNoChangeIdentityChrome(diff) {
  // Honest leftover-ax-scroll no-change whose Next is already perceive.
  // Position already states scroll identity. Viewport Scroll restates that
  // Position. Page URL restates leftover session identity that Next
  // perceive re-establishes (#316). Do not strip from leftover-ax-scroll
  // changed or from the leftover perceive dump itself.
  return String(diff || '')
    .split('\n')
    .filter(line => !LEFTOVER_AX_SCROLL_IDENTITY_HEADER_RE.test(line))
    .join('\n')
    .replace(/^\n+/, '');
}
export function stripLeftoverAxScrollNoChangeAxBodyChrome(diff) {
  // Honest leftover-ax-scroll no-change whose Next is already perceive.
  // Outcome already states no-change. The AX body restates that (#318).
  // Do not strip from leftover-ax-scroll changed or from the leftover
  // perceive dump itself.
  return String(diff || '')
    .split('\n')
    .filter(line => !LEFTOVER_AX_SCROLL_NO_CHANGE_BODY_RE.test(line.trim()))
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
}
export function parseBoundedNavObservation(domDiff = '') {
  const text = String(domDiff || '');
  return {
    page: text.match(/^Page:\s*(.*)$/m)?.[1]?.trim() || '',
    url: text.match(/^URL:\s*(.*)$/m)?.[1]?.trim() || '',
    readyState: text.match(/^Ready state:\s*(.*)$/m)?.[1]?.trim() || '',
  };
}
export function cleanDocumentNavField(value) {
  const text = String(value || '').trim();
  if (!text || DOCUMENT_NAV_PLACEHOLDER_RE.test(text)) return '';
  return text;
}
export function documentNavIdentity(result = {}) {
  const parsed = parseBoundedNavObservation(result.effects?.domDiff);
  const page = result.effects?.page || {};
  const health = result.effects?.pageHealth?.evidence || {};
  return {
    url: cleanDocumentNavField(parsed.url || health.url || page.url || result.target?.input || ''),
    title: cleanDocumentNavField(parsed.page || health.title || page.title || ''),
    readyState: cleanDocumentNavField(parsed.readyState || health.readyState || page.readyState || ''),
  };
}
export function isBoundedDocumentNavObservation(result = {}) {
  const action = String(result.action || '').toLowerCase();
  if (action !== 'nav' && action !== 'navigate') return false;
  return NAVIGATION_OBSERVATION_HEADING_RE.test(String(result.effects?.domDiff || ''));
}
export function isSuccessfulBoundedDocumentNav(result = {}) {
  if (!isBoundedDocumentNavObservation(result)) return false;
  if (result.dispatch?.ok === false) return false;
  if (result.settle?.ok === false) return false;
  if (result.effects?.failure?.kind) return false;
  if (result.effects?.observationError?.message) return false;
  const diagnosis = result.effects?.diagnosis;
  if (diagnosis && diagnosis.status !== 'ok') return false;
  if (result.outcome?.needsAttention === true) return false;
  if (result.outcome?.status && result.outcome.status !== 'changed') return false;
  if (actionBlockingSignals(result).length) return false;
  const identity = documentNavIdentity(result);
  return Boolean(identity.url || identity.title);
}
export function formatSuccessfulDocumentNavText(result, { compact = false } = {}) {
  const { url, title, readyState } = documentNavIdentity(result);
  if (compact) return [url, title].filter(Boolean).join('  ');
  const lines = [];
  if (title) lines.push(`Page: ${title}`);
  if (url) lines.push(`URL: ${url}`);
  if (readyState) lines.push(`Ready state: ${readyState}`);
  return lines.join('\n');
}
export function documentScrollEdgeDispatchText(result = {}, dispatchText = '') {
  return String(dispatchText || result.target?.dispatchText || '').trim();
}
export function isSuccessfulBoundedDocumentScrollEdge(result = {}, { dispatchText = '' } = {}) {
  if (String(result.action || '').toLowerCase() !== 'scroll') return false;
  if (!isDocumentScrollEdgeTarget(result.target || {})) return false;
  if (result.dispatch?.ok === false) return false;
  if (result.settle?.ok === false) return false;
  if (result.effects?.failure?.kind) return false;
  if (result.effects?.observationError?.message) return false;
  const diagnosis = result.effects?.diagnosis;
  if (diagnosis && diagnosis.status !== 'ok') return false;
  if (result.outcome?.needsAttention === true) return false;
  if (result.outcome?.status && result.outcome.status !== 'dispatched') return false;
  if (actionBlockingSignals(result).length) return false;
  return DOCUMENT_SCROLL_EDGE_DISPATCH_RE.test(documentScrollEdgeDispatchText(result, dispatchText));
}
export function formatSuccessfulDocumentScrollEdgeText(result, { compact = false, dispatchText = '' } = {}) {
  const text = documentScrollEdgeDispatchText(result, dispatchText);
  if (!text) return '';
  if (!compact) return text;
  const match = text.match(DOCUMENT_SCROLL_EDGE_DISPATCH_RE);
  return match ? match[2] : text;
}
export function isDefaultSkinnyMutatingAction(result = {}) {
  // A stale navigation baseline has to say so. The one-line receipt would hide it.
  if (result.target?.baselineStale === true || result.effects?.baselineStale === true) return false;
  const action = String(result.action || '').toLowerCase();
  // clickxy stays on the full envelope when nothing outside the page was observed,
  // so a coordinate click that changes nothing still says so. A child frame, a new
  // tab, or a download is the result; that receipt is the one-line dispatch text.
  if (action === 'clickxy') {
    return Boolean(result.effects?.childFrame || result.effects?.openedTab || result.effects?.download);
  }
  return DEFAULT_SKINNY_MUTATING_ACTIONS.has(action);
}
export function isHandoffNextCommand(command) {
  const text = String(command || '').trim();
  if (!text) return true;
  if (isGenericSinceActionHint(text)) return true;
  if (/\bperceive\b[\s\S]*--since-action/.test(text)) return true;
  if (/\breport\b[\s\S]*--format json/.test(text)) return true;
  if (/\brecord-actions\b/.test(text)) return true;
  return false;
}
export function actionNavigatedSameTarget(result = {}, dispatchText = '') {
  const action = String(result.action || '').toLowerCase();
  if (action === 'nav' || action === 'navigate') return true;
  if (result.effects?.navigation?.changed === true) return true;
  return /(?:^|\n)URL: \S/.test(String(dispatchText || result.target?.dispatchText || ''));
}
// #430: when no diagnosis or recovery names a concrete next step, the receipt used to
// fall back to `cdp list`, which re-enumerates tabs and never helps after an in-page
// action. With a known target, look at that page instead: `perceive --since-action`
// shows what the action changed; after a same-tab navigation the old page is gone, so
// a fresh golden-path perceive is the useful view. `list` stays only when the receipt
// has no target to point at.
export function defaultMutatingFallbackNextCommand(result = {}, { dispatchText = '' } = {}) {
  const targetId = result.target?.targetId;
  if (!targetId) return 'cdp list';
  const prefix = targetPrefixForDisplay(targetId);
  return actionNavigatedSameTarget(result, dispatchText)
    ? `cdp perceive ${prefix} -C -d 8`
    : `cdp perceive ${prefix} --since-action`;
}
export function defaultMutatingNextCommand(result = {}, { dispatchText = '' } = {}) {
  const candidates = [
    result.effects?.failure?.nextCommand,
    result.effects?.diagnosis?.nextCommand,
    result.recommendation?.verifyCommand,
    ...(Array.isArray(result.recommendation?.commands) ? result.recommendation.commands : []),
    result.verdict?.primaryNextStep,
  ].filter(Boolean);
  const next = candidates.find(command => !isHandoffNextCommand(command));
  return next || defaultMutatingFallbackNextCommand(result, { dispatchText });
}
export function formatFailedDispatchText(result = {}) {
  const failure = result.effects?.failure || {};
  const diagnosis = result.effects?.diagnosis || {};
  return formatActionFailureLines({
    message: result.dispatch?.error || failure.originalMessage || '',
    reason: failure.reason || diagnosis.reason || result.outcome?.reason || '',
    kind: failure.kind || diagnosis.kind || 'unknown',
    detailLines: [formatFillValueLine(failure), ...(Array.isArray(failure.detailLines) ? failure.detailLines : [])],
    nextCommand: defaultMutatingNextCommand(result),
  });
}
// #553: the default receipt names what was addressed and the next command.
// It does not claim the page changed. The full diagnostic path still prints Outcome.
export function formatDefaultMutatingActionText(result = {}, { dispatchText = '' } = {}) {
  if (result.dispatch?.ok === false || result.effects?.failure?.kind) {
    return formatFailedDispatchText(result);
  }
  const outcome = String(dispatchText || '').trim()
    || (result.outcome?.status ? String(result.outcome.status) : `${result.action}: dispatched`);
  const next = defaultMutatingNextCommand(result, { dispatchText });
  let one = outcome.replace(/\.+$/, '');
  // #664: the skinny receipt is the line an agent trusts. Name the control's
  // own aria change here; the AX diff stays on the full diagnostic.
  const ariaChange = result.outcome?.status === 'changed'
    ? ariaControlStateReceiptClause(result.target?.controlStateDiff)
    : '';
  // The END marker is a whole line. A receipt tail goes on the line after it, and the aria clause
  // goes on the receipt's first line.
  const endMarker = /^--- END FRAME CONTENT nonce=[0-9a-f]{32} ---$/;
  const endsInBlock = endMarker.test(String(one).split('\n').at(-1) || '');
  if (ariaChange && endsInBlock && !one.split('\n')[0].includes(ariaChange)) {
    one = one.replace(/^[^\n]*/, head => `${head}: ${ariaChange}`);
  } else if (ariaChange && !endsInBlock && !one.includes(ariaChange)) {
    one = `${one}: ${ariaChange}`;
  }
  // #648: a request the action sent that failed is evidence for the next step.
  const failed = failedRequestLines(result);
  if (/(?:^|\n)Next:/m.test(one) || one.includes(`Next: ${next}`)) return insertBeforeNextLine(one, failed);
  if (endsInBlock) {
    return insertBeforeNextLine(`${one}\nNext: ${next}`, failed);
  }
  return insertBeforeNextLine(`${one}. Next: ${next}`, failed);
}
export function formatActionText(result, { compact = false, full = false, dispatchText = '' } = {}) {
  if (!full && isSuccessfulBoundedDocumentNav(result)) {
    return formatSuccessfulDocumentNavText(result, { compact });
  }
  if (!full && isSuccessfulBoundedDocumentScrollEdge(result, { dispatchText })) {
    return formatSuccessfulDocumentScrollEdgeText(result, { compact, dispatchText });
  }
  const diagnostics = summarizeActionObservationEffects(result.effects || {});
  const diagnosis = result.effects?.diagnosis || null;
  const leftoverAxScroll = isExpectedLeftoverAxScrollNoChange(result.target);
  const leftoverAxScrollNext = leftoverAxScroll && result.recommendation?.commands?.[0];
  // Honest leftover-ax-scroll no-change whose Next is already perceive.
  // Scrolled by / Position already states the action. dispatched via
  // scroll + Target: down restates that same leftover input (#320).
  // Do not strip from leftover-ax-scroll changed, leftover --cards,
  // pdf-viewer.v1, or generic non-leftover actions.
  const skipLeftoverNoChangeDispatchChrome = leftoverAxScroll
    && leftoverAxScrollNextIsPerceive(result)
    && result.outcome?.status === 'no-change'
    && result.dispatch?.ok;
  const lines = [];
  if (!skipLeftoverNoChangeDispatchChrome) {
    lines.push(`${result.action}: ${result.dispatch.ok ? 'dispatched' : 'failed'} via ${result.dispatch.method}`);
    if (result.target?.label) lines.push(`Target: ${result.target.label}`);
  }
  if (result.outcome?.status) {
    const skipGenericChangedReason = leftoverAxScroll
      && result.outcome.status === 'changed'
      && result.outcome.reason === GENERIC_CHANGED_REASON;
    // Honest leftover-ax-scroll no-change whose Next is already perceive
    // already prints Outcome: no-change. The settle-shape essay restates
    // that Outcome (#313). Do not drop Outcome reasons on generic
    // non-leftover actions, leftover --cards, or pdf-viewer.v1.
    const skipLeftoverNoChangeReason = leftoverAxScroll
      && leftoverAxScrollNextIsPerceive(result)
      && result.outcome.status === 'no-change'
      && result.outcome.reason === LEFTOVER_AX_SCROLL_NO_CHANGE_REASON;
    const reason = skipGenericChangedReason || skipLeftoverNoChangeReason || !result.outcome.reason
      ? ''
      : ` — ${result.outcome.reason}`;
    lines.push(`Outcome: ${result.outcome.status}${reason}`);
  }
  if (result.receipt?.outcome) {
    const skipReceiptStatus = leftoverAxScroll
      && result.receipt.outcome === result.outcome?.status
      && !(Array.isArray(result.receipt.blockingSignals) && result.receipt.blockingSignals.length);
    if (!skipReceiptStatus) lines.push(`Receipt: ${result.receipt.outcome}`);
    if (Array.isArray(result.receipt.blockingSignals) && result.receipt.blockingSignals.length) {
      lines.push(`Blocking signals: ${result.receipt.blockingSignals.join(', ')}`);
    }
    if (result.receipt.recoveryHint) lines.push(`Recovery hint: ${result.receipt.recoveryHint}`);
  }
  if (result.effects?.failure?.kind) lines.push(`Failure: ${result.effects.failure.kind}`);
  if (diagnosis && diagnosis.status !== 'ok') {
    lines.push(`Diagnosis: ${diagnosis.kind}${diagnosis.reason ? ` — ${diagnosis.reason}` : ''}`);
  }
  if (result.effects?.observationError?.message) lines.push(`Observation error: ${result.effects.observationError.message}`);
  if (result.verdict?.status) {
    const skipDupReason = leftoverAxScroll
      && result.verdict.reason
      && result.verdict.reason === result.outcome?.reason;
    const reason = skipDupReason || !result.verdict.reason ? '' : ` — ${result.verdict.reason}`;
    lines.push(`Verdict: ${result.verdict.status}${reason}`);
  }
  if (result.settle) {
    const duration = result.settle.durationMs ? ` in ${result.settle.durationMs}ms` : '';
    lines.push(`Settle: ${result.settle.ok ? 'ok' : 'not confirmed'}${duration}`);
  }
  if (diagnostics.consoleSummary) lines.push(diagnostics.consoleSummary);
  if (diagnostics.consoleSample) lines.push(`Console sample: ${diagnostics.consoleSample}`);
  if (diagnostics.exceptionSummary) lines.push(diagnostics.exceptionSummary);
  if (diagnostics.exceptionSample) lines.push(`Exception sample: ${diagnostics.exceptionSample}`);
  if (diagnostics.networkSummary) lines.push(diagnostics.networkSummary);
  if (diagnostics.networkSample) lines.push(`Network sample: ${diagnostics.networkSample}`);
  lines.push(...failedRequestLines(result));
  // #578: no AX change is not evidence for viewport. Attach the diff only
  // when the tree actually changed.
  const viewportDomDiff = viewportApplicationOf(result) && !actionDomDiffShowsChange(result.effects?.domDiff)
    ? ''
    : result.effects?.domDiff;
  if (viewportDomDiff) {
    const diff = redactSensitiveString(viewportDomDiff);
    let formatted = leftoverAxScroll ? stripLeftoverAxScrollCensusChrome(diff) : diff;
    if (
      leftoverAxScroll
      && leftoverAxScrollNextIsPerceive(result)
      && result.outcome.status === 'no-change'
    ) {
      formatted = stripLeftoverAxScrollNoChangeIdentityChrome(formatted);
      formatted = stripLeftoverAxScrollNoChangeAxBodyChrome(formatted);
    }
    if (formatted.trim()) lines.push('---', formatted);
  }
  if (diagnosis?.nextCommand && diagnosis.status !== 'ok') lines.push(`Next: ${diagnosis.nextCommand}`);
  if (result.recommendation?.strategy === 'investigate-viewport-size' && result.recommendation.commands?.[0]) {
    lines.push(`Next: ${result.recommendation.commands[0]}`);
  }
  if (result.effects?.childFrame && result.recommendation?.strategy === 'inspect-child-frame' && result.recommendation.commands?.[0]) {
    lines.push(`Next: ${result.recommendation.commands[0]}`);
  }
  if (!diagnosis?.nextCommand && result.outcome?.status === 'no-change' && result.recommendation?.commands?.[0]) {
    lines.push(`Next: ${result.recommendation.commands[0]}`);
  } else if (leftoverAxScrollNext) {
    lines.push(`Next: ${result.recommendation.commands[0]}`);
  }
  if (result.nextHint && !leftoverAxScrollNext) lines.push(`Hint: ${result.nextHint}`);
  return lines.join('\n');
}
export async function finalizeActionResult(result, { enrichActionResult = null, onActionResult = null } = {}) {
  if (enrichActionResult) await enrichActionResult(result);
  applyActionReceipt(applyActionVerdict(applyActionRecommendation(applyActionOutcome(applyActionDiagnosis(result)))));
  if (onActionResult) onActionResult(result);
  return result;
}
export function normalizeActionOutputOptions(format = 'text') {
  if (format && typeof format === 'object') {
    return {
      format: format.format || 'text',
      compact: format.compact === true || format.qa === true || format.summary === true,
      qa: format.qa === true || format.summary === true,
      maxDiffLines: format.maxDiffLines == null ? null : Number(format.maxDiffLines),
      full: format.full === true || format.unsafeFull === true,
    };
  }
  return { format, compact: false, qa: false, maxDiffLines: null, full: false };
}
export function typeaheadLabelFromAxLine(line) {
  const trimmed = String(line || '').replace(/^[+-]\s*/, '').trim();
  const match = trimmed.match(/^\[(option|listitem|link)\]\s+(.+)$/i);
  if (!match) return null;
  const name = match[2]
    .replace(/\s+@[c\w:-]+(?:\s+\([^)]+\))?$/, '')
    .replace(/\s+=\s+".*"$/, '')
    .trim();
  if (!name) return null;
  return compactActionText(name, FILL_TYPEAHEAD_MAX_CHARS);
}
export function extractTypeaheadLabels(lines = [], { limit = FILL_TYPEAHEAD_LIMIT } = {}) {
  const seen = new Set();
  const labels = [];
  for (const line of lines) {
    const label = typeaheadLabelFromAxLine(line);
    if (!label || seen.has(label)) continue;
    seen.add(label);
    labels.push(label);
    if (labels.length >= limit) break;
  }
  return labels;
}
export function countTypeaheadLabels(lines = []) {
  const seen = new Set();
  for (const line of lines) {
    const label = typeaheadLabelFromAxLine(line);
    if (label) seen.add(label);
  }
  return seen.size;
}
export function typeaheadLabelFromNetworkUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return null;
  try {
    const parsed = raw.includes('://') ? new URL(raw) : new URL(raw, 'https://typeahead.invalid');
    const keys = [...parsed.searchParams.keys()];
    if (keys.some(key => /^(q|query|search|suggest|typeahead|autocomplete)$/i.test(key))) return null;
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    if (/^(api|search|suggest|autocomplete|query)$/i.test(parts[0])) return null;
    return compactActionText(parts.slice(0, 2).join('/'), FILL_TYPEAHEAD_MAX_CHARS);
  } catch {
    return null;
  }
}
export function extractFillTypeahead(effects = {}) {
  const fromDiff = extractTypeaheadLabels(String(effects.domDiff || '').split('\n'));
  const seen = new Set(fromDiff);
  const labels = [...fromDiff];
  const entries = effects.networkDelta?.entries || effects.network || [];
  for (const entry of entries) {
    if (labels.length >= FILL_TYPEAHEAD_LIMIT) break;
    if (String(entry?.method || 'GET').toUpperCase() !== 'GET') continue;
    const label = typeaheadLabelFromNetworkUrl(entry.url || '');
    if (!label || seen.has(label)) continue;
    seen.add(label);
    labels.push(label);
  }
  return labels;
}
export function fillTypedValue(result = {}) {
  const target = result.target || {};
  const args = Array.isArray(target.commandArgs) ? target.commandArgs : [];
  if (commandArgsNameSecret(result.action, args)) return secretMarker(args[args.indexOf('--secret') + 1]);
  if (isSensitiveActionTarget(result.action, target)) return REDACTED_VALUE;
  const text = args[0] === '--react' ? args[2] : args[1];
  if (text == null) return '';
  // #748: maxlength cut the typed text; report what the field holds.
  return target.fillMaxLength ? keepWithinMaxLength(text, target.fillMaxLength.limit) : String(text);
}
// The control's value before fill (null when unknown). fillStr already masks password values.
export function fillPreviousValue(result = {}) {
  const before = result.target?.fillValue?.before;
  if (before == null) return null;
  if (isSensitiveActionTarget(result.action, result.target || {})) return before === '' ? '' : REDACTED_VALUE;
  return String(before);
}
export function fillNavigationUrl(effects = {}) {
  const nav = effects.navigation;
  if (nav == null || nav === false) return null;
  if (typeof nav === 'string') return compactActionText(redactUrl(nav), 180) || null;
  if (typeof nav === 'object') {
    const url = nav.url || nav.href || nav.to || '';
    return url ? compactActionText(redactUrl(String(url)), 180) : null;
  }
  return null;
}
export function compactFillReceiptForJson(result = {}) {
  const typeahead = isSensitiveActionTarget(result.action, result.target || {})
    || commandArgsNameSecret(result.action, result.target?.commandArgs)
    ? []
    : extractFillTypeahead(result.effects || {});
  const targetId = result.target?.targetId || '';
  const receipt = {
    schema: 'chrome-cdp-ex.fill.v1',
    value: fillTypedValue(result),
    previousValue: fillPreviousValue(result),
    changed: result.outcome?.changed === true || result.outcome?.status === 'changed',
    navigation: fillNavigationUrl(result.effects || {}),
    typeahead,
  };
  if (result.target?.fillMaxLength) receipt.maxLength = { ...result.target.fillMaxLength };
  if (targetId) receipt.targetPrefix = targetPrefixForDisplay(targetId);
  Object.assign(receipt, actionDialogFields(result.effects));
  return receipt;
}
export function shouldUseCompactFillReceipt(result, { compact = false, qa = false, full = false } = {}) {
  return result?.action === 'fill'
    && result?.dispatch?.ok !== false
    && result?.settle?.ok !== false
    && result?.outcome?.needsAttention !== true
    && full !== true
    && compact !== true
    && qa !== true;
}
export function actionResultPdfViewerMeta(result = {}, dispatchText = '') {
  const page = result.effects?.page || result.page || result.target?.page || {};
  const blob = [
    result.effects?.domDiff,
    dispatchText,
    result.dispatch?.error,
    result.effects?.failure?.originalMessage,
  ].filter(Boolean).join('\n');
  if (!isPdfViewerContentType(page.contentType) && !blob.includes('chrome-cdp-ex.pdf-viewer.v1')) {
    return null;
  }
  return {
    title: page.title || '',
    url: page.url || '',
    contentType: isPdfViewerContentType(page.contentType) ? page.contentType : 'application/pdf',
  };
}
export function actionObservationPerceiveOpts(targetId, extra = {}) {
  return {
    ...extra,
    cards: false,
    // An action settle must not renumber the refs from the agent's last perceive (#548).
    preserveRefs: true,
    targetPrefix: extra.targetPrefix || targetPrefixForDisplay(targetId),
  };
}
export function actionSettleObserveOpts(targetId, actionTarget = {}, baselineOutput = null, baselineOpts = null) {
  const targetFrameRef = frameRefFromActionTarget(actionTarget);
  const keepFeedCards = isLeftoverFeedCardsSettle(baselineOutput, baselineOpts, actionTarget);
  const opts = actionObservationPerceiveOpts(targetId, {
    ...resolveSinceActionPerceiveOpts(
      {
        sinceAction: true,
        diffBaseline: baselineOutput,
        ...(targetFrameRef ? { frameRef: targetFrameRef } : {}),
      },
      { baselineOutput, baselineOpts },
      [],
    ),
    // Never inherit leftover perceive --frame mode; only the action's @fN target
    // (or an explicit --frame) may settle inside an iframe.
    frameRef: targetFrameRef || null,
    // Receipts ignore backend-node identity: an identical redraw is not a reaction (#651).
    ignoreNodeIdentity: true,
  });
  // actionObservationPerceiveOpts forces cards:false so leftover 0-card
  // recapture stays default AX (#257/#279). Re-enable cards only when the
  // leftover feed window is the scroll settle shape (#293).
  if (keepFeedCards) opts.cards = true;
  return opts;
}
// Every action receipt leaves through here. JSON models are redacted field by
// field; text receipts are redacted as a whole because outcome reasons, page
// URLs and dispatch text all embed raw URLs (#455).
// A sensitive fill's typed and previous values are scrubbed from the whole output in every mode:
// AX diffs, diagnosis samples and failure targets all quote the field's live value (#485).
// JSON models are scrubbed before serialization (string leaves only); text is scrubbed whole.
export function formatActionResultOutput(result, opts = {}) {
  const secrets = sensitiveActionValues(result?.action, result?.target);
  const scrubModel = model => scrubSecretValues(model, secrets, { keepKeys: ACTION_JSON_IDENTIFIER_KEYS });
  const output = formatActionResultOutputUnredacted(result, { ...opts, scrubModel });
  if (opts.format === 'json') return output;
  // #460: every text receipt names the dialogs the daemon answered on the user's behalf.
  // #472: and the file a click --expect-download saved.
  const extraLines = [
    ...downloadReceiptLines(result?.effects?.download),
    ...actionDialogLines(result?.effects || {}),
  ];
  const text = extraLines.length ? [output, ...extraLines].filter(Boolean).join('\n') : output;
  return scrubSecretValues(redactSensitiveString(text), secrets);
}
export function formatActionResultOutputUnredacted(result, { format = 'text', compact = false, qa = false, maxDiffLines = null, dispatchText = '', timeoutError = null, full = false, scrubModel = model => model } = {}) {
  const revisedDownload = String(result?.target?.dispatchText || '');
  if (revisedDownload.includes('→ download started') && (
    !dispatchText || String(dispatchText).includes('no download event was observed')
  )) {
    dispatchText = revisedDownload;
  }
  if (qa) {
    const pdf = actionResultPdfViewerMeta(result, dispatchText);
    if (pdf) {
      const targetPrefix = result.target?.targetId
        ? targetPrefixForDisplay(result.target.targetId)
        : '<target>';
      return format === 'json'
        ? formatJson(scrubModel(pdfViewerHandoffModel({ ...pdf, url: redactUrl(pdf.url) }, { targetPrefix })))
        : formatPdfViewerOutput(pdf, { targetPrefix });
    }
    const summary = buildQaSummaryModel({
      page: {
        url: result.effects?.page?.url || result.page?.url || '',
        title: result.effects?.page?.title || result.page?.title || '',
      },
      pageHealth: result.effects?.pageHealth || null,
      navigation: result.effects?.navigation || null,
      console: {
        errors: Number(result.effects?.consoleDelta?.errors || 0),
        exceptions: Number(result.effects?.exceptionDelta?.count || 0),
      },
      network: {
        failures: Number(result.effects?.networkDelta?.failures || 0),
      },
      action: {
        outcome: result.outcome?.status || result.receipt?.outcome || null,
        dispatch: result.dispatch || null,
        changed: result.outcome?.status ? result.outcome.status !== 'no-change' : Boolean(result.effects?.domDiff),
      },
      targetPrefix: result.target?.targetId ? targetPrefixForDisplay(result.target.targetId) : null,
      nextCommand: result.recommendation?.commands?.[0] || result.effects?.diagnosis?.nextCommand || null,
      source: 'action',
    });
    if (format === 'json') {
      return formatJson(scrubModel({
        summary: redactSensitiveArtifactValue(summary),
        action: compactActionResultForJson(result, { compact: true }),
      }));
    }
    return formatQaSummaryText(summary);
  }
  if (format === 'json') {
    if (shouldUseCompactFillReceipt(result, { compact, qa, full })) {
      return JSON.stringify(scrubModel(redactSensitiveArtifactValue(compactFillReceiptForJson(result))));
    }
    const model = scrubModel(compactActionResultForJson(result, { compact }));
    return compact ? JSON.stringify(model) : formatJson(model);
  }
  if (!full && isSuccessfulBoundedDocumentNav(result)) {
    let text = formatSuccessfulDocumentNavText(result, { compact });
    if (maxDiffLines != null) text = truncateTextLines(text, maxDiffLines);
    if (!timeoutError) return text;
    return `${text}\n(success but observation timed out after action dispatch: ${timeoutError.message}. The action was already sent; run \`perceive --since-action\`, \`perceive --diff\`, or \`status\` to refresh.)`;
  }
  if (!full && isSuccessfulBoundedDocumentScrollEdge(result, { dispatchText })) {
    let text = formatSuccessfulDocumentScrollEdgeText(result, { compact, dispatchText });
    if (maxDiffLines != null) text = truncateTextLines(text, maxDiffLines);
    if (!timeoutError) return text;
    return `${text}\n(success but observation timed out after action dispatch: ${timeoutError.message}. The action was already sent; run \`perceive --since-action\`, \`perceive --diff\`, or \`status\` to refresh.)`;
  }
  if (!full && isDefaultSkinnyMutatingAction(result)) {
    let text = formatDefaultMutatingActionText(result, { dispatchText });
    if (maxDiffLines != null) text = truncateTextLines(text, maxDiffLines);
    if (!timeoutError) return text;
    return `${text}\n(success but observation timed out after action dispatch: ${timeoutError.message}. The action was already sent; run \`perceive --since-action\`, \`perceive --diff\`, or \`status\` to refresh.)`;
  }
  let text = dispatchText ? `${dispatchText}\n---\n${formatActionText(result)}` : formatActionText(result);
  if (maxDiffLines != null) text = truncateTextLines(text, maxDiffLines);
  if (!timeoutError) return text;
  return `${text}\n(success but observation timed out after action dispatch: ${timeoutError.message}. The action was already sent; run \`perceive --since-action\`, \`perceive --diff\`, or \`status\` to refresh.)`;
}
export function parseVerifyClickArgs(args = []) {
  const fopts = parseFormatArgs(args, ['text', 'json']);
  const tokens = fopts.args;
  const opts = {
    selector: null,
    expectRequest: null,
    expectStatus: null,
    expectText: null,
    noConsoleErrors: false,
    evidence: 'concise',
    format: fopts.format,
  };
  const positional = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '--expect-request') opts.expectRequest = tokens[++i] || '';
    else if (token === '--expect-status') {
      const status = Number(tokens[++i]);
      if (!Number.isInteger(status) || status < 100 || status > 599) throw new Error('verify-click: --expect-status requires an HTTP status code');
      opts.expectStatus = status;
    } else if (token === '--expect-text') opts.expectText = tokens[++i] || '';
    else if (token === '--no-console-errors') opts.noConsoleErrors = true;
    else if (token === '--evidence') {
      const evidence = tokens[++i] || '';
      if (!['concise', 'full'].includes(evidence)) throw new Error('verify-click: --evidence must be concise or full');
      opts.evidence = evidence;
    } else if (String(token).startsWith('--')) {
      throw new Error(`verify-click: unknown argument ${token}`);
    } else {
      positional.push(token);
    }
  }
  if (positional.length !== 1) throw new Error('verify-click requires exactly one selector or @ref');
  if (opts.expectStatus != null && !opts.expectRequest) {
    throw new Error('verify-click: --expect-status requires --expect-request');
  }
  opts.selector = positional[0];
  return opts;
}
