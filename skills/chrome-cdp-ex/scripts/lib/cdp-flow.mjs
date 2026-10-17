// Moved from cdp.mjs without changes (#688). cdp.mjs is the entry point and re-exports for tests.
import { autoActionJsonArgs as autoActionJsonArgsForCommands } from './action-evidence.mjs';
import { actionFailureMessage, isTimeoutError, recoveryCommandsFromDiagnosis } from './action-recovery.mjs';
import { COMMAND_SURFACE } from './command-surface.mjs';
import { redactUrl } from './redaction.mjs';
import { assertSecretName } from './secrets.mjs';
import { removeTabObservation } from './tab-observation.mjs';
import { isTableCollectArgs } from './table-contract.mjs';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { BATCH_PARALLEL_SAFE_SCRIPT_COMMANDS, COMMANDS, FLOW_SCRIPT_COMMANDS, FOREGROUND_ACTIVATE_COMMAND, INHERITABLE_PROPS, NAVIGATION_CANCEL_EVIDENCE_WAIT_MS, NAVIGATION_CANCEL_POLL_MS, RELOAD_DISPATCH_TIMEOUT, RELOAD_EVENT_TIMEOUT, RELOAD_OBSERVE_TIMEOUT, RELOAD_READY_PROBE_TIMEOUT, RELOAD_READY_TIMEOUT, REPEAT_BLOCKED, REPEAT_CAP, REPLAY_BLOCKED, RUNTIME_DIR, _B64, pathApiForRoot, sleep } from './cdp-base.mjs';
import { formatJson, parseCompactFormatArgs, parseFormatArgs } from './cdp-browser.mjs';
import { parseFillArgs } from './cdp-cli.mjs';
import { boundedConsoleLineText, commandArgsFromTokens, consoleEntryFromEvent, exceptionEntryFromEvent, removeTabEnvironment, removeTabMode, tokenizeCommandLine, tokenizeFlowCommandLine } from './cdp-core.mjs';
import { clickStr, fillStr, normalizeScrollArgs, pressStr, scrollStr, selectStr, typeStr } from './cdp-input.mjs';
import { assertNotPdfViewerPage, cdpDomains, evalStr, getPages, navStr, runtimeExceptionMessage, waitForDocumentReady } from './cdp-page.mjs';
import { formatUnknownRefError, frameScopedBackendNode, isRef, parseFrameRef, rejectCrossSiteFrameAction, validateUrl, waitForSettle } from './cdp-perceive.mjs';
import { formatCommandLine, redactedCommandNeedsInput, resolveRequestSecret } from './cdp-session-report.mjs';

