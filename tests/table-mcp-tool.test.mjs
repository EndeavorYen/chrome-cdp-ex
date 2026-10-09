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

describe('first-class MCP table tool', () => {
  it('keeps the table mapper while the served surface is the survivor card', () => {
    expect(COMMAND_SURFACE.commands).toHaveLength(82);
    expect(MCP_TOOL_DEFINITIONS).toHaveLength(14);
    expect(MCP_RESOURCE_TEMPLATES).toHaveLength(3);
    expect(Object.keys(MCP_TOOL_MAPPER_BY_NAME)).toHaveLength(27);
    expect(COMMAND_SURFACE.resolve('table')).toMatchObject({
      mcp: { exposure: 'tool-and-run-command', toolName: 'table', mapper: 'table' },
      aliases: [],
      help: { summary: HONEST_SUMMARY },
    });
    expect(MCP_TOOL_DEFINITIONS.filter(tool => tool.name === 'table')).toHaveLength(0);
    expect(MCP_TOOL_DEFINITIONS.filter(tool => tool.name === 'run_command')).toHaveLength(1);
    expect(MCP_TOOL_MAPPER_BY_NAME.table).toBe('table');
  });

  it('maps observe, collect, and continue aliases onto exact JSON argv', () => {
    expect(buildMcpToolCommand('table', { target: 'fixture', selector: '#grid' }))
      .toEqual(['table', 'fixture', '#grid']);
    expect(buildMcpToolCommand('table', {
      target: 'fixture',
      selector: '#grid',
      collect: true,
      scrollContainer: '.viewport',
      confirm: true,
    })).toEqual([
      'table', 'fixture', '#grid', '--collect', '--scroll-container', '.viewport',
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
      '--load-more', '#more', '--row-key-column', '0',
    ]);
    expect(buildMcpToolCommand('table', { target: 'fixture', continue: TOKEN }))
      .toEqual(['table', 'fixture', '--continue', TOKEN]);
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

  it('keeps the table tool and refuses table through the survivor run_command allowlist', () => {
    expect(buildMcpToolCommand('table', { target: 'fixture', selector: '#grid' })[0]).toBe('table');
    expect(() => buildMcpToolCommand('run_command', {
      command: 'table',
      args: ['fixture', '#grid', '--format', 'json'],
    })).toThrow(/not allowlisted/);
    expect(() => buildMcpToolCommand('run_command', {
      command: 'table',
      args: [
        'fixture', '#grid', '--collect', '--scroll-container', '.viewport',
        '--load-more', '#more', '--row-key-column', '2', '--format', 'json',
      ],
      confirm: true,
    })).toThrow(/not allowlisted/);
    expect(() => buildMcpToolCommand('run_command', {
      command: 'table',
      args: ['fixture', '--continue', TOKEN, '--format', 'json'],
    })).toThrow(/not allowlisted/);
  });
});

describe('first-class MCP table confirmation isolation', () => {
  it('refuses the unlisted table tool before RuntimeClient execution, and its mapper still needs confirm', async () => {
    const executeCli = vi.fn();
    const state = handlerWith(executeCli);
    await state.handle({
      jsonrpc: '2.0', id: 70, method: 'tools/call',
      params: {
        name: 'table',
        arguments: { target: 'fixture', selector: '#grid', collect: true, scrollContainer: '.viewport' },
      },
    });
    // #643: tools/list does not serve table, so tools/call does not run it.
    expect(state.sent[0].error).toEqual({ code: -32000, message: 'Unknown MCP tool: table' });
    expect(executeCli).not.toHaveBeenCalled();
    expect(() => buildMcpToolCommand('table', {
      target: 'fixture', selector: '#grid', collect: true, scrollContainer: '.viewport',
    })).toThrow(/confirm: true/i);
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
