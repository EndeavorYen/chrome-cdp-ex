import { describe, it, expect } from 'vitest';
import { createMockCDP } from './mock-cdp.mjs';

import { buildTableSamplerExpression } from '../skills/chrome-cdp-ex/scripts/lib/table-sampler.mjs';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
const { sampleRootFrameTables, tableObservationStr } = T;

// =========================================================================
// CDP mock helper — lightweight fake for testing command functions
// =========================================================================


describe('bounded table observation', () => {
  function sampledPage(tables = []) {
    return JSON.stringify({
      schema: 'chrome-cdp-ex.table-sample.v1',
      tablesSeen: tables.length,
      tables,
      truncated: false,
      truncationReason: null,
    });
  }

  function sampledTable(overrides = {}) {
    return {
      caption: 'Orders',
      ariaRowCount: null,
      headerRows: [],
      dataRows: [
        { rawAriaRowIndex: null, cells: ['A', '1'] },
        { rawAriaRowIndex: null, cells: ['B', '2'] },
      ],
      directRowsSeen: 2,
      headerRowsSeen: 0,
      dataRowsSeen: 2,
      truncated: false,
      truncationReason: null,
      ...overrides,
    };
  }

  it('uses the exact root-frame isolated-world CDP sequence and bounded string result', async () => {
    const cdp = createMockCDP({
      'Page.getFrameTree': () => ({
        frameTree: {
          frame: { id: 'root-frame' },
          childFrames: [{ frame: { id: 'child-frame', parentId: 'root-frame' } }],
        },
      }),
      'Page.createIsolatedWorld': params => {
        expect(params).toEqual({
          frameId: 'root-frame',
          worldName: 'chrome-cdp-ex-table-sampler-v1',
          grantUniveralAccess: false,
        });
        return { executionContextId: 731 };
      },
      'Runtime.evaluate': params => {
        expect(params).toEqual({
          expression: buildTableSamplerExpression('#orders'),
          contextId: 731,
          returnByValue: true,
          awaitPromise: false,
        });
        return { result: { type: 'string', value: sampledPage([sampledTable()]) } };
      },
    });

    await expect(sampleRootFrameTables(cdp, 'sid1', '#orders')).resolves.toMatchObject({
      schema: 'chrome-cdp-ex.table-sample.v1',
      tablesSeen: 1,
    });
    expect(cdp.calls.map(call => call.method)).toEqual([
      'Page.getFrameTree',
      'Page.createIsolatedWorld',
      'Runtime.evaluate',
    ]);
    expect(cdp.calls.every(call => call.sessionId === 'sid1')).toBe(true);
  });

  it.each([
    'table:has(#last)',
    'html table',
    'table>tbody',
    'table,table',
    'table\\#orders',
  ])('rejects an unbounded observation selector before any CDP call: %s', async selector => {
    const cdp = createMockCDP();

    await expect(sampleRootFrameTables(cdp, 'sid1', selector)).rejects.toThrow(/bounded table selector|not supported/i);
    expect(cdp.calls).toEqual([]);
  });

  it.each([
    [{ frameTree: { frame: {} } }, /root frame/i],
    [{ frameTree: { frame: { id: 'root' } } }, /execution context/i],
  ])('rejects malformed frame/world responses before returning sample %#', async (frameResult, message) => {
    const cdp = createMockCDP({
      'Page.getFrameTree': () => frameResult,
      'Page.createIsolatedWorld': () => ({}),
    });
    await expect(sampleRootFrameTables(cdp, 'sid1', 'table')).rejects.toThrow(message);
  });

  it.each([0, -1, 1.5, '1', null])('rejects invalid isolated execution context id %j', async executionContextId => {
    const cdp = createMockCDP({
      'Page.createIsolatedWorld': () => ({ executionContextId }),
    });
    await expect(sampleRootFrameTables(cdp, 'sid1', 'table')).rejects.toThrow(/execution context/i);
    expect(cdp.calls.map(call => call.method)).toEqual(['Page.getFrameTree', 'Page.createIsolatedWorld']);
  });

  it('rejects runtime exceptions, non-string remote values, malformed JSON, and oversized samples', async () => {
    for (const runtimeResult of [
      { exceptionDetails: { text: 'boom' }, result: { type: 'string', value: sampledPage() } },
      { result: { type: 'object', value: {} } },
      { result: { type: 'string', value: '{' } },
      { result: { type: 'string', value: 'x'.repeat(524289) } },
    ]) {
      const cdp = createMockCDP({ 'Runtime.evaluate': () => runtimeResult });
      await expect(sampleRootFrameTables(cdp, 'sid1', 'table')).rejects.toThrow();
    }
  });

  it('rejects a hostile sampler wire row that violates the canonical-row contract', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { type: 'string', value: sampledPage([sampledTable({
        dataRows: [
          { rawAriaRowIndex: null, cells: ['safe'] },
          { rawAriaRowIndex: null, cells: ['\\'.repeat(2049)] },
        ],
        directRowsSeen: 2,
        dataRowsSeen: 2,
        truncated: true,
        truncationReason: 'row-too-large',
      })]) } }),
    });

    await expect(tableObservationStr(cdp, 'sid1', {
      mode: 'observe', selector: null, format: 'json',
    })).rejects.toThrow(/canonical row exceeds 4096/i);
  });

  it('preserves the producible page-side valid prefix and N plus one truncation evidence', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { type: 'string', value: sampledPage([sampledTable({
        dataRows: [{ rawAriaRowIndex: null, cells: ['safe'] }],
        directRowsSeen: 2,
        dataRowsSeen: 2,
        truncated: true,
        truncationReason: 'row-too-large',
      })]) } }),
    });

    const output = JSON.parse(await tableObservationStr(cdp, 'sid1', {
      mode: 'observe', selector: null, format: 'json',
    }));
    expect(output.tables[0]).toMatchObject({
      collectedRows: 1,
      inline: { rows: ['safe'] },
      snapshot: {
        dataRowsSeen: 2,
        rowsAdmitted: 1,
        truncated: true,
        truncationReason: 'row-too-large',
      },
    });
  });

  it('certifies complete only for exact normalized ARIA coverage with contiguous indexed headers', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { type: 'string', value: sampledPage([sampledTable({
        ariaRowCount: 3,
        headerRows: [{ rawAriaRowIndex: 1, cells: ['Name', 'Value'] }],
        dataRows: [
          { rawAriaRowIndex: 2, cells: ['A', '1'] },
          { rawAriaRowIndex: 3, cells: ['B', '2'] },
        ],
        directRowsSeen: 3,
        headerRowsSeen: 1,
      })]) } }),
    });

    const output = JSON.parse(await tableObservationStr(cdp, 'sid1', {
      mode: 'observe', selector: '#orders', format: 'json',
    }));
    expect(output.tables[0]).toMatchObject({
      logicalRows: 2,
      logicalCountSource: 'aria-rowcount',
      identitySource: 'aria-rowindex',
      orderingSource: 'aria-rowindex',
      completeness: { state: 'complete', termination: 'logical-count-reached', evidenceConflict: false },
      headers: [['Name', 'Value']],
      inline: { rows: ['A\t1', 'B\t2'] },
    });
  });

  it.each([
    {
      name: 'zero headers',
      ariaRowCount: 2,
      headerRows: [],
      dataRows: [
        { rawAriaRowIndex: 1, cells: ['A'] },
        { rawAriaRowIndex: 2, cells: ['B'] },
      ],
    },
    {
      name: 'two headers',
      ariaRowCount: 4,
      headerRows: [
        { rawAriaRowIndex: 1, cells: ['Group'] },
        { rawAriaRowIndex: 2, cells: ['Name'] },
      ],
      dataRows: [
        { rawAriaRowIndex: 3, cells: ['A'] },
        { rawAriaRowIndex: 4, cells: ['B'] },
      ],
    },
  ])('certifies exact normalized ARIA coverage with $name', async fixture => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { type: 'string', value: sampledPage([sampledTable({
        ariaRowCount: fixture.ariaRowCount,
        headerRows: fixture.headerRows,
        dataRows: fixture.dataRows,
        directRowsSeen: fixture.headerRows.length + fixture.dataRows.length,
        headerRowsSeen: fixture.headerRows.length,
        dataRowsSeen: fixture.dataRows.length,
      })]) } }),
    });

    const output = JSON.parse(await tableObservationStr(cdp, 'sid1', {
      mode: 'observe', selector: null, format: 'json',
    }));
    expect(output.tables[0]).toMatchObject({
      logicalRows: 2,
      identitySource: 'aria-rowindex',
      orderingSource: 'aria-rowindex',
      completeness: { state: 'complete', termination: 'logical-count-reached', evidenceConflict: false },
    });
  });

  it('retains certified ARIA identity for a valid partial prefix without claiming complete', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { type: 'string', value: sampledPage([sampledTable({
        ariaRowCount: 4,
        headerRows: [{ rawAriaRowIndex: 1, cells: ['Name'] }],
        dataRows: [
          { rawAriaRowIndex: 2, cells: ['A'] },
          { rawAriaRowIndex: 3, cells: ['B'] },
        ],
        directRowsSeen: 3,
        headerRowsSeen: 1,
      })]) } }),
    });

    const output = JSON.parse(await tableObservationStr(cdp, 'sid1', {
      mode: 'observe', selector: null, format: 'json',
    }));
    expect(output.tables[0]).toMatchObject({
      logicalRows: 3,
      identitySource: 'aria-rowindex',
      orderingSource: 'aria-rowindex',
      completeness: { state: 'incomplete', termination: 'observation', evidenceConflict: false },
    });
  });

  it('retains certified ARIA identity for a sampler-truncated valid prefix', async () => {
    const dataRows = Array.from({ length: 128 }, (_, index) => ({
      rawAriaRowIndex: index + 1,
      cells: [`row-${index + 1}`],
    }));
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { type: 'string', value: sampledPage([sampledTable({
        ariaRowCount: 1000,
        dataRows,
        directRowsSeen: 129,
        dataRowsSeen: 129,
        truncated: true,
        truncationReason: 'row-limit',
      })]) } }),
    });

    const output = JSON.parse(await tableObservationStr(cdp, 'sid1', {
      mode: 'observe', selector: null, format: 'json',
    }));
    expect(output.tables[0]).toMatchObject({
      logicalRows: 1000,
      logicalCountSource: 'aria-rowcount',
      identitySource: 'aria-rowindex',
      orderingSource: 'aria-rowindex',
      collectedRows: 128,
      completeness: { state: 'incomplete', termination: 'observation', evidenceConflict: false },
      snapshot: { rowsAdmitted: 128, truncated: true, truncationReason: 'row-limit' },
    });
  });

  it('retains ARIA identity for a valid non-prefix virtual window without claiming complete', async () => {
    const dataRows = Array.from({ length: 11 }, (_, index) => ({
      rawAriaRowIndex: index + 50,
      cells: [`row-${index + 50}`],
    }));
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { type: 'string', value: sampledPage([sampledTable({
        ariaRowCount: 100,
        dataRows,
        directRowsSeen: dataRows.length,
        dataRowsSeen: dataRows.length,
      })]) } }),
    });

    const output = JSON.parse(await tableObservationStr(cdp, 'sid1', {
      mode: 'observe', selector: null, format: 'json',
    }));
    expect(output.tables[0]).toMatchObject({
      logicalRows: 100,
      logicalCountSource: 'aria-rowcount',
      identitySource: 'aria-rowindex',
      orderingSource: 'aria-rowindex',
      collectedRows: 11,
      completeness: { state: 'incomplete', termination: 'observation', evidenceConflict: false },
    });
  });

  it.each(['cell-limit', 'row-too-large'])(
    'does not infer ARIA count or identity after a %s header-prefix omission',
    async truncationReason => {
      const cdp = createMockCDP({
        'Runtime.evaluate': () => ({ result: { type: 'string', value: sampledPage([sampledTable({
          ariaRowCount: 4,
          headerRows: [{ rawAriaRowIndex: 1, cells: ['Visible header'] }],
          dataRows: [],
          directRowsSeen: 2,
          headerRowsSeen: 2,
          dataRowsSeen: 0,
          truncated: true,
          truncationReason,
        })]) } }),
      });

      const output = JSON.parse(await tableObservationStr(cdp, 'sid1', {
        mode: 'observe', selector: null, format: 'json',
      }));
      expect(output.tables[0]).toMatchObject({
        logicalRows: null,
        logicalCountSource: 'none',
        identitySource: 'snapshot-order',
        orderingSource: 'dom-order',
        completeness: { state: 'unknown', termination: 'observation', evidenceConflict: false },
        snapshot: {
          headerRowsSeen: 2,
          rowsAdmitted: 0,
          truncated: true,
          truncationReason,
        },
      });
    },
  );

  it.each([
    { name: 'null count', ariaRowCount: null, expectedRows: null, expectedConflict: false },
    { name: 'unknown count', ariaRowCount: -1, expectedRows: null, expectedConflict: false },
    { name: 'count smaller than headers', ariaRowCount: 0, expectedRows: null, expectedConflict: false },
    { name: 'uncertified count with unindexed data', ariaRowCount: 1, expectedRows: null, expectedConflict: false },
  ])('falls back truthfully for $name', async fixture => {
    const headerRows = fixture.name === 'count smaller than headers'
      ? [{ rawAriaRowIndex: 1, cells: ['Header'] }]
      : [];
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { type: 'string', value: sampledPage([sampledTable({
        ariaRowCount: fixture.ariaRowCount,
        headerRows,
        directRowsSeen: headerRows.length + 2,
        headerRowsSeen: headerRows.length,
      })]) } }),
    });

    const output = JSON.parse(await tableObservationStr(cdp, 'sid1', {
      mode: 'observe', selector: null, format: 'json',
    }));
    expect(output.tables[0]).toMatchObject({
      logicalRows: fixture.expectedRows,
      identitySource: 'snapshot-order',
      orderingSource: 'dom-order',
      completeness: { state: 'unknown', evidenceConflict: fixture.expectedConflict },
    });
  });

  it.each([
    { dataRows: [
      { rawAriaRowIndex: 1, cells: ['A'] },
      { rawAriaRowIndex: 3, cells: ['B'] },
    ] },
    { dataRows: [
      { rawAriaRowIndex: 1, cells: ['A'] },
      { rawAriaRowIndex: 1, cells: ['B'] },
    ] },
    { dataRows: [
      { rawAriaRowIndex: null, cells: ['A'] },
      { rawAriaRowIndex: 2, cells: ['B'] },
    ] },
  ])('falls back to snapshot identity for inconsistent data-row ARIA %#', async fixture => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { type: 'string', value: sampledPage([sampledTable({
        ariaRowCount: 2,
        dataRows: fixture.dataRows,
      })]) } }),
    });
    const output = JSON.parse(await tableObservationStr(cdp, 'sid1', {
      mode: 'observe', selector: null, format: 'json',
    }));
    expect(output.tables[0]).toMatchObject({
      identitySource: 'snapshot-order',
      orderingSource: 'dom-order',
      completeness: { state: 'unknown', evidenceConflict: false },
    });
  });

  it('publishes only the frozen plural envelope fields without raw sampler details', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { type: 'string', value: sampledPage([sampledTable()]) } }),
    });
    const output = JSON.parse(await tableObservationStr(cdp, 'sid1', {
      mode: 'observe', selector: '#orders', format: 'json',
    }));

    expect(Object.keys(output)).toEqual(['schema', 'snapshot', 'tables']);
    expect(Object.keys(output.snapshot)).toEqual(['tablesSeen', 'tablesReturned', 'truncated', 'truncationReason']);
    expect(Object.keys(output.tables[0])).toEqual([
      'schema', 'logicalRows', 'logicalCountSource', 'identitySource', 'orderingSource',
      'mountedRows', 'collectedRows', 'recycledMountedNodes', 'completeness', 'inline',
      'caption', 'headers', 'snapshot',
    ]);
    expect(JSON.stringify(output)).not.toMatch(/rawAriaRowIndex|executionContextId|frameId|timestamp|path/);
  });

  it('canonicalizes hostile caption and header metadata before JSON emission', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { type: 'string', value: sampledPage([sampledTable({
        caption: 'Orders\nFORGED\u001b[31m\u0085\u2028',
        ariaRowCount: 2,
        headerRows: [{ rawAriaRowIndex: 1, cells: ['Name\rNEXT\u009f\u2029'] }],
        dataRows: [{ rawAriaRowIndex: 2, cells: ['safe'] }],
        directRowsSeen: 2,
        headerRowsSeen: 1,
        dataRowsSeen: 1,
      })]) } }),
    });

    const output = JSON.parse(await tableObservationStr(cdp, 'sid1', {
      mode: 'observe', selector: null, format: 'json',
    }));
    expect(output.tables[0].caption).toBe('Orders\\nFORGED\\u001B[31m\\u0085\\u2028');
    expect(output.tables[0].headers).toEqual([['Name\\rNEXT\\u009F\\u2029']]);
    const metadata = [output.tables[0].caption, ...output.tables[0].headers.flat()];
    expect(metadata.every(value => [...value].every(character => {
      const unit = character.charCodeAt(0);
      return unit >= 0x20 && !(unit >= 0x7F && unit <= 0x9F)
        && unit !== 0x2028 && unit !== 0x2029;
    }))).toBe(true);
  });

  it('escapes hostile runtime exception controls into one bounded diagnostic line', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({
        exceptionDetails: { text: 'boom\nFORGED\u001b[31m\u0000' },
      }),
    });

    const error = await sampleRootFrameTables(cdp, 'sid1', 'table').catch(cause => cause);
    expect(error.message).toContain('boom\\nFORGED\\u001B[31m\\0');
    expect([...error.message].some(character => {
      const unit = character.charCodeAt(0);
      return unit < 0x20 || (unit >= 0x7F && unit <= 0x9F);
    })).toBe(false);
    expect(Buffer.byteLength(error.message, 'utf8')).toBeLessThanOrEqual(1024);
  });

  it.each([
    { headerRows: [{ rawAriaRowIndex: null, cells: ['H'] }] },
    { headerRows: [{ rawAriaRowIndex: 2, cells: ['H'] }] },
    { headerRows: [{ rawAriaRowIndex: 1, cells: ['H'] }, { rawAriaRowIndex: 1, cells: ['H2'] }] },
  ])('keeps malformed or noncontiguous header indexing uncertified %#', async headerCase => {
    const headerRows = headerCase.headerRows;
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { type: 'string', value: sampledPage([sampledTable({
        ariaRowCount: headerRows.length + 2,
        headerRows,
        dataRows: [
          { rawAriaRowIndex: headerRows.length + 1, cells: ['A'] },
          { rawAriaRowIndex: headerRows.length + 2, cells: ['B'] },
        ],
        directRowsSeen: headerRows.length + 2,
        headerRowsSeen: headerRows.length,
      })]) } }),
    });

    const output = JSON.parse(await tableObservationStr(cdp, 'sid1', {
      mode: 'observe', selector: null, format: 'json',
    }));
    expect(output.tables[0]).toMatchObject({
      logicalRows: null,
      logicalCountSource: 'none',
      identitySource: 'snapshot-order',
      orderingSource: 'dom-order',
      completeness: { state: 'unknown' },
    });
  });

  it.each([
    {
      name: 'mixed noncontiguous header indexes',
      headerRows: [
        { rawAriaRowIndex: 1, cells: ['H'] },
        { rawAriaRowIndex: 3, cells: ['H2'] },
      ],
    },
    {
      name: 'noncontiguous header indexes',
      headerRows: [{ rawAriaRowIndex: 2, cells: ['H'] }],
    },
    {
      name: 'duplicate header indexes',
      headerRows: [
        { rawAriaRowIndex: 1, cells: ['H'] },
        { rawAriaRowIndex: 1, cells: ['H2'] },
      ],
    },
    {
      name: 'missing header indexes',
      headerRows: [{ rawAriaRowIndex: null, cells: ['H'] }],
    },
  ])('does not trust logicalRows for $name with a partial ARIA rowcount', async fixture => {
    const dataRows = Array.from({ length: 5 }, (_, index) => ({
      rawAriaRowIndex: null,
      cells: [`row-${index + 1}`],
    }));
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { type: 'string', value: sampledPage([sampledTable({
        ariaRowCount: 100,
        headerRows: fixture.headerRows,
        dataRows,
        directRowsSeen: fixture.headerRows.length + dataRows.length,
        headerRowsSeen: fixture.headerRows.length,
        dataRowsSeen: dataRows.length,
      })]) } }),
    });

    const output = JSON.parse(await tableObservationStr(cdp, 'sid1', {
      mode: 'observe', selector: null, format: 'json',
    }));
    expect(output.tables[0]).toMatchObject({
      logicalRows: null,
      logicalCountSource: 'none',
      identitySource: 'snapshot-order',
      orderingSource: 'dom-order',
      collectedRows: 5,
      completeness: { state: 'unknown', termination: 'observation', evidenceConflict: false },
    });
  });

  it('does not trust aria-rowcount for unindexed H=0 data', async () => {
    const dataRows = Array.from({ length: 5 }, (_, index) => ({
      rawAriaRowIndex: null,
      cells: [`row-${index + 1}`],
    }));
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { type: 'string', value: sampledPage([sampledTable({
        ariaRowCount: 100,
        headerRows: [],
        dataRows,
        directRowsSeen: dataRows.length,
        headerRowsSeen: 0,
        dataRowsSeen: dataRows.length,
      })]) } }),
    });

    const output = JSON.parse(await tableObservationStr(cdp, 'sid1', {
      mode: 'observe', selector: null, format: 'json',
    }));
    expect(output.tables[0]).toMatchObject({
      logicalRows: null,
      logicalCountSource: 'none',
      identitySource: 'snapshot-order',
      orderingSource: 'dom-order',
      collectedRows: 5,
      completeness: { state: 'unknown', termination: 'observation', evidenceConflict: false },
    });
  });

  it('retains trusted logicalRows for certified headers and a valid partial ARIA data window', async () => {
    const dataRows = Array.from({ length: 5 }, (_, index) => ({
      rawAriaRowIndex: index + 2,
      cells: [`row-${index + 1}`],
    }));
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { type: 'string', value: sampledPage([sampledTable({
        ariaRowCount: 100,
        headerRows: [{ rawAriaRowIndex: 1, cells: ['Name'] }],
        dataRows,
        directRowsSeen: 1 + dataRows.length,
        headerRowsSeen: 1,
        dataRowsSeen: dataRows.length,
      })]) } }),
    });

    const output = JSON.parse(await tableObservationStr(cdp, 'sid1', {
      mode: 'observe', selector: null, format: 'json',
    }));
    expect(output.tables[0]).toMatchObject({
      logicalRows: 99,
      logicalCountSource: 'aria-rowcount',
      identitySource: 'aria-rowindex',
      orderingSource: 'aria-rowindex',
      collectedRows: 5,
      completeness: { state: 'incomplete', termination: 'observation', evidenceConflict: false },
    });
  });

  it('formats text as a mounted snapshot with provenance first and complete-row bounds', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { type: 'string', value: sampledPage([sampledTable({
        ariaRowCount: 100,
      })]) } }),
    });

    const output = await tableObservationStr(cdp, 'sid1', {
      mode: 'observe', selector: null, format: 'text',
    });
    expect(output.split('\n').slice(0, 4).join('\n')).toMatch(/Table snapshot.*mounted.*unknown/is);
    expect(output).toContain('A\t1');
    expect(output).toContain('B\t2');
    expect(output).toMatch(/table .*--collect.*--scroll-container/i);
    expect(Buffer.byteLength(output, 'utf8')).toBeLessThanOrEqual(8192);
  });

  it('trims a complete hostile trailing row instead of deleting an earlier row', async () => {
    const first = 'a'.repeat(4090);
    const second = 'b'.repeat(4090);
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { type: 'string', value: sampledPage([sampledTable({
        ariaRowCount: 2,
        dataRows: [
          { rawAriaRowIndex: 1, cells: [first] },
          { rawAriaRowIndex: 2, cells: [second] },
        ],
      })]) } }),
    });

    const output = await tableObservationStr(cdp, 'sid1', {
      mode: 'observe', selector: null, format: 'text',
    });
    expect(Buffer.byteLength(output, 'utf8')).toBeLessThanOrEqual(8192);
    expect(output).toContain(first);
    expect(output).not.toContain(second);
    expect(output).toMatch(/emission limit/i);
  });

  it('canonicalizes hostile caption and header controls before text emission', async () => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { type: 'string', value: sampledPage([sampledTable({
        caption: 'Orders\nFORGED COMMAND\u001b[31m',
        ariaRowCount: 2,
        headerRows: [{ rawAriaRowIndex: 1, cells: ['Name\r\nNEXT\u0000'] }],
        dataRows: [{ rawAriaRowIndex: 2, cells: ['safe'] }],
        directRowsSeen: 2,
        headerRowsSeen: 1,
        dataRowsSeen: 1,
      })]) } }),
    });

    const output = await tableObservationStr(cdp, 'sid1', {
      mode: 'observe', selector: null, format: 'text',
    });
    expect(output).toContain('Orders\\nFORGED COMMAND\\u001B[31m');
    expect(output).toContain('Header: Name\\r\\nNEXT\\0');
    expect(output.split('\n')).not.toContain('FORGED COMMAND');
    expect(output.split('\n')).not.toContain('NEXT');
    expect([...output].some(character => {
      const unit = character.charCodeAt(0);
      return unit !== 0x0A && (unit < 0x20 || (unit >= 0x7F && unit <= 0x9F));
    })).toBe(false);
  });

  it.each([
    { name: 'trailing empty cell', cells: ['A', ''], canonical: 'A\t' },
    { name: 'empty row', cells: [], canonical: '' },
  ])('ends complete text after $name with a non-whitespace provenance footer', async fixture => {
    const cdp = createMockCDP({
      'Runtime.evaluate': () => ({ result: { type: 'string', value: sampledPage([sampledTable({
        ariaRowCount: 1,
        dataRows: [{ rawAriaRowIndex: 1, cells: fixture.cells }],
        directRowsSeen: 1,
        dataRowsSeen: 1,
      })]) } }),
    });

    const output = await tableObservationStr(cdp, 'sid1', {
      mode: 'observe', selector: null, format: 'text',
    });
    expect(output).toContain(`\n${fixture.canonical}\nSnapshot provenance: bounded root-frame observation.`);
    expect(output).toMatch(/Snapshot provenance: bounded root-frame observation\.$/);
  });
});
