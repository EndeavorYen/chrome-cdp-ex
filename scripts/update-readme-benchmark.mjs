#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'fs';
import { pathToFileURL } from 'url';

import { buildCandidateIdentity } from './candidate-identity.mjs';

const RELEASE_CAMPAIGN_TYPES = Object.freeze([
  'mcp',
  'cli',
  'killer',
  'large-app',
  'real-app',
  'real-app',
  'real-app',
  'real-app',
  'real-app',
  'cli',
]);
const RELEASE_REAL_APP_TARGETS = Object.freeze([
  'dashboard',
  'docs-app',
  'auth-flow',
  'data-table',
  'canvas-heavy',
]);

function number(value) {
  return Number.isFinite(value) ? value : null;
}

function commas(value) {
  return new Intl.NumberFormat('en-US').format(value);
}

function seconds(ms) {
  const value = number(ms);
  return value === null ? 'n/a' : `${(value / 1000).toFixed(3)}s`;
}

function percent(rate) {
  const value = number(rate);
  return value === null ? 'n/a' : `${Math.round(value * 100)}%`;
}

function average(values) {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return null;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function gate(summary) {
  const gateModel = summary.gate || {};
  if (!Number.isFinite(gateModel.passedCount) || !Number.isFinite(gateModel.total)) return 'n/a';
  return `${gateModel.passedCount}/${gateModel.total} ${gateModel.passed ? 'pass' : 'fail'}`;
}

function actionEvidence(summary) {
  const coverage = summary.metrics?.actionEvidenceCoverage || {};
  if (!Number.isFinite(coverage.covered) || !Number.isFinite(coverage.total)) return 'n/a';
  return `${percent(coverage.rate)} (${coverage.covered}/${coverage.total} mutating commands)`;
}

function staleRef(summary) {
  const recovery = summary.metrics?.staleRefRecovery || {};
  if (!Number.isFinite(recovery.durationMs) || !Number.isFinite(recovery.recovered) || !Number.isFinite(recovery.commandCalls)) return 'n/a';
  return `${recovery.durationMs}ms, ${recovery.recovered}/${recovery.commandCalls} recovered`;
}

function assertPassedGate(summary) {
  if (summary.gate?.passed !== true) throw new Error('benchmark gate failed; snapshot not updated');
}

function gateFraction(summary) {
  const gateModel = summary.gate || {};
  if (!Number.isFinite(gateModel.passedCount) || !Number.isFinite(gateModel.total)) return 'n/a';
  return `${gateModel.passedCount}/${gateModel.total}`;
}

function replaceMetric(readme, label, value) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return readme.replace(new RegExp(`\\| ${escaped} \\| [^|]+ \\|`, 'g'), `| ${label} | ${value} |`);
}

function replaceMetricInSection(readme, start, end, label, value) {
  const startIndex = readme.indexOf(start);
  if (startIndex < 0) return readme;
  const endIndex = readme.indexOf(end, startIndex + start.length);
  const before = readme.slice(0, startIndex);
  const section = readme.slice(startIndex, endIndex < 0 ? readme.length : endIndex);
  const after = endIndex < 0 ? '' : readme.slice(endIndex);
  return `${before}${replaceMetric(section, label, value)}${after}`;
}

function isCampaignSummary(summary) {
  return summary?.schema === 'chrome-cdp-ex.live-campaign.v1';
}

function primaryCampaignType(summary) {
  return summary.typeSummaries?.find(item => item.type === 'real-app') || summary.typeSummaries?.[0] || {};
}

function campaignRounds(summary, type = primaryCampaignType(summary).type) {
  const rounds = Array.isArray(summary.rounds) ? summary.rounds : [];
  return type ? rounds.filter(round => round.type === type) : rounds;
}

function campaignTargets(typeSummary) {
  const targets = typeSummary.realAppTargets?.targets || [];
  if (!targets.length) return 'n/a';
  const preferred = ['dashboard', 'docs-app', 'auth-flow', 'data-table', 'canvas-heavy'];
  return [...targets]
    .sort((a, b) => {
      const ai = preferred.indexOf(a);
      const bi = preferred.indexOf(b);
      if (ai >= 0 && bi >= 0) return ai - bi;
      if (ai >= 0) return -1;
      if (bi >= 0) return 1;
      return targets.indexOf(a) - targets.indexOf(b);
    })
    .join(', ');
}

