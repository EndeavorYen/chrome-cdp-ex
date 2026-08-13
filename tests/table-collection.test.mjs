import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { executeCdpCli } from '../skills/chrome-cdp-ex/scripts/cdp.mjs';
import { createTableArtifactStore } from '../skills/chrome-cdp-ex/scripts/lib/table-artifacts.mjs';
import { parseTableArgs } from '../skills/chrome-cdp-ex/scripts/lib/table-contract.mjs';
import { createMcpRequestHandler } from '../skills/chrome-cdp-ex/scripts/mcp-server.mjs';
import { createRuntimeClient } from '../skills/chrome-cdp-ex/scripts/lib/runtime-client.mjs';

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
  querySelectorAll(selector) { return findAllElements(this, selector); }
  dispatchEvent(event) {
    if (event?.type === 'scroll' && typeof this._onScroll === 'function') this._onScroll();
    return true;
  }
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
  querySelectorAll(selector) { return findAllElements(this, selector); }
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

function findAllElements(root, selector) {
  const matches = [];
  const visit = node => {
    if (node !== root && matchSelector(node, selector)) matches.push(node);
    for (const child of node._children) visit(child);
  };
  visit(root);
  return matches;
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
  const staticBox = body.appendChild(new Element('div', { id: 'static' }));
  staticBox._scrollHeight = 32;
  staticBox._clientHeight = 32;
  staticBox._scrollTop = 0;
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
      const rawIndex = config.duplicateAria && offset > 0
        ? windowStart + 1 + config.headerRows
        : dataIndex + config.headerRows;
      if (config.omitAria) node._attrs = { ...node._attrs };
      else node.setAttribute('aria-rowindex', String(rawIndex));
      if (config.omitAria) delete node._attrs['aria-rowindex'];
      const cells = config.hugeRow && offset === 0
        ? [frozenDataRow(dataIndex)[0], 'x'.repeat(4097), ...frozenDataRow(dataIndex).slice(2)]
        : config.conflictOnRecycle && windowStart > 0
          ? frozenDataRow(dataIndex).map((cell, index) => (index === 1 ? `mutated-${cell}` : cell))
          : frozenDataRow(dataIndex);
      fillCells(node, cells);
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
      if (config.stallWindow) {
        this._scrollTop = Math.max(0, Number(value));
        return;
      }
      if (config.stallScroll) return;
      this._scrollTop = Math.max(0, Number(value));
      if (config.syncOnScrollEvent) return;
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
    if (loadMore.hidden || (!config.endlessLoadMore && loadedRows >= config.logicalRows)) return false;
    loadedRows = config.endlessLoadMore
      ? loadedRows + 1
      : Math.min(config.logicalRows, loadedRows + config.loadIncrement);
    loadMoreClicks += 1;
    if (!config.endlessLoadMore && loadedRows >= config.logicalRows) setLoadMoreVisible(false);
    renderWindow();
    return true;
  };

  loadMore.onclick = clickLoadMore;
  if (config.syncOnScrollEvent) {
    viewport._onScroll = () => {
      const maxStart = Math.max(0, loadedRows - config.mountedRows);
      windowStart = Math.min(maxStart, Math.max(0, Math.floor((viewport._scrollTop || 0) / config.rowHeightPx)));
      renderWindow();
    };
  }
  setLoadMoreVisible(!config.noLoadMore && loadedRows < config.logicalRows);
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
    poisonMountedRows() {
      slots.forEach((node, offset) => {
        const dataIndex = windowStart + offset + 1;
        fillCells(node, frozenDataRow(dataIndex).map((cell, index) => (
          index === 1 ? `conflict-${cell}` : cell
        )));
      });
    },
    detachTable() {
      const parent = table.parentNode;
      if (!parent) return;
      const siblings = parent._children;
      const index = siblings.indexOf(table);
      if (index >= 0) siblings.splice(index, 1);
      table._parent = null;
    },
    appendExtraTable() {
      const extra = new HTMLTableElement({ id: 'other' });
      body.appendChild(extra);
      return extra;
    },
    growThead() {
      const extra = thead.appendChild(new Element('tr', {
        'aria-rowindex': String(config.headerRows + 1),
      }));
      fillCells(extra, HEADER_CELLS, { header: true });
      return extra;
    },
    shrinkThead() {
      const first = thead.firstChild;
      if (!first) return;
      const siblings = thead._children;
      const index = siblings.indexOf(first);
      if (index >= 0) siblings.splice(index, 1);
      first._parent = null;
    },
    reappearLoadMore() {
      if (loadMore.parentNode) return;
      body.appendChild(loadMore);
      setLoadMoreVisible(true);
    },
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
    Event: class Event {
      constructor(type) { this.type = type; }
    },
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

  it('collects when the page virtualizer updates on scroll events rather than the scrollTop setter', async () => {
    const fixture = mountRecycledTableFixture({ syncOnScrollEvent: true });
    const output = await runCollect(createWorldCdp(fixture), collectRequest(), { store: artifactStore() });
    const table = collectedTable(output);
    expect(table.collectedRows).toBe(1024);
    expect(table.completeness.state).toBe('complete');
    expect(table.artifact.checksum).toBe(FROZEN_CHECKSUM);
    expect(fixture.state().loadMoreClicks).toBe(FIXTURE.loadMoreClicks);
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

  it('publishes already-collected rows as incomplete time-limit when the page deadline hits mid-interaction', async () => {
    const fixture = mountRecycledTableFixture({
      logicalRows: 8,
      ariaRowCount: 9,
      mountedRows: 2,
      initialAvailable: 8,
    });
    let elapsed = 0;
    let evaluates = 0;
    const execution = collectExecution({ now: () => elapsed });
    const cdp = createWorldCdp(fixture, {
      beforeEvaluate: async () => {
        evaluates += 1;
        if (evaluates >= 3) elapsed = 295000;
      },
    });
    const output = await runCollect(cdp, collectRequest(), {
      store: artifactStore(),
      execution,
    });
    const table = collectedTable(output);
    expect(table.collectedRows).toBe(2);
    expect(table.completeness.state).toBe('incomplete');
    expect(table.completeness.termination).toBe('time-limit');
  });
});

