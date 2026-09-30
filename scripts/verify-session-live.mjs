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

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CDP = join(ROOT, 'skills/chrome-cdp-ex/scripts/cdp.mjs');
const SESSION = join(ROOT, 'skills/chrome-cdp-ex/scripts/session.mjs');
if (['9222', '9224'].includes(String(process.env.CDP_PORT ?? '').trim())) {
  console.error('refusing to run: CDP_PORT is your own Chrome, not a test browser; start your own headless Chrome on another port');
  process.exit(2);
}
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
writeFileSync(waitPath, `export default async ({ page, args }) => {
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
await run([CDP, 'nav', target, `http://127.0.0.1:${port}/`]);

const sessionMs = []; // receipt ms: measured inside session.mjs, excludes Node startup (the pass threshold uses this)
const sessionWallMs = []; // wall-clock around the whole `node session.mjs` process, includes Node startup
for (let i = 0; i < 8; i++) {
  const t0 = Date.now();
  const r = await run([SESSION, target, '--script', jobPath]);
  sessionWallMs.push(Date.now() - t0);
  sessionMs.push(JSON.parse(r.stdout).ms);
}
const cliMs = [];
for (let r = 0; r < 3; r++) {
  const t0 = Date.now();
  for (let i = 0; i < 12; i++) await run([CDP, 'eval', target, 'document.title']);
  cliMs.push(Date.now() - t0);
}
const wait = JSON.parse((await run([SESSION, target, '--script', waitPath])).stdout);
const menu = JSON.parse((await run([SESSION, target, '--script', menuPath])).stdout);
server.close();

const session = summarize(sessionMs);
const sessionWall = summarize(sessionWallMs);
const cli = summarize(cliMs);
console.log(JSON.stringify({
  twelve_steps_via_session_receipt_ms_in_process: session,
  twelve_steps_via_session_wall_clock_ms_per_process: sessionWall,
  twelve_steps_via_12_cli_calls_wall_clock_ms: cli,
  ratio_cli12_wall_over_session_receipt: Number((cli.median / session.median).toFixed(1)),
  ratio_cli12_wall_over_session_wall: Number((cli.median / sessionWall.median).toFixed(1)),
  pass_twelve_steps_under_300ms: session.median <= 300,
  waitResponse: wait,
  pass_wait_within_100ms_of_response: wait.ok && wait.result.after_ms <= 400,
  pointer_opened_pointerdown_menu: menu,
}, null, 2));
