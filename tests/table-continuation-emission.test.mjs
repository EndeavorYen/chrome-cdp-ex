import { describe, expect, it, vi } from 'vitest';

import { attachTargetResolutionDiagnostics } from '../skills/chrome-cdp-ex/scripts/lib/target-binding.mjs';

const { __test__: cdpTest } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

function continuationPayload(bytes = 16_200) {
  const model = {
    schema: 'chrome-cdp-ex.table.v1',
    artifact: { id: '0123456789abcdef0123456789abcdef' },
    continuation: {
      token: 'ct1.0123456789abcdef0123456789abcdef.0',
      offset: 0,
      rowCount: 1,
      rows: [''],
      bytes: 0,
      nextToken: null,
    },
  };
  const empty = JSON.stringify(model, null, 2);
  let rowBytes = bytes - Buffer.byteLength(empty, 'utf8');
  for (let attempt = 0; attempt < 4; attempt += 1) {
    model.continuation.rows[0] = 'x'.repeat(rowBytes);
    model.continuation.bytes = rowBytes;
    const actual = Buffer.byteLength(JSON.stringify(model, null, 2), 'utf8');
    if (actual === bytes) break;
    rowBytes += bytes - actual;
  }
  const output = JSON.stringify(model, null, 2);
  expect(Buffer.byteLength(output, 'utf8')).toBe(bytes);
  return output;
}

function resolution(suffix) {
  return {
    requestedTargetPrefix: `TARGET-${suffix}`,
    requestedTargetId: `target-${suffix}`,
    boundTargetId: `target-${suffix}`,
    resolvedTargetId: `target-${suffix}`,
    resolutionSource: 'live-discovery',
    status: 'reused',
    rebound: false,
  };
}

describe('table continuation public emission', () => {
  it('preserves a deterministic bounded continuation payload across volatile target diagnostics', () => {
    const payload = continuationPayload();
    expect(Buffer.byteLength(
      attachTargetResolutionDiagnostics(payload, resolution('first')),
      'utf8',
    )).toBeGreaterThan(16_384);

    const first = vi.fn();
    const second = vi.fn();
    cdpTest.emitTargetCommandResponse({ ok: true, result: payload }, {
      cmd: 'table',
      format: 'json',
      targetResolution: resolution('first'),
      console: { log: first, error: vi.fn() },
      process: { exitCode: 0 },
    });
    cdpTest.emitTargetCommandResponse({ ok: true, result: payload }, {
      cmd: 'table',
      format: 'json',
      targetResolution: resolution('second'),
      console: { log: second, error: vi.fn() },
      process: { exitCode: 0 },
    });

    expect(first).toHaveBeenCalledExactlyOnceWith(payload);
    expect(second).toHaveBeenCalledExactlyOnceWith(payload);
    expect(Buffer.byteLength(first.mock.calls[0][0], 'utf8')).toBeLessThanOrEqual(16_384);
    expect(first.mock.calls[0][0]).toBe(second.mock.calls[0][0]);
    expect(first.mock.calls[0][0]).not.toContain('targetResolution');
  });
});
