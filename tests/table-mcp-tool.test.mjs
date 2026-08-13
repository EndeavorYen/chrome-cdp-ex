import { describe, expect, it, vi } from 'vitest';

import { createMcpRequestHandler } from '../skills/chrome-cdp-ex/scripts/mcp-server.mjs';
import { createRuntimeClient } from '../skills/chrome-cdp-ex/scripts/lib/runtime-client.mjs';
import {
  COMMAND_SURFACE,
  MCP_RESOURCE_TEMPLATES,
  MCP_TOOL_DEFINITIONS,
  MCP_TOOL_MAPPER_BY_NAME,
} from '../skills/chrome-cdp-ex/scripts/lib/command-surface.mjs';
import { buildMcpToolCommand } from '../skills/chrome-cdp-ex/scripts/lib/mcp-adapter.mjs';
import { parseTableRunCommandArgs } from '../skills/chrome-cdp-ex/scripts/lib/table-contract.mjs';

const TOKEN = 'ct1.0123456789abcdef0123456789abcdef.0';
const HONEST_SUMMARY = 'Bounded table observation with completeness, explicit virtual collection, and private continuation; fixed ceilings and MCP collect confirmation';

function handlerWith(executeCli) {
  const sent = [];
  return {
    sent,
    executeCli,
    handle: createMcpRequestHandler({
      runtimeClient: createRuntimeClient({ executeCli }),
      sendMessage: message => sent.push(message),
    }),
  };
}

function semantics(command) {
  const parsed = parseTableRunCommandArgs(command.slice(1));
  const { argv: _argv, ...request } = parsed.request;
  return { target: parsed.target, request };
}

describe('first-class MCP table tool', () => {
  it('owns one table tool on the 26-tool, three-resource surface', () => {
    expect(COMMAND_SURFACE.commands).toHaveLength(81);
    expect(MCP_TOOL_DEFINITIONS).toHaveLength(26);
    expect(MCP_RESOURCE_TEMPLATES).toHaveLength(3);
    expect(Object.keys(MCP_TOOL_MAPPER_BY_NAME)).toHaveLength(26);
    expect(COMMAND_SURFACE.resolve('table')).toMatchObject({
      mcp: { exposure: 'tool-and-run-command', toolName: 'table', mapper: 'table' },
      aliases: [],
      help: { summary: HONEST_SUMMARY },
    });
    expect(MCP_TOOL_DEFINITIONS.filter(tool => tool.name === 'table')).toHaveLength(1);
    expect(MCP_TOOL_DEFINITIONS.filter(tool => tool.name === 'run_command')).toHaveLength(1);
    expect(MCP_TOOL_MAPPER_BY_NAME.table).toBe('table');
  });

  it('maps observe, collect, and continue aliases onto exact JSON argv', () => {
    expect(buildMcpToolCommand('table', { target: 'fixture', selector: '#grid' }))
      .toEqual(['table', 'fixture', '#grid', '--format', 'json']);
    expect(buildMcpToolCommand('table', {
      target: 'fixture',
      selector: '#grid',
      collect: true,
      scrollContainer: '.viewport',
      confirm: true,
    })).toEqual([
      'table', 'fixture', '#grid', '--collect', '--scroll-container', '.viewport', '--format', 'json',
    ]);
    expect(buildMcpToolCommand('table', {
      target: 'fixture',
      selector: '#grid',
      collect: true,
      scrollContainer: '.viewport',
      loadMore: '#more',
      rowKeyColumn: 0,
      confirm: true,
    })).toEqual([
      'table', 'fixture', '#grid', '--collect', '--scroll-container', '.viewport',
      '--load-more', '#more', '--row-key-column', '0', '--format', 'json',
    ]);
    expect(buildMcpToolCommand('table', { target: 'fixture', continue: TOKEN }))
      .toEqual(['table', 'fixture', '--continue', TOKEN, '--format', 'json']);
  });

  it('keeps selector and continue mutually exclusive before RuntimeClient', () => {
    expect(() => buildMcpToolCommand('table', {
      target: 'fixture',
      selector: '#grid',
      continue: TOKEN,
    })).toThrow(/continue/i);
  });

  it('requires own-data confirm:true only for collect', () => {
    expect(() => buildMcpToolCommand('table', {
      target: 'fixture',
      selector: '#grid',
      collect: true,
      scrollContainer: '.viewport',
    })).toThrow(/confirm: true/);
    expect(buildMcpToolCommand('table', { target: 'fixture', selector: '#grid' })[0]).toBe('table');
    expect(buildMcpToolCommand('table', { target: 'fixture', continue: TOKEN })[0]).toBe('table');
    expect(buildMcpToolCommand('table', {
      target: 'fixture',
      selector: '#grid',
      collect: true,
      scrollContainer: '.viewport',
      confirm: true,
    })).toContain('--collect');
  });

  it('converges first-class and run_command onto the same parsed request', () => {
    const observeTool = buildMcpToolCommand('table', { target: 'fixture', selector: '#grid' });
    const observeRun = buildMcpToolCommand('run_command', {
      command: 'table',
      args: ['fixture', '#grid', '--format', 'json'],
    });
    expect(semantics(observeTool)).toEqual(semantics(observeRun));

    const collectTool = buildMcpToolCommand('table', {
      target: 'fixture',
      selector: '#grid',
      collect: true,
      scrollContainer: '.viewport',
      loadMore: '#more',
      rowKeyColumn: 2,
      confirm: true,
    });
    const collectRun = buildMcpToolCommand('run_command', {
      command: 'table',
      args: [
        'fixture', '#grid', '--collect', '--scroll-container', '.viewport',
        '--load-more', '#more', '--row-key-column', '2', '--format', 'json',
      ],
      confirm: true,
    });
    expect(semantics(collectTool)).toEqual(semantics(collectRun));

    const continueTool = buildMcpToolCommand('table', { target: 'fixture', continue: TOKEN });
    const continueRun = buildMcpToolCommand('run_command', {
      command: 'table',
      args: ['fixture', '--continue', TOKEN, '--format', 'json'],
    });
    expect(semantics(continueTool)).toEqual(semantics(continueRun));
  });
});

