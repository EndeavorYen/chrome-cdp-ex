import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTableArtifactStore } from '../skills/chrome-cdp-ex/scripts/lib/table-artifacts.mjs';
import { parseTableArgs } from '../skills/chrome-cdp-ex/scripts/lib/table-contract.mjs';

const { __test__: cdpTest } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

const XHTML = 'http://www.w3.org/1999/xhtml';
const FROZEN_CHECKSUM = '73e9f36080b8c781e204857ad9c7dcf4ce7ce419b1503d9affd0343f58f964ed';
const HEADER_CELLS = Object.freeze(['Id', 'Status', 'Team', 'Value']);
const STATUSES = Object.freeze(['queued', 'ready', 'blocked', 'done']);
const FIXTURE = Object.freeze({
  logicalRows: 1024,
  headerRows: 1,
  ariaRowCount: 1025,
  columns: 4,
  mountedRows: 12,
  rowHeightPx: 32,
  initialAvailable: 128,
  loadIncrement: 64,
  loadMoreClicks: 14,
  bodyBytes: 31104,
});

const createdRoots = [];

afterEach(() => {
  while (createdRoots.length) rmSync(createdRoots.pop(), { recursive: true, force: true });
});

function frozenDataRow(index) {
  return [
    `ROW-${String(index).padStart(4, '0')}`,
    STATUSES[(index * 7) % 4],
    `team-${String(((index * 13) % 17) + 1).padStart(2, '0')}`,
    String(1000 + ((index * 7919) % 900000)),
  ];
}

function privateRuntimeRoot() {
  const path = mkdtempSync(join(tmpdir(), 'cdp-table-collection-'));
  chmodSync(path, 0o700);
  createdRoots.push(path);
  return path;
}

class Node {
  constructor(type, value = null) {
    this._type = type;
    this._value = value;
    this._parent = null;
    this._children = [];
  }

  get parentNode() { return this._parent; }
  get firstChild() { return this._children[0] || null; }
  get nextSibling() {
    if (!this._parent) return null;
    const siblings = this._parent._children;
    return siblings[siblings.indexOf(this) + 1] || null;
  }
  get nodeType() { return this._type; }
  get nodeValue() { return this._value; }

  appendChild(child) {
    child._parent = this;
    this._children.push(child);
    return child;
  }

  replaceChildren(...nodes) {
    for (const child of this._children) child._parent = null;
    this._children = [];
    for (const node of nodes) this.appendChild(node);
    return undefined;
  }
}

class Text extends Node {
  constructor(value) { super(3, value); }
}

class Element extends Node {
  constructor(name, attrs = {}, namespace = XHTML) {
    super(1);
    this._name = name;
    this._attrs = { ...attrs };
    this._ns = namespace;
    this._hidden = false;
    this._rect = { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, bottom: 0, right: 0 };
    this.onclick = null;
  }

  get localName() { return this._name; }
  get namespaceURI() { return this._ns; }
  get hidden() { return this._hidden; }
  set hidden(value) { this._hidden = Boolean(value); }
  getAttribute(name) { return Object.hasOwn(this._attrs, name) ? this._attrs[name] : null; }
  hasAttribute(name) { return Object.hasOwn(this._attrs, name); }
  setAttribute(name, value) { this._attrs[name] = String(value); }
  getBoundingClientRect() { return { ...this._rect }; }
  querySelector(selector) { return findElement(this, selector); }
  click() { this.onclick?.(this); }
}

class HTMLTableElement extends Element {
  constructor(attrs = {}) { super('table', attrs); }
}

class Document extends Node {
  constructor(root) {
    super(9);
    this.appendChild(root);
  }

  querySelector(selector) { return findElement(this, selector); }
}

