#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'fs';
import { pathToFileURL } from 'url';

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

export function updateReadmeBenchmarkSnapshot(readme, summary, { runDate } = {}) {
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

export function updateBenchmarkHtmlSnapshot(html, summary, { runDate } = {}) {
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
  return {
    summaryPath: args[0],
    readmePath: args[1] || 'README.md',
    htmlPath,
    runDate,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const { summaryPath, readmePath, htmlPath, runDate } = parseArgs(process.argv.slice(2));
  if (!summaryPath) {
    console.error('Usage: node scripts/update-readme-benchmark.mjs <benchmark.json> [README.md] [--date YYYY-MM-DD]');
    process.exit(1);
  }
  const summary = parseBenchmarkSummaryJson(readFileSync(summaryPath, 'utf8'));
  const readme = readFileSync(readmePath, 'utf8');
  writeFileSync(readmePath, updateReadmeBenchmarkSnapshot(readme, summary, { runDate }));
  if (htmlPath) {
    const html = readFileSync(htmlPath, 'utf8');
    writeFileSync(htmlPath, updateBenchmarkHtmlSnapshot(html, summary, { runDate }));
  }
  console.log(`updated ${readmePath}`);
}