describe('first-class MCP table confirmation isolation', () => {
  it('denies collect without confirmation before RuntimeClient execution', async () => {
    const executeCli = vi.fn();
    const state = handlerWith(executeCli);
    await state.handle({
      jsonrpc: '2.0', id: 70, method: 'tools/call',
      params: {
        name: 'table',
        arguments: { target: 'fixture', selector: '#grid', collect: true, scrollContainer: '.viewport' },
      },
    });
    expect(state.sent[0].error).toMatchObject({ code: -32000 });
    expect(state.sent[0].error.message).toMatch(/confirm: true/i);
    expect(executeCli).not.toHaveBeenCalled();
  });

  it('rejects inherited confirmation before RuntimeClient execution', async () => {
    const executeCli = vi.fn();
    const state = handlerWith(executeCli);
    await state.handle({
      jsonrpc: '2.0', id: 71, method: 'tools/call',
      params: {
        name: 'table',
        arguments: Object.assign(Object.create({ confirm: true }), {
          target: 'fixture', collect: true, scrollContainer: '.viewport',
        }),
      },
    });
    expect(state.sent[0].error).toMatchObject({ code: -32600 });
    expect(executeCli).not.toHaveBeenCalled();
  });

  it('rejects non-enumerable confirmation before RuntimeClient execution', async () => {
    const executeCli = vi.fn();
    const state = handlerWith(executeCli);
    const args = { target: 'fixture', collect: true, scrollContainer: '.viewport' };
    Object.defineProperty(args, 'confirm', { enumerable: false, value: true });
    await state.handle({
      jsonrpc: '2.0', id: 72, method: 'tools/call',
      params: { name: 'table', arguments: args },
    });
    expect(state.sent[0].error).toMatchObject({ code: -32600 });
    expect(executeCli).not.toHaveBeenCalled();
  });

  it('rejects accessor confirmation without invoking it or RuntimeClient', async () => {
    const executeCli = vi.fn();
    const state = handlerWith(executeCli);
    const read = vi.fn(() => true);
    const args = { target: 'fixture', collect: true, scrollContainer: '.viewport' };
    Object.defineProperty(args, 'confirm', { enumerable: true, get: read });
    await state.handle({
      jsonrpc: '2.0', id: 73, method: 'tools/call',
      params: { name: 'table', arguments: args },
    });
    expect(state.sent[0].error).toMatchObject({ code: -32600 });
    expect(read).not.toHaveBeenCalled();
    expect(executeCli).not.toHaveBeenCalled();
  });

  it('rejects symbol keys, custom prototypes, and proxied arguments before RuntimeClient', async () => {
    const executeCli = vi.fn();
    const state = handlerWith(executeCli);

    const withSymbol = { target: 'fixture', selector: '#grid' };
    withSymbol[Symbol('secret')] = true;
    await state.handle({
      jsonrpc: '2.0', id: 74, method: 'tools/call',
      params: { name: 'table', arguments: withSymbol },
    });
    expect(state.sent.at(-1).error).toMatchObject({ code: -32600 });

    await state.handle({
      jsonrpc: '2.0', id: 75, method: 'tools/call',
      params: {
        name: 'table',
        arguments: new Proxy({ target: 'fixture', selector: '#grid' }, {}),
      },
    });
    expect(state.sent.at(-1).error).toMatchObject({ code: -32600 });
    expect(executeCli).not.toHaveBeenCalled();
  });
});