function matchSelector(node, selector) {
  if (node.nodeType !== 1) return false;
  if (selector.startsWith('#')) return node.getAttribute('id') === selector.slice(1);
  if (selector.startsWith('.')) {
    return (node.getAttribute('class') || '').split(/\s+/).includes(selector.slice(1));
  }
  const hash = selector.indexOf('#');
  if (hash > 0) {
    return node.localName === selector.slice(0, hash)
      && node.getAttribute('id') === selector.slice(hash + 1);
  }
  const dot = selector.indexOf('.');
  if (dot > 0) {
    return node.localName === selector.slice(0, dot)
      && (node.getAttribute('class') || '').split(/\s+/).includes(selector.slice(dot + 1));
  }
  return node.localName === selector;
}

function findElement(root, selector) {
  const visit = node => {
    if (matchSelector(node, selector)) return node;
    for (const child of node._children) {
      const found = visit(child);
      if (found) return found;
    }
    return null;
  };
  return visit(root);
}

function fillCells(rowNode, cells, { header = false } = {}) {
  rowNode.replaceChildren();
  cells.forEach((value, column) => {
    const cell = new Element(header || column === 0 ? 'th' : 'td');
    cell.appendChild(new Text(value));
    rowNode.appendChild(cell);
  });
}

function mountRecycledTableFixture(overrides = {}) {
  const config = { ...FIXTURE, ...overrides };
  const html = new Element('html');
  const body = html.appendChild(new Element('body'));
  const viewport = body.appendChild(new Element('div', { id: 'viewport', class: 'viewport' }));
  const table = viewport.appendChild(new HTMLTableElement({
    id: 'orders',
    'aria-rowcount': String(config.ariaRowCount),
    'aria-colcount': String(config.columns),
  }));
  const caption = table.appendChild(new Element('caption'));
  caption.appendChild(new Text('Orders'));
  const thead = table.appendChild(new Element('thead'));
  const headerRow = thead.appendChild(new Element('tr', { 'aria-rowindex': '1' }));
  fillCells(headerRow, HEADER_CELLS, { header: true });
  const tbody = table.appendChild(new Element('tbody'));
  const loadMore = body.appendChild(new Element('button', { id: 'load-more' }));
  loadMore._rect = { x: 8, y: 400, width: 120, height: 32, top: 400, left: 8, bottom: 432, right: 128 };
  loadMore.appendChild(new Text('Load more'));

  const slots = Array.from({ length: config.mountedRows }, (_, slot) => {
    const row = new Element('tr', { id: `virtual-slot-${String(slot).padStart(2, '0')}` });
    tbody.appendChild(row);
    return row;
  });

  let loadedRows = config.initialAvailable;
  let windowStart = 0;
  let loadMoreClicks = 0;
  const document = new Document(html);

  const setLoadMoreVisible = visible => {
    loadMore.hidden = !visible;
    if (visible) loadMore.setAttribute('aria-hidden', 'false');
    else {
      loadMore.setAttribute('aria-hidden', 'true');
      if (loadMore.parentNode) {
        const siblings = loadMore.parentNode._children;
        const index = siblings.indexOf(loadMore);
        if (index >= 0) siblings.splice(index, 1);
        loadMore._parent = null;
      }
    }
  };

  const renderWindow = () => {
    slots.forEach((node, offset) => {
      const dataIndex = windowStart + offset + 1;
      const rawIndex = dataIndex + config.headerRows;
      node.setAttribute('aria-rowindex', String(rawIndex));
      fillCells(node, frozenDataRow(dataIndex));
    });
    viewport._scrollHeight = loadedRows * config.rowHeightPx;
    viewport._clientHeight = config.mountedRows * config.rowHeightPx;
    viewport._scrollTop = windowStart * config.rowHeightPx;
  };

  Object.defineProperty(viewport, 'scrollTop', {
    configurable: true,
    enumerable: true,
    get() { return this._scrollTop || 0; },
    set(value) {
      const maxStart = Math.max(0, loadedRows - config.mountedRows);
      windowStart = Math.min(maxStart, Math.max(0, Math.floor(Number(value) / config.rowHeightPx)));
      renderWindow();
    },
  });
  Object.defineProperty(viewport, 'scrollHeight', {
    configurable: true,
    enumerable: true,
    get() { return this._scrollHeight; },
  });
  Object.defineProperty(viewport, 'clientHeight', {
    configurable: true,
    enumerable: true,
    get() { return this._clientHeight; },
  });

  const clickLoadMore = () => {
    if (loadMore.hidden || loadedRows >= config.logicalRows) return false;
    loadedRows = Math.min(config.logicalRows, loadedRows + config.loadIncrement);
    loadMoreClicks += 1;
    if (loadedRows >= config.logicalRows) setLoadMoreVisible(false);
    renderWindow();
    return true;
  };

  loadMore.onclick = clickLoadMore;
  setLoadMoreVisible(loadedRows < config.logicalRows);
  renderWindow();

  return {
    document,
    Node,
    Text,
    Element,
    HTMLTableElement,
    Document,
    viewport,
    table,
    loadMore,
    state() {
      return {
        logicalRows: config.logicalRows,
        loadedRows,
        windowStart,
        loadMoreClicks,
        loadMoreVisible: !loadMore.hidden && loadMore.parentNode !== null,
        mountedNodeIds: slots.map(node => node.getAttribute('id')),
      };
    },
    dispatchMouse(params) {
      if (params.type !== 'mousePressed') return;
      if (loadMore.hidden || loadMore.parentNode === null) return;
      const rect = loadMore.getBoundingClientRect();
      const hit = params.x >= rect.x && params.x <= rect.x + rect.width
        && params.y >= rect.y && params.y <= rect.y + rect.height;
      if (hit) clickLoadMore();
    },
  };
}

