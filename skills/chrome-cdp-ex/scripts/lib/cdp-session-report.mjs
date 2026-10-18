// Moved from cdp.mjs without changes (#688). cdp.mjs is the entry point and re-exports for tests.
import { receiptForActionJson, receiptForReport } from './action-receipt-surfaces.mjs';
import { actionTargetCommandId, buildActionRecoveryPlan, classifyActionFailure, formatActionFailure, isExpectedNoChange, isTimeoutError, uniqueNextStepCommands } from './action-recovery.mjs';
import { downloadReceiptLines } from './click-download.mjs';
import { commandResult } from './command-application.mjs';
import { classifyPageHealth } from './page-health.mjs';
import { REDACTED_VALUE, isSensitiveFieldText, redactSensitiveString, redactUrl, scrubSecretText, scrubSecretValues } from './redaction.mjs';
import { hasResponsiveFindings, normalizeResponsiveFindings } from './responsive-audit.mjs';
import { MIN_SCRUB_SECRET_CHARS, secretMarker } from './secrets.mjs';
import { buildReportRecommendation, defaultReportNextSteps, formatReportNextStepLines, formatReportRecommendationLines, normalizeReportTargetCommand } from './session-report.mjs';
import { formatWebVitalsText } from './web-vitals.mjs';
import { appendFileSync, lstatSync, mkdirSync, promises as fsPromises, readFileSync, readdirSync, renameSync, statSync } from 'fs';
import { resolve } from 'path';
import { actionDialogFields, actionDialogLines, applyActionDiagnosis, applyActionOutcome, applyActionReceipt, applyActionRecommendation, applyActionVerdict, buildActionOutcome, buildActionReceipt, buildActionVerdict, buildSettlementReceipt, compactActionText, compactObservationError, createActionResult, finalizeActionResult, formatActionResultOutput, formatSummaryText, isNetworkFailure, locateObservedEntries, locatedCallerLines, locatedLoc, normalizeActionOutputOptions, normalizeConsoleDelta, normalizeExceptionDelta, normalizeNetworkDelta, numericDeltaCount, redactDisplayedPage, redactNavigationEntries, redactObservedEntry, redactSensitiveArtifactValue, summarizeActionObservationEffects } from './cdp-action-result.mjs';
import { ACTION_JSON_IDENTIFIER_KEYS, CLICKED_CONTROL_TAG_RE, DEFAULT_REPORT_ACTION_LIMIT, DEFAULT_REPORT_JSON_BYTES_MAX, DEFAULT_STALE_ARTIFACT_HOURS, DRAG_POINT_RE, GENERIC_SINCE_ACTION_HINT, HIGH_SIGNAL_ACTION_TEXT_RE, MAX_ACTION_JSON_DOM_DIFF_CHARS, MAX_ACTION_LOG_ENTRIES, MAX_ENVIRONMENT_LOG_ENTRIES, MAX_SCREENSHOT_ENTRIES, PLAYWRIGHT_ASSERTION_TEXT_ROLES, QA_SCREENSHOT_TIMEOUT_MS, REACTIVE_CLICK_ROLES, REACTIVE_CLICK_TAGS, RUNTIME_ARTIFACT_KEEP_NEWEST_TARGETS, RUNTIME_ARTIFACT_MAX_AGE_MS, RUNTIME_ARTIFACT_PATTERN, RUNTIME_DIR, RUNTIME_PRUNE_FALLBACK_MS, SENSITIVE_FILL_RAW_VALUES, SESSION_LOG_ROTATE_BYTES, SESSION_SECRET_SCRUB, STATUS_PAGE_INFO_TIMEOUT, UNSCRUBBED_DAEMON_COMMANDS, daemonRequestStorage, daemonSecretStorage } from './cdp-base.mjs';
import { buildQaSummaryModel, formatBytes, formatDuration, formatJson, formatQaSummaryText, parseFormatArgs } from './cdp-browser.mjs';
import { buildCliErrorModel, formatCliErrorRecovery, parseFillArgs, parseNonNegativeInteger, targetPrefixForDisplay } from './cdp-cli.mjs';
import { applyDaemonRestartNotice, consoleDocumentEntries, consoleDocumentSince, displayConsoleLine, displayLocation, displayUrl, listDaemonRecords, rememberTabObservation, restoreTabObservation } from './cdp-core.mjs';
import { isProcessAlive } from './cdp-daemon.mjs';
import { actionDispatchFailureMessage, actionDispatchSemanticsFromModel, compactActionDiagnosisModel } from './cdp-flow.mjs';
import { clickDispatchEffects, clickStr, fillFeedbackPolicy, isNamedClickQuery, namedClickQueryName, parseDragArgs, parseScrollContainerArg, parseScrollEdge, splitScrollEdgeArgs } from './cdp-input.mjs';
import { assertNotPdfViewerPage, cdpDomains, collectPageHealth, createScreenshotTierState, evalStr, formatPdfViewerOutput, isHiddenTabCaptureError, isPdfViewerContentType, pdfViewerError, pdfViewerHandoffModel, pdfViewerNextCommand, pdfViewerReportRecommendation, runtimeMetricsStr, shotStr, webVitalsModelOrUnavailable } from './cdp-page.mjs';
import { applyViewportOverride, formatClockSummary, formatNetworkMocksSummary, formatThrottleSummary } from './cdp-page-commands.mjs';
import { attachSelectorFrameMiss, crossSiteSummaryFrames, formatCrossSiteSummaryText, perceiveStr, renderedInteractiveSource } from './cdp-perceive.mjs';
import { relocateCrossSiteActionFields } from './frame-sites.mjs';
import { readTabObservation, writeTabObservation } from './tab-observation.mjs';

