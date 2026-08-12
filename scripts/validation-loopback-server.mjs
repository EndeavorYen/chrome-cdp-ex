#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

export function createValidationLoopbackServer({ port, pagePath }) {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('validation loopback port must be an integer from 1 to 65535');
  }
  if (typeof pagePath !== 'string' || pagePath.length === 0) {
    throw new Error('validation loopback pagePath is required');
  }
  const page = readFileSync(pagePath);
  const server = createServer((request, response) => {
    if (request.url === '/validation-phase4.html'
      || request.url === '/validation-phase4.html?route=mcp') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(page);
      return;
    }
    response.writeHead(404);
    response.end('not found');
  });
  return server;
}

async function main() {
  const port = Number(process.argv[2]);
  const pagePath = process.argv[3];
  const server = createValidationLoopbackServer({ port, pagePath });
  const close = () => server.close(() => { process.exitCode = 0; });
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  process.stdout.write(`READY ${port}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => {
    process.stderr.write(`Validation loopback server failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