function campaignGate(summary, { proof = false } = {}) {
  const rounds = campaignRounds(summary);
  const passedRounds = rounds.filter(round => round.gatePassed === true);
  const gates = passedRounds
    .map(round => round.gate)
    .filter(gateModel => Number.isFinite(gateModel?.passedCount) && Number.isFinite(gateModel?.total));
  const first = gates[0];
  const sameGate = first && gates.every(gateModel => gateModel.passedCount === first.passedCount && gateModel.total === first.total);
  if (sameGate) {
    const roundLabel = primaryCampaignType(summary).type || 'campaign';
    return proof
      ? `${first.passedCount}/${first.total} pass in each ${roundLabel} round`
      : `${first.passedCount}/${first.total} pass in all ${passedRounds.length} ${roundLabel} rounds`;
  }
  if (Number.isFinite(summary.passCount) && Number.isFinite(summary.roundsCompleted)) {
    return `${summary.passCount}/${summary.roundsCompleted} rounds passed`;
  }
  return 'n/a';
}

function campaignAutoEvidence(summary) {
  const value = average(campaignRounds(summary).map(round => round.metrics?.autoEvidenceActions));
  if (!Number.isFinite(value)) return 'n/a';
  const rounded = Number.isInteger(value) ? value : value.toFixed(1);
  return `${rounded} auto-evidence actions per round; no failed criteria`;
}

function campaignTraitCoverage(summary, trait) {
  const rounds = campaignRounds(summary).filter(round => round.gatePassed === true);
  if (!rounds.length) return 'n/a';
  const covered = rounds.every(round => round.metrics?.realAppTarget?.traits?.includes(trait));
  return covered ? `covered by all real-app adversarial profiles` : 'not covered in every profile';
}

function campaignGoldenPathMs(summary) {
  return average(campaignRounds(summary).map(round => round.metrics?.goldenPathMs));
}

function normalizedReleaseVersion(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/^v/, '');
  return /^\d+\.\d+\.\d+$/.test(normalized) ? normalized : null;
}

function inferredReadmeReleaseVersion(readme) {
  return normalizedReleaseVersion(readme.match(/release-v([\d.]+)/)?.[1]);
}

function explicitReleaseVersion(value) {
  if (value === undefined) return null;
  const normalized = normalizedReleaseVersion(value);
  if (!normalized) throw new Error('releaseVersion must be X.Y.Z');
  return normalized;
}

function requiredReleaseVersion(value) {
  if (value === undefined) throw new Error('releaseVersion is required for campaign promotion');
  return explicitReleaseVersion(value);
}

function requirePromotedProofCopy(original, updated, surface) {
  const promotionBlocker = /Previous-release baseline|previous-release baseline|Phase 1 candidate|historical for (?:the )?current tree|must rerun|rerun required|fresh campaign is required/;
  const hadPromotionBlocker = promotionBlocker.test(original);
  const hasPromotionBlocker = promotionBlocker.test(updated);
  if (hadPromotionBlocker && hasPromotionBlocker) {
    throw new Error(`${surface} release identity was not promoted; snapshot not updated`);
  }
}

