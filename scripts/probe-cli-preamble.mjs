#!/usr/bin/env node
// Wall-clock probe for one `cdp eval` call. Read-only: it only runs `eval <target> document.title`.
//
// Runner:  CDP_PORT=9336 node scripts/probe-cli-preamble.mjs <cdp.mjs path> <target> [runs=10] [out.json]
//          Runs the CLI (runs+1)x, discards the first as warm-up, prints median segments as JSON.
// Preload: TRACE_OUT=trace.txt node --import ./scripts/probe-cli-preamble.mjs <cdp.mjs> eval <target> document.title
//          Logs "<ms since process time origin>  <event>" lines (net connect/write/data/close, fetch, WebSocket,
//          setTimeout >= 5 ms, cpuUsage, exit) to TRACE_OUT. The same file does both jobs.
// It never edits cdp.mjs. Named-import bindings of child_process are not wrapped, so spawnSync is not logged;
// daemon metadata collection (a git spawn before #461) shows up as the gap between a pipe connect and its `meta` write.
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

import { requireTestPort } from './lib/port-guard.mjs';

const SELF_URL = import.meta.url;
const isRunner = Boolean(process.argv[1]) && pathToFileURL(process.argv[1]).href === SELF_URL;

export function parseTrace(text) {
  return text
    .split('\n')
    .map((l) => l.match(/^\s*(\d+(?:\.\d)?)\s+(\S.*)$/))
    .filter(Boolean)
    .map((m) => ({ t: Number(m[1]), e: m[2] }));
}

export function segmentsFromTrace(ev) {
  const idOf = (e) => e.split(' ')[1];
  const pipeConnects = ev.filter((x) => x.e.startsWith('net.connect ') && x.e.includes('pipe'));
  const listRawWrites = ev.filter((x) => x.e.startsWith('net.write') && x.e.includes('list_raw'));
  const evalWrite = ev.find((x) => x.e.startsWith('net.write') && x.e.includes('"cmd":"eval"'));
  const evalReply = ev.find((x) => x.t > evalWrite.t && x.e.startsWith('net.firstdata'));
  const metaWrites = ev.filter((x) => x.e.startsWith('net.write') && x.e.includes('"cmd":"meta"'));
  const cpu = ev.find((x) => x.e.startsWith('cpu '));
  const exit = ev.find((x) => x.e === 'exit');
  const firstConnect = ev.find((x) => x.e.startsWith('net.connect ')).t;
  // discovery span: from each list_raw pipe connection to the next pipe connection
  const disc = listRawWrites.map((w) => {
    const startC = [...pipeConnects].reverse().find((c) => c.t <= w.t);
    const nextC = pipeConnects.find((c) => c.t > startC.t);
    return Number((nextC.t - startC.t).toFixed(1));
  });
  // collectDaemonMetadata (git spawnSync) sits between a pipe connect and its meta write
  const gaps = metaWrites
    .map((w) => {
      const c = ev.find((x) => x.e.startsWith('net.connect ') && idOf(x.e) === idOf(w.e));
      return c ? w.t - c.t : null;
    })
    .filter((g) => g != null);
  const num = (re) => Number(cpu.e.match(re)[1]);
  return {
    boot_to_preload: ev[0].t,
    module_load: Number((firstConnect - ev[0].t).toFixed(1)),
    discoveries_ms: disc,
    discoveries_total: Number(disc.reduce((a, b) => a + b, 0).toFixed(1)),
    git_gap: Number(Math.max(0, ...gaps).toFixed(1)),
    eval_rtt: Number((evalReply.t - evalWrite.t).toFixed(1)),
    tail_after_eval: Number((exit.t - evalReply.t).toFixed(1)),
    exit_at: exit.t,
    cpu_ms: Number((num(/user=([\d.]+)/) + num(/sys=([\d.]+)/)).toFixed(1)),
  };
}

