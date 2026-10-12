// Moved from cdp.mjs without changes (#688). cdp.mjs is the entry point and re-exports for tests.
import { isTimeoutError } from './action-recovery.mjs';
import { createPerceptionModel } from './perception-model.mjs';

import { actionDomDiffShowsChange, countTypeaheadLabels, extractTypeaheadLabels } from './cdp-action-result.mjs';
import { CONTENT_REF_ROLES, ENRICHED_ROLES, HIDDEN_TEXT_CAP_NOTE, HIDDEN_TEXT_MAX_CHARS, HIDDEN_TEXT_MAX_LINES, HOVER_MUTATION_MARKER, HOVER_MUTATION_TIMEOUT_MS, INTERACTIVE_ROLES, PERCEIVE_CHROME_LANDMARK_ROLES, PERCEIVE_CHROME_LINE_CAP, PERCEIVE_CHROME_MAX_RELATIVE_DEPTH, PERCEIVE_COMPACT_FLAGS, PERCEIVE_CONTENT_LANDMARK_ROLES, PERCEIVE_COORDS_LINE, PERCEIVE_COORDS_LINE_VERBOSE, PERCEIVE_CURSOR_SURFACE_DEFAULT_CAP, PERCEIVE_SNAPSHOT_FLAGS, REF_HIGH_WATER, REF_RESOLVE_TIMEOUT, REF_SETTLE_BUDGET_MS, SKIP_LINK_NAME_RE, STALE_REF_ERROR_CODE, TYPEAHEAD_FOCUS_ROLES, TYPEAHEAD_POPUP_ROLES, VISIBLE_CONTROL_CAP_SWAP_SAMPLE } from './cdp-base.mjs';
import { formatJson, parseFormatArgs, takeUnsafeFullArg } from './cdp-browser.mjs';
import { displayUrl } from './cdp-core.mjs';
import { actionabilityFunctionSource } from './cdp-input.mjs';
import { cdpDomains, evalStr, formatAxNode, isPriorityPerceiveTextLine, orderedAxChildren, runtimeExceptionMessage, shouldShowAxNode } from './cdp-page.mjs';

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
export async function resolveRefNode(cdp, sid, refMap, ref, refState, options = {}) {
  const frameParsed = parseFrameRef(ref);
  let num = null;
  let backendNodeId;
  let frameId = null;
  if (frameParsed) {
    const scoped = frameScopedBackendNode(refState || {}, frameParsed);
    backendNodeId = scoped.backendNodeId;
    frameId = scoped.entry.frameId;
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
    sid,
    frameId || await rootFrameId(cdp, sid),
  );
  let object;
  try {
    ({ object } = await cdpDomains(cdp).DOM.resolveNode({
      backendNodeId,
      executionContextId,
    }, sid, REF_RESOLVE_TIMEOUT));
  } catch (error) {
    if (isMissingDomNodeError(error)) {
      throw await staleRefError(cdp, sid, refMap, ref, refState, error, { contextId: executionContextId });
    }
    throw error;
  }
  if (!object?.objectId) throw new Error('DOM.resolveNode did not return an object id');
  const validation = await cdpDomains(cdp).Runtime.callFunctionOn({
    objectId: object.objectId,
    functionDeclaration: trustedRefConnectivityFunctionDeclaration(),
    returnByValue: true,
  }, sid, REF_RESOLVE_TIMEOUT);
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
      pageResult = await cdpDomains(cdp).DOM.resolveNode({ backendNodeId }, sid, REF_RESOLVE_TIMEOUT);
    } catch (error) {
      if (isMissingDomNodeError(error)) {
        throw await staleRefError(cdp, sid, refMap, ref, refState, error, { contextId: executionContextId });
      }
      throw error;
    }
    if (!pageResult.object?.objectId) throw new Error('DOM.resolveNode did not return a page-world object id');
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
    // #601 large: walk from the hit upward. Measure only the first fixed/sticky ancestor that
    // does not contain the click target and can receive hits (pointer-events is not none).
    // A pointer-events:none shell (react-hot-toast) and a fixed app shell that contains the
    // target do not qualify, so Next stays a JS click.
    const dialogSelector = 'dialog,[role="dialog"],[role="alertdialog"],[aria-modal="true"]';
    let layer = null;
    let dialog = false;
    let largeCover = null;
    for (let node = top, guard = 0; node && node.nodeType === 1 && guard < 64; node = composedParent(node), guard++) {
      const position = positionOf(node);
      if (position === 'fixed' || position === 'sticky') {
        if (!layer) layer = { node, position };
        if (!largeCover && !composedContains(node, target)) {
          let pointerEvents = '';
          try { pointerEvents = getComputedStyle(node).pointerEvents || ''; } catch { pointerEvents = ''; }
          if (pointerEvents !== 'none') largeCover = node;
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
      text: (this.getAttribute('aria-label') || this.getAttribute('title') || this.textContent || '').trim().substring(0, 80),
      role: (typeof this.getAttribute === 'function' ? this.getAttribute('role') : '') || '',${hitTest ? `
      hit,
      disabled: actionDisabledReason(this),` : ''}
    };
  }`;
}
export async function resolveRef(cdp, sid, refMap, ref, refState, { hitTest = false } = {}) {
  const frameParsed = parseFrameRef(ref);
  const objectId = await resolveRefNode(cdp, sid, refMap, ref, refState);
  let result;
  try {
    result = await cdpDomains(cdp).Runtime.callFunctionOn( {
      objectId,
      functionDeclaration: scrollSettledRectFunctionDeclaration({ hitTest }),
      returnByValue: true,
      awaitPromise: true,
    }, sid, REF_RESOLVE_TIMEOUT);
  } catch (error) {
    if (isTimeoutError(error, ['Runtime.callFunctionOn'])) {
      // resolveRefRectNoScroll returns { rect, objectId }; callers of resolveRef read the
      // rect fields directly, so unwrap it (#464: x/y were undefined → NaN click point).
      const { rect } = await resolveRefRectNoScroll(cdp, sid, refMap, ref, refState, { objectId });
      const value = { ...rect, connected: true, settled: false };
      if (hitTest) {
        // No settle happened, so check the point now: a covered target still fails as
        // covered instead of clicking whatever sits there.
        const probe = await resolveRefRectNoScroll(cdp, sid, refMap, ref, refState, {
          objectId,
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
    const { entry } = frameScopedBackendNode(refState || {}, frameParsed);
    const offset = await frameViewportOffset(cdp, sid, entry, { settle: true });
    value.x = (Number(value.x) || 0) + offset.x;
    value.y = (Number(value.y) || 0) + offset.y;
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
  for (const frame of frames) {
    const indent = '  '.repeat(Math.min(frame.depth || 0, 8));
    const label = frame.name || '(anonymous)';
    const parent = frame.parentRef ? ` parent:${frame.parentRef}` : '';
    const origin = frame.securityOrigin ? ` origin:${frame.securityOrigin}` : '';
    const url = frame.url || frame.unreachableUrl || '(no url)';
    lines.push(`${indent}${frame.ref} ${label} ${frame.id}${parent} ${url}${origin}`);
  }
  lines.push('Hint: use frame refs to diagnose wrong-frame errors; element refs inside frames will use @fN:M syntax.');
  return lines.join('\n');
}
export async function framesModel(cdp, sid) {
  const result = await cdpDomains(cdp).Page.getFrameTree( {}, sid);
  const frames = flattenFrameTree(result.frameTree);
  return {
    schema: 'chrome-cdp-ex.frames.v1',
    frameCount: frames.length,
    frames,
  };
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
export async function framesStr(cdp, sid, { format = 'text', unsafeFull = false } = {}) {
  const model = await framesModel(cdp, sid);
  const frames = (model.frames || []).map(frame => displayedFrame(frame, { unsafeFull }));
  if (format === 'json') return formatJson({ ...model, frames });
  return formatFrameTreeText(frames);
}
export async function resolveFrameRef(cdp, sid, frameRef) {
  const parsed = parseFrameOnlyRef(frameRef);
  if (!parsed) throw new Error(`Frame ref required (example: @f2), got: ${frameRef || '(empty)'}`);
  const model = await framesModel(cdp, sid);
  const frame = model.frames[parsed.frameIndex - 1];
  if (!frame || frame.ref !== parsed.frameRef) {
    throw new Error(`Unknown frame: ${parsed.frameRef}. Run "frame" to refresh the frame tree, then use a listed @fN ref.`);
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
    refs: new Map(scopedRefMap),
    frames: frames || [],
  });
}
export function frameScopedRefEntry(refState, parsed) {
  const store = refState?.frameRefs;
  if (!(store instanceof Map)) return null;
  return store.get(parsed.frameRef) || null;
}
export function frameScopedBackendNode(refState, parsed) {
  const entry = frameScopedRefEntry(refState, parsed);
  if (!entry) {
    throw new Error(`Unknown frame ref: ${parsed.frameRef}. Run "frame", then "perceive --frame ${parsed.frameRef}" to assign iframe-local refs.`);
  }
  if (!(entry.refs instanceof Map) || !entry.refs.has(parsed.refIndex)) {
    throw new Error(`Unknown ref: ${parsed.frameRef}:${parsed.refIndex}. Run "perceive --frame ${parsed.frameRef}" to refresh refs inside that frame.`);
  }
  return { entry, backendNodeId: entry.refs.get(parsed.refIndex) };
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
  const objectId = options.objectId || await resolveRefNode(cdp, sid, refMap, ref, refState);
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
        text: (this.getAttribute('aria-label') || this.getAttribute('title') || this.textContent || '').trim().substring(0, 80),
        position: cs ? cs.position : '',
        pointerEvents: cs ? cs.pointerEvents : '',
        visible: !!(rect.width && rect.height),
      };
    }`,
    returnByValue: true,
  }, sid, REF_RESOLVE_TIMEOUT);
  const value = result.result.value || {};
  if (options.functionDeclaration) return value;
  if (frameParsed) {
    const { entry } = frameScopedBackendNode(refState || {}, frameParsed);
    const offset = await frameViewportOffset(cdp, sid, entry);
    value.x = (Number(value.x) || 0) + offset.x;
    value.y = (Number(value.y) || 0) + offset.y;
  }
  return { rect: value, objectId };
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
  return actionDomDiffShowsChange(formatPerceiveDiffOutput(before, after, { mode: 'since-action' }));
}
export function discardHoverIdleBaseline(lastPerceiveStore) {
  if (!lastPerceiveStore || typeof lastPerceiveStore !== 'object') return;
  lastPerceiveStore.output = null;
}
export function validateUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error(`Invalid URL: ${url}`); }
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
export function stripPerceiveIdentityChrome(line) {
  // Fold tags (`↑above fold` / `↓below fold`) are viewport chrome on the
  // same landmark identity (#297). Title-only selector+class chrome is
  // identity chrome (#303). Do not strip Visible-control membership.
  return stripPerceiveSelectorChrome(
    stripPerceiveRectChrome(line).replace(/\s+[↑↓](?:above|below) fold\b/g, ''),
  );
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
export function computePerceiveDiff(previousOutput, currentOutput) {
  const prev = previousOutput.split('\n');
  const curr = currentOutput.split('\n');
  // Skip header lines up to the first blank line. Frame-scoped perceive adds
  // a `Frame:` header, so avoid hard-coding the legacy 5-line header shape.
  const prevHeaderEnd = prev.findIndex(line => line === '');
  const currHeaderEnd = curr.findIndex(line => line === '');
  const prevTreeStart = prevHeaderEnd >= 0 ? prevHeaderEnd + 1 : 5;
  const currTreeStart = currHeaderEnd >= 0 ? currHeaderEnd + 1 : 5;
  const prevTree = prev.slice(prevTreeStart).map(stripPerceiveIdentityChrome);
  const currTree = curr.slice(currTreeStart).map(stripPerceiveIdentityChrome);
  // Line-level diff with StaticText noise filtering. A ref number is not page identity: an action
  // settle, --since-action, and --diff keep numbers (#548, #642) and a later plain perceive
  // renumbers, so lines compare without `@N`. Reported lines keep their refs.
  const refFreeKey = line => line.replace(/\s+@(?:c?\d+|f\d+:\d+)(?=\s|$)/g, '');
  // Count each key, so one of two identical lines going away is still reported.
  const unmatched = (lines, other) => {
    const left = new Map();
    for (const line of other) left.set(refFreeKey(line), (left.get(refFreeKey(line)) || 0) + 1);
    return lines.filter(line => {
      const key = refFreeKey(line);
      const count = left.get(key) || 0;
      if (count > 0) {
        left.set(key, count - 1);
        return false;
      }
      return true;
    });
  };
  const removed = unmatched(prevTree, currTree);
  const added = unmatched(currTree, prevTree);
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

      return JSON.stringify({
        title: document.title, url: window.location.href,
        contentType: document.contentType || '',
        vw, vh, scrollY, scrollMax,
        counts, focused: focusDesc, layoutMap, styleHints, cursorInteractives,
        visibleControls, visibleControlsTruncated, cardWindows
      });
    })()`;
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
// resolveRef's text is already cut at 80 before whitespace collapse. Read the full
// aria-label, title, or textContent here so elshot cuts after collapse (#547).
export async function elshotRefLabel(cdp, sid, refMap, ref, refState) {
  const objectId = await resolveRefNode(cdp, sid, refMap, ref, refState);
  const read = await cdpDomains(cdp).Runtime.callFunctionOn({
    objectId,
    functionDeclaration: `function() {
      /* elshot-label */
      return (this.getAttribute('aria-label') || this.getAttribute('title') || this.textContent || '').replace(/\\s+/g, ' ').trim().substring(0, 80);
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
