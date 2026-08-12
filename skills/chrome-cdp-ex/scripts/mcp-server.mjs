#!/usr/bin/env node
import { resolve } from 'path';
import { fileURLToPath } from 'url';

import {
  MCP_TOOL_DEFINITIONS,
  MCP_RESOURCE_TEMPLATES,
  buildMcpToolCommand,
  createMcpInitializeResult,
  listMcpResources,
  resolveMcpResource,
  snapshotMcpData,
} from './lib/mcp-adapter.mjs';
import { createRuntimeClient, isRuntimeClient } from './lib/runtime-client.mjs';

function encodeMessage(payload) {
  const body = JSON.stringify(payload);
  return `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`;
}

function send(payload) {
  process.stdout.write(encodeMessage(payload));
}

const defaultRuntimeClient = createRuntimeClient();

export function createMcpRequestHandler({
  runtimeClient = defaultRuntimeClient,
  sendMessage = send,
} = {}) {
  if (!isRuntimeClient(runtimeClient)) throw new Error('mcp.runtimeClient: must be a branded RuntimeClient');
  return async function handleRequest(message) {
    if (!message || typeof message !== 'object') return;
    try {
      message = snapshotMcpData(message, 'mcp.request');
    } catch (error) {
      sendMessage({ jsonrpc: '2.0', id: null, error: { code: -32600, message: error.message } });
      return;
    }
    if (typeof message.method !== 'string' || !message.method) {
      sendMessage({ jsonrpc: '2.0', id: message.id ?? null, error: { code: -32600, message: 'mcp.request.method: must be a non-empty string' } });
      return;
    }
    if (message.method.startsWith('notifications/')) return;
    const id = message.id;
    try {
      if (message.method === 'initialize') {
        sendMessage({ jsonrpc: '2.0', id, result: createMcpInitializeResult() });
        return;
      }
      if (message.method === 'tools/list') {
        sendMessage({ jsonrpc: '2.0', id, result: { tools: MCP_TOOL_DEFINITIONS } });
        return;
      }
      if (message.method === 'tools/call') {
        const name = message.params?.name;
        const args = message.params?.arguments || {};
        const command = buildMcpToolCommand(name, args);
        const result = await runtimeClient.execute(command);
        const text = result.code === 0
          ? result.stdout
          : [result.stderr, result.stdout].filter(Boolean).join('\n');
        sendMessage({
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
        sendMessage({ jsonrpc: '2.0', id, result: { resources: listMcpResources() } });
        return;
      }
      if (message.method === 'resources/templates/list') {
        sendMessage({
          jsonrpc: '2.0',
          id,
          result: { resourceTemplates: MCP_RESOURCE_TEMPLATES.filter(t => t.uriTemplate.includes('{')) },
        });
        return;
      }
      if (message.method === 'resources/read') {
        const uri = message.params?.uri;
        if (typeof uri !== 'string' || !uri.trim()) throw new Error('resources/read requires uri');
        const resource = resolveMcpResource(uri.trim());
        const result = await runtimeClient.execute(resource.command);
        const text = result.code === 0
          ? result.stdout
          : [result.stderr, result.stdout].filter(Boolean).join('\n');
        if (result.code !== 0) {
          sendMessage({
            jsonrpc: '2.0',
            id,
            error: { code: -32000, message: text || `Resource read failed for ${uri}` },
          });
          return;
        }
        sendMessage({
          jsonrpc: '2.0',
          id,
          result: {
            contents: [{ uri, mimeType: resource.mimeType, text }],
          },
        });
        return;
      }
      sendMessage({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${message.method}` },
      });
    } catch (e) {
      sendMessage({
        jsonrpc: '2.0',
        id,
        error: { code: -32000, message: e.message || String(e) },
      });
    }
  };
}

const handleRequest = createMcpRequestHandler();

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

const isDirectRun = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  process.stdin.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    for (const message of parseBufferedMessages()) {
      enqueueRequest(message);
    }
  });
}