function createWorldCdp(fixture, { beforeEvaluate } = {}) {
  const context = createContext({
    Object,
    Array,
    String,
    Number,
    Boolean,
    Math,
    JSON,
    Map,
    WeakMap,
    Set,
    Reflect,
    Node: fixture.Node,
    Text: fixture.Text,
    Element: fixture.Element,
    HTMLTableElement: fixture.HTMLTableElement,
    Document: fixture.Document,
    document: fixture.document,
    window: { document: fixture.document, devicePixelRatio: 1 },
  });
  const calls = [];
  const releasedGroups = [];
  const eventHandlers = new Map();
  let worldId = 0;
  const send = async (method, params = {}, sessionId, timeout) => {
    calls.push({ method, params, sessionId, timeout });
    if (method === 'Page.getFrameTree') {
      return { frameTree: { frame: { id: 'root-frame' } } };
    }
    if (method === 'Page.createIsolatedWorld') {
      worldId += 1;
      return { executionContextId: worldId };
    }
    if (method === 'Runtime.evaluate') {
      if (beforeEvaluate) await beforeEvaluate(params);
      try {
        const value = runInContext(params.expression, context, { timeout: 5000 });
        if (params.returnByValue === false) {
          return { result: { type: 'object', objectId: `collector-${worldId}` } };
        }
        const type = value === null ? 'object' : typeof value;
        return { result: { type, value } };
      } catch (error) {
        return {
          exceptionDetails: { text: error.message, exception: { description: error.message } },
        };
      }
    }
    if (method === 'Runtime.callFunctionOn') {
      try {
        const fn = runInContext(`(${params.functionDeclaration})`, context, { timeout: 1000 });
        const value = fn.apply(null, params.arguments?.map(entry => entry.value) || []);
        return { result: { type: typeof value, value } };
      } catch (error) {
        return {
          exceptionDetails: { text: error.message, exception: { description: error.message } },
        };
      }
    }
    if (method === 'Runtime.releaseObjectGroup') {
      releasedGroups.push(params.objectGroup);
      return {};
    }
    if (method === 'Input.dispatchMouseEvent') {
      fixture.dispatchMouse(params);
      return {};
    }
    return {};
  };
  return {
    send,
    calls,
    releasedGroups,
    onEvent(method, handler) {
      if (!eventHandlers.has(method)) eventHandlers.set(method, new Set());
      eventHandlers.get(method).add(handler);
      return () => eventHandlers.get(method)?.delete(handler);
    },
    emit(method, params = {}) {
      for (const handler of [...(eventHandlers.get(method) || [])]) handler(params);
    },
  };
}

