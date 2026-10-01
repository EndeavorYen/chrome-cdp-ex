import { describe, expect, it } from 'vitest';
import { spawn } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';

process.env.NODE_ENV = 'test';

const {
  createMcpRequestHandler,
  createMcpStdioDecoder,
  encodeMcpMessage,
} = await import('../skills/chrome-cdp-ex/scripts/mcp-server.mjs');
const { createRuntimeClient } = await import('../skills/chrome-cdp-ex/scripts/lib/runtime-client.mjs');
const { verifyMcpInitialize } = await import('../scripts/setup.mjs');
const { encodeMcpFrame, parseMcpFrames } = await import('../scripts/benchmark-mcp-path.mjs');

const serverPath = fileURLToPath(new URL('../skills/chrome-cdp-ex/scripts/mcp-server.mjs', import.meta.url));

function spawnServer() {
  const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = Buffer.alloc(0);
  let stderr = '';
  const waiters = [];
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  child.stdout.on('data', chunk => {
    stdout = Buffer.concat([stdout, chunk]);
    for (const waiter of [...waiters]) waiter();
  });
  child.on('exit', () => { for (const waiter of [...waiters]) waiter(); });
  return {
    child,
    raw: () => stdout.toString('utf8'),
    stderr: () => stderr,
    // Resolves once stdout satisfies `predicate`, or rejects on timeout / early exit.
    waitFor(predicate, timeoutMs = 5000) {
      return new Promise((resolve, reject) => {
        const check = () => {
          const text = stdout.toString('utf8');
          if (predicate(text)) {
            cleanup();
            resolve(text);
          } else if (child.exitCode !== null) {
            cleanup();
            reject(new Error(`MCP server exited ${child.exitCode}; stdout=${text}; stderr=${stderr}`));
          }
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error(`MCP server timeout; stdout=${stdout.toString('utf8')}; stderr=${stderr}`));
        }, timeoutMs);
        const cleanup = () => {
          clearTimeout(timer);
          const index = waiters.indexOf(check);
          if (index !== -1) waiters.splice(index, 1);
        };
        waiters.push(check);
        check();
      });
    },
  };
}

const completeLines = text => text.split('\n').slice(0, -1);

function handlerHarness() {
  const sent = [];
  const runtimeClient = createRuntimeClient({
    executeCli: async () => ({ code: 0, stdout: 'ok', stderr: '' }),
  });
  return {
    sent,
    handle: createMcpRequestHandler({ runtimeClient, sendMessage: message => sent.push(message) }),
  };
}

