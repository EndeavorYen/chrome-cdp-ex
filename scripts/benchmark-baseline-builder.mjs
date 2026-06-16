#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'fs';
import { pathToFileURL } from 'url';

function metricNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeRunMetrics(run = {}) {
  const metrics = run.metrics || run;
  return {
    commandCalls: metricNumber(metrics.commandCalls),
    usefulObservationTokens: metricNumber(metrics.usefulObservationTokens),
    verificationCallsSaved: metricNumber(metrics.verificationCallsSaved, 0),
    differentiatorSuccessRate: metricNumber(metrics.differentiatorSuccessRate),
  };
}

export function buildComparisonBaselineFile(raw = {}, overrides = {}) {
  if (raw.schema !== 'chrome-cdp-ex.raw-baseline-results.v1') {
    throw new Error('raw baseline input must use schema chrome-cdp-ex.raw-baseline-results.v1');
  }
  if (!Array.isArray(raw.runs)) {
    throw new Error('raw baseline input must include a runs array');
  }
  return {
    schema: 'chrome-cdp-ex.comparison-baselines.v1',
    source: overrides.source || raw.source || 'measured-baseline',
    note: overrides.note || raw.note || 'Measured comparison baselines.',
    baselines: raw.runs.map((run, index) => ({
      id: run.id || `baseline-${index + 1}`,
      label: run.label || run.id || `Baseline ${index + 1}`,
      metrics: normalizeRunMetrics(run),
    })),
  };
}

export function parseBaselineBuilderArgs(argv = []) {
  const opts = {
    inputPath: null,
    outPath: null,
    source: null,
    note: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out') {
      opts.outPath = argv[++i] || null;
    } else if (arg === '--source') {
      opts.source = argv[++i] || null;
    } else if (arg === '--note') {
      opts.note = argv[++i] || null;
    } else if (!opts.inputPath) {
      opts.inputPath = arg;
    }
  }
  return opts;
}

export function runBaselineBuilder(argv = process.argv.slice(2)) {
  const opts = parseBaselineBuilderArgs(argv);
  if (!opts.inputPath) {
    throw new Error('usage: benchmark-baseline-builder <raw-results.json> [--out baselines.json] [--source name] [--note text]');
  }
  const raw = JSON.parse(readFileSync(opts.inputPath, 'utf8'));
  const output = buildComparisonBaselineFile(raw, opts);
  const text = `${JSON.stringify(output, null, 2)}\n`;
  if (opts.outPath) {
    writeFileSync(opts.outPath, text);
    return opts.outPath;
  }
  return text;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    const out = runBaselineBuilder();
    if (!process.argv.includes('--out')) process.stdout.write(out);
  } catch (err) {
    console.error(`Baseline builder failed: ${err.message || err}`);
    process.exit(1);
  }
}
