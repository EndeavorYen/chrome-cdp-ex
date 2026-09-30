import { describe, expect, it } from 'vitest';

import { topSelfTime } from '../scripts/profile-cli-call.mjs';

const profile = {
  nodes: [
    { id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: -1 } },
    { id: 2, callFrame: { functionName: 'discover', url: 'file:///x/cdp.mjs', lineNumber: 99 } },
    { id: 3, callFrame: { functionName: '', url: 'file:///x/lib/a.mjs', lineNumber: 4 } },
  ],
  samples: [2, 2, 3, 1],
  timeDeltas: [3000, 3000, 2000, 2000],
};

describe('topSelfTime', () => {
  it('sums self time per node, sorts descending and reports percentages', () => {
    expect(topSelfTime(profile, 5)).toEqual([
      { fn: 'discover', where: 'cdp.mjs:100', ms: 6, pct: 60 },
      { fn: '(anonymous)', where: 'a.mjs:5', ms: 2, pct: 20 },
      { fn: '(root)', where: ':0', ms: 2, pct: 20 },
    ]);
  });

  it('respects the limit', () => {
    expect(topSelfTime(profile, 1)).toHaveLength(1);
  });
});
