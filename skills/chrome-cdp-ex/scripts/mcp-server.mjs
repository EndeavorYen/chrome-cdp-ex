#!/usr/bin/env node
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

import {
  MCP_TOOL_DEFINITIONS,
  MCP_RESOURCE_TEMPLATES,
  buildMcpResourceCommand,
  buildMcpToolCommand,
  createMcpInitializeResult,
  listMcpResources,
} from './lib/mcp-adapter.mjs';

const CDP_SCRIPT = fileURLToPath(new URL('./cdp.mjs', import.meta.url));

function encodeMessage(payload) {
  const body = JSON.stringify(payload);
  return `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`;
}

function send(payload) {
  process.stdout.write(encodeMessage(payload));
}

function runCdpCommand(command) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CDP_SCRIPT, ...command], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('close', code => {
      resolve({
        code,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
  });
}

async function handleRequest(message) {
  if (!message || typeof message !== 'object') return;
  if (message.method?.startsWith('notifications/')) return;
  const id = message.id;
  try {
    if (message.method === 'initialize') {
      send({ jsonrpc: '2.0', id, result: createMcpInitializeResult() });
      return;
    }
    if (message.method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: MCP_TOOL_DEFINITIONS } });
      return;
    }
    if (message.method === 'tools/call') {
      const name = message.params?.name;
      const args = message.params?.arguments || {};
      const command = buildMcpToolCommand(name, args);
      const result = await runCdpCommand(command);
      const text = result.code === 0
        ? result.stdout
        : [result.stderr, result.stdout].filter(Boolean).join('\n');
      send({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text }],
          isError: result.code !== 0,
        },
      });
      return;
    }
    if (message.method === 'resources/list') {
      send({ jsonrpc: '2.0', id, result: { resources: listMcpResources() } });
      return;
    }
    if (message.method === 'resources/templates/list') {
      send({
        jsonrpc: '2.0',
        id,
        result: { resourceTemplates: MCP_RESOURCE_TEMPLATES.filter(t => t.uriTemplate.includes('{')) },
      });
      return;
    }
    if (message.method === 'resources/read') {
      const uri = message.params?.uri;
      if (typeof uri !== 'string' || !uri.trim()) throw new Error('resources/read requires uri');
      const command = buildMcpResourceCommand(uri.trim());
      const result = await runCdpCommand(command);
      const text = result.code === 0
        ? result.stdout
        : [result.stderr, result.stdout].filter(Boolean).join('\n');
      if (result.code !== 0) {
        send({
          jsonrpc: '2.0',
          id,
          error: { code: -32000, message: text || `Resource read failed for ${uri}` },
        });
        return;
      }
      const mimeType = uri.includes('/screenshot/') ? 'text/plain' : 'application/json';
      send({
        jsonrpc: '2.0',
        id,
        result: {
          contents: [{ uri, mimeType, text }],
        },
      });
      return;
    }
    send({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${message.method}` },
    });
  } catch (e) {
    send({
      jsonrpc: '2.0',
      id,
      error: { code: -32000, message: e.message || String(e) },
    });
  }
}

let buffer = Buffer.alloc(0);
let requestQueue = Promise.resolve();

function enqueueRequest(message) {
  requestQueue = requestQueue
    .then(() => handleRequest(message))
    .catch(error => {
      send({
        jsonrpc: '2.0',
        id: message?.id ?? null,
        error: { code: -32000, message: error.message || String(error) },
      });
    });
}

function parseBufferedMessages() {
  const messages = [];
  while (buffer.length) {
    const text = buffer.toString('utf8');
    const headerEnd = text.indexOf('\r\n\r\n');
    if (headerEnd !== -1) {
      const header = text.slice(0, headerEnd);
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        buffer = Buffer.alloc(0);
        break;
      }
      const length = Number(match[1]);
      const bodyStart = Buffer.byteLength(text.slice(0, headerEnd + 4), 'utf8');
      if (buffer.length < bodyStart + length) break;
      const body = buffer.slice(bodyStart, bodyStart + length).toString('utf8');
      buffer = buffer.slice(bodyStart + length);
      messages.push(JSON.parse(body));
      continue;
    }

    const newline = text.indexOf('\n');
    if (newline === -1) break;
    const line = text.slice(0, newline).trim();
    buffer = buffer.slice(Buffer.byteLength(text.slice(0, newline + 1), 'utf8'));
    if (line) messages.push(JSON.parse(line));
  }
  return messages;
}

process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  for (const message of parseBufferedMessages()) {
    enqueueRequest(message);
  }
});
