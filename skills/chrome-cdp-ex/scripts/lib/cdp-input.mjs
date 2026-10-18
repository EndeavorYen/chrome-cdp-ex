// Moved from cdp.mjs without changes (#688). cdp.mjs is the entry point and re-exports for tests.
import { isTimeoutError } from './action-recovery.mjs';
import { armClickDownloadWatch, safeDownloadFilename } from './click-download.mjs';
import { COMMAND_SURFACE } from './command-surface.mjs';
import { REDACTED_VALUE, isSensitiveFieldText } from './redaction.mjs';
import { secretMarker } from './secrets.mjs';
import { statSync, writeFileSync } from 'fs';
import { dirname, isAbsolute, resolve } from 'path';
import { actionObservationPerceiveOpts } from './cdp-action-result.mjs';
import { ACTIONABILITY_POLL_MS, ACTIONABILITY_WAIT_DEFAULT_MS, ACTIONABILITY_WAIT_MAX_MS, ACTION_DISABLED_NOT_SENT, ARIA_CONTROL_STATE_ATTRS, CHILD_FRAME_CLICK_RE, CLICK_DOWNLOAD_STARTED_RE, CLICK_DOWNLOAD_UNOBSERVED_RE, CLICK_EVENT_PROBE_KEY, CLICK_HREF_PROBE_TIMEOUT_MS, CLICK_MOUSE_ACK_TIMEOUT_MS, CLICK_NAVIGATION_WAIT_MS, CLICK_OPENED_TAB_RE, CLICK_OPENER_BLOCK_GRACE_MS, CLICK_OPENER_RESPOND_TIMEOUT_MS, CLICK_OPENER_TERMINATE_TIMEOUT_MS, CLICK_POPUP_COMMIT_WAIT_MS, CLICK_POPUP_NAVIGATION_CAP_MS, CLICK_PROBE_READ_AFTER_MOUSE_TIMEOUT_MS, CLICK_STUCK_OPENER_BUDGET_MS, DOCUMENT_SCROLLER_JS, DOCUMENT_SCROLL_EDGE_OUTCOME, DOCUMENT_SCROLL_EDGE_TOLERANCE_PX, DRAG_DEFAULT_STEPS, DRAG_EVENT_PROBE_KEY, DRAG_INTERCEPT_WAIT_MS, DRAG_LATE_START_GRACE_MS, DRAG_LATE_START_SYNC_MS, DRAG_MAX_STEPS, DRAG_POINT_RE, DRAG_PRESS_HOLD_MS, DRAG_PROBE_EVENT_ORDER, DRAG_STEP_DELAY_MS, FILL_VALUE_PREVIEW_MAX, HOVER_DELIVERY_POLL_MS, HOVER_DELIVERY_WAIT_MS, HOVER_MOUSE_ACK_TIMEOUT_MS, HOVER_VISIBLE_COVER_POLLS, HOVER_VISIBLE_DELIVERY_WAIT_MS, HOVER_REVEAL_MARKER, KEY_MAP, NAMED_IN_VIEWPORT_CLICK_OUTCOME, NAMED_IN_VIEWPORT_CLICK_SELECTOR, NAVIGATION_CANCEL_EVIDENCE_WAIT_MS, NON_FILLABLE_INPUT_TYPES, POINTER_CLICK_SETTLE_MS, PRESS_DELIVERY_POLL_MS, PRESS_DELIVERY_WAIT_MS, PRESS_PROBE_KEY, PRESS_PROBE_MARKER, PRESS_SEARCH_SUBMIT_FLAG, PUNCT_KEY_MAP, REF_RESOLVE_TIMEOUT, SEARCH_SUBMIT_PROBE_WAIT_MS, SENSITIVE_FILL_RAW_VALUES, SESSION_TARGET_IDS, SHIFTED_PUNCT_KEY_MAP, TEXT_SELECTOR_PREFIX_RE, TIMEOUT, sleep, daemonSecretStorage, targetLabelExpression } from './cdp-base.mjs';
import { isBlankPageUrl, parseCompactFormatArgs } from './cdp-browser.mjs';
import { parseNonNegativeInteger, targetPrefixForDisplay } from './cdp-cli.mjs';
import { cutDocumentConsoleBuffersAt, documentConsoleCutSeq, shellQuoteCliArg } from './cdp-core.mjs';
import { navigationCancelledError, reloadObservationBuffers, reloadStr } from './cdp-flow.mjs';
import { cdpDomains, evalStr, getPages, navigationDestinationMatches, runtimeExceptionMessage } from './cdp-page.mjs';
import { clearObservationBuffers } from './cdp-page-commands.mjs';
import { clickPointHitFunctionSource, clickableBoxHelpersSource, discardHoverIdleBaseline, formatUnknownRefError, frameScopedBackendNode, frameViewportOffset, hoverRecaptureShowsChange, invalidateRefMapping, invalidateSessionRefs, isCursorRef, isRef, isSearchListingHref, isStaleRefError, linkFrameNamePageExpression, linkTargetPageExpression, parseElshotArgs, parseFrameRef, perceiveStr, resolveCursorRef, resolveRef, resolveRefNode, resolveRefRectNoScroll, resolvedNodeSession, scrollSettledRectFunctionDeclaration, searchListingHelpersSource, searchListingSelector, trustedRefPresenceFunctionDeclaration } from './cdp-perceive.mjs';
import { formatCrossSiteTarget, frameContentOrigin, listedFrame, originHost, wrapFrameContent } from './frame-sites.mjs';
import { clickDownloadBrowser, isSensitiveActionTarget, rememberSessionSecret } from './cdp-session-report.mjs';

