import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

import {
  buildComparisonBaselineFile,
  parseBaselineBuilderArgs,
  runBaselineBuilder,
} from '../scripts/benchmark-baseline-builder.mjs';

describe('benchmark baseline builder', () => {
  it('normalizes raw harness results into comparison-baselines v1', () => {
    const out = buildComparisonBaselineFile({
      schema: 'chrome-cdp-ex.raw-baseline-results.v1',
      source: 'measured-local-baseline',
      note: 'Measured by local harnesses.',
      runs: [
        {
          id: 'playwright',
          label: 'Measured Playwright harness',
          commandCalls: 24,
          usefulObservationTokens: 4200,
          verificationCallsSaved: 0,
          differentiatorSuccessRate: 0.5,
        },
        {
          id: 'generic-cdp',
          label: 'Measured generic CDP harness',
          metrics: {
            commandCalls: 29,
            usefulObservationTokens: 6500,
            verificationCallsSaved: 0,
            differentiatorSuccessRate: 0.25,
          },
        },
      ],
    });

    expect(out).toEqual({
      schema: 'chrome-cdp-ex.comparison-baselines.v1',
      source: 'measured-local-baseline',
      note: 'Measured by local harnesses.',
      baselines: [
        {
          id: 'playwright',
          label: 'Measured Playwright harness',
          metrics: {
            commandCalls: 24,
            usefulObservationTokens: 4200,
            verificationCallsSaved: 0,
            differentiatorSuccessRate: 0.5,
          },
        },
        {
          id: 'generic-cdp',
          label: 'Measured generic CDP harness',
          metrics: {
            commandCalls: 29,
            usefulObservationTokens: 6500,
            verificationCallsSaved: 0,
            differentiatorSuccessRate: 0.25,
          },
        },
      ],
    });
  });

  it('rejects invalid raw baseline schemas', () => {
    expect(() => buildComparisonBaselineFile({
      schema: 'wrong',
      runs: [],
    })).toThrow(/raw-baseline-results\.v1/);
  });

  it('preserves optional capability metrics for capability-aware comparisons', () => {
    const out = buildComparisonBaselineFile({
      schema: 'chrome-cdp-ex.raw-baseline-results.v1',
      runs: [
        {
          id: 'generic-cdp',
          commandCalls: 8,
          usefulObservationTokens: 2041,
          verificationCallsSaved: 0,
          differentiatorSuccessRate: 1,
          autoEvidenceActions: 0,
          hasReportTimeline: false,
          staleRefRecoveryRate: 0,
          sessionStabilitySample: false,
        },
      ],
    });

    expect(out.baselines[0].metrics).toMatchObject({
      commandCalls: 8,
      usefulObservationTokens: 2041,
      verificationCallsSaved: 0,
      differentiatorSuccessRate: 1,
      autoEvidenceActions: 0,
      hasReportTimeline: false,
      staleRefRecoveryRate: 0,
      sessionStabilitySample: false,
    });
  });

  it('parses CLI args for input, output, source, and note', () => {
    expect(parseBaselineBuilderArgs([
      'raw.json',
      'raw-2.json',
      '--out',
      'baselines.json',
      '--source',
      'ci-measured',
      '--note',
      'CI run',
    ])).toEqual({
      inputPath: 'raw.json',
      inputPaths: ['raw.json', 'raw-2.json'],
      outPath: 'baselines.json',
      source: 'ci-measured',
      note: 'CI run',
    });
  });

  it('writes a comparison baseline file from CLI-style args', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'chrome-cdp-ex-baseline-builder-'));
    const rawPath = resolve(dir, 'raw.json');
    const outPath = resolve(dir, 'baselines.json');
    try {
      writeFileSync(rawPath, JSON.stringify({
        schema: 'chrome-cdp-ex.raw-baseline-results.v1',
        runs: [
          { id: 'playwright', commandCalls: 24, usefulObservationTokens: 4200 },
        ],
      }));

      expect(runBaselineBuilder([rawPath, '--out', outPath, '--source', 'ci-measured'])).toBe(outPath);
      expect(JSON.parse(readFileSync(outPath, 'utf8'))).toMatchObject({
        schema: 'chrome-cdp-ex.comparison-baselines.v1',
        source: 'ci-measured',
        baselines: [
          {
            id: 'playwright',
            metrics: {
              commandCalls: 24,
              usefulObservationTokens: 4200,
            },
          },
        ],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('merges multiple raw baseline files from CLI-style args', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'chrome-cdp-ex-baseline-builder-'));
    const playwrightPath = resolve(dir, 'playwright-raw.json');
    const genericPath = resolve(dir, 'generic-cdp-raw.json');
    const outPath = resolve(dir, 'baselines.json');
    try {
      writeFileSync(playwrightPath, JSON.stringify({
        schema: 'chrome-cdp-ex.raw-baseline-results.v1',
        source: 'measured-playwright-baseline',
        runs: [
          {
            id: 'playwright',
            commandCalls: 12,
            usefulObservationTokens: 3000,
            autoEvidenceActions: 0,
            hasReportTimeline: false,
            staleRefRecoveryRate: 0,
            sessionStabilitySample: false,
          },
        ],
      }));
      writeFileSync(genericPath, JSON.stringify({
        schema: 'chrome-cdp-ex.raw-baseline-results.v1',
        source: 'measured-generic-cdp-baseline',
        runs: [
          {
            id: 'generic-cdp',
            commandCalls: 8,
            usefulObservationTokens: 2000,
            autoEvidenceActions: 0,
            hasReportTimeline: false,
            staleRefRecoveryRate: 0,
            sessionStabilitySample: false,
          },
        ],
      }));

      expect(runBaselineBuilder([
        playwrightPath,
        genericPath,
        '--out',
        outPath,
      ])).toBe(outPath);
      expect(JSON.parse(readFileSync(outPath, 'utf8'))).toMatchObject({
        schema: 'chrome-cdp-ex.comparison-baselines.v1',
        source: 'merged-measured-baselines',
        note: 'Merged measured baselines from measured-playwright-baseline and measured-generic-cdp-baseline.',
        baselines: [
          {
            id: 'playwright',
            metrics: {
              commandCalls: 12,
              usefulObservationTokens: 3000,
              autoEvidenceActions: 0,
              hasReportTimeline: false,
            },
          },
          {
            id: 'generic-cdp',
            metrics: {
              commandCalls: 8,
              usefulObservationTokens: 2000,
              staleRefRecoveryRate: 0,
              sessionStabilitySample: false,
            },
          },
        ],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
