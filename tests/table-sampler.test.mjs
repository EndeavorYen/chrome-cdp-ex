import { describe, expect, it } from 'vitest';

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
    });
    expect(expression).toContain('chrome-cdp-ex.table-sample.v1');
    expect(expression).toContain('HTMLTableElement');
    expect(expression).toContain('Object.getOwnPropertyDescriptor');
    expect(expression).toContain('Node.prototype');
    expect(expression).toContain('Element.prototype');
    expect(expression).toContain('Text.prototype');
    expect(expression).not.toMatch(/\.querySelector|\.querySelectorAll|\.matches|\.closest|\.textContent/);
    expect(expression).not.toMatch(/JSON\.stringify|new TextEncoder|\.toJSON|for\s*\([^)]*\sof\s/);
    expect(Buffer.byteLength(expression, 'utf8')).toBeLessThan(100_000);
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
