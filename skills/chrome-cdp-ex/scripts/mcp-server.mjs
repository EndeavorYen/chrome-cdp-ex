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

// MCP stdio is newline-delimited JSON-RPC: one message per line, no embedded newlines (#454).
// LSP-style `Content-Length` framing is still accepted for a client that sends it. The first
// frame fixes the framing for the whole connection, and every reply uses that framing.
const CONTENT_LENGTH = 'content-length';
const HEADER_END = Buffer.from('\r\n\r\n');
const MAX_HEADER_BYTES = 1024;

export function encodeMcpMessage(payload, framing = 'newline') {
  const body = JSON.stringify(payload);
  if (framing === 'header') return `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`;
  return `${body}\n`;
}

function parseError(detail) {
  return { jsonrpc: '2.0', id: null, error: { code: -32700, message: `Parse error: ${detail}` } };
}

function decodeJson(bytes) {
  try {
    return { message: JSON.parse(bytes.toString('utf8')) };
  } catch {
    return { error: parseError('message is not valid JSON') };
  }
}

function isFrameWhitespace(byte) {
  return byte === 0x0a || byte === 0x0d || byte === 0x20 || byte === 0x09;
}

// Splits stdin bytes into frames. `push` never throws: each entry is `{ message }` for a parsed
// JSON value, or `{ error }` holding the -32700 reply for a frame that could not be parsed.
export function createMcpStdioDecoder() {
  let buffer = Buffer.alloc(0);
  let framing = null;
  return {
    get framing() { return framing || 'newline'; },
    push(chunk) {
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : Buffer.from(chunk);
      const entries = [];
      while (buffer.length) {
        let start = 0;
        while (start < buffer.length && isFrameWhitespace(buffer[start])) start += 1;
        buffer = buffer.subarray(start);
        if (!buffer.length) break;

        // Wait while the buffer could still turn out to be a `Content-Length` header.
        const head = buffer.subarray(0, CONTENT_LENGTH.length).toString('latin1').toLowerCase();
        if (head.length < CONTENT_LENGTH.length && CONTENT_LENGTH.startsWith(head)) break;
        if (head !== CONTENT_LENGTH) {
          const newline = buffer.indexOf(0x0a);
          if (newline === -1) break;
          framing ??= 'newline';
          entries.push(decodeJson(buffer.subarray(0, newline)));
          buffer = buffer.subarray(newline + 1);
          continue;
        }

        framing ??= 'header';
        const headerEnd = buffer.indexOf(HEADER_END);
        if (headerEnd === -1) {
          if (buffer.length <= MAX_HEADER_BYTES) break;
          entries.push({ error: parseError('Content-Length header is not terminated') });
          const newline = buffer.indexOf(0x0a);
          buffer = newline === -1 ? Buffer.alloc(0) : buffer.subarray(newline + 1);
          continue;
        }
        const header = buffer.subarray(0, headerEnd).toString('latin1');
        const match = header.match(/^content-length[ \t]*:[ \t]*(\d+)[ \t]*$/im);
        if (!match) {
          entries.push({ error: parseError('Content-Length header is missing or invalid') });
          buffer = buffer.subarray(headerEnd + HEADER_END.length);
          continue;
        }
        const bodyStart = headerEnd + HEADER_END.length;
        const bodyEnd = bodyStart + Number(match[1]);
        if (buffer.length < bodyEnd) break;
        entries.push(decodeJson(buffer.subarray(bodyStart, bodyEnd)));
        buffer = buffer.subarray(bodyEnd);
      }
      return entries;
    },
  };
}

const stdioDecoder = createMcpStdioDecoder();

function send(payload) {
  process.stdout.write(encodeMcpMessage(payload, stdioDecoder.framing));
}

const defaultRuntimeClient = createRuntimeClient();

export function createMcpRequestHandler({
  runtimeClient = defaultRuntimeClient,
  sendMessage = send,
} = {}) {
  if (!isRuntimeClient(runtimeClient)) throw new Error('mcp.runtimeClient: must be a branded RuntimeClient');
  return async function handleRequest(message) {
    if (!message || typeof message !== 'object') {
      sendMessage({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'mcp.request: must be a JSON-RPC request object' } });
      return;
    }
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
    // A message without `id` is a notification: JSON-RPC forbids any reply, even for an
    // unknown method or a failure (e.g. `notifications/initialized`, `notifications/cancelled`).
    if (!Object.hasOwn(message, 'id')) return;
    const id = message.id;
    try {
      if (message.method === 'ping') {
        sendMessage({ jsonrpc: '2.0', id, result: {} });
        return;
      }
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

// Requests are answered one at a time, in arrival order. Tool calls drive one shared browser
// session, so running them concurrently could interleave actions on the same tab.
let requestQueue = Promise.resolve();

function enqueue(task, replyId) {
  requestQueue = requestQueue
    .then(task)
    .catch(error => {
      if (replyId === undefined) return;
      send({
        jsonrpc: '2.0',
        id: replyId,
        error: { code: -32000, message: error.message || String(error) },
      });
    });
}

// The id a failure reply should carry, or undefined for a notification (never answered).
function replyIdFor(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
  if (!Object.hasOwn(message, 'id')) return undefined;
  return message.id ?? null;
}

const isDirectRun = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  process.stdin.on('data', chunk => {
    for (const entry of stdioDecoder.push(chunk)) {
      if (entry.error) enqueue(() => send(entry.error), null);
      else enqueue(() => handleRequest(entry.message), replyIdFor(entry.message));
    }
  });
}
