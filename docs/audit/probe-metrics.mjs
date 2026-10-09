#!/usr/bin/env node
// Phase D metrics: one row per probe run, from the logging wrapper's JSONL, the judge's verdict and the
// agent's final answer, compared with the scenario's reference path (docs/audit/scenarios.md).
//   node docs/audit/probe-metrics.mjs <probeDir> [--json]
// <probeDir>/<NN>/ holds calls.jsonl, verdict.json, handoff.json, answer.txt and agent.json
// ({ model, totalTokens, toolUses, durationMs } from the agent run, when known).
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Reference paths measured in the validation-lab run (docs/audit/scenarios.md, Summary).
const REFERENCE = {
  '01': { calls: 6, chars: 3369 }, '02': { calls: 6, chars: 1853 }, '03': { calls: 6, chars: 4444 },
  '04': { calls: 10, chars: 1899 }, '05': { calls: 4, chars: 2064 }, '06': { calls: 8, chars: 2606 },
  '07': { calls: 4, chars: 2786 }, '08': { calls: 3, chars: 561 }, '09': { calls: 5, chars: 1483 },
  '10': { calls: 3, chars: 369 }, '11': { calls: 7, chars: 1770 }, '12': { calls: 2, chars: 279 },
};
const ACTIONS = new Set(['click', 'fill', 'press', 'select', 'scroll', 'dismiss-modal', 'nav', 'type', 'clickxy', 'jsclick', 'upload', 'eval', 'batch', 'flow']);
const INVENTED = /unknown (option|argument|flag)|Unknown command|unexpected argument|is not a valid (option|flag)|Did you mean/i;

const read = path => (existsSync(path) ? readFileSync(path, 'utf8') : '');
const json = path => { try { return JSON.parse(read(path)); } catch { return null; } };

// The command an output tells the agent to run next, as argv (prefix and quotes normalised).
function nextOf(text) {
  const lines = String(text).split('\n').filter(l => /^Next: /.test(l));
  if (!lines.length) return null;
  const cmd = lines.at(-1).replace(/^Next:\s*/, '').replace(/\s+\(Kind: [^)]*\)\s*$/, '').replace(/\s+#.*$/, '').trim();
  const words = cmd.match(/"[^"]*"|'[^']*'|\S+/g) || [];
  if (words[0] !== 'cdp') return null;
  return words.slice(1).map(w => w.replace(/^["']|["']$/g, ''));
}

const sameTarget = (a, b) => !a || !b || a.slice(0, 8).toUpperCase() === b.slice(0, 8).toUpperCase();

function metrics(dir, nn) {
  const calls = read(join(dir, 'calls.jsonl')).split('\n').filter(Boolean).map(l => JSON.parse(l));
  // A corrected verdict (a judge bug fixed after the run, applied to the same answer and transcript) wins.
  const corrected = json(join(dir, 'verdict.corrected.json'));
  const verdict = corrected || json(join(dir, 'verdict.json')) || {};
  const agent = json(join(dir, 'agent.json')) || {};
  const out = calls.map(c => `${c.stdout || ''}${c.stderr || ''}`);
  const chars = out.reduce((n, t) => n + t.length, 0);
  let nextAvailable = 0;
  let nextFollowed = 0;
  calls.forEach((c, i) => {
    const next = nextOf(out[i]);
    if (!next || i + 1 >= calls.length) return;
    nextAvailable += 1;
    const actual = calls[i + 1].args;
    if (actual[0] === next[0] && sameTarget(actual[1], next[1])) nextFollowed += 1;
  });
  let redundantPerceive = 0;
  calls.forEach((c, i) => {
    if (c.args[0] !== 'perceive' || i === 0) return;
    const prev = calls.slice(0, i).reverse().find(p => p.args[0] === 'perceive' || ACTIONS.has(p.args[0]));
    if (prev?.args[0] === 'perceive' && prev.args[1] === c.args[1] && !c.args.includes('--since-action')) redundantPerceive += 1;
  });
  const cliMs = calls.reduce((n, c) => n + (c.ms || 0), 0);
  const wallMs = calls.length ? (calls.at(-1).startedAt + calls.at(-1).ms) - calls[0].startedAt : 0;
  const ref = REFERENCE[nn] || {};
  return {
    nn,
    id: verdict.id || null,
    pass: verdict.pass === true,
    failures: (verdict.failures || []).map(f => f.code),
    correction: corrected?.correction || null,
    prompt: agent.prompt || 'v1',
    model: agent.model || null,
    calls: calls.length,
    failedCalls: calls.filter(c => c.exit !== 0).length,
    inventedOrUnknown: calls.filter((c, i) => INVENTED.test(out[i])).length,
    usageErrors: out.filter(t => /Kind: usage/.test(t)).length,
    perceive: calls.filter(c => c.args[0] === 'perceive').length,
    redundantPerceive,
    helpCalls: calls.filter(c => c.args[0] === 'help' || c.args.includes('--help') || c.args.includes('-h')).length,
    nextAvailable,
    nextFollowed,
    commands: [...new Set(calls.map(c => c.args[0]))],
    callerCdpEnv: [...new Set(calls.flatMap(c => Object.keys(c.callerCdpEnv || {})))],
    budgetExhausted: calls.some(c => c.budget),
    chars,
    tokensEst: Math.round(chars / 4),
    charsPerCall: calls.length ? Math.round(chars / calls.length) : 0,
    cliMs,
    wallMs,
    thinkMs: Math.max(0, wallMs - cliMs),
    agentTokens: agent.totalTokens ?? null,
    agentToolUses: agent.toolUses ?? null,
    agentDurationMs: agent.durationMs ?? null,
    vsReference: ref.calls ? { calls: +(calls.length / ref.calls).toFixed(1), chars: +(chars / ref.chars).toFixed(1) } : null,
    answer: read(join(dir, 'answer.txt')).trim(),
    steps: calls.map(c => ({ cmd: c.args.map(a => (/^[0-9A-F]{8,32}$/i.test(a) ? '<t>' : a)).join(' '), exit: c.exit, ms: c.ms, chars: `${c.stdout || ''}${c.stderr || ''}`.length })),
  };
}

const probeDir = process.argv[2];
if (!probeDir) {
  console.error('usage: node docs/audit/probe-metrics.mjs <probeDir> [--json]');
  process.exit(2);
}
// Official runs live in <NN>; --all adds archived ones (<NN>smoke, <NN>v1, <NN>invalid).
const pattern = process.argv.includes('--all') ? /^\d\d[a-z0-9]*$/ : /^\d\d$/;
const rows = readdirSync(probeDir).filter(n => pattern.test(n)).sort().map(name => ({ ...metrics(join(probeDir, name), name.slice(0, 2)), run: name }));
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  console.log('| # | Result | Failure codes | Calls (ref) | Failed calls | Next followed | Perceive (redundant) | Chars (~tokens) | CLI / think s |');
  console.log('|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    console.log(`| ${r.nn} | ${r.pass ? 'pass' : 'FAIL'} | ${r.failures.join(', ') || '—'} | ${r.calls} (${REFERENCE[r.nn]?.calls ?? '?'}) | ${r.failedCalls} | ${r.nextFollowed}/${r.nextAvailable} | ${r.perceive} (${r.redundantPerceive}) | ${r.chars} (~${r.tokensEst}) | ${(r.cliMs / 1000).toFixed(1)} / ${(r.thinkMs / 1000).toFixed(1)} |`);
  }
}
