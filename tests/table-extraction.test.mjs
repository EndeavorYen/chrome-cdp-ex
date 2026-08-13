import { describe, expect, it } from 'vitest';

import {
  addTableSample,
  buildInlineTablePreview,
  buildTableExportManifest,
  canonicalizeTableCells,
  createTableAccumulator,
  finalizeTableExtraction,
  TABLE_EXTRACTION_LIMITS,
} from '../skills/chrome-cdp-ex/scripts/lib/table-extraction.mjs';

function addMountedRows(accumulator, count) {
  for (let index = 0; index < count; index += 1) {
    addTableSample(accumulator, {
      mountedNodeId: `node-${index}`,
      key: index + 1,
      cells: [`row ${index}`, `value ${index}`],
    });
  }
}

function accumulatorWithRows(rows, {
  logicalRows = rows.length,
  logicalCountSource = 'aria-rowcount',
  identitySource = 'aria-rowindex',
  orderingSource = 'aria-rowindex',
} = {}) {
  const accumulator = createTableAccumulator({ logicalRows, logicalCountSource, identitySource, orderingSource });
  rows.forEach((cells, index) => {
    addTableSample(accumulator, {
      mountedNodeId: `node-${index % 12}`,
      key: index + 1,
      cells,
    });
  });
  return accumulator;
}

function frozenRowsFixture() {
  const statuses = ['queued', 'ready', 'blocked', 'done'];
  return Array.from({ length: 1024 }, (_, zeroBasedIndex) => {
    const index = zeroBasedIndex + 1;
    return [
      `ROW-${String(index).padStart(4, '0')}`,
      statuses[(index * 7) % 4],
      `team-${String(((index * 13) % 17) + 1).padStart(2, '0')}`,
      String(1000 + ((index * 7919) % 900000)),
    ];
  });
}

describe('table extraction truthfulness', () => {
  it('reports a known virtual table as incomplete when only its mounted rows were observed', () => {
    const accumulator = createTableAccumulator({
      logicalRows: 1024,
      logicalCountSource: 'aria-rowcount',
      identitySource: 'aria-rowindex',
      orderingSource: 'aria-rowindex',
    });
    addMountedRows(accumulator, 12);

    const result = finalizeTableExtraction(accumulator, { termination: 'observation' });

    expect(result.logicalRows).toBe(1024);
    expect(result.mountedRows).toBe(12);
    expect(result.collectedRows).toBe(12);
    expect(result.completeness.state).toBe('incomplete');
  });

  it('reports logical count and completeness as unknown without explicit semantic evidence', () => {
    const accumulator = createTableAccumulator({
      logicalRows: null,
      logicalCountSource: 'none',
      identitySource: 'aria-rowindex',
      orderingSource: 'aria-rowindex',
    });
    addMountedRows(accumulator, 12);

    const result = finalizeTableExtraction(accumulator, { termination: 'observation' });

    expect(result.logicalRows).toBeNull();
    expect(result.completeness.state).toBe('unknown');
  });
});

describe('canonical table bytes and bounded previews', () => {
  it('escapes backslash, tab, CR, and LF before joining cells', () => {
    expect(canonicalizeTableCells(['left\\right', 'tab\tcell', 'carriage\rreturn', 'line\nbreak']))
      .toBe('left\\\\right\ttab\\tcell\tcarriage\\rreturn\tline\\nbreak');
  });

  it('keeps a complete exactly-8192-byte row without admitting the next row', () => {
    const exactBoundary = 'a'.repeat(8192);
    const preview = buildInlineTablePreview([exactBoundary, 'next']);

    expect(preview.rows).toEqual([exactBoundary]);
    expect(preview.rowCount).toBe(1);
    expect(preview.bytes).toBe(8192);
    expect(preview.truncated).toBe(true);
  });

  it('does not split a multibyte UTF-8 row at the byte boundary', () => {
    const preview = buildInlineTablePreview(['🙂🙂', '漢'], { maxInlineBytes: 8 });

    expect(preview.rows).toEqual(['🙂🙂']);
    expect(preview.bytes).toBe(8);
    expect(preview.rows.join('\n')).not.toContain('�');
    expect(Buffer.byteLength(preview.rows.join('\n'), 'utf8')).toBe(8);
  });

  it('caps an inline preview at twenty complete data rows', () => {
    const preview = buildInlineTablePreview(Array.from({ length: 21 }, () => 'x'));

    expect(preview.rowCount).toBe(20);
    expect(preview.bytes).toBe(39);
    expect(preview.truncated).toBe(true);
  });

  it('never lets callers raise fixed collection or preview ceilings', () => {
    expect(() => buildInlineTablePreview(['x'], { maxInlineRows: 21 })).toThrow(/must not exceed/i);
    expect(() => finalizeTableExtraction(accumulatorWithRows([['x']]), {
      termination: 'logical-count-reached',
      limits: { maxRows: 100001 },
    })).toThrow(/must not exceed/i);
  });

  it('hashes the frozen 1024-row TSV body exactly, without a header or final LF', () => {
    const manifest = buildTableExportManifest(accumulatorWithRows(frozenRowsFixture()), {
      termination: 'logical-count-reached',
    });

    expect(manifest.schema).toBe('chrome-cdp-ex.table-export.v1');
    expect(manifest.artifact.rows).toBe(1024);
    expect(manifest.artifact.bytes).toBe(31104);
    expect(manifest.artifact.checksum).toBe('73e9f36080b8c781e204857ad9c7dcf4ce7ce419b1503d9affd0343f58f964ed');
    expect(manifest.inline.bytes).toBeLessThanOrEqual(8192);
  });

  it('keeps the complete manifest response at or below 16384 UTF-8 bytes under escaping pressure', () => {
    const manifest = buildTableExportManifest(accumulatorWithRows([['\\'.repeat(4096)]]), {
      termination: 'logical-count-reached',
    });

    expect(manifest.inline.bytes).toBeLessThanOrEqual(8192);
    expect(Buffer.byteLength(JSON.stringify(manifest), 'utf8')).toBeLessThanOrEqual(16384);
  });
});