describe('adversarial virtual collection', () => {
  it('fails a duplicate mounted aria-rowindex inside one sample', async () => {
    const fixture = mountRecycledTableFixture({
      logicalRows: 2,
      ariaRowCount: 3,
      mountedRows: 2,
      initialAvailable: 2,
      duplicateAria: true,
    });
    await expect(runCollect(createWorldCdp(fixture), collectRequest(), { store: artifactStore() }))
      .rejects.toThrow(/duplicate/i);
  });

  it('fails a recycled-row conflict when the same key later has different bytes', async () => {
    const fixture = mountRecycledTableFixture({
      logicalRows: 4,
      ariaRowCount: 5,
      mountedRows: 2,
      initialAvailable: 4,
      stallScroll: true,
    });
    let evaluates = 0;
    const cdp = createWorldCdp(fixture, {
      beforeEvaluate: async () => {
        evaluates += 1;
        if (evaluates === 3) fixture.poisonMountedRows();
      },
    });
    await expect(runCollect(cdp, collectRequest(), { store: artifactStore() }))
      .rejects.toThrow(/conflict/i);
  });

  it('rejects snapshot-order collection before the first interaction', async () => {
    const fixture = mountRecycledTableFixture({
      logicalRows: 2,
      ariaRowCount: 3,
      mountedRows: 2,
      initialAvailable: 2,
      omitAria: true,
    });
    const cdp = createWorldCdp(fixture);
    await expect(runCollect(cdp, collectRequest(), { store: artifactStore() }))
      .rejects.toThrow(/aria-rowindex or --row-key-column/i);
    expect(cdp.calls.filter(call => call.method === 'Input.dispatchMouseEvent')).toHaveLength(0);
  });

  it('cannot certify complete in row-key mode even when every row was collected', async () => {
    const fixture = mountRecycledTableFixture({
      logicalRows: 2,
      ariaRowCount: 3,
      mountedRows: 2,
      initialAvailable: 2,
    });
    const output = await runCollect(createWorldCdp(fixture), collectRequest({
      argv: [
        '#orders', '--collect', '--scroll-container', '#viewport',
        '--row-key-column', '0', '--format', 'json',
      ],
    }), { store: artifactStore() });
    const table = collectedTable(output);
    expect(table.collectedRows).toBe(2);
    expect(table.identitySource).toBe('row-key-column');
    expect(table.completeness.state).toBe('unknown');
  });

  it('fails closed for a missing or non-scrollable container and a detached table', async () => {
    const missing = mountRecycledTableFixture({ logicalRows: 2, ariaRowCount: 3, mountedRows: 2, initialAvailable: 2 });
    await expect(runCollect(createWorldCdp(missing), collectRequest({
      argv: ['#orders', '--collect', '--scroll-container', '#missing', '--format', 'json'],
    }), { store: artifactStore() })).rejects.toThrow(/scroll-container not found/i);

    const frozen = mountRecycledTableFixture({
      logicalRows: 4, ariaRowCount: 5, mountedRows: 2, initialAvailable: 2, noLoadMore: true,
    });
    await expect(runCollect(createWorldCdp(frozen), collectRequest({
      argv: ['#orders', '--collect', '--scroll-container', '#static', '--format', 'json'],
    }), { store: artifactStore() })).rejects.toThrow(/not scrollable/i);

    const detaching = mountRecycledTableFixture({ logicalRows: 4, ariaRowCount: 5, mountedRows: 2, initialAvailable: 4 });
    let evaluates = 0;
    const cdp = createWorldCdp(detaching, {
      beforeEvaluate: async () => {
        evaluates += 1;
        if (evaluates === 3) detaching.detachTable();
      },
    });
    await expect(runCollect(cdp, collectRequest(), { store: artifactStore() }))
      .rejects.toThrow(/detach|exactly one HTML table/i);
  });

  it('fails when more than one HTML table matches, including the default table selector', async () => {
    const fixture = mountRecycledTableFixture({
      logicalRows: 2,
      ariaRowCount: 3,
      mountedRows: 2,
      initialAvailable: 2,
    });
    fixture.appendExtraTable();
    await expect(runCollect(createWorldCdp(fixture), collectRequest({
      argv: ['--collect', '--scroll-container', '#viewport', '--format', 'json'],
    }), { store: artifactStore() })).rejects.toThrow(/exactly one HTML table/);
  });

  it('fails when a later sample grows or shrinks certified thead membership', async () => {
    const grow = mountRecycledTableFixture({
      logicalRows: 4,
      ariaRowCount: 5,
      mountedRows: 2,
      initialAvailable: 4,
    });
    let growEvaluates = 0;
    const growCdp = createWorldCdp(grow, {
      beforeEvaluate: async () => {
        growEvaluates += 1;
        if (growEvaluates === 3) grow.growThead();
      },
    });
    await expect(runCollect(growCdp, collectRequest(), { store: artifactStore() }))
      .rejects.toThrow(/header aria-rowindex coverage drifted/);

    const shrink = mountRecycledTableFixture({
      logicalRows: 4,
      ariaRowCount: 5,
      mountedRows: 2,
      initialAvailable: 4,
    });
    let shrinkEvaluates = 0;
    const shrinkCdp = createWorldCdp(shrink, {
      beforeEvaluate: async () => {
        shrinkEvaluates += 1;
        if (shrinkEvaluates === 3) shrink.shrinkThead();
      },
    });
    await expect(runCollect(shrinkCdp, collectRequest(), { store: artifactStore() }))
      .rejects.toThrow(/header aria-rowindex coverage drifted/);
  });

  it('stops at row-too-large, no-progress, interaction, and thrown CDP operations', async () => {
    const huge = mountRecycledTableFixture({
      logicalRows: 2,
      ariaRowCount: 3,
      mountedRows: 2,
      initialAvailable: 2,
      hugeRow: true,
    });
    const hugeResult = collectedTable(await runCollect(
      createWorldCdp(huge),
      collectRequest(),
      { store: artifactStore() },
    ));
    expect(hugeResult.completeness.termination).toBe('row-too-large');

    const stalled = mountRecycledTableFixture({
      logicalRows: 8,
      ariaRowCount: 9,
      mountedRows: 2,
      initialAvailable: 8,
      stallScroll: true,
    });
    const stalledResult = collectedTable(await runCollect(
      createWorldCdp(stalled),
      collectRequest(),
      { store: artifactStore() },
    ));
    expect(stalledResult.completeness.termination).toBe('no-progress-limit');

    const endless = mountRecycledTableFixture({
      logicalRows: 100,
      ariaRowCount: 101,
      mountedRows: 12,
      initialAvailable: 12,
      endlessLoadMore: true,
      stallWindow: true,
    });
    const endlessResult = collectedTable(await runCollect(
      createWorldCdp(endless),
      collectRequest(),
      { store: artifactStore() },
    ));
    expect(endlessResult.completeness.termination).toBe('interaction-limit');

    const throwing = mountRecycledTableFixture({
      logicalRows: 2, ariaRowCount: 3, mountedRows: 2, initialAvailable: 2,
    });
    const cdp = createWorldCdp(throwing, {
      beforeEvaluate: async () => { throw new Error('cdp evaluate exploded'); },
    });
    await expect(runCollect(cdp, collectRequest(), { store: artifactStore() }))
      .rejects.toThrow(/exploded/i);
    expect(cdp.releasedGroups.length).toBeGreaterThan(0);
  });
});

