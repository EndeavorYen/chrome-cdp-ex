// Download a URL with the page's own login session (#397).
// `evaluate(expression)` runs JS in the page (Runtime.evaluate, awaitPromise) and resolves to a string.
// The body stays in the page as a Blob and is read back in small base64 chunks, so no single CDP
// reply carries the whole file.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

export const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;
export const DEFAULT_CHUNK_BYTES = 2 * 1024 * 1024;

function downloadError(code, message) {
  const error = new Error(`download: ${message}`);
  error.code = code;
  return error;
}

export function redactDownloadUrl(url) {
  const value = String(url);
  if (value.startsWith('data:')) {
    const comma = value.indexOf(',');
    if (comma < 0) return 'data:(invalid)';
    return `${value.slice(0, comma + 1)}(${value.length - comma - 1} chars)`;
  }
  try {
    const parsed = new URL(value);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return value.slice(0, 117) + (value.length > 117 ? '...' : '');
  }
}

export function parseDownloadArgs(args) {
  const positional = [];
  let maxBytes = DEFAULT_MAX_BYTES;
  let force = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--force') force = true;
    else if (arg === '--max-mb') {
      const mb = Number(args[++i]);
      if (!Number.isFinite(mb) || mb <= 0) throw downloadError('usage', '--max-mb needs a positive number');
      maxBytes = Math.floor(mb * 1024 * 1024);
    } else if (String(arg).startsWith('--')) throw downloadError('usage', `unknown flag ${arg}`);
    else positional.push(arg);
  }
  if (positional.length !== 3) {
    throw downloadError('usage', 'usage: download.mjs <target> <url> <out-file> [--max-mb N] [--force]');
  }
  const [target, url, outFile] = positional;
  return { target, url, outFile, maxBytes, force };
}

function startExpression(url, maxBytes) {
  return `(async()=>{
    const r = await fetch(${JSON.stringify(url)}, {credentials: 'include'});
    if (!r.ok) return JSON.stringify({ok: false, status: r.status, type: '', size: 0});
    const declared = Number(r.headers.get('content-length'));
    if (declared > ${maxBytes}) return JSON.stringify({ok: true, status: r.status, type: '', size: declared, tooLarge: true});
    const blob = await r.blob();
    window.__cdpDownload = {blob};
    return JSON.stringify({ok: true, status: r.status, type: blob.type || r.headers.get('content-type') || '', size: blob.size});
  })()`;
}

function chunkExpression(start, end) {
  return `(async()=>{
    const bytes = new Uint8Array(await window.__cdpDownload.blob.slice(${start},${end}).arrayBuffer());
    let s = '';
    for (let i = 0; i < bytes.length; i += 32768) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
    return btoa(s);
  })()`;
}

const CLEANUP_EXPRESSION = "(()=>{ delete window.__cdpDownload; return 'ok'; })()";

export async function downloadViaPage({
  evaluate,
  url,
  outFile,
  maxBytes = DEFAULT_MAX_BYTES,
  chunkBytes = DEFAULT_CHUNK_BYTES,
  force = false,
}) {
  if (typeof evaluate !== 'function') throw downloadError('usage', 'evaluate function required');
  if (!force && existsSync(outFile)) {
    throw downloadError('exists', `${outFile} already exists (use --force to overwrite)`);
  }
  // Create the parent folder before any page work, so a bad path fails before a paid fetch (#418).
  const folder = dirname(outFile);
  try {
    await mkdir(folder, { recursive: true });
  } catch (error) {
    throw downloadError('mkdir', `cannot create folder ${folder}: ${error.code || error.message}`);
  }
  const partFile = `${outFile}.part`;
  let handle = null;
  try {
    const meta = JSON.parse(await evaluate(startExpression(url, maxBytes)));
    if (!meta.ok) throw downloadError('http_status', `HTTP ${meta.status} for ${redactDownloadUrl(url)}`);
    if (meta.tooLarge || meta.size > maxBytes) {
      throw downloadError('too_large', `body is ${meta.size} bytes, over the ${maxBytes} byte cap`);
    }
    handle = await open(partFile, 'w');
    const hash = createHash('sha256');
    let written = 0;
    while (written < meta.size) {
      const end = Math.min(written + chunkBytes, meta.size);
      const base64 = await evaluate(chunkExpression(written, end));
      const chunk = Buffer.from(base64, 'base64');
      if (chunk.length !== end - written) {
        throw downloadError('short_read', `expected ${end - written} bytes at offset ${written}, got ${chunk.length}`);
      }
      await handle.write(chunk);
      hash.update(chunk);
      written = end;
    }
    await handle.close();
    handle = null;
    await rename(partFile, outFile);
    return {
      url: redactDownloadUrl(url),
      status: meta.status,
      contentType: meta.type,
      bytes: written,
      sha256: hash.digest('hex'),
      path: outFile,
    };
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await rm(partFile, { force: true }).catch(() => {});
    throw error;
  } finally {
    await evaluate(CLEANUP_EXPRESSION).catch(() => {});
  }
}

export function formatDownloadReceipt(receipt) {
  return [
    'downloaded',
    `url=${receipt.url}`,
    `status=${receipt.status}`,
    `type=${receipt.contentType || 'unknown'}`,
    `bytes=${receipt.bytes}`,
    `sha256=${receipt.sha256}`,
    `path=${receipt.path}`,
  ].join(' ');
}
