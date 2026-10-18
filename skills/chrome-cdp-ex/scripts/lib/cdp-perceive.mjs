// Moved from cdp.mjs without changes (#688). cdp.mjs is the entry point and re-exports for tests.
import { isTimeoutError } from './action-recovery.mjs';
import { buildCardsModel, formatCardsJson, formatCardsText } from './cards-model.mjs';
import { createPerceptionModel } from './perception-model.mjs';

import { actionDomDiffShowsChange, countTypeaheadLabels, extractTypeaheadLabels, pdfViewerPerceiveResult, perceiveStoreDiffSource, rememberPerceiveDiffSource } from './cdp-action-result.mjs';
import { CONTENT_REF_ROLES, ENRICHED_ROLES, HIDDEN_TEXT_CAP_NOTE, HIDDEN_TEXT_MAX_CHARS, HIDDEN_TEXT_MAX_LINES, HOVER_MUTATION_MARKER, HOVER_MUTATION_TIMEOUT_MS, INTERACTIVE_ROLES, PERCEIVE_CHROME_LANDMARK_ROLES, PERCEIVE_CHROME_LINE_CAP, PERCEIVE_CHROME_MAX_RELATIVE_DEPTH, PERCEIVE_COMPACT_FLAGS, PERCEIVE_CONTENT_LANDMARK_ROLES, PERCEIVE_COORDS_LINE, PERCEIVE_COORDS_LINE_VERBOSE, PERCEIVE_CURSOR_SURFACE_DEFAULT_CAP, PERCEIVE_SNAPSHOT_FLAGS, REF_HIGH_WATER, REF_RESOLVE_TIMEOUT, REF_SETTLE_BUDGET_MS, SKIP_LINK_NAME_RE, STALE_REF_ERROR_CODE, STATUS_PAGE_INFO_TIMEOUT, TYPEAHEAD_FOCUS_ROLES, TYPEAHEAD_OMITTED_NOTICE, TYPEAHEAD_POPUP_ROLES, VISIBLE_CONTROL_CAP_SWAP_SAMPLE, daemonPolicyStorage, fileUrlRefusedMessage, sleep, targetLabelExpression } from './cdp-base.mjs';
import { classifyFrameOrigin, createFrameContentNonce, crossSiteReadClause, frameContentBoundary, frameContentOrigin, listedFrame, originHost, parseFrameSiteEntry, rememberListedFrames, wrapFrameContent } from './frame-sites.mjs';
import { formatJson, isBlankPageUrl, parseFormatArgs, takeUnsafeFullArg } from './cdp-browser.mjs';
import { consoleDocumentEntries, cutDocumentConsoleBuffers, displayUrl } from './cdp-core.mjs';
import { actionabilityFunctionSource, namedClickQueryName } from './cdp-input.mjs';
import { cdpDomains, evalStr, formatAxNode, formatPdfViewerOutput, getPages, isPdfViewerContentType, isPriorityPerceiveTextLine, orderedAxChildren, pdfViewerHandoffModelFromOutput, runtimeExceptionMessage, shouldShowAxNode } from './cdp-page.mjs';

export function invalidateSessionRefs(session, reason, options = {}) {
  session.refs.map.clear();
  if (session.refs.frameRefs instanceof Map) session.refs.frameRefs.clear();
  if (session.refs.frameLastOutputs instanceof Map) session.refs.frameLastOutputs.clear();
  session.refs.invalidatedAt = Date.now();
  session.refs.invalidationReason = reason;
  session.refGeneration += 1;
  // #610: reload must not move this cut after the new document's load errors.
  if (reason === 'navigation' && options.cutDocument !== false) cutDocumentConsoleBuffers(session.buffers);
}
export function axPropertyValue(node, name) {
  const want = String(name || '').toLowerCase();
  for (const prop of node?.properties || []) {
    if (String(prop?.name || '').toLowerCase() !== want) continue;
    const value = prop.value;
    if (value && typeof value === 'object' && 'value' in value) return String(value.value ?? '');
    return String(value ?? '');
  }
  return '';
}
export function axNodeUrl(node) {
  return axPropertyValue(node, 'url');
}
export function axNodeAccessibleName(node) {
  const name = String(node?.name?.value ?? '');
  if (name) return name;
  return axPropertyValue(node, 'name')
    || axPropertyValue(node, 'aria-label')
    || axPropertyValue(node, 'description')
    || '';
}
export function isSkipLinkName(name) {
  return SKIP_LINK_NAME_RE.test(String(name || ''));
}
export function isSkipLinkAxNode(node) {
  const role = String(node?.role?.value || '');
  const name = axNodeAccessibleName(node);
  const haystack = [
    name,
    axPropertyValue(node, 'aria-label'),
    axPropertyValue(node, 'description'),
  ].filter(Boolean).join('\n');
  const url = axNodeUrl(node);
  const fragmentOnly = url === '#' || url.startsWith('#');
  if (isSkipLinkName(haystack)) return true;
  if ((role === 'link' || role === 'button') && /^\s*(skip\s+to|跳至)/i.test(name)) return true;
  if (role === 'link' && fragmentOnly) return true;
  return false;
}
// Format a stale/unknown @ref error explaining the most likely root cause.
// `state` holds {generation, invalidationReason, lastPerceiveAt} from the daemon.
export function formatUnknownRefError(ref, state = {}) {
  const reason = state.invalidationReason || (state.generation ? null : 'daemon-start');
  if (reason === 'navigation') {
    return `Unknown ref: ${ref}. Refs were cleared because the page navigated/reloaded after the last perceive (e.g. Vite HMR or in-app routing). Run "perceive" to refresh refs, or use a stable CSS selector for long loops.`;
  }
  if (reason === 'dom-mutation') return formatDomMutationStaleMessage(ref);
  if (reason === 'daemon-restart') {
    return `Unknown ref: ${ref}. Refs from the previous daemon were cleared because this tab's daemon restarted. Run "perceive" to refresh refs, or use a CSS selector.`;
  }
  if (reason === 'daemon-start' || (!state.generation)) {
    return `Unknown ref: ${ref}. No refs have been assigned in this daemon yet. Run "perceive" first, or use a CSS selector.`;
  }
  return `Unknown ref: ${ref}. Run "perceive" to refresh refs, or use a stable CSS selector for long loops.`;
}
export function invalidateRefMapping(refMap, ref, refState) {
  if (refState) {
    refState.invalidatedAt = Date.now();
    refState.invalidationReason = 'dom-mutation';
  }
  const frameParsed = parseFrameRef(ref);
  if (frameParsed) frameScopedRefEntry(refState || {}, frameParsed)?.refs?.delete(frameParsed.refIndex);
  else refMap.delete(parseInt(ref.slice(1)));
}
export function isMissingDomNodeError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('no node with given id')
    || message.includes('could not find node')
    || /node with given id.*does not belong/.test(message)
    || /no node found for given backend/.test(message)
    || /backend node.*(?:not found|does not exist)/.test(message);
}
export function formatDomMutationStaleMessage(ref, suggestion = null) {
  const base = `${ref} is stale: the DOM changed after the last perceive.`;
  const selector = String(suggestion?.selector || '').trim();
  if (suggestion?.count !== 1 || suggestion?.selectorUnique !== true || !selector || selector.startsWith('@')) {
    return base;
  }
  const role = String(suggestion.role || 'element');
  const name = String(suggestion.name ?? '');
  return `${base} It now matches 1 element: [${role}] "${name}" (${selector}).`;
}
export function perceiveTextForStaleRef(ref, refState) {
  const frame = parseFrameRef(ref);
  if (frame && refState?.frameLastOutputs instanceof Map) {
    const framed = refState.frameLastOutputs.get(frame.frameRef);
    if (framed) return String(framed);
  }
  return String(refState?.lastPerceiveText || '');
}
export function identityForStaleRef(ref, refState) {
  const text = perceiveTextForStaleRef(ref, refState);
  if (!text) return null;
  const hit = refAnnotationsFromTreeLines(text.split('\n')).find(item => item.ref === ref);
  if (!hit) return null;
  const role = String(hit.role || '').trim();
  const name = String(hit.name || '').trim();
  if (!role || !name) return null;
  return { role, name };
}
// Read-only lookup. A unique role+name match may be named in the error. Nothing is clicked,
// and the old @ref is never returned as the replacement.
export function staleRefMatchExpression(role, name) {
  const wantedRole = JSON.stringify(String(role || '').toLowerCase());
  const wantedName = JSON.stringify(String(name || ''));
  return `(() => {
    const marker = 'chrome-cdp-ex-stale-ref-match';
    const wantedRole = ${wantedRole};
    const wantedName = ${wantedName};
    const norm = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const roleOf = (el) => {
      const explicit = norm(el.getAttribute && el.getAttribute('role')).toLowerCase();
      if (explicit) return explicit;
      const tag = String(el.tagName || '').toLowerCase();
      if (tag === 'a') return 'link';
      if (tag === 'button' || tag === 'summary') return 'button';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'select') return el.multiple ? 'listbox' : 'combobox';
      if (tag === 'input') {
        const type = String(el.getAttribute('type') || 'text').toLowerCase();
        if (type === 'checkbox' || type === 'radio') return type;
        if (type === 'button' || type === 'submit' || type === 'reset' || type === 'image') return 'button';
        return 'textbox';
      }
      if (el.isContentEditable) return 'textbox';
      return '';
    };
    const accName = (el) => {
      const aria = el.getAttribute && el.getAttribute('aria-label');
      if (aria && norm(aria)) return norm(aria);
      const labelledBy = el.getAttribute && el.getAttribute('aria-labelledby');
      if (labelledBy) {
        const doc = el.ownerDocument;
        const parts = String(labelledBy).split(/\\s+/).map((id) => {
          const node = doc && doc.getElementById ? doc.getElementById(id) : null;
          return node ? (node.innerText || node.textContent || '') : '';
        }).filter(Boolean);
        if (parts.length) return norm(parts.join(' '));
      }
      if (String(el.tagName || '').toUpperCase() === 'IMG') {
        const alt = el.getAttribute('alt');
        if (alt && norm(alt)) return norm(alt);
      }
      const tag = String(el.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        const doc = el.ownerDocument;
        if (el.id && doc && doc.querySelector) {
          let label = null;
          try { label = doc.querySelector('label[for="' + CSS.escape(el.id) + '"]'); } catch (err) { label = null; }
          const labelText = label ? norm(label.innerText || label.textContent || '') : '';
          if (labelText) return labelText;
        }
        const wrap = el.closest ? el.closest('label') : null;
        const wrapText = wrap ? norm(wrap.innerText || wrap.textContent || '') : '';
        if (wrapText) return wrapText;
        const placeholder = el.getAttribute('placeholder');
        if (placeholder && norm(placeholder)) return norm(placeholder);
      }
      return norm(el.innerText || el.textContent || '');
    };
    const selectorFor = (el) => {
      const tag = String(el.tagName || '').toLowerCase();
      if (!el.id) return tag;
      let id = el.id;
      try { if (window.CSS && CSS.escape) id = CSS.escape(el.id); } catch (err) { id = el.id; }
      return tag + '#' + id;
    };
    const nodes = document.querySelectorAll('a, button, input, select, textarea, summary, [role], [contenteditable], [aria-label]');
    const matches = [];
    for (const el of nodes) {
      if (!el.isConnected) continue;
      if (roleOf(el) !== wantedRole) continue;
      if (accName(el) !== wantedName) continue;
      matches.push(el);
      if (matches.length >= 3) break;
    }
    if (matches.length !== 1) {
      return JSON.stringify({ marker, count: matches.length, selector: '', selectorUnique: false, role: wantedRole, name: wantedName });
    }
    const selector = selectorFor(matches[0]);
    let selectorUnique = false;
    try { selectorUnique = document.querySelectorAll(selector).length === 1; } catch (err) { selectorUnique = false; }
    return JSON.stringify({
      marker,
      count: 1,
      selector: selectorUnique ? selector : '',
      selectorUnique,
      role: wantedRole,
      name: wantedName,
    });
  })()`;
}
export async function suggestStaleRefReplacement(cdp, sid, ref, refState, { contextId = null } = {}) {
  const identity = identityForStaleRef(ref, refState);
  if (!identity) return null;
  let raw = '';
  try {
    raw = await evalStr(cdp, sid, staleRefMatchExpression(identity.role, identity.name), false, {
      timeoutMs: REF_RESOLVE_TIMEOUT,
      ...(contextId !== null && contextId !== undefined ? { contextId } : {}),
    });
  } catch {
    return null;
  }
  let parsed = null;
  try { parsed = JSON.parse(String(raw || '')); } catch { return null; }
  if (!parsed || parsed.marker !== 'chrome-cdp-ex-stale-ref-match') return null;
  const selectorUnique = parsed.selectorUnique === true;
  const selector = selectorUnique ? String(parsed.selector || '').trim() : '';
  const safeSelector = selector && !selector.startsWith('@') && !/[\r\n]/.test(selector) ? selector : '';
  return {
    count: Number(parsed.count) || 0,
    selector: safeSelector,
    selectorUnique: Boolean(safeSelector),
    role: String(parsed.role || identity.role),
    name: String(parsed.name || identity.name),
  };
}
export async function staleRefError(cdp, sid, refMap, ref, refState, cause, { invalidate = true, contextId = null } = {}) {
  if (invalidate) invalidateRefMapping(refMap, ref, refState);
  const suggestion = await suggestStaleRefReplacement(cdp, sid, ref, refState, { contextId });
  const error = new Error(formatDomMutationStaleMessage(ref, suggestion), { cause });
  error.code = STALE_REF_ERROR_CODE;
  if (suggestion) error.staleRefMatch = suggestion;
  return error;
}
export function isStaleRefError(error) {
  return error?.code === STALE_REF_ERROR_CODE;
}
export function trustedRefConnectivityFunctionDeclaration() {
  return `function() {
    try {
      const nodePrototype = Node.prototype;
      const connectedGetter = Object.getOwnPropertyDescriptor(nodePrototype, 'isConnected')?.get;
      const ownerDocumentGetter = Object.getOwnPropertyDescriptor(nodePrototype, 'ownerDocument')?.get;
      const getRootNode = Object.getOwnPropertyDescriptor(nodePrototype, 'getRootNode')?.value;
      if (typeof connectedGetter !== 'function' || typeof ownerDocumentGetter !== 'function' || typeof getRootNode !== 'function') {
        return { error: 'trusted connectivity primitives unavailable' };
      }
      const connected = Reflect.apply(connectedGetter, this, []);
      const ownerDocument = Reflect.apply(ownerDocumentGetter, this, []);
      const composedRoot = Reflect.apply(getRootNode, this, [{ composed: true }]);
      return { connected: connected === true && ownerDocument != null && composedRoot === ownerDocument };
    } catch (error) {
      return { error: String(error && error.message || error || 'trusted connectivity probe failed') };
    }
  }`;
}
export function trustedRefPresenceFunctionDeclaration() {
  return `function() {
    try {
      const nodePrototype = Node.prototype;
      const elementPrototype = Element.prototype;
      const connectedGetter = Object.getOwnPropertyDescriptor(nodePrototype, 'isConnected')?.get;
      const ownerDocumentGetter = Object.getOwnPropertyDescriptor(nodePrototype, 'ownerDocument')?.get;
      const getRootNode = Object.getOwnPropertyDescriptor(nodePrototype, 'getRootNode')?.value;
      const getClientRects = Object.getOwnPropertyDescriptor(elementPrototype, 'getClientRects')?.value;
      if (typeof connectedGetter !== 'function' || typeof ownerDocumentGetter !== 'function'
        || typeof getRootNode !== 'function' || typeof getClientRects !== 'function') {
        return { error: 'trusted presence primitives unavailable' };
      }
      const connected = Reflect.apply(connectedGetter, this, []);
      const ownerDocument = Reflect.apply(ownerDocumentGetter, this, []);
      const composedRoot = Reflect.apply(getRootNode, this, [{ composed: true }]);
      if (connected !== true || ownerDocument == null || composedRoot !== ownerDocument) {
        return { connected: false, visible: false };
      }
      const rects = Reflect.apply(getClientRects, this, []);
      const style = getComputedStyle(this);
      const visible = rects.length > 0
        && style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.visibility !== 'collapse';
      return { connected: true, visible };
    } catch (error) {
      return { error: String(error && error.message || error || 'trusted presence probe failed') };
    }
  }`;
}
export async function rootFrameId(cdp, sid) {
  const result = await cdpDomains(cdp).Page.getFrameTree({}, sid, REF_RESOLVE_TIMEOUT);
  const frameId = result.frameTree?.frame?.id;
  if (!frameId) throw new Error('Page.getFrameTree did not return a root frame id');
  return frameId;
}
export async function createRefExecutionContext(cdp, sid, frameId) {
  if (!frameId) throw new Error('Ref frame id is unavailable');
  const result = await cdpDomains(cdp).Page.createIsolatedWorld({
    frameId,
    worldName: 'chrome-cdp-ex-ref-validation',
    grantUniveralAccess: false,
  }, sid, REF_RESOLVE_TIMEOUT);
  if (!Number.isSafeInteger(result.executionContextId)) {
    throw new Error('Page.createIsolatedWorld did not return an execution context id');
  }
  return result.executionContextId;
}
const resolvedNodeSessions = new WeakMap();

function rememberResolvedNodeSession(cdp, objectId, sessionId) {
  if (!cdp || objectId == null || !sessionId) return;
  let sessions = resolvedNodeSessions.get(cdp);
  if (!sessions) {
    sessions = new Map();
    resolvedNodeSessions.set(cdp, sessions);
  }
  sessions.set(objectId, sessionId);
}

// Object ids are session-scoped. A cross-site ref resolves in the child session,
// and later Runtime.callFunctionOn for that id has to use the same session.
export function resolvedNodeSession(cdp, fallbackSid, objectId) {
  if (objectId == null) return fallbackSid;
  return resolvedNodeSessions.get(cdp)?.get(objectId) || fallbackSid;
}

