import { describe, expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';

import {
  TABLE_SAMPLER_LIMITS,
  buildTableSamplerExpression,
  parseTableSamplerResult,
} from '../skills/chrome-cdp-ex/scripts/lib/table-sampler.mjs';

function table(overrides = {}) {
  return {
    caption: 'Orders',
    ariaRowCount: null,
    headerRows: [],
    dataRows: [
      { rawAriaRowIndex: null, cells: ['A', ''] },
      { rawAriaRowIndex: null, cells: ['', 'B'] },
    ],
    directRowsSeen: 2,
    headerRowsSeen: 0,
    dataRowsSeen: 2,
    truncated: false,
    truncationReason: null,
    ...overrides,
  };
}

function page(tables = [table()], overrides = {}) {
  return JSON.stringify({
    schema: 'chrome-cdp-ex.table-sample.v1',
    tablesSeen: tables.length,
    tables,
    truncated: false,
    truncationReason: null,
    ...overrides,
  });
}

describe('trusted table sampler source', () => {
  it('freezes the root-frame bounded DOM contract without page callbacks or mutable globals', () => {
    const expression = buildTableSamplerExpression('table');

    expect(TABLE_SAMPLER_LIMITS).toEqual({
      maxTables: 10,
      maxDirectRowsPerTable: 128,
      maxCellsPerRow: 256,
      maxCanonicalRowBytes: 4096,
      maxSerializedBytes: 524288,
      maxCaptionBytes: 512,
      maxCellTextBytes: 16384,
      maxTextNodesPerCell: 4096,
    });
    expect(expression).toContain('chrome-cdp-ex.table-sample.v1');
    expect(expression).toContain('HTMLTableElement');
    expect(expression).toContain('const O = Object');
    expect(expression).toContain('O.getOwnPropertyDescriptor');
    expect(expression).toContain('Node.prototype');
    expect(expression).toContain('Element.prototype');
    expect(expression).toContain('Text.prototype');
    expect(expression).not.toMatch(/\.querySelector|\.querySelectorAll|\.matches|\.closest|\.textContent/);
    expect(expression).not.toMatch(/JSON\.stringify|new TextEncoder|\.toJSON|\.filter\(|\.map\(|\.isPrototypeOf\(|\.test\(|\.padStart\(|for\s*\([^)]*\sof\s/);
    expect(Buffer.byteLength(expression, 'utf8')).toBeLessThan(100_000);
  });

  it('executes against captured DOM primitives without invoking poisoned page callbacks', () => {
    let poisonCalls = 0;
    class NodeLike {
      constructor(type, value = null) {
        this._type = type;
        this._value = value;
        this._parent = null;
        this._children = [];
      }
      append(child) {
        child._parent = this;
        this._children.push(child);
        return this;
      }
      get parentNode() { return this._parent; }
      get firstChild() { return this._children[0] || null; }
      get nextSibling() {
        if (!this._parent) return null;
        const index = this._parent._children.indexOf(this);
        return this._parent._children[index + 1] || null;
      }
      get nodeType() { return this._type; }
      get nodeValue() { return this._value; }
      get textContent() { poisonCalls += 1; throw new Error('page textContent'); }
      toJSON() { poisonCalls += 1; throw new Error('page toJSON'); }
    }
    class ElementLike extends NodeLike {
      constructor(localName, attributes = {}) {
        super(1);
        this._localName = localName;
        this._attributes = attributes;
      }
      get localName() { return this._localName; }
      getAttribute(name) { return Object.hasOwn(this._attributes, name) ? this._attributes[name] : null; }
      querySelectorAll() { poisonCalls += 1; throw new Error('page querySelectorAll'); }
      closest() { poisonCalls += 1; throw new Error('page closest'); }
    }
    class TextLike extends NodeLike {
      constructor(value) { super(3, value); }
    }
    class HTMLTableElementLike extends ElementLike {
      constructor(attributes) { super('table', attributes); }
    }
    class DocumentLike extends NodeLike {
      constructor(root) { super(9); this._root = root; }
      get documentElement() { return this._root; }
      querySelectorAll(selector) {
        if (selector !== 'table') throw new Error('unexpected selector');
        return this._root._children.filter(child => child instanceof HTMLTableElementLike);
      }
    }
    const root = new ElementLike('html');
    const outer = root.append(new HTMLTableElementLike({ 'aria-label': 'Orders', 'aria-rowcount': '2' }));
    const body = outer.append(new ElementLike('tbody'));
    const first = body.append(new ElementLike('tr', { 'aria-rowindex': '1' }));
    first.append(new ElementLike('td')).append(new TextLike('A'));
    first.append(new ElementLike('td')).append(new TextLike(''));
    const second = body.append(new ElementLike('tr', { 'aria-rowindex': '2' }));
    const cell = second.append(new ElementLike('td'));
    cell.append(new TextLike('B'));
    const nested = cell.append(new HTMLTableElementLike());
    nested.append(new ElementLike('tr')).append(new ElementLike('td')).append(new TextLike('poison nested'));
    const document = new DocumentLike(root);
    const context = {
      Object,
      Array,
      String,
      Number,
      Node: NodeLike,
      Element: ElementLike,
      Text: TextLike,
      Document: DocumentLike,
      HTMLTableElement: HTMLTableElementLike,
      document,
      JSON: Object.freeze({ stringify: () => { poisonCalls += 1; throw new Error('page JSON'); } }),
      TextEncoder: class { constructor() { poisonCalls += 1; throw new Error('page TextEncoder'); } },
    };

    const encoded = runInNewContext(buildTableSamplerExpression('table'), context);
    const sampled = parseTableSamplerResult(encoded);

    expect(poisonCalls).toBe(0);
    expect(sampled.tables).toHaveLength(1);
    expect(sampled.tables[0]).toMatchObject({
      caption: 'Orders',
      ariaRowCount: 2,
      dataRows: [
        { rawAriaRowIndex: 1, cells: ['A', ''] },
        { rawAriaRowIndex: 2, cells: ['B'] },
      ],
    });
  });

  it('executes the direct table-row fallback without invoking a getter on a synthetic object', () => {
    class N {
      constructor(type, value = null) { this.t = type; this.v = value; this.p = null; this.c = []; }
      append(child) { child.p = this; this.c.push(child); return this; }
      get parentNode() { return this.p; }
      get firstChild() { return this.c[0] || null; }
      get nextSibling() { return this.p?.c[this.p.c.indexOf(this) + 1] || null; }
      get nodeType() { return this.t; }
      get nodeValue() { return this.v; }
    }
    class E extends N {
      constructor(name, attrs = {}) { super(1); this.n = name; this.a = attrs; }
      get localName() { return this.n; }
      getAttribute(name) { return Object.hasOwn(this.a, name) ? this.a[name] : null; }
    }
    class X extends N { constructor(value) { super(3, value); } }
    class T extends E { constructor() { super('table'); } }
    class D extends N {
      constructor(root) { super(9); this.r = root; }
      get documentElement() { return this.r; }
      querySelectorAll() { return this.r.c; }
    }
    const root = new E('html');
    const tableNode = new T();
    const row = new E('tr');
    const cell = new E('td');
    cell.append(new X('direct'));
    row.append(cell);
    tableNode.append(row);
    root.append(tableNode);
    const encoded = runInNewContext(buildTableSamplerExpression('table'), {
      Object, Array, String, Number, Node: N, Element: E, Text: X, Document: D,
      HTMLTableElement: T, document: new D(root),
    });

    expect(parseTableSamplerResult(encoded).tables[0].dataRows[0].cells).toEqual(['direct']);
  });

  it('drops the whole offending row for cell, text-node, canonical-row, or aggregate-byte pressure', () => {
    const expression = buildTableSamplerExpression('table');

    expect(expression).toContain("truncationReason = 'cell-limit'");
    expect(expression).toContain("truncationReason = 'row-too-large'");
    expect(expression).toContain("truncationReason = 'sample-byte-limit'");
    expect(expression).toContain('maxTextNodesPerCell');
    expect(expression).toMatch(/utf8Bytes\([^)]*candidate/i);
  });
});

describe('bounded table sampler host validation', () => {
  it('preserves empty static rows and reports one DOM-ordered mounted snapshot', () => {
    const result = parseTableSamplerResult(page());

    expect(result.tables).toEqual([table()]);
    expect(result.tables[0].dataRows[0].cells).toEqual(['A', '']);
    expect(result.tables[0].dataRows[1].cells).toEqual(['', 'B']);
  });

  it('accepts ten tables and rejects an eleventh or an oversized page response', () => {
    expect(parseTableSamplerResult(page(Array.from({ length: 10 }, (_, index) => table({ caption: `T${index + 1}` })))).tables)
      .toHaveLength(10);
    expect(() => parseTableSamplerResult(page(Array.from({ length: 11 }, () => table()), {
      tablesSeen: 11,
      truncated: true,
      truncationReason: 'table-limit',
    }))).toThrow(/tables.*bound/i);
    expect(() => parseTableSamplerResult('x'.repeat(524289))).toThrow(/524,288.*bytes/i);
  });

  it('accepts at most 128 direct rows and 256 direct cells with explicit N plus one evidence', () => {
    const rows128 = Array.from({ length: 128 }, (_, index) => ({
      rawAriaRowIndex: index + 1,
      cells: Array(256).fill(''),
    }));
    expect(parseTableSamplerResult(page([table({
      ariaRowCount: 128,
      dataRows: rows128,
      directRowsSeen: 128,
      dataRowsSeen: 128,
    })])).tables[0].dataRows).toHaveLength(128);

    expect(() => parseTableSamplerResult(page([table({
      dataRows: rows128.concat({ rawAriaRowIndex: 129, cells: ['late'] }),
      directRowsSeen: 129,
      dataRowsSeen: 129,
      truncated: true,
      truncationReason: 'row-limit',
    })]))).toThrow(/dataRows.*bound/i);
    expect(() => parseTableSamplerResult(page([table({
      dataRows: [{ rawAriaRowIndex: null, cells: Array(257).fill('') }],
      directRowsSeen: 1,
      dataRowsSeen: 1,
      truncated: true,
      truncationReason: 'cell-limit',
    })]))).toThrow(/cells.*bound/i);
  });

  it('rejects malformed ARIA, extra keys, accessors, custom prototypes, and unpaired Unicode', () => {
    expect(() => parseTableSamplerResult(page([table({ ariaRowCount: -2 })]))).toThrow(/ariaRowCount/i);
    expect(() => parseTableSamplerResult(page([table({ ariaRowCount: '2' })]))).toThrow(/ariaRowCount/i);
    expect(() => parseTableSamplerResult(page([table({ extra: true })]))).toThrow(/extra/i);
    expect(() => parseTableSamplerResult(page([table({ caption: '\ud800' })]))).toThrow(/Unicode/i);
    expect(() => parseTableSamplerResult({ value: page() })).toThrow(/string/i);
  });

  it('requires exact truncation provenance and bounded seen counts', () => {
    expect(() => parseTableSamplerResult(page([table({ truncated: true, truncationReason: null })])))
      .toThrow(/truncation/i);
    expect(() => parseTableSamplerResult(page([table({
      directRowsSeen: 130,
      dataRowsSeen: 130,
      truncated: true,
      truncationReason: 'row-limit',
    })]))).toThrow(/directRowsSeen/i);
    expect(() => parseTableSamplerResult(page([], {
      tablesSeen: 12,
      truncated: true,
      truncationReason: 'table-limit',
    }))).toThrow(/tablesSeen/i);
  });
});