// --- Navigation history ---
export async function historyNavStr(cdp, sid, direction) {
  const { currentIndex, entries } = await cdpDomains(cdp).Page.getNavigationHistory( {}, sid);
  const targetIdx = currentIndex + direction;
  if (targetIdx < 0) throw new Error('No previous page in history');
  if (targetIdx >= entries.length) throw new Error('No forward page in history');
  await cdpDomains(cdp).Page.navigateToHistoryEntry( { entryId: entries[targetIdx].id }, sid);
  await sleep(500);
  const url = await evalStr(cdp, sid, 'window.location.href');
  return `Navigated ${direction < 0 ? 'back' : 'forward'} to: ${url}`;
}
export async function reloadStr(cdp, sid) {
  await cdpDomains(cdp).Page.enable( {}, sid);
  const loadEvent = cdp.waitForEvent('Page.loadEventFired', RELOAD_EVENT_TIMEOUT);
  try {
    await cdpDomains(cdp).Page.reload( {}, sid, RELOAD_DISPATCH_TIMEOUT);
  } catch (e) {
    if (!isTimeoutError(e, ['Page.reload'])) throw e;
  }
  try {
    await Promise.race([
      loadEvent.promise,
      waitForDocumentReady(cdp, sid, RELOAD_READY_TIMEOUT, { probeTimeoutMs: RELOAD_READY_PROBE_TIMEOUT }),
    ]);
  } catch {
    // Some embedded/live targets do not reliably emit Page.loadEventFired after
    // reload. Action feedback still performs a bounded post-reload observation.
  } finally {
    loadEvent.cancel?.();
  }
  return 'Page reloaded';
}
export async function observeReloadPage(cdp, sid) {
  return observePageState(cdp, sid, 'Reload observation');
}
export async function observeNavPage(cdp, sid) {
  return observePageState(cdp, sid, 'Navigation observation');
}
export async function observePageState(cdp, sid, heading = 'Page observation') {
  const result = await cdpDomains(cdp).Runtime.evaluate( {
    expression: `JSON.stringify({
      title: document.title || '',
      url: window.location.href || '',
      readyState: document.readyState || '',
      contentType: document.contentType || ''
    })`,
    returnByValue: true,
    awaitPromise: true,
  }, sid, RELOAD_OBSERVE_TIMEOUT);
  if (result.exceptionDetails) {
    throw new Error(runtimeExceptionMessage(result.exceptionDetails));
  }
  const value = result.result?.value;
  const parsed = typeof value === 'string' ? JSON.parse(value) : (value || {});
  return [
    `${heading}:`,
    `Page: ${parsed.title || '(untitled)'}`,
    `URL: ${parsed.url || '(unknown)'}`,
    `Ready state: ${parsed.readyState || '(unknown)'}`,
    parsed.contentType ? `contentType: ${parsed.contentType}` : null,
  ].filter(Boolean).join('\n');
}
export function createNavigationCancelWatch({ dialogBuf = null, jsDialogs = null, session = null, dismissMode = () => false } = {}) {
  const dialogSeq = typeof dialogBuf?.latest === 'function' ? dialogBuf.latest() : 0;
  const generation = session?.pageGeneration;
  async function dismissedBeforeunload({ awaitMs = 0 } = {}) {
    const deadline = Date.now() + (dismissMode() ? Math.max(0, Number(awaitMs) || 0) : 0);
    for (;;) {
      if (jsDialogs && typeof jsDialogs.hasPending === 'function' && jsDialogs.hasPending()) {
        await jsDialogs.waitForPending(1500);
      }
      if (session && session.pageGeneration !== generation) return null;
      const entries = typeof dialogBuf?.since === 'function' ? dialogBuf.since(dialogSeq) : [];
      const dismissed = entries.find(entry => entry.type === 'beforeunload' && entry.accepted === false && entry.handled !== false);
      if (dismissed) return dismissed;
      if (Date.now() >= deadline) return null;
      await sleep(Math.min(NAVIGATION_CANCEL_POLL_MS, Math.max(1, deadline - Date.now())));
    }
  }
  dismissedBeforeunload.dismissMode = dismissMode;
  return dismissedBeforeunload;
}
export function navigationCancelledError(action, dialog = {}, cause = null) {
  const what = action === 'reload' ? 'reload' : 'navigation';
  const detail = cause?.message ? ` (${actionFailureMessage(cause)})` : '';
  const err = new Error(`the page's beforeunload prompt was dismissed, so the ${what} was cancelled${detail}; the page did not change`);
  err.navigationCancelled = { action, url: dialog.url || '' };
  return err;
}
export async function dispatchGuardingCancelledNavigation(action, dispatch, navigationCancelWatch = null) {
  let result;
  try {
    result = await dispatch();
  } catch (error) {
    const dialog = navigationCancelWatch ? await navigationCancelWatch() : null;
    if (dialog) throw navigationCancelledError(action, dialog, error);
    throw error;
  }
  // A dispatch can also "succeed" on a cancelled navigation: navStr's target-URL poll sees the
  // pending URL while a slow beforeunload handler runs, then the dialog is dismissed (#500 review).
  const dialog = navigationCancelWatch ? await navigationCancelWatch() : null;
  if (dialog) throw navigationCancelledError(action, dialog);
  return result;
}
export async function navActionDispatch({ cdp, sessionId, url, targetId = null, onSessionId, navigationCancelWatch = null, navOpts = {} }) {
  const dismissMode = typeof navigationCancelWatch?.dismissMode === 'function' && navigationCancelWatch.dismissMode();
  return dispatchGuardingCancelledNavigation('nav', () => navStr(cdp, sessionId, url, {
    ...navOpts,
    targetId,
    onSessionId,
    // In dismiss mode, an observed pending URL is not proof: wait (bounded) for Page.navigate's own answer.
    confirmNavigateMs: dismissMode ? NAVIGATION_CANCEL_EVIDENCE_WAIT_MS : 0,
  }), navigationCancelWatch);
}
export function reloadObservationBuffers(session, consoleBuf, exceptionBuf) {
  if (session?.buffers && (session.buffers.console || session.buffers.exception)) return session.buffers;
  return { console: consoleBuf, exception: exceptionBuf };
}
// --- Inject: live CSS/JS injection with tracking ---
export async function injectStr(cdp, sid, args) {
  const type = args[0];
  const content = args.slice(1).join(' ');

  if (type === '--remove') {
    const selector = content
      ? `[data-cdp-inject="${content}"]`
      : '[data-cdp-inject]';
    return evalStr(cdp, sid, `(() => {
      const els = document.querySelectorAll(${JSON.stringify(selector)});
      els.forEach(el => el.remove());
      return els.length + ' element(s) removed';
    })()`);
  }

  if (type === '--css') {
    if (!content) throw new Error('CSS text required: inject --css "body { background: red }"');
    return evalStr(cdp, sid, `(() => {
      const id = 'inject-' + (document.querySelectorAll('[data-cdp-inject]').length + 1);
      const s = document.createElement('style');
      s.setAttribute('data-cdp-inject', id);
      s.textContent = ${JSON.stringify(content)};
      document.head.appendChild(s);
      return id;
    })()`);
  }

  if (type === '--css-file') {
    if (!content) throw new Error('URL required: inject --css-file https://example.com/style.css');
    validateUrl(content);
    return evalStr(cdp, sid, `new Promise((resolve, reject) => {
      const id = 'inject-' + (document.querySelectorAll('[data-cdp-inject]').length + 1);
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = ${JSON.stringify(content)};
      link.setAttribute('data-cdp-inject', id);
      link.onload = () => resolve(id);
      link.onerror = () => reject(new Error('Failed to load stylesheet: ' + ${JSON.stringify(content)}));
      document.head.appendChild(link);
    })`);
  }

  if (type === '--js-file') {
    if (!content) throw new Error('URL required: inject --js-file https://example.com/lib.js');
    validateUrl(content);
    return evalStr(cdp, sid, `new Promise((resolve, reject) => {
      const id = 'inject-' + (document.querySelectorAll('[data-cdp-inject]').length + 1);
      const s = document.createElement('script');
      s.src = ${JSON.stringify(content)};
      s.setAttribute('data-cdp-inject', id);
      s.onload = () => resolve(id);
      s.onerror = () => reject(new Error('Failed to load script: ' + ${JSON.stringify(content)}));
      document.head.appendChild(s);
    })`);
  }

  throw new Error('inject requires --css, --css-file, --js-file, or --remove\n  inject --css "body { color: red }"   inject inline CSS\n  inject --css-file <url>              load external stylesheet\n  inject --js-file <url>               load external script\n  inject --remove [id]                 remove injected element(s)');
}
// --- Record: short timeline capture around actions / waits ---
export function formatRecordEvent(e, startTs) {
  const rel = Math.max(0, e.ts - startTs).toString().padStart(5, ' ');
  if (e.kind === 'dom') return `  +${rel}ms DOM ${e.summary}`;
  if (e.kind === 'console') return `  +${rel}ms console.${e.level}: ${boundedConsoleLineText(e.text, e)}${e.loc ? ' (' + e.loc + ')' : ''}`;
  if (e.kind === 'exception') return `  +${rel}ms exception: ${boundedConsoleLineText(e.msg, e)}${e.loc ? ' (' + e.loc + ')' : ''}`;
  if (e.kind === 'network') return `  +${rel}ms ${e.method} ${redactUrl(e.url)} → ${e.status} (${e.duration}ms)`;
  if (e.kind === 'navigation') return `  +${rel}ms navigation ${redactUrl(e.url)}`;
  if (e.kind === 'action') return `  +${rel}ms action ${e.summary}`;
  return `  +${rel}ms ${e.kind || 'event'} ${e.summary || ''}`.trimEnd();
}
export function parseRecordArgs(args) {
  const opts = { durationMs: 1000, until: null, action: null, actionArgs: [], explicitDuration: false };
  const setUntil = (val) => {
    const v = (val || '').toLowerCase();
    if (!['dom stable', 'network idle', 'auto settle'].includes(v)) throw new Error('record --until supports "dom stable" or "network idle"');
    opts.until = v;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--action') {
      opts.action = args[++i];
      if (!opts.action) throw new Error('record --action requires an action command (click, press, fill, select, type, scroll, nav)');
      const rest = args.slice(i + 1);
      const actionArgs = [];
      for (let j = 0; j < rest.length; j++) {
        const a = rest[j];
        if (a === '--until') { setUntil(rest[++j]); continue; }
        if (/^\d+$/.test(a) && j === rest.length - 1) {
          opts.durationMs = Math.min(Math.max(parseInt(a), 100), 30000);
          opts.explicitDuration = true;
          continue;
        }
        actionArgs.push(a);
      }
      opts.actionArgs = actionArgs;
      break;
    }
    if (arg === '--until') { setUntil(args[++i]); continue; }
    if (/^\d+$/.test(arg)) {
      opts.durationMs = Math.min(Math.max(parseInt(arg), 100), 30000);
      opts.explicitDuration = true;
      continue;
    }
    throw new Error(`Unknown record argument: ${arg}`);
  }
  // --action with no explicit duration and no --until: auto-settle (DOM/network quiet)
  // Cap: 5s for DOM-only, 10s if network activity observed.
  if (opts.action && !opts.until && !opts.explicitDuration) {
    opts.until = 'auto settle';
    opts.durationMs = 10000;
  } else if (opts.until && !opts.explicitDuration) {
    opts.durationMs = 30000;
  }
  return opts;
}
export async function collectDomMutationSummary(cdp, sid) {
  const raw = await evalStr(cdp, sid, `(function() {
    const bucket = window.__cdp_record_mutations || [];
    window.__cdp_record_mutations = [];
    const totals = { added: 0, removed: 0, attributes: 0, characterData: 0 };
    const labels = [];
    for (const m of bucket) {
      if (m.type === 'childList') { totals.added += m.added || 0; totals.removed += m.removed || 0; }
      else if (m.type === 'attributes') totals.attributes += 1;
      else if (m.type === 'characterData') totals.characterData += 1;
      if (m.label && labels.length < 4) labels.push(m.label);
    }
    return JSON.stringify({ totals, labels, count: bucket.length });
  })()`);
  const parsed = JSON.parse(raw || '{}');
  if (!parsed.count) return null;
  const parts = [];
  if (parsed.totals.added) parts.push(`${parsed.totals.added} added`);
  if (parsed.totals.removed) parts.push(`${parsed.totals.removed} removed`);
  if (parsed.totals.attributes) parts.push(`${parsed.totals.attributes} attr`);
  if (parsed.totals.characterData) parts.push(`${parsed.totals.characterData} text`);
  const labelText = parsed.labels?.length ? ` [${parsed.labels.join('; ')}]` : '';
  return `${parts.join(', ') || parsed.count + ' mutation(s)'}${labelText}`;
}
export async function installRecordMutationObserver(cdp, sid) {
  await evalStr(cdp, sid, `(function() {
    if (window.__cdp_record_observer) { window.__cdp_record_mutations = []; return 'already'; }
    window.__cdp_record_mutations = [];
    const label = (node) => {
      if (!node || node.nodeType !== 1) return '';
      const el = node;
      const id = el.id ? '#' + el.id : '';
      const cls = typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\\s+/).slice(0,2).join('.') : '';
      const text = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40);
      return '<' + el.tagName.toLowerCase() + id + cls + '>' + (text ? ' "' + text + '"' : '');
    };
    window.__cdp_record_observer = new MutationObserver((mutations) => {
      const out = window.__cdp_record_mutations || (window.__cdp_record_mutations = []);
      for (const m of mutations) {
        out.push({
          type: m.type,
          added: m.addedNodes ? m.addedNodes.length : 0,
          removed: m.removedNodes ? m.removedNodes.length : 0,
          attr: m.attributeName || '',
          label: label(m.target) || label(m.addedNodes && m.addedNodes[0]) || label(m.removedNodes && m.removedNodes[0]),
        });
      }
      if (out.length > 200) out.splice(0, out.length - 200);
    });
    window.__cdp_record_observer.observe(document.documentElement || document, { subtree: true, childList: true, attributes: true, characterData: true });
    return 'installed';
  })()`);
}
export async function recordStr(cdp, sid, args, refs) {
  const opts = parseRecordArgs(args);
  const startTs = Date.now();
  const events = [];
  const offConsole = cdp.onEvent?.('Runtime.consoleAPICalled', (params) => {
    events.push({ kind: 'console', ...consoleEntryFromEvent(params) });
  });
  const offException = cdp.onEvent?.('Runtime.exceptionThrown', (params) => {
    events.push({ kind: 'exception', ...exceptionEntryFromEvent(params) });
  });
  const pending = new Map();
  const offReq = cdp.onEvent?.('Network.requestWillBeSent', (params) => {
    if (['XHR','Fetch','Document'].includes(params.type)) pending.set(params.requestId, { method: params.request.method, url: params.request.url.substring(0, 160), ts: Date.now() });
  });
  const offRes = cdp.onEvent?.('Network.responseReceived', (params) => {
    const req = pending.get(params.requestId);
    if (!req) return;
    pending.delete(params.requestId);
    events.push({ kind: 'network', ...req, status: params.response.status, duration: Date.now() - req.ts, ts: Date.now() });
  });
  const offNav = cdp.onEvent?.('Page.frameNavigated', (params) => {
    if (!params.frame?.parentId) events.push({ kind: 'navigation', url: params.frame?.url || '', ts: Date.now() });
  });

  // Wrap setup/action/loop in try/finally so the temporary listeners are
  // always detached — including when an action throws (unsupported action,
  // click/fill failure, CDP error). Leaking listeners would pollute future
  // record/timeline runs on the same daemon.
  try {
    try { await cdpDomains(cdp).Runtime.enable( {}, sid); } catch {}
    try { await cdpDomains(cdp).Page.enable( {}, sid); } catch {}
    try { await cdpDomains(cdp).DOM.enable( {}, sid); } catch {}
    try { await cdpDomains(cdp).Network.enable( {}, sid); } catch {}
    await installRecordMutationObserver(cdp, sid);

    let actionText = null;
    if (opts.action) {
      if (opts.action === 'click') actionText = await clickStr(cdp, sid, opts.actionArgs[0], refs);
      else if (opts.action === 'press') actionText = await pressStr(cdp, sid, opts.actionArgs[0]);
      else if (opts.action === 'fill') {
        const secretAt = opts.actionArgs.indexOf('--secret');
        if (secretAt !== -1) {
          const secretName = assertSecretName(opts.actionArgs[secretAt + 1], 'record --action fill');
          actionText = await fillStr(cdp, sid, opts.actionArgs[0], resolveRequestSecret(secretName, { command: 'record --action fill' }), refs, undefined, { secretName });
        } else {
          actionText = await fillStr(cdp, sid, opts.actionArgs[0], opts.actionArgs.length > 1 ? opts.actionArgs.slice(1).join(' ') : null, refs);
        }
      }
      else if (opts.action === 'select') actionText = await selectStr(cdp, sid, opts.actionArgs[0], opts.actionArgs[1], {}, refs);
      else if (opts.action === 'type') actionText = await typeStr(cdp, sid, opts.actionArgs.join(' '));
      else if (opts.action === 'scroll') {
        const scrollArgs = normalizeScrollArgs(opts.actionArgs);
        actionText = await scrollStr(cdp, sid, scrollArgs[0], scrollArgs[1], scrollArgs.slice(2));
      }
      else if (opts.action === 'nav' || opts.action === 'navigate') actionText = await navStr(cdp, sid, opts.actionArgs[0]);
      else throw new Error(`record --action does not support: ${opts.action}`);
      events.push({ kind: 'action', summary: actionText.split('\n')[0], ts: Date.now() });
    }

    let quietSince = Date.now();
    let networkSeen = false;
    const deadline = Date.now() + opts.durationMs;
    // Auto-settle cap: 5s if no network activity has been observed yet, else 10s.
    const autoCap = () => Date.now() - startTs >= (networkSeen ? 10000 : 5000);
    while (Date.now() < deadline) {
      await sleep(Math.min(100, deadline - Date.now()));
      const domSummary = await collectDomMutationSummary(cdp, sid);
      if (domSummary) { events.push({ kind: 'dom', summary: domSummary, ts: Date.now() }); quietSince = Date.now(); }
      if (pending.size > 0 || events.some(e => e.kind === 'network')) networkSeen = true;
      if (opts.until === 'network idle' && pending.size === 0 && Date.now() - quietSince >= 500) break;
      if (opts.until === 'dom stable' && Date.now() - quietSince >= 500) break;
      if (opts.until === 'auto settle' && pending.size === 0 && Date.now() - quietSince >= 500) break;
      if (opts.until === 'auto settle' && autoCap()) break;
      if (!opts.until && Date.now() >= deadline) break;
    }

    const lines = [`Record timeline (${Date.now() - startTs}ms${opts.action ? `, action: ${opts.action}` : ''}${opts.until ? `, until: ${opts.until}` : ''})`];
    if (actionText) lines.push(`Action: ${actionText.split('\n')[0]}`);
    if (events.length === 0) lines.push('  (no DOM, console, exception, navigation, or XHR/Fetch/Document network events observed)');
    else for (const e of events.sort((a,b) => a.ts - b.ts)) lines.push(formatRecordEvent(e, startTs));
    return lines.join('\n');
  } finally {
    offConsole?.();
    offException?.();
    offReq?.();
    offRes?.();
    offNav?.();
  }
}
// Strip Vite/CSS Module query suffixes (?vue&type=style&lang.css, ?direct, ?used)
export function stripVitePathQuery(url) {
  if (!url) return url;
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}
export function decodeVLQ(str) {
  const out = [];
  let value = 0, shift = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = _B64.indexOf(str[i]);
    if (ch === -1) return out;
    const cont = ch & 32;
    const digit = ch & 31;
    value += digit << shift;
    shift += 5;
    if (!cont) {
      const negate = value & 1;
      out.push(negate ? -(value >> 1) : (value >> 1));
      value = 0; shift = 0;
    }
  }
  return out;
}
// Walk source-map mappings to find first segment on generated line `genLine0`
export function mapLineToSource(mappings, genLine0) {
  if (typeof mappings !== 'string' || !mappings) return null;
  const lines = mappings.split(';');
  if (genLine0 < 0 || genLine0 >= lines.length) return null;
  let srcIdx = 0, origLine = 0, origCol = 0;
  let result = null;
  for (let i = 0; i <= genLine0; i++) {
    const segments = lines[i].split(',');
    for (const seg of segments) {
      if (!seg) continue;
      const vals = decodeVLQ(seg);
      if (vals.length >= 4) {
        srcIdx += vals[1];
        origLine += vals[2];
        origCol += vals[3];
        if (i === genLine0 && result === null) {
          result = { srcIdx, origLine, origCol };
        }
      }
    }
  }
  return result;
}
export function mapInlineSourceMap(sheetText, genLine0) {
  const m = sheetText.match(/sourceMappingURL=data:application\/json[^,]*?base64,([A-Za-z0-9+/=]+)/);
  if (!m) return null;
  let json;
  try {
    const decoded = Buffer.from(m[1], 'base64').toString('utf8');
    json = JSON.parse(decoded);
  } catch { return null; }
  const sources = json.sources || [];
  if (sources.length === 0) return null;
  const mapping = mapLineToSource(json.mappings || '', genLine0);
  const srcIdx = mapping ? Math.max(0, Math.min(mapping.srcIdx, sources.length - 1)) : 0;
  const origLine = mapping ? mapping.origLine : genLine0;
  const sourceRoot = (json.sourceRoot || '').replace(/\/$/, '');
  const rawSrc = sources[srcIdx] || '';
  if (!rawSrc) return null;
  const fullPath = sourceRoot ? `${sourceRoot}/${rawSrc}` : rawSrc;
  return `${stripVitePathQuery(fullPath)}:${origLine + 1}`;
}
// Map a stylesheet line to the most-informative source location available
export function mapStyleSource(sheetText, sheetId, genLine0) {
  const text = sheetText || '';
  const inline = mapInlineSourceMap(text, genLine0);
  if (inline) return inline;
  const sourceUrl = text.match(/\/\*#?\s*sourceURL=([^*\n]+)\s*\*\//)?.[1]
    || text.match(/\/\/# sourceURL=([^\n]+)/)?.[1];
  if (sourceUrl) return `${stripVitePathQuery(sourceUrl.trim())}:${genLine0 + 1}`;
  const mapUrl = text.match(/sourceMappingURL=([^\s*]+)/)?.[1];
  if (mapUrl && !mapUrl.startsWith('data:')) {
    return `${stripVitePathQuery(mapUrl.trim().replace(/\.map$/, ''))}:${genLine0 + 1}`;
  }
  return `${sheetId}:${genLine0 + 1}`;
}
export async function resolveStyleSource(cdp, sid, rule) {
  const origin = rule.origin;
  if (origin === 'user-agent') return 'user-agent stylesheet';
  const sheetId = rule.style?.styleSheetId;
  if (!sheetId) return origin === 'regular' ? 'inline style' : (origin || 'unknown stylesheet');
  const range = rule.style.range;
  const genLine0 = range ? range.startLine : 0;
  let header;
  try { header = await cdpDomains(cdp).CSS.getStyleSheetText( { styleSheetId: sheetId }, sid); } catch {}
  return mapStyleSource(header?.text || '', sheetId, genLine0);
}
export function cssDeclarationImportant(prop = {}) {
  if (prop.important === true) return true;
  if (String(prop.important || '').toLowerCase() === 'important') return true;
  return /\s!important\s*$/i.test(String(prop.text || ''));
}
export function cascadeDeclarationRank(rule = {}) {
  const important = rule.important === true;
  const inline = rule.origin === 'inline';
  const userAgent = rule.origin === 'user-agent';
  if (userAgent && important) return 50;
  if (inline && important) return 40;
  if (important) return 30;
  if (inline) return 20;
  if (userAgent) return 0;
  return 10;
}
export async function cascadeStr(cdp, sid, selector, property, refMap, refState, opts = {}) {
  if (!selector) throw new Error('CSS selector or @ref required');
  rejectCrossSiteFrameAction(refState, selector);
  const targetPrefix = opts.targetPrefix || '<target>';
  await assertNotPdfViewerPage(cdp, sid, { targetPrefix });

  // CSS.getMatchedStylesForNode requires these domains/document state. Enable
  // them inside cascade so the first call works even before evalraw/perceive.
  try { await cdpDomains(cdp).DOM.enable( {}, sid); } catch {}
  try { await cdpDomains(cdp).CSS.enable( {}, sid); } catch {}
  const { root } = await cdpDomains(cdp).DOM.getDocument( {}, sid);

  // Resolve element to DOM nodeId
  let nodeId;
  if (isRef(selector)) {
    const frameParsed = parseFrameRef(selector);
    let backendNodeId;
    if (frameParsed) {
      backendNodeId = frameScopedBackendNode(refState || {}, frameParsed).backendNodeId;
    } else {
      const num = parseInt(selector.slice(1));
      backendNodeId = refMap.get(num);
      if (!backendNodeId) throw new Error(formatUnknownRefError(selector, refState || {}));
    }
    const { nodeIds } = await cdpDomains(cdp).DOM.pushNodesByBackendIdsToFrontend(
      { backendNodeIds: [backendNodeId] }, sid);
    nodeId = nodeIds[0];
  } else {
    const result = await cdpDomains(cdp).DOM.querySelector(
      { nodeId: root.nodeId, selector }, sid);
    if (!result.nodeId) throw new Error('Element not found: ' + selector);
    nodeId = result.nodeId;
  }

  // Get matched styles + computed style in parallel
  const [matched, computed] = await Promise.all([
    cdpDomains(cdp).CSS.getMatchedStylesForNode( { nodeId }, sid),
    cdpDomains(cdp).CSS.getComputedStyleForNode( { nodeId }, sid),
  ]);

  // Build computed value lookup
  const computedMap = new Map();
  for (const c of computed.computedStyle || []) {
    computedMap.set(c.name, c.value);
  }

  // Collect rules by property
  const propRules = new Map();
  for (const match of matched.matchedCSSRules || []) {
    const rule = match.rule;
    const selectorText = rule.selectorList?.text || '?';
    const origin = rule.origin; // 'regular', 'user-agent', 'injected', 'inspector'
    const source = await resolveStyleSource(cdp, sid, rule);

    for (const prop of rule.style?.cssProperties || []) {
      if (prop.disabled || !prop.value) continue;
      if (prop.name.startsWith('-webkit-') || prop.name.startsWith('-moz-')) continue;
      if (property && prop.name !== property) continue;
      if (!propRules.has(prop.name)) propRules.set(prop.name, []);
      propRules.get(prop.name).push({
        value: prop.value,
        selector: selectorText,
        source,
        origin,
        important: cssDeclarationImportant(prop),
      });
    }
  }

  // Inline styles (highest specificity — style="" attribute)
  for (const prop of matched.inlineStyle?.cssProperties || []) {
    if (prop.disabled || !prop.value) continue;
    if (prop.name.startsWith('-webkit-') || prop.name.startsWith('-moz-')) continue;
    if (property && prop.name !== property) continue;
    if (!propRules.has(prop.name)) propRules.set(prop.name, []);
    // Inline styles beat non-important stylesheet rules. Keep them last so
    // same-rank ties still follow cascade order; !important is ranked separately.
    propRules.get(prop.name).push({
      value: prop.value,
      selector: '[inline]',
      source: 'inline style attribute',
      origin: 'inline',
      important: cssDeclarationImportant(prop),
    });
  }

  const normalizeCssValue = (v) => String(v || '')
    .trim()
    .replace(/\s*,\s*/g, ', ')
    .replace(/\s+/g, ' ');
  const cssValuesEquivalent = (specified, computed) => {
    const a = normalizeCssValue(specified).toLowerCase();
    const b = normalizeCssValue(computed).toLowerCase();
    if (a === b) return true;
    const aliases = { bold: '700', normal: '400' };
    return aliases[a] === b || aliases[b] === a;
  };
  const cascadeWinnerIndex = (rules, computedVal) => {
    let bestRank = -1;
    for (const rule of rules) {
      const rank = cascadeDeclarationRank(rule);
      if (rank > bestRank) bestRank = rank;
    }
    let equivalent = -1;
    let lastAtRank = -1;
    for (let i = 0; i < rules.length; i++) {
      if (cascadeDeclarationRank(rules[i]) !== bestRank) continue;
      lastAtRank = i;
      if (cssValuesEquivalent(rules[i].value, computedVal)) equivalent = i;
    }
    return equivalent >= 0 ? equivalent : lastAtRank;
  };

  // Dedupe identical (selector, normalized value, source, origin) entries per property.
  // CDP can return repeated matchedCSSRules / cssProperties (e.g. same rule
  // matched via multiple selectors in the selectorList, or authored vs normalized
  // values like rgb(37,99,235) vs rgb(37, 99, 235)); rendering them twice
  // misleadingly implies multiple independent winning rules.
  for (const [name, rules] of propRules) {
    const seen = new Set();
    const deduped = [];
    for (const r of rules) {
      const key = `${r.selector}\u0000${normalizeCssValue(r.value)}\u0000${r.source}\u0000${r.origin}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(r);
    }
    propRules.set(name, deduped);
  }

  const hasInherited = (matched.inherited || []).some(inh =>
    inh.matchedCSSRules?.some(m =>
      m.rule.style?.cssProperties?.some(p => !p.disabled && p.value && INHERITABLE_PROPS.has(p.name))));

  if (propRules.size === 0 && !hasInherited && !property) {
    if (opts.format === 'json') {
      return formatJson({
        schema: 'chrome-cdp-ex.cascade.v1',
        input: { selector, property: null },
        propertyCount: 0,
        properties: [],
        inherited: [],
        editTarget: null,
        message: 'No matching CSS rules found for this element',
      });
    }
    return 'No matching CSS rules found for this element';
  }
  if (propRules.size === 0 && !hasInherited && property) {
    const computed = computedMap.get(property);
    if (opts.format === 'json') {
      return formatJson({
        schema: 'chrome-cdp-ex.cascade.v1',
        input: { selector, property },
        propertyCount: computed ? 1 : 0,
        properties: computed ? [{
          name: property,
          computedValue: computed,
          winner: null,
          rules: [],
          note: 'computed, no explicit rule found',
        }] : [],
        inherited: [],
        editTarget: null,
        message: computed
          ? `${property}: ${computed} (computed, no explicit rule found)`
          : `Property "${property}" not found on this element`,
      });
    }
    return computed
      ? `${property}: ${computed} (computed, no explicit rule found)`
      : `Property "${property}" not found on this element`;
  }

  // Format output
  const lines = [];
  const properties = [];
  for (const [prop, rules] of propRules) {
    const computedVal = computedMap.get(prop);
    if (!computedVal) continue;

    lines.push(`${prop}: ${computedVal}`);
    const ruleModels = [];
    let winner = null;
    const winnerIndex = cascadeWinnerIndex(rules, computedVal);
    for (const [index, r] of rules.entries()) {
      const isWinner = index === winnerIndex;
      const mark = isWinner ? '✓' : '✗';
      const note = isWinner ? '' : '  [overridden]';
      const ruleModel = {
        selector: r.selector,
        value: r.value,
        source: r.source,
        origin: r.origin || null,
        winner: isWinner,
        overridden: !isWinner,
      };
      ruleModels.push(ruleModel);
      if (isWinner && !winner) winner = {
        selector: r.selector,
        value: r.value,
        source: r.source,
        origin: r.origin || null,
      };
      lines.push(`  ${mark} ${r.selector} { ${prop}: ${r.value} }${note}`);
      lines.push(`    → ${r.source}`);
    }
    properties.push({
      name: prop,
      computedValue: computedVal,
      winner,
      rules: ruleModels,
    });
    lines.push('');
  }

  // Inherited properties
  const inherited = matched.inherited || [];
  const inheritedLines = [];
  const inheritedModels = [];
  for (const inh of inherited) {
    for (const match of inh.matchedCSSRules || []) {
      const rule = match.rule;
      for (const prop of rule.style?.cssProperties || []) {
        if (prop.disabled || !prop.value) continue;
        if (!INHERITABLE_PROPS.has(prop.name)) continue;
        if (property && prop.name !== property) continue;
        const selectorText = rule.selectorList?.text || '?';
        const source = await resolveStyleSource(cdp, sid, rule);
        inheritedLines.push(`  ${prop.name}: ${prop.value}  ← ${selectorText}  → ${source}`);
        inheritedModels.push({
          name: prop.name,
          value: prop.value,
          selector: selectorText,
          source,
          origin: rule.origin || null,
        });
      }
    }
  }
  if (inheritedLines.length > 0) {
    lines.push('Inherited:');
    // Deduplicate identical lines (CDP can repeat the same inherited rule
    // across multiple ancestors / selectors); distinct (selector, source)
    // entries with the same property+value are still preserved.
    const seen = new Set();
    for (const l of inheritedLines) {
      if (seen.has(l)) continue;
      seen.add(l);
      lines.push(l);
    }
  }

  if (opts.format === 'json') {
    const editProperty = property
      ? properties.find(entry => entry.name === property)
      : properties.find(entry => entry.winner);
    const editTarget = editProperty?.winner
      ? {
        property: editProperty.name,
        selector: editProperty.winner.selector,
        value: editProperty.winner.value,
        source: editProperty.winner.source,
        origin: editProperty.winner.origin || null,
      }
      : null;
    return formatJson({
      schema: 'chrome-cdp-ex.cascade.v1',
      input: { selector, property: property || null },
      propertyCount: properties.length,
      properties,
      inherited: inheritedModels,
      editTarget,
      recommendation: editTarget
        ? {
          source: 'cascade',
          strategy: 'edit-winning-source',
          property: editTarget.property,
          selector: editTarget.selector,
          sourceLocation: editTarget.source,
        }
        : {
          source: 'cascade',
          strategy: 'inspect-computed-style',
        },
    });
  }

  return lines.join('\n').trim() || 'No matching CSS rules found';
}
// --- Tab close ---
export function parseClosetabArgs(args = []) {
  const opts = { force: false };
  for (const arg of args.filter(a => a !== undefined && a !== null)) {
    if (arg === '--force') opts.force = true;
    else throw new Error(`closetab: unknown argument ${arg}`);
  }
  return opts;
}
// #404: closing the only open tab can quit the browser. The page list is best-effort evidence; when it
// cannot be read the tab is closed exactly as before. The success text is unchanged on purpose: validation
// scripts and contract tests compare it byte for byte.
export async function closetabStr(cdp, targetId, { force = false, runtimeDir = RUNTIME_DIR } = {}) {
  if (!force) {
    let pages = null;
    try { pages = await getPages(cdp); } catch { pages = null; }
    if (pages && pages.length <= 1 && pages.some(p => p.targetId === targetId)) {
      throw new Error('closetab: refusing to close the last open tab (closing it can quit the browser); pass --force to close it anyway');
    }
  }
  await cdpDomains(cdp).Target.closeTarget( { targetId });
  // The tab is gone: its background-mode record (#441) and saved dialog/throttle/mocks (#575)
  // have nothing left to apply to.
  removeTabMode(targetId, { runtimeDir });
  removeTabEnvironment(targetId, { runtimeDir });
  removeTabObservation(targetId, { runtimeDir });
  return `Closed tab: ${targetId.slice(0, 8)}`;
}
// --- Batch result formatting ---
export function firstNonEmptyLine(value, limit = 240) {
  const line = String(value ?? '').split('\n').map(s => s.trim()).find(Boolean) || '';
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}
export function maybeParseJson(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return null;
  try { return JSON.parse(trimmed); } catch { return null; }
}
export function actionDispatchSemanticsFromModel(model = null) {
  if (!model || typeof model !== 'object' || Array.isArray(model)) {
    return { action: null, dispatch: null };
  }
  if (model.schema === 'chrome-cdp-ex.action.v1') {
    return { action: model, dispatch: model.dispatch || null };
  }
  if (model.schema === 'chrome-cdp-ex.semantic-interaction.v1') {
    const action = model.actionEvidence?.schema === 'chrome-cdp-ex.action.v1'
      ? model.actionEvidence
      : null;
    return { action, dispatch: model.dispatch || action?.dispatch || null };
  }
  if (model.schema === 'chrome-cdp-ex.qa-page.v1'
    && model.action?.schema === 'chrome-cdp-ex.semantic-interaction.v1') {
    return actionDispatchSemanticsFromModel(model.action);
  }
  if (model.action?.schema === 'chrome-cdp-ex.action.v1') {
    return { action: model.action, dispatch: model.action.dispatch || null };
  }
  return { action: null, dispatch: null };
}
export function actionDispatchFailureMessage(action = null, dispatch = null) {
  return dispatch?.error
    || action?.effects?.failure?.originalMessage
    || action?.effects?.failure?.reason
    || 'Action dispatch failed';
}
export function commandOwnsActionEvidence(command = null) {
  const record = COMMAND_SURFACE.resolve(command);
  return record?.kind === 'mutation'
    && record.evidencePolicy === 'action-receipt'
    && record.feedbackPolicy !== null;
}
export function commandCatalogName(command = null) {
  return COMMAND_SURFACE.resolve(command)?.name || command || '';
}
export function batchOutputHasFailure(output, parsed = maybeParseJson(output)) {
  if (parsed?.schema === 'chrome-cdp-ex.batch.v1') return Number(parsed.counts?.failed) > 0;
  if (Array.isArray(parsed)) return parsed.some(step => step && step.ok === false);
  return / \(error\)|: ERROR /m.test(String(output || ''));
}
export function semanticAssertionFailureMessage(model = null, output = '') {
  const failed = (model?.assertions || [])
    .filter(assertion => assertion?.status === 'fail')
    .map(assertion => assertion.message)
    .filter(Boolean);
  if (failed.length) return failed.join('; ');
  if (/^Verdict:\s*fail$/m.test(String(output || ''))) return 'Verdict: fail';
  return 'assertion failed';
}
export function classifyCommandResultSemantics(result = null, { command = null } = {}) {
  const transportOk = result?.ok === true
    || (Number.isInteger(result?.code) && result.code === 0);
  const output = Object.hasOwn(result || {}, 'result') ? result.result : result?.stdout;
  const parsed = maybeParseJson(output);
  const ownsAction = commandOwnsActionEvidence(command);
  const catalogName = commandCatalogName(command);
  const model = ownsAction || catalogName === 'batch' ? parsed : null;
  const { action, dispatch } = actionDispatchSemanticsFromModel(ownsAction ? parsed : null);
  const dispatchFailed = dispatch?.ok === false;
  const assertionFailed = catalogName === 'verify-click' && (
    parsed?.verdict === 'fail'
    || /^Verdict:\s*fail$/m.test(String(output || ''))
  );
  const batchFailed = catalogName === 'batch' && batchOutputHasFailure(output, parsed);
  const error = result?.error
    || (dispatchFailed
      ? actionDispatchFailureMessage(action, dispatch)
      : null)
    || (assertionFailed ? semanticAssertionFailureMessage(parsed, output) : null)
    || (batchFailed ? 'batch step failed' : null);
  return {
    ok: transportOk && !dispatchFailed && !assertionFailed && !batchFailed,
    transportOk,
    dispatchFailed,
    assertionFailed,
    batchFailed,
    error,
    model,
    action,
    dispatch,
  };
}
export function extractLabeledLine(text, label) {
  const re = new RegExp(`^${label}:\\s*(.+)$`, 'm');
  return String(text || '').match(re)?.[1]?.trim() || null;
}
export function compactActionDiagnosisModel(diagnosis = null) {
  if (!diagnosis || typeof diagnosis !== 'object') return null;
  return {
    schema: diagnosis.schema || 'chrome-cdp-ex.action-diagnosis.v1',
    status: diagnosis.status || 'ok',
    kind: diagnosis.kind || 'ok',
    confidence: diagnosis.confidence || 'medium',
    source: diagnosis.source || 'action',
    reason: diagnosis.reason || '',
    nextCommand: diagnosis.nextCommand || null,
    recovery: diagnosis.recovery || null,
    signals: diagnosis.signals || {},
  };
}
export function compactActionVerdictModel(verdict = null) {
  if (!verdict || typeof verdict !== 'object') return null;
  const nextSteps = Array.isArray(verdict.nextSteps) ? verdict.nextSteps.filter(Boolean) : [];
  return {
    schema: verdict.schema || 'chrome-cdp-ex.action-verdict.v1',
    status: verdict.status || 'verify',
    source: verdict.source || 'outcome',
    confidence: verdict.confidence || 'medium',
    canContinue: verdict.canContinue === true,
    needsRecovery: verdict.needsRecovery === true,
    primaryNextStep: verdict.primaryNextStep || null,
    nextSteps,
    reason: verdict.reason || null,
  };
}
export function diagnosisFromActionModel(actionModel = null) {
  if (actionModel?.schema !== 'chrome-cdp-ex.action.v1') return null;
  return compactActionDiagnosisModel(actionModel.effects?.diagnosis || null);
}
export function verdictFromActionModel(actionModel = null) {
  if (actionModel?.schema !== 'chrome-cdp-ex.action.v1') return null;
  return compactActionVerdictModel(actionModel.verdict || null);
}
export function isAttentionDiagnosis(diagnosis = null) {
  return diagnosis?.status === 'attention';
}
export function isAttentionVerdict(verdict = null) {
  if (!verdict || typeof verdict !== 'object') return false;
  if (verdict.needsRecovery === true) return true;
  return ['investigate', 'recover', 'blocked'].includes(verdict.status);
}
export function recoveryCommandsFromVerdict(verdict = null) {
  const commands = Array.isArray(verdict?.nextSteps) ? verdict.nextSteps.filter(Boolean) : [];
  if (commands.length) return commands;
  return verdict?.primaryNextStep ? [verdict.primaryNextStep] : [];
}
export function commandMeta(cmd) {
  return COMMANDS.find(command => command.name === cmd || (command.aliases || []).includes(cmd)) || null;
}
export function isParallelSafeCookieList(command) {
  return command.name === 'cookies'
    && command.kind === 'sensitive-read'
    && command.authorization === 'sensitive-read'
    && command.mutates === false;
}
export function isViewportMutationArg(value) {
  return /^\d+x\d+$/i.test(String(value || ''));
}
export function isBatchParallelUnsafeCommand(cmd, args = []) {
  const command = COMMAND_SURFACE.resolve(cmd);
  if (!command) return true;
  if (command.name === 'table') {
    if (command.kind !== 'conditional-mutation'
      || command.authorization !== 'conditional'
      || command.evidencePolicy !== 'none') return true;
    return isTableCollectArgs(args);
  }
  if (command.name === 'console' || command.name === 'netlog' || command.name === 'record-actions') {
    return args.some(arg => arg === '--clear');
  }
  if (command.name === 'dialog') {
    return args.some(arg => arg === 'accept' || arg === 'dismiss');
  }
  if (command.name === 'viewport' || command.name === 'resize') {
    return args.some(arg => isViewportMutationArg(arg));
  }
  if (BATCH_PARALLEL_SAFE_SCRIPT_COMMANDS.has(command.name)) return false;
  if (isParallelSafeCookieList(command)) return false;
  if (command.kind !== 'read'
    || command.authorization !== 'standard'
    || command.evidencePolicy !== 'none') return true;
  return false;
}
export function autoActionJsonArgs(cmd, args = [], enabled = false) {
  return autoActionJsonArgsForCommands(cmd, args, enabled, { commands: COMMANDS });
}
export function batchStepModel(result = {}, index = 0) {
  const semantics = classifyCommandResultSemantics(result, { command: result.cmd });
  const actionModel = semantics.action;
  const actionFailure = semantics.dispatchFailed;
  const diagnosis = diagnosisFromActionModel(actionModel);
  const verdict = verdictFromActionModel(actionModel);
  const errorText = semantics.error || '';
  const ok = semantics.ok;
  const failureKind = actionFailure
    ? actionModel?.effects?.failure?.kind || null
    : extractLabeledLine(errorText, 'Action failure');
  const nextCommand = actionFailure
    ? actionModel?.nextHint || actionModel?.effects?.failure?.nextCommand || null
    : extractLabeledLine(errorText, 'Next');
  const step = {
    index: index + 1,
    cmd: result.cmd || '',
    ok,
  };
  if (ok) {
    step.resultPreview = firstNonEmptyLine(result.result);
  } else {
    step.error = errorText || 'unknown error';
    if (failureKind) step.failureKind = failureKind;
    if (nextCommand) step.nextCommand = nextCommand;
  }
  if (diagnosis) step.diagnosis = diagnosis;
  if (verdict) step.verdict = verdict;
  return step;
}
export function buildBatchResultModel(results = [], { targetId = null, mode = 'sequential' } = {}) {
  const steps = results.map((result, index) => batchStepModel(result, index));
  const failedSteps = steps.filter(step => !step.ok);
  const diagnosisAttentionSteps = steps.filter(step => step.ok && isAttentionDiagnosis(step.diagnosis));
  const verdictAttentionSteps = steps.filter(step => step.ok && isAttentionVerdict(step.verdict));
  const attentionSteps = [...new Set([...diagnosisAttentionSteps, ...verdictAttentionSteps])];
  const nextSteps = [];
  const pushNext = (command) => {
    if (command && !nextSteps.includes(command)) nextSteps.push(command);
  };
  for (const step of failedSteps) {
    for (const command of recoveryCommandsFromDiagnosis(step.diagnosis)) pushNext(command);
    for (const command of recoveryCommandsFromVerdict(step.verdict)) pushNext(command);
    pushNext(step.nextCommand);
  }
  for (const step of attentionSteps) {
    for (const command of recoveryCommandsFromDiagnosis(step.diagnosis)) pushNext(command);
    for (const command of recoveryCommandsFromVerdict(step.verdict)) pushNext(command);
  }
  if (failedSteps.length && nextSteps.length === 0) {
    const unknownCommand = failedSteps.some(step => /unknown command/i.test(step.error || ''));
    nextSteps.push(unknownCommand
      ? 'cdp help'
      : (targetId ? `cdp status ${targetId}` : 'cdp status <target>'));
  }
  return {
    schema: 'chrome-cdp-ex.batch.v1',
    targetId,
    mode,
    counts: {
      steps: steps.length,
      ok: steps.length - failedSteps.length,
      failed: failedSteps.length,
      attention: attentionSteps.length,
    },
    steps,
    failedStep: failedSteps[0] || null,
    nextSteps,
  };
}
export function parseBatchArgs(args = []) {
  const fopts = parseFormatArgs(args, ['text', 'json']);
  const tokens = fopts.args;
  const parallel = tokens.includes('--parallel');
  const plain = tokens.includes('--plain');
  const compact = tokens.includes('--compact');
  const input = tokens.filter(a => a !== '--parallel' && a !== '--plain' && a !== '--compact').join(' ') || '';
  let commands;
  if (input.startsWith('[')) {
    try { commands = JSON.parse(input); } catch { throw new Error('batch: invalid JSON array'); }
    if (!Array.isArray(commands)) throw new Error('batch argument must be a JSON array');
  } else {
    // `|` always splits a batch step, including inside quotes. Splitting first used to
    // leave an unclosed quote as literal text; that is now an error from the tokenizer.
    const segments = input.split('|');
    try {
      commands = segments.map(segment => {
        const tokens = tokenizeCommandLine(segment.trim());
        if (!tokens.length) return { cmd: '', args: [] };
        return { cmd: tokens[0].value, args: commandArgsFromTokens(tokens.slice(1)) };
      }).filter(c => c.cmd);
    } catch (error) {
      const message = String(error?.message || '');
      if (segments.length > 1 && message.startsWith('unclosed quote')) {
        throw new Error(`batch: | separates batch steps, including inside quotes. Use flow for a value that contains |, or quote the steps differently. ${message}`);
      }
      throw error;
    }
  }
  return {
    commands,
    parallel,
    output: fopts.format === 'json' ? 'model' : (plain ? 'plain' : compact ? 'compact' : 'legacy-json'),
  };
}
export function formatBatchResults(results, format = 'json', options = {}) {
  if (format && typeof format === 'object') {
    return formatJson(buildBatchResultModel(results, format));
  }
  if (format === 'model') {
    return formatJson(buildBatchResultModel(results, options));
  }
  if (format === 'plain') {
    const lines = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      lines.push(`[${i + 1}/${results.length}] ${r.cmd}${r.ok ? '' : ' (error)'}`);
      if (r.ok) {
        const body = (r.result ?? '').toString();
        if (body) lines.push(...body.split('\n').map(l => '  ' + l));
      } else {
        lines.push(`  ${r.error}`);
      }
    }
    return lines.join('\n');
  }
  if (format === 'compact') {
    return results.map((r, i) => {
      const head = `[${i + 1}] ${r.cmd}`;
      if (!r.ok) return `${head}: ERROR ${r.error}`;
      const body = (r.result ?? '').toString().split('\n')[0].slice(0, 200);
      return body ? `${head}: ${body}` : `${head}: ok`;
    }).join('\n');
  }
  return JSON.stringify(results, null, 2);
}
export async function runBatchCommands({ run }, commands = [], { parallel = false } = {}) {
  const runOne = async (command) => {
    const nested = await run(command);
    const semantics = classifyCommandResultSemantics(nested, { command: command.cmd });
    return {
      cmd: command.cmd,
      ok: semantics.ok,
      result: nested.result,
      error: semantics.ok ? nested.error : semantics.error,
    };
  };
  if (parallel) return Promise.all(commands.map(runOne));
  const results = [];
  for (const command of commands) {
    const result = await runOne(command);
    results.push(result);
  }
  return results;
}
export function parsePageConditionArgs(args = []) {
  const flags = new Map([
    ['--until-selector', 'selector-exists'],
    ['--until-selector-missing', 'selector-missing'],
    ['--until-text', 'text'],
  ]);
  const remainingArgs = [];
  let condition = null;
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (!flags.has(token)) {
      remainingArgs.push(token);
      continue;
    }
    const value = args[++i];
    if (value == null || value === '' || String(value).startsWith('--')) {
      throw new Error(`repeat: ${token} requires a value.`);
    }
    if (condition) {
      throw new Error('repeat: choose exactly one until condition.');
    }
    condition = { kind: flags.get(token), value: String(value) };
  }
  return { condition, remainingArgs };
}
export function pageConditionDescription(condition = {}) {
  if (condition.kind === 'selector-exists') return `selector ${condition.value} exists`;
  if (condition.kind === 'selector-missing') return `selector ${condition.value} is missing`;
  if (condition.kind === 'text') return `text includes ${JSON.stringify(condition.value)}`;
  return 'unknown page condition';
}
export async function probePageCondition(cdp, sid, condition) {
  if (!condition?.kind || !condition?.value) throw new Error('page condition requires a kind and value');
  const value = JSON.stringify(condition.value);
  let expression;
  if (condition.kind === 'selector-exists' || condition.kind === 'selector-missing') {
    const negate = condition.kind === 'selector-missing';
    expression = `JSON.stringify({ matched: ${negate ? '!' : '!!'}document.querySelector(${value}) })`;
  } else if (condition.kind === 'text') {
    expression = `JSON.stringify({ matched: ((document.body && document.body.innerText) || '').includes(${value}) })`;
  } else {
    throw new Error(`Unknown page condition: ${condition.kind}`);
  }
  const raw = await evalStr(cdp, sid, expression);
  const result = JSON.parse(raw);
  return { matched: result.matched === true, description: pageConditionDescription(condition) };
}
export function parseRepeatArgs(args) {
  if (!Array.isArray(args) || args.length < 1) {
    throw new Error('repeat requires <count> <cmd> [args...]');
  }
  const parsedCondition = parsePageConditionArgs(args);
  const opts = { count: 0, cmd: null, args: [], continueOnError: false, condition: parsedCondition.condition };
  const positional = [];
  for (const a of parsedCondition.remainingArgs) {
    if (a === '--continue' || a === '-c') opts.continueOnError = true;
    else positional.push(a);
  }
  if (positional.length < 1) throw new Error('repeat requires <count> <cmd> [args...]');
  const count = parseInt(positional[0], 10);
  if (!Number.isFinite(count) || count < 1 || String(count) !== String(positional[0]).trim()) {
    throw new Error(`repeat: count must be a positive integer, got "${positional[0]}"`);
  }
  if (count > REPEAT_CAP) {
    throw new Error(`repeat: count ${count} exceeds cap ${REPEAT_CAP}. Run multiple repeats or drive your own loop with state checks.`);
  }
  opts.count = count;
  if (positional.length < 2) throw new Error('repeat: command name required after count');
  opts.cmd = positional[1];
  opts.args = positional.slice(2);
  if (REPEAT_BLOCKED.has(opts.cmd)) {
    throw new Error(`repeat: cannot wrap "${opts.cmd}" (would recurse or break IPC). Use a single-shot command (click, press, fill, ...).`);
  }
  return opts;
}
export async function repeatStr({ run, probeCondition }, args) {
  const opts = parseRepeatArgs(args);
  const head = `Repeat ${opts.count}× ${opts.cmd}${opts.args.length ? ' ' + opts.args.join(' ') : ''}${opts.continueOnError ? ' (--continue)' : ''}`;
  const lines = [head];
  let okCount = 0, failCount = 0;
  let haltedEarly = false;
  for (let i = 1; i <= opts.count; i++) {
    const r = await run({ cmd: opts.cmd, args: opts.args.slice() });
    const semantics = classifyCommandResultSemantics(r, { command: opts.cmd });
    if (semantics.ok) {
      okCount++;
      const body = (r.result || '').toString().split('\n')[0].slice(0, 200);
      lines.push(body ? `[${i}/${opts.count}] ok: ${body}` : `[${i}/${opts.count}] ok`);
      if (opts.condition) {
        if (typeof probeCondition !== 'function') throw new Error('repeat: condition probe is unavailable');
        const conditionResult = await probeCondition(opts.condition);
        lines.push(`  Condition: ${conditionResult.description} — ${conditionResult.matched ? 'matched' : 'not matched'}`);
        if (conditionResult.matched) {
          lines.push(`Condition satisfied after iteration ${i}/${opts.count}`);
          lines.push(`Done: ${okCount} ok, ${failCount} failed`);
          return lines.join('\n');
        }
      }
    } else {
      failCount++;
      const errText = semantics.error || 'unknown error';
      lines.push(`[${i}/${opts.count}] ✗ ${errText}`);
      if (!opts.continueOnError) {
        lines.push(`Repeat halted at iteration ${i}/${opts.count} (use --continue to keep going).`);
        haltedEarly = true;
        break;
      }
    }
  }
  lines.push(`Done: ${okCount} ok, ${failCount} failed`);
  if (haltedEarly) throw new Error(lines.join('\n'));
  if (opts.condition && !haltedEarly) {
    lines.push(`repeat: condition not satisfied after ${opts.count} iterations`);
    throw new Error(lines.join('\n'));
  }
  return lines.join('\n');
}
// --- Flow: sequential step runner ---
// A semicolon separates steps only outside quotes (' " `). A quote opens only at
// the start of a word: the start of a segment, or after whitespace. A quote inside
// a word stays literal. Inside quotes a backslash is literal, except `\;`, which
// keeps a semicolon. The opening quote always closes. Outside quotes, `\;` is a
// literal semicolon, and a doubled backslash does not escape the next character,
// so `\\;` still separates steps. An unquoted `\;` before a command name, alias,
// or assert fails the flow, except inside an unquoted eval/eval64/call body.
// That body keeps consuming segments until the next one starts with a command
// name, alias, or assert. A body that is one wrapped quote stops at that quote.
// The unwrapped script body is one argument, byte-exact, including an empty
// quoted body. Wrapping quotes on that body are flow delimiters and are not
// part of the JavaScript.
export let flowStepHeads = null;
export function flowStepHeadSet() {
  if (!flowStepHeads) {
    flowStepHeads = new Set(['assert', FOREGROUND_ACTIVATE_COMMAND]);
    for (const command of COMMANDS) {
      flowStepHeads.add(command.name);
      for (const alias of command.aliases || []) flowStepHeads.add(alias);
    }
  }
  return flowStepHeads;
}
export function firstFlowToken(segment) {
  const trimmed = String(segment || '').trim();
  if (!trimmed) return '';
  const opener = trimmed[0];
  if (opener === '"' || opener === "'" || opener === '`') return '';
  const match = /^[^\s]+/.exec(trimmed);
  return match ? match[0] : '';
}
// Raw slices keep `\;` and the original quotes so a path rewrite can rejoin
// unchanged steps without turning a literal semicolon into a separator.
export function flowQuoteOpens(atTokenStart, ch) {
  return atTokenStart && (ch === '"' || ch === "'" || ch === '`');
}
// Inside quotes, a backslash is literal except `\;`, which keeps a semicolon.
// The opening quote always closes; this does not swallow it. `skip` is how many
// extra characters the caller moves past. A trailing backslash emits itself.
export function flowQuotedEscape(ch, next) {
  if (ch === '\\' && next === ';') return { emit: ';', skip: 1 };
  return { emit: ch, skip: 0 };
}
export function flowWordAt(input, index, limit = input.length) {
  let cursor = index;
  while (cursor < limit && /\s/.test(input[cursor])) cursor += 1;
  if (cursor >= limit) return '';
  const opener = input[cursor];
  if (opener === '"' || opener === "'" || opener === '`') return '';
  let word = '';
  while (cursor < limit && !/\s/.test(input[cursor]) && input[cursor] !== ';') {
    word += input[cursor];
    cursor += 1;
  }
  return word;
}
// Unquoted `\;` in an eval/eval64/call body is how that body keeps a semicolon
// before a command word. After a wrapped script quote has closed, or in any
// other step, that same spelling swallows the next step.
export function escapedSemicolonIsScriptBody(input, segmentStart, slashIndex) {
  const prefix = input.slice(segmentStart, slashIndex).trim();
  const head = firstFlowToken(prefix);
  if (!FLOW_SCRIPT_COMMANDS.has(head)) return false;
  const rest = prefix.slice(head.length).trim();
  const body = head === 'eval' ? takeEvalFlowFlags(rest).body : rest;
  if (!body) return true;
  const opener = body[0];
  return opener !== '"' && opener !== "'" && opener !== '`';
}
export function ambiguousEscapedSemicolonError(nextWord) {
  return new Error([
    `flow: unquoted \\; before ${nextWord} is a semicolon, so ${nextWord} does not start a step. Quote the value, for example fill #p "C:\\a\\"; summary`,
    'Kind: usage',
    'Next: cdp help flow',
  ].join('\n'));
}
// #698: a script step gets an example in its own command. A `"` or backtick
// opener is fixed with single quotes; a `'` opener with double quotes.
const FLOW_UNCLOSED_SCRIPT_EXAMPLES = {
  eval: { double: "eval 'const x = 1; x'", single: 'eval "const x = 1; x"' },
  eval64: { double: "eval64 'eCA9IDE7IHg='", single: 'eval64 "eCA9IDE7IHg="' },
  call: { double: "call '() => document.title'", single: 'call "() => document.title"' },
};
// The command word of the step that holds the opener. `stepStart` is where
// that step begins; a single segment starts at 0.
function flowStepHeadAt(text, openIndex, stepStart = 0) {
  const head = text.slice(stepStart, openIndex).trim().split(/\s+/)[0] || '';
  return Object.hasOwn(FLOW_UNCLOSED_SCRIPT_EXAMPLES, head) ? head : '';
}
// Name the opener and a spelling that parses. A leading apostrophe is the
// opener, so 'twas is closed by switching quote kind: type "'twas".
export function unclosedFlowQuoteError(source, openIndex, stepStart = 0) {
  const text = String(source || '');
  const quote = text[openIndex] || '';
  const rawExcerpt = text.length <= 48
    ? text
    : text.slice(Math.max(0, openIndex - 10), Math.min(text.length, openIndex + 18));
  const excerpt = rawExcerpt.replace(/\s+/g, ' ');
  const scriptExample = FLOW_UNCLOSED_SCRIPT_EXAMPLES[flowStepHeadAt(text, openIndex, stepStart)];
  const example = scriptExample
    ? scriptExample[quote === "'" ? 'single' : 'double']
    : quote === "'"
      ? 'type "\'twas"'
      : quote === '"'
        ? "fill #p 'abc'"
        : 'type "hello"';
  return new Error([
    `flow: unclosed quote in steps: ${quote} opened at index ${openIndex} (${excerpt}). Close it, or use a different quote kind, e.g. ${example}`,
    'Kind: usage',
    'Next: cdp help flow',
  ].join('\n'));
}
export function splitFlowSegmentsRaw(input) {
  const segments = [];
  let start = 0;
  let quote = '';
  let quoteAt = -1;
  let atTokenStart = true;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      // A backslash does not swallow the closer. `\;` stays in this step.
      const escaped = flowQuotedEscape(ch, input[i + 1]);
      if (escaped.skip) {
        i += escaped.skip;
        continue;
      }
      if (ch === quote) {
        quote = '';
        quoteAt = -1;
        atTokenStart = false;
      }
      continue;
    }
    // Pair from the left. `\\` is an escaped backslash, so the second slash does
    // not escape a following semicolon: `\\;` still starts the next step.
    if (ch === '\\' && input[i + 1] === '\\') {
      i += 1;
      atTokenStart = false;
      continue;
    }
    if (ch === '\\' && input[i + 1] === ';') {
      const nextWord = flowWordAt(input, i + 2);
      if (nextWord && flowStepHeadSet().has(nextWord) && !escapedSemicolonIsScriptBody(input, start, i)) {
        throw ambiguousEscapedSemicolonError(nextWord);
      }
      i += 1;
      atTokenStart = false;
      continue;
    }
    if (flowQuoteOpens(atTokenStart, ch)) {
      quote = ch;
      quoteAt = i;
      atTokenStart = false;
      continue;
    }
    if (ch === ';') {
      segments.push(input.slice(start, i));
      start = i + 1;
      atTokenStart = true;
      continue;
    }
    atTokenStart = /\s/.test(ch);
  }
  if (quote) throw unclosedFlowQuoteError(input, quoteAt, start);
  segments.push(input.slice(start));
  return segments;
}
export function decodeFlowEscapedSemicolon(segment) {
  let out = '';
  let quote = '';
  let quoteAt = -1;
  let atTokenStart = true;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote) {
      // Keep `\;` for the quoted-value decode. A backslash does not hide the closer.
      out += ch;
      if (ch === quote) {
        quote = '';
        quoteAt = -1;
        atTokenStart = false;
      }
      continue;
    }
    if (ch === '\\' && segment[i + 1] === '\\') {
      out += '\\\\';
      i += 1;
      atTokenStart = false;
      continue;
    }
    if (ch === '\\' && segment[i + 1] === ';') {
      out += ';';
      i += 1;
      atTokenStart = false;
      continue;
    }
    if (flowQuoteOpens(atTokenStart, ch)) {
      quote = ch;
      quoteAt = i;
      atTokenStart = false;
    } else {
      atTokenStart = /\s/.test(ch);
    }
    out += ch;
  }
  if (quote) throw unclosedFlowQuoteError(segment, quoteAt);
  return out;
}
export function splitFlowSegments(input) {
  return splitFlowSegmentsRaw(input).map(decodeFlowEscapedSemicolon);
}
// `\;` inside quotes becomes a semicolon once. Other backslashes stay.
// Outside quotes, decodeFlowEscapedSemicolon already turned `\;` into `;`.
export function decodeQuotedFlowSemicolon(segment) {
  let out = '';
  let quote = '';
  let quoteAt = -1;
  let atTokenStart = true;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote) {
      const escaped = flowQuotedEscape(ch, segment[i + 1]);
      if (escaped.skip) {
        out += escaped.emit;
        i += escaped.skip;
        continue;
      }
      out += ch;
      if (ch === quote) {
        quote = '';
        quoteAt = -1;
        atTokenStart = false;
      }
      continue;
    }
    if (flowQuoteOpens(atTokenStart, ch)) {
      quote = ch;
      quoteAt = i;
      atTokenStart = false;
    } else {
      atTokenStart = /\s/.test(ch);
    }
    out += ch;
  }
  if (quote) throw unclosedFlowQuoteError(segment, quoteAt);
  return out;
}
export function takeEvalFlowFlags(rest) {
  const args = [];
  let body = String(rest || '').trim();
  while (body) {
    const match = /^(--fire-and-forget|--faf|--raw|--b64|-b)(?:\s+([\s\S]*))?$/.exec(body);
    if (!match) break;
    args.push(match[1]);
    body = String(match[2] || '').trim();
    if (match[1] === '--b64' || match[1] === '-b') break;
  }
  return { args, body };
}
export function wrappedFlowQuote(text) {
  if (!text) return false;
  const opener = text[0];
  if (opener !== '"' && opener !== "'" && opener !== '`') return false;
  for (let i = 1; i < text.length; i++) {
    const escaped = flowQuotedEscape(text[i], text[i + 1]);
    if (escaped.skip) {
      i += escaped.skip;
      continue;
    }
    if (text[i] === opener) return i === text.length - 1;
  }
  return false;
}
export function scriptSegmentClosesQuote(segment) {
  const trimmed = String(segment || '').trim();
  const head = firstFlowToken(trimmed);
  if (!FLOW_SCRIPT_COMMANDS.has(head)) return false;
  const rest = trimmed.slice(head.length);
  const body = head === 'eval' ? takeEvalFlowFlags(rest).body : String(rest || '').trim();
  return wrappedFlowQuote(body);
}
export function mergeFlowScriptSegments(segments) {
  const steps = [];
  let index = 0;
  while (index < segments.length) {
    if (!segments[index].trim()) {
      index++;
      continue;
    }
    const head = firstFlowToken(segments[index]);
    if (!FLOW_SCRIPT_COMMANDS.has(head)) {
      steps.push(segments[index].trim());
      index++;
      continue;
    }
    let combined = segments[index];
    let next = index + 1;
    // Only an unquoted body continues. A wrapped quote already ended the body,
    // so the next segment is the next step even when it is not a command name.
    if (!scriptSegmentClosesQuote(segments[index])) {
      while (next < segments.length) {
        const piece = segments[next];
        if (piece.trim() && flowStepHeadSet().has(firstFlowToken(piece))) break;
        combined += `;${piece}`;
        next++;
      }
    }
    steps.push(combined.trim());
    index = next;
  }
  return steps;
}
export function unwrapFlowScriptBody(text) {
  if (!text) return '';
  const opener = text[0];
  if (opener !== '"' && opener !== "'" && opener !== '`') return text;
  let decoded = '';
  for (let i = 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') {
      const next = text[i + 1];
      // A trailing backslash is literal. The quote, if still open, is unclosed.
      if (next === undefined) {
        decoded += ch;
        continue;
      }
      const escaped = flowQuotedEscape(ch, next);
      if (escaped.skip) {
        decoded += escaped.emit;
        i += escaped.skip;
        continue;
      }
    }
    if (ch === opener) {
      if (i !== text.length - 1) return text;
      return decoded;
    }
    decoded += ch;
  }
  throw unclosedFlowQuoteError(text, 0);
}
export function scriptCommandArgs(cmd, body) {
  const taken = cmd === 'eval' ? takeEvalFlowFlags(body) : { args: [], body: String(body || '').trim() };
  if (!taken.body) return taken.args;
  // One argument, including "". Splitting on whitespace would change literals such as 'a  b'.
  taken.args.push(unwrapFlowScriptBody(taken.body));
  return taken.args;
}
export function parseFlowLine(line) {
  const trimmed = String(line || '').trim();
  const head = firstFlowToken(trimmed);
  if (head === FOREGROUND_ACTIVATE_COMMAND) throw new Error(`flow: "${head}" is internal and not allowed as a step`);
  if (FLOW_SCRIPT_COMMANDS.has(head)) {
    return { kind: 'command', cmd: head, args: scriptCommandArgs(head, trimmed.slice(head.length)) };
  }
  // Non-script steps use tokenizeFlowCommandLine. `\;` inside quotes is already a
  // semicolon. Any other backslash stays, and a backtick-quoted word is one
  // argument with the backticks removed. Batch still uses tokenizeCommandLine.
  const decoded = decodeQuotedFlowSemicolon(trimmed);
  if (head === 'wait') {
    const parts = tokenizeFlowCommandLine(decoded).map(token => token.value);
    const what = parts.slice(1).join(' ').toLowerCase();
    if (what === 'dom stable' || what === 'network idle') return { kind: 'wait', what };
    // `cdp wait <ms>` is a real command. Flow used to send every wait to the settle helper.
    if (parts.length === 2 && /^\d+$/.test(parts[1])) return { kind: 'command', cmd: 'wait', args: [parts[1]] };
    return { kind: 'wait', what };
  }
  if (head === 'assert') {
    const parts = tokenizeFlowCommandLine(decoded).map(token => token.value);
    const assertionKind = parts[1];
    // Quotes are already removed. A second strip would eat quotes that are part
    // of the value, such as assert text `"O'Brien"`.
    const value = parts.slice(2).join(' ');
    const kinds = {
      selector: 'selector-exists',
      'selector-missing': 'selector-missing',
      text: 'text',
    };
    if (!kinds[assertionKind] || !value) {
      throw new Error('flow assert: use "assert selector <css>", "assert selector-missing <css>", or "assert text <value>".');
    }
    return { kind: 'assert', condition: { kind: kinds[assertionKind], value } };
  }
  const tokens = tokenizeFlowCommandLine(decoded);
  return { kind: 'command', cmd: tokens[0].value, args: commandArgsFromTokens(tokens.slice(1)) };
}
export function parseFlowSteps(input) {
  if (typeof input !== 'string' || !input.trim()) return [];
  return mergeFlowScriptSegments(splitFlowSegments(input)).map(parseFlowLine);
}
export function flowStepHelpLines() {
  return [
    'A semicolon separates flow steps only outside quotes. Quotes are single quotes, double quotes, or backticks.',
    'A quote opens only at the start of a word (the start of a step, or after whitespace). A quote inside a word stays literal.',
    'A backslash-semicolon (\\;) is a literal semicolon and does not start a step. A doubled backslash does not escape that semicolon, so \\\\; still starts a step and both backslashes stay in the previous step.',
    'Inside quotes, a backslash is literal, except \\; which keeps a semicolon. The opening quote always closes. Put a quote in the value by wrapping that step in another kind of quote.',
    'An unquoted \\; before a command name, alias, or assert fails the flow before any step runs, except inside an unquoted eval, eval64, or call body. Quote the value to keep a trailing backslash and start the next step, for example fill #p "C:\\a\\"; summary.',
    'wait <milliseconds> is the standalone wait command, for example wait 2000.',
    'wait dom stable and wait network idle still wait for the page and fail the flow on timeout.',
    'eval, eval64, and call take one script body. Wrapping quotes around that body are flow delimiters, not JavaScript.',
    'Spaces, newlines, and tabs in that script body stay byte-for-byte.',
    'An unquoted script body continues across semicolons until the next segment starts with a command name, alias, or assert.',
    'Quote that body, or write \\;, when a statement after a semicolon starts with one of those words.',
    'An unclosed quote fails the flow before any step runs. A leading apostrophe opens a quote, so \'twas is an unclosed quote.',
    'A backtick-quoted word in a non-script step is one argument with the backticks removed. The characters inside stay byte-for-byte. A backslash inside those quotes is literal, except \\; which keeps a semicolon.',
    'A value with significant whitespace or a quote must be wrapped in a quote kind it does not contain.',
    'An unquoted fill or type value is trimmed, and a run of whitespace is an argument boundary.',
  ];
}
export function flowStepModel(step = {}, index = 0, state = {}) {
  const semantics = classifyCommandResultSemantics(state, { command: step.cmd });
  const base = {
    index: index + 1,
    kind: step.kind || 'command',
    ok: semantics.ok,
  };
  if (step.kind === 'wait') base.wait = step.what || '';
  else if (step.kind === 'assert') base.condition = step.condition || null;
  else {
    base.cmd = step.cmd || '';
    base.args = Array.isArray(step.args) ? step.args : [];
  }
  if (state.skipped) {
    base.ok = false;
    base.skipped = true;
    return base;
  }
  const actionModel = semantics.action;
  const diagnosis = diagnosisFromActionModel(actionModel);
  const verdict = verdictFromActionModel(actionModel);
  if (diagnosis) base.diagnosis = diagnosis;
  if (verdict) base.verdict = verdict;
  if (base.ok) {
    base.resultPreview = firstNonEmptyLine(state.result);
    return base;
  }
  const errorText = String(semantics.error || 'unknown error');
  base.error = errorText;
  if (step.kind === 'assert') {
    base.failureKind = 'assertion';
    base.nextCommand = 'cdp help flow';
    return base;
  }
  const failureKind = semantics.dispatchFailed
    ? actionModel?.effects?.failure?.kind || null
    : extractLabeledLine(errorText, 'Action failure');
  const nextCommand = semantics.dispatchFailed
    ? actionModel?.nextHint || actionModel?.effects?.failure?.nextCommand || null
    : extractLabeledLine(errorText, 'Next');
  if (failureKind) base.failureKind = failureKind;
  if (nextCommand) base.nextCommand = nextCommand;
  return base;
}
export function buildFlowResultModel({ targetId = null, input = '', steps = [], stepResults = [] } = {}) {
  const failedStep = stepResults.find(step => step.ok === false && step.skipped !== true) || null;
  const skipped = stepResults.filter(step => step.skipped === true).length;
  const failed = failedStep ? 1 : 0;
  const ok = stepResults.filter(step => step.ok === true).length;
  const diagnosisAttentionSteps = stepResults.filter(step => step.ok && isAttentionDiagnosis(step.diagnosis));
  const verdictAttentionSteps = stepResults.filter(step => step.ok && isAttentionVerdict(step.verdict));
  const attentionSteps = [...new Set([...diagnosisAttentionSteps, ...verdictAttentionSteps])];
  const nextSteps = [];
  const pushNext = (command) => {
    if (command && !nextSteps.includes(command)) nextSteps.push(command);
  };
  if (failedStep) {
    for (const command of recoveryCommandsFromDiagnosis(failedStep.diagnosis)) pushNext(command);
    for (const command of recoveryCommandsFromVerdict(failedStep.verdict)) pushNext(command);
    pushNext(failedStep.nextCommand);
  }
  if (failedStep && nextSteps.length === 0) {
    if (failedStep.kind === 'assert' || failedStep.failureKind === 'assertion') {
      pushNext('cdp help flow');
    } else {
      pushNext(targetId ? `cdp status ${targetId}` : 'cdp status <target>');
    }
  }
  for (const step of attentionSteps) {
    for (const command of recoveryCommandsFromDiagnosis(step.diagnosis)) pushNext(command);
    for (const command of recoveryCommandsFromVerdict(step.verdict)) pushNext(command);
  }
  return {
    schema: 'chrome-cdp-ex.flow.v1',
    targetId,
    input,
    halted: !!failedStep,
    counts: {
      steps: steps.length,
      ok,
      failed,
      skipped,
      attention: attentionSteps.length,
    },
    steps: stepResults,
    failedStep,
    nextSteps,
  };
}
export async function settleFlow(cdp, sid, what, pendingReqs, opts = {}) {
  const max = opts.maxMs || 10000;
  const quiet = opts.quietMs || 500;
  if (what === 'dom stable') {
    const outcome = await waitForSettle(cdp, sid, max);
    if (outcome === 'timeout') throw new Error(`wait dom stable timed out after ${max}ms`);
    return 'dom stable';
  }
  if (what === 'network idle') {
    const deadline = Date.now() + max;
    let lastBusy = Date.now();
    while (Date.now() < deadline) {
      const size = pendingReqs?.size || 0;
      if (size > 0) lastBusy = Date.now();
      else if (Date.now() - lastBusy >= quiet) return 'network idle';
      await sleep(100);
    }
    throw new Error(`wait network idle timed out after ${max}ms (${pendingReqs?.size || 0} pending requests)`);
  }
  throw new Error(`Unknown wait: "${what}". Use "dom stable", "network idle", or a millisecond count such as wait 2000.`);
}
export async function flowStr({ run, settle, assertCondition }, input, { format = 'text', targetId = null, throwOnFailure = false } = {}) {
  const steps = parseFlowSteps(input);
  if (steps.length === 0) throw new Error('flow: no steps. Example: flow <target> "click @1; wait dom stable; summary"');
  const lines = [`Flow: ${steps.length} step(s)`];
  const stepResults = [];
  const finish = () => {
    const model = buildFlowResultModel({ targetId, input, steps, stepResults });
    const output = format === 'json' ? formatJson(model) : lines.join('\n');
    if (throwOnFailure && model.halted) {
      const error = new Error(output);
      error.code = 'FLOW_HALTED';
      throw error;
    }
    return output;
  };
  const markSkippedAfter = (startIndex) => {
    for (let j = startIndex; j < steps.length; j++) {
      stepResults.push(flowStepModel(steps[j], j, { skipped: true }));
    }
  };
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const head = step.kind === 'wait'
      ? `[${i + 1}/${steps.length}] wait ${step.what}`
      : step.kind === 'assert'
      ? `[${i + 1}/${steps.length}] assert ${pageConditionDescription(step.condition)}`
      : `[${i + 1}/${steps.length}] ${step.cmd}${step.args.length ? ' ' + step.args.join(' ') : ''}`;
    lines.push(head);
    try {
      let body;
      if (step.kind === 'wait') {
        body = await settle(step.what);
      } else if (step.kind === 'assert') {
        if (typeof assertCondition !== 'function') throw new Error('flow: assertion probe is unavailable');
        const assertion = await assertCondition(step.condition);
        if (!assertion.matched) throw new Error(`Assertion failed: ${assertion.description}`);
        body = `Assertion passed: ${assertion.description}`;
      } else {
        const r = await run(step);
        if (!r.ok) {
          stepResults.push(flowStepModel(step, i, {
            ok: false,
            result: r.result,
            error: r.error,
          }));
          markSkippedAfter(i + 1);
          lines.push(`  ✗ ${r.error}`);
          lines.push(`Flow halted at step ${i + 1}/${steps.length}`);
          return finish();
        }
        body = r.result ?? '';
      }
      const stepModel = flowStepModel(step, i, { ok: true, result: body });
      stepResults.push(stepModel);
      const text = (body || '').toString();
      if (text) for (const ln of text.split('\n')) lines.push('  ' + ln);
      if (!stepModel.ok) {
        markSkippedAfter(i + 1);
        lines.push(`Flow halted at step ${i + 1}/${steps.length}`);
        return finish();
      }
    } catch (e) {
      if (e?.code === 'FLOW_HALTED') throw e;
      stepResults.push(flowStepModel(step, i, { ok: false, error: e.message }));
      markSkippedAfter(i + 1);
      lines.push(`  ✗ ${e.message}`);
      lines.push(`Flow halted at step ${i + 1}/${steps.length}`);
      return finish();
    }
  }
  return finish();
}
export function parseReplayArgs(args, { reader = readFileSync } = {}) {
  const fopts = parseFormatArgs((args || []).filter(a => a !== undefined && a !== null), ['text', 'json']);
  const tokens = fopts.args;
  const opts = { continueOnError: false, artifact: null, source: 'inline JSON', format: fopts.format };
  const positional = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '--continue' || token === '-c') {
      opts.continueOnError = true;
    } else if (token === '--json') {
      const raw = tokens.slice(i + 1).join(' ').trim();
      if (!raw) throw new Error('replay --json requires a record-actions JSON payload');
      opts.artifact = parseReplayArtifact(raw);
      opts.source = 'inline JSON';
      break;
    } else if (token === '--file' || token === '-f') {
      const filePath = tokens[++i];
      if (!filePath) throw new Error('replay --file requires a path to a record-actions JSON artifact');
      opts.artifact = parseReplayArtifact(reader(filePath, 'utf8'));
      opts.source = filePath;
    } else {
      positional.push(token);
    }
  }
  if (!opts.artifact) {
    const raw = positional.join(' ').trim();
    if (!raw) throw new Error('replay requires --json <record-actions-json> or --file <path>');
    if (raw.startsWith('{') || raw.startsWith('[')) {
      opts.artifact = parseReplayArtifact(raw);
      opts.source = 'inline JSON';
    } else {
      opts.artifact = parseReplayArtifact(reader(positional[0], 'utf8'));
      opts.source = positional[0];
    }
  }
  return opts;
}
export function parseReplayArtifact(raw) {
  let artifact;
  try {
    artifact = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) {
    throw new Error(`replay: invalid JSON artifact (${e.message})`);
  }
  if (Array.isArray(artifact)) {
    artifact = { schema: 'chrome-cdp-ex.record-actions.v1', actions: artifact };
  }
  if (!artifact || typeof artifact !== 'object') throw new Error('replay: artifact must be a record-actions JSON object');
  if (artifact.schema !== 'chrome-cdp-ex.record-actions.v1') {
    throw new Error(`replay: unsupported artifact schema ${artifact.schema || '(missing)'}`);
  }
  if (!Array.isArray(artifact.actions)) throw new Error('replay: artifact.actions must be an array');
  if (artifact.environment != null && !Array.isArray(artifact.environment)) throw new Error('replay: artifact.environment must be an array when provided');
  return artifact;
}
export function replayCommandMissingFields(action = {}, command = []) {
  const declared = Array.isArray(action.needsInput) ? action.needsInput.filter(Boolean) : [];
  const inferred = [];
  const cmd = command[0];
  if (cmd === 'fill') {
    try {
      const parsed = parseFillArgs(command.slice(1));
      const textTokens = parsed.args.slice(1);
      if (!parsed.selector) inferred.push('target');
      if (textTokens.length === 0 && parsed.secretName == null) inferred.push('text');
    } catch {
      inferred.push('text');
    }
  } else if (cmd === 'type') {
    try {
      const fopts = parseCompactFormatArgs(command.slice(1), ['text', 'json']);
      if (!fopts.args.length) inferred.push('text');
    } catch {
      inferred.push('text');
    }
  } else if (cmd === 'select' && command.length < 3) {
    inferred.push('value');
  }
  return [...new Set([...declared, ...inferred])];
}
export function replayStepFromAction(action = {}) {
  const command = Array.isArray(action.command) ? action.command.map(v => String(v)) : [];
  const commandText = command.length ? formatCommandLine(command) : `${action.action || 'action'} <missing command>`;
  const missing = replayCommandMissingFields(action, command);
  if (action.replayable !== true) {
    return {
      skip: true,
      command,
      commandText,
      missing: missing.length ? missing : ['review'],
      reason: 'not replayable',
    };
  }
  if (!command.length || !command[0]) {
    return { skip: true, command, commandText, missing: ['command'], reason: 'missing command' };
  }
  if (command.includes('<redacted>')) {
    return {
      skip: true,
      command,
      commandText,
      missing: missing.length ? missing : redactedCommandNeedsInput(action.action || command[0]),
      reason: 'redacted input',
    };
  }
  if (REPLAY_BLOCKED.has(command[0])) {
    return { skip: true, command, commandText, missing: ['safe command'], reason: `blocked command: ${command[0]}` };
  }
  if (missing.length) {
    return { skip: true, command, commandText, missing, reason: 'missing input' };
  }
  return { cmd: command[0], args: command.slice(1), command, commandText };
}
// #466: the steps batch/flow/repeat/replay would run, so the session policy can refuse the whole
// command before its first step. Null when the arguments do not parse; the command reports that.
export function policyCompositeSteps(cmd, args = []) {
  try {
    if (cmd === 'batch') {
      return parseBatchArgs(args).commands.map(command => ({
        cmd: String(command?.cmd || ''),
        args: Array.isArray(command?.args) ? command.args.map(String) : [],
      }));
    }
    if (cmd === 'flow') {
      // wait/assert steps stay as empty entries so step numbers match the flow text.
      return parseFlowSteps(parseFormatArgs(args, ['text', 'json']).args.join(' '))
        .map(step => (step.kind === 'command' ? { cmd: step.cmd, args: step.args } : { cmd: '', args: [] }));
    }
    if (cmd === 'repeat') {
      const opts = parseRepeatArgs(args);
      return [{ cmd: opts.cmd, args: opts.args }];
    }
    if (cmd === 'replay') {
      const { artifact } = parseReplayArgs(args);
      const actions = [
        ...(Array.isArray(artifact.environment) ? artifact.environment : []),
        ...(Array.isArray(artifact.actions) ? artifact.actions : []),
      ];
      // Steps replay skips stay as empty entries so step numbers match the artifact.
      return actions.map(replayStepFromAction)
        .map(step => (!step.skip && step.cmd ? { cmd: step.cmd, args: step.args } : { cmd: '', args: [] }));
    }
  } catch {
    return null;
  }
  return null;
}
export function replayRecoveryNextSteps(targetId) {
  const target = targetId || '<target>';
  return [
    `cdp perceive ${target} -C -d 8`,
    `cdp report ${target} --format json`,
  ];
}
export async function replayActionsStr({ run }, args) {
  const opts = parseReplayArgs(args);
  const actions = opts.artifact.actions;
  const environment = Array.isArray(opts.artifact.environment) ? opts.artifact.environment : [];
  const total = actions.length;
  const model = {
    schema: 'chrome-cdp-ex.replay.v1',
    source: opts.source,
    sourceTargetId: opts.artifact.targetId || null,
    sourceSessionId: opts.artifact.sessionId || null,
    continueOnError: opts.continueOnError,
    halted: false,
    counts: {
      environment: environment.length,
      actions: total,
      total: environment.length + total,
      ok: 0,
      failed: 0,
      skipped: 0,
    },
    steps: [],
    failedStep: null,
    nextSteps: [],
  };
  const lines = [
    `Replay: ${total} step(s)`,
    `Source: ${opts.source}`,
  ];
  if (environment.length) lines.push(`Environment: ${environment.length} step(s)`);
  const finish = () => {
    lines.push(`Done: ${model.counts.ok} ok, ${model.counts.failed} failed, ${model.counts.skipped} skipped`);
    if (model.failedStep) model.nextSteps = replayRecoveryNextSteps(model.sourceTargetId);
    return opts.format === 'json' ? formatJson(model) : lines.join('\n');
  };
  const recordStep = (phase, index, totalCount, step, details) => {
    const entry = {
      phase,
      index,
      total: totalCount,
      command: step.command || [],
      commandText: step.commandText,
      ok: details.ok === true,
      skipped: details.skipped === true,
    };
    if (details.resultPreview) entry.resultPreview = details.resultPreview;
    if (details.error) entry.error = details.error;
    if (step.reason) entry.reason = step.reason;
    if (step.missing?.length) entry.missing = step.missing;
    model.steps.push(entry);
    return entry;
  };
  const runReplayStep = async (step, phase, index, totalCount, label, haltText) => {
    if (step.skip) {
      model.counts.skipped++;
      lines.push(`${label} skip ${step.commandText}`);
      if (step.reason) lines.push(`  Reason: ${step.reason}`);
      if (step.missing?.length) lines.push(`  Missing: ${step.missing.join(', ')}`);
      recordStep(phase, index, totalCount, step, { skipped: true });
      return true;
    }
    lines.push(`${label} ${step.commandText}`);
    const result = await run({ cmd: step.cmd, args: step.args });
    const semantics = classifyCommandResultSemantics(result, { command: step.cmd });
    if (semantics.ok) {
      model.counts.ok++;
      const body = (result.result || '').toString().split('\n')[0].slice(0, 240);
      if (body) lines.push(`  ok: ${body}`);
      else lines.push('  ok');
      recordStep(phase, index, totalCount, step, { ok: true, resultPreview: body || null });
      return true;
    }
    model.counts.failed++;
    const error = semantics.error || 'unknown error';
    lines.push(`  ✗ ${error}`);
    const failedStep = recordStep(phase, index, totalCount, step, { ok: false, error });
    if (!model.failedStep) model.failedStep = failedStep;
    if (!opts.continueOnError) {
      model.halted = true;
      lines.push(`${haltText} (use --continue to keep going).`);
      return false;
    }
    return true;
  };
  for (let i = 0; i < environment.length; i++) {
    const step = replayStepFromAction(environment[i]);
    const keepGoing = await runReplayStep(step, 'environment', i + 1, environment.length, `[env ${i + 1}/${environment.length}]`, `Replay halted at environment step ${i + 1}/${environment.length}`);
    if (!keepGoing) {
      return finish();
    }
  }
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    const step = replayStepFromAction(action);
    const keepGoing = await runReplayStep(step, 'action', i + 1, total, `[${i + 1}/${total}]`, `Replay halted at step ${i + 1}/${total}`);
    if (!keepGoing) break;
  }
  return finish();
}
export function hostSkillInstallPaths({ home = homedir(), env = process.env } = {}) {
  const p = pathApiForRoot(home);
  const hermesHome = env.HERMES_HOME || p.join(home, '.hermes');
  return [...new Set([
    pathApiForRoot(hermesHome).join(hermesHome, 'skills', 'chrome-cdp-ex'),
    p.join(home, '.hermes', 'skills', 'chrome-cdp-ex'),
    p.join(home, '.claude', 'skills', 'chrome-cdp-ex'),
    p.join(home, '.codex', 'skills', 'chrome-cdp-ex'),
  ])];
}
export function doctorCliPrefix(node) {
  if (node?.recommendedBinary && node.cdpScriptPath) {
    return `${node.recommendedBinary} ${node.cdpScriptPath}`;
  }
  return 'cdp';
}
export function checkSkillSymlink({ home = homedir(), env = process.env, fs = { existsSync, lstatSync: null } } = {}) {
  const candidates = hostSkillInstallPaths({ home, env });
  const target = candidates.find(path => fs.existsSync(path));
  if (!target) {
    return {
      status: 'WARN', label: 'Skill install', detail: `${candidates.join(', ')} not found`,
      hint: 'Install with: cp -r skills/chrome-cdp-ex ~/.hermes/skills/  (or ~/.claude/skills/, ~/.codex/skills/, or use the plugin loader)',
    };
  }
  let kind = 'directory';
  try {
    const lstat = fs.lstatSync ? fs.lstatSync(target) : null;
    if (lstat?.isSymbolicLink?.()) kind = 'symlink';
  } catch {}
  const binPath = pathApiForRoot(target).join(target, 'bin', 'chrome-cdp');
  if (!fs.existsSync(binPath)) {
    return {
      status: 'WARN',
      label: 'Skill launcher',
      detail: `${target} is missing bin/chrome-cdp`,
      hint: 'Installed skill copies should include bin/chrome-cdp wrapping scripts/cdp.mjs. From a checkout use repo-root ./bin/chrome-cdp.',
    };
  }
  return { status: 'OK', label: 'Skill install', detail: `${kind}: ${target}` };
}
