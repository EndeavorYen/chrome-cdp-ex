import { describe, expect, it } from 'vitest';

import { parseTrace, segmentsFromTrace } from '../scripts/probe-cli-preamble.mjs';

const trace = [
  '   20.0  preload-start (ms since process timeOrigin)',
  '   80.0  net.connect a1 [{"path":"pipe-cdp-X"},null]',
  '   80.5  net.write a1 26B {"cmd":"list_raw","id":1}',
  '   90.0  net.connect b2 [{"path":"pipe-cdp-X"},null]',
  '   90.5  net.write b2 32B {"cmd":"meta","args":[],"id":1}',
  '  100.0  net.connect c3 [{"path":"pipe-cdp-X"},null]',
  '  120.0  net.write c3 32B {"cmd":"meta","args":[],"id":1}',
  '  121.0  net.connect d4 [{"path":"pipe-cdp-X"},null]',
  '  121.5  net.write d4 48B {"cmd":"eval","args":["1"],"id":1}',
  '  124.5  net.firstdata d4 31B {"ok":true}',
  '  175.0  cpu user=100.0 sys=20.0',
  '  175.0  exit',
].join('\n');

describe('segmentsFromTrace', () => {
  it('splits a call into boot, load, discovery, git gap, eval round trip and shutdown tail', () => {
    expect(segmentsFromTrace(parseTrace(trace))).toEqual({
      boot_to_preload: 20,
      module_load: 60,
      discoveries_ms: [10],
      discoveries_total: 10,
      git_gap: 20,
      eval_rtt: 3,
      tail_after_eval: 50.5,
      exit_at: 175,
      cpu_ms: 120,
    });
  });
});
