import { describe, expect, it, vi } from 'vitest';
import { executeCdpCli } from '../skills/chrome-cdp-ex/scripts/cdp.mjs';
import { createMcpRequestHandler } from '../skills/chrome-cdp-ex/scripts/mcp-server.mjs';
import { createRuntimeClient } from '../skills/chrome-cdp-ex/scripts/lib/runtime-client.mjs';
import { attachTargetResolutionDiagnostics } from '../skills/chrome-cdp-ex/scripts/lib/target-binding.mjs';

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

function observedTable(rows, overrides = {}) {
  return {
    schema: 'chrome-cdp-ex.table.v1',
    logicalRows: 200,
    logicalCountSource: 'aria-rowcount',
    identitySource: 'aria-rowindex',
    orderingSource: 'aria-rowindex',
    mountedRows: rows.length,
    collectedRows: rows.length,
    recycledMountedNodes: 0,
    completeness: { state: 'incomplete', termination: 'observation', evidenceConflict: false },
    caption: 'Orders',
    headers: [['Id', 'Value']],
    snapshot: {
      directRowsSeen: rows.length + 1,
      headerRowsSeen: 1,
      dataRowsSeen: rows.length,
      rowsAdmitted: rows.length,
      truncated: false,
      truncationReason: null,
    },
    inline: {
      rows,
      rowCount: rows.length,
      bytes: Buffer.byteLength(rows.join('\n'), 'utf8'),
      truncated: false,
    },
    ...overrides,
  };
}

function tableObservationPayload() {
  const rows = Array.from({ length: 20 }, (_, index) => `${index + 1}\t${'x'.repeat(740)}`);
  const table = observedTable(rows);
  const output = JSON.stringify({
    schema: 'chrome-cdp-ex.tables.v1',
    snapshot: { tablesSeen: 1, tablesReturned: 1, truncated: false, truncationReason: null },
    tables: [table],
  }, null, 2);
  expect(Buffer.byteLength(output, 'utf8')).toBeLessThanOrEqual(16_384);
  expect(Buffer.byteLength(attachTargetResolutionDiagnostics(output, targetResolution()), 'utf8'))
    .toBeGreaterThan(16_384);
  return { output, rows };
}

function trailingTablePayload() {
  const rows = Array.from({ length: 15 }, (_, index) => `${index + 1}\t${'a'.repeat(650)}`);
  const first = observedTable(rows, { caption: 'First' });
  const second = observedTable([], {
    caption: 'Second',
    logicalRows: null,
    logicalCountSource: 'none',
    identitySource: 'snapshot-order',
    orderingSource: 'dom-order',
    mountedRows: 0,
    collectedRows: 0,
    completeness: { state: 'unknown', termination: 'observation', evidenceConflict: false },
    snapshot: {
      directRowsSeen: 1,
      headerRowsSeen: 1,
      dataRowsSeen: 0,
      rowsAdmitted: 0,
      truncated: false,
      truncationReason: null,
    },
  });
  const model = {
    schema: 'chrome-cdp-ex.tables.v1',
    snapshot: { tablesSeen: 2, tablesReturned: 2, truncated: false, truncationReason: null },
    tables: [first, second],
  };
  const emptyBytes = Buffer.byteLength(JSON.stringify(model, null, 2), 'utf8');
  second.headers = [['h'.repeat(Math.max(0, 16_200 - emptyBytes))]];
  const output = JSON.stringify(model, null, 2);
  expect(Buffer.byteLength(output, 'utf8')).toBeLessThanOrEqual(16_384);
  expect(Buffer.byteLength(attachTargetResolutionDiagnostics(output, targetResolution()), 'utf8'))
    .toBeGreaterThan(16_384);
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

  it('drops an empty trailing table preview before removing earlier table rows', () => {
    const { output, rows } = trailingTablePayload();
    const log = vi.fn();

    cdpTest.emitTargetCommandResponse({ ok: true, result: output }, {
      cmd: 'table',
      format: 'json',
      targetResolution: targetResolution(),
      console: { log, error: vi.fn() },
      process: { exitCode: 0 },
    });

    const emitted = log.mock.calls[0][0];
    const model = JSON.parse(emitted);
    expect(Buffer.byteLength(emitted, 'utf8')).toBeLessThanOrEqual(16_384);
    expect(model.tables).toHaveLength(1);
    expect(model.tables[0].inline.rows).toEqual(rows);
    expect(model.snapshot).toEqual({
      tablesSeen: 2,
      tablesReturned: 1,
      truncated: true,
      truncationReason: 'sample-byte-limit',
    });
  });

  it('keeps exact final JSON parity through direct CLI capture and MCP run_command', async () => {
    const { output } = tableObservationPayload();
    const direct = await executeCdpCli(['table', 'ABC12345', '#grid', '--format', 'json'], {
      runMain: async ({ console, process }) => {
        cdpTest.emitTargetCommandResponse({ ok: true, result: output }, {
          cmd: 'table',
          format: 'json',
          targetResolution: targetResolution(),
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
      id: 151,
      method: 'tools/call',
      params: {
        name: 'run_command',
        arguments: { command: 'table', args: ['ABC12345', '#grid', '--format', 'json'] },
      },
    });

    expect(direct.code).toBe(0);
    expect(Buffer.byteLength(direct.stdout, 'utf8')).toBeLessThanOrEqual(16_384);
    expect(sent[0].result).toEqual({
      content: [{ type: 'text', text: direct.stdout }],
      isError: false,
    });
  });
});