describe('collection safety and completeness', () => {
  it('records node recycling when one mounted node carries different stable keys', () => {
    const accumulator = accumulatorWithRows([['first']]);
    addTableSample(accumulator, { mountedNodeId: 'node-0', key: 2, cells: ['second'] });

    expect(finalizeTableExtraction(accumulator, { termination: 'logical-count-reached' }).recycledMountedNodes).toBe(1);
  });

  it('retains one row for an identical duplicate stable key', () => {
    const accumulator = accumulatorWithRows([['same']]);
    addTableSample(accumulator, { mountedNodeId: 'node-1', key: 1, cells: ['same'] });

    expect(finalizeTableExtraction(accumulator, { termination: 'logical-count-reached' }).collectedRows).toBe(1);
  });

  it('fails closed when a stable key is observed with conflicting canonical bytes', () => {
    const accumulator = accumulatorWithRows([['before']]);

    expect(() => addTableSample(accumulator, { mountedNodeId: 'node-1', key: 1, cells: ['after'] }))
      .toThrow(/conflict/i);
  });

  it('does not call an unknown logical total complete', () => {
    const accumulator = accumulatorWithRows([['only']], { logicalRows: null, logicalCountSource: 'none' });

    expect(finalizeTableExtraction(accumulator, { termination: 'logical-count-reached' }).completeness.state).toBe('unknown');
  });

  it('requires logical-count termination in addition to exact collected-count equality', () => {
    const accumulator = accumulatorWithRows([['one'], ['two']]);

    expect(finalizeTableExtraction(accumulator, { termination: 'observation' }).completeness.state).toBe('incomplete');
    expect(finalizeTableExtraction(accumulator, { termination: 'logical-count-reached' }).completeness.state).toBe('complete');
  });

  it.each(['row-limit', 'byte-limit', 'interaction-limit', 'time-limit', 'no-progress-limit', 'control-disappeared'])(
    'reports %s as incomplete rather than claiming a partial artifact is complete',
    termination => {
      const accumulator = accumulatorWithRows([['one']], { logicalRows: 2 });
      const result = finalizeTableExtraction(accumulator, { termination });

      expect(result.completeness.state).toBe('incomplete');
      expect(result.completeness.termination).toBe(termination);
    },
  );

  it('keeps a partial artifact truthful when a byte limit stops collection', () => {
    const manifest = buildTableExportManifest(accumulatorWithRows([['one']], { logicalRows: 2 }), {
      termination: 'byte-limit',
    });

    expect(manifest.artifact.rows).toBe(1);
    expect(manifest.completeness.state).toBe('incomplete');
  });
});

describe('hostile in-process input validation', () => {
  it('rejects accessors, custom prototypes, sparse arrays, non-strings, invalid counts, and unknown provenance before derivation', () => {
    const accessorOptions = {
      logicalCountSource: 'aria-rowcount',
      identitySource: 'aria-rowindex',
      orderingSource: 'aria-rowindex',
    };
    Object.defineProperty(accessorOptions, 'logicalRows', { enumerable: true, get: () => 1 });
    const customPrototypeOptions = Object.assign(Object.create({ inherited: true }), {
      logicalRows: 1,
      logicalCountSource: 'aria-rowcount',
      identitySource: 'aria-rowindex',
      orderingSource: 'aria-rowindex',
    });
    const sparseCells = Array(3);
    sparseCells[0] = 'first';
    sparseCells[2] = 'third';
    const accumulator = accumulatorWithRows([['safe']]);

    expect(() => createTableAccumulator(accessorOptions)).toThrow(/enumerable data/i);
    expect(() => createTableAccumulator(customPrototypeOptions)).toThrow(/Object\.prototype/i);
    expect(() => createTableAccumulator({ logicalRows: -1, logicalCountSource: 'aria-rowcount', identitySource: 'aria-rowindex', orderingSource: 'aria-rowindex' })).toThrow(/non-negative/i);
    expect(() => createTableAccumulator({ logicalRows: 1, logicalCountSource: 'caption', identitySource: 'aria-rowindex', orderingSource: 'aria-rowindex' })).toThrow(/not supported/i);
    expect(() => addTableSample(accumulator, { mountedNodeId: 'node-1', key: 1, cells: sparseCells })).toThrow(/dense/i);
    expect(() => addTableSample(accumulator, { mountedNodeId: 'node-1', key: 1, cells: ['safe', 2] })).toThrow(/string/i);
    expect(() => finalizeTableExtraction(accumulator, { termination: 'disappeared-control' })).toThrow(/not supported/i);
  });

  it('publishes immutable fixed ceilings', () => {
    expect(Object.isFrozen(TABLE_EXTRACTION_LIMITS)).toBe(true);
    expect(TABLE_EXTRACTION_LIMITS.maxRows).toBe(100000);
    expect(TABLE_EXTRACTION_LIMITS.maxArtifactBytes).toBe(16 * 1024 * 1024);
    expect(TABLE_EXTRACTION_LIMITS.maxInteractions).toBe(256);
    expect(TABLE_EXTRACTION_LIMITS.maxDurationMs).toBe(300000);
    expect(TABLE_EXTRACTION_LIMITS.maxNoProgressCycles).toBe(3);
  });
});
