#!/usr/bin/env node
// MCP payload probe for docs/audit/findings.md (B-12) and token-perf.md. Drives the stdio MCP server
// against a tab you opened on a test browser and records each response's size and content blocks.
// The click call targets the covered #save button of the overlay fixture, so it is refused.
//   CDP_PORT=<test port> node docs/audit/mcp-probe.mjs <target-prefix> <out.json>
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireTestPort } from '../../scripts/lib/port-guard.mjs';

requireTestPort();
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const [target, outPath] = process.argv.slice(2);
if (!target || !outPath) {
  console.error('usage: CDP_PORT=<test port> node docs/audit/mcp-probe.mjs <target-prefix> <out.json>');
  process.exit(2);
}
const server = spawn(process.execPath, [join(root, 'skills/chrome-cdp-ex/scripts/mcp-server.mjs')], { stdio: ['pipe', 'pipe', 'inherit'] });
let buffered = Buffer.alloc(0);
const waiters = new Map();
server.stdout.on('data', chunk => {
  buffered = Buffer.concat([buffered, chunk]);
  let nl;
  while ((nl = buffered.indexOf(10)) >= 0) {
    const line = buffered.subarray(0, nl).toString('utf8').trim();
    buffered = buffered.subarray(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    waiters.get(msg.id)?.({ msg, bytes: Buffer.byteLength(line) });
  }
});
let nextId = 1;
const call = (method, params) => new Promise(resolve => {
  const id = nextId++;
  waiters.set(id, resolve);
  server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
});

const results = [];
async function record(label, method, params) {
  const t0 = Date.now();
  const { msg, bytes } = await call(method, params);
  const content = msg.result?.content || [];
  const entry = {
    label,
    ms: Date.now() - t0,
    bytes,
    isError: Boolean(msg.result?.isError || msg.error),
    blocks: content.map(c => ({ type: c.type, chars: c.type === 'text' ? c.text.length : (c.data || '').length })),
    structuredChars: msg.result?.structuredContent ? JSON.stringify(msg.result.structuredContent).length : 0,
    text: content.filter(c => c.type === 'text').map(c => c.text).join('\n'),
    error: msg.error || null,
  };
  results.push(entry);
  console.log(`${label}: ${bytes} B, ${entry.ms} ms, blocks=${JSON.stringify(entry.blocks)}, structured=${entry.structuredChars}${entry.isError ? ' ERROR' : ''}`);
  return msg;
}

await record('initialize', 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'audit-probe', version: '0' } });
server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
const list = await record('tools/list', 'tools/list', {});
console.log('tools:', (list.result?.tools || []).map(t => t.name).join(', '));
await record('perceive', 'tools/call', { name: 'perceive', arguments: { target } });
await record('screenshot', 'tools/call', { name: 'screenshot', arguments: { target } });
await record('click covered #save', 'tools/call', { name: 'click', arguments: { target, selector: '#save', confirm: true } });
await record('run_command status', 'tools/call', { name: 'run_command', arguments: { command: 'status', args: [target] } });
await record('run_command jsclick', 'tools/call', { name: 'run_command', arguments: { command: 'jsclick', args: [target, '#save'], confirm: true } });
await record('run_command eval', 'tools/call', { name: 'run_command', arguments: { command: 'eval', args: [target, '1+1'], confirm: true } });
await record('unlisted tool report', 'tools/call', { name: 'report', arguments: { target } });
writeFileSync(outPath, `${JSON.stringify(results, null, 2)}\n`);
server.stdin.end();
server.kill();