export async function resolveRefNode(cdp, sid, refMap, ref, refState, options = {}) {
  const frameParsed = parseFrameRef(ref);
  const allowCrossSite = options.allowCrossSite === true;
  let num = null;
  let backendNodeId;
  let frameId = null;
  let contentSid = sid;
  if (frameParsed) {
    const scoped = frameScopedBackendNode(refState || {}, frameParsed, { allowCrossSite });
    backendNodeId = scoped.backendNodeId;
    frameId = scoped.entry.frameId;
    if (allowCrossSite && crossSiteFrameProcess(scoped.entry, frameParsed.frameRef) === 'oopif') {
      contentSid = await ensureCrossSiteFrameSession(cdp, sid, scoped.entry);
    }
  } else {
    num = parseInt(ref.slice(1));
    if (isNaN(num) || !refMap.has(num)) {
      const state = refState || {};
      const reason = state.invalidationReason || (state.generation ? null : 'daemon-start');
      if (reason === 'dom-mutation') {
        throw await staleRefError(cdp, sid, refMap, ref, state, new Error('ref is not in the map'), { invalidate: false });
      }
      throw new Error(formatUnknownRefError(ref, state));
    }
    backendNodeId = refMap.get(num);
  }
  const executionContextId = await createRefExecutionContext(
    cdp,
    contentSid,
    frameId || await rootFrameId(cdp, contentSid),
  );
  let object;
  try {
    ({ object } = await cdpDomains(cdp).DOM.resolveNode({
      backendNodeId,
      executionContextId,
    }, contentSid, REF_RESOLVE_TIMEOUT));
  } catch (error) {
    if (isMissingDomNodeError(error)) {
      throw await staleRefError(cdp, sid, refMap, ref, refState, error, { contextId: executionContextId });
    }
    throw error;
  }
  if (!object?.objectId) throw new Error('DOM.resolveNode did not return an object id');
  rememberResolvedNodeSession(cdp, object.objectId, contentSid);
  const validation = await cdpDomains(cdp).Runtime.callFunctionOn({
    objectId: object.objectId,
    functionDeclaration: trustedRefConnectivityFunctionDeclaration(),
    returnByValue: true,
  }, contentSid, REF_RESOLVE_TIMEOUT);
  if (validation.exceptionDetails) {
    throw new Error(runtimeExceptionMessage(validation.exceptionDetails));
  }
  const validationValue = validation.result?.value;
  if (validationValue?.error) throw new Error(`Trusted ref connectivity probe failed: ${validationValue.error}`);
  const connected = validationValue === true || validationValue?.connected === true;
  if (!connected && (validationValue === false || validationValue?.connected === false)) {
    throw await staleRefError(
      cdp,
      sid,
      refMap,
      ref,
      refState,
      new Error('resolved backend node is detached from its owning document'),
      { contextId: executionContextId },
    );
  }
  if (!connected) throw new Error('Trusted ref connectivity probe returned no connectivity result');
  if (options.returnRealm === 'page') {
    let pageResult;
    try {
      pageResult = await cdpDomains(cdp).DOM.resolveNode({ backendNodeId }, contentSid, REF_RESOLVE_TIMEOUT);
    } catch (error) {
      if (isMissingDomNodeError(error)) {
        throw await staleRefError(cdp, sid, refMap, ref, refState, error, { contextId: executionContextId });
      }
      throw error;
    }
    if (!pageResult.object?.objectId) throw new Error('DOM.resolveNode did not return a page-world object id');
    rememberResolvedNodeSession(cdp, pageResult.object.objectId, contentSid);
    return pageResult.object.objectId;
  }
  return object.objectId;
}
// #437: page-side reads of where a link opens. The effective target is the link's own
// `target` attribute, else the first `<base target>` (HTML "get an element's target").
// `frameName` is the link's own window name: a target equal to it stays in this frame.
export function linkTargetPageExpression(el) {
  return `(${el}.tagName === 'A' ? String((${el}.getAttribute('target') ?? (${el}.ownerDocument || document).querySelector('base[target]')?.getAttribute('target')) || '') : null)`;
}
export function linkFrameNamePageExpression(el) {
  return `(${el}.tagName === 'A' ? String((${el}.ownerDocument || document).defaultView?.name || '') : '')`;
}
// #436: page-side hit test of a click point. `this` is the click target; `rect` is its settled
// viewport rect in the target's own document (frame-local for @f refs). Returns null when the point
// cannot be tested (zero size, outside the viewport, nothing hit), { covered: false } when the real
// mouse event would reach the target, otherwise what is on top. elementFromPoint already skips
// pointer-events:none layers. Open shadow roots are walked to the deepest element; a closed one
// stops at its host, which then counts as an ancestor of the target.
export function clickPointHitFunctionSource() {
  return `function clickPointHit(target, rect, clip = null) {
    if (!target || target.nodeType !== 1) return null;
    const doc = target.ownerDocument;
    if (!doc || typeof doc.elementFromPoint !== 'function') return null;
    if (!(rect.w > 0 && rect.h > 0)) return null;
    const x = rect.x + rect.w / 2;
    const y = rect.y + rect.h / 2;
    if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return null;
    let top = doc.elementFromPoint(x, y);
    for (let depth = 0; top && top.shadowRoot && depth < 32; depth++) {
      const inner = top.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === top) break;
      top = inner;
    }
    if (!top) return null;
    // #551: a point outside the target's clip-visible rect (a scroll container cuts it off) does not
    // reach the target, even when an ancestor such as the container's <dialog> is what is there.
    const clipped = Boolean(clip) && (x < clip.left || y < clip.top || x >= clip.right || y >= clip.bottom);
    const composedParent = node => {
      const parent = node.parentNode;
      return parent && parent.nodeType === 11 && parent.host ? parent.host : parent;
    };
    const composedContains = (outer, inner) => {
      for (let node = inner, guard = 0; node && guard < 4096; node = composedParent(node), guard++) {
        if (node === outer) return true;
      }
      return false;
    };
    // The target, something inside it, or an ancestor (the target itself is not hit-testable,
    // e.g. pointer-events:none) receives the same event a user's click there would send.
    // The target or something inside it is at the point: the browser itself says the click reaches it.
    if (composedContains(target, top)) return { covered: false };
    if (!clipped && composedContains(top, target)) return { covered: false };
    const label = typeof top.closest === 'function' ? top.closest('label') : null;
    if (!clipped && label && label.control === target) return { covered: false };
    const positionOf = node => {
      try { return getComputedStyle(node).position || ''; } catch { return ''; }
    };
    const describe = (node, withText) => {
      const tag = String(node.tagName || 'node').toUpperCase();
      const id = node.id ? '#' + node.id : '';
      const classes = !id && typeof node.className === 'string' && node.className.trim()
        ? '.' + node.className.trim().split(/\\s+/).slice(0, 2).join('.')
        : '';
      const text = withText
        ? String((node.getAttribute && node.getAttribute('aria-label')) || node.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40)
        : '';
      return '<' + tag + id + classes + '>' + (text ? ' "' + text + '"' : '');
    };
    // Only on the failure path: the nearest fixed/sticky layer and whether a dialog is on top.
    // #601 / #629: that layer is the first fixed/sticky ancestor of the hit that does not contain
    // the click target and can receive hits (pointer-events is not none). The target's own app
    // shell and a pointer-events:none wrapper are not the cover, so they are not reported.
    const dialogSelector = 'dialog,[role="dialog"],[role="alertdialog"],[aria-modal="true"]';
    let layer = null;
    let dialog = false;
    let largeCover = null;
    for (let node = top, guard = 0; node && node.nodeType === 1 && guard < 64; node = composedParent(node), guard++) {
      const position = positionOf(node);
      if ((position === 'fixed' || position === 'sticky') && !composedContains(node, target)) {
        let pointerEvents = '';
        try { pointerEvents = getComputedStyle(node).pointerEvents || ''; } catch { pointerEvents = ''; }
        if (pointerEvents !== 'none') {
          if (!layer) layer = { node, position };
          if (!largeCover) largeCover = node;
        }
      }
      if (!dialog && typeof node.matches === 'function' && node.matches(dialogSelector)) dialog = true;
    }
    // More than half the viewport is a blocker the user cannot click past. A header, sidebar, toast,
    // or bottom strip stays under that and keeps the JS-click recovery.
    const coverBox = node => {
      const r = node.getBoundingClientRect();
      const boxX = Number(r.x != null ? r.x : r.left) || 0;
      const boxY = Number(r.y != null ? r.y : r.top) || 0;
      const boxW = Number(r.width != null ? r.width : (Number(r.right) - Number(r.left))) || 0;
      const boxH = Number(r.height != null ? r.height : (Number(r.bottom) - Number(r.top))) || 0;
      return { x: boxX, y: boxY, w: boxW, h: boxH };
    };
    let large = false;
    if (largeCover && typeof largeCover.getBoundingClientRect === 'function') {
      const box = coverBox(largeCover);
      const vw = Number(window.innerWidth) || 0;
      const vh = Number(window.innerHeight) || 0;
      if (vw > 0 && vh > 0 && box.w > 0 && box.h > 0) {
        const left = Math.max(box.x, 0);
        const topEdge = Math.max(box.y, 0);
        const right = Math.min(box.x + box.w, vw);
        const bottom = Math.min(box.y + box.h, vh);
        const area = Math.max(0, right - left) * Math.max(0, bottom - topEdge);
        large = area > vw * vh * 0.5;
      }
    }
    return {
      covered: true,
      x: Math.round(x),
      y: Math.round(y),
      by: describe(top, true),
      byPosition: positionOf(top),
      within: layer && layer.node !== top ? describe(layer.node, false) : null,
      withinPosition: layer ? layer.position : null,
      // A clipped target's own container (an ancestor at the point) is not a dialog to dismiss.
      dialog: clipped && composedContains(top, target) ? false : dialog,
      ...(clipped ? { clipped: true } : {}),
      ...(large ? { large: true } : {}),
    };
  }`;
}
// #614: a zero-size border box (a closed dialog) and a box whose centre is outside the
// viewport are not clickable. A descendant client rect or an associated label can still
// be. The returned x/y are the border-box origin so callers keep using x + w/2.
export function clickableBoxHelpersSource() {
  return `function clickBoxUsable(rect) {
    if (!rect) return null;
    const w = Number(rect.w != null ? rect.w : rect.width);
    const h = Number(rect.h != null ? rect.h : rect.height);
    const x = Number(rect.x != null ? rect.x : rect.left);
    const y = Number(rect.y != null ? rect.y : rect.top);
    if (!(w > 0) || !(h > 0) || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    const cx = x + w / 2;
    const cy = y + h / 2;
    const view = typeof window !== 'undefined' ? window : {};
    const vw = Number(view.innerWidth);
    const vh = Number(view.innerHeight);
    if (!(vw > 0) || !(vh > 0)) return null;
    if (cx < 0 || cy < 0 || cx >= vw || cy >= vh) return null;
    return { x: x, y: y, w: w, h: h };
  }
  function firstUsableClientBox(node) {
    if (!node) return null;
    if (typeof node.getClientRects === 'function') {
      let rects = [];
      try { rects = node.getClientRects() || []; } catch (err) { rects = []; }
      const count = Number(rects.length) || 0;
      for (let i = 0; i < count; i++) {
        const box = clickBoxUsable(rects[i]);
        if (box) return box;
      }
    }
    if (typeof node.getBoundingClientRect === 'function') {
      try { return clickBoxUsable(node.getBoundingClientRect()); } catch (err) { return null; }
    }
    return null;
  }
  function resolveClickableBox(el, own) {
    const self = clickBoxUsable(own) || firstUsableClientBox(el);
    if (self) return { x: self.x, y: self.y, w: self.w, h: self.h, source: 'self', noClickBox: false, inViewport: true };
    const candidates = [];
    try {
      if (el && typeof el.querySelectorAll === 'function') {
        const found = el.querySelectorAll('*');
        const count = Number(found && found.length) || 0;
        for (let i = 0; i < count; i++) candidates.push(found[i]);
      }
    } catch (err) {}
    const labels = el && el.labels;
    if (labels && typeof labels.length === 'number') {
      for (let i = 0; i < labels.length; i++) candidates.push(labels[i]);
    }
    for (let i = 0; i < candidates.length; i++) {
      const node = candidates[i];
      if (!node || node === el) continue;
      const box = firstUsableClientBox(node);
      if (box) return { x: box.x, y: box.y, w: box.w, h: box.h, source: 'content', noClickBox: false, inViewport: true };
    }
    const w = Number(own && (own.w != null ? own.w : own.width));
    const h = Number(own && (own.h != null ? own.h : own.height));
    const x = Number(own && (own.x != null ? own.x : own.left));
    const y = Number(own && (own.y != null ? own.y : own.top));
    return {
      x: Number.isFinite(x) ? x : 0,
      y: Number.isFinite(y) ? y : 0,
      w: Number.isFinite(w) ? w : 0,
      h: Number.isFinite(h) ? h : 0,
      source: 'none',
      noClickBox: true,
      inViewport: false,
    };
  }`;
}
// `hitTest` folds the #436 click-point hit test into the same evaluation (no extra round trip).
// A fully visible target that is covered (sticky header, toast) is centred once and re-tested;
// whatever still covers it after that is reported, never retried.
export function scrollSettledRectFunctionDeclaration({ hitTest = false } = {}) {
  return `async function() {
    const connectedToOwningDocument = () => {
      try {
        const nodePrototype = Node.prototype;
        const connectedGetter = Object.getOwnPropertyDescriptor(nodePrototype, 'isConnected')?.get;
        const ownerDocumentGetter = Object.getOwnPropertyDescriptor(nodePrototype, 'ownerDocument')?.get;
        const getRootNode = Object.getOwnPropertyDescriptor(nodePrototype, 'getRootNode')?.value;
        if (typeof connectedGetter !== 'function' || typeof ownerDocumentGetter !== 'function' || typeof getRootNode !== 'function') return false;
        const connected = Reflect.apply(connectedGetter, this, []);
        const ownerDocument = Reflect.apply(ownerDocumentGetter, this, []);
        const composedRoot = Reflect.apply(getRootNode, this, [{ composed: true }]);
        return connected === true && ownerDocument != null && composedRoot === ownerDocument;
      } catch {
        return false;
      }
    };
    if (!connectedToOwningDocument()) return { connected: false };
    const readRect = () => {
      const rect = this.getBoundingClientRect();
      return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
    };
    // #551: an ancestor that clips its overflow can hide the click point of a target that is inside
    // the viewport. Walk the containing-block chain: a fixed element escapes every ancestor, and an
    // absolute one escapes ancestors that are not positioned. html and body propagate their overflow
    // to the viewport, so they never clip here.
    const ownerDoc = this.ownerDocument;
    const docElement = ownerDoc ? ownerDoc.documentElement : null;
    const docBody = ownerDoc ? ownerDoc.body : null;
    const styleOf = node => { try { return getComputedStyle(node); } catch { return null; } };
    const escapeMode = position => (position === 'fixed' || position === 'absolute' ? position : 'flow');
    const clippingAncestors = [];
    // body's overflow reaches the viewport only while html's is visible on both axes.
    const htmlStyle = docElement ? styleOf(docElement) : null;
    const bodyPropagates = !htmlStyle
      || (String(htmlStyle.overflowX || 'visible') === 'visible' && String(htmlStyle.overflowY || 'visible') === 'visible');
    // transform, filter and contain make an element the containing block of fixed/absolute children.
    const containsOutOfFlow = style => Boolean(style) && (
      (style.transform && style.transform !== 'none')
      || (style.filter && style.filter !== 'none')
      || /paint|layout|strict|content/.test(String(style.contain || '')));
    let mode = escapeMode(String(styleOf(this)?.position || 'static'));
    // Slotted content is clipped by the shadow tree it is rendered in: follow assignedSlot first.
    const nextUp = node => node.assignedSlot || node.parentNode;
    for (let node = nextUp(this), guard = 0; node && mode !== 'fixed' && guard < 4096; guard++) {
      if (node.nodeType === 11 && node.host) { node = node.host; continue; }
      if (node.nodeType !== 1) break;
      const style = styleOf(node);
      const position = String(style?.position || 'static');
      const containingBlock = mode === 'flow' || position !== 'static' || containsOutOfFlow(style);
      const display = String(style?.display || '');
      const propagates = node === docElement || (node === docBody && bodyPropagates);
      // overflow does not apply to display:contents or inline boxes.
      if (containingBlock && !propagates && style && display !== 'contents' && display !== 'inline') {
        const clipX = String(style.overflowX || 'visible') !== 'visible';
        const clipY = String(style.overflowY || 'visible') !== 'visible';
        if (clipX || clipY) clippingAncestors.push({ node, clipX, clipY });
      }
      if (containingBlock) mode = containsOutOfFlow(style) && position === 'static' ? 'flow' : escapeMode(position);
      node = nextUp(node);
    }
    // Overflow clips at the padding box, inside borders and scrollbars.
    const clipBox = () => {
      const box = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
      for (const { node, clipX, clipY } of clippingAncestors) {
        const r = node.getBoundingClientRect();
        const left = r.x + (Number(node.clientLeft) || 0);
        const top = r.y + (Number(node.clientTop) || 0);
        const width = Number(node.clientWidth) > 0 ? Number(node.clientWidth) : r.width;
        const height = Number(node.clientHeight) > 0 ? Number(node.clientHeight) : r.height;
        if (clipX) { box.left = Math.max(box.left, left); box.right = Math.min(box.right, left + width); }
        if (clipY) { box.top = Math.max(box.top, top); box.bottom = Math.min(box.bottom, top + height); }
      }
      return box;
    };
    // Visible: the whole rect is in the viewport (as before), and the click point is inside every
    // clipping ancestor. A target larger than its clipping parent passes when its centre shows.
    const insideClip = rect => {
      if (!(rect.x >= 0 && rect.y >= 0 && rect.x + rect.w <= window.innerWidth && rect.y + rect.h <= window.innerHeight)) return false;
      if (!clippingAncestors.length) return true;
      const box = clipBox();
      const cx = rect.x + rect.w / 2;
      const cy = rect.y + rect.h / 2;
      return cx >= box.left && cy >= box.top && cx < box.right && cy < box.bottom;
    };
    const initial = readRect();
    const fullyVisible = insideClip(initial);
    if (!fullyVisible) this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    // One budget for every settle pass (including the hit-test re-centre), kept below the
    // caller's REF_RESOLVE_TIMEOUT so the CDP call returns instead of timing out (#464).
    const settleDeadline = Date.now() + ${REF_SETTLE_BUDGET_MS};
    const settle = async (maxSamples) => {
      const deadline = settleDeadline;
      let previous = readRect();
      let stableSamples = 0;
      for (let sample = 0; sample < maxSamples; sample++) {
        if (Date.now() >= deadline) break;
        await Promise.race([
          new Promise(resolve => {
            if (typeof requestAnimationFrame === 'function') requestAnimationFrame(resolve);
            else resolve();
          }),
          new Promise(resolve => setTimeout(resolve, 50)),
        ]);
        const current = readRect();
        const movement = Math.max(
          Math.abs(current.x - previous.x),
          Math.abs(current.y - previous.y),
          Math.abs(current.w - previous.w),
          Math.abs(current.h - previous.h),
        );
        const currentVisible = insideClip(current);
        previous = current;
        stableSamples = movement < 0.5 ? stableSamples + 1 : 0;
        if (currentVisible && stableSamples >= 2) break;
      }
      return previous;
    };
    const maxSamples = fullyVisible ? 2 : 60;
    let previous = await settle(maxSamples);
    ${clickableBoxHelpersSource()}
    const resolvedClickBox = resolveClickableBox(this, previous);
    const noClickBox = resolvedClickBox.noClickBox === true;
    if (!noClickBox) previous = { x: resolvedClickBox.x, y: resolvedClickBox.y, w: resolvedClickBox.w, h: resolvedClickBox.h };${hitTest ? `
    ${clickPointHitFunctionSource()}
    ${actionabilityFunctionSource()}
    let hit = clickPointHit(this, previous, clipBox());
    if (hit && hit.covered && fullyVisible) {
      this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      previous = await settle(60);
      const recentredBox = resolveClickableBox(this, previous);
      if (!recentredBox.noClickBox) previous = { x: recentredBox.x, y: recentredBox.y, w: recentredBox.w, h: recentredBox.h };
      hit = clickPointHit(this, previous, clipBox());
      if (hit && hit.covered) hit.recentred = true;
    }` : ''}
    return {
      connected: connectedToOwningDocument(),
      ...previous,
      noClickBox: noClickBox,
      inViewport: !noClickBox,
      tag: this.tagName,
      href: this.tagName === 'A' ? (this.href || null) : null,
      linkTarget: ${linkTargetPageExpression('this')},
      frameName: ${linkFrameNamePageExpression('this')},
      pageHref: location.href,
      downloadAttr: this.tagName === 'A' && typeof this.hasAttribute === 'function' && this.hasAttribute('download'),
      text: ${targetLabelExpression('this')},
      role: (typeof this.getAttribute === 'function' ? this.getAttribute('role') : '') || '',${hitTest ? `
      hit,
      disabled: actionDisabledReason(this),` : ''}
    };
  }`;
}
export async function resolveRef(cdp, sid, refMap, ref, refState, { hitTest = false, allowCrossSite = false } = {}) {
  const frameParsed = parseFrameRef(ref);
  const objectId = await resolveRefNode(cdp, sid, refMap, ref, refState, { allowCrossSite });
  const nodeSid = resolvedNodeSession(cdp, sid, objectId);
  let result;
  try {
    result = await cdpDomains(cdp).Runtime.callFunctionOn( {
      objectId,
      functionDeclaration: scrollSettledRectFunctionDeclaration({ hitTest }),
      returnByValue: true,
      awaitPromise: true,
    }, nodeSid, REF_RESOLVE_TIMEOUT);
  } catch (error) {
    if (isTimeoutError(error, ['Runtime.callFunctionOn'])) {
      // resolveRefRectNoScroll returns { rect, objectId }; callers of resolveRef read the
      // rect fields directly, so unwrap it (#464: x/y were undefined → NaN click point).
      // Leave the rect in the frame. placeFrameRect below is the one page-layer
      // cover check, and it has to run after the child probe so a page cover wins.
      const resolved = await resolveRefRectNoScroll(cdp, sid, refMap, ref, refState, {
        objectId,
        allowCrossSite,
        offsetFrame: false,
      });
      const value = { ...resolved.rect, connected: true, settled: false };
      if (hitTest) {
        // No settle happened, so check the point now: a covered target still fails as
        // covered instead of clicking whatever sits there.
        const probe = await resolveRefRectNoScroll(cdp, sid, refMap, ref, refState, {
          objectId,
          allowCrossSite,
          functionDeclaration: `function() {
            ${clickPointHitFunctionSource()}
            ${actionabilityFunctionSource()}
            const box = this.getBoundingClientRect();
            return {
              hit: clickPointHit(this, { x: box.x, y: box.y, w: box.width, h: box.height }),
              disabled: actionDisabledReason(this),
            };
          }`,
        });
        // #468: the disabled check must not be skipped when the settle timed out.
        value.hit = probe?.hit && typeof probe.hit === 'object' ? probe.hit : null;
        value.disabled = typeof probe?.disabled === 'string' ? probe.disabled : '';
      }
      if (frameParsed) {
        await placeFrameRect(cdp, sid, refState, frameParsed, value, { allowCrossSite, hitTest });
      }
      return value;
    }
    throw error;
  }
  const value = result.result.value || {};
  if (value.connected !== true) {
    throw await staleRefError(
      cdp,
      sid,
      refMap,
      ref,
      refState,
      new Error('resolved backend node is detached from its owning document'),
    );
  }
  if (frameParsed) {
    await placeFrameRect(cdp, sid, refState, frameParsed, value, { allowCrossSite, settle: true, hitTest });
  }
  return value;
}
export function isRef(s) { return /^@\d+$/.test(s) || /^@f\d+:\d+$/.test(s); }
export function isCursorRef(s) { return /^@c\d+$/.test(String(s || '')); }
export function resolveCursorRef(refMap, ref, refState) {
  const key = String(ref || '').slice(1);
  const entry = refMap.get(key);
  if (!entry) {
    throw new Error(`Unknown cursor ref: ${ref}. Run "perceive -C -d 8" to refresh cursor refs, or use a stable CSS selector.${refState?.invalidationReason ? ` Ref state: ${refState.invalidationReason}.` : ''}`);
  }
  const x = Number(entry.x);
  const y = Number(entry.y);
  const w = Number(entry.w);
  const h = Number(entry.h);
  if (![x, y, w, h].every(Number.isFinite)) {
    throw new Error(`Invalid cursor ref: ${ref}. Run "perceive -C -d 8" to refresh cursor refs, or use a stable CSS selector.`);
  }
  return {
    x,
    y,
    w,
    h,
    sel: entry.sel || 'cursor-ref',
    text: String(entry.text || '').trim().substring(0, 80),
  };
}
export function parseFrameOnlyRef(s) {
  const m = String(s || '').match(/^@f(\d+)$/);
  if (!m) return null;
  const frameIndex = Number(m[1]);
  if (!Number.isSafeInteger(frameIndex) || frameIndex < 1) return null;
  return { frameRef: `@f${frameIndex}`, frameIndex };
}
export function parseFrameRef(s) {
  const m = String(s || '').match(/^@f(\d+):(\d+)$/);
  if (!m) return null;
  const frameIndex = Number(m[1]);
  const refIndex = Number(m[2]);
  if (!Number.isSafeInteger(frameIndex) || frameIndex < 1 || !Number.isSafeInteger(refIndex) || refIndex < 1) return null;
  return {
    frameRef: `@f${frameIndex}`,
    frameIndex,
    ref: `@${refIndex}`,
    refIndex,
  };
}
export function flattenFrameTree(frameTree, { startIndex = 1 } = {}) {
  const frames = [];
  function visit(node, depth = 0, parentRef = null) {
    if (!node?.frame) return;
    const ref = `@f${startIndex + frames.length}`;
    const frame = node.frame;
    frames.push({
      ref,
      index: startIndex + frames.length,
      id: frame.id || '',
      parentId: frame.parentId || null,
      parentRef,
      depth,
      name: frame.name || '',
      url: frame.url || '',
      securityOrigin: frame.securityOrigin || '',
      unreachableUrl: frame.unreachableUrl || '',
      mimeType: frame.mimeType || '',
    });
    for (const child of node.childFrames || []) visit(child, depth + 1, ref);
  }
  visit(frameTree);
  return frames;
}
export function formatFrameTreeText(frames = []) {
  const lines = [`Frames: ${frames.length}`];
  if (frames.length === 0) {
    lines.push('No frames reported by Page.getFrameTree.');
    return lines.join('\n');
  }
  const blocks = [];
  let nonce = '';
  for (const frame of frames) {
    const indent = '  '.repeat(Math.min(frame.depth || 0, 8));
    const crossSite = frame.process === 'oopif';
    const label = crossSite ? '(anonymous)' : (frame.name || '(anonymous)');
    const parent = frame.parentRef ? ` parent:${frame.parentRef}` : '';
    const origin = frame.securityOrigin ? ` origin:${frame.securityOrigin}` : '';
    const url = frame.url || frame.unreachableUrl || '(no url)';
    const process = crossSite ? ' process:oopif' : '';
    lines.push(`${indent}${frame.ref} ${label} ${frame.id}${parent} ${url}${origin}${process}`);
    const name = String(frame.name || '');
    if (crossSite && name.trim()) {
      if (!nonce) nonce = createFrameContentNonce();
      blocks.push(wrapFrameContent(name, { nonce, origin: frameContentOrigin(frame.securityOrigin) }));
    }
  }
  if (blocks.length) lines.push(...blocks);
  lines.push('Hint: use frame refs to diagnose wrong-frame errors; element refs inside frames will use @fN:M syntax.');
  return lines.join('\n');
}
// Cross-site (out-of-process) iframes are not in the page session's
// Page.getFrameTree. The first `frame` command, or a cross-site @fN, attaches
// iframe targets once per document and appends those frames after the
// same-origin numbers. A cross-site frame can embed a third site in its own
// process. That grandchild is not in the child session's frame tree, and
// auto-attach reaches only the targets directly related to the session that
// called it. The same lazy auto-attach runs on each attached iframe session.
// Those frames are read after the sessions already known, so they are appended
// after the other cross-site frames and existing @fN numbers stay put.
// 50 extra frames and depth 8 bound the child walk.
const OOPIF_MAX_EXTRA = 50;
const OOPIF_MAX_DEPTH = 8;
const oopifClients = new WeakMap();

function oopifAutoAttachParams() {
  return {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
    filter: [{ type: 'iframe' }],
  };
}

function oopifDocument(cdp, sid) {
  let docs = oopifClients.get(cdp);
  if (!docs) {
    docs = new Map();
    oopifClients.set(cdp, docs);
  }
  let doc = docs.get(sid);
  if (!doc) {
    doc = {
      attached: false,
      children: [],
      frames: new Map(),
      byTarget: new Map(),
      autoAttached: new Set(),
      hostedBy: new Map(),
    };
    docs.set(sid, doc);
    watchOopifDocument(cdp, sid, doc);
  }
  return doc;
}

function rememberOopifSession(doc, sessionId, targetId, hostSessionId) {
  if (!sessionId) return;
  if (!doc.children.includes(sessionId)) doc.children.push(sessionId);
  if (targetId) doc.byTarget.set(targetId, sessionId);
  if (hostSessionId) doc.hostedBy.set(sessionId, hostSessionId);
}

function descendantOopifSessions(doc, sessionId) {
  const out = [];
  const pending = [sessionId];
  const seen = new Set();
  while (pending.length) {
    const host = pending.pop();
    for (const [child, parent] of doc.hostedBy) {
      if (parent !== host || seen.has(child)) continue;
      seen.add(child);
      out.push(child);
      pending.push(child);
    }
  }
  return out;
}

function forgetOopifSession(doc, sessionId) {
  doc.children = doc.children.filter(id => id !== sessionId);
  doc.autoAttached.delete(sessionId);
  for (const [targetId, mapped] of doc.byTarget) {
    if (mapped === sessionId) doc.byTarget.delete(targetId);
  }
  for (const [frameId, mapped] of doc.frames) {
    if (mapped === sessionId) doc.frames.delete(frameId);
  }
  doc.hostedBy.delete(sessionId);
}

function dropOopifSession(doc, sessionId) {
  for (const child of descendantOopifSessions(doc, sessionId)) forgetOopifSession(doc, child);
  forgetOopifSession(doc, sessionId);
}

function eventHostSession(msg, sid) {
  return msg?.sessionId || sid;
}

function watchOopifDocument(cdp, sid, doc) {
  if (typeof cdp.onEvent !== 'function') return;
  const forThisPage = msg => !msg?.sessionId || msg.sessionId === sid;
  const forThisDocument = msg => {
    const host = eventHostSession(msg, sid);
    return host === sid || doc.children.includes(host);
  };
  cdp.onEvent('Target.attachedToTarget', (params, msg) => {
    if (!forThisDocument(msg)) return;
    const child = params?.sessionId;
    if (!child || child === sid || params?.targetInfo?.type !== 'iframe') return;
    rememberOopifSession(doc, child, params?.targetInfo?.targetId || '', eventHostSession(msg, sid));
  });
  cdp.onEvent('Target.detachedFromTarget', (params, msg) => {
    if (!forThisDocument(msg)) return;
    const child = params?.sessionId;
    if (!child || child === sid || !doc.children.includes(child)) return;
    dropOopifSession(doc, child);
    doc.attached = false;
  });
  cdp.onEvent('Page.frameNavigated', (params, msg) => {
    if (!forThisPage(msg) || params?.frame?.parentId) return;
    // The previous document's iframe sessions are not this document's. Drop them
    // here; a later attachedToTarget, or Target.getTargets on the next list, finds
    // the iframes that belong to the new document.
    doc.children = [];
    doc.frames.clear();
    doc.byTarget.clear();
    doc.autoAttached.clear();
    doc.hostedBy.clear();
    doc.attached = false;
  });
}

function iframeTargetParentId(info) {
  if (!info || info.type !== 'iframe' || !info.targetId) return '';
  return info.parentId || info.parentFrameId || info.openerId || '';
}

function frameIdsInTree(node, ids = new Set()) {
  if (!node?.frame) return ids;
  if (node.frame.id) ids.add(node.frame.id);
  for (const child of node.childFrames || []) frameIdsInTree(child, ids);
  return ids;
}

// setAutoAttach does not send attachedToTarget again for an iframe this client
// already attached. After navigation clears the cache, ask for iframe targets
// whose parent frame is in this session and attach any we no longer have.
async function adoptPageIframeTargets(cdp, sid, doc, parentIds) {
  if (!(parentIds instanceof Set) || parentIds.size === 0 || doc.children.length >= OOPIF_MAX_EXTRA) return;
  let infos = [];
  try {
    const result = await cdpDomains(cdp).Target.getTargets({ filter: [{ type: 'iframe' }] }, sid);
    infos = Array.isArray(result?.targetInfos) ? result.targetInfos : [];
  } catch {
    return;
  }
  for (const info of infos) {
    if (doc.children.length >= OOPIF_MAX_EXTRA) break;
    if (!parentIds.has(iframeTargetParentId(info)) || doc.byTarget.has(info.targetId)) continue;
    try {
      const attached = await cdpDomains(cdp).Target.attachToTarget({
        targetId: info.targetId,
        flatten: true,
      }, sid);
      const child = attached?.sessionId;
      if (!child || doc.byTarget.has(info.targetId)) continue;
      rememberOopifSession(doc, child, info.targetId, sid);
    } catch {
      // The target left, or this client is already attached and the event kept the session.
    }
  }
}

// Known iframe sessions are read before the next level is attached, so a
// third-site frame is appended after the cross-site frames already listed.
async function attachChildOopifSessions(cdp, doc, childSid, frameTree) {
  if (!childSid || !frameTree || doc.autoAttached.has(childSid) || doc.autoAttached.size >= OOPIF_MAX_EXTRA) return;
  try {
    await cdpDomains(cdp).Target.setAutoAttach(oopifAutoAttachParams(), childSid);
  } catch {
    return;
  }
  doc.autoAttached.add(childSid);
  await adoptPageIframeTargets(cdp, childSid, doc, frameIdsInTree(frameTree));
}

function appendCrossSiteFrames(sameOriginFrames, childTrees, { maxExtra = OOPIF_MAX_EXTRA, maxDepth = OOPIF_MAX_DEPTH } = {}) {
  const frames = sameOriginFrames.map(frame => ({ ...frame }));
  const byId = new Map();
  for (const frame of frames) if (frame.id) byId.set(frame.id, frame);
  const extras = [];
  const sessionByFrame = new Map();
  const pending = [];
  function visit(node, sessionId) {
    if (!node?.frame || extras.length >= maxExtra) return;
    const raw = node.frame;
    const id = raw.id || '';
    if (id && byId.has(id)) {
      for (const child of node.childFrames || []) visit(child, sessionId);
      return;
    }
    const parent = raw.parentId ? byId.get(raw.parentId) : null;
    if (raw.parentId && !parent) {
      pending.push({ node, sessionId });
      return;
    }
    const depth = parent ? parent.depth + 1 : 1;
    if (depth > maxDepth) return;
    const index = frames.length + extras.length + 1;
    const entry = {
      ref: `@f${index}`,
      index,
      id,
      parentId: raw.parentId || null,
      parentRef: parent ? parent.ref : null,
      depth,
      name: raw.name || '',
      url: raw.url || '',
      securityOrigin: raw.securityOrigin || '',
      unreachableUrl: raw.unreachableUrl || '',
      mimeType: raw.mimeType || '',
      process: 'oopif',
    };
    extras.push(entry);
    if (id) {
      byId.set(id, entry);
      sessionByFrame.set(id, sessionId);
    }
    for (const child of node.childFrames || []) visit(child, sessionId);
  }
  for (const tree of childTrees) {
    if (extras.length >= maxExtra) break;
    visit(tree?.frameTree, tree?.sessionId);
  }
  for (let pass = 0; pass < maxDepth && pending.length && extras.length < maxExtra; pass += 1) {
    const batch = pending.splice(0, pending.length);
    for (const item of batch) {
      if (extras.length >= maxExtra) break;
      visit(item.node, item.sessionId);
    }
  }
  return { frames: frames.concat(extras), sessionByFrame };
}

async function loadCrossSiteFrames(cdp, sid, sameOriginFrames) {
  const doc = oopifDocument(cdp, sid);
  if (!doc.attached) {
    await cdpDomains(cdp).Target.setAutoAttach(oopifAutoAttachParams(), sid);
    const rootId = sameOriginFrames.find(frame => frame && frame.depth === 0)?.id || '';
    await adoptPageIframeTargets(cdp, sid, doc, rootId ? new Set([rootId]) : new Set());
    doc.attached = true;
  }
  const trees = [];
  const seen = new Set();
  let wave = doc.children.filter(id => id && !seen.has(id));
  while (wave.length && trees.length < OOPIF_MAX_EXTRA) {
    const next = [];
    for (const childSid of wave) {
      if (!childSid || seen.has(childSid) || trees.length >= OOPIF_MAX_EXTRA) continue;
      seen.add(childSid);
      let frameTree = null;
      try {
        const result = await cdpDomains(cdp).Page.getFrameTree({}, childSid);
        frameTree = result?.frameTree || null;
      } catch {
        // A detached child no longer answers. detachedFromTarget drops the session.
        frameTree = null;
      }
      if (frameTree) trees.push({ sessionId: childSid, frameTree });
      await attachChildOopifSessions(cdp, doc, childSid, frameTree);
      for (const id of doc.children) {
        if (id && !seen.has(id) && !next.includes(id)) next.push(id);
      }
    }
    wave = next;
  }
  const merged = appendCrossSiteFrames(sameOriginFrames, trees);
  doc.frames = merged.sessionByFrame;
  rememberListedFrames(cdp, sid, merged.frames);
  return merged.frames;
}

function crossSiteFrameSession(cdp, sid, frameId) {
  if (!frameId) return null;
  return oopifDocument(cdp, sid).frames.get(frameId) || null;
}

export async function framesModel(cdp, sid, { crossSite = false } = {}) {
  const result = await cdpDomains(cdp).Page.getFrameTree( {}, sid);
  const frames = flattenFrameTree(result.frameTree);
  const listed = crossSite ? await loadCrossSiteFrames(cdp, sid, frames) : frames;
  return {
    schema: 'chrome-cdp-ex.frames.v1',
    frameCount: listed.length,
    frames: listed,
  };
}
const PERCEIVE_FRAME_ELEMENT_CAP = 50;
const PERCEIVE_FRAME_OWNER_MARKER = 'chrome-cdp-ex.frame-owner.v1';
const PERCEIVE_FRAME_OWNER_FN = `function() {
  const el = this;
  const title = el.getAttribute ? (el.getAttribute('title') || '') : '';
  const src = el.src || '';
  let host = '';
  try { if (src) host = new URL(src).host; } catch {}
  let visible = false;
  try {
    const rects = typeof el.getClientRects === 'function' ? el.getClientRects() : [];
    visible = rects.length > 0;
    if (visible && typeof el.checkVisibility === 'function') visible = !!el.checkVisibility({ visibilityProperty: true });
    const rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
    if (!rect || !(rect.width >= 1) || !(rect.height >= 1)) visible = false;
  } catch {}
  return { marker: '${PERCEIVE_FRAME_OWNER_MARKER}', title: String(title).trim(), src: String(src), host, visible };
}`;
function frameUrlHost(url) {
  try {
    return new URL(String(url || '')).host || '';
  } catch {
    return '';
  }
}
function frameUrlsEqual(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  if (!left || !right) return false;
  if (left === right) return true;
  try {
    return new URL(left).href === new URL(right).href;
  } catch {
    return false;
  }
}
// Schemeful site is scheme + registrable host. An IP or localhost is its own
// site; other hosts use the last two labels, or the last three when the tail
// is a multi-label public suffix. Port is not part of the site. about:blank,
// about:srcdoc, and an empty src are not another site.
const MULTI_LABEL_PUBLIC_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'co.jp', 'com.au', 'net.au', 'org.au',
  'co.nz', 'com.br', 'co.kr', 'com.hk', 'com.sg', 'com.tr', 'co.za', 'com.mx',
  'co.in', 'com.tw', 'com.cn', 'com.ar',
]);
function registrableHost(hostname) {
  const host = String(hostname || '').replace(/\.+$/, '').toLowerCase();
  if (!host) return '';
  if (host === 'localhost' || host.endsWith('.localhost')) return host;
  if (host.startsWith('[') || host.includes(':')) return host;
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host)) return host;
  const labels = host.split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const tail = labels.slice(-2).join('.');
  if (MULTI_LABEL_PUBLIC_SUFFIXES.has(tail) && labels.length >= 3) return labels.slice(-3).join('.');
  return tail;
}
function schemefulSite(value, base) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  let url;
  try {
    url = base ? new URL(raw, base) : new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const host = registrableHost(url.hostname);
  if (!host) return null;
  return `${url.protocol}//${host}`;
}
function srcPointsAtAnotherSite(src, pageUrl) {
  const srcSite = schemefulSite(src, pageUrl);
  if (!srcSite) return false;
  const pageSite = schemefulSite(pageUrl);
  if (!pageSite) return false;
  return srcSite !== pageSite;
}
// Chrome reports a cross-site iframe whose navigation has not committed as a
// depth-1 child still at about:blank (or with an empty URL) and an opaque
// origin. '://', an empty origin, and the string 'null' are that opaque value.
function isOpaqueSecurityOrigin(origin) {
  const value = String(origin ?? '').trim().toLowerCase();
  return value === '' || value === '://' || value === 'null';
}
function isUncommittedFrameUrl(url) {
  const value = String(url || '').trim().toLowerCase();
  return value === '' || value === 'about:blank';
}
function isPendingBlankFrame(frame) {
  return !!frame
    && frame.depth === 1
    && isUncommittedFrameUrl(frame.url)
    && !frame.unreachableUrl
    && isOpaqueSecurityOrigin(frame.securityOrigin);
}
function frameInventoryFromMeta(meta) {
  const elements = [];
  if (Array.isArray(meta?.frameElements)) {
    for (const el of meta.frameElements) {
      if (!el || typeof el !== 'object') continue;
      elements.push(el);
      if (elements.length >= PERCEIVE_FRAME_ELEMENT_CAP) break;
    }
  }
  // The detail list is capped. The page reports the full iframe/frame count
  // separately so a page with more than the cap still gets an honest X.
  const reported = Number(meta?.frameElementCount);
  const count = Number.isInteger(reported) && reported >= elements.length
    ? reported
    : elements.length;
  return { elements, count };
}
// One collector for the perceive Frames line and for a selector miss. The cap,
// the iframe/frame selector, and the fields stay the same list.
function frameElementInventorySource(visibleExpression = 'renderedInteractive(el)') {
  return `const frameElements = [];
    let frameElementCount = 0;
    for (const el of document.querySelectorAll('iframe, frame')) {
      frameElementCount += 1;
      if (frameElements.length >= ${PERCEIVE_FRAME_ELEMENT_CAP}) continue;
      const src = el.src || '';
      let host = '';
      try { if (src) host = new URL(src).host; } catch {}
      let visible = ${visibleExpression};
      try {
        const rect = el.getBoundingClientRect();
        if (!(rect.width >= 1) || !(rect.height >= 1)) visible = false;
      } catch { visible = false; }
      frameElements.push({
        title: el.getAttribute('title') || '',
        src,
        host,
        name: el.getAttribute('name') || '',
        visible,
      });
    }`;
}
const FRAME_INVENTORY_MARKER = 'chrome-cdp-ex.frame-inventory.v1';
function frameElementInventoryExpression() {
  return `(function() {
    ${frameElementInventorySource('true')}
    return { marker: ${JSON.stringify(FRAME_INVENTORY_MARKER)}, frameElements, frameElementCount };
  })()`;
}
// Pair only frames whose parent is the top frame. Callers pass depth-1 frames;
// a nested frame must never take a leftover top-level element's ref.
function matchPerceiveFrameElements(childFrames, frameElements) {
  const paired = new Map();
  const used = new Set();
  for (const frame of childFrames) {
    const urls = [frame.url, frame.unreachableUrl].filter(Boolean);
    const index = frameElements.findIndex((el, elIndex) => (
      !used.has(elIndex) && urls.some(url => frameUrlsEqual(url, el.src))
    ));
    if (index >= 0) {
      used.add(index);
      paired.set(frame.ref, index);
    }
  }
  const leftoverFrames = childFrames.filter(frame => !paired.has(frame.ref));
  const leftoverElements = [];
  frameElements.forEach((_, index) => {
    if (!used.has(index)) leftoverElements.push(index);
  });
  if (leftoverFrames.length > 0 && leftoverFrames.length === leftoverElements.length) {
    leftoverFrames.forEach((frame, index) => paired.set(frame.ref, leftoverElements[index]));
  }
  return paired;
}
function frameChildVisible(element, owner) {
  if (owner && typeof owner.visible === 'boolean') return owner.visible;
  if (element && typeof element.visible === 'boolean') return element.visible;
  return true;
}
function perceiveFrameLabel(element, owner, crossSite) {
  if (crossSite) return String(element?.host || frameUrlHost(element?.src) || '').trim();
  const title = String(owner?.title || element?.title || '').trim();
  if (title) return title;
  return String(owner?.host || element?.host || frameUrlHost(owner?.src || element?.src) || '').trim();
}
// N and M count child frames Page.getFrameTree reports (depth > 0), including
// nested frames. They do not include cross-site frames. This census does not
// attach; perceiveStr attaches when the page has iframe elements, reads each
// frame's securityOrigin. An allowlisted frame is then inlined from that frame's
// AX tree; a frame that is not allowlisted is not read. A depth-1 frame that is still about:blank or has an empty URL,
// with an opaque origin, is cross-site (pending) when its owner iframe src
// points at another site: it is not a same-origin child, it gets no ref, and
// Next does not point at it. `frame <t>` still lists that frame as Chrome
// reports it, so same-origin @fN numbers stay put. An about:blank iframe with
// no src, a same-site src, or srcdoc stays same-origin. Pairing and the
// cross-site count use only depth-1 frames against the top document's
// iframe/frame elements. A nested frame is not a top-level element, so it
// never matches one and never gets a top-level [iframe] line.
function perceiveTopLevelFrames(childFrames) {
  return childFrames.filter(frame => frame && frame.depth === 1);
}
function resolvedOwnerSrc(frame, owners, paired, elements) {
  if (owners instanceof Map && owners.has(frame.ref)) {
    const owner = owners.get(frame.ref);
    if (owner && typeof owner.src === 'string') return owner.src;
  }
  const index = paired.get(frame.ref);
  if (index == null) return '';
  return elements[index]?.src || '';
}
function sameSiteElementIndex(elements, used, pageUrl) {
  return elements.findIndex((element, index) => (
    !used.has(index) && !srcPointsAtAnotherSite(element?.src || '', pageUrl)
  ));
}
function pendingCrossSiteRefs(topLevel, elements, paired, pageUrl, owners) {
  const pending = new Set();
  const used = new Set(paired.values());
  for (const frame of topLevel) {
    if (!isPendingBlankFrame(frame)) continue;
    const ownerKnown = owners instanceof Map && owners.has(frame.ref);
    let src = resolvedOwnerSrc(frame, owners, paired, elements);
    const ownerSaysCrossSite = ownerKnown && srcPointsAtAnotherSite(src, pageUrl);
    const pairedIndex = paired.get(frame.ref);
    const pairedSrc = pairedIndex == null ? '' : (elements[pairedIndex]?.src || '');
    // Positional pairing can attach this blank frame to a cross-site iframe,
    // or leave it unpaired when a committed cross-site iframe is also on the
    // page. A free same-site element (no src, about:blank, srcdoc, or a
    // same-site URL) keeps the frame same-origin. The owner element's src
    // wins when DOM.getFrameOwner already read it.
    const pairIsWrong = pairedIndex == null || srcPointsAtAnotherSite(pairedSrc, pageUrl);
    if (!ownerSaysCrossSite && pairIsWrong) {
      const friendly = sameSiteElementIndex(elements, used, pageUrl);
      if (friendly >= 0) {
        if (pairedIndex != null) used.delete(pairedIndex);
        used.add(friendly);
        paired.set(frame.ref, friendly);
        if (!ownerKnown) src = elements[friendly]?.src || '';
      }
    }
    if (srcPointsAtAnotherSite(src, pageUrl)) pending.add(frame.ref);
  }
  return pending;
}
function withoutPendingFrames(children, pendingRefs) {
  if (!pendingRefs.size) return children;
  const pendingIds = new Set();
  for (const frame of children) {
    if (pendingRefs.has(frame.ref) && frame.id) pendingIds.add(frame.id);
  }
  const excluded = new Set(pendingRefs);
  let grew = true;
  while (grew) {
    grew = false;
    for (const frame of children) {
      if (excluded.has(frame.ref) || !frame.parentId || !pendingIds.has(frame.parentId)) continue;
      excluded.add(frame.ref);
      if (frame.id) pendingIds.add(frame.id);
      grew = true;
    }
  }
  return children.filter(frame => !excluded.has(frame.ref));
}
function perceiveFrameCensus({
  childFrames, frameElements, frameElementCount, pageUrl = '', owners = null,
}) {
  const children = Array.isArray(childFrames) ? childFrames : [];
  const elements = Array.isArray(frameElements) ? frameElements : [];
  const topLevel = perceiveTopLevelFrames(children);
  const reported = Number(frameElementCount);
  const elementCount = Number.isInteger(reported) && reported >= elements.length
    ? reported
    : elements.length;
  const paired = matchPerceiveFrameElements(topLevel, elements);
  const pendingRefs = pendingCrossSiteRefs(topLevel, elements, paired, pageUrl, owners);
  for (const ref of pendingRefs) paired.delete(ref);
  const sameOriginChildren = withoutPendingFrames(children, pendingRefs);
  const sameOriginTop = topLevel.filter(frame => !pendingRefs.has(frame.ref));
  const crossSiteCount = Math.max(0, elementCount - sameOriginTop.length);
  return { children: sameOriginChildren, elements, crossSiteCount, paired };
}
// An implicit perceive inlines at most this many allowlisted frames. The rest
// stay host-only with reason cap, and they are not read.
const FRAME_INLINE_CAP = 8;

