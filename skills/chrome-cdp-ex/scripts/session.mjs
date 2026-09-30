#!/usr/bin/env node
// session.mjs <target> --script <file.mjs> --port N [--args <json>] [--host H]   (Node >= 22; CDP_PORT may replace --port)
// One CDP connection, one script. The script's default export receives { page, args } and may await many
// page.* calls; the connection cost is paid once. Not a catalog command (like download.mjs).
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { CdpSession } from './lib/cdp-session.mjs';
import { connect as realConnect } from './lib/ws-transport.mjs';

const messageOf = (error) => (error instanceof Error ? error.message : String(error));

const USAGE = 'usage: session.mjs <target> --script <file.mjs> --port N [--args <json>] [--host H]   (or set CDP_PORT instead of --port)';

// No default port on purpose: a default would silently attach to whatever browser owns it (e.g. the daily one).
export function parseSessionArgs(argv, env = process.env) {
  let portText = env.CDP_PORT;
  const out = { target: null, script: null, args: {}, port: null, host: env.CDP_HOST || '127.0.0.1' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--script') out.script = argv[++i];
    else if (a === '--args') {
      try { out.args = JSON.parse(argv[++i]); } catch { throw new Error('--args must be JSON'); }
    } else if (a === '--port') portText = argv[++i];
    else if (a === '--host') out.host = argv[++i];
    else if (a.startsWith('--')) throw new Error(`unknown flag ${a}`);
    else if (!out.target) out.target = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  if (!out.target || !out.script) throw new Error(USAGE);
  const trimmed = String(portText ?? '').trim();
  if (trimmed === '') throw new Error(`port is required: pass --port N or set CDP_PORT\n${USAGE}`);
  const port = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`port must be an integer from 1 to 65535, got "${portText}"\n${USAGE}`);
  out.port = port;
  return out;
}

export async function runSession({ target, script, args, port, host }, { connect = realConnect } = {}) {
  const t0 = Date.now();
  let conn;
  try {
    let fn;
    try {
      if (!existsSync(script)) throw new Error('file not found');
      fn = (await import(/* @vite-ignore */ pathToFileURL(resolve(script)).href)).default;
    } catch (error) {
      throw new Error(`cannot load script ${script}: ${messageOf(error)}`);
    }
    if (typeof fn !== 'function') throw new Error(`script ${script} needs a default export function`);
    conn = await connect({ host, port, target });
    const page = new CdpSession(conn.transport, conn.sessionId);
    const result = await fn({ page, args });
    return { schema: 'chrome-cdp-ex.session.v1', ok: true, ms: Date.now() - t0, target: conn.targetId, result: result ?? null };
  } catch (error) {
    return { schema: 'chrome-cdp-ex.session.v1', ok: false, ms: Date.now() - t0, target, error: messageOf(error) };
  } finally {
    conn?.close();
  }
}

// A result that JSON cannot hold (BigInt, circular) must not crash the printer: degrade to an ok:false receipt.
export function serializeReceipt(receipt) {
  try {
    return { line: JSON.stringify(receipt), ok: receipt.ok === true };
  } catch (error) {
    const failed = { schema: receipt.schema, ok: false, ms: receipt.ms, target: receipt.target, error: `result is not JSON-serialisable: ${messageOf(error)}` };
    return { line: JSON.stringify(failed), ok: false };
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (typeof globalThis.WebSocket !== 'function') {
    console.error(`session.mjs needs Node >= 22 (global WebSocket); this is Node ${process.versions.node}`);
    process.exit(2);
  }
  let parsed;
  try {
    parsed = parseSessionArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  const t0 = Date.now();
  let printed = false;
  const finish = (receipt) => {
    if (printed) return;
    printed = true;
    const { line, ok } = serializeReceipt(receipt);
    console.log(line);
    process.exit(ok ? 0 : 1);
  };
  // A job may leave a promise unawaited or throw from a timer; that still ends in exactly one receipt.
  const crash = (kind) => (error) => finish({ schema: 'chrome-cdp-ex.session.v1', ok: false, ms: Date.now() - t0, target: parsed.target, error: `${kind}: ${messageOf(error)}` });
  process.on('unhandledRejection', crash('unhandled rejection'));
  process.on('uncaughtException', crash('uncaught exception'));
  runSession(parsed).then(finish);
}
