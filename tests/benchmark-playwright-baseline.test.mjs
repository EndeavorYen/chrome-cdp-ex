import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

import {
  buildPlaywrightRawBaseline,
  estimateTokenCount,
  parsePlaywrightBaselineArgs,
  runPlaywrightBaseline,
} from '../scripts/benchmark-playwright-baseline.mjs';

describe('Playwright baseline harness', () => {
  it('builds raw baseline results from Playwright step samples', () => {
    const raw = buildPlaywrightRawBaseline({
      source: 'unit-playwright',
      note: 'Fixture transcript.',
      steps: [
        {
          name: 'navigate',
          command: 'page.goto',
          startedAt: 0,
          endedAt: 20,
          output: '{"title":"chrome-cdp-ex long-session smoke"}',
        },
        {
          name: 'snapshot',
          command: 'page.locator("body").innerText',
          startedAt: 20,
          endedAt: 36,
          output: 'MOTD combat log Run combat Run diagnostic',
        },
        {
          name: 'modal-probe',
          command: 'page.getByRole("dialog")',
          probe: 'modalOverlay',
          startedAt: 36,
          endedAt: 42,
          output: '{"visible":true,"name":"MOTD"}',
        },
        {
          name: 'frame-probe',
          command: 'page.frameLocator',
          probe: 'frameRefs',
          startedAt: 42,
          endedAt: 50,
          output: '{"frame":"Smoke child frame","button":"Child action"}',
        },
        {
          name: 'css-probe',
          command: 'locator.evaluate(getComputedStyle)',
          probe: 'cssTrace',
          ok: false,
          startedAt: 50,
          endedAt: 56,
          output: '{"cursor":"pointer","sourceTrace":false}',
        },
        {
          name: 'hmr-probe',
          command: 'page.locator("#combat-log").innerText',
          probe: 'hmrDomUpdate',
          startedAt: 56,
          endedAt: 64,
          output: 'hmr panel ready',
        },
      ],
    });

    const outputChars = raw.runs[0].details.steps.reduce((sum, step) => sum + step.outputChars, 0);

    expect(raw).toMatchObject({
      schema: 'chrome-cdp-ex.raw-baseline-results.v1',
      source: 'unit-playwright',
      note: 'Fixture transcript.',
      runs: [
        {
          id: 'playwright',
          label: 'Measured Playwright harness',
          commandCalls: 6,
          usefulObservationTokens: estimateTokenCount(outputChars),
          verificationCallsSaved: 0,
          differentiatorSuccessRate: 0.75,
          autoEvidenceActions: 0,
          hasReportTimeline: false,
          staleRefRecoveryRate: 0,
          sessionStabilitySample: false,
          details: {
            totalMs: 64,
            differentiators: {
              modalOverlay: { success: true, commandCalls: 1 },
              frameRefs: { success: true, commandCalls: 1 },
              cssTrace: { success: false, commandCalls: 1 },
              hmrDomUpdate: { success: true, commandCalls: 1 },
            },
          },
        },
      ],
    });
  });

  it('parses CLI args for transcript input and live browser options', () => {
    expect(parsePlaywrightBaselineArgs([
      '--from-steps',
      'steps.json',
      '--out',
      'raw.json',
      '--source',
      'ci-playwright',
      '--note',
      'CI baseline',
      '--server-port',
      '41810',
      '--headed',
    ])).toEqual({
      fromStepsPath: 'steps.json',
      outPath: 'raw.json',
      source: 'ci-playwright',
      note: 'CI baseline',
      serverPort: 41810,
      headed: true,
    });
  });

  it('writes raw baseline results from a transcript file', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'chrome-cdp-ex-playwright-baseline-'));
    const stepsPath = resolve(dir, 'steps.json');
    const outPath = resolve(dir, 'raw.json');
    try {
      writeFileSync(stepsPath, JSON.stringify({
        steps: [
          { name: 'navigate', output: '{"title":"T"}' },
          { name: 'modal-probe', probe: 'modalOverlay', output: '{"visible":true}' },
        ],
      }));

      expect(await runPlaywrightBaseline([
        '--from-steps',
        stepsPath,
        '--out',
        outPath,
        '--source',
        'file-playwright',
      ])).toBe(outPath);
      expect(JSON.parse(readFileSync(outPath, 'utf8'))).toMatchObject({
        schema: 'chrome-cdp-ex.raw-baseline-results.v1',
        source: 'file-playwright',
        runs: [
          {
            id: 'playwright',
            label: 'Measured Playwright harness',
            commandCalls: 2,
          },
        ],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
