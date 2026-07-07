import { describe, expect, it } from 'vitest';

import { parseBenchmarkSummaryJson, updateBenchmarkHtmlSnapshot, updateReadmeBenchmarkSnapshot } from '../scripts/update-readme-benchmark.mjs';

describe('README benchmark updater', () => {
  it('updates both README benchmark sections from a killer-path summary', () => {
    const readme = `# chrome-cdp-ex

## Smart Eye Proof

| Proof point | Latest local run |
|---|---:|
| Quality gate | **old** |
| Golden path complete | **old** |
| Useful observation tokens | **old** |
| Action evidence coverage | **old** |
| Differentiator success rate | **old** |

## Quick start

### Latest dogfood snapshot

Local run on 2026-01-01 against the same smoke page.

| Metric | Latest run |
|---|---:|
| Total time | old |
| Command calls | old |
| First useful observation | old |
| Golden path complete | old |
| Useful observation tokens | old |
| Action evidence coverage | old |
| Differentiator success rate | old |
| Stale-ref recovery | old |
| Quality gate | old |
`;

    const updated = updateReadmeBenchmarkSnapshot(readme, {
      metrics: {
        totalMs: 9615,
        commandCalls: 23,
        firstUsefulObservationMs: 3019,
        goldenPathMs: 5879,
        usefulObservationTokens: 1384,
        actionEvidenceCoverage: { covered: 9, total: 9, rate: 1 },
        differentiators: { successRate: 1 },
        staleRefRecovery: { durationMs: 40, recovered: 1, commandCalls: 1 },
      },
      gate: { passed: true, passedCount: 25, total: 25 },
    }, { runDate: '2026-06-17' });

    expect(updated).toContain('| Quality gate | **25/25 pass** |');
    expect(updated).toContain('| Golden path complete | **5.879s** |');
    expect(updated).toContain('| Useful observation tokens | **1,384** |');
    expect(updated).toContain('| Action evidence coverage | **100%** |');
    expect(updated).toContain('| Differentiator success rate | **100%** |');
    expect(updated).toContain('Local run on 2026-06-17 against the same smoke page.');
    expect(updated).toContain('| Total time | 9.615s |');
    expect(updated).toContain('| Command calls | 23 |');
    expect(updated).toContain('| First useful observation | 3.019s |');
    expect(updated).toContain('| Stale-ref recovery | 40ms, 1/1 recovered |');
  });

  it('parses npm-run output that prefixes the benchmark JSON', () => {
    const summary = parseBenchmarkSummaryJson('> node scripts/benchmark-killer-path.mjs --json\n{"metrics":{"commandCalls":23}}\n');

    expect(summary.metrics.commandCalls).toBe(23);
  });

  it('refuses to update README from a failed benchmark gate', () => {
    expect(() => updateReadmeBenchmarkSnapshot('README', {
      metrics: {},
      gate: { passed: false, passedCount: 24, total: 25 },
    })).toThrow('benchmark gate failed');
  });

  it('updates the visual benchmark page from the same summary', () => {
    const html = `
      <strong>old</strong>
      <span>quality gate passed on the 2026-01-01 local run</span>
      <div class="stat"><strong>old</strong><span>golden path complete</span></div>
      <div class="stat"><strong>old</strong><span><em>useful observation</em> tokens</span></div>
      <div class="stat"><strong>old</strong><span>action evidence coverage</span></div>
      <div class="stat"><strong>old</strong><span>stale-ref recovery</span></div>
      <span>First observation</span><div class="track"><div class="fill" style="width: 1%"></div></div><span>old</span>
      <span>Golden path</span><div class="track"><div class="fill" style="width: 1%"></div></div><span>old</span>
      <span>Total run</span><div class="track"><div class="fill" style="width: 100%"></div></div><span>old</span>
    `;

    const updated = updateBenchmarkHtmlSnapshot(html, {
      metrics: {
        totalMs: 10104,
        firstUsefulObservationMs: 3391,
        goldenPathMs: 6361,
        usefulObservationTokens: 1384,
        actionEvidenceCoverage: { rate: 1 },
        staleRefRecovery: { durationMs: 50 },
      },
      gate: { passed: true, passedCount: 25, total: 25 },
    }, { runDate: '2026-06-17' });

    expect(updated).toContain('<strong>25/25</strong>');
    expect(updated).toContain('quality gate passed<br>2026-06-17 local run');
    expect(updated).toContain('<strong>6.361s</strong><span>golden path complete</span>');
    expect(updated).toContain('<strong>1,384</strong><span><em>useful observation</em> tokens</span>');
    expect(updated).toContain('<strong>100%</strong><span>action evidence coverage</span>');
    expect(updated).toContain('<strong>50ms</strong><span>stale-ref recovery</span>');
    expect(updated).toContain('<span>3.391s</span>');
    expect(updated).toContain('<span>10.104s</span>');
  });

  it('updates README and benchmark page from a live campaign summary', () => {
    const campaign = {
      schema: 'chrome-cdp-ex.live-campaign.v1',
      roundsCompleted: 3,
      passCount: 3,
      typeSummaries: [{
        type: 'real-app',
        avgTotalMs: 10161,
        avgFirstUsefulObservationMs: 2187,
        avgFirstActionEvidenceMs: 3015,
        avgEstimatedOutputTokens: 12677,
        avgUsefulObservationTokens: 1637,
        maxStepEstimatedTokens: 1113,
        realAppTargets: { targets: ['auth-flow', 'dashboard', 'docs-app'] },
      }],
      rounds: [
        {
          type: 'real-app',
          gatePassed: true,
          gate: { passed: true, passedCount: 33, total: 33 },
          metrics: {
            commandCalls: 24,
            goldenPathMs: 5256,
            autoEvidenceActions: 6,
            realAppTarget: { traits: ['stale-ref'] },
          },
        },
        {
          type: 'real-app',
          gatePassed: true,
          gate: { passed: true, passedCount: 33, total: 33 },
          metrics: {
            commandCalls: 24,
            goldenPathMs: 5197,
            autoEvidenceActions: 6,
            realAppTarget: { traits: ['stale-ref'] },
          },
        },
        {
          type: 'real-app',
          gatePassed: true,
          gate: { passed: true, passedCount: 33, total: 33 },
          metrics: {
            commandCalls: 24,
            goldenPathMs: 5200,
            autoEvidenceActions: 6,
            realAppTarget: { traits: ['stale-ref'] },
          },
        },
      ],
    };
    const readme = `# chrome-cdp-ex

[![Release v2.9.0](https://img.shields.io/badge/release-v2.9.0-brightgreen)](release)

## Smart Eye Proof

| Proof point | Latest local run |
|---|---:|
| Release proof | **old** |
| Real-app targets | **old** |
| Campaign pass rate | **old** |
| Quality gate | **old** |
| First useful observation | **old** |
| First action evidence | **old** |
| Useful observation tokens | **old** |
| Max step output | **old** |

## Quick start

### Latest dogfood snapshot

Local run on 2026-01-01 against three safe local real-app fixtures: old.

| Metric | Latest run |
|---|---:|
| Total time | old |
| Command calls | old |
| First useful observation | old |
| First action evidence | old |
| Golden path complete | old |
| Estimated output tokens | old |
| Useful observation tokens | old |
| Action evidence coverage | old |
| Real-app targets | old |
| Stale-ref recovery | old |
| Quality gate | old |

Regenerate this table
`;
    const html = `
      <strong>old</strong>
      <span>quality gate passed in each real-app round<br>2026-01-01 local run</span>
      <div class="stat"><strong>old</strong><span>real-app targets passed</span></div>
      <div class="stat"><strong>old</strong><span>first useful observation avg</span></div>
      <div class="stat"><strong>old</strong><span>first action evidence avg</span></div>
      <div class="stat"><strong>old</strong><span><em>useful observation</em> tokens avg</span></div>
      <span>First observation avg</span><div class="track"><div class="fill" style="width: 1%"></div></div><span>old</span>
      <span>First action evidence</span><div class="track"><div class="fill" style="width: 1%"></div></div><span>old</span>
      <span>Golden path avg</span><div class="track"><div class="fill" style="width: 1%"></div></div><span>old</span>
      <span>Total run avg</span><div class="track"><div class="fill" style="width: 100%"></div></div><span>old</span>
    `;

    const updatedReadme = updateReadmeBenchmarkSnapshot(readme, campaign, { runDate: '2026-07-08' });
    const updatedHtml = updateBenchmarkHtmlSnapshot(html, campaign, { runDate: '2026-07-08' });

    expect(updatedReadme).toContain('| Quality gate | **33/33 pass in each round** |');
    expect(updatedReadme).toContain('| First action evidence | **3.015s avg** |');
    expect(updatedReadme).toContain('| Max step output | **1,113 tokens** |');
    expect(updatedReadme).toContain('Local run on 2026-07-08 against three safe local real-app fixtures: dashboard, docs-app, auth-flow.');
    expect(updatedReadme).toContain('| Golden path complete | 5.218s avg |');
    expect(updatedReadme).toContain('| Action evidence coverage | 6 auto-evidence actions per round; no failed criteria |');
    expect(updatedHtml).toContain('<strong>33/33</strong>');
    expect(updatedHtml).toContain('<strong>3/3</strong><span>real-app targets passed</span>');
    expect(updatedHtml).toContain('<span>5.218s</span>');
    expect(updatedHtml).toContain('<span>10.161s</span>');
  });
});
