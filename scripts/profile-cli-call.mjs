#!/usr/bin/env node
// Run one CLI call under `node --cpu-prof` and print the functions with the most self time.
// Usage: CDP_PORT=9336 node scripts/profile-cli-call.mjs <target> [expression]
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { requireTestPort } from './lib/port-guard.mjs';

const CDP = fileURLToPath(new URL('../skills/chrome-cdp-ex/scripts/cdp.mjs', import.meta.url));

export function topSelfTime(profile, n = 15) {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const selfUs = new Map();
  profile.samples.forEach((id, i) => selfUs.set(id, (selfUs.get(id) || 0) + (profile.timeDeltas[i] || 0)));
  const total = [...selfUs.values()].reduce((a, b) => a + b, 0) || 1;
  return [...selfUs.entries()]
    .map(([id, us]) => {
      const cf = byId.get(id).callFrame;
      return {
        fn: cf.functionName || '(anonymous)',
        where: `${cf.url.split('/').pop()}:${cf.lineNumber + 1}`,
        ms: Number((us / 1000).toFixed(1)),
        pct: Number(((us / total) * 100).toFixed(1)),
      };
    })
    .sort((a, b) => b.ms - a.ms)
    .slice(0, n);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  requireTestPort(); // exits 2 before any spawn: never 9222/9224 or an unset port
  const [target, expression = 'document.title'] = process.argv.slice(2);
  if (!target) {
    console.error('usage: node scripts/profile-cli-call.mjs <target> [expression]');
    process.exit(2);
  }
  const dir = mkdtempSync(join(tmpdir(), 'cdp-prof-'));
  const r = spawnSync(process.execPath, ['--cpu-prof', `--cpu-prof-dir=${dir}`, CDP, 'eval', target, expression], { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(r.stdout + r.stderr);
    process.exit(1);
  }
  // the daemon may write its own profile; pick the largest file (the CLI process)
  const files = readdirSync(dir).filter((f) => f.endsWith('.cpuprofile'));
  const profiles = files.map((f) => ({ f, body: readFileSync(join(dir, f), 'utf8') })).sort((a, b) => b.body.length - a.body.length);
  console.log(JSON.stringify({ dir, files, top: topSelfTime(JSON.parse(profiles[0].body), 20) }, null, 2));
}