function frameNodeById(node, frameId) {
  if (!node?.frame) return null;
  if (node.frame.id === frameId) return node.frame;
  for (const child of node.childFrames || []) {
    const found = frameNodeById(child, frameId);
    if (found) return found;
  }
  return null;
}

async function committedFrameSnapshot(cdp, sessionId, frameId) {
  const result = await cdpDomains(cdp).Page.getFrameTree({}, sessionId);
  const frame = frameNodeById(result?.frameTree, frameId);
  if (!frame) return null;
  return { origin: frame.securityOrigin || '', loaderId: frame.loaderId || '' };
}

// A frame's AX tree includes same-process children. Drop those nodes, and drop
// the iframe element whose name is the child document's title, so a skipped
// child cannot appear inside the parent block.
function axNodesOwnedByFrame(nodes, frameId) {
  const list = (Array.isArray(nodes) ? nodes : []).filter(node => node && node.nodeId);
  const byId = new Map(list.map(node => [node.nodeId, node]));
  const dropped = new Set();
  const dropTree = (nodeId) => {
    if (!nodeId || dropped.has(nodeId)) return;
    dropped.add(nodeId);
    const node = byId.get(nodeId);
    for (const childId of node?.childIds || []) dropTree(childId);
  };
  for (const node of list) {
    const role = String(node.role?.value || '').toLowerCase();
    if (role === 'iframe' || role === 'frame') dropTree(node.nodeId);
    if (node.frameId && frameId && node.frameId !== frameId) dropTree(node.nodeId);
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const node of list) {
      if (dropped.has(node.nodeId) || !node.parentId || !dropped.has(node.parentId)) continue;
      dropTree(node.nodeId);
      grew = true;
    }
  }
  return list.filter(node => !dropped.has(node.nodeId)).map(node => ({
    ...node,
    childIds: (node.childIds || []).filter(id => byId.has(id) && !dropped.has(id)),
  }));
}

function frameContentTitleAndInteractive(nodes) {
  let title = '';
  const interactive = {};
  for (const node of nodes || []) {
    const role = String(node?.role?.value || '');
    if (!title && role === 'RootWebArea') title = String(node.name?.value ?? '');
    const key = role.toLowerCase();
    if (INTERACTIVE_ROLES.has(key)) interactive[key] = (interactive[key] || 0) + 1;
  }
  return { title, interactive };
}

function hoistTrailingFrameRef(line) {
  const text = String(line ?? '');
  const match = / {2}(@f\d+:\d+|@\d+)$/.exec(text);
  if (!match || !text.includes('\n')) return text;
  const parts = text.slice(0, match.index).split('\n');
  parts[0] += match[0];
  return parts.join('\n');
}

function nestedIframeLine(host, ref, clause) {
  const parts = ['[iframe]'];
  if (host) parts.push(host);
  if (ref) parts.push(ref);
  if (clause) parts.push(clause);
  return `  ${parts.join(' ')}`;
}

function markInlineSlotUnread(slot, reason, origin) {
  const shown = origin == null || origin === '' ? null : frameContentOrigin(origin);
  slot.read = false;
  slot.reason = reason;
  slot.clause = crossSiteReadClause({ reason, origin: shown });
  slot.inlineText = '';
  slot.childLines = [];
  if (slot.emit) slot.emit.block = false;
  if (slot.record) {
    slot.record.content = { read: false, reason, origin: shown };
    delete slot.record.contentBoundary;
  }
}

function frameBlockOpenLine(slot) {
  const open = String(slot?.inlineText || '').split('\n').find(line => line.includes('--- FRAME CONTENT'));
  return open ? open.trim() : '';
}

// A frame counts as inlined only while its block is still in the printed tree.
// Depth and the chrome line cap can drop a block after the read.
function retainPrintedFrameBlocks(slots, lines) {
  const printed = new Set((lines || []).map(line => String(line).trim()));
  for (const slot of slots || []) {
    if (!slot?.emit) continue;
    const open = frameBlockOpenLine(slot);
    slot.emit.block = Boolean(slot.emit.block && open && printed.has(open));
  }
}

function renderFrameNoticeLine(notice) {
  const visibleRefs = notice.visibleRefs || [];
  const classifying = notice.classifying === true;
  const target = notice.target || '<target>';
  const childCount = notice.childCount || 0;
  const crossSiteCount = notice.crossSiteCount || 0;
  const candidates = [...visibleRefs];
  let allowed = 0;
  let inlined = 0;
  if (classifying) {
    for (const slot of notice.slots || []) {
      if (!slot?.crossSite || !slot.read || slot.reason) continue;
      allowed += 1;
      // The printed tree already contains this frame's block. --frame would re-read it.
      if (slot.emit?.block) {
        inlined += 1;
        continue;
      }
      if (slot.visible && slot.ref) candidates.push(slot.ref);
    }
  }
  const notRead = classifying ? Math.max(0, crossSiteCount - allowed) : crossSiteCount;
  let line = `Frames: ${childCount} (${visibleRefs.length} visible)`;
  if (classifying) {
    if (notRead > 0) line += `, ${notRead} cross-site not read`;
    if (allowed > 0) line += `, ${allowed} cross-site allowed`;
    const pending = allowed - inlined;
    if (candidates.length === 1) line += `. Next: cdp perceive ${target} --frame ${candidates[0]}`;
    else if (childCount || notRead || pending) line += `. Next: cdp frame ${target}`;
  } else if (crossSiteCount > 0) {
    line += `, ${crossSiteCount} cross-site not reachable yet`;
    if (visibleRefs.length === 1) line += `. Next: cdp perceive ${target} --frame ${visibleRefs[0]}`;
    else if (childCount >= 1) line += `. Next: cdp frame ${target}`;
  } else if (visibleRefs.length === 1) {
    line += `. Next: cdp perceive ${target} --frame ${visibleRefs[0]}`;
  } else if (childCount >= 1) {
    line += `. Next: cdp frame ${target}`;
  }
  notice.line = line;
  return notice;
}

// COMMIT_CHECKS: the origin is read before the AX call and again after it.
// A Page.frameNavigated for that frame, or a changed origin or loaderId,
// discards the tree. The printed host stays the origin we committed to.
async function readInlineFrameContent(cdp, sid, frame, ctx) {
  const committed = frameContentOrigin(frame.securityOrigin);
  const childSid = crossSiteFrameSession(cdp, sid, frame.id);
  if (!childSid) return { ok: false, reason: 'navigated', origin: committed };
  let before = null;
  try {
    before = await committedFrameSnapshot(cdp, childSid, frame.id);
  } catch {
    return { ok: false, reason: 'navigated', origin: committed };
  }
  const started = frame.securityOrigin || '';
  if (!before || before.origin !== started || !classifyFrameOrigin(before.origin, ctx.sites).read) {
    return { ok: false, reason: 'navigated', origin: committed };
  }
  let sawNavigation = false;
  const unsubscribe = typeof cdp.onEvent === 'function'
    ? cdp.onEvent('Page.frameNavigated', (params) => {
      if (params?.frame?.id === frame.id) sawNavigation = true;
    })
    : null;
  try {
    const ax = await cdpDomains(cdp).Accessibility.getFullAXTree({ frameId: frame.id }, childSid);
    const after = await committedFrameSnapshot(cdp, childSid, frame.id);
    if (sawNavigation || !after || after.origin !== before.origin || after.loaderId !== before.loaderId) {
      return { ok: false, reason: 'navigated', origin: frameContentOrigin(before.origin) };
    }
    const nodes = axNodesOwnedByFrame(Array.isArray(ax?.nodes) ? ax.nodes : [], frame.id);
    const scopedRefs = new Map();
    const built = buildPerceiveTree(nodes, { layoutMap: {}, counts: {}, styleHints: {} }, scopedRefs, {
      maxDepth: ctx.maxDepth,
      interactiveOnly: ctx.interactiveOnly,
      cursorInteractive: ctx.cursorInteractive,
      targetPrefix: ctx.targetPrefix,
    });
    storeFrameScopedRefs(ctx.refState, frame, ctx.frames, scopedRefs);
    const { title, interactive } = frameContentTitleAndInteractive(nodes);
    const origin = frameContentOrigin(before.origin);
    const qualified = qualifyFrameRefsInLines(built.treeLines, frame.ref).map(hoistTrailingFrameRef);
    return {
      ok: true,
      origin,
      title,
      interactive,
      text: wrapFrameContent(qualified.join('\n'), { nonce: ctx.nonce, origin }),
    };
  } catch {
    return { ok: false, reason: 'navigated', origin: frameContentOrigin(before.origin) };
  } finally {
    if (typeof unsubscribe === 'function') unsubscribe();
  }
}

async function inlineNestedOopifFrames(cdp, sid, parent, ctx) {
  const lines = [];
  const children = (ctx.frames || []).filter(frame => frame && frame.process === 'oopif' && frame.parentId === parent.id);
  for (const child of children) {
    const classification = classifyFrameOrigin(child.securityOrigin, ctx.sites);
    const host = originHost(child.securityOrigin);
    if (!classification.read) {
      ctx.notice.records.push({
        ref: child.ref,
        content: { read: false, reason: classification.reason, origin: classification.origin },
      });
      lines.push(nestedIframeLine(host, child.ref, crossSiteReadClause(classification)));
      continue;
    }
    if (ctx.budget <= 0) {
      ctx.notice.records.push({
        ref: child.ref,
        content: { read: false, reason: 'cap', origin: classification.origin },
      });
      lines.push(nestedIframeLine(host, child.ref, crossSiteReadClause({ reason: 'cap', origin: classification.origin })));
      continue;
    }
    ctx.budget -= 1;
    const outcome = await readInlineFrameContent(cdp, sid, child, ctx);
    if (!outcome.ok) {
      ctx.notice.records.push({
        ref: child.ref,
        content: { read: false, reason: outcome.reason || 'navigated', origin: outcome.origin },
      });
      lines.push(nestedIframeLine(host, child.ref, crossSiteReadClause({
        reason: outcome.reason || 'navigated',
        origin: outcome.origin,
      })));
      continue;
    }
    ctx.notice.records.push({
      ref: child.ref,
      content: { read: true, origin: outcome.origin },
      contentBoundary: frameContentBoundary(ctx.nonce, outcome.origin),
    });
    lines.push(nestedIframeLine(host, child.ref, ''));
    if (outcome.text) lines.push(...String(outcome.text).split('\n'));
    lines.push(...await inlineNestedOopifFrames(cdp, sid, child, ctx));
  }
  return lines;
}

async function inlineAllowlistedFrames(cdp, sid, notice, ctx) {
  const byId = new Map();
  for (const frame of ctx.frames || []) {
    if (frame?.id) byId.set(frame.id, frame);
  }
  const state = {
    ...ctx,
    notice,
    nonce: createFrameContentNonce(),
    budget: FRAME_INLINE_CAP,
  };
  for (const slot of notice.slots || []) {
    if (!slot?.crossSite || !slot.read || slot.reason) continue;
    const origin = slot.record?.content?.origin || null;
    const frame = slot.frameId ? byId.get(slot.frameId) : null;
    if (!frame) {
      markInlineSlotUnread(slot, 'navigated', origin);
      continue;
    }
    if (state.budget <= 0) {
      markInlineSlotUnread(slot, 'cap', origin);
      continue;
    }
    state.budget -= 1;
    const outcome = await readInlineFrameContent(cdp, sid, frame, state);
    if (!outcome.ok) {
      markInlineSlotUnread(slot, outcome.reason || 'navigated', outcome.origin || origin);
      continue;
    }
    slot.read = true;
    slot.reason = '';
    slot.clause = '';
    slot.inlineText = outcome.text;
    slot.emit = { block: false };
    if (slot.record) {
      slot.record.content = { read: true, origin: outcome.origin };
      slot.record.contentBoundary = frameContentBoundary(state.nonce, outcome.origin);
    }
    slot.childLines = await inlineNestedOopifFrames(cdp, sid, frame, state);
  }
  return renderFrameNoticeLine(notice);
}

function interactiveCountLine(interactive) {
  const parts = Object.entries(interactive || {})
    .filter(([, count]) => count > 0)
    .map(([role, count]) => `${count} ${role}`);
  return `Interactive: ${parts.length ? parts.join(', ') : 'none'}`;
}

export function formatCrossSiteSummaryText(frames) {
  if (!Array.isArray(frames) || frames.length === 0) return '';
  const lines = [];
  for (const frame of frames) {
    if (!frame?.content?.read || !frame.frameContent) continue;
    const host = frame.host || originHost(frame.content.origin);
    if (host) lines.push(`Frame: ${host}`);
    const nonce = frame.contentBoundary?.nonce || createFrameContentNonce();
    lines.push(wrapFrameContent([
      `Title: ${frame.frameContent.title || ''}`,
      interactiveCountLine(frame.frameContent.interactive),
    ].join('\n'), { nonce, origin: frame.content.origin }));
  }
  return lines.join('\n');
}

export async function crossSiteSummaryFrames(cdp, sid) {
  const sites = currentFrameSites();
  // Unset means nothing can be inlined. Skip attach and the child frame walk.
  if (sites == null) return [];
  const listed = await framesModel(cdp, sid, { crossSite: true });
  const frames = (listed.frames || []).filter(frame => frame?.process === 'oopif' && frame.id);
  if (!frames.length) return [];
  const nonce = createFrameContentNonce();
  const records = [];
  let budget = FRAME_INLINE_CAP;
  const ctx = {
    sites,
    nonce,
    frames: listed.frames,
    maxDepth: Infinity,
    interactiveOnly: false,
    cursorInteractive: false,
    targetPrefix: '<target>',
    refState: null,
  };
  for (const frame of frames) {
    const classification = classifyFrameOrigin(frame.securityOrigin, sites);
    if (!classification.read) continue;
    if (budget <= 0) break;
    budget -= 1;
    const outcome = await readInlineFrameContent(cdp, sid, frame, ctx);
    if (!outcome.ok) continue;
    records.push({
      ref: frame.ref,
      host: originHost(outcome.origin),
      content: { read: true, origin: outcome.origin },
      contentBoundary: frameContentBoundary(nonce, outcome.origin),
      frameContent: { title: outcome.title, interactive: outcome.interactive },
    });
  }
  return records;
}
const PERCEIVE_FRAME_RECORDS = new WeakMap();

function normalizeFrameSites(value) {
  if (value == null || !Array.isArray(value) || value.length === 0) return null;
  if (typeof value[0] === 'string') return value.map(parseFrameSiteEntry);
  return value;
}

// The daemon uses the value on this request. It does not read CDP_FRAME_SITES
// from its own environment. Unit tests that omit the store behave as unset.
function currentFrameSites(opts = {}) {
  if (Object.hasOwn(opts, 'frameSites')) return normalizeFrameSites(opts.frameSites);
  return normalizeFrameSites(daemonPolicyStorage.getStore()?.policy?.frameSites);
}

function rememberPerceiveFrameRecords(cdp, records) {
  if (!cdp) return;
  PERCEIVE_FRAME_RECORDS.set(cdp, records || null);
}

function perceiveFrameRecords(cdp) {
  return cdp ? (PERCEIVE_FRAME_RECORDS.get(cdp) || null) : null;
}

