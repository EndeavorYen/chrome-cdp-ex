import { describe, expect, it } from 'vitest';

import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

describe('issue #270 record-actions password dispatchText redaction', () => {
  it('#270 record-actions JSON redacts dispatchText and sibling fields for a password-like fill', () => {
    const logPath = join(mkdtempSync(join(tmpdir(), 'cdp-p18w-pass-')), 'session.jsonl');
    const secret = 'dummy-secret-p18';
    const state = T.createSessionState({ targetId: 'P18WPASS', sessionId: 'sid-p18', logPath });

    T.appendSessionActionLog(state, T.createActionResult({
      action: 'fill',
      target: {
        input: '#p18w-pass',
        resolvedBy: 'selector',
        label: '#p18w-pass',
        commandArgs: ['#p18w-pass', secret],
        dispatchText: `Filled <INPUT> with "${secret}"`,
        controlStateDiff: `value "" → "${secret}"`,
      },
      dispatch: { ok: true, method: 'fill' },
      settle: { ok: true, durationMs: 42 },
      effects: {
        domDiff: `Control state changed: value "" → "${secret}"`,
        console: [],
        network: [],
        navigation: null,
      },
      nextHint: null,
    }));

    const json = T.formatRecordActions(state, { format: 'json' });
    const model = JSON.parse(json);
    const step = model.actions[0];
    const serialized = JSON.stringify(model);

    expect(serialized).not.toContain(secret);
    expect(step.command).toEqual(['fill', '#p18w-pass', '<redacted>']);
    expect(step.target.commandArgs).toEqual(['#p18w-pass', '<redacted>']);
    expect(step.target.redacted).toEqual(expect.arrayContaining(['commandArgs']));
    expect(step.replayable).toBe(false);
    expect(step.needsInput).toEqual(['text']);
    expect(String(step.target.dispatchText || '')).not.toContain(secret);
    expect(String(step.target.dispatchText || '')).toMatch(/<redacted>/);
    expect(JSON.stringify(step.target)).not.toContain(secret);
    expect(JSON.stringify(step.evidence || {})).not.toContain(secret);
    expect(readFileSync(logPath, 'utf8')).not.toContain(secret);
    expect(T.formatExportPlaywright(state)).not.toContain(secret);
  });
});