function sameList(actual, expected) {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

export function assertReleaseCampaign(summary, {
  releaseVersion,
  currentCandidate = buildCandidateIdentity(),
} = {}) {
  const measuredVersion = requiredReleaseVersion(releaseVersion);
  const rounds = Array.isArray(summary?.rounds) ? summary.rounds : [];
  if (!Number.isInteger(summary?.plannedRounds)
    || summary.plannedRounds !== summary.roundsCompleted
    || summary.roundsCompleted !== rounds.length) {
    throw new Error('campaign rounds are incomplete; snapshot not updated');
  }
  if (summary.passCount !== rounds.length
    || summary.failCount !== 0
    || summary.passRate !== 1
    || (Array.isArray(summary.failurePatterns) && summary.failurePatterns.length > 0)) {
    throw new Error('campaign summary is not fully passing; snapshot not updated');
  }
  for (let index = 0; index < rounds.length; index += 1) {
    const round = rounds[index];
    const gateComplete = Number.isInteger(round?.gate?.passedCount)
      && Number.isInteger(round?.gate?.total)
      && round.gate.passedCount > 0
      && round.gate.total > 0
      && round.gate.passedCount === round.gate.total;
    if (round?.round !== index + 1
      || round?.success !== true
      || round?.runSuccess !== true
      || round?.gatePassed !== true
      || round?.gate?.passed !== true
      || !gateComplete) {
      throw new Error(`campaign round ${index + 1} did not pass its complete gate; snapshot not updated`);
    }
  }

  const candidate = summary?.candidate;
  if (candidate?.schema !== 'chrome-cdp-ex.candidate-identity.v1') {
    throw new Error('campaign candidate identity is missing; snapshot not updated');
  }
  if (candidate.productVersion !== measuredVersion) {
    throw new Error(`campaign candidate version ${candidate.productVersion || 'missing'} does not match v${measuredVersion}; snapshot not updated`);
  }
  if (currentCandidate?.productVersion !== measuredVersion) {
    throw new Error(`current candidate version ${currentCandidate?.productVersion || 'missing'} does not match v${measuredVersion}; snapshot not updated`);
  }
  if (candidate.algorithm !== 'sha256'
    || !/^sha256:[a-f0-9]{64}$/.test(String(candidate.sourceDigest || ''))
    || !Number.isInteger(candidate.fileCount)
    || candidate.fileCount < 1) {
    throw new Error('campaign candidate identity is invalid; snapshot not updated');
  }
  if (candidate.sourceDigest !== currentCandidate?.sourceDigest) {
    throw new Error('campaign candidate digest does not match the current tree; snapshot not updated');
  }

  const types = rounds.map(round => round.type);
  if (!sameList(types, RELEASE_CAMPAIGN_TYPES)) {
    throw new Error('campaign route inventory does not match the release contract; snapshot not updated');
  }
  const targets = rounds.filter(round => round.type === 'real-app').map(round => round.realAppTarget);
  if (!sameList(targets, RELEASE_REAL_APP_TARGETS)) {
    throw new Error('campaign real-app target inventory does not match the release contract; snapshot not updated');
  }
}

function updateReadmeCampaignSnapshot(readme, summary, { runDate, releaseVersion, currentCandidate } = {}) {
  if (summary.passCount !== summary.roundsCompleted || summary.passCount === 0) {
    throw new Error('campaign gate failed; snapshot not updated');
  }
  assertReleaseCampaign(summary, { releaseVersion, currentCandidate });
  const measuredVersion = explicitReleaseVersion(releaseVersion) || inferredReadmeReleaseVersion(readme);
  const measuredVersionLabel = measuredVersion ? `v${measuredVersion}` : 'current release';
  const measuredDate = runDate || new Date().toISOString().slice(0, 10);
  const typeSummary = primaryCampaignType(summary);
  const realAppRounds = campaignRounds(summary, typeSummary.type);
  const targets = campaignTargets(typeSummary);
  const roundCount = `${summary.passCount}/${summary.roundsCompleted} rounds`;
  const goldenPathMs = campaignGoldenPathMs(summary);

  let next = readme;
  next = next.replace(
    /> \*\*Evidence boundary:\*\* Phase 1 candidate evidence: v[\d.]+ live-validated the Codex CLI-skill route on one disposable local fixture\. Candidate digest sha256:[a-f0-9]+…; these measurements are historical for the current tree\. A fresh campaign is required before any current-tree or release claim\./,
    `> **Evidence boundary:** ${measuredVersionLabel} live-validated the Codex CLI-skill route on one disposable local fixture.`,
  );
  next = next.replace(
    /> \*\*Evidence boundary:\*\* v[\d.]+ previously live-validated the Codex CLI-skill route on one disposable local fixture\. The current v[\d.]+ manifest remains `documented` until this exact candidate is rerun\./,
    `> **Evidence boundary:** ${measuredVersionLabel} live-validated the Codex CLI-skill route on one disposable local fixture.`,
  );
  next = next.replace(
    /(\| \[Smart Eye benchmark\]\([^\n]+\) \| )Previous-release baseline: the v[\d.]+ mixed local campaign passed \d+\/\d+ rounds, including five local fixture profiles — not external production apps; v[\d.]+ must rerun before promotion( \|)/,
    `$1Latest measured release: the ${measuredVersionLabel} mixed local campaign passed ${summary.passCount}/${summary.roundsCompleted} rounds, including five local fixture profiles — not external production apps$2`,
  );
  next = next.replace(
    /(\| \[Smart Eye benchmark\]\([^\n]+\) \| )Phase 1 candidate measurement: the v[\d.]+ mixed local campaign passed \d+\/\d+ rounds, including five local fixture profiles\. Historical for the current tree; rerun required before release\.( \|)/,
    `$1Latest measured release: the ${measuredVersionLabel} mixed local campaign passed ${summary.passCount}/${summary.roundsCompleted} rounds, including five local fixture profiles — not external production apps$2`,
  );
  next = next.replace(
    /Local run on \d{4}-\d{2}-\d{2}(?:[^.]*?) against (?:\w+|\d+) safe local real-app fixtures: [^.]+\./,
    `Local run on ${measuredDate} against ${realAppRounds.length} safe local real-app fixtures: ${targets}.`,
  );
  next = next.replace(
    /Previous-release baseline: local run on \d{4}-\d{2}-\d{2} for v[\d.]+ against \d+ safe local real-app fixtures: [^.]+\. These are not external production apps\. The v[\d.]+ candidate must rerun this gate before promotion\./,
    `Latest measured release: local run on ${measuredDate} for ${measuredVersionLabel} against ${realAppRounds.length} safe local real-app fixtures: ${targets}. These are not external production apps.`,
  );
  next = next.replace(
    /Phase 1 candidate snapshot: local run on \d{4}-\d{2}-\d{2} for v[\d.]+ against \d+ safe local real-app fixtures: [^.]+\. These are not external production apps\. Historical for the current tree; rerun required before release\./,
    `Latest measured release: local run on ${measuredDate} for ${measuredVersionLabel} against ${realAppRounds.length} safe local real-app fixtures: ${targets}. These are not external production apps.`,
  );

  const proofStart = '## Smart Eye Proof';
  const proofEnd = '## Quick start';
  next = replaceMetricInSection(next, proofStart, proofEnd, 'Release proof', `**${measuredVersionLabel} live campaign**`);
  next = replaceMetricInSection(next, proofStart, proofEnd, 'Real-app targets', `**${targets}**`);
  next = replaceMetricInSection(next, proofStart, proofEnd, 'Campaign pass rate', `**${roundCount}**`);
  next = replaceMetricInSection(next, proofStart, proofEnd, 'Quality gate', `**${campaignGate(summary, { proof: true })}**`);
  next = replaceMetricInSection(next, proofStart, proofEnd, 'First useful observation', `**${seconds(typeSummary.avgFirstUsefulObservationMs)} avg**`);
  next = replaceMetricInSection(next, proofStart, proofEnd, 'First action evidence', `**${seconds(typeSummary.avgFirstActionEvidenceMs)} avg**`);
  next = replaceMetricInSection(next, proofStart, proofEnd, 'Useful observation tokens', `**${commas(Math.round(typeSummary.avgUsefulObservationTokens || 0))} avg**`);
  next = replaceMetricInSection(next, proofStart, proofEnd, 'Max step output', `**${commas(typeSummary.maxStepEstimatedTokens || 0)} tokens**`);

  const snapshotStart = '### Latest dogfood snapshot';
  const snapshotEnd = 'Regenerate this table';
  next = replaceMetricInSection(next, snapshotStart, snapshotEnd, 'Total time', `${seconds(typeSummary.avgTotalMs)} avg`);
  next = replaceMetricInSection(next, snapshotStart, snapshotEnd, 'Command calls', `${Math.round(average(campaignRounds(summary).map(round => round.metrics?.commandCalls)) || 0)} per round`);
  next = replaceMetricInSection(next, snapshotStart, snapshotEnd, 'First useful observation', `${seconds(typeSummary.avgFirstUsefulObservationMs)} avg`);
  next = replaceMetricInSection(next, snapshotStart, snapshotEnd, 'First action evidence', `${seconds(typeSummary.avgFirstActionEvidenceMs)} avg`);
  next = replaceMetricInSection(next, snapshotStart, snapshotEnd, 'Golden path complete', `${seconds(goldenPathMs)} avg`);
  next = replaceMetricInSection(next, snapshotStart, snapshotEnd, 'Estimated output tokens', `${commas(Math.round(typeSummary.avgEstimatedOutputTokens || 0))} avg`);
  next = replaceMetricInSection(next, snapshotStart, snapshotEnd, 'Useful observation tokens', `${commas(Math.round(typeSummary.avgUsefulObservationTokens || 0))} avg`);
  next = replaceMetricInSection(next, snapshotStart, snapshotEnd, 'Action evidence coverage', campaignAutoEvidence(summary));
  next = replaceMetricInSection(next, snapshotStart, snapshotEnd, 'Real-app targets', targets);
  next = replaceMetricInSection(next, snapshotStart, snapshotEnd, 'Stale-ref recovery', campaignTraitCoverage(summary, 'stale-ref'));
  next = replaceMetricInSection(next, snapshotStart, snapshotEnd, 'Quality gate', campaignGate(summary));
  requirePromotedProofCopy(readme, next, 'README');
  return next;
}

export function updateReadmeBenchmarkSnapshot(readme, summary, { runDate, releaseVersion, currentCandidate } = {}) {
  if (isCampaignSummary(summary)) return updateReadmeCampaignSnapshot(readme, summary, { runDate, releaseVersion, currentCandidate });

  assertPassedGate(summary);
  let next = readme;
  const metrics = summary.metrics || {};
  next = next.replace(/Local run on \d{4}-\d{2}-\d{2} against the same smoke page\./, `Local run on ${runDate || new Date().toISOString().slice(0, 10)} against the same smoke page.`);

  const proofStart = '## Smart Eye Proof';
  const proofEnd = '## Quick start';
  next = replaceMetricInSection(next, proofStart, proofEnd, 'Quality gate', `**${gate(summary)}**`);
  next = replaceMetricInSection(next, proofStart, proofEnd, 'Golden path complete', `**${seconds(metrics.goldenPathMs)}**`);
  next = replaceMetricInSection(next, proofStart, proofEnd, 'Useful observation tokens', `**${commas(metrics.usefulObservationTokens || 0)}**`);
  next = replaceMetricInSection(next, proofStart, proofEnd, 'Action evidence coverage', `**${percent(metrics.actionEvidenceCoverage?.rate)}**`);
  next = replaceMetricInSection(next, proofStart, proofEnd, 'Differentiator success rate', `**${percent(metrics.differentiators?.successRate)}**`);

  const snapshotStart = '### Latest dogfood snapshot';
  const snapshotEnd = 'Regenerate this table';
  next = replaceMetricInSection(next, snapshotStart, snapshotEnd, 'Total time', seconds(metrics.totalMs));
  next = replaceMetricInSection(next, snapshotStart, snapshotEnd, 'Command calls', String(metrics.commandCalls ?? 'n/a'));
  next = replaceMetricInSection(next, snapshotStart, snapshotEnd, 'First useful observation', seconds(metrics.firstUsefulObservationMs));
  next = replaceMetricInSection(next, snapshotStart, snapshotEnd, 'Golden path complete', seconds(metrics.goldenPathMs));
  next = replaceMetricInSection(next, snapshotStart, snapshotEnd, 'Useful observation tokens', commas(metrics.usefulObservationTokens || 0));
  next = replaceMetricInSection(next, snapshotStart, snapshotEnd, 'Action evidence coverage', actionEvidence(summary));
  next = replaceMetricInSection(next, snapshotStart, snapshotEnd, 'Differentiator success rate', percent(metrics.differentiators?.successRate));
  next = replaceMetricInSection(next, snapshotStart, snapshotEnd, 'Stale-ref recovery', staleRef(summary));
  next = replaceMetricInSection(next, snapshotStart, snapshotEnd, 'Quality gate', gate(summary));
  return next;
}

function replaceStat(html, labelHtml, value) {
  const escaped = labelHtml.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return html.replace(new RegExp(`(<div class="stat"><strong>)[^<]+(</strong><span>${escaped}</span></div>)`), `$1${value}$2`);
}

function replaceTimeline(html, label, value, width) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return html.replace(
    new RegExp(`(<span>${escaped}</span>\\s*<div class="track"><div class="fill" style="width: )[^"]+("></div></div>\\s*<span>)[^<]+(</span>)`),
    `$1${width}%$2${value}$3`,
  );
}