export function buildTargetStatusDiagnostic(err, { cmd = 'status', targetPrefix = '' } = {}) {
  const model = buildCliErrorModel(err, { cmd, targetPrefix });
  const state = model.recovery.kind === 'target-closed'
    ? 'closed'
    : model.recovery.kind === 'daemon-disconnect'
    ? 'daemon-disconnect'
    : 'error';
  return {
    state,
    error: model.error,
    recovery: model.recovery,
    nextSteps: model.nextSteps,
  };
}
export async function pageInfoModel(cdp, sid, opts = {}) {
  let title = '', url = '', contentType = '';
  try {
    const info = JSON.parse(await evalStr(cdp, sid, 'JSON.stringify({ title: document.title, url: window.location.href, contentType: document.contentType || "" })', false, { timeoutMs: STATUS_PAGE_INFO_TIMEOUT }));
    title = info.title;
    url = info.url;
    contentType = info.contentType || '';
  } catch (e) {
    return { title, url, contentType, diagnostic: buildTargetStatusDiagnostic(e, { targetPrefix: opts.targetPrefix }) };
  }
  return { title, url, contentType, diagnostic: null };
}
export function clearConsoleBaseline(consoleBuf, exceptionBuf, lastReadSeq) {
  const cleared = {
    console: consoleDocumentEntries(consoleBuf).length,
    exceptions: consoleDocumentEntries(exceptionBuf).length,
  };
  consoleBuf.clear();
  exceptionBuf.clear();
  lastReadSeq.console = consoleBuf.latest();
  lastReadSeq.exception = exceptionBuf.latest();
  return {
    schema: 'chrome-cdp-ex.console-baseline.v1',
    mode: 'clear',
    cleared,
    message: 'Console baseline cleared (console and exception buffers)',
  };
}
export function selectConsoleEntries(consoleBuf, exceptionBuf, lastReadSeq, flag) {
  const mode = flag === '--errors' ? 'errors' : flag === '--all' ? 'all' : flag || 'new';
  if (mode === 'all') return { mode, entries: consoleDocumentEntries(consoleBuf), exceptions: consoleDocumentEntries(exceptionBuf) };
  if (mode === 'errors') {
    return {
      mode,
      entries: consoleDocumentEntries(consoleBuf).filter(e => e.level === 'error' || e.level === 'warning'),
      exceptions: consoleDocumentEntries(exceptionBuf),
    };
  }
  return {
    mode: 'new',
    entries: consoleDocumentSince(consoleBuf, lastReadSeq.console),
    exceptions: consoleDocumentSince(exceptionBuf, lastReadSeq.exception),
  };
}
export function buildConsoleModel(consoleBuf, exceptionBuf, lastReadSeq, flag, located = null, { unsafeFull = false } = {}) {
  const { mode, entries, exceptions } = selectConsoleEntries(consoleBuf, exceptionBuf, lastReadSeq, flag);
  return {
    schema: 'chrome-cdp-ex.console.v1',
    mode,
    entries: entries.map(entry => redactObservedEntry(entry, located, { unsafeFull })),
    exceptions: exceptions.map(entry => redactObservedEntry(entry, located, { unsafeFull })),
  };
}
export function buildStatusModel({ targetId, page, consoleBuf, exceptionBuf, navBuf, lastReadSeq, runtime = null, vitals = null, diagnostic = null, located = null, unsafeFull = false }) {
  return {
    schema: 'chrome-cdp-ex.status.v1',
    targetId,
    target: {
      state: diagnostic?.state || 'connected',
      diagnostic,
    },
    page: redactDisplayedPage(page, { unsafeFull }),
    console: consoleDocumentSince(consoleBuf, lastReadSeq.console).map(entry => redactObservedEntry(entry, located, { unsafeFull })),
    exceptions: consoleDocumentSince(exceptionBuf, lastReadSeq.exception).map(entry => redactObservedEntry(entry, located, { unsafeFull })),
    navigation: redactNavigationEntries(navBuf.since(lastReadSeq.nav || 0), { unsafeFull }),
    runtime,
    vitals,
  };
}
export async function statusStr(cdp, sid, consoleBuf, exceptionBuf, navBuf, lastReadSeq, opts = {}) {
  const { title, url, diagnostic } = await pageInfoModel(cdp, sid, { targetPrefix: opts.targetPrefix });

  const lines = [];
  const unsafeFull = opts.unsafeFull === true;
  lines.push(`URL: ${displayUrl(url, { unsafeFull })}`);
  lines.push(`Title: ${title}`);
  if (diagnostic) {
    lines.push(`Target state: ${diagnostic.state}`);
    lines.push(`Diagnostic: ${diagnostic.error.message}`);
    lines.push(...formatCliErrorRecovery(diagnostic.recovery));
    lines.push(`Next: ${diagnostic.recovery.run}`);
  }

  const navs = navBuf.all();
  if (navs.length > 0) {
    const last = navs[navs.length - 1];
    const ago = Math.round((Date.now() - last.ts) / 1000);
    lines.push(`Navigations: ${navs.length} (last ${ago}s ago)`);
  }

  // Collect the slow probes before reading the buffers (as the JSON path does), so console
  // entries and exceptions logged during the vitals window are printed in this call.
  let runtimeLine = null;
  if (opts.runtime) {
    try {
      runtimeLine = await runtimeMetricsStr(cdp, sid);
    } catch (e) {
      runtimeLine = `Runtime metrics (Performance.getMetrics): unavailable (${e.message})`;
    }
  }
  const vitalsText = opts.vitals ? formatWebVitalsText(await webVitalsModelOrUnavailable(cdp, sid)) : null;

  // Read the buffers and snapshot how far they were read in the same synchronous step.
  const newConsole = consoleDocumentSince(consoleBuf, lastReadSeq.console);
  const newExceptions = consoleDocumentSince(exceptionBuf, lastReadSeq.exception);
  // Entries logged while source maps load are not printed here, so they stay unread.
  const readThrough = { console: consoleBuf.latest(), exception: exceptionBuf.latest() };
  const located = await locateObservedEntries(opts.locate, newConsole.slice(-20), newExceptions.slice(-10));

  if (newConsole.length > 0) {
    lines.push(`Console (${newConsole.length} new):`);
    for (const e of newConsole.slice(-20)) {
      const locText = displayLocation(locatedLoc(located, e), { unsafeFull });
      const loc = locText ? ` (${locText})` : '';
      lines.push(`  [${e.level}] ${displayConsoleLine(e.text, e, 200, { unsafeFull })}${loc}`);
    }
    if (newConsole.length > 20) lines.push(`  ... and ${newConsole.length - 20} more (use 'console --all')`);
  } else {
    lines.push('Console: (no new entries)');
  }

  if (newExceptions.length > 0) {
    lines.push(`Exceptions (${newExceptions.length} new):`);
    for (const e of newExceptions.slice(-10)) {
      const locText = displayLocation(locatedLoc(located, e), { unsafeFull });
      const loc = locText ? ` at ${locText}` : '';
      lines.push(`  ${displayConsoleLine(e.msg, e, 200, { unsafeFull })}${loc}`);
    }
  }

  if (runtimeLine) lines.push(runtimeLine);
  if (vitalsText) lines.push(vitalsText);

  lastReadSeq.console = readThrough.console;
  lastReadSeq.exception = readThrough.exception;

  return lines.join('\n');
}
export async function consoleStr(consoleBuf, exceptionBuf, lastReadSeq, flag, { locate = null, unsafeFull = false } = {}) {
  const { mode, entries, exceptions } = selectConsoleEntries(consoleBuf, exceptionBuf, lastReadSeq, flag);
  if (mode === 'new') {
    lastReadSeq.console = consoleBuf.latest();
    lastReadSeq.exception = exceptionBuf.latest();
  }

  const lines = [];
  if (entries.length === 0 && exceptions.length === 0) {
    return mode === 'all' ? 'Console buffer is empty' : 'No new console entries';
  }

  const located = await locateObservedEntries(locate, entries, exceptions);
  for (const e of entries) {
    const locText = displayLocation(locatedLoc(located, e), { unsafeFull });
    const loc = locText ? ` (${locText})` : '';
    lines.push(`[${e.level}] ${displayConsoleLine(e.text, e, 300, { unsafeFull })}${loc}`);
    lines.push(...locatedCallerLines(located, e, { unsafeFull }));
  }
  if (exceptions.length > 0) {
    lines.push('--- Uncaught Exceptions ---');
    for (const e of exceptions) {
      const locText = displayLocation(locatedLoc(located, e), { unsafeFull });
      const loc = locText ? ` at ${locText}` : '';
      lines.push(`[exception] ${displayConsoleLine(e.msg, e, 300, { unsafeFull })}${loc}`);
      lines.push(...locatedCallerLines(located, e, { unsafeFull }));
    }
  }
  return lines.join('\n');
}
export async function summaryModel(cdp, sid, consoleBuf, exceptionBuf, extra = {}) {
  const targetPrefix = extra.targetPrefix || '<target>';
  await assertNotPdfViewerPage(cdp, sid, { targetPrefix });
  const expr = `
    (function() {
      const counts = {};
      const renderedInteractive = ${renderedInteractiveSource()};
      const interactive = document.querySelectorAll('a, button, input, select, textarea, [role="button"], [tabindex]');
      let visibleControls = 0;
      for (const el of interactive) {
        if (el.getAttribute('aria-hidden') === 'true' || !renderedInteractive(el)) continue;
        visibleControls += 1;
        const tag = el.tagName.toLowerCase();
        const type = tag === 'input' ? 'input[' + (el.type || 'text') + ']' : tag;
        counts[type] = (counts[type] || 0) + 1;
      }
      const domNodes = document.querySelectorAll('*').length;
      let tableRows = 0;
      for (const table of document.querySelectorAll('table')) {
        const sourceRows = Number(table.getAttribute('data-source-rows') || table.dataset.sourceRows || 0);
        tableRows = Math.max(tableRows, table.querySelectorAll('tr').length, Number.isFinite(sourceRows) ? sourceRows : 0);
      }
      const hiddenTemplateNodes = document.querySelectorAll('template *, [data-hidden-template], [data-hidden-template] *, [hidden], [hidden] *, [aria-hidden="true"], [aria-hidden="true"] *').length;
      const focused = document.activeElement;
      const focusDesc = focused && focused !== document.body
        ? '<' + focused.tagName.toLowerCase() + (focused.id ? '#' + focused.id : '') + (focused.className ? '.' + focused.className.toString().split(' ')[0] : '') + '>'
        : 'none';
      return {
        title: document.title,
        url: window.location.href,
        viewport: window.innerWidth + 'x' + window.innerHeight,
        scrollY: Math.round(window.scrollY),
        scrollMax: Math.round(document.documentElement.scrollHeight - window.innerHeight),
        counts,
        domNodes,
        tableRows,
        visibleControls,
        hiddenTemplateNodes,
        focused: focusDesc,
      };
    })()
  `;
  const result = await evalStr(cdp, sid, expr);
  const r = JSON.parse(result);
  const allConsole = consoleDocumentEntries(consoleBuf);
  let errors = 0, warnings = 0;
  for (const e of allConsole) {
    if (e.level === 'error') errors++;
    else if (e.level === 'warning' || e.level === 'warn') warnings++;
  }
  const exceptions = consoleDocumentEntries(exceptionBuf).length;

  const model = {
    schema: 'chrome-cdp-ex.summary.v1',
    page: { title: r.title, url: displayUrl(r.url, { unsafeFull: extra.unsafeFull === true }) },
    viewport: {
      size: r.viewport,
      scrollY: r.scrollY,
      scrollMax: r.scrollMax,
    },
    interactive: r.counts,
    counts: {
      domNodes: r.domNodes || 0,
      tableRows: r.tableRows || 0,
      visibleControls: r.visibleControls || 0,
      hiddenTemplateNodes: r.hiddenTemplateNodes || 0,
    },
    limits: {
      outputTokenBudget: 1200,
      hiddenTemplateNodesOmitted: r.hiddenTemplateNodes || 0,
      truncated: (r.domNodes || 0) > 1000 || (r.tableRows || 0) > 100 || (r.visibleControls || 0) > 50 || (r.hiddenTemplateNodes || 0) > 0,
    },
    focused: r.focused,
    console: { errors, warnings, exceptions },
  };
  try {
    const frames = await crossSiteSummaryFrames(cdp, sid);
    if (frames.length) model.frames = frames;
  } catch {
    // A frame probe must not hide the page summary.
  }
  return model;
}
export async function summaryStr(cdp, sid, consoleBuf, exceptionBuf, extra = {}) {
  const model = await summaryModel(cdp, sid, consoleBuf, exceptionBuf, extra);
  const text = formatSummaryText(model);
  const frames = formatCrossSiteSummaryText(model.frames);
  return frames ? `${text}\n${frames}` : text;
}
export function normalizeRequestExpectation(pattern = '') {
  const text = String(pattern || '').trim();
  const match = text.match(/^([A-Z]+)\s+(.+)$/);
  return match
    ? { method: match[1], pattern: match[2].trim(), display: `${match[1]} ${match[2].trim()}` }
    : { method: null, pattern: text, display: text };
}
export function requestUrlPieces(url = '') {
  try {
    const parsed = new URL(url);
    return {
      full: parsed.href,
      path: `${parsed.pathname}${parsed.search || ''}`,
    };
  } catch {
    return { full: String(url || ''), path: String(url || '') };
  }
}
export function wildcardMatch(value = '', pattern = '') {
  const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`).test(String(value || ''));
}
export function findExpectedNetworkRequest(entries = [], expectation = '') {
  const expected = normalizeRequestExpectation(expectation);
  return (entries || []).find(entry => {
    if (expected.method && String(entry.method || '').toUpperCase() !== expected.method) return false;
    const pieces = requestUrlPieces(entry.url || '');
    return pieces.path.includes(expected.pattern)
      || pieces.full.includes(expected.pattern)
      || wildcardMatch(pieces.path, expected.pattern)
      || wildcardMatch(pieces.full, expected.pattern);
  }) || null;
}
export function buildSemanticInteractionModel(actionResult = {}, opts = {}, observed = {}) {
  const networkEntries = actionResult.effects?.networkDelta?.entries || actionResult.effects?.network || [];
  const consoleDelta = normalizeConsoleDelta(actionResult.effects?.consoleDelta || {});
  const exceptionDelta = normalizeExceptionDelta(actionResult.effects?.exceptionDelta || {});
  const assertions = [];
  let matchedRequest = null;

  if (opts.expectRequest) {
    matchedRequest = findExpectedNetworkRequest(networkEntries, opts.expectRequest);
    const expected = normalizeRequestExpectation(opts.expectRequest);
    const statusOk = opts.expectStatus == null || Number(matchedRequest?.status) === Number(opts.expectStatus);
    assertions.push({
      kind: 'request',
      expected: expected.display,
      expectedStatus: opts.expectStatus,
      status: matchedRequest && statusOk ? 'pass' : 'fail',
      matched: matchedRequest ? {
        method: matchedRequest.method || null,
        url: matchedRequest.url || null,
        status: matchedRequest.status ?? null,
        duration: matchedRequest.duration ?? null,
      } : null,
      message: matchedRequest
        ? `${expected.display} -> ${matchedRequest.status ?? 'unknown'} ${statusOk ? 'matched' : 'status-mismatch'}`
        : `${expected.display} not observed`,
    });
  }

  if (opts.expectText) {
    const matched = observed.textMatched === true;
    assertions.push({
      kind: 'text',
      expected: opts.expectText,
      status: matched ? 'pass' : 'fail',
      message: matched ? `"${opts.expectText}" matched` : `"${opts.expectText}" not found`,
    });
  }

  if (opts.noConsoleErrors) {
    const errors = Number(consoleDelta.errors || 0) + Number(exceptionDelta.count || 0);
    assertions.push({
      kind: 'console',
      expected: 'no console errors',
      status: errors === 0 ? 'pass' : 'fail',
      errors,
      warnings: Number(consoleDelta.warnings || 0),
      message: errors === 0 ? 'clean' : `${errors} error${errors === 1 ? '' : 's'}`,
    });
  }

  const dispatchOk = actionResult.dispatch?.ok !== false;
  const verdict = dispatchOk && assertions.every(assertion => assertion.status === 'pass') ? 'pass' : 'fail';
  return {
    schema: 'chrome-cdp-ex.semantic-interaction.v1',
    action: actionResult.action || 'click',
    target: actionResult.target?.input || actionResult.target?.label || opts.selector || null,
    dispatch: actionResult.dispatch || null,
    settlement: buildSettlementReceipt(actionResult),
    outcome: actionResult.outcome?.status || buildActionOutcome(actionResult).status,
    verdict,
    assertions,
    matchedRequest,
    ...actionDialogFields(actionResult.effects),
    actionEvidence: opts.evidence === 'full' ? actionResult : null,
  };
}
export function formatSemanticInteractionResult(model) {
  const lines = [
    `Action: ${model.action}${model.target ? ` ${model.target}` : ''}`,
    `Dispatch: ${model.dispatch?.ok === false ? 'failed' : 'ok'}`,
  ];
  for (const assertion of model.assertions || []) {
    if (assertion.kind === 'request') {
      lines.push(`Request: ${assertion.message}`);
    } else if (assertion.kind === 'text') {
      lines.push(`Text: ${assertion.message}`);
    } else if (assertion.kind === 'console') {
      lines.push(`Console: ${assertion.message}`);
    } else {
      lines.push(`${assertion.kind}: ${assertion.message || assertion.status}`);
    }
  }
  lines.push(...actionDialogLines(model));
  lines.push(`Verdict: ${model.verdict}`);
  if (model.verdict === 'fail') {
    lines.push('Kind: assertion');
    lines.push('Next: cdp help verify-click');
  }
  return lines.join('\n');
}
export function formatActionWorkflowCommandOutput(model, { format = 'text', text = '' } = {}) {
  if (format === 'json') return formatJson(model);
  const { action, dispatch } = actionDispatchSemanticsFromModel(model);
  if (dispatch?.ok === false) {
    throw new Error(actionDispatchFailureMessage(action, dispatch));
  }
  return typeof text === 'function' ? text() : text;
}
export function qaScreenshotCaptureOptions() {
  return {
    timeoutMs: QA_SCREENSHOT_TIMEOUT_MS,
    skipSanityRetry: true,
  };
}
export function diffShotScreenshotCaptureOptions() {
  return {
    timeoutMs: QA_SCREENSHOT_TIMEOUT_MS,
    skipSanityRetry: true,
    failFastOnTimeout: true,
  };
}
export function isScreenshotTimeoutError(err) {
  const msg = String(err?.message || '');
  return isTimeoutError(err)
    || /screenshot failed: all methods timed out/i.test(msg)
    || /screenshot alternate capture failed/i.test(msg)
    || /page\.capturescreenshot timed out/i.test(msg);
}
export function parseQaArgs(args = []) {
  const fopts = parseFormatArgs(args, ['text', 'json']);
  const opts = {
    desktop: '1440x900',
    mobile: '390x844',
    click: null,
    expectRequest: null,
    expectStatus: null,
    expectText: null,
    noConsoleErrors: false,
    format: fopts.format,
  };
  for (let i = 0; i < fopts.args.length; i++) {
    const token = fopts.args[i];
    if (token === '--desktop') opts.desktop = fopts.args[++i] || opts.desktop;
    else if (token === '--mobile') opts.mobile = fopts.args[++i] || opts.mobile;
    else if (token === '--click') opts.click = fopts.args[++i] || '';
    else if (token === '--expect-request') opts.expectRequest = fopts.args[++i] || '';
    else if (token === '--expect-status') {
      const status = Number(fopts.args[++i]);
      if (!Number.isInteger(status) || status < 100 || status > 599) throw new Error('qa: --expect-status requires an HTTP status code');
      opts.expectStatus = status;
    } else if (token === '--expect-text') opts.expectText = fopts.args[++i] || '';
    else if (token === '--no-console-errors') opts.noConsoleErrors = true;
    else throw new Error(`qa: unknown argument ${token}`);
  }
  return opts;
}
export function parseResponsiveAuditArgs(args = []) {
  const fopts = parseFormatArgs(args, ['text', 'json']);
  const opts = {
    format: fopts.format,
    viewports: [],
    outDir: null,
    maxControls: 12,
  };
  for (let i = 0; i < fopts.args.length; i++) {
    const token = fopts.args[i];
    if (token === '--viewport' || token === '-V') {
      const size = fopts.args[++i];
      if (!size) throw new Error('responsive-audit: --viewport requires WxH');
      opts.viewports.push(size);
    } else if (token === '--out-dir' || token === '--output-dir') {
      opts.outDir = fopts.args[++i] || null;
      if (!opts.outDir) throw new Error('responsive-audit: --out-dir requires a path');
    } else if (token === '--max-controls') {
      opts.maxControls = parseNonNegativeInteger(fopts.args[++i], 'responsive-audit: --max-controls');
    } else {
      throw new Error(`responsive-audit: unknown argument ${token}`);
    }
  }
  if (!opts.viewports.length) opts.viewports = ['1440x900', '390x844'];
  return opts;
}
export function responsiveAuditViewportScript({ maxControls = 12 } = {}) {
  const limit = Math.max(0, Math.min(Number(maxControls) || 12, 100));
  return `(function() {
    const doc = document.documentElement;
    const body = document.body;
    const scrollWidth = Math.max(doc?.scrollWidth || 0, body?.scrollWidth || 0);
    const scrollHeight = Math.max(doc?.scrollHeight || 0, body?.scrollHeight || 0);
    const clientWidth = doc?.clientWidth || window.innerWidth || 0;
    const clientHeight = doc?.clientHeight || window.innerHeight || 0;
    const overflowX = scrollWidth > clientWidth + 1;
    const allControls = Array.from(document.querySelectorAll('a,button,input,select,textarea,[role="button"],[role="link"]'))
      .filter(el => {
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      });
    const rectModel = rect => ({
      x: Math.round(rect.x), y: Math.round(rect.y),
      width: Math.round(rect.width), height: Math.round(rect.height),
    });
    const identity = el => {
      const id = el.id ? '#' + CSS.escape(el.id) : '';
      const testId = el.getAttribute('data-testid');
      const selector = id || (testId ? '[data-testid="' + CSS.escape(testId) + '"]' : el.tagName.toLowerCase());
      const name = (el.getAttribute('aria-label') || el.innerText || el.value || el.title || '').trim().slice(0, 80);
      return { selector, name };
    };
    const nearestScrollable = el => {
      for (let parent = el.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        const scrollable = parent.scrollWidth > parent.clientWidth + 1 || parent.scrollHeight > parent.clientHeight + 1;
        const clips = /(auto|scroll|hidden|clip)/.test(style.overflowX + ' ' + style.overflowY);
        if (scrollable && clips) return parent;
      }
      return null;
    };
    const intersectionRatio = (a, b) => {
      const width = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
      const height = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
      const area = width * height;
      const base = Math.max(1, Math.min(a.width * a.height, b.width * b.height));
      return area / base;
    };
    const clippedControls = [];
    for (const el of allControls.slice(0, 100)) {
      const container = nearestScrollable(el);
      if (!container) continue;
      const elementRect = el.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      const visibleRatio = intersectionRatio(elementRect, containerRect);
      const clippedRatio = Math.max(0, 1 - visibleRatio);
      if (clippedRatio < 0.20) continue;
      const role = container.getAttribute('role') || '';
      const intentional = container.getAttribute('data-cdp-audit-scroll') === 'intentional'
        || role === 'listbox' || role === 'feed';
      clippedControls.push({
        ...identity(el),
        severity: intentional ? 'info' : 'warning',
        clippedRatio: Math.round(clippedRatio * 1000) / 1000,
        elementRect: rectModel(elementRect),
        containerRect: rectModel(containerRect),
        suppressed: intentional,
        suppression: intentional ? 'intentional-scroll-container' : null,
      });
      if (clippedControls.length >= ${limit}) break;
    }
    const surfaces = Array.from(document.querySelectorAll('body *')).filter(el => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const visible = style.visibility !== 'hidden'
        && style.display !== 'none'
        && Number.parseFloat(style.opacity || '1') > 0.05
        && style.pointerEvents !== 'none'
        && !el.hidden
        && el.getAttribute('aria-hidden') !== 'true';
      return visible && rect.width > 0 && rect.height > 0 && (
        style.position === 'fixed' || style.position === 'sticky'
        || el.matches('dialog,[role="dialog"],[aria-modal="true"],[data-cdp-audit-overlay]')
      );
    }).slice(0, 80);
    const overlaps = [];
    for (const el of allControls.slice(0, 100)) {
      const elementRect = el.getBoundingClientRect();
      for (const surface of surfaces) {
        if (surface === el || surface.contains(el) || el.contains(surface)) continue;
        const occluderRect = surface.getBoundingClientRect();
        const overlapRatio = intersectionRatio(elementRect, occluderRect);
        if (overlapRatio < 0.20) continue;
        const overlapLeft = Math.max(elementRect.left, occluderRect.left);
        const overlapRight = Math.min(elementRect.right, occluderRect.right);
        const overlapTop = Math.max(elementRect.top, occluderRect.top);
        const overlapBottom = Math.min(elementRect.bottom, occluderRect.bottom);
        const topElement = document.elementFromPoint(
          (overlapLeft + overlapRight) / 2,
          (overlapTop + overlapBottom) / 2,
        );
        if (topElement !== surface && !surface.contains(topElement)) continue;
        overlaps.push({
          ...identity(el),
          occluderSelector: identity(surface).selector,
          occluderName: identity(surface).name,
          severity: 'warning',
          overlapRatio: Math.round(overlapRatio * 1000) / 1000,
          elementRect: rectModel(elementRect),
          occluderRect: rectModel(occluderRect),
        });
        break;
      }
      if (overlaps.length >= ${limit}) break;
    }
    const controls = allControls
      .slice(0, ${limit})
      .map(el => ({
        tag: el.tagName.toLowerCase(),
        text: (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 80),
      }));
    const bodyRect = body ? body.getBoundingClientRect() : { width: 0, height: 0 };
    const pageHealthSignals = {
      url: location.href,
      readyState: document.readyState,
      visibleTextLength: body ? (body.innerText || body.textContent || '').trim().length : 0,
      elementCount: document.querySelectorAll('*').length,
      visibleControlCount: allControls.length,
      bodyRect: { width: Math.round(bodyRect.width), height: Math.round(bodyRect.height) },
    };
    return JSON.stringify({
      url: location.href,
      title: document.title,
      viewport: window.innerWidth + 'x' + window.innerHeight,
      scroll: { width: scrollWidth, height: scrollHeight, clientWidth, clientHeight },
      overflowX,
      controlCount: allControls.length,
      controls,
      controlsTruncated: allControls.length > ${limit},
      maxControls: ${limit},
      clippedControls,
      overlaps,
      pageHealthSignals,
    });
  })()`;
}
export function countNetworkFailures(netReqBuf = null) {
  if (!netReqBuf || typeof netReqBuf.all !== 'function') return 0;
  return netReqBuf.all().filter(isNetworkFailure).length;
}
export function buildResponsiveAuditModel({
  targetId = '',
  viewports = [],
  page = {},
  console: consoleHealth = {},
  errors = [],
  viewportRestore = null,
} = {}) {
  const checks = viewports.map(entry => {
    const findings = normalizeResponsiveFindings(entry);
    const pageHealth = entry.pageHealth || (entry.pageHealthSignals
      ? classifyPageHealth(entry.pageHealthSignals)
      : {
          status: entry.blank ? 'blank' : 'populated',
          isBlank: Boolean(entry.blank),
          confidence: 'legacy',
          evidence: null,
        });
    const blank = pageHealth.isBlank === true;
    let status = 'pass';
    if (entry.error || entry.screenshotCapture?.sanity?.retry === true) status = 'fail';
    else if (blank || pageHealth.status === 'indeterminate' || entry.overflowX || hasResponsiveFindings(findings) || Number(consoleHealth.errors || 0) > 0) status = 'warn';
    return {
      viewport: entry.viewport,
      layoutViewport: entry.layoutViewport || null,
      status,
      url: entry.url || page.url || '',
      title: entry.title || page.title || '',
      screenshot: entry.screenshot || null,
      overflowX: Boolean(entry.overflowX),
      blank,
      pageHealth,
      scroll: entry.scroll || null,
      controlCount: entry.controlCount ?? null,
      controls: entry.controls || [],
      findings,
      screenshotCapture: entry.screenshotCapture || null,
      error: entry.error || null,
    };
  });
  const verdict = checks.some(c => c.status === 'fail')
    ? 'fail'
    : checks.some(c => c.status === 'warn')
      ? 'warn'
      : 'pass';
  return {
    schema: 'chrome-cdp-ex.responsive-audit.v1',
    targetId,
    targetPrefix: targetPrefixForDisplay(targetId),
    page,
    console: consoleHealth,
    viewports: checks,
    errors,
    ...(viewportRestore ? { viewportRestore } : {}),
    verdict,
    summary: {
      pass: checks.filter(c => c.status === 'pass').length,
      warn: checks.filter(c => c.status === 'warn').length,
      fail: checks.filter(c => c.status === 'fail').length,
    },
    nextSteps: [
      `cdp shot ${targetPrefixForDisplay(targetId)}`,
      `cdp perceive ${targetPrefixForDisplay(targetId)} -C -d 8`,
      `cdp report ${targetPrefixForDisplay(targetId)}`,
    ],
  };
}
export function formatResponsiveAuditReport(model) {
  const lines = [
    `Responsive audit: ${model.verdict}`,
    `Page: ${model.page?.title || '(untitled)'}`,
    `URL: ${model.page?.url || '(unknown)'}`,
    `Console: ${model.console?.errors || 0} errors, ${model.console?.warnings || 0} warnings`,
    `Summary: ${model.summary.pass} pass / ${model.summary.warn} warn / ${model.summary.fail} fail`,
  ];
  for (const vp of model.viewports || []) {
    lines.push(`- ${vp.viewport}: ${vp.status}` +
      `${vp.layoutViewport && vp.layoutViewport !== vp.viewport ? ` layout=${vp.layoutViewport}` : ''}` +
      `${vp.overflowX ? ' overflow-x' : ''}` +
      `${vp.blank ? ' blank' : ''}` +
      `${vp.findings?.clippedControls?.length || vp.findings?.overlaps?.length ? ` clipped=${vp.findings.clippedControls.length} overlap=${vp.findings.overlaps.length}` : ''}` +
      `${vp.controlCount != null ? ` controls=${vp.controlCount}` : ''}` +
      `${vp.screenshot ? ` shot=${vp.screenshot}` : ''}` +
      `${vp.error ? ` error=${vp.error}` : ''}`);
  }
  const restoreLine = formatViewportRestoreLine(model.viewportRestore);
  if (restoreLine) lines.push(restoreLine);
  for (const error of model.errors || []) lines.push(`Error: ${error}`);
  if (model.nextSteps?.[0]) lines.push(`Next: ${model.nextSteps[0]}`);
  return lines.join('\n');
}
export async function responsiveAuditStr(cdp, sid, session, targetId, consoleBuf, exceptionBuf, args = []) {
  const opts = parseResponsiveAuditArgs(args);
  const targetPrefix = targetPrefixForDisplay(targetId);
  const page = await pageInfoModel(cdp, sid, { targetPrefix });
  if (isPdfViewerContentType(page.contentType)) {
    throw pdfViewerError(page, { targetPrefix });
  }
  const originalViewport = await captureViewportSize(cdp, sid);
  const consoleHealth = {
    errors: consoleDocumentEntries(consoleBuf).filter(entry => entry.level === 'error').length,
    warnings: consoleDocumentEntries(consoleBuf).filter(entry => entry.level === 'warning' || entry.level === 'warn').length,
    exceptions: consoleDocumentEntries(exceptionBuf).length,
  };
  const viewports = [];
  const errors = [];
  // One tier state for every viewport: a capture tier that timed out is not retried per size.
  const tierState = createScreenshotTierState();
  let viewportRestore = null;
  try {
    let screenshotTimedOut = false;
    for (const size of opts.viewports) {
      const entry = { viewport: size };
      try {
        if (screenshotTimedOut) {
          entry.error = 'skipped after previous screenshot timeout';
          errors.push(`${size}: ${entry.error}`);
          viewports.push(entry);
          continue;
        }
        await applyViewportOverride(cdp, sid, size);
        const metricsRaw = await evalStr(cdp, sid, responsiveAuditViewportScript({ maxControls: opts.maxControls }));
        // The page reports its layout viewport (a mobile size without <meta viewport> lays
        // out at 980px); keep the requested size as the entry's label (#452).
        const { viewport: layoutViewport, ...metrics } = JSON.parse(metricsRaw);
        Object.assign(entry, metrics);
        if (layoutViewport) entry.layoutViewport = layoutViewport;
        const shotDir = opts.outDir || session.screenshotDir || null;
        if (opts.outDir) {
          try { mkdirSync(opts.outDir, { recursive: true }); } catch {}
        } else {
          ensureSessionScreenshotDir(session);
        }
        const path = opts.outDir
          ? resolve(opts.outDir, `responsive-${size.replace(/[^0-9x]/gi, 'x')}-${Date.now()}.png`)
          : nextSessionScreenshotPath(session, `responsive-${size}`);
        let screenshotCapture = null;
        const shot = await shotStr(cdp, sid, path, targetId, { quiet: true, tierState, onCapture: capture => { screenshotCapture = capture; } });
        entry.screenshot = shot.split('\n')[0];
        if (screenshotCapture) {
          entry.screenshotCapture = {
            method: screenshotCapture.method,
            retryCount: screenshotCapture.retryCount || 0,
            sanity: screenshotCapture.sanity || null,
          };
        }
        appendSessionScreenshot(session, { kind: 'responsive-audit', path: entry.screenshot, note: size });
        if (!shotDir && !opts.outDir) {
          // default screenshots stay under session dir outside the repo
        }
      } catch (e) {
        entry.error = e.message || String(e);
        errors.push(`${size}: ${entry.error}`);
        // A hidden tab stays hidden for the next size too (#488).
        if (isScreenshotTimeoutError(e) || isHiddenTabCaptureError(e)) screenshotTimedOut = true;
      }
      viewports.push(entry);
    }
    // #533: restore before the receipt is built, so the receipt can say where the viewport ended up.
    viewportRestore = await restoreAuditViewport(cdp, sid, session, originalViewport);
    const model = buildResponsiveAuditModel({
      targetId,
      viewports,
      page: { title: page.title, url: page.url },
      console: consoleHealth,
      errors,
      viewportRestore,
    });
    if (screenshotTimedOut) {
      const timeoutError = errors.find(msg => isScreenshotTimeoutError({ message: msg })) || errors[0];
      throw new Error(timeoutError);
    }
    return opts.format === 'json' ? formatJson(model) : formatResponsiveAuditReport(model);
  } finally {
    if (!viewportRestore) await restoreAuditViewport(cdp, sid, session, originalViewport);
  }
}
export function buildQaPageModel({ targetId = '', page = {}, pageHealth = null, console: consoleHealth = {}, perception = null, screenshots = {}, action = null, assertions = [], errors = [] } = {}) {
  const checks = {
    page: pageHealth?.isBlank ? 'fail' : pageHealth?.status === 'indeterminate' ? 'warn' : page?.url || page?.title ? 'pass' : 'fail',
    console: Number(consoleHealth.errors || 0) === 0 && Number(consoleHealth.exceptions || 0) === 0 ? 'pass' : 'fail',
    desktopScreenshot: screenshots.desktop?.path ? 'pass' : 'skip',
    mobileScreenshot: screenshots.mobile?.path ? 'pass' : 'skip',
    assertions: assertions.length ? (assertions.every(assertion => assertion.status === 'pass') ? 'pass' : 'fail') : 'skip',
    action: action ? action.verdict : 'skip',
  };
  if (errors.length) checks.errors = 'fail';
  const verdict = Object.values(checks).some(status => status === 'fail') ? 'fail' : 'pass';
  return {
    schema: 'chrome-cdp-ex.qa-page.v1',
    targetId,
    targetPrefix: targetPrefixForDisplay(targetId),
    page,
    pageHealth,
    console: consoleHealth,
    perception,
    screenshots,
    action,
    assertions,
    errors,
    checks,
    verdict,
    nextSteps: [
      `cdp report ${targetPrefixForDisplay(targetId)} --format json`,
      `cdp perceive ${targetPrefixForDisplay(targetId)} -C -d 8`,
    ],
  };
}
export function formatQaPageReport(model) {
  const lines = [
    `QA page: ${model.page?.title || '(untitled)'}`,
    `URL: ${model.page?.url || '(unknown)'}`,
    `Page: ${model.checks.page}${model.pageHealth?.status ? ` (${model.pageHealth.status})` : ''}`,
    `Console: ${model.checks.console}${model.console ? ` (${model.console.errors || 0} errors, ${model.console.warnings || 0} warnings, ${model.console.exceptions || 0} exceptions)` : ''}`,
  ];
  if (model.screenshots?.desktop?.path) lines.push(`Desktop screenshot: ${model.screenshots.desktop.path}`);
  if (model.screenshots?.mobile?.path) lines.push(`Mobile screenshot: ${model.screenshots.mobile.path}`);
  if (model.action) {
    lines.push(`Action: ${model.action.verdict}`);
    for (const assertion of model.action.assertions || []) {
      lines.push(`  ${assertion.kind}: ${assertion.status} — ${assertion.message || assertion.expected}`);
    }
  }
  if (model.assertions?.length) {
    lines.push('Assertions:');
    for (const assertion of model.assertions) {
      lines.push(`  ${assertion.kind}: ${assertion.status} — ${assertion.message || assertion.expected}`);
    }
  }
  for (const error of model.errors || []) lines.push(`Error: ${error}`);
  lines.push(`Verdict: ${model.verdict}`);
  return lines.join('\n');
}
export async function captureViewportSize(cdp, sid) {
  try {
    const dims = JSON.parse(await evalStr(
      cdp,
      sid,
      'JSON.stringify({w:window.innerWidth,h:window.innerHeight})',
    ));
    const width = Number(dims?.w);
    const height = Number(dims?.h);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
    return `${Math.round(width)}x${Math.round(height)}`;
  } catch {
    return null;
  }
}
// #533: put the viewport back the way the audit found it. A `viewport` override set earlier in this
// session is reapplied; otherwise the override is cleared, so the audit leaves no override the user
// never set. The read-back says whether the size matches the one captured before the audit.
export async function restoreAuditViewport(cdp, sid, session, original) {
  try {
    const override = session?.viewportOverride;
    if (override?.width && override?.height) {
      await applyViewportOverride(cdp, sid, `${override.width}x${override.height}`);
    } else {
      await cdpDomains(cdp).Emulation.clearDeviceMetricsOverride( {}, sid);
    }
    const viewport = await captureViewportSize(cdp, sid);
    const status = !original || !viewport ? 'unknown' : viewport === original ? 'restored' : 'left';
    return { status, original: original || null, viewport: viewport || null };
  } catch (e) {
    return { status: 'failed', original: original || null, viewport: null, error: e?.message || String(e) };
  }
}
export function formatViewportRestoreLine(restore) {
  if (!restore) return null;
  if (restore.status === 'restored') return `Viewport restored to ${restore.viewport}`;
  if (restore.status === 'left') return `Viewport left at ${restore.viewport} (was ${restore.original})`;
  if (restore.status === 'failed') return `Viewport restore failed: ${restore.error}`;
  return `Viewport reset to ${restore.viewport || 'unknown size'} (size before the audit unknown)`;
}
export async function qaPageStr({
  cdp,
  sid,
  session,
  targetId,
  consoleBuf,
  exceptionBuf,
  refMap,
  lastPerceiveStore,
  refState,
  actionFeedback,
}, args = []) {
  const qopts = parseQaArgs(args);
  const errors = [];
  const page = await pageInfoModel(cdp, sid, { targetPrefix: targetPrefixForDisplay(targetId) });
  if (isPdfViewerContentType(page.contentType)) {
    const targetPrefix = targetPrefixForDisplay(targetId);
    return qopts.format === 'json'
      ? formatJson(pdfViewerHandoffModel(page, { targetPrefix }))
      : formatPdfViewerOutput(page, { targetPrefix });
  }
  const originalViewport = await captureViewportSize(cdp, sid);
  const consoleHealth = {
    errors: consoleDocumentEntries(consoleBuf).filter(entry => entry.level === 'error').length,
    warnings: consoleDocumentEntries(consoleBuf).filter(entry => entry.level === 'warning' || entry.level === 'warn').length,
    exceptions: consoleDocumentEntries(exceptionBuf).length,
  };
  const screenshots = {};
  let screenshotTimedOut = false;
  try {
    for (const [kind, size] of [['desktop', qopts.desktop], ['mobile', qopts.mobile]]) {
      if (!size) continue;
      if (screenshotTimedOut) {
        errors.push(`${kind} screenshot: skipped after previous screenshot timeout`);
        continue;
      }
      try {
        await applyViewportOverride(cdp, sid, size);
        ensureSessionScreenshotDir(session);
        const path = nextSessionScreenshotPath(session, kind);
        const shot = await shotStr(cdp, sid, path, targetId, {
          quiet: true,
          ...qaScreenshotCaptureOptions(),
        });
        appendSessionScreenshot(session, { kind: `qa-${kind}`, path: shot.split('\n')[0], note: size });
        screenshots[kind] = { viewport: size, path: shot.split('\n')[0] };
      } catch (error) {
        errors.push(`${kind} screenshot: ${error.message}`);
        if (isScreenshotTimeoutError(error) || isHiddenTabCaptureError(error)) screenshotTimedOut = true;
      }
    }
    let perception = null;
    try {
      const text = await perceiveStr(cdp, sid, consoleBuf, exceptionBuf, refMap, lastPerceiveStore, {
        cursorInteractive: true,
        maxDepth: 4,
        targetPrefix: targetPrefixForDisplay(targetId),
      }, refState);
      perception = { captured: true, summary: text.split('\n').slice(0, 6).join('\n') };
    } catch (error) {
      perception = { captured: false, error: error.message };
      errors.push(`perceive: ${error.message}`);
    }
    let action = null;
    const assertions = [];
    if (qopts.click) {
      let captured = null;
      await actionFeedback(
        'click',
        () => clickStr(cdp, sid, qopts.click, refMap, refState),
        { input: qopts.click, resolvedBy: 'selector-or-ref', label: qopts.click || '', commandArgs: [qopts.click] },
        'settle-diff',
        null,
        'json',
        result => { captured = result; },
      );
      const textMatched = qopts.expectText
        ? await pageContainsText(cdp, sid, qopts.expectText).catch(() => false)
        : false;
      action = buildSemanticInteractionModel(captured || {}, {
        selector: qopts.click,
        expectRequest: qopts.expectRequest,
        expectStatus: qopts.expectStatus,
        expectText: qopts.expectText,
        noConsoleErrors: qopts.noConsoleErrors,
        evidence: 'concise',
      }, { textMatched });
    } else {
      if (qopts.expectText) {
        const textMatched = await pageContainsText(cdp, sid, qopts.expectText).catch(() => false);
        assertions.push({
          kind: 'text',
          expected: qopts.expectText,
          status: textMatched ? 'pass' : 'fail',
          message: textMatched ? `"${qopts.expectText}" matched` : `"${qopts.expectText}" not found`,
        });
      }
      if (qopts.expectRequest) {
        assertions.push({
          kind: 'request',
          expected: qopts.expectRequest,
          status: 'fail',
          message: '--expect-request requires --click so the command can collect action network evidence',
        });
      }
    }
    const pageHealth = await collectPageHealth(cdp, sid).catch(() => null);
    const model = buildQaPageModel({
      targetId,
      page: { title: page.title, url: page.url },
      pageHealth,
      console: consoleHealth,
      perception,
      screenshots,
      action,
      assertions,
      errors,
    });
    return formatActionWorkflowCommandOutput(model, {
      format: qopts.format,
      text: () => formatQaPageReport(model),
    });
  } finally {
    await restoreAuditViewport(cdp, sid, session, originalViewport);
  }
}
export async function pageContainsText(cdp, sid, text) {
  if (!text) return false;
  const raw = await evalStr(cdp, sid, `(function() {
    const needle = ${JSON.stringify(String(text))};
    const body = document.body ? (document.body.innerText || document.body.textContent || '') : '';
    return JSON.stringify({ matched: body.includes(needle) });
  })()`);
  try {
    return JSON.parse(raw).matched === true;
  } catch {
    return false;
  }
}
export function clickControlShouldReact(result, dispatchText) {
  const action = String(result?.action || '').toLowerCase();
  if (action !== 'click' && action !== 'jsclick') return false;
  const trust = result?.target?.clickTrust;
  const role = String(trust?.role || '').toLowerCase();
  if (REACTIVE_CLICK_ROLES.has(role)) return true;
  const tag = String(trust?.tag || '').toUpperCase()
    || String(dispatchText || '').match(CLICKED_CONTROL_TAG_RE)?.[1]?.toUpperCase()
    || '';
  return REACTIVE_CLICK_TAGS.has(tag);
}
function dispatchErrorWithFrameBlock(message, block) {
  const extra = String(block || '').trim();
  const head = String(message || '');
  return extra ? `${head}\n${extra}` : head;
}
export function clickNoChangeError(dispatchText) {
  // A cross-site receipt ends in a frame block. Keep it on its own lines, out of the Error: line.
  // Only a cross-site head (`<TAG> (@fN:M) in host`) splits; a top-page label is page text.
  const raw = String(dispatchText || '');
  const crossSite = /^(?:Clicked|JS-clicked|Pointer-clicked) <[^>"\s]*> \(@f\d+:\d+\) in \S/.test(raw);
  const blockAt = crossSite ? raw.search(/^--- FRAME CONTENT \(untrusted\) /m) : -1;
  const line = (blockAt < 0 ? raw : raw.slice(0, blockAt)).replace(/\s+/g, ' ').trim();
  const err = new Error(`click: the control did not react (Outcome: no-change).${line ? ` ${line}` : ''}`);
  err.clickNoChange = { dispatchText: line };
  if (blockAt >= 0) err.frameContentBlock = raw.slice(blockAt).trim();
  return err;
}
// #552: a mouse or JS click that reached a control and settled as no-change is a
// failed action. Expected no-change (clipboard, PDF viewer, and the other
// existing cases) stays a success. Exit code stays 1; this is not a per-Kind map.
export function applyReactiveClickNoChangeFailure(result, dispatchText) {
  if (!result || result.dispatch?.ok === false) return null;
  const downloadState = result.effects?.download?.state;
  if (downloadState === 'started' || downloadState === 'completed' || downloadState === 'unobserved') return null;
  if (result.effects?.childFrame) return null;
  if (result.outcome?.status !== 'no-change') return null;
  if (!clickControlShouldReact(result, dispatchText)) return null;
  const target = result.target && typeof result.target === 'object' ? result.target : {};
  if (isExpectedNoChange(
    { ...target, dispatchText: target.dispatchText || dispatchText },
    [dispatchText, result.effects?.domDiff].filter(Boolean).join('\n'),
    result.action,
  )) return null;
  const err = clickNoChangeError(dispatchText);
  const failure = classifyActionFailure(err, { action: result.action, target });
  result.dispatch = {
    ...(result.dispatch || {}),
    ok: false,
    error: dispatchErrorWithFrameBlock(failure.originalMessage, err.frameContentBlock),
  };
  result.settle = { ...(result.settle || {}), ok: false };
  result.effects = result.effects || {};
  result.effects.failure = failure;
  applyActionReceipt(applyActionVerdict(applyActionRecommendation(applyActionOutcome(applyActionDiagnosis(result)))));
  return err;
}
export async function finishObservedAction(result, { output, dispatchText, enrichActionResult, onActionResult }) {
  await finalizeActionResult(result, { enrichActionResult, onActionResult: null });
  const refused = applyReactiveClickNoChangeFailure(result, dispatchText);
  if (onActionResult) onActionResult(result);
  if (refused) {
    if (output.format === 'json') return formatActionResultOutput(result, { ...output, dispatchText });
    const wrapped = new Error(formatActionFailure(refused, { action: result.action, target: result.target }));
    wrapped.clickNoChange = true;
    throw wrapped;
  }
  return formatActionResultOutput(result, { ...output, dispatchText });
}
export async function runActionWithFeedback({ action, target = null, dispatch, feedbackPolicy, observe, dispatchMethod = action, nextHint = GENERIC_SINCE_ACTION_HINT, enrichActionResult = null, onActionResult = null, format = 'text', cdp = null, sid = null, refState = null }) {
  const output = normalizeActionOutputOptions(format);
  const startedAt = Date.now();
  let dispatchText;
  try {
    dispatchText = await dispatch();
  } catch (e) {
    if (cdp && sid) await attachSelectorFrameMiss(cdp, sid, e, target || {}, refState);
    const failure = classifyActionFailure(e, { action, target });
    if (failure.kind === 'usage') throw e;
    const result = createActionResult({
      action,
      target: target || { input: '', resolvedBy: 'command', label: '' },
      dispatch: { ok: false, method: dispatchMethod, error: dispatchErrorWithFrameBlock(failure.originalMessage, e?.frameContentBlock) },
      settle: { ok: false, durationMs: Date.now() - startedAt },
      effects: { domDiff: null, console: [], network: [], navigation: null, failure },
      nextHint: failure.nextCommand,
    });
    await finalizeActionResult(result, { enrichActionResult, onActionResult });
    if (result.effects?.download?.state === 'started' && result.dispatch?.ok !== false) {
      const text = String(result.target?.dispatchText || '');
      return formatActionResultOutput(result, { ...output, dispatchText: text });
    }
    if (output.format === 'json') return formatActionResultOutput(result, output);
    throw new Error(scrubSecretValues(
      [formatActionFailure(e, { action, target }), ...downloadReceiptLines(result.effects?.download), ...actionDialogLines(result.effects)].join('\n'),
      sensitiveActionValues(action, target),
    ));
  }
  // #437 / #639: a click whose effect is outside this document says so in its dispatch text.
  const outsideEffect = clickDispatchEffects(action, dispatchText);
  if (feedbackPolicy === 'none' || feedbackPolicy === 'report-only') {
    const result = createActionResult({
      action,
      target: target || { input: '', resolvedBy: 'command', label: '' },
      dispatch: { ok: true, method: dispatchMethod },
      settle: { ok: true, durationMs: Date.now() - startedAt },
      effects: { domDiff: null, console: [], network: [], navigation: null, ...outsideEffect },
      nextHint: feedbackPolicy === 'report-only' ? nextHint : null,
    });
    if (feedbackPolicy === 'none') {
      await finalizeActionResult(result, { enrichActionResult, onActionResult });
      return dispatchText;
    }
    return finishObservedAction(result, { output, dispatchText, enrichActionResult, onActionResult });
  }
  try {
    const domDiff = await observe();
    const result = createActionResult({
      action,
      target: target || { input: '', resolvedBy: 'command', label: '' },
      dispatch: { ok: true, method: dispatchMethod },
      settle: { ok: true, durationMs: Date.now() - startedAt },
      effects: { domDiff, console: [], network: [], navigation: null, ...outsideEffect },
      nextHint,
    });
    return await finishObservedAction(result, { output, dispatchText, enrichActionResult, onActionResult });
  } catch (e) {
    if (e?.clickNoChange) throw e;
    const observationError = isTimeoutError(e) ? null : compactObservationError(e);
    const result = createActionResult({
      action,
      target: target || { input: '', resolvedBy: 'command', label: '' },
      dispatch: { ok: true, method: dispatchMethod },
      settle: { ok: false, durationMs: Date.now() - startedAt },
      effects: {
        domDiff: null,
        console: [],
        network: [],
        navigation: null,
        ...outsideEffect,
        ...(observationError ? { observationError } : {}),
      },
      nextHint,
    });
    await finalizeActionResult(result, { enrichActionResult, onActionResult });
    return formatActionResultOutput(result, {
      ...output,
      dispatchText,
      timeoutError: observationError ? null : e,
    });
  }
}
export function actionDomDiffSampleScore(line = '') {
  const trimmed = String(line || '').trim();
  let score = 0;
  if (trimmed.startsWith('+')) score += 2;
  if (/^\+\s+\[(alert|status|statustext|statictext|heading)\]/i.test(trimmed)) score += 2;
  if (HIGH_SIGNAL_ACTION_TEXT_RE.test(trimmed)) score += 4;
  if (/^-\s/.test(trimmed)) score -= 2;
  return score;
}
export function chooseActionDomDiffSample(lines = []) {
  const samples = lines.filter(l => /^[+-]\s/.test(l));
  if (!samples.length) return null;
  return samples
    .map((line, index) => ({ line, index, score: actionDomDiffSampleScore(line) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)[0].line;
}
export function summarizeActionDomDiff(domDiff) {
  const lines = String(domDiff || '').split('\n').map(l => l.trim()).filter(Boolean);
  const summary = lines.find(l =>
    l.startsWith('+++ Added') ||
    l.startsWith('--- Removed') ||
    l.startsWith('~~~ Text nodes updated') ||
    l.includes('no changes detected')
  ) || null;
  const sample = chooseActionDomDiffSample(lines);
  return { summary, sample };
}
export function compactActionTargetModel(target = null) {
  if (!target || typeof target !== 'object') return target;
  const compact = {};
  for (const field of ['targetId', 'input', 'resolvedBy', 'label', 'frameRef', 'redacted', 'expectedOutcome']) {
    if (target[field] !== undefined && target[field] !== null && target[field] !== '') compact[field] = target[field];
  }
  return compact;
}
export function compactActionDeltaModel(delta = {}, fields = []) {
  const compact = {
    count: numericDeltaCount(delta.count, 0),
  };
  for (const field of fields) {
    compact[field] = numericDeltaCount(delta[field], 0);
  }
  const entries = Array.isArray(delta.entries) ? delta.entries.filter(Boolean) : [];
  const signal = entries.find(entry => (
    entry?.level === 'error'
    || entry?.level === 'warning'
    || entry?.level === 'warn'
    || entry?.failed === true
    || entry?.errorText
    || Number(entry?.status) >= 400
    || entry?.pending === true
  )) || entries[0];
  if (signal) {
    compact.sample = Object.fromEntries(Object.entries(signal).filter(([, value]) => (
      value !== null && value !== undefined && value !== '' && value !== false
    )));
  }
  return compact;
}
export function compactActionFailureModel(failure = null) {
  if (!failure || typeof failure !== 'object') return null;
  return {
    kind: failure.kind || 'unknown',
    reason: failure.reason || failure.originalMessage || null,
    nextCommand: failure.nextCommand || null,
  };
}
export function compactActionRecommendationModel(recommendation = null) {
  if (!recommendation || typeof recommendation !== 'object') return null;
  const compact = {};
  for (const field of ['source', 'strategy', 'action', 'targetPrefix', 'outcomeStatus', 'diagnosisKind', 'priority', 'verifyCommand']) {
    if (recommendation[field] !== undefined && recommendation[field] !== null && recommendation[field] !== '') {
      compact[field] = recommendation[field];
    }
  }
  for (const field of ['commands', 'blockingSignals']) {
    if (Array.isArray(recommendation[field]) && recommendation[field].length) compact[field] = recommendation[field];
  }
  return compact;
}
export function compactActionOutcomeModel(outcome = null) {
  if (!outcome || typeof outcome !== 'object') return null;
  return {
    status: outcome.status || 'unknown',
    changed: outcome.changed ?? null,
    needsAttention: outcome.needsAttention === true,
    evidence: outcome.evidence || null,
  };
}
export function compactActionVerdictForJson(verdict = null) {
  if (!verdict || typeof verdict !== 'object') return null;
  return {
    status: verdict.status || 'verify',
    canContinue: verdict.canContinue === true,
    needsRecovery: verdict.needsRecovery === true,
    primaryNextStep: verdict.primaryNextStep || null,
  };
}
export function receiptForCompactActionJson(receipt = null) {
  const base = receiptForActionJson(receipt);
  if (!base || typeof base !== 'object') return base;
  return {
    schema: base.schema || 'chrome-cdp-ex.action-receipt.v1',
    eventId: base.eventId || null,
    sequence: base.sequence ?? null,
    dispatch: base.dispatch || null,
    settlement: {
      state: base.settlement?.state || null,
      strategy: base.settlement?.strategy || null,
      durationMs: Number.isFinite(base.settlement?.durationMs) ? base.settlement.durationMs : null,
      signals: Array.isArray(base.settlement?.signals) ? base.settlement.signals : [],
    },
    outcome: base.outcome || null,
    observedDelta: Array.isArray(base.observedDelta) ? base.observedDelta.slice(0, 2) : [],
    observedDeltaDetails: Array.isArray(base.observedDeltaDetails) ? base.observedDeltaDetails.slice(0, 2) : [],
    blockingSignals: Array.isArray(base.blockingSignals) ? base.blockingSignals : [],
    recoveryHint: base.recoveryHint || null,
    nextSteps: Array.isArray(base.nextSteps) ? base.nextSteps : [],
  };
}
export function compactActionEffectsModel(effects = {}) {
  const compact = {};
  if (typeof effects.domDiff === 'string') {
    const summary = effects.domDiffSummary || summarizeActionDomDiff(effects.domDiff).summary;
    const sample = effects.domDiffSample || summarizeActionDomDiff(effects.domDiff).sample;
    compact.domDiffChars = Number.isFinite(effects.domDiffChars) ? effects.domDiffChars : effects.domDiff.length;
    compact.domDiffSummary = summary || 'DOM observation captured';
    if (sample) compact.domDiffSample = sample;
    if (effects.domDiffTruncated === true || effects.domDiff.length > MAX_ACTION_JSON_DOM_DIFF_CHARS) {
      compact.domDiffTruncated = true;
    }
  } else if (Object.hasOwn(effects, 'domDiff')) {
    compact.domDiff = effects.domDiff ?? null;
    if (compact.domDiff == null) compact.domDiffSummary = 'DOM observation not captured';
  } else {
    compact.domDiff = null;
    compact.domDiffSummary = 'DOM observation not captured';
  }
  compact.consoleDelta = compactActionDeltaModel(normalizeConsoleDelta(effects.consoleDelta || {}), ['errors', 'warnings']);
  compact.exceptionDelta = compactActionDeltaModel(normalizeExceptionDelta(effects.exceptionDelta || {}));
  compact.networkDelta = compactActionDeltaModel(normalizeNetworkDelta(effects.networkDelta || {}), ['failures', 'pending']);
  Object.assign(compact, actionDialogFields(effects));
  if (effects.download) compact.download = effects.download;
  const pageHealthIsActionable = effects.pageHealth && (
    effects.pageHealth.status !== 'populated'
    || effects.pageHealth.isBlank === true
    || effects.pageHealth.evidence?.changed === true
  );
  if (pageHealthIsActionable) {
    const healthEvidence = { changed: effects.pageHealth.evidence?.changed === true };
    if (effects.pageHealth.status !== 'populated') {
      Object.assign(healthEvidence, {
        readyState: effects.pageHealth.evidence?.readyState || null,
        visibleTextLength: effects.pageHealth.evidence?.visibleTextLength ?? null,
        elementCount: effects.pageHealth.evidence?.elementCount ?? null,
        visibleControlCount: effects.pageHealth.evidence?.visibleControlCount ?? null,
        bodyRect: effects.pageHealth.evidence?.bodyRect || null,
      });
    }
    compact.pageHealth = {
      status: effects.pageHealth.status || 'indeterminate',
      isBlank: effects.pageHealth.isBlank === true,
      confidence: effects.pageHealth.confidence || 'low',
      evidence: healthEvidence,
    };
  }
  const failure = compactActionFailureModel(effects.failure);
  if (failure) compact.failure = failure;
  const diagnosis = compactActionDiagnosisModel(effects.diagnosis);
  if (diagnosis && diagnosis.status !== 'ok') compact.diagnosis = diagnosis;
  if (effects.observationError?.message) compact.observationError = effects.observationError;
  return compact;
}
export function compactActionHandoffForJson(result = {}) {
  return {
    schema: result.schema || 'chrome-cdp-ex.action.v1',
    mode: 'compact',
    action: result.action || null,
    target: compactActionTargetModel(result.target || null),
    dispatch: result.dispatch || null,
    settle: result.settle || null,
    effects: compactActionEffectsModel(result.effects || {}),
    outcome: compactActionOutcomeModel(result.outcome),
    verdict: compactActionVerdictForJson(result.verdict),
    recommendation: compactActionRecommendationModel(result.recommendation),
    nextSteps: Array.isArray(result.nextSteps) ? result.nextSteps : [],
    receipt: receiptForCompactActionJson(result.receipt),
  };
}
export function compactActionResultForJson(result, { compact: compactMode = false } = {}) {
  const compact = JSON.parse(JSON.stringify(result));
  compact.target = relocateCrossSiteActionFields(sanitizeActionTargetForLog(compact.action, result.target || null));
  if (compact.effects?.failure?.target) {
    compact.effects.failure.target = relocateCrossSiteActionFields(sanitizeActionTargetForLog(compact.action, result.target || null));
  }
  compact.receipt = receiptForActionJson(compact.receipt);
  const effects = compact.effects || {};
  if (typeof effects.domDiff !== 'string') {
    const redacted = redactSensitiveArtifactValue(compact);
    return compactMode ? compactActionHandoffForJson(redacted) : redacted;
  }

  const original = effects.domDiff;
  const { summary, sample } = summarizeActionDomDiff(original);
  effects.domDiffChars = original.length;
  effects.domDiffSummary = summary;
  effects.domDiffSample = sample;
  effects.domDiffTruncated = original.length > MAX_ACTION_JSON_DOM_DIFF_CHARS;
  if (effects.domDiffTruncated) {
    effects.domDiff = [summary, sample].filter(Boolean).join('\n')
      || compactActionText(original, MAX_ACTION_JSON_DOM_DIFF_CHARS);
  }
  const redacted = redactSensitiveArtifactValue(compact);
  return compactMode ? compactActionHandoffForJson(redacted) : redacted;
}
// Whether a fill/type value must stay out of receipts and logs. The key classifier splits each
// string on `_`, `-` and camelCase (#485), so `#api_token` and `[name=client_secret]` count.
// `sensitiveValue` is set when fill read the control itself: a password input, or a name, id,
// autocomplete or label that marks it secret. Only fill names a field: `type`'s first arg is the
// typed prose itself, not a field name.
export function isSensitiveActionTarget(action, target = {}) {
  if (action !== 'fill' && action !== 'type') return false;
  if (target.sensitiveValue === true) return true;
  if (action !== 'fill') return false;
  return [
    target.input,
    target.label,
    ...(Array.isArray(target.commandArgs) ? target.commandArgs.slice(0, 1) : []),
  ].some(text => text && isSensitiveFieldText(text));
}
// Every literal a sensitive action's output must not contain.
export function sensitiveActionValues(action, target = {}) {
  if (!target || !isSensitiveActionTarget(action, target)) return [];
  return [sensitiveActionSecret(action, target), ...(SENSITIVE_FILL_RAW_VALUES.get(target) || [])];
}
// `fill --secret NAME` (#469) records the name, never the value: its argv is already safe to keep.
export function commandArgsNameSecret(action, args) {
  return action === 'fill' && Array.isArray(args) && args.includes('--secret');
}
export function sensitiveActionSecret(action, target = {}) {
  if (!isSensitiveActionTarget(action, target)) return '';
  const args = Array.isArray(target.commandArgs) ? target.commandArgs : [];
  if (commandArgsNameSecret(action, args)) return '';
  if (action === 'type') return args[0] == null ? '' : String(args[0]);
  if (args[0] === '--react') return args[2] == null ? '' : String(args[2]);
  return args[1] == null ? '' : String(args[1]);
}
// `secret` is one literal or a list (a sensitive fill's typed and previous values).
export function replaceSecretLiteral(value, secret) {
  return scrubSecretValues(value, secret, { keepKeys: ACTION_JSON_IDENTIFIER_KEYS });
}
export function redactSensitiveDispatchText(text) {
  return String(text || '')
    .replace(/with "(?:\\.|[^"\\])*"/g, `with "${REDACTED_VALUE}"`)
    .replace(/with '(?:\\.|[^'\\])*'/g, `with '${REDACTED_VALUE}'`);
}
export function redactSensitiveCommandArgs(action, args = []) {
  if (action === 'type') return args.map((arg, index) => (index === 0 ? REDACTED_VALUE : arg));
  if (args[0] === '--react') return args.map((arg, index) => (index <= 1 ? arg : REDACTED_VALUE));
  return args.map((arg, index) => (index === 0 ? arg : REDACTED_VALUE));
}
export function sanitizeActionTargetForLog(action, target = null) {
  if (!target || typeof target !== 'object') return target;
  const sanitized = {
    ...target,
    commandArgs: Array.isArray(target.commandArgs) ? [...target.commandArgs] : target.commandArgs,
  };
  if (!isSensitiveActionTarget(action, sanitized)) return sanitized;
  // The original target: a fill's raw values are keyed by it, not by this copy.
  const secret = sensitiveActionValues(action, target);
  let next = replaceSecretLiteral(sanitized, secret);
  // `fill <sel> --secret NAME` (#469) carries the name, never the value: its argv stays
  // replayable and its dispatch text already shows <secret:NAME>.
  const namedSecret = commandArgsNameSecret(action, sanitized.commandArgs);
  if (namedSecret) next = { ...next, commandArgs: sanitized.commandArgs };
  const redacted = new Set(next.redacted || []);
  if (!namedSecret && Array.isArray(next.commandArgs) && next.commandArgs.length) {
    next = { ...next, commandArgs: redactSensitiveCommandArgs(action, next.commandArgs) };
    redacted.add('commandArgs');
  }
  if (!namedSecret && typeof next.dispatchText === 'string') {
    next = { ...next, dispatchText: redactSensitiveDispatchText(next.dispatchText) };
    redacted.add('dispatchText');
  }
  next.redacted = [...redacted];
  return next;
}
export function sessionLogPath(targetId, runtimeDir = RUNTIME_DIR) {
  const safeTarget = String(targetId || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_');
  return resolve(runtimeDir, `cdp-${safeTarget}.log`);
}
export function sessionScreenshotDir(targetId, runtimeDir = RUNTIME_DIR) {
  const safeTarget = String(targetId || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_');
  return resolve(runtimeDir, `cdp-${safeTarget}-screenshots`);
}
// Default folder for `click --expect-download` (#472); pruned with the tab's other runtime artifacts.
export function sessionDownloadDir(targetId, runtimeDir = RUNTIME_DIR) {
  const safeTarget = String(targetId || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_');
  return resolve(runtimeDir, `cdp-${safeTarget}-downloads`);
}
// Browser.* download calls go on the root (browser) session, and their events arrive there too.
export function clickDownloadBrowser(cdp, sessionId, targetId) {
  return {
    setDownloadBehavior: params => cdpDomains(cdp).Browser.setDownloadBehavior(params),
    cancelDownload: params => cdpDomains(cdp).Browser.cancelDownload(params),
    browserContextId: async () => {
      const { targetInfos = [] } = await cdpDomains(cdp).Target.getTargets();
      return targetInfos.find(info => info.targetId === targetId)?.browserContextId || null;
    },
    // Browser.downloadWillBegin reports every download in the browser; its frameId says which tab.
    frameIds: async () => {
      const { frameTree } = await cdpDomains(cdp).Page.getFrameTree({}, sessionId);
      const ids = [];
      const walk = node => {
        if (node?.frame?.id) ids.push(node.frame.id);
        for (const child of node?.childFrames || []) walk(child);
      };
      walk(frameTree);
      return [targetId, ...ids];
    },
    onEvent: (method, handler) => cdp.onEvent(method, handler),
  };
}
// Async with fs/promises by default, so a large prune (many screenshot folders, a virus
// scanner on Windows) runs on the libuv pool instead of blocking the daemon's event loop.
export async function runtimeArtifactSets(runtimeDir, { readdir = fsPromises.readdir, lstat = fsPromises.lstat } = {}) {
  const sets = new Map();
  let names;
  try {
    names = await readdir(runtimeDir);
  } catch {
    return sets;
  }
  for (const name of names) {
    const match = RUNTIME_ARTIFACT_PATTERN.exec(name);
    if (!match) continue;
    const path = resolve(runtimeDir, name);
    let stats;
    try {
      stats = await lstat(path);
    } catch {
      continue;
    }
    // A symlink or an entry of the wrong kind is not an artifact this runtime wrote.
    if (match[2].startsWith('-') ? !stats.isDirectory() : !stats.isFile()) continue;
    const set = sets.get(match[1]) || { targetId: match[1], paths: [], mtimeMs: 0 };
    set.paths.push(path);
    set.mtimeMs = Math.max(set.mtimeMs, stats.mtimeMs);
    sets.set(match[1], set);
  }
  return sets;
}
export async function pruneRuntimeArtifacts({
  runtimeDir = RUNTIME_DIR,
  protectedTargetIds = [],
  now = Date.now(),
  maxAgeMs = RUNTIME_ARTIFACT_MAX_AGE_MS,
  keepNewest = RUNTIME_ARTIFACT_KEEP_NEWEST_TARGETS,
  fs = {},
} = {}) {
  const { readdir = fsPromises.readdir, lstat = fsPromises.lstat, rm = fsPromises.rm } = fs;
  const kept = new Set([...protectedTargetIds].map(id => String(id).replace(/[^A-Za-z0-9_.-]/g, '_')));
  const sets = [...(await runtimeArtifactSets(runtimeDir, { readdir, lstat })).values()]
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  let removedTargets = 0;
  let failedPaths = 0;
  for (const [index, set] of sets.entries()) {
    if (index < keepNewest || kept.has(set.targetId) || now - set.mtimeMs <= maxAgeMs) continue;
    let removedAll = true;
    for (const path of set.paths) {
      // A file still open elsewhere (EPERM/EBUSY on Windows) is left for a later daemon start.
      try {
        await rm(path, { recursive: true, force: true });
      } catch {
        failedPaths += 1;
        removedAll = false;
      }
    }
    if (removedAll) removedTargets += 1;
  }
  return { removedTargets, failedPaths };
}
// Targets whose artifacts must survive a prune: a recorded daemon whose pid still runs, or a
// Unix socket file (an old daemon without a record, or one still starting).
export function liveRuntimeArtifactTargetIds({
  runtimeDir = RUNTIME_DIR,
  readdir = readdirSync,
  reader = readFileSync,
  isAlive = isProcessAlive,
} = {}) {
  const live = new Set();
  for (const record of listDaemonRecords({ runtimeDir, readdir, reader })) {
    if (isAlive(record.pid)) live.add(record.targetId);
  }
  try {
    for (const name of readdir(runtimeDir)) {
      if (name.startsWith('cdp-') && name.endsWith('.sock')) live.add(name.slice(4, -5));
    }
  } catch {}
  return live;
}
export async function pruneDaemonRuntimeArtifacts(session, targetId) {
  try {
    const protectedTargetIds = liveRuntimeArtifactTargetIds();
    protectedTargetIds.add(targetId);
    const result = await pruneRuntimeArtifacts({ protectedTargetIds });
    if (result.removedTargets || result.failedPaths) {
      appendSessionEventLog(session, { kind: 'runtime-artifacts-pruned', ts: Date.now(), ...result });
    }
    return result;
  } catch {
    return null;
  }
}
export function createRuntimePruneScheduler({
  run,
  fallbackMs = RUNTIME_PRUNE_FALLBACK_MS,
  defer = setImmediate,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (typeof run !== 'function') throw new Error('runtime prune runner must be a function');
  let armed = false;
  let started = false;
  let fallback = null;
  const start = () => {
    if (started) return;
    started = true;
    clearTimer(fallback);
    Promise.resolve().then(run).catch(() => {});
  };
  return Object.freeze({
    arm() {
      if (armed || started) return;
      armed = true;
      fallback = setTimer(start, fallbackMs);
      fallback?.unref?.();
    },
    requestSettled() {
      if (armed && !started) defer(start);
    },
  });
}
export function directoryArtifactStats(dir) {
  let sizeBytes = 0;
  let fileCount = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = resolve(dir, entry.name);
    const stats = lstatSync(fullPath);
    if (stats.isDirectory()) {
      const child = directoryArtifactStats(fullPath);
      sizeBytes += child.sizeBytes;
      fileCount += child.fileCount;
    } else {
      sizeBytes += stats.size;
      fileCount += 1;
    }
  }
  return { sizeBytes, fileCount };
}
export function artifactPathStats(path) {
  if (!path) {
    return {
      path: null,
      exists: false,
      kind: null,
      sizeBytes: null,
      fileCount: 0,
      error: null,
    };
  }
  try {
    const stats = lstatSync(path);
    if (stats.isDirectory()) {
      const dir = directoryArtifactStats(path);
      return {
        path,
        exists: true,
        kind: 'directory',
        sizeBytes: dir.sizeBytes,
        fileCount: dir.fileCount,
        error: null,
      };
    }
    return {
      path,
      exists: true,
      kind: stats.isSymbolicLink() ? 'symlink' : 'file',
      sizeBytes: stats.size,
      fileCount: 1,
      error: null,
    };
  } catch (e) {
    return {
      path,
      exists: false,
      kind: null,
      sizeBytes: null,
      fileCount: 0,
      error: e.message,
    };
  }
}
export function buildSessionArtifactsSummary(session = {}) {
  const screenshots = session.screenshots || [];
  const screenshotItems = screenshots.map(entry => artifactPathStats(entry.path));
  const screenshotTotalBytes = screenshotItems.reduce((sum, item) => sum + (Number.isFinite(item.sizeBytes) ? item.sizeBytes : 0), 0);
  const log = artifactPathStats(session.logPath || null);
  const screenshotDir = artifactPathStats(session.screenshotDir || null);
  return {
    paths: {
      log: session.logPath || null,
      screenshotDir: session.screenshotDir || null,
    },
    counts: {
      actions: session.actionLog?.length || 0,
      screenshots: screenshots.length,
      records: session.records?.length || 0,
    },
    sizes: {
      log,
      screenshotDir,
      screenshots: {
        count: screenshots.length,
        totalBytes: screenshotTotalBytes,
        missing: screenshotItems.filter(item => !item.exists).length,
      },
    },
  };
}
export function buildReportBudget(timelineWindow = {}) {
  const expensive = timelineWindow.limit == null;
  return {
    jsonBytesMax: DEFAULT_REPORT_JSON_BYTES_MAX,
    estimatedJsonBytes: null,
    defaultActionLimit: DEFAULT_REPORT_ACTION_LIMIT,
    actionLimit: timelineWindow.limit,
    allActionsOptIn: true,
    expensive,
    warning: expensive
      ? 'report --all includes the full action history and can be expensive for long sessions.'
      : 'Default report JSON is bounded; --all is opt-in and expensive for long sessions.',
  };
}
export function buildArtifactCleanupWorkflow(session = {}) {
  const targets = [session.logPath || null, session.screenshotDir || null].filter(Boolean);
  return {
    staleAfterHours: DEFAULT_STALE_ARTIFACT_HOURS,
    targets,
    workflow: [
      'Remove stale session artifacts after preserving any evidence needed for handoff or debugging.',
      'Delete the listed log file and screenshot directory when the browser session is no longer active.',
      'Use report --format json to re-check artifact paths, counts, and sizes before cleanup.',
    ],
  };
}
export function nextSessionScreenshotPath(session, kind = 'shot') {
  const safeKind = String(kind || 'shot').replace(/[^A-Za-z0-9_.-]/g, '_');
  const dir = session.screenshotDir || sessionScreenshotDir(session.targetId);
  const seq = String((session.screenshots?.length || 0) + 1).padStart(3, '0');
  return resolve(dir, `${safeKind}-${seq}.png`);
}
export function ensureSessionScreenshotDir(session) {
  if (!session.screenshotDir) return null;
  try {
    mkdirSync(session.screenshotDir, { recursive: true, mode: 0o700 });
    return session.screenshotDir;
  } catch (e) {
    if (!session.logErrors) session.logErrors = [];
    session.logErrors.push({ ts: Date.now(), message: `screenshot-dir: ${e.message}` });
    return null;
  }
}
// Values typed through `fill --secret NAME` (#469), kept for the daemon's lifetime as value -> name
// so later output and log lines of this session show <secret:NAME> instead (best effort, see
// scrubSecretText). A value shorter than MIN_SCRUB_SECRET_CHARS is not kept: scrubbing it would
// rewrite unrelated text, so only the fill's own receipt and records mask it.
export function rememberSessionSecret(session, name, value) {
  if (!session || typeof value !== 'string' || value.length < MIN_SCRUB_SECRET_CHARS) return;
  if (!(session.secretValues instanceof Map)) session.secretValues = new Map();
  session.secretValues.set(value, secretMarker(name));
}
export function scrubSessionSecrets(session, value) {
  return session?.secretValues?.size
    ? scrubSecretValues(value, session.secretValues, { ...SESSION_SECRET_SCRUB, keepKeys: ACTION_JSON_IDENTIFIER_KEYS })
    : value;
}
export function scrubDaemonResponse(session, response, cmd = '') {
  if (!response || typeof response !== 'object' || !session?.secretValues?.size) return response;
  if (UNSCRUBBED_DAEMON_COMMANDS.has(cmd)) return response;
  const scrubbed = { ...response };
  const opts = { ...SESSION_SECRET_SCRUB, keepKeys: ACTION_JSON_IDENTIFIER_KEYS };
  if (typeof scrubbed.result === 'string') scrubbed.result = scrubSecretText(scrubbed.result, session.secretValues, opts);
  if (typeof scrubbed.error === 'string') scrubbed.error = scrubSecretText(scrubbed.error, session.secretValues, opts);
  return scrubbed;
}
// Outermost entry of one daemon request: nested steps (batch, flow, replay) share its secrets,
// and the reply leaves through the session's secret scrub (#469).
export async function runDaemonRequestScope({ cmd, secrets = null, execution = null, session }, run) {
  const response = await daemonRequestStorage.run(
    execution || null,
    () => daemonSecretStorage.run({ secrets, session }, run),
  );
  return applyDaemonRestartNotice(session, cmd, scrubDaemonResponse(session, response, cmd));
}
// The daemon's fill capability. `fill(selector, text, opts)` is fillStr bound to the tab.
// --secret NAME (#469) types the request's secret value; receipts and records keep only the name.
export function createDaemonFillCapability({ session, actionFeedback, fill }) {
  return async args => {
    const parsed = parseFillArgs(args);
    const { secretName } = parsed;
    const text = secretName != null ? resolveRequestSecret(secretName) : parsed.text;
    const textArgs = secretName != null ? ['--secret', secretName] : [parsed.text];
    const feedbackPolicy = fillFeedbackPolicy(session.batchNextCommand);
    // fillStr records the before/after value here; actionFeedback turns it into receipt state.
    const fillValueState = {};
    const fillOpts = {
      ...(parsed.react ? { react: true } : {}),
      valueState: fillValueState,
      waitMs: parsed.waitMs,
      ...(secretName != null ? { secretName } : {}),
    };
    const commandArgs = parsed.react ? ['--react', parsed.selector, ...textArgs] : [parsed.selector, ...textArgs];
    const value = await actionFeedback('fill', () => fill(parsed.selector, text, fillOpts), { input: parsed.selector, resolvedBy: 'selector-or-ref', label: parsed.selector || '', commandArgs, fillValueState }, feedbackPolicy, null, parsed.fopts);
    if (feedbackPolicy === 'report-only') {
      session.awaitSearchSubmitListing = true;
      session.searchSubmitQuery = parsed.text ?? '';
    }
    return commandResult(value, { kind: 'action-receipt' });
  };
}
// The value of `--secret NAME` for the current daemon request. The CLI resolved it at call time
// and sent it beside, never inside, the args. Using it registers it for the session scrub.
export function resolveRequestSecret(name, { command = 'fill', store = daemonSecretStorage.getStore() } = {}) {
  const secrets = store?.secrets || null;
  if (!secrets || !Object.hasOwn(secrets, name)) {
    const error = new Error(`${command}: secret ${name} was not provided with this request; the CLI resolves --secret names from CDP_SECRET_<NAME> or CDP_SECRETS_FILE`);
    error.code = 'unknown_secret';
    throw error;
  }
  const value = secrets[name];
  if (value === '') throw new Error(`${command}: secret ${name} is empty`);
  rememberSessionSecret(store.session, name, value);
  return value;
}
export function rotateSessionLog(session, lineBytes, { rename, size, rotateBytes }) {
  if (!Number.isFinite(session.logBytes)) {
    try {
      session.logBytes = size(session.logPath);
    } catch {
      session.logBytes = 0;
    }
  }
  if (session.logBytes === 0 || session.logBytes + lineBytes <= rotateBytes) return;
  try { rename(session.logPath, `${session.logPath}.1`); } catch {}
  session.logBytes = 0;
}
export function appendSessionEventLog(session, event, {
  writer = appendFileSync,
  rename = renameSync,
  size = path => statSync(path).size,
  rotateBytes = SESSION_LOG_ROTATE_BYTES,
} = {}) {
  if (!session.logPath) return null;
  const payload = scrubSessionSecrets(session, {
    schema: 'chrome-cdp-ex.session-event.v1',
    targetId: session.targetId,
    sessionId: session.sessionId,
    ...event,
  });
  try {
    const line = `${JSON.stringify(payload)}\n`;
    const lineBytes = Buffer.byteLength(line);
    rotateSessionLog(session, lineBytes, { rename, size, rotateBytes });
    writer(session.logPath, line, { mode: 0o600 });
    session.logBytes += lineBytes;
    return payload;
  } catch (e) {
    if (!session.logErrors) session.logErrors = [];
    session.logErrors.push({ ts: Date.now(), message: e.message });
    return null;
  }
}
export function appendSessionEnvironmentLog(session, event, { ts = Date.now() } = {}) {
  if (!session.environmentLog) session.environmentLog = [];
  const entry = { ...event, ts: event.ts ?? ts };
  session.environmentLog.push(entry);
  if (session.environmentLog.length > MAX_ENVIRONMENT_LOG_ENTRIES) {
    session.environmentLog.splice(0, session.environmentLog.length - MAX_ENVIRONMENT_LOG_ENTRIES);
  }
  appendSessionEventLog(session, entry);
  rememberTabObservation(session);
  return entry;
}
export function initializeSessionLog(session, {
  ts = session.createdAt || Date.now(),
  writer = appendFileSync,
  rename = renameSync,
  size = path => statSync(path).size,
  rotateBytes = SESSION_LOG_ROTATE_BYTES,
} = {}) {
  if (!session.logPath) return null;
  restoreTabObservation(session);
  let existing = 0;
  try { existing = size(session.logPath); } catch { existing = 0; }
  // A new process for a tab that already has a log is a restart: its ref map is empty
  // because the previous daemon exited, not because this tab was never perceived (#549).
  if (existing > 0 && session.refs?.invalidationReason === 'daemon-start') {
    session.refs.invalidationReason = 'daemon-restart';
  }
  session.logBytes = existing;
  return appendSessionEventLog(session, {
    kind: 'session-start',
    ts,
    restarted: existing > 0,
  }, { writer, rename, size, rotateBytes });
}
export function appendSessionExitLog(session, {
  reason,
  signal = null,
  exceptionKind = null,
  message = null,
  exitCode = 0,
  ts = Date.now(),
} = {}) {
  const event = { kind: 'session-end', ts, reason, exitCode };
  if (signal) event.signal = signal;
  if (exceptionKind) event.exceptionKind = exceptionKind;
  if (message) event.message = redactSensitiveString(String(message).slice(0, 300));
  return appendSessionEventLog(session, event);
}
// Exit lines belong to the daemon that owns the tab log. A loser that exits because another
// daemon already serves the socket must not append session-end into that log (#549).
export function createDaemonExitLog(session) {
  let owned = false;
  return {
    markOwned() { owned = true; },
    onCrash(kind, error) {
      if (!owned) return null;
      return appendSessionExitLog(session, {
        reason: 'exception',
        exceptionKind: kind,
        message: error?.message || String(error || 'unknown error'),
        exitCode: 1,
      });
    },
    beforeExit(info) {
      if (!owned) return null;
      return appendSessionExitLog(session, info);
    },
  };
}
export function nextSessionActionSequence(session) {
  const current = Number.isInteger(session.actionSeq) ? session.actionSeq : (session.actionLog?.length || 0);
  session.actionSeq = current + 1;
  return session.actionSeq;
}
export function currentSessionActionSequence(session) {
  return Number.isInteger(session.actionSeq) ? session.actionSeq : (session.actionLog?.length || 0);
}
// #466: an action that took the tab to a disallowed origin failed after its receipt was logged.
// Its log entries say so, so `report` does not recommend continuing on that page, and the evidence
// sample (content from that page) is dropped.
export function markSessionActionsPolicyFailed(session, sinceSequence, message) {
  if (!Number.isInteger(sinceSequence)) return 0;
  const nextCommand = `cdp back ${targetPrefixForDisplay(session.targetId)}`;
  const reason = 'The action navigated the tab to an origin CDP_ALLOWED_ORIGINS does not allow; the navigation already happened.';
  let marked = 0;
  for (const entry of session.actionLog || []) {
    if (!(Number(entry?.sequence) > sinceSequence)) continue;
    entry.failure = { kind: 'policy', reason, message };
    if (entry.receipt && typeof entry.receipt === 'object') {
      const isPageSample = line => /^(DOM|Effect) sample:/i.test(String(line || ''));
      entry.receipt = {
        ...entry.receipt,
        outcome: 'failed',
        observedDelta: Array.isArray(entry.receipt.observedDelta)
          ? entry.receipt.observedDelta.filter(line => !isPageSample(line))
          : entry.receipt.observedDelta,
        observedDeltaDetails: Array.isArray(entry.receipt.observedDeltaDetails)
          ? entry.receipt.observedDeltaDetails.map(detail => (detail?.type === 'dom' ? { type: 'dom', status: detail.status } : detail))
          : entry.receipt.observedDeltaDetails,
      };
    }
    entry.diagnosis = {
      schema: 'chrome-cdp-ex.action-diagnosis.v1',
      status: 'blocked',
      kind: 'policy',
      confidence: 'high',
      source: 'policy',
      reason,
      nextCommand,
      recovery: buildActionRecoveryPlan({ kind: 'policy', status: 'blocked', nextCommand }, { targetId: targetPrefixForDisplay(session.targetId) }),
      signals: {},
    };
    entry.outcome = { ...(entry.outcome || {}), status: 'failed', reason };
    entry.verdict = {
      ...(entry.verdict || {}),
      status: 'blocked',
      source: 'diagnosis',
      canContinue: false,
      needsRecovery: true,
      primaryNextStep: nextCommand,
      nextSteps: [nextCommand],
      reason,
    };
    entry.effectSample = null;
    entry.nextHint = nextCommand;
    marked += 1;
    appendSessionEventLog(session, { kind: 'action-policy-failure', ts: Date.now(), sequence: entry.sequence, eventId: entry.eventId || null, message });
  }
  if (marked) rememberTabObservation(session);
  return marked;
}
export function sessionActionEventId(session, sequence) {
  const target = targetPrefixForDisplay(session.targetId || 'target');
  return `act_${target}_${String(sequence).padStart(6, '0')}`;
}
export function applyActionReceiptEvent(actionResult, { eventId, sequence, ts } = {}) {
  actionResult.receipt = {
    ...buildActionReceipt(actionResult),
    eventId,
    sequence,
    loggedAt: Number.isFinite(ts) ? new Date(ts).toISOString() : null,
  };
  return actionResult.receipt;
}
export function appendSessionActionLog(session, actionResult, { ts = Date.now() } = {}) {
  if (!session.actionLog) session.actionLog = [];
  const sequence = nextSessionActionSequence(session);
  const eventId = sessionActionEventId(session, sequence);
  const receipt = applyActionReceiptEvent(actionResult, { eventId, sequence, ts });
  const domDiff = actionResult.effects?.domDiff || '';
  const { summary, sample } = summarizeActionDomDiff(domDiff);
  const diagnostics = summarizeActionObservationEffects(actionResult.effects || {});
  const secret = sensitiveActionValues(actionResult.action, actionResult.target || {});
  const target = sanitizeActionTargetForLog(actionResult.action, actionResult.target || null);
  const entry = scrubSessionSecrets(session, replaceSecretLiteral(redactSensitiveArtifactValue({
    sequence,
    eventId,
    ts,
    action: actionResult.action,
    target,
    dispatch: actionResult.dispatch || null,
    settle: actionResult.settle || null,
    effectSummary: summary,
    effectSample: sample,
    consoleSummary: diagnostics.consoleSummary,
    consoleSample: diagnostics.consoleSample,
    exceptionSummary: diagnostics.exceptionSummary,
    exceptionSample: diagnostics.exceptionSample,
    networkSummary: diagnostics.networkSummary,
    networkSample: diagnostics.networkSample,
    ...actionDialogFields(actionResult.effects),
    failure: actionResult.effects?.failure || null,
    diagnosis: actionResult.effects?.diagnosis || null,
    outcome: actionResult.outcome || buildActionOutcome(actionResult),
    verdict: actionResult.verdict || buildActionVerdict(actionResult),
    receipt,
    nextHint: actionResult.nextHint || null,
  }), secret));
  session.actionLog.push(entry);
  if (session.actionLog.length > MAX_ACTION_LOG_ENTRIES) {
    session.actionLog.splice(0, session.actionLog.length - MAX_ACTION_LOG_ENTRIES);
  }
  appendSessionEventLog(session, { kind: 'action', ts, action: entry });
  rememberTabObservation(session);
  return entry;
}
export function appendSessionScreenshot(session, { kind = 'shot', path = null, note = '', ts = Date.now() } = {}) {
  if (!session.screenshots) session.screenshots = [];
  const entry = {
    ts,
    kind,
    path: path || nextSessionScreenshotPath(session, kind),
    note,
  };
  session.screenshots.push(entry);
  if (session.screenshots.length > MAX_SCREENSHOT_ENTRIES) {
    session.screenshots.splice(0, session.screenshots.length - MAX_SCREENSHOT_ENTRIES);
  }
  appendSessionEventLog(session, { kind: 'screenshot', ts, screenshot: entry });
  return entry;
}
export function reportActionStatus(entry = {}) {
  if (entry.failure?.kind === 'policy') return 'failed';
  return entry.dispatch?.ok === false ? 'failed' : (entry.settle?.ok ? 'ok' : 'not-confirmed');
}
export function buildLatestReportActionSummary(actionLog = []) {
  if (!actionLog.length) return null;
  const index = actionLog.length;
  const entry = actionLog[index - 1] || {};
  return {
    index,
    sequence: entry.sequence ?? index,
    eventId: entry.eventId || entry.receipt?.eventId || null,
    ts: entry.ts || null,
    action: entry.action || null,
    status: reportActionStatus(entry),
    outcomeStatus: entry.outcome?.status || null,
    verdictStatus: entry.verdict?.status || null,
    canContinue: entry.verdict?.canContinue ?? null,
    needsRecovery: entry.verdict?.needsRecovery ?? null,
    effectSummary: entry.effectSummary || null,
    effectSample: entry.effectSample || null,
    consoleSummary: entry.consoleSummary || null,
    networkSummary: entry.networkSummary || null,
    diagnosisKind: entry.diagnosis?.kind || null,
    nextHint: entry.nextHint || null,
  };
}
export function compactReportActionTarget(target = null) {
  if (!target || typeof target !== 'object') return target;
  const compact = {};
  for (const field of ['input', 'label', 'resolvedBy', 'frameRef']) {
    if (target[field] !== undefined && target[field] !== null && target[field] !== '') compact[field] = target[field];
  }
  return compact;
}
export function compactReportActionEvidence(entry = {}) {
  return {
    dispatchMethod: entry.dispatch?.method || null,
    settleOk: entry.settle?.ok ?? null,
    settleDurationMs: entry.settle?.durationMs ?? null,
    effectSummary: entry.effectSummary || null,
    effectSample: entry.effectSample || null,
    consoleSummary: entry.consoleSummary || null,
    exceptionSummary: entry.exceptionSummary || null,
    networkSummary: entry.networkSummary || null,
    ...actionDialogFields(entry),
    failure: entry.failure?.kind || entry.failure || null,
    diagnosis: entry.diagnosis?.kind || entry.diagnosis || null,
  };
}
export function reportActionModel(entry = {}, index = 1, { compact = false } = {}) {
  if (compact) {
    return {
      index,
      sequence: entry.sequence ?? index,
      eventId: entry.eventId || entry.receipt?.eventId || null,
      ts: entry.ts || null,
      action: entry.action,
      status: reportActionStatus(entry),
      target: compactReportActionTarget(entry.target || null),
      evidence: compactReportActionEvidence(entry),
      receipt: receiptForReport(entry.receipt),
      nextHint: entry.nextHint || null,
    };
  }
  return {
    index,
    sequence: entry.sequence ?? index,
    eventId: entry.eventId || entry.receipt?.eventId || null,
    ts: entry.ts || null,
    action: entry.action,
    status: reportActionStatus(entry),
    outcome: entry.outcome || null,
    verdict: entry.verdict || null,
    target: entry.target || null,
    dispatch: entry.dispatch || null,
    settle: entry.settle || null,
    receipt: receiptForReport(entry.receipt),
    evidence: {
      dispatchMethod: entry.dispatch?.method || null,
      settleOk: entry.settle?.ok ?? null,
      settleDurationMs: entry.settle?.durationMs ?? null,
      effectSummary: entry.effectSummary || null,
      effectSample: entry.effectSample || null,
      consoleSummary: entry.consoleSummary || null,
      consoleSample: entry.consoleSample || null,
      exceptionSummary: entry.exceptionSummary || null,
      exceptionSample: entry.exceptionSample || null,
      networkSummary: entry.networkSummary || null,
      networkSample: entry.networkSample || null,
      ...actionDialogFields(entry),
      failure: entry.failure || null,
      diagnosis: entry.diagnosis || null,
    },
    nextHint: entry.nextHint || null,
  };
}
export function compactReportBudgetModel(reportBudget = {}) {
  return {
    jsonBytesMax: reportBudget.jsonBytesMax ?? DEFAULT_REPORT_JSON_BYTES_MAX,
    estimatedJsonBytes: null,
    actionLimit: reportBudget.actionLimit ?? null,
  };
}
export function compactReportArtifactsSummary(artifacts = {}) {
  return {
    paths: artifacts.paths || {},
    counts: artifacts.counts || {},
  };
}
export function compactReportEnvironmentModel(environment = {}) {
  return {
    networkThrottleSummary: environment.networkThrottleSummary || 'none',
    networkMocksSummary: environment.networkMocksSummary || 'none',
    clockSummary: environment.clockSummary || 'real time',
  };
}
export function reportScreenshotModel(entry = {}, index = 0, { compact = false } = {}) {
  if (compact) {
    return {
      index: index + 1,
      path: entry.path || null,
      kind: entry.kind || 'shot',
    };
  }
  return {
    index: index + 1,
    ts: entry.ts || null,
    kind: entry.kind || 'shot',
    path: entry.path || null,
    note: entry.note || '',
  };
}
export function parseReportArgs(args = []) {
  let lastActions = DEFAULT_REPORT_ACTION_LIMIT;
  let compact = false;
  let qa = false;
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--all') {
      lastActions = null;
    } else if (arg === '--compact') {
      compact = true;
    } else if (arg === '--qa' || arg === '--summary') {
      qa = true;
      compact = true;
    } else if (arg === '--last') {
      const raw = args[++i];
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) throw new Error('report: --last requires a positive integer');
      lastActions = n;
    } else {
      rest.push(arg);
    }
  }
  return { lastActions, compact, qa, args: rest };
}
export function reportActionTimelineWindow(actionLog = [], lastActions = DEFAULT_REPORT_ACTION_LIMIT) {
  const total = actionLog.length;
  const limit = lastActions == null ? null : Math.max(1, Math.floor(Number(lastActions) || DEFAULT_REPORT_ACTION_LIMIT));
  const startOffset = limit == null || total <= limit ? 0 : total - limit;
  const entries = actionLog.slice(startOffset);
  return {
    entries,
    total,
    shown: entries.length,
    omitted: startOffset,
    startIndex: entries.length ? startOffset + 1 : null,
    endIndex: entries.length ? total : null,
    limit,
    mode: limit == null ? 'all' : 'latest',
    expensive: limit == null,
  };
}
export function buildSessionReportModel(session, { now = Date.now(), lastActions = DEFAULT_REPORT_ACTION_LIMIT, compact = false, page = null } = {}) {
  const actionLog = session.actionLog || [];
  const screenshots = session.screenshots || [];
  const timelineWindow = reportActionTimelineWindow(actionLog, lastActions);
  const uptimeMs = Math.max(0, now - (session.createdAt || now));
  const target = targetPrefixForDisplay(session.targetId);
  const artifacts = buildSessionArtifactsSummary(session);
  const reportBudget = buildReportBudget(timelineWindow);
  const cleanup = buildArtifactCleanupWorkflow(session);
  const actions = timelineWindow.entries.map((entry, offset) => {
    const index = (timelineWindow.startIndex || 1) + offset;
    return reportActionModel(entry, index, { compact });
  });
  const pdfViewer = isPdfViewerContentType(page?.contentType);
  const recommendation = pdfViewer
    ? pdfViewerReportRecommendation(target)
    : buildReportRecommendation(actionLog, target, session.targetId);
  const nextSteps = pdfViewer
    ? [pdfViewerNextCommand(target)]
    : uniqueNextStepCommands([
      ...(recommendation.commands || []),
      ...(actionLog.length > 0 ? [
        `cdp record-actions ${target} --format json`,
        `cdp export-playwright ${target}`,
      ] : []),
    ]);
  const environment = {
    networkThrottleSummary: formatThrottleSummary(session.networkThrottle),
    networkMocksSummary: formatNetworkMocksSummary(session),
    clockSummary: formatClockSummary(session.clock),
    controls: buildRecordEnvironmentModel(session),
  };
  const model = {
    schema: 'chrome-cdp-ex.report.v1',
    ...(compact ? { mode: 'compact' } : {}),
    targetId: session.targetId,
    targetPrefix: target,
    sessionId: session.sessionId,
    createdAt: session.createdAt || null,
    now,
    uptimeMs,
    paths: {
      log: session.logPath || null,
      screenshotDir: session.screenshotDir || null,
    },
    counts: {
      actions: actionLog.length,
      screenshots: screenshots.length,
      records: session.records?.length || 0,
    },
    artifacts: compact ? compactReportArtifactsSummary(artifacts) : artifacts,
    reportBudget: compact ? compactReportBudgetModel(reportBudget) : reportBudget,
    ...(!compact ? { cleanup } : {}),
    timelineWindow: {
      total: timelineWindow.total,
      shown: timelineWindow.shown,
      omitted: timelineWindow.omitted,
      startIndex: timelineWindow.startIndex,
      endIndex: timelineWindow.endIndex,
      limit: timelineWindow.limit,
      mode: timelineWindow.mode,
      expensive: timelineWindow.expensive,
    },
    latestAction: buildLatestReportActionSummary(actionLog),
    environment: compact ? compactReportEnvironmentModel(environment) : environment,
    actions,
    screenshots: screenshots.map((entry, index) => reportScreenshotModel(entry, index, { compact })),
    recommendation,
    nextSteps: nextSteps.length ? nextSteps : defaultReportNextSteps(target, actionLog.length > 0),
  };
  if (pdfViewer) model.pdfViewer = pdfViewerHandoffModel(page, { targetPrefix: target });
  model.reportBudget.estimatedJsonBytes = Buffer.byteLength(formatJson(model), 'utf8');
  return model;
}
export function formatSessionReport(session, { now = Date.now(), format = 'text', lastActions = DEFAULT_REPORT_ACTION_LIMIT, compact = false, qa = false, page: livePage = null } = {}) {
  // Action entries are redacted when logged; the live page URL is not (#455).
  const page = livePage?.url ? { ...livePage, url: redactUrl(livePage.url) } : livePage;
  const jsonDefaultCompact = format === 'json' && lastActions != null;
  const effectiveCompact = compact || jsonDefaultCompact;
  const targetPrefix = targetPrefixForDisplay(session.targetId);
  if (isPdfViewerContentType(page?.contentType) && qa) {
    return format === 'json'
      ? formatJson(pdfViewerHandoffModel(page, { targetPrefix }))
      : formatPdfViewerOutput(page, { targetPrefix });
  }
  if (qa) {
    const model = buildSessionReportModel(session, { now, lastActions, compact: true, page });
    const latest = model.latestAction || null;
    const summary = buildQaSummaryModel({
      page: { url: page?.url || latest?.url || '', title: page?.title || '' },
      console: {
        errors: Number(latest?.consoleErrors || latest?.effects?.consoleDelta?.errors || 0),
        exceptions: Number(latest?.exceptions || latest?.effects?.exceptionDelta?.count || 0),
      },
      network: {
        failures: Number(latest?.networkFailures || latest?.effects?.networkDelta?.failures || 0),
      },
      action: latest ? {
        outcome: latest.outcome || latest.receipt?.outcome || null,
        dispatch: { ok: latest.dispatchOk !== false },
        changed: latest.outcome ? latest.outcome !== 'no-change' : undefined,
      } : null,
      targetPrefix: model.targetPrefix,
      nextCommand: model.nextSteps?.[0] || null,
      source: 'report',
    });
    if (format === 'json') {
      return formatJson({
        ...summary,
        report: {
          schema: model.schema,
          targetPrefix: model.targetPrefix,
          counts: model.counts,
          latestAction: model.latestAction,
          nextSteps: model.nextSteps,
        },
      });
    }
    return formatQaSummaryText(summary);
  }
  if (format === 'json') return formatJson(buildSessionReportModel(session, { now, lastActions, compact: effectiveCompact, page }));
  const model = buildSessionReportModel(session, { now, lastActions, compact: effectiveCompact, page });
  const actionLog = session.actionLog || [];
  const timelineWindow = reportActionTimelineWindow(actionLog, lastActions);
  const screenshots = session.screenshots || [];
  const uptimeMs = Math.max(0, now - (session.createdAt || now));
  const actionCountLine = timelineWindow.omitted > 0
    ? `Actions: ${actionLog.length} (showing last ${timelineWindow.shown}, ${timelineWindow.omitted} omitted)`
    : `Actions: ${actionLog.length}`;
  const lines = [
    `Session report: ${session.targetId}`,
    `CDP session: ${session.sessionId}`,
    `Uptime: ${formatDuration(uptimeMs)}`,
    `Log: ${session.logPath || '(disabled)'}`,
    `Screenshot dir: ${session.screenshotDir || '(disabled)'}`,
    actionCountLine,
    `Screenshots: ${screenshots.length}`,
    `Records: ${session.records?.length || 0}`,
  ];
  if (model.reportBudget?.warning != null && model.reportBudget.estimatedJsonBytes != null) {
    lines.push(`Report JSON budget: ${formatBytes(model.reportBudget.estimatedJsonBytes)} / ${formatBytes(model.reportBudget.jsonBytesMax)}; ${model.reportBudget.warning}`);
  }
  if (model.artifacts?.sizes?.log && model.artifacts?.sizes?.screenshotDir) {
    lines.push(`Artifact bytes: log ${formatBytes(model.artifacts.sizes.log.sizeBytes)}, screenshots ${formatBytes(model.artifacts.sizes.screenshotDir.sizeBytes)} (${model.artifacts.sizes.screenshotDir.fileCount} files)`);
  }
  if (model.cleanup?.workflow?.[0]) {
    lines.push(`Cleanup: ${model.cleanup.workflow[0]}`);
  }
  lines.push(
    `Network throttle: ${formatThrottleSummary(session.networkThrottle)}`,
    `Network mocks: ${formatNetworkMocksSummary(session)}`,
    `Clock: ${formatClockSummary(session.clock)}`,
    '',
    'Action timeline:',
  );
  if (actionLog.length === 0) {
    lines.push('No actions recorded yet. Run click/fill/press/nav/inject/reload, then report again.');
  } else {
    if (timelineWindow.omitted > 0) {
      lines.push(`Showing actions ${timelineWindow.startIndex}-${timelineWindow.endIndex}. Use report --all or inspect the JSONL log for the full action history.`);
    }
    for (const [offset, entry] of timelineWindow.entries.entries()) {
      const i = (timelineWindow.startIndex || 1) + offset;
      const label = entry.target?.label || entry.target?.input || '';
      const settleStatus = reportActionStatus(entry).replace('not-confirmed', 'not confirmed');
      const settleDuration = Number.isFinite(entry.settle?.durationMs) ? ` in ${entry.settle.durationMs}ms` : '';
      const sourceTarget = actionTargetCommandId(entry.target || {}) || session.targetId;
      lines.push(`${i}. ${entry.action}${label ? ` ${label}` : ''} — ${settleStatus}${settleDuration}`);
      if (entry.dispatch?.method) lines.push(`   Dispatch: ${entry.dispatch.method}`);
      if (entry.outcome?.status) lines.push(`   Outcome: ${entry.outcome.status}${entry.outcome.reason ? ` — ${entry.outcome.reason}` : ''}`);
      if (entry.verdict?.status) lines.push(`   Verdict: ${entry.verdict.status}${entry.verdict.reason ? ` — ${entry.verdict.reason}` : ''}`);
      if (effectiveCompact) {
        for (const line of actionDialogLines(entry)) lines.push(`   ${line}`);
        if (entry.nextHint) lines.push(`   Next: ${normalizeReportTargetCommand(entry.nextHint, sourceTarget, model.targetPrefix)}`);
        continue;
      }
      if (entry.failure?.kind) lines.push(`   Failure: ${entry.failure.kind} — ${entry.failure.reason}`);
      if (entry.diagnosis?.kind && entry.diagnosis.status !== 'ok') {
        lines.push(`   Diagnosis: ${entry.diagnosis.kind} — ${entry.diagnosis.reason}`);
      }
      if (entry.diagnosis?.recovery?.strategy && entry.diagnosis.status !== 'ok') {
        lines.push(`   Recovery: ${entry.diagnosis.recovery.strategy}`);
      }
      if (entry.effectSummary) lines.push(`   Effect: ${entry.effectSummary}`);
      if (entry.effectSample) lines.push(`   Sample: ${entry.effectSample}`);
      if (entry.consoleSummary) lines.push(`   ${entry.consoleSummary}`);
      if (entry.consoleSample) lines.push(`   Console sample: ${entry.consoleSample}`);
      if (entry.exceptionSummary) lines.push(`   ${entry.exceptionSummary}`);
      if (entry.exceptionSample) lines.push(`   Exception sample: ${entry.exceptionSample}`);
      if (entry.networkSummary) lines.push(`   ${entry.networkSummary}`);
      if (entry.networkSample) lines.push(`   Network sample: ${entry.networkSample}`);
      for (const line of actionDialogLines(entry)) lines.push(`   ${line}`);
      if (entry.diagnosis?.nextCommand && entry.diagnosis.status !== 'ok') {
        lines.push(`   Diagnostic next: ${normalizeReportTargetCommand(entry.diagnosis.nextCommand, sourceTarget, model.targetPrefix)}`);
      }
      if (entry.nextHint) lines.push(`   Next: ${normalizeReportTargetCommand(entry.nextHint, sourceTarget, model.targetPrefix)}`);
    }
  }
  if (screenshots.length > 0) {
    lines.push('', 'Attachments:');
    for (const [i, entry] of screenshots.entries()) {
      const note = entry.note ? ` (${entry.note})` : '';
      lines.push(`${i + 1}. ${entry.kind || 'shot'} — ${entry.path}${note}`);
    }
  }
  lines.push('', ...formatReportRecommendationLines(model.recommendation));
  lines.push('', ...formatReportNextStepLines(model.nextSteps));
  if (isPdfViewerContentType(page?.contentType)) {
    return [formatPdfViewerOutput(page, { targetPrefix: model.targetPrefix }), '', ...lines].join('\n');
  }
  return lines.join('\n');
}
export function commandArgsFromTarget(entry, fallbackArgs = []) {
  const args = entry.target && Array.isArray(entry.target.commandArgs)
    ? entry.target.commandArgs
    : fallbackArgs;
  return args.filter(v => v !== undefined && v !== null).map(v => String(v));
}
export function normalizeRecordCommandName(value = '') {
  const name = String(value || '').toLowerCase();
  if (name === 'diffshot') return 'diff-shot';
  if (name === 'dismissmodal') return 'dismiss-modal';
  return name;
}
export function forcedRecordCommandNeedsInput(commandName, args = []) {
  const name = normalizeRecordCommandName(commandName);
  if (name === 'diff-shot') return ['live-visual-baseline'];
  if (name === 'upload') {
    if (args.includes('<redacted>') || args.length < 2) return ['file'];
  }
  return null;
}
export function inferRecordActionCommand(entry) {
  const targetInput = entry.target?.input || '';
  const commandName = entry.target?.commandName || entry.action;
  const explicitArgs = entry.target && Array.isArray(entry.target.commandArgs);
  if (explicitArgs) {
    const args = commandArgsFromTarget(entry);
    const needsInput = forcedRecordCommandNeedsInput(commandName, args)
      || (args.includes('<redacted>') ? redactedCommandNeedsInput(commandName) : []);
    return { command: [commandName, ...args], replayable: needsInput.length === 0, needsInput };
  }

  switch (entry.action) {
    case 'click':
    case 'jsclick':
      return targetInput
        ? { command: [entry.action, targetInput], replayable: true, needsInput: [] }
        : { command: [entry.action, '<selector|@ref>'], replayable: false, needsInput: ['target'] };
    case 'clickxy': {
      const parts = targetInput.split(',').map(s => s.trim()).filter(Boolean);
      return parts.length >= 2
        ? { command: ['clickxy', parts[0], parts[1]], replayable: true, needsInput: [] }
        : { command: ['clickxy', '<x>', '<y>'], replayable: false, needsInput: ['coordinates'] };
    }
    case 'press':
    case 'scroll':
    case 'nav':
    case 'viewport':
      return targetInput
        ? { command: [entry.action, ...targetInput.split(/\s+/).filter(Boolean)], replayable: true, needsInput: [] }
        : { command: [entry.action, '<input>'], replayable: false, needsInput: ['input'] };
    case 'back':
    case 'forward':
    case 'reload':
    case 'dismiss-modal':
      return { command: [entry.action], replayable: true, needsInput: [] };
    case 'fill':
      return {
        command: ['fill', targetInput || '<selector|@ref>', '<text>'],
        replayable: false,
        needsInput: targetInput ? ['text'] : ['target', 'text'],
      };
    case 'select':
      return {
        command: ['select', targetInput || '<selector|@ref>', '<value>'],
        replayable: false,
        needsInput: targetInput ? ['value'] : ['target', 'value'],
      };
    case 'type':
      return { command: ['type', '<text>'], replayable: false, needsInput: ['text'] };
    case 'inject':
      return { command: ['inject', targetInput || '<type>', '<content>'], replayable: false, needsInput: ['content'] };
    case 'upload':
      return {
        command: ['upload', targetInput || '<selector|@ref>', '<file>'],
        replayable: false,
        needsInput: targetInput ? ['file'] : ['target', 'file'],
      };
    case 'diff-shot':
    case 'diffshot':
      return {
        command: ['diff-shot', targetInput || '<selector>'],
        replayable: false,
        needsInput: ['live-visual-baseline'],
      };
    default:
      return {
        command: targetInput ? [entry.action, targetInput] : [entry.action],
        replayable: false,
        needsInput: ['review'],
      };
  }
}
export function redactedCommandNeedsInput(action) {
  if (action === 'fill' || action === 'type') return ['text'];
  if (action === 'select') return ['value'];
  if (action === 'inject') return ['content'];
  if (action === 'upload') return ['file'];
  return ['input'];
}
export function mockEnvironmentCommand(entry = {}) {
  if (entry.action === 'clear') return ['mock', 'clear'];
  const rule = entry.rule || {};
  const command = ['mock', 'add', String(rule.urlPattern || '<urlPattern>'), '--status', String(rule.status ?? 200)];
  if (rule.body != null && rule.body !== '') command.push('--body', String(rule.body));
  if (rule.contentType) command.push('--content-type', String(rule.contentType));
  if (rule.method) command.push('--method', String(rule.method));
  return command;
}
export function throttleEnvironmentCommand(entry = {}) {
  const throttle = entry.throttle || {};
  const profile = throttle.profile || 'off';
  if (profile === 'custom') {
    return [
      'throttle', 'custom',
      '--latency', String(throttle.latencyMs || 0),
      '--download', String(throttle.downloadKbps ?? 0),
      '--upload', String(throttle.uploadKbps ?? 0),
    ];
  }
  return ['throttle', profile];
}
export function clockEnvironmentCommand(entry = {}) {
  if (entry.action === 'reset' || !entry.clock) return ['clock', 'reset'];
  const clock = entry.clock || {};
  if (clock.profile === 'freeze') return ['clock', 'freeze', '--at', new Date(clock.atMs).toISOString()];
  if (clock.profile === 'offset') return ['clock', 'offset', '--ms', String(clock.offsetMs || 0)];
  return ['clock', 'reset'];
}
export function environmentCommandFromLogEntry(entry = {}) {
  switch (entry.kind || entry.type) {
    case 'mock':
      return mockEnvironmentCommand(entry);
    case 'throttle':
      return throttleEnvironmentCommand(entry);
    case 'clock':
      return clockEnvironmentCommand(entry);
    default:
      return [];
  }
}
export function sanitizeEnvironmentDetails(entry = {}) {
  if ((entry.kind || entry.type) === 'mock' && entry.rule) {
    return {
      rule: {
        urlPattern: entry.rule.urlPattern,
        method: entry.rule.method || null,
        status: entry.rule.status,
        contentType: entry.rule.contentType,
        body: entry.rule.body || '',
      },
    };
  }
  if ((entry.kind || entry.type) === 'throttle' && entry.throttle) {
    return {
      throttle: {
        profile: entry.throttle.profile || 'off',
        offline: entry.throttle.offline === true,
        latencyMs: entry.throttle.latencyMs || 0,
        downloadKbps: entry.throttle.downloadKbps,
        uploadKbps: entry.throttle.uploadKbps,
      },
    };
  }
  if ((entry.kind || entry.type) === 'clock' && entry.clock) {
    return {
      clock: {
        profile: entry.clock.profile || 'real',
        atMs: entry.clock.atMs ?? null,
        offsetMs: entry.clock.offsetMs || 0,
      },
    };
  }
  return {};
}
export function buildRecordEnvironmentModel(session) {
  return (session.environmentLog || []).map((entry, index) => {
    const command = environmentCommandFromLogEntry(entry);
    const type = entry.type || entry.kind || 'environment';
    return {
      index: index + 1,
      ts: entry.ts || null,
      type,
      action: entry.action || (type === 'throttle' ? 'apply' : 'set'),
      command,
      replayable: command.length > 0,
      needsInput: command.length > 0 ? [] : ['review'],
      ...sanitizeEnvironmentDetails(entry),
    };
  });
}
export function buildRecordActionsModel(session) {
  const actions = (session.actionLog || []).map((entry, index) => {
    const inferred = inferRecordActionCommand(entry);
    const dispatchFailed = entry.dispatch?.ok === false;
    const needsInput = dispatchFailed
      ? [...new Set([...inferred.needsInput, 'successful-dispatch'])]
      : inferred.needsInput;
    const secret = sensitiveActionSecret(entry.action, entry.target || {});
    return replaceSecretLiteral({
      index: index + 1,
      ts: entry.ts,
      action: entry.action,
      target: sanitizeActionTargetForLog(entry.action, entry.target || null),
      command: inferred.command,
      replayable: dispatchFailed ? false : inferred.replayable,
      needsInput,
      evidence: {
        dispatchMethod: entry.dispatch?.method || null,
        settleOk: entry.settle?.ok ?? null,
        settleDurationMs: entry.settle?.durationMs ?? null,
        effectSummary: entry.effectSummary || null,
        effectSample: entry.effectSample || null,
        consoleSummary: entry.consoleSummary || null,
        consoleSample: entry.consoleSample || null,
        exceptionSummary: entry.exceptionSummary || null,
        exceptionSample: entry.exceptionSample || null,
        networkSummary: entry.networkSummary || null,
        networkSample: entry.networkSample || null,
        failure: entry.failure || null,
        diagnosis: entry.diagnosis || null,
        outcome: entry.outcome || null,
        verdict: entry.verdict || null,
        nextHint: entry.nextHint || null,
      },
    }, secret);
  });
  const environment = buildRecordEnvironmentModel(session);
  const unreadable = session.observationRestore?.status === 'unreadable';
  return {
    schema: 'chrome-cdp-ex.record-actions.v1',
    targetId: session.targetId,
    sessionId: session.sessionId,
    source: 'session-action-log',
    environmentCount: environment.length,
    environment,
    actionCount: actions.length,
    actions,
    ...(session.observationLoaded ? { restored: true } : {}),
    ...(unreadable ? {
      unavailable: {
        reason: 'saved-action-log-unreadable',
        message: 'Saved action log could not be read after the tab daemon restarted. This is not an empty session.',
      },
    } : {}),
    ...(session.observationWriteFailed ? {
      saveError: 'The action log could not be saved. A restarted daemon will not have this latest copy.',
    } : {}),
  };
}
export function formatCommandLine(command) {
  return (command || []).map(arg => {
    const s = String(arg);
    return /^[^\s"']+$/.test(s) ? s : JSON.stringify(s);
  }).join(' ');
}
function countedLabel(count, one, many) {
  const n = Number(count) || 0;
  return `${n} ${n === 1 ? one : many}`;
}
export function recordActionsClearModel(targetId, actions, environment) {
  const next = `cdp record-actions ${targetPrefixForDisplay(targetId)}`;
  return {
    schema: 'chrome-cdp-ex.record-actions-clear.v1',
    targetId: targetId || null,
    cleared: { actions, environment },
    message: `Cleared action log (${countedLabel(actions, 'action', 'actions')}, ${countedLabel(environment, 'environment step', 'environment steps')}).`,
    next,
  };
}
export function parseRecordActionsArgs(args = []) {
  const fopts = parseFormatArgs(args, ['text', 'json']);
  let clear = false;
  for (const arg of fopts.args) {
    if (arg === '--clear') {
      if (clear) {
        throw new Error('record-actions: unknown argument --clear. --clear cannot be combined with an export flag. Use --clear or --format json.');
      }
      clear = true;
      continue;
    }
    throw new Error(`record-actions: unknown argument ${arg}. --clear cannot be combined with an export flag. Use --clear or --format json.`);
  }
  return { format: fopts.format, clear };
}
function sessionHasNetworkBuffer(session) {
  return Boolean(session?.buffers?.network && typeof session.buffers.network.all === 'function');
}
function restoreClearedSession(session, previous) {
  session.actionLog = previous.actionLog;
  session.environmentLog = previous.environmentLog;
  session.actionSeq = previous.actionSeq;
  session.observationLoaded = previous.observationLoaded;
  session.observationRestore = previous.observationRestore;
}
// Empties the action log and recorded environment steps. The netlog buffer stays.
// Mock rules, throttle, and dialog mode live in the environment file and are not touched.
export function clearRecordedActions(session, { format = 'text' } = {}) {
  if (!session || typeof session !== 'object') {
    throw new Error('record-actions: no target session to clear');
  }
  const disk = session.runtimeDir && session.targetId
    ? readTabObservation(session.targetId, { runtimeDir: session.runtimeDir })
    : { status: 'absent' };
  const memoryActions = Array.isArray(session.actionLog) ? session.actionLog.length : 0;
  const memoryEnvironment = Array.isArray(session.environmentLog) ? session.environmentLog.length : 0;
  const memoryHoldsLog = memoryActions > 0 || memoryEnvironment > 0 || session.observationLoaded === true;
  if (disk.status === 'unreadable' && !memoryHoldsLog) {
    throw new Error('record-actions: saved action log could not be read, so it was not cleared');
  }
  const actions = memoryHoldsLog ? memoryActions : (disk.status === 'ok' ? disk.actions.length : 0);
  const environment = memoryHoldsLog ? memoryEnvironment : (disk.status === 'ok' ? disk.environment.length : 0);
  const diskAlreadyEmpty = disk.status === 'absent'
    || (disk.status === 'ok' && disk.actions.length === 0 && disk.environment.length === 0);
  if (actions === 0 && environment === 0 && diskAlreadyEmpty) {
    session.actionLog = [];
    session.environmentLog = [];
    session.actionSeq = 0;
    session.observationLoaded = false;
  } else {
    const previous = {
      actionLog: session.actionLog,
      environmentLog: session.environmentLog,
      actionSeq: session.actionSeq,
      observationLoaded: session.observationLoaded,
      observationRestore: session.observationRestore,
    };
    session.actionLog = [];
    session.environmentLog = [];
    session.actionSeq = 0;
    session.observationLoaded = false;
    if (session.observationRestore?.status === 'unreadable') {
      session.observationRestore = {
        applied: true,
        status: 'ok',
        netlogCount: 0,
        actionCount: 0,
        environmentCount: 0,
      };
    }
    let saved = true;
    if (session.runtimeDir && session.targetId) {
      if (sessionHasNetworkBuffer(session) || disk.status !== 'ok') {
        saved = rememberTabObservation(session);
      } else {
        saved = writeTabObservation(session.targetId, {
          actionSeq: 0,
          actions: [],
          environment: [],
          netlog: disk.netlog,
        }, { runtimeDir: session.runtimeDir });
        if (saved) {
          session.observationWriteFailed = false;
          session.observationComparable = null;
        }
      }
    }
    if (!saved) {
      restoreClearedSession(session, previous);
      throw new Error('record-actions: the action log could not be saved, so it was not cleared');
    }
  }
  const model = recordActionsClearModel(session.targetId, actions, environment);
  return format === 'json' ? formatJson(model) : `${model.message} Next: ${model.next}`;
}
export function formatRecordActions(session, { format = 'text' } = {}) {
  const model = buildRecordActionsModel(session);
  if (format === 'json') return formatJson(model);
  const lines = [
    `Recorded actions: ${model.actionCount}`,
    `Session: ${model.targetId}`,
    session.observationRestore?.status === 'unreadable'
      ? 'Source: saved action log could not be read after the tab daemon restarted'
      : (session.observationLoaded
        ? 'Source: saved action log restored after the tab daemon exited'
        : 'Source: current daemon session action log'),
  ];
  if (model.saveError) lines.push(model.saveError);
  if (model.environment.length) {
    lines.push(`Environment controls: ${model.environmentCount}`);
    for (const entry of model.environment) {
      const status = entry.replayable ? 'replayable' : (entry.needsInput.length ? 'needs input' : 'review needed');
      lines.push(`Env ${entry.index}. ${formatCommandLine(entry.command)} — ${status}`);
      if (entry.needsInput.length) lines.push(`   Missing: ${entry.needsInput.join(', ')}`);
    }
  }
  if (model.actions.length === 0) {
    if (model.unavailable) lines.push(model.unavailable.message);
    else lines.push('No actions recorded yet. Run click/fill/press/nav/inject/reload, then record-actions again.');
    return lines.join('\n');
  }
  for (const step of model.actions) {
    const label = step.target?.label || step.target?.input || '';
    const status = step.replayable ? 'replayable' : (step.needsInput.length ? 'needs input' : 'review needed');
    lines.push(`${step.index}. ${step.action}${label ? ` ${label}` : ''} — ${status}`);
    lines.push(`   Replay: ${formatCommandLine(step.command)}`);
    if (step.needsInput.length) lines.push(`   Missing: ${step.needsInput.join(', ')}`);
    if (step.evidence.settleOk !== null) {
      const settle = step.evidence.settleOk ? 'ok' : 'not confirmed';
      const duration = Number.isFinite(step.evidence.settleDurationMs) ? ` in ${step.evidence.settleDurationMs}ms` : '';
      lines.push(`   Settle: ${settle}${duration}`);
    }
    if (step.evidence.effectSummary) lines.push(`   Evidence: ${step.evidence.effectSummary}`);
    if (step.evidence.effectSample) lines.push(`   Sample: ${step.evidence.effectSample}`);
    if (step.evidence.outcome?.status) lines.push(`   Outcome: ${step.evidence.outcome.status}`);
    if (step.evidence.verdict?.status) lines.push(`   Verdict: ${step.evidence.verdict.status}`);
    if (step.evidence.failure?.kind) lines.push(`   Failure: ${step.evidence.failure.kind}`);
    if (step.evidence.failure?.reason) lines.push(`   Reason: ${step.evidence.failure.reason}`);
    if (step.evidence.nextHint) lines.push(`   Next: ${step.evidence.nextHint}`);
    if (step.evidence.consoleSummary) lines.push(`   ${step.evidence.consoleSummary}`);
    if (step.evidence.consoleSample) lines.push(`   Console sample: ${step.evidence.consoleSample}`);
    if (step.evidence.exceptionSummary) lines.push(`   ${step.evidence.exceptionSummary}`);
    if (step.evidence.exceptionSample) lines.push(`   Exception sample: ${step.evidence.exceptionSample}`);
    if (step.evidence.networkSummary) lines.push(`   ${step.evidence.networkSummary}`);
    if (step.evidence.networkSample) lines.push(`   Network sample: ${step.evidence.networkSample}`);
  }
  return lines.join('\n');
}
export function isPlaywrightPortableSelector(value) {
  const selector = String(value || '').trim();
  return selector && !selector.startsWith('@') && !selector.startsWith('<') && selector !== '<redacted>';
}
export function cleanObservedTextForPlaywrightAssertion(text) {
  return String(text || '')
    .replace(/\s+@f?\d+(?::\d+)?\b.*$/u, '')
    .replace(/\s+\(-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?\s+\d+(?:\.\d+)?[×x]\d+(?:\.\d+)?.*$/u, '')
    .replace(/\s{2,}.*/u, '')
    .trim();
}
export function observedTextAssertionFromEffectSample(sample) {
  const line = String(sample || '').trim();
  const match = line.match(/^\+\s+\[([^\]]+)\]\s+(.+)$/u);
  if (!match) return null;
  const role = match[1].replace(/\s+/g, '').toLowerCase();
  if (!PLAYWRIGHT_ASSERTION_TEXT_ROLES.has(role)) return null;
  const text = cleanObservedTextForPlaywrightAssertion(match[2]);
  if (!text || text.length < 2 || text.length > 160) return null;
  return text;
}
export function playwrightAssertionLinesFromEvidence(evidence = {}) {
  const text = observedTextAssertionFromEffectSample(evidence.effectSample);
  if (!text) return [];
  return [`await expect(page.getByText(${JSON.stringify(text)})).toBeVisible();`];
}
export function playwrightStepFromCommand(action = {}) {
  const command = Array.isArray(action.command) ? action.command.map(v => String(v)) : [];
  const commandText = command.length ? formatCommandLine(command) : `${action.action || 'action'} <missing command>`;
  const skip = (reason) => ({
    lines: [
      `// Not exported: ${commandText}`,
      `// Reason: ${reason}`,
    ],
    exported: false,
  });
  const finish = (lines) => ({
    lines: [...lines, ...playwrightAssertionLinesFromEvidence(action.evidence || {})],
    exported: true,
  });

  if (action.replayable !== true) {
    const missing = Array.isArray(action.needsInput) && action.needsInput.length
      ? action.needsInput.join(', ')
      : 'review';
    return skip(`not replayable; missing ${missing}`);
  }
  if (!command.length || !command[0]) return skip('missing command');
  if (command.includes('<redacted>')) return skip('redacted input');

  const [cmd, ...args] = command;
  switch (cmd) {
    case 'nav':
    case 'navigate':
      return args[0]
        ? finish([`await page.goto(${JSON.stringify(args[0])});`])
        : skip('missing URL');
    case 'click':
    case 'jsclick': {
      const selector = args[0] === '--js' || args[0] === '-j' ? args[1] : args[0];
      if (isNamedClickQuery(selector)) {
        return finish([`await page.getByRole('link', { name: ${JSON.stringify(namedClickQueryName(selector))} }).click();`]);
      }
      if (!isPlaywrightPortableSelector(selector)) return skip('needs stable selector; chrome-cdp-ex @refs are session-local');
      return finish([`await page.locator(${JSON.stringify(selector)}).click();`]);
    }
    case 'fill': {
      const usesReactFill = args[0] === '--react';
      const selector = usesReactFill ? args[1] : args[0];
      const text = usesReactFill ? args[2] : args[1];
      if (!isPlaywrightPortableSelector(selector)) return skip('needs stable selector; chrome-cdp-ex @refs are session-local');
      // A named secret stays a name: the spec reads the same environment variable at run time.
      const secretName = text === '--secret' ? String(args[args.indexOf('--secret') + 1] ?? '') : null;
      if (secretName != null) {
        if (!/^[A-Z0-9_]+$/.test(secretName)) return skip('invalid secret name');
        return finish([`await page.locator(${JSON.stringify(selector)}).fill(process.env.CDP_SECRET_${secretName} ?? '');`]);
      }
      if (text == null || text === '<redacted>') return skip('missing fill text');
      return finish([`await page.locator(${JSON.stringify(selector)}).fill(${JSON.stringify(text)});`]);
    }
    case 'select': {
      const [selector, value] = args;
      if (!isPlaywrightPortableSelector(selector)) return skip('needs stable selector; chrome-cdp-ex @refs are session-local');
      if (value == null) return skip('missing select value');
      return finish([`await page.locator(${JSON.stringify(selector)}).selectOption(${JSON.stringify(value)});`]);
    }
    case 'type':
      return args[0]
        ? finish([`await page.keyboard.type(${JSON.stringify(args[0])});`])
        : skip('missing text');
    case 'press':
      return args[0]
        ? finish([`await page.keyboard.press(${JSON.stringify(args[0])});`])
        : skip('missing key');
    case 'clickxy': {
      const x = Number(args[0]);
      const y = Number(args[1]);
      return Number.isFinite(x) && Number.isFinite(y)
        ? finish([`await page.mouse.click(${x}, ${y});`, '// Coordinate click: review before committing as a regression test.'])
        : skip('missing coordinates');
    }
    case 'scroll': {
      const scrollArgs = splitScrollEdgeArgs(args);
      let edge = null;
      try { edge = parseScrollEdge(scrollArgs[0], scrollArgs[1]); } catch { edge = null; }
      let container = null;
      try { container = parseScrollContainerArg(scrollArgs.slice(2)); } catch { container = null; }
      if (edge === 'top' || edge === 'bottom') {
        if (container && !isPlaywrightPortableSelector(container)) {
          return skip('needs stable selector; chrome-cdp-ex @refs are session-local');
        }
        if (container) {
          const topExpr = edge === 'top'
            ? "Element.prototype.scrollTo.call(el, { top: 0, behavior: 'instant' })"
            : "Element.prototype.scrollTo.call(el, { top: Math.max(0, (el.scrollHeight || 0) - (el.clientHeight || 0)), behavior: 'instant' })";
          return finish([
            `await page.locator(${JSON.stringify(container)}).evaluate((el) => { ${topExpr}; });`,
          ]);
        }
        const dest = edge === 'top' ? '0' : 'edge';
        return finish([
          `await page.evaluate(() => { const tolerance = 2; const scrolling = document.scrollingElement || document.documentElement; const docMax = Math.max(0, Math.round((Number(scrolling && scrolling.scrollHeight) || 0) - window.innerHeight)); if (docMax > tolerance) { Element.prototype.scrollTo.call(scrolling, { left: 0, top: ${edge === 'top' ? '0' : 'docMax'}, behavior: 'instant' }); return; } let best = null; let bestScore = 0; const nodes = document.querySelectorAll ? document.querySelectorAll('*') : []; for (let i = 0; i < nodes.length; i++) { const el = nodes[i]; if (el === document.documentElement || el === document.body || el === document.scrollingElement) continue; const max = Math.max(0, (el.scrollHeight || 0) - (el.clientHeight || 0)); if (max <= tolerance) continue; const style = window.getComputedStyle ? window.getComputedStyle(el) : null; if (!/(auto|scroll|overlay)/.test(String((style && (style.overflowY || style.overflow)) || ''))) continue; const score = max * Math.max(1, (el.clientWidth || 0) * (el.clientHeight || 0)); if (score > bestScore) { best = el; bestScore = score; } } if (best) Element.prototype.scrollTo.call(best, { top: ${dest === '0' ? '0' : 'Math.max(0, (best.scrollHeight || 0) - (best.clientHeight || 0))'}, behavior: 'instant' }); });`,
        ]);
      }
      const direction = scrollArgs[0] || '';
      const amount = Number(scrollArgs[1] || 500);
      const dirMap = { down: [0, amount], up: [0, -amount], left: [-amount, 0], right: [amount, 0] };
      let xy = dirMap[direction.toLowerCase()];
      if (!xy && direction.includes(',')) xy = direction.split(',').map(Number);
      return xy && xy.every(Number.isFinite)
        ? finish([`await page.mouse.wheel(${xy[0]}, ${xy[1]});`])
        : skip('unsupported scroll arguments');
    }
    case 'viewport': case 'resize': {
      const match = String(args[0] || '').match(/^(\d+)[x×](\d+)$/);
      return match
        ? finish([`await page.setViewportSize({ width: ${Number(match[1])}, height: ${Number(match[2])} });`])
        : skip('unsupported viewport format');
    }
    case 'reload':
      return finish(['await page.reload();']);
    case 'back':
      return finish(['await page.goBack();']);
    case 'forward':
      return finish(['await page.goForward();']);
    case 'dismiss-modal':
    case 'dismissmodal':
      return finish(['await page.keyboard.press("Escape");', '// Review: chrome-cdp-ex may have clicked a specific close button instead.']);
    case 'drag': {
      let drag = null;
      try { drag = parseDragArgs(args); } catch { drag = null; }
      if (!drag) return skip('unsupported drag arguments');
      if (!isPlaywrightPortableSelector(drag.from)) return skip('needs stable selector; chrome-cdp-ex @refs are session-local');
      if (DRAG_POINT_RE.test(drag.to)) return skip('drop at coordinates; review before exporting');
      if (!isPlaywrightPortableSelector(drag.to)) return skip('needs stable selector; chrome-cdp-ex @refs are session-local');
      return finish([`await page.locator(${JSON.stringify(drag.from)}).dragTo(page.locator(${JSON.stringify(drag.to)}));`]);
    }
    default:
      return skip(`unsupported command: ${cmd}`);
  }
}
export function parseFlagArgs(args = []) {
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (String(token || '').startsWith('--')) {
      opts[token] = args[++i];
    }
  }
  return opts;
}
export function playwrightStepFromEnvironment(entry = {}) {
  const command = Array.isArray(entry.command) ? entry.command.map(v => String(v)) : [];
  const commandText = command.length ? formatCommandLine(command) : `${entry.type || 'environment'} <missing command>`;
  const skip = (reason) => ({
    lines: [
      `// Environment not exported: ${commandText}`,
      `// Reason: ${reason}`,
    ],
    exported: false,
  });

  if (!command.length || !command[0]) return skip('missing command');
  if (command.includes('<redacted>')) return skip('redacted input');
  const [cmd, mode, pattern, ...rest] = command;
  if (cmd === 'mock' && mode === 'add') {
    if (!pattern || pattern.startsWith('<')) return skip('missing URL pattern');
    const flags = parseFlagArgs(rest);
    const status = Number(flags['--status'] || 200);
    const contentType = flags['--content-type'] || 'text/plain; charset=utf-8';
    const body = flags['--body'] || '';
    const method = flags['--method'];
    if (method) {
      return {
        lines: [
          `await page.route(${JSON.stringify(pattern)}, route => {`,
          `  if (route.request().method() !== ${JSON.stringify(method)}) return route.continue();`,
          `  return route.fulfill({ status: ${Number.isFinite(status) ? status : 200}, contentType: ${JSON.stringify(contentType)}, body: ${JSON.stringify(body)} });`,
          '});',
        ],
        exported: true,
      };
    }
    return {
      lines: [
        `await page.route(${JSON.stringify(pattern)}, route => route.fulfill({ status: ${Number.isFinite(status) ? status : 200}, contentType: ${JSON.stringify(contentType)}, body: ${JSON.stringify(body)} }));`,
      ],
      exported: true,
    };
  }
  if (cmd === 'mock' && mode === 'clear') return skip('Playwright routes are test-scoped; review whether unroute is needed');
  if (cmd === 'throttle') return skip('chrome-cdp-ex live network throttling has no portable exporter step yet');
  if (cmd === 'clock') return skip('chrome-cdp-ex live clock override has no portable exporter step yet');
  return skip(`unsupported environment command: ${cmd}`);
}
export function formatPlaywrightSpecFromRecordActions(model, { title = 'chrome-cdp-ex exported workflow' } = {}) {
  const actions = Array.isArray(model?.actions) ? model.actions : [];
  const environment = Array.isArray(model?.environment) ? model.environment : [];
  const environmentSteps = environment.map(entry => playwrightStepFromEnvironment(entry));
  const actionSteps = actions.map(action => playwrightStepFromCommand(action));
  const hasAssertions = actionSteps.some(step => step.lines.some(line => /\bexpect\(/.test(line)));
  const lines = [
    `import { test${hasAssertions ? ', expect' : ''} } from '@playwright/test';`,
    '',
    '// Generated from chrome-cdp-ex record-actions.',
    '// Review selectors, assertions, auth state, and skipped steps before committing.',
    '',
    `test(${singleQuotedJsString(title)}, async ({ page }) => {`,
  ];
  let environmentExported = 0;
  let environmentSkipped = 0;
  for (const step of environmentSteps) {
    if (step.exported) environmentExported++;
    else environmentSkipped++;
    for (const line of step.lines) lines.push(`  ${line}`);
  }
  let exported = 0;
  let skipped = 0;
  for (const step of actionSteps) {
    if (step.exported) exported++;
    else skipped++;
    for (const line of step.lines) lines.push(`  ${line}`);
  }
  if (actions.length === 0 && environment.length === 0) {
    lines.push('  // No recorded actions yet. Run click/fill/nav, then export-playwright again.');
  }
  lines.push('});');
  lines.push('');
  if (environment.length) {
    lines.push(`// Environment exported ${environmentExported}/${environment.length} step(s); ${environmentSkipped} need review.`);
  }
  lines.push(`// Exported ${exported}/${actions.length} step(s); ${skipped} need review.`);
  return lines.join('\n');
}
export function parseExportPlaywrightArgs(args = []) {
  const fopts = parseFormatArgs(args, ['text', 'json']);
  const opts = { title: 'chrome-cdp-ex exported workflow', format: fopts.format };
  for (let i = 0; i < fopts.args.length; i++) {
    if (fopts.args[i] === '--title') {
      opts.title = fopts.args[++i] || opts.title;
    }
  }
  return opts;
}
export function singleQuotedJsString(value) {
  return `'${String(value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r/g, '\\r').replace(/\n/g, '\\n')}'`;
}
export function playwrightExportReviewEntry(phase, index, sourceEntry = {}, step = {}) {
  const command = Array.isArray(sourceEntry.command) ? sourceEntry.command.map(v => String(v)) : [];
  const reasonLine = (step.lines || []).find(line => line.startsWith('// Reason: '));
  return {
    phase,
    index,
    exported: step.exported === true,
    command,
    commandText: command.length ? formatCommandLine(command) : null,
    reason: reasonLine ? reasonLine.slice('// Reason: '.length) : null,
  };
}
export function buildExportPlaywrightModel(recordActionsModel, opts = {}) {
  const actions = Array.isArray(recordActionsModel?.actions) ? recordActionsModel.actions : [];
  const environment = Array.isArray(recordActionsModel?.environment) ? recordActionsModel.environment : [];
  const environmentSteps = environment.map(entry => playwrightStepFromEnvironment(entry));
  const actionSteps = actions.map(action => playwrightStepFromCommand(action));
  const environmentExported = environmentSteps.filter(step => step.exported).length;
  const actionsExported = actionSteps.filter(step => step.exported).length;
  const assertions = actionSteps.reduce((count, step) => (
    count + (step.lines || []).filter(line => /\bexpect\(/.test(line)).length
  ), 0);
  const review = [
    ...environmentSteps.map((step, i) => playwrightExportReviewEntry('environment', i + 1, environment[i], step)),
    ...actionSteps.map((step, i) => playwrightExportReviewEntry('action', i + 1, actions[i], step)),
  ].filter(entry => !entry.exported);
  const targetId = recordActionsModel?.targetId || '<target>';
  const skipped = review.length;
  const nextSteps = skipped > 0
    ? [
        'Review skipped steps and auth state before committing the Playwright spec.',
        `cdp record-actions ${targetId} --format json`,
        `cdp report ${targetId} --format json`,
      ]
    : [
        'Review auth state and selectors before committing the Playwright spec.',
        `cdp report ${targetId} --format json`,
      ];

  return {
    schema: 'chrome-cdp-ex.export-playwright.v1',
    targetId: recordActionsModel?.targetId || null,
    sessionId: recordActionsModel?.sessionId || null,
    source: 'record-actions',
    title: opts.title || 'chrome-cdp-ex exported workflow',
    counts: {
      environment: environment.length,
      environmentExported,
      environmentSkipped: environment.length - environmentExported,
      actions: actions.length,
      actionsExported,
      actionsSkipped: actions.length - actionsExported,
      assertions,
    },
    spec: formatPlaywrightSpecFromRecordActions(recordActionsModel, opts),
    review,
    nextSteps,
  };
}
export function formatExportPlaywright(session, opts = {}) {
  const model = buildRecordActionsModel(session);
  if (opts.format === 'json') return formatJson(buildExportPlaywrightModel(model, opts));
  return formatPlaywrightSpecFromRecordActions(model, opts);
}
export function createSessionState({ targetId, sessionId, logPath = sessionLogPath(targetId), screenshotDir = sessionScreenshotDir(targetId) }) {
  return {
    targetId,
    sessionId,
    createdAt: Date.now(),
    logPath,
    screenshotDir,
    logErrors: [],
    pageGeneration: 0,
    refGeneration: 0,
    refs: {
      map: new Map(),
      generation: 0,
      lastPerceiveAt: 0,
      invalidatedAt: Date.now(),
      invalidationReason: 'daemon-start',
    },
    lastPerceive: { output: null, model: null, snapshotOpts: null, cards: null },
    lastAction: null,
    buffers: {},
    pendingRequests: new Map(),
    networkThrottle: null,
    secretValues: new Map(),
    networkMocks: [],
    networkMockHits: [],
    dialogMode: 'dismiss',
    restartNotice: null,
    clock: null,
    environmentLog: [],
    actionSeq: 0,
    actionLog: [],
    screenshots: [],
    diffShot: null,
    records: [],
    frames: [],
    injections: [],
    privacy: {
      redactCookies: true,
      redactStorage: true,
      redactAuthorizationHeaders: true,
    },
  };
}
