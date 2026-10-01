import { describe, expect, it } from 'vitest';
import { spawn } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

process.env.NODE_ENV = 'test';

const { createMcpRequestHandler } = await import('../skills/chrome-cdp-ex/scripts/mcp-server.mjs');
const { createRuntimeClient } = await import('../skills/chrome-cdp-ex/scripts/lib/runtime-client.mjs');
const {
  MCP_IMAGE_MAX_BASE64_BYTES,
  MCP_PROTOCOL_VERSION,
  MCP_SUPPORTED_PROTOCOL_VERSIONS,
  MCP_TOOLS,
} = await import('../skills/chrome-cdp-ex/scripts/lib/mcp-adapter.mjs');
const {
  COMMAND_SURFACE,
  MCP_RUN_COMMAND_ALLOWLIST,
  MCP_TOOL_DEFINITIONS,
} = await import('../skills/chrome-cdp-ex/scripts/lib/command-surface.mjs');

// A real 1x1 transparent PNG.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const PNG_SIGNATURE = TINY_PNG.subarray(0, 8);

function withRuntimeDir(fn) {
  return async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), 'chrome-cdp-465-'));
    try {
      await fn(runtimeDir);
    } finally {
      rmSync(runtimeDir, { recursive: true, force: true });
    }
  };
}

function harness(executeCli, options = {}) {
  const sent = [];
  const handle = createMcpRequestHandler({
    runtimeClient: createRuntimeClient({ executeCli }),
    sendMessage: message => sent.push(message),
    ...options,
  });
  return {
    sent,
    async call(name, args) {
      await handle({ jsonrpc: '2.0', id: sent.length + 1, method: 'tools/call', params: { name, arguments: args } });
      return sent.at(-1);
    },
    async request(method, params) {
      await handle({ jsonrpc: '2.0', id: sent.length + 1, method, ...(params === undefined ? {} : { params }) });
      return sent.at(-1);
    },
  };
}

const shotOutput = path => async () => ({ code: 0, stdout: `${path}\nScreenshot saved. DPR=1`, stderr: '' });

describe('#465 initialize negotiates protocolVersion', () => {
  it('echoes a supported client version and otherwise answers with the latest supported one', async () => {
    expect(MCP_SUPPORTED_PROTOCOL_VERSIONS).toEqual(['2025-06-18', '2025-03-26', '2024-11-05']);
    expect(MCP_PROTOCOL_VERSION).toBe('2025-06-18');
    const server = harness(async () => ({ code: 0, stdout: '', stderr: '' }));
    for (const version of MCP_SUPPORTED_PROTOCOL_VERSIONS) {
      const reply = await server.request('initialize', { protocolVersion: version, capabilities: {} });
      expect(reply.result.protocolVersion).toBe(version);
    }
    for (const params of [{ protocolVersion: '2099-01-01' }, { protocolVersion: 7 }, {}, undefined]) {
      const reply = await server.request('initialize', params);
      expect(reply.result.protocolVersion).toBe('2025-06-18');
      expect(reply.result.serverInfo.name).toBe('chrome-cdp-ex');
    }
  });
});

