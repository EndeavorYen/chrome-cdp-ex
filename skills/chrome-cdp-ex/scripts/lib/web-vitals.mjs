// Web vitals evidence for `status --vitals` (#473).
//
// The page side reads entries the browser already buffered through PerformanceObserver
// (`buffered: true`), waits one short window for them to be delivered, then disconnects. It does
// not install anything that outlives the call, so repeated `status --vitals` reads stay side-effect
// free. Aggregation that needs DOM nodes (selectors, text) happens in the page; ratings and
// bounding happen here in Node so they are testable without a browser.

import { redactUrl } from './redaction.mjs';

export const WEB_VITALS_SCHEMA = 'chrome-cdp-ex.vitals.v1';
export const WEB_VITALS_WINDOW_MS = 120;
export const WEB_VITALS_ENTRY_TYPES = Object.freeze([
  'largest-contentful-paint',
  'layout-shift',
  'event',
  'longtask',
  'long-animation-frame',
]);
// Chrome only puts Event Timing entries of at least this duration into the buffer a late
// `buffered: true` observer reads, so faster interactions are invisible to `status --vitals`.
export const EVENT_TIMING_BUFFER_THRESHOLD_MS = 104;

// Google's published "good" / "poor" boundaries.
const THRESHOLDS = Object.freeze({
  lcp: [2500, 4000],
  cls: [0.1, 0.25],
  inp: [200, 500],
});

const SELECTOR_MAX = 120;
const TEXT_MAX = 80;
const URL_MAX = 120;
const TOP_SHIFT_SOURCES = 3;

