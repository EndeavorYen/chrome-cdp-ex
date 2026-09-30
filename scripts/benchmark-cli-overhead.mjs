#!/usr/bin/env node
// Measure per-call overhead of the CLI against one tab.
// Usage: CDP_PORT=<port of a test browser you started> node scripts/benchmark-cli-overhead.mjs <target> [--runs N]
// Prints one JSON object. It only runs `eval document.title`, `help` and `batch` of evals: read-only.
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { requireTestPort } from './lib/port-guard.mjs';

const CDP = fileURLToPath(new URL('../skills/chrome-cdp-ex/scripts/cdp.mjs', import.meta.url));

export function summarize(samplesMs) {
  if (!samplesMs.length) throw new Error('no samples');
  const s = [...samplesMs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  const mean = Math.round(s.reduce((a, b) => a + b, 0) / s.length);
  return { n: s.length, min: s[0], median: q(0.5), p90: q(0.9), max: s[s.length - 1], mean };
}

function timeMs(args) {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', env: process.env, timeout: 120000 }); // a hung call fails, not hangs
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (r.status !== 0) throw new Error(`command failed: ${args.join(' ')}\n${r.stdout}${r.stderr}`);
  return Math.round(ms);
}

function repeat(runs, args) {
  return summarize(Array.from({ length: runs }, () => timeMs(args)));
}

export function runBenchmark({ target, runs }) {
  const twelve = Array.from({ length: 12 }, () => 'eval document.title').join(' | ');
  return {
    schema: 'chrome-cdp-ex.benchmark-cli-overhead.v1',
    runs,
    node_startup: repeat(runs, ['-e', '0']),
    cli_help: repeat(runs, [CDP, 'help']),
    cli_eval: repeat(runs, [CDP, 'eval', target, 'document.title']),
    cli_batch_12_evals: repeat(runs, [CDP, 'batch', target, '--compact', twelve]),
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  requireTestPort(); // exits 2 before any spawn: never 9222/9224 or an unset port
  const args = process.argv.slice(2);
  const runsAt = args.indexOf('--runs');
  const runs = runsAt >= 0 ? Number(args[runsAt + 1]) : 8;
  const target = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--runs');
  if (!target || !Number.isInteger(runs) || runs < 1) {
    console.error('usage: node scripts/benchmark-cli-overhead.mjs <target> [--runs N]');
    process.exit(2);
  }
  console.log(JSON.stringify(runBenchmark({ target, runs }), null, 2));
}
