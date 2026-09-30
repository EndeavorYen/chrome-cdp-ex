#!/usr/bin/env node
// session.mjs <target> --script <file.mjs> [--args <json>] [--port N] [--host H]
// One CDP connection, one script. The script's default export receives { page, args } and may await many
// page.* calls; the connection cost is paid once. Not a catalog command (like download.mjs).
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { CdpSession } from './lib/cdp-session.mjs';
import { connect as realConnect } from './lib/ws-transport.mjs';

const USAGE = 'usage: session.mjs <target> --script <file.mjs> [--args <json>] [--port N] [--host H]';

export function parseSessionArgs(argv) {
  const out = { target: null, script: null, args: {}, port: Number(process.env.CDP_PORT || 9222), host: process.env.CDP_HOST || '127.0.0.1' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--script') out.script = argv[++i];
    else if (a === '--args') {
      try { out.args = JSON.parse(argv[++i]); } catch { throw new Error('--args must be JSON'); }
    } else if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--host') out.host = argv[++i];
    else if (a.startsWith('--')) throw new Error(`unknown flag ${a}`);
    else if (!out.target) out.target = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  if (!out.target || !out.script) throw new Error(USAGE);
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
      throw new Error(`cannot load script ${script}: ${error.message}`);
    }
    if (typeof fn !== 'function') throw new Error(`script ${script} needs a default export function`);
    conn = await connect({ host, port, target });
    const page = new CdpSession(conn.transport, conn.sessionId);
    const result = await fn({ page, args });
    return { schema: 'chrome-cdp-ex.session.v1', ok: true, ms: Date.now() - t0, target: conn.targetId, result: result ?? null };
  } catch (error) {
    return { schema: 'chrome-cdp-ex.session.v1', ok: false, ms: Date.now() - t0, target, error: error.message };
  } finally {
    conn?.close();
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  let parsed;
  try {
    parsed = parseSessionArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  runSession(parsed).then((receipt) => {
    console.log(JSON.stringify(receipt));
    process.exit(receipt.ok ? 0 : 1);
  });
}