describe('#454 MCP stdio framing', () => {
  it('answers newline-framed requests with single-line JSON, survives a garbage line, and ignores notifications', async () => {
    const server = spawnServer();
    try {
      const initialize = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
      // Split a request across writes so the reader must buffer a partial line.
      server.child.stdin.write(initialize.slice(0, 20));
      server.child.stdin.write(`${initialize.slice(20)}\n`);
      server.child.stdin.write('garbage\n');
      server.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' })}\n`);
      server.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      server.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } })}\n`);
      server.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'custom/unknown-notification' })}\n`);
      server.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' })}\r\n`);

      const text = await server.waitFor(out => completeLines(out).some(line => line.includes('"id":3')));
      expect(text).not.toMatch(/Content-Length/i);
      expect(text.endsWith('\n')).toBe(true);
      const replies = completeLines(text).map(line => JSON.parse(line));
      expect(replies).toHaveLength(4);
      expect(replies[0]).toMatchObject({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'chrome-cdp-ex' } } });
      expect(replies[1]).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32700 } });
      expect(replies[2]).toEqual({ jsonrpc: '2.0', id: 2, result: {} });
      expect(replies[3]).toEqual({ jsonrpc: '2.0', id: 3, result: {} });

      // The server is still alive after the garbage line and still answers.
      expect(server.child.exitCode).toBeNull();
      server.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list' })}\n`);
      const after = await server.waitFor(out => completeLines(out).length >= 5);
      const toolsList = JSON.parse(completeLines(after)[4]);
      expect(toolsList.id).toBe(4);
      expect(toolsList.result.tools.length).toBeGreaterThan(0);
      expect(server.child.exitCode).toBeNull();
    } finally {
      server.child.kill();
    }
  });

  it('keeps header framing for a client that sent Content-Length headers', async () => {
    const server = spawnServer();
    try {
      server.child.stdin.write(encodeMcpMessage({ jsonrpc: '2.0', id: 1, method: 'ping' }, 'header'));
      server.child.stdin.write('Content-Length: 7\r\n\r\ngarbage');
      server.child.stdin.write(encodeMcpMessage({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} }, 'header'));
      const text = await server.waitFor(out => out.includes('"id":2'));
      const decoder = createMcpStdioDecoder();
      const decoded = decoder.push(Buffer.from(text, 'utf8'));
      expect(decoder.framing).toBe('header');
      expect(decoded.map(entry => entry.message ?? entry.error)).toEqual([
        { jsonrpc: '2.0', id: 1, result: {} },
        { jsonrpc: '2.0', id: null, error: expect.objectContaining({ code: -32700 }) },
        expect.objectContaining({ id: 2, result: expect.objectContaining({ serverInfo: expect.any(Object) }) }),
      ]);
      expect(server.child.exitCode).toBeNull();
    } finally {
      server.child.kill();
    }
  });

  it('decodes split UTF-8, CRLF, blank lines, and bad headers without throwing', () => {
    const decoder = createMcpStdioDecoder();
    const line = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { text: '戰鬥勝利' } })}\r\n`, 'utf8');
    const cut = line.indexOf(Buffer.from('戰', 'utf8')) + 1;
    expect(decoder.push(line.subarray(0, cut))).toEqual([]);
    expect(decoder.push(Buffer.concat([line.subarray(cut), Buffer.from('\n\n')]))).toEqual([
      { message: { jsonrpc: '2.0', id: 1, method: 'ping', params: { text: '戰鬥勝利' } } },
    ]);
    expect(decoder.framing).toBe('newline');
    const [bad] = decoder.push(Buffer.from('{"jsonrpc":\n'));
    expect(bad.error).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32700 } });

    const headerDecoder = createMcpStdioDecoder();
    const [badHeader] = headerDecoder.push(Buffer.from('Content-Length: nope\r\n\r\n'));
    expect(badHeader.error).toMatchObject({ id: null, error: { code: -32700 } });
    expect(headerDecoder.push(Buffer.from(encodeMcpMessage({ jsonrpc: '2.0', id: 9, method: 'ping' }, 'header'))))
      .toEqual([{ message: { jsonrpc: '2.0', id: 9, method: 'ping' } }]);
    expect(headerDecoder.framing).toBe('header');
  });

  it('encodes newline framing by default with no embedded newlines', () => {
    const encoded = encodeMcpMessage({ jsonrpc: '2.0', id: 1, result: { text: 'a\nb' } });
    expect(encoded).toBe('{"jsonrpc":"2.0","id":1,"result":{"text":"a\\nb"}}\n');
    expect(encoded.indexOf('\n')).toBe(encoded.length - 1);
  });

  it('answers ping with an empty result and never answers a notification', async () => {
    const state = handlerHarness();
    await state.handle({ jsonrpc: '2.0', id: 7, method: 'ping' });
    await state.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 7 } });
    await state.handle({ jsonrpc: '2.0', method: 'unknown/method' });
    await state.handle({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'nope' } });
    expect(state.sent).toEqual([{ jsonrpc: '2.0', id: 7, result: {} }]);
  });

  it('returns invalid-request for a JSON value that is not a request object', async () => {
    const state = handlerHarness();
    await state.handle(42);
    await state.handle(null);
    expect(state.sent).toEqual([
      { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'mcp.request: must be a JSON-RPC request object' } },
      { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'mcp.request: must be a JSON-RPC request object' } },
    ]);
  });

  it('setup --verify speaks newline framing and rejects a header-framed reply', async () => {
    const ok = await verifyMcpInitialize({ mcpServer: serverPath, timeoutMs: 10000 });
    expect(ok).toMatchObject({ ok: true, serverName: 'chrome-cdp-ex' });

    const dir = mkdtempSync(join(tmpdir(), 'cdp-454-'));
    try {
      const legacy = join(dir, 'legacy-server.mjs');
      writeFileSync(legacy, `
        process.stdin.once('data', () => {
          const body = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'chrome-cdp-ex' } } });
          process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body);
        });
      `);
      await expect(verifyMcpInitialize({ mcpServer: legacy, timeoutMs: 3000 })).rejects.toThrow(/newline/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('benchmark-mcp-path frames requests and parses replies as newline-delimited JSON', () => {
    expect(encodeMcpFrame({ jsonrpc: '2.0', id: 1, method: 'ping' })).toBe('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
    const parsed = parseMcpFrames(Buffer.from('{"jsonrpc":"2.0","id":1,"result":{}}\n{"jsonrpc":"2.0","id":2', 'utf8'));
    expect(parsed.messages).toEqual([{ jsonrpc: '2.0', id: 1, result: {} }]);
    expect(parsed.rest.toString('utf8')).toBe('{"jsonrpc":"2.0","id":2');
  });
});
