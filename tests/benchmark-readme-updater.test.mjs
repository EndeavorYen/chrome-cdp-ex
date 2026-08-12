import { describe, expect, it } from 'vitest';

import { parseBenchmarkSummaryJson, updateBenchmarkHtmlSnapshot, updateReadmeBenchmarkSnapshot } from '../scripts/update-readme-benchmark.mjs';

function releaseCandidateIdentity(digestCharacter = 'a') {
  return {
    schema: 'chrome-cdp-ex.candidate-identity.v1',
    productVersion: '2.15.0',
    algorithm: 'sha256',
    sourceDigest: `sha256:${digestCharacter.repeat(64)}`,
    fileCount: 20,
  };
}

function releaseCampaignFixture() {
  const identity = releaseCandidateIdentity();
  const types = ['mcp', 'cli', 'killer', 'large-app', 'real-app', 'real-app', 'real-app', 'real-app', 'real-app', 'cli'];
  const targets = ['dashboard', 'docs-app', 'auth-flow', 'data-table', 'canvas-heavy'];
  let targetIndex = 0;
  return {
    identity,
    campaign: {
      schema: 'chrome-cdp-ex.live-campaign.v1',
      candidate: identity,
      plannedRounds: 10,
      roundsCompleted: 10,
      passCount: 10,
      failCount: 0,
      passRate: 1,
      failurePatterns: [],
      typeSummaries: [{
        type: 'real-app',
        avgTotalMs: 10278,
        avgFirstUsefulObservationMs: 2169,
        avgFirstActionEvidenceMs: 2858,
        avgEstimatedOutputTokens: 11422,
        avgUsefulObservationTokens: 1732,
        maxStepEstimatedTokens: 1132,
        realAppTargets: { targets },
      }],
      rounds: types.map((type, index) => {
        const realAppTarget = type === 'real-app' ? targets[targetIndex++] : null;
        return {
          round: index + 1,
          type,
          realAppTarget,
          success: true,
          runSuccess: true,
          gatePassed: true,
          gate: { passed: true, passedCount: type === 'real-app' ? 34 : 10, total: type === 'real-app' ? 34 : 10 },
          metrics: {
            commandCalls: 24,
            goldenPathMs: 5353,
            autoEvidenceActions: 6,
            realAppTarget: realAppTarget ? { name: realAppTarget, traits: ['stale-ref'] } : null,
          },
        };
      }),
    },
  };
}

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

  it('rejects an invalid explicit release version instead of falling back', () => {
    expect(() => updateReadmeBenchmarkSnapshot('[release](release-v2.15.0)', {
      schema: 'chrome-cdp-ex.live-campaign.v1',
      roundsCompleted: 1,
      passCount: 1,
      typeSummaries: [{ type: 'real-app', realAppTargets: { targets: [] } }],
      rounds: [{ type: 'real-app', gatePassed: true, metrics: {} }],
    }, { releaseVersion: 'latest' })).toThrow('releaseVersion must be X.Y.Z');
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
    const { campaign, identity } = releaseCampaignFixture();
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

    const options = { runDate: '2026-07-08', releaseVersion: '2.15.0', currentCandidate: identity };
    const updatedReadme = updateReadmeBenchmarkSnapshot(readme, campaign, options);
    const updatedHtml = updateBenchmarkHtmlSnapshot(html, campaign, options);

    expect(updatedReadme).toContain('| Quality gate | **34/34 pass in each real-app round** |');
    expect(updatedReadme).toContain('| First action evidence | **2.858s avg** |');
    expect(updatedReadme).toContain('| Max step output | **1,132 tokens** |');
    expect(updatedReadme).toContain('Local run on 2026-07-08 against 5 safe local real-app fixtures: dashboard, docs-app, auth-flow, data-table, canvas-heavy.');
    expect(updatedReadme).toContain('| Golden path complete | 5.353s avg |');
    expect(updatedReadme).toContain('| Action evidence coverage | 6 auto-evidence actions per round; no failed criteria |');
    expect(updatedHtml).toContain('<strong>34/34</strong>');
    expect(updatedHtml).toContain('<strong>5/5</strong><span>real-app targets passed</span>');
    expect(updatedHtml).toContain('<span>5.353s</span>');
    expect(updatedHtml).toContain('<span>10.278s</span>');
  });

  it('promotes current benchmark copy without relabeling host-installation evidence', () => {
    const { campaign, identity } = releaseCampaignFixture();
    const readme = `
[![Release v2.15.0](release-v2.15.0)](release)
> **Evidence boundary:** v2.14.0 previously live-validated the Codex CLI-skill route on one disposable local fixture. The current v2.15.0 manifest remains \`documented\` until this exact candidate is rerun. Claude Code, Cursor, OpenClaw, Hermes, and Pi have documented install routes; this does not claim that every route was live-tested. Benchmark "real-app" profiles are local fixtures, not external production apps.

## Proof, with boundaries
| Evidence | What it proves |
|---|---|
| [Smart Eye benchmark](benchmark.html) | Previous-release baseline: the v2.14.0 mixed local campaign passed 10/10 rounds, including five local fixture profiles — not external production apps; v2.15.0 must rerun before promotion |

### Latest dogfood snapshot
Previous-release baseline: local run on 2026-01-01 for v2.14.0 against 5 safe local real-app fixtures: old. These are not external production apps. The v2.15.0 candidate must rerun this gate before promotion. Timing starts after CDP is reachable. Publish competitor deltas only from measured baselines.
| Metric | Latest measured run |
|---|---:|
| Total time | old |
| Real-app targets | old |
| Quality gate | old |
Regenerate this table
`;
    const html = `
      <div class="eyebrow">Smart Eye benchmark · previous-release baseline</div>
      <p class="lead">Previous-release baseline: <strong>v2.14.0</strong> (2026-01-01). It passed 10/10 rounds across safe local profiles. The v2.15.0 candidate must rerun before promotion.</p>
      <strong>old</strong>
      <span>quality gate passed in each real-app round<br>2026-01-01 local run · v2.14.0 previous baseline</span>
      <a class="link" href="https://github.com/example/releases/tag/v2.14.0">v2.14.0 product</a>
      <a class="link" href="https://github.com/example/releases/tag/v2.14.0">v2.14.0 measured campaign</a>
    `;

    const options = { runDate: '2026-08-12', releaseVersion: '2.15.0', currentCandidate: identity };
    const updatedReadme = updateReadmeBenchmarkSnapshot(readme, campaign, options);
    const updatedHtml = updateBenchmarkHtmlSnapshot(html, campaign, options);

    expect(updatedReadme).toContain('v2.14.0 previously live-validated the Codex CLI-skill route on one disposable local fixture');
    expect(updatedReadme).toContain('v2.15.0 mixed local campaign passed 10/10 rounds');
    expect(updatedReadme).toContain('Latest measured release: local run on 2026-08-12 for v2.15.0 against 5 safe local real-app fixtures');
    expect(updatedReadme).not.toContain('must rerun');
    expect(updatedReadme).not.toContain('Previous-release baseline');
    expect(updatedHtml).toContain('Smart Eye benchmark · latest measured release');
    expect(updatedHtml).toContain('Latest measured release: <strong>v2.15.0</strong> (2026-08-12).');
    expect(updatedHtml).toContain('2026-08-12 local run · v2.15.0 campaign');
    expect(updatedHtml).toContain('releases/tag/v2.15.0">v2.15.0 product</a>');
    expect(updatedHtml).toContain('releases/tag/v2.15.0">v2.15.0 measured campaign</a>');
    expect(updatedHtml).not.toContain('must rerun');
    expect(updatedHtml).not.toContain('previous-release baseline');
  });

  it('promotes an explicitly historical benchmark while preserving the Phase 1 host boundary', () => {
    const { campaign, identity } = releaseCampaignFixture();
    const readme = `
[![Release v2.15.0](release-v2.15.0)](release)
> **Evidence boundary:** Phase 1 candidate evidence: v2.15.0 live-validated the Codex CLI-skill route on one disposable local fixture. Candidate digest sha256:802f7add…; these measurements are historical for the current tree. A fresh campaign is required before any current-tree or release claim.

## Proof, with boundaries
| Evidence | What it proves |
|---|---|
| [Smart Eye benchmark](benchmark.html) | Phase 1 candidate measurement: the v2.15.0 mixed local campaign passed 10/10 rounds, including five local fixture profiles. Historical for the current tree; rerun required before release. |

### Latest dogfood snapshot
Phase 1 candidate snapshot: local run on 2026-08-12 for v2.15.0 against 5 safe local real-app fixtures: old. These are not external production apps. Historical for the current tree; rerun required before release.
| Metric | Latest measured run |
|---|---:|
| Total time | old |
| Real-app targets | old |
| Quality gate | old |
Regenerate this table
`;
    const html = `
      <div class="eyebrow">Smart Eye benchmark · Phase 1 candidate measurement · historical for current tree</div>
      <p class="lead">Phase 1 candidate measurement: <strong>v2.15.0</strong> (2026-08-12). It passed 10/10 rounds. A fresh campaign is required before any current-tree or release claim.</p>
      <strong>old</strong>
      <span>quality gate passed in each real-app round<br>2026-08-12 local run · v2.15.0 Phase 1 candidate</span>
      <a class="link" href="https://github.com/example/releases/tag/v2.15.0">v2.15.0 Phase 1 candidate measurement</a>
    `;
    const options = { runDate: '2026-08-13', releaseVersion: '2.15.0', currentCandidate: identity };

    const updatedReadme = updateReadmeBenchmarkSnapshot(readme, campaign, options);
    const updatedHtml = updateBenchmarkHtmlSnapshot(html, campaign, options);

    expect(updatedReadme).toContain('Latest measured release: the v2.15.0 mixed local campaign passed 10/10 rounds');
    expect(updatedReadme).toContain('Phase 1 candidate evidence: v2.15.0 live-validated the Codex CLI-skill route');
    expect(updatedReadme).toContain('historical for the current tree');
    expect(updatedReadme).not.toContain('rerun required');
    expect(updatedHtml).toContain('Smart Eye benchmark · latest measured release');
    expect(updatedHtml).toContain('releases/tag/v2.15.0">v2.15.0 measured campaign</a>');
    expect(updatedHtml).not.toContain('historical for current tree');
    expect(updatedHtml).not.toContain('fresh campaign is required');
  });

  it('rejects truncated, failed, missing-identity, and mismatched release campaigns', () => {
    const { campaign, identity } = releaseCampaignFixture();
    const options = { releaseVersion: '2.15.0', currentCandidate: identity };

    expect(() => updateReadmeBenchmarkSnapshot('README', campaign, {
      currentCandidate: identity,
    })).toThrow('releaseVersion is required for campaign promotion');

    const truncated = structuredClone(campaign);
    truncated.rounds.pop();
    expect(() => updateReadmeBenchmarkSnapshot('README', truncated, options)).toThrow('campaign rounds are incomplete');

    const failed = structuredClone(campaign);
    failed.rounds[0].gatePassed = false;
    failed.rounds[0].gate.passed = false;
    expect(() => updateReadmeBenchmarkSnapshot('README', failed, options)).toThrow('campaign round 1 did not pass');

    const missingIdentity = structuredClone(campaign);
    delete missingIdentity.candidate;
    expect(() => updateReadmeBenchmarkSnapshot('README', missingIdentity, options)).toThrow('campaign candidate identity is missing');

    const mismatched = structuredClone(campaign);
    mismatched.candidate = releaseCandidateIdentity('b');
    expect(() => updateReadmeBenchmarkSnapshot('README', mismatched, options)).toThrow('campaign candidate digest does not match');

    for (const [passedCount, total] of [[0, 0], [-1, -1], [1.5, 1.5]]) {
      const invalidGate = structuredClone(campaign);
      invalidGate.rounds[0].gate.passedCount = passedCount;
      invalidGate.rounds[0].gate.total = total;
      expect(() => updateReadmeBenchmarkSnapshot('README', invalidGate, options)).toThrow('campaign round 1 did not pass');
    }
  });

  it('keeps mixed-campaign totals separate from real-app proof counts', () => {
    const { campaign, identity } = releaseCampaignFixture();
    const readme = `
[![Release v2.11.0](release-v2.11.0)](release)
## Smart Eye Proof
| Proof point | Latest local run |
|---|---:|
| Campaign pass rate | **old** |
| Real-app targets | **old** |
## Quick start
### Latest dogfood snapshot
Local run on 2026-01-01 against three safe local real-app fixtures: old.
| Metric | Latest run |
|---|---:|
| Real-app targets | old |
Regenerate this table
`;
    const html = '<div class="stat"><strong>old</strong><span>real-app targets passed</span></div>';

    const options = { runDate: '2026-07-10', releaseVersion: '2.15.0', currentCandidate: identity };
    const updatedReadme = updateReadmeBenchmarkSnapshot(readme, campaign, options);
    const updatedHtml = updateBenchmarkHtmlSnapshot(html, campaign, options);

    expect(updatedReadme).toContain('| Campaign pass rate | **10/10 rounds** |');
    expect(updatedReadme).toContain('against 5 safe local real-app fixtures');
    expect(updatedHtml).toContain('<strong>5/5</strong><span>real-app targets passed</span>');
  });
});
