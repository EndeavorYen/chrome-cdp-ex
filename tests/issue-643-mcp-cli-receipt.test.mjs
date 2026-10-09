// #643: an MCP tool result is the CLI text receipt, its Next is a callable run_command call, and
// tools/call runs only the tools tools/list serves.
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it, vi } from 'vitest';

import { createMcpRequestHandler } from '../skills/chrome-cdp-ex/scripts/mcp-server.mjs';
import {
  buildMcpToolCommand,
  createMcpToolResult,
  isServedMcpTool,
  mcpNextCall,
  MCP_TOOLS,
} from '../skills/chrome-cdp-ex/scripts/lib/mcp-adapter.mjs';
import {
  COMMAND_SURFACE,
  MCP_JSON_FORMAT_TOOLS,
  MCP_NEXT_COMMANDS,
  MCP_RUN_COMMAND_ALLOWLIST,
} from '../skills/chrome-cdp-ex/scripts/lib/command-surface.mjs';
import { createRuntimeClient } from '../skills/chrome-cdp-ex/scripts/lib/runtime-client.mjs';

const COVERED = [
  'Error: click point (97, 322) of <BUTTON> "Save profile" is covered by position:fixed <DIV#consent> "We use cookies. Accept all" even after scrolling it to the viewport centre. The mouse click was not sent: it would land on the covering element.',
  'Kind: covered',
  'Next: cdp click DE804A60 "#save" --js (Kind: covered)',
].join('\n');

function harness(executeCli) {
  const sent = [];
  const handle = createMcpRequestHandler({
    runtimeClient: createRuntimeClient({ executeCli }),
    sendMessage: message => sent.push(message),
  });
  return {
    sent,
    async call(name, args) {
      await handle({ jsonrpc: '2.0', id: sent.length + 1, method: 'tools/call', params: { name, arguments: args } });
      return sent.at(-1);
    },
  };
}

describe('#643 a tool result is the CLI text receipt', () => {
  it('returns a refused click as the CLI text plus kind and the Next as a run_command call', async () => {
    const executeCli = vi.fn(async () => ({ code: 1, stdout: '', stderr: COVERED }));
    const reply = await harness(executeCli).call('click', { target: 'DE804A60', selector: '#save', confirm: true });
    expect(executeCli).toHaveBeenCalledWith(['click', 'DE804A60', '#save']);
    expect(reply.result).toEqual({
      content: [{ type: 'text', text: COVERED }],
      structuredContent: {
        schema: 'chrome-cdp-ex.mcp-result.v1',
        ok: false,
        exitCode: 1,
        kind: 'covered',
        next: { name: 'run_command', arguments: { command: 'click', args: ['DE804A60', '#save', '--js'], confirm: true } },
      },
      isError: true,
    });
    // The CLI prints 313 chars for this failure; the MCP result stays near that size.
    expect(JSON.stringify(reply.result).length).toBeLessThan(700);
  });

  it('keeps the versioned JSON receipt for format: "json"', async () => {
    const payload = { schema: 'chrome-cdp-ex.action.v1', ok: false, recovery: { kind: 'covered' } };
    const executeCli = vi.fn(async () => ({ code: 1, stdout: JSON.stringify(payload), stderr: '' }));
    const reply = await harness(executeCli)
      .call('click', { target: 'DE804A60', selector: '#save', confirm: true, format: 'json' });
    expect(executeCli).toHaveBeenCalledWith(['click', 'DE804A60', '#save', '--format', 'json']);
    expect(reply.result).toEqual({
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      structuredContent: payload,
      isError: true,
    });
  });

  it('offers format only on tools whose command prints JSON, and refuses other values', () => {
    for (const tool of MCP_TOOLS) {
      const format = tool.inputSchema.properties.format;
      if (MCP_JSON_FORMAT_TOOLS.includes(tool.name)) expect(format, tool.name).toMatchObject({ enum: ['text', 'json'] });
      else expect(format, tool.name).toBeUndefined();
    }
    expect(buildMcpToolCommand('doctor', {})).toEqual(['doctor']);
    expect(buildMcpToolCommand('doctor', { format: 'json' })).toEqual(['doctor', '--format', 'json']);
    expect(buildMcpToolCommand('list_tabs', { format: 'text' })).toEqual(['list']);
    expect(() => buildMcpToolCommand('doctor', { format: 'yaml' })).toThrow('format must be text or json');
  });

  it('turns a success receipt Next into a call and leaves a receipt without one at ok/exitCode', () => {
    const pressed = createMcpToolResult(['press', 'T1', 'Enter'], {
      code: 0, stdout: 'Pressed Enter. Next: cdp perceive T1 --since-action\n', stderr: '',
    });
    expect(pressed.structuredContent).toEqual({
      schema: 'chrome-cdp-ex.mcp-result.v1',
      ok: true,
      exitCode: 0,
      next: { name: 'run_command', arguments: { command: 'perceive', args: ['T1', '--since-action'] } },
    });
    const listed = createMcpToolResult(['list'], { code: 0, stdout: 'T1  Page  https://a.test/ *\n', stderr: '' });
    expect(listed.structuredContent).toEqual({ schema: 'chrome-cdp-ex.mcp-result.v1', ok: true, exitCode: 0 });
  });
});