// Runs inside the page via Function.prototype.toString(). It must only use page globals
// (PerformanceObserver, performance, document, setTimeout) and its own argument.
export function collectWebVitalsInPage(options) {
  const windowMs = Math.max(0, Number(options && options.windowMs) || 0);
  const selectorMax = 120;
  const textMax = 80;
  const urlMax = 120;
  const supported = typeof PerformanceObserver === 'function' && Array.isArray(PerformanceObserver.supportedEntryTypes)
    ? PerformanceObserver.supportedEntryTypes
    : [];
  const clip = (value, max) => {
    const text = String(value == null ? '' : value).slice(0, max * 4).replace(/\s+/g, ' ').trim();
    return text.length > max ? text.slice(0, max - 1) + '…' : text;
  };
  const round = value => (Number.isFinite(value) ? Math.round(value) : null);
  const cleanUrl = value => {
    if (!value) return null;
    const raw = String(value);
    if (/^data:/i.test(raw)) return 'data:…';
    return clip(raw.replace(/[?#].*$/, ''), urlMax);
  };
  const simpleIdent = value => /^[A-Za-z_][\w-]*$/.test(value);
  const doc = globalThis.document;
  const idIsUnique = id => {
    try {
      return !doc || !doc.querySelectorAll || doc.querySelectorAll('#' + id).length === 1;
    } catch {
      return true;
    }
  };
  const selectorFor = node => {
    // A layout-shift source can be a text node; name its element.
    if (node && node.nodeType === 3) node = node.parentElement;
    if (!node || node.nodeType !== 1) return null;
    const parts = [];
    let element = node;
    for (let depth = 0; element && element.nodeType === 1 && depth < 5; depth++) {
      const tag = String(element.localName || element.nodeName || '').toLowerCase() || '*';
      const id = typeof element.id === 'string' ? element.id : '';
      if (id && simpleIdent(id) && idIsUnique(id)) {
        parts.unshift(tag + '#' + id);
        break;
      }
      let part = tag;
      const classes = typeof element.className === 'string'
        ? element.className.trim().split(/\s+/).filter(simpleIdent).slice(0, 2)
        : [];
      if (classes.length) part += '.' + classes.join('.');
      const parent = element.parentElement;
      if (parent && parent.children) {
        const siblings = Array.prototype.filter.call(parent.children, child => child.localName === element.localName);
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(element) + 1) + ')';
      }
      parts.unshift(part);
      if (tag === 'body' || tag === 'html') break;
      element = parent;
    }
    const selector = parts.join(' > ');
    return selector.length > selectorMax ? '…' + selector.slice(selector.length - selectorMax + 1) : selector;
  };
  const textFor = node => {
    if (!node || node.nodeType !== 1) return null;
    const alt = typeof node.getAttribute === 'function' ? node.getAttribute('alt') || node.getAttribute('aria-label') : null;
    const text = clip(alt || node.textContent || '', textMax);
    return text || null;
  };

  const entries = {};
  const status = {};
  // The timeline buffers keep the first N entries of a type and drop the rest. The count of
  // dropped entries only arrives in the observer callback's third argument, not via takeRecords().
  const dropped = {};
  const observers = [];
  for (const type of ['largest-contentful-paint', 'layout-shift', 'event', 'longtask', 'long-animation-frame']) {
    entries[type] = [];
    if (!supported.includes(type)) {
      status[type] = 'unavailable';
      continue;
    }
    try {
      const observer = new PerformanceObserver((list, _observer, callbackOptions) => {
        for (const entry of list.getEntries()) entries[type].push(entry);
        const count = Number(callbackOptions && callbackOptions.droppedEntriesCount);
        if (count > 0) dropped[type] = Math.max(dropped[type] || 0, count);
      });
      const init = { type, buffered: true };
      if (type === 'event') init.durationThreshold = 16;
      observer.observe(init);
      observers.push({ type, observer });
      status[type] = 'ok';
    } catch {
      status[type] = 'unavailable';
    }
  }

  const summarize = () => {
    for (const { type, observer } of observers) {
      try {
        for (const entry of observer.takeRecords()) entries[type].push(entry);
      } catch {}
      try { observer.disconnect(); } catch {}
    }
    // Chrome does not always report a drop count (live: LoAF at its 200 cap said 0), so a buffer
    // holding its full capacity is reported as full with an unknown drop count.
    const capacity = { 'largest-contentful-paint': 150, 'layout-shift': 150, event: 150, longtask: 200, 'long-animation-frame': 200 };
    const withDropped = (summary, type) => (dropped[type] > 0
      ? Object.assign(summary, { dropped: dropped[type] })
      : entries[type].length >= capacity[type] ? Object.assign(summary, { bufferFull: true }) : summary);

    let nav = null;
    let navigationAvailable = false;
    try {
      if (typeof performance !== 'undefined' && performance.getEntriesByType) {
        navigationAvailable = true;
        nav = performance.getEntriesByType('navigation')[0] || null;
      }
    } catch {}
    // Prerendered pages: timings count from activation, not from the prerender start.
    const activation = (nav && Number(nav.activationStart)) || 0;

    let lcp = { status: status['largest-contentful-paint'] };
    if (lcp.status === 'ok') {
      const last = entries['largest-contentful-paint'][entries['largest-contentful-paint'].length - 1];
      lcp = withDropped(last
        ? {
          status: 'ok',
          ms: round(Math.max(0, last.startTime - activation)),
          size: round(last.size),
          selector: selectorFor(last.element),
          text: textFor(last.element),
          url: cleanUrl(last.url),
        }
        : { status: 'none' }, 'largest-contentful-paint');
    }

    let cls = { status: status['layout-shift'] };
    if (cls.status === 'ok') {
      const shifts = entries['layout-shift'].filter(entry => !entry.hadRecentInput);
      // CLS is the largest session window: shifts less than 1 s apart, window at most 5 s long.
      let best = 0;
      let bestShifts = [];
      let current = 0;
      let currentShifts = [];
      let windowStart = 0;
      let previous = -Infinity;
      for (const entry of shifts) {
        if (entry.startTime - previous < 1000 && entry.startTime - windowStart < 5000) {
          current += entry.value;
          currentShifts.push(entry);
        } else {
          current = entry.value;
          currentShifts = [entry];
          windowStart = entry.startTime;
        }
        previous = entry.startTime;
        if (current > best) {
          best = current;
          bestShifts = currentShifts.slice();
        }
      }
      // Sources come from the reported window only. Each element is credited with the score of
      // every shift in that window it took part in.
      const bySelector = new Map();
      for (const entry of bestShifts) {
        for (const source of entry.sources || []) {
          const selector = selectorFor(source.node);
          if (!selector) continue;
          const row = bySelector.get(selector) || { selector, value: 0, shifts: 0 };
          row.value += entry.value;
          row.shifts += 1;
          bySelector.set(selector, row);
        }
      }
      cls = withDropped({
        status: shifts.length ? 'ok' : 'none',
        value: best,
        shifts: shifts.length,
        windowShifts: bestShifts.length,
        sources: Array.from(bySelector.values()).sort((a, b) => b.value - a.value).slice(0, 3),
      }, 'layout-shift');
    }

    let inp = { status: status.event };
    if (inp.status === 'ok') {
      const byInteraction = new Map();
      for (const entry of entries.event) {
        if (!entry.interactionId) continue;
        const prior = byInteraction.get(entry.interactionId);
        if (!prior || entry.duration > prior.duration) byInteraction.set(entry.interactionId, entry);
      }
      const ranked = Array.from(byInteraction.values()).sort((a, b) => b.duration - a.duration);
      const count = typeof performance !== 'undefined' && Number.isFinite(performance.interactionCount)
        ? performance.interactionCount
        : null;
      // Like web-vitals: skip one outlier per 50 interactions of ALL interactions on the page.
      // Only slow (buffered) interactions are visible here, so when the pick falls past them the
      // estimate is "below the buffer threshold".
      const index = Math.floor(Math.max(count == null ? 0 : count, ranked.length) / 50);
      const pick = ranked[index];
      inp = withDropped(pick
        ? {
          status: 'ok',
          ms: round(pick.duration),
          type: clip(pick.name, 40),
          selector: selectorFor(pick.target),
          slowInteractions: ranked.length,
          interactionCount: count,
        }
        : ranked.length
          ? { status: 'ok', ms: null, belowThreshold: true, slowInteractions: ranked.length, interactionCount: count }
          : { status: 'none', slowInteractions: 0, interactionCount: count }, 'event');
    }

    const longSummary = (type, extra) => {
      if (status[type] !== 'ok') return { status: status[type] };
      const list = entries[type];
      if (!list.length) return withDropped({ status: 'none', count: 0 }, type);
      let total = 0;
      let worst = list[0];
      for (const entry of list) {
        total += entry.duration;
        if (entry.duration > worst.duration) worst = entry;
      }
      return withDropped(Object.assign(
        { status: 'ok', count: list.length, totalMs: round(total), worstMs: round(worst.duration) },
        extra ? extra(worst, list) : {},
      ), type);
    };
    const longTasks = longSummary('longtask');
    const longAnimationFrames = longSummary('long-animation-frame', (worst, list) => {
      const scripts = Array.isArray(worst.scripts) ? worst.scripts.slice() : [];
      scripts.sort((a, b) => b.duration - a.duration);
      const script = scripts[0];
      let maxBlocking = null;
      for (const entry of list) {
        if (Number.isFinite(entry.blockingDuration) && (maxBlocking == null || entry.blockingDuration > maxBlocking)) {
          maxBlocking = entry.blockingDuration;
        }
      }
      return {
        maxBlockingMs: round(maxBlocking),
        worstScript: script
          ? {
            // A classic-script invoker is the script's src URL, query string included.
            invoker: (/^(?:[a-z][\w+.-]*:\/\/|data:|blob:)/i.test(String(script.invoker || '')) ? cleanUrl(script.invoker) : clip(script.invoker, 80)) || null,
            source: cleanUrl(script.sourceURL),
            ms: round(script.duration),
          }
          : null,
      };
    });

    let navigation = { status: navigationAvailable ? 'none' : 'unavailable' };
    if (nav) {
      const at = value => (Number(value) > 0 ? round(Math.max(0, value - activation)) : null);
      navigation = {
        status: 'ok',
        type: clip(nav.type, 20) || null,
        ttfbMs: at(nav.responseStart),
        domContentLoadedMs: at(nav.domContentLoadedEventEnd),
        loadMs: at(nav.loadEventEnd),
      };
    }

    return { windowMs, lcp, cls, inp, longTasks, longAnimationFrames, navigation };
  };

  return new Promise(resolve => {
    setTimeout(() => {
      try {
        resolve(summarize());
      } catch (error) {
        resolve({ error: clip(error && error.message, 200) || 'vitals collection failed' });
      }
    }, windowMs);
  });
}

export function webVitalsPageScript({ windowMs = WEB_VITALS_WINDOW_MS } = {}) {
  return `(${collectWebVitalsInPage.toString()})(${JSON.stringify({ windowMs })})`;
}

function finite(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function bounded(value, max) {
  if (value == null) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function boundedTail(value, max) {
  const text = bounded(value, Number.MAX_SAFE_INTEGER);
  if (!text) return null;
  return text.length > max ? `…${text.slice(text.length - max + 1)}` : text;
}

// URLs (and classic-script invokers, which are URLs) lose their query and fragment, then go through
// the shared URL redactor for userinfo and sensitive path parameters such as `;jsessionid=`.
function boundedUrl(value, max) {
  const text = bounded(value, Number.MAX_SAFE_INTEGER);
  if (!text) return null;
  if (/^data:/i.test(text)) return 'data:…';
  if (!/^(?:[a-z][\w+.-]*:\/\/|blob:)/i.test(text)) return bounded(text, max);
  return bounded(redactUrl(text.replace(/[?#].*$/, '')), max);
}

function metricStatus(value) {
  return value === 'ok' || value === 'none' ? value : 'unavailable';
}

function rate(metric, value) {
  if (value == null) return null;
  const [good, poor] = THRESHOLDS[metric];
  return value <= good ? 'good' : value <= poor ? 'needs-improvement' : 'poor';
}

// The browser's timeline buffer keeps the first N entries of a type. `dropped` is the count the
// browser reported, or null when the buffer is at capacity but no count was reported.
function droppedField(raw) {
  const dropped = finite(raw?.dropped);
  if (dropped > 0) return { bufferFull: true, dropped };
  return raw?.bufferFull === true ? { bufferFull: true, dropped: null } : {};
}

function countSummary(raw = {}) {
  const status = metricStatus(raw.status);
  if (status === 'unavailable') return { status };
  if (status === 'none') return { status, count: 0, ...droppedField(raw) };
  return {
    status,
    count: finite(raw.count),
    totalMs: finite(raw.totalMs),
    worstMs: finite(raw.worstMs),
    ...droppedField(raw),
  };
}

function unavailableMetrics() {
  return {
    lcp: { status: 'unavailable' },
    cls: { status: 'unavailable' },
    inp: { status: 'unavailable' },
    longTasks: { status: 'unavailable' },
    longAnimationFrames: { status: 'unavailable' },
    navigation: { status: 'unavailable' },
  };
}

export function buildWebVitalsUnavailable(reason) {
  return {
    schema: WEB_VITALS_SCHEMA,
    windowMs: WEB_VITALS_WINDOW_MS,
    error: bounded(reason, 200) || 'unavailable',
    ...unavailableMetrics(),
  };
}

function buildInp(inpRaw) {
  const status = metricStatus(inpRaw.status);
  if (status === 'unavailable') return { status };
  const common = {
    slowInteractions: finite(inpRaw.slowInteractions) ?? 0,
    interactionCount: finite(inpRaw.interactionCount),
    bufferThresholdMs: EVENT_TIMING_BUFFER_THRESHOLD_MS,
    ...droppedField(inpRaw),
  };
  if (status === 'none') return { status, ...common };
  if (inpRaw.belowThreshold === true || finite(inpRaw.belowMs) != null) {
    // The percentile pick is an interaction faster than the buffer threshold: INP is below it.
    // With a full event buffer, later slow interactions were dropped, so the pick may really be
    // slower: no rating then.
    return {
      status, ms: null, belowMs: EVENT_TIMING_BUFFER_THRESHOLD_MS, rating: common.bufferFull ? null : 'good', ...common,
    };
  }
  const inpMs = finite(inpRaw.ms);
  return {
    status,
    ms: inpMs,
    rating: rate('inp', inpMs),
    type: bounded(inpRaw.type, 40),
    selector: boundedTail(inpRaw.selector, SELECTOR_MAX),
    ...common,
  };
}

// Normalizes the page result into the bounded, versioned chrome-cdp-ex.vitals.v1 model.
export function buildWebVitalsModel(raw) {
  if (!raw || typeof raw !== 'object') return buildWebVitalsUnavailable('page returned no vitals result');
  if (raw.error) return buildWebVitalsUnavailable(raw.error);

  const lcpRaw = raw.lcp || {};
  const lcpStatus = metricStatus(lcpRaw.status);
  const lcpMs = finite(lcpRaw.ms);
  const lcp = lcpStatus === 'ok'
    ? {
      status: lcpStatus,
      ms: lcpMs,
      rating: rate('lcp', lcpMs),
      selector: boundedTail(lcpRaw.selector, SELECTOR_MAX),
      text: bounded(lcpRaw.text, TEXT_MAX),
      url: boundedUrl(lcpRaw.url, URL_MAX),
      size: finite(lcpRaw.size),
      ...droppedField(lcpRaw),
    }
    : lcpStatus === 'none' ? { status: lcpStatus, ...droppedField(lcpRaw) } : { status: lcpStatus };

  const clsRaw = raw.cls || {};
  const clsStatus = metricStatus(clsRaw.status);
  const clsValue = finite(clsRaw.value);
  const cls = clsStatus === 'unavailable'
    ? { status: clsStatus }
    : {
      status: clsStatus,
      value: clsValue == null ? 0 : Math.round(clsValue * 10000) / 10000,
      rating: rate('cls', clsValue == null ? 0 : clsValue),
      shifts: finite(clsRaw.shifts) ?? 0,
      windowShifts: finite(clsRaw.windowShifts) ?? 0,
      sources: (Array.isArray(clsRaw.sources) ? clsRaw.sources : [])
        .slice(0, TOP_SHIFT_SOURCES)
        .map(source => ({
          selector: boundedTail(source?.selector, SELECTOR_MAX),
          value: Math.round((finite(source?.value) ?? 0) * 10000) / 10000,
          shifts: finite(source?.shifts) ?? 0,
        }))
        .filter(source => source.selector),
      ...droppedField(clsRaw),
    };

  const loafRaw = raw.longAnimationFrames || {};
  const longAnimationFrames = countSummary(loafRaw);
  if (longAnimationFrames.status === 'ok') {
    longAnimationFrames.maxBlockingMs = finite(loafRaw.maxBlockingMs);
    const script = loafRaw.worstScript;
    longAnimationFrames.worstScript = script && typeof script === 'object'
      ? {
        invoker: boundedUrl(script.invoker, 80),
        source: boundedUrl(script.source, URL_MAX),
        ms: finite(script.ms),
      }
      : null;
  }

  const navRaw = raw.navigation || {};
  const navStatus = metricStatus(navRaw.status);
  const navigation = navStatus === 'ok'
    ? {
      status: navStatus,
      type: bounded(navRaw.type, 20),
      ttfbMs: finite(navRaw.ttfbMs),
      domContentLoadedMs: finite(navRaw.domContentLoadedMs),
      loadMs: finite(navRaw.loadMs),
    }
    : { status: navStatus };

  return {
    schema: WEB_VITALS_SCHEMA,
    windowMs: finite(raw.windowMs) ?? WEB_VITALS_WINDOW_MS,
    lcp,
    cls,
    inp: buildInp(raw.inp || {}),
    longTasks: countSummary(raw.longTasks),
    longAnimationFrames,
    navigation,
  };
}

function short(value, max) {
  if (!value) return '';
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

// Selectors keep their most specific (rightmost) part when cut.
function tail(value, max) {
  if (!value) return '';
  return value.length > max ? `…${value.slice(value.length - max + 1)}` : value;
}

function ms(value) {
  return value == null ? '?' : `${value} ms`;
}

function rated(rating) {
  return rating ? ` (${rating})` : '';
}

function countLine(label, summary, extra = '') {
  if (summary.status === 'unavailable') return `  ${label}: unavailable`;
  if (summary.status === 'none') return `  ${label}: none`;
  return `  ${label}: ${summary.count}, total ${ms(summary.totalMs)}, worst ${ms(summary.worstMs)}${extra}`;
}

// Text stays under about 600 characters: selectors, text, and invokers are cut short here and CLS
// shows its top 2 sources; the JSON model keeps the longer bounded values and 3 sources.
export function formatWebVitalsText(model) {
  const lines = [`Web vitals (buffered entries, ${model.windowMs} ms):`];
  if (model.error) {
    lines.push(`  unavailable (${short(model.error, 120)})`);
    return lines.join('\n');
  }
  const { lcp, cls, inp, longTasks, longAnimationFrames, navigation } = model;

  if (lcp.status === 'ok') {
    const where = lcp.selector ? ` ${tail(lcp.selector, 28)}` : lcp.url ? ` ${tail(lcp.url, 28)}` : '';
    const text = lcp.text ? ` "${short(lcp.text, 20)}"` : '';
    lines.push(`  LCP: ${ms(lcp.ms)}${rated(lcp.rating)}${where}${text}`);
  } else {
    lines.push(`  LCP: ${lcp.status}`);
  }

  if (cls.status === 'unavailable') {
    lines.push('  CLS: unavailable');
  } else {
    const top = cls.sources.length
      ? `; top ${cls.sources.slice(0, 2).map(source => `${tail(source.selector, 18)} ${source.value}`).join(', ')}`
      : '';
    lines.push(`  CLS: ${cls.value}${rated(cls.rating)}, ${cls.shifts} shift${cls.shifts === 1 ? '' : 's'}${top}`);
  }

  const of = inp.interactionCount == null ? '' : ` of ${inp.interactionCount}`;
  if (inp.status === 'ok' && inp.ms == null && inp.belowMs != null) {
    lines.push(`  INP (slow only): < ${inp.belowMs} ms${rated(inp.rating)}, ${inp.slowInteractions} slow${of}`);
  } else if (inp.status === 'ok') {
    const target = inp.selector ? ` on ${tail(inp.selector, 20)}` : '';
    lines.push(`  INP (slow only): ${ms(inp.ms)}${rated(inp.rating)} ${short(inp.type, 12) || 'event'}${target}, ${inp.slowInteractions} slow${of}`);
  } else if (inp.status === 'none') {
    lines.push(`  INP (slow only): none >= ${inp.bufferThresholdMs} ms${of ? `, ${inp.interactionCount} interactions` : ''}`);
  } else {
    lines.push('  INP: unavailable');
  }

  lines.push(countLine('Long tasks', longTasks));
  const invoker = longAnimationFrames.worstScript?.invoker;
  lines.push(countLine('LoAF', longAnimationFrames, invoker ? ` (${short(invoker, 16)})` : ''));

  if (navigation.status === 'ok') {
    lines.push(`  Navigation: TTFB ${ms(navigation.ttfbMs)}, DCL ${ms(navigation.domContentLoadedMs)}, load ${ms(navigation.loadMs)}`);
  } else {
    lines.push(`  Navigation: ${navigation.status}`);
  }

  const dropped = [
    ['LCP', lcp], ['CLS', cls], ['INP', inp], ['long tasks', longTasks], ['LoAF', longAnimationFrames],
  ].filter(([, summary]) => summary.bufferFull).map(([label, summary]) => `${label} ${summary.dropped ?? '?'}`);
  if (dropped.length) lines.push(`  Buffer full, dropped: ${dropped.join(', ')}`);
  return lines.join('\n');
}
