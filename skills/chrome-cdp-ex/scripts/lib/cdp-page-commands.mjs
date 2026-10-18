// Moved from cdp.mjs without changes (#688). cdp.mjs is the entry point and re-exports for tests.
import { actionFailureMessage, classifyActionFailure, isClassifiedActionFailureText, isTimeoutError, querySelectorEvalCommand } from './action-recovery.mjs';
import { bindCdpTransport, createRawCdpGateway } from './cdp-domains.mjs';
import { buildNetlogListModel, buildNetlogRequestModel, formatNetlogListText, formatNetlogRequestText, summarizeResponseBody, unavailableBody, writeNetlogBodyFile } from './netlog.mjs';
import { formatNextLine } from './next-line.mjs';
import { extractPdfPageText } from './pdf-text.mjs';
import { REDACTED_VALUE, redactSensitiveString, redactUrl } from './redaction.mjs';
import { TABLE_EXTRACTION_LIMITS, addTableSampleBatch, buildTableExportBundle, canonicalizeTableCells, createTableAccumulator, finalizeTableExtraction } from './table-extraction.mjs';
import { buildTableSamplerExpression, parseTableSamplerResult } from './table-sampler.mjs';
import { randomBytes } from 'crypto';
import { readFileSync, statSync } from 'fs';
import { basename, resolve } from 'path';
import { compactActionText, isSensitiveDataKey, redactSensitiveArtifactValue } from './cdp-action-result.mjs';
import { ACCEPT_DIALOG_FLAG, DECISION_DIALOG_TYPES, FULLSHOT_MAX_CAPTURE_HEIGHT, INPUT_NOT_DELIVERED_KINDS, LOADALL_DEFAULT_INTERVAL_MS, LOADALL_DEFAULT_TIMEOUT_MS, LOADALL_MAX_TIMEOUT_MS, MAX_ACTION_DIALOG_MESSAGE_CHARS, MAX_NETWORK_MOCK_HITS, MOCK_PATTERN_END, NAVIGATION_TIMEOUT, REF_RESOLVE_TIMEOUT, TABLE_COLLECTOR_OBJECT_GROUP, TABLE_COLLECTOR_WORLD, THROTTLE_PRESETS, sleep } from './cdp-base.mjs';
import { formatJson, parseFormatArgs, takeUnsafeFullArg } from './cdp-browser.mjs';
import { parseNonNegativeInteger } from './cdp-cli.mjs';
import { TableCollectionDeadlineError, displayUrl, rememberTabEnvironment, rememberTabObservation, runTableCollectionLifecycle, throwIfRequestAborted } from './cdp-core.mjs';
import { dispatchClick, scrollEdgeLogicSource } from './cdp-input.mjs';
import { assertNotPdfViewerPage, cdpDomains, evalStr, isPdfViewerContentType, loadPdfBytesForText, pdfViewerError, runtimeExceptionMessage } from './cdp-page.mjs';
import { isCursorRef, isRef, resolveCursorRef, resolveRefNode, validateUrl } from './cdp-perceive.mjs';
import { appendSessionEnvironmentLog } from './cdp-session-report.mjs';

export function fullshotFitsViewport(content = {}, viewport = null) {
  const width = Number(content.width);
  const height = Number(content.height);
  const viewportWidth = Number(viewport?.w);
  const viewportHeight = Number(viewport?.h);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return true;
  if (!Number.isFinite(viewportWidth) || !Number.isFinite(viewportHeight) || viewportWidth <= 0 || viewportHeight <= 0) {
    return true;
  }
  return width <= viewportWidth + 1 && height <= viewportHeight + 1;
}

function fullshotUsageError(message) {
  const err = new Error(message);
  err.usage = true;
  err.code = 'usage';
  return err;
}

export function fullshotFrameRefError(ref) {
  return fullshotUsageError(
    `fullshot: --scroll-container ${ref} is a frame ref. The container is looked up in the main document, so use a main-document @ref or a CSS selector.`,
  );
}

export function parseFullshotArgs(args = []) {
  const list = Array.isArray(args) ? args : [];
  let container = null;
  let filePath = null;
  let format = 'text';
  for (let i = 0; i < list.length; i++) {
    const token = list[i];
    if (token === '--scroll-container') {
      const value = list[++i];
      if (value == null || String(value).startsWith('--')) {
        throw fullshotUsageError('fullshot: --scroll-container requires a CSS selector or an @ref');
      }
      if (container != null) throw fullshotUsageError('fullshot: duplicate --scroll-container');
      container = String(value);
      continue;
    }
    if (token === '--format') {
      const value = list[++i];
      if (value !== 'text' && value !== 'json') {
        throw fullshotUsageError('fullshot: format must be text or json');
      }
      format = value;
      continue;
    }
    if (String(token).startsWith('--')) throw fullshotUsageError(`fullshot: unknown argument ${token}`);
    if (filePath != null) throw fullshotUsageError(`fullshot: unexpected argument ${token}`);
    filePath = String(token);
  }
  return { filePath, scrollContainer: container, format };
}

export function capFullshotHeight(height, max = FULLSHOT_MAX_CAPTURE_HEIGHT) {
  const content = Math.max(1, Math.round(Number(height) || 0));
  const limit = Math.max(1, Math.round(Number(max) || FULLSHOT_MAX_CAPTURE_HEIGHT));
  if (content <= limit) return { height: content, capped: false, max: limit, content };
  return { height: limit, capped: true, max: limit, content };
}

export function buildFullshotModel({ path, width, height, dpr, container = null, capped = null } = {}) {
  const model = {
    schema: 'chrome-cdp-ex.fullshot.v1',
    path,
    width,
    height,
    dpr,
    capped: capped?.capped === true,
  };
  if (container) model.scrollContainer = container;
  if (capped?.capped === true) model.contentHeight = capped.content;
  return model;
}

export function formatFullshotReceipt({ path, width, height, dpr, diagnostics = '', container = null, capped = null } = {}) {
  const fb = diagnostics ? ` ${diagnostics}` : '';
  const capNote = capped?.capped === true
    ? `Height capped at ${capped.max} CSS px (content is ${capped.content}px).`
    : '';
  if (!container) {
    const cap = capNote ? `\n${capNote}` : '';
    return `${path}\nFull-page screenshot saved. Size: ${width}x${height} CSS px, DPR: ${dpr}${fb}${cap}\nNote: large pages produce tiny text. Use 'scanshot' for readable segmented capture.`;
  }
  const cap = capNote ? ` ${capNote}` : '';
  return `${path}\nSaved full-page screenshot ${path} (scrolled container ${container}, ${width}×${height}).${cap}${fb}\nNote: large pages produce tiny text. Use 'scanshot' for readable segmented capture.`;
}

export function formatFullshotOutput(info, format = 'text') {
  if (format === 'json') return formatJson(buildFullshotModel(info));
  return formatFullshotReceipt(info);
}

export function fullshotPlanError(plan = {}) {
  if (plan.kind === 'selector') {
    const err = new Error(`fullshot: no element matched ${plan.selector || ''}`.trim());
    err.selectorMiss = true;
    return err;
  }
  if (plan.kind === 'usage') {
    const who = plan.label || 'element';
    return fullshotUsageError(
      `fullshot: ${who} does not scroll (scrollHeight ${plan.scrollHeight}, clientHeight ${plan.clientHeight})`,
    );
  }
  return fullshotUsageError(`fullshot: ${plan.error || 'could not use that scroll container'}`);
}

function fullshotRestoreBody() {
  return `
    const saved = window.__cdpFullshotRestore;
    window.__cdpFullshotRestore = null;
    if (saved && saved.nodes) {
      for (let i = saved.nodes.length - 1; i >= 0; i--) {
        const item = saved.nodes[i];
        const el = item.el;
        if (!el) continue;
        if (item.stylePresent) {
          try { el.setAttribute('style', item.style == null ? '' : String(item.style)); } catch (err) {}
        } else {
          // Chrome writes style="" back on removeAttribute unless that attribute was read first.
          try { el.getAttribute('style'); } catch (err) {}
          try { el.removeAttribute('style'); } catch (err) {}
        }
        try {
          Element.prototype.scrollTo.call(el, { left: item.scrollLeft, top: item.scrollTop, behavior: 'instant' });
        } catch (err) {}
      }
      const scroller = document.scrollingElement || document.documentElement;
      if (scroller) {
        try {
          Element.prototype.scrollTo.call(scroller, { left: saved.scrollX || 0, top: saved.scrollY || 0, behavior: 'instant' });
        } catch (err) {}
      }
    }
    if (document.querySelectorAll) {
      const marked = document.querySelectorAll('[data-cdp-fullshot-target]');
      for (let i = 0; i < marked.length; i++) {
        try { marked[i].removeAttribute('data-cdp-fullshot-target'); } catch (err) {}
      }
    }
    try {
      const injected = document.querySelector('style[data-cdp-fullshot]');
      if (injected) injected.remove();
    } catch (err) {}
  `;
}

// Hides the scrollbar that appears once html/body overflow is visible.
// setScrollbarsHidden applies on a later layout, so the capture measures only
// after this sheet is in the document, offsetWidth has been read, and one frame
// has passed. fullshotRestoreExpression removes the sheet.
export function fullshotHideScrollbarsExpression() {
  return `(async function() {
    /* chrome-cdp-ex.fullshot-scrollbars */
    const css = 'html{scrollbar-width:none} ::-webkit-scrollbar{display:none}';
    let node = document.querySelector('style[data-cdp-fullshot]');
    if (!node) {
      node = document.createElement('style');
      node.setAttribute('data-cdp-fullshot', '');
      (document.head || document.documentElement).appendChild(node);
    }
    node.textContent = css;
    void document.documentElement.offsetWidth;
    await new Promise(r => requestAnimationFrame(() => r()));
    return 'hidden';
  })()`;
}

export function fullshotRestoreExpression() {
  return `(function() {
    /* chrome-cdp-ex.fullshot-restore */
    ${fullshotRestoreBody()}
    return 'restored';
  })()`;
}

// Reuses scroll's primaryOverflow (largest overflow auto/scroll/overlay box).
// Explicit --scroll-container must be that element: a miss is selector, a box
// that does not scroll is usage. The document gate is scrollHeight <= clientHeight + 1.
export function fullshotScrollPlanExpression({ selector = null, label = null } = {}) {
  const requested = selector == null ? 'null' : JSON.stringify(selector);
  // Explicit mode prints this name. A pinned @ref keeps the caller's ref; the
  // marker selector is only the lookup handle and is never shown.
  const explicitLabel = label == null ? 'requested' : JSON.stringify(String(label));
  return `(function() {
    /* chrome-cdp-ex.fullshot-scroll */
    ${scrollEdgeLogicSource()}
    const requested = ${requested};
    const doc = document.scrollingElement || document.documentElement;
    const docScrollHeight = Math.round(Number(doc && doc.scrollHeight) || 0);
    const docClientHeight = Math.round(Number(doc && doc.clientHeight) || 0);
    const documentScrolls = docScrollHeight > docClientHeight + 1;
    const describe = function(el) {
      if (!el) return 'element';
      const tag = el.tagName ? String(el.tagName).toLowerCase() : 'element';
      const names = [];
      if (el.classList && el.classList.length) {
        for (let i = 0; i < el.classList.length && names.length < 3; i++) {
          const name = String(el.classList[i] || '');
          if (name) names.push(name);
        }
      } else if (typeof el.className === 'string' && el.className) {
        const parts = el.className.trim().split(/\\s+/);
        for (let i = 0; i < parts.length && names.length < 3; i++) {
          if (parts[i]) names.push(parts[i]);
        }
      }
      if (names.length) return tag + '.' + names.join('.');
      if (el.id) return '#' + String(el.id);
      return tag;
    };
    const elementScrolls = function(el) {
      if (!el || isDocumentScroller(el)) return false;
      const extra = Math.round(Number(el.scrollHeight) || 0) > Math.round(Number(el.clientHeight) || 0) + 1;
      if (!extra) return false;
      const style = typeof window.getComputedStyle === 'function' ? window.getComputedStyle(el) : null;
      const oy = String((style && (style.overflowY || style.overflow)) || '');
      return /(auto|scroll|overlay|hidden)/.test(oy);
    };
    const readStyle = function(node) {
      let present = false;
      if (node && typeof node.hasAttribute === 'function') present = !!node.hasAttribute('style');
      else if (node && typeof node.getAttribute === 'function') present = node.getAttribute('style') != null;
      const value = present && node && typeof node.getAttribute === 'function' ? node.getAttribute('style') : null;
      return { present: present, value: value };
    };
    const expand = function(el) {
      const nodes = [];
      for (let node = el; node; node = node.parentElement) {
        const savedStyle = readStyle(node);
        nodes.push({
          el: node,
          style: savedStyle.value,
          stylePresent: savedStyle.present,
          scrollTop: Math.round(Number(node.scrollTop) || 0),
          scrollLeft: Math.round(Number(node.scrollLeft) || 0),
        });
        if (node === document.documentElement) break;
      }
      window.__cdpFullshotRestore = {
        nodes: nodes,
        scrollX: Math.round(Number(window.scrollX) || 0),
        scrollY: Math.round(Number(window.scrollY) || 0),
      };
      const contentHeight = Math.round(Number(el.scrollHeight) || 0);
      el.style.setProperty('height', contentHeight + 'px', 'important');
      el.style.setProperty('max-height', 'none', 'important');
      el.style.setProperty('overflow', 'visible', 'important');
      el.style.setProperty('overflow-y', 'visible', 'important');
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i].el;
        if (node === el) continue;
        node.style.setProperty('height', 'auto', 'important');
        node.style.setProperty('max-height', 'none', 'important');
        node.style.setProperty('overflow', 'visible', 'important');
        node.style.setProperty('overflow-y', 'visible', 'important');
      }
      return contentHeight;
    };
    try {
      let el = null;
      let how = 'document';
      if (requested) {
        let found = null;
        if (typeof document.querySelector !== 'function') {
          return JSON.stringify({ ok: false, kind: 'selector', selector: ${explicitLabel} });
        }
        try {
          found = document.querySelector(requested);
        } catch (err) {
          return JSON.stringify({ ok: false, kind: 'invalid', error: 'invalid selector: ' + ${explicitLabel}, selector: ${explicitLabel} });
        }
        if (!found) return JSON.stringify({ ok: false, kind: 'selector', selector: ${explicitLabel} });
        if (!elementScrolls(found)) {
          return JSON.stringify({
            ok: false,
            kind: 'usage',
            label: describe(found),
            scrollHeight: Math.round(Number(found.scrollHeight) || 0),
            clientHeight: Math.round(Number(found.clientHeight) || 0),
          });
        }
        el = found;
        how = 'explicit';
      } else if (!documentScrolls) {
        el = primaryOverflow();
        if (el) how = 'auto';
      }
      if (!el) {
        return JSON.stringify({ ok: true, mode: 'document', documentScrolls: documentScrolls });
      }
      const contentHeight = expand(el);
      return JSON.stringify({
        ok: true,
        mode: 'container',
        how: how,
        label: how === 'explicit' ? ${explicitLabel} : describe(el),
        contentHeight: contentHeight,
        scrollTop: window.__cdpFullshotRestore.nodes[0].scrollTop,
      });
    } catch (err) {
      ${fullshotRestoreBody()}
      return JSON.stringify({ ok: false, kind: 'invalid', error: String(err && err.message || err) });
    }
  })()`;
}

export function fullshotHelpLines() {
  return [
    '--scroll-container <sel|@ref> captures that element\'s full scroll height, then restores its scroll position and any styles fullshot changed.',
    'With no flag, a document that does not scroll (scrollHeight <= clientHeight + 1) uses the largest visible overflow:auto/scroll/overlay box, the same container scroll picks. When none exists, fullshot captures the document as before.',
    `Height is capped at ${FULLSHOT_MAX_CAPTURE_HEIGHT} CSS px, the same ceiling as a document fullshot, and the receipt says so.`,
    'Fixed and sticky headers are painted once, at their position when the page is at scroll 0, so they are not repeated down the image. A fixed bar can still cover the top of the content; fullshot does not hide it.',
    'A selector that matches nothing is Kind: selector. An element that does not scroll is Kind: usage.',
    'A frame ref such as @f1:3 is Kind: usage. The container is looked up in the main document; use a main-document @ref or a CSS selector.',
    'The receipt and JSON scrollContainer name the caller\'s selector or @ref, or the tag when fullshot picked the container.',
  ];
}
export async function stylesStr(cdp, sid, selectorOrArgs, extra = {}) {
  // Share root/selector resolution with text/html for consistent diagnostics.
  let opts;
  if (Array.isArray(selectorOrArgs)) opts = parseTextArgs(selectorOrArgs);
  else if (typeof selectorOrArgs === 'string' || selectorOrArgs == null) {
    opts = parseTextArgs(selectorOrArgs ? [selectorOrArgs] : []);
  } else opts = { selectors: [], root: null };
  const targetPrefix = extra.targetPrefix || opts.targetPrefix || '<target>';
  await assertNotPdfViewerPage(cdp, sid, { targetPrefix });
  const selector = opts.selectors[0] || null;
  if (!selector) throw new Error('CSS selector required');
  const root = opts.root || 'document';
  const expr = `
    (function() {
      function safeQuery(root, sel) { try { return root?.querySelector?.(sel) || null; } catch { return null; } }
      let scope = document.documentElement;
      const rootSetting = ${JSON.stringify(root)};
      if (rootSetting === 'body') scope = document.body || document.documentElement;
      else if (rootSetting === 'auto' || rootSetting === 'default') {
        scope = safeQuery(document, '#root') || safeQuery(document, '[data-reactroot]') || safeQuery(document, 'main') || document.body || document.documentElement;
      } else if (rootSetting !== 'document') {
        scope = safeQuery(document, rootSetting);
        if (!scope) return JSON.stringify({ ok: false, root: rootSetting, reason: 'root-not-found' });
      }
      const el = scope === document || scope === document.documentElement
        ? safeQuery(document, ${JSON.stringify(selector)})
        : (scope.matches && scope.matches(${JSON.stringify(selector)}) ? scope : safeQuery(scope, ${JSON.stringify(selector)}));
      if (!el) return JSON.stringify({ ok: false, root: rootSetting, selector: ${JSON.stringify(selector)} });
      const cs = window.getComputedStyle(el);
      const props = {};
      const keep = [
        'display','visibility','opacity','position','top','right','bottom','left',
        'width','height','min-width','min-height','max-width','max-height',
        'margin','padding','border','box-sizing','overflow','z-index',
        'flex','flex-direction','flex-wrap','align-items','justify-content','gap',
        'grid-template-columns','grid-template-rows',
        'color','background-color','background','font-size','font-weight','font-family',
        'line-height','text-align','text-decoration','text-overflow','white-space',
        'transform','transition','animation','cursor','pointer-events','user-select',
        'box-shadow','border-radius','outline',
      ];
      const skip = new Set([
        'none','normal','auto','0px','0','visible','static','content-box',
        'start','baseline','inherit','default','clip','row','nowrap',
        'rgb(0, 0, 0)','rgba(0, 0, 0, 0)',
      ]);
      const skipPatterns = [
        /^0px /,
        /^rgba\\(0, ?0, ?0, ?0\\)/,
        /^0 [01]+ auto$/,
        /none 0px$/,
        /^all$/,
      ];
      for (const p of keep) {
        const v = cs.getPropertyValue(p);
        if (!v || skip.has(v)) continue;
        if (skipPatterns.some(re => re.test(v))) continue;
        props[p] = v;
      }
      return JSON.stringify({
        ok: true,
        root: rootSetting,
        tag: el.tagName,
        id: el.id,
        cls: el.className?.toString().substring(0, 80),
        props,
      });
    })()
  `;
  const result = await evalStr(cdp, sid, expr);
  let parsed;
  try { parsed = JSON.parse(result); } catch { parsed = null; }
  if (!parsed || parsed.ok === false) {
    const rootLabel = parsed?.root || root || 'document';
    throw new Error(
      `styles: no element matched within root "${rootLabel}" for selector ${selector}. ` +
      `Fallback: ${querySelectorEvalCommand(targetPrefix, selector, '', { wrap: 'getComputedStyle' }) || `cdp perceive ${targetPrefix} -C -d 8`}`
    );
  }
  // Legacy path: eval may still return a plain object if script changes.
  const r = typeof parsed === 'object' && parsed.props ? parsed : JSON.parse(result);
  const header = '<' + r.tag + '>' + (r.id ? '#' + r.id : '') + (r.cls ? '.' + r.cls.split(' ').join('.') : '');
  const lines = [header];
  for (const [k, v] of Object.entries(r.props || {})) {
    lines.push('  ' + k + ': ' + v);
  }
  return lines.join('\n');
}
// ---------------------------------------------------------------------------
// components — React/Vue component tree + state (MVP)
// ---------------------------------------------------------------------------