function timelineWidth(ms, totalMs) {
  if (!Number.isFinite(ms) || !Number.isFinite(totalMs) || totalMs <= 0) return 0;
  return Math.min(100, Math.max(1, Math.round((ms / totalMs) * 100)));
}

function updateBenchmarkCampaignHtmlSnapshot(html, summary, { runDate, releaseVersion, currentCandidate } = {}) {
  if (summary.passCount !== summary.roundsCompleted || summary.passCount === 0) {
    throw new Error('campaign gate failed; snapshot not updated');
  }
  assertReleaseCampaign(summary, { releaseVersion, currentCandidate });
  const measuredVersion = explicitReleaseVersion(releaseVersion);
  const measuredVersionLabel = measuredVersion ? `v${measuredVersion}` : null;
  const measuredDate = runDate || new Date().toISOString().slice(0, 10);
  const typeSummary = primaryCampaignType(summary);
  const rounds = campaignRounds(summary);
  const gates = rounds.map(round => round.gate).filter(Boolean);
  const firstGate = gates.find(gateModel => Number.isFinite(gateModel?.passedCount) && Number.isFinite(gateModel?.total));
  const gateText = firstGate ? `${firstGate.passedCount}/${firstGate.total}` : `${summary.passCount}/${summary.roundsCompleted}`;
  const goldenPathMs = campaignGoldenPathMs(summary);
  let next = html;
  if (measuredVersionLabel) {
    next = next.replace('Smart Eye benchmark · previous-release baseline', 'Smart Eye benchmark · latest measured release');
    next = next.replace('Smart Eye benchmark · Phase 1 candidate measurement · historical for current tree', 'Smart Eye benchmark · latest measured release');
    next = next.replace(
      /Previous-release baseline: <strong>v[\d.]+<\/strong> \(\d{4}-\d{2}-\d{2}\)\. ([^<]|<(?!\/p>))*?The v[\d.]+ candidate must rerun before promotion\./,
      `Latest measured release: <strong>${measuredVersionLabel}</strong> (${measuredDate}). It passed ${summary.passCount}/${summary.roundsCompleted} rounds across matched MCP and CLI routes, Killer Path, 5,200-node large-app stress, and five distinct safe local real-app profiles.`,
    );
    next = next.replace(
      /Phase 1 candidate measurement: <strong>v[\d.]+<\/strong> \(\d{4}-\d{2}-\d{2}\)\. ([^<]|<(?!\/p>))*?A fresh campaign is required before any current-tree or release claim\./,
      `Latest measured release: <strong>${measuredVersionLabel}</strong> (${measuredDate}). It passed ${summary.passCount}/${summary.roundsCompleted} rounds across matched MCP and CLI routes, Killer Path, 5,200-node large-app stress, and five distinct safe local real-app profiles.`,
    );
    next = next.replace(/releases\/tag\/v[\d.]+">v[\d.]+ product<\/a>/, `releases/tag/${measuredVersionLabel}">${measuredVersionLabel} product</a>`);
    next = next.replace(/releases\/tag\/v[\d.]+">v[\d.]+ measured campaign<\/a>/, `releases/tag/${measuredVersionLabel}">${measuredVersionLabel} measured campaign</a>`);
  }
  next = next.replace(
    /<strong>[^<]+<\/strong>\s*<span>quality gate passed[^<]*<br>\d{4}-\d{2}-\d{2} local run(?: · v[\d.]+ (?:previous baseline|Phase 1 candidate))?<\/span>/,
    `<strong>${gateText}</strong>\n      <span>quality gate passed in each real-app round<br>${measuredDate} local run${measuredVersionLabel ? ` · ${measuredVersionLabel} campaign` : ''}</span>`,
  );
  const passedRealAppRounds = rounds.filter(round => round.gatePassed === true).length;
  next = replaceStat(next, 'real-app targets passed', `${passedRealAppRounds}/${rounds.length}`);
  next = replaceStat(next, 'first useful observation avg', seconds(typeSummary.avgFirstUsefulObservationMs));
  next = replaceStat(next, 'first action evidence avg', seconds(typeSummary.avgFirstActionEvidenceMs));
  next = replaceStat(next, '<em>useful observation</em> tokens avg', commas(Math.round(typeSummary.avgUsefulObservationTokens || 0)));
  next = replaceTimeline(next, 'First observation avg', seconds(typeSummary.avgFirstUsefulObservationMs), timelineWidth(typeSummary.avgFirstUsefulObservationMs, typeSummary.avgTotalMs));
  next = replaceTimeline(next, 'First action evidence', seconds(typeSummary.avgFirstActionEvidenceMs), timelineWidth(typeSummary.avgFirstActionEvidenceMs, typeSummary.avgTotalMs));
  next = replaceTimeline(next, 'Golden path avg', seconds(goldenPathMs), timelineWidth(goldenPathMs, typeSummary.avgTotalMs));
  next = replaceTimeline(next, 'Total run avg', seconds(typeSummary.avgTotalMs), 100);
  if (measuredVersionLabel) requirePromotedProofCopy(html, next, 'benchmark HTML');
  return next;
}

export function updateBenchmarkHtmlSnapshot(html, summary, { runDate, releaseVersion, currentCandidate } = {}) {
  if (isCampaignSummary(summary)) return updateBenchmarkCampaignHtmlSnapshot(html, summary, { runDate, releaseVersion, currentCandidate });

  assertPassedGate(summary);
  const metrics = summary.metrics || {};
  const totalMs = metrics.totalMs;
  let next = html.replace(
    /<strong>[^<]+<\/strong>\s*<span>quality gate passed on the \d{4}-\d{2}-\d{2} local run<\/span>/,
    `<strong>${gateFraction(summary)}</strong>\n      <span>quality gate passed<br>${runDate || new Date().toISOString().slice(0, 10)} local run</span>`,
  );
  next = replaceStat(next, 'golden path complete', seconds(metrics.goldenPathMs));
  next = replaceStat(next, '<em>useful observation</em> tokens', commas(metrics.usefulObservationTokens || 0));
  next = replaceStat(next, 'action evidence coverage', percent(metrics.actionEvidenceCoverage?.rate));
  next = replaceStat(next, 'stale-ref recovery', `${metrics.staleRefRecovery?.durationMs ?? 'n/a'}ms`);
  next = replaceTimeline(next, 'First observation', seconds(metrics.firstUsefulObservationMs), timelineWidth(metrics.firstUsefulObservationMs, totalMs));
  next = replaceTimeline(next, 'Golden path', seconds(metrics.goldenPathMs), timelineWidth(metrics.goldenPathMs, totalMs));
  next = replaceTimeline(next, 'Total run', seconds(totalMs), 100);
  return next;
}

export function parseBenchmarkSummaryJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('benchmark JSON not found');
  return JSON.parse(text.slice(start, end + 1));
}

