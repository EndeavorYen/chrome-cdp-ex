import { describe, expect, it } from 'vitest';

import {
  addTableSample,
  createTableAccumulator,
  finalizeTableExtraction,
} from '../skills/chrome-cdp-ex/scripts/lib/table-extraction.mjs';

function addMountedRows(accumulator, count) {
  for (let index = 0; index < count; index += 1) {
    addTableSample(accumulator, {
      mountedNodeId: `node-${index}`,
      key: index,
      cells: [`row ${index}`, `value ${index}`],
    });
  }
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