describe('#643 mcpNextCall', () => {
  it('reads double-quoted, single-quoted and plain words', () => {
    expect(mcpNextCall('Next: cdp fill T1 "#q" \'it\'\\\'\'s\' --format json').arguments)
      .toEqual({ command: 'fill', args: ['T1', '#q', "it's", '--format', 'json'], confirm: true });
    expect(mcpNextCall('Next: cdp text T1 "a \\"b\\""').arguments).toEqual({ command: 'text', args: ['T1', 'a "b"'] });
    expect(mcpNextCall('Next: cdp netlog T1 --failed  # the failed request').arguments)
      .toEqual({ command: 'netlog', args: ['T1', '--failed'] });
  });

  it('returns null for placeholders, choices, unterminated quotes and refused commands', () => {
    for (const text of [
      'Next: cdp click T1 @ref  # choose a ref from the perception below',
      'Next: cdp cookies <target> [--unsafe-full]',
      'Next: cdp perceive T1 …',
      'Next: press Escape or perceive -s main',
      'Next: cdp click T1 "#save',
      'Next: cdp eval T1 "1+1"',
      'Next: cdp evalraw T1 DOM.getDocument',
      'Next: cdp text T1; rm -rf /',
      'no next step here',
    ]) expect(mcpNextCall(text), text).toBeNull();
  });

  it('gives confirm only when run_command needs it for that argv', () => {
    expect(mcpNextCall('Next: cdp console T1 --errors').arguments).toEqual({ command: 'console', args: ['T1', '--errors'] });
    expect(mcpNextCall('Next: cdp console T1 --clear').arguments)
      .toEqual({ command: 'console', args: ['T1', '--clear'], confirm: true });
  });
});

describe('#643 run_command accepts the commands Next lines name', () => {
  // Commands whose MCP exposure is none stay refused even when a Next line names them.
  const UNEXPOSED = new Set(['call', 'cookiedel', 'cookieset', 'eval', 'eval64', 'evalraw', 'flow']);

  function namedInSource() {
    const root = fileURLToPath(new URL('../skills/chrome-cdp-ex/scripts/', import.meta.url));
    const named = new Set();
    for (const dir of [root, join(root, 'lib')]) {
      for (const name of readdirSync(dir).filter(file => file.endsWith('.mjs'))) {
        const text = readFileSync(join(dir, name), 'utf8');
        for (const match of text.matchAll(/(?:Next: |`)cdp ([a-z][a-z0-9-]*)\b/g)) named.add(match[1]);
      }
    }
    return named;
  }

  it('accepts every command a Next line or recovery command names, except unexposed ones', () => {
    const named = namedInSource();
    expect(named.size).toBeGreaterThan(30);
    const refused = [...named].filter(command => !MCP_RUN_COMMAND_ALLOWLIST.includes(command));
    expect(refused.sort()).toEqual([...UNEXPOSED].sort());
    for (const command of UNEXPOSED) expect(COMMAND_SURFACE.resolve(command).mcp.exposure).toBe('none');
    for (const command of MCP_NEXT_COMMANDS) expect(named.has(command), command).toBe(true);
  });

  it('runs status and jsclick, and still refuses eval', async () => {
    const executeCli = vi.fn(async command => ({ code: 0, stdout: `ran ${command[0]}`, stderr: '' }));
    const mcp = harness(executeCli);
    expect((await mcp.call('run_command', { command: 'status', args: ['T1'] })).result.isError).toBe(false);
    expect((await mcp.call('run_command', { command: 'jsclick', args: ['T1', '#save'] })).error.message)
      .toMatch(/confirm: true/);
    expect((await mcp.call('run_command', { command: 'jsclick', args: ['T1', '#save'], confirm: true })).result.isError)
      .toBe(false);
    expect((await mcp.call('run_command', { command: 'eval', args: ['T1', '1+1'], confirm: true })).error.message)
      .toBe('run_command command not allowlisted: eval');
    expect(executeCli.mock.calls.map(([command]) => command[0])).toEqual(['status', 'jsclick']);
  });
});

describe('#643 tools/call runs only the tools tools/list serves', () => {
  it('refuses report and the other hidden catalog tools', async () => {
    const executeCli = vi.fn();
    const mcp = harness(executeCli);
    for (const name of ['report', 'controls', 'overlay', 'table', 'verify_click', 'select_target']) {
      expect(isServedMcpTool(name), name).toBe(false);
      expect((await mcp.call(name, { target: 'T1' })).error, name)
        .toEqual({ code: -32000, message: `Unknown MCP tool: ${name}` });
    }
    expect(executeCli).not.toHaveBeenCalled();
    for (const tool of MCP_TOOLS) expect(isServedMcpTool(tool.name), tool.name).toBe(true);
  });
});