function buildPerceiveFrameNotice({
  childFrames, frameElements, frameElementCount, owners, target, pageUrl = '',
  oopifFrames = null, frameSites = null,
}) {
  const { children, elements, crossSiteCount, paired } = perceiveFrameCensus({
    childFrames,
    frameElements,
    frameElementCount,
    pageUrl,
    owners,
  });
  if (children.length === 0 && crossSiteCount === 0) return null;
  const classifying = Array.isArray(oopifFrames);
  const ownerMap = owners instanceof Map ? owners : new Map();
  const refByElement = new Map();
  for (const [ref, index] of paired) refByElement.set(index, ref);
  const oopifByElement = new Map();
  if (classifying) {
    const usedElements = new Set(paired.values());
    const usedOopifs = new Set();
    const topOopifs = oopifFrames.filter(frame => frame && frame.depth === 1);
    for (const frame of topOopifs) {
      const urls = [frame.url, frame.unreachableUrl].filter(Boolean);
      const index = elements.findIndex((element, elementIndex) => (
        !usedElements.has(elementIndex)
        && !usedOopifs.has(frame.ref)
        && urls.some(url => frameUrlsEqual(url, element?.src))
      ));
      if (index < 0) continue;
      usedElements.add(index);
      usedOopifs.add(frame.ref);
      oopifByElement.set(index, frame);
    }
    // The iframe src attribute stays where the page set it. After the frame
    // navigates, the frame tree has the current origin and that src no longer
    // matches. Pair the leftovers in order and classify that origin.
    const freeOopifs = topOopifs.filter(frame => !usedOopifs.has(frame.ref));
    const freeElements = [];
    elements.forEach((_, index) => {
      if (!usedElements.has(index)) freeElements.push(index);
    });
    if (freeOopifs.length > 0 && freeOopifs.length === freeElements.length) {
      freeOopifs.forEach((frame, index) => {
        oopifByElement.set(freeElements[index], frame);
      });
    }
  }
  const records = [];
  const slots = elements.map((element, index) => {
    const sameRef = refByElement.get(index) || null;
    if (sameRef) {
      const owner = ownerMap.get(sameRef);
      return {
        ref: sameRef,
        label: perceiveFrameLabel(element, owner, false),
        backendNodeId: owner?.backendNodeId || null,
      };
    }
    if (!classifying) {
      return {
        ref: null,
        label: perceiveFrameLabel(element, null, true),
        backendNodeId: null,
      };
    }
    const oopif = oopifByElement.get(index) || null;
    const classification = oopif
      ? classifyFrameOrigin(oopif.securityOrigin, frameSites)
      : { read: false, reason: 'opaque-origin', origin: null };
    const host = oopif ? originHost(oopif.securityOrigin) : '';
    const ref = oopif?.ref || null;
    const visible = frameChildVisible(element, null);
    const read = classification.read === true;
    const record = {
      ...(ref ? { ref } : {}),
      content: read
        ? { read: true, origin: classification.origin }
        : { read: false, reason: classification.reason, origin: classification.origin },
    };
    records.push(record);
    return {
      ref,
      crossSite: true,
      host,
      clause: read ? '' : crossSiteReadClause(classification),
      reason: read ? '' : classification.reason,
      read,
      visible,
      label: host,
      backendNodeId: null,
      frameId: oopif?.id || '',
      record,
    };
  });
  const visibleRefs = [];
  for (const frame of children) {
    const index = paired.get(frame.ref);
    const element = index == null ? null : elements[index];
    if (frameChildVisible(element, ownerMap.get(frame.ref))) visibleRefs.push(frame.ref);
  }
  // FRAME_NEXT_CANDIDATES: a skipped cross-site frame is never a perceive --frame target.
  return renderFrameNoticeLine({
    slots,
    records,
    childCount: children.length,
    crossSiteCount,
    singleChildRef: children.length === 1 ? children[0]?.ref || null : null,
    classifying,
    target,
    visibleRefs,
  });
}
// Named click matches buttons, links, tabs, radios and labels. A heading or
// ignored node with the same text is not a place that click would have found
// the control. LabelText is the accessible role of a <label>.
const NAMED_FRAME_MISS_ROLES = new Set(['button', 'link', 'tab', 'radio', 'label', 'labeltext']);
function namedFrameMissLabel(message, target) {
  if (!/^Named control not found\b/.test(String(message || ''))) return '';
  const input = String(target?.input || '').trim();
  if (input) {
    const name = String(namedClickQueryName(input) || '').trim();
    if (name) return name;
  }
  const quoted = String(message).match(/^Named control not found:\s+("(?:\\.|[^"\\])*")/);
  if (!quoted) return '';
  try {
    const parsed = JSON.parse(quoted[1]);
    return typeof parsed === 'string' ? parsed.trim() : '';
  } catch {
    return '';
  }
}
function accessibleNameMatches(actual, wanted) {
  const name = String(actual ?? '');
  const label = String(wanted ?? '');
  if (!label) return false;
  if (name === label) return true;
  const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
  const wantedNorm = normalize(label);
  return wantedNorm !== '' && normalize(name) === wantedNorm;
}
function frameNameHits(nodes, label) {
  const hits = [];
  for (const node of nodes || []) {
    if (!node || node.ignored === true) continue;
    const role = String(node.role?.value || '').toLowerCase();
    if (!NAMED_FRAME_MISS_ROLES.has(role)) continue;
    if (!accessibleNameMatches(axNodeAccessibleName(node), label)) continue;
    hits.push(node);
  }
  return hits;
}
async function axNodesForFrame(cdp, sid, frame) {
  if (!frame?.id) return [];
  const sessionId = frame.process === 'oopif' ? crossSiteFrameSession(cdp, sid, frame.id) : sid;
  if (!sessionId) return [];
  const result = await cdpDomains(cdp).Accessibility.getFullAXTree({ frameId: frame.id }, sessionId);
  return Array.isArray(result?.nodes) ? result.nodes : [];
}
// Stop once two frames match: Next stays on the slice C command either way.
async function uniqueNamedFrameMatch(cdp, sid, frames, label) {
  const matches = [];
  for (const frame of frames) {
    let hits = [];
    try {
      hits = frameNameHits(await axNodesForFrame(cdp, sid, frame), label);
    } catch {
      continue;
    }
    if (!hits.length) continue;
    matches.push({ frame, hits });
    if (matches.length > 1) return null;
  }
  return matches.length === 1 ? matches[0] : null;
}
function knownFrameElementRef(refState, frame, node) {
  if (!frame || frame.process === 'oopif') return '';
  const backendNodeId = node?.backendDOMNodeId;
  if (!Number.isInteger(backendNodeId)) return '';
  const entry = frameScopedRefEntry(refState, { frameRef: frame.ref });
  if (!entry || !(entry.refs instanceof Map)) return '';
  if (entry.frameId && frame.id && entry.frameId !== frame.id) return '';
  if (crossSiteFrameProcess(entry, frame.ref) === 'oopif') return '';
  let found = '';
  for (const [index, id] of entry.refs) {
    if (id !== backendNodeId || !Number.isInteger(index) || index < 1) continue;
    if (found) return '';
    found = `${frame.ref}:${index}`;
  }
  return found;
}
// A top-document selector miss. Count comes from the same census as the Frames
// line. Zero iframe/frame elements skip Page.getFrameTree: that page has nothing
// a later --frame could enter. A named miss then reads accessible names in
// same-origin frames. An already-attached cross-site frame is included; this
// does not call setAutoAttach, and it does not inline that frame here.
export async function attachSelectorFrameMiss(cdp, sid, err, target = {}, refState = null) {
  if (!cdp || !sid || !err || typeof err !== 'object') return err;
  const message = String(err.message || '');
  if (!/^(?:Named control not found|Element not found)\b/.test(message)) return err;
  const input = String(target?.input || target?.label || '').trim();
  if (/^@f\d+:\d+$/.test(input)) return err;
  try {
    const hint = await readSelectorFrameMiss(cdp, sid, {
      label: namedFrameMissLabel(message, target),
      refState,
    });
    if (hint) err.frameMiss = hint;
  } catch {
    // The original miss still has to be reported if the frame probe fails.
  }
  return err;
}
async function readSelectorFrameMiss(cdp, sid, { label = '', refState = null } = {}) {
  const raw = await evalStr(cdp, sid, frameElementInventoryExpression(), false, {
    timeoutMs: STATUS_PAGE_INFO_TIMEOUT,
  });
  let parsed = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); } catch { return null; }
  }
  if (!parsed || parsed.marker !== FRAME_INVENTORY_MARKER) return null;
  const inventory = frameInventoryFromMeta(parsed);
  if (!inventory.count) return null;
  const model = await framesModel(cdp, sid);
  const frames = model.frames || [];
  const childFrames = frames.filter(item => item && item.depth > 0);
  const pageUrl = frames.find(item => item && item.depth === 0)?.url || '';
  const notice = buildPerceiveFrameNotice({
    childFrames,
    frameElements: inventory.elements,
    frameElementCount: inventory.count,
    owners: new Map(),
    target: '<target>',
    pageUrl,
  });
  if (!notice) return null;
  const hint = {
    childCount: notice.childCount,
    crossSiteCount: notice.crossSiteCount,
    singleChildRef: notice.singleChildRef,
  };
  if (!label) return hint;
  const census = perceiveFrameCensus({
    childFrames,
    frameElements: inventory.elements,
    frameElementCount: inventory.count,
    pageUrl,
    owners: new Map(),
  });
  const sameOrigin = (census.children || []).filter(frame => frame && frame.depth > 0 && frame.id);
  let oopifFrames = [];
  const doc = oopifDocument(cdp, sid);
  // Already attached only. setAutoAttach stays on the frame command.
  if (doc.attached && doc.children.length > 0) {
    try {
      const merged = await framesModel(cdp, sid, { crossSite: true });
      oopifFrames = (merged.frames || []).filter(frame => frame?.process === 'oopif' && frame.depth > 0 && frame.id);
    } catch {
      oopifFrames = [];
    }
  }
  const match = await uniqueNamedFrameMatch(cdp, sid, sameOrigin.concat(oopifFrames), label);
  if (!match || !/^@f\d+$/.test(match.frame?.ref || '')) return hint;
  hint.matchedFrameRef = match.frame.ref;
  if (match.frame.process === 'oopif') hint.matchedProcess = 'oopif';
  if (match.hits.length === 1) {
    const elementRef = knownFrameElementRef(refState, match.frame, match.hits[0]);
    if (elementRef) hint.matchedElementRef = elementRef;
  }
  return hint;
}
function formatPerceiveIframeLine(depth, label, ref, slot = null) {
  const indent = '  '.repeat(Math.min(depth, 10));
  if (slot?.crossSite) {
    const parts = ['[iframe]'];
    if (slot.host) parts.push(slot.host);
    if (slot.ref) parts.push(slot.ref);
    if (slot.clause) parts.push(slot.clause);
    return `${indent}${parts.join(' ')}`;
  }
  const quoted = JSON.stringify(String(label ?? ''));
  return `${indent}[iframe] ${quoted}${ref ? ` ${ref}` : ''}`;
}
async function describeOnePerceiveFrameOwner(cdp, sid, frame) {
  if (!frame?.id) return null;
  try {
    const owner = await cdpDomains(cdp).DOM.getFrameOwner( { frameId: frame.id }, sid);
    const backendNodeId = owner?.backendNodeId;
    if (!backendNodeId) return null;
    const { object } = await cdpDomains(cdp).DOM.resolveNode( { backendNodeId }, sid);
    if (!object?.objectId) return null;
    const res = await cdpDomains(cdp).Runtime.callFunctionOn( {
      objectId: object.objectId,
      functionDeclaration: PERCEIVE_FRAME_OWNER_FN,
      returnByValue: true,
    }, sid);
    const value = res?.result?.value;
    if (!value || value.marker !== PERCEIVE_FRAME_OWNER_MARKER) return null;
    return {
      ref: frame.ref,
      owner: {
        backendNodeId,
        title: value.title || '',
        src: value.src || '',
        host: value.host || '',
        visible: value.visible === true,
      },
    };
  } catch {
    return null;
  }
}
async function describePerceiveFrameOwners(cdp, sid, childFrames) {
  const entries = await Promise.all(childFrames.map(frame => describeOnePerceiveFrameOwner(cdp, sid, frame)));
  const owners = new Map();
  for (const entry of entries) {
    if (entry) owners.set(entry.ref, entry.owner);
  }
  return owners;
}
export function displayedFrame(frame, { unsafeFull = false } = {}) {
  if (!frame || unsafeFull) return frame;
  const url = typeof frame.url === 'string' ? displayUrl(frame.url) : frame.url;
  const unreachableUrl = typeof frame.unreachableUrl === 'string' ? displayUrl(frame.unreachableUrl) : frame.unreachableUrl;
  if (url === frame.url && unreachableUrl === frame.unreachableUrl) return frame;
  return { ...frame, url, unreachableUrl };
}
export function parseFrameArgs(args = []) {
  const fopts = parseFormatArgs(args, ['text', 'json']);
  const lifted = takeUnsafeFullArg(fopts.args);
  if (lifted.args.length) {
    throw new Error(`frame: unknown argument ${lifted.args[0]}. Next: cdp frame <target> [--unsafe-full] [--format json]`);
  }
  return { format: fopts.format, unsafeFull: lifted.unsafeFull };
}
function frameListModel(frames) {
  const nonce = createFrameContentNonce();
  return frames.map(frame => {
    if (frame?.process !== 'oopif') return frame;
    const copy = { ...frame };
    const name = String(copy.name || '');
    delete copy.name;
    delete copy.title;
    if (name.trim()) {
      copy.frameContent = {
        name,
        contentBoundary: frameContentBoundary(nonce, frameContentOrigin(copy.securityOrigin)),
      };
    }
    return copy;
  });
}
export async function framesStr(cdp, sid, { format = 'text', unsafeFull = false } = {}) {
  const model = await framesModel(cdp, sid, { crossSite: true });
  const frames = (model.frames || []).map(frame => displayedFrame(frame, { unsafeFull }));
  if (format === 'json') return formatJson({ ...model, frames: frameListModel(frames) });
  return formatFrameTreeText(frames);
}
function unknownFrameError(message) {
  const err = new Error(message);
  err.unknownFrame = true;
  return err;
}
export async function resolveFrameRef(cdp, sid, frameRef) {
  const parsed = parseFrameOnlyRef(frameRef);
  if (!parsed) throw new Error(`Frame ref required (example: @f2), got: ${frameRef || '(empty)'}`);
  // A same-origin @fN is inside Page.getFrameTree. Resolving it must not attach.
  const same = await framesModel(cdp, sid);
  const direct = same.frames[parsed.frameIndex - 1];
  if (direct && direct.ref === parsed.frameRef) return { frame: direct, frames: same.frames };
  const model = await framesModel(cdp, sid, { crossSite: true });
  const frame = model.frames[parsed.frameIndex - 1];
  if (!frame || frame.ref !== parsed.frameRef) {
    throw unknownFrameError(`Unknown frame: ${parsed.frameRef}. Run "frame" to refresh the frame tree, then use a listed @fN ref.`);
  }
  return { frame, frames: model.frames };
}
export async function createFrameExecutionContext(cdp, sid, frameId) {
  const res = await cdpDomains(cdp).Page.createIsolatedWorld( {
    frameId,
    worldName: 'chrome-cdp-ex',
    grantUniveralAccess: false,
  }, sid);
  return res.executionContextId;
}
export function storeFrameScopedRefs(refState, frame, frames, scopedRefMap) {
  if (!refState || !frame) return;
  if (!(refState.frameRefs instanceof Map)) refState.frameRefs = new Map();
  refState.frameRefs.set(frame.ref, {
    frameRef: frame.ref,
    frameIndex: frame.index,
    frameId: frame.id,
    parentId: frame.parentId || null,
    parentRef: frame.parentRef || null,
    name: frame.name || '',
    url: frame.url || '',
    process: frame.process || '',
    refs: new Map(scopedRefMap),
    frames: frames || [],
  });
}
export function frameScopedRefEntry(refState, parsed) {
  const store = refState?.frameRefs;
  if (!(store instanceof Map)) return null;
  return store.get(parsed.frameRef) || null;
}
export function frameScopedBackendNode(refState, parsed, { allowCrossSite = false } = {}) {
  const entry = frameScopedRefEntry(refState, parsed);
  if (!entry) {
    throw unknownFrameError(`Unknown frame ref: ${parsed.frameRef}. Run "frame", then "perceive --frame ${parsed.frameRef}" to assign iframe-local refs.`);
  }
  if (!allowCrossSite) rejectCrossSiteFrameEntry(entry, parsed.frameRef);
  if (!(entry.refs instanceof Map) || !entry.refs.has(parsed.refIndex)) {
    throw new Error(`Unknown ref: ${parsed.frameRef}:${parsed.refIndex}. Run "perceive --frame ${parsed.frameRef}" to refresh refs inside that frame.`);
  }
  return { entry, backendNodeId: entry.refs.get(parsed.refIndex) };
}
function crossSiteFrameProcess(entry, frameRef) {
  if (entry?.process === 'oopif') return 'oopif';
  const frames = entry?.frames;
  if (!Array.isArray(frames)) return '';
  const match = frames.find(frame => frame && (frame.ref === frameRef || frame.id === entry.frameId));
  return match?.process === 'oopif' ? 'oopif' : '';
}
export function crossSiteFrameActionError(frameRef) {
  const err = new Error(`Actions inside cross-site frames are not supported yet (${frameRef}).`);
  err.crossSiteFrameAction = { frameRef };
  return err;
}
function rejectCrossSiteFrameEntry(entry, frameRef) {
  if (crossSiteFrameProcess(entry, frameRef) === 'oopif') throw crossSiteFrameActionError(frameRef);
}
// Actions that do not route into the child session still refuse here, before
// Page.createIsolatedWorld on the parent session ("No frame for given id found").
export function rejectCrossSiteFrameAction(refState, ref) {
  const parsed = parseFrameRef(ref);
  if (!parsed) return;
  const entry = frameScopedRefEntry(refState || {}, parsed);
  if (!entry) return;
  rejectCrossSiteFrameEntry(entry, parsed.frameRef);
}
export function qualifyFrameRefsInLines(lines, frameRef) {
  return lines.map(line => line.replace(/@(\d+)(?=\s*(?:\(|$))/, `${frameRef}:$1`));
}
export function frameRefFromActionTarget(target = {}) {
  for (const value of [target.input, target.label, target.selector]) {
    const parsed = parseFrameRef(value);
    if (parsed) return parsed.frameRef;
  }
  return null;
}
export function rememberFramePerceiveOutput(refState, frameRef, output) {
  if (!refState || !frameRef) return;
  if (!(refState.frameLastOutputs instanceof Map)) refState.frameLastOutputs = new Map();
  refState.frameLastOutputs.set(frameRef, output);
}
export function baselineOutputForActionTarget(refState, fallbackOutput, target = {}) {
  const targetFrameRef = frameRefFromActionTarget(target);
  if (targetFrameRef && refState?.frameLastOutputs instanceof Map && refState.frameLastOutputs.has(targetFrameRef)) {
    return refState.frameLastOutputs.get(targetFrameRef);
  }
  return fallbackOutput;
}
function crossSiteFrameNotAttachedError(frameRef) {
  const ref = frameRef || 'cross-site frame';
  return new Error(`Cross-site frame ${ref} is not attached. Run "frame" to refresh it, then "perceive --frame ${ref}".`);
}

function crossSiteFrameBoxError(frameRef) {
  const ref = frameRef || 'cross-site frame';
  return new Error(`Cross-site frame ${ref} has no box for its owner iframe. Run "frame" to refresh it, then retry.`);
}

async function ensureCrossSiteFrameSession(cdp, pageSid, entry) {
  const frameId = entry?.frameId || '';
  const frameRef = entry?.frameRef || entry?.ref || '';
  const ready = crossSiteFrameSession(cdp, pageSid, frameId);
  if (ready) return ready;
  await framesModel(cdp, pageSid, { crossSite: true });
  const attached = crossSiteFrameSession(cdp, pageSid, frameId);
  if (attached) return attached;
  throw crossSiteFrameNotAttachedError(frameRef);
}

function contentQuadOrigin(model) {
  const content = model?.model?.content;
  if (!Array.isArray(content) || content.length < 2) return null;
  const x = Number(content[0]);
  const y = Number(content[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

// Child-local points are viewport CSS pixels of the OOPIF. DOM.getBoxModel's
// content quad is the viewport top-left of that document's root frame, so the
// page point is the sum of each owner iframe's content origin. Do not also
// subtract scroll: the quad is already in viewport pixels.
async function crossSiteFramePageOffset(cdp, pageSid, entry, frameRef) {
  const ref = frameRef || entry?.frameRef || entry?.ref || '';
  if (!entry?.frameId || !entry.parentId) throw crossSiteFrameBoxError(ref);
  let x = 0;
  let y = 0;
  let ownerBackendNodeId = 0;
  let current = entry;
  const frames = Array.isArray(entry.frames) ? entry.frames : [];
  for (let guard = 0; current?.frameId && current.parentId && guard < 8; guard += 1) {
    const parentFrame = frames.find(frame => frame && frame.id === current.parentId) || null;
    const parentIsOopif = parentFrame?.process === 'oopif';
    let ownerSid = pageSid;
    if (parentIsOopif) {
      ownerSid = crossSiteFrameSession(cdp, pageSid, current.parentId);
      if (!ownerSid) throw crossSiteFrameNotAttachedError(parentFrame.ref || ref);
    }
    const owner = await cdpDomains(cdp).DOM.getFrameOwner({ frameId: current.frameId }, ownerSid);
    const backendNodeId = owner?.backendNodeId;
    const stepRef = current.frameRef || current.ref || ref;
    if (!backendNodeId) throw crossSiteFrameBoxError(stepRef);
    const model = await cdpDomains(cdp).DOM.getBoxModel({ backendNodeId }, ownerSid);
    const origin = contentQuadOrigin(model);
    if (!origin) throw crossSiteFrameBoxError(stepRef);
    x += origin.x;
    y += origin.y;
    if (ownerSid === pageSid) {
      ownerBackendNodeId = backendNodeId;
      break;
    }
    if (!parentFrame) break;
    current = {
      frameId: parentFrame.id,
      parentId: parentFrame.parentId || null,
      frameRef: parentFrame.ref || '',
      ref: parentFrame.ref || '',
      frames,
    };
  }
  if (!ownerBackendNodeId) throw crossSiteFrameBoxError(ref);
  return { x, y, ownerBackendNodeId };
}

async function framePointOffset(cdp, sid, entry, frameRef, { settle = false } = {}) {
  if (crossSiteFrameProcess(entry, frameRef) === 'oopif') {
    return crossSiteFramePageOffset(cdp, sid, entry, frameRef);
  }
  const offset = await frameViewportOffset(cdp, sid, entry, { settle });
  return { x: offset.x, y: offset.y, ownerBackendNodeId: 0 };
}

async function placeFrameRect(cdp, sid, refState, frameParsed, value, { allowCrossSite = false, settle = false, hitTest = false } = {}) {
  const { entry } = frameScopedBackendNode(refState || {}, frameParsed, { allowCrossSite });
  const offset = await framePointOffset(cdp, sid, entry, frameParsed.frameRef, { settle });
  value.x = (Number(value.x) || 0) + offset.x;
  value.y = (Number(value.y) || 0) + offset.y;
  // The only page-layer cover check. Dispatch does not repeat it: a frame point is
  // already in the top viewport, and dropping this check lets the click fail closed.
  let parentCovered = false;
  if (hitTest && offset.ownerBackendNodeId) {
    const parentHit = await ownerIframeCover(cdp, sid, offset.ownerBackendNodeId, value, frameParsed.frameRef);
    if (parentHit?.covered === true) {
      value.hit = parentHit;
      parentCovered = true;
    }
  }
  if (crossSiteFrameProcess(entry, frameParsed.frameRef) === 'oopif') {
    const listed = listedFrame(cdp, sid, entry.frameId) || listedFrame(cdp, sid, frameParsed.frameRef);
    const rawOrigin = listed?.securityOrigin || '';
    value.crossSite = true;
    value.crossSiteOrigin = rawOrigin;
    value.crossSiteHost = originHost(rawOrigin);
    value.coverScope = parentCovered ? 'page' : 'frame';
  }
  return offset;
}

const OWNER_IFRAME_HIT_MARKER = 'chrome-cdp-ex.owner-iframe-hit.v1';

function ownerIframeHitDeclaration() {
  return `function(x, y) {
    const iframe = this;
    const marker = ${JSON.stringify(OWNER_IFRAME_HIT_MARKER)};
    const doc = iframe && iframe.ownerDocument;
    const px = Number(x) || 0;
    const py = Number(y) || 0;
    if (!doc || typeof doc.elementFromPoint !== 'function') {
      return { marker: marker, covered: true, by: '<none>', x: px, y: py };
    }
    let top = null;
    try { top = doc.elementFromPoint(px, py); } catch (err) { top = null; }
    if (!top) return { marker: marker, covered: true, by: '<none>', x: px, y: py };
    let inside = false;
    for (let node = top, guard = 0; node && guard < 64; node = node.parentNode, guard++) {
      if (node === iframe) { inside = true; break; }
    }
    if (inside) return { marker: marker, covered: false, x: px, y: py };
    const tag = String(top.tagName || 'node').toUpperCase();
    const id = top.id ? '#' + top.id : '';
    const text = String((top.getAttribute && top.getAttribute('aria-label')) || top.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40);
    let position = '';
    try { position = getComputedStyle(top).position || ''; } catch (err) { position = ''; }
    const by = '<' + tag + id + '>' + (text ? ' "' + text + '"' : '');
    const fixed = position === 'fixed' || position === 'sticky';
    return { marker: marker, covered: true, by: by, byPosition: fixed ? position : '', x: px, y: py };
  }`;
}

async function ownerIframeCover(cdp, sid, backendNodeId, rect, frameRef) {
  if (!backendNodeId) throw crossSiteFrameBoxError(frameRef);
  const x = (Number(rect?.x) || 0) + (Number(rect?.w) || 0) / 2;
  const y = (Number(rect?.y) || 0) + (Number(rect?.h) || 0) / 2;
  const { object } = await cdpDomains(cdp).DOM.resolveNode({ backendNodeId }, sid);
  if (!object?.objectId) throw crossSiteFrameBoxError(frameRef);
  const res = await cdpDomains(cdp).Runtime.callFunctionOn({
    objectId: object.objectId,
    functionDeclaration: ownerIframeHitDeclaration(),
    arguments: [{ value: x }, { value: y }],
    returnByValue: true,
  }, sid);
  if (res?.exceptionDetails) throw new Error(runtimeExceptionMessage(res.exceptionDetails));
  const hit = res?.result?.value;
  if (!hit || typeof hit !== 'object') throw crossSiteFrameBoxError(frameRef);
  return hit;
}

function parentFrameOf(frame, frames) {
  if (!frame?.parentId || !Array.isArray(frames)) return null;
  return frames.find(item => item && item.id === frame.parentId) || null;
}

// A same-process frame nested in a cross-site frame shares that frame's child
// session. Its owner iframe is not in the page session: DOM.getFrameOwner there
// throws "No frame for given id found".
async function perceiveFrameOffset(cdp, sid, frame, frames) {
  const entry = {
    ...frame,
    frameRef: frame.ref,
    frameId: frame.id,
    frames,
  };
  if (frame?.process === 'oopif' && parentFrameOf(frame, frames)?.process === 'oopif') {
    const offset = await crossSiteFramePageOffset(cdp, sid, entry, frame.ref);
    return { x: offset.x, y: offset.y };
  }
  return frameViewportOffset(cdp, sid, entry);
}

export async function frameViewportOffset(cdp, sid, frameEntry, { settle = false } = {}) {
  if (!frameEntry?.frameId || !frameEntry.parentId) return { x: 0, y: 0 };
  let x = 0;
  let y = 0;
  let current = frameEntry;
  for (let guard = 0; current?.frameId && current.parentId && guard < 8; guard++) {
    const owner = await cdpDomains(cdp).DOM.getFrameOwner( { frameId: current.frameId }, sid);
    const { object } = await cdpDomains(cdp).DOM.resolveNode( { backendNodeId: owner.backendNodeId }, sid);
    const res = await cdpDomains(cdp).Runtime.callFunctionOn( {
      objectId: object.objectId,
      functionDeclaration: settle ? scrollSettledRectFunctionDeclaration() : `function() {
        const r = this.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
      }`,
      returnByValue: true,
      awaitPromise: settle,
    }, sid);
    const rect = res.result.value || {};
    x += Number(rect.x) || 0;
    y += Number(rect.y) || 0;
    const parent = (current.frames || []).find(frame => frame.id === current.parentId);
    if (!parent) break;
    current = {
      ...parent,
      frameRef: parent.ref,
      frameId: parent.id,
      frames: current.frames || [],
    };
  }
  return { x, y };
}
export async function resolveRefRectNoScroll(cdp, sid, refMap, ref, refState, options = {}) {
  const frameParsed = parseFrameRef(ref);
  const allowCrossSite = options.allowCrossSite === true;
  const objectId = options.objectId || await resolveRefNode(cdp, sid, refMap, ref, refState, { allowCrossSite });
  const nodeSid = resolvedNodeSession(cdp, sid, objectId);
  const result = await cdpDomains(cdp).Runtime.callFunctionOn( {
    objectId,
    functionDeclaration: options.functionDeclaration || `function() {
      const rect = this.getBoundingClientRect();
      const cs = (typeof getComputedStyle === 'function') ? getComputedStyle(this) : null;
      return {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
        tag: this.tagName,
        text: ${targetLabelExpression('this')},
        position: cs ? cs.position : '',
        pointerEvents: cs ? cs.pointerEvents : '',
        visible: !!(rect.width && rect.height),
      };
    }`,
    returnByValue: true,
  }, nodeSid, REF_RESOLVE_TIMEOUT);
  const value = result.result.value || {};
  if (options.functionDeclaration) return value;
  // offsetFrame false keeps the frame-local rect. The settle-timeout path places
  // it afterwards, through the one page-layer cover check.
  if (frameParsed && options.offsetFrame !== false) {
    const offset = await placeFrameRect(cdp, sid, refState, frameParsed, value, { allowCrossSite });
    return { rect: value, objectId, ownerBackendNodeId: offset.ownerBackendNodeId || 0 };
  }
  return { rect: value, objectId, ownerBackendNodeId: 0 };
}
// Wait for DOM mutations to stop after an action (350ms of silence = settled).
// Bound the CDP evaluate to the settle budget so a document replacement cannot
// hang until the default 15s CDP timeout.
export async function waitForSettle(cdp, sid, timeoutMs = 3000) {
  const budget = Math.max(1, Number(timeoutMs) || 3000);
  let timer;
  try {
    const outcome = await Promise.race([
      evalStr(cdp, sid, `new Promise(resolve => {
    let timer;
    const done = () => { obs.disconnect(); resolve('stable'); };
    const reset = () => { clearTimeout(timer); timer = setTimeout(done, 350); };
    const obs = new MutationObserver(reset);
    obs.observe(document.body || document.documentElement, { childList: true, subtree: true, attributes: true });
    timer = setTimeout(done, 350);
    setTimeout(() => { clearTimeout(timer); obs.disconnect(); resolve('timeout'); }, ${budget});
  })`, false, { timeoutMs: budget + 50 }),
      new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), budget); }),
    ]);
    return outcome === 'timeout' ? 'timeout' : String(outcome || 'stable');
  } catch {
    return 'stable';
  } finally {
    clearTimeout(timer);
  }
}
export async function waitForHoverDomChange(cdp, sid, timeoutMs = HOVER_MUTATION_TIMEOUT_MS) {
  // First MutationObserver callback from this hover, not 350ms of silence.
  // waitForSettle treats pre-hover idle as settled and recapture then writes
  // the idle AX tree (#286 live Chrome 151). Do not wait for mouseMoved ack.
  const budget = Math.max(1, Number(timeoutMs) || HOVER_MUTATION_TIMEOUT_MS);
  let timer;
  try {
    const outcome = await Promise.race([
      evalStr(cdp, sid, `new Promise(resolve => {
    const done = (value) => { obs.disconnect(); resolve(value); };
    const obs = new MutationObserver(() => done('hover-changed'));
    obs.observe(document.body || document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
    void ${JSON.stringify(HOVER_MUTATION_MARKER)};
    setTimeout(() => { obs.disconnect(); resolve('timeout'); }, ${budget});
  })`, false, { timeoutMs: budget + 50 }),
      new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), budget); }),
    ]);
    return String(outcome || '').includes('hover-changed') ? 'hover-changed' : 'timeout';
  } catch {
    return 'timeout';
  } finally {
    clearTimeout(timer);
  }
}
export function hoverRecaptureShowsChange(before, after) {
  if (before == null || after == null) return false;
  if (before === after) return false;
  return actionDomDiffShowsChange(formatPerceiveDiffOutput(stripPerceiveNodeIdentity(before), stripPerceiveNodeIdentity(after), { mode: 'since-action' }));
}
export function discardHoverIdleBaseline(lastPerceiveStore) {
  if (!lastPerceiveStore || typeof lastPerceiveStore !== 'object') return;
  lastPerceiveStore.output = null;
}
export function validateUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error(`Invalid URL: ${url}`); }
  if (parsed.protocol === 'file:') throw new Error(fileUrlRefusedMessage(url));
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Only http/https URLs allowed, got: ${parsed.protocol}`);
  }
  // Block cloud metadata endpoints (AWS/GCP/Azure IMDS)
  const host = parsed.hostname;
  const metadataIPs = ['169.254.169.254', '169.254.170.2', 'fd00:ec2::254'];
  const metadataHosts = ['metadata.google.internal', 'metadata.gke.internal'];
  if (metadataIPs.includes(host) || metadataHosts.includes(host)) {
    throw new Error(`Blocked: cloud metadata endpoint (${host})`);
  }
  // Block link-local range (169.254.x.x)
  if (/^169\.254\.\d+\.\d+$/.test(host)) {
    throw new Error(`Blocked: link-local address (${host})`);
  }
}
export function pickPrimaryScrollMetrics(candidates, opts) {
  const significancePx = opts && Number.isFinite(opts.significancePx) ? opts.significancePx : 80;
  if (!candidates || candidates.length === 0) {
    return { scrollY: 0, scrollMax: 0, source: 'document' };
  }
  function metric(candidate, fallbackSource) {
    const scrollHeight = Number(candidate && candidate.scrollHeight) || 0;
    const clientHeight = Number(candidate && candidate.clientHeight) || 0;
    const scrollTop = Number(candidate && candidate.scrollTop) || 0;
    return {
      scrollY: Math.round(scrollTop),
      scrollMax: Math.round(Math.max(0, scrollHeight - clientHeight)),
      source: (candidate && candidate.source) || fallbackSource,
    };
  }
  let best = metric(candidates[0], 'document');
  for (let i = 1; i < candidates.length; i++) {
    const next = metric(candidates[i], 'inner');
    if (best.scrollMax === 0 && next.scrollMax > 0) best = next;
    else if (next.scrollMax > best.scrollMax + significancePx) best = next;
  }
  return best;
}
export function axNodeRole(node) {
  return String(node?.role?.value || node?.role || '');
}
export function axNodeProp(node, name) {
  const props = node?.properties;
  if (!Array.isArray(props)) return undefined;
  for (const prop of props) {
    const propName = prop?.name?.value || prop?.name;
    if (propName === name) return prop?.value?.value ?? prop?.value;
  }
  return undefined;
}
export function isDomSearchFocus(focusedDesc) {
  if (!focusedDesc || focusedDesc === 'none') return false;
  const s = String(focusedDesc);
  if (!/^<(input|textarea)\b/i.test(s)) return false;
  const id = (s.match(/#([^>.\s]+)/) || [])[1] || '';
  const cls = (s.match(/\.([^>\s]+)/) || [])[1] || '';
  const tokens = `${id} ${cls}`.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return tokens.some(token => (
    token === 'search' || token === 'searchbox' || token === 'combobox'
    || token === 'typeahead' || token === 'autocomplete'
  ));
}
export function selectorTargetsTypeaheadInput(selector) {
  if (selector == null) return false;
  const s = String(selector).trim().toLowerCase();
  if (!s) return false;
  if (s === 'main' || s === 'article' || s === 'body' || s === 'html') return false;
  if (/^(main|article|body|html)[.#:>[]/.test(s)) return false;
  if (/\b(?:input|textarea|select)\b/.test(s)) return true;
  if (/\[role\s*=\s*['"]?(?:searchbox|combobox|textbox|listbox)\b/.test(s)) return true;
  if (/\b(?:searchbox|combobox|typeahead|autocomplete)\b/.test(s)) return true;
  if (/(?:^|[\s.#:[])search\b/.test(s)) return true;
  return false;
}
export function omitTypeaheadListboxNodes(nodes, opts = {}) {
  const list = Array.isArray(nodes) ? nodes : [];
  if (opts.keepTypeahead || selectorTargetsTypeaheadInput(opts.selector)) {
    return { nodes: list, omitted: false };
  }
  const focusedSearch = list.some(node => {
    const focused = axNodeProp(node, 'focused');
    return (focused === true || focused === 'true') && TYPEAHEAD_FOCUS_ROLES.has(axNodeRole(node));
  });
  if (!focusedSearch && !isDomSearchFocus(opts.focusedDesc)) {
    return { nodes: list, omitted: false };
  }
  const childrenByParent = new Map();
  for (const node of list) {
    if (!node?.parentId) continue;
    if (!childrenByParent.has(node.parentId)) childrenByParent.set(node.parentId, []);
    childrenByParent.get(node.parentId).push(node);
  }
  const omitIds = new Set();
  function markSubtree(nodeId) {
    if (omitIds.has(nodeId)) return;
    omitIds.add(nodeId);
    for (const child of (childrenByParent.get(nodeId) || [])) markSubtree(child.nodeId);
  }
  let foundPopup = false;
  for (const node of list) {
    if (!TYPEAHEAD_POPUP_ROLES.has(axNodeRole(node))) continue;
    foundPopup = true;
    markSubtree(node.nodeId);
  }
  if (!foundPopup) return { nodes: list, omitted: false };
  return { nodes: list.filter(node => !omitIds.has(node.nodeId)), omitted: true };
}
export function unknownPerceiveOption(token) {
  throw new Error(`unknown option ${token}\nperceive compact flags: ${PERCEIVE_COMPACT_FLAGS}`);
}
export function perceiveArgsIncludeSnapshotShape(args = []) {
  return args.some(token => PERCEIVE_SNAPSHOT_FLAGS.has(String(token)));
}
export function perceiveSnapshotOpts(opts = {}) {
  return {
    interactive: Boolean(opts.interactive),
    maxDepth: opts.maxDepth === undefined ? Infinity : opts.maxDepth,
    cursorInteractive: Boolean(opts.cursorInteractive),
    selector: opts.selector || null,
    exclude: opts.exclude || null,
    keepTypeahead: Boolean(opts.keepTypeahead),
    last: opts.last ?? null,
    adaptive: Boolean(opts.adaptive),
    cards: Boolean(opts.cards),
    frameRef: opts.frameRef || null,
  };
}
export function resolveSinceActionPerceiveOpts(popts = {}, lastAction = null, rawArgs = []) {
  if (!popts.sinceAction) return popts;
  const snapshot = lastAction?.baselineOpts;
  const userShaped = perceiveArgsIncludeSnapshotShape(rawArgs);
  return {
    ...popts,
    ...(userShaped || !snapshot ? {} : snapshot),
    sinceAction: true,
    keepTypeahead: true,
    diffBaseline: popts.diffBaseline ?? lastAction?.baselineOutput ?? null,
  };
}
export function parsePerceiveArgs(args) {
  const opts = {
    diff: false, selector: null, exclude: null,
    interactive: false, maxDepth: Infinity, cursorInteractive: false,
    keepRefs: false, keepTypeahead: false, last: null, adaptive: false, sinceAction: false, frameRef: null,
    cards: false, unsafeFull: false, verbose: false,
  };
  const requireValue = (flag, index, label) => {
    const value = args[index + 1];
    if (value === undefined || value === '' || String(value).startsWith('-')) {
      throw new Error(`${flag} requires ${label}`);
    }
    return value;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!String(a).startsWith('-')) continue;
    if (a === '--diff') opts.diff = true;
    else if (a === '--since-action') opts.sinceAction = true;
    else if (a === '--cards') opts.cards = true;
    else if (a === '--unsafe-full') opts.unsafeFull = true;
    else if (a === '--role') {
      const role = String(requireValue(a, i, 'a role')).trim().toLowerCase();
      i++;
      if (role === 'feed') opts.cards = true;
    } else if (a === '-F' || a === '--frame') {
      opts.frameRef = requireValue(a, i, 'a frame ref');
      i++;
    } else if (a === '-s' || a === '--selector') {
      opts.selector = requireValue(a, i, 'a CSS selector');
      i++;
    } else if (a === '-x' || a === '--exclude') {
      opts.exclude = requireValue(a, i, 'a CSS selector');
      i++;
    } else if (a === '-i' || a === '--interactive') opts.interactive = true;
    else if (a === '-d' || a === '--depth') {
      opts.maxDepth = parseInt(requireValue(a, i, 'a depth')) || Infinity;
      i++;
    } else if (a === '-C' || a === '--cursor-interactive') opts.cursorInteractive = true;
    else if (a === '--verbose' || a === '-v') opts.verbose = true;
    else if (a === '--keep-typeahead') opts.keepTypeahead = true;
    else if (a === '--keep-refs') opts.keepRefs = true;
    else if (a === '--adaptive') opts.adaptive = true;
    else if (a === '--last') {
      const raw = requireValue(a, i, 'N or auto');
      i++;
      if (raw === 'auto') {
        opts.last = 'auto';
        opts.adaptive = true;
      } else {
        const n = parseInt(raw);
        opts.last = Number.isFinite(n) && n > 0 ? n : null;
      }
    } else {
      unknownPerceiveOption(a);
    }
  }
  return opts;
}
/**
 * Choose a perceive text-row budget from density + error state.
 * Explicit numeric --last still wins; this is for --adaptive / --last auto.
 */
export function chooseAdaptivePerceiveLast({
  lineCount = 0,
  consoleErrors = 0,
  interactiveCount = 0,
  hasPriorityText = false,
} = {}) {
  let budget = 48;
  if (lineCount > 100) budget = 36;
  if (lineCount > 220) budget = 24;
  if (lineCount > 400) budget = 16;
  if (consoleErrors > 0 || hasPriorityText) budget = Math.max(budget, 28);
  if (interactiveCount > 40) budget = Math.min(budget, 22);
  if (interactiveCount > 80) budget = Math.min(budget, 16);
  return Math.max(8, Math.min(80, budget));
}
export function countsTowardPerceiveDepth(node) {
  const role = node.role?.value || '';
  return role !== 'none' && role !== 'generic' && role !== 'InlineTextBox';
}
export function isPerceiveBodyTextRole(role) {
  return role === 'StaticText' || role === 'paragraph' || role === 'heading';
}
export function perceiveCursorSurfaceLimit(opts = {}) {
  const defaultCap = PERCEIVE_CURSOR_SURFACE_DEFAULT_CAP;
  const { last = null, adaptive = false } = opts;
  if (Number.isFinite(last) && last > 0) return last;
  if (last === 'auto' || adaptive) {
    const budget = chooseAdaptivePerceiveLast({
      lineCount: Number(opts.lineCount || 0),
      consoleErrors: Number(opts.consoleErrors || 0),
      interactiveCount: Number(opts.interactiveCount || 0),
      hasPriorityText: Boolean(opts.hasPriorityText),
    });
    return Math.max(4, Math.min(defaultCap, Math.ceil(budget / 6)));
  }
  return defaultCap;
}
export function perceiveCursorItemSkipHaystack(item, nameOf) {
  const named = typeof nameOf === 'function' ? nameOf(item) : '';
  return [
    named,
    item?.label,
    item?.ariaLabel,
    item?.text,
    item?.title,
    item?.sel,
    item?.selector,
  ].filter(Boolean).join('\n');
}
export function isSearchListingHref(href) {
  const raw = String(href || '').trim();
  if (!raw) return false;
  let path = raw;
  let query = '';
  try {
    const parsed = raw.includes('://') ? new URL(raw) : new URL(raw, 'https://search-listing.invalid');
    path = parsed.pathname || '/';
    query = parsed.search || '';
  } catch {
    const q = raw.indexOf('?');
    if (q >= 0) {
      path = raw.slice(0, q);
      query = raw.slice(q);
    }
  }
  const params = new URLSearchParams(query.startsWith('?') ? query.slice(1) : query);
  const listingPath = /^\/(models|datasets|spaces|posts)?\/?$/i.test(path) || /\/search\/?$/i.test(path);
  return listingPath && (params.has('search') || params.has('q'));
}
export function isSearchListingText(text) {
  // "See 51552 model results" is a search listing. "See full election results" is not.
  return /\bsee\b[\s\S]{0,80}\b(?:model|dataset|space|post|search)\s+results\b/i.test(String(text || ''));
}
export function isSearchListingControl(item) {
  if (!item || typeof item !== 'object') return false;
  const href = item.href || '';
  const selector = item.selector || '';
  const hay = [item.label, item.text, item.ariaLabel, item.title, href, selector].filter(Boolean).join('\n');
  return isSearchListingHref(href) || isSearchListingHref(selector) || isSearchListingText(hay);
}
export function searchListingSelector(href) {
  const raw = String(href || '').trim();
  if (!raw) return 'a[href*="?search="]';
  try {
    const parsed = raw.includes('://') ? new URL(raw) : new URL(raw, 'https://search-listing.invalid');
    const relative = `${parsed.pathname}${parsed.search}`;
    return `a[href="${relative.replace(/"/g, '\\"')}"]`;
  } catch {
    return `a[href="${raw.replace(/"/g, '\\"')}"]`;
  }
}
export function rankSearchListingFirst(items) {
  const listing = [];
  const rest = [];
  for (const item of items || []) {
    (isSearchListingControl(item) ? listing : rest).push(item);
  }
  return listing.concat(rest);
}
export function searchListingHelpersSource() {
  return [
    isSearchListingHref,
    isSearchListingText,
    isSearchListingControl,
    searchListingSelector,
    rankSearchListingFirst,
  ].map(fn => Function.prototype.toString.call(fn)).join('\n');
}
export function rankPerceiveCursorItems(items, nameOf) {
  const listing = [];
  const skip = [];
  const rest = [];
  for (const item of items || []) {
    const hay = perceiveCursorItemSkipHaystack(item, nameOf);
    if (isSearchListingControl(item) || isSearchListingText(hay)) listing.push(item);
    else if (isSkipLinkName(hay)) skip.push(item);
    else rest.push(item);
  }
  return listing.concat(rest, skip);
}
export function parseControlsArgs(args) {
  const opts = { selector: null, filter: null, limit: 30, compact: false };
  const requireValue = (flag, label, index) => {
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`controls: ${flag} requires ${label}`);
    return value;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-s' || a === '--selector' || a === '--scope') {
      opts.selector = requireValue(a, 'a CSS selector', i);
      i++;
    } else if (a === '--filter' || a === '-f') {
      opts.filter = requireValue(a, 'text', i);
      i++;
    } else if (a === '--limit' || a === '-n') {
      const raw = requireValue(a, 'a positive integer', i);
      i++;
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) throw new Error(`controls: ${a} requires a positive integer`);
      opts.limit = Math.min(n, 100);
    } else if (a === '--compact' || a === '--summary') {
      opts.compact = true;
    } else {
      throw new Error(`controls: unknown argument ${a}`);
    }
  }
  return opts;
}
export function compactVisibleControlsModel(model = {}) {
  return {
    ...model,
    compact: true,
    controls: (model.controls || []).map(control => ({
      role: control.role || null,
      label: control.label || null,
      selector: control.selector || null,
      disabled: Boolean(control.disabled),
      clickable: Boolean(control.clickable),
      rect: control.rect || null,
    })),
  };
}
export function visibleControlsCollectorSource() {
  return String.raw`
      function chromeCdpVisibleControls(options) {
` + searchListingHelpersSource() + String.raw`
        const vw = window.innerWidth || 0;
        const vh = window.innerHeight || 0;
        const limit = Math.max(1, Math.min(Number(options.limit) || 30, 100));
        const scope = options.selector || null;
        const filter = options.filter ? String(options.filter).toLowerCase() : null;
        const schema = 'chrome-cdp-ex.visible-controls.v1';
        let root = document;
        if (scope) {
          try {
            root = document.querySelector(scope);
          } catch (err) {
            return { schema, scope, filter: options.filter || null, limit, total: 0, returned: 0, truncated: false, controls: [], error: 'invalid-selector', message: String(err && err.message || err || 'Invalid selector') };
          }
        }
        if (!root) {
          return { schema, scope, filter: options.filter || null, limit, total: 0, returned: 0, truncated: false, controls: [], error: 'scope-not-found' };
        }

        const interactiveRoles = new Set(['button', 'link', 'menuitem', 'option', 'checkbox', 'radio', 'switch', 'tab', 'textbox', 'combobox', 'searchbox']);
        const nativeInteractive = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY']);
        const selector = [
          'a', 'button', 'input', 'select', 'textarea', 'summary',
          '[role="button"]', '[role="link"]', '[role="menuitem"]', '[role="option"]',
          '[role="checkbox"]', '[role="radio"]', '[role="switch"]', '[role="tab"]',
          '[role="textbox"]', '[role="combobox"]', '[role="searchbox"]',
          '[role]', '[contenteditable="true"]', '[onclick]', '[tabindex]',
          '[aria-label]', '[title]',
          'div', 'span', 'li', 'label', 'svg', 'img'
        ].join(',');

        function esc(value) {
          const text = String(value || '');
          return window.CSS && CSS.escape ? CSS.escape(text) : text.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
        }

        function compactText(value, max = 60) {
          return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
        }

        function roleFor(el) {
          const explicit = el.getAttribute('role');
          if (explicit) {
            const tokens = String(explicit).trim().toLowerCase().split(/\s+/).filter(Boolean);
            return tokens.find(token => interactiveRoles.has(token)) || tokens[0] || '';
          }
          const tag = el.tagName.toLowerCase();
          if (tag === 'a') return 'link';
          if (tag === 'button') return 'button';
          if (tag === 'textarea') return 'textbox';
          if (tag === 'select') return 'combobox';
          if (tag === 'input') {
            const type = String(el.getAttribute('type') || 'text').toLowerCase();
            if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
            if (['checkbox', 'radio'].includes(type)) return type;
            return 'textbox';
          }
          return '';
        }

        function selectorFor(el) {
          const tag = el.tagName.toLowerCase();
          if (tag === 'a') {
            const href = el.getAttribute('href') || '';
            if (isSearchListingHref(href) || isSearchListingText(el.textContent || '')) {
              return searchListingSelector(href);
            }
          }
          if (el.id) return tag + '#' + esc(el.id);
          const aria = el.getAttribute('aria-label');
          if (aria) return tag + '[aria-label="' + String(aria).replace(/"/g, '\\"') + '"]';
          const title = el.getAttribute('title');
          if (title) return tag + '[title="' + String(title).replace(/"/g, '\\"') + '"]';
          if (typeof el.className === 'string' && el.className.trim()) {
            return tag + el.className.trim().split(/\s+/).slice(0, 2).map(c => '.' + esc(c)).join('');
          }
          return tag;
        }

        function nearestScrollable(el) {
          for (let parent = el.parentElement; parent && parent !== document.documentElement && parent !== document.body; parent = parent.parentElement) {
            const style = window.getComputedStyle(parent);
            const overflow = (style.overflowX || '') + ' ' + (style.overflowY || '');
            const clips = /(auto|scroll|hidden|clip)/.test(overflow);
            const scrollable = parent.scrollWidth > parent.clientWidth + 1 || parent.scrollHeight > parent.clientHeight + 1;
            if (clips && scrollable) return parent;
          }
          return null;
        }

        function isScrollportClipped(el, rect) {
          const container = nearestScrollable(el);
          if (!container) return false;
          const pr = container.getBoundingClientRect();
          const top = Math.max(rect.top, pr.top);
          const left = Math.max(rect.left, pr.left);
          const bottom = Math.min(rect.bottom, pr.bottom);
          const right = Math.min(rect.right, pr.right);
          const visibleW = Math.max(0, right - left);
          const visibleH = Math.max(0, bottom - top);
          // Fully (or nearly) clipped by an overflow ancestor → not actionable for hit-testing.
          return visibleW < 2 || visibleH < 2;
        }

        function isVisible(rect, cs) {
          if (!rect || rect.width < 4 || rect.height < 4) return false;
          if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
          return rect.bottom >= 0 && rect.right >= 0 && rect.top <= vh && rect.left <= vw;
        }

        function isClickable(el, cs, role) {
          const tagInteractive = nativeInteractive.has(el.tagName);
          const roleInteractive = interactiveRoles.has(role);
          return tagInteractive || roleInteractive || cs.cursor === 'pointer' || el.hasAttribute('onclick') || (el.hasAttribute('tabindex') && el.tabIndex >= 0);
        }

        const controls = [];
        const seen = new Set();
        const candidates = [];
        if (root.matches && root.matches(selector)) candidates.push(root);
        if (root.querySelectorAll) candidates.push(...root.querySelectorAll(selector));
        for (const el of candidates) {
          const cs = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          if (!isVisible(rect, cs)) continue;
          if (isScrollportClipped(el, rect)) continue;
          const role = roleFor(el);
          const clickable = isClickable(el, cs, role);
          const ariaLabel = compactText(el.getAttribute('aria-label'));
          const title = compactText(el.getAttribute('title'));
          const text = compactText(el.innerText || el.textContent || el.getAttribute('placeholder') || el.getAttribute('value'));
          const label = ariaLabel || title || text || role || el.tagName.toLowerCase();
          if (!clickable && !ariaLabel && !title) continue;
          const path = selectorFor(el);
          const key = path + '|' + Math.round(rect.left) + ',' + Math.round(rect.top);
          if (seen.has(key)) continue;
          seen.add(key);
          const haystack = [el.tagName, role, ariaLabel, title, text, path, el.id, el.className].join(' ').toLowerCase();
          if (filter && !haystack.includes(filter)) continue;
          const classes = typeof el.className === 'string'
            ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 3)
            : [];
          controls.push({
            tag: el.tagName.toLowerCase(),
            role,
            ariaLabel,
            title,
            label,
            text,
            href: el.tagName === 'A' ? (el.getAttribute('href') || '') : '',
            disabled: Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true',
            clickable,
            rect: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) },
            selector: path,
            hints: { id: el.id || '', classes },
          });
        }
        const ranked = rankSearchListingFirst(controls);
        const total = ranked.length;
        return {
          schema,
          scope,
          filter: options.filter || null,
          limit,
          total,
          returned: Math.min(total, limit),
          truncated: total > limit,
          controls: ranked.slice(0, limit),
        };
      }
  `;
}
export function visibleControlsPageScript(opts = {}) {
  const options = {
    selector: opts.selector || null,
    filter: opts.filter || null,
    limit: opts.limit || 30,
  };
  return `(function() {
${visibleControlsCollectorSource()}
      return JSON.stringify(chromeCdpVisibleControls(${JSON.stringify(options)}));
    })()`;
}
export function formatPerceiveCoordsLine(verbose = false) {
  return verbose ? PERCEIVE_COORDS_LINE_VERBOSE : PERCEIVE_COORDS_LINE;
}
// Drop a line only when that whole line was already printed. A remaining line
// keeps every field formatVisibleControlLine emitted.
export function dedupeRepeatedLines(lines, priorLines = []) {
  const seen = new Set();
  const remember = (line) => {
    const key = String(line || '').trim();
    if (key) seen.add(key);
  };
  for (const line of priorLines) remember(line);
  const out = [];
  for (const line of lines) {
    const key = String(line || '').trim();
    if (!key) {
      out.push(line);
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}
export function formatVisibleControlsHeader({ shown, collected, pageTruncated }) {
  if (pageTruncated) return `[Visible controls] (${shown} shown; --last N for more)`;
  if (collected > shown) return `[Visible controls] (${shown}/${collected} shown; --last ${collected} for all)`;
  return '[Visible controls]';
}
export function formatVisibleControlLine(control, index = null) {
  const role = control.role ? ` role=${control.role}` : '';
  const aria = control.ariaLabel ? ` aria-label="${control.ariaLabel}"` : '';
  const title = control.title && control.title !== control.label ? ` title="${control.title}"` : '';
  const label = control.label ? ` "${control.label}"` : '';
  const state = [
    control.clickable ? 'clickable' : null,
    control.disabled ? 'disabled' : null,
  ].filter(Boolean);
  const stateText = state.length ? ` [${state.join(',')}]` : '';
  const rect = control.rect ? ` (${control.rect.x},${control.rect.y} ${control.rect.w}×${control.rect.h})` : '';
  const ref = control.ref ? ` ${control.ref}` : '';
  const hints = [];
  if (control.hints?.id) hints.push(`#${control.hints.id}`);
  for (const cls of control.hints?.classes || []) hints.push(`.${cls}`);
  const hintText = hints.length ? ` ${hints.join('')}` : '';
  const prefix = index == null ? '' : `${index}. `;
  return `${prefix}${control.tag || '?'}${role}${aria}${title}${label}${stateText}${rect}${ref} ${control.selector || ''}${hintText}`.trimEnd();
}
export function offsetCssRect(rect, offset) {
  if (!rect || typeof rect !== 'object') return rect;
  const dx = Number(offset?.x) || 0;
  const dy = Number(offset?.y) || 0;
  if (!dx && !dy) return rect;
  const next = { ...rect };
  if (rect.x != null) next.x = (Number(rect.x) || 0) + dx;
  if (rect.y != null) next.y = (Number(rect.y) || 0) + dy;
  return next;
}
export function offsetCursorInteractiveItem(item, offset) {
  if (!item || typeof item !== 'object') return item;
  const dx = Number(offset?.x) || 0;
  const dy = Number(offset?.y) || 0;
  if (!dx && !dy) return item;
  return {
    ...item,
    x: (Number(item.x) || 0) + dx,
    y: (Number(item.y) || 0) + dy,
    ...(item.rect ? { rect: offsetCssRect(item.rect, offset) } : {}),
  };
}
export function nativeVisibleControlTag(tag) {
  return new Set(['a', 'button', 'input', 'select', 'textarea']).has(String(tag || '').toLowerCase());
}
export function refAnnotationsFromTreeLines(treeLines = []) {
  const out = [];
  for (const line of treeLines) {
    const text = String(line || '');
    const match = text.match(/\[([^\]]+)\](?:\s+(.*?))?\s+@((?:f\d+:)?\d+)(?:\s+\((-?\d+),(-?\d+) (\d+)×(\d+)\))?/);
    if (!match) continue;
    const name = String(match[2] || '').replace(/\s+=\s+\S.*$/, '').replace(/\s+(?:checked|pressed|expanded)=\S.*$/, '').trim();
    const idHint = name.split(/\s+/).find(Boolean) || '';
    out.push({
      role: match[1],
      name,
      id: idHint,
      selector: idHint ? `#${idHint}` : '',
      ref: `@${match[3]}`,
      x: match[4] != null ? Number(match[4]) : null,
      y: match[5] != null ? Number(match[5]) : null,
      w: match[6] != null ? Number(match[6]) : null,
      h: match[7] != null ? Number(match[7]) : null,
    });
  }
  return out;
}
export function visibleControlLabelIsGeneric(control) {
  const label = String(control?.label || '').trim().toLowerCase();
  if (!label) return true;
  const role = String(control?.role || '').trim().toLowerCase();
  const tag = String(control?.tag || '').trim().toLowerCase();
  return label === role || label === tag;
}
export function axRefNumber(ref) {
  const match = String(ref || '').match(/^@(?:f\d+:)?(\d+)$/);
  return match ? Number(match[1]) : null;
}
// Ref number → { role, name } taken from the AX node, so a value/checked
// suffix on the printed dump cannot become the accessible name (#579).
export function axIdentityByRefMap(axNodes, refMap) {
  const byBackend = new Map();
  for (const node of axNodes || []) {
    const backendId = node?.backendDOMNodeId;
    if (backendId == null || byBackend.has(backendId)) continue;
    byBackend.set(backendId, {
      role: axNodeRole(node),
      name: String(axNodeAccessibleName(node) || '').trim(),
    });
  }
  const byRef = new Map();
  if (!refMap || typeof refMap.entries !== 'function') return byRef;
  for (const [ref, backendId] of refMap.entries()) {
    if (!Number.isInteger(ref)) continue;
    const identity = byBackend.get(backendId);
    if (identity) byRef.set(ref, identity);
  }
  return byRef;
}
export function axIdentityForVisibleControl(annotation, identities) {
  const parsedRole = String(annotation?.role || '').trim();
  const parsedName = String(annotation?.name || '').trim();
  const ref = axRefNumber(annotation?.ref);
  const fromNode = ref != null && identities && typeof identities.get === 'function'
    ? identities.get(ref)
    : null;
  if (!fromNode) return { role: parsedRole, name: parsedName };
  return {
    role: String(fromNode.role || '').trim() || parsedRole,
    name: fromNode.name == null ? parsedName : String(fromNode.name).trim(),
  };
}
export function visibleControlAnnotationMatches(control, annotations) {
  const id = String(control.hints?.id || '').trim();
  const selector = String(control.selector || '').trim();
  const byIdentity = annotations.filter(item => {
    if (id && (item.id === id || item.selector === `#${id}` || String(item.name || '') === id)) return true;
    if (selector && item.selector && (item.selector === selector || selector.endsWith(item.selector))) return true;
    return false;
  });
  if (byIdentity.length) return byIdentity;
  if (!control.rect) return [];
  const { x, y, w, h } = control.rect;
  return annotations.filter(item => (
    item.x != null
    && Math.abs(item.x - x) <= 1
    && Math.abs(item.y - y) <= 1
    && Math.abs(item.w - w) <= 1
    && Math.abs(item.h - h) <= 1
  ));
}
export function withVisibleControlAxIdentity(control, annotation, identities) {
  const { role, name } = axIdentityForVisibleControl(annotation, identities);
  const next = { ...control, ref: annotation.ref };
  const previousRole = String(control?.role || '').trim().toLowerCase();
  const generic = visibleControlLabelIsGeneric(control);
  if (role) next.role = role;
  // Replace only the collector's role/tag fallback ("textbox"). A real label
  // stays, so a rect that happens to hit another AX node cannot rewrite
  // cap-swap sample names (#299). The fallback is what looks like a missing
  // label (#579).
  if (!generic) return next;
  if (name) next.label = name.replace(/\s+/g, ' ').trim();
  else if (role && role.toLowerCase() !== previousRole) next.label = '';
  return next;
}
export function attachRefToVisibleControl(control, annotations = [], identities = null) {
  if (!control || !annotations.length) return control;
  const matches = visibleControlAnnotationMatches(control, annotations);
  if (!matches.length) return control;
  const matched = matches[0];
  if (matches.length !== 1) return { ...control, ref: matched.ref };
  return withVisibleControlAxIdentity(control, matched, identities);
}
export function axRoleForDomControl(control = {}) {
  const tag = String(control.tag || '').toLowerCase();
  const type = String(control.type || '').toLowerCase();
  if (tag === 'a') return 'link';
  if (tag === 'button') return 'button';
  if (tag === 'textarea') return 'textbox';
  if (tag === 'select') return control.multiple ? 'listbox' : 'combobox';
  if (tag === 'input') {
    if (type === 'checkbox' || type === 'radio') return type;
    if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
    return 'textbox';
  }
  return control.role || 'generic';
}
export function syntheticAxNodeFromDomControl(control, nodeId) {
  const role = control.role || axRoleForDomControl(control);
  const node = {
    nodeId,
    role: { value: role },
    name: { value: control.name || control.id || '' },
    backendDOMNodeId: control.backendNodeId,
  };
  if (control.parentId) node.parentId = control.parentId;
  if (control.value != null && control.value !== '') node.value = { value: control.value };
  if (control.checked === true || control.checked === false) node.checked = { value: control.checked };
  if (Array.isArray(control.selected) && control.selected.length) {
    node.value = { value: control.selected.join(', ') };
  }
  return node;
}
export function isSynthesizableDomControl(control = {}) {
  const tag = String(control.tag || '').toLowerCase();
  if (!nativeVisibleControlTag(tag)) return false;
  const type = String(control.type || '').toLowerCase();
  if (type === 'hidden') return false;
  if (control.hidden === true) return false;
  const display = String(control.display || '').toLowerCase();
  const visibility = String(control.visibility || '').toLowerCase();
  if (display === 'none' || visibility === 'hidden') return false;
  return true;
}
export function shouldSynthesizeMissingFrameInteractives(frame, axNodes = [], listed = []) {
  if (!frame) return false;
  const candidates = (listed || []).filter(isSynthesizableDomControl);
  if (!candidates.length) return false;
  return candidates.length > axInteractiveBackendCount(axNodes);
}
export function mergeMissingDomInteractiveAxNodes(axNodes = [], domControls = []) {
  const have = new Set(
    (axNodes || [])
      .map(node => node?.backendDOMNodeId)
      .filter(id => id != null),
  );
  const extras = [];
  let index = 0;
  for (const control of domControls || []) {
    if (!isSynthesizableDomControl(control)) continue;
    if (control?.backendNodeId == null || have.has(control.backendNodeId)) continue;
    index += 1;
    extras.push(syntheticAxNodeFromDomControl(control, `dom-interactive-${index}`));
  }
  if (!extras.length) return axNodes || [];
  const nodes = (axNodes || []).map(node => (node?.childIds ? { ...node, childIds: [...node.childIds] } : { ...node }));
  const root = nodes.find(node => !node.parentId);
  if (root) {
    root.childIds = [...(root.childIds || []), ...extras.map(node => node.nodeId)];
    for (const extra of extras) extra.parentId = root.nodeId;
  }
  return [...nodes, ...extras];
}
export function countedInteractiveElements(counts = {}) {
  return Object.values(counts).reduce((sum, value) => sum + (Number(value) || 0), 0);
}
export function axInteractiveBackendCount(axNodes = []) {
  const ids = new Set();
  for (const node of axNodes) {
    const role = node?.role?.value || '';
    if (!INTERACTIVE_ROLES.has(role) || node.backendDOMNodeId == null) continue;
    ids.add(node.backendDOMNodeId);
  }
  return ids.size;
}
export function domInteractiveListScript() {
  return `(function() {
    const chromeCdpDomInteractiveList = true;
    const els = Array.from(document.querySelectorAll('a, button, input, select, textarea'));
    const out = [];
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      const tag = el.tagName.toLowerCase();
      const type = String(el.type || '').toLowerCase();
      const cs = window.getComputedStyle(el);
      const hidden = Boolean(el.hidden)
        || el.getAttribute('hidden') != null
        || type === 'hidden'
        || cs.display === 'none'
        || cs.visibility === 'hidden';
      if (hidden) continue;
      let role = tag;
      if (tag === 'a') role = 'link';
      else if (tag === 'button') role = 'button';
      else if (tag === 'textarea') role = 'textbox';
      else if (tag === 'select') role = el.multiple ? 'listbox' : 'combobox';
      else if (tag === 'input') {
        if (type === 'checkbox' || type === 'radio') role = type;
        else if (['button', 'submit', 'reset', 'image'].includes(type)) role = 'button';
        else role = 'textbox';
      }
      out.push({
        chromeCdpDomInteractiveList: true,
        index: i,
        tag: tag,
        type: type,
        id: el.id || '',
        name: String(el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || el.id || '').slice(0, 80),
        value: el.value || '',
        checked: el.checked === true,
        multiple: tag === 'select' ? Boolean(el.multiple) : false,
        selected: tag === 'select' ? Array.from(el.selectedOptions || []).map(opt => opt.value) : null,
        role: role,
        hidden: false,
        display: cs.display,
        visibility: cs.visibility
      });
    }
    return JSON.stringify(out);
  })()`;
}
export async function listDomInteractiveControls(cdp, sid, { contextId = null, limit = 40 } = {}) {
  let listed = [];
  try {
    const raw = await evalStr(cdp, sid, domInteractiveListScript(), false, contextId != null ? { contextId } : {});
    listed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(listed) || listed.length === 0) return [];
  const capped = listed.filter(isSynthesizableDomControl).slice(0, Math.max(1, Math.min(Number(limit) || 40, 80)));
  return capped;
}
export async function collectDomInteractiveControls(cdp, sid, { contextId = null, limit = 40, listed = null } = {}) {
  const candidates = listed || await listDomInteractiveControls(cdp, sid, { contextId, limit });
  if (!Array.isArray(candidates) || candidates.length === 0) return [];
  const out = [];
  for (const item of candidates) {
    try {
      const params = {
        expression: `document.querySelectorAll('a, button, input, select, textarea')[${Number(item.index) || 0}]`,
        returnByValue: false,
        awaitPromise: false,
      };
      if (contextId != null) params.contextId = contextId;
      const remote = await cdpDomains(cdp).Runtime.evaluate(params, sid);
      const objectId = remote?.result?.objectId;
      if (!objectId) continue;
      const described = await cdpDomains(cdp).DOM.describeNode({ objectId }, sid);
      const backendNodeId = described?.node?.backendNodeId;
      if (backendNodeId == null) continue;
      out.push({ ...item, backendNodeId });
    } catch {
      // Best-effort: AX dump still renders whatever Chrome already exposed.
    }
  }
  return out;
}
export function formatVisibleControlsText(model) {
  if (model.error === 'scope-not-found') {
    return `Visible controls: scope not found (${model.scope})`;
  }
  const scope = model.scope ? ` in ${model.scope}` : '';
  const filter = model.filter ? ` matching "${model.filter}"` : '';
  const suffix = model.truncated ? ` (truncated to ${model.limit})` : '';
  const lines = [`Visible controls: ${model.returned}/${model.total}${scope}${filter}${suffix}`];
  if (!model.controls?.length) {
    lines.push('  none');
    return lines.join('\n');
  }
  model.controls.forEach((control, index) => {
    lines.push(`  ${formatVisibleControlLine(control, index + 1)}`);
  });
  return lines.join('\n');
}
export async function controlsStr(cdp, sid, opts = {}) {
  const result = await cdpDomains(cdp).Runtime.evaluate( {
    expression: visibleControlsPageScript(opts),
    returnByValue: true,
    awaitPromise: false,
  }, sid);
  if (result.exceptionDetails) {
    throw new Error(runtimeExceptionMessage(result.exceptionDetails));
  }
  const raw = result.result?.value ?? '{}';
  const model = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (model.error === 'invalid-selector') {
    throw new Error(`controls: invalid selector: ${model.scope}${model.message ? ` (${model.message})` : ''}`);
  }
  if (model.error === 'scope-not-found') {
    throw new Error(`controls: selector not found: ${model.scope}`);
  }
  const outputModel = opts.compact ? compactVisibleControlsModel(model) : model;
  return opts.format === 'json' ? formatJson(outputModel) : formatVisibleControlsText(outputModel);
}
export function collectDomBackendNodeIds(node, out = new Set()) {
  if (!node || typeof node !== 'object') return out;
  const backendNodeId = node.backendNodeId ?? node.backendDOMNodeId;
  if (backendNodeId != null) out.add(backendNodeId);
  for (const key of ['children', 'shadowRoots', 'pseudoElements', 'distributedNodes']) {
    for (const child of node[key] || []) collectDomBackendNodeIds(child, out);
  }
  if (node.contentDocument) collectDomBackendNodeIds(node.contentDocument, out);
  if (node.templateContent) collectDomBackendNodeIds(node.templateContent, out);
  return out;
}
export function filterAxNodesToBackendSubtree(axNodes, backendNodeIds) {
  if (!backendNodeIds || backendNodeIds.size === 0) return axNodes;
  const nodesById = new Map(axNodes.map(n => [n.nodeId, n]));
  const includeCache = new Map();
  function included(node) {
    if (!node) return false;
    if (includeCache.has(node.nodeId)) return includeCache.get(node.nodeId);
    let value = false;
    if (node.backendDOMNodeId != null && backendNodeIds.has(node.backendDOMNodeId)) {
      value = true;
    } else if (node.parentId) {
      value = included(nodesById.get(node.parentId));
    }
    includeCache.set(node.nodeId, value);
    return value;
  }
  return axNodes.filter(included);
}
export function axRoleValue(node) {
  const role = node?.role;
  if (typeof role === 'string') return role.toLowerCase();
  if (role && typeof role.value === 'string') return role.value.toLowerCase();
  return '';
}
export function isMainLandmarkRole(role) {
  const value = String(role || '').toLowerCase();
  return value === 'main' || value === 'article';
}
export function parseDomAttributeMap(attributes) {
  const map = Object.create(null);
  if (!Array.isArray(attributes)) return map;
  for (let i = 0; i + 1 < attributes.length; i += 2) {
    map[String(attributes[i]).toLowerCase()] = String(attributes[i + 1]);
  }
  return map;
}
export function isMainContentDomNode(node) {
  if (!node || typeof node !== 'object') return false;
  const name = String(node.nodeName || node.localName || '').toLowerCase();
  if (name === 'main' || name === 'article') return true;
  const attrs = parseDomAttributeMap(node.attributes);
  const role = String(attrs.role || '').toLowerCase();
  if (role === 'main' || role === 'article') return true;
  const className = String(attrs.class || attrs.classname || '');
  return className.split(/\s+/).includes('mdx-content');
}
export function walkDescribedDomNodes(node, visit) {
  if (!node || typeof node !== 'object') return;
  visit(node);
  for (const key of ['children', 'shadowRoots', 'pseudoElements', 'distributedNodes']) {
    for (const child of node[key] || []) walkDescribedDomNodes(child, visit);
  }
  if (node.contentDocument) walkDescribedDomNodes(node.contentDocument, visit);
  if (node.templateContent) walkDescribedDomNodes(node.templateContent, visit);
}
export function domNodeContainsMainContent(node) {
  let found = false;
  walkDescribedDomNodes(node, child => {
    if (!found && isMainContentDomNode(child)) found = true;
  });
  return found;
}
export function axChildrenByParent(axNodes) {
  const childMap = new Map();
  for (const n of axNodes || []) {
    if (!n?.parentId) continue;
    if (!childMap.has(n.parentId)) childMap.set(n.parentId, []);
    childMap.get(n.parentId).push(n);
  }
  return childMap;
}
export function axNodeOrDescendantIsMainLandmark(node, childMap) {
  if (!node) return false;
  if (isMainLandmarkRole(axRoleValue(node))) return true;
  for (const child of childMap.get(node.nodeId) || []) {
    if (axNodeOrDescendantIsMainLandmark(child, childMap)) return true;
  }
  return false;
}
export function describedNodeForBackendId(describedNodesByBackendId, backendNodeId) {
  if (!describedNodesByBackendId) return null;
  if (describedNodesByBackendId instanceof Map) return describedNodesByBackendId.get(backendNodeId) || null;
  return describedNodesByBackendId[backendNodeId] || null;
}
export function shouldPreserveExcludedBackendNode(backendNodeId, axNodes, describedNodesByBackendId, childMap) {
  const ax = (axNodes || []).find(n => n.backendDOMNodeId === backendNodeId);
  if (ax && axNodeOrDescendantIsMainLandmark(ax, childMap)) return true;
  const described = describedNodeForBackendId(describedNodesByBackendId, backendNodeId);
  return Boolean(described && domNodeContainsMainContent(described));
}
export function filterAxNodesByExcludedBackendIds(axNodes, excludedBackendNodeIds) {
  const excludedAxIds = new Set();
  for (const n of axNodes) {
    if (n.backendDOMNodeId && excludedBackendNodeIds.has(n.backendDOMNodeId)) excludedAxIds.add(n.nodeId);
  }
  if (excludedAxIds.size === 0) return axNodes;
  const childIdsByParent = new Map();
  for (const n of axNodes) {
    if (!n.parentId) continue;
    if (!childIdsByParent.has(n.parentId)) childIdsByParent.set(n.parentId, []);
    childIdsByParent.get(n.parentId).push(n.nodeId);
  }
  const queue = [...excludedAxIds];
  while (queue.length) {
    const id = queue.pop();
    for (const child of (childIdsByParent.get(id) || [])) {
      excludedAxIds.add(child);
      queue.push(child);
    }
  }
  return axNodes.filter(n => !excludedAxIds.has(n.nodeId));
}
export function filterPerceiveExcludedAxNodes(axNodes, excludedBackendNodeIds, describedNodesByBackendId) {
  if (!excludedBackendNodeIds || excludedBackendNodeIds.size === 0) return axNodes;
  const childMap = axChildrenByParent(axNodes);
  const safeExcluded = new Set();
  for (const id of excludedBackendNodeIds) {
    if (shouldPreserveExcludedBackendNode(id, axNodes, describedNodesByBackendId, childMap)) continue;
    safeExcluded.add(id);
  }
  return filterAxNodesByExcludedBackendIds(axNodes, safeExcluded);
}
export function perceiveInteractiveNoiseHint(count) {
  return `(Hint: ${count} interactive elements found — most may be sidebar/nav noise. Exclude must not empty main; prefer \`text --auto\` or \`perceive -s main\`. \`perceive -x "nav, aside"\` only drops chrome that does not wrap main.)`;
}
export function parsePerceiveHeader(output) {
  const lines = String(output || '').split('\n');
  const pageMatch = (lines[0] || '').match(/^Page: (.*) — (.*)$/);
  const viewportMatch = (lines[1] || '').match(/^Viewport: (\d+)×(\d+) \| Scroll: (\d+)\/(\d+)/);
  const consoleLine = lines.find(line => line.startsWith('Console: ')) || 'Console: clean';
  const consoleHealth = { errors: 0, warnings: 0, exceptions: 0 };
  for (const [key, pattern] of [
    ['errors', /(\d+) errors?/],
    ['warnings', /(\d+) warnings?/],
    ['exceptions', /(\d+) exceptions?/],
  ]) {
    const match = consoleLine.match(pattern);
    if (match) consoleHealth[key] = Number(match[1]);
  }
  return {
    page: {
      title: pageMatch ? pageMatch[1] : '',
      url: pageMatch ? pageMatch[2] : '',
    },
    viewport: {
      width: viewportMatch ? Number(viewportMatch[1]) : 0,
      height: viewportMatch ? Number(viewportMatch[2]) : 0,
      scrollY: viewportMatch ? Number(viewportMatch[3]) : 0,
      scrollMax: viewportMatch ? Number(viewportMatch[4]) : 0,
      coordinateSpace: 'viewport-css-px',
    },
    console: consoleHealth,
  };
}
export function stripPerceiveRectChrome(line) {
  // Viewport-CSS @ref / Visible-control suffixes (`(24,180 160×22)`,
  // `(8,80 80×24, fixed)`) move on every scroll even when AX identities
  // are unchanged (#295). Identity compare ignores that chrome; displayed
  // leftover dumps still include the live rects.
  return String(line || '').replace(/\s+\(-?\d+,-?\d+ \d+×\d+(?:, [^)]+)?\)/g, '');
}
export function stripPerceiveSelectorChrome(line) {
  // Title-only Visible-control dump lines reprint the quoted name as
  // `span[title="…"]` / `time[title="…"]` plus trailing CSS class hints
  // (` .mx-2.text-green-500.dark:text-green-600`). That duplicated
  // selector+class chrome is identity chrome (#303), like rects / fold tags.
  // Displayed leftover dumps still include the live selectors.
  return String(line || '')
    .replace(/\s+[a-z][\w-]*\[(?:title|aria-label)="[^"]*"\]/gi, '')
    .replace(/\s+(?:\.[^\s]+)+$/g, '');
}
// A FRAME CONTENT marker carries a new nonce on every output. The printed
// tree keeps that nonce. Identity compare treats it as chrome so an unchanged
// page does not look edited. Escaped marker text inside the block is page
// content and stays in the key.
const FRAME_CONTENT_NONCE_RE = /^(\s*--- (?:FRAME CONTENT \(untrusted\) origin=\S+|END FRAME CONTENT) )nonce=[0-9a-f]{32}( ---)$/;
function stripFrameContentNonce(line) {
  return String(line ?? '').replace(FRAME_CONTENT_NONCE_RE, '$1nonce=<nonce>$2');
}
export function stripPerceiveIdentityChrome(line) {
  // Fold tags (`↑above fold` / `↓below fold`) are viewport chrome on the
  // same landmark identity (#297). Title-only selector+class chrome is
  // identity chrome (#303). Do not strip Visible-control membership.
  return stripFrameContentNonce(stripPerceiveSelectorChrome(
    stripPerceiveRectChrome(line).replace(/\s+[↑↓](?:above|below) fold\b/g, ''),
  ));
}
export function isVisibleControlsSectionHeader(line) {
  return /^\s*\[Visible controls\]/.test(String(line || ''));
}
export function isVisibleControlDumpLine(line) {
  const text = String(line || '').trim();
  if (!text || text.startsWith('[') || text.startsWith('...')) return false;
  if (!/^(?:[a-z][\w-]*|\?)\b/i.test(text)) return false;
  return /\brole=/.test(text) || /\[(?:clickable|disabled)\b/.test(text);
}
export function isVisibleControlStructuralLine(line) {
  return isVisibleControlsSectionHeader(line) || isVisibleControlDumpLine(line);
}
export function isPerceiveDecorativeTitleChrome(line) {
  // Collector includes `[title]` even when the node is not clickable.
  // After identity-chrome strip those rows are `span "…"` / `time "Fri, … GMT"`.
  // They are signed-commit / timestamp chrome, not a file / heading / link (#303).
  const text = stripPerceiveIdentityChrome(line).trim();
  if (!text || isVisibleControlsSectionHeader(text) || isVisibleControlDumpLine(text)) return false;
  if (/^\[/.test(text)) return false;
  return /^(?:[a-z][\w-]*)\s+"[^"]+"\s*$/i.test(text);
}
export function isVisibleControlTimestampName(name) {
  // Relative-time / HTTP-date GMT strings are membership chrome, not sample
  // names (#305). Same family as #299 (tag/role fallbacks stay counted) and
  // #293 (timestamp is not an identity name). Do not treat `main` as a
  // special case.
  const text = String(name || '').trim();
  if (!text) return false;
  if (/^[A-Z][a-z]{2}, \d{1,2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/i.test(text)) {
    return true;
  }
  return /^(?:just now|\d+\s+(?:second|minute|hour|day|week|month|year)s?\s+ago)$/i.test(text);
}
export function visibleControlNameFromLine(line) {
  const text = stripPerceiveIdentityChrome(line).trim();
  if (!text || isVisibleControlsSectionHeader(text)) return { name: null, named: false };
  // Live collector always sets label to ariaLabel || title || text || role ||
  // tagName, so formatVisibleControlLine prints `img "img"` / `a role=link
  // "link"`. Those quoted tag/role fallbacks are membership, not sample
  // names (#299). Do not treat selector href quotes (`a[href="/"]`) as a name.
  const tag = (text.match(/^(?:[a-z][\w-]*|\?)\b/i) || [])[0] || '';
  const role = (text.match(/\brole=([^\s]+)/i) || [])[1] || '';
  const aria = text.match(/\baria-label="([^"]*)"/);
  const title = text.match(/\btitle="([^"]*)"/);
  const labeled = text.match(/\s"([^"]+)"/);
  const name = (aria && aria[1].trim())
    || (title && title[1].trim())
    || (labeled && labeled[1].trim())
    || null;
  if (name) {
    // Collector fallbacks equal the printed tag or role= (`img "img"`,
    // `a role=link "link"`). Relative-time / GMT title strings occupy the
    // same membership-not-sample bucket (#305).
    const key = name.toLowerCase();
    const named = key !== tag.toLowerCase()
      && key !== role.toLowerCase()
      && !isVisibleControlTimestampName(name);
    return { name, named };
  }
  const fallback = text.replace(/\s+@[\w:-]+\b.*/, '').slice(0, 60) || null;
  return { name: fallback, named: false };
}
export function extractVisibleControlLabels(lines = [], { namedOnly = false } = {}) {
  const labels = [];
  const seen = new Set();
  for (const line of lines) {
    const parsed = visibleControlNameFromLine(line);
    if (!parsed.name || (namedOnly && !parsed.named)) continue;
    if (seen.has(parsed.name)) continue;
    seen.add(parsed.name);
    labels.push(parsed.name);
  }
  return labels;
}
export function uniqueVisibleControlCapSwapSamples(removedNamed = [], addedNamed = [], limit = VISIBLE_CONTROL_CAP_SWAP_SAMPLE) {
  // Names that appear on both sides (live: a shared commit title on every
  // HF file row) are still membership, but they are leftover sample chrome
  // when they occupy a named slot on both sides and push a unique file
  // name into `... and 1 more` (#307). Prefer unique names. Do not treat
  // `main` as a special case.
  const addedSet = new Set(addedNamed);
  const removedSet = new Set(removedNamed);
  return {
    removedSamples: removedNamed.filter(name => !addedSet.has(name)).slice(0, limit),
    addedSamples: addedNamed.filter(name => !removedSet.has(name)).slice(0, limit),
  };
}
export function splitVisibleControlStructural(lines = []) {
  const visible = [];
  const rest = [];
  for (const line of lines) {
    (isVisibleControlStructuralLine(line) ? visible : rest).push(line);
  }
  return { visible, rest };
}
export function visibleControlCapSwap(diff) {
  const removed = splitVisibleControlStructural(diff.removedStructural);
  const added = splitVisibleControlStructural(diff.addedStructural);
  const removedLabels = extractVisibleControlLabels(removed.visible);
  const addedLabels = extractVisibleControlLabels(added.visible);
  const removedNamed = extractVisibleControlLabels(removed.visible, { namedOnly: true });
  const addedNamed = extractVisibleControlLabels(added.visible, { namedOnly: true });
  const samples = uniqueVisibleControlCapSwapSamples(removedNamed, addedNamed);
  return {
    isCapSwap: removedLabels.length >= 2 && addedLabels.length >= 2,
    removedRest: removed.rest,
    addedRest: added.rest,
    removedLabels,
    addedLabels,
    removedNamed,
    addedNamed,
    ...samples,
  };
}
export function visibleControlCapSwapHeadline(left, entered) {
  return `Visible-control cap swap: ${left} left, ${entered} entered`;
}
export function formatVisibleControlCapSwapLines(swap) {
  const lines = [visibleControlCapSwapHeadline(swap.removedLabels.length, swap.addedLabels.length)];
  const removedSamples = swap.removedSamples || [];
  const addedSamples = swap.addedSamples || [];
  for (const label of removedSamples) lines.push(`- ${label}`);
  if (removedSamples.length && swap.removedLabels.length > removedSamples.length) {
    lines.push(`  ... and ${swap.removedLabels.length - removedSamples.length} more left`);
  }
  for (const label of addedSamples) lines.push(`+ ${label}`);
  if (addedSamples.length && swap.addedLabels.length > addedSamples.length) {
    lines.push(`  ... and ${swap.addedLabels.length - addedSamples.length} more entered`);
  }
  return lines;
}
// Private-use mark at the end of a diff-source line. It is not part of the
// printed tree. The number is the DOM backend node id of that @ref.
const PERCEIVE_NODE_MARK = '\uE000';
const PERCEIVE_NODE_MARK_RE = new RegExp(`${PERCEIVE_NODE_MARK}(\\d+)$`);
export function splitPerceiveNodeIdentity(line) {
  const text = String(line ?? '');
  const mark = text.match(PERCEIVE_NODE_MARK_RE);
  if (!mark) return { line: text, id: null };
  return { line: text.slice(0, mark.index), id: mark[1] };
}
export function stripPerceiveNodeIdentity(text) {
  return String(text ?? '').replace(new RegExp(`${PERCEIVE_NODE_MARK}\\d+$`, 'gm'), '');
}
export function annotatePerceiveIdentityLines(lines, refNodeIds) {
  const idByRef = new Map();
  for (const item of refNodeIds || []) {
    if (item?.backendDOMNodeId == null || item.ref == null) continue;
    idByRef.set(String(item.ref), String(item.backendDOMNodeId));
  }
  if (idByRef.size === 0) return lines;
  return lines.map(line => {
    const refs = [...String(line).matchAll(/\s+@(?:f\d+:)?(\d+)(?=\s|$)/g)];
    const ref = refs.length ? refs[refs.length - 1][1] : null;
    if (!ref || !idByRef.has(ref)) return line;
    return `${line}${PERCEIVE_NODE_MARK}${idByRef.get(ref)}`;
  });
}
export function computePerceiveDiff(previousOutput, currentOutput) {
  const prev = previousOutput.split('\n');
  const curr = currentOutput.split('\n');
  // Skip header lines up to the first blank line. Frame-scoped perceive adds
  // a `Frame:` header, so avoid hard-coding the legacy 5-line header shape.
  const prevHeaderEnd = prev.findIndex(line => line === '');
  const currHeaderEnd = curr.findIndex(line => line === '');
  const prevTreeStart = prevHeaderEnd >= 0 ? prevHeaderEnd + 1 : 5;
  const currTreeStart = currHeaderEnd >= 0 ? currHeaderEnd + 1 : 5;
  // A ref number is not page identity: an action settle, --since-action, and
  // --diff keep numbers (#548, #642) and a later plain perceive renumbers, so
  // lines compare without `@N`. A backend-node mark is identity (#651): when
  // both copies of a line carry one and they differ, the node was replaced
  // even if the text matches, and the diff prints the old line and the new @ref.
  // A line with no mark still matches on text, so an older baseline does not
  // report every ref as changed. The mark is removed before the line is shown.
  const prevSplit = prev.slice(prevTreeStart).map(splitPerceiveNodeIdentity);
  const currSplit = curr.slice(currTreeStart).map(splitPerceiveNodeIdentity);
  const prevTree = prevSplit.map(item => stripPerceiveIdentityChrome(item.line));
  const currTree = currSplit.map(item => stripPerceiveIdentityChrome(item.line));
  const prevIds = prevSplit.map(item => item.id);
  const currIds = currSplit.map(item => item.id);
  const refFreeKey = line => stripFrameContentNonce(line).replace(/\s+@(?:c?\d+|f\d+:\d+)(?=\s|$)/g, '');
  // Count each key, so one of two identical lines going away is still reported.
  // Same text with two different backend ids does not pair.
  const currItems = currTree.map((line, index) => ({
    line,
    id: currIds[index],
    key: refFreeKey(line),
    used: false,
  }));
  const byKey = new Map();
  for (const item of currItems) {
    const bucket = byKey.get(item.key);
    if (bucket) bucket.push(item);
    else byKey.set(item.key, [item]);
  }
  const removed = [];
  for (let index = 0; index < prevTree.length; index++) {
    const line = prevTree[index];
    const id = prevIds[index];
    const bucket = byKey.get(refFreeKey(line)) || [];
    let match = -1;
    if (id != null) {
      match = bucket.findIndex(item => !item.used && item.id === id);
      if (match === -1) match = bucket.findIndex(item => !item.used && item.id == null);
    } else {
      match = bucket.findIndex(item => !item.used);
    }
    if (match === -1) removed.push(line);
    else bucket[match].used = true;
  }
  const added = currItems.filter(item => !item.used).map(item => item.line);
  const isTextOnly = l => /^\s*\[StaticText\]/.test(l) && !isPriorityPerceiveTextLine(l);
  const isTextSummary = l => /^\s*\.\.\. \d+ earlier text node\(s\) omitted \(--last \d+\)/.test(l);
  const isCompactTextChange = l => isTextOnly(l) || isTextSummary(l);
  const isIdentityChrome = l => isCompactTextChange(l) || isPerceiveDecorativeTitleChrome(l);
  const removedStructural = removed.filter(l => !isIdentityChrome(l));
  const addedStructural = added.filter(l => !isIdentityChrome(l));
  const removedTextLines = removed.filter(isTextOnly);
  const addedTextLines = added.filter(isTextOnly);
  return {
    headerLines: curr.slice(0, currHeaderEnd >= 0 ? currHeaderEnd : 5),
    removedStructural,
    addedStructural,
    removedTextLines,
    addedTextLines,
  };
}
export function buildPerceiveDiffRecommendation({ mode, changed, baselineAvailable = true, nextSteps = [] }) {
  const source = 'perceive-diff';
  const reason = !baselineAvailable
    ? 'No previous perceive baseline is available; capture a fresh perception before relying on diffs.'
    : changed
    ? 'The page changed; preserve the diff and action timeline before continuing.'
    : 'No page change was detected; use the report timeline or a fresh perceive before retrying the action.';
  return {
    source,
    mode,
    reason,
    commands: nextSteps,
    verifyCommand: nextSteps[0] || null,
  };
}
export function perceiveFocusedFromOutput(output) {
  const lines = String(output || '').split('\n');
  const match = (lines[1] || '').match(/Focused: (.*)$/);
  return match ? match[1].trim() : '';
}
export function perceiveTextboxValueFromOutput(output) {
  for (const line of String(output || '').split('\n')) {
    const match = line.match(/\[(?:textbox|searchbox|combobox)\][^=\n]*=\s*"([^"]*)"/i);
    if (match) return match[1];
  }
  return null;
}
export function isTypeaheadDiffFocus(focused) {
  if (!focused || focused === 'none') return false;
  const s = String(focused);
  if (/textbox|searchbox|combobox/i.test(s)) return true;
  // Live perceive headers use document.activeElement, e.g. "Focused: <input>",
  // not the AX role. HuggingFace search is often a bare <input> with no id.
  return /^<(input|textarea)\b/i.test(s);
}
export function shouldSummarizeTypeaheadDiff(diff, previousOutput, currentOutput, mode) {
  if (mode !== 'since-action') return false;
  const previous = parsePerceiveHeader(previousOutput);
  const current = parsePerceiveHeader(currentOutput);
  if (previous.page.url && current.page.url && previous.page.url !== current.page.url) return false;
  const focused = perceiveFocusedFromOutput(currentOutput);
  if (!isTypeaheadDiffFocus(focused)) return false;
  const suggestionCount = countTypeaheadLabels(diff.addedStructural);
  const hasListbox = [...diff.addedStructural, ...diff.removedStructural]
    .some(line => /\[listbox\]/i.test(line));
  const previousValue = perceiveTextboxValueFromOutput(previousOutput);
  const currentValue = perceiveTextboxValueFromOutput(currentOutput);
  const valueChanged = currentValue != null && previousValue !== currentValue;
  const structuralChurn = diff.removedStructural.length + diff.addedStructural.length;
  if (suggestionCount > 0 && (hasListbox || valueChanged || suggestionCount >= 2)) return true;
  if (valueChanged && hasListbox) return true;
  // perceive -i baseline vs a later snapshot can reroot; still print the one-liner.
  if (valueChanged && structuralChurn >= 40) return true;
  return false;
}
export function typeaheadDiffHeadline(suggestionCount) {
  return `textbox value set; ${suggestionCount} suggestion links`;
}
export function buildPerceiveDiffModel(previousOutput, currentOutput, { mode = 'diff', targetPrefix = '' } = {}) {
  const diff = computePerceiveDiff(previousOutput, currentOutput);
  const target = targetPrefix || '<target>';
  const removedText = diff.removedTextLines.length;
  const addedText = diff.addedTextLines.length;
  const changed = diff.removedStructural.length > 0 || diff.addedStructural.length > 0 || removedText > 0 || addedText > 0;
  const nextSteps = mode === 'since-action'
    ? [
        `cdp report ${target} --format json`,
        `cdp record-actions ${target} --format json`,
      ]
    : [
        `cdp report ${target} --format json`,
      ];
  const model = {
    schema: 'chrome-cdp-ex.perceive-diff.v1',
    mode,
    ...parsePerceiveHeader(currentOutput),
    summary: {
      changed,
      removed: diff.removedStructural.length,
      added: diff.addedStructural.length,
      textRemoved: removedText,
      textAdded: addedText,
    },
    removed: diff.removedStructural.slice(0, 20),
    added: diff.addedStructural.slice(0, 20),
    removedOmitted: Math.max(0, diff.removedStructural.length - 20),
    addedOmitted: Math.max(0, diff.addedStructural.length - 20),
    textRemovedSamples: diff.removedTextLines.slice(-3),
    textAddedSamples: diff.addedTextLines.slice(-3),
    recommendation: buildPerceiveDiffRecommendation({ mode, changed, nextSteps }),
    nextSteps,
  };
  if (shouldSummarizeTypeaheadDiff(diff, previousOutput, currentOutput, mode)) {
    const suggestionCount = countTypeaheadLabels(diff.addedStructural);
    const labels = extractTypeaheadLabels(diff.addedStructural);
    model.summary.kind = 'typeahead';
    model.summary.headline = typeaheadDiffHeadline(suggestionCount);
    model.added = labels;
    model.removed = [];
    model.removedOmitted = diff.removedStructural.length;
    model.addedOmitted = Math.max(0, suggestionCount - labels.length);
  } else {
    const swap = visibleControlCapSwap(diff);
    if (swap.isCapSwap) {
      model.summary.kind = 'visible-control-cap-swap';
      model.summary.headline = visibleControlCapSwapHeadline(
        swap.removedLabels.length,
        swap.addedLabels.length,
      );
      if (swap.removedRest.length === 0 && swap.addedRest.length === 0) {
        const removedSamples = swap.removedSamples || [];
        const addedSamples = swap.addedSamples || [];
        model.removed = removedSamples;
        model.added = addedSamples;
        model.removedOmitted = Math.max(0, swap.removedLabels.length - removedSamples.length);
        model.addedOmitted = Math.max(0, swap.addedLabels.length - addedSamples.length);
      } else {
        model.removed = swap.removedRest.slice(0, 20);
        model.added = swap.addedRest.slice(0, 20);
        model.removedOmitted = Math.max(0, swap.removedRest.length - 20);
        model.addedOmitted = Math.max(0, swap.addedRest.length - 20);
      }
    }
  }
  return model;
}
export function formatPerceiveDiffOutput(previousOutput, currentOutput, { mode = 'diff' } = {}) {
  const diff = computePerceiveDiff(previousOutput, currentOutput);
  if (shouldSummarizeTypeaheadDiff(diff, previousOutput, currentOutput, mode)) {
    const suggestionCount = countTypeaheadLabels(diff.addedStructural);
    const labels = extractTypeaheadLabels(diff.addedStructural);
    const lines = [typeaheadDiffHeadline(suggestionCount), ...labels.map(label => `+ ${label}`)];
    if (suggestionCount > labels.length) {
      lines.push(`  ... and ${suggestionCount - labels.length} more`);
    }
    return diff.headerLines.join('\n') + '\n\n' + lines.join('\n');
  }
  const swap = visibleControlCapSwap(diff);
  const removedStructural = swap.isCapSwap ? swap.removedRest : diff.removedStructural;
  const addedStructural = swap.isCapSwap ? swap.addedRest : diff.addedStructural;
  const diffLines = [];
  const removedText = diff.removedTextLines.length;
  const addedText = diff.addedTextLines.length;
  if (
    removedStructural.length === 0
    && addedStructural.length === 0
    && removedText === 0
    && addedText === 0
    && !swap.isCapSwap
  ) {
    diffLines.push('(no changes detected in AX tree)');
  } else {
    if (removedStructural.length > 0) {
      diffLines.push(`--- Removed (${removedStructural.length}):`);
      for (const l of removedStructural.slice(0, 20)) diffLines.push(`- ${l}`);
      if (removedStructural.length > 20) diffLines.push(`  ... and ${removedStructural.length - 20} more`);
    }
    if (addedStructural.length > 0) {
      diffLines.push(`+++ Added (${addedStructural.length}):`);
      for (const l of addedStructural.slice(0, 20)) diffLines.push(`+ ${l}`);
      if (addedStructural.length > 20) diffLines.push(`  ... and ${addedStructural.length - 20} more`);
    }
    if (removedText > 0 || addedText > 0) {
      const parts = [];
      if (removedText > 0) parts.push(`${removedText} removed`);
      if (addedText > 0) parts.push(`${addedText} added`);
      diffLines.push(`~~~ Text nodes updated (${parts.join(', ')})`);
      if (addedText > 0 && removedStructural.length === 0 && addedStructural.length === 0 && !swap.isCapSwap) {
        const samples = diff.addedTextLines.slice(-3);
        for (const l of samples) diffLines.push(`+ ${l}`);
        if (addedText > samples.length) diffLines.push(`  ... and ${addedText - samples.length} more text additions`);
      }
    }
    if (swap.isCapSwap) {
      diffLines.push(...formatVisibleControlCapSwapLines(swap));
    }
  }
  return diff.headerLines.join('\n') + '\n\n' + diffLines.join('\n');
}
// Format a single @ref bounding-rect annotation. Adds `position` only for
// fixed/sticky elements so agents do not misread visible fixed UI as off-screen.
export function formatRefRect(rect) {
  if (!rect) return '';
  const base = `(${rect.x},${rect.y} ${rect.w}×${rect.h}`;
  if (rect.position === 'fixed' || rect.position === 'sticky') {
    return `${base}, ${rect.position})`;
  }
  return `${base})`;
}
// A diff-only perceive reprints added and removed lines and compares them
// without the ref number. Rebuilding @1..@N would bind a remembered @N to a
// different node while the diff stays silent (#642). Keep each surviving
// backend node on its number. A plain perceive still numbers @1..@N.
export function shouldPreservePerceiveRefs(opts = {}) {
  return opts.preserveRefs === true || opts.sinceAction === true || opts.diff === true;
}
export function buildPerceiveTree(nodes, meta, refMap, opts = {}) {
  const { maxDepth = Infinity, interactiveOnly = false, keepRefs = false, last = null, preserveRefs = false } = opts;
  // opts.adaptive + opts.consoleErrors are used by the --last auto / --adaptive budget path
  // opts.cursorInteractive is accepted so -C ranking shares this path with last/adaptive.

  const nodesById = new Map(nodes.map(n => [n.nodeId, n]));
  const childrenByParent = new Map();
  for (const n of nodes) {
    if (!n.parentId) continue;
    if (!childrenByParent.has(n.parentId)) childrenByParent.set(n.parentId, []);
    childrenByParent.get(n.parentId).push(n);
  }

  // Layout consumption cursors (each role's entries are consumed in document order)
  const layoutCursors = {};
  for (const [role, entries] of Object.entries(meta.layoutMap || {})) {
    layoutCursors[role] = { entries, idx: 0 };
  }
  function consumeLayout(role) {
    const cursor = layoutCursors[role];
    if (!cursor || cursor.idx >= cursor.entries.length) return null;
    return cursor.entries[cursor.idx++];
  }

  // Track table rows to cap output
  const TABLE_ROW_LIMIT = 5;
  const tableRowCounts = new Map();
  const tableIdxMap = new Map();
  let nextTableIdx = 0;
  const rowCellIdx = new Map();
  const dataRowIdx = new Map();

  // Clear and rebuild ref map. preserveRefs (an action settle, --since-action, or --diff)
  // keeps the number each node already has, so a ref the agent read still names the same
  // element; a new node gets a number above every number handed out before, never a freed
  // one (#548, #642). A plain perceive leaves the flag false and numbers @1..@N.
  const preservedRefByNode = new Map();
  let refCounter = 0;
  if (preserveRefs) {
    refCounter = refMap[REF_HIGH_WATER] || 0;
    for (const [ref, backendNodeId] of refMap) {
      if (!Number.isInteger(ref)) continue;
      // A node listed twice keeps each of its numbers, lowest first.
      if (!preservedRefByNode.has(backendNodeId)) preservedRefByNode.set(backendNodeId, []);
      preservedRefByNode.get(backendNodeId).push(ref);
      if (ref > refCounter) refCounter = ref;
    }
    for (const refs of preservedRefByNode.values()) refs.sort((a, b) => a - b);
  }
  refMap.clear();
  const refNodeIds = [];
  const pendingContentRefs = [];
  const pendingRestRefs = [];
  const pendingSkipRefs = [];
  const pendingChromeRefs = [];

  function refKind(node, skipLink, inChrome) {
    if (skipLink) return 'skip';
    if (inChrome) return 'chrome';
    const role = node.role?.value || '';
    if (CONTENT_REF_ROLES.has(role)) return 'content';
    return 'rest';
  }

  function queueRef(node, lineIndex, kind) {
    if (!node?.backendDOMNodeId) return;
    const entry = { lineIndex, backendDOMNodeId: node.backendDOMNodeId };
    if (kind === 'skip') pendingSkipRefs.push(entry);
    else if (kind === 'chrome') pendingChromeRefs.push(entry);
    else if (kind === 'content') pendingContentRefs.push(entry);
    else pendingRestRefs.push(entry);
  }

  const treeLines = [];
  const hiddenTextLines = [];
  let hiddenTextChars = 0;
  let hiddenTextCapped = false;
  const contentBodyLines = new Set();
  const visited = new Set();
  let chromeLinesEmitted = 0;
  let chromeTruncationNoted = false;
  const iframeSlots = Array.isArray(opts.iframeSlots) && opts.iframeSlots.length
    ? opts.iframeSlots.map(slot => ({ ...slot, consumed: false }))
    : null;
  const iframeByBackend = new Map();
  if (iframeSlots) {
    for (const slot of iframeSlots) {
      if (slot.backendNodeId) iframeByBackend.set(slot.backendNodeId, slot);
    }
  }

  function takeIframeSlot(node) {
    if (!iframeSlots) return null;
    const bound = node?.backendDOMNodeId != null ? iframeByBackend.get(node.backendDOMNodeId) : null;
    if (bound) {
      if (bound.consumed) return null;
      bound.consumed = true;
      return bound;
    }
    const next = iframeSlots.find(slot => !slot.consumed);
    if (!next) return null;
    next.consumed = true;
    return next;
  }

  function markSubtreeVisited(nodeId) {
    visited.add(nodeId);
    for (const child of (childrenByParent.get(nodeId) || [])) {
      markSubtreeVisited(child.nodeId);
    }
  }

  function assignInteractiveRef(node) {
    if (!node.backendDOMNodeId) return null;
    let ref = (preservedRefByNode.get(node.backendDOMNodeId) || []).find(kept => !refMap.has(kept));
    if (ref == null) ref = ++refCounter;
    refMap.set(ref, node.backendDOMNodeId);
    refMap[REF_HIGH_WATER] = Math.max(refMap[REF_HIGH_WATER] || 0, ref);
    refNodeIds.push({ ref, backendDOMNodeId: node.backendDOMNodeId });
    return ref;
  }

  function childRegion(ctx, counts) {
    return {
      inContent: ctx.inContent,
      inChrome: ctx.inChrome,
      chromeDepth: ctx.inChrome && counts ? ctx.chromeDepth + 1 : ctx.chromeDepth,
      contentDepth: ctx.inContent && counts ? ctx.contentDepth + 1 : ctx.contentDepth,
    };
  }

  function visit(node, depth, parentNode = null, tableAncestorId = null, ctx = {
    inContent: false, inChrome: false, chromeDepth: 0, contentDepth: 0,
  }) {
    if (!node || visited.has(node.nodeId)) return;
    visited.add(node.nodeId);

    const role = node.role?.value || '';
    const name = node.name?.value ?? '';
    const skipLink = isSkipLinkAxNode(node);
    const enteringContent = PERCEIVE_CONTENT_LANDMARK_ROLES.has(role) && depth <= maxDepth;
    const inContent = ctx.inContent || enteringContent;
    const enteringChrome = !inContent && PERCEIVE_CHROME_LANDMARK_ROLES.has(role);
    const inChrome = !inContent && (ctx.inChrome || enteringChrome);
    const chromeDepth = enteringChrome ? 0 : ctx.chromeDepth;
    const contentDepth = enteringContent ? 0 : ctx.contentDepth;
    const region = { inContent, inChrome, chromeDepth, contentDepth };
    const counts = countsTowardPerceiveDepth(node);
    const childDepth = counts ? depth + 1 : depth;

    const overChrome = inChrome && chromeDepth > PERCEIVE_CHROME_MAX_RELATIVE_DEPTH;
    const overContent = inContent && contentDepth > maxDepth;
    const overGlobal = !inContent && depth > maxDepth;
    if (String(role).toLowerCase() === 'iframe' && iframeSlots) {
      const slot = takeIframeSlot(node);
      const overDepth = overChrome || overContent || overGlobal;
      if (slot && !overDepth) {
        const chromeCapped = inChrome && chromeLinesEmitted >= PERCEIVE_CHROME_LINE_CAP;
        if (chromeCapped) {
          if (!chromeTruncationNoted) {
            treeLines.push(formatAxNode({ role: { value: 'note' }, name: { value: '... chrome truncated' } }, depth));
            chromeTruncationNoted = true;
          }
        } else {
          treeLines.push(formatPerceiveIframeLine(depth, slot.label, slot.ref, slot));
          if (slot.inlineText) {
            let emittedBlock = false;
            for (const line of String(slot.inlineText).split('\n')) {
              treeLines.push(line);
              if (String(line).includes('--- FRAME CONTENT')) emittedBlock = true;
            }
            if (emittedBlock && slot.emit) slot.emit.block = true;
          }
          if (Array.isArray(slot.childLines)) {
            for (const line of slot.childLines) treeLines.push(line);
          }
          if (inChrome) chromeLinesEmitted++;
        }
      }
      for (const child of orderedAxChildren(node, nodesById, childrenByParent)) {
        visit(child, childDepth, node, tableAncestorId, childRegion(region, counts));
      }
      return;
    }
    if (overChrome || overContent || overGlobal) {
      if ((INTERACTIVE_ROLES.has(role) || CONTENT_REF_ROLES.has(role)) && node.backendDOMNodeId) {
        queueRef(node, -1, refKind(node, skipLink, inChrome));
      }
      for (const child of orderedAxChildren(node, nodesById, childrenByParent)) {
        visit(child, childDepth, node, tableAncestorId, childRegion(region, counts));
      }
      return;
    }

    // Detect table context: track row counts per table ancestor
    if (role === 'table' || role === 'grid' || role === 'treegrid') {
      tableAncestorId = node.nodeId;
      tableRowCounts.set(tableAncestorId, 0);
      dataRowIdx.set(tableAncestorId, -1);
      if (!tableIdxMap.has(tableAncestorId)) {
        tableIdxMap.set(tableAncestorId, nextTableIdx++);
      }
    }
    if (tableAncestorId && role === 'row') {
      const count = tableRowCounts.get(tableAncestorId) || 0;
      tableRowCounts.set(tableAncestorId, count + 1);
      rowCellIdx.set(tableAncestorId, 0);
      if (count >= TABLE_ROW_LIMIT) {
        if (count === TABLE_ROW_LIMIT) {
          treeLines.push(formatAxNode({ role: { value: 'note' }, name: { value: '... more rows truncated' } }, depth));
        }
        markSubtreeVisited(node.nodeId);
        return;
      }
    }

    // Filter decorative icon images (short lowercase names like "thunderbolt", "check-circle")
    if (role === 'image') {
      if (name.length < 25 && name === name.toLowerCase() && !name.includes(' ')) {
        markSubtreeVisited(node.nodeId);
        return;
      }
    }

    // Track cell index unconditionally (even for filtered nodes) to stay aligned with browser-side
    const isCellRole = tableAncestorId && (role === 'cell' || role === 'gridcell' || role === 'columnheader' || role === 'rowheader');
    let cellColIdx = -1;
    if (isCellRole) {
      cellColIdx = rowCellIdx.get(tableAncestorId) || 0;
      rowCellIdx.set(tableAncestorId, cellColIdx + 1);
      if ((role === 'cell' || role === 'gridcell') && cellColIdx === 0) {
        dataRowIdx.set(tableAncestorId, (dataRowIdx.get(tableAncestorId) ?? -1) + 1);
      }
    }

    const isInteractive = INTERACTIVE_ROLES.has(role);

    // --interactive mode: only show interactive elements and their immediate structural parents
    if (interactiveOnly && !isInteractive && !ENRICHED_ROLES.has(role)) {
      // Keep the page text this filter hides as diff-only lines (#487), so a
      // settle / --since-action / --diff in this shape still sees a status <p>
      // change. Shared with the default shape: shouldShowAxNode's filters
      // (InlineTextBox, text that repeats the parent's name, empty text).
      // Not shared: -i does not advance depth through filtered nodes, so -d does
      // not reach this text, and the default chrome/table-row caps do not apply.
      // HIDDEN_TEXT_MAX_LINES / _CHARS bound it instead, in document order.
      if (role === 'StaticText' && !hiddenTextCapped && shouldShowAxNode(node, true, parentNode)) {
        const line = formatAxNode(node, depth);
        if (
          hiddenTextLines.length >= HIDDEN_TEXT_MAX_LINES
          || hiddenTextChars + line.length + 1 > HIDDEN_TEXT_MAX_CHARS
        ) {
          hiddenTextCapped = true;
        } else {
          hiddenTextLines.push(line);
          hiddenTextChars += line.length + 1;
        }
      }
      for (const child of orderedAxChildren(node, nodesById, childrenByParent)) {
        visit(child, depth, node, tableAncestorId, region);
      }
      return;
    }

    if (shouldShowAxNode(node, true, parentNode)) {
      const chromeCapped = inChrome && chromeLinesEmitted >= PERCEIVE_CHROME_LINE_CAP;
      if (chromeCapped) {
        if (!chromeTruncationNoted) {
          treeLines.push(formatAxNode({ role: { value: 'note' }, name: { value: '... chrome truncated' } }, depth));
          chromeTruncationNoted = true;
        }
      } else {
        let line = formatAxNode(node, depth);

        // Assign @ref after the walk: content landmarks first, then other
        // controls, then chrome, then skip-links so 跳至 / Skip to never take @1.
        if ((isInteractive || CONTENT_REF_ROLES.has(role)) && node.backendDOMNodeId) {
          queueRef(node, treeLines.length, refKind(node, skipLink, inChrome));
        }

        // Enrich landmark/structural nodes with layout annotations
        if (ENRICHED_ROLES.has(role)) {
          const layout = consumeLayout(role);
          if (layout) {
            const parts = [];
            if (layout.w) parts.push(`${layout.w}×${layout.h}px`);
            else if (layout.h >= 40) parts.push(`↕${layout.h}px`);
            if (layout.bg) parts.push(`bg:${layout.bg}`);
            if (layout.font) parts.push(layout.font);
            if (layout.color) parts.push(`color:${layout.color}`);
            if (layout.display) {
              let d = layout.display;
              if (layout.gap) d += ` gap:${layout.gap}`;
              parts.push(d);
            }
            if (layout.opacity) parts.push(`opacity:${layout.opacity}`);
            if (layout.vis === 'above') parts.push('↑above fold');
            else if (layout.vis === 'below') parts.push('↓below fold');
            if (parts.length > 0) line += '  ' + parts.join('  ');
          }
        }

        // Enrich table cells with style hints (positional key: tableIdx:rowIdx:colIdx)
        if (isCellRole && meta.styleHints) {
          const ti = tableIdxMap.get(tableAncestorId);
          const ri = dataRowIdx.get(tableAncestorId) ?? -1;
          if (ti != null && ri >= 0) {
            const hint = meta.styleHints[ti + ':' + ri + ':' + cellColIdx];
            if (hint) line += '  ' + hint;
          }
        }
        treeLines.push(line);
        if (inChrome) chromeLinesEmitted++;
        if (inContent && isPerceiveBodyTextRole(role)) contentBodyLines.add(line);
      }
    }
    for (const child of orderedAxChildren(node, nodesById, childrenByParent)) {
      visit(child, childDepth, node, tableAncestorId, childRegion(region, counts));
    }
  }

  const roots = nodes.filter(n => !n.parentId || !nodesById.has(n.parentId));
  for (const root of roots) visit(root, 0);
  for (const node of nodes) visit(node, 0);

  for (const pending of [...pendingContentRefs, ...pendingRestRefs, ...pendingChromeRefs, ...pendingSkipRefs]) {
    const ref = assignInteractiveRef({ backendDOMNodeId: pending.backendDOMNodeId });
    if (ref != null && pending.lineIndex >= 0 && treeLines[pending.lineIndex] != null) {
      treeLines[pending.lineIndex] += `  @${ref}`;
    }
  }

  // --last N: keep only the last N StaticText / paragraph rows. Ref-bearing
  // lines (anything containing `@<digit>` or `@c<digit>`) and structural lines
  // (landmarks, headings, dialogs, etc.) are always kept.
  // --keep-refs: when truncating, ensure every line carrying an @ref survives.
  // --adaptive / --last auto: choose N from density + error/priority signals.
  // Content-landmark text is treated as priority so -C chrome cannot outrank the article.
  let outLines = treeLines;
  let effectiveLast = last;
  if (last === 'auto' || (opts.adaptive && (last == null || last === 'auto'))) {
    const interactiveCount = outLines.filter(ln => /@(c?\d+)/.test(ln)).length;
    const hasPriorityText = outLines.some(ln => isPriorityPerceiveTextLine(ln) || contentBodyLines.has(ln));
    effectiveLast = chooseAdaptivePerceiveLast({
      lineCount: outLines.length,
      consoleErrors: Number(opts.consoleErrors || 0),
      interactiveCount,
      hasPriorityText,
    });
  }
  if (effectiveLast && Number.isFinite(effectiveLast) && effectiveLast > 0) {
    const refLineRe = /@(c?\d+)/;
    const textRoleRe = /\[(StaticText|paragraph|listitem|note|description|comment|term|definition)\]/;
    // Walk backwards collecting the last N text lines while keeping all ref/structural lines
    const reversed = [];
    let textKept = 0;
    let priorityKept = 0;
    const priorityBudget = Math.max(effectiveLast, 12);
    let textOmitted = 0;
    for (let i = outLines.length - 1; i >= 0; i--) {
      const ln = outLines[i];
      const isRef = refLineRe.test(ln);
      const isText = textRoleRe.test(ln) && !isRef;
      if (isText) {
        if ((contentBodyLines.has(ln) || isPriorityPerceiveTextLine(ln)) && priorityKept < priorityBudget) {
          reversed.push(ln);
          priorityKept++;
        } else if (textKept < effectiveLast) { reversed.push(ln); textKept++; }
        else { textOmitted++; }
      } else {
        reversed.push(ln);
      }
    }
    outLines = reversed.reverse();
    if (textOmitted > 0) {
      const label = (last === 'auto' || opts.adaptive) ? `--adaptive last ${effectiveLast}` : `--last ${effectiveLast}`;
      outLines.push(`  ... ${textOmitted} earlier text node(s) omitted (${label})`);
    }
  } else if (keepRefs) {
    // No size budget enforced here; the caller chooses when to truncate, but
    // when --keep-refs is set we mark lines so downstream truncation can
    // protect them. We currently return the lines as-is (the truncation that
    // hid refs was happening elsewhere; --keep-refs is now a soft flag agents
    // can use to assert "do not drop my @ref lines"). The flag is honoured
    // upstream by perceiveStr which avoids cutting ref lines.
  }

  const hasContentBody = outLines.some(ln => contentBodyLines.has(ln));
  const emittedChromeOrSkip = outLines.some(ln =>
    /\[(navigation|banner|complementary)\]/.test(ln)
    || /\[(link|button)\].*(Skip\s+to|跳至)/i.test(ln)
  );
  if (!hasContentBody && Number.isFinite(maxDepth) && emittedChromeOrSkip) {
    const target = opts.targetPrefix || '<target>';
    outLines.push(`Body truncated. Next: cdp text ${target} --auto`);
  }

  // A fixed note (no count) so a capped baseline and a capped settle do not
  // differ on the note alone; crossing the cap is a real text change.
  if (hiddenTextCapped) hiddenTextLines.push(HIDDEN_TEXT_CAP_NOTE);
  return { treeLines: outLines, refNodeIds, hiddenTextLines: interactiveOnly ? hiddenTextLines : [] };
}
// Browser-side script for perceiveStr — extracted for readability and testability.
// Collects page metadata, layout map, style hints, and cursor-interactive elements.
// #561: the Interactive census counts a control only when it is rendered (it has a client rect, so no
// display:none ancestor, closed <dialog>, hidden attribute or type=hidden) and visible. A native input
// hidden behind a styled <label> (input{display:none}) is therefore not counted, as in the AX tree.
export function renderedInteractiveSource() {
  return `function renderedInteractive(el) {
    if (!el || typeof el.getClientRects !== 'function' || el.getClientRects().length === 0) return false;
    // checkVisibility also catches a content-visibility:hidden ancestor (a closed <details>), which
    // keeps its rects.
    if (typeof el.checkVisibility === 'function') return el.checkVisibility({ visibilityProperty: true });
    let visibility = 'visible';
    try { visibility = String(getComputedStyle(el).visibility || 'visible'); } catch {}
    return visibility !== 'hidden' && visibility !== 'collapse';
  }`;
}
export function perceivePageScript(cursorInteractive) {
  return `(function() {
${visibleControlsCollectorSource()}
      const renderedInteractive = ${renderedInteractiveSource()};
      const pickPrimaryScrollMetrics = ${pickPrimaryScrollMetrics.toString()};
      const vw = window.innerWidth, vh = window.innerHeight;
      const scrollingEl = document.scrollingElement || document.documentElement;
      const scrollCandidates = [];
      function pushScrollCandidate(el, source) {
        if (!el) return;
        const isDocument = el === scrollingEl || el === document.documentElement;
        scrollCandidates.push({
          scrollTop: isDocument ? (el.scrollTop || window.scrollY || 0) : (el.scrollTop || 0),
          scrollHeight: el.scrollHeight || 0,
          clientHeight: isDocument ? (el.clientHeight || window.innerHeight || 0) : (el.clientHeight || 0),
          source: source
        });
      }
      pushScrollCandidate(scrollingEl, 'document');
      if (document.body && document.body !== scrollingEl) pushScrollCandidate(document.body, 'body');
      const seenScrollers = new Set();
      const walk = [document.documentElement, document.body].filter(Boolean);
      let inspected = 0;
      while (walk.length && inspected < 400) {
        const el = walk.pop();
        if (!el || seenScrollers.has(el)) continue;
        seenScrollers.add(el);
        inspected++;
        let overflowY = '';
        try { overflowY = window.getComputedStyle(el).overflowY || ''; } catch {}
        if (el !== scrollingEl && /(auto|scroll|overlay)/.test(overflowY)) {
          pushScrollCandidate(el, 'inner');
        }
        const children = el.children;
        if (children) {
          for (let i = 0; i < children.length; i++) walk.push(children[i]);
        }
      }
      const scrollMetrics = pickPrimaryScrollMetrics(scrollCandidates);
      const scrollY = scrollMetrics.scrollY;
      const scrollMax = scrollMetrics.scrollMax;

      // Interactive element counts
      const counts = {};
      for (const el of document.querySelectorAll('a, button, input, select, textarea, [role="button"], [tabindex]')) {
        if (!renderedInteractive(el)) continue;
        const tag = el.tagName.toLowerCase();
        const type = tag === 'input' ? 'input[' + (el.type || 'text') + ']' : tag;
        counts[type] = (counts[type] || 0) + 1;
      }

      // Build layout map keyed by ARIA role (matching AX tree roles)
      const TAG_ROLE = {
        header:'banner', nav:'navigation', main:'main', footer:'contentinfo',
        aside:'complementary', form:'form', table:'table', dialog:'dialog',
        article:'article', section:'region', img:'img', video:'video',
        h1:'heading', h2:'heading', h3:'heading', h4:'heading', h5:'heading', h6:'heading'
      };
      const selectors = 'header,nav,main,footer,aside,section,article,form,h1,h2,h3,h4,h5,h6,img,video,table,dialog,[role="banner"],[role="navigation"],[role="main"],[role="contentinfo"],[role="dialog"],[role="alert"],[role="region"],[role="complementary"]';
      const layoutMap = {};
      let count = 0;
      for (const el of document.querySelectorAll(selectors)) {
        const rect = el.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) continue;
        const cs = window.getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;

        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute('role') || TAG_ROLE[tag] || tag;
        const info = { h: Math.round(rect.height) };

        // Only include width if element is significantly narrower than viewport
        const w = Math.round(rect.width);
        if (w < vw * 0.9) info.w = w;

        // Key visual properties (only non-defaults)
        const bg = cs.backgroundColor;
        if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') info.bg = bg;
        if (tag.match(/^h[1-6]$/)) {
          info.font = cs.fontSize + ' ' + cs.fontWeight;
          if (cs.color && cs.color !== 'rgb(0, 0, 0)') info.color = cs.color;
        }
        if (cs.display === 'flex' || cs.display === 'grid') {
          info.display = cs.display;
          if (cs.gap && cs.gap !== 'normal' && cs.gap !== '0px') info.gap = cs.gap;
        }
        if (cs.opacity !== '1') info.opacity = cs.opacity;

        // Viewport visibility
        const top = rect.top, bot = rect.bottom;
        if (bot < 0) info.vis = 'above';
        else if (top > vh) info.vis = 'below';
        // else: in viewport (default, no annotation needed)

        if (!layoutMap[role]) layoutMap[role] = [];
        layoutMap[role].push(info);
        if (++count >= 150) break;
      }

      // === Style hints: detect visual anomalies on table cells ===
      const styleHints = {};
      let styleHintCount = 0;
      const CELL_SEL = 'td, th, [role="cell"], [role="gridcell"], [role="columnheader"], [role="rowheader"]';
      const BASELINE_ROW_CAP = 20; // enough rows for reliable baseline, avoids scanning huge tables
      function majority(counts) {
        let best = null, bestN = 0;
        for (const [v, n] of Object.entries(counts)) { if (n > bestN) { best = v; bestN = n; } }
        return best;
      }
      const allTables = document.querySelectorAll('table, [role="grid"], [role="treegrid"]');
      // Filter out presentation/hidden tables to match AX tree traversal order
      const visTables = [];
      for (const t of allTables) {
        const r = t.getAttribute('role');
        if (r === 'presentation' || r === 'none') continue;
        if (t.getAttribute('aria-hidden') === 'true') continue;
        const cs = window.getComputedStyle(t);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        visTables.push(t);
      }
      for (let ti = 0; ti < visTables.length && styleHintCount < 100; ti++) {
        const tbl = visTables[ti];
        const rows = tbl.querySelectorAll('tr, [role="row"]');
        const dataRows = [];
        for (const row of rows) {
          const firstCell = row.querySelector('td, [role="cell"], [role="gridcell"]');
          if (firstCell) dataRows.push(row);
        }
        if (dataRows.length === 0) continue;
        const smallTable = dataRows.length < 4;
        const scanRows = dataRows.slice(0, BASELINE_ROW_CAP);

        // Single pass: collect styles, build baselines, cache per-cell data
        const colBgs = {}, colWeights = {}, colColors = {};
        const cellCache = []; // [{cells: [{bg, fw, clr, ci}]}] per row
        for (const row of scanRows) {
          const cells = row.querySelectorAll(CELL_SEL);
          const rowData = [];
          let ci = 0;
          for (const cell of cells) {
            if (cell.colSpan > 1) { ci += cell.colSpan; continue; }
            const cs = window.getComputedStyle(cell);
            const bg = cs.backgroundColor;
            const fw = parseInt(cs.fontWeight) || 400;
            const clr = cs.color;
            if (!colBgs[ci]) { colBgs[ci] = {}; colWeights[ci] = {}; colColors[ci] = {}; }
            colBgs[ci][bg] = (colBgs[ci][bg] || 0) + 1;
            colWeights[ci][fw] = (colWeights[ci][fw] || 0) + 1;
            colColors[ci][clr] = (colColors[ci][clr] || 0) + 1;
            rowData.push({ bg, fw, clr, ci });
            ci++;
          }
          cellCache.push(rowData);
        }

        // Compute baselines from collected data
        const baseBg = {}, baseWeight = {}, baseColor = {};
        for (const ci of Object.keys(colBgs)) {
          baseBg[ci] = majority(colBgs[ci]);
          baseWeight[ci] = parseInt(majority(colWeights[ci])) || 400;
          baseColor[ci] = majority(colColors[ci]);
        }

        // Emit hints from cached styles (no second getComputedStyle pass)
        for (let ri = 0; ri < cellCache.length; ri++) {
          for (const { bg, fw, clr, ci } of cellCache[ri]) {
            const hints = [];
            if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
              if (smallTable || bg !== baseBg[ci]) hints.push('bg:' + bg);
            }
            if (fw > 400 && (smallTable || fw !== baseWeight[ci])) hints.push('bold');
            if (clr && clr !== 'rgb(0, 0, 0)') {
              if (smallTable || clr !== baseColor[ci]) hints.push('color:' + clr);
            }
            if (hints.length > 0) {
              styleHints[ti + ':' + ri + ':' + ci] = hints.join(' ');
              if (++styleHintCount >= 100) break;
            }
          }
          if (styleHintCount >= 100) break;
        }
      }

      // Focused element
      const focused = document.activeElement;
      const focusDesc = focused && focused !== document.body
        ? '<' + focused.tagName.toLowerCase() + (focused.id ? '#' + focused.id : '') + '>'
        : 'none';

      // Cursor-interactive scan: find non-ARIA clickable elements (cursor:pointer, onclick, tabindex)
      const cursorInteractives = [];
      let visibleControls = [];
      let visibleControlsTruncated = false;
      if (${cursorInteractive}) {
        const visibleControlsModel = chromeCdpVisibleControls({ limit: 30 });
        visibleControls = visibleControlsModel.controls || [];
        visibleControlsTruncated = Boolean(visibleControlsModel.truncated);

        const ARIA_INTERACTIVE = new Set(['A','BUTTON','INPUT','SELECT','TEXTAREA']);
        const seen = new Set();
        const candidates = document.querySelectorAll('div, span, li, td, tr, label, img, svg, i, p, section, article, [onclick], [tabindex]:not(a):not(button):not(input):not(select):not(textarea)');
        for (const el of candidates) {
          if (ARIA_INTERACTIVE.has(el.tagName)) continue;
          if (el.getAttribute('role')) continue;
          if (el.closest('a, button, input, select, textarea, [role]')) continue;
          const cs = window.getComputedStyle(el);
          const clickable = cs.cursor === 'pointer' || el.hasAttribute('onclick') || (el.hasAttribute('tabindex') && el.tabIndex >= 0);
          if (!clickable) continue;
          if (cs.display === 'none' || cs.visibility === 'hidden') continue;
          const rect = el.getBoundingClientRect();
          if (rect.width < 5 || rect.height < 5) continue;
          // Overflow scrollports can report on-screen rects that are clipped from hit-testing.
          {
            let clipped = false;
            for (let parent = el.parentElement; parent && parent !== document.documentElement && parent !== document.body; parent = parent.parentElement) {
              const style = window.getComputedStyle(parent);
              const overflow = (style.overflowX || '') + ' ' + (style.overflowY || '');
              const clips = /(auto|scroll|hidden|clip)/.test(overflow);
              const scrollable = parent.scrollWidth > parent.clientWidth + 1 || parent.scrollHeight > parent.clientHeight + 1;
              if (!(clips && scrollable)) continue;
              const pr = parent.getBoundingClientRect();
              const top = Math.max(rect.top, pr.top);
              const left = Math.max(rect.left, pr.left);
              const bottom = Math.min(rect.bottom, pr.bottom);
              const right = Math.min(rect.right, pr.right);
              if ((bottom - top) < 2 || (right - left) < 2) { clipped = true; break; }
            }
            if (clipped) continue;
          }
          // Build a CSS selector path for this element
          let sel = el.tagName.toLowerCase();
          if (el.id) sel += '#' + CSS.escape(el.id);
          else if (el.className && typeof el.className === 'string') {
            const cls = el.className.trim().split(/\\s+/).slice(0, 2).map(c => '.' + CSS.escape(c)).join('');
            sel += cls;
          }
          const key = sel + '|' + Math.round(rect.x) + ',' + Math.round(rect.y);
          if (seen.has(key)) continue;
          seen.add(key);
          const text = el.textContent.trim().substring(0, 60);
          cursorInteractives.push({ sel, text, x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) });
          if (cursorInteractives.length >= 50) break;
        }
      }

      const cardWindows = [];
      const cardEls = document.querySelectorAll('article, [role="article"], [role="listitem"]');
      for (const el of cardEls) {
        const rect = el.getBoundingClientRect();
        if (rect.width < 8 || rect.height < 8) continue;
        let vis = 'in';
        if (rect.bottom < 0) vis = 'above';
        else if (rect.top > vh) vis = 'below';
        const handleMatch = (el.textContent || '').match(/@[A-Za-z0-9_]{1,30}/);
        cardWindows.push({
          vis,
          text: (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 180),
          handle: handleMatch ? handleMatch[0] : '',
        });
        if (cardWindows.length >= 40) break;
      }

      ${frameElementInventorySource()}

      return JSON.stringify({
        title: document.title, url: window.location.href,
        contentType: document.contentType || '',
        vw, vh, scrollY, scrollMax,
        counts, focused: focusDesc, layoutMap, styleHints, cursorInteractives,
        visibleControls, visibleControlsTruncated, cardWindows, frameElements, frameElementCount
      });
    })()`;
}
// The focused element's id is page text. Outside the block a cross-site read shows the tag only.
function crossSiteFocusedTag(focused) {
  return String(focused ?? 'none').replace(/^(<[^#>]*)#[\s\S]*$/, '$1>');
}

function explicitCrossSiteBody(frame, meta, treeLines) {
  const body = [`title: ${meta?.title ?? ''}`];
  if (crossSiteFocusedTag(meta?.focused) !== String(meta?.focused ?? 'none')) body.push(`focused: ${meta.focused}`);
  if (frame?.name) {
    body.push('name:');
    body.push(String(frame.name));
  }
  body.push(...treeLines);
  return body.join('\n');
}

function wrapCrossSiteOutput(text, frame, nonce = createFrameContentNonce()) {
  const host = originHost(frame?.securityOrigin);
  const origin = frameContentOrigin(frame?.securityOrigin);
  const head = [`Page: ${host}`, host ? `Frame: ${frame.ref} ${host}` : `Frame: ${frame.ref}`].join('\n');
  return {
    nonce,
    origin,
    text: `${head}\n${wrapFrameContent(text, { nonce, origin })}`,
  };
}

function rememberCrossSiteBoundary(cdp, nonce, origin) {
  rememberPerceiveFrameRecords(cdp, { contentBoundary: frameContentBoundary(nonce, origin) });
}

export async function perceiveStr(cdp, sid, consoleBuf, exceptionBuf, refMap, lastPerceiveStore, opts = {}, refState = null) {
  rememberPerceiveFrameRecords(cdp, null);
  const {
    diff: diffMode = false, selector: scopeSelector = null, exclude: excludeSelector = null,
    interactive: interactiveOnly = false, maxDepth = Infinity, cursorInteractive = false,
    keepRefs = false, keepTypeahead = false, last = null, adaptive = false, sinceAction = false, diffBaseline = null,
    frameRef = null, cards = false, verbose = false,
  } = opts;
  if (lastPerceiveStore && typeof lastPerceiveStore === 'object') lastPerceiveStore.outputTruncated = false;
  const frameContext = frameRef ? await resolveFrameRef(cdp, sid, frameRef) : null;
  const frame = frameContext?.frame || null;
  const crossSiteSid = frame?.process === 'oopif' ? crossSiteFrameSession(cdp, sid, frame.id) : null;
  if (frame?.process === 'oopif' && !crossSiteSid) {
    throw new Error(`Cross-site frame ${frame.ref} is not attached. Run "frame" to refresh it, then "perceive --frame ${frame.ref}".`);
  }
  // Same-origin frame commands stay on the page session. A cross-site frame's
  // AX tree and isolated world belong to the attached child session.
  const contentSid = crossSiteSid || sid;
  const frameExecutionContextId = frame ? await createFrameExecutionContext(cdp, contentSid, frame.id) : null;
  if (frame && (scopeSelector || excludeSelector)) {
    throw new Error('perceive --frame does not yet support --selector/--exclude; run frame-scoped perceive first, then use the listed @fN:M refs.');
  }

  const pdfProbeContext = frameExecutionContextId != null
    ? { contextId: frameExecutionContextId }
    : { timeoutMs: STATUS_PAGE_INFO_TIMEOUT };
  // --cards and -s previously skipped the PDF gate and treated the empty
  // embedder as a normal HTML/cards page. Probe before AX / scoped DOM queries.
  if (cards || scopeSelector) {
    try {
      const probe = JSON.parse(await evalStr(
        cdp,
        contentSid,
        'JSON.stringify({ title: document.title, url: window.location.href, contentType: document.contentType || "" })',
        false,
        pdfProbeContext,
      ));
      if (isPdfViewerContentType(probe.contentType)) {
        const output = formatPdfViewerOutput(probe, { targetPrefix: opts.targetPrefix, unsafeFull: opts.unsafeFull === true });
        return pdfViewerPerceiveResult(lastPerceiveStore, opts, output);
      }
    } catch (error) {
      if (error?.code === 'pdf_viewer') throw error;
    }
  }

  // Get AX tree nodes and page metadata + layout map in parallel
  // Hoist DOM.getDocument so scope and exclude can share it
  const needsDocument = !frame && (scopeSelector || excludeSelector);
  const docRootPromise = needsDocument ? cdpDomains(cdp).DOM.getDocument( {}, sid) : null;
  let scopeBackendNodeIds = null;
  const axPromise = frame
    ? cdpDomains(cdp).Accessibility.getFullAXTree( { frameId: frame.id }, contentSid)
    : scopeSelector
    ? (async () => {
        const { root } = await docRootPromise;
        const { nodeId } = await cdpDomains(cdp).DOM.querySelector( { nodeId: root.nodeId, selector: scopeSelector }, sid);
        if (!nodeId) throw new Error(`Scope selector not found: ${scopeSelector}`);
        const { node } = await cdpDomains(cdp).DOM.describeNode( { nodeId, depth: -1, pierce: true }, sid);
        scopeBackendNodeIds = collectDomBackendNodeIds(node);
        return cdpDomains(cdp).Accessibility.getFullAXTree( {}, sid);
      })()
    : cdpDomains(cdp).Accessibility.getFullAXTree( {}, sid);
  const [axResult, metaJson] = await Promise.all([
    axPromise,
    evalStr(cdp, contentSid, perceivePageScript(cursorInteractive), false, frameExecutionContextId != null ? { contextId: frameExecutionContextId } : {})
  ]);

  const meta = JSON.parse(metaJson);

  if (isPdfViewerContentType(meta.contentType)) {
    const output = formatPdfViewerOutput(meta, { targetPrefix: opts.targetPrefix, unsafeFull: opts.unsafeFull === true });
    return pdfViewerPerceiveResult(lastPerceiveStore, opts, output);
  }

  // Console health
  const allConsole = consoleDocumentEntries(consoleBuf);
  let errors = 0, warnings = 0;
  for (const e of allConsole) {
    if (e.level === 'error') errors++;
    else if (e.level === 'warning' || e.level === 'warn') warnings++;
  }
  const exceptions = consoleDocumentEntries(exceptionBuf).length;

  // Exclude filtering: remove AX subtrees rooted at excluded DOM nodes
  let axNodes = axResult.nodes;
  if (scopeBackendNodeIds) {
    axNodes = filterAxNodesToBackendSubtree(axNodes, scopeBackendNodeIds);
  }
  if (excludeSelector) {
    const { root } = await docRootPromise;
    const excludedBackendNodeIds = new Set();
    const describedNodesByBackendId = new Map();
    const exNodes = await cdpDomains(cdp).DOM.querySelectorAll( { nodeId: root.nodeId, selector: excludeSelector }, sid);
    if (exNodes.nodeIds) {
      const results = await Promise.allSettled(
        exNodes.nodeIds.map(nid => cdpDomains(cdp).DOM.describeNode( { nodeId: nid, depth: -1, pierce: true }, sid))
      );
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value.node?.backendNodeId) {
          excludedBackendNodeIds.add(r.value.node.backendNodeId);
          describedNodesByBackendId.set(r.value.node.backendNodeId, r.value.node);
        }
      }
    }
    axNodes = filterPerceiveExcludedAxNodes(axNodes, excludedBackendNodeIds, describedNodesByBackendId);
  }

  const typeaheadFilter = omitTypeaheadListboxNodes(axNodes, {
    keepTypeahead,
    selector: scopeSelector,
    focusedDesc: meta.focused,
  });
  axNodes = typeaheadFilter.nodes;

  if (frame) {
    const listed = await listDomInteractiveControls(cdp, contentSid, {
      contextId: frameExecutionContextId,
    });
    if (shouldSynthesizeMissingFrameInteractives(frame, axNodes, listed)) {
      const extras = await collectDomInteractiveControls(cdp, contentSid, {
        contextId: frameExecutionContextId,
        listed,
      });
      if (extras.length) axNodes = mergeMissingDomInteractiveAxNodes(axNodes, extras);
    }
  }

  const activeRefMap = frame ? new Map() : refMap;
  if (cards) {
    const model = buildCardsModel(axNodes, meta, activeRefMap, {
      last,
      targetPrefix: opts.targetPrefix,
      previousCards: lastPerceiveStore.cards?.cards,
      previousScrollY: lastPerceiveStore.cards?.scrollY,
    });
    if (frame) {
      storeFrameScopedRefs(refState, frame, frameContext.frames, activeRefMap);
      for (const card of model.cards || []) {
        if (typeof card.ref === 'string' && /^@\d+$/.test(card.ref)) {
          card.ref = `${frame.ref}:${card.ref.slice(1)}`;
        }
      }
    }
    const output = opts.format === 'json' ? formatCardsJson(model) : formatCardsText(model);
    lastPerceiveStore.output = output;
    lastPerceiveStore.cards = model;
    lastPerceiveStore.snapshotOpts = perceiveSnapshotOpts(opts);
    if (frame) rememberFramePerceiveOutput(refState, frame.ref, output);
    if (refState && typeof refState === 'object') {
      refState.lastPerceiveText = output;
      refState.generation = (refState.generation || 0) + 1;
      refState.lastPerceiveAt = Date.now();
      refState.invalidationReason = null;
    }
    return output;
  }
  let frameNotice = null;
  const frameInventory = frame ? { elements: [], count: 0 } : frameInventoryFromMeta(meta);
  if (frameInventory.count > 0) {
    try {
      const model = await framesModel(cdp, sid, { crossSite: true });
      const frames = model.frames || [];
      const childFrames = frames.filter(item => item && item.depth > 0 && item.process !== 'oopif');
      const oopifFrames = frames.filter(item => item?.process === 'oopif');
      const owners = await describePerceiveFrameOwners(cdp, sid, childFrames);
      frameNotice = buildPerceiveFrameNotice({
        childFrames,
        frameElements: frameInventory.elements,
        frameElementCount: frameInventory.count,
        owners,
        target: opts.targetPrefix || '<target>',
        pageUrl: frames.find(item => item && item.depth === 0)?.url || meta.url || '',
        oopifFrames,
        frameSites: currentFrameSites(opts),
      });
      if (frameNotice) {
        await inlineAllowlistedFrames(cdp, sid, frameNotice, {
          frames,
          refState,
          maxDepth,
          interactiveOnly,
          cursorInteractive,
          targetPrefix: opts.targetPrefix || '<target>',
          sites: currentFrameSites(opts),
        });
      }
    } catch {
      frameNotice = null;
    }
  }
  const builtTree = buildPerceiveTree(axNodes, meta, activeRefMap, {
    maxDepth,
    interactiveOnly,
    keepRefs,
    last,
    adaptive,
    cursorInteractive,
    // --since-action / --diff print added and removed lines only. Rebuilding
    // @1..@N would point a remembered @N at a different node (#642).
    preserveRefs: shouldPreservePerceiveRefs(opts),
    consoleErrors: errors + exceptions,
    targetPrefix: opts.targetPrefix || '<target>',
    iframeSlots: frameNotice?.slots?.length ? frameNotice.slots : null,
  });
  let treeLines = builtTree.treeLines;
  const { refNodeIds, hiddenTextLines } = builtTree;
  if (frame) storeFrameScopedRefs(refState, frame, frameContext.frames, activeRefMap);

  // === Batch-resolve @ref bounding rects (parallel, non-scrolling) ===
  // Now also returns `position` (computed style) so fixed/sticky elements get
  // a clear annotation — agents previously saw negative document-relative Ys
  // and assumed elements were off-screen.
  const refRects = new Map(); // ref number → {x, y, w, h, position?}
  const frameOffset = frame
    ? await perceiveFrameOffset(cdp, sid, frame, frameContext.frames)
    : { x: 0, y: 0 };
  if (frame && (frameOffset.x || frameOffset.y)) {
    if (Array.isArray(meta.cursorInteractives)) {
      meta.cursorInteractives = meta.cursorInteractives.map(item => offsetCursorInteractiveItem(item, frameOffset));
    }
    if (Array.isArray(meta.visibleControls)) {
      meta.visibleControls = meta.visibleControls.map(control => (
        control?.rect ? { ...control, rect: offsetCssRect(control.rect, frameOffset) } : control
      ));
    }
  }
  if (refNodeIds.length > 0) {
    const results = await Promise.allSettled(refNodeIds.map(async ({ ref, backendDOMNodeId }) => {
      const { object } = await cdpDomains(cdp).DOM.resolveNode( { backendNodeId: backendDOMNodeId }, contentSid);
      const res = await cdpDomains(cdp).Runtime.callFunctionOn( {
        objectId: object.objectId,
        functionDeclaration: `function() {
          const r = this.getBoundingClientRect();
          const cs = (typeof getComputedStyle === 'function') ? getComputedStyle(this) : null;
          return {
            x: Math.round(r.x),
            y: Math.round(r.y),
            w: Math.round(r.width),
            h: Math.round(r.height),
            position: cs ? cs.position : '',
          };
        }`,
        returnByValue: true,
      }, contentSid);
      const rect = res.result.value || {};
      if (frame) {
        rect.x = (Number(rect.x) || 0) + frameOffset.x;
        rect.y = (Number(rect.y) || 0) + frameOffset.y;
      }
      return { ref, rect };
    }));
    for (const r of results) {
      if (r.status === 'fulfilled') refRects.set(r.value.ref, r.value.rect);
    }
  }

  // Inject @ref coordinates into treeLines (top-level viewport CSS pixels; same space as clickxy)
  for (let i = 0; i < treeLines.length; i++) {
    const m = treeLines[i].match(/@(\d+)$/);
    if (m) {
      const rect = refRects.get(parseInt(m[1]));
      if (rect) treeLines[i] += `  ${formatRefRect(rect)}`;
    }
  }
  if (frame) treeLines = qualifyFrameRefsInLines(treeLines, frame.ref);

  // === Cursor-interactive @c refs (capped AFTER body; last/adaptive apply here) ===
  const cursorLimit = perceiveCursorSurfaceLimit({
    last,
    adaptive,
    lineCount: treeLines.length,
    consoleErrors: errors + exceptions,
    interactiveCount: refNodeIds.length + (meta.cursorInteractives?.length || 0) + (meta.visibleControls?.length || 0),
    hasPriorityText: treeLines.some(ln => isPriorityPerceiveTextLine(ln)),
  });
  let cRefCounter = 0;
  let outputTruncated = false;
  if (cursorInteractive && meta.cursorInteractives?.length > 0) {
    const ranked = rankPerceiveCursorItems(meta.cursorInteractives, item => item.text || item.sel);
    const capped = ranked.slice(0, cursorLimit);
    if (ranked.length > capped.length) outputTruncated = true;
    treeLines.push('');
    treeLines.push(`[Cursor-interactive elements] (non-ARIA clickable)${ranked.length > capped.length ? ' (truncated)' : ''}`);
    for (const ci of capped) {
      cRefCounter++;
      refMap.set(`c${cRefCounter}`, ci);
      treeLines.push(`  [clickable] ${ci.text || ci.sel}  @c${cRefCounter}  (${ci.x},${ci.y} ${ci.w}×${ci.h})`);
    }
  }
  if (cursorInteractive && meta.visibleControls?.length > 0) {
    const refAnns = refAnnotationsFromTreeLines(treeLines);
    const axIdentities = axIdentityByRefMap(axNodes, activeRefMap);
    const ranked = rankPerceiveCursorItems(
      meta.visibleControls.map(control => attachRefToVisibleControl(control, refAnns, axIdentities)),
      item => item.label || item.ariaLabel || item.text || item.title,
    );
    const formatted = ranked.map(control => `  ${formatVisibleControlLine(control)}`);
    const listed = verbose ? formatted : dedupeRepeatedLines(formatted, treeLines);
    const capped = listed.slice(0, cursorLimit);
    const pageTruncated = Boolean(meta.visibleControlsTruncated);
    if (pageTruncated || listed.length > capped.length) outputTruncated = true;
    treeLines.push('');
    treeLines.push(formatVisibleControlsHeader({
      shown: capped.length,
      collected: listed.length,
      pageTruncated,
    }));
    for (const line of capped) treeLines.push(line);
  }
  if (lastPerceiveStore && typeof lastPerceiveStore === 'object') lastPerceiveStore.outputTruncated = outputTruncated;

  // === Assemble output ===
  const lines = [];
  const unsafeFull = opts.unsafeFull === true;
  const crossSiteRead = frame?.process === 'oopif';
  const crossHost = crossSiteRead ? originHost(frame.securityOrigin) : '';
  if (crossSiteRead) lines.push(`Page: ${crossHost}`);
  else lines.push(`Page: ${meta.title} — ${displayUrl(meta.url, { unsafeFull })}`);
  if (frame) {
    if (crossSiteRead) lines.push(crossHost ? `Frame: ${frame.ref} ${crossHost}` : `Frame: ${frame.ref}`);
    else {
      const label = frame.name || '(anonymous)';
      const url = displayUrl(frame.url || frame.unreachableUrl || '(no url)', { unsafeFull });
      lines.push(`Frame: ${frame.ref} ${label} ${frame.id} ${url}`);
    }
  }

  const scrollPct = meta.scrollMax > 0 ? Math.round(meta.scrollY / meta.scrollMax * 100) : 0;
  const focused = crossSiteRead ? crossSiteFocusedTag(meta.focused) : meta.focused;
  lines.push(`Viewport: ${meta.vw}×${meta.vh} | Scroll: ${meta.scrollY}/${meta.scrollMax > 0 ? meta.scrollMax : 0} (${scrollPct}%) | Focused: ${focused}`);
  if (typeaheadFilter.omitted) lines.push(TYPEAHEAD_OMITTED_NOTICE);

  const countParts = Object.entries(meta.counts).map(([k, v]) => `${v} ${k}`);
  lines.push(`Interactive: ${countParts.length > 0 ? countParts.join(', ') : 'none'}`);

  const healthParts = [];
  if (errors > 0) healthParts.push(`${errors} error${errors > 1 ? 's' : ''}`);
  if (warnings > 0) healthParts.push(`${warnings} warning${warnings > 1 ? 's' : ''}`);
  if (exceptions > 0) healthParts.push(`${exceptions} exception${exceptions > 1 ? 's' : ''}`);
  lines.push(`Console: ${healthParts.length > 0 ? healthParts.join(', ') : 'clean'}`);
  if (frameNotice) {
    retainPrintedFrameBlocks(frameNotice.slots, treeLines);
    renderFrameNoticeLine(frameNotice);
  }
  if (frameNotice?.line) lines.push(frameNotice.line);
  // Coordinate hint — top-level viewport CSS pixels match clickxy/Input events.
  // Fixed/sticky elements include a "fixed"/"sticky" tag so agents do not
  // misread negative scroll-relative Ys as off-screen.
  lines.push(formatPerceiveCoordsLine(verbose));

  const headerLines = lines.slice();
  lines.push('');
  lines.push(...treeLines);

  const output = lines.join('\n');
  const identityTree = annotatePerceiveIdentityLines(treeLines, refNodeIds);
  const identityOutput = identityTree === treeLines
    ? output
    : [...lines.slice(0, lines.length - treeLines.length), ...identityTree].join('\n');

  const publishImplicitFrameRecords = () => {
    if (crossSiteRead) return;
    const records = frameNotice?.records || [];
    rememberPerceiveFrameRecords(cdp, records.length ? { frames: records } : null);
  };
  const presentCrossSite = (text, { reuseHeader = false } = {}) => {
    const nonce = createFrameContentNonce();
    const origin = frameContentOrigin(frame.securityOrigin);
    const printed = reuseHeader
      ? `${headerLines.join('\n')}\n\n${wrapFrameContent(text, { nonce, origin })}`
      : wrapCrossSiteOutput(text, frame, nonce).text;
    rememberCrossSiteBoundary(cdp, nonce, origin);
    return printed;
  };

  const markPerceived = () => {
    lastPerceiveStore.output = output;
    rememberPerceiveDiffSource(lastPerceiveStore, output, hiddenTextLines, identityOutput);
    lastPerceiveStore.snapshotOpts = perceiveSnapshotOpts(opts);
    if (frame) rememberFramePerceiveOutput(refState, frame.ref, perceiveStoreDiffSource(lastPerceiveStore));
    // Mark refs as freshly assigned (clears 'navigation'/'daemon-start' state).
    if (refState && typeof refState === 'object') {
      refState.lastPerceiveText = output;
      refState.generation = (refState.generation || 0) + 1;
      refState.lastPerceiveAt = Date.now();
      refState.invalidationReason = null;
    }
    publishImplicitFrameRecords();
  };

  if (sinceAction) {
    markPerceived();
    let printed;
    if (!diffBaseline) {
      printed = output + '\n\n(no action baseline available; run `perceive` before a mutating command, or use `perceive --diff` after a normal perceive.)';
    } else {
      const currentSource = perceiveStoreDiffSource(lastPerceiveStore);
      // An action receipt judges whether the page reacted. A node redrawn with
      // the same content is no reaction there (click-no-change stays), so the
      // settle diff drops backend-node marks; perceive --since-action keeps them (#651).
      printed = opts.ignoreNodeIdentity
        ? formatPerceiveDiffOutput(stripPerceiveNodeIdentity(diffBaseline), stripPerceiveNodeIdentity(currentSource), { mode: 'since-action' })
        : formatPerceiveDiffOutput(diffBaseline, currentSource, { mode: 'since-action' });
    }
    return crossSiteRead ? presentCrossSite(printed) : printed;
  }

  // Diff mode: compare with previous perceive output.
  if (diffMode && lastPerceiveStore.output) {
    const previousOutput = perceiveStoreDiffSource(lastPerceiveStore);
    markPerceived();
    const printed = formatPerceiveDiffOutput(previousOutput, perceiveStoreDiffSource(lastPerceiveStore));
    return crossSiteRead ? presentCrossSite(printed) : printed;
  }

  markPerceived();
  let printed = output;
  if (crossSiteRead) printed = presentCrossSite(explicitCrossSiteBody(frame, meta, treeLines), { reuseHeader: true });
  // Hint when perceive returns many interactive elements without exclude
  if (interactiveOnly && !excludeSelector && refNodeIds.length > 50) {
    return printed + `\n\n${perceiveInteractiveNoiseHint(refNodeIds.length)}`;
  }
  return printed;
}
export function perceptionModelFromText(output, refState = {}, targetPrefix = '<target>', opts = {}) {
  const lines = String(output || '').split('\n');
  const header = parsePerceiveHeader(output);

  const nodes = [];
  for (const line of lines) {
    const refMatch = line.match(/\[(\w+)\]\s+(.+?)\s+(@f\d+:\d+|@\d+)(?:\s+\((-?\d+),(-?\d+) (\d+)×(\d+)(?:, [^)]+)?\))?$/);
    if (!refMatch) continue;
    const [, role, rawName, ref, x, y, width, height] = refMatch;
    const node = {
      ref,
      role,
      name: rawName.trim(),
    };
    if (x !== undefined) {
      node.rect = {
        x: Number(x),
        y: Number(y),
        width: Number(width),
        height: Number(height),
      };
    }
    nodes.push(node);
  }

  return createPerceptionModel({
    targetPrefix,
    page: header.page,
    viewport: header.viewport,
    consoleHealth: header.console,
    refs: { generation: refState.generation || 0 },
    nodes,
    limits: {
      truncated: output.includes('truncated') || opts.outputTruncated === true,
      ...(opts.last ? { lastTextRows: opts.last, outputTokenBudget: opts.last * 80 } : {}),
    },
  });
}
export async function perceiveModel(cdp, sid, consoleBuf, exceptionBuf, refMap, lastPerceiveStore, opts = {}, refState = null) {
  const output = await perceiveStr(cdp, sid, consoleBuf, exceptionBuf, refMap, lastPerceiveStore, opts, refState);
  if (String(output || '').includes('chrome-cdp-ex.pdf-viewer.v1')) {
    return pdfViewerHandoffModelFromOutput(output, opts.targetPrefix || '<target>');
  }
  const model = perceptionModelFromText(output, refState || {}, opts.targetPrefix || '<target>', {
    ...opts,
    outputTruncated: lastPerceiveStore?.outputTruncated === true,
  });
  const extra = perceiveFrameRecords(cdp);
  if (extra?.frames?.length) {
    model.frames = extra.frames;
    const originByFrame = new Map();
    for (const frame of extra.frames) {
      if (frame?.ref && frame.content?.read === true && frame.content.origin) {
        originByFrame.set(frame.ref, frame.content.origin);
      }
    }
    for (const node of model.nodes || []) {
      const match = /^(@f\d+):\d+$/.exec(String(node?.ref || ''));
      if (!match || !originByFrame.has(match[1])) continue;
      if (node.frameRef == null) node.frameRef = match[1];
      if (node.origin == null) node.origin = originByFrame.get(match[1]);
    }
  }
  if (extra?.contentBoundary) model.contentBoundary = extra.contentBoundary;
  return model;
}
export async function perceiveDiffModel(cdp, sid, consoleBuf, exceptionBuf, refMap, lastPerceiveStore, opts = {}, refState = null) {
  const mode = opts.sinceAction ? 'since-action' : 'diff';
  const baseline = opts.sinceAction ? opts.diffBaseline : perceiveStoreDiffSource(lastPerceiveStore);
  const printedOutput = await perceiveStr(
    cdp,
    sid,
    consoleBuf,
    exceptionBuf,
    refMap,
    lastPerceiveStore,
    {
      ...opts,
      sinceAction: false,
      diff: false,
      diffBaseline: null,
      // The flags above are cleared so this call stores the full tree. They are
      // also what keeps a surviving @ref (#642); pass that decision through.
      preserveRefs: shouldPreservePerceiveRefs(opts),
    },
    refState
  );
  const currentOutput = perceiveStoreDiffSource(lastPerceiveStore) ?? printedOutput;
  if (!baseline) {
    const header = parsePerceiveHeader(currentOutput);
    const target = opts.targetPrefix || '<target>';
    const nextSteps = [
      `cdp perceive ${target} -C -d 8`,
      `cdp report ${target} --format json`,
    ];
    return {
      schema: 'chrome-cdp-ex.perceive-diff.v1',
      mode,
      baselineAvailable: false,
      ...header,
      summary: {
        changed: null,
        removed: 0,
        added: 0,
        textRemoved: 0,
        textAdded: 0,
      },
      removed: [],
      added: [],
      removedOmitted: 0,
      addedOmitted: 0,
      textRemovedSamples: [],
      textAddedSamples: [],
      recommendation: buildPerceiveDiffRecommendation({
        mode,
        changed: null,
        baselineAvailable: false,
        nextSteps,
      }),
      nextSteps,
    };
  }
  return buildPerceiveDiffModel(baseline, currentOutput, {
    mode,
    targetPrefix: opts.targetPrefix || '',
  });
}
// Element screenshot: targeted capture of a specific element by CSS selector or @ref
// Page.captureScreenshot reads `clip` in document coordinates, while element boxes come
// from getBoundingClientRect (viewport coordinates): add the scroll offset, or a scrolled
// page captures the wrong region (#452). `pad` CSS px of context is kept around the box.
export function elementScreenshotClip(rect, scroll = {}, pad = 8) {
  const scrollX = Number(scroll.x) || 0;
  const scrollY = Number(scroll.y) || 0;
  return {
    x: Math.max(0, rect.x - pad + scrollX),
    y: Math.max(0, rect.y - pad + scrollY),
    width: rect.w + pad * 2,
    height: rect.h + pad * 2,
    scale: 1,
  };
}
// Click's nameOf rule: collapse whitespace, then keep 80 characters. No ellipsis (#547).
export function elshotReceiptLabel(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().substring(0, 80);
}
export function formatElshotReceipt(desc, { w, h, clip = null, fallback = false, path }) {
  const fb = fallback ? ' (fallback)' : '';
  const clipText = clip
    ? ` (clip: ${Math.round(clip.width)}×${Math.round(clip.height)} with padding)`
    : '';
  return `Element screenshot of ${desc} — ${Math.round(w)}×${Math.round(h)} CSS px${clipText}${fb} -> ${path}`;
}
// The elshot @ref label, by the shared target-label rule (#547, #745): aria-label, then
// visible text, then title, whitespace collapsed before the 80-character cut.
export async function elshotRefLabel(cdp, sid, refMap, ref, refState) {
  const objectId = await resolveRefNode(cdp, sid, refMap, ref, refState);
  const read = await cdpDomains(cdp).Runtime.callFunctionOn({
    objectId,
    functionDeclaration: `function() {
      /* elshot-label */
      return ${targetLabelExpression('this')};
    }`,
    returnByValue: true,
  }, sid, REF_RESOLVE_TIMEOUT);
  if (read.exceptionDetails) throw new Error(runtimeExceptionMessage(read.exceptionDetails));
  return String(read.result?.value ?? '');
}
// elshot <sel|@ref> [file] [--format text] (#526): the first positional is the selector, the
// second the output file. Any other flag or a third positional is an error, never a file name.
export function parseElshotArgs(args = []) {
  const positionals = [];
  for (let i = 0; i < args.length; i++) {
    const token = String(args[i] ?? '');
    if (token === '--format') {
      if (String(args[i + 1] ?? '') !== 'text') throw new Error('elshot: --format must be text');
      i++;
      continue;
    }
    if (token.startsWith('-')) throw new Error(`elshot: unknown argument ${token}`);
    positionals.push({ value: token, index: i });
  }
  if (positionals.length > 2) {
    throw new Error(`elshot: unexpected argument ${positionals[2].value}; quote a selector with spaces (elshot <target> <sel|@ref> [file])`);
  }
  return {
    selector: positionals[0]?.value || '',
    filePath: positionals[1]?.value || null,
    fileIndex: positionals[1]?.index ?? -1,
  };
}
export function perceiveReadinessRecovery(target) {
  return {
    kind: 'loading',
    strategy: 'retry-perceive',
    run: `cdp perceive ${target} -C -d 8`,
    reason: 'Target metadata advertises an HTTP(S) page, but the renderer stayed blank through bounded readiness sampling. Retry perceive without navigating.',
  };
}
export const PERCEIVE_READINESS_DELAYS_MS = Object.freeze([0, 250, 500, 1000]);
export async function readPerceiveTargetMetadata(cdp, targetId) {
  const pages = await getPages(cdp);
  return pages.find(page => page.targetId === targetId) || null;
}
export async function readPerceiveDocumentState(cdp, sid) {
  const value = await evalStr(
    cdp,
    sid,
    'JSON.stringify({ url: window.location.href, readyState: document.readyState })',
    false,
    { timeoutMs: STATUS_PAGE_INFO_TIMEOUT },
  );
  const state = JSON.parse(value);
  return {
    url: String(state?.url || ''),
    readyState: String(state?.readyState || 'unknown'),
  };
}
export async function ensurePerceiveTargetReady({ cdp, sessionId, targetId, ops = {} }) {
  const readTargetMetadata = ops.readPerceiveTargetMetadata || readPerceiveTargetMetadata;
  const readDocumentState = ops.readPerceiveDocumentState || readPerceiveDocumentState;
  const sampleDelaysMs = ops.perceiveReadinessDelaysMs || PERCEIVE_READINESS_DELAYS_MS;
  const wait = ops.sleep || sleep;
  const now = ops.now || Date.now;
  let target;
  try {
    target = await readTargetMetadata(cdp, targetId);
  } catch {
    return;
  }
  const advertisedUrl = String(target?.url || '').trim();
  if (!/^https?:\/\//i.test(advertisedUrl)) return;

  const delays = Array.isArray(sampleDelaysMs) && sampleDelaysMs.length
    ? sampleDelaysMs
    : PERCEIVE_READINESS_DELAYS_MS;
  const startedAt = now();
  let observed = { url: '', readyState: 'unknown' };
  for (let index = 0; index < delays.length; index++) {
    const delayMs = Math.max(0, Number(delays[index]) || 0);
    if (delayMs > 0) await wait(delayMs);
    observed = await readDocumentState(cdp, sessionId);
    if (!isBlankPageUrl(observed?.url)) return;
  }

  const observedUrl = String(observed?.url || '');
  const readyState = String(observed?.readyState || 'unknown');
  throw new Error(
    'perceive: target/document readiness mismatch; ' +
    `targetId=${targetId}; requestedTargetId=${targetId}; resolvedTargetId=${targetId}; ` +
    `boundTargetId=${targetId}; advertisedUrl=${advertisedUrl}; observedUrl=${observedUrl}; ` +
    `readyState=${readyState}; attempts=${delays.length}/${delays.length}; elapsedMs=${Math.max(0, now() - startedAt)}. ` +
    'The target metadata advertises a loaded HTTP(S) page while its renderer is still blank; retry the same perceive command.'
  );
}
