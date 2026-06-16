import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

import {
  buildGenericCdpRawBaseline,
  estimateTokenCount,
  parseGenericCdpBaselineArgs,
  runGenericCdpBaseline,
} from '../scripts/benchmark-generic-cdp-baseline.mjs';

describe('generic CDP baseline harness', () => {
  it('builds raw baseline results from generic CDP step samples', () => {
    const raw = buildGenericCdpRawBaseline({
      source: 'unit-generic-cdp',
      note: 'Fixture transcript.',
      steps: [
        {
          name: 'json-tabs',
          command: 'GET /json',
          startedAt: 0,
          endedAt: 4,
          output: '[{"title":"chrome-cdp-ex long-session smoke"}]',
        },
        {
          name: 'dom-summary',
          command: 'Runtime.evaluate',
          startedAt: 4,
          endedAt: 18,
          output: '{"title":"chrome-cdp-ex long-session smoke","clickables":["#combat","#diagnostic"],"text":"MOTD combat log"}',
        },
        {
          name: 'overlay-probe',
          command: 'Runtime.evaluate',
          probe: 'modalOverlay',
          startedAt: 18,
          endedAt: 25,
          output: '{"dialog":true}',
        },
        {
          name: 'frame-probe',
          command: 'Runtime.evaluate',
          probe: 'frameRefs',
          startedAt: 25,
          endedAt: 32,
          output: '{"frames":[{"name":"smoke-child"}]}',
        },
        {
          name: 'css-probe',
          command: 'Runtime.evaluate',
          probe: 'cssTrace',
          ok: false,
          startedAt: 32,
          endedAt: 40,
          output: '{"reason":"no source trace"}',
        },
        {
          name: 'hmr-probe',
          command: 'Runtime.evaluate',
          probe: 'hmrDomUpdate',
          ok: false,
          startedAt: 40,
          endedAt: 45,
          output: '{"reason":"no diff memory"}',
        },
      ],
    });

    const outputChars = raw.runs[0].details.steps.reduce((sum, step) => sum + step.outputChars, 0);

    expect(raw).toMatchObject({
      schema: 'chrome-cdp-ex.raw-baseline-results.v1',
      source: 'unit-generic-cdp',
      note: 'Fixture transcript.',
      runs: [
        {
          id: 'generic-cdp',
          label: 'Measured generic CDP harness',
          commandCalls: 6,
          usefulObservationTokens: estimateTokenCount(outputChars),
          verificationCallsSaved: 0,
          differentiatorSuccessRate: 0.5,
          autoEvidenceActions: 0,
          hasReportTimeline: false,
          staleRefRecoveryRate: 0,
          sessionStabilitySample: false,
          details: {
            totalMs: 45,
            differentiators: {
              modalOverlay: { success: true, commandCalls: 1 },
              frameRefs: { success: true, commandCalls: 1 },
              cssTrace: { success: false, commandCalls: 1 },
              hmrDomUpdate: { success: false, commandCalls: 1 },
            },
          },
        },
      ],
    });
  });

  it('parses CLI args for transcript input and output paths', () => {
    expect(parseGenericCdpBaselineArgs([
      '--from-steps',
      'steps.json',
      '--out',
      'raw.json',
      '--source',
      'ci-generic-cdp',
      '--note',
      'CI baseline',
      '--port',
      '9444',
      '--server-port',
      '41800',
    ])).toEqual({
      fromStepsPath: 'steps.json',
      outPath: 'raw.json',
      source: 'ci-generic-cdp',
      note: 'CI baseline',
      port: 9444,
      serverPort: 41800,
    });
  });

  it('writes raw baseline results from a transcript file', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'chrome-cdp-ex-generic-baseline-'));
    const stepsPath = resolve(dir, 'steps.json');
    const outPath = resolve(dir, 'raw.json');
    try {
      writeFileSync(stepsPath, JSON.stringify({
        steps: [
          { name: 'json-tabs', output: '[{"title":"T"}]' },
          { name: 'overlay-probe', probe: 'modalOverlay', output: '{"dialog":true}' },
        ],
      }));

      expect(await runGenericCdpBaseline([
        '--from-steps',
        stepsPath,
        '--out',
        outPath,
        '--source',
        'file-generic-cdp',
      ])).toBe(outPath);
      expect(JSON.parse(readFileSync(outPath, 'utf8'))).toMatchObject({
        schema: 'chrome-cdp-ex.raw-baseline-results.v1',
        source: 'file-generic-cdp',
        runs: [
          {
            id: 'generic-cdp',
            label: 'Measured generic CDP harness',
            commandCalls: 2,
          },
        ],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