// The daemon keeps the working directory of the CLI that started it; send the file absolute (#526).
export function absolutizeElshotFileArg(args = [], cwd = process.cwd()) {
  const { filePath, fileIndex } = parseElshotArgs(args);
  const next = [...args];
  if (filePath) next[fileIndex] = resolve(cwd, filePath);
  return next;
}
// A user path is opened in the tab daemon, whose cwd is whoever started it (#577).
// Leave an absolute path untouched, including its spelling, so a second pass is a no-op.
export function resolveCallerFile(filePath, cwd) {
  const text = String(filePath);
  if (!text || isAbsolute(text)) return text;
  return resolve(cwd, text);
}
export function sameArgList(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}
// Rejoin a rewritten flow or batch step. Quote only values the tokenizer would
// split or drop. Those tokenizers do not treat shell `'\''` as one apostrophe,
// so a value that contains `'` uses a quote kind it does not contain. `quoteChars`
// is the set that tokenizer accepts: flow includes backticks, batch does not.
// tokenizeCommandLine has no escape. When no quote in the set can wrap the value,
// return null and the caller leaves that step unchanged. A selector such as #f
// stays bare so the step text is stable. A backslash is not whitespace, so a
// Windows path with no spaces stays bare.
export function quoteRewrittenArg(text, quoteChars = '"\'`') {
  const value = String(text ?? '');
  const allowed = String(quoteChars || '"\'`');
  if (value === '') {
    const quote = allowed.includes("'") ? "'" : allowed.includes('"') ? '"' : '`';
    return `${quote}${quote}`;
  }
  if (!/[\s"';|]/.test(value)) return value;
  if (allowed.includes("'") && !value.includes("'")) return `'${value}'`;
  if (allowed.includes('"') && !value.includes('"')) return `"${value}"`;
  if (allowed.includes('`') && !value.includes('`')) return `\`${value}\``;
  if (allowed.includes('`')) return shellQuoteCliArg(value);
  return null;
}
export function rejoinRewrittenCommand(head, args, quoteChars) {
  const parts = [head];
  for (const arg of args) {
    const quoted = quoteRewrittenArg(arg, quoteChars);
    if (quoted == null) return null;
    parts.push(quoted);
  }
  return parts.join(' ');
}
export function canonicalCallerCommand(cmd) {
  return COMMAND_SURFACE.resolve(String(cmd || ''))?.name || String(cmd || '');
}
export function assertScreenshotOutputDirectory(filePath, command) {
  const dir = dirname(String(filePath));
  let info;
  try {
    info = statSync(dir);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`${command}: output directory does not exist: ${dir}`);
    throw error;
  }
  if (!info.isDirectory()) throw new Error(`${command}: output path is not a directory: ${dir}`);
}
export function writeScreenshotFile(filePath, base64, command) {
  assertScreenshotOutputDirectory(filePath, command);
  try {
    writeFileSync(filePath, Buffer.from(base64, 'base64'), { mode: 0o600 });
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`${command}: output directory does not exist: ${dirname(filePath)}`);
    if (error?.code === 'ENOTDIR') throw new Error(`${command}: output path is not a directory: ${dirname(filePath)}`);
    throw error;
  }
}
export function absolutizeShotArgs(args = [], cwd = process.cwd()) {
  if (!Array.isArray(args) || args.length === 0) return args;
  if (args[0] === '--annotate' || args[0] === '-a') return args;
  let fileIndex = -1;
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token == null) continue;
    if (token === '--quiet' || token === '-q' || token === '--verbose' || token === '-v') continue;
    if (typeof token === 'string' && !token.startsWith('--')) fileIndex = i;
  }
  if (fileIndex < 0) return args;
  const resolved = resolveCallerFile(args[fileIndex], cwd);
  if (resolved === args[fileIndex]) return args;
  const next = args.slice();
  next[fileIndex] = resolved;
  return next;
}
export function absolutizeFullshotArgs(args = [], cwd = process.cwd()) {
  if (!Array.isArray(args) || args.length === 0) return args;
  const next = args.slice();
  let changed = false;
  for (let i = 0; i < next.length; i++) {
    const token = next[i];
    if (token === '--scroll-container' || token === '--format') {
      i += 1;
      continue;
    }
    if (typeof token !== 'string' || !token || token.startsWith('--')) continue;
    const resolved = resolveCallerFile(token, cwd);
    if (resolved === token) continue;
    next[i] = resolved;
    changed = true;
  }
  return changed ? next : args;
}
export function uploadPathIndexes(args = []) {
  const indexes = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === '--format' || token === '--max-diff-lines') {
      i += 1;
      continue;
    }
    if (
      token === '--compact' || token === '--full' || token === '--unsafe-full'
      || token === '--qa' || token === '--summary'
      || (typeof token === 'string' && token.startsWith('--max-diff-lines='))
    ) continue;
    indexes.push(i);
  }
  return indexes;
}
export function absolutizeUploadArgs(args = [], cwd = process.cwd()) {
  const pathIndex = uploadPathIndexes(args)[1];
  if (pathIndex == null) return args;
  const raw = args[pathIndex];
  if (typeof raw !== 'string' || !raw) return args;
  const resolved = raw.split(',').map(part => {
    const trimmed = part.trim();
    if (!trimmed) return part;
    const next = resolveCallerFile(trimmed, cwd);
    return next === trimmed ? part : next;
  }).join(',');
  if (resolved === raw) return args;
  const next = args.slice();
  next[pathIndex] = resolved;
  return next;
}
// replay/restore read the artifact inside the daemon. --json is a payload, not a path.
export function absolutizeArtifactFileArgs(args = [], cwd = process.cwd()) {
  if (!Array.isArray(args)) return args;
  const next = args.slice();
  let changed = false;
  let sawFile = false;
  let sawJson = false;
  const positional = [];
  for (let i = 0; i < next.length; i++) {
    const token = next[i];
    if (token === '--format') {
      i += 1;
      continue;
    }
    if (token === '--continue' || token === '-c') continue;
    if (token === '--json') {
      sawJson = true;
      break;
    }
    if (token === '--file' || token === '-f') {
      sawFile = true;
      const value = next[i + 1];
      if (typeof value === 'string' && value && !value.startsWith('--')) {
        const resolved = resolveCallerFile(value, cwd);
        if (resolved !== value) {
          next[i + 1] = resolved;
          changed = true;
        }
        i += 1;
      }
      continue;
    }
    positional.push(i);
  }
  if (!sawJson && !sawFile && positional.length) {
    const index = positional[0];
    const raw = next[index];
    if (typeof raw === 'string' && raw && !raw.startsWith('{') && !raw.startsWith('[')) {
      const resolved = resolveCallerFile(raw, cwd);
      if (resolved !== raw) {
        next[index] = resolved;
        changed = true;
      }
    }
  }
  return changed ? next : args;
}
export function absolutizeResponsiveAuditArgs(args = [], cwd = process.cwd()) {
  if (!Array.isArray(args)) return args;
  const next = args.slice();
  let changed = false;
  for (let i = 0; i < next.length - 1; i++) {
    if (next[i] !== '--out-dir' && next[i] !== '--output-dir') continue;
    const value = next[i + 1];
    if (typeof value !== 'string' || !value || value.startsWith('--')) continue;
    const resolved = resolveCallerFile(value, cwd);
    if (resolved !== value) {
      next[i + 1] = resolved;
      changed = true;
    }
    i += 1;
  }
  return changed ? next : args;
}
export function callerPayloadIndexes(args, extraSkip) {
  const indexes = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === '--format') {
      i += 1;
      continue;
    }
    if (extraSkip.has(token)) continue;
    indexes.push(i);
  }
  return indexes;
}
export function replaceCallerPayload(args, indexes, value) {
  const drop = new Set(indexes.slice(1));
  const first = indexes[0];
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (drop.has(i)) continue;
    out.push(i === first ? value : args[i]);
  }
  return out;
}
// Attach a no-op rejection handler now and return the same promise for a later await.
export function handledLater(promise) {
  promise.catch(() => {});
  return promise;
}
export async function dispatchMouseEventAllowingAckTimeout(cdp, sid, params) {
  try {
    await cdpDomains(cdp).Input.dispatchMouseEvent(params, sid, HOVER_MOUSE_ACK_TIMEOUT_MS);
    return { timedOut: false };
  } catch (error) {
    // Same Chrome 151 compositor-ack stall as hover: the event is already
    // forwarded, so waiting out the default 15s RPC would separate press from
    // release by seconds and the link default action never runs.
    if (!isTimeoutError(error, ['Input.dispatchMouseEvent'])) throw error;
    return { timedOut: true };
  }
}
export async function dispatchClickMouseEvent(cdp, sid, params) {
  try {
    await cdpDomains(cdp).Input.dispatchMouseEvent(params, sid, CLICK_MOUSE_ACK_TIMEOUT_MS);
    return { timedOut: false };
  } catch (error) {
    // Press/release may sit behind Chrome 151's ~5s hit-test/compositor stall.
    // Swallow only that timeout so overlapping events can still inject; the
    // page-side probe below fail-closes if nothing actually reached the DOM.
    if (!isTimeoutError(error, ['Input.dispatchMouseEvent'])) throw error;
    return { timedOut: true };
  }
}
export function clickEventProbeInstallOnViewSource() {
  // `target` is the intended element. The same set the pre-dispatch hit test
  // accepts (#436/#551) counts as reached: the target, a descendant, an
  // ancestor, or a <label> whose control is the target. A page-level probe
  // passes target null and only records that some event arrived.
  return `function installOnView(view, target, scope) {
    const key = ${JSON.stringify(CLICK_EVENT_PROBE_KEY)};
    const types = ['pointerdown', 'mousedown', 'mouseup', 'pointerup', 'click'];
    if (!view || typeof view.addEventListener !== 'function') {
      return { cdpClickProbe: true, ok: false, installed: false };
    }
    const existing = view[key];
    if (existing && existing.handler) {
      for (const type of existing.types || types) {
        view.removeEventListener(type, existing.handler, true);
      }
    }
    const seen = [];
    const reached = [];
    const state = { landedOn: '' };
    const verifiesTarget = Boolean(target && target.nodeType === 1);
    const composedParent = node => {
      if (!node) return null;
      const parent = node.parentNode;
      return parent && parent.nodeType === 11 && parent.host ? parent.host : parent;
    };
    const composedContains = (outer, inner) => {
      for (let node = inner, guard = 0; node && guard < 4096; node = composedParent(node), guard++) {
        if (node === outer) return true;
      }
      return false;
    };
    const describe = node => {
      if (!node || node.nodeType !== 1) return '';
      const tag = String(node.tagName || 'node').toUpperCase();
      const id = node.id ? '#' + node.id : '';
      return '<' + tag + id + '>';
    };
    const accepted = hit => {
      if (!verifiesTarget || !hit || hit.nodeType !== 1) return false;
      if (composedContains(target, hit) || composedContains(hit, target)) return true;
      const label = typeof hit.closest === 'function' ? hit.closest('label') : null;
      return Boolean(label && (label.control === target || composedContains(label, target)));
    };
    const handler = function(event) {
      seen.push(event.type);
      if (!verifiesTarget) return;
      const raw = event && event.target;
      const hit = raw && raw.nodeType === 1 ? raw : (raw && raw.parentElement) || null;
      if (accepted(hit)) {
        reached.push(event.type);
        return;
      }
      if (!state.landedOn) state.landedOn = describe(hit);
    };
    for (const type of types) view.addEventListener(type, handler, true);
    view[key] = {
      types: types,
      handler: handler,
      seen: seen,
      reached: reached,
      state: state,
      verifiesTarget: verifiesTarget,
    };
    let top = false;
    let href = '';
    try { top = view.top === view; } catch (err) { top = false; }
    try { href = String(view.location.href || ''); } catch (err) { href = ''; }
    return {
      cdpClickProbe: true,
      ok: true,
      installed: true,
      scope: scope || 'target-document',
      top: top,
      href: href,
      verifiesTarget: verifiesTarget,
    };
  }`;
}
export function clickEventProbeReadOnViewSource() {
  return `function readOnView(view) {
    const key = ${JSON.stringify(CLICK_EVENT_PROBE_KEY)};
    if (!view) return { cdpClickProbe: true, ok: false };
    const probe = view[key];
    if (!probe) return { cdpClickProbe: true, ok: false };
    const types = probe.types || ['pointerdown', 'mousedown', 'mouseup', 'pointerup', 'click'];
    if (probe.handler) {
      for (const type of types) view.removeEventListener(type, probe.handler, true);
    }
    const seen = Array.isArray(probe.seen) ? probe.seen.slice() : [];
    const reached = Array.isArray(probe.reached) ? probe.reached.slice() : [];
    const landedOn = probe.state && typeof probe.state.landedOn === 'string' ? probe.state.landedOn : '';
    const verifiesTarget = probe.verifiesTarget === true;
    try { delete view[key]; } catch (err) { view[key] = undefined; }
    return {
      cdpClickProbe: true,
      ok: true,
      seen: seen,
      reached: reached,
      landedOn: landedOn,
      verifiesTarget: verifiesTarget,
    };
  }`;
}
export function clickEventProbeInstallOnNodeDeclaration() {
  return `function() {
    ${clickEventProbeInstallOnViewSource()}
    const view = this && this.ownerDocument && this.ownerDocument.defaultView;
    const target = this && this.nodeType === 1 ? this : null;
    return installOnView(view, target, 'target-document');
  }`;
}
export function clickEventProbeReadOnNodeDeclaration() {
  return `function() {
    ${clickEventProbeReadOnViewSource()}
    const view = this && this.ownerDocument && this.ownerDocument.defaultView;
    return readOnView(view);
  }`;
}
export function clickEventProbeInstallAtPointScript(x, y, selector = '') {
  return `(function() {
    ${clickEventProbeInstallOnViewSource()}
    const bindSelector = ${JSON.stringify(String(selector || ''))};
    if (bindSelector && !/^@(?:c\\d+|(?:f\\d+:)?\\d+)$/.test(bindSelector)) {
      let target = null;
      try { target = document.querySelector(bindSelector); } catch (err) { target = null; }
      if (!target) return { cdpClickProbe: true, ok: false, missingTarget: true, installed: false };
      const boundView = (target.ownerDocument && target.ownerDocument.defaultView) || window;
      return installOnView(boundView, target, 'target-document');
    }
    const px0 = ${JSON.stringify(Number(x))};
    const py0 = ${JSON.stringify(Number(y))};
    let doc = document;
    let view = window;
    let px = px0;
    let py = py0;
    for (let depth = 0; depth < 8; depth++) {
      const hit = doc.elementFromPoint ? doc.elementFromPoint(px, py) : null;
      if (!hit) break;
      const tag = String(hit.tagName || '').toUpperCase();
      if (tag !== 'IFRAME' && tag !== 'FRAME') {
        view = (hit.ownerDocument && hit.ownerDocument.defaultView) || view;
        break;
      }
      // A cross-origin frame throws or returns null for contentDocument. Do not
      // claim a probe was installed in a document this page cannot read (#639).
      let nested = null;
      try { nested = hit.contentDocument; } catch (err) { nested = null; }
      if (!nested) {
        let src = '';
        try { src = String(hit.src || ''); } catch (err) { src = ''; }
        return { cdpClickProbe: true, ok: true, installed: false, opaqueFrame: true, scope: 'opaque-frame', frameSrc: src };
      }
      const rect = hit.getBoundingClientRect();
      px -= rect.left;
      py -= rect.top;
      doc = nested;
      view = hit.contentWindow || view;
    }
    const scope = (view && view !== window) ? 'target-document' : 'top';
    return installOnView(view || window, null, scope);
  })()`;
}
export function clickEventProbeInstallOnWindowScript() {
  return `(function() {
    ${clickEventProbeInstallOnViewSource()}
    return installOnView(window, null, 'target-document');
  })()`;
}
export function clickEventProbeReadOnWindowScript() {
  return `(function() {
    ${clickEventProbeReadOnViewSource()}
    return readOnView(window);
  })()`;
}
export function clickEventProbeReadAtPointScript(x, y) {
  return `(function() {
    ${clickEventProbeReadOnViewSource()}
    const key = ${JSON.stringify(CLICK_EVENT_PROBE_KEY)};
    const px0 = ${JSON.stringify(Number(x))};
    const py0 = ${JSON.stringify(Number(y))};
    let doc = document;
    let view = window;
    let px = px0;
    let py = py0;
    for (let depth = 0; depth < 8; depth++) {
      if (view && view[key]) return readOnView(view);
      const hit = doc.elementFromPoint ? doc.elementFromPoint(px, py) : null;
      if (!hit) break;
      const tag = String(hit.tagName || '').toUpperCase();
      if (tag !== 'IFRAME' && tag !== 'FRAME') {
        view = (hit.ownerDocument && hit.ownerDocument.defaultView) || view;
        break;
      }
      const nested = hit.contentDocument;
      if (!nested) {
        view = hit.contentWindow || view;
        break;
      }
      const rect = hit.getBoundingClientRect();
      px -= rect.left;
      py -= rect.top;
      doc = nested;
      view = hit.contentWindow || view;
    }
    if (view && view[key]) return readOnView(view);
    if (window[key]) return readOnView(window);
    return { cdpClickProbe: true, ok: false };
  })()`;
}
export function parseClickEventProbeOutput(raw) {
  if (raw && typeof raw === 'object' && raw.cdpClickProbe === true) return raw;
  const text = String(raw || '').trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || parsed.cdpClickProbe !== true) return null;
    return parsed;
  } catch {
    return null;
  }
}
export function clickProbeSawPageEvent(seen) {
  if (!Array.isArray(seen) || seen.length === 0) return false;
  return seen.some(type => (
    type === 'mousedown'
    || type === 'pointerdown'
    || type === 'mouseup'
    || type === 'pointerup'
    || type === 'click'
  ));
}
// A hidden tab (its window covered by another window or minimised) drops Input.* events
// silently, which looks exactly like "dispatch.ok, zero page events" (#402). Ask the page
// once so the failure can say why instead of only "no events".
export async function probePageVisibility(cdp, sid) {
  try {
    const value = await evalStr(cdp, sid, 'document.visibilityState', false, { timeoutMs: 1500, raw: true });
    return value === 'hidden' || value === 'visible' ? value : 'unknown';
  } catch {
    return 'unknown';
  }
}
export function clickProbeBindSelector(selector) {
  const text = String(selector || '').trim();
  if (!text || isRef(text) || isCursorRef(text)) return '';
  return text;
}
export function clickMeasurementUnusable(measurement, point = null) {
  if (!measurement || typeof measurement !== 'object') return false;
  const w = measurement.w;
  const h = measurement.h;
  const hasSize = typeof w === 'number' && typeof h === 'number'
    && Number.isFinite(w) && Number.isFinite(h);
  const positive = hasSize && w > 0 && h > 0;
  const atOrigin = !!point && point.x === 0 && point.y === 0;
  // A positive box that is still off-viewport keeps its real centre. The pin
  // scrolls that box into view. Refuse before dispatch when there is no box,
  // or when the point we would send is the origin.
  if (measurement.noClickBox === true || measurement.inViewport === false) {
    return !positive || atOrigin;
  }
  return hasSize && !positive;
}
export function noClickBoxError(selector, measurement = {}) {
  const name = String(selector || 'the target');
  const w = typeof measurement.w === 'number' ? measurement.w : Number.NaN;
  const h = typeof measurement.h === 'number' ? measurement.h : Number.NaN;
  const size = Number.isFinite(w) && Number.isFinite(h) ? ` (${Math.round(w)}×${Math.round(h)})` : '';
  const off = measurement.inViewport === false && w > 0 && h > 0 ? ' It is outside the viewport.' : '';
  const err = new Error(`click: ${name}${size} has no clickable box in the viewport.${off} Nothing was clicked.`);
  err.noClickBox = {
    selector: String(selector || ''),
    w: Number.isFinite(w) ? w : null,
    h: Number.isFinite(h) ? h : null,
    inViewport: measurement.inViewport === true,
  };
  return err;
}
export function clickMisdirectedError(x, y, selector = '', { sent = true, landedOn = '' } = {}) {
  const target = selector ? ` for ${selector}` : '';
  const where = landedOn ? ` It landed on ${landedOn}.` : '';
  const sentText = sent ? 'The mouse click was misdirected.' : 'The mouse click was not sent.';
  const err = new Error(
    `click: the mouse click at (${x}, ${y})${target} did not reach the intended element.${where} ${sentText}`
  );
  err.clickMisdirected = {
    x,
    y,
    selector: String(selector || ''),
    landedOn: String(landedOn || ''),
    sent: sent !== false,
  };
  return err;
}
export function isUncommittedPageUrl(url = '') {
  return !String(url || '').trim();
}
export function openedTabUncommitted(opened) {
  return Boolean(opened) && opened.existing !== true && isUncommittedPageUrl(opened.url);
}
// The opener did not answer, and terminating its execution did not bring it
// back. Closing the popup does not recover it either. Reopen the page.
export function openerUnusableError(opened) {
  const err = new Error('click: the original tab is no longer usable. Reopen the tab or restart the browser.');
  err.openerBlocked = {
    targetId: String(opened?.targetId || ''),
    targetPrefix: targetPrefixForDisplay(opened?.targetId || ''),
    pageUrl: String(opened?.pageUrl || ''),
  };
  return err;
}
// The popup's target URL is still empty, and the opener still answers. That is
// a navigation that has not committed, not a dead tab, and not an about:blank open.
export function popupUncommittedError(opened) {
  const pending = String(opened?.pendingUrl || '').trim();
  const navigated = /^https?:\/\/\S+$/i.test(pending);
  const err = new Error(navigated
    ? `click: the popup started navigating to ${pending} but that navigation did not commit. The original tab is still usable. Do not repeat the click.`
    : 'click: the popup did not leave its initial document. The original tab is still usable. Do not repeat the click.');
  err.popupUncommitted = {
    targetId: String(opened?.targetId || ''),
    pendingUrl: navigated ? pending : '',
    pageUrl: String(opened?.pageUrl || ''),
  };
  return err;
}
export function throwIfUncommittedPopup(opened) {
  if (!openedTabUncommitted(opened)) return;
  if (opened.openerAlive === true && opened.openerDead !== true) throw popupUncommittedError(opened);
  throw openerUnusableError(opened);
}
export function createPopupCommitWatch() {
  return { started: false, url: '', committed: false, stop: async () => {} };
}
export function rememberPopupNavigationUrl(watch, url) {
  const text = String(url || '').trim();
  if (/^https?:\/\/\S+$/i.test(text)) watch.url = text;
}
// TargetInfo.url stays empty until the first commit. Enabling the popup page
// reports the destination on Page.frameStartedNavigating while that field is
// still empty. Attaching does not eval the popup.
export async function noteUncommittedPopup(cdp, watch, targetId) {
  if (watch.started || typeof cdp?.onEvent !== 'function') return;
  watch.started = true;
  let sessionId = '';
  try {
    const attached = await cdpDomains(cdp).Target.attachToTarget(
      { targetId, flatten: true },
      undefined,
      1000,
    );
    sessionId = String(attached?.sessionId || '');
  } catch {
    sessionId = '';
  }
  if (!sessionId) return;
  const onStart = (params, msg) => {
    if (msg?.sessionId && msg.sessionId !== sessionId) return;
    rememberPopupNavigationUrl(watch, params?.url);
  };
  const onCommit = (params, msg) => {
    if (msg?.sessionId && msg.sessionId !== sessionId) return;
    if (params?.frame?.parentId) return;
    rememberPopupNavigationUrl(watch, params?.frame?.url);
    if (watch.url) watch.committed = true;
  };
  const offStart = cdp.onEvent('Page.frameStartedNavigating', onStart);
  const offCommit = cdp.onEvent('Page.frameNavigated', onCommit);
  try {
    await cdpDomains(cdp).Page.enable({}, sessionId, 1000);
  } catch {
    // The destination event is delivered on enable. A timeout means we did not see it.
  }
  watch.stop = async () => {
    if (typeof offStart === 'function') offStart();
    if (typeof offCommit === 'function') offCommit();
    try {
      await cdpDomains(cdp).Target.detachFromTarget({ sessionId }, undefined, 1000);
    } catch {
      // Detach is best-effort. The browser drops the session with the tab.
    }
  };
}
export function openerStuckRecheckReserveMs() {
  return CLICK_OPENER_RESPOND_TIMEOUT_MS
    + CLICK_OPENER_TERMINATE_TIMEOUT_MS
    + CLICK_OPENER_RESPOND_TIMEOUT_MS;
}
export async function finishStuckOpener(cdp, sid, found, watch, deadlines) {
  await releaseBlockedOpener(cdp, sid);
  if (!await openerStillResponds(cdp, sid)) return { done: { ...found, openerDead: true } };
  if (watch.url && deadlines.nav && Date.now() < deadlines.nav) return { keepWaiting: true };
  return { done: { ...found, openerAlive: true, pendingUrl: watch.url || '' } };
}
// Empty URL and a live opener: keep waiting while a navigation is in flight.
// Empty URL and a silent opener: terminate that execution once the empty-url
// deadline has passed, even if a destination was announced. Do not spend the
// navigation cap on an opener that is not answering. Do not treat the initial
// document as about:blank.
export async function considerUncommittedPopup(cdp, sid, found, watch, deadlines) {
  await noteUncommittedPopup(cdp, watch, found.targetId);
  if (watch.committed && watch.url) return { done: { ...found, url: watch.url } };
  if (!deadlines.commit) deadlines.commit = Date.now() + CLICK_POPUP_COMMIT_WAIT_MS;
  if (watch.url && !deadlines.nav) deadlines.nav = Date.now() + CLICK_POPUP_NAVIGATION_CAP_MS;
  const now = Date.now();
  const stillWaiting = watch.url ? now < deadlines.nav : now < deadlines.commit;
  const stuckAt = Number(deadlines.stuckDeadline) || 0;
  const timeToCheckStuck = stuckAt > 0 && now >= stuckAt - openerStuckRecheckReserveMs();
  const commitPassed = now >= deadlines.commit;
  if (stillWaiting && !timeToCheckStuck && !(watch.url && commitPassed && !deadlines.openerChecked)) {
    return { keepWaiting: true };
  }
  if (stillWaiting && deadlines.openerChecked && !timeToCheckStuck) return { keepWaiting: true };
  if (!deadlines.openerChecked || !stillWaiting) {
    const alive = await openerStillResponds(cdp, sid);
    if (stillWaiting) deadlines.openerChecked = true;
    if (alive && stillWaiting) return { keepWaiting: true };
    if (alive) return { done: { ...found, openerAlive: true, pendingUrl: watch.url || '' } };
    return finishStuckOpener(cdp, sid, found, watch, deadlines);
  }
  return { keepWaiting: true };
}
export function clickNoPageEventsError(x, y, selector = '', visibility = 'unknown', { crossOriginFrame = false } = {}) {
  const target = selector ? ` for ${selector}` : '';
  if (crossOriginFrame) {
    const err = new Error(
      `click: Input.dispatchMouseEvent completed but the cross-origin frame received no mousedown/click events at (${x}, ${y})${target}. The mouse path failed closed.`
    );
    err.visibility = visibility;
    err.crossOriginFrame = { delivered: false };
    return err;
  }
  const hidden = visibility === 'hidden'
    ? " The tab's document.visibilityState is hidden (window covered or minimised): Input.* events are dropped while hidden, so retrying the mouse path will not help."
    : '';
  const err = new Error(
    `click: Input.dispatchMouseEvent completed but the page received no mousedown/click events at (${x}, ${y})${target}. The mouse path failed closed. Try jsclick or click --js.${hidden}`
  );
  err.visibility = visibility;
  return err;
}
export function clickProbeInstallModel(parsed, { objectId = null, x = 0, y = 0, scope = 'top' } = {}) {
  return {
    installed: Boolean(parsed?.ok && parsed?.installed),
    verifiesTarget: parsed?.verifiesTarget === true,
    missingTarget: parsed?.missingTarget === true,
    scope: parsed?.scope || scope,
    opaqueFrame: parsed?.opaqueFrame === true,
    frameSrc: typeof parsed?.frameSrc === 'string' ? parsed.frameSrc : '',
    top: parsed?.top === true,
    href: typeof parsed?.href === 'string' ? parsed.href : '',
    objectId,
    x,
    y,
  };
}
export async function installClickEventProbe(cdp, sid, { objectId = null, x = 0, y = 0, selector = '' } = {}) {
  try {
    if (objectId) {
      const probeSid = resolvedNodeSession(cdp, sid, objectId);
      const res = await cdpDomains(cdp).Runtime.callFunctionOn({
        objectId,
        functionDeclaration: clickEventProbeInstallOnNodeDeclaration(),
        returnByValue: true,
      }, probeSid);
      if (res.exceptionDetails) return { installed: false, verifiesTarget: false, missingTarget: false };
      return {
        ...clickProbeInstallModel(parseClickEventProbeOutput(res.result?.value), {
          objectId, x, y, scope: 'target-document',
        }),
        contentSid: probeSid,
      };
    }
    const raw = await evalStr(cdp, sid, clickEventProbeInstallAtPointScript(x, y, selector));
    return clickProbeInstallModel(parseClickEventProbeOutput(raw), { objectId: null, x, y, scope: 'top' });
  } catch {
    return { installed: false, verifiesTarget: false, missingTarget: false, scope: 'top', opaqueFrame: false, objectId, x, y };
  }
}
export async function readClickEventProbe(cdp, sid, probe = {}, timeoutMs) {
  const budget = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : undefined;
  try {
    if (probe.objectId) {
      const probeSid = probe.contentSid || resolvedNodeSession(cdp, sid, probe.objectId);
      const res = await cdpDomains(cdp).Runtime.callFunctionOn({
        objectId: probe.objectId,
        functionDeclaration: clickEventProbeReadOnNodeDeclaration(),
        returnByValue: true,
      }, probeSid, budget);
      if (res.exceptionDetails) return null;
      return parseClickEventProbeOutput(res.result?.value);
    }
    const raw = await evalStr(cdp, sid, clickEventProbeReadAtPointScript(probe.x, probe.y), false, {
      timeoutMs: budget,
    });
    return parseClickEventProbeOutput(raw);
  } catch (error) {
    // A timed-out evaluate stays queued in the renderer. Drop it, or every
    // later eval on this tab waits behind it (#639).
    if (isTimeoutError(error)) await releaseBlockedOpener(cdp, sid);
    return null;
  }
}
// #639: a popup script that touches window.opener can hold the opener's main
// thread. Terminate that execution so the abandoned probe, and the next
// command on this tab, are not stuck behind it.
export async function releaseBlockedOpener(cdp, sid) {
  try {
    await cdpDomains(cdp).Runtime.terminateExecution({}, sid, CLICK_OPENER_TERMINATE_TIMEOUT_MS);
  } catch {
    // The opener can already be idle. Termination is best-effort.
  }
}
export async function openerProbe(cdp, sid) {
  try {
    await evalStr(cdp, sid, '1', false, {
      timeoutMs: CLICK_OPENER_RESPOND_TIMEOUT_MS,
      raw: true,
    });
    return 'alive';
  } catch (error) {
    return isTimeoutError(error) ? 'timeout' : 'error';
  }
}
export async function openerStillResponds(cdp, sid) {
  const probe = await openerProbe(cdp, sid);
  return probe === 'alive';
}
// The browser process still knows the committed URL when the renderer does not answer.
export function openerPageUrl(pages, sid) {
  const openerId = SESSION_TARGET_IDS.get(sid) || '';
  if (!openerId) return '';
  const page = (pages || []).find(info => info.targetId === openerId);
  return String(page?.url || '');
}
// A popup this tab opened that is still on its initial document (empty URL or
// about:blank). That popup is what holds the opener in #677.
export function openerHoldingPopup(pages, sid) {
  const openerId = SESSION_TARGET_IDS.get(sid) || '';
  if (!openerId) return null;
  return (pages || []).find(info => info.openerId === openerId
    && info.targetId !== openerId
    && isBlankPageUrl(info.url)) || null;
}
// A tab a previous popup already stuck does not answer Runtime.evaluate. The click
// baseline (15s), the form-control snapshot (15s), and the locator
// (TIMEOUT + the 2s actionability wait = 17s) would each wait that out and the
// command would exit Kind: timeout. Probe first. A page in a long task also
// misses the probe, and terminating it would abort the page's own script, so
// terminate only when a popup this tab opened is still on its initial document.
// If the tab still does not answer after that, the receipt is opener-blocked.
// 400 + 500 + 1000 + 400 = 2300, under the live test's 20s budget.
export async function stuckOpenerBeforeClick(cdp, sid) {
  if (await openerProbe(cdp, sid) !== 'timeout') return null;
  const pages = await boundedPageTargets(cdp, 500);
  if (!openerHoldingPopup(pages, sid)) return null;
  await releaseBlockedOpener(cdp, sid);
  if (await openerProbe(cdp, sid) !== 'timeout') return null;
  return {
    targetId: SESSION_TARGET_IDS.get(sid) || '',
    pageUrl: openerPageUrl(pages, sid),
  };
}
// The pre-dispatch settle can return while CSS scroll-behavior:smooth is still
// animating. The click probe then adds a round trip, and the measured point is
// no longer on the target: elementFromPoint hits an ancestor, the click is
// accepted, and the control's listener never runs (#552). Freeze the current
// scroll offset through the native Element scroll method (instant, so the CSS
// animation cannot resume) and hit-test the fresh centre immediately before
// the mouse events.
export function pinClickPointSource() {
  return `function pinClickPoint(el) {
    ${clickPointHitFunctionSource()}
    ${clickableBoxHelpersSource()}
    if (!el || el.nodeType !== 1) return { cdpClickPoint: true, ok: false };
    const doc = el.ownerDocument || document;
    const view = doc.defaultView || window;
    const scrolling = doc.scrollingElement || doc.documentElement;
    const pin = scroller => {
      if (!scroller || typeof Element === 'undefined' || typeof Element.prototype.scrollTo !== 'function') return;
      try {
        Element.prototype.scrollTo.call(scroller, {
          left: Number(scroller.scrollLeft) || 0,
          top: Number(scroller.scrollTop) || 0,
          behavior: 'instant',
        });
      } catch (err) {}
    };
    const fullyVisible = () => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0
        && rect.top >= -0.5 && rect.left >= -0.5
        && rect.bottom <= view.innerHeight + 0.5 && rect.right <= view.innerWidth + 0.5;
    };
    pin(scrolling);
    if (doc.body && doc.body !== scrolling) pin(doc.body);
    if (!fullyVisible()) {
      if (typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      }
      if (scrolling) {
        const rect = el.getBoundingClientRect();
        const top = rect.top + (Number(scrolling.scrollTop) || 0) - Math.max(0, (view.innerHeight - rect.height) / 2);
        try {
          Element.prototype.scrollTo.call(scrolling, {
            left: Number(scrolling.scrollLeft) || 0,
            top: Math.max(0, top),
            behavior: 'instant',
          });
        } catch (err) {}
      }
      pin(scrolling);
    }
    const rect = el.getBoundingClientRect();
    const own = { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
    const resolved = resolveClickableBox(el, own);
    const box = { x: resolved.x, y: resolved.y, w: resolved.w, h: resolved.h };
    const hit = resolved.noClickBox ? null : clickPointHit(el, box);
    return {
      cdpClickPoint: true,
      ok: Boolean(!resolved.noClickBox && hit && hit.covered !== true && box.w > 0 && box.h > 0),
      noClickBox: resolved.noClickBox === true,
      inViewport: resolved.noClickBox !== true,
      x: box.x + box.w / 2,
      y: box.y + box.h / 2,
      w: box.w,
      h: box.h,
      hit: hit,
    };
  }`;
}
export function pinClickPointOnNodeDeclaration() {
  return `function() {
    ${pinClickPointSource()}
    return pinClickPoint(this);
  }`;
}
export function pinClickPointSelectorScript(selector) {
  return `(function() {
    ${pinClickPointSource()}
    let el = null;
    try { el = document.querySelector(${JSON.stringify(String(selector))}); } catch (err) { el = null; }
    if (!el) return { cdpClickPoint: true, ok: false, missingTarget: true };
    return pinClickPoint(el);
  })()`;
}
export function parsePinnedClickPoint(raw) {
  if (raw && typeof raw === 'object' && raw.cdpClickPoint === true) return raw;
  const text = String(raw || '').trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && parsed.cdpClickPoint === true ? parsed : null;
  } catch {
    return null;
  }
}
// Best-effort: a mock that does not implement the pin returns null and the
// caller keeps the point it already hit-tested. A real page returns the frozen
// centre, or missingTarget when the CSS node disappeared.
export async function readPinnedClickPoint(cdp, sid, probeTarget = {}) {
  try {
    if (probeTarget.objectId) {
      const res = await cdpDomains(cdp).Runtime.callFunctionOn({
        objectId: probeTarget.objectId,
        functionDeclaration: pinClickPointOnNodeDeclaration(),
        returnByValue: true,
      }, sid);
      if (res?.exceptionDetails) return null;
      return parsePinnedClickPoint(res?.result?.value);
    }
    const selector = clickProbeBindSelector(probeTarget.selector);
    if (!selector) return null;
    const raw = await evalStr(cdp, sid, pinClickPointSelectorScript(selector));
    return parsePinnedClickPoint(raw);
  } catch {
    return null;
  }
}
export async function dispatchClickMouseSequence(cdp, sid, x, y) {
  const point = { x, y, modifiers: 0, pointerType: 'mouse', clickCount: 1 };
  // The events overlap on purpose, so each promise is marked handled as soon as it exists:
  // a rejection while we sleep must reach Promise.all, not crash the daemon as an
  // unhandled rejection (#464).
  const moved = handledLater(dispatchMouseEventAllowingAckTimeout(cdp, sid, { ...point, type: 'mouseMoved', button: 'none', buttons: 0 }));
  const pressed = handledLater(dispatchClickMouseEvent(cdp, sid, { ...point, type: 'mousePressed', button: 'left', buttons: 1 }));
  await sleep(50);
  const released = handledLater(dispatchClickMouseEvent(cdp, sid, { ...point, type: 'mouseReleased', button: 'left', buttons: 0 }));
  const settled = await Promise.all([moved, pressed, released]);
  return { timedOut: settled.some(outcome => outcome?.timedOut === true) };
}
export function childFrameHrefSuffix(href) {
  const text = String(href || '');
  if (!/^https?:\/\/\S+$/.test(text) || text.includes('"')) return '';
  return ` ${text}`;
}
export function formatChildFrameClickSuffix(outcome) {
  if (!outcome || typeof outcome !== 'object') return '';
  const href = childFrameHrefSuffix(outcome.href);
  if (outcome.delivered === true) return ` → child-frame delivered${href}`;
  if (outcome.observed === false) return ` → child-frame unobserved${href}`;
  return '';
}
export function sameHttpUrl(left, right) {
  try {
    const a = new URL(String(left || ''));
    const b = new URL(String(right || ''));
    if (a.protocol !== 'http:' && a.protocol !== 'https:') return false;
    return a.href === b.href;
  } catch {
    return false;
  }
}
// One iframe target with this URL, or one page target that is not the opener tab.
// Two matches with the same URL are ambiguous: do not probe the wrong frame.
export function matchOpaqueFrameTarget(targetInfos, frameSrc, openerId) {
  const href = String(frameSrc || '');
  if (!/^https?:\/\//.test(href)) return null;
  const matches = (targetInfos || []).filter(info => info?.targetId && info.targetId !== openerId && sameHttpUrl(info.url, href));
  const iframes = matches.filter(info => info.type === 'iframe');
  if (iframes.length === 1) return iframes[0];
  if (iframes.length > 1) return null;
  const pages = matches.filter(info => info.type === 'page');
  return pages.length === 1 ? pages[0] : null;
}
export async function readOpaqueFrameTargets(cdp) {
  try {
    const { targetInfos = [] } = await cdpDomains(cdp).Target.getTargets();
    return targetInfos;
  } catch {
    return [];
  }
}
// #639: the top document cannot see events inside a cross-origin frame. Attach
// to that frame's target when exactly one matches, install the probe there, then
// send the mouse events on the parent session (Chrome routes them into the frame).
export async function dispatchClickIntoOpaqueFrame(cdp, sid, x, y, probe, probeTarget = {}) {
  const href = typeof probe.frameSrc === 'string' ? probe.frameSrc : '';
  const openerId = SESSION_TARGET_IDS.get(sid) || '';
  const unobserved = { childFrame: { observed: false, delivered: null, href } };
  const target = matchOpaqueFrameTarget(await readOpaqueFrameTargets(cdp), href, openerId);
  if (!target) {
    await dispatchClickMouseSequence(cdp, sid, x, y);
    return unobserved;
  }
  let childSession = '';
  try {
    const attached = await cdpDomains(cdp).Target.attachToTarget({ targetId: target.targetId, flatten: true }, undefined, 5000);
    childSession = String(attached?.sessionId || '');
  } catch {
    childSession = '';
  }
  if (!childSession) {
    await dispatchClickMouseSequence(cdp, sid, x, y);
    return unobserved;
  }
  try {
    let installed = null;
    try {
      const raw = await evalStr(cdp, childSession, clickEventProbeInstallOnWindowScript(), false, { timeoutMs: 5000, raw: true });
      installed = parseClickEventProbeOutput(raw);
    } catch {
      installed = null;
    }
    await dispatchClickMouseSequence(cdp, sid, x, y);
    if (!installed?.installed) return unobserved;
    let readout = null;
    try {
      const raw = await evalStr(cdp, childSession, clickEventProbeReadOnWindowScript(), false, { timeoutMs: 5000, raw: true });
      readout = parseClickEventProbeOutput(raw);
    } catch {
      readout = null;
    }
    if (readout?.ok && clickProbeSawPageEvent(readout.seen)) {
      return { childFrame: { observed: true, delivered: true, href } };
    }
    // A probe that vanished was wiped by a document replacement after the events.
    if (readout && readout.ok === false) {
      return { childFrame: { observed: true, delivered: true, href } };
    }
    if (!readout?.ok) return unobserved;
    throw clickNoPageEventsError(x, y, probeTarget.selector, await probePageVisibility(cdp, sid), { crossOriginFrame: true });
  } finally {
    try {
      await cdpDomains(cdp).Target.detachFromTarget({ sessionId: childSession });
    } catch {
      // Detach is best-effort. The child session ends with the browser anyway.
    }
  }
}
// Shared: dispatch a realistic mouse click at CSS pixel coordinates.
// Chrome's default action for <a href> requires the buttons bitmask
// (left=1 while pressed, 0 after release). Omitting it yields mousedown
// without a click, so the link never navigates.
//
// Chrome 151's Input.dispatchMouseEvent waits for an async widget hit-test
// before injecting. Serializing on that ack with a 250ms swallow left
// press/release uninjected (dispatch.ok, zero page events). Overlap the
// CDP commands, wait long enough for the ~5s stall, then fail closed unless a
// capture-phase probe on the target document saw mouse/click events. When the
// probe is bound to the intended element, those events must land on that
// element (or the #436/#551 hit set). A missing probe is fail-closed for
// top-level clicks; framed targets must probe the iframe document instead of
// treating a top-level empty `seen` as proof.
export async function dispatchClick(cdp, sid, x, y, probeTarget = {}) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(`Click point is not a finite viewport coordinate (x=${x}, y=${y}); the target's box could not be measured. Re-run perceive and retry, or use a CSS selector.`);
  }
  const probe = await installClickEventProbe(cdp, sid, {
    objectId: probeTarget.objectId || null,
    x,
    y,
    selector: clickProbeBindSelector(probeTarget.selector),
  });
  if (probe.missingTarget) {
    throw clickMisdirectedError(x, y, probeTarget.selector, { sent: false });
  }
  // Frame-ref coordinates are already translated into the top viewport. The pin
  // reads the element's own document, so those x/y values must not replace them.
  const pinned = probeTarget.framed ? null : await readPinnedClickPoint(cdp, sid, probeTarget);
  if (pinned?.missingTarget) {
    throw clickMisdirectedError(x, y, probeTarget.selector, { sent: false });
  }
  // #614: a pin that measured a zero-size or still off-viewport box must not fall
  // through to the caller's point. That point is (0, 0) for a closed dialog.
  if (pinned?.noClickBox === true || pinned?.inViewport === false) {
    throw noClickBoxError(probeTarget.selector || '', pinned);
  }
  if (pinned?.hit?.covered === true) {
    assertClickPointNotCovered(pinned.hit, {
      x: pinned.x,
      y: pinned.y,
      ref: probeTarget.selector || '',
    });
  }
  if (pinned?.ok === true && Number.isFinite(pinned.x) && Number.isFinite(pinned.y)) {
    x = pinned.x;
    y = pinned.y;
  }
  if (probe.opaqueFrame) {
    const visibility = await probePageVisibility(cdp, sid);
    if (visibility === 'hidden') {
      throw clickNoPageEventsError(x, y, probeTarget.selector, visibility);
    }
    return dispatchClickIntoOpaqueFrame(cdp, sid, x, y, probe, probeTarget);
  }
  const navigation = watchMainFrameNavigation(cdp, sid);
  const stuckDeadline = Date.now() + CLICK_STUCK_OPENER_BUDGET_MS;
  try {
    const mouse = dispatchClickMouseSequence(cdp, sid, x, y);
    // The mouse ack can sit out its full timeout while the popup holds the
    // opener. The rejection is handled here so returning early is not an
    // unhandled rejection; awaiting `mouse` still surfaces a real failure.
    mouse.catch(() => {});
    const blockingTab = await openedTabBlockingDispatch(
      cdp, sid, probeTarget.pagesBeforePromise || null, mouse, stuckDeadline,
    );
    if (blockingTab) {
      throwIfUncommittedPopup(blockingTab);
      // A committed about:blank whose opener does not answer is the popup
      // script holding this tab. A real URL is not that case: terminating a
      // long click handler that already opened a page would cut it short.
      if (isBlankPageUrl(blockingTab.url) && !await openerStillResponds(cdp, sid)) {
        await releaseBlockedOpener(cdp, sid);
      }
      return { openedTab: blockingTab };
    }
    const mouseOutcome = await mouse;
    const probeTimeout = mouseOutcome?.timedOut ? CLICK_PROBE_READ_AFTER_MOUSE_TIMEOUT_MS : undefined;
    const framed = probeTarget.framed === true;
    const openedInstead = async () => {
      const opened = await openedTabNow(cdp, sid, probeTarget.pagesBeforePromise || null, stuckDeadline);
      if (!opened) return null;
      throwIfUncommittedPopup(opened);
      if (isBlankPageUrl(opened.url) && !await openerStillResponds(cdp, sid)) {
        await releaseBlockedOpener(cdp, sid);
      }
      return opened;
    };
    if (!probe.installed) {
      if (framed) return;
      const opened = await openedInstead();
      if (opened) return { openedTab: opened };
      throw clickNoPageEventsError(x, y, probeTarget.selector, await probePageVisibility(cdp, sid));
    }
    if (probe.scope === 'top' && framed) return;
    const readout = await readClickEventProbe(cdp, sid, probe, probeTimeout);
    if (probe.verifiesTarget) {
      if (readout?.ok && clickProbeSawPageEvent(readout.reached)) return;
      if (!readout?.ok && await clickProbeWipedByNavigation(cdp, sid, probe, navigation.seen)) return;
      if (readout?.ok && clickProbeSawPageEvent(readout.seen)) {
        throw clickMisdirectedError(x, y, probeTarget.selector, {
          sent: true,
          landedOn: readout.landedOn || '',
        });
      }
      const opened = await openedInstead();
      if (opened) return { openedTab: opened };
      throw clickNoPageEventsError(x, y, probeTarget.selector, await probePageVisibility(cdp, sid));
    }
    if (readout?.ok && clickProbeSawPageEvent(readout.seen)) return;
    if (!readout?.ok && await clickProbeWipedByNavigation(cdp, sid, probe, navigation.seen)) return;
    const opened = await openedInstead();
    if (opened) return { openedTab: opened };
    throw clickNoPageEventsError(x, y, probeTarget.selector, await probePageVisibility(cdp, sid));
  } finally {
    navigation.stop();
  }
}
// #447: a same-tab <a href> to a fast page can commit before the probe is read
// back. The read then runs in the new document, where the probe no longer
// exists, which looked exactly like "zero page events". Record main-frame
// commits for this tab's session while the click is dispatched; this costs no
// CDP round trip.
export function watchMainFrameNavigation(cdp, sid) {
  const seen = { navigated: false };
  if (typeof cdp?.onEvent !== 'function') return { seen, stop() {} };
  const off = cdp.onEvent('Page.frameNavigated', (params, msg) => {
    if (!params?.frame || params.frame.parentId) return;
    if (sid && msg?.sessionId && msg.sessionId !== sid) return;
    seen.navigated = true;
  });
  return { seen, stop() { if (typeof off === 'function') off(); } };
}
// Only a probe that vanished counts: a probe that survived with zero events
// means the document was not replaced, so the mouse events really were lost.
// Proof of a navigation is a main-frame Page.frameNavigated during dispatch or,
// for a probe installed in the top document, a changed location.href (covers
// an event that has not been delivered yet). Runs only on the failure path.
export async function clickProbeWipedByNavigation(cdp, sid, probe = {}, seen = {}) {
  if (seen.navigated) return true;
  if (!probe.top || !probe.href) return false;
  const current = await evalPageHref(cdp, sid);
  return Boolean(current) && current !== probe.href;
}
export function isNavigatingHref(href, pageHref = '') {
  const target = String(href || '').trim();
  if (!target) return false;
  const lower = target.toLowerCase();
  if (lower.startsWith('javascript:') || lower.startsWith('mailto:') || lower.startsWith('tel:')) return false;
  if (target.startsWith('#')) return false;
  try {
    const next = new URL(target, pageHref || 'https://example.invalid/');
    if (next.protocol !== 'http:' && next.protocol !== 'https:') return false;
    if (!pageHref) return true;
    return next.href !== new URL(pageHref).href;
  } catch {
    return false;
  }
}
export async function evalPageHref(cdp, sid, timeoutMs = CLICK_HREF_PROBE_TIMEOUT_MS) {
  const requested = Number(timeoutMs);
  const budget = Math.max(1, Number.isFinite(requested) ? requested : CLICK_HREF_PROBE_TIMEOUT_MS);
  let timer;
  try {
    const href = await Promise.race([
      evalStr(cdp, sid, 'location.href', false, { timeoutMs: budget }),
      new Promise(resolve => { timer = setTimeout(() => resolve(''), budget); }),
    ]);
    return String(href || '').trim();
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}
export function rememberSessionTarget(sessionId, targetId) {
  if (sessionId && targetId) SESSION_TARGET_IDS.set(sessionId, targetId);
}
export function forgetSessionTarget(sessionId) {
  SESSION_TARGET_IDS.delete(sessionId);
}
export function clickFollowsHref(target = {}) {
  return String(target.tag || '').toUpperCase() === 'A' && isNavigatingHref(target.href, target.pageHref);
}
// #437: whether following this link opens another browsing context instead of this one.
// `_blank` always does; `_self`/`_parent`/`_top` never do; any other name does unless it
// is this frame's own window name. (A name that matches another open window reuses that
// tab, which findClickOpenedTab also reports.)
export function linkOpensNewBrowsingContext(target = {}) {
  const name = String(target.linkTarget || '').trim();
  if (!name) return false;
  const lower = name.toLowerCase();
  if (lower === '_blank') return true;
  if (lower === '_self' || lower === '_parent' || lower === '_top') return false;
  return name !== String(target.frameName || '');
}
// Page targets via the existing browser-level getPages call (the direct-CDP call-site
// inventory is frozen), bounded by a timer instead of the default CDP timeout.
export async function boundedPageTargets(cdp, timeoutMs) {
  const budget = Math.max(1, Number(timeoutMs) || 1);
  let timer;
  try {
    const pages = await Promise.race([
      getPages(cdp),
      new Promise(resolve => { timer = setTimeout(() => resolve(null), budget); }),
    ]);
    if (!pages) return null;
    return pages.filter(info => info?.targetId);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
// #437: page targets before a click on a link that opens another browsing context, so a
// tab the click opens is recognisable afterwards. Only such links pay this round trip.
export function clickNewTabWatchFromTargets(sid, targetInfos) {
  if (!targetInfos) return null;
  return {
    openerId: SESSION_TARGET_IDS.get(sid) || null,
    pagesBefore: new Map(targetInfos.map(info => [info.targetId, String(info.url || '')])),
  };
}
export async function prepareClickFollowedHref(cdp, sid, target = {}) {
  if (!clickFollowsHref(target) || !linkOpensNewBrowsingContext(target)) return null;
  return clickNewTabWatchFromTargets(sid, await boundedPageTargets(cdp, CLICK_NAVIGATION_WAIT_MS));
}
// #639: a followed link may download instead of navigating. A control that does
// not follow an href may open a tab with window.open. Snapshot page targets
// before the click (the promise starts immediately). Download observation
// listens for Page.downloadWillBegin and does not call Target.getTargets.
// --expect-download keeps its own capture.
export async function beginClickOutsideWatch(cdp, sid, target = {}, opts = {}) {
  const followed = clickFollowsHref(target);
  let downloadWatch = null;
  if (followed && opts.captureDownload !== true && typeof cdp?.onEvent === 'function') {
    downloadWatch = await armClickDownloadWatch(clickDownloadBrowser(cdp, sid, SESSION_TARGET_IDS.get(sid) || ''));
  }
  const pagesBeforePromise = followed ? null : boundedPageTargets(cdp, CLICK_NAVIGATION_WAIT_MS);
  const newTabWatch = followed ? await prepareClickFollowedHref(cdp, sid, target) : null;
  return {
    downloadWatch,
    pagesBeforePromise,
    newTabWatch,
    captureDownload: opts.captureDownload === true,
    async stop() {
      if (downloadWatch) await downloadWatch.stop();
    },
  };
}
export function createPageTargetFeed(cdp) {
  let inflight = null;
  return async function take(budget) {
    if (!inflight) {
      inflight = getPages(cdp).then(
        pages => (Array.isArray(pages) ? pages.filter(info => info?.targetId) : null),
        () => null,
      ).finally(() => { inflight = null; });
    }
    const current = inflight;
    let timer;
    try {
      const raced = await Promise.race([
        current.then(pages => ({ ready: true, pages })),
        new Promise(resolve => {
          timer = setTimeout(() => resolve({ ready: false }), Math.max(1, Number(budget) || 1));
        }),
      ]);
      return raced.ready ? raced.pages : null;
    } finally {
      clearTimeout(timer);
    }
  };
}
export function popupWatchFromBefore(sid, before) {
  if (before) return { watch: clickNewTabWatchFromTargets(sid, before), haveBefore: true };
  const openerId = SESSION_TARGET_IDS.get(sid) || null;
  if (!openerId) return { watch: null, haveBefore: false };
  return { watch: { openerId, pagesBefore: new Map() }, haveBefore: false };
}
export function findUncommittedOwnedPopup(targetInfos, watch) {
  const pageUrl = watch?.pagesBefore?.get?.(watch.openerId) || '';
  for (const info of targetInfos || []) {
    if (!watch?.openerId || info.openerId !== watch.openerId) continue;
    if (info.targetId === watch.openerId) continue;
    if (!isUncommittedPageUrl(info.url)) continue;
    if (watch.pagesBefore?.get?.(info.targetId) !== undefined) continue;
    return { targetId: info.targetId, url: '', existing: false, pageUrl };
  }
  return null;
}
export function openedPopupFromPages(pages, watch, haveBefore) {
  if (!pages || !watch) return null;
  if (haveBefore) return findClickOpenedTab(pages, watch, '');
  return findUncommittedOwnedPopup(pages, watch);
}
export async function openedTabAfterClick(cdp, sid, pagesBeforePromise) {
  return openedTabNow(cdp, sid, pagesBeforePromise);
}
// A new target this tab opened. An empty URL is the initial document of
// window.open(url), before the navigation commits. Keep polling that target
// until it has a URL. A committed about:blank is returned as itself.
export async function openedTabNow(cdp, sid, pagesBeforePromise, stuckDeadline = 0) {
  if (!pagesBeforePromise) return null;
  const before = await pagesBeforePromise;
  const { watch, haveBefore } = popupWatchFromBefore(sid, before);
  if (!watch?.openerId) return null;
  const deadlines = { commit: 0, nav: 0, stuckDeadline, openerChecked: false };
  const popupWatch = createPopupCommitWatch();
  const poll = createPageTargetFeed(cdp);
  let opened = null;
  try {
    let idleDeadline = Date.now() + CLICK_NAVIGATION_WAIT_MS;
    for (;;) {
      const now = Date.now();
      const waiting = now <= idleDeadline
        || (deadlines.commit && now < deadlines.commit)
        || (deadlines.nav && now < deadlines.nav);
      const pages = waiting || (opened && openedTabUncommitted(opened))
        ? await poll(250)
        : null;
      if (pages) opened = openedPopupFromPages(pages, watch, haveBefore);
      if (opened && !openedTabUncommitted(opened)) return opened;
      if (opened && popupWatch.committed && popupWatch.url) return { ...opened, url: popupWatch.url };
      if (opened && openedTabUncommitted(opened)) {
        const decision = await considerUncommittedPopup(cdp, sid, opened, popupWatch, deadlines);
        if (decision.done) return decision.done;
        idleDeadline = Math.max(idleDeadline, deadlines.commit || 0, deadlines.nav || 0);
      }
      const limit = Math.max(idleDeadline, deadlines.commit || 0, deadlines.nav || 0);
      if (Date.now() >= limit) break;
      await sleep(Math.min(40, limit - Date.now()));
    }
    return opened;
  } finally {
    await popupWatch.stop();
  }
}
// While the mouse ack is still outstanding, a new opener-owned target means
// window.open already ran. A healthy ack lands well inside the grace, so this
// returns null and the probe still runs. An empty URL is not a committed
// about:blank. If that popup has started an http(s) navigation, wait for the
// commit instead of calling the opener dead. A committed about:blank that
// outlives the grace is the blocked-opener case.
export async function openedTabBlockingDispatch(cdp, sid, pagesBeforePromise, mousePromise, stuckDeadline = 0) {
  if (!pagesBeforePromise) return null;
  let settled = false;
  mousePromise.then(() => { settled = true; }, () => { settled = true; });
  const before = await pagesBeforePromise;
  const { watch, haveBefore } = popupWatchFromBefore(sid, before);
  if (!watch?.openerId) return null;
  const mouseDeadline = Date.now() + CLICK_MOUSE_ACK_TIMEOUT_MS;
  const deadlines = { commit: 0, nav: 0, stuckDeadline, openerChecked: false };
  const popupWatch = createPopupCommitWatch();
  const poll = createPageTargetFeed(cdp);
  let blankSince = 0;
  let lastUncommitted = null;
  try {
    for (;;) {
      const now = Date.now();
      const open = now < mouseDeadline
        || (deadlines.commit && now < deadlines.commit)
        || (deadlines.nav && now < deadlines.nav);
      // The last sleep lands on the deadline. One more look decides the popup
      // instead of handing an empty URL back to the probe for another wait.
      if (!open && !lastUncommitted) return null;
      const pages = await poll(250);
      const found = openedPopupFromPages(pages, watch, haveBefore);
      if (found && !isBlankPageUrl(found.url)) return found;
      if (found && popupWatch.committed && popupWatch.url) return { ...found, url: popupWatch.url };
      if (found && isUncommittedPageUrl(found.url)) {
        blankSince = 0;
        lastUncommitted = found;
        const decision = await considerUncommittedPopup(cdp, sid, found, popupWatch, deadlines);
        if (decision.done) return decision.done;
      } else if (found) {
        lastUncommitted = null;
        if (!blankSince) blankSince = Date.now();
        if (Date.now() - blankSince >= CLICK_OPENER_BLOCK_GRACE_MS) return found;
      } else {
        blankSince = 0;
        lastUncommitted = null;
        if ((settled || Date.now() >= mouseDeadline) && !deadlines.commit && !deadlines.nav) return null;
      }
      const limit = Math.max(mouseDeadline, deadlines.commit || 0, deadlines.nav || 0);
      if (Date.now() >= limit) {
        if (!lastUncommitted) return null;
        const decision = await considerUncommittedPopup(cdp, sid, lastUncommitted, popupWatch, deadlines);
        if (decision.done) return decision.done;
      }
      const pause = Math.min(40, limit - Date.now());
      if (pause > 0) await sleep(pause);
    }
  } finally {
    await popupWatch.stop();
  }
}
export function clickDeliveryMissedPage(error) {
  return /no mousedown\/click events/i.test(String(error?.message || '')) && !error?.crossOriginFrame;
}
export function retainLateClickDownloadWatch(cdp, outside) {
  const watch = outside?.downloadWatch;
  if (!watch?.armed || !cdp) return;
  const previous = cdp.lateClickDownloadWatch;
  if (previous && previous !== watch) previous.stop?.();
  cdp.lateClickDownloadWatch = watch;
  outside.downloadWatch = null;
}
// Page.downloadWillBegin can arrive while post-click settle is still running.
// The click's own poll has already given up by then. Keep that listener and
// read it once the receipt is about to be built.
export async function applyLateClickDownload(cdp, actionResult) {
  const watch = cdp?.lateClickDownloadWatch || null;
  if (!watch) return;
  cdp.lateClickDownloadWatch = null;
  const text = String(actionResult?.target?.dispatchText || '');
  try {
    const begin = await watch.poll();
    if (!begin) return;
    const filename = safeDownloadFilename(begin.suggestedFilename || 'download');
    actionResult.effects = actionResult.effects || {};
    actionResult.effects.download = { state: 'started', filename };
    const phrase = '; the link asks for a download and no download event was observed';
    if (text.includes(phrase)) {
      actionResult.target.dispatchText = text.replace(phrase, ` → download started "${filename}"`);
    } else if (!text.includes('download started')) {
      const input = actionResult.target?.input ? ` ${actionResult.target.input}` : '';
      actionResult.target.dispatchText = `Clicked${input} → download started "${filename}"`;
    }
    if (actionResult.effects.failure) delete actionResult.effects.failure;
    if (actionResult.dispatch) {
      actionResult.dispatch.ok = true;
      delete actionResult.dispatch.error;
    }
    if (actionResult.settle) actionResult.settle.ok = true;
  } finally {
    await watch.stop();
  }
}
export async function observeClickOutsideDocument(cdp, sid, point, probeTarget, target, opts = {}) {
  const outside = await beginClickOutsideWatch(cdp, sid, target, opts);
  let retainWatch = false;
  try {
    let dispatched;
    try {
      dispatched = await dispatchClick(cdp, sid, point.x, point.y, {
        ...probeTarget,
        pagesBeforePromise: outside.pagesBeforePromise,
      });
    } catch (error) {
      if (clickDeliveryMissedPage(error)) {
        const opened = await openedTabNow(cdp, sid, outside.pagesBeforePromise);
        throwIfUncommittedPopup(opened);
        if (opened) return formatOutsideClickSuffix({ openedTab: opened }, null);
        if (outside.downloadWatch?.armed) {
          retainLateClickDownloadWatch(cdp, outside);
          retainWatch = true;
        }
      }
      throw error;
    }
    if (dispatched?.openedTab) {
      throwIfUncommittedPopup(dispatched.openedTab);
      return formatOutsideClickSuffix({ openedTab: dispatched.openedTab }, dispatched.childFrame);
    }
    const followed = await confirmClickFollowedHref(cdp, sid, target, outside.newTabWatch, outside);
    const opened = !followed && outside.pagesBeforePromise
      ? await openedTabAfterClick(cdp, sid, outside.pagesBeforePromise)
      : null;
    throwIfUncommittedPopup(opened);
    const merged = followed || (opened ? { openedTab: opened } : null);
    const suffix = formatOutsideClickSuffix(merged, dispatched?.childFrame);
    if (outside.downloadWatch?.armed && suffix.includes('no download event was observed')) {
      retainLateClickDownloadWatch(cdp, outside);
      retainWatch = true;
    }
    return suffix;
  } finally {
    if (!retainWatch) await outside.stop();
  }
}
// A new page target opened by this tab (or showing the link URL), or a tab that existed
// before the click and now shows the link URL (a named target reusing that window).
export function findClickOpenedTab(targetInfos, watch, href) {
  const pageUrl = watch?.pagesBefore?.get?.(watch.openerId) || '';
  for (const info of targetInfos || []) {
    const url = String(info.url || '');
    const before = watch.pagesBefore.get(info.targetId);
    if (before === undefined) {
      const opener = Boolean(watch.openerId) && info.openerId === watch.openerId;
      if (opener || navigationDestinationMatches(url, href)) {
        return { targetId: info.targetId, url: clickOpenedTabUrl(url, href), existing: false, pageUrl };
      }
    } else if (info.targetId !== watch.openerId && before !== url && navigationDestinationMatches(url, href)) {
      return { targetId: info.targetId, url, existing: true, pageUrl };
    }
  }
  return null;
}
export function clickOpenedTabUrl(url, href) {
  if (!isBlankPageUrl(url)) return url;
  const fallback = String(href || '').trim();
  if (fallback) return fallback;
  // An empty target URL has not committed. Do not rewrite it to about:blank:
  // that reported a still-loading window.open(url) as a successful blank tab.
  return String(url || '').trim();
}
export function formatClickOpenedTab(opened) {
  if (!opened) return '';
  return ` → ${opened.existing ? 'opened in tab' : 'opened new tab'} ${targetPrefixForDisplay(opened.targetId)} ${opened.url}`;
}
export function parseClickOpenedTab(text) {
  const match = String(text || '').match(CLICK_OPENED_TAB_RE);
  if (!match) return null;
  return { targetPrefix: match[2], url: match[3], existing: match[1] === 'in tab' };
}
export function parseChildFrameClick(text) {
  const match = String(text || '').match(CHILD_FRAME_CLICK_RE);
  if (!match) return null;
  return {
    observed: match[1] !== 'unobserved',
    delivered: match[1] === 'delivered',
    href: match[2] || '',
  };
}
export function parseClickDownloadStarted(text) {
  const match = String(text || '').match(CLICK_DOWNLOAD_STARTED_RE);
  if (!match) return null;
  return { state: 'started', filename: match[1] };
}
export function clickDispatchEffects(action, dispatchText) {
  const name = String(action || '').toLowerCase();
  if (name !== 'click' && name !== 'jsclick' && name !== 'clickxy') return {};
  const effects = {};
  const openedTab = parseClickOpenedTab(dispatchText);
  if (openedTab) effects.openedTab = openedTab;
  const childFrame = parseChildFrameClick(dispatchText);
  if (childFrame) effects.childFrame = childFrame;
  const started = parseClickDownloadStarted(dispatchText);
  if (started) effects.download = started;
  else if (CLICK_DOWNLOAD_UNOBSERVED_RE.test(String(dispatchText || ''))) {
    effects.download = { state: 'unobserved' };
  }
  return effects;
}
export function formatOutsideClickSuffix(followed, childFrame) {
  let suffix = '';
  if (followed?.download?.filename) suffix += ` → download started "${followed.download.filename}"`;
  else if (followed?.downloadUnobserved) suffix += '; the link asks for a download and no download event was observed';
  else suffix += formatClickOpenedTab(followed?.openedTab);
  suffix += formatChildFrameClickSuffix(childFrame);
  return suffix;
}
// Returns null when the click is not a followed link, { url } after this tab navigated,
// or { openedTab } when the link opened (or reused) another tab (#437). Throws when a
// followed link did neither within CLICK_NAVIGATION_WAIT_MS.
export async function confirmClickFollowedHref(cdp, sid, target = {}, newTabWatch = null, outside = null) {
  if (!clickFollowsHref(target)) return null;
  const downloadWatch = outside?.downloadWatch?.armed ? outside.downloadWatch : null;
  const captureDownload = outside?.captureDownload === true;
  const before = String(target.pageHref || '');
  const deadline = Date.now() + CLICK_NAVIGATION_WAIT_MS;
  const downloadFromWatch = async () => {
    if (!downloadWatch) return null;
    const begin = await downloadWatch.poll();
    if (!begin) return null;
    return { download: { filename: safeDownloadFilename(begin.suggestedFilename || 'download') } };
  };
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const probeMs = Math.min(CLICK_HREF_PROBE_TIMEOUT_MS, remaining);
    const [current, pages] = await Promise.all([
      evalPageHref(cdp, sid, probeMs),
      newTabWatch ? boundedPageTargets(cdp, probeMs) : null,
    ]);
    if (current && current !== before) return { url: current };
    const download = await downloadFromWatch();
    if (download) return download;
    const openedTab = newTabWatch ? findClickOpenedTab(pages, newTabWatch, target.href) : null;
    if (openedTab) return { openedTab };
    const pause = Math.min(40, deadline - Date.now());
    if (pause > 0) await sleep(pause);
  }
  const download = await downloadFromWatch();
  if (download) return download;
  // A download attribute that produced no event still must not be retried: the
  // browser may have saved the file without a CDP event. --expect-download keeps
  // the throw so its own watcher can decide.
  if (target.downloadAttr === true && !captureDownload) {
    return { downloadUnobserved: true };
  }
  if (newTabWatch) {
    const linkTarget = String(target.linkTarget || '').trim();
    // A named target whose window already shows the link URL is reloaded in place, which
    // leaves no trace in the target list. Name that tab instead of guessing either way.
    const sameUrlTab = linkTarget.toLowerCase() === '_blank'
      ? null
      : [...newTabWatch.pagesBefore].find(([id, url]) => id !== newTabWatch.openerId
        && navigationDestinationMatches(url, target.href))?.[0];
    const reloadHint = sameUrlTab
      ? `; tab ${targetPrefixForDisplay(sameUrlTab)} already shows that URL and may have reloaded it (cdp perceive ${targetPrefixForDisplay(sameUrlTab)} -C -d 8)`
      : '';
    throw new Error(
      `Click on <A href="${target.href}" target="${linkTarget}"> did not navigate and no new tab opened${reloadHint}. Try jsclick or click --js.`
    );
  }
  throw new Error(
    `Click on <A href="${target.href}"> did not navigate. Try jsclick or click --js.`
  );
}
// Shared: get device pixel ratio
export async function getDpr(cdp, sid) {
  try {
    const raw = await evalStr(cdp, sid, 'window.devicePixelRatio');
    const parsed = parseFloat(raw);
    if (parsed > 0) return parsed;
  } catch {}
  return 1;
}
export async function resolveSelectorNode(cdp, sid, selector) {
  if (!selector) throw new Error('CSS selector required');
  try { await cdpDomains(cdp).DOM.enable( {}, sid); } catch {}
  const { root } = await cdpDomains(cdp).DOM.getDocument( {}, sid);
  let result;
  try {
    result = await cdpDomains(cdp).DOM.querySelector( { nodeId: root.nodeId, selector }, sid);
  } catch (e) {
    throw new Error(`Invalid selector: ${selector}. ${e.message}`);
  }
  if (!result.nodeId) throw new Error('Element not found: ' + selector);
  const { object } = await cdpDomains(cdp).DOM.resolveNode( { nodeId: result.nodeId }, sid);
  return object.objectId;
}
// A word is a tag selector only when it is a known element name. `Save` is a label;
// `button` and a hyphenated custom element stay selectors. Compared lowercased.
const HTML_TAG_NAMES = new Set(`
a abbr address area article aside audio b base bdi bdo blockquote body br button canvas caption cite code col colgroup data datalist dd del details dfn dialog div dl dt em embed fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 head header hgroup hr html i iframe img input ins kbd label legend li link main map mark menu meta meter nav noscript object ol optgroup option output p picture pre progress q rp rt ruby s samp script search section select slot small source span strong style sub summary sup table tbody td template textarea tfoot th thead time title tr track u ul var video wbr
svg g path circle rect ellipse line polyline polygon text tspan textpath use image defs symbol marker clippath mask pattern lineargradient radialgradient stop filter foreignobject switch desc
`.trim().split(/\s+/));
function isCssTypeSelector(token) {
  if (!/^[A-Za-z][\w-]*$/.test(token)) return false;
  if (token.includes('-')) return true;
  return HTML_TAG_NAMES.has(token.toLowerCase());
}
// Compounds split on whitespace and > + ~, not inside [], (), or quotes.
function cssCompounds(selector) {
  const parts = [];
  let current = '';
  let square = 0;
  let paren = 0;
  let quote = '';
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i];
    if (quote) {
      current += ch;
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '[') { square += 1; current += ch; continue; }
    if (ch === ']' && square > 0) { square -= 1; current += ch; continue; }
    if (ch === '(') { paren += 1; current += ch; continue; }
    if (ch === ')' && paren > 0) { paren -= 1; current += ch; continue; }
    if (square === 0 && paren === 0 && (ch === '>' || ch === '+' || ch === '~' || /\s/.test(ch))) {
      if (current.trim()) parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}
function isPlausibleCssCompound(compound) {
  const start = compound[0];
  if (start === '#' || start === '.' || start === '[' || start === '*' || start === ':') return true;
  const match = compound.match(/^([A-Za-z][\w-]*)([\s\S]*)$/);
  if (!match || !isCssTypeSelector(match[1])) return false;
  return match[2] === '' || /^[#.[:]/.test(match[2]);
}
export function isLikelyCssSelector(value) {
  const selector = String(value || '').trim();
  if (!selector) return false;
  const compounds = cssCompounds(selector);
  return compounds.length > 0 && compounds.every(isPlausibleCssCompound);
}
// `text="a  b"` keeps the inner spaces. An unquoted tail keeps its own leading and trailing space.
// One balanced wrapping quote pair is syntax, not part of the label.
export function textSelectorName(value) {
  const text = String(value ?? '');
  const match = text.match(/^\s*text=/i);
  if (!match) return null;
  const raw = text.slice(match[0].length);
  const quoted = raw.trim().match(/^(["'])([\s\S]*)\1$/);
  return quoted ? quoted[2] : raw;
}
export function namedClickQueryName(value) {
  const fromText = textSelectorName(value);
  return fromText == null ? String(value ?? '') : fromText;
}
// A quote that opens the target and never closes is an error. A quote inside the
// label (`O'Brien`, `don't`) is text. A balanced wrapper stays in a plain label.
export function assertClosedClickTarget(value) {
  const text = String(value ?? '').trim().replace(/^text=/i, '');
  const quote = text[0];
  if (quote !== '"' && quote !== "'") return;
  for (let i = 1; i < text.length; i++) {
    if (text[i] === quote) return;
  }
  const example = quote === '"' ? "'abc'" : '"abc"';
  throw new Error(`click: unclosed quote in target (${text}). Close the ${quote} quote, for example ${example}.`);
}
export function isNamedClickQuery(value) {
  const selector = String(value || '').trim();
  if (!selector) return false;
  if (TEXT_SELECTOR_PREFIX_RE.test(selector)) return true;
  if (isRef(selector) || isCursorRef(selector)) return false;
  return !isLikelyCssSelector(selector);
}
// #427: a CSS miss says what to try instead. A bare HTML tag (`button`) parses as a tag
// selector, so point at the text= form that forces a visible-text lookup.
export function cssClickMissMessage(selector, error) {
  const text = String(error || '');
  if (!text.startsWith('Element not found')) return text;
  const bareWord = /^[A-Za-z][\w-]*$/.test(String(selector || '').trim());
  return bareWord
    ? `${text}. "${selector}" was read as a CSS tag selector; for a button or link with that visible text use "text=${selector}", or an @ref from perceive.`
    : `${text}. No element matches this CSS selector; pass the control's visible text or an @ref from perceive.`;
}
// #436: the real mouse event goes to whatever is on top at the click point. When that is not the
// target (see clickPointHitFunctionSource), fail before dispatch and name the covering element,
// instead of sending the click into it and reporting `Clicked <target>`.
function crossSiteListed(cdp, sid, selector, refState) {
  const parsed = parseFrameRef(selector);
  if (!parsed || !refState?.frameRefs?.get) return null;
  const entry = refState.frameRefs.get(parsed.frameRef);
  if (!entry) return null;
  const listedByRef = Array.isArray(entry.frames) && entry.frames.some(frame => frame?.ref === parsed.frameRef && frame.process === 'oopif');
  if (entry.process !== 'oopif' && !listedByRef) return null;
  const listed = listedFrame(cdp, sid, entry.frameId) || listedFrame(cdp, sid, parsed.frameRef);
  const rawOrigin = listed?.securityOrigin || '';
  return {
    host: originHost(rawOrigin),
    origin: frameContentOrigin(rawOrigin),
    rawOrigin: rawOrigin || frameContentOrigin(rawOrigin),
  };
}

function crossSitePageBlock(facts, text) {
  const label = String(text || '').replace(/\s+/g, ' ').trim();
  if (!facts || !label) return '';
  return `\n${wrapFrameContent(label, { origin: facts.origin })}`;
}

export function assertClickPointNotCovered(hit, { x, y, tag, text, ref = '', crossSiteHost = null, coverScope = '', frameOrigin = '' } = {}) {
  if (!hit || hit.covered !== true) return;
  const label = String(text || '').replace(/\s+/g, ' ').trim();
  const crossSite = coverScope === 'page' || coverScope === 'frame';
  const target = crossSite
    ? formatCrossSiteTarget({ tag, ref, host: crossSiteHost || '' })
    : `<${tag || '?'}>${label ? ` "${label}"` : ''}${ref ? ` (${ref})` : ''}`;
  let by = !hit.within && (hit.byPosition === 'fixed' || hit.byPosition === 'sticky')
    ? `position:${hit.byPosition} ${hit.by}`
    : String(hit.by || '<unknown>');
  if (crossSite && coverScope === 'page') by = by.replace(/\s+"[^"]*"/g, '');
  else if (crossSite && coverScope === 'frame') {
    const tagMatch = /<([A-Za-z0-9]+)/.exec(String(hit.by || by));
    by = tagMatch ? `<${tagMatch[1]}> ` : '<unknown> ';
  }
  const within = hit.within ? ` (inside position:${hit.withinPosition} ${hit.within})` : '';
  const recentred = hit.recentred ? ' (also after scrolling to centre)' : '';
  // #551: the target's scroll container cuts it off at the click point.
  const clipped = hit.clipped ? ', clipped by its scroll container,' : '';
  const point = `(${Math.round(Number(x) || 0)},${Math.round(Number(y) || 0)})`;
  const err = new Error(`click not sent: ${target} at ${point}${clipped} is covered by ${by}${within}${recentred}.`);
  if (crossSite && label) err.frameContentBlock = wrapFrameContent(label, { origin: frameContentOrigin(frameOrigin) });
  err.clickCovered = {
    by: String(hit.by || ''),
    within: hit.within || null,
    withinPosition: hit.withinPosition || null,
    byPosition: hit.byPosition || null,
    dialog: hit.dialog === true,
    recentred: hit.recentred === true,
    clipped: hit.clipped === true,
    large: hit.large === true,
  };
  throw err;
}
export function namedClickMissMessage(input, error) {
  const text = String(error || '');
  const name = namedClickQueryName(input);
  const from = textSelectorName(input) == null ? '' : ` (from ${String(input).trim()})`;
  if (text.startsWith('Named control not found')) {
    return `Named control not found: ${JSON.stringify(name)}${from}. No button, link, tab, radio or label has that exact visible text or aria-label; pass the exact visible text or an @ref from perceive.`;
  }
  if (text.startsWith('Named control is not unique')) {
    return `Named control is not unique and none are in the viewport: ${JSON.stringify(name)}${from}. Pick one by @ref from perceive.`;
  }
  return text;
}
export function clickFeedbackPolicy(selector, maybeName) {
  const query = selector === '--js' || selector === '-j' ? maybeName : selector;
  return isNamedClickQuery(query) ? 'report-only' : 'settle-diff';
}
export function jsclickFeedbackPolicy(selector) {
  return clickFeedbackPolicy(selector);
}
export function namedClickActionTarget(input, extra = {}) {
  const named = isNamedClickQuery(input);
  const target = {
    input: extra.input ?? input,
    resolvedBy: extra.resolvedBy ?? (named ? 'name' : 'selector-or-ref'),
    label: extra.label ?? (input || ''),
    commandArgs: extra.commandArgs ?? [input],
  };
  if (extra.targetId) target.targetId = extra.targetId;
  if (named) target.expectedOutcome = NAMED_IN_VIEWPORT_CLICK_OUTCOME;
  return target;
}
// Page-side mark so the resolved node can be clicked by objectId. A string key
// survives the evaluate that set it; it is removed before the pointer events.
const NAMED_CLICK_MARK = 'chrome-cdp-ex.named-click';
export function namedClickMarkReaderDeclaration() {
  return `function() {
    const mark = ${JSON.stringify(NAMED_CLICK_MARK)};
    const meta = this[mark] || null;
    try { delete this[mark]; } catch (err) {}
    return meta;
  }`;
}
export function namedInViewportClickExpression(name, { checkCover = false, resolveOnly = false } = {}) {
  const wanted = String(name ?? '');
  const coverCheck = checkCover ? `
    ${clickPointHitFunctionSource()}
    const hitBox = () => {
      const box = el.getBoundingClientRect();
      return { x: box.x, y: box.y, w: box.width, h: box.height };
    };
    const fullyInView = (box) => box.w > 0 && box.h > 0 && box.x >= 0 && box.y >= 0 && box.x + box.w <= vw && box.y + box.h <= vh;
    let point = hitBox();
    let hit = clickPointHit(el, point);
    if (hit && hit.covered && fullyInView(point)) {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      point = hitBox();
      hit = clickPointHit(el, point);
      if (hit && hit.covered) hit.recentred = true;
    }
    if (hit && hit.covered) {
      return JSON.stringify({
        ok: false,
        covered: true,
        hit,
        tag: el.tagName,
        text: labelOf(el).substring(0, 80),
        x: point.x + point.w / 2,
        y: point.y + point.h / 2,
      });
    }` : '';
  return `(function() {
    /* chrome-cdp-ex.named-in-viewport-click */
    const wanted = ${JSON.stringify(wanted)};
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const inViewport = (el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < vh && rect.left < vw;
    };
    const fieldsOf = (el) => [
      typeof el.getAttribute === 'function' ? el.getAttribute('aria-label') : null,
      el.innerText,
      el.textContent,
      typeof el.getAttribute === 'function' ? el.getAttribute('title') : null,
    ];
    const exactField = (el) => {
      for (const field of fieldsOf(el)) {
        if (field != null && String(field) === wanted) return String(field);
      }
      return null;
    };
    const normalizedField = (el) => {
      const wantedNorm = normalize(wanted);
      if (!wantedNorm) return null;
      for (const field of fieldsOf(el)) {
        if (field != null && normalize(field) === wantedNorm) return String(field);
      }
      return null;
    };
    const labelOf = (el) => {
      const exact = exactField(el);
      if (exact != null) return exact;
      const fuzzy = normalizedField(el);
      return fuzzy == null ? '' : normalize(fuzzy);
    };
    const containsMatch = (ancestor, node) => {
      let parent = node && node.parentNode;
      while (parent) {
        if (parent === ancestor) return true;
        parent = parent.parentNode;
      }
      return false;
    };
    // One visual control can match twice (a tab wrapping a button, a label wrapping a radio).
    // Keep the innermost so that pair is one target.
    const innermost = (list) => list.filter(el => !list.some(other => other !== el && containsMatch(el, other)));
    const nodes = Array.from(document.querySelectorAll(${JSON.stringify(NAMED_IN_VIEWPORT_CLICK_SELECTOR)}));
    const tagOf = (el) => String(el && el.tagName || '').toUpperCase();
    // A field label usually precedes the button it names. A label with role=button,
    // role=link, role=tab, or role=radio is that control and stays in the primary
    // list, ranked with any other element of that role. A label with no role is used
    // only when no primary match exists, and only when its control is a radio or
    // checkbox (an antd Segmented item is that label). Prefer HTMLLabelElement.control;
    // otherwise resolve for= or the first labelable descendant.
    const labelControl = (el) => {
      if (!el || tagOf(el) !== 'LABEL') return null;
      if ('control' in el) return el.control && el.control.nodeType === 1 ? el.control : null;
      const forId = typeof el.getAttribute === 'function' ? el.getAttribute('for') : '';
      if (forId) {
        const doc = el.ownerDocument;
        const found = doc && typeof doc.getElementById === 'function' ? doc.getElementById(forId) : null;
        return found && found.nodeType === 1 ? found : null;
      }
      return typeof el.querySelector === 'function'
        ? el.querySelector('input, select, textarea, button, meter, output, progress')
        : null;
    };
    const checkableLabel = (el) => {
      const control = labelControl(el);
      if (!control || tagOf(control) !== 'INPUT') return false;
      const type = String(control.type || '').toLowerCase();
      return type === 'radio' || type === 'checkbox';
    };
    const roleOf = (el) => {
      const role = typeof el.getAttribute === 'function' ? el.getAttribute('role') : '';
      return role || '';
    };
    const explicitControlRole = (el) => {
      const role = roleOf(el);
      return role === 'button' || role === 'link' || role === 'tab' || role === 'radio';
    };
    const rank = (list) => {
      const exact = innermost(list.filter(el => exactField(el) != null));
      return exact.length ? exact : innermost(list.filter(el => normalizedField(el) != null));
    };
    const primaryNamed = rank(nodes.filter(el => tagOf(el) !== 'LABEL' || explicitControlRole(el)));
    const named = primaryNamed.length
      ? primaryNamed
      : rank(nodes.filter(el => tagOf(el) === 'LABEL' && roleOf(el) === '' && checkableLabel(el)));
    const visible = named.filter(inViewport);
    const scrollYBefore = Math.round(window.scrollY || 0);
    let el = visible[0] || null;
    const offscreen = !el;
    if (offscreen) {
      if (!named.length) return JSON.stringify({ ok: false, error: 'Named control not found: ' + wanted });
      if (named.length !== 1) {
        return JSON.stringify({
          ok: false,
          error: 'Named control is not unique and none are in the viewport: ' + wanted,
        });
      }
      el = named[0];
    }
    // #742: HTMLElement.click() fires nothing on a :disabled control, so do not claim a click,
    // and do not scroll to a control that will not be clicked.
    ${actionabilityFunctionSource()}
    const disabledReason = actionDisabledReason(el, false);
    if (disabledReason) {
      return JSON.stringify({ ok: false, disabled: { tag: el.tagName, text: labelOf(el).substring(0, 80), reason: disabledReason } });
    }
    let scrolled = false;
    if (offscreen) {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      scrolled = true;
    }
    ${coverCheck}
    const rect = el.getBoundingClientRect();
    const href = el.href || el.getAttribute('href') || null;
    const linkTarget = ${linkTargetPageExpression('el')};
    const frameName = ${linkFrameNamePageExpression('el')};
    const pageHref = location.href;
    const meta = {
      ok: true,
      tag: el.tagName,
      text: labelOf(el).substring(0, 80),
      href,
      linkTarget,
      frameName,
      pageHref,
      role: (typeof el.getAttribute === 'function' ? el.getAttribute('role') : '') || '',
      x: rect.x,
      y: rect.y,
      w: rect.width,
      h: rect.height,
      scrolled,
      scrollYBefore,
      scrollYAfter: Math.round(window.scrollY || 0),
    };
    ${resolveOnly ? `
    try { el[${JSON.stringify(NAMED_CLICK_MARK)}] = meta; } catch (err) {}
    return el;` : `
    if (typeof el.click === 'function') el.click();
    else el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return JSON.stringify(meta);`}
  })()`;
}
export function rememberClickTrust(holder, { tag = '', role = '' } = {}) {
  if (!holder || typeof holder !== 'object') return;
  const nextTag = String(tag || '').toUpperCase();
  const nextRole = String(role || '').toLowerCase();
  if (nextTag) holder.tag = nextTag;
  if (nextRole && nextRole !== 'null') holder.role = nextRole;
}
// #437: snapshot page targets before the in-page click. CDP handles one connection's
// messages in order, so the snapshot is the tabs from before the click and adds no
// round trip; it is awaited only for a link that opens another browsing context.
// `note` is extra receipt text after the label (the zero-box fallback).
async function namedInPageClickReceipt(cdp, sid, performClick, note = '') {
  const pagesBefore = boundedPageTargets(cdp, CLICK_NAVIGATION_WAIT_MS);
  const meta = await performClick();
  const newTabWatch = clickFollowsHref(meta) && linkOpensNewBrowsingContext(meta)
    ? clickNewTabWatchFromTargets(sid, await pagesBefore)
    : null;
  const followed = await confirmClickFollowedHref(cdp, sid, meta, newTabWatch);
  const line = `JS-clicked <${meta.tag || '?'}> "${meta.text || ''}"${note}${formatClickOpenedTab(followed?.openedTab)}`;
  const scrollLine = meta.scrolled
    ? `\nScroll: ${meta.scrollYBefore} → ${meta.scrollYAfter}`
    : '';
  return followed?.url ? `${line}${scrollLine}\nURL: ${followed.url}` : `${line}${scrollLine}`;
}
export async function namedInViewportJsClickStr(cdp, sid, input, clickTrust = null, { checkCover = false } = {}) {
  assertClosedClickTarget(input);
  const name = namedClickQueryName(input);
  if (!String(name).trim()) {
    throw new Error(`${String(input).trim()} has no visible text to match. Pass the button or link text, e.g. click <target> "text=Save", or an @ref from perceive.`);
  }
  return namedInPageClickReceipt(cdp, sid, async () => {
    const result = await evalStr(cdp, sid, namedInViewportClickExpression(name, { checkCover }));
    const parsed = JSON.parse(result);
    if (parsed.covered === true) {
      assertClickPointNotCovered(parsed.hit, { x: parsed.x, y: parsed.y, tag: parsed.tag, text: parsed.text });
    }
    if (!parsed.ok && parsed.disabled) throw actionDisabledError('click', parsed.disabled, input);
    if (!parsed.ok) throw new Error(namedClickMissMessage(input, parsed.error));
    rememberClickTrust(clickTrust, { tag: parsed.tag, role: parsed.role });
    return parsed;
  });
}
// JS-fallback click: uses HTMLElement.click() / dispatchEvent in the page
// instead of CDP Input.dispatchMouseEvent. Useful when the page intercepts
// real-pointer events with overlays, has misaligned hit testing under custom
// transforms, or when an MUD/game UI binds handlers only to synthetic clicks.
// This path is intentionally separate from clickStr — agents opt into it via
// `jsclick` or `click --js` so the default behaviour stays a realistic mouse
// dispatch. A named `click` is a pointer click; only these opt-ins keep the
// in-page click. Off-screen unique names scrollIntoView, then el.click().
export async function jsClickStr(cdp, sid, selector, refMap, refState, options = {}) {
  const pointer = options.pointer === true;
  if (!selector) throw new Error('CSS selector, @ref, or accessible name required');
  assertClosedClickTarget(selector);
  if (isNamedClickQuery(selector)) {
    if (pointer) {
      throw new Error('click --pointer needs a CSS selector or @ref, not an accessible name. Run `perceive` to get an @ref.');
    }
    return namedInViewportJsClickStr(cdp, sid, selector, options.clickTrust);
  }
  const objectId = isRef(selector)
    ? await resolveRefNode(cdp, sid, refMap, selector, refState, { allowCrossSite: true })
    : await resolveSelectorNode(cdp, sid, selector);
  const nodeSid = resolvedNodeSession(cdp, sid, objectId);
  const facts = isRef(selector) ? crossSiteListed(cdp, sid, selector, refState) : null;
  try {
    const res = await cdpDomains(cdp).Runtime.callFunctionOn( {
      objectId,
      functionDeclaration: pointer ? pointerClickFunctionDeclaration(POINTER_CLICK_SETTLE_MS, isRef(selector) ? '' : selector) : `function() {
        // #742: HTMLElement.click() fires nothing on a :disabled control; aria-disabled is still clicked.
        ${actionabilityFunctionSource()}
        const disabled = actionDisabledReason(this, false);
        if (disabled) {
          return { disabled: { tag: this.tagName, text: actionLabel(this), reason: disabled, matches: ${isRef(selector) ? 'null' : `actionMatchCount(${JSON.stringify(selector)})`} } };
        }
        this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        if (typeof this.click === 'function') this.click();
        else this.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        return {
          tag: this.tagName,
          text: (this.textContent || '').trim().substring(0, 80),
          role: (typeof this.getAttribute === 'function' ? this.getAttribute('role') : '') || '',
        };
      }`,
      awaitPromise: pointer,
      returnByValue: true,
    }, nodeSid);
    if (pointer) {
      const value = res.result.value || {};
      rememberClickTrust(options.clickTrust, value);
      if (facts && options.clickTrust && value.ok) {
        options.clickTrust.frameContent = { origin: facts.rawOrigin, host: facts.host, name: value.text || '' };
      }
      return formatPointerClickReceipt(value, selector, facts);
    }
    const r = res.result.value || {};
    if (r.disabled) throw frameAwareDisabledError('click', r.disabled, selector, facts);
    rememberClickTrust(options.clickTrust, r);
    if (facts && options.clickTrust) {
      options.clickTrust.frameContent = { origin: facts.rawOrigin, host: facts.host, name: r.text || '' };
    }
    if (facts) {
      return `JS-clicked ${formatCrossSiteTarget({ tag: r.tag, ref: selector, host: facts.host })}${crossSitePageBlock(facts, r.text)}`;
    }
    return `JS-clicked <${r.tag || '?'}> "${r.text || ''}"${isRef(selector) ? ` (${selector})` : ''}`;
  } catch (e) {
    if (isTimeoutError(e, ['Runtime.callFunctionOn'])) {
      return `JS-click dispatched for ${selector}; success but click acknowledgement timed out after dispatch (${e.message}). Run \`perceive --diff\` or \`status\` to refresh observation.`;
    }
    throw e;
  }
}
export function formatPointerClickReceipt(r, selector, facts = null) {
  if (!r.ok && r.disabled) throw frameAwareDisabledError('click', r.disabled, selector, facts);
  if (!r.ok) {
    // A cross-site element's tag and label are frame page text; only the top page names them.
    const named = r.zeroSize && !facts ? ` (${r.tag} "${r.text}")` : '';
    throw new Error(`${r.error || 'click --pointer failed'}${named}`);
  }
  const state = [
    r.ariaExpanded != null ? `aria-expanded=${r.ariaExpanded}` : null,
    r.dataState != null ? `data-state=${r.dataState}` : null,
  ].filter(Boolean);
  const opened = r.ariaExpanded === 'true' || r.dataState === 'open';
  const closed = r.ariaExpanded === 'false' || r.dataState === 'closed';
  const verdict = state.length === 0
    ? 'No aria-expanded or data-state on the target; check the page (perceive / shot) to see what changed.'
    : opened
      ? 'A menu or popover is open.'
      : closed
        ? 'Still closed: no menu opened. The page may need a different element or more time.'
        : '';
  const mode = 'mode: pointer-sequence (pointerdown, mousedown, pointerup, mouseup, click; no Input.* events)';
  if (facts) {
    // The name and the aria-expanded/data-state values are frame page text; they go in the block.
    const page = [String(r.text || '').trim(), state.join(' ')].filter(Boolean).join('\n');
    return [
      `Pointer-clicked ${formatCrossSiteTarget({ tag: r.tag, ref: selector, host: facts.host })}`,
      mode,
      ...(verdict ? [verdict] : []),
      ...(page ? [wrapFrameContent(page, { origin: facts.origin })] : []),
    ].join('\n');
  }
  return `Pointer-clicked <${r.tag || '?'}> "${r.text || ''}"${isRef(selector) ? ` (${selector})` : ''}
${mode}
${state.join(' ')}${verdict ? `
${verdict}` : ''}`;
}
// `selector` (CSS only) lets a disabled failure say how many elements the selector matches.
export function pointerClickFunctionDeclaration(settleMs = POINTER_CLICK_SETTLE_MS, selector = '') {
  return `async function() {
    const el = this;
    const label = (el.getAttribute('aria-label') || el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().substring(0, 80);
    const ariaDisabled = el.getAttribute('aria-disabled') === 'true';
    let nativeDisabled = el.disabled === true;
    try { nativeDisabled = nativeDisabled || (typeof el.matches === 'function' && el.matches(':disabled')); } catch (e) {}
    if (nativeDisabled || ariaDisabled) {
      // #468: the reason travels with the failure so Kind: disabled gets a Next that cannot loop.
      const reason = el.disabled === true ? 'disabled attribute'
        : nativeDisabled ? 'inside a disabled <fieldset>' : 'aria-disabled="true"';
      return {
        ok: false,
        error: 'click --pointer: element is disabled (' + el.tagName + ' "' + label + '")',
        disabled: { tag: el.tagName, text: label, reason, matches: ${selector ? `(function() {
          try { return document.querySelectorAll(${JSON.stringify(selector)}).length; } catch (e) { return null; }
        })()` : 'null'} },
      };
    }
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const rect = el.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) {
      return { ok: false, error: 'click --pointer: element is not visible (zero size)', zeroSize: true, tag: el.tagName, text: label };
    }
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') {
      return { ok: false, error: 'click --pointer: element is not visible (' + style.display + '/' + style.visibility + ')' };
    }
    if (style.pointerEvents === 'none') {
      return { ok: false, error: 'click --pointer: element has pointer-events: none' };
    }
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const base = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: x, clientY: y, screenX: x, screenY: y,
      button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true,
    };
    el.dispatchEvent(new PointerEvent('pointerdown', { ...base, buttons: 1 }));
    el.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }));
    el.dispatchEvent(new PointerEvent('pointerup', { ...base, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('click', { ...base, buttons: 0 }));
    await new Promise(resolve => setTimeout(resolve, ${Number(settleMs) || 0}));
    const trigger = el.closest('[aria-expanded],[data-state]') || el;
    return {
      ok: true,
      tag: el.tagName,
      text: label,
      role: (typeof el.getAttribute === 'function' ? el.getAttribute('role') : '') || '',
      ariaExpanded: trigger.getAttribute('aria-expanded'),
      dataState: trigger.getAttribute('data-state'),
    };
  }`;
}
// `click --pointer` shares jsClickStr's single Runtime.callFunctionOn call site (the direct-CDP inventory is frozen),
// so this is only a named entry point for tests and the handler.
export function pointerClickStr(cdp, sid, selector, refMap, refState, clickTrust = null) {
  return jsClickStr(cdp, sid, selector, refMap, refState, { pointer: true, clickTrust });
}
// Page-side source: actionDisabledReason(el, aria), actionLabel(el), actionMatchCount(selector),
// actionBlockedBy(el, needVisible, aria) and waitForActionable(query, waitMs, needVisible, aria).
// Interpolated into a page function. `aria` (click only) also treats aria-disabled="true" as
// disabled; fill and select refuse only what the browser itself refuses (:disabled), since
// aria-disabled is not enforced and they have no JS-click escape.
export function actionabilityFunctionSource() {
  return `
    const actionDisabledReason = (el, aria = true) => {
      if (!el || el.nodeType !== 1) return '';
      const nativeReason = (node) => {
        if (!node || node.nodeType !== 1) return '';
        let native = false;
        try { native = typeof node.matches === 'function' && node.matches(':disabled'); } catch (e) { native = false; }
        if (!native) return '';
        if (typeof node.hasAttribute === 'function' && node.hasAttribute('disabled')) return 'disabled attribute';
        const fieldset = typeof node.closest === 'function' ? node.closest('fieldset[disabled]') : null;
        return fieldset && fieldset !== node ? 'inside a disabled <fieldset>' : 'disabled';
      };
      const own = nativeReason(el);
      if (own) return own;
      // A label is not :disabled. The control it wraps, or the one its for= points at, is.
      if (String(el.tagName || '').toUpperCase() === 'LABEL') {
        let control = null;
        const forId = typeof el.getAttribute === 'function' ? el.getAttribute('for') : '';
        if (forId) {
          const doc = el.ownerDocument;
          control = doc && typeof doc.getElementById === 'function' ? doc.getElementById(forId) : null;
        } else if (typeof el.querySelector === 'function') {
          control = el.querySelector('input, select, textarea, button');
        }
        const via = control && control !== el ? nativeReason(control) : '';
        if (via) return via;
      }
      if (aria && typeof el.getAttribute === 'function' && el.getAttribute('aria-disabled') === 'true') return 'aria-disabled="true"';
      return '';
    };
    const actionMatchCount = (selector) => {
      try { return document.querySelectorAll(selector).length; } catch (e) { return null; }
    };
    const actionLabel = (el) => {
      if (!el) return '';
      const attr = (name) => (typeof el.getAttribute === 'function' ? el.getAttribute(name) : null);
      const tag = String(el.tagName || '').toUpperCase();
      const type = String(el.type || '').toLowerCase();
      const field = tag === 'SELECT' || tag === 'TEXTAREA'
        || (tag === 'INPUT' && ['button', 'submit', 'reset'].indexOf(type) === -1);
      const raw = attr('aria-label')
        || (field ? (attr('name') || el.id || attr('placeholder')) : (el.innerText || el.textContent || el.value))
        || '';
      return String(raw).replace(/\\s+/g, ' ').trim().substring(0, 80);
    };
    const actionBlockedBy = (el, needVisible, aria = true) => {
      if (!el) return 'attach';
      if (needVisible) {
        let box = null;
        try { box = el.getBoundingClientRect(); } catch (e) { box = null; }
        if (!box || !(box.width > 0 && box.height > 0)) return 'visible';
        let style = null;
        try { style = getComputedStyle(el); } catch (e) { style = null; }
        if (style && (style.visibility === 'hidden' || style.display === 'none')) return 'visible';
      }
      return actionDisabledReason(el, aria) ? 'enabled' : '';
    };
    const waitForActionable = (query, waitMs, needVisible, aria = true) => new Promise((resolve) => {
      const started = Date.now();
      const waitedFor = [];
      let waited = false;
      let done = false;
      let observer = null;
      let poll = null;
      let deadline = null;
      const finish = (el, blocked) => {
        done = true;
        if (observer) observer.disconnect();
        if (poll != null) clearInterval(poll);
        if (deadline != null) clearTimeout(deadline);
        resolve({ el, blocked, waited, waitedMs: waited ? Date.now() - started : 0, waitedFor });
      };
      const check = (final) => {
        if (done) return;
        let el = null;
        try { el = query(); } catch (e) { el = null; }
        const blocked = actionBlockedBy(el, needVisible, aria);
        if (!blocked) return finish(el, '');
        if (!(waitMs > 0)) return finish(el, blocked);
        waited = true;
        if (waitedFor.indexOf(blocked) === -1) waitedFor.push(blocked);
        if (final || Date.now() - started >= waitMs) finish(el, blocked);
      };
      check(false);
      if (done) return;
      if (typeof MutationObserver === 'function' && typeof document !== 'undefined') {
        try {
          observer = new MutationObserver(() => check(false));
          observer.observe(document, { subtree: true, childList: true, attributes: true });
        } catch (e) { observer = null; }
      }
      poll = setInterval(() => check(false), ${ACTIONABILITY_POLL_MS});
      deadline = setTimeout(() => check(true), waitMs);
    });
  `;
}
export function normalizeActionabilityWaitMs(value) {
  if (value == null) return ACTIONABILITY_WAIT_DEFAULT_MS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(Math.trunc(parsed), ACTIONABILITY_WAIT_MAX_MS);
}
// `--wait-ms N` / `--wait-ms=N` on click, fill and select. Returns the remaining args and
// waitMs (null when the flag is absent, so the default applies).
export function parseActionabilityWaitArgs(args = [], command = 'click') {
  const rest = [];
  let waitMs = null;
  const parse = (raw) => {
    const value = parseNonNegativeInteger(raw, `${command}: --wait-ms`);
    if (value > ACTIONABILITY_WAIT_MAX_MS) {
      throw new Error(`${command}: --wait-ms must be at most ${ACTIONABILITY_WAIT_MAX_MS}`);
    }
    return value;
  };
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === '--wait-ms') waitMs = parse(args[++i]);
    else if (String(token).startsWith('--wait-ms=')) waitMs = parse(String(token).slice('--wait-ms='.length));
    else rest.push(token);
  }
  return { waitMs, args: rest };
}
// ` (waited 640ms for attach)` when the page-side wait actually waited, else ''.
export function formatActionabilityWaitNote(result = {}) {
  if (!result || result.waited !== true) return '';
  const what = Array.isArray(result.waitedFor) && result.waitedFor.length ? result.waitedFor.join(', ') : 'actionability';
  return ` (waited ${Math.max(0, Math.round(Number(result.waitedMs) || 0))}ms for ${what})`;
}
// `Element not found: <sel>` keeps its prefix (selector classification) and says how long it waited.
export function actionabilityMissMessage(error, result = {}) {
  const text = String(error || '');
  if (!result || result.waited !== true) return text;
  return `${text} (waited ${Math.max(0, Math.round(Number(result.waitedMs) || 0))}ms for attach)`;
}
// A disabled target: nothing is dispatched. `err.actionDisabled` drives `Kind: disabled`.
export function actionDisabledError(action, info = {}, selector = '') {
  const tag = String(info.tag || '?').toUpperCase();
  const label = String(info.text || '').replace(/\s+/g, ' ').trim();
  const reason = String(info.reason || 'disabled');
  const ref = isRef(selector) ? ` (${selector})` : '';
  const where = info.host ? ` in ${info.host}` : '';
  const waited = info.waited === true ? ` after waiting ${Math.max(0, Math.round(Number(info.waitedMs) || 0))}ms` : '';
  const err = new Error(
    `<${tag}>${label ? ` "${label}"` : ''}${ref}${where} is disabled (${reason})${waited}; ${ACTION_DISABLED_NOT_SENT[action] || 'nothing was dispatched'}.`
  );
  err.actionDisabled = { tag, text: label, reason, selector: String(selector || '') };
  // How many elements the CSS selector matches; recovery must not offer a `waitfor` that a sibling
  // could satisfy while the first match (the one acted on) stays disabled.
  if (Number.isInteger(info.matches)) err.actionDisabled.matches = info.matches;
  return err;
}
// A cross-site control's label is that frame's page text. The error keeps the tag, ref, and host;
// the label goes in a frame block after it.
function frameAwareDisabledError(action, info = {}, selector = '', facts = null) {
  if (!facts) return actionDisabledError(action, info, selector);
  const label = String(info.text || '').replace(/\s+/g, ' ').trim();
  const err = actionDisabledError(action, { ...info, text: '', host: facts.host }, selector);
  if (label) err.frameContentBlock = wrapFrameContent(label, { origin: facts.origin });
  return err;
}
// Separate wait for paths that resolve the node through DOM.querySelector (fill --react).
export async function waitForActionableSelector(cdp, sid, selector, { waitMs = ACTIONABILITY_WAIT_DEFAULT_MS, visible = true } = {}) {
  const wait = normalizeActionabilityWaitMs(waitMs);
  const raw = await evalStr(cdp, sid, `(async function() {
    ${actionabilityFunctionSource()}
    try { document.querySelector(${JSON.stringify(selector)}); }
    catch (err) { return { cdpActionability: true, ok: false, invalid: true }; }
    const r = await waitForActionable(() => document.querySelector(${JSON.stringify(selector)}), ${wait}, ${visible ? 'true' : 'false'}, false);
    const disabled = r.el ? actionDisabledReason(r.el, false) : '';
    return {
      cdpActionability: true,
      ok: true,
      found: !!r.el,
      waited: r.waited,
      waitedMs: r.waitedMs,
      waitedFor: r.waitedFor,
      disabled: disabled ? { tag: r.el.tagName, text: actionLabel(r.el), reason: disabled, matches: actionMatchCount(${JSON.stringify(selector)}) } : null,
    };
  })()`, false, { timeoutMs: TIMEOUT + wait });
  let parsed = null;
  try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { parsed = null; }
  return parsed && parsed.cdpActionability === true ? parsed : null;
}
function namedClickPoint(rect) {
  const w = Number(rect?.w);
  const h = Number(rect?.h);
  return { x: Number(rect?.x) + w / 2, y: Number(rect?.y) + h / 2 };
}
function namedClickBoxUnusable(rect, point) {
  if (!rect || rect.connected === false) return true;
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return true;
  return clickMeasurementUnusable({ ...rect, x: point.x, y: point.y }, point);
}
function namedResolvePayload(remote) {
  const value = remote?.value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }
  if (value && typeof value === 'object' && value.ok !== true) return value;
  return null;
}
let namedClickObjectGroupSeq = 0;
// Resolve a named control with the same rules as jsclick, hold it by objectId,
// then use the CSS pointer path so the control takes focus. No usable box falls
// back to el.click() and the receipt says focus was not moved. That fallback
// reports a followed href, a new tab, and scroll through namedInPageClickReceipt.
export async function namedInViewportPointerClickStr(cdp, sid, input, opts = {}) {
  assertClosedClickTarget(input);
  const name = namedClickQueryName(input);
  if (!String(name).trim()) {
    throw new Error(`${String(input).trim()} has no visible text to match. Pass the button or link text, e.g. click <target> "text=Save", or an @ref from perceive.`);
  }
  const objectGroup = `named-click-${++namedClickObjectGroupSeq}`;
  try {
    const evaluated = await cdpDomains(cdp).Runtime.evaluate({
      expression: namedInViewportClickExpression(name, { resolveOnly: true }),
      returnByValue: false,
      awaitPromise: true,
      objectGroup,
    }, sid);
    if (evaluated.exceptionDetails) throw new Error(runtimeExceptionMessage(evaluated.exceptionDetails));
    const remote = evaluated.result || {};
    const failure = namedResolvePayload(remote);
    // This resolve runs with checkCover false, so it cannot return covered.
    // The scroll-settled hit test below is the cover check.
    if (failure && failure.ok !== true) {
      if (failure.disabled) throw actionDisabledError('click', failure.disabled, input);
      throw new Error(namedClickMissMessage(input, failure.error));
    }
    const objectId = remote.objectId;
    if (!objectId) {
      throw new Error(`click: named control ${JSON.stringify(name)} was found but could not be held for a pointer click. Nothing was clicked.`);
    }
    const marked = await cdpDomains(cdp).Runtime.callFunctionOn({
      objectId,
      functionDeclaration: namedClickMarkReaderDeclaration(),
      returnByValue: true,
    }, sid);
    if (marked.exceptionDetails) throw new Error(runtimeExceptionMessage(marked.exceptionDetails));
    const meta = marked.result?.value;
    if (!meta || meta.ok !== true) {
      throw new Error(`click: named control ${JSON.stringify(name)} was found, then lost before the pointer click. Nothing was clicked.`);
    }
    const settled = await cdpDomains(cdp).Runtime.callFunctionOn({
      objectId,
      functionDeclaration: scrollSettledRectFunctionDeclaration({ hitTest: true }),
      returnByValue: true,
      awaitPromise: true,
    }, sid, REF_RESOLVE_TIMEOUT);
    if (settled.exceptionDetails) throw new Error(runtimeExceptionMessage(settled.exceptionDetails));
    const rect = settled.result?.value || {};
    const point = namedClickPoint(rect);
    const measurement = { ...rect, x: point.x, y: point.y };
    rememberClickTrust(opts.clickTrust, { tag: meta.tag || rect.tag, role: meta.role || rect.role });
    if (rect.hit?.covered === true) {
      assertClickPointNotCovered(rect.hit, { x: point.x, y: point.y, tag: meta.tag, text: meta.text });
    }
    if (namedClickBoxUnusable(measurement, point)) {
      return namedInPageClickReceipt(cdp, sid, async () => {
        const clicked = await cdpDomains(cdp).Runtime.callFunctionOn({
          objectId,
          functionDeclaration: `function() {
            if (typeof this.click === 'function') this.click();
            else this.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
            return true;
          }`,
          returnByValue: true,
        }, sid);
        if (clicked.exceptionDetails) throw new Error(runtimeExceptionMessage(clicked.exceptionDetails));
        return meta;
      }, ' (no click box; focus not moved)');
    }
    const target = {
      tag: meta.tag,
      text: meta.text,
      role: meta.role || '',
      href: rect.href || meta.href || null,
      linkTarget: rect.linkTarget != null ? rect.linkTarget : meta.linkTarget,
      frameName: rect.frameName != null ? rect.frameName : meta.frameName,
      pageHref: rect.pageHref || meta.pageHref || '',
      downloadAttr: rect.downloadAttr === true,
    };
    const suffix = await observeClickOutsideDocument(cdp, sid, point, { objectId, selector: input }, target, opts);
    let url = '';
    if (clickFollowsHref(target) && !suffix) {
      const current = await evalPageHref(cdp, sid);
      if (current && current !== String(target.pageHref || '')) url = current;
    }
    const scrollLine = meta.scrolled ? `\nScroll: ${meta.scrollYBefore} → ${meta.scrollYAfter}` : '';
    const urlLine = url ? `\nURL: ${url}` : '';
    return `Clicked <${meta.tag || '?'}> "${meta.text || ''}"${suffix || ''}${scrollLine}${urlLine}`;
  } finally {
    try {
      await cdpDomains(cdp).Runtime.releaseObjectGroup({ objectGroup }, sid);
    } catch {
      // Releasing the resolved node is cleanup. A transport that cannot release keeps the object.
    }
  }
}
// Click element by CSS selector, @ref, or accessible name.
// A named query resolves with the same rules as jsclick (exact text, then a
// normalised field, viewport first, one off-screen match scrolled into view),
// then uses the CSS pointer path: scroll-settled box, hit test, CDP mouse at
// the centre, so the control takes focus. A target with no usable click box
// falls back to el.click() and still reports a followed href, a new tab, and scroll.
// `jsclick` and `click --js` stay on that in-page click.
// A CSS selector waits up to `opts.waitMs` (default ACTIONABILITY_WAIT_DEFAULT_MS, 0 disables)
// for the element to be attached, visible and enabled (#468); an @ref is checked for disabled
// without waiting.
export async function clickStr(cdp, sid, selector, refMap, refState, opts = {}) {
  if (!selector) throw new Error('CSS selector, @ref, or accessible name required');
  assertClosedClickTarget(selector);
  if (isNamedClickQuery(selector)) {
    return namedInViewportPointerClickStr(cdp, sid, selector, opts);
  }
  if (isCursorRef(selector)) {
    const r = resolveCursorRef(refMap, selector, refState);
    const cursorPoint = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
    if (clickMeasurementUnusable(r, cursorPoint)) throw noClickBoxError(selector, r);
    await dispatchClick(cdp, sid, r.x + r.w / 2, r.y + r.h / 2, { selector, x: r.x + r.w / 2, y: r.y + r.h / 2 });
    await confirmClickFollowedHref(cdp, sid, r);
    return `Clicked <${r.sel}> "${r.text}" (${selector})`;
  }
  if (isRef(selector)) {
    const r = await resolveRef(cdp, sid, refMap, selector, refState, { hitTest: true, allowCrossSite: true });
    const facts = crossSiteListed(cdp, sid, selector, refState);
    if (r.disabled) throw frameAwareDisabledError('click', { tag: r.tag, text: r.text, reason: r.disabled }, selector, facts);
    const refPoint = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
    if (clickMeasurementUnusable(r, refPoint)) throw noClickBoxError(selector, r);
    rememberClickTrust(opts.clickTrust, r);
    if (facts && opts.clickTrust) {
      opts.clickTrust.frameContent = { origin: facts.rawOrigin, host: facts.host, name: r.text || '' };
    }
    assertClickPointNotCovered(r.hit, {
      x: r.x + r.w / 2,
      y: r.y + r.h / 2,
      tag: r.tag,
      text: r.text,
      ref: selector,
      ...(facts ? { crossSiteHost: facts.host, coverScope: r.coverScope || 'frame', frameOrigin: facts.rawOrigin } : {}),
    });
    let objectId = null;
    try {
      objectId = await resolveRefNode(cdp, sid, refMap, selector, refState, { returnRealm: 'page', allowCrossSite: true });
    } catch {
      objectId = null;
    }
    const suffix = await observeClickOutsideDocument(cdp, sid, {
      x: r.x + r.w / 2,
      y: r.y + r.h / 2,
    }, {
      selector,
      objectId,
      framed: Boolean(parseFrameRef(selector)),
    }, r, opts);
    if (facts) {
      return `Clicked ${formatCrossSiteTarget({ tag: r.tag, ref: selector, host: facts.host })}${suffix}${crossSitePageBlock(facts, r.text)}`;
    }
    return `Clicked <${r.tag}> "${r.text}" (${selector})${suffix}`;
  }
  const waitMs = normalizeActionabilityWaitMs(opts.waitMs);
  const expr = `
    (async function() {
      let el;
      try {
        el = document.querySelector(${JSON.stringify(selector)});
      } catch (err) {
        return { ok: false, error: 'Invalid selector: ' + (err && err.message ? err.message : String(err)) };
      }
      ${actionabilityFunctionSource()}
      const wait = await waitForActionable(() => document.querySelector(${JSON.stringify(selector)}), ${waitMs}, true);
      const waitInfo = { waited: wait.waited, waitedMs: wait.waitedMs, waitedFor: wait.waitedFor };
      el = wait.el;
      if (!el) return { ok: false, error: 'Element not found: ' + ${JSON.stringify(selector)}, ...waitInfo };
      const disabled = actionDisabledReason(el);
      if (disabled) return { ok: false, disabled: { tag: el.tagName, text: actionLabel(el), reason: disabled, matches: actionMatchCount(${JSON.stringify(selector)}) }, ...waitInfo };
      const rect = await (${scrollSettledRectFunctionDeclaration({ hitTest: true })}).call(el);
      return {
        ok: true,
        x: rect.x + rect.w / 2,
        y: rect.y + rect.h / 2,
        w: rect.w,
        h: rect.h,
        noClickBox: rect.noClickBox === true,
        inViewport: rect.noClickBox === true ? false : rect.inViewport !== false,
        tag: rect.tag,
        text: rect.text,
        role: rect.role || '',
        href: rect.href || (el.tagName === 'A' ? (el.href || null) : null),
        linkTarget: rect.linkTarget,
        frameName: rect.frameName,
        pageHref: rect.pageHref || location.href,
        downloadAttr: rect.downloadAttr === true,
        hit: rect.hit,
        ...waitInfo,
      };
    })()
  `;
  const result = await evalStr(cdp, sid, expr, false, waitMs > 0 ? { timeoutMs: TIMEOUT + waitMs } : {});
  const r = JSON.parse(result);
  if (!r.ok && r.disabled) throw actionDisabledError('click', { ...r.disabled, waited: r.waited, waitedMs: r.waitedMs }, selector);
  if (!r.ok) throw new Error(cssClickMissMessage(selector, actionabilityMissMessage(r.error, r)));
  if (clickMeasurementUnusable(r, { x: r.x, y: r.y })) throw noClickBoxError(selector, r);
  rememberClickTrust(opts.clickTrust, r);
  assertClickPointNotCovered(r.hit, { x: r.x, y: r.y, tag: r.tag, text: r.text });
  const suffix = await observeClickOutsideDocument(cdp, sid, { x: r.x, y: r.y }, { selector, x: r.x, y: r.y }, r, opts);
  return `Clicked <${r.tag}> "${r.text}"${formatActionabilityWaitNote(r)}${suffix}`;
}
// Click at CSS pixel coordinates using Input.dispatchMouseEvent
export async function clickXyStr(cdp, sid, x, y) {
  const cx = parseFloat(x);
  const cy = parseFloat(y);
  if (isNaN(cx) || isNaN(cy)) throw new Error('x and y must be numbers (CSS pixels)');
  const suffix = await observeClickOutsideDocument(cdp, sid, { x: cx, y: cy }, { x: cx, y: cy }, {}, {});
  return `Clicked at CSS (${cx}, ${cy})${suffix}`;
}
// Type text using Input.insertText (works in cross-origin iframes, unlike eval)
export async function typeStr(cdp, sid, text) {
  if (text == null || text === '') throw new Error('text required');
  await cdpDomains(cdp).Input.insertText( { text }, sid);
  return `Typed ${text.length} characters`;
}
// Resolve a press argument (named key or single-character) to a CDP descriptor.
// Returns { key, code, keyCode, shift? } or null when unsupported.
export function keyForPress(input) {
  if (!input || typeof input !== 'string') return null;
  const named = KEY_MAP[input.toLowerCase()];
  if (named) return { ...named };
  if (input.length !== 1) return null;
  // a-z
  if (/^[a-z]$/.test(input)) {
    return { key: input, code: 'Key' + input.toUpperCase(), keyCode: input.toUpperCase().charCodeAt(0) };
  }
  // A-Z (shift-modified)
  if (/^[A-Z]$/.test(input)) {
    return { key: input, code: 'Key' + input, keyCode: input.charCodeAt(0), shift: true };
  }
  // 0-9
  if (/^[0-9]$/.test(input)) {
    return { key: input, code: 'Digit' + input, keyCode: input.charCodeAt(0) };
  }
  if (Object.prototype.hasOwnProperty.call(PUNCT_KEY_MAP, input)) {
    const p = PUNCT_KEY_MAP[input];
    return { key: input, code: p.code, keyCode: p.keyCode };
  }
  if (Object.prototype.hasOwnProperty.call(SHIFTED_PUNCT_KEY_MAP, input)) {
    const p = SHIFTED_PUNCT_KEY_MAP[input];
    return { key: input, code: p.code, keyCode: p.keyCode, shift: true };
  }
  return null;
}
export function pressUsageError(keyName) {
  if (!keyName) {
    return new Error('Key name required (Enter, Tab, Escape, Backspace, Space, Arrow*, or single character a-z/A-Z/0-9/punctuation)');
  }
  if (!keyForPress(keyName)) {
    return new Error(
      `Unknown key: ${keyName}. Supported: ${Object.keys(KEY_MAP).join(', ')}, single characters (a-z, A-Z, 0-9, common punctuation). Use \`type\` for multi-character text.`
    );
  }
  return null;
}
export function isEnterKeyName(keyName) {
  return String(keyName || '').trim().toLowerCase() === 'enter';
}
export function pressFeedbackPolicy(keyName, probe) {
  if (isEnterKeyName(keyName) && probe && probe.ok && probe.selector) return 'report-only';
  return 'settle-diff';
}
export function pressCommandKey(command) {
  const args = Array.isArray(command?.args) ? command.args : [];
  return args.find(arg => arg && !String(arg).startsWith('--'));
}
export function pressCommandRequestsSearchSubmit(command) {
  const args = Array.isArray(command?.args) ? command.args : [];
  return args.includes(PRESS_SEARCH_SUBMIT_FLAG);
}
export function isSearchSubmitPressCommand(command) {
  if (!command || typeof command !== 'object') return false;
  const cmd = String(command.cmd || '').trim().toLowerCase();
  if (cmd !== 'press' && cmd !== 'key') return false;
  if (!pressCommandRequestsSearchSubmit(command)) return false;
  return isEnterKeyName(pressCommandKey(command));
}
export function fillFeedbackPolicy(nextCommand) {
  // Mid-pipe fill before an opted-in `press Enter --search-submit`: leftover
  // typeahead AX and pending /api/quicksearch are not the success signal.
  // A plain `press Enter` still settle-diffs, then dispatches the key.
  return isSearchSubmitPressCommand(nextCommand) ? 'report-only' : 'settle-diff';
}
export function isHoverConfirmEvalCommand(command) {
  if (!command || typeof command !== 'object') return false;
  const cmd = String(command.cmd || '').trim().toLowerCase();
  return cmd === 'eval';
}
export function hoverFeedbackPolicy(nextCommand) {
  // Sequential batch hover then eval: leftover AX recapture races CSS
  // :hover (opacity / group-hover). Confirm eval is the success signal.
  // Standalone hover still recaptures so a later no-op mutator does not
  // steal hover's AX delta (#286). Do not invent a hover family.
  return isHoverConfirmEvalCommand(nextCommand) ? 'report-only' : 'settle-diff';
}
export function batchCommandLookahead(commands = [], { parallel = false } = {}) {
  const list = Array.isArray(commands) ? commands : [];
  return list.map((command, index) => ({
    ...command,
    nextCommand: parallel ? null : list[index + 1] || null,
  }));
}
export async function runWithBatchLookahead(session, nextCommand, run) {
  // Keep lookahead until `run()` finishes, including across the first
  // handleCommand await (executeDaemonApplicationRoute). A sync try/finally
  // around `return handleCommand(...)` clears it before fillFeedbackPolicy.
  session.batchNextCommand = nextCommand || null;
  try {
    return await run();
  } finally {
    session.batchNextCommand = null;
  }
}
export function formatSearchSubmitPressText(probe = {}) {
  return `Submitted search via ${probe.selector}`;
}
export function parsePressArgs(args = []) {
  const fopts = parseCompactFormatArgs(args, ['text', 'json']);
  let viaListing = false;
  const positional = [];
  for (const arg of fopts.args) {
    if (arg === PRESS_SEARCH_SUBMIT_FLAG) viaListing = true;
    else if (String(arg).startsWith('--')) throw new Error(`press: unknown argument ${arg}`);
    else positional.push(arg);
  }
  const key = positional[0];
  if (viaListing && key && !isEnterKeyName(key)) {
    throw new Error('press --search-submit only applies to Enter. Omit --search-submit to send the key.');
  }
  return {
    fopts: { format: fopts.format, compact: fopts.compact, qa: fopts.qa, full: fopts.full, maxDiffLines: fopts.maxDiffLines },
    key,
    viaListing,
  };
}
export function pressSearchSubmitPlan({ key, viaListing = false, awaitListing = false } = {}) {
  if (viaListing !== true || !isEnterKeyName(key)) {
    return { mode: 'dispatch-key', requireListing: false };
  }
  if (awaitListing) return { mode: 'probe-after-fill', requireListing: true };
  return { mode: 'probe-once', requireListing: true };
}
export function pressHelpLines() {
  return [
    'Enter dispatches keyDown with a carriage return to the focused element, including inside batch.',
    '--search-submit opts into clicking a results listing instead. The receipt names that link and does not claim a key press.',
  ];
}
export function searchSubmitProbeExpression() {
  return `(function() {
    /* chrome-cdp-ex.search-submit */
    ${searchListingHelpersSource()}
    try {
      const links = Array.from(document.querySelectorAll('a[href]'));
      for (const el of links) {
        const href = el.getAttribute('href') || '';
        const text = String(el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
        if (!(isSearchListingHref(href) || isSearchListingText(text))) continue;
        const cs = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        if (rect.width < 4 || rect.height < 4) continue;
        return {
          ok: true,
          selector: searchListingSelector(href),
          href: href,
          text: text.slice(0, 80),
        };
      }
    } catch {}
    return { ok: false };
  })()`;
}
export async function probeSearchSubmit(cdp, sid) {
  try {
    const raw = await evalStr(cdp, sid, searchSubmitProbeExpression());
    const probe = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (probe && probe.ok && probe.selector) return probe;
  } catch {}
  return { ok: false };
}
export function searchListingProbeFromQuery(query, pageHref) {
  const q = String(query || '').trim();
  const raw = String(pageHref || '').trim();
  if (!q || !raw) return { ok: false };
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false };
  }
  const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
  if (host !== 'huggingface.co') return { ok: false };
  const relative = `/models?search=${encodeURIComponent(q)}`;
  return {
    ok: true,
    selector: searchListingSelector(relative),
    href: relative,
    text: relative,
    navigateHref: `${parsed.origin}${relative}`,
    synthesized: true,
  };
}
export function searchSubmitProbeOptions(timeoutMs, opts = {}) {
  if (timeoutMs && typeof timeoutMs === 'object' && !Array.isArray(timeoutMs)) {
    return timeoutMs;
  }
  return opts && typeof opts === 'object' ? opts : {};
}
export async function waitForSearchSubmitProbe(cdp, sid, timeoutMs = SEARCH_SUBMIT_PROBE_WAIT_MS, opts = {}) {
  const options = searchSubmitProbeOptions(timeoutMs, opts);
  const filledQuery = String(options.filledQuery || '');
  let probe = await probeSearchSubmit(cdp, sid);
  if (probe?.ok && probe.selector) return probe;
  // After report-only fill we already know the query. Do not poll 1500 ms
  // for the typeahead listing link; synthesize /models?search=<filled>
  // and let submitSearchListing navigate, then return on listing commit.
  if (filledQuery.trim()) {
    return searchListingProbeFromQuery(filledQuery, await evalPageHref(cdp, sid));
  }
  const budget = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : (Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : SEARCH_SUBMIT_PROBE_WAIT_MS);
  const deadline = Date.now() + budget;
  while (Date.now() < deadline) {
    const pause = Math.min(40, deadline - Date.now());
    if (pause > 0) await sleep(pause);
    probe = await probeSearchSubmit(cdp, sid);
    if (probe?.ok && probe.selector) return probe;
  }
  return probe?.ok && probe.selector ? probe : { ok: false };
}
export async function currentSearchListingHref(cdp, sid) {
  const href = await evalPageHref(cdp, sid);
  return isSearchListingHref(href) ? href : '';
}
export async function waitForSearchListingHref(cdp, sid, timeoutMs = CLICK_NAVIGATION_WAIT_MS) {
  const budget = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : CLICK_NAVIGATION_WAIT_MS;
  const deadline = Date.now() + budget;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const href = await currentSearchListingHref(cdp, sid);
    if (href) return href;
    const pause = Math.min(40, deadline - Date.now());
    if (pause > 0) await sleep(pause);
  }
  return '';
}
export async function navigateSearchListingIssued(cdp, sid, url) {
  await cdpDomains(cdp).Page.enable({}, sid).catch(() => {});
  const result = await cdpDomains(cdp).Page.navigate({ url }, sid);
  if (result?.errorText) throw new Error(result.errorText);
}
export async function submitSearchListing(cdp, sid, probe, refMap, refState) {
  const selector = probe?.selector;
  const navigateHref = String(probe?.navigateHref || '').trim();
  if (probe?.synthesized && navigateHref) {
    // Typeahead listing is not required. Issue listing navigation and
    // return on href commit — same idea as Playwright waitUntil: commit.
    await navigateSearchListingIssued(cdp, sid, navigateHref);
    if (await currentSearchListingHref(cdp, sid)) return;
    if (await waitForSearchListingHref(cdp, sid)) return;
    throw new Error(
      `Search submit via ${selector || navigateHref} did not reach a results listing. Try jsclick ${selector || 'a[href*="models?search="]'}.`
    );
  }
  if (!selector) throw new Error('Search listing selector required');
  const maps = refMap instanceof Map ? refMap : new Map();
  // Typeahead overlays fail-close realistic mouse (compositor ack +
  // scrollSettledRect). Listing URL commit is the success signal, same
  // idea as Playwright noWaitAfter / waitUntil: commit. Prefer jsclick,
  // then return as soon as /models?search= (or /search?q=) is current.
  try {
    await jsClickStr(cdp, sid, selector, maps, refState);
  } catch (error) {
    if (await currentSearchListingHref(cdp, sid)) return;
    try {
      await clickStr(cdp, sid, selector, maps, refState);
    } catch {
      if (await waitForSearchListingHref(cdp, sid)) return;
      throw error;
    }
  }
  if (await currentSearchListingHref(cdp, sid)) return;
  if (await waitForSearchListingHref(cdp, sid)) return;
  throw new Error(
    `Search submit via ${selector} did not reach a results listing. Try jsclick ${selector}.`
  );
}
export function pressNotDeliveredError(key, visibility = 'unknown') {
  const hidden = visibility === 'hidden'
    ? " The tab's document.visibilityState is hidden."
    : '';
  const err = new Error(`press: ${key} was not delivered. The page received no keydown.${hidden}`);
  err.pressNotDelivered = { key: String(key || ''), visibility: visibility || 'unknown' };
  return err;
}
export function pressProbeExpression(mode, mapped) {
  const marker = JSON.stringify(PRESS_PROBE_MARKER);
  const key = JSON.stringify(mapped.key);
  const code = JSON.stringify(mapped.code);
  if (mode === 'install') {
    return `(function() {
      const marker = ${marker};
      const expectKey = ${key};
      const expectCode = ${code};
      const previous = window.${PRESS_PROBE_KEY};
      if (previous && previous.listener) window.removeEventListener('keydown', previous.listener, true);
      const state = { marker: marker, count: 0, matched: false, installed: true, listener: null };
      state.listener = function(event) {
        state.count += 1;
        if (event && (event.key === expectKey || event.code === expectCode)) state.matched = true;
      };
      window.addEventListener('keydown', state.listener, true);
      window.${PRESS_PROBE_KEY} = state;
      return { marker: marker, ok: true, installed: true, matched: false, count: 0 };
    })()`;
  }
  if (mode === 'cleanup') {
    return `(function() {
      const marker = ${marker};
      const state = window.${PRESS_PROBE_KEY};
      if (state && state.listener) window.removeEventListener('keydown', state.listener, true);
      if (!state || state.marker !== marker) return { marker: marker, ok: false, installed: false, matched: false, count: 0 };
      return { marker: marker, ok: true, installed: state.installed === true, matched: state.matched === true, count: Number(state.count) || 0 };
    })()`;
  }
  return `(function() {
    const marker = ${marker};
    const state = window.${PRESS_PROBE_KEY};
    if (!state || state.marker !== marker) return { marker: marker, ok: false, installed: false, matched: false, count: 0 };
    return { marker: marker, ok: true, installed: state.installed === true, matched: state.matched === true, count: Number(state.count) || 0 };
  })()`;
}
export function parsePressProbe(raw) {
  let value = raw;
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!text) return null;
    try { value = JSON.parse(text); } catch { return null; }
  }
  if (!value || typeof value !== 'object' || value.marker !== PRESS_PROBE_MARKER) return null;
  return value;
}
export async function readPressProbe(cdp, sid, mapped) {
  const raw = await evalStr(cdp, sid, pressProbeExpression('read', mapped), false, { raw: true, timeoutMs: 1500 });
  return parsePressProbe(raw);
}
export async function confirmPressDelivered(cdp, sid, mapped, { waitMs } = {}) {
  const budget = Number.isFinite(Number(waitMs)) ? Number(waitMs) : PRESS_DELIVERY_WAIT_MS;
  const started = Date.now();
  for (;;) {
    const parsed = await readPressProbe(cdp, sid, mapped);
    if (parsed?.matched === true) return parsed;
    if (!parsed) break;
    const elapsed = Date.now() - started;
    if (elapsed >= budget) break;
    const pause = Math.min(PRESS_DELIVERY_POLL_MS, budget - elapsed);
    if (pause > 0) await sleep(pause);
  }
  throw pressNotDeliveredError(mapped.key, await probePageVisibility(cdp, sid));
}
export async function pressStr(cdp, sid, keyName, opts = {}) {
  const usage = pressUsageError(keyName);
  if (usage) throw usage;
  const mapped = keyForPress(keyName);
  const modifiers = mapped.shift ? 8 : 0;
  if (opts.viaListing === true && isEnterKeyName(keyName)) {
    const probe = opts.searchSubmit && typeof opts.searchSubmit === 'object'
      ? opts.searchSubmit
      : await probeSearchSubmit(cdp, sid);
    if (probe && probe.ok && probe.selector) {
      await submitSearchListing(cdp, sid, probe, opts.refMap, opts.refState);
      return formatSearchSubmitPressText(probe);
    }
    throw new Error(
      'Search submit did not find a results listing. Try jsclick a[href*="models?search="], or press Enter without --search-submit.'
    );
  }
  const base = {
    key: mapped.key,
    code: mapped.code,
    windowsVirtualKeyCode: mapped.keyCode,
    nativeVirtualKeyCode: mapped.keyCode,
    modifiers,
  };
  const keyDown = { ...base, type: 'keyDown' };
  // Enter is not a one-character key, so the char branch below does not run.
  // Chrome emits keypress and implicit form submission only when keyDown
  // carries text "\r". A separate char event still submits after keydown
  // preventDefault, and sending both clicks the default button twice.
  if (isEnterKeyName(keyName)) {
    keyDown.text = '\r';
    keyDown.unmodifiedText = '\r';
  }
  // #607: success is a capture-phase keydown on the page, not a resolved
  // Input.dispatchKeyEvent. A hidden tab is named in the error; the caller
  // does not activate the tab or raise the window.
  const installed = parsePressProbe(await evalStr(
    cdp, sid, pressProbeExpression('install', mapped), false, { raw: true, timeoutMs: 1500 },
  ));
  if (!installed?.installed) {
    throw pressNotDeliveredError(mapped.key, await probePageVisibility(cdp, sid));
  }
  try {
    await cdpDomains(cdp).Input.dispatchKeyEvent(keyDown, sid);
    // For printable single characters, send a `char` event so the page receives input
    // (mirrors what real keyboards do for letter / digit / punctuation keys).
    if (mapped.key.length === 1 && mapped.code !== 'Space' && mapped.key !== ' ') {
      await cdpDomains(cdp).Input.dispatchKeyEvent( { ...base, type: 'char', text: mapped.key, unmodifiedText: mapped.key }, sid);
    }
    await cdpDomains(cdp).Input.dispatchKeyEvent( { ...base, type: 'keyUp' }, sid);
    await confirmPressDelivered(cdp, sid, mapped, { waitMs: opts.deliveryWaitMs });
    return `Pressed ${mapped.key}`;
  } finally {
    try {
      await evalStr(cdp, sid, pressProbeExpression('cleanup', mapped), false, { raw: true, timeoutMs: 1500 });
    } catch {
      // The delivery result is already decided.
    }
  }
}
export function documentScrollToJs(topExpr) {
  return `Element.prototype.scrollTo.call(${DOCUMENT_SCROLLER_JS}, { left: 0, top: ${topExpr}, behavior: 'instant' })`;
}
export function documentScrollByJs(dx, dy) {
  return `Element.prototype.scrollBy.call(${DOCUMENT_SCROLLER_JS}, { left: ${dx}, top: ${dy}, behavior: 'instant' })`;
}
// #560: `scroll <t> "to top"` passes the edge phrase as one argument. Split it, so every positional
// reader (edge parse, --scroll-container, receipts, export) sees `to` and the edge separately.
export function splitScrollEdgeArgs(args = []) {
  const list = Array.isArray(args) ? args.map(arg => String(arg)) : [];
  const words = String(list[0] || '').trim().split(/\s+/);
  if (words.length < 2 || words[0].toLowerCase() !== 'to') return list;
  return [...words, ...list.slice(1)];
}
function scrollDirectionError(message) {
  const err = new Error(message);
  err.usage = true;
  err.code = 'usage';
  return err;
}
export function parseScrollEdge(direction, amount) {
  const first = String(direction || '').trim().toLowerCase();
  if (first !== 'to') return null;
  const second = String(amount || '').trim().toLowerCase();
  if (second === 'top' || second === 'bottom') return second;
  throw scrollDirectionError('Direction required: to top or to bottom');
}
export function parseScrollContainerArg(args = []) {
  const list = Array.isArray(args) ? args : [];
  let container = null;
  for (let i = 0; i < list.length; i++) {
    const token = list[i];
    if (token === '--scroll-container') {
      const value = list[++i];
      if (value == null || String(value).startsWith('--')) {
        throw new Error('scroll: --scroll-container requires a selector');
      }
      if (container != null) throw new Error('scroll: duplicate --scroll-container');
      container = String(value);
      continue;
    }
    if (String(token).startsWith('--')) {
      throw new Error(`scroll: unknown argument ${token}`);
    }
    throw new Error(`scroll: unexpected argument ${token}`);
  }
  return container;
}
export function scrollFeedbackPolicy(direction, amount) {
  return parseScrollEdge(direction, amount) ? 'report-only' : 'settle-diff';
}
export function scrollActionTarget(args = [], extra = {}) {
  const direction = args[0];
  const amount = args[1];
  const edge = parseScrollEdge(direction, amount);
  const target = {
    input: extra.input ?? [direction, amount].filter(Boolean).join(' '),
    resolvedBy: extra.resolvedBy ?? 'scroll',
    label: extra.label ?? (edge ? `to ${edge}` : (direction || 'scroll')),
    commandArgs: extra.commandArgs ?? (Array.isArray(args) ? args.filter(arg => arg != null && arg !== '') : []),
  };
  if (extra.targetId) target.targetId = extra.targetId;
  if (edge) target.expectedOutcome = DOCUMENT_SCROLL_EDGE_OUTCOME;
  return target;
}
export function scrollEdgeLogicSource() {
  const tolerance = DOCUMENT_SCROLL_EDGE_TOLERANCE_PX;
  return `
    const tolerance = ${tolerance};
    const nativeScrollTo = Element.prototype.scrollTo;
    const measureDocument = function() {
      const el = document.scrollingElement || document.documentElement;
      const scrollY = Math.round(window.scrollY);
      const scrollMax = Math.max(0, Math.round((Number(el && el.scrollHeight) || 0) - window.innerHeight));
      return {
        kind: 'document',
        scrollY: scrollY,
        scrollMax: scrollMax,
        atTop: scrollY <= tolerance,
        atBottom: scrollMax <= tolerance || scrollY >= scrollMax - tolerance,
      };
    };
    const measureEl = function(el) {
      const scrollTop = Math.round(Number(el && el.scrollTop) || 0);
      const clientHeight = Math.round(Number(el && el.clientHeight) || 0);
      const scrollHeight = Math.round(Number(el && el.scrollHeight) || 0);
      const scrollMax = Math.max(0, scrollHeight - clientHeight);
      return {
        scrollTop: scrollTop,
        scrollMax: scrollMax,
        atTop: scrollTop <= tolerance,
        atBottom: scrollMax <= tolerance || scrollTop >= scrollMax - tolerance,
      };
    };
    const overflowKeyword = function(el, axis) {
      const style = typeof window.getComputedStyle === 'function' ? window.getComputedStyle(el) : null;
      const named = style && (axis === 'x' ? style.overflowX : style.overflowY);
      return String(named || (style && style.overflow) || '');
    };
    // Explicit --scroll-container still accepts hidden: the caller named that box.
    const clipsOn = function(el, axis) {
      return /(auto|scroll|overlay|hidden)/.test(overflowKeyword(el, axis));
    };
    // Automatic selection matches perceive's Scroll line (auto, scroll, overlay).
    // overflow:hidden still accepts scrollLeft/scrollTop, so a full-page side-menu
    // wrapper would otherwise win the largest-area score and shove the page.
    const autoScrollableOverflow = function(el, axis) {
      return /(auto|scroll|overlay)/.test(overflowKeyword(el, axis));
    };
    const overflowMax = function(el, axis) {
      if (axis === 'x') return Math.max(0, (Number(el.scrollWidth) || 0) - (Number(el.clientWidth) || 0));
      return Math.max(0, (Number(el.scrollHeight) || 0) - (Number(el.clientHeight) || 0));
    };
    const isDocumentScroller = function(el) {
      return !el
        || el === document.documentElement
        || el === document.body
        || el === document.scrollingElement;
    };
    const isOverflowOn = function(el, axis) {
      if (isDocumentScroller(el)) return false;
      return overflowMax(el, axis) > tolerance && clipsOn(el, axis);
    };
    const isAutoScrollableOn = function(el, axis) {
      if (isDocumentScroller(el)) return false;
      return overflowMax(el, axis) > tolerance && autoScrollableOverflow(el, axis);
    };
    // Explicit --scroll-container matching, including a named overflow:hidden box.
    // Automatic up/down and to top/to bottom use isAutoScrollableOn.
    const isOverflow = function(el) {
      return isOverflowOn(el, 'y');
    };
    const nearestOverflow = function(start, axis) {
      for (let el = start; el && !isDocumentScroller(el); el = el.parentElement) {
        if (axis === 'x' ? (isOverflowOn(el, 'x') || isOverflow(el)) : isOverflow(el)) return el;
      }
      return null;
    };
    const primaryOverflowOn = function(axis) {
      const nodes = document.querySelectorAll ? document.querySelectorAll('*') : [];
      let best = null;
      let bestScore = 0;
      for (let i = 0; i < nodes.length; i++) {
        const el = nodes[i];
        if (!isAutoScrollableOn(el, axis)) continue;
        const max = overflowMax(el, axis);
        const area = (Number(el.clientWidth) || 0) * (Number(el.clientHeight) || 0);
        const score = max * Math.max(1, area);
        if (score > bestScore) {
          best = el;
          bestScore = score;
        }
      }
      return best;
    };
    const primaryOverflow = function() {
      return primaryOverflowOn('y');
    };
    const identityOf = function(el) {
      if (!el) return 'container';
      if (el.id) return '#' + String(el.id);
      return el.tagName ? String(el.tagName).toLowerCase() : 'container';
    };
    const applyEdge = function(el, dest) {
      const max = Math.max(0, (Number(el.scrollHeight) || 0) - (Number(el.clientHeight) || 0));
      nativeScrollTo.call(el, { top: dest === 'top' ? 0 : max, behavior: 'instant' });
      if (typeof Event === 'function' && typeof el.dispatchEvent === 'function') {
        try { el.dispatchEvent(new Event('scroll')); } catch {}
      }
    };
    const finishContainer = function(el) {
      const measured = measureEl(el);
      return {
        ok: true,
        kind: 'container',
        selector: identityOf(el),
        scrollTop: measured.scrollTop,
        scrollMax: measured.scrollMax,
        atTop: measured.atTop,
        atBottom: measured.atBottom,
      };
    };
    // axis 'x' also accepts a vertical overflow box, so an explicit container that
    // already scrolled sideways keeps doing so. Auto-detect does not use this helper.
    const matchesRequested = function(el, axis) {
      if (axis === 'x') return isOverflowOn(el, 'x') || isOverflow(el);
      return isOverflow(el);
    };
    const resolveContainer = function(requested, startNode, axis) {
      if (startNode) {
        if (matchesRequested(startNode, axis)) return { ok: true, el: startNode };
        const ancestor = nearestOverflow(startNode, axis);
        if (ancestor) return { ok: true, el: ancestor };
        return { ok: false, error: 'scroll-container is not scrollable' };
      }
      if (!requested) return { ok: true, el: null };
      if (typeof document.querySelector !== 'function') {
        return { ok: false, error: 'scroll-container not found' };
      }
      const found = document.querySelector(requested);
      if (!found) return { ok: false, error: 'scroll-container not found' };
      if (matchesRequested(found, axis)) return { ok: true, el: found };
      const ancestor = nearestOverflow(found, axis);
      if (ancestor) return { ok: true, el: ancestor };
      return { ok: false, error: 'scroll-container is not scrollable' };
    };
    const runScrollEdge = function(requested, dest, startNode) {
      const resolved = resolveContainer(requested, startNode);
      if (resolved.ok === false) return resolved;
      if (resolved.el) {
        applyEdge(resolved.el, dest);
        return finishContainer(resolved.el);
      }
      const doc = measureDocument();
      if (doc.scrollMax > tolerance) {
        ${documentScrollToJs("dest === 'top' ? 0 : doc.scrollMax")};
        return Object.assign({ ok: true }, measureDocument());
      }
      const overflow = primaryOverflow();
      if (!overflow) return Object.assign({ ok: true }, doc);
      applyEdge(overflow, dest);
      return finishContainer(overflow);
    };
  `;
}
// #640: a directional scroll moves the document when it can scroll on that axis (or the move is
// diagonal), else the page's main overflow container on that axis. Up/down use scrollHeight and
// overflow-y (the same container as `to bottom`). Left/right use scrollWidth and overflow-x, so a
// horizontal-only carousel is found without --scroll-container. Automatic selection accepts
// overflow auto, scroll, or overlay on that axis. overflow hidden stays out of that search;
// --scroll-container still scrolls a named hidden box.
// #657: that fallback prefers an open dialog's scroller when the background is scroll-locked, or
// when the dialog is modal. A document scroll that is already at the top or bottom says so.
// Kept out of scrollEdgeLogicSource: an edge scroll never calls scrollBy, and `to top` / `to bottom`
// keep the main overflow container (a dialog does not change those).
export function scrollByLogicSource() {
  return `
    const attrOf = function(el, name) {
      try {
        if (!el || typeof el.getAttribute !== 'function') return '';
        const value = el.getAttribute(name);
        return value == null ? '' : String(value);
      } catch (err) {
        return '';
      }
    };
    const hasOpen = function(el) {
      try {
        if (el && typeof el.hasAttribute === 'function') return el.hasAttribute('open');
      } catch (err) {}
      return !!(el && el.open === true);
    };
    const isShown = function(el) {
      if (!el || el.hidden === true) return false;
      const style = typeof window.getComputedStyle === 'function' ? window.getComputedStyle(el) : null;
      if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
      return true;
    };
    const isDialogCandidate = function(el) {
      if (!el || isDocumentScroller(el)) return false;
      const tag = String(el.tagName || '').toLowerCase();
      if (tag === 'dialog') return hasOpen(el);
      const role = attrOf(el, 'role').toLowerCase();
      if (role === 'dialog' || role === 'alertdialog') return true;
      return attrOf(el, 'aria-modal').toLowerCase() === 'true';
    };
    const isModalDialog = function(el) {
      if (attrOf(el, 'aria-modal').toLowerCase() === 'true') return true;
      try {
        return typeof el.matches === 'function' && el.matches(':modal');
      } catch (err) {
        return false;
      }
    };
    const backgroundScrollLocked = function(axis) {
      const locks = function(el) {
        return !!el && /(hidden|clip)/.test(overflowKeyword(el, axis));
      };
      return locks(document.body) || locks(document.documentElement);
    };
    const bestAutoScroller = function(root, axis) {
      let best = null;
      let bestScore = 0;
      const consider = function(node) {
        if (!isAutoScrollableOn(node, axis)) return;
        const max = overflowMax(node, axis);
        const area = (Number(node.clientWidth) || 0) * (Number(node.clientHeight) || 0);
        const score = max * Math.max(1, area);
        if (score > bestScore) {
          best = node;
          bestScore = score;
        }
      };
      consider(root);
      const inner = root && typeof root.querySelectorAll === 'function' ? root.querySelectorAll('*') : [];
      for (let i = 0; i < inner.length; i++) consider(inner[i]);
      return best;
    };
    // Last matching dialog in DOM order is the topmost. A non-modal dialog does not steal the
    // scroll unless the background is locked, which is the modal scroll-lock pattern.
    const preferDialogScroller = function(axis) {
      if (typeof document.querySelectorAll !== 'function') return null;
      let nodes = [];
      try {
        nodes = document.querySelectorAll('dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]') || [];
      } catch (err) {
        return null;
      }
      const locked = backgroundScrollLocked(axis);
      let chosen = null;
      for (let i = 0; i < nodes.length; i++) {
        const dialog = nodes[i];
        if (!isShown(dialog) || !isDialogCandidate(dialog)) continue;
        if (!locked && !isModalDialog(dialog)) continue;
        const scroller = bestAutoScroller(dialog, axis);
        if (scroller) chosen = scroller;
      }
      return chosen;
    };
    const runScrollBy = function(requested, dx, dy) {
      const axis = dy !== 0 ? 'y' : 'x';
      const resolved = resolveContainer(requested, null, axis);
      if (resolved.ok === false) return resolved;
      let el = resolved.el;
      if (!el) {
        const scroller = document.scrollingElement || document.documentElement;
        const docMax = dy !== 0
          ? measureDocument().scrollMax
          : Math.max(0, Math.round((Number(scroller && scroller.scrollWidth) || 0) - (Number(scroller && scroller.clientWidth) || Number(window.innerWidth) || 0)));
        if (docMax > tolerance || (dx !== 0 && dy !== 0)) {
          const beforeX = Math.round(Number(window.scrollX) || 0);
          const beforeY = Math.round(Number(window.scrollY) || 0);
          ${documentScrollByJs('dx', 'dy')};
          const afterX = Math.round(Number(window.scrollX) || 0);
          const afterY = Math.round(Number(window.scrollY) || 0);
          const after = measureDocument();
          const horizontalMax = dy !== 0 ? 0 : docMax;
          return {
            ok: true,
            kind: 'document',
            x: afterX,
            y: afterY,
            moved: afterX !== beforeX || afterY !== beforeY,
            scrollMax: dy !== 0 ? after.scrollMax : docMax,
            atTop: after.atTop,
            atBottom: after.atBottom,
            atLeft: afterX <= tolerance,
            atRight: horizontalMax <= tolerance || afterX >= horizontalMax - tolerance,
          };
        }
        el = preferDialogScroller(axis) || (dy !== 0 ? primaryOverflow() : (dx !== 0 ? primaryOverflowOn('x') : null));
        if (!el) return { ok: true, kind: 'none', x: Math.round(window.scrollX), y: Math.round(window.scrollY) };
      }
      const fromTop = Math.round(Number(el.scrollTop) || 0);
      const fromLeft = Math.round(Number(el.scrollLeft) || 0);
      Element.prototype.scrollBy.call(el, { left: dx, top: dy, behavior: 'instant' });
      if (typeof Event === 'function' && typeof el.dispatchEvent === 'function') {
        try { el.dispatchEvent(new Event('scroll')); } catch {}
      }
      const measured = measureEl(el);
      const scrollLeft = Math.round(Number(el.scrollLeft) || 0);
      return {
        ok: true,
        kind: 'container',
        selector: identityOf(el),
        fromTop: fromTop,
        scrollTop: measured.scrollTop,
        scrollMax: measured.scrollMax,
        fromLeft: fromLeft,
        scrollLeft: scrollLeft,
        atTop: measured.atTop,
        atBottom: measured.atBottom,
        moved: measured.scrollTop !== fromTop || scrollLeft !== fromLeft,
      };
    };
  `;
}
export function scrollByExpression(dx, dy, containerSelector = null) {
  const requested = containerSelector == null ? 'null' : JSON.stringify(containerSelector);
  return `(function() {
    /* chrome-cdp-ex.scroll-by */
    ${scrollEdgeLogicSource()}
    ${scrollByLogicSource()}
    return JSON.stringify(runScrollBy(${requested}, ${Number(dx) || 0}, ${Number(dy) || 0}));
  })()`;
}
// #640: the container receipt names what moved, from where to where.
export function formatScrollByContainerText(dx, dy, pos = {}) {
  const who = pos.selector || 'container';
  const vertical = Number(dy) !== 0;
  const edge = vertical && Number(dy) > 0 && pos.atBottom ? ' (at-bottom: yes)' : vertical && Number(dy) < 0 && pos.atTop ? ' (at-top: yes)' : '';
  if (!pos.moved) {
    const where = vertical ? (Number(dy) > 0 ? 'bottom' : 'top') : (Number(dx) > 0 ? 'right edge' : 'left edge');
    return vertical
      ? `Did not scroll: ${who} is already at the ${where}. scrollTop: ${pos.scrollTop} / ${pos.scrollMax} max`
      : `Did not scroll: ${who} is already at the ${where}. scrollLeft: ${pos.scrollLeft}`;
  }
  return vertical
    ? `Scrolled ${who} by (${dx}, ${dy}): scrollTop ${pos.fromTop} → ${pos.scrollTop} / ${pos.scrollMax} max${edge}`
    : `Scrolled ${who} by (${dx}, ${dy}): scrollLeft ${pos.fromLeft} → ${pos.scrollLeft}`;
}
// #657: the document receipt used to claim the requested delta even when the page was already
// at that edge. Name the edge, and do not claim a move that did not happen.
export function formatScrollByDocumentText(dx, dy, pos = {}) {
  const vertical = Number(dy) !== 0 && Number(dx) === 0;
  const horizontal = Number(dx) !== 0 && Number(dy) === 0;
  const edgeName = vertical
    ? (Number(dy) > 0 ? (pos.atBottom === true ? 'bottom' : '') : (pos.atTop === true ? 'top' : ''))
    : horizontal
      ? (Number(dx) > 0 ? (pos.atRight === true ? 'right edge' : '') : (pos.atLeft === true ? 'left edge' : ''))
      : '';
  if (pos.moved === false && edgeName) {
    if (vertical) {
      const flag = edgeName === 'bottom' ? 'at-bottom' : 'at-top';
      return `Did not scroll: the document is already at the ${edgeName}. scrollY: ${pos.y} / ${pos.scrollMax} max (${flag}: yes)`;
    }
    return `Did not scroll: the document is already at the ${edgeName}. scrollX: ${pos.x}`;
  }
  const hint = pos.moved === true && edgeName === 'bottom'
    ? ' (at-bottom: yes)'
    : pos.moved === true && edgeName === 'top'
      ? ' (at-top: yes)'
      : '';
  return `Scrolled by (${dx}, ${dy}). Position: (${pos.x}, ${pos.y})${hint}`;
}
export function scrollEdgeExpression(edge, containerSelector = null) {
  const dest = edge === 'top' ? 'top' : 'bottom';
  const requested = containerSelector == null ? 'null' : JSON.stringify(containerSelector);
  return `(function() {
    /* chrome-cdp-ex.scroll-edge */
    ${scrollEdgeLogicSource()}
    return JSON.stringify(runScrollEdge(${requested}, ${JSON.stringify(dest)}, null));
  })()`;
}
export function documentScrollEdgeExpression(edge, containerSelector = null) {
  return scrollEdgeExpression(edge, containerSelector);
}
export function documentScrollReachedEdge(edge, pos = {}) {
  return edge === 'top' ? pos.atTop === true : pos.atBottom === true;
}
export function formatDocumentScrollEdgeText(edge, pos = {}) {
  const flag = edge === 'top' ? 'at-top' : 'at-bottom';
  if (pos.kind === 'container') {
    const who = pos.selector ? `${pos.selector} ` : '';
    return `Scrolled to ${edge}. ${who}scrollTop: ${pos.scrollTop} / ${pos.scrollMax} max (${flag}: yes)`;
  }
  return `Scrolled to ${edge}. scrollY: ${pos.scrollY} / ${pos.scrollMax} max (${flag}: yes)`;
}
export function formatDocumentScrollEdgeFailure(edge, pos = {}) {
  const flag = edge === 'top' ? 'at-top' : 'at-bottom';
  if (pos.kind === 'container') {
    const who = pos.selector ? `${pos.selector} ` : '';
    return `Did not reach container ${edge}. ${who}scrollTop: ${pos.scrollTop} / ${pos.scrollMax} max (${flag}: no)`;
  }
  return `Did not reach document ${edge}. scrollY: ${pos.scrollY} / ${pos.scrollMax} max (${flag}: no)`;
}
export function parseScrollEdgePayload(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string' || !raw) throw new Error('scroll edge returned no result');
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('scroll edge returned no result');
  }
}
export async function scrollStr(cdp, sid, direction, amount, extraArgs = []) {
  const rest = Array.isArray(extraArgs) ? extraArgs : [];
  const edge = parseScrollEdge(direction, amount);
  if (edge) {
    const container = parseScrollContainerArg(rest);
    if (container && isRef(container)) {
      throw new Error('scroll: --scroll-container requires a CSS selector (same as table --scroll-container)');
    }
    const raw = await evalStr(cdp, sid, scrollEdgeExpression(edge, container));
    const pos = parseScrollEdgePayload(raw);
    if (pos && pos.ok === false) throw new Error(pos.error || 'scroll failed');
    if (!documentScrollReachedEdge(edge, pos)) {
      throw new Error(formatDocumentScrollEdgeFailure(edge, pos));
    }
    return formatDocumentScrollEdgeText(edge, pos);
  }
  // #640: the amount is optional, so `down --scroll-container SEL` arrives with the flag in the
  // amount slot. --scroll-container works with every direction.
  const flagged = typeof amount === 'string' && amount.startsWith('--');
  const container = parseScrollContainerArg(flagged ? [amount, ...rest] : rest);
  if (container && isRef(container)) {
    throw new Error('scroll: --scroll-container requires a CSS selector (same as table --scroll-container)');
  }
  const px = (flagged ? 0 : parseInt(amount)) || 500;
  const dirMap = { down: [0, px], up: [0, -px], left: [-px, 0], right: [px, 0] };
  let dx, dy;
  if (dirMap[direction?.toLowerCase()]) {
    [dx, dy] = dirMap[direction.toLowerCase()];
  } else if (direction?.includes(',')) {
    [dx, dy] = direction.split(',').map(Number);
    if (isNaN(dx) || isNaN(dy)) throw new Error('Invalid coordinates. Use "down", "up", or "x,y"');
  } else {
    throw scrollDirectionError('Direction required: down, up, left, right, x,y, or to top/to bottom');
  }
  const pos = parseScrollEdgePayload(await evalStr(cdp, sid, scrollByExpression(dx, dy, container)));
  if (pos && pos.ok === false) throw new Error(pos.error || 'scroll failed');
  if (pos.kind === 'container') return formatScrollByContainerText(dx, dy, pos);
  if (pos.kind === 'document') return formatScrollByDocumentText(dx, dy, pos);
  if (pos.kind === 'none') {
    const axisWord = dy !== 0 ? 'vertically' : 'horizontally';
    throw new Error(`scroll: nothing scrolled: nothing on the page scrolls ${axisWord}. Position: (${pos.x}, ${pos.y})`);
  }
  return `Scrolled by (${dx}, ${dy}). Position: (${pos.x}, ${pos.y})`;
}
// #640: the amount may follow --scroll-container; put the parts in the order the positional
// readers (scrollStr, scrollActionTarget) expect: direction, amount, then flags.
export function normalizeScrollArgs(args = []) {
  const list = splitScrollEdgeArgs(args);
  if (!list.length || String(list[0]).toLowerCase() === 'to') return list;
  const [direction, ...rest] = list;
  let amount = null;
  const flags = [];
  for (let i = 0; i < rest.length; i++) {
    const token = String(rest[i]);
    if (token === '--scroll-container') {
      flags.push(token);
      if (i + 1 < rest.length) flags.push(String(rest[++i]));
    } else if (amount == null && /^-?\d+$/.test(token)) {
      amount = token;
    } else {
      flags.push(token);
    }
  }
  return [direction, ...(amount == null ? [] : [amount]), ...flags];
}
export async function dispatchHoverMove(cdp, sid, x, y) {
  try {
    await cdpDomains(cdp).Input.dispatchMouseEvent(
      { x, y, type: 'mouseMoved', button: 'none', modifiers: 0 },
      sid,
      HOVER_MOUSE_ACK_TIMEOUT_MS,
    );
  } catch (error) {
    // Chrome waits for a renderer/compositor ack on mouseMoved. On live Chrome 151
    // that ack is often withheld until a ~5s input timeout, then the RPC still
    // succeeds. The event was already forwarded; do not block hover on the ack.
    // A background tab can apply :hover only when that ack completes. hoverStr
    // polls the page for :hover instead of lengthening this timeout.
    if (!isTimeoutError(error, ['Input.dispatchMouseEvent'])) throw error;
  }
}
// The centre of the target, in its own document. A child or an open-shadow
// descendant is the target. Anything else is the element at that point.
function hoverPointHitJs() {
  return [
    'let pointHit = null;',
    'try {',
    '  const hoverDoc = hoverEl.ownerDocument || document;',
    '  const hoverBox = hoverEl.getBoundingClientRect();',
    '  const hoverX = Number(hoverBox.x) + Number(hoverBox.width) * 0.5;',
    '  const hoverY = Number(hoverBox.y) + Number(hoverBox.height) * 0.5;',
    '  if (hoverDoc && typeof hoverDoc.elementFromPoint === "function" && Number.isFinite(hoverX) && Number.isFinite(hoverY)) {',
    '    let hoverTop = hoverDoc.elementFromPoint(hoverX, hoverY);',
    '    for (let hoverDepth = 0; hoverTop && hoverTop.shadowRoot && hoverDepth < 32; hoverDepth++) {',
    '      const hoverInner = hoverTop.shadowRoot.elementFromPoint(hoverX, hoverY);',
    '      if (!hoverInner || hoverInner === hoverTop) break;',
    '      hoverTop = hoverInner;',
    '    }',
    '    const hoverParent = node => {',
    '      const parent = node && node.parentNode;',
    '      return parent && parent.nodeType === 11 && parent.host ? parent.host : parent;',
    '    };',
    '    let hoverOnTarget = false;',
    '    for (let node = hoverTop, guard = 0; node && guard < 4096; node = hoverParent(node), guard++) {',
    '      if (node === hoverEl) { hoverOnTarget = true; break; }',
    '    }',
    '    const hoverDescribe = node => {',
    '      if (!node || !node.tagName) return "";',
    '      const tag = String(node.tagName).toUpperCase();',
    '      const id = node.id ? "#" + String(node.id).replace(/\\s+/g, "") : "";',
    '      const className = !id && typeof node.className === "string" ? node.className.trim() : "";',
    '      const classes = className ? "." + className.split(/\\s+/).slice(0, 2).join(".") : "";',
    '      const role = node.getAttribute ? String(node.getAttribute("role") || "").replace(/\\s+/g, " ").trim() : "";',
    '      const rolePart = role ? " role=\\"" + role.replace(/"/g, "") + "\\"" : "";',
    // #757: the shared receipt label (aria-label, then visible text, then title).
    `      const name = String(${targetLabelExpression('node')} || "").slice(0, 40).replace(/"/g, "'");`,
    '      return "<" + tag + id + classes + rolePart + ">" + (name ? " \\"" + name + "\\"" : "");',
    '    };',
    '    pointHit = hoverOnTarget ? { onTarget: true, label: "" } : { onTarget: false, label: hoverDescribe(hoverTop) };',
    '  }',
    '} catch (hoverPointErr) {',
    '  pointHit = null;',
    '}',
  ].join('\n');
}
export function hoverRevealStateJs(elExpr) {
  return `
    const hoverEl = ${elExpr};
    if (!hoverEl) return { ok: false, marker: ${JSON.stringify(HOVER_REVEAL_MARKER)} };
    const style = getComputedStyle(hoverEl);
    const opacity = Number(style.opacity);
    const visibility = String(style.visibility || '');
    const display = String(style.display || '');
    const visible = Number.isFinite(opacity) && opacity > 0 && visibility !== 'hidden' && display !== 'none';
    let matchesHover = null;
    let groupHover = false;
    try {
      matchesHover = hoverEl.matches(':hover') === true;
      groupHover = matchesHover || !!hoverEl.closest(':hover');
    } catch {}
    ${hoverPointHitJs()}
    return {
      ok: true,
      marker: ${JSON.stringify(HOVER_REVEAL_MARKER)},
      opacity,
      visibility,
      display,
      visible,
      groupHover,
      matchesHover,
      href: String(location.href || ''),
      tag: hoverEl.tagName,
      pointHit,
    };
  `;
}
export function hoverRevealStateExpression(selector) {
  return `(function() {
    void ${JSON.stringify(HOVER_REVEAL_MARKER)};
    ${hoverRevealStateJs(`document.querySelector(${JSON.stringify(selector)})`)}
  })()`;
}
export function hoverRevealStateAtPointExpression(x, y) {
  return `(function() {
    void ${JSON.stringify(HOVER_REVEAL_MARKER)};
    ${hoverRevealStateJs(`document.elementFromPoint(${Number(x)}, ${Number(y)})`)}
  })()`;
}
export function formatHoverOpacity(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value ?? '');
  if (Number.isInteger(n)) return String(n);
  return String(Math.round(n * 1000) / 1000);
}
export function parseHoverRevealState(raw) {
  let value = raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    try { value = JSON.parse(trimmed); } catch { return null; }
  }
  if (!value || typeof value !== 'object') return null;
  const opacity = Number(value.opacity);
  if (value.marker !== HOVER_REVEAL_MARKER && !Number.isFinite(opacity)) return null;
  return {
    ok: value.ok !== false,
    marker: HOVER_REVEAL_MARKER,
    opacity: Number.isFinite(opacity) ? opacity : null,
    visibility: value.visibility != null ? String(value.visibility) : '',
    display: value.display != null ? String(value.display) : '',
    visible: value.visible === true || (
      Number.isFinite(opacity)
      && opacity > 0
      && value.visibility !== 'hidden'
      && value.display !== 'none'
    ),
    groupHover: value.groupHover === true,
    matchesHover: value.matchesHover === true ? true : value.matchesHover === false ? false : null,
    href: value.href != null ? String(value.href) : undefined,
    tag: value.tag,
    x: value.x,
    y: value.y,
    pointHit: parseHoverPointHit(value.pointHit),
  };
}
function parseHoverPointHit(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const label = raw.label != null ? String(raw.label).replace(/\s+/g, ' ').trim().slice(0, 160) : '';
  return {
    onTarget: raw.onTarget === true,
    label,
  };
}
export function hoverDeliveryLanded(after) {
  if (!after || after.ok === false) return false;
  if (after.matchesHover === true) return true;
  // Older reveal reads omit matchesHover and report a landed hover as groupHover.
  if (after.matchesHover == null && after.groupHover === true) return true;
  return false;
}
export function hoverNotDeliveredError(selector, point, visibility, { coveredBy = '' } = {}) {
  const target = selector ? String(selector) : 'the target';
  const where = point && Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y))
    ? ` at CSS (${Math.round(Number(point.x))}, ${Math.round(Number(point.y))})`
    : '';
  const cover = coveredBy ? ` It is covered by ${coveredBy}.` : '';
  const hidden = visibility === 'hidden'
    ? " The tab's document.visibilityState is hidden."
    : '';
  const err = new Error(`hover: ${target}${where} did not match :hover.${cover}${hidden} The hover was not delivered.`);
  // Tagged at the source (#636): the Recovery reason reads this, not the message text.
  if (coveredBy) err.hoverCovered = true;
  return err;
}
function hoverDeliveryBudgetMs(visibility, waitMs) {
  const requested = Number.isFinite(Number(waitMs)) ? Number(waitMs) : null;
  if (visibility === 'visible') {
    return requested == null ? HOVER_VISIBLE_DELIVERY_WAIT_MS : Math.min(requested, HOVER_VISIBLE_DELIVERY_WAIT_MS);
  }
  return requested == null ? HOVER_DELIVERY_WAIT_MS : requested;
}
export async function confirmHoverDelivered(cdp, sid, readState, { selector = '', point = null, waitMs } = {}) {
  const visibility = await probePageVisibility(cdp, sid);
  const budget = hoverDeliveryBudgetMs(visibility, waitMs);
  const started = Date.now();
  let coverStreak = 0;
  let coveredBy = '';
  for (;;) {
    const after = await readState();
    if (hoverDeliveryLanded(after)) return after;
    const hit = visibility === 'visible' ? after?.pointHit : null;
    if (hit && hit.onTarget === false && hit.label) {
      coverStreak += 1;
      coveredBy = hit.label;
      if (coverStreak >= HOVER_VISIBLE_COVER_POLLS) {
        throw hoverNotDeliveredError(selector, point, visibility, { coveredBy });
      }
    } else {
      coverStreak = 0;
      coveredBy = '';
    }
    const elapsed = Date.now() - started;
    if (elapsed >= budget) break;
    const pause = Math.min(HOVER_DELIVERY_POLL_MS, budget - elapsed);
    if (pause > 0) await sleep(pause);
  }
  throw hoverNotDeliveredError(selector, point, visibility, {
    coveredBy: coverStreak > 0 ? coveredBy : '',
  });
}
export async function readHoverRevealOnObject(cdp, sid, objectId) {
  if (!objectId) return null;
  try {
    const result = await cdpDomains(cdp).Runtime.callFunctionOn({
      objectId,
      functionDeclaration: `function() {
        void ${JSON.stringify(HOVER_REVEAL_MARKER)};
        ${hoverRevealStateJs('this')}
      }`,
      returnByValue: true,
    }, sid, REF_RESOLVE_TIMEOUT);
    return parseHoverRevealState(result?.result?.value);
  } catch {
    return null;
  }
}
export function formatHoverRevealClause(before, after) {
  if (!after) return '';
  const parts = [];
  if (before?.opacity != null && after.opacity != null) {
    parts.push(`opacity ${formatHoverOpacity(before.opacity)}→${formatHoverOpacity(after.opacity)}`);
  } else if (after.opacity != null) {
    parts.push(`opacity ${formatHoverOpacity(after.opacity)}`);
  }
  if (after.visible === true) parts.push('visible');
  else if (after.visible === false) parts.push('hidden');
  if (after.groupHover === true) parts.push('groupHover');
  return parts.length ? ` ${parts.join(' ')}` : '';
}
export async function readHoverRevealState(cdp, sid, selector, point = null) {
  const expr = selector
    ? hoverRevealStateExpression(selector)
    : hoverRevealStateAtPointExpression(point?.x, point?.y);
  try {
    return parseHoverRevealState(await evalStr(cdp, sid, expr));
  } catch {
    return null;
  }
}
// #750: only click and jsclick resolve text= names; hover takes a CSS selector or an @ref.
export function assertHoverSelector(selector) {
  if (TEXT_SELECTOR_PREFIX_RE.test(String(selector ?? '').trim())) {
    throw new Error(`hover: ${JSON.stringify(String(selector))} is a text query; hover takes a CSS selector or an @ref. Only click and jsclick resolve text= names.`);
  }
}
export async function hoverStr(cdp, sid, selector, refMap, refState, options = {}) {
  if (!selector) throw new Error('CSS selector or @ref required');
  assertHoverSelector(selector);
  const waitMs = options.deliveryWaitMs;
  if (isRef(selector)) {
    const { rect: r, objectId } = await resolveRefRectNoScroll(cdp, sid, refMap, selector, refState);
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    const point = { x: cx, y: cy };
    const readAt = () => (objectId
      ? readHoverRevealOnObject(cdp, sid, objectId)
      : readHoverRevealState(cdp, sid, null, point));
    const before = await readAt();
    await dispatchHoverMove(cdp, sid, cx, cy);
    const after = await confirmHoverDelivered(cdp, sid, readAt, { selector, point, waitMs });
    return `Hovering over <${r.tag || '?'}> at CSS (${Math.round(cx)}, ${Math.round(cy)}) (${selector})${formatHoverRevealClause(before, after)}`;
  }
  const expr = `
    (function() {
      void ${JSON.stringify(HOVER_REVEAL_MARKER)};
      let el;
      try {
        el = document.querySelector(${JSON.stringify(selector)});
      } catch (err) {
        return { ok: false, error: 'Invalid selector: ' + (err && err.message ? err.message : String(err)) };
      }
      if (!el) return { ok: false, error: 'Element not found: ' + ${JSON.stringify(selector)} };
      const rect = el.getBoundingClientRect();
      const state = (function() {
        ${hoverRevealStateJs('el')}
      })();
      if (!state || state.ok === false) return state;
      return Object.assign({}, state, {
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2,
      });
    })()
  `;
  const result = await evalStr(cdp, sid, expr);
  const r = JSON.parse(result);
  if (!r.ok) throw new Error(r.error);
  const before = parseHoverRevealState(result);
  const point = { x: r.x, y: r.y };
  await dispatchHoverMove(cdp, sid, r.x, r.y);
  const after = await confirmHoverDelivered(
    cdp,
    sid,
    () => readHoverRevealState(cdp, sid, selector),
    { selector, point, waitMs },
  );
  return `Hovering over <${r.tag}> at CSS (${Math.round(r.x)}, ${Math.round(r.y)})${formatHoverRevealClause(before, after)}`;
}
export function parseDragSteps(value) {
  const raw = String(value ?? '').trim();
  const steps = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(steps) || steps < 1 || steps > DRAG_MAX_STEPS) {
    throw new Error(`drag: --steps must be an integer from 1 to ${DRAG_MAX_STEPS}`);
  }
  return steps;
}
export function parseDragArgs(args = []) {
  const positional = [];
  let steps = DRAG_DEFAULT_STEPS;
  let mode = 'auto';
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index] ?? '');
    if (arg === '--steps') steps = parseDragSteps(args[++index]);
    else if (arg.startsWith('--steps=')) steps = parseDragSteps(arg.slice('--steps='.length));
    else if (arg === '--html5' || arg === '--pointer') {
      const requested = arg.slice(2);
      if (mode !== 'auto' && mode !== requested) throw new Error('drag: --html5 and --pointer are mutually exclusive');
      mode = requested;
    } else if (arg.startsWith('--')) throw new Error(`drag: unknown flag ${arg}`);
    else positional.push(arg);
  }
  const [from, to] = positional;
  if (!from || !to) {
    throw new Error('drag: source and destination required (drag <target> <from sel|@ref> <to sel|@ref|x,y>)');
  }
  if (positional.length > 2) throw new Error(`drag: unexpected argument ${positional[2]}`);
  if (DRAG_POINT_RE.test(from)) throw new Error('drag: the source must be a CSS selector or @ref, not x,y coordinates');
  return { from, to, steps, mode };
}
export function dragElementLabel(point, input = '') {
  const text = String(point?.text || '').replace(/\s+/g, ' ').trim();
  const ref = isRef(input) || isCursorRef(input) ? ` (${input})` : '';
  return `<${point?.tag || '?'}>${text ? ` "${text}"` : ''}${ref}`;
}
// #436 for drags: the press and the drop go to whatever is on top at those points.
export function assertDragPointNotCovered(point, role, input) {
  const hit = point?.hit;
  if (!hit || hit.covered !== true) return;
  const by = !hit.within && (hit.byPosition === 'fixed' || hit.byPosition === 'sticky')
    ? `position:${hit.byPosition} ${hit.by}`
    : String(hit.by || '<unknown>');
  const within = hit.within ? ` (inside position:${hit.withinPosition} ${hit.within})` : '';
  const recentred = hit.recentred ? ' even after scrolling it to the viewport centre' : '';
  const verb = role === 'start' ? 'start on' : 'drop onto';
  const err = new Error(
    `drag ${role} point (${Math.round(Number(point.x) || 0)}, ${Math.round(Number(point.y) || 0)}) of ${dragElementLabel(point, input)} is covered by ${by}${within}${recentred}. `
    + `The drag was not sent: it would ${verb} the covering element.`
  );
  err.dragCovered = {
    point: role,
    input: String(input || ''),
    by: String(hit.by || ''),
    within: hit.within || null,
    withinPosition: hit.withinPosition || null,
    byPosition: hit.byPosition || null,
    dialog: hit.dialog === true,
    recentred: hit.recentred === true,
  };
  throw err;
}
export function dragSourceExpression(selector) {
  return `(async function() {
    /* chrome-cdp-ex.drag-source */
    let el;
    try {
      el = document.querySelector(${JSON.stringify(selector)});
    } catch (err) {
      return { ok: false, error: 'Invalid selector: ' + (err && err.message ? err.message : String(err)) };
    }
    if (!el) return { ok: false, error: 'Element not found: ' + ${JSON.stringify(selector)} };
    const rect = await (${scrollSettledRectFunctionDeclaration({ hitTest: true })}).call(el);
    return { ok: true, x: rect.x + rect.w / 2, y: rect.y + rect.h / 2, w: rect.w, h: rect.h, tag: rect.tag, text: rect.text, hit: rect.hit };
  })()`;
}
// The destination is read where it is: scrolling it into view could move the source away.
export function dragDestinationBody(el) {
  return `${clickPointHitFunctionSource()}
    const box = ${el}.getBoundingClientRect();
    const rect = { x: box.x, y: box.y, w: box.width, h: box.height };
    return {
      ok: true,
      x: rect.x + rect.w / 2,
      y: rect.y + rect.h / 2,
      w: rect.w,
      h: rect.h,
      vw: window.innerWidth,
      vh: window.innerHeight,
      tag: ${el}.tagName,
      text: ${targetLabelExpression(el)},
      hit: clickPointHit(${el}, rect),
    };`;
}
export function dragDestinationExpression(selector) {
  return `(function() {
    /* chrome-cdp-ex.drag-destination */
    let el;
    try {
      el = document.querySelector(${JSON.stringify(selector)});
    } catch (err) {
      return { ok: false, error: 'Invalid selector: ' + (err && err.message ? err.message : String(err)) };
    }
    if (!el) return { ok: false, error: 'Element not found: ' + ${JSON.stringify(selector)} };
    ${dragDestinationBody('el')}
  })()`;
}
export function dragDestinationRefFunctionDeclaration() {
  return `function() {
    ${dragDestinationBody('this')}
  }`;
}
export function dragPointExpression(x, y) {
  return `(function() {
    /* chrome-cdp-ex.drag-point */
    const el = document.elementFromPoint(${Number(x)}, ${Number(y)});
    return {
      ok: true,
      x: ${Number(x)},
      y: ${Number(y)},
      vw: window.innerWidth,
      vh: window.innerHeight,
      tag: el ? el.tagName : null,
      text: ${targetLabelExpression('el')},
      scrollX: Math.round(window.scrollX),
      scrollY: Math.round(window.scrollY),
    };
  })()`;
}
export function assertDragPointInViewport(point, role, label) {
  const { x, y, vw, vh } = point;
  if (!(Number(vw) > 0 && Number(vh) > 0)) return;
  if (x >= 0 && y >= 0 && x < vw && y < vh) return;
  const where = role === 'start' ? 'source' : 'drop target';
  const after = role === 'start' ? '' : ' after the source was scrolled into view';
  const err = new Error(
    `drag: ${where} ${label} is outside the viewport${after} (point (${Math.round(x)}, ${Math.round(y)}), viewport ${Math.round(vw)}x${Math.round(vh)}). `
    + 'Scroll so both points are visible, or drop at x,y CSS pixels.'
  );
  err.dragOffViewport = { point: role, x: Math.round(x), y: Math.round(y), vw: Math.round(vw), vh: Math.round(vh) };
  throw err;
}
export async function resolveDragSource(cdp, sid, input, refMap, refState) {
  if (isCursorRef(input)) {
    const r = resolveCursorRef(refMap, input, refState);
    return { x: r.x + r.w / 2, y: r.y + r.h / 2, w: r.w, h: r.h, tag: r.sel, text: r.text, hit: null };
  }
  if (isRef(input)) {
    const r = await resolveRef(cdp, sid, refMap, input, refState, { hitTest: true });
    return { x: r.x + r.w / 2, y: r.y + r.h / 2, w: r.w, h: r.h, tag: r.tag, text: r.text, hit: r.hit || null };
  }
  const r = JSON.parse(await evalStr(cdp, sid, dragSourceExpression(input)));
  if (!r.ok) throw new Error(cssClickMissMessage(input, r.error));
  return r;
}
export async function resolveDragDestination(cdp, sid, input, refMap, refState) {
  const coordinates = String(input).match(DRAG_POINT_RE);
  if (coordinates) {
    const point = JSON.parse(await evalStr(cdp, sid, dragPointExpression(Number(coordinates[1]), Number(coordinates[2]))));
    assertDragPointInViewport(point, 'drop', `(${point.x}, ${point.y})`);
    return { ...point, point: true };
  }
  if (isCursorRef(input)) {
    // A cursor ref is a perceive-time point: check it is still in the viewport and report what
    // is under it now. dragStr rejects it when scrolling the source moved the page.
    const r = resolveCursorRef(refMap, input, refState);
    const point = JSON.parse(await evalStr(cdp, sid, dragPointExpression(r.x + r.w / 2, r.y + r.h / 2)));
    assertDragPointInViewport(point, 'drop', `${input} (${Math.round(point.x)}, ${Math.round(point.y)})`);
    return { ...point, w: r.w, h: r.h, cursorRef: true, label: r.text || r.sel };
  }
  if (isRef(input)) {
    const r = await resolveRefRectNoScroll(cdp, sid, refMap, input, refState, {
      functionDeclaration: dragDestinationRefFunctionDeclaration(),
    });
    if (!(r.w > 0 && r.h > 0)) throw new Error(`drag: drop target ${dragElementLabel(r, input)} has no size (hidden or not rendered)`);
    // Checked in the frame's own viewport, then moved into top-level coordinates.
    assertDragPointInViewport(r, 'drop', dragElementLabel(r, input));
    const frameParsed = parseFrameRef(input);
    if (frameParsed) {
      const { entry } = frameScopedBackendNode(refState || {}, frameParsed);
      const offset = await frameViewportOffset(cdp, sid, entry);
      r.x += offset.x;
      r.y += offset.y;
    }
    return r;
  }
  const r = JSON.parse(await evalStr(cdp, sid, dragDestinationExpression(input)));
  if (!r.ok) throw new Error(cssClickMissMessage(input, r.error));
  if (!(r.w > 0 && r.h > 0)) throw new Error(`drag: drop target ${dragElementLabel(r, input)} has no size (hidden or not rendered)`);
  assertDragPointInViewport(r, 'drop', dragElementLabel(r, input));
  return r;
}
export function dragEventProbeInstallScript(x = null, y = null) {
  return `(function() {
    const key = ${JSON.stringify(DRAG_EVENT_PROBE_KEY)};
    const px = ${JSON.stringify(x == null ? null : Number(x))};
    const py = ${JSON.stringify(y == null ? null : Number(y))};
    // The element under the press point and up to four ancestors, with each one's index among
    // its parent's element children: a sortable reorder moves one of them, which the AX diff misses.
    const placement = [];
    let node = px == null ? null : document.elementFromPoint(px, py);
    for (let depth = 0; node && node.parentElement && depth < 5; depth++, node = node.parentElement) {
      placement.push({ node: node, parent: node.parentElement, index: Array.prototype.indexOf.call(node.parentElement.children, node) });
    }
    const types = ['pointerdown', 'mousedown', 'pointermove', 'mousemove', 'pointerup', 'mouseup',
      'dragstart', 'dragenter', 'dragover', 'drop', 'dragend'];
    const existing = window[key];
    if (existing && existing.handler) {
      for (const type of existing.types || types) window.removeEventListener(type, existing.handler, true);
    }
    const counts = {};
    const handler = function(event) { counts[event.type] = (counts[event.type] || 0) + 1; };
    for (const type of types) window.addEventListener(type, handler, true);
    window[key] = { types: types, handler: handler, counts: counts, placement: placement };
    return true;
  })()`;
}
export function dragEventProbeReadScript() {
  return `(function() {
    const key = ${JSON.stringify(DRAG_EVENT_PROBE_KEY)};
    const probe = window[key];
    if (!probe) return null;
    for (const type of probe.types || []) window.removeEventListener(type, probe.handler, true);
    try { delete window[key]; } catch (err) { window[key] = undefined; }
    const describe = function(el) {
      if (!el || !el.tagName) return '<?>';
      const id = el.id ? '#' + el.id : '';
      const text = !id ? String(el.getAttribute('aria-label') || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40) : '';
      return '<' + el.tagName + id + '>' + (text ? ' "' + text + '"' : '');
    };
    let moved = null;
    for (const entry of probe.placement || []) {
      const parent = entry.node.parentElement;
      if (!entry.node.isConnected) {
        moved = describe(entry.node) + ' was replaced in ' + describe(entry.parent);
        break;
      }
      if (parent !== entry.parent) {
        moved = describe(entry.node) + ' moved from ' + describe(entry.parent) + ' to ' + describe(parent);
        break;
      }
      const index = Array.prototype.indexOf.call(parent.children, entry.node);
      if (index !== entry.index) {
        moved = describe(entry.node) + ' index ' + entry.index + ' → ' + index + ' in ' + describe(parent);
        break;
      }
    }
    return { counts: probe.counts || {}, moved: moved };
  })()`;
}
export async function installDragEventProbe(cdp, sid, point = {}) {
  try {
    return (await evalStr(cdp, sid, dragEventProbeInstallScript(point.x, point.y))) === 'true';
  } catch {
    return false;
  }
}
export async function readDragEventProbe(cdp, sid) {
  try {
    const parsed = JSON.parse(await evalStr(cdp, sid, dragEventProbeReadScript()));
    if (!parsed || typeof parsed.counts !== 'object' || !parsed.counts) return null;
    return { counts: parsed.counts, moved: typeof parsed.moved === 'string' ? parsed.moved : null };
  } catch {
    return null;
  }
}
export function formatDragEventCounts(counts = {}) {
  const pointer = ['pointerdown', 'pointermove', 'pointerup'].some(type => counts[type] > 0);
  return DRAG_PROBE_EVENT_ORDER
    .filter(type => counts[type] > 0)
    // Chrome derives pointer* from the same mouse events; print the mouse twins only when pointer* is missing.
    .filter(type => !(pointer && type.startsWith('mouse')))
    .map(type => (counts[type] > 1 ? `${type}×${counts[type]}` : type))
    .join(', ');
}
export function dragNoPageEventsError(from, to, visibility = 'unknown') {
  const hidden = visibility === 'hidden'
    ? " The tab's document.visibilityState is hidden (window covered or minimised): Input.* events are dropped while hidden."
    : '';
  const err = new Error(
    `drag: Input.dispatchMouseEvent completed but the page received no mouse or drag events between (${Math.round(from.x)}, ${Math.round(from.y)}) and (${Math.round(to.x)}, ${Math.round(to.y)}). The drag failed closed.${hidden}`
  );
  err.visibility = visibility;
  return err;
}
// #471 review: a drag the page started but that never got a drop or a cancel leaves the
// renderer in drag mode, and the tab then ignores CDP mouse input until it reloads.
export function dragIncompleteError(from, fromInput, reason) {
  const why = reason === 'late'
    ? 'the page started an HTML5 drag only after the mouse was released (its dragstart handler ran longer than the gesture), so nothing was dropped. The drag was cancelled with Input.dispatchDragEvent dragCancel so the tab keeps taking input.'
    : 'the page fired dragstart but no drop or dragend, so the drag never finished. A dragCancel was sent so the tab keeps taking input.';
  const err = new Error(`drag: ${why} Source: ${dragElementLabel(from, fromInput)}.`);
  err.dragIncomplete = { reason };
  return err;
}
export function dragStaleCursorRefError(input) {
  return new Error(
    `drag: the ${input} drop point is stale: perceive measured it before the source was scrolled into view, and the page has scrolled since. `
    + 'Run perceive -C again, or drop at x,y CSS pixels.'
  );
}
export async function dispatchDragEventStep(cdp, sid, params) {
  return cdpDomains(cdp).Input.dispatchDragEvent(params, sid);
}
export function dragNotStartedError(from, fromInput) {
  return new Error(
    `drag --html5: Chrome did not start an HTML5 drag from ${dragElementLabel(from, fromInput)} (it is not draggable, or its dragstart handler cancelled the drag). `
    + 'The pointer press, moves, and release were still sent.'
  );
}
// Every Input call is awaited before the next one, so no dispatch promise is left
// pending without a handler (#464). Returns what was sent for the receipt.
export async function dispatchDrag(cdp, sid, from, to, { steps = DRAG_DEFAULT_STEPS, mode = 'auto' } = {}) {
  const base = { modifiers: 0, pointerType: 'mouse' };
  let data = null;
  let resolveIntercept = () => {};
  const intercepted = new Promise(resolve => { resolveIntercept = resolve; });
  const off = mode !== 'pointer' && typeof cdp?.onEvent === 'function'
    ? cdp.onEvent('Input.dragIntercepted', (params, msg) => {
      if (sid && msg?.sessionId && msg.sessionId !== sid) return;
      if (!data && params?.data) {
        data = params.data;
        resolveIntercept(data);
      }
    })
    : null;
  let intercepting = false;
  let interceptUnavailable = null;
  let pressedAt = null;
  let moves = 0;
  let dropSent = false;
  let cancelSent = false;
  try {
    if (mode !== 'pointer') {
      try {
        await cdpDomains(cdp).Input.setInterceptDrags({ enabled: true }, sid);
        intercepting = true;
      } catch (error) {
        if (mode === 'html5') throw new Error(`drag --html5: Input.setInterceptDrags is not available here (${error.message})`);
        interceptUnavailable = String(error?.message || error);
      }
    }
    await dispatchMouseEventAllowingAckTimeout(cdp, sid, { ...base, x: from.x, y: from.y, type: 'mouseMoved', button: 'none', buttons: 0 });
    await dispatchClickMouseEvent(cdp, sid, { ...base, x: from.x, y: from.y, type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1 });
    pressedAt = { x: from.x, y: from.y };
    await sleep(DRAG_PRESS_HOLD_MS);
    for (let step = 1; step <= steps && !data; step += 1) {
      const t = step / steps;
      const point = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
      await dispatchMouseEventAllowingAckTimeout(cdp, sid, { ...base, ...point, type: 'mouseMoved', button: 'left', buttons: 1 });
      pressedAt = point;
      moves = step;
      if (step < steps && !data) await sleep(DRAG_STEP_DELAY_MS);
    }
    if (intercepting && !data) {
      let timer;
      await Promise.race([
        intercepted,
        new Promise(resolve => { timer = setTimeout(resolve, DRAG_INTERCEPT_WAIT_MS); }),
      ]);
      clearTimeout(timer);
    }
    const html5 = Boolean(data);
    if (html5) {
      for (const type of ['dragEnter', 'dragOver', 'drop']) {
        await dispatchDragEventStep(cdp, sid, { type, x: to.x, y: to.y, data, modifiers: 0 });
      }
      dropSent = true;
    }
    await dispatchClickMouseEvent(cdp, sid, { ...base, x: to.x, y: to.y, type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1 });
    pressedAt = null;
    if (!html5 && intercepting) {
      // A dragstart handler still running at the release can start the drag afterwards. Wait for
      // the renderer to finish that task (one round trip), then give the intercept a moment to land.
      await evalStr(cdp, sid, '0', false, { timeoutMs: DRAG_LATE_START_SYNC_MS }).catch(() => {});
      if (!data) {
        let timer;
        await Promise.race([
          intercepted,
          new Promise(resolve => { timer = setTimeout(resolve, DRAG_LATE_START_GRACE_MS); }),
        ]);
        clearTimeout(timer);
      }
      if (data) {
        cancelSent = true;
        await dispatchDragEventStep(cdp, sid, { type: 'dragCancel', x: to.x, y: to.y, data, modifiers: 0 }).catch(() => {});
        return { mode: 'pointer', moves, lateStart: true };
      }
    }
    if (!html5 && mode === 'html5') return { mode: 'pointer', moves, notStarted: true };
    return { mode: html5 ? 'html5' : 'pointer', moves, interceptUnavailable };
  } finally {
    // A started drag that got no drop keeps the renderer in drag mode: cancel it first.
    if (data && !dropSent && !cancelSent) {
      await dispatchDragEventStep(cdp, sid, { type: 'dragCancel', x: to.x, y: to.y, data, modifiers: 0 }).catch(() => {});
    }
    // Never leave the left button held down in the page after a failed dispatch.
    if (pressedAt) {
      await dispatchClickMouseEvent(cdp, sid, { ...base, ...pressedAt, type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1 })
        .catch(() => {});
    }
    if (typeof off === 'function') off();
    if (intercepting) await cdpDomains(cdp).Input.setInterceptDrags({ enabled: false }, sid).catch(() => {});
  }
}
export function formatDragReceipt({ from, to, fromInput, toInput, sent, counts }) {
  const fromLabel = dragElementLabel(from, fromInput);
  const toLabel = to.point
    ? `(${Math.round(to.x)}, ${Math.round(to.y)})${to.tag ? ` over <${to.tag}>` : ''}`
    : dragElementLabel(to, toInput);
  const path = `(${Math.round(from.x)}, ${Math.round(from.y)}) → (${Math.round(to.x)}, ${Math.round(to.y)})`;
  const mode = sent.mode === 'html5'
    ? `mode: html5 — Chrome started a drag after ${sent.moves} mouseMoved; dragEnter, dragOver, drop sent with Input.dispatchDragEvent ${path}`
    : `mode: pointer — mousePressed, ${sent.moves} mouseMoved, mouseReleased ${path}`;
  const lines = [`Dragged ${fromLabel} → ${toLabel}`, mode];
  if (sent.interceptUnavailable) lines.push('Input.setInterceptDrags is unavailable here, so HTML5 drag-and-drop was not intercepted.');
  if (sent.moved) lines.push(`order: ${sent.moved}`);
  if (counts) {
    const events = formatDragEventCounts(counts);
    lines.push(`page events: ${events || 'none'}`);
    if (sent.mode === 'html5' && !(counts.drop > 0)) {
      lines.push('Drop not accepted: the destination fired no drop event (its dragover handler did not call preventDefault).');
    }
  }
  return lines.join('\n');
}
export async function readDragScroll(cdp, sid) {
  try {
    return JSON.parse(await evalStr(cdp, sid, 'JSON.stringify([Math.round(window.scrollX), Math.round(window.scrollY)])'));
  } catch {
    return null;
  }
}
// `state` is the action-receipt channel: `state.orderChange` makes a reorder count as a change.
export async function dragStr(cdp, sid, options, refMap, refState, state = null) {
  const opts = Array.isArray(options) ? parseDragArgs(options) : options;
  const scrollBefore = isCursorRef(opts.to) ? await readDragScroll(cdp, sid) : null;
  const from = await resolveDragSource(cdp, sid, opts.from, refMap, refState);
  if (!(from.w > 0 && from.h > 0)) throw new Error(`drag: source ${dragElementLabel(from, opts.from)} has no size (hidden or not rendered)`);
  assertDragPointNotCovered(from, 'start', opts.from);
  const to = await resolveDragDestination(cdp, sid, opts.to, refMap, refState);
  assertDragPointNotCovered(to, 'drop', opts.to);
  if (scrollBefore && to.cursorRef && (scrollBefore[0] !== to.scrollX || scrollBefore[1] !== to.scrollY)) {
    throw dragStaleCursorRefError(opts.to);
  }
  // Window capture listeners in the top document cannot see events inside an iframe.
  const framed = Boolean(parseFrameRef(opts.from) || parseFrameRef(opts.to));
  const probe = framed ? false : await installDragEventProbe(cdp, sid, from);
  let sent;
  let readout = null;
  try {
    sent = await dispatchDrag(cdp, sid, from, to, opts);
  } finally {
    if (probe) readout = await readDragEventProbe(cdp, sid);
  }
  const counts = readout ? readout.counts : null;
  if (counts && !Object.values(counts).some(count => count > 0)) {
    throw dragNoPageEventsError(from, to, await probePageVisibility(cdp, sid));
  }
  if (sent.notStarted) throw dragNotStartedError(from, opts.from);
  if (sent.lateStart) throw dragIncompleteError(from, opts.from, 'late');
  if (counts && counts.dragstart > 0 && !(counts.drop > 0) && !(counts.dragend > 0)) {
    // Covers --pointer and the no-interception fallback, where nothing else ends the drag.
    await dispatchDragEventStep(cdp, sid, { type: 'dragCancel', x: to.x, y: to.y, data: { items: [], dragOperationsMask: 1 }, modifiers: 0 }).catch(() => {});
    throw dragIncompleteError(from, opts.from, 'no-end');
  }
  if (readout?.moved) {
    sent.moved = readout.moved;
    if (state && typeof state === 'object') state.orderChange = readout.moved;
  }
  return formatDragReceipt({ from, to, fromInput: opts.from, toInput: opts.to, sent, counts });
}
export async function dispatchHoverWithLeftoverPolicy({
  cdp,
  sid,
  selector,
  refMap,
  refState,
  consoleBuf,
  exceptionBuf,
  lastPerceiveStore,
  targetId,
  nextCommand = null,
} = {}) {
  // Refuse a text query before the settle baseline reads the page.
  assertHoverSelector(selector);
  const dispatch = () => hoverStr(cdp, sid, selector, refMap, refState);
  if (hoverFeedbackPolicy(nextCommand) === 'report-only') {
    return dispatch();
  }
  let text;
  await rememberHoverSettleBaseline(
    cdp,
    sid,
    consoleBuf,
    exceptionBuf,
    refMap,
    lastPerceiveStore,
    refState,
    targetId,
    async () => {
      text = await dispatch();
    },
  );
  return text;
}
export async function rememberHoverSettleBaseline(
  cdp,
  sid,
  consoleBuf,
  exceptionBuf,
  refMap,
  lastPerceiveStore,
  refState,
  targetId,
  dispatchHover = null,
) {
  // Hover mutates live DOM (tooltips, :hover text) but historically printed a
  // one-liner and left last-perceive stale. Recapture default AX so the next
  // mutator does not steal hover's delta (#286). Snapshot settle-shape AX
  // before mouseMoved — leftover perceive -C -d 8 is a different line-set
  // than default recapture even when both still say hover:0, so that leftover
  // must not be the KEEP baseline. After dispatch, recapture immediately; if
  // the same shape already changed, KEEP. If it is still idle, discard
  // unconditionally (#291). Do not sit waitForHoverDomChange /
  // HOVER_MUTATION_TIMEOUT_MS: Chrome 151 mouseenter can land after that
  // window, and discard already keeps the next no-op scroll honest. Do not
  // emit ActionResult. Do not lengthen waitForSettle. Do not wait for the
  // compositor mouseMoved ack. hoverStr confirms :hover before it returns;
  // this recapture stays immediate and does not add another wait.
  const settleOpts = actionObservationPerceiveOpts(targetId);
  await perceiveStr(
    cdp,
    sid,
    consoleBuf,
    exceptionBuf,
    refMap,
    lastPerceiveStore,
    settleOpts,
    refState,
  );
  const before = lastPerceiveStore.output;
  if (typeof dispatchHover === 'function') {
    await dispatchHover();
  }
  await perceiveStr(
    cdp,
    sid,
    consoleBuf,
    exceptionBuf,
    refMap,
    lastPerceiveStore,
    settleOpts,
    refState,
  );
  if (hoverRecaptureShowsChange(before, lastPerceiveStore.output)) {
    return;
  }
  discardHoverIdleBaseline(lastPerceiveStore);
}
export async function waitForStr(cdp, sid, args, refMap, refState) {
  // Shared polling loop
  async function poll(jsExpr, formatResult, interval, timeoutMs, label) {
    const timeout = Math.min(Math.max(timeoutMs, 500), 300000);
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const found = await evalStr(cdp, sid, jsExpr);
      if (found !== 'null' && found !== '') return formatResult(JSON.parse(found));
      await sleep(interval);
    }
    throw new Error(`Timeout: ${label} not found within ${timeout}ms`);
  }

  // --any-of: regex-OR text wait, returns the first matching alternative.
  if (args[0] === '--any-of') {
    const pattern = args[1];
    if (!pattern) throw new Error('Pattern required after --any-of (e.g. "win|lose|escape")');
    let scope = 'body';
    let timeoutMs = 30000;
    for (let i = 2; i < args.length; i++) {
      if (args[i] === '--scope' || args[i] === '-s') scope = args[++i];
      else if (/^\d+$/.test(args[i])) timeoutMs = parseInt(args[i]);
    }
    const alternatives = pattern.split('|').filter(Boolean);
    if (alternatives.length === 0) throw new Error('--any-of pattern must contain at least one alternative');
    const altsJson = JSON.stringify(alternatives);
    return poll(
      `(function() {
        const el = document.querySelector(${JSON.stringify(scope)});
        if (!el) return null;
        const t = el.innerText || el.textContent || '';
        const alts = ${altsJson};
        for (const a of alts) {
          const idx = t.indexOf(a);
          if (idx !== -1) return { matched: a, snippet: t.substring(Math.max(0, idx - 20), idx + a.length + 60).trim(), len: t.length };
        }
        return null;
      })()`,
      r => `Found "${r.matched}" (page has ${r.len} chars): "...${r.snippet}..."`,
      400, timeoutMs, `any of [${alternatives.join(', ')}]`
    );
  }

  // --selector-stable: wait for selector's textContent to stop changing for stableMs.
  if (args[0] === '--selector-stable') {
    const selector = args[1];
    if (!selector) throw new Error('Selector required after --selector-stable');
    const stableMs = parseInt(args[2]) || 3000;
    const timeoutMs = parseInt(args[3]) || 30000;
    const deadline = Date.now() + Math.min(Math.max(timeoutMs, 500), 300000);
    let lastText = null;
    let stableSince = null;
    while (Date.now() < deadline) {
      const raw = await evalStr(cdp, sid, `(function() {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const t = el.innerText || el.textContent || '';
        return JSON.stringify({ len: t.length, hash: t });
      })()`);
      if (raw === 'null' || raw === '') {
        // selector not present yet — keep polling
        lastText = null; stableSince = null;
        await sleep(300);
        continue;
      }
      const cur = JSON.parse(raw);
      if (lastText !== null && cur.hash === lastText) {
        if (stableSince == null) stableSince = Date.now();
        if (Date.now() - stableSince >= stableMs) {
          return `Selector "${selector}" stable for ${stableMs}ms (${cur.len} chars)`;
        }
      } else {
        lastText = cur.hash;
        stableSince = null;
      }
      await sleep(Math.min(300, stableMs / 4));
    }
    throw new Error(`Timeout: "${selector}" did not stabilise within ${timeoutMs}ms`);
  }

  // --gone: wait for element to DISAPPEAR (e.g. stop button after streaming)
  if (args[0] === '--gone') {
    const selector = args[1];
    if (!selector) throw new Error('CSS selector or @ref required after --gone');
    const timeoutMs = parseInt(args[2]) || 30000;
    const timeout = Math.min(Math.max(timeoutMs, 500), 300000);
    const deadline = Date.now() + timeout;

    // Resolve @ref in a tool-owned isolated world so page code cannot forge
    // connectivity or visibility while we wait.
    if (isRef(selector) && refMap) {
      const frameParsed = parseFrameRef(selector);
      if (frameParsed) {
        frameScopedBackendNode(refState || {}, frameParsed);
      } else {
        const num = parseInt(selector.slice(1));
        if (!refMap.has(num)) throw new Error(formatUnknownRefError(selector, refState || {}));
      }
      while (Date.now() < deadline) {
        try {
          const objectId = await resolveRefNode(cdp, sid, refMap, selector, refState);
          const res = await cdpDomains(cdp).Runtime.callFunctionOn( {
            objectId,
            functionDeclaration: trustedRefPresenceFunctionDeclaration(),
            returnByValue: true,
          }, sid, REF_RESOLVE_TIMEOUT);
          if (res.exceptionDetails) throw new Error(runtimeExceptionMessage(res.exceptionDetails));
          const presence = res.result?.value;
          if (presence?.error) throw new Error(`Trusted ref presence probe failed: ${presence.error}`);
          if (presence?.connected !== true) {
            if (presence?.connected !== false) {
              throw new Error('Trusted ref presence probe returned no connectivity result');
            }
            invalidateRefMapping(refMap, selector, refState);
            return `Element ${selector} is gone (disconnected)`;
          }
          if (presence.visible !== true) return `Element ${selector} is gone (hidden)`;
        } catch (error) {
          if (isStaleRefError(error)) return `Element ${selector} is gone (removed from DOM)`;
          throw error;
        }
        await sleep(300);
      }
      throw new Error(`Timeout: ${selector} still present after ${timeout}ms`);
    }

    // CSS selector mode
    while (Date.now() < deadline) {
      const found = await evalStr(cdp, sid, `document.querySelector(${JSON.stringify(selector)}) ? 'yes' : null`);
      if (found === 'null' || found === '') return `Element "${selector}" is gone`;
      await sleep(300);
    }
    throw new Error(`Timeout: "${selector}" still present after ${timeout}ms`);
  }

  // Parse args: waitfor <selector> [timeout] OR waitfor --text <text> [--scope <sel>] [timeout]
  if (args[0] === '--text') {
    const text = args[1];
    if (!text) throw new Error('Text string required after --text');
    let scope = 'body';
    let timeoutMs = 30000;
    for (let i = 2; i < args.length; i++) {
      if (args[i] === '--scope' || args[i] === '-s') scope = args[++i];
      else timeoutMs = parseInt(args[i]) || 30000;
    }
    return poll(
      `(function() {
        const el = document.querySelector(${JSON.stringify(scope)});
        if (!el) return null;
        const t = el.innerText;
        const idx = t.indexOf(${JSON.stringify(text)});
        if (idx === -1) return null;
        return { len: t.length, snippet: t.substring(Math.max(0, idx - 20), idx + ${text.length} + 80).trim() };
      })()`,
      r => `Found text (page has ${r.len} chars): "...${r.snippet}..."`,
      500, timeoutMs, `text "${text}"`
    );
  }
  // CSS selector mode
  const selector = args[0];
  if (!selector) throw new Error('CSS selector or --text required');
  const timeoutMs = parseInt(args[1]) || 10000;
  try {
    return await poll(
      `(function() {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        return { tag: el.tagName, text: el.textContent.trim().substring(0, 80) };
      })()`,
      r => `Found <${r.tag}> "${r.text}"`,
      200, timeoutMs, `"${selector}"`
    );
  } catch (e) {
    throw new Error(e.message + ' — to wait for specific text content instead, use: waitfor --text "expected text" 120000');
  }
}
export function formatInputTextPreview(text) {
  return `${text.substring(0, 40)}${text.length > 40 ? '...' : ''}`;
}
export function fillableControlProbeDeclaration() {
  return `function() {
    const el = this;
    const tag = el && el.tagName ? String(el.tagName).toUpperCase() : '?';
    const type = String(el && el.type || '').toLowerCase();
    const role = String(el && el.getAttribute && el.getAttribute('role') || '').toLowerCase();
    const fillable = !!(el && (
      el.isContentEditable
      || tag === 'TEXTAREA'
      || (tag === 'INPUT' && ${JSON.stringify(NON_FILLABLE_INPUT_TYPES)}.indexOf(type) === -1)
      || role === 'textbox' || role === 'searchbox' || role === 'combobox'
    ));
    return { ok: fillable, fillable, tag, type, role, maxLength: ${fillMaxLengthExpression('el')} };
  }`;
}
export function formControlStateProbeDeclaration() {
  return `function() {
    const el = this;
    if (!el || !el.tagName) return null;
    const tag = String(el.tagName).toLowerCase();
    const type = String(el.type || '').toLowerCase();
    const state = { tag: tag, type: type, id: el.id || '' };
    if (type === 'checkbox' || type === 'radio') state.checked = el.checked === true;
    if (tag === 'select') {
      state.multiple = Boolean(el.multiple);
      state.selected = Array.from(el.selectedOptions || []).map(opt => String(opt.value || ''));
      state.value = String(el.value || '');
    }
    const names = ${JSON.stringify(ARIA_CONTROL_STATE_ATTRS)};
    const aria = {};
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      if (el.hasAttribute && el.hasAttribute(name)) aria[name] = String(el.getAttribute(name));
    }
    if (Object.keys(aria).length) state.aria = aria;
    return state;
  }`;
}
export function parseFormControlStateSnapshot(raw) {
  if (raw == null || raw === '' || raw === 'null' || raw === 'undefined') return null;
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}
export function shouldSnapshotFormControlState(action, target = {}) {
  const name = String(action || '').toLowerCase();
  if (!['click', 'jsclick', 'select'].includes(name)) return false;
  const input = String(target.input || '').trim();
  if (!input) return false;
  if (target.resolvedBy === 'coordinates' || target.resolvedBy === 'key' || target.resolvedBy === 'history') {
    return false;
  }
  return isRef(input) || isCursorRef(input) || /^[#.[a-zA-Z*]/.test(input);
}
export function ariaControlStateValue(snapshot, name) {
  const aria = snapshot?.aria;
  if (!aria || typeof aria !== 'object' || !Object.prototype.hasOwnProperty.call(aria, name)) return null;
  return aria[name] == null ? '' : String(aria[name]);
}
export function formatAriaControlStateDiff(before, after) {
  const shown = (value) => {
    if (value == null) return '(absent)';
    if (value === '') return '(empty)';
    return value;
  };
  const parts = [];
  for (const name of ARIA_CONTROL_STATE_ATTRS) {
    const left = ariaControlStateValue(before, name);
    const right = ariaControlStateValue(after, name);
    if (left === right) continue;
    parts.push(`${name} ${shown(left)} → ${shown(right)}`);
  }
  return parts.join('; ');
}
export function formControlStateChanged(before, after) {
  if (!before || !after) return false;
  if (Object.prototype.hasOwnProperty.call(before, 'checked')
    || Object.prototype.hasOwnProperty.call(after, 'checked')) {
    if (Boolean(before.checked) !== Boolean(after.checked)) return true;
  }
  const beforeSelected = Array.isArray(before.selected) ? before.selected.join('\0') : null;
  const afterSelected = Array.isArray(after.selected) ? after.selected.join('\0') : null;
  if ((beforeSelected != null || afterSelected != null) && beforeSelected !== afterSelected) return true;
  return ARIA_CONTROL_STATE_ATTRS.some(name => ariaControlStateValue(before, name) !== ariaControlStateValue(after, name));
}
export function formatFormControlStateDiff(before, after) {
  const id = after?.id || before?.id || after?.tag || before?.tag || 'control';
  const label = id ? `#${id}` : (after?.tag || 'control');
  const aria = formatAriaControlStateDiff(before, after);
  const withAria = (line) => (aria ? `${line}; ${aria}` : line);
  if (Object.prototype.hasOwnProperty.call(before || {}, 'checked')
    || Object.prototype.hasOwnProperty.call(after || {}, 'checked')) {
    return withAria(`${after?.type || before?.type || 'checkbox'} ${label} checked ${Boolean(before?.checked)} → ${Boolean(after?.checked)}`);
  }
  if (Array.isArray(before?.selected) || Array.isArray(after?.selected)) {
    return withAria(`select ${label} selected ${JSON.stringify(before?.selected || [])} → ${JSON.stringify(after?.selected || [])}`);
  }
  return aria;
}
const ARIA_STATE_TOKEN_RE = /^(?:true|false|mixed|undefined|\(absent\)|\(empty\))$/;
// A cross-site control's id, option values, and free-form attribute values are that frame's page
// text. Its diff keeps only aria state changes between ARIA's own tokens.
export function formatActionControlStateDiff(cdp, sid, selector, refState, before, after) {
  const diff = formatFormControlStateDiff(before, after);
  if (!isRef(selector) || !crossSiteListed(cdp, sid, selector, refState)) return diff;
  const checked = Object.hasOwn(before || {}, 'checked') || Object.hasOwn(after || {}, 'checked')
    ? [`${after?.type === 'radio' ? 'radio' : 'checkbox'} checked ${Boolean(before?.checked)} → ${Boolean(after?.checked)}`]
    : [];
  const kept = [...checked, ...ariaControlStateReceiptClause(diff)
    .split('; ')
    .filter((part) => {
      const match = /^aria-[a-z]+ (\S+) → (\S+)$/.exec(part);
      return Boolean(match && ARIA_STATE_TOKEN_RE.test(match[1]) && ARIA_STATE_TOKEN_RE.test(match[2]));
    })]
    .join('; ');
  return kept || 'changed inside the cross-site frame; values not shown';
}
export function ariaControlStateReceiptClause(diff) {
  return String(diff || '')
    .split(';')
    .map(part => part.trim())
    .filter(part => /^aria-(?:pressed|expanded|checked|selected)\b/.test(part))
    .join('; ');
}
export async function snapshotFormControlState(cdp, sid, selector, refMap, refState) {
  if (!selector) return null;
  try {
    if (isRef(selector)) {
      const objectId = await resolveRefNode(cdp, sid, refMap, selector, refState, { allowCrossSite: true });
      const res = await cdpDomains(cdp).Runtime.callFunctionOn({
        objectId,
        functionDeclaration: `function() { return (${formControlStateProbeDeclaration()}).call(this); }`,
        returnByValue: true,
      }, resolvedNodeSession(cdp, sid, objectId));
      return parseFormControlStateSnapshot(res.result?.value);
    }
    const raw = await evalStr(cdp, sid, `(function() {
      let el;
      try { el = document.querySelector(${JSON.stringify(selector)}); }
      catch (err) { return null; }
      if (!el) return null;
      return (${formControlStateProbeDeclaration()}).call(el);
    })()`);
    return parseFormControlStateSnapshot(raw);
  } catch {
    return null;
  }
}
// In-page expression for a control's live value (`name` is the element variable).
export function fillControlValueExpression(name) {
  return `(${name} && ${name}.isContentEditable
      ? String(${name}.innerText || ${name}.textContent || '')
      : String((${name} && ${name}.value != null) ? ${name}.value : (${name} && ${name}.textContent) || ''))`;
}
// Probe + optional pre-clear. `before` is the value the control held before fill touched it.
// A clear (`fill ""`) skips the pre-clear: assigning el.value = '' through the instance setter
// updates React's value tracker, so the later native-setter clear would look like no change.
// #468: the selector first waits up to waitMs for an attached, visible, enabled element.
export function fillableControlPageProbe(selector, { clear = true, waitMs = 0 } = {}) {
  return `(async function() {
    const probe = ${fillableControlProbeDeclaration()};
    ${actionabilityFunctionSource()}
    document.querySelector(${JSON.stringify(selector)}); // an invalid selector throws here, before any wait
    const wait = await waitForActionable(() => document.querySelector(${JSON.stringify(selector)}), ${normalizeActionabilityWaitMs(waitMs)}, true, false);
    const waitInfo = { waited: wait.waited, waitedMs: wait.waitedMs, waitedFor: wait.waitedFor };
    const el = wait.el;
    if (!el) return { ok: false, error: 'Element not found: ' + ${JSON.stringify(selector)}, ...waitInfo };
    const info = probe.call(el);
    if (!info.fillable) {
      return {
        ok: false,
        error: 'fill: ' + ${JSON.stringify(selector)} + ' is not a fillable control (<' + info.tag + '>). Use click for links/buttons.',
        tag: info.tag,
      };
    }
    const disabled = actionDisabledReason(el, false);
    if (disabled) return { ok: false, disabled: { tag: info.tag, text: actionLabel(el), reason: disabled, matches: actionMatchCount(${JSON.stringify(selector)}) }, ...waitInfo };
    const before = ${fillControlValueExpression('el')};
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    el.focus();
    ${clear ? `if (el.isContentEditable) el.textContent = '';
    else el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));` : '// clear: native setter path follows'}
    return { ok: true, tag: info.tag, type: info.type, before: before, maxLength: info.maxLength, ...waitInfo };
  })()`;
}
export function fillableRefProbeDeclaration({ clear = true } = {}) {
  return `function() {
    const info = (${fillableControlProbeDeclaration()}).call(this);
    if (!info.fillable) return info;
    const el = this;
    ${actionabilityFunctionSource()}
    const disabled = actionDisabledReason(el, false);
    if (disabled) return { ...info, disabled: { tag: info.tag, text: actionLabel(el), reason: disabled } };
    info.before = ${fillControlValueExpression('el')};
    this.scrollIntoView({ block: 'center', behavior: 'instant' });
    this.focus();
    ${clear ? `if (this.isContentEditable) this.textContent = '';
    else this.value = '';
    this.dispatchEvent(new Event('input',{bubbles:true}));` : '// clear: native setter path follows'}
    return info;
  }`;
}
export function notFillableControlError(selector, tag) {
  const shown = selector || '<element>';
  const tagPart = tag ? ` (<${String(tag).toUpperCase()}>)` : '';
  return new Error(`fill: ${shown} is not a fillable control${tagPart}. Use click for links/buttons.`);
}
export function fillValuePreview(value) {
  const text = String(value);
  return text.length > FILL_VALUE_PREVIEW_MAX ? `${text.slice(0, FILL_VALUE_PREVIEW_MAX)}…` : text;
}
// Before/after/requested values for a fill receipt. `changed` compares the raw live values;
// password fields (and selectors that look sensitive) never echo a non-empty value. A named
// secret (`fill --secret NAME`, #469) shows as <secret:NAME> wherever the value would be.
export function buildFillValueState({ before = null, after = null, requested = '', inputType = '', sensitive = false, secretName = null } = {}) {
  const marker = secretName ? secretMarker(secretName) : null;
  const shown = (value) => {
    if (value == null) return null;
    if (marker && value !== '' && String(value) === String(requested)) return marker;
    if ((sensitive || marker) && value !== '') return REDACTED_VALUE;
    return fillValuePreview(value);
  };
  return {
    before: shown(before),
    after: shown(after),
    requested: shown(requested),
    inputType: inputType ? String(inputType).toLowerCase() : null,
    changed: before == null || after == null ? null : String(before) !== String(after),
    ...(sensitive ? { redacted: true } : {}),
  };
}
// A receipt value: quoted text, or a bare <redacted>/<secret:NAME> marker so it never reads as a literal.
export function fillValueDisplay(value) {
  if (value == null) return '(unknown)';
  return value === REDACTED_VALUE || /^<secret:[A-Z0-9_]+>$/.test(value) ? value : JSON.stringify(value);
}
export function fillValueRejectedError(selector, text, state = null) {
  const shown = selector || '<element>';
  const requested = state?.requested ?? formatInputTextPreview(String(text ?? ''));
  let detail = 'live value is still empty';
  if (state?.changed === true) {
    detail = `value changed ${fillValueDisplay(state.before)} → ${fillValueDisplay(state.after)}`;
  } else if (state?.after) {
    detail = `value stayed ${fillValueDisplay(state.after)}`;
  }
  const err = new Error(`fill: ${shown} did not accept "${requested}"; ${detail}`);
  if (state) err.fillValue = state;
  return err;
}
export function fillLiveValueDeclaration() {
  return `function() {
    const el = this;
    const cdpFillLiveValue = true;
    const value = ${fillControlValueExpression('el')};
    return {
      ok: true,
      cdpFillLiveValue,
      tag: el && el.tagName ? String(el.tagName).toUpperCase() : '?',
      type: String(el && el.type || '').toLowerCase(),
      value,
      textContent: String(el && el.textContent || ''),
      field: ${fillFieldDescriptorExpression('el')},
      maxLength: ${fillMaxLengthExpression('el')},
    };
  }`;
}
// #748: the maxlength the browser enforces on typed text: a <textarea>, or an <input> of a text
// type. Chrome ignores maxlength on number, date and the other input types. null when none applies.
export function fillMaxLengthExpression(name) {
  return `(function(el) {
      if (!el) return null;
      const tag = String(el.tagName || '').toUpperCase();
      const type = String(el.type || '').toLowerCase();
      const applies = tag === 'TEXTAREA' || (tag === 'INPUT' && ['text', 'search', 'url', 'tel', 'email', 'password'].indexOf(type) !== -1);
      return applies && Number.isInteger(el.maxLength) && el.maxLength >= 0 ? el.maxLength : null;
    })(${name})`;
}
// #748: a user cannot type more than maxlength UTF-16 code units, and fill keeps the same limit.
// A surrogate pair at the cut is dropped whole.
export function keepWithinMaxLength(text, maxLength) {
  const value = String(text ?? '');
  if (!Number.isInteger(maxLength) || maxLength < 0 || value.length <= maxLength) return value;
  const kept = value.slice(0, maxLength);
  return /[\uD800-\uDBFF]$/.test(kept) ? kept.slice(0, -1) : kept;
}
// A sensitive value's length stays out of the note.
export function formatFillMaxLengthNote(wanted, kept, maxLength, { sensitive = false } = {}) {
  if (kept.length >= String(wanted).length) return '';
  return ` (maxlength ${maxLength}: kept ${kept.length}${sensitive ? '' : ` of ${String(wanted).length}`} characters)`;
}
// The strings that name a control (#485): fill decides from them whether the typed value is secret.
export function fillFieldDescriptorExpression(name) {
  return `(function(el) {
      const attr = (key) => String(el && el.getAttribute && el.getAttribute(key) || '').slice(0, 200);
      const labels = Array.from(el && el.labels || []).slice(0, 3)
        .map(label => String(label.textContent || '').trim().slice(0, 200));
      return {
        id: attr('id'),
        name: attr('name'),
        autocomplete: attr('autocomplete'),
        ariaLabel: attr('aria-label'),
        placeholder: attr('placeholder'),
        labels,
      };
    })(${name})`;
}
export function fillLiveValuePageScript(selector) {
  return `(function() {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { ok: false, cdpFillLiveValue: true, error: 'Element not found: ' + ${JSON.stringify(selector)} };
    return (${fillLiveValueDeclaration()}).call(el);
  })()`;
}
// A CSS selector that matches exactly this element in its document, so a recovery command for
// an @ref can use `document.querySelector`. '' when none can be built (shadow DOM, detached).
export function fillUniqueSelectorDeclaration() {
  return `function() {
    const cdpFillUniqueSelector = true;
    const el = this;
    if (!el || el.nodeType !== 1 || !el.isConnected || el.getRootNode() !== document) return '';
    const esc = (value) => (window.CSS && CSS.escape ? CSS.escape(value) : String(value).replace(/[^a-zA-Z0-9_-]/g, ch => '\\\\' + ch));
    const uniqueId = (node) => {
      if (!node.id) return '';
      const sel = '#' + esc(node.id);
      try { return document.querySelectorAll(sel).length === 1 ? sel : ''; } catch (e) { return ''; }
    };
    const parts = [];
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const id = uniqueId(node);
      if (id) { parts.unshift(id); break; }
      if (node === document.documentElement) { parts.unshift('html'); break; }
      let index = 1;
      for (let sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) {
        if (sib.tagName === node.tagName) index++;
      }
      parts.unshift(node.tagName.toLowerCase() + ':nth-of-type(' + index + ')');
    }
    const selector = parts.join(' > ');
    try { return document.querySelector(selector) === el ? selector : ''; } catch (e) { return ''; }
  }`;
}
export async function fillRefUniqueSelector(cdp, sid, selector, refMap, refState) {
  if (!isRef(selector) || parseFrameRef(selector)) return '';
  try {
    const objectId = await resolveRefNode(cdp, sid, refMap, selector, refState);
    const res = await cdpDomains(cdp).Runtime.callFunctionOn({
      objectId,
      functionDeclaration: fillUniqueSelectorDeclaration(),
      returnByValue: true,
    }, sid);
    const value = res.result?.value;
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}
export function parseFillLiveSnapshot(raw) {
  let parsed = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); } catch { parsed = null; }
  }
  if (!parsed || typeof parsed !== 'object') return { ok: false, value: '', textContent: '' };
  return {
    ok: parsed.ok !== false,
    tag: parsed.tag || '?',
    type: parsed.type ? String(parsed.type) : '',
    value: String(parsed.value ?? ''),
    textContent: String(parsed.textContent ?? ''),
    field: parsed.field && typeof parsed.field === 'object' ? parsed.field : null,
    maxLength: Number.isInteger(parsed.maxLength) ? parsed.maxLength : null,
  };
}
// True when the control's own name, id, autocomplete, aria-label, placeholder or label marks it secret.
export function fillFieldLooksSensitive(field) {
  if (!field || typeof field !== 'object') return false;
  const texts = [field.id, field.name, field.autocomplete, field.ariaLabel, field.placeholder,
    ...(Array.isArray(field.labels) ? field.labels : [])];
  return texts.some(text => typeof text === 'string' && text && isSensitiveFieldText(text));
}
export function fillLiveValueAccepted(snapshot, wanted) {
  const expected = String(wanted ?? '');
  if (!snapshot || snapshot.ok !== true) return false;
  // A clear must check the value itself: an <input>'s textContent is always "", so it would
  // accept a field the page refilled. An emptied contenteditable may keep a trailing <br> ("\n").
  if (expected === '') return String(snapshot.value ?? '').replace(/\n+$/, '') === '';
  return snapshot.value === expected || snapshot.textContent === expected;
}
export async function readFillLiveValue(cdp, sid, selector, refMap, refState) {
  if (isRef(selector)) {
    const objectId = await resolveRefNode(cdp, sid, refMap, selector, refState, { allowCrossSite: true });
    const res = await cdpDomains(cdp).Runtime.callFunctionOn({
      objectId,
      functionDeclaration: fillLiveValueDeclaration(),
      returnByValue: true,
    }, resolvedNodeSession(cdp, sid, objectId));
    return parseFillLiveSnapshot(res.result?.value);
  }
  const raw = await evalStr(cdp, sid, fillLiveValuePageScript(selector));
  return parseFillLiveSnapshot(raw);
}
export async function fillLiveValueAcceptedNow(cdp, sid, selector, text, refMap, refState) {
  try {
    return fillLiveValueAccepted(await readFillLiveValue(cdp, sid, selector, refMap, refState), text);
  } catch {
    return false;
  }
}
export async function fillReactStr(cdp, sid, selector, text, refMap, refState) {
  const objectId = isRef(selector)
    ? await resolveRefNode(cdp, sid, refMap, selector, refState, { allowCrossSite: true })
    : await resolveSelectorNode(cdp, sid, selector);
  const nodeSid = resolvedNodeSession(cdp, sid, objectId);
  const probe = await cdpDomains(cdp).Runtime.callFunctionOn({
    objectId,
    functionDeclaration: `function() {
      const info = (${fillableControlProbeDeclaration()}).call(this);
      ${actionabilityFunctionSource()}
      const disabled = info.fillable ? actionDisabledReason(this, false) : '';
      if (disabled) info.disabled = { tag: info.tag, text: actionLabel(this), reason: disabled };
      return info;
    }`,
    returnByValue: true,
  }, nodeSid);
  const probed = probe.result?.value || {};
  if (probed.fillable !== true) throw notFillableControlError(selector, probed.tag);
  if (probed.disabled) {
    const facts = isRef(selector) ? crossSiteListed(cdp, sid, selector, refState) : null;
    throw frameAwareDisabledError('fill', probed.disabled, selector, facts);
  }
  const res = await cdpDomains(cdp).Runtime.callFunctionOn( {
    objectId,
    functionDeclaration: `function(value) {
      const el = this;
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      el.focus();
      if (el.isContentEditable) {
        el.textContent = value;
      } else {
        const proto = el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : el instanceof HTMLSelectElement
            ? HTMLSelectElement.prototype
            : HTMLInputElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(proto, 'value')
          || Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'value');
        if (descriptor && descriptor.set) descriptor.set.call(el, value);
        else el.value = value;
      }
      const inputEvent = typeof InputEvent === 'function'
        ? new InputEvent('input', { bubbles: true, cancelable: true, composed: true, inputType: value === '' ? 'deleteContent' : 'insertText', data: value === '' ? null : value })
        : new Event('input', { bubbles: true, cancelable: true });
      el.dispatchEvent(inputEvent);
      el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
      return { tag: el.tagName, value: el.isContentEditable ? el.textContent : el.value };
    }`,
    arguments: [{ value: keepWithinMaxLength(text, probed.maxLength) }],
    returnByValue: true,
  }, nodeSid);
  const tag = res.result.value?.tag || '?';
  return `React-filled ${isRef(selector) ? selector : `<${tag}>`} with "${formatInputTextPreview(keepWithinMaxLength(text, probed.maxLength))}"`;
}
export function formatFillDispatchText({ label, text, clearing, react, state, secretName = null }) {
  const before = state?.before;
  if (clearing) {
    if (before == null) return `Cleared ${label}`;
    return before === '' ? `Cleared ${label} (value unchanged: already empty)` : `Cleared ${label} (was ${fillValueDisplay(before)})`;
  }
  const shownText = secretName ? secretMarker(secretName) : formatInputTextPreview(text);
  const head = `${react ? 'React-filled' : 'Filled'} ${label} with "${shownText}"`;
  if (before == null || before === '') return head;
  if (state.changed === false) return `${head} (value unchanged: already ${fillValueDisplay(before)})`;
  return `${head} (was ${fillValueDisplay(before)})`;
}
// fill found the control sensitive in the page (#485): receipts, logs and records redact its value.
export function markSensitiveFillTarget(target, state) {
  if (!target || state?.redacted !== true) return target;
  target.sensitiveValue = true;
  const raw = SENSITIVE_FILL_RAW_VALUES.get(state);
  if (raw) SENSITIVE_FILL_RAW_VALUES.set(target, raw);
  return target;
}
// Turn a successful fill's value transition into receipt state on the action target.
export function applyFillValueState(target, state) {
  if (!target || !state || typeof state !== 'object' || !Object.hasOwn(state, 'after')) return target;
  markSensitiveFillTarget(target, state);
  target.fillValue = { before: state.before ?? null, after: state.after ?? null };
  if (state.maxLength && typeof state.maxLength === 'object') target.fillMaxLength = { ...state.maxLength };
  if (state.changed === true) {
    target.controlStateChanged = true;
    target.controlStateDiff = `value ${fillValueDisplay(state.before)} → ${fillValueDisplay(state.after)}`;
  } else if (state.changed === false) {
    target.expectedOutcome = target.expectedOutcome || 'fill-value-unchanged';
  }
  return target;
}
// fill <selector|@ref> <text>: clear the control, enter text, then verify the live value.
// `text === ''` clears the field through the native value setter (input + change events), the
// path React/Vue controlled inputs observe. The receipt compares the real before/after values.
// A CSS selector first waits up to `opts.waitMs` for an attached, visible, enabled control (#468).
export async function fillStr(cdp, sid, selector, text, refMap, refState, opts = {}) {
  if (!selector) throw new Error('CSS selector or @ref required');
  if (text == null) throw new Error('Text required');
  const wanted = String(text);
  const clearing = wanted === '';
  const ref = isRef(selector);
  const waitMs = normalizeActionabilityWaitMs(opts.waitMs);
  let waitNote = '';
  let before = null;
  let inputType = '';
  let tag = '?';
  let maxLength = null;
  if (opts.react) {
    if (!ref) {
      const wait = await waitForActionableSelector(cdp, sid, selector, { waitMs, visible: true });
      if (wait?.ok && !wait.found) throw new Error(actionabilityMissMessage(`Element not found: ${selector}`, wait));
      if (wait?.disabled) throw actionDisabledError('fill', { ...wait.disabled, waited: wait.waited, waitedMs: wait.waitedMs }, selector);
      waitNote = formatActionabilityWaitNote(wait);
    }
    const snapshot = await readFillLiveValue(cdp, sid, selector, refMap, refState).catch(() => null);
    if (snapshot?.ok) {
      before = snapshot.value;
      inputType = snapshot.type || '';
    }
    const out = await fillReactStr(cdp, sid, selector, wanted, refMap, refState);
    tag = out.match(/^React-filled <([^>]+)>/)?.[1] || tag;
  } else {
    let probed;
    let nodeSid = sid;
    if (ref) {
      const objectId = await resolveRefNode(cdp, sid, refMap, selector, refState, { allowCrossSite: true });
      nodeSid = resolvedNodeSession(cdp, sid, objectId);
      const probe = await cdpDomains(cdp).Runtime.callFunctionOn({
        objectId,
        functionDeclaration: fillableRefProbeDeclaration({ clear: !clearing }),
        returnByValue: true,
      }, nodeSid);
      probed = probe.result?.value || {};
      if (probed.fillable !== true) throw notFillableControlError(selector, probed.tag);
      if (probed.disabled) throw frameAwareDisabledError('fill', probed.disabled, selector, crossSiteListed(cdp, sid, selector, refState));
    } else {
      probed = JSON.parse(await evalStr(
        cdp,
        sid,
        fillableControlPageProbe(selector, { clear: !clearing, waitMs }),
        false,
        waitMs > 0 ? { timeoutMs: TIMEOUT + waitMs } : {},
      ));
      if (!probed.ok && probed.disabled) {
        throw actionDisabledError('fill', { ...probed.disabled, waited: probed.waited, waitedMs: probed.waitedMs }, selector);
      }
      if (!probed.ok) throw new Error(actionabilityMissMessage(probed.error, probed));
      waitNote = formatActionabilityWaitNote(probed);
    }
    if (typeof probed.before === 'string') before = probed.before;
    inputType = probed.type || '';
    tag = probed.tag || tag;
    maxLength = Number.isInteger(probed.maxLength) ? probed.maxLength : null;
    if (clearing) {
      await fillReactStr(cdp, sid, selector, wanted, refMap, refState);
    } else {
      const kept = keepWithinMaxLength(wanted, maxLength);
      await cdpDomains(cdp).Input.insertText( { text: kept }, nodeSid);
      if (!(await fillLiveValueAcceptedNow(cdp, sid, selector, kept, refMap, refState))) {
        await fillReactStr(cdp, sid, selector, kept, refMap, refState);
      }
    }
  }
  const after = await readFillLiveValue(cdp, sid, selector, refMap, refState).catch(() => null);
  if (maxLength == null && Number.isInteger(after?.maxLength)) maxLength = after.maxLength;
  const kept = keepWithinMaxLength(wanted, maxLength);
  const facts = ref ? crossSiteListed(cdp, sid, selector, refState) : null;
  if (facts) before = null;
  const secretName = opts.secretName || null;
  // One display rule: a named secret (#469) shows <secret:NAME>; any other sensitive field <redacted>.
  const sensitive = Boolean(secretName)
    || String(inputType || after?.type || '').toLowerCase() === 'password'
    || isSensitiveActionTarget('fill', { input: selector })
    || fillFieldLooksSensitive(after?.field);
  const state = buildFillValueState({
    before,
    after: after?.ok ? after.value : null,
    requested: kept,
    inputType: inputType || after?.type || '',
    sensitive,
    secretName,
  });
  if (kept.length < wanted.length) {
    state.maxLength = sensitive ? { limit: maxLength, kept: kept.length } : { limit: maxLength, kept: kept.length, requested: wanted.length };
    // #748: the page now holds the start of the secret; scrub that part too, on every fill path.
    if (secretName) rememberSessionSecret(daemonSecretStorage.getStore()?.session, secretName, kept);
  }
  if (opts.valueState && typeof opts.valueState === 'object') {
    Object.assign(opts.valueState, state);
    if (sensitive) {
      const typed = secretName ? { value: wanted, replacement: secretMarker(secretName) } : wanted;
      SENSITIVE_FILL_RAW_VALUES.set(opts.valueState, [typed, before, after?.value]);
    }
  }
  if (!fillLiveValueAccepted(after, kept)) {
    if (ref) {
      const unique = await fillRefUniqueSelector(cdp, sid, selector, refMap, refState);
      if (unique) state.selector = unique;
    }
    throw fillValueRejectedError(selector, secretName ? secretMarker(secretName) : kept, state);
  }
  const label = facts
    ? `${selector}${facts.host ? ` in ${facts.host}` : ''}`
    : (ref ? selector : `<${tag}>`);
  return `${formatFillDispatchText({ label, text: sensitive ? REDACTED_VALUE : kept, clearing, react: opts.react === true, state, secretName })}${formatFillMaxLengthNote(wanted, kept, maxLength, { sensitive })}${waitNote}`;
}
// An @ref names one node (#633). Apply it on that node; there is no selector to wait for.
export async function selectByRef(cdp, sid, selector, wanted, refMap, refState) {
  const objectId = await resolveRefNode(cdp, sid, refMap, selector, refState, { allowCrossSite: true });
  const evaluated = await cdpDomains(cdp).Runtime.callFunctionOn({
    objectId,
    functionDeclaration: `function() {
      ${actionabilityFunctionSource()}
      const el = this;
      if (!el || el.tagName !== 'SELECT') return { ok: false, error: 'Not a <select>: ' + (el && el.tagName ? el.tagName : '?') };
      const disabled = actionDisabledReason(el, false);
      if (disabled) return { ok: false, disabled: { tag: el.tagName, text: actionLabel(el), reason: disabled, matches: 1 } };
      const wanted = ${JSON.stringify(wanted)};
      const match = Array.from(el.options).find(opt => opt.value === wanted || String(opt.textContent || '').trim() === wanted);
      if (!match) return { ok: false, error: 'No option value=' + wanted };
      match.selected = true;
      el.value = match.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, text: String(match.textContent || '').trim() || match.value || wanted };
    }`,
    returnByValue: true,
  }, resolvedNodeSession(cdp, sid, objectId));
  if (evaluated.exceptionDetails) throw new Error(runtimeExceptionMessage(evaluated.exceptionDetails));
  const r = evaluated.result?.value || {};
  const facts = crossSiteListed(cdp, sid, selector, refState);
  if (!r.ok && r.disabled) throw frameAwareDisabledError('select', r.disabled, selector, facts);
  if (!r.ok) throw new Error(actionabilityMissMessage(r.error, r));
  if (facts) {
    return `Selected ${formatCrossSiteTarget({ tag: 'SELECT', ref: selector, host: facts.host })}${crossSitePageBlock(facts, r.text)}`;
  }
  return `Selected "${r.text}"`;
}
// The selector first waits up to `opts.waitMs` for an attached, enabled element (#468). Visibility is
// not required: select sets the value in the page, and custom dropdowns often hide the native <select>.
export async function selectStr(cdp, sid, selector, value, opts = {}, refMap, refState) {
  if (!selector) throw new Error('CSS selector or @ref required');
  if (value == null || String(value) === '') throw new Error('Value required');
  const wanted = String(value);
  if (isRef(selector)) return selectByRef(cdp, sid, selector, wanted, refMap, refState);
  const waitMs = normalizeActionabilityWaitMs(opts.waitMs);
  const expr = `
    (async function() {
      ${actionabilityFunctionSource()}
      document.querySelector(${JSON.stringify(selector)}); // an invalid selector throws here, before any wait
      const wait = await waitForActionable(() => document.querySelector(${JSON.stringify(selector)}), ${waitMs}, false, false);
      const waitInfo = { waited: wait.waited, waitedMs: wait.waitedMs, waitedFor: wait.waitedFor };
      const el = wait.el;
      if (!el) return { ok: false, error: 'Element not found: ' + ${JSON.stringify(selector)}, ...waitInfo };
      if (el.tagName !== 'SELECT') return { ok: false, error: 'Not a <select>: ' + el.tagName };
      const disabled = actionDisabledReason(el, false);
      if (disabled) return { ok: false, disabled: { tag: el.tagName, text: actionLabel(el), reason: disabled, matches: actionMatchCount(${JSON.stringify(selector)}) }, ...waitInfo };
      const wanted = ${JSON.stringify(wanted)};
      const match = Array.from(el.options).find(opt => opt.value === wanted || String(opt.textContent || '').trim() === wanted);
      if (!match) return { ok: false, error: 'No option value=' + wanted };
      match.selected = true;
      el.value = match.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, text: String(match.textContent || '').trim() || match.value || wanted, ...waitInfo };
    })()
  `;
  const result = await evalStr(cdp, sid, expr, false, waitMs > 0 ? { timeoutMs: TIMEOUT + waitMs } : {});
  const r = JSON.parse(result);
  if (!r.ok && r.disabled) throw actionDisabledError('select', { ...r.disabled, waited: r.waited, waitedMs: r.waitedMs }, selector);
  if (!r.ok) throw new Error(actionabilityMissMessage(r.error, r));
  return `Selected "${r.text}"${formatActionabilityWaitNote(r)}`;
}
export async function reloadActionDispatch({ cdp, sessionId, session, consoleBuf, exceptionBuf, navBuf, netReqBuf, pendingReqs, networkStatusByRequest, navigationCancelWatch = null }) {
  const buffers = reloadObservationBuffers(session, consoleBuf, exceptionBuf);
  const consoleBefore = typeof consoleBuf?.latest === 'function' ? consoleBuf.latest() : 0;
  const exceptionBefore = typeof exceptionBuf?.latest === 'function' ? exceptionBuf.latest() : 0;
  const consoleCutBefore = documentConsoleCutSeq(buffers.console);
  const exceptionCutBefore = documentConsoleCutSeq(buffers.exception);
  const reloadResult = await reloadStr(cdp, sessionId);
  // Checked before clearing buffers or refs: a cancelled reload left the page as it was.
  const cancelledBy = navigationCancelWatch
    ? await navigationCancelWatch({ awaitMs: NAVIGATION_CANCEL_EVIDENCE_WAIT_MS })
    : null;
  if (cancelledBy) throw navigationCancelledError('reload', cancelledBy);
  // #610: the main-frame commit already cut console and exception reads at that
  // document. Clearing those buffers after the load event dropped exceptions
  // thrown while the new document loaded, and cutting again here would move
  // the cut past those same entries. Navigation and network reads are not cut
  // that way, so those buffers are still cleared. The cleared netlog is saved
  // so a later daemon does not bring the pre-reload requests back.
  clearObservationBuffers({ navBuf, netReqBuf, pendingReqs, networkStatusByRequest, session });
  const consoleCutMoved = documentConsoleCutSeq(buffers.console) !== consoleCutBefore;
  const exceptionCutMoved = documentConsoleCutSeq(buffers.exception) !== exceptionCutBefore;
  if (!consoleCutMoved || !exceptionCutMoved) {
    cutDocumentConsoleBuffersAt(buffers, {
      ...(consoleCutMoved ? {} : { console: consoleBefore }),
      ...(exceptionCutMoved ? {} : { exception: exceptionBefore }),
    });
  }
  if (session) invalidateSessionRefs(session, 'navigation', { cutDocument: false });
  return reloadResult;
}
