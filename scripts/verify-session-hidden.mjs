#!/usr/bin/env node
// Hidden-tab check for session.mjs pointer(): opens a second tab so the first becomes hidden, records both
// tabs' visibilityState, then runs pointer('#menu') on the hidden tab through session.mjs. Needs a debug
// browser YOU started on CDP_PORT (never the user's own Chrome). Prints one JSON object.
// Usage: CDP_PORT=9336 node scripts/verify-session-hidden.mjs <target> [runs]
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { requireTestPort } from './lib/port-guard.mjs';

requireTestPort(); // exits 2 on unset, empty, invalid, 9222 or 9224, before any spawn or connect
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CDP = join(ROOT, 'skills/chrome-cdp-ex/scripts/cdp.mjs');
const SESSION = join(ROOT, 'skills/chrome-cdp-ex/scripts/session.mjs');
const target = process.argv[2];
const runs = Number(process.argv[3] ?? 3);
if (!target) { console.error('usage: node scripts/verify-session-hidden.mjs <target> [runs]'); process.exit(2); }

const PAGE = `<!doctype html><title>fixture</title>
<button id="menu" onpointerdown="document.getElementById('m').hidden=false">menu</button>
<div id="m" hidden>1080p</div>`;
// The server lives in this process, so children are spawned async (spawnSync would starve it).
const server = createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(PAGE); }).listen(0);
const port = server.address().port;

const dir = mkdtempSync(join(tmpdir(), 'session-hidden-'));
const menuPath = join(dir, 'menu.mjs');
writeFileSync(menuPath, `export default async ({ page }) => {
  const visibility_before_pointer = await page.ev('document.visibilityState');
  const menu_open_before = await page.ev("!document.getElementById('m').hidden");
  await page.pointer('#menu');
  return { visibility_before_pointer, menu_open_before, menu_open_after: await page.ev("!document.getElementById('m').hidden") };
};`);
const stateJs = 'document.visibilityState';
const run = (args) => new Promise((resolve) => {
  const child = spawn(process.execPath, args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.on('close', (status) => resolve({ status, stdout: stdout.trim() }));
});

const results = [];
for (let i = 0; i < runs; i++) {
  await run([CDP, 'nav', target, `http://127.0.0.1:${port}/`]); // fresh page: menu closed
  const opened = await run([CDP, 'open', 'about:blank']); // second tab takes the foreground
  const second = /Opened new tab:\s+(\S+)/.exec(opened.stdout)?.[1] ?? null;
  const firstState = (await run([CDP, 'eval', target, stateJs])).stdout;
  const secondState = second ? (await run([CDP, 'eval', second, stateJs])).stdout : null;
  const child = await run([SESSION, target, '--script', menuPath]);
  let receipt;
  try { receipt = JSON.parse(child.stdout); } catch { receipt = { ok: false, error: `no JSON receipt (exit ${child.status})` }; }
  results.push({
    run: i + 1,
    first_tab_visibility: firstState,
    second_tab_visibility: secondState,
    became_hidden: firstState === 'hidden',
    session_receipt: receipt,
    pass: firstState === 'hidden' && child.status === 0 && receipt.ok === true && receipt.result?.menu_open_before === false && receipt.result?.menu_open_after === true,
  });
  if (second) await run([CDP, 'closetab', second]); // give focus back so the next run starts clean
}
server.close();
console.log(JSON.stringify({ first_tab_target: target, runs: results, pass_all_runs_hidden_and_pointer_worked: results.every((r) => r.pass) }, null, 2));