function installProbe() {
  const out = process.env.TRACE_OUT;
  if (!out) throw new Error('TRACE_OUT must be set when preloading the probe');
  const events = [];
  const log = (e) => events.push(`${String(Number(performance.now().toFixed(1))).padStart(7)}  ${e}`);
  const short = (d) => String(d).slice(0, 70).split('\n').join('\\n');
  log('preload-start (ms since process timeOrigin)');
  const ow = net.Socket.prototype.write;
  net.Socket.prototype.write = function (d, ...r) {
    log(`net.write ${this.__id} ${String(d).length}B ${short(d)}`);
    return ow.call(this, d, ...r);
  };
  const origConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...a) {
    const desc = typeof a[0] === 'object' ? JSON.stringify(a[0]).slice(0, 80) : String(a[0]);
    const id = Math.random().toString(36).slice(2, 5);
    this.__id = id;
    log(`net.connect ${id} ${desc}`);
    this.once('connect', () => log(`net.connected ${id}`));
    this.on('error', (e) => log(`net.error ${id} ${e.code}`));
    let first = true;
    this.on('data', (d) => {
      if (first) {
        first = false;
        log(`net.firstdata ${id} ${d.length}B ${short(d)}`);
      }
    });
    this.once('close', () => log(`net.close ${id}`));
    return origConnect.apply(this, a);
  };
  const of = globalThis.fetch;
  globalThis.fetch = async (...a) => {
    log(`fetch ${a[0]} START`);
    try {
      return await of(...a);
    } finally {
      log('fetch END');
    }
  };
  const ost = globalThis.setTimeout;
  globalThis.setTimeout = function (fn, ms, ...r) {
    if (ms >= 5) log(`setTimeout ${ms}ms armed`);
    return ost(fn, ms, ...r);
  };
  const OWS = globalThis.WebSocket;
  if (OWS) {
    globalThis.WebSocket = class extends OWS {
      constructor(u, ...r) {
        super(u, ...r);
        log(`ws new ${u}`);
        this.addEventListener('open', () => log('ws open'));
      }
      send(d) {
        log(`ws send ${short(d)}`);
        return super.send(d);
      }
    };
  }
  process.on('exit', () => {
    const c = process.cpuUsage();
    log(`cpu user=${(c.user / 1000).toFixed(1)} sys=${(c.system / 1000).toFixed(1)}`);
    log('exit');
    appendFileSync(out, `${events.join('\n')}\n`);
  });
}

function median(rows, key) {
  const a = rows.map((r) => r[key]).sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)];
}

function runProbe([script, target, runsArg, outJson]) {
  requireTestPort(); // runner only (the preload child inherits the checked env); exits 2 before any spawn
  const runs = Number(runsArg || 10);
  if (!script || !target || !Number.isInteger(runs) || runs < 1) {
    console.error('usage: CDP_PORT=<port> node scripts/probe-cli-preamble.mjs <cdp.mjs> <target> [runs] [out.json]');
    process.exit(2);
  }
  const dir = mkdtempSync(join(tmpdir(), 'cdp-seg-'));
  const rows = [];
  for (let i = 0; i <= runs; i++) {
    const out = join(dir, `t${i}.txt`);
    const t0 = performance.now();
    const r = spawnSync(process.execPath, ['--import', SELF_URL, script, 'eval', target, 'document.title'], {
      encoding: 'utf8',
      env: { ...process.env, TRACE_OUT: out },
    });
    const wall = performance.now() - t0;
    if (r.status !== 0) throw new Error(r.stderr + r.stdout);
    if (i === 0) continue; // warm-up: the per-tab daemon may be cold
    rows.push({ wall_ms: Number(wall.toFixed(1)), ...segmentsFromTrace(parseTrace(readFileSync(out, 'latin1'))) });
  }
  const keys = ['wall_ms', 'boot_to_preload', 'module_load', 'discoveries_total', 'git_gap', 'eval_rtt', 'tail_after_eval', 'exit_at', 'cpu_ms'];
  const summary = Object.fromEntries(keys.map((k) => [k, median(rows, k)]));
  summary.discovery_count_median = rows.map((r) => r.discoveries_ms.length).sort()[Math.floor(rows.length / 2)];
  if (outJson) writeFileSync(outJson, `${JSON.stringify({ script, runs, summary, rows }, null, 2)}\n`);
  console.log(JSON.stringify(summary));
}

if (isRunner) runProbe(process.argv.slice(2));
else if (process.env.TRACE_OUT) installProbe();
