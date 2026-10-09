#!/usr/bin/env node
// Token and latency measurements for docs/audit/token-perf.md. Live: it opens tabs, scrolls, clicks a
// fixture button, and stops/restarts one tab daemon, so point it only at a browser you started.
//   CDP_PORT=<test port> node docs/audit/measure-token-perf.mjs <out.json> [fixtureBase] [--no-public]
// fixtureBase defaults to http://127.0.0.1:41801 (docs/audit/fixtures/phase-b-server.mjs).
// "chars" is what an agent reads: stdout plus stderr. Tokens in the doc are chars/4, an estimate.
import { spawnSync } from 'node:child_process';
import { statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireTestPort } from '../../scripts/lib/port-guard.mjs';

requireTestPort();
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cdpScript = join(root, 'skills/chrome-cdp-ex/scripts/cdp.mjs');
const binScript = join(root, 'bin/chrome-cdp');
const [outPath, fixtureArg] = process.argv.slice(2).filter(a => !a.startsWith('--'));
const fixtures = fixtureArg || 'http://127.0.0.1:41801';
const withPublic = !process.argv.includes('--no-public');
if (!outPath) {
  console.error('usage: CDP_PORT=<test port> node docs/audit/measure-token-perf.mjs <out.json> [fixtureBase] [--no-public]');
  process.exit(2);
}

function run(args, { script = cdpScript } = {}) {
  const t0 = performance.now();
  const res = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 120000 });
  const out = `${res.stdout || ''}${res.stderr || ''}`;
  return { exit: res.status, ms: Math.round(performance.now() - t0), chars: out.length, out };
}
const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const times = (n, fn) => Array.from({ length: n }, fn);
const pngBytes = text => [...text.matchAll(/((?:[A-Za-z]:)?[\\/][^\s"]+?\.png)/g)]
  .reduce((sum, m) => { try { return sum + statSync(m[1]).size; } catch { return sum; } }, 0);
const pick = r => ({ ms: r.ms, chars: r.chars, exit: r.exit });

const pages = [
  ['local:todo', `${fixtures}/todo.html`],
  ['local:overlay', `${fixtures}/overlay.html`],
  ['local:iframe-host', `${fixtures}/iframe-host.html`],
  ['local:spa', `${fixtures}/spa.html`],
  ...(withPublic ? [
    ['public:wikipedia', 'https://en.wikipedia.org/wiki/Web_browser'],
    ['public:github-repo', 'https://github.com/EndeavorYen/chrome-cdp-ex'],
    ['public:hackernews', 'https://news.ycombinator.com/'],
    ['public:mdn', 'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API'],
  ] : []),
];

const report = { date: new Date().toISOString(), node: process.version, pages: [], latency: {}, receipts: {} };

for (const [label, url] of pages) {
  const opened = run(['open', url]);
  const prefix = opened.out.match(/Opened new tab: ([0-9A-F]{8})/)?.[1];
  if (!prefix) { report.pages.push({ label, url, error: opened.out.slice(0, 300) }); continue; }
  await sleep(label.startsWith('public') ? 4000 : 800);
  const first = run(['perceive', prefix]);
  const warm = times(3, () => run(['perceive', prefix]));
  const deep = run(['perceive', prefix, '-C', '-d', '8']);
  const textAuto = run(['text', prefix, '--auto']);
  const textAll = run(['text', prefix]);
  const shot = run(['shot', prefix]);
  const scanshot = run(['scanshot', prefix]);
  const elshot = run(['elshot', prefix, 'h1']);
  const scrolled = run(['scroll', prefix, 'down']);
  const since = run(['perceive', prefix, '--since-action']);
  const entry = {
    label, url, prefix,
    open: pick(opened),
    perceive: { ...pick(first), warmMedianMs: median(warm.map(w => w.ms)) },
    perceiveDeep: pick(deep),
    textAuto: pick(textAuto),
    text: pick(textAll),
    shot: { ...pick(shot), pngBytes: pngBytes(shot.out) },
    scanshot: { ...pick(scanshot), pngBytes: pngBytes(scanshot.out) },
    elshot: { ...pick(elshot), pngBytes: pngBytes(elshot.out) },
    scrollReceipt: pick(scrolled),
    sinceActionAfterScroll: pick(since),
  };
  report.pages.push(entry);
  console.log(label, JSON.stringify(entry));
}

const [a, b] = report.pages.filter(p => p.prefix).map(p => p.prefix);
const cold = times(3, () => { run(['stop', a]); return run(['eval', a, '1']).ms; });
report.latency = {
  runs: 7,
  nodeNoopMs: median(times(7, () => { const t0 = performance.now(); spawnSync(process.execPath, ['-e', '0']); return Math.round(performance.now() - t0); })),
  helpMs: median(times(7, () => run(['help']).ms)),
  listMs: median(times(7, () => run(['list']).ms)),
  listViaBinMs: median(times(7, () => run(['list'], { script: binScript }).ms)),
  evalWarmMs: median(times(7, () => run(['eval', a, '1']).ms)),
  evalWarmViaBinMs: median(times(7, () => run(['eval', a, '1'], { script: binScript }).ms)),
  evalAlternatingTabsMs: median(times(7, (_, i) => run(['eval', i % 2 ? a : b, '1']).ms)),
  evalColdDaemonMs: { runs: 3, median: median(cold), all: cold },
};
console.log('latency', JSON.stringify(report.latency));

const overlay = report.pages.find(p => p.label === 'local:overlay')?.prefix;
if (overlay) {
  const fields = text => { try { return Object.fromEntries(Object.entries(JSON.parse(text)).map(([k, v]) => [k, JSON.stringify(v).length])); } catch { return null; } };
  run(['perceive', overlay]);
  const okText = run(['click', overlay, '@2']);
  run(['nav', overlay, `${fixtures}/overlay.html`]);
  run(['perceive', overlay]);
  const okJson = run(['click', overlay, '@2', '--format', 'json']);
  run(['nav', overlay, `${fixtures}/overlay.html`]);
  const refusedText = run(['click', overlay, '#save']);
  const refusedJson = run(['click', overlay, '#save', '--format', 'json']);
  report.receipts = {
    clickOkText: { chars: okText.chars, out: okText.out },
    clickOkJson: { chars: okJson.chars, fields: fields(okJson.out) },
    clickRefusedText: { chars: refusedText.chars, out: refusedText.out },
    clickRefusedJson: { chars: refusedJson.chars, fields: fields(refusedJson.out) },
  };
  console.log('receipts', JSON.stringify(report.receipts, (k, v) => (k === 'out' ? undefined : v)));
}

writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