export function parseComponentsArgs(args = []) {
  const fopts = parseFormatArgs(args, ['text', 'json']);
  const opts = {
    format: fopts.format,
    depth: 6,
    ref: null,
    selector: null,
    unsafeFull: false,
    maxChars: 2000,
  };
  const positional = [];
  for (let i = 0; i < fopts.args.length; i++) {
    const a = fopts.args[i];
    if (a === '--depth' || a === '-d') {
      const n = parseInt(fopts.args[++i], 10);
      if (!Number.isFinite(n) || n <= 0) throw new Error('components: --depth requires a positive integer');
      opts.depth = Math.min(n, 20);
    } else if (a === '--unsafe-full') {
      opts.unsafeFull = true;
    } else if (a === '--max-chars') {
      const n = Number(fopts.args[++i]);
      if (!Number.isInteger(n) || n < 80 || n > 20000) {
        throw new Error('components: --max-chars requires an integer between 80 and 20000');
      }
      opts.maxChars = n;
    } else if (/^@(?:\d+|c\d+|f\d+:\d+)$/.test(String(a))) {
      opts.ref = a;
    } else if (String(a).startsWith('@')) {
      throw new Error(`components: invalid ref ${a}`);
    } else if (String(a).startsWith('-')) {
      throw new Error(`components: unknown argument ${a}`);
    } else {
      positional.push(a);
    }
  }
  if (!opts.ref && positional[0]) {
    opts.selector = positional[0];
  }
  return opts;
}
export function sanitizeComponentValue(value, { unsafeFull = false, maxChars = 2000 } = {}) {
  const safeValue = unsafeFull ? value : redactSensitiveArtifactValue(value);
  let serialized;
  try {
    serialized = JSON.stringify(safeValue);
  } catch {
    serialized = String(safeValue);
  }
  if (serialized === undefined) serialized = 'undefined';
  const originalChars = serialized.length;
  if (unsafeFull || originalChars <= maxChars) {
    return { value: safeValue, truncated: false, originalChars };
  }
  return {
    value: {
      truncated: true,
      originalChars,
      preview: serialized.slice(0, maxChars),
    },
    truncated: true,
    originalChars,
  };
}
export function sanitizeComponentResult(parsed = {}, opts = {}) {
  if (!parsed?.ok) return parsed;
  const props = sanitizeComponentValue(parsed.props || {}, opts);
  const state = sanitizeComponentValue(parsed.state || {}, opts);
  return {
    ...parsed,
    props: props.value,
    state: state.value,
    privacy: {
      redaction: opts.unsafeFull ? 'unsafe-full' : 'default-redacted',
    },
    limits: {
      maxCharsPerSection: opts.unsafeFull ? null : opts.maxChars,
      props: { truncated: props.truncated, originalChars: props.originalChars },
      state: { truncated: state.truncated, originalChars: state.originalChars },
    },
  };
}
export function frameworkDetectorScript() {
  return `(function() {
    try {
      const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
      if (hook?.renderers?.size > 0) {
        const renderer = Array.from(hook.renderers.values())[0];
        return JSON.stringify({ framework: 'react', version: renderer?.version || 'unknown', source: 'devtools-hook' });
      }
    } catch {}
    try {
      if (window.__VUE__) return JSON.stringify({ framework: 'vue', version: window.__VUE__.version || 'unknown', source: '__VUE__' });
    } catch {}
    try {
      const vueApp = document.querySelector('#app')?.__vue_app__ || document.querySelector('[data-v-app]')?.__vue_app__;
      if (vueApp) return JSON.stringify({ framework: 'vue', version: vueApp.version || '3', source: 'vue_app' });
    } catch {}
    try {
      const el = document.querySelector('[ng-version]');
      if (el) return JSON.stringify({ framework: 'angular', version: el.getAttribute('ng-version') || 'unknown', source: 'ng-version' });
    } catch {}
    // Fiber present without DevTools hook (dev builds)
    try {
      const roots = document.querySelectorAll('[data-reactroot], #root, #__next, #app, [data-reactroot]');
      for (const root of roots) {
        const key = Object.keys(root).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
        if (key) return JSON.stringify({ framework: 'react', version: 'fiber', source: 'fiber-key' });
      }
    } catch {}
    return JSON.stringify({ framework: null });
  })()`;
}
export function componentTreeRedactionHelpersScript() {
  return `
    const sensitiveKey = key => /(?:pass(?:word)?|secret|token|api[_-]?key|auth|session|cookie|credential|private[_-]?key)/i.test(String(key || ''));
    function redactString(value) {
      return String(value)
        .replace(/(authorization\\s*[:=]\\s*(?:bearer\\s+)?)[^\\s,;]+/ig, '$1[REDACTED]')
        .replace(/(bearer\\s+)[A-Za-z0-9._~+\\/=-]+/ig, '$1[REDACTED]');
    }
    function redactNested(value, key = '', depth = 0, seen = new WeakSet()) {
      if (sensitiveKey(key)) return '[REDACTED]';
      if (value == null) return value;
      if (typeof value === 'string') return redactString(value);
      if (typeof value !== 'object') return value;
      if (seen.has(value)) return '[circular]';
      if (depth >= 4) return '[nested]';
      seen.add(value);
      if (Array.isArray(value)) return value.slice(0, 20).map(item => redactNested(item, '', depth + 1, seen));
      const out = {};
      for (const [entryKey, entryValue] of Object.entries(value).slice(0, 20)) {
        out[entryKey] = redactNested(entryValue, entryKey, depth + 1, seen);
      }
      return out;
    }
  `;
}
export function reactComponentsTreeScript(maxDepth = 6, { redactSensitive = true } = {}) {
  return `(function() {
    const maxDepth = ${Number(maxDepth) || 6};
    const redactSensitive = ${redactSensitive ? 'true' : 'false'};
    ${componentTreeRedactionHelpersScript()}
    function safeName(type) {
      if (!type) return null;
      if (typeof type === 'string') return type;
      return type.displayName || type.name || null;
    }
    function summarizeProps(props) {
      if (!props || typeof props !== 'object') return '';
      const parts = [];
      for (const [k, v] of Object.entries(props)) {
        if (k === 'children' || typeof v === 'function') continue;
        let s;
        try {
          const safeValue = redactSensitive ? redactNested(v, k) : v;
          s = typeof safeValue === 'string' ? JSON.stringify(safeValue) : (typeof safeValue === 'object' ? JSON.stringify(safeValue) : String(safeValue));
        }
        catch { s = '[unserializable]'; }
        if (s.length > 40) s = s.slice(0, 37) + '...';
        parts.push(k + '=' + s);
        if (parts.length >= 4) { parts.push('...'); break; }
      }
      return parts.length ? ' ' + parts.join(' ') : '';
    }
    function walk(fiber, depth, lines, seen) {
      if (!fiber || depth > maxDepth) return;
      const id = fiber._debugID || fiber.actualStartTime || Math.random();
      if (seen.has(fiber)) return;
      seen.add(fiber);
      const name = safeName(fiber.type);
      if (name && name.length <= 60 && !/^[a-z]/.test(name)) {
        lines.push('  '.repeat(depth) + '<' + name + summarizeProps(fiber.memoizedProps) + '>');
        if (fiber.child) walk(fiber.child, depth + 1, lines, seen);
      } else {
        if (fiber.child) walk(fiber.child, depth, lines, seen);
      }
      if (fiber.sibling) walk(fiber.sibling, depth, lines, seen);
    }
    const roots = document.querySelectorAll('[data-reactroot], #root, #__next, #app, body > div');
    for (const root of roots) {
      const key = Object.keys(root).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
      if (!key) continue;
      let fiber = root[key];
      // Climb to root fiber
      let guard = 0;
      while (fiber?.return && guard++ < 50) fiber = fiber.return;
      const lines = [];
      walk(fiber, 0, lines, new Set());
      if (lines.length) {
        return JSON.stringify({ ok: true, framework: 'react', lines: lines.slice(0, 200), truncated: lines.length > 200 });
      }
    }
    return JSON.stringify({ ok: false, framework: 'react', reason: 'fiber-tree-not-found' });
  })()`;
}
export function vueComponentsTreeScript(maxDepth = 6, { redactSensitive = true } = {}) {
  return `(function() {
    const maxDepth = ${Number(maxDepth) || 6};
    const redactSensitive = ${redactSensitive ? 'true' : 'false'};
    ${componentTreeRedactionHelpersScript()}
    function walk(vm, depth, lines) {
      if (!vm || depth > maxDepth) return;
      const name = vm.$options?.name || vm.type?.name || vm.$.type?.name || 'Anonymous';
      const props = vm.$props || vm.props || {};
      const propParts = [];
      try {
        for (const [k, v] of Object.entries(props || {})) {
          if (typeof v === 'function') continue;
          const safeValue = redactSensitive ? redactNested(v, k) : v;
          let s = typeof safeValue === 'object' ? JSON.stringify(safeValue) : String(safeValue);
          if (s.length > 30) s = s.slice(0, 27) + '...';
          propParts.push(k + '=' + s);
          if (propParts.length >= 3) break;
        }
      } catch {}
      lines.push('  '.repeat(depth) + '<' + name + (propParts.length ? ' ' + propParts.join(' ') : '') + '>');
      const children = vm.$children || vm.subTree?.component?.subTree?.children || [];
      if (Array.isArray(children)) {
        for (const child of children) {
          const next = child?.component || child;
          if (next) walk(next, depth + 1, lines);
        }
      }
    }
    const lines = [];
    const appEl = document.querySelector('#app') || document.querySelector('[data-v-app]');
    const app = appEl?.__vue_app__;
    if (app?._instance) {
      walk(app._instance, 0, lines);
    } else if (appEl?.__vue__) {
      walk(appEl.__vue__, 0, lines);
    }
    if (!lines.length) return JSON.stringify({ ok: false, framework: 'vue', reason: 'vue-tree-not-found' });
    return JSON.stringify({ ok: true, framework: 'vue', lines: lines.slice(0, 200), truncated: lines.length > 200 });
  })()`;
}
export function reactComponentAtElementScript() {
  return `function(el) {
    if (!el) return JSON.stringify({ ok: false, reason: 'no-element' });
    const key = Object.keys(el).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
    if (!key) return JSON.stringify({ ok: false, reason: 'no-fiber-on-element' });
    let fiber = el[key];
    let guard = 0;
    while (fiber && guard++ < 40) {
      const name = fiber.type?.displayName || fiber.type?.name;
      if (typeof name === 'string' && name.length && name[0] === name[0].toUpperCase()) {
        const props = {};
        try {
          for (const [k, v] of Object.entries(fiber.memoizedProps || {})) {
            if (k === 'children' || typeof v === 'function') continue;
            try { props[k] = typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v; }
            catch { props[k] = String(v).slice(0, 80); }
            if (Object.keys(props).length >= 12) break;
          }
        } catch {}
        const state = {};
        try {
          let hook = fiber.memoizedState;
          let i = 0;
          while (hook && i < 8) {
            if (hook.memoizedState !== undefined && typeof hook.memoizedState !== 'function') {
              try { state['hook' + i] = JSON.parse(JSON.stringify(hook.memoizedState)); }
              catch { state['hook' + i] = String(hook.memoizedState).slice(0, 80); }
            }
            hook = hook.next;
            i++;
          }
        } catch {}
        return JSON.stringify({ ok: true, name, props, state });
      }
      fiber = fiber.return;
    }
    return JSON.stringify({ ok: false, reason: 'no-named-component' });
  }`;
}
export async function resolveComponentRefObjectId(cdp, sid, ref, refMap, refState) {
  if (!isCursorRef(ref)) {
    return resolveRefNode(cdp, sid, refMap, ref, refState, { returnRealm: 'page' });
  }
  const rect = resolveCursorRef(refMap, ref, refState);
  const result = await cdpDomains(cdp).Runtime.evaluate( {
    expression: `document.elementFromPoint(${rect.x + rect.w / 2}, ${rect.y + rect.h / 2})`,
    returnByValue: false,
    awaitPromise: false,
  }, sid, REF_RESOLVE_TIMEOUT);
  if (result.exceptionDetails) throw new Error(runtimeExceptionMessage(result.exceptionDetails));
  const objectId = result.result?.objectId;
  if (!objectId) throw new Error(`Unknown cursor ref: ${ref}. Run "perceive -C -d 8" to refresh cursor refs, or use a stable CSS selector.`);
  return objectId;
}
export async function componentsStr(cdp, sid, args = [], refMap = new Map(), refState = null) {
  const opts = parseComponentsArgs(args);
  const detectionRaw = await evalStr(cdp, sid, frameworkDetectorScript());
  let detection;
  try { detection = JSON.parse(detectionRaw); } catch { detection = { framework: null }; }
  if (!detection.framework) {
    const msg = 'No supported framework detected (React fiber/DevTools, Vue, or Angular ng-version).';
    return opts.format === 'json'
      ? formatJson({ schema: 'chrome-cdp-ex.components.v1', framework: null, ok: false, message: msg })
      : msg;
  }
  if (detection.framework === 'angular') {
    const msg = `Angular ${detection.version} detected; tree extraction not yet supported. Use eval for ng probes.`;
    return opts.format === 'json'
      ? formatJson({ schema: 'chrome-cdp-ex.components.v1', framework: 'angular', version: detection.version, ok: false, message: msg })
      : msg;
  }

  if ((opts.ref || opts.selector) && detection.framework !== 'react') {
    const target = opts.ref || opts.selector;
    const reason = 'target-inspection-unsupported';
    const message = `Targeted component props/state inspection is not supported for ${detection.framework}; inspect the component tree or use a React dev build.`;
    return opts.format === 'json'
      ? formatJson({
          schema: 'chrome-cdp-ex.components.v1',
          framework: detection.framework,
          version: detection.version,
          target,
          ok: false,
          reason,
          message,
        })
      : `components: ${message}`;
  }

  if (opts.ref || opts.selector) {
    if (opts.ref) {
      try {
        const objectId = await resolveComponentRefObjectId(cdp, sid, opts.ref, refMap, refState);
        if (objectId && detection.framework === 'react') {
            const result = await cdpDomains(cdp).Runtime.callFunctionOn( {
              objectId,
              functionDeclaration: `function() { return (${reactComponentAtElementScript()})(this); }`,
              returnByValue: true,
            }, sid);
            if (result.exceptionDetails) throw new Error(runtimeExceptionMessage(result.exceptionDetails));
            let parsed;
            try { parsed = JSON.parse(result.result?.value || '{}'); } catch { parsed = { ok: false }; }
            parsed = sanitizeComponentResult(parsed, opts);
            if (opts.format === 'json') {
              return formatJson({ schema: 'chrome-cdp-ex.components.v1', framework: detection.framework, version: detection.version, target: opts.ref, ...parsed });
            }
            if (!parsed.ok) return `components: could not resolve component for ${opts.ref} (${parsed.reason || 'unknown'})`;
            const lines = [`Component: <${parsed.name}>`];
            lines.push(`  Props: ${JSON.stringify(parsed.props || {})}`);
            lines.push(`  State/hooks: ${JSON.stringify(parsed.state || {})}`);
            return lines.join('\n');
        }
      } catch (e) {
        if (opts.format === 'json') {
          return formatJson({ schema: 'chrome-cdp-ex.components.v1', framework: detection.framework, ok: false, error: e.message });
        }
        return `components: ${e.message}`;
      }
    }
    if (opts.selector) {
      const raw = await evalStr(cdp, sid, `(${reactComponentAtElementScript()})(document.querySelector(${JSON.stringify(opts.selector)}))`);
      let parsed;
      try { parsed = JSON.parse(raw); } catch { parsed = { ok: false, reason: 'parse-failed' }; }
      parsed = sanitizeComponentResult(parsed, opts);
      if (opts.format === 'json') {
        return formatJson({ schema: 'chrome-cdp-ex.components.v1', framework: detection.framework, version: detection.version, target: opts.selector, ...parsed });
      }
      if (!parsed.ok) return `components: could not resolve component for ${opts.selector} (${parsed.reason || 'unknown'})`;
      return [`Component: <${parsed.name}>`, `  Props: ${JSON.stringify(parsed.props || {})}`, `  State/hooks: ${JSON.stringify(parsed.state || {})}`].join('\n');
    }
  }

  const treeRaw = detection.framework === 'vue'
    ? await evalStr(cdp, sid, vueComponentsTreeScript(opts.depth, { redactSensitive: !opts.unsafeFull }))
    : await evalStr(cdp, sid, reactComponentsTreeScript(opts.depth, { redactSensitive: !opts.unsafeFull }));
  let tree;
  try { tree = JSON.parse(treeRaw); } catch { tree = { ok: false, reason: 'parse-failed' }; }
  if (opts.format === 'json') {
    return formatJson({
      schema: 'chrome-cdp-ex.components.v1',
      framework: detection.framework,
      version: detection.version,
      source: detection.source,
      depth: opts.depth,
      privacy: { redaction: opts.unsafeFull ? 'unsafe-full' : 'default-redacted' },
      ...tree,
    });
  }
  if (!tree.ok) {
    return `${detection.framework} ${detection.version || ''} detected but component tree not found (${tree.reason || 'unknown'}). Use a dev build or framework DevTools hooks.`.replace(/\\s+/g, ' ').trim();
  }
  const header = `[${detection.framework} ${detection.version || ''} detected]`;
  return [header, '', ...(tree.lines || []), tree.truncated ? `... truncated` : null].filter(Boolean).join('\n');
}
export function parseCookieArgs(args = []) {
  const lifted = takeUnsafeFullArg(args);
  if (lifted.args.length) {
    throw new Error(`cookies: unknown argument ${lifted.args[0]}. Next: cdp cookies <target> [--unsafe-full]`);
  }
  return { unsafeFull: lifted.unsafeFull };
}
export async function cookiesStr(cdp, sid, { unsafeFull = false } = {}) {
  const { cookies } = await cdpDomains(cdp).Network.getCookies( {}, sid);
  if (!cookies || cookies.length === 0) return 'No cookies';
  // Dynamic column width based on actual cookie names
  const nameW = Math.min(Math.max(...cookies.map(c => c.name.length)) + 2, 32);
  const lines = [];
  for (const c of cookies) {
    const val = unsafeFull ? String(c.value ?? '') : REDACTED_VALUE;
    const flags = [c.httpOnly && 'HttpOnly', c.secure && 'Secure', c.sameSite].filter(Boolean).join(' ');
    const exp = c.expires > 0 ? new Date(c.expires * 1000).toISOString().slice(0, 19) : 'session';
    lines.push(`${c.name.padEnd(nameW)} ${val.padEnd(34)} ${c.domain.padEnd(20)} ${exp.padEnd(20)} ${flags}`);
  }
  return lines.join('\n');
}
// Checkpoint/restore: serialize the minimum browser state needed to resume a
// real-page exploration flow without pretending to snapshot the whole browser.
export function checkpointPageScript() {
  return `(function() {
    function dumpStorage(storage) {
      const out = {};
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        out[key] = storage.getItem(key);
      }
      return out;
    }
    return JSON.stringify({
      url: location.href,
      title: document.title,
      origin: location.origin,
      localStorage: dumpStorage(localStorage),
      sessionStorage: dumpStorage(sessionStorage)
    });
  })()`;
}
export function sanitizeCheckpointCookies(cookies = [], { redactValues = true } = {}) {
  return cookies.map(cookie => {
    const out = {};
    for (const key of ['name', 'value', 'domain', 'path', 'secure', 'httpOnly', 'sameSite']) {
      if (cookie[key] !== undefined) out[key] = key === 'value' && redactValues ? REDACTED_VALUE : cookie[key];
    }
    if (Number.isFinite(cookie.expires) && cookie.expires > 0) out.expires = cookie.expires;
    if (redactValues && out.value !== undefined) out.redacted = ['value'];
    return out;
  }).filter(cookie => cookie.name);
}
export function sanitizeCheckpointStorage(storage = {}, { redactValues = true } = {}) {
  if (!storage || typeof storage !== 'object') return {};
  if (!redactValues) return { ...storage };
  return Object.fromEntries(Object.entries(storage).map(([key, value]) => [
    key,
    isSensitiveDataKey(key) ? REDACTED_VALUE : redactSensitiveArtifactValue(value, key),
  ]));
}
export function parseCheckpointArgs(args = []) {
  const rest = [];
  let unsafeFullCapture = false;
  for (const arg of args || []) {
    if (arg === '--unsafe-full' || arg === '--full' || arg === '--include-secrets') {
      unsafeFullCapture = true;
    } else {
      rest.push(arg);
    }
  }
  return { unsafeFullCapture, args: rest };
}
export async function checkpointModel(cdp, sid, { now = Date.now(), unsafeFullCapture = false } = {}) {
  const raw = await evalStr(cdp, sid, checkpointPageScript());
  let pageState;
  try {
    pageState = JSON.parse(raw);
  } catch (e) {
    throw new Error(`checkpoint: failed to read page state (${e.message})`);
  }
  let cookies = [];
  try {
    const res = await cdpDomains(cdp).Network.getCookies( {}, sid);
    cookies = sanitizeCheckpointCookies(res.cookies || [], { redactValues: !unsafeFullCapture });
  } catch {}
  return {
    schema: 'chrome-cdp-ex.checkpoint.v1',
    ts: now,
    privacy: {
      redaction: unsafeFullCapture ? 'unsafe-full' : 'default-redacted',
      cookies: !unsafeFullCapture,
      storage: !unsafeFullCapture,
      warning: unsafeFullCapture
        ? 'This checkpoint intentionally includes raw cookie, URL, and storage values. Treat it as a secret artifact.'
        : 'Cookie values, URL secrets, and sensitive storage values are redacted by default. Use --unsafe-full only when restore fidelity is required and the artifact can be protected.',
    },
    page: {
      url: displayUrl(pageState.url || '', { unsafeFull: unsafeFullCapture }),
      title: pageState.title || '',
      origin: pageState.origin || '',
    },
    storage: {
      localStorage: sanitizeCheckpointStorage(pageState.localStorage || {}, { redactValues: !unsafeFullCapture }),
      sessionStorage: sanitizeCheckpointStorage(pageState.sessionStorage || {}, { redactValues: !unsafeFullCapture }),
    },
    cookies,
  };
}
// The session log keeps where a checkpoint was taken, never its secrets (#455).
export function checkpointSessionEvent(output = '') {
  const text = String(output || '');
  const url = text.includes('URL: ') ? text.split('URL: ')[1]?.split('\n')[0] : undefined;
  return { kind: 'checkpoint', url: url == null ? undefined : redactUrl(url) };
}
export async function checkpointStr(cdp, sid, { format = 'text', now = Date.now(), unsafeFullCapture = false } = {}) {
  const model = await checkpointModel(cdp, sid, { now, unsafeFullCapture });
  if (format === 'json') return formatJson(model);
  const localCount = Object.keys(model.storage.localStorage || {}).length;
  const sessionCount = Object.keys(model.storage.sessionStorage || {}).length;
  return [
    'Checkpoint captured',
    `URL: ${model.page.url}`,
    `Privacy: ${model.privacy.redaction}`,
    `Storage: local ${localCount}, session ${sessionCount}`,
    `Cookies: ${model.cookies.length}`,
    unsafeFullCapture
      ? 'Warning: raw cookie and storage values are included. Protect this artifact like a secret.'
      : 'Values: cookie values, URL secrets, and sensitive storage values are redacted by default.',
    unsafeFullCapture
      ? 'Save this output, then restore it with `cdp restore <target> --file <path>`.'
      : 'Use `cdp checkpoint <target> --unsafe-full --format json` only when restore fidelity is required.',
  ].join('\n');
}
export function parseCheckpointArtifact(raw) {
  let artifact;
  try {
    artifact = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) {
    throw new Error(`restore: invalid checkpoint JSON (${e.message})`);
  }
  if (!artifact || typeof artifact !== 'object') throw new Error('restore: checkpoint artifact must be a JSON object');
  if (artifact.schema !== 'chrome-cdp-ex.checkpoint.v1') {
    throw new Error(`restore: unsupported checkpoint schema ${artifact.schema || '(missing)'}`);
  }
  if (!artifact.page?.url) throw new Error('restore: checkpoint.page.url is required');
  validateUrl(artifact.page.url);
  return artifact;
}
export function parseRestoreArgs(args, { reader = readFileSync } = {}) {
  const fopts = parseFormatArgs((args || []).filter(a => a !== undefined && a !== null), ['text', 'json']);
  const tokens = fopts.args;
  const positional = [];
  const finish = (result) => ({ ...result, format: fopts.format });
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '--json') {
      const raw = tokens.slice(i + 1).join(' ').trim();
      if (!raw) throw new Error('restore --json requires a checkpoint JSON payload');
      return finish({ artifact: parseCheckpointArtifact(raw), source: 'inline JSON' });
    }
    if (token === '--file' || token === '-f') {
      const filePath = tokens[++i];
      if (!filePath) throw new Error('restore --file requires a checkpoint JSON path');
      return finish({ artifact: parseCheckpointArtifact(reader(filePath, 'utf8')), source: filePath });
    }
    positional.push(token);
  }
  const raw = positional.join(' ').trim();
  if (!raw) throw new Error('restore requires --file <path> or --json <checkpoint-json>');
  if (raw.startsWith('{')) return finish({ artifact: parseCheckpointArtifact(raw), source: 'inline JSON' });
  return finish({ artifact: parseCheckpointArtifact(reader(positional[0], 'utf8')), source: positional[0] });
}
export function redactRestoreCommandArgs(args = []) {
  const positionalRaw = args.join(' ').trim();
  if (args.length && !args.some(arg => arg === '--json' || arg === '--file' || arg === '-f')) {
    return [positionalRaw.startsWith('{') ? '[checkpoint-json-redacted]' : '[checkpoint-path-redacted]'];
  }
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    out.push(arg);
    if (arg === '--json') {
      out.push('[checkpoint-json-redacted]');
      break;
    }
    if (arg === '--file' || arg === '-f') {
      if (args[i + 1]) {
        i += 1;
        out.push('[checkpoint-path-redacted]');
      }
    }
  }
  return out.length ? out : ['restore'];
}
export function collectExternalInputStrings(value, out, depth = 0) {
  if (depth > 8 || out.length >= 64) return;
  if (typeof value === 'string') {
    if (value) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectExternalInputStrings(item, out, depth + 1);
    return;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectExternalInputStrings(item, out, depth + 1);
  }
}
export function redactExternalInputActionError(error, action, args = []) {
  const original = actionFailureMessage(error);
  let message = original;
  const replacements = [];
  if (action === 'upload' && args[1]) {
    replacements.push([args[1], '[upload-path-redacted]']);
    for (const filePath of args[1].split(',').map(value => value.trim()).filter(Boolean)) {
      replacements.push([filePath, '[upload-path-redacted]']);
    }
  } else if (action === 'inject' && args.length > 1) {
    const payload = args.slice(1).join(' ').trim();
    if (payload) {
      const marker = args[0] === '--css' ? '[inject-content-redacted]' : '[inject-url-redacted]';
      replacements.push([payload, marker]);
    }
  } else if (action === 'restore') {
    let inlineJson = null;
    for (let i = 0; i < args.length; i += 1) {
      if ((args[i] === '--file' || args[i] === '-f') && args[i + 1]) {
        replacements.push([args[i + 1], '[checkpoint-path-redacted]']);
        i += 1;
      } else if (args[i] === '--json') {
        inlineJson = args.slice(i + 1).join(' ').trim();
        break;
      }
    }
    if (!args.some(arg => arg === '--json' || arg === '--file' || arg === '-f')) {
      const positional = args.join(' ').trim();
      if (positional.startsWith('{')) inlineJson = positional;
      else if (args[0]) replacements.push([args[0], '[checkpoint-path-redacted]']);
    }
    if (inlineJson) {
      replacements.push([inlineJson, '[checkpoint-json-redacted]']);
      try {
        const values = [];
        collectExternalInputStrings(JSON.parse(inlineJson), values);
        for (const value of values) replacements.push([value, '[checkpoint-value-redacted]']);
      } catch {}
    }
  }
  replacements.sort((left, right) => right[0].length - left[0].length);
  for (const [value, marker] of replacements) {
    if (value) message = message.split(value).join(marker);
  }
  message = message
    .replace(/\b(?:https?|file):\/\/[^\s'"\])]+/gi, '[external-url-redacted]')
    .replace(/(^|[\s'"])((?:\/(?!\/)[^\s'"]+)+|[A-Za-z]:\\[^\s'"]+)/g, '$1[external-path-redacted]');
  if (message === original) return error;
  const redacted = new Error(message, { cause: error });
  redacted.name = error?.name || 'Error';
  if (error?.code !== undefined) redacted.code = error.code;
  return redacted;
}
export function redactRestoreActionError(error, args = []) {
  return redactExternalInputActionError(error, 'restore', args);
}
export function checkpointCookieToSetCookieParams(cookie, url) {
  const params = { url };
  for (const key of ['name', 'value', 'domain', 'path', 'secure', 'httpOnly', 'sameSite', 'expires']) {
    if (cookie[key] !== undefined) params[key] = cookie[key];
  }
  return params;
}
export function isRestorableCheckpointCookie(cookie) {
  if (!cookie || typeof cookie !== 'object') return false;
  if (!cookie.name) return false;
  if (cookie.value === undefined || cookie.value === null) return false;
  if (cookie.value === REDACTED_VALUE) return false;
  if (Array.isArray(cookie.redacted) && cookie.redacted.includes('value')) return false;
  return true;
}
export function cookiesForRestore(cookies = []) {
  return cookies.filter(isRestorableCheckpointCookie);
}
export function restoreStorageScript(storage = {}) {
  const local = storage.localStorage || {};
  const session = storage.sessionStorage || {};
  return `(function() {
    const localItems = ${JSON.stringify(local)};
    const sessionItems = ${JSON.stringify(session)};
    localStorage.clear();
    for (const [key, value] of Object.entries(localItems)) localStorage.setItem(key, value);
    sessionStorage.clear();
    for (const [key, value] of Object.entries(sessionItems)) sessionStorage.setItem(key, value);
    return JSON.stringify({ localStorage: Object.keys(localItems).length, sessionStorage: Object.keys(sessionItems).length });
  })()`;
}
export async function navigateForRestore(cdp, sid, url) {
  await cdpDomains(cdp).Page.enable( {}, sid).catch(() => {});
  let loadEvent = cdp.waitForEvent('Page.loadEventFired', NAVIGATION_TIMEOUT);
  try {
    const nav = await cdpDomains(cdp).Page.navigate( { url }, sid, 5000);
    if (nav.errorText) {
      loadEvent.cancel();
      throw new Error(nav.errorText);
    }
    if (nav.loaderId) {
      await loadEvent.promise;
    } else {
      loadEvent.cancel();
    }
    return 'Page.navigate';
  } catch (e) {
    loadEvent.cancel();
    if (!isTimeoutError(e, ['Page.navigate'])) throw e;
    loadEvent = cdp.waitForEvent('Page.loadEventFired', NAVIGATION_TIMEOUT);
    await evalStr(cdp, sid, `(function() { location.assign(${JSON.stringify(url)}); return 'navigating'; })()`);
    await loadEvent.promise.catch(() => {});
    return 'location.assign fallback';
  }
}
export async function restoreCheckpointStr(cdp, sid, args) {
  const { artifact } = parseRestoreArgs(args);
  const url = artifact.page.url;
  const cookies = cookiesForRestore(artifact.cookies || []);
  let cookieSet = 0;
  for (const cookie of cookies) {
    const result = await cdpDomains(cdp).Network.setCookie( checkpointCookieToSetCookieParams(cookie, url), sid);
    if (result && result.success === false) throw new Error(`restore: failed to set cookie ${cookie.name}`);
    cookieSet++;
  }

  let currentUrl = null;
  try { currentUrl = await evalStr(cdp, sid, 'location.href'); } catch {}
  const navigationMethod = currentUrl === url
    ? 'already at checkpoint URL'
    : await navigateForRestore(cdp, sid, url);
  await evalStr(cdp, sid, restoreStorageScript(artifact.storage || {}));

  const localCount = Object.keys(artifact.storage?.localStorage || {}).length;
  const sessionCount = Object.keys(artifact.storage?.sessionStorage || {}).length;
  return [
    `Restored checkpoint: ${url}`,
    `Navigation: ${navigationMethod}`,
    `Storage: local ${localCount}, session ${sessionCount}; cookies: ${cookieSet}`,
    'Refs were invalidated; run `perceive` before using @refs again.',
  ].join('\n');
}
export function parseLoadAllArgs(args = []) {
  const positional = [];
  let timeoutMs = LOADALL_DEFAULT_TIMEOUT_MS;
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === '--timeout-ms') {
      timeoutMs = parseNonNegativeInteger(args[++i], 'loadall: --timeout-ms');
    } else if (String(token).startsWith('--timeout-ms=')) {
      timeoutMs = parseNonNegativeInteger(String(token).slice('--timeout-ms='.length), 'loadall: --timeout-ms');
    } else if (String(token).startsWith('-')) {
      throw new Error(`loadall: unknown argument ${token}`);
    } else {
      positional.push(token);
    }
  }
  const selector = positional[0];
  if (!selector) throw new Error('CSS selector required');
  let intervalMs = LOADALL_DEFAULT_INTERVAL_MS;
  if (positional[1] != null) {
    intervalMs = parseNonNegativeInteger(positional[1], 'loadall: interval-ms');
  }
  if (positional.length > 2) throw new Error(`loadall: unknown argument ${positional[2]}`);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('loadall: --timeout-ms must be a positive integer');
  }
  return {
    selector,
    intervalMs,
    timeoutMs: Math.min(timeoutMs, LOADALL_MAX_TIMEOUT_MS),
  };
}
// Load-more: repeatedly click a button/selector until it disappears
export async function loadAllStr(cdp, sid, selector, intervalMs = LOADALL_DEFAULT_INTERVAL_MS, options = {}) {
  if (!selector) throw new Error('CSS selector required');
  const timeoutMs = Math.min(
    Math.max(Number(options.timeoutMs) || LOADALL_DEFAULT_TIMEOUT_MS, 1),
    LOADALL_MAX_TIMEOUT_MS,
  );
  let clicks = 0;
  let seen = false;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    throwIfRequestAborted('loadall: aborted');
    if (Date.now() >= deadline) {
      if (!seen) throw new Error(`Element not found: ${selector}`);
      throw new Error(`loadall: "${selector}" still present after ${clicks} click(s) (timeout ${timeoutMs}ms)`);
    }
    const expr = `
      (function() {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        const rect = el.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      })()
    `;
    const result = await evalStr(cdp, sid, expr);
    if (result === 'null' || result === '') {
      if (!seen) throw new Error(`Element not found: ${selector}`);
      return `Clicked "${selector}" ${clicks} time(s) until it disappeared`;
    }
    seen = true;
    const r = JSON.parse(result);
    await dispatchClick(cdp, sid, r.x, r.y, { selector, x: r.x, y: r.y });
    clicks++;
    throwIfRequestAborted('loadall: aborted');
    const remaining = deadline - Date.now();
    if (remaining <= 0) continue;
    await sleep(Math.min(Math.max(0, intervalMs), remaining));
  }
}
// Send a raw CDP command and return the result as JSON
export async function evalRawStr(cdp, sid, method, paramsJson, authorization) {
  if (!method) throw new Error('CDP method required (e.g. "DOM.getDocument")');
  let params = {};
  if (paramsJson) {
    try { params = JSON.parse(paramsJson); }
    catch { throw new Error(`Invalid JSON params: ${paramsJson}`); }
  }
  const gateway = createRawCdpGateway(bindCdpTransport(cdp), authorization);
  const result = await gateway.execute(params, sid);
  return JSON.stringify(result, null, 2);
}
export function takeAcceptDialogFlag(args = []) {
  const list = Array.isArray(args) ? args : [];
  let acceptDialog = false;
  const kept = [];
  for (const arg of list) {
    if (arg === ACCEPT_DIALOG_FLAG) {
      acceptDialog = true;
      continue;
    }
    kept.push(arg);
  }
  return { args: kept, acceptDialog };
}
// Accept is never the default. A command flag or a saved `dialog accept` is required (#658).
export function nativeDialogShouldAccept({ commandAccept = false, savedAccept = false } = {}) {
  return commandAccept === true || savedAccept === true;
}
// confirm, prompt, and beforeunload change what the page does. alert has one button.
export function dismissedDecisionDialogSince(dialogBuf, sinceSeq = 0) {
  const entries = typeof dialogBuf?.since === 'function' ? dialogBuf.since(sinceSeq || 0) : [];
  return entries.find(entry => (
    DECISION_DIALOG_TYPES.has(String(entry?.type || ''))
    && entry?.accepted === false
    && entry?.handled !== false
  )) || null;
}
export function nativeDialogDismissedError(entry, { action = 'click', target = {} } = {}) {
  const type = String(entry?.type || 'dialog');
  const message = compactActionText(
    redactSensitiveString(String(entry?.message || '')),
    MAX_ACTION_DIALOG_MESSAGE_CHARS,
  );
  const quoted = message ? ` "${message}"` : '';
  const err = new Error(`native ${type}${quoted} was dismissed`);
  err.nativeDialog = {
    type,
    message,
    action,
    commandArgs: Array.isArray(target?.commandArgs) ? [...target.commandArgs] : [],
  };
  return err;
}
export function classifiedFailureKind(message) {
  return String(message || '').match(/^Kind:\s*(\S+)/m)?.[1] || null;
}
export function inputFailureYieldsToDismissedDialog(err, { action = 'action', target = {} } = {}) {
  if (!err || err.nativeDialog || err.navigationCancelled) return false;
  const message = actionFailureMessage(err);
  const printed = isClassifiedActionFailureText(message) ? classifiedFailureKind(message) : null;
  if (printed === 'native-dialog' || printed === 'navigation-cancelled') return false;
  if (printed) return INPUT_NOT_DELIVERED_KINDS.has(printed);
  return INPUT_NOT_DELIVERED_KINDS.has(classifyActionFailure(err, { action, target }).kind);
}
// Prefer the dismissed dialog over a not-delivered or no-change receipt.
// A dialog from before this command, an alert, or an accepted dialog stays as it was.
export function errorYieldingToDismissedDialog(err, { dialogBuf, sinceSeq = 0, action = 'click', target = {} } = {}) {
  const dismissed = dismissedDecisionDialogSince(dialogBuf, sinceSeq);
  if (!dismissed || !inputFailureYieldsToDismissedDialog(err, { action, target })) return err;
  return nativeDialogDismissedError(dismissed, { action, target });
}
export function dialogStr(dialogBuf, dialogAutoAcceptRef, flag) {
  if (flag === 'accept') { dialogAutoAcceptRef.value = true; return 'Dialog auto-accept: ON (explicit)'; }
  if (flag === 'dismiss') { dialogAutoAcceptRef.value = false; return 'Dialog auto-accept: OFF (dialogs will be dismissed/rejected)'; }
  if (flag) throw new Error(`Unknown dialog flag: "${flag}". Use "accept" or "dismiss".`);
  const mode = dialogAutoAcceptRef.value ? 'ON' : 'OFF';
  const entries = dialogBuf.all();
  if (entries.length === 0) return `No dialogs recorded. Auto-accept: ${mode}`;
  const lines = [`Dialogs (${entries.length}, auto-accept: ${mode}):`];
  for (const e of entries) {
    const ago = Math.round((Date.now() - e.ts) / 1000);
    lines.push(`  [${e.type}] "${e.message}" (${ago}s ago)`);
  }
  return lines.join('\n');
}
export function setDialogMode(dialogBuf, dialogAutoAcceptRef, session, flag) {
  const text = dialogStr(dialogBuf, dialogAutoAcceptRef, flag);
  if (flag === 'accept' || flag === 'dismiss') {
    if (session) session.dialogMode = flag;
    rememberTabEnvironment(session);
  }
  return text;
}
export function javascriptDialogHandleParams(params = {}, accept) {
  return {
    accept: Boolean(accept),
    // Chrome prompt() handling fails when promptText is omitted, including dismiss.
    promptText: String(params?.defaultPrompt || ''),
  };
}
export function createJavaScriptDialogSession() {
  const pending = new Set();
  let failedHandle = false;
  let lastHandle = null;
  return {
    pending,
    track(promise) {
      const tracked = Promise.resolve(promise).then((result) => {
        lastHandle = result && typeof result === 'object' ? result : { ok: true, value: result };
        if (result && result.ok === false) failedHandle = true;
        return result;
      }, (error) => {
        failedHandle = true;
        lastHandle = { ok: false, error };
        throw error;
      }).finally(() => {
        pending.delete(tracked);
      });
      pending.add(tracked);
      return tracked;
    },
    async waitForPending(timeoutMs = 1000) {
      if (pending.size === 0) return;
      const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
      while (pending.size > 0 && Date.now() < deadline) {
        await Promise.race([
          Promise.allSettled([...pending]),
          sleep(Math.max(1, deadline - Date.now())),
        ]);
      }
    },
    hasPending() {
      return pending.size > 0;
    },
    hasFailedHandle() {
      return failedHandle;
    },
    lastHandle() {
      return lastHandle;
    },
  };
}
export function shouldSkipActionPageEvaluate(dialogSession) {
  return Boolean(dialogSession && typeof dialogSession.hasFailedHandle === 'function' && dialogSession.hasFailedHandle());
}
export function formatDialogBlockedObserveText(dialogSession = null) {
  const handle = dialogSession && typeof dialogSession.lastHandle === 'function' ? dialogSession.lastHandle() : null;
  const detail = handle?.error?.message ? `: ${handle.error.message}` : '';
  return `JavaScript dialog still open; skipped page evaluate to avoid blocking the tab daemon${detail}`;
}
export async function observeAfterActionGuardingDialogs(jsDialogs, observeAfterAction) {
  if (jsDialogs && typeof jsDialogs.hasPending === 'function' ? jsDialogs.hasPending() : jsDialogs?.pending?.size > 0) {
    await jsDialogs.waitForPending(1500);
  }
  if (shouldSkipActionPageEvaluate(jsDialogs)) {
    return formatDialogBlockedObserveText(jsDialogs);
  }
  return observeAfterAction();
}
export async function handleOpeningJavaScriptDialog(cdp, fallbackSessionId, params, msg, {
  accept = true,
  dialogBuf = null,
  retries = 8,
  delayMs = 25,
} = {}) {
  // `accepted` is the answer sent on the user's behalf; action receipts report it (#460).
  const entry = {
    type: params?.type || 'alert',
    message: params?.message || '',
    defaultPrompt: params?.defaultPrompt || '',
    url: params?.url || '',
    accepted: Boolean(accept),
    ts: Date.now(),
  };
  if (dialogBuf && typeof dialogBuf.push === 'function') dialogBuf.push(entry);
  const payload = javascriptDialogHandleParams(params, accept);
  const sessions = [];
  if (msg?.sessionId) sessions.push(msg.sessionId);
  if (fallbackSessionId && fallbackSessionId !== msg?.sessionId) sessions.push(fallbackSessionId);
  let lastError = null;
  if (sessions.length === 0) {
    entry.handled = false;
    return { ok: false, error: new Error('No page session available for JavaScript dialog handling') };
  }
  for (let attempt = 0; attempt < retries; attempt++) {
    for (const sid of sessions) {
      try {
        await cdpDomains(cdp).Page.handleJavaScriptDialog(payload, sid);
        entry.handled = true;
        return { ok: true, sessionId: sid, attempt };
      } catch (error) {
        lastError = error;
      }
    }
    if (attempt + 1 < retries) await sleep(delayMs);
  }
  entry.handled = false;
  return { ok: false, error: lastError };
}
export function filterNetlogEntries(entries = [], { lastNavigationTs = null, lookbackMs = 2500, holdRestored = false } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  if (!Number.isFinite(Number(lastNavigationTs))) return [...list];
  const since = Number(lastNavigationTs) - (Number.isFinite(Number(lookbackMs)) ? Number(lookbackMs) : 2500);
  return list.filter(entry => (holdRestored && entry?.restored === true) || Number(entry?.ts) >= since);
}
// URLs are redacted by default (#455); --unsafe-full prints them verbatim.
// Each request carries the short id from `requestStore` that `--id N` reads (#467).
export function netlogStr(netReqBuf, flag, options = {}) {
  if (flag === '--clear') {
    netReqBuf.clear();
    options.requestStore?.clear();
    if (options.session) {
      options.session.restoredNetlogHold = false;
      rememberTabObservation(options.session);
    }
    return 'Network log cleared';
  }
  const model = buildNetlogListModel(filterNetlogEntries(netReqBuf.all(), options), {
    idFor: requestId => options.requestStore?.idFor(requestId) ?? null,
    detailFor: id => options.requestStore?.get(id) ?? null,
    filters: options.filters,
    unsafeFull: options.unsafeFull === true,
    targetId: options.targetId,
  });
  if (options.observationUnreadable && model.total === 0) {
    const message = 'Saved network log could not be read after the tab daemon restarted. This is not an empty capture.';
    model.unavailable = { reason: 'saved-netlog-unreadable', message };
    if (options.format === 'json') return formatJson(model);
    return `${message} Next: cdp netlog ${model.targetId || '<target>'}`;
  }
  return options.format === 'json' ? formatJson(model) : formatNetlogListText(model);
}
// #648: Chrome sends no Network.loadingFinished for a `Cache-Control: no-store` response that the
// page never reads, and Network.getResponseBody then answers "No data found". The bytes Chrome
// already received are still there: Network.streamResourceContent returns them as bufferedData.
// `unread: true` marks a body read that way.
export async function readNetlogResponseBody(cdp, sid, detail, { timeoutMs } = {}) {
  try {
    return { result: await cdpDomains(cdp).Network.getResponseBody({ requestId: detail.requestId }, sid, timeoutMs), unread: false };
  } catch (error) {
    if (detail.state !== 'pending' || detail.status == null) throw error;
    const streamed = await cdpDomains(cdp).Network.streamResourceContent({ requestId: detail.requestId }, sid, timeoutMs)
      .catch(() => null);
    if (!streamed?.bufferedData) throw error;
    return { result: { body: streamed.bufferedData, base64Encoded: true }, unread: true };
  }
}
// `netlog <target> --id N` (#467, #555): stored request detail. The response body
// is fetched only for `--body` or `--out`. `--out` writes the file and does not
// echo the body unless `--body` is also set.
export async function netlogRequestStr(cdp, sid, requestStore, opts, { targetId = '', writeBodyFile = writeNetlogBodyFile } = {}) {
  const detail = requestStore?.get(opts.id);
  if (!detail) {
    throw new Error(`netlog: no request #${opts.id} in this tab's log. Request ids come from \`cdp netlog <target>\`; older requests drop out of the bounded log.`);
  }
  const includeBody = opts.includeBody === true;
  const wantFetch = includeBody || Boolean(opts.out);
  let body = null;
  let file = null;
  if (wantFetch && detail.restored === true) {
    body = unavailableBody('this request was restored after the tab daemon restarted; Chrome no longer holds the response body');
  } else if (wantFetch) {
    if (detail.state === 'failed') {
      body = unavailableBody(`the request failed (${detail.errorText}), so there is no response body`);
    } else {
      try {
        const { result, unread } = await readNetlogResponseBody(cdp, sid, detail);
        ({ model: body, file } = summarizeResponseBody(result, { mimeType: detail.mimeType, unsafeFull: opts.unsafeFull }));
        if (unread) body = { ...body, unread: true };
      } catch (error) {
        const reason = String(error?.message || error || 'unknown error');
        body = unavailableBody(detail.state !== 'pending'
          ? `Chrome no longer holds it: ${reason}`
          : detail.status == null
            ? `still loading: ${reason}`
            : `the response arrived but its body never finished loading, and Chrome holds no copy: ${reason}`);
      }
    }
  }
  let savedTo = null;
  if (opts.out) {
    if (!file) throw new Error(`netlog: --out has no body to save for request #${opts.id}: ${body?.error || 'the body was not fetched'}`);
    writeBodyFile(opts.out, file.data, { overwrite: opts.overwrite, requestId: opts.id });
    savedTo = { path: opts.out, bytes: file.data.length, redacted: file.redacted };
  }
  const model = buildNetlogRequestModel(detail, { body, unsafeFull: opts.unsafeFull, targetId, savedTo, includeBody });
  return opts.format === 'json' ? formatJson(model) : formatNetlogRequestText(model);
}
// The daemon may run in another working directory, so a relative `--out` is
// resolved where the CLI was invoked.
export function absolutizeNetlogOutArg(args = [], cwd = process.cwd()) {
  const next = [...args];
  for (let i = 0; i < next.length - 1; i++) {
    if (next[i] === '--out' && next[i + 1] && !String(next[i + 1]).startsWith('--')) next[i + 1] = resolve(cwd, String(next[i + 1]));
  }
  return next;
}
export function parseHttpStatus(value, label = '--status') {
  const status = Number(value);
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new Error(`mock ${label} requires an HTTP status code from 100 to 599`);
  }
  return status;
}
export function parseMockArgs(args = []) {
  const fopts = parseFormatArgs(args, ['text', 'json']);
  const tokens = fopts.args || [];
  if (tokens.length === 0) return { mode: 'status', format: fopts.format };
  const mode = String(tokens[0] || '').toLowerCase();
  if (mode === 'clear' || mode === 'off' || mode === 'reset') {
    if (tokens.length > 1) throw new Error(`mock ${tokens[0]} does not accept extra arguments`);
    return { mode: 'clear', format: fopts.format };
  }
  if (mode !== 'add') {
    throw new Error(`Unknown mock command: ${tokens[0]}. Use add, clear, or no args for status.`);
  }
  const urlPattern = tokens[1];
  if (!urlPattern) throw new Error('mock add requires a URL pattern, e.g. **/api/items*');
  const rule = {
    id: `mock-${Date.now().toString(36)}`,
    urlPattern,
    method: null,
    status: 200,
    body: '',
    contentType: 'text/plain; charset=utf-8',
    hits: 0,
  };
  for (let i = 2; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '--status') rule.status = parseHttpStatus(tokens[++i], '--status');
    else if (token === '--body') rule.body = tokens[++i] ?? '';
    else if (token === '--content-type' || token === '--type') rule.contentType = tokens[++i] || rule.contentType;
    else if (token === '--method') rule.method = String(tokens[++i] || '').toUpperCase();
    else throw new Error(`mock add: unknown option ${token}`);
  }
  if (rule.method === '') rule.method = null;
  return { mode: 'add', format: fopts.format, rule };
}
export function nextMockCodePoint(text, index) {
  if (index >= text.length) return { index, code: MOCK_PATTERN_END };
  const code = text.codePointAt(index);
  return { index: index + (code > 0xFFFF ? 2 : 1), code };
}
export function eatMockWildcards(pattern, index) {
  let questions = 0;
  let star = false;
  while (index < pattern.length) {
    const ch = pattern[index];
    if (ch === '?') questions += 1;
    else if (ch === '*') star = true;
    else break;
    index += 1;
  }
  return { index, max: star ? -1 : questions };
}
export function searchMockPattern(pattern, patternIndex, text, textIndex, maximumDistance) {
  const patternStart = patternIndex;
  let stringStart = textIndex;
  let escape = false;
  while (true) {
    if (patternIndex >= pattern.length) {
      if (textIndex >= text.length) return { ok: true, patternIndex, textIndex };
    } else {
      const patternChar = pattern[patternIndex];
      if (!escape && (patternChar === '*' || patternChar === '?')) {
        return { ok: true, patternIndex, textIndex };
      }
      if (!escape && patternChar === '\\') {
        escape = true;
        const stepped = nextMockCodePoint(pattern, patternIndex);
        if (stepped.code === MOCK_PATTERN_END) return { ok: false };
        patternIndex = stepped.index;
        continue;
      }
      escape = false;
      if (textIndex >= text.length) return { ok: false };
      const patternNext = nextMockCodePoint(pattern, patternIndex);
      const textNext = nextMockCodePoint(text, textIndex);
      if (patternNext.code === textNext.code && patternNext.code !== MOCK_PATTERN_END) {
        patternIndex = patternNext.index;
        textIndex = textNext.index;
        continue;
      }
    }
    if (maximumDistance === 0) return { ok: false };
    maximumDistance -= 1;
    patternIndex = patternStart;
    const steppedString = nextMockCodePoint(text, stringStart);
    if (steppedString.code === MOCK_PATTERN_END) return { ok: false };
    stringStart = steppedString.index;
    textIndex = stringStart;
  }
}
export function matchMockPattern(text, pattern) {
  let patternIndex = 0;
  let textIndex = 0;
  const value = String(text);
  const source = String(pattern);
  do {
    const eaten = eatMockWildcards(source, patternIndex);
    patternIndex = eaten.index;
    const found = searchMockPattern(source, patternIndex, value, textIndex, eaten.max);
    if (!found.ok) return false;
    patternIndex = found.patternIndex;
    textIndex = found.textIndex;
  } while (patternIndex < source.length);
  return true;
}
export function tokenizeMockGlob(pattern) {
  const tokens = [];
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '*') { tokens.push({ kind: 'star' }); continue; }
    if (ch === '?') { tokens.push({ kind: 'q' }); continue; }
    if (ch === '\\') {
      const next = pattern[i + 1];
      if (next == null) break;
      tokens.push({ kind: 'char', char: next });
      i += 1;
      continue;
    }
    tokens.push({ kind: 'char', char: ch });
  }
  return tokens;
}
export function mockPatternHasLiteral(pattern) {
  return tokenizeMockGlob(pattern).some(token => token.kind === 'char');
}
export function looksLikeUrlScheme(pattern) {
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(pattern);
}
export function mockPatternIsAbsolute(pattern) {
  return pattern.includes('://') || pattern.startsWith('*') || looksLikeUrlScheme(pattern);
}
export function mockGlobCanReach(startPhase, moves, representatives) {
  const seen = new Set([startPhase]);
  const queue = [startPhase];
  while (queue.length) {
    const current = queue.shift();
    for (const ch of representatives(current)) {
      const next = moves(current, ch);
      if (next !== -1 && !seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return [...seen];
}
export function mockGlobCanMatch(tokens, { accept, moves, representatives }) {
  const memo = new Map();
  const visit = (tokenIndex, phase) => {
    const key = `${tokenIndex}:${phase}`;
    if (memo.has(key)) return memo.get(key);
    memo.set(key, false);
    let ok = false;
    if (tokenIndex === tokens.length) ok = accept(phase);
    else {
      const token = tokens[tokenIndex];
      if (token.kind === 'star') {
        for (const next of mockGlobCanReach(phase, moves, representatives)) {
          if (visit(tokenIndex + 1, next)) { ok = true; break; }
        }
      } else if (token.kind === 'q') {
        if (visit(tokenIndex + 1, phase)) ok = true;
        else {
          for (const ch of representatives(phase)) {
            const next = moves(phase, ch);
            if (next !== -1 && visit(tokenIndex + 1, next)) { ok = true; break; }
          }
        }
      } else {
        const next = moves(phase, token.char);
        if (next !== -1) ok = visit(tokenIndex + 1, next);
      }
    }
    memo.set(key, ok);
    return ok;
  };
  return visit(0, 0);
}
export function mockUrlPhase(phase, char) {
  if (phase === 0) return /[A-Za-z]/.test(char) ? 1 : -1;
  if (phase === 1) {
    if (char === ':') return 2;
    return /[A-Za-z0-9+.-]/.test(char) ? 1 : -1;
  }
  if (phase === 2) return char === '/' ? 3 : -1;
  if (phase === 3) return char === '/' ? 4 : -1;
  if (phase === 4 || phase === 5) return /\s/.test(char) ? -1 : 5;
  return -1;
}
export function mockUrlRepresentatives(phase) {
  if (phase === 0) return ['h'];
  if (phase === 1) return ['t', ':'];
  if (phase === 2 || phase === 3) return ['/'];
  if (phase === 4 || phase === 5) return ['a', '/', '?', '.', '%'];
  return [];
}
export function mockPathPhase(phase, char) {
  if (phase === 0) return char === '/' ? 1 : -1;
  return /\s/.test(char) ? -1 : 1;
}
export function mockPathRepresentatives(phase) {
  return phase === 0 ? ['/'] : ['a', '/', '?', '.', '%'];
}
export function globCanMatchBrowserUrl(pattern) {
  return mockGlobCanMatch(tokenizeMockGlob(pattern), {
    accept: phase => phase === 5,
    moves: mockUrlPhase,
    representatives: mockUrlRepresentatives,
  });
}
export function globCanMatchRequestPath(pattern) {
  return mockGlobCanMatch(tokenizeMockGlob(pattern), {
    accept: phase => phase === 1,
    moves: mockPathPhase,
    representatives: mockPathRepresentatives,
  });
}
export function mockPatternCanMatch(pattern) {
  const source = String(pattern || '');
  if (mockPatternIsAbsolute(source)) return globCanMatchBrowserUrl(source);
  if (source.startsWith('/')) return globCanMatchRequestPath(source);
  if (!mockPatternHasLiteral(source)) return false;
  return globCanMatchBrowserUrl(`*${source}`);
}
export function mockInterceptPattern(pattern) {
  const source = String(pattern || '');
  if (mockPatternIsAbsolute(source)) return source;
  if (source.startsWith('/') || mockPatternHasLiteral(source)) return `*${source}`;
  return source;
}
export function mockPatternWarning(pattern) {
  const source = String(pattern ?? '');
  if (mockPatternCanMatch(source)) return null;
  const quoted = `"${source}"`;
  if (/\s/.test(source)) {
    return `mock pattern ${quoted} contains whitespace, so it cannot match a request URL. Encode a space as %20.`;
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/(?!\/)/.test(source)) {
    return `mock pattern ${quoted} has one slash after the scheme, so it cannot match a browser URL. Use http:// or https://.`;
  }
  return `mock pattern ${quoted} cannot match a browser request URL. Use a full URL, a leading *, or a path that starts with /.`;
}
export function stripRequestFragment(url) {
  const raw = String(url || '');
  const hash = raw.indexOf('#');
  return hash === -1 ? raw : raw.slice(0, hash);
}
export function pathAndQueryOf(absolute) {
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.exec(absolute);
  if (!scheme) return absolute;
  const rest = absolute.slice(scheme[0].length);
  const split = rest.search(/[/?]/);
  if (split === -1) return '/';
  if (rest[split] === '?') return `/${rest.slice(split)}`;
  return rest.slice(split);
}
export function matchesOneSubdomainLabel(absolute, pattern) {
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(absolute);
  if (!scheme) return false;
  const rest = absolute.slice(scheme[0].length);
  const split = rest.search(/[/?]/);
  const host = split === -1 ? rest : rest.slice(0, split);
  const tail = split === -1 ? '' : rest.slice(split);
  const dot = host.indexOf('.');
  if (dot <= 0) return false;
  return matchMockPattern(`${scheme[1]}://${host.slice(dot + 1)}${tail}`, `*://${pattern}`);
}
export function mockPatternMatchesUrl(pattern, url) {
  const source = String(pattern || '');
  const absolute = stripRequestFragment(url);
  if (mockPatternIsAbsolute(source)) return matchMockPattern(absolute, source);
  const pathAndQuery = pathAndQueryOf(absolute);
  if (source.startsWith('/')) return matchMockPattern(pathAndQuery, source);
  if (!mockPatternHasLiteral(source)) return false;
  if (matchMockPattern(pathAndQuery, `*${source}`)) return true;
  if (!source.includes('.')) return false;
  if (matchMockPattern(absolute, `*://${source}`)) return true;
  return matchesOneSubdomainLabel(absolute, source);
}
export function mockRuleMatches(rule, request = {}) {
  if (!rule) return false;
  if (rule.method && String(request.method || '').toUpperCase() !== rule.method) return false;
  return mockPatternMatchesUrl(rule.urlPattern, request.url);
}
export function findNetworkMockRule(session, request = {}) {
  return (session.networkMocks || []).find(rule => mockRuleMatches(rule, request));
}
export function mockDisplayedHits(rule, hits = []) {
  if (Number.isInteger(rule?.hits) && rule.hits >= 0) return rule.hits;
  return hits.filter(hit => hit.ruleId === rule?.id).length;
}
export function nextMockHitCount(hits) {
  const current = Number.isInteger(hits) && hits >= 0 ? hits : 0;
  if (current >= Number.MAX_SAFE_INTEGER) return current;
  return current + 1;
}
export function formatNetworkMocksSummary(session = {}) {
  const rules = session.networkMocks || [];
  if (rules.length === 0) return 'off';
  const first = rules[0];
  const hits = mockDisplayedHits(first, session.networkMockHits || []);
  const suffix = rules.length > 1 ? ` (+${rules.length - 1} more)` : '';
  return `${rules.length} rule${rules.length === 1 ? '' : 's'} — ${first.urlPattern} -> ${first.status} (${hits} hit${hits === 1 ? '' : 's'})${suffix}`;
}
export function buildMockModel(session, parsed) {
  const rules = session.networkMocks || [];
  const hits = session.networkMockHits || [];
  return {
    schema: 'chrome-cdp-ex.mock.v1',
    targetId: session.targetId,
    mode: parsed.mode,
    rules: rules.map(rule => {
      const warning = mockPatternWarning(rule.urlPattern);
      return {
        id: rule.id,
        urlPattern: rule.urlPattern,
        method: rule.method,
        status: rule.status,
        contentType: rule.contentType,
        bodyBytes: Buffer.byteLength(rule.body || '', 'utf8'),
        hits: mockDisplayedHits(rule, hits),
        ...(warning ? { warning } : {}),
      };
    }),
    recentHits: hits.slice(-10),
  };
}
export function formatMockText(model, { warnPattern = null } = {}) {
  if (!model.rules.length) {
    return [
      'Network mock: off',
      `Next: cdp mock ${model.targetId} add "**/api/*" --status 503 --body '{"ok":false}' --content-type application/json`,
    ].join('\n');
  }
  const lines = [`Network mock: ${model.rules.length} rule${model.rules.length === 1 ? '' : 's'}`];
  for (const [i, rule] of model.rules.entries()) {
    const method = rule.method ? `${rule.method} ` : '';
    const unmatched = rule.warning ? ' — pattern cannot match' : '';
    lines.push(`${i + 1}. ${method}${rule.urlPattern} -> ${rule.status} ${rule.contentType} (${rule.hits} hit${rule.hits === 1 ? '' : 's'})${unmatched}`);
  }
  if (warnPattern != null) {
    const added = [...model.rules].reverse().find(rule => rule.urlPattern === warnPattern);
    if (added?.warning) lines.push(`Warning: ${added.warning}`);
  }
  if (model.recentHits.length) {
    const hit = model.recentHits[model.recentHits.length - 1];
    lines.push(`Last hit: ${hit.method} ${hit.url} -> ${hit.status}`);
  }
  lines.push(`Next: cdp mock ${model.targetId} clear`);
  return lines.join('\n');
}
export async function setMockCacheDisabled(cdp, sid, session, cacheDisabled) {
  await cdpDomains(cdp).Network.setCacheDisabled({ cacheDisabled }, sid);
  session.mockCacheDisabled = cacheDisabled === true;
}
export async function applyNetworkMocks(cdp, sid, session) {
  const rules = session.networkMocks || [];
  if (!rules.length) {
    await cdpDomains(cdp).Fetch.disable( {}, sid);
    if (session.mockCacheDisabled) await setMockCacheDisabled(cdp, sid, session, false);
    return;
  }
  await setMockCacheDisabled(cdp, sid, session, true);
  try {
    await cdpDomains(cdp).Fetch.enable( {
      patterns: rules.map(rule => ({ urlPattern: mockInterceptPattern(rule.urlPattern), requestStage: 'Request' })),
    }, sid);
  } catch (error) {
    if (session.mockCacheDisabled) {
      try { await setMockCacheDisabled(cdp, sid, session, false); } catch {}
    }
    throw error;
  }
}
export async function handleMockRequestPaused(cdp, sid, session, params = {}) {
  const request = params.request || {};
  const rule = findNetworkMockRule(session, request);
  if (!rule) {
    await cdpDomains(cdp).Fetch.continueRequest( { requestId: params.requestId }, sid);
    return null;
  }
  await cdpDomains(cdp).Fetch.fulfillRequest( {
    requestId: params.requestId,
    responseCode: rule.status,
    responseHeaders: [{ name: 'content-type', value: rule.contentType }],
    body: Buffer.from(rule.body || '', 'utf8').toString('base64'),
  }, sid);
  rule.hits = nextMockHitCount(rule.hits);
  const hit = {
    ruleId: rule.id,
    method: request.method || '',
    // Hits are only displayed (mock text "Last hit", JSON recentHits), so store them redacted (#455).
    url: redactUrl(request.url || ''),
    status: rule.status,
    ts: Date.now(),
  };
  session.networkMockHits.push(hit);
  if (session.networkMockHits.length > MAX_NETWORK_MOCK_HITS) {
    session.networkMockHits.splice(0, session.networkMockHits.length - MAX_NETWORK_MOCK_HITS);
  }
  try {
    rememberTabEnvironment(session);
  } catch {
    // The response is already fulfilled. A failed env write must not continueRequest.
  }
  return hit;
}
export async function mockStr(cdp, sid, session, args = []) {
  const parsed = parseMockArgs(args);
  if (!Array.isArray(session.networkMocks)) session.networkMocks = [];
  if (!Array.isArray(session.networkMockHits)) session.networkMockHits = [];
  if (parsed.mode === 'add') {
    session.networkMocks.push(parsed.rule);
    await applyNetworkMocks(cdp, sid, session);
    appendSessionEnvironmentLog(session, { kind: 'mock', ts: Date.now(), action: 'add', rule: parsed.rule });
    rememberTabEnvironment(session);
  } else if (parsed.mode === 'clear') {
    session.networkMocks = [];
    session.networkMockHits = [];
    await applyNetworkMocks(cdp, sid, session);
    appendSessionEnvironmentLog(session, { kind: 'mock', ts: Date.now(), action: 'clear' });
    rememberTabEnvironment(session);
  }
  const model = buildMockModel(session, parsed);
  if (parsed.format === 'json') return formatJson(model);
  return formatMockText(model, { warnPattern: parsed.mode === 'add' ? parsed.rule.urlPattern : null });
}
export function parseClockTimestamp(value) {
  if (value == null || value === '') throw new Error('clock freeze requires --at <date|epoch-ms>');
  const numeric = Number(value);
  const atMs = Number.isFinite(numeric) ? numeric : Date.parse(String(value));
  if (!Number.isFinite(atMs)) throw new Error('clock freeze --at requires a valid date or epoch milliseconds');
  return atMs;
}
export function parseClockOffsetMs(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms)) throw new Error('clock offset --ms requires a finite millisecond value');
  return ms;
}
export function parseClockArgs(args = []) {
  const fopts = parseFormatArgs(args, ['text', 'json']);
  const tokens = fopts.args || [];
  if (tokens.length === 0) return { mode: 'status', format: fopts.format };
  const cmd = String(tokens[0] || '').toLowerCase();
  if (cmd === 'reset' || cmd === 'off' || cmd === 'real') {
    if (tokens.length > 1) throw new Error(`clock ${tokens[0]} does not accept extra arguments`);
    return { mode: 'reset', format: fopts.format, profile: 'real' };
  }
  if (cmd === 'freeze') {
    let atMs = null;
    for (let i = 1; i < tokens.length; i++) {
      const token = tokens[i];
      if (token === '--at') atMs = parseClockTimestamp(tokens[++i]);
      else throw new Error(`clock freeze: unknown option ${token}`);
    }
    if (atMs == null) throw new Error('clock freeze requires --at <date|epoch-ms>');
    return { mode: 'apply', format: fopts.format, profile: 'freeze', atMs };
  }
  if (cmd === 'offset') {
    let offsetMs = null;
    for (let i = 1; i < tokens.length; i++) {
      const token = tokens[i];
      if (token === '--ms') offsetMs = parseClockOffsetMs(tokens[++i]);
      else if (token === '--seconds') offsetMs = parseClockOffsetMs(tokens[++i]) * 1000;
      else throw new Error(`clock offset: unknown option ${token}`);
    }
    if (offsetMs == null) throw new Error('clock offset requires --ms <milliseconds>');
    return { mode: 'apply', format: fopts.format, profile: 'offset', offsetMs };
  }
  throw new Error(`Unknown clock command: ${tokens[0]}. Use freeze, offset, reset, or no args for status.`);
}
export function clockPageScript(config) {
  return `(${function installCdpClock(cfg) {
    const g = globalThis;
    const existing = g.__cdpClockOriginals;
    const originals = existing || {
      Date: g.Date,
      performanceNow: g.performance && typeof g.performance.now === 'function'
        ? g.performance.now.bind(g.performance)
        : null,
    };
    if (!existing) {
      Object.defineProperty(g, '__cdpClockOriginals', {
        value: originals,
        configurable: true,
        writable: true,
      });
    }

    if (cfg.profile === 'real' || cfg.mode === 'reset') {
      if (originals.Date) g.Date = originals.Date;
      if (g.performance && originals.performanceNow) {
        try {
          Object.defineProperty(g.performance, 'now', {
            value: originals.performanceNow,
            configurable: true,
          });
        } catch {}
      }
      try { delete g.__cdpClock; } catch {}
      return { ok: true, profile: 'real', now: originals.Date.now() };
    }

    const OriginalDate = originals.Date;
    const profile = cfg.profile;
    const atMs = Number(cfg.atMs);
    const offsetMs = Number(cfg.offsetMs || 0);
    const installedAtPerfMs = originals.performanceNow ? originals.performanceNow() : 0;
    const currentNow = () => profile === 'freeze' ? atMs : OriginalDate.now() + offsetMs;

    function MockDate(...args) {
      if (this instanceof MockDate) {
        return args.length ? new OriginalDate(...args) : new OriginalDate(currentNow());
      }
      return new OriginalDate(currentNow()).toString();
    }
    Object.setPrototypeOf(MockDate, OriginalDate);
    MockDate.prototype = OriginalDate.prototype;
    MockDate.now = currentNow;
    MockDate.parse = OriginalDate.parse.bind(OriginalDate);
    MockDate.UTC = OriginalDate.UTC.bind(OriginalDate);
    try { Object.defineProperty(MockDate, 'name', { value: 'Date', configurable: true }); } catch {}
    g.Date = MockDate;

    if (g.performance && originals.performanceNow) {
      try {
        Object.defineProperty(g.performance, 'now', {
          value: () => profile === 'freeze' ? installedAtPerfMs : originals.performanceNow() + offsetMs,
          configurable: true,
        });
      } catch {}
    }

    const now = currentNow();
    g.__cdpClock = {
      profile,
      atMs: profile === 'freeze' ? atMs : null,
      offsetMs: profile === 'offset' ? offsetMs : 0,
      iso: new OriginalDate(now).toISOString(),
    };
    return { ok: true, ...g.__cdpClock, now };
  }.toString()})(${JSON.stringify(config)});`;
}
export function formatSignedMs(ms) {
  return `${ms >= 0 ? '+' : ''}${ms}ms`;
}
export function formatClockSummary(clock = null) {
  if (!clock || clock.profile === 'real') return 'real time';
  if (clock.profile === 'freeze') return `frozen at ${new Date(clock.atMs).toISOString()}`;
  if (clock.profile === 'offset') return `offset ${formatSignedMs(clock.offsetMs || 0)}`;
  return 'real time';
}
export function buildClockModel(session, parsed) {
  const clock = parsed.mode === 'status' ? session.clock : (session.clock || null);
  return {
    schema: 'chrome-cdp-ex.clock.v1',
    targetId: session.targetId,
    mode: parsed.mode,
    profile: clock?.profile || 'real',
    atMs: clock?.atMs ?? null,
    offsetMs: clock?.offsetMs ?? 0,
    scriptIdentifier: clock?.scriptIdentifier || null,
  };
}
export function formatClockText(model) {
  const lines = [`Clock: ${formatClockSummary(model)}`];
  if (model.profile === 'real') {
    lines.push(`Next: cdp clock ${model.targetId} freeze --at 2020-01-02T03:04:05.000Z`);
    lines.push(`Next: cdp clock ${model.targetId} offset --ms 3600000`);
  } else {
    lines.push(`Next: cdp clock ${model.targetId} reset`);
  }
  return lines.join('\n');
}
export async function removeClockScriptIfNeeded(cdp, sid, session) {
  const identifier = session.clock?.scriptIdentifier;
  if (identifier) {
    await cdpDomains(cdp).Page.removeScriptToEvaluateOnNewDocument( { identifier }, sid);
  }
}
export async function clockStr(cdp, sid, session, args = []) {
  const parsed = parseClockArgs(args);
  if (parsed.mode === 'apply') {
    await removeClockScriptIfNeeded(cdp, sid, session);
    const source = clockPageScript(parsed);
    const added = await cdpDomains(cdp).Page.addScriptToEvaluateOnNewDocument( { source }, sid);
    await cdpDomains(cdp).Runtime.evaluate( { expression: source, returnByValue: true, awaitPromise: true }, sid);
    session.clock = {
      profile: parsed.profile,
      atMs: parsed.profile === 'freeze' ? parsed.atMs : null,
      offsetMs: parsed.profile === 'offset' ? parsed.offsetMs : 0,
      scriptIdentifier: added.identifier || null,
      appliedAt: Date.now(),
    };
    appendSessionEnvironmentLog(session, { kind: 'clock', ts: session.clock.appliedAt, action: 'apply', clock: session.clock });
  } else if (parsed.mode === 'reset') {
    await removeClockScriptIfNeeded(cdp, sid, session);
    await cdpDomains(cdp).Runtime.evaluate( { expression: clockPageScript(parsed), returnByValue: true, awaitPromise: true }, sid);
    appendSessionEnvironmentLog(session, { kind: 'clock', ts: Date.now(), action: 'reset' });
    session.clock = null;
  }
  const model = buildClockModel(session, parsed);
  return parsed.format === 'json' ? formatJson(model) : formatClockText(model);
}
export function kbpsToBytesPerSecond(kbps) {
  const n = Number(kbps);
  return Number.isFinite(n) ? Math.round(n * 1000 / 8) : -1;
}
export function throttleCdpParams(profile) {
  if (profile.profile === 'off') {
    return { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 };
  }
  return {
    offline: profile.offline === true,
    latency: Number(profile.latencyMs || 0),
    downloadThroughput: profile.offline ? 0 : kbpsToBytesPerSecond(profile.downloadKbps),
    uploadThroughput: profile.offline ? 0 : kbpsToBytesPerSecond(profile.uploadKbps),
  };
}
export function parseNonNegativeNumber(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`throttle ${label} requires a non-negative number`);
  return n;
}
export function parseThrottleArgs(args = []) {
  const fopts = parseFormatArgs(args, ['text', 'json']);
  const tokens = fopts.args || [];
  if (tokens.length === 0) return { mode: 'status', format: fopts.format };
  let profileName = String(tokens[0] || '').toLowerCase();
  if (profileName === 'reset' || profileName === 'none') profileName = 'off';
  let profile;
  if (profileName === 'custom') {
    const custom = { profile: 'custom', offline: false, latencyMs: 0, downloadKbps: null, uploadKbps: null };
    for (let i = 1; i < tokens.length; i++) {
      const token = tokens[i];
      if (token === '--latency') custom.latencyMs = parseNonNegativeNumber(tokens[++i], '--latency');
      else if (token === '--download' || token === '--down') custom.downloadKbps = parseNonNegativeNumber(tokens[++i], token);
      else if (token === '--upload' || token === '--up') custom.uploadKbps = parseNonNegativeNumber(tokens[++i], token);
      else throw new Error(`throttle custom: unknown option ${token}`);
    }
    if (custom.downloadKbps == null || custom.uploadKbps == null) {
      throw new Error('throttle custom requires --download <kbps> and --upload <kbps>');
    }
    profile = custom;
  } else {
    profile = THROTTLE_PRESETS[profileName];
    if (!profile) {
      throw new Error(`Unknown throttle profile: ${tokens[0]}. Use off, offline, slow-3g, fast-3g, lte, or custom.`);
    }
    if (tokens.length > 1) {
      throw new Error(`throttle ${tokens[0]} does not accept extra arguments. Use custom --latency <ms> --download <kbps> --upload <kbps>.`);
    }
    profile = { ...profile };
  }
  const cdpParams = throttleCdpParams(profile);
  return { mode: 'apply', format: fopts.format, ...profile, cdpParams };
}
export function formatThrottleSummary(profile = null) {
  if (!profile || profile.profile === 'off') return 'off';
  if (profile.offline) return 'offline';
  return `${profile.profile} — latency ${profile.latencyMs}ms, ${profile.downloadKbps} kbps down, ${profile.uploadKbps} kbps up`;
}
export function throttleModel(session, parsed) {
  const current = parsed.mode === 'status'
    ? (session.networkThrottle || { profile: 'off', offline: false, latencyMs: 0, downloadKbps: null, uploadKbps: null })
    : parsed;
  return {
    schema: 'chrome-cdp-ex.throttle.v1',
    targetId: session.targetId,
    mode: parsed.mode,
    profile: current.profile || 'off',
    offline: current.offline === true,
    latencyMs: current.latencyMs || 0,
    downloadKbps: current.downloadKbps,
    uploadKbps: current.uploadKbps,
    cdpParams: current.cdpParams || throttleCdpParams(current),
  };
}
export function formatThrottleText(model) {
  const lines = [`Network throttle: ${formatThrottleSummary(model)}`];
  if (model.mode === 'status') {
    lines.push('Apply a preset.');
    lines.push(formatNextLine(`cdp throttle ${model.targetId} slow-3g`));
  } else if (model.profile === 'off') {
    lines.push('Network conditions reset to browser defaults.');
    lines.push('Re-apply a preset.');
    lines.push(formatNextLine(`cdp throttle ${model.targetId} slow-3g`));
  } else {
    lines.push(formatNextLine(`cdp throttle ${model.targetId} off`));
  }
  return lines.join('\n');
}
export async function throttleStr(cdp, sid, session, args = []) {
  const parsed = parseThrottleArgs(args);
  if (parsed.mode === 'apply') {
    await cdpDomains(cdp).Network.enable( {}, sid);
    await cdpDomains(cdp).Network.emulateNetworkConditions( parsed.cdpParams, sid);
    session.networkThrottle = {
      profile: parsed.profile,
      offline: parsed.offline,
      latencyMs: parsed.latencyMs,
      downloadKbps: parsed.downloadKbps,
      uploadKbps: parsed.uploadKbps,
      cdpParams: parsed.cdpParams,
      appliedAt: Date.now(),
    };
    appendSessionEnvironmentLog(session, { kind: 'throttle', ts: session.networkThrottle.appliedAt, action: 'apply', throttle: session.networkThrottle });
    rememberTabEnvironment(session);
  }
  const model = throttleModel(session, parsed);
  return parsed.format === 'json' ? formatJson(model) : formatThrottleText(model);
}
export function clearObservationBuffers({ consoleBuf, exceptionBuf, navBuf, netReqBuf, pendingReqs, networkStatusByRequest, lastReadSeq, session = null }) {
  consoleBuf?.clear();
  exceptionBuf?.clear();
  navBuf?.clear();
  netReqBuf?.clear();
  pendingReqs?.clear();
  networkStatusByRequest?.clear();
  if (lastReadSeq) {
    lastReadSeq.console = consoleBuf?.latest?.() || 0;
    lastReadSeq.exception = exceptionBuf?.latest?.() || 0;
  }
  if (session) {
    session.restoredNetlogHold = false;
    rememberTabObservation(session);
  }
}
export function actionNetworkQuietOptions(action, { navigated = false } = {}) {
  // Document nav already waited until dest URL committed + readyState complete.
  // Do not add the leftover 150ms quiet floor after a cached document GET.
  if (action === 'nav') return null;
  if (navigated) return { quietMs: 50, timeoutMs: 250 };
  return { quietMs: 150, timeoutMs: 1000 };
}
export async function waitForActionNetworkQuiet(pendingReqs, { quietMs = 150, timeoutMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let quietSince = pendingReqs?.size ? 0 : Date.now();
  while (Date.now() < deadline) {
    if (pendingReqs?.size) {
      quietSince = 0;
    } else {
      if (!quietSince) quietSince = Date.now();
      if (Date.now() - quietSince >= quietMs) return true;
    }
    await sleep(50);
  }
  return !pendingReqs?.size;
}
export function appendPendingActionNetworkEntries(pendingReqs, netReqBuf, sinceTs, { now = Date.now() } = {}) {
  if (!pendingReqs || !netReqBuf) return 0;
  let count = 0;
  for (const req of pendingReqs.values()) {
    if (!req || req.actionEvidenceReported || req.ts < sinceTs) continue;
    req.actionEvidenceReported = true;
    netReqBuf.push({
      requestId: req.requestId,
      method: req.method,
      url: req.url,
      status: 'pending',
      type: req.type,
      duration: now - req.ts,
      size: 0,
      pending: true,
      ts: req.ts,
    });
    count += 1;
  }
  return count;
}
// width/height: the layout viewport (innerWidth/innerHeight). screenWidth/screenHeight: the screen,
// which a mobile override sets even when a page without <meta viewport> lays out at 980px.
export async function readViewportDims(cdp, sid) {
  const d = JSON.parse(await evalStr(cdp, sid, `JSON.stringify({w:window.innerWidth,h:window.innerHeight,sw:screen.width,sh:screen.height,dpr:window.devicePixelRatio})`));
  return {
    width: Number(d.w), height: Number(d.h),
    screenWidth: Number(d.sw), screenHeight: Number(d.sh),
    dpr: Number(d.dpr),
  };
}
// Sets the override without reading it back: audits that sweep sizes measure the page themselves.
export async function applyViewportOverride(cdp, sid, size) {
  const match = String(size || '').match(/^(\d+)[x×](\d+)$/);
  if (!match) throw new Error('Format: <width>x<height> (e.g. 375x812, 1280x720)');
  const width = parseInt(match[1]), height = parseInt(match[2]);
  await cdpDomains(cdp).Emulation.setDeviceMetricsOverride( {
    width, height, deviceScaleFactor: 0, mobile: width <= 768,
  }, sid);
  return { width, height };
}
// Applied when either the layout or the emulated screen matches: a desktop override (mobile:false)
// keeps the real screen, and a mobile size without <meta viewport> keeps a 980px layout.
// Only a mobile override emulates the screen, so only then does a screen match prove anything.
export function assessViewportReadback(width, height, readback = {}) {
  const dpr = readback.dpr;
  const mobile = width <= 768;
  const layoutMatches = readback.width === width && readback.height === height;
  const applied = layoutMatches || (mobile && readback.screenWidth === width && readback.screenHeight === height);
  const mobileNote = mobile ? ' (mobile mode)' : '';
  const layoutNote = layoutMatches ? '' : `; layout ${readback.width}x${readback.height}`;
  const text = applied
    ? `Viewport: ${width}x${height} (DPR ${dpr})${mobileNote}${layoutNote}`
    : `Viewport: ${readback.width}x${readback.height} (DPR ${dpr})${mobileNote}; requested ${width}x${height}`;
  const flags = [`DPR ${dpr}`];
  if (mobile) flags.push('mobile mode');
  if (applied && !layoutMatches) flags.push(`layout ${readback.width}x${readback.height}`);
  const reason = applied
    ? `Viewport ${width}x${height} applied (${flags.join(', ')}).`
    : `Requested ${width}x${height}${mobile ? ' (mobile mode)' : ''}; read back ${readback.width}x${readback.height} (DPR ${dpr}).`;
  return {
    applied,
    requested: { width, height },
    actual: {
      width: readback.width,
      height: readback.height,
      screenWidth: readback.screenWidth,
      screenHeight: readback.screenHeight,
      dpr,
      mobile,
      layoutMatches,
    },
    text,
    reason,
  };
}
// The daemon shallow-copies the action target before dispatch. viewportStr stores
// the readback on the session; this copies it onto the clone the receipt uses.
export function rememberViewportReadback(actionTarget, session) {
  const assessment = session?.viewportReadback;
  if (!actionTarget || !assessment?.requested) return actionTarget;
  actionTarget.viewportApplication = assessment;
  return actionTarget;
}
// #533: the receipt states the size read back from the page, so an agent knows the override took
// effect. `session`, when given, remembers the override so an audit can put it back afterwards.
// #578: the same readback is the action's success signal, independent of the AX diff.
export async function viewportStr(cdp, sid, size, { session = null, application = null } = {}) {
  if (!size) {
    const d = await readViewportDims(cdp, sid);
    return `Viewport: ${d.width}×${d.height} (DPR: ${d.dpr})`;
  }
  const { width, height } = await applyViewportOverride(cdp, sid, size);
  if (session) session.viewportOverride = { width, height };
  const readback = await readViewportDims(cdp, sid);
  const assessment = assessViewportReadback(width, height, readback);
  if (session) session.viewportReadback = assessment;
  if (application && typeof application === 'object') Object.assign(application, assessment);
  return assessment.text;
}
export async function cookieSetStr(cdp, sid, cookieStr) {
  if (!cookieStr) throw new Error('Cookie string required: "name=value" or "name=value; domain=.example.com"');
  const parts = cookieStr.split(';').map(s => s.trim());
  const [name, ...valParts] = parts[0].split('=');
  const value = valParts.join('='); // handle values with = in them
  if (!name) throw new Error('Cookie name required');

  const cookie = { name: name.trim(), value };
  for (const part of parts.slice(1)) {
    const [k, ...v] = part.split('=');
    const key = k.trim().toLowerCase();
    const val = v.join('=').trim();
    if (key === 'domain') cookie.domain = val;
    else if (key === 'path') cookie.path = val;
    else if (key === 'secure') cookie.secure = true;
    else if (key === 'httponly') cookie.httpOnly = true;
    else if (key === 'samesite') cookie.sameSite = val;
  }

  // Batch location queries into a single eval round-trip
  const loc = JSON.parse(await evalStr(cdp, sid, 'JSON.stringify({hostname:location.hostname,href:location.href})'));
  if (!cookie.domain) cookie.domain = loc.hostname;
  cookie.url = loc.href;

  const { success } = await cdpDomains(cdp).Network.setCookie( cookie, sid);
  if (!success) throw new Error(`Failed to set cookie: ${name}`);
  return `Cookie set: ${name}=${value.substring(0, 30)}${value.length > 30 ? '...' : ''} (domain: ${cookie.domain})`;
}
export function cookieDeleteParams(cookie, pageUrl = '') {
  const params = { name: cookie.name };
  if (cookie.domain) params.domain = cookie.domain;
  else if (pageUrl) params.url = pageUrl;
  if (cookie.path) params.path = cookie.path;
  if (cookie.partitionKey) params.partitionKey = cookie.partitionKey;
  return params;
}
export async function cookieDelStr(cdp, sid, name) {
  if (!name) throw new Error('Cookie name required');
  const { cookies } = await cdpDomains(cdp).Network.getCookies( {}, sid);
  const matches = (cookies || []).filter(cookie => cookie.name === name);
  if (!matches.length) throw new Error(`Cookie not found: ${name}`);
  const needsUrl = matches.some(cookie => !cookie.domain);
  const pageUrl = needsUrl ? await evalStr(cdp, sid, 'window.location.href') : '';
  for (const cookie of matches) {
    await cdpDomains(cdp).Network.deleteCookies( cookieDeleteParams(cookie, pageUrl), sid);
  }
  const { cookies: remaining } = await cdpDomains(cdp).Network.getCookies( {}, sid);
  const leftover = (remaining || []).some(cookie => cookie.name === name);
  if (leftover) throw new Error(`Cookie still present: ${name}`);
  return `Cookie deleted: ${name}`;
}
export function assertReadableUploadFiles(filePaths) {
  const files = String(filePaths || '').split(',').map(f => f.trim()).filter(Boolean);
  if (!files.length) throw new Error('File path(s) required (comma-separated for multiple)');
  for (const file of files) {
    let stat;
    try {
      stat = statSync(file);
    } catch {
      throw new Error(`upload: file not found: ${file}`);
    }
    if (!stat.isFile()) throw new Error(`upload: file not found: ${file}`);
  }
  return files;
}
export function describedNodeAttribute(node, name) {
  const attrs = node?.attributes || [];
  // CDP lists attributes as a flat [name, value, ...] array. indexOf(name) also
  // hits a value (name="type", id="type"), so only even indexes are names.
  for (let i = 0; i + 1 < attrs.length; i += 2) {
    if (attrs[i] === name) return attrs[i + 1];
  }
  return undefined;
}
export function asciiEqualsIgnoreCase(value, expectedLower) {
  const text = String(value ?? '');
  if (text.length !== expectedLower.length) return false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const folded = code >= 65 && code <= 90 ? code + 32 : code;
    if (folded !== expectedLower.charCodeAt(i)) return false;
  }
  return true;
}
export function describedNodeIsFileInput(node) {
  return node?.nodeName === 'INPUT' && asciiEqualsIgnoreCase(describedNodeAttribute(node, 'type'), 'file');
}
// The ref's node, or the one file input it wraps or labels. Perceive shows a file input as a
// [button]; that button can be the input itself or a control inside its shadow root.
export function uploadFileInputLocatorDeclaration() {
  return `function() {
    const isFile = (node) => !!(node && node.nodeType === 1 && String(node.tagName || '').toUpperCase() === 'INPUT' && String(node.type || '').toLowerCase() === 'file');
    if (isFile(this)) return this;
    const found = [];
    const push = (node) => { if (isFile(node) && found.indexOf(node) === -1) found.push(node); };
    const tag = String(this.tagName || '').toUpperCase();
    if (tag === 'LABEL') push(this.control);
    if (typeof this.querySelectorAll === 'function') {
      const wrapped = this.querySelectorAll('input[type="file"]');
      for (let i = 0; i < wrapped.length; i++) push(wrapped[i]);
    }
    if (tag === 'LABEL' && this.ownerDocument && typeof this.ownerDocument.querySelectorAll === 'function') {
      const labeled = this.ownerDocument.querySelectorAll('input[type="file"]');
      for (let i = 0; i < labeled.length; i++) {
        const labels = labeled[i] && labeled[i].labels;
        if (!labels) continue;
        for (let j = 0; j < labels.length; j++) if (labels[j] === this) push(labeled[i]);
      }
    }
    // Two file inputs under one ref is the same refusal as a CSS selector that
    // matches two inputs. The shadow host is only the perceive button when the
    // ref itself wraps nothing.
    if (found.length > 1) {
      const detail = [];
      for (let i = 0; i < found.length; i++) {
        const el = found[i];
        let label = '';
        try {
          const aria = el.getAttribute && el.getAttribute('aria-label');
          const fromLabel = el.labels && el.labels[0] && (el.labels[0].innerText || el.labels[0].textContent);
          label = String(aria || fromLabel || '').split(/\\s+/).join(' ').trim().slice(0, 40);
        } catch (e) { label = ''; }
        detail.push({
          index: i,
          id: el.id || '',
          name: el.name || '',
          accept: el.accept || '',
          multiple: !!el.multiple,
          label: label,
        });
      }
      throw new Error('UPLOAD_AMBIGUOUS_JSON ' + JSON.stringify(detail));
    }
    if (found.length === 1) return found[0];
    let host = null;
    try {
      const root = typeof this.getRootNode === 'function' ? this.getRootNode() : null;
      host = root && root.host;
    } catch (e) { host = null; }
    return isFile(host) ? host : null;
  }`;
}
export function ambiguousUploadMatchesFromMessage(message) {
  const text = String(message || '');
  const marker = 'UPLOAD_AMBIGUOUS_JSON ';
  const at = text.indexOf(marker);
  if (at === -1) return null;
  const start = text.indexOf('[', at + marker.length);
  if (start === -1) return [{ index: 0 }, { index: 1 }];
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '[') depth += 1;
    else if (char === ']') {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(start, i + 1));
          if (Array.isArray(parsed) && parsed.length > 1) return parsed;
        } catch { /* fall through */ }
        return [{ index: 0 }, { index: 1 }];
      }
    }
  }
  return [{ index: 0 }, { index: 1 }];
}
export async function readInputMultiple(cdp, sid, objectId) {
  const evaluated = await cdpDomains(cdp).Runtime.callFunctionOn({
    objectId,
    functionDeclaration: 'function() { return !!(this && this.multiple); }',
    returnByValue: true,
  }, sid);
  if (evaluated.exceptionDetails) throw new Error(runtimeExceptionMessage(evaluated.exceptionDetails));
  return evaluated.result?.value === true;
}
// #743: a page may read the file in its change handler and then clear input.value. Before the
// files are set, a capture listener on the input's root (its document, or the shadow root it is in)
// records what the input held at its first input or change event. The read-back takes that record
// and removes the listeners; a failed set removes them too. Each upload uses its own global key.
function uploadSeenKey() {
  return `__chromeCdpExUploadSeen_${randomBytes(6).toString('hex')}`;
}
function uploadSeenArmSource(elementExpression, key) {
  return `
    const el = ${elementExpression};
    const root = el && (typeof el.getRootNode === 'function' ? el.getRootNode() : el.ownerDocument);
    if (!root || typeof root.addEventListener !== 'function') return false;
    const state = { seen: null };
    const record = (event) => {
      if (event.target !== el || state.seen) return;
      state.seen = [...(el.files || [])].map(file => ({ name: file.name, size: file.size }));
    };
    root.addEventListener('input', record, true);
    root.addEventListener('change', record, true);
    globalThis.${key} = () => {
      root.removeEventListener('input', record, true);
      root.removeEventListener('change', record, true);
      return state.seen;
    };
    return true;`;
}
function uploadSeenTakeSource(key) {
  return `const take = globalThis.${key};
    delete globalThis.${key};
    let seen = null;
    try { seen = typeof take === 'function' ? take() : null; } catch (e) { seen = null; }`;
}
async function runUploadSeenScript(cdp, sid, { objectId = null }, body) {
  try {
    if (objectId) {
      await cdpDomains(cdp).Runtime.callFunctionOn({ objectId, functionDeclaration: `function() { ${body} }`, returnByValue: true }, sid);
    } else {
      await evalStr(cdp, sid, `(()=>{ ${body} })()`, false, { timeoutMs: 3000, raw: true });
    }
  } catch {
    // Best-effort, like the other upload probes: without it a cleared input fails as before.
  }
}
function armUploadSeen(cdp, sid, target, key) {
  const element = target.objectId ? 'this' : `document.querySelector(${JSON.stringify(target.selector)})`;
  return runUploadSeenScript(cdp, sid, target, `/* __uploadArm */ ${uploadSeenArmSource(element, key)}`);
}
async function setFilesWithUploadSeen(cdp, sid, params, target, key) {
  try {
    await cdpDomains(cdp).DOM.setFileInputFiles(params, sid);
  } catch (error) {
    await runUploadSeenScript(cdp, sid, target, `/* __uploadDisarm */ ${uploadSeenTakeSource(key)} return true;`);
    throw error;
  }
}
// A read-back is { files, seen }. An older page answer (a bare array) has no seen record.
function uploadReadBack(value) {
  if (Array.isArray(value)) return { files: value, seen: null };
  if (value && Array.isArray(value.files)) return { files: value.files, seen: Array.isArray(value.seen) ? value.seen : null };
  return null;
}
export async function readUploadedFilesFromObject(cdp, sid, objectId, key = uploadSeenKey()) {
  try {
    const evaluated = await cdpDomains(cdp).Runtime.callFunctionOn({
      objectId,
      functionDeclaration: `function() {
        ${uploadSeenTakeSource(key)}
        if (!this || !this.files) return null;
        return { files: [...this.files].map(file => ({ name: file.name, size: file.size })), seen };
      }`,
      returnByValue: true,
    }, sid);
    if (evaluated.exceptionDetails) return null;
    return uploadReadBack(evaluated.result?.value);
  } catch {
    return null;
  }
}
// Returns a receipt note, or '' when the page reports exactly the files sent.
export function assertUploadedFilesMatch(selector, files, readBack) {
  const page = uploadReadBack(readBack);
  if (!page) return '';
  const sent = files.map(file => `${basename(file)}:${statSync(file).size}`);
  const list = entries => entries.map(file => `${file.name}:${file.size}`);
  const same = entries => entries.length === sent.length && entries.every((entry, i) => entry === sent[i]);
  const got = list(page.files);
  if (same(got)) return '';
  if (got.length === 0 && page.seen && same(list(page.seen))) return ' (the page cleared the input after its change event)';
  throw new Error(`upload: the page reports [${got.join(', ')}] but [${sent.join(', ')}] was sent to ${selector}`);
}
// A @ref names one node, so the #403 multi-match scan does not apply. Read the files back from
// the resolved input, not through querySelector.
export async function uploadByRef(cdp, sid, selector, files, refMap, refState) {
  const objectId = await resolveRefNode(cdp, sid, refMap, selector, refState);
  let described = await cdpDomains(cdp).DOM.describeNode({ objectId }, sid);
  let fileObjectId = objectId;
  let node = described.node;
  if (!describedNodeIsFileInput(node)) {
    const located = await cdpDomains(cdp).Runtime.callFunctionOn({
      objectId,
      functionDeclaration: uploadFileInputLocatorDeclaration(),
      returnByValue: false,
    }, sid);
    if (located.exceptionDetails) {
      const message = runtimeExceptionMessage(located.exceptionDetails);
      const matches = ambiguousUploadMatchesFromMessage(message);
      if (matches) throw new Error(uploadAmbiguousMessage(selector, matches));
      throw new Error(message);
    }
    fileObjectId = located.result?.objectId;
    if (!fileObjectId) throw new Error('Element is not an <input type="file">');
    // The locator already accepted this node by HTMLInputElement.type. Checking the
    // content attribute again rejects type="FILE" and a type that exists only on the IDL.
    described = await cdpDomains(cdp).DOM.describeNode({ objectId: fileObjectId }, sid);
    node = described.node;
  }
  if (files.length > 1 && !(await readInputMultiple(cdp, sid, fileObjectId))) {
    throw new Error(`upload: ${selector} does not accept several files (no \`multiple\`); pass one file`);
  }
  const params = { files };
  if (node.backendNodeId != null) params.backendNodeId = node.backendNodeId;
  else params.objectId = fileObjectId;
  const key = uploadSeenKey();
  await armUploadSeen(cdp, sid, { objectId: fileObjectId }, key);
  await setFilesWithUploadSeen(cdp, sid, params, { objectId: fileObjectId }, key);
  const note = assertUploadedFilesMatch(selector, files, await readUploadedFilesFromObject(cdp, sid, fileObjectId, key));
  return `Uploaded ${files.length} file(s) to ${selector}: ${files.join(', ')}${note}`;
}
export async function uploadStr(cdp, sid, selector, filePaths, refMap, refState) {
  if (!selector) throw new Error('CSS selector or @ref for <input type="file"> required');
  if (!filePaths) throw new Error('File path(s) required (comma-separated for multiple)');
  const files = assertReadableUploadFiles(filePaths);
  if (isRef(selector)) return uploadByRef(cdp, sid, selector, files, refMap, refState);
  const { root } = await cdpDomains(cdp).DOM.getDocument( {}, sid);
  const { nodeId } = await cdpDomains(cdp).DOM.querySelector( { nodeId: root.nodeId, selector }, sid);
  if (!nodeId) throw new Error('Element not found: ' + selector);
  // Validate it's a file input — attributes is a flat [name, value, name, value, ...] array
  const { node } = await cdpDomains(cdp).DOM.describeNode( { nodeId }, sid);
  if (!describedNodeIsFileInput(node))
    throw new Error('Element is not an <input type="file">');
  // #403: a selector such as input[type=file] can match a template card's input as well as the
  // composer's, and DOM.querySelector silently takes the first. These probes are best-effort: when the
  // page cannot be evaluated the command behaves as before.
  const matches = await scanUploadMatches(cdp, sid, selector);
  if (matches && matches.length > 1) throw new Error(uploadAmbiguousMessage(selector, matches));
  if (matches && matches.length === 1 && matches[0].multiple === false && files.length > 1) {
    throw new Error(`upload: ${selector} does not accept several files (no \`multiple\`); pass one file`);
  }
  const key = uploadSeenKey();
  await armUploadSeen(cdp, sid, { selector }, key);
  await setFilesWithUploadSeen(cdp, sid, { files, nodeId }, { selector }, key);
  const note = assertUploadedFilesMatch(selector, files, await readUploadedFiles(cdp, sid, selector, key));
  return `Uploaded ${files.length} file(s) to ${selector}: ${files.join(', ')}${note}`;
}
export async function evalUploadProbe(cdp, sid, expression) {
  try {
    const raw = await evalStr(cdp, sid, expression, false, { timeoutMs: 3000, raw: true });
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
export function scanUploadMatches(cdp, sid, selector) {
  return evalUploadProbe(cdp, sid, `(()=>{ /* __uploadScan */
    const label = (el) => {
      const own = el.getAttribute('aria-label') || (el.labels && el.labels[0] && el.labels[0].innerText) || '';
      if (own.trim()) return own.trim().slice(0, 40);
      for (let p = el.parentElement, i = 0; p && i < 4; p = p.parentElement, i++) {
        const text = (p.innerText || '').replace(/\\s+/g, ' ').trim();
        if (text) return text.slice(0, 40);
      }
      return '';
    };
    return JSON.stringify([...document.querySelectorAll(${JSON.stringify(selector)})].map((el, index) => (
      { index, id: el.id || '', name: el.name || '', accept: el.accept || '', multiple: !!el.multiple, label: label(el) })));
  })()`);
}
export async function readUploadedFiles(cdp, sid, selector, key = uploadSeenKey()) {
  try {
    const raw = await evalStr(cdp, sid, `(()=>{ /* __uploadRead */
    ${uploadSeenTakeSource(key)}
    const el = document.querySelector(${JSON.stringify(selector)});
    return JSON.stringify({ files: el && el.files ? [...el.files].map(f => ({ name: f.name, size: f.size })) : [], seen });
  })()`, false, { timeoutMs: 3000, raw: true });
    return uploadReadBack(JSON.parse(raw));
  } catch {
    return null;
  }
}
export function uploadAmbiguousMessage(selector, matches) {
  const lines = matches.map(m => `  #${m.index}${m.id ? ` id="${m.id}"` : ''}${m.name ? ` name="${m.name}"` : ''} label="${m.label || ''}" accept="${m.accept || ''}"${m.multiple ? ' multiple' : ''}`);
  return [
    `upload: selector ${JSON.stringify(selector)} matches ${matches.length} elements, refusing to guess which one to fill:`,
    ...lines,
    'Make the selector match exactly one input (an id, a container such as "form input[type=file]", or :nth-of-type(N)).',
  ].join('\n');
}
// --- Clean text extraction ---
// Parse `text` arguments. Supports:
//   text                          → full body
//   text "main, [role=main]"      → fallback chain (try first, then next…)
//   text --auto                   → auto-pick main content (excludes nav/aside/script/style)
//   text --root auto|body|document|<sel>  → scope extraction root
//   text --auto --exclude "nav,.sidebar"  → custom extra exclusions
export function parseTextArgs(args) {
  const opts = { selectors: [], auto: false, exclude: null, root: null };
  const tokens = Array.isArray(args) ? args.filter(a => a !== undefined && a !== null) : [];
  for (let i = 0; i < tokens.length; i++) {
    const a = tokens[i];
    if (a === '--auto') opts.auto = true;
    else if (a === '--root') opts.root = tokens[++i] || 'auto';
    else if (a === '--exclude' || a === '-x') opts.exclude = tokens[++i];
    else if (typeof a === 'string' && a.startsWith('--')) {
      throw new Error(`text: unknown argument ${a}`);
    } else if (typeof a === 'string') {
      // Comma list = fallback chain (try each until one matches)
      const parts = a.split(',').map(s => s.trim()).filter(Boolean);
      if (parts.length === 0) continue;
      opts.selectors.push(...parts);
    }
  }
  return opts;
}
export function formatTextNoMatchError(parsed = {}, opts = {}) {
  const tried = (parsed.tried || []).join(', ') || '(no candidates)';
  const root = parsed.root || opts.root || 'auto';
  const selector = (opts.selectors && opts.selectors[0]) || parsed.sel || '';
  const lines = [
    `text: no element matched within root "${root}". Tried: ${tried}.`,
    `Scope: root=${root}${selector ? `; selector=${selector}` : ''}.`,
  ];
  const fallback = selector ? querySelectorEvalCommand(opts.targetPrefix || '<target>', selector, '?.textContent') : null;
  if (fallback) {
    lines.push(`Fallback: ${fallback}`);
  } else {
    lines.push('Try `text <target> --auto` or `text <target> "main, [role=main], body"`.');
  }
  lines.push('Tip: `text --root body|document|auto|<css>` changes the search root.');
  return lines.join(' ');
}
export function textPageScript(opts) {
  const { selectors = [], auto = false, exclude = null, root = null } = opts || {};
  const extraExcludes = exclude ? exclude.split(',').map(s => s.trim()).filter(Boolean) : [];
  // Explicit selectors default to document-wide search so they match eval's
  // document.querySelector behavior. Full-page / --auto extraction still uses
  // auto root candidates to reduce nav/shell noise.
  const defaultRoot = (selectors.length > 0 && !auto) ? 'document' : 'auto';
  return `(function() {
    const STRIP = ['script','style','noscript','svg','link','meta','template'];
    const AUTO_NOISE = ['nav','aside','footer','[role="navigation"]','[role="complementary"]','[role="contentinfo"]'];
    const ROOT_CANDIDATES = ['#root', '[data-reactroot]', 'main', 'body'];
    const AUTO_CANDIDATES = ['main', '[role="main"]', 'article', '#root main', '#app main', '#root', '[data-reactroot]', '#app', 'body'];
    const EXTRA_EXCLUDES = ${JSON.stringify(extraExcludes)};
    function safeMatches(el, sel) { try { return !!el?.matches?.(sel); } catch { return false; } }
    function safeQuery(root, sel) { try { return root?.querySelector?.(sel) || null; } catch { return null; } }
    function selectorFallbacks(sel) {
      const s = String(sel || '').trim();
      if (s.toLowerCase() === 'header') {
        return ['header', '[role="banner"]', '[data-testid*="header" i]', '[class*="header" i]', '[id*="header" i]', 'h1', 'h2'];
      }
      return [s];
    }
    function pickRoot() {
      const setting = ${JSON.stringify(root || defaultRoot)};
      if (!setting || setting === 'auto' || setting === 'default') {
        for (const sel of ROOT_CANDIDATES) {
          const found = safeQuery(document, sel);
          if (found) return { el: found, sel };
        }
        return { el: document.body || document.documentElement, sel: 'body' };
      }
      if (setting === 'document') {
        return { el: document.documentElement || document.body, sel: 'document' };
      }
      if (setting === 'body') {
        return { el: document.body || document.documentElement, sel: 'body' };
      }
      const found = safeQuery(document, setting);
      return found ? { el: found, sel: setting } : { el: null, sel: setting };
    }
    // null for an element the text skips, else its computed display ('' for the root).
    function displayOf(el, rootEl, skipSelectors) {
      if (!el || el === rootEl) return '';
      if (el.hidden || el.getAttribute('aria-hidden') === 'true') return null;
      for (const sel of skipSelectors) if (safeMatches(el, sel)) return null;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return null;
      return String(style.display || '');
    }
    function clean(rootEl, stripNoise) {
      if (!rootEl) return '';
      const skipSelectors = STRIP.concat(EXTRA_EXCLUDES, stripNoise ? AUTO_NOISE : []);
      const parts = [];
      const blockish = new Set(['ADDRESS','ARTICLE','ASIDE','BLOCKQUOTE','BR','DIV','DL','FIELDSET','FIGCAPTION','FIGURE','FOOTER','FORM','H1','H2','H3','H4','H5','H6','HEADER','HR','LI','MAIN','NAV','OL','P','PRE','SECTION','TABLE','TR','UL']);
      // #649: like innerText, a table cell ends with a tab, and any other element laid out as a block
      // (dt, dd, grid and flex items, display:block spans) ends its line. An ARIA grid built from divs
      // reads like a table: a cell, gridcell, columnheader or rowheader ends with a tab, a row with a
      // newline. CELL stands in for that tab until source whitespace, tabs included, has been
      // collapsed. SOFT is a block's line end: it gives way to a newline the tag rules print right
      // after it, so nesting adds no blank lines.
      const BLOCK_DISPLAY = new Set(['block', 'flex', 'grid', 'list-item', 'table', 'table-row', 'table-caption', 'flow-root']);
      const CELL_ROLES = new Set(['cell', 'gridcell', 'columnheader', 'rowheader']);
      const CELL = '\\u001f';
      const SOFT = '\\u001e';
      function walk(node) {
        if (!node) return;
        if (node.nodeType === Node.TEXT_NODE) {
          parts.push(node.nodeValue || '');
          return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_NODE) return;
        const el = node.nodeType === Node.ELEMENT_NODE ? node : null;
        const display = el ? displayOf(el, rootEl, skipSelectors) : '';
        if (display === null) return;
        if (el?.tagName === 'BR') { parts.push('\\n'); return; }
        const role = el ? String(el.getAttribute('role') || '').toLowerCase() : '';
        const cellStart = display === 'table-cell' || CELL_ROLES.has(role) ? parts.length : -1;
        for (const child of node.childNodes) walk(child);
        if (cellStart >= 0) {
          // A block inside the cell ends the cell, not the row.
          while (parts.length > cellStart && !/[^\\s\\u001e]/.test(parts[parts.length - 1])) parts.pop();
          if (parts.length > cellStart) parts[parts.length - 1] = parts[parts.length - 1].replace(/[\\s\\u001e]+$/, '');
          parts.push(CELL);
        } else if (el && (blockish.has(el.tagName) || role === 'row')) {
          parts.push('\\n');
        } else if (BLOCK_DISPLAY.has(display)) {
          const last = String(parts[parts.length - 1] || '');
          if (!last.endsWith('\\n') && !last.endsWith(SOFT)) parts.push(SOFT);
        }
      }
      walk(rootEl);
      return parts.join('')
        .replace(/\\u001e+(?=[ \\t\\f\\v]*\\n)/g, '')
        .replace(/\\u001e+/g, '\\n')
        .replace(/[ \\t\\f\\v]+/g, ' ')
        .replace(/ *\\u001f */g, '\\t')
        .replace(/\\t+(?=\\n|$)/g, '')
        .replace(/ *\\n */g, '\\n')
        .replace(/(\\n\\s*){3,}/g, '\\n\\n')
        .trim();
    }
    function findWithin(scope, sel, tried) {
      for (const candidate of selectorFallbacks(sel)) {
        tried.push(candidate);
        if (safeMatches(scope, candidate)) return { el: scope, sel: candidate };
        const found = safeQuery(scope, candidate);
        if (found) return { el: found, sel: candidate === sel ? candidate : candidate + ' (fallback for ' + sel + ')' };
      }
      return null;
    }
    const tried = [];
    const rootInfo = pickRoot();
    if (!rootInfo.el) return JSON.stringify({ ok: false, root: rootInfo.sel, tried: ['--root ' + rootInfo.sel] });
    const scope = rootInfo.el;
    const selectors = ${JSON.stringify(selectors)};
    for (const sel of selectors) {
      const found = findWithin(scope, sel, tried);
      if (found) return JSON.stringify({ ok: true, sel: found.sel, root: rootInfo.sel, text: clean(found.el, false) });
    }
    if (${auto ? 'true' : 'false'}) {
      for (const sel of AUTO_CANDIDATES) {
        const found = findWithin(scope, sel, tried);
        if (!found) continue;
        const text = clean(found.el, true);
        if (text.length > 0) return JSON.stringify({ ok: true, sel: found.sel + ' (auto)', root: rootInfo.sel, text });
        tried.push(sel + ' (auto)');
      }
    }
    if (selectors.length === 0 && !${auto ? 'true' : 'false'}) {
      return JSON.stringify({ ok: true, sel: rootInfo.sel, root: rootInfo.sel, text: clean(scope, false) });
    }
    return JSON.stringify({ ok: false, root: rootInfo.sel, tried });
  })()`;
}
export async function textStr(cdp, sid, args, extra = {}) {
  // Support legacy single-string call: textStr(cdp, sid, 'main') — wrap into args[]
  let optsArgs = args;
  if (typeof args === 'string' || args == null) optsArgs = args ? [args] : [];
  else if (!Array.isArray(args)) optsArgs = [];
  const opts = parseTextArgs(optsArgs);
  if (extra.targetPrefix && !opts.targetPrefix) opts.targetPrefix = extra.targetPrefix;
  const targetPrefix = opts.targetPrefix || extra.targetPrefix || '<target>';
  if (opts.auto) {
    const page = await assertNotPdfViewerPage(cdp, sid, { targetPrefix, allowPdf: true });
    if (page && isPdfViewerContentType(page.contentType)) {
      const bytes = await loadPdfBytesForText(cdp, sid, page.url, extra);
      const text = extractPdfPageText(bytes);
      if (text) return text;
      throw pdfViewerError(page, { targetPrefix });
    }
  } else {
    await assertNotPdfViewerPage(cdp, sid, { targetPrefix });
  }
  const result = await evalStr(cdp, sid, textPageScript(opts));
  let parsed;
  try { parsed = JSON.parse(result); }
  catch { return result; }
  if (!parsed.ok) {
    const err = new Error(formatTextNoMatchError(parsed, opts));
    err.selectorMiss = true;
    throw err;
  }
  const out = parsed.text || '';
  // Hint when no scope was given and text is large.
  const noScope = opts.selectors.length === 0 && !opts.auto;
  if (noScope && out.length > 2000) {
    return out + '\n\n(Hint: output is large — use `text <target> --auto` or `text <target> "main"` / `text <target> "main, [role=main], #app .main"` to scope to a specific area)';
  }
  return out;
}
// --- Truthful bounded table observation ---
export function boundedTableRuntimeDiagnostic(exceptionDetails) {
  const raw = String(runtimeExceptionMessage(exceptionDetails));
  let bounded = '';
  for (let index = 0; index < raw.length && bounded.length < 128; index += 1) {
    const unit = raw.charCodeAt(index);
    if (unit >= 0xD800 && unit <= 0xDBFF) {
      const next = raw.charCodeAt(index + 1);
      if (next >= 0xDC00 && next <= 0xDFFF && bounded.length <= 126) {
        bounded += raw[index] + raw[index + 1];
        index += 1;
      } else {
        bounded += '\uFFFD';
      }
    } else if (unit >= 0xDC00 && unit <= 0xDFFF) {
      bounded += '\uFFFD';
    } else {
      bounded += raw[index];
    }
  }
  return canonicalizeTableCells([bounded]);
}
export async function sampleRootFrameTables(cdp, sid, selector) {
  const expression = buildTableSamplerExpression(selector || 'table');
  const frameTree = await cdpDomains(cdp).Page.getFrameTree({}, sid);
  const frameId = frameTree?.frameTree?.frame?.id;
  if (typeof frameId !== 'string' || frameId.length === 0) throw new Error('table: root frame id is unavailable');
  const world = await cdpDomains(cdp).Page.createIsolatedWorld({
    frameId,
    worldName: 'chrome-cdp-ex-table-sampler-v1',
    grantUniveralAccess: false,
  }, sid);
  if (!Number.isSafeInteger(world?.executionContextId) || world.executionContextId < 1) {
    throw new Error('table: isolated execution context is unavailable');
  }
  const evaluated = await cdpDomains(cdp).Runtime.evaluate({
    expression,
    contextId: world.executionContextId,
    returnByValue: true,
    awaitPromise: false,
  }, sid);
  if (evaluated?.exceptionDetails) {
    throw new Error(`table: isolated sampler failed: ${boundedTableRuntimeDiagnostic(evaluated.exceptionDetails)}`);
  }
  if (evaluated?.result?.type !== 'string' || typeof evaluated.result.value !== 'string') {
    throw new Error('table: isolated sampler returned a non-string result');
  }
  return parseTableSamplerResult(evaluated.result.value);
}
export function validAriaIdentity(sample) {
  const headerCount = sample.headerRows.length;
  const rawCount = sample.ariaRowCount;
  if (sample.headerRowsSeen !== headerCount
    || !Number.isSafeInteger(rawCount)
    || rawCount < headerCount
    || rawCount === -1) return null;
  for (let index = 0; index < headerCount; index += 1) {
    if (sample.headerRows[index].rawAriaRowIndex !== index + 1) return null;
  }
  let previous = headerCount;
  for (let index = 0; index < sample.dataRows.length; index += 1) {
    const raw = sample.dataRows[index].rawAriaRowIndex;
    if (!Number.isSafeInteger(raw) || raw <= previous || raw > rawCount) return null;
    previous = raw;
  }
  const logicalRows = rawCount - headerCount;
  const coverageComplete = sample.dataRows.length === logicalRows
    && sample.dataRows.every((row, index) => row.rawAriaRowIndex === headerCount + index + 1);
  return Object.freeze({ headerCount, logicalRows, coverageComplete });
}
export function observedTableEntry(sample, index) {
  const ariaIdentity = validAriaIdentity(sample);
  const accumulator = createTableAccumulator({
    logicalRows: ariaIdentity ? ariaIdentity.logicalRows : null,
    logicalCountSource: ariaIdentity ? 'aria-rowcount' : 'none',
    identitySource: ariaIdentity ? 'aria-rowindex' : 'snapshot-order',
    orderingSource: ariaIdentity ? 'aria-rowindex' : 'dom-order',
  });
  const admitted = [];
  let truncationReason = sample.truncationReason;
  for (let rowIndex = 0; rowIndex < sample.dataRows.length; rowIndex += 1) {
    const row = sample.dataRows[rowIndex];
    try {
      const canonical = canonicalizeTableCells(row.cells);
      if (Buffer.byteLength(canonical, 'utf8') > TABLE_EXTRACTION_LIMITS.maxCanonicalRowBytes
        || Buffer.byteLength(JSON.stringify(row), 'utf8') > 8194) {
        truncationReason = 'row-too-large';
        break;
      }
      admitted.push({
        mountedNodeId: `snapshot-${index + 1}-row-${rowIndex + 1}`,
        key: ariaIdentity ? row.rawAriaRowIndex - ariaIdentity.headerCount : admitted.length + 1,
        cells: row.cells,
      });
    } catch (error) {
      if (/bound|4096|item/i.test(error.message || '')) {
        truncationReason = row.cells.length > 256 ? 'cell-limit' : 'row-too-large';
        break;
      }
      throw error;
    }
  }
  const admission = addTableSampleBatch(accumulator, admitted);
  if (!admission.admitted && !truncationReason) truncationReason = admission.reason;
  const safeComplete = ariaIdentity?.coverageComplete
    && !truncationReason
    && admitted.length === ariaIdentity.logicalRows;
  const result = finalizeTableExtraction(accumulator, {
    termination: safeComplete ? 'logical-count-reached' : 'observation',
  });
  const caption = canonicalizeTableCells([sample.caption || `Table ${index + 1}`]);
  const headers = sample.headerRows.map(row => Object.freeze(
    row.cells.map(cell => canonicalizeTableCells([cell])),
  ));
  return Object.freeze({
    ...result,
    caption,
    headers: Object.freeze(headers),
    snapshot: Object.freeze({
      directRowsSeen: sample.directRowsSeen,
      headerRowsSeen: sample.headerRowsSeen,
      dataRowsSeen: sample.dataRowsSeen,
      rowsAdmitted: admitted.length,
      truncated: Boolean(sample.truncated || truncationReason),
      truncationReason: truncationReason || null,
    }),
  });
}
export function tableObservationModel(sample) {
  return Object.freeze({
    schema: 'chrome-cdp-ex.tables.v1',
    snapshot: Object.freeze({
      tablesSeen: sample.tablesSeen,
      tablesReturned: sample.tables.length,
      truncated: sample.truncated,
      truncationReason: sample.truncationReason,
    }),
    tables: Object.freeze(sample.tables.map(observedTableEntry)),
  });
}
export function orderedTableObservationEnvelope(model) {
  return {
    schema: model.schema,
    snapshot: model.snapshot,
    ...(Object.hasOwn(model, 'targetResolution') ? { targetResolution: model.targetResolution } : {}),
    tables: model.tables,
  };
}
export function trimTrailingTableObservationPreview(model) {
  const table = model.tables[model.tables.length - 1];
  if (table?.inline?.rows?.length > 0) {
    table.inline.rows.pop();
    table.inline.rowCount = table.inline.rows.length;
    table.inline.bytes = Buffer.byteLength(table.inline.rows.join('\n'), 'utf8');
    table.inline.truncated = true;
    return true;
  }
  if (model.tables.length > 0) {
    model.tables.pop();
    model.snapshot.tablesReturned = model.tables.length;
    model.snapshot.truncated = true;
    model.snapshot.truncationReason = 'sample-byte-limit';
    return true;
  }
  return false;
}
export function boundedTableObservationJson(model) {
  const mutable = structuredClone(model);
  let output = formatJson(orderedTableObservationEnvelope(mutable));
  while (Buffer.byteLength(output, 'utf8') > 16384) {
    if (!trimTrailingTableObservationPreview(mutable)) {
      throw new RangeError('table: observation metadata exceeds the JSON response byte ceiling');
    }
    output = formatJson(orderedTableObservationEnvelope(mutable));
  }
  return output;
}
export function boundedTableObservationText(model, target = '<target>') {
  const summary = `Table snapshot: ${model.tables.length} mounted table(s); ${model.snapshot.truncated ? 'truncated' : 'bounded root-frame sample'}`;
  const footer = 'Snapshot provenance: bounded root-frame observation.';
  const sections = [];
  for (let index = 0; index < model.tables.length; index += 1) {
    const table = model.tables[index];
    const metadata = [
      `${table.caption} — ${table.completeness.state}; mounted ${table.mountedRows}; observed ${table.collectedRows}${table.logicalRows === null ? '' : `/${table.logicalRows}`}`,
    ];
    for (let headerIndex = 0; headerIndex < table.headers.length; headerIndex += 1) {
      metadata.push(`${headerIndex === 0 ? 'Header' : `Header ${headerIndex + 1}`}: ${table.headers[headerIndex].join('\t')}`);
    }
    sections.push({ metadata, rows: [...table.inline.rows] });
  }
  const hint = model.tables.some(table => table.completeness.state !== 'complete')
    ? `Mounted snapshot only. For explicit virtual collection: cdp table ${target} --collect --scroll-container <selector>`
    : null;
  let emissionTruncated = false;
  const render = () => [
    summary,
    ...sections.flatMap(section => [...section.metadata, ...section.rows]),
    ...(emissionTruncated ? ['Table preview truncated at complete row boundaries by the 8,192-byte emission limit.'] : []),
    ...(hint ? [hint] : []),
    footer,
  ].join('\n');
  let output = render();
  while (Buffer.byteLength(output, 'utf8') > 8192) {
    const section = sections[sections.length - 1];
    if (!section) throw new RangeError('table: observation summary exceeds the text response byte ceiling');
    if (section.rows.length > 0) section.rows.pop();
    else sections.pop();
    emissionTruncated = true;
    output = render();
  }
  return output;
}
export function boundedTableObservationEmissionJson(result) {
  if (typeof result !== 'string') return result;
  let model;
  try { model = JSON.parse(result); } catch { return result; }
  if (!model || typeof model !== 'object' || Array.isArray(model)
    || model.schema !== 'chrome-cdp-ex.tables.v1'
    || !Array.isArray(model.tables)) return result;
  return boundedTableObservationJson(model);
}
export function boundedTableObservationEmissionText(result) {
  if (typeof result !== 'string' || Buffer.byteLength(result, 'utf8') <= 8192) return result;
  const marker = 'Table preview truncated at complete row boundaries by the 8,192-byte emission limit.';
  const lines = result.split('\n');
  while (lines.length > 1 && Buffer.byteLength([...lines, marker].join('\n'), 'utf8') > 8192) lines.pop();
  if (Buffer.byteLength([...lines, marker].join('\n'), 'utf8') > 8192) {
    return 'Table snapshot unavailable: summary exceeded the 8,192-byte emission limit.';
  }
  return [...lines, marker].join('\n');
}
export async function tableObservationStr(cdp, sid, request) {
  const sample = await sampleRootFrameTables(cdp, sid, request.selector || 'table');
  const model = tableObservationModel(sample);
  return request.format === 'json'
    ? boundedTableObservationJson(model)
    : boundedTableObservationText(model);
}
export function tableCollectorError(message) {
  return new Error(`table: ${message}`);
}
export function buildTableCollectorBootstrapExpression() {
  return String.raw`(() => {
    'use strict';
    const O = Object;
    const A = Array;
    const S = String;
    const N = Number;
    const J = JSON;
    const WM = WeakMap;
    const EventCtor = globalThis.Event;
    const getOwnPropertyDescriptor = O.getOwnPropertyDescriptor;
    const reflectApply = Reflect.apply;
    const nodeProto = Node.prototype;
    const elementProto = Element.prototype;
    const documentProto = Document.prototype;
    const parentNodeGetter = getOwnPropertyDescriptor(nodeProto, 'parentNode').get;
    const firstChildGetter = getOwnPropertyDescriptor(nodeProto, 'firstChild').get;
    const nextSiblingGetter = getOwnPropertyDescriptor(nodeProto, 'nextSibling').get;
    const nodeTypeGetter = getOwnPropertyDescriptor(nodeProto, 'nodeType').get;
    const nodeValueGetter = getOwnPropertyDescriptor(nodeProto, 'nodeValue').get;
    const localNameGetter = getOwnPropertyDescriptor(elementProto, 'localName').get;
    const getAttribute = getOwnPropertyDescriptor(elementProto, 'getAttribute').value;
    const getBoundingClientRect = getOwnPropertyDescriptor(elementProto, 'getBoundingClientRect').value;
    const queryDocument = getOwnPropertyDescriptor(documentProto, 'querySelector').value;
    const queryAllDocument = getOwnPropertyDescriptor(documentProto, 'querySelectorAll').value;
    const elementScrollTo = getOwnPropertyDescriptor(elementProto, 'scrollTo').value;
    const apply = (fn, receiver, args) => reflectApply(fn, receiver, args);
    const nodeIds = new WM();
    let nextId = 1;
    let savedScroll = null;
    const idOf = node => {
      let id = nodeIds.get(node);
      if (id === undefined) {
        id = nextId;
        nextId += 1;
        nodeIds.set(node, id);
      }
      return S(id);
    };
    const query = selector => apply(queryDocument, document, [selector]);
    const queryAll = selector => apply(queryAllDocument, document, [selector]);
    const nameOf = node => apply(localNameGetter, node, []);
    const attr = (node, key) => apply(getAttribute, node, [key]);
    const parseIndex = raw => {
      if (raw === null || raw === '') return null;
      if (raw === '-1') return -1;
      if (raw.length > 1 && raw[0] === '0') return null;
      const value = N(raw);
      if (!N.isSafeInteger(value) || value < 1) return null;
      return value;
    };
    const cellText = root => {
      let value = '';
      let current = apply(firstChildGetter, root, []);
      while (current) {
        const type = apply(nodeTypeGetter, current, []);
        if (type === 3) value += apply(nodeValueGetter, current, []) || '';
        const first = type === 1 ? apply(firstChildGetter, current, []) : null;
        if (first) current = first;
        else {
          let next = null;
          while (current && current !== root) {
            next = apply(nextSiblingGetter, current, []);
            if (next) break;
            current = apply(parentNodeGetter, current, []);
          }
          current = current === root ? null : next;
        }
      }
      return value;
    };
    const rowCells = tr => {
      const cells = [];
      let child = apply(firstChildGetter, tr, []);
      while (child) {
        if (apply(nodeTypeGetter, child, []) === 1) {
          const tag = nameOf(child);
          if (tag === 'th' || tag === 'td') cells[cells.length] = cellText(child);
        }
        child = apply(nextSiblingGetter, child, []);
      }
      return cells;
    };
    const collectRows = (parent, kind) => {
      const rows = [];
      let child = apply(firstChildGetter, parent, []);
      while (child) {
        if (apply(nodeTypeGetter, child, []) === 1 && nameOf(child) === 'tr') {
          rows[rows.length] = {
            kind: kind,
            mountedNodeId: idOf(child),
            rawAriaRowIndex: parseIndex(attr(child, 'aria-rowindex')),
            cells: rowCells(child),
          };
        }
        child = apply(nextSiblingGetter, child, []);
      }
      return rows;
    };
    // Instant, so the sample read right after lands on the final offset even when the
    // container has CSS scroll-behavior: smooth (a raw scrollTop write would animate).
    const scrollContainerTo = (container, top) => apply(elementScrollTo, container, [{ top: top, behavior: 'instant' }]);
    const rememberScroll = container => {
      if (savedScroll) return;
      savedScroll = { container: container, top: container.scrollTop };
    };
    const sampleScroll = container => O.freeze({
      top: container.scrollTop,
      height: container.scrollHeight,
      clientHeight: container.clientHeight,
    });
    const loadMoreState = selector => {
      if (!selector) return O.freeze({ present: false, x: 0, y: 0 });
      const node = query(selector);
      if (!node || apply(parentNodeGetter, node, []) === null) {
        return O.freeze({ present: false, x: 0, y: 0 });
      }
      const rect = apply(getBoundingClientRect, node, []);
      return O.freeze({
        present: true,
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2,
      });
    };
    globalThis.__chromeCdpExTableCollector = {
      sample(tableSelector, scrollSelector, loadMoreSelector) {
        const list = queryAll(tableSelector);
        const matches = [];
        for (let i = 0; i < list.length; i += 1) matches[matches.length] = list[i];
        if (matches.length !== 1 || nameOf(matches[0]) !== 'table') {
          return J.stringify({ ok: false, error: 'collection requires exactly one HTML table' });
        }
        const table = matches[0];
        if (apply(parentNodeGetter, table, []) === null) {
          return J.stringify({ ok: false, error: 'table is detached' });
        }
        const container = query(scrollSelector);
        if (!container) return J.stringify({ ok: false, error: 'scroll-container not found' });
        rememberScroll(container);
        const headerRows = [];
        const dataRows = [];
        let child = apply(firstChildGetter, table, []);
        while (child) {
          if (apply(nodeTypeGetter, child, []) === 1) {
            const tag = nameOf(child);
            if (tag === 'thead') {
              const rows = collectRows(child, 'header');
              for (let index = 0; index < rows.length; index += 1) headerRows[headerRows.length] = rows[index];
            } else if (tag === 'tbody') {
              const rows = collectRows(child, 'data');
              for (let index = 0; index < rows.length; index += 1) dataRows[dataRows.length] = rows[index];
            }
          }
          child = apply(nextSiblingGetter, child, []);
        }
        const scroll = sampleScroll(container);
        return J.stringify({
          ok: true,
          ariaRowCount: parseIndex(attr(table, 'aria-rowcount')),
          headerRows: headerRows,
          dataRows: dataRows,
          scroll: scroll,
          scrollable: scroll.height > scroll.clientHeight,
          loadMore: loadMoreState(loadMoreSelector),
        });
      },
      scrollTo(scrollSelector, top) {
        const container = query(scrollSelector);
        if (!container) return J.stringify({ ok: false, error: 'scroll-container not found' });
        rememberScroll(container);
        scrollContainerTo(container, top);
        if (typeof EventCtor === 'function') {
          const dispatch = container.dispatchEvent;
          if (typeof dispatch === 'function') apply(dispatch, container, [new EventCtor('scroll')]);
        }
        return J.stringify({ ok: true, scroll: sampleScroll(container) });
      },
      restore() {
        if (savedScroll) {
          scrollContainerTo(savedScroll.container, savedScroll.top);
          if (typeof EventCtor === 'function') {
            const dispatch = savedScroll.container.dispatchEvent;
            if (typeof dispatch === 'function') apply(dispatch, savedScroll.container, [new EventCtor('scroll')]);
          }
        }
        return true;
      },
    };
    return true;
  })()`;
}
export function parseCollectorPayload(value, fallback = 'isolated collector failed') {
  if (typeof value !== 'string') throw tableCollectorError(fallback);
  let parsed;
  try { parsed = JSON.parse(value); } catch { throw tableCollectorError(fallback); }
  if (!parsed || parsed.ok !== true) {
    throw tableCollectorError(parsed?.error || fallback);
  }
  return parsed;
}
export function collectorIdentity(request, sample) {
  if (request.rowKeyColumn !== null && request.rowKeyColumn !== undefined) {
    return {
      identitySource: 'row-key-column',
      orderingSource: 'row-key-column',
      logicalRows: null,
      logicalCountSource: 'none',
      headerCount: sample.headerRows.length,
    };
  }
  const headerCount = sample.headerRows.length;
  for (let index = 0; index < headerCount; index += 1) {
    if (sample.headerRows[index].rawAriaRowIndex !== index + 1) {
      throw tableCollectorError('header aria-rowindex coverage is not contiguous from 1');
    }
  }
  const hasAria = sample.dataRows.every(row => Number.isSafeInteger(row.rawAriaRowIndex) && row.rawAriaRowIndex >= 1);
  if (!hasAria) {
    throw tableCollectorError('virtual collection requires aria-rowindex or --row-key-column');
  }
  return {
    identitySource: 'aria-rowindex',
    orderingSource: 'aria-rowindex',
    logicalRows: null,
    logicalCountSource: 'none',
    headerCount,
  };
}
export function nextAriaLogicalRows(sample, headerCount, previousCount) {
  const raw = sample.ariaRowCount;
  if (raw === null || raw === -1) {
    if (previousCount !== undefined && previousCount !== null) {
      throw tableCollectorError('aria-rowcount drifted from a stable integer');
    }
    return null;
  }
  if (!Number.isSafeInteger(raw) || raw < headerCount) {
    throw tableCollectorError('aria-rowcount is not a stable safe integer');
  }
  if (previousCount !== undefined && previousCount !== raw - headerCount) {
    throw tableCollectorError('aria-rowcount drifted from a stable integer');
  }
  return raw - headerCount;
}
export function collectorSamples(sample, identity) {
  return sample.dataRows.map(row => {
    let key;
    if (identity.identitySource === 'row-key-column') {
      key = row.cells[identity.rowKeyColumn];
      if (typeof key !== 'string') throw tableCollectorError('row-key-column is missing from a mounted row');
    } else {
      key = row.rawAriaRowIndex - identity.headerCount;
    }
    return {
      mountedNodeId: row.mountedNodeId,
      key,
      cells: row.cells,
    };
  });
}
export function collectorProgress(before, after, admittedNew) {
  if (admittedNew) return true;
  if (before.scroll.top !== after.scroll.top) return true;
  if (before.scroll.height !== after.scroll.height) return true;
  if (before.loadMore.present && !after.loadMore.present) return true;
  return false;
}
export function boundedCollectJson(model) {
  const mutable = structuredClone(model);
  let output = JSON.stringify(orderedCollectEnvelope(mutable), null, 2);
  while (Buffer.byteLength(output, 'utf8') > TABLE_EXTRACTION_LIMITS.maxResponseBytes) {
    if (!mutable.inline?.rows?.length) {
      throw new RangeError('table: collection metadata exceeds the JSON response byte ceiling');
    }
    mutable.inline.rows.pop();
    mutable.inline.rowCount = mutable.inline.rows.length;
    mutable.inline.bytes = Buffer.byteLength(mutable.inline.rows.join('\n'), 'utf8');
    mutable.inline.truncated = true;
    output = JSON.stringify(orderedCollectEnvelope(mutable), null, 2);
  }
  return output;
}
export function orderedCollectEnvelope(model) {
  return {
    schema: model.schema,
    logicalRows: model.logicalRows,
    logicalCountSource: model.logicalCountSource,
    identitySource: model.identitySource,
    orderingSource: model.orderingSource,
    mountedRows: model.mountedRows,
    collectedRows: model.collectedRows,
    recycledMountedNodes: model.recycledMountedNodes,
    completeness: model.completeness,
    artifact: model.artifact,
    inline: model.inline,
    continuation: model.continuation,
  };
}
export function boundedCollectText(model) {
  const rows = [...(model.inline?.rows || [])];
  const lines = () => [
    `Table collection: ${model.completeness.state}; collected ${model.collectedRows}`
      + (model.logicalRows === null ? '' : `/${model.logicalRows}`),
    ...rows,
    model.continuation?.token ? `Continuation: ${model.continuation.token}` : 'Continuation: none',
  ];
  let output = lines().join('\n');
  while (Buffer.byteLength(output, 'utf8') > 8192 && rows.length > 0) {
    rows.pop();
    output = lines().join('\n');
  }
  return output;
}
export function formatCollectedTable(bundle, publication, continuation, format) {
  const manifest = bundle.manifest;
  const model = {
    schema: 'chrome-cdp-ex.table.v1',
    logicalRows: manifest.logicalRows,
    logicalCountSource: manifest.logicalCountSource,
    identitySource: manifest.identitySource,
    orderingSource: manifest.orderingSource,
    mountedRows: manifest.mountedRows,
    collectedRows: manifest.collectedRows,
    recycledMountedNodes: manifest.recycledMountedNodes,
    completeness: manifest.completeness,
    artifact: {
      id: publication.artifactId,
      rows: publication.artifact.rows,
      bytes: publication.artifact.bytes,
      checksum: publication.artifact.checksum,
      checksumScope: publication.artifact.checksumScope,
    },
    inline: manifest.inline,
    continuation: continuation.continuation,
  };
  return format === 'json' ? boundedCollectJson(model) : boundedCollectText(model);
}
export async function tableCollectionStr(cdp, sid, request, execution, options = {}) {
  const store = options.store;
  const session = options.session || { collector: null };
  if (!store) throw tableCollectorError('artifact store is required for collection');
  if ((options.platform || process.platform) === 'win32') {
    throw tableCollectorError('private table artifacts are unavailable on Windows in v2.16');
  }
  if (session.collector) throw tableCollectorError('collector-busy');
  session.collector = true;
  let worldId = null;
  let restored = false;
  const listeners = [];
  let invalidated = null;
  const invalidate = error => {
    if (!invalidated) invalidated = error;
  };
  const throwIfInvalid = () => {
    if (invalidated) throw invalidated;
  };
  const runPage = async (runtime, operation) => runtime.runCdpOperation(async ({ timeoutMs }) => {
    throwIfInvalid();
    runtime.throwIfAborted();
    const result = await operation(timeoutMs);
    throwIfInvalid();
    runtime.throwIfAborted();
    return result;
  });
  const evaluate = (runtime, expression) => runPage(runtime, timeoutMs => cdpDomains(cdp).Runtime.evaluate({
    expression,
    contextId: worldId,
    objectGroup: TABLE_COLLECTOR_OBJECT_GROUP,
    returnByValue: true,
    awaitPromise: false,
  }, sid, timeoutMs).then(evaluated => {
    if (evaluated?.exceptionDetails) {
      throw tableCollectorError(boundedTableRuntimeDiagnostic(evaluated.exceptionDetails));
    }
    return evaluated?.result?.value;
  }));
  const samplePage = async runtime => parseCollectorPayload(
    await evaluate(
      runtime,
      `__chromeCdpExTableCollector.sample(${JSON.stringify(request.selector || 'table')},`
        + `${JSON.stringify(request.scrollContainer)},${JSON.stringify(request.loadMore || null)})`,
    ),
    'isolated collector sample failed',
  );
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    while (listeners.length) {
      try { listeners.pop()(); } catch {}
    }
    try {
      cdpDomains(cdp).Runtime.releaseObjectGroup({ objectGroup: TABLE_COLLECTOR_OBJECT_GROUP }, sid);
    } catch {}
    session.collector = false;
  };

  let cleaned = false;
  session.collector = true;
  try {
    return await runTableCollectionLifecycle(execution, {
      collect: async runtime => {
        runtime.throwIfAborted();
        if (runtime.remainingPageMs() <= 0) throw new TableCollectionDeadlineError('page');
        const frameTree = await runPage(runtime, timeoutMs => cdpDomains(cdp).Page.getFrameTree({}, sid, timeoutMs));
        const frameId = frameTree?.frameTree?.frame?.id;
        if (typeof frameId !== 'string' || frameId.length === 0) {
          throw tableCollectorError('root frame id is unavailable');
        }
        const world = await runPage(runtime, timeoutMs => cdpDomains(cdp).Page.createIsolatedWorld({
          frameId,
          worldName: TABLE_COLLECTOR_WORLD,
          grantUniveralAccess: false,
        }, sid, timeoutMs));
        worldId = world?.executionContextId;
        if (!Number.isSafeInteger(worldId) || worldId < 1) {
          throw tableCollectorError('isolated execution context is unavailable');
        }
        listeners.push(cdp.onEvent('Runtime.executionContextDestroyed', params => {
          if (params.executionContextId === worldId) {
            invalidate(tableCollectorError('isolated execution context was destroyed'));
          }
        }));
        listeners.push(cdp.onEvent('Page.frameNavigated', params => {
          if (!params?.frame?.parentId) {
            invalidate(tableCollectorError('root frame navigated during collection'));
          }
        }));
        listeners.push(cdp.onEvent('Target.detachedFromTarget', () => {
          invalidate(tableCollectorError('target detached during collection'));
        }));
        await evaluate(runtime, buildTableCollectorBootstrapExpression());
        let sample = await samplePage(runtime);
        const identity = collectorIdentity(request, sample);
        identity.rowKeyColumn = request.rowKeyColumn;
        if (identity.identitySource === 'aria-rowindex') {
          identity.logicalRows = nextAriaLogicalRows(sample, identity.headerCount);
          identity.logicalCountSource = identity.logicalRows === null ? 'none' : 'aria-rowcount';
        }
        const accumulator = createTableAccumulator({
          logicalRows: identity.logicalRows,
          logicalCountSource: identity.logicalCountSource,
          identitySource: identity.identitySource,
          orderingSource: identity.orderingSource,
        });
        const admit = current => {
          const batch = collectorSamples(current, identity);
          const admission = addTableSampleBatch(accumulator, batch);
          if (!admission.admitted) return admission;
          return { admitted: true, added: batch.length, collectedRows: admission.collectedRows };
        };
        let previousCollected = 0;
        let admission = admit(sample);
        if (!admission.admitted) {
          return { accumulator, termination: admission.reason, interactions: 0 };
        }
        previousCollected = admission.collectedRows;
        let interactions = 0;
        let noProgress = 0;
        const complete = () => {
          if (identity.identitySource !== 'aria-rowindex' || identity.logicalRows === null) return false;
          const result = finalizeTableExtraction(accumulator, { termination: 'logical-count-reached' });
          return result.completeness.state === 'complete';
        };
        try {
          while (!complete()) {
            runtime.throwIfAborted();
            throwIfInvalid();
            if (runtime.remainingPageMs() <= 0) {
              return { accumulator, termination: 'time-limit', interactions };
            }
            if (interactions >= TABLE_EXTRACTION_LIMITS.maxInteractions) {
              return { accumulator, termination: 'interaction-limit', interactions };
            }
            if (noProgress >= TABLE_EXTRACTION_LIMITS.maxNoProgressCycles) {
              return { accumulator, termination: 'no-progress-limit', interactions };
            }
            const before = sample;
            const maxTop = Math.max(0, before.scroll.height - before.scroll.clientHeight);
            if (before.loadMore.present && before.scroll.top >= maxTop) {
              await runPage(runtime, async timeoutMs => {
                const base = {
                  x: before.loadMore.x,
                  y: before.loadMore.y,
                  button: 'left',
                  clickCount: 1,
                  modifiers: 0,
                };
                await cdpDomains(cdp).Input.dispatchMouseEvent({ ...base, type: 'mouseMoved' }, sid, timeoutMs);
                await cdpDomains(cdp).Input.dispatchMouseEvent({ ...base, type: 'mousePressed' }, sid, timeoutMs);
                await cdpDomains(cdp).Input.dispatchMouseEvent({ ...base, type: 'mouseReleased' }, sid, timeoutMs);
              });
            } else if (before.scroll.top < maxTop) {
              const nextTop = Math.min(maxTop, before.scroll.top + Math.max(1, before.scroll.clientHeight));
              parseCollectorPayload(await evaluate(
                runtime,
                `__chromeCdpExTableCollector.scrollTo(${JSON.stringify(request.scrollContainer)},${nextTop})`,
              ), 'scroll-container is not scrollable');
            } else if (!before.scrollable && !before.loadMore.present) {
              const needsMore = identity.logicalRows !== null && previousCollected < identity.logicalRows;
              if (needsMore) throw tableCollectorError('scroll-container is not scrollable');
              return {
                accumulator,
                termination: identity.logicalRows === null ? 'no-progress-limit' : 'logical-count-reached',
                interactions,
              };
            } else {
              noProgress += 1;
              sample = await samplePage(runtime);
              continue;
            }
            interactions += 1;
            sample = await samplePage(runtime);
            if (identity.identitySource === 'aria-rowindex') {
              nextAriaLogicalRows(sample, identity.headerCount, identity.logicalRows);
            }
            if (sample.headerRows.length !== identity.headerCount) {
              throw tableCollectorError('header aria-rowindex coverage drifted');
            }
            for (let index = 0; index < identity.headerCount; index += 1) {
              if (sample.headerRows[index]?.rawAriaRowIndex !== index + 1) {
                throw tableCollectorError('header aria-rowindex coverage drifted');
              }
            }
            const collectedBefore = previousCollected;
            admission = admit(sample);
            if (!admission.admitted) {
              return { accumulator, termination: admission.reason, interactions };
            }
            previousCollected = admission.collectedRows;
            if (collectorProgress(before, sample, previousCollected > collectedBefore)) noProgress = 0;
            else noProgress += 1;
          }
        } catch (error) {
          if (error?.code === 'TABLE_COLLECTION_PAGE_DEADLINE') {
            runtime.clearLatePageInvocation();
            return { accumulator, termination: 'time-limit', interactions };
          }
          throw error;
        }
        if (runtime.remainingPageMs() > 0 && worldId !== null && !restored) {
          try {
            await evaluate(runtime, '__chromeCdpExTableCollector.restore()');
            restored = true;
          } catch {}
        }
        return { accumulator, termination: 'logical-count-reached', interactions };
      },
      finalize: async collection => {
        if (!collection?.accumulator) {
          throw collection?.error || new TableCollectionDeadlineError('page');
        }
        const bundle = buildTableExportBundle(collection.accumulator, {
          termination: collection.termination || 'error',
        });
        const publication = await store.publish(bundle, execution);
        const continuation = publication.artifact.rows > 0
          ? await store.readContinuation(publication.token)
          : {
            continuation: {
              token: null,
              offset: 0,
              rowCount: 0,
              rows: [],
              bytes: 0,
              nextToken: null,
            },
          };
        return formatCollectedTable(bundle, publication, continuation, request.format);
      },
      cleanup,
    });
  } finally {
    cleanup();
  }
}