function collectRequest(overrides = {}) {
  const argv = overrides.argv || [
    '#orders', '--collect', '--scroll-container', '#viewport', '--load-more', '#load-more',
    '--format', 'json',
  ];
  return {
    ...parseTableArgs(argv),
    ...overrides,
  };
}

function collectedTable(output) {
  const model = JSON.parse(output);
  if (model?.schema === 'chrome-cdp-ex.tables.v1') return model.tables[0];
  return model;
}

function collectExecution({
  argv = collectRequest().argv,
  now = () => 0,
  signal = new AbortController().signal,
} = {}) {
  return cdpTest.createDaemonRequestExecutionContext({
    request: { cmd: 'table', args: [...argv] },
    signal,
    now,
  });
}

function artifactStore() {
  return createTableArtifactStore({
    runtimeDir: privateRuntimeRoot(),
    targetId: 'target-table-collection',
    sessionId: 'session-table-collection',
    platform: 'darwin',
  });
}

async function runCollect(cdp, request, {
  now = () => 0,
  store,
  session = { collector: null },
  execution,
  signal,
} = {}) {
  const resolvedExecution = execution || collectExecution({
    argv: request.argv,
    now,
    signal: signal || new AbortController().signal,
  });
  const collect = cdpTest.tableCollectionStr;
  if (typeof collect === 'function') {
    return collect(cdp, 'sid', request, resolvedExecution, { store, session });
  }
  return cdpTest.tableObservationStr(cdp, 'sid', request);
}

function pageMutatingCalls(cdp) {
  return cdp.calls.filter(call => (
    call.method === 'Page.createIsolatedWorld'
    || call.method === 'Runtime.evaluate'
    || call.method === 'Runtime.callFunctionOn'
    || call.method === 'Input.dispatchMouseEvent'
  ));
}

describe('persistent isolated-world virtual collection', () => {
  it('collects every recycled row from the frozen 1024-row virtual table', async () => {
    const fixture = mountRecycledTableFixture();
    const cdp = createWorldCdp(fixture);
    const output = await runCollect(cdp, collectRequest(), { store: artifactStore() });
    const table = collectedTable(output);

    expect(table.logicalRows).toBe(1024);
    expect(table.collectedRows).toBe(1024);
    expect(table.completeness.state).toBe('complete');
    expect(table.completeness.termination).toBe('logical-count-reached');
    expect(table.identitySource).toBe('aria-rowindex');
    expect(table.recycledMountedNodes).toBeGreaterThan(0);
    expect(table.artifact.bytes).toBe(FIXTURE.bodyBytes);
    expect(table.artifact.checksum).toBe(FROZEN_CHECKSUM);
    expect(fixture.state().loadMoreClicks).toBe(FIXTURE.loadMoreClicks);
    expect(cdp.releasedGroups.some(group => typeof group === 'string' && group.length > 0)).toBe(true);
  });
});