describe('#465 tool annotations come from the command authorization catalog', () => {
  const EXPECTED_BY_AUTHORIZATION = {
    standard: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    'sensitive-read': { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    conditional: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    mutation: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  };

  it('lists every tool with annotations that match its owning command authorization', async () => {
    const reply = await harness(async () => ({ code: 0, stdout: '', stderr: '' })).request('tools/list', {});
    const tools = reply.result.tools;
    expect(tools.map(tool => tool.name)).toEqual(MCP_TOOL_DEFINITIONS.map(tool => tool.name));
    expect(tools).toEqual(MCP_TOOLS);
    for (const tool of tools) {
      expect(typeof tool.annotations.title).toBe('string');
      expect(tool.annotations.title.length).toBeGreaterThan(0);
      if (tool.name === 'run_command') continue;
      const command = COMMAND_SURFACE.commands.find(candidate => candidate.mcp.toolName === tool.name);
      const { title: _title, ...hints } = tool.annotations;
      expect(hints, tool.name).toEqual(EXPECTED_BY_AUTHORIZATION[command.authorization]);
    }
    const byName = Object.fromEntries(tools.map(tool => [tool.name, tool.annotations]));
    expect(byName.perceive.readOnlyHint).toBe(true);
    expect(byName.click.destructiveHint).toBe(true);
    expect(byName.screenshot.readOnlyHint).toBe(false);
    expect(byName.list_tabs.title).toBe('List tabs');
  });

  it('gives run_command the widest hints of its allowlist', async () => {
    const reply = await harness(async () => ({ code: 0, stdout: '', stderr: '' })).request('tools/list', {});
    const runCommand = reply.result.tools.find(tool => tool.name === 'run_command');
    const authorizations = new Set(MCP_RUN_COMMAND_ALLOWLIST.map(name => COMMAND_SURFACE.resolve(name).authorization));
    expect(authorizations.has('mutation')).toBe(true);
    expect(runCommand.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
  });
});

describe('#465 structuredContent for JSON command output', () => {
  it('returns the parsed object next to the unchanged text', async () => {
    const payload = { schema: 'chrome-cdp-ex.doctor.v1', ok: true, checks: [{ id: 'node', ok: true }] };
    const stdout = JSON.stringify(payload, null, 2);
    const reply = await harness(async () => ({ code: 0, stdout, stderr: '' })).call('doctor', {});
    expect(reply.result).toEqual({
      content: [{ type: 'text', text: stdout }],
      structuredContent: payload,
      isError: false,
    });
  });

  it('keeps structuredContent on a failed command that still printed its JSON result', async () => {
    const payload = { schema: 'chrome-cdp-ex.action-result.v1', ok: false };
    const stdout = JSON.stringify(payload);
    const reply = await harness(async () => ({ code: 1, stdout, stderr: '' }))
      .call('click', { target: 'ABC', selector: '#go', confirm: true });
    expect(reply.result).toEqual({
      content: [{ type: 'text', text: stdout }],
      structuredContent: payload,
      isError: true,
    });
  });

  it('omits structuredContent for text, arrays, schema-less objects, and malformed JSON', async () => {
    for (const stdout of ['plain text', '[1,2]', '{"ok":true}', '{"schema":', '"chrome-cdp-ex"', '{"schema":7}']) {
      const reply = await harness(async () => ({ code: 0, stdout, stderr: '' })).call('doctor', {});
      expect(reply.result, stdout).toEqual({ content: [{ type: 'text', text: stdout }], isError: false });
    }
  });
});

describe('#465 screenshot tools return an image content block', () => {
  it('attaches the PNG the screenshot command wrote into the runtime directory', withRuntimeDir(async runtimeDir => {
    const path = join(runtimeDir, 'screenshot-ABCDEF12.png');
    writeFileSync(path, TINY_PNG);
    const reply = await harness(shotOutput(path), { runtimeDir }).call('screenshot', { target: 'ABCDEF12' });
    expect(reply.result).toEqual({
      content: [
        { type: 'text', text: `${path}\nScreenshot saved. DPR=1` },
        { type: 'image', data: TINY_PNG.toString('base64'), mimeType: 'image/png' },
      ],
      isError: false,
    });
  }));

  it('attaches a daemon shot written into the tab session screenshot directory', withRuntimeDir(async runtimeDir => {
    // A tab daemon writes `shot` to <runtime>/cdp-<targetId>-screenshots/shot-NNN.png.
    const sessionDir = join(runtimeDir, 'cdp-ABCDEF1234567890ABCDEF1234567890-screenshots');
    mkdirSync(sessionDir);
    const path = join(sessionDir, 'shot-001.png');
    writeFileSync(path, TINY_PNG);
    const reply = await harness(shotOutput(path), { runtimeDir }).call('screenshot', { target: 'ABCDEF12' });
    expect(reply.result.content[1]).toEqual({ type: 'image', data: TINY_PNG.toString('base64'), mimeType: 'image/png' });

    // Any other subdirectory, or a deeper path, is not a CLI screenshot location.
    for (const dir of [join(runtimeDir, 'other'), join(sessionDir, 'deeper')]) {
      mkdirSync(dir);
      const other = join(dir, 'shot-001.png');
      writeFileSync(other, TINY_PNG);
      const rejected = await harness(shotOutput(other), { runtimeDir }).call('screenshot', { target: 'ABCDEF12' });
      expect(rejected.result.content[1].text, dir).toMatch(/outside the chrome-cdp-ex runtime directory/);
    }
  }));

  it('attaches images for run_command screenshot spellings (shot alias, elshot, fullshot)', withRuntimeDir(async runtimeDir => {
    const path = join(runtimeDir, 'elshot-ABCDEF12-ref3.png');
    writeFileSync(path, TINY_PNG);
    for (const command of ['screenshot', 'elshot', 'fullshot']) {
      const reply = await harness(shotOutput(path), { runtimeDir })
        .call('run_command', { command, args: ['ABCDEF12', '@3'], confirm: true });
      expect(reply.result.content[1], command).toEqual({
        type: 'image', data: TINY_PNG.toString('base64'), mimeType: 'image/png',
      });
    }
  }));

  it('returns only text with a note when the PNG is over the inline cap', withRuntimeDir(async runtimeDir => {
    const path = join(runtimeDir, 'fullshot-ABCDEF12.png');
    const rawBytes = Math.floor(MCP_IMAGE_MAX_BASE64_BYTES / 4) * 3 + 3;
    writeFileSync(path, Buffer.concat([PNG_SIGNATURE, Buffer.alloc(rawBytes - PNG_SIGNATURE.length)]));
    const reply = await harness(shotOutput(path), { runtimeDir }).call('screenshot', { target: 'ABCDEF12' });
    expect(reply.result.content).toHaveLength(2);
    expect(reply.result.content.every(block => block.type === 'text')).toBe(true);
    expect(reply.result.content[1].text).toMatch(/not attached/i);
    expect(reply.result.content[1].text).toContain('cap');
    expect(reply.result.content[1].text).toContain(path);
  }));

  it('attaches a PNG exactly at the cap', withRuntimeDir(async runtimeDir => {
    const path = join(runtimeDir, 'fullshot-ABCDEF12.png');
    const rawBytes = Math.floor(MCP_IMAGE_MAX_BASE64_BYTES / 4) * 3;
    writeFileSync(path, Buffer.concat([PNG_SIGNATURE, Buffer.alloc(rawBytes - PNG_SIGNATURE.length)]));
    const reply = await harness(shotOutput(path), { runtimeDir }).call('screenshot', { target: 'ABCDEF12' });
    expect(reply.result.content[1].type).toBe('image');
    expect(reply.result.content[1].data.length).toBeLessThanOrEqual(MCP_IMAGE_MAX_BASE64_BYTES);
  }));

  it('never reads a file outside the runtime directory, even one the screenshot path wrote', withRuntimeDir(async runtimeDir => {
    const outside = mkdtempSync(join(tmpdir(), 'chrome-cdp-465-outside-'));
    try {
      const path = join(outside, 'explicit.png');
      writeFileSync(path, TINY_PNG);
      const reply = await harness(shotOutput(path), { runtimeDir })
        .call('screenshot', { target: 'ABCDEF12', path, confirm: true });
      expect(reply.result.content.map(block => block.type)).toEqual(['text', 'text']);
      expect(reply.result.content[1].text).toMatch(/outside the chrome-cdp-ex runtime directory/);

      const nested = join(runtimeDir, 'nested');
      const traversal = join(nested, '..', '..', 'escape.png');
      const escaped = await harness(shotOutput(traversal), { runtimeDir }).call('screenshot', { target: 'ABCDEF12' });
      expect(escaped.result.content.map(block => block.type)).toEqual(['text', 'text']);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  }));

  it('does not attach stale files, non-PNG bytes, or images for failed or non-screenshot commands', withRuntimeDir(async runtimeDir => {
    const stale = join(runtimeDir, 'screenshot-STALE000.png');
    writeFileSync(stale, TINY_PNG);
    const old = new Date(Date.now() - 60_000);
    utimesSync(stale, old, old);
    const staleReply = await harness(shotOutput(stale), { runtimeDir }).call('screenshot', { target: 'STALE000' });
    expect(staleReply.result.content.map(block => block.type)).toEqual(['text', 'text']);

    const fake = join(runtimeDir, 'screenshot-FAKE0000.png');
    writeFileSync(fake, 'not a png');
    const fakeReply = await harness(shotOutput(fake), { runtimeDir }).call('screenshot', { target: 'FAKE0000' });
    expect(fakeReply.result.content.map(block => block.type)).toEqual(['text', 'text']);

    const fresh = join(runtimeDir, 'screenshot-FRESH000.png');
    writeFileSync(fresh, TINY_PNG);
    const failed = await harness(async () => ({ code: 1, stdout: fresh, stderr: 'capture failed' }), { runtimeDir })
      .call('screenshot', { target: 'FRESH000' });
    expect(failed.result).toEqual({ content: [{ type: 'text', text: `capture failed\n${fresh}` }], isError: true });

    const other = await harness(shotOutput(fresh), { runtimeDir }).call('doctor', {});
    expect(other.result.content.map(block => block.type)).toEqual(['text']);
  }));

  it('serves the image block over a real stdio server process', withRuntimeDir(async runtimeDir => {
    const path = join(runtimeDir, 'screenshot-ABCDEF12.png');
    writeFileSync(path, TINY_PNG);
    const serverUrl = new URL('../skills/chrome-cdp-ex/scripts/mcp-server.mjs', import.meta.url).href;
    const clientUrl = new URL('../skills/chrome-cdp-ex/scripts/lib/runtime-client.mjs', import.meta.url).href;
    const script = `
      import { startMcpStdioServer } from ${JSON.stringify(serverUrl)};
      import { createRuntimeClient } from ${JSON.stringify(clientUrl)};
      const path = ${JSON.stringify(path)};
      startMcpStdioServer({
        runtimeDir: ${JSON.stringify(runtimeDir)},
        runtimeClient: createRuntimeClient({
          executeCli: async () => ({ code: 0, stdout: path + '\\nScreenshot saved. DPR=1', stderr: '' }),
        }),
      });
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    try {
      const replies = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout; stdout=${stdout}; stderr=${stderr}`)), 10_000);
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.stdout.on('data', chunk => {
          stdout += chunk;
          const lines = stdout.split('\n').slice(0, -1);
          if (lines.length >= 2) {
            clearTimeout(timer);
            resolve(lines.map(line => JSON.parse(line)));
          }
        });
        child.on('exit', code => reject(new Error(`exited ${code}; stdout=${stdout}; stderr=${stderr}`)));
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })}\n`);
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'screenshot', arguments: { target: 'ABCDEF12' } } })}\n`);
      });
      expect(replies[0].result.protocolVersion).toBe('2025-03-26');
      expect(replies[1].id).toBe(2);
      expect(replies[1].result.content).toEqual([
        { type: 'text', text: `${path}\nScreenshot saved. DPR=1` },
        { type: 'image', data: TINY_PNG.toString('base64'), mimeType: 'image/png' },
      ]);
    } finally {
      child.kill();
    }
  }));
});