function parseArgs(argv) {
  const args = [...argv];
  const htmlIndex = args.indexOf('--html');
  let htmlPath;
  if (htmlIndex >= 0) {
    htmlPath = args[htmlIndex + 1];
    args.splice(htmlIndex, 2);
  }
  const dateIndex = args.indexOf('--date');
  let runDate;
  if (dateIndex >= 0) {
    runDate = args[dateIndex + 1];
    args.splice(dateIndex, 2);
  }
  const versionIndex = args.indexOf('--version');
  let releaseVersion;
  if (versionIndex >= 0) {
    releaseVersion = args[versionIndex + 1];
    args.splice(versionIndex, 2);
  }
  return {
    summaryPath: args[0],
    readmePath: args[1] || 'README.md',
    htmlPath,
    runDate,
    releaseVersion,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const { summaryPath, readmePath, htmlPath, runDate, releaseVersion } = parseArgs(process.argv.slice(2));
  if (!summaryPath) {
    console.error('Usage: node scripts/update-readme-benchmark.mjs <benchmark.json> [README.md] [--html path] [--date YYYY-MM-DD] [--version X.Y.Z]');
    process.exit(1);
  }
  const summary = parseBenchmarkSummaryJson(readFileSync(summaryPath, 'utf8'));
  const readme = readFileSync(readmePath, 'utf8');
  const updatedReadme = updateReadmeBenchmarkSnapshot(readme, summary, { runDate, releaseVersion });
  let updatedHtml;
  if (htmlPath) {
    const html = readFileSync(htmlPath, 'utf8');
    updatedHtml = updateBenchmarkHtmlSnapshot(html, summary, { runDate, releaseVersion });
  }
  writeFileSync(readmePath, updatedReadme);
  if (htmlPath) writeFileSync(htmlPath, updatedHtml);
  console.log(`updated ${readmePath}`);
}
