import { describe, expect, it, vi } from 'vitest';

const { __test__: cdpTest } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

function targetResolution() {
  return {
    requestedTargetPrefix: '0123456789ABCDEF0123456789ABCDEF',
    requestedTargetId: '0123456789ABCDEF0123456789ABCDEF',
    boundTargetId: 'FEDCBA9876543210FEDCBA9876543210',
    resolvedTargetId: '0123456789ABCDEF0123456789ABCDEF',
    resolutionSource: 'live-discovery+alias',
    status: 'rebound',
    rebound: true,
  };
}

function tableObservationPayload() {
  const rows = Array.from({ length: 20 }, (_, index) => `${index + 1}\t${'x'.repeat(650)}`);
  const table = {
    schema: 'chrome-cdp-ex.table.v1',
    logicalRows: 200,
    logicalCountSource: 'aria-rowcount',
    identitySource: 'aria-rowindex',
    orderingSource: 'aria-rowindex',
    mountedRows: 20,
    collectedRows: 20,
    recycledMountedNodes: 0,
    completeness: { state: 'incomplete', termination: 'observation', evidenceConflict: false },
    caption: 'Orders',
    headers: [['Id', 'Value']],
    snapshot: {
      directRowsSeen: 21,
      headerRowsSeen: 1,
      dataRowsSeen: 20,
      rowsAdmitted: 20,
      truncated: false,
      truncationReason: null,
    },
    inline: {
      rows,
      rowCount: rows.length,
      bytes: Buffer.byteLength(rows.join('\n'), 'utf8'),
      truncated: false,
    },
  };
  const output = JSON.stringify({
    schema: 'chrome-cdp-ex.tables.v1',
    snapshot: { tablesSeen: 1, tablesReturned: 1, truncated: false, truncationReason: null },
    tables: [table],
  }, null, 2);
  expect(Buffer.byteLength(output, 'utf8')).toBeLessThanOrEqual(16_384);
  return { output, rows };
}

describe('bounded table observation public emission', () => {
  it('keeps full target diagnostics and trims only whole inline rows after diagnostics attach', () => {
    const { output, rows } = tableObservationPayload();
    const log = vi.fn();

    cdpTest.emitTargetCommandResponse({ ok: true, result: output }, {
      cmd: 'table',
      format: 'json',
      targetResolution: targetResolution(),
      console: { log, error: vi.fn() },
      process: { exitCode: 0 },
    });

    expect(log).toHaveBeenCalledOnce();
    const emitted = log.mock.calls[0][0];
    const model = JSON.parse(emitted);
    expect(Buffer.byteLength(emitted, 'utf8')).toBeLessThanOrEqual(16_384);
    expect(model).toMatchObject({
      schema: 'chrome-cdp-ex.tables.v1',
      snapshot: { tablesSeen: 1, tablesReturned: 1 },
      targetResolution: targetResolution(),
      tables: [{
        inline: { truncated: true },
        snapshot: { rowsAdmitted: 20 },
      }],
    });
    expect(model.tables[0].inline.rows.length).toBeLessThan(rows.length);
    expect(model.tables[0].inline.rows).toEqual(rows.slice(0, model.tables[0].inline.rows.length));
    expect(model.tables[0].inline.rowCount).toBe(model.tables[0].inline.rows.length);
    expect(model.tables[0].inline.bytes).toBe(Buffer.byteLength(model.tables[0].inline.rows.join('\n'), 'utf8'));
    expect(Object.keys(model).slice(0, 3)).toEqual(['schema', 'snapshot', 'targetResolution']);
  });

  it('bounds emitted table text by complete lines and treats the console newline as transport framing', () => {
    const summary = 'Table snapshot: 1 mounted table(s); bounded root-frame sample';
    const row = `1\t${'x'.repeat(700)}`;
    const payload = [summary, ...Array.from({ length: 20 }, () => row)].join('\n');
    const log = vi.fn();

    cdpTest.emitTargetCommandResponse({ ok: true, result: payload }, {
      cmd: 'table',
      format: 'text',
      console: { log, error: vi.fn() },
      process: { exitCode: 0 },
    });

    const emitted = log.mock.calls[0][0];
    expect(Buffer.byteLength(emitted, 'utf8')).toBeLessThanOrEqual(8192);
    expect(Buffer.byteLength(`${emitted}\n`, 'utf8')).toBeLessThanOrEqual(8193);
    expect(emitted.split('\n')[0]).toBe(summary);
    expect(emitted).toMatch(/emission limit/i);
    expect(emitted.split('\n').slice(1, -1).every(line => line === row)).toBe(true);
  });
});
