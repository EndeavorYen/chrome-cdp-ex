import { describe, expect, it } from 'vitest';

import { autoActionJsonArgs } from '../skills/chrome-cdp-ex/scripts/lib/action-evidence.mjs';

const commands = [
  { name: 'click', mutates: true, feedbackPolicy: 'auto', outputFormats: ['text', 'json'] },
  { name: 'summary', mutates: false, outputFormats: ['text', 'json'] },
];

describe('action evidence helpers', () => {
  it('adds JSON output only for mutating commands that support action handoffs', () => {
    expect(autoActionJsonArgs('click', ['#ok'], true, { commands })).toEqual(['#ok', '--format', 'json']);
    expect(autoActionJsonArgs('summary', [], true, { commands })).toEqual([]);
    expect(autoActionJsonArgs('click', ['#ok', '--format', 'text'], true, { commands })).toEqual(['#ok', '--format', 'text']);
  });
});
