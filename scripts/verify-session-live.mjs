#!/usr/bin/env node
// Acceptance measurement for session.mjs. Starts a local HTTP fixture and needs a debug browser YOU started
// on CDP_PORT (never the user's own Chrome). Prints one JSON object with pass/fail against the spec numbers.
// Usage: CDP_PORT=9336 node scripts/verify-session-live.mjs <target>
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { summarize } from './benchmark-cli-overhead.mjs';
import { requireTestPort } from './lib/port-guard.mjs';
import { readReceipt, twelveStepsPass } from './lib/session-acceptance.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CDP = join(ROOT, 'skills/chrome-cdp-ex/scripts/cdp.mjs');
const SESSION = join(ROOT, 'skills/chrome-cdp-ex/scripts/session.mjs');
requireTestPort(); // exits 2 on unset, empty, invalid, 9222 or 9224, before any spawn or connect
const target = process.argv[2];
if (!target) { console.error('usage: node scripts/verify-session-live.mjs <target>'); process.exit(2); }

const PAGE = `<!doctype html><title>fixture</title>
<button id="menu" onpointerdown="document.getElementById('m').hidden=false">menu</button>
<div id="m" hidden>1080p</div><script>
window.later = () => fetch('/late.bin');
</script>`;
const server = createServer((req, res) => {
  if (req.url === '/late.bin') return setTimeout(() => { res.setHeader('content-type', 'application/octet-stream'); res.end('x'); }, 300);
  res.setHeader('content-type', 'text/html'); res.end(PAGE);
}).listen(0);
const port = server.address().port;

const dir = mkdtempSync(join(tmpdir(), 'session-live-'));
const jobPath = join(dir, 'twelve.mjs');
writeFileSync(jobPath, `export default async ({ page }) => { for (let i = 0; i < 12; i++) await page.ev('document.title'); return 12; };`);
const waitPath = join(dir, 'wait.mjs');
writeFileSync(waitPath, `export default async ({ page }) => {
  const w = page.waitResponse('/late.bin', { timeoutMs: 5000 });
  const t0 = Date.now();
  await page.ev('window.later()');
  await w.promise;
  return { after_ms: Date.now() - t0 };
};`);
const menuPath = join(dir, 'menu.mjs');
writeFileSync(menuPath, `export default async ({ page }) => {
  await page.pointer('#menu');
  return page.ev("!document.getElementById('m').hidden");
};`);

// Async spawn on purpose: the fixture server lives in this process, so a blocking spawnSync would starve it.
const run = (args) => new Promise((resolve) => {
  const child = spawn(process.execPath, args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.on('close', (status) => resolve({ status, stdout }));
});
const nav = await run([CDP, 'nav', target, `http://127.0.0.1:${port}/`]);
if (nav.status !== 0) {
  server.close();
  console.error(`cdp nav failed (exit ${nav.status}); nothing measured`);
  process.exit(1);
}

const sessionRuns = []; // { status, ok, ms, result, error } per `node session.mjs` child
const sessionWallMs = []; // wall-clock around the whole `node session.mjs` process, includes Node startup
for (let i = 0; i < 8; i++) {
  const t0 = Date.now();
  const r = await run([SESSION, target, '--script', jobPath]);
  sessionWallMs.push(Date.now() - t0);
  sessionRuns.push(readReceipt(r));
}
// receipt ms: measured inside session.mjs, excludes Node startup (the pass threshold uses this)
const sessionMs = sessionRuns.filter((r) => typeof r.ms === 'number').map((r) => r.ms);
const cliMs = [];
let cliFailedCalls = 0;
for (let r = 0; r < 3; r++) {
  const t0 = Date.now();
  for (let i = 0; i < 12; i++) if ((await run([CDP, 'eval', target, 'document.title'])).status !== 0) cliFailedCalls++;
  cliMs.push(Date.now() - t0);
}
const wait = readReceipt(await run([SESSION, target, '--script', waitPath]));
const menu = readReceipt(await run([SESSION, target, '--script', menuPath]));
server.close();

const session = sessionMs.length ? summarize(sessionMs) : { n: 0, median: Infinity };
const sessionWall = summarize(sessionWallMs);
const cli = summarize(cliMs);
console.log(JSON.stringify({
  twelve_steps_via_session_receipt_ms_in_process: session,
  twelve_steps_via_session_wall_clock_ms_per_process: sessionWall,
  twelve_steps_via_12_cli_calls_wall_clock_ms: cli,
  ratio_cli12_wall_over_session_receipt: Number((cli.median / session.median).toFixed(1)),
  ratio_cli12_wall_over_session_wall: Number((cli.median / sessionWall.median).toFixed(1)),
  twelve_steps_session_runs: sessionRuns,
  cli_failed_calls: cliFailedCalls,
  pass_twelve_steps_under_300ms: twelveStepsPass(sessionRuns, session),
  waitResponse: wait,
  pass_wait_within_100ms_of_response: wait.ok && typeof wait.result?.after_ms === 'number' && wait.result.after_ms <= 400,
  pointer_opened_pointerdown_menu: menu,
  pass_pointer_opened_menu: menu.ok && menu.result === true,
}, null, 2));