describe('collection command semantics', () => {
  it('fails closed on Windows before any page mutation', async () => {
    const fixture = mountRecycledTableFixture({
      logicalRows: 2, ariaRowCount: 3, mountedRows: 2, initialAvailable: 2,
    });
    const cdp = createWorldCdp(fixture);
    await expect(cdpTest.tableCollectionStr(
      cdp,
      'sid',
      collectRequest(),
      collectExecution(),
      { store: artifactStore(), platform: 'win32' },
    )).rejects.toThrow(/unavailable on Windows/i);
    expect(pageMutatingCalls(cdp)).toEqual([]);
  });

  it('keeps continuation on the private store without creating an isolated world', async () => {
    const fixture = mountRecycledTableFixture({
      logicalRows: 2, ariaRowCount: 3, mountedRows: 2, initialAvailable: 2,
    });
    const store = artifactStore();
    const collected = await runCollect(createWorldCdp(fixture), collectRequest(), { store });
    const token = collectedTable(collected).continuation.token;
    const continued = JSON.stringify(await store.readContinuation(token), null, 2);
    expect(JSON.parse(continued).continuation.token).toBe(token);
    expect(continued).toContain('ROW-0001');
  });

  it('preserves collect JSON through CLI capture and confirmed MCP run_command', async () => {
    const fixture = mountRecycledTableFixture({
      logicalRows: 2, ariaRowCount: 3, mountedRows: 2, initialAvailable: 2,
    });
    const output = await runCollect(createWorldCdp(fixture), collectRequest(), { store: artifactStore() });
    expect(JSON.parse(output).schema).toBe('chrome-cdp-ex.table.v1');
    expect(Buffer.byteLength(output, 'utf8')).toBeLessThanOrEqual(16_384);

    const targetResolution = {
      requestedTargetPrefix: 'ABC12345',
      requestedTargetId: 'ABC12345ABC12345ABC12345ABC12345',
      boundTargetId: 'ABC12345ABC12345ABC12345ABC12345',
      resolvedTargetId: 'ABC12345ABC12345ABC12345ABC12345',
      resolutionSource: 'live-discovery',
      status: 'reused',
      rebound: false,
    };
    const direct = await executeCdpCli([
      'table', 'ABC12345', '#orders', '--collect', '--scroll-container', '#viewport', '--format', 'json',
    ], {
      runMain: async ({ console, process }) => {
        cdpTest.emitTargetCommandResponse({ ok: true, result: output }, {
          cmd: 'table',
          format: 'json',
          targetResolution,
          console,
          process,
        });
      },
    });
    const sent = [];
    const handle = createMcpRequestHandler({
      runtimeClient: createRuntimeClient({ executeCli: async () => direct }),
      sendMessage: message => sent.push(message),
    });
    await handle({
      jsonrpc: '2.0',
      id: 160,
      method: 'tools/call',
      params: {
        name: 'run_command',
        arguments: {
          command: 'table',
          args: ['ABC12345', '#orders', '--collect', '--scroll-container', '#viewport', '--format', 'json'],
          confirm: true,
        },
      },
    });

    expect(direct.code).toBe(0);
    expect(direct.stdout).toBe(output);
    expect(direct.stdout).not.toContain('targetResolution');
    expect(sent[0].result).toEqual({
      content: [{ type: 'text', text: output }],
      isError: false,
    });
  });

  it('preserves collect text through CLI capture and confirmed MCP run_command', async () => {
    const fixture = mountRecycledTableFixture({
      logicalRows: 2, ariaRowCount: 3, mountedRows: 2, initialAvailable: 2,
    });
    const output = await runCollect(
      createWorldCdp(fixture),
      collectRequest({
        argv: ['#orders', '--collect', '--scroll-container', '#viewport', '--load-more', '#load-more'],
      }),
      { store: artifactStore() },
    );
    expect(output.startsWith('Table collection:')).toBe(true);
    expect(Buffer.byteLength(output, 'utf8')).toBeLessThanOrEqual(8192);

    const direct = await executeCdpCli([
      'table', 'ABC12345', '#orders', '--collect', '--scroll-container', '#viewport',
    ], {
      runMain: async ({ console, process }) => {
        cdpTest.emitTargetCommandResponse({ ok: true, result: output }, {
          cmd: 'table',
          format: 'text',
          console,
          process,
        });
      },
    });
    const sent = [];
    const handle = createMcpRequestHandler({
      runtimeClient: createRuntimeClient({ executeCli: async () => direct }),
      sendMessage: message => sent.push(message),
    });
    await handle({
      jsonrpc: '2.0',
      id: 161,
      method: 'tools/call',
      params: {
        name: 'run_command',
        arguments: {
          command: 'table',
          args: ['ABC12345', '#orders', '--collect', '--scroll-container', '#viewport'],
          confirm: true,
        },
      },
    });

    expect(direct.code).toBe(0);
    expect(direct.stdout).toBe(output);
    expect(sent[0].result).toEqual({
      content: [{ type: 'text', text: output }],
      isError: false,
    });
  });

  it('keeps batch aggregate-all while flow, replay, and repeat halt on collector-busy without retry', async () => {
    const busy = async () => ({ ok: false, error: 'table: collector-busy' });
    const collectArgs = ['#orders', '--collect', '--scroll-container', '#viewport'];
    const later = { cmd: 'table', args: ['#orders'] };

    const batchRun = vi.fn(async command => (
      command.args.includes('--collect') ? busy() : { ok: true, result: 'observed' }
    ));
    const batchResults = await cdpTest.runBatchCommands({ run: batchRun }, [
      { cmd: 'table', args: collectArgs },
      later,
    ]);
    expect(batchRun).toHaveBeenCalledTimes(2);
    expect(batchResults).toMatchObject([
      { cmd: 'table', ok: false, error: 'table: collector-busy' },
      { cmd: 'table', ok: true, result: 'observed' },
    ]);

    const flowRun = vi.fn(busy);
    const flow = JSON.parse(await cdpTest.flowStr({
      run: flowRun,
      settle: async () => '',
    }, 'table #orders --collect --scroll-container #viewport; table #orders', {
      format: 'json',
      targetId: 'ABC12345',
    }));
    expect(flowRun).toHaveBeenCalledTimes(1);
    expect(flowRun).toHaveBeenCalledWith(expect.objectContaining({
      cmd: 'table',
      args: collectArgs,
    }));
    expect(flow).toMatchObject({
      halted: true,
      counts: { ok: 0, failed: 1, skipped: 1 },
      failedStep: { cmd: 'table', error: 'table: collector-busy' },
    });

    const replayRun = vi.fn(busy);
    const replay = JSON.parse(await cdpTest.replayActionsStr({ run: replayRun }, [
      '--format', 'json', '--json', JSON.stringify({
        schema: 'chrome-cdp-ex.record-actions.v1',
        targetId: 'ABC12345',
        sessionId: 'fixture-session',
        actions: [
          { action: 'table', command: ['table', ...collectArgs], replayable: true, needsInput: [] },
          { action: 'table', command: ['table', '#orders'], replayable: true, needsInput: [] },
        ],
      }),
    ]));
    expect(replayRun).toHaveBeenCalledTimes(1);
    expect(replay).toMatchObject({
      halted: true,
      counts: { ok: 0, failed: 1 },
      failedStep: { command: ['table', ...collectArgs], error: 'table: collector-busy' },
    });

    const repeatRun = vi.fn(busy);
    await expect(cdpTest.repeatStr({ run: repeatRun }, ['3', 'table', ...collectArgs]))
      .rejects.toThrow(/collector-busy.*Repeat halted at iteration 1\/3/s);
    expect(repeatRun).toHaveBeenCalledTimes(1);
  });
});