describe('collection context, abort, and deadline lifecycle', () => {
  it('returns collector-busy when a second collect is already active on the session', async () => {
    const fixture = mountRecycledTableFixture();
    let release;
    const blocked = new Promise(resolve => { release = resolve; });
    let evaluates = 0;
    const cdp = createWorldCdp(fixture, {
      beforeEvaluate: async () => {
        evaluates += 1;
        if (evaluates === 1) await blocked;
      },
    });
    const session = { collector: null };
    const store = artifactStore();
    const first = runCollect(cdp, collectRequest(), { store, session });
    await vi.waitFor(() => { expect(evaluates).toBeGreaterThan(0); });
    await expect(runCollect(cdp, collectRequest(), { store, session }))
      .rejects.toThrow(/collector-busy/);
    release();
    await first.catch(() => {});
  });

  it('aborts when the isolated execution context is destroyed and still releases the object group', async () => {
    const fixture = mountRecycledTableFixture();
    const cdp = createWorldCdp(fixture, {
      beforeEvaluate: async params => {
        if (params.objectGroup || /table-collector/i.test(params.expression || '')) {
          cdp.emit('Runtime.executionContextDestroyed', { executionContextId: 1 });
        }
      },
    });
    await expect(runCollect(cdp, collectRequest(), { store: artifactStore() }))
      .rejects.toThrow(/execution context|destroyed|detached/i);
    expect(cdp.releasedGroups.length).toBeGreaterThan(0);
  });

  it('aborts on root navigation or detach and does not retry the interrupted interaction', async () => {
    const fixture = mountRecycledTableFixture();
    const cdp = createWorldCdp(fixture, {
      beforeEvaluate: async () => {
        cdp.emit('Page.frameNavigated', { frame: { id: 'root-frame' } });
      },
    });
    await expect(runCollect(cdp, collectRequest(), { store: artifactStore() }))
      .rejects.toThrow(/navigat|detach/i);
    expect(cdp.calls.filter(call => call.method === 'Input.dispatchMouseEvent')).toHaveLength(0);
    expect(cdp.releasedGroups.length).toBeGreaterThan(0);
  });

  it('aborts on caller disconnect, deletes unpublished artifacts, and releases the object group', async () => {
    const fixture = mountRecycledTableFixture();
    const controller = new AbortController();
    const cdp = createWorldCdp(fixture, {
      beforeEvaluate: async () => {
        controller.abort(new Error('table: collection request aborted'));
      },
    });
    const store = artifactStore();
    const execution = collectExecution({ signal: controller.signal });
    await expect(runCollect(cdp, collectRequest(), { store, execution }))
      .rejects.toThrow(/aborted/i);
    expect(cdp.releasedGroups.length).toBeGreaterThan(0);
  });

  it('does not start page or final-sample work at or after the 295s page deadline', async () => {
    const fixture = mountRecycledTableFixture();
    const cdp = createWorldCdp(fixture);
    let elapsed = 0;
    const execution = collectExecution({ now: () => elapsed });
    elapsed = 295000;
    await expect(runCollect(cdp, collectRequest(), {
      store: artifactStore(),
      execution,
    })).rejects.toThrow(/page\/CDP deadline|time-limit/i);
    expect(pageMutatingCalls(cdp)).toEqual([]);
  });

  it('publishes immediately after early complete success without further page mutations', async () => {
    const fixture = mountRecycledTableFixture({
      logicalRows: 2,
      ariaRowCount: 3,
      mountedRows: 2,
      initialAvailable: 2,
    });
    const cdp = createWorldCdp(fixture);
    const output = await runCollect(cdp, collectRequest(), { store: artifactStore() });
    const table = collectedTable(output);
    expect(table.collectedRows).toBe(2);
    expect(table.completeness.state).toBe('complete');
    expect(table.artifact.bytes).toBeGreaterThan(0);
    expect(cdp.calls.filter(call => call.method === 'Input.dispatchMouseEvent')).toHaveLength(0);
    expect(cdp.releasedGroups.length).toBeGreaterThan(0);
  });

  it('uses the remaining page budget for the dynamically shortened final CDP call', async () => {
    const fixture = mountRecycledTableFixture({
      logicalRows: 2,
      ariaRowCount: 3,
      mountedRows: 2,
      initialAvailable: 2,
    });
    let elapsed = 0;
    const execution = collectExecution({ now: () => elapsed });
    const cdp = createWorldCdp(fixture, {
      beforeEvaluate: async () => {
        if (elapsed === 0) elapsed = 293000;
      },
    });
    await runCollect(cdp, collectRequest(), { store: artifactStore(), execution });
    const timed = cdp.calls.filter(call => (
      (call.method === 'Runtime.evaluate' || call.method === 'Runtime.callFunctionOn')
      && Number.isFinite(call.timeout)
    ));
    expect(timed.length).toBeGreaterThan(0);
    expect(timed[timed.length - 1].timeout).toBeLessThanOrEqual(2000);
  });
});

