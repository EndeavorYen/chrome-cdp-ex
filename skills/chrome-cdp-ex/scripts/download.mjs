#!/usr/bin/env node
// download.mjs <target> <url> <out-file> [--max-mb N] [--force]
// Fetch a URL inside the tab's login session and save it to a local file (#397).
// Not a catalog command: it drives the existing `evalraw Runtime.evaluate` route, so it honours
// CDP_PORT / CDP_HOST like cdp.mjs does.
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { downloadViaPage, formatDownloadReceipt, parseDownloadArgs } from './lib/page-download.mjs';

const execFileAsync = promisify(execFile);
const CDP_PATH = fileURLToPath(new URL('./cdp.mjs', import.meta.url));

export function createEvaluate(target, { run = execFileAsync, cdpPath = CDP_PATH } = {}) {
  return async (expression) => {
    const params = JSON.stringify({ expression, awaitPromise: true, returnByValue: true });
    const { stdout } = await run(process.execPath, [cdpPath, 'evalraw', target, 'Runtime.evaluate', params], {
      maxBuffer: 16 * 1024 * 1024,
      env: process.env,
    });
    let reply;
    try {
      reply = JSON.parse(stdout);
    } catch {
      throw new Error(`download: unexpected evalraw output: ${String(stdout).slice(0, 120)}`);
    }
    if (reply.exceptionDetails) {
      throw new Error(`download: page error: ${reply.exceptionDetails.exception?.description || reply.exceptionDetails.text}`);
    }
    return reply.result?.value;
  };
}

export async function main(argv, { evaluateFactory = createEvaluate, log = console.log } = {}) {
  const { target, url, outFile, maxBytes, force } = parseDownloadArgs(argv);
  const receipt = await downloadViaPage({ evaluate: evaluateFactory(target), url, outFile, maxBytes, force });
  log(formatDownloadReceipt(receipt));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exit(error.code === 'usage' ? 2 : 1);
  });
}
