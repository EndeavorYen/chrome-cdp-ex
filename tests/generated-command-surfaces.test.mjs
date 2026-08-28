import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { createMcpRequestHandler } from '../skills/chrome-cdp-ex/scripts/mcp-server.mjs';
import { __test__ as cdpTest } from '../skills/chrome-cdp-ex/scripts/cdp.mjs';
import {
  COMMAND_SURFACE,
  MCP_RESOURCE_TEMPLATES,
  MCP_TOOL_DEFINITIONS,
  defineCommandSurface,
} from '../skills/chrome-cdp-ex/scripts/lib/command-surface.mjs';
import { listMcpResources, resolveMcpResource } from '../skills/chrome-cdp-ex/scripts/lib/mcp-adapter.mjs';
import { createRuntimeClient } from '../skills/chrome-cdp-ex/scripts/lib/runtime-client.mjs';

describe('generated CLI and MCP command surfaces', () => {
  it('renders all 81 help rows from catalog data while default help is the survivor card', () => {
    expect(typeof cdpTest.renderCliHelp).toBe('function');
    expect(typeof cdpTest.renderCardHelp).toBe('function');
    expect(cdpTest.renderCliHelp(COMMAND_SURFACE)).not.toBe(cdpTest.helpStr());
    expect(cdpTest.renderCardHelp(COMMAND_SURFACE)).toBe(cdpTest.helpStr());
    expect(cdpTest.CLI_HELP_TEMPLATE.match(/\{\{command:[a-z0-9-]+}}/g)).toHaveLength(81);
    expect(cdpTest.CLI_HELP_LAYOUT).toHaveLength(81);
    expect(cdpTest.helpStr()).not.toMatch(/\bjsclick\s+</);
    expect(cdpTest.helpStr()).not.toMatch(/\beval64\s+</);
  });

  it('changes rendered command synopsis and summary only when catalog data changes', () => {
    const commands = structuredClone(COMMAND_SURFACE.commands);
    const help = commands.find(command => command.name === 'help');
    help.help.synopsis = 'help revised';
    help.help.summary = 'Revised fixture summary.';
    const surface = defineCommandSurface(commands);
    const rendered = cdpTest.renderCliHelp(surface);

    expect(rendered).toContain('help revised');
    expect(rendered).toContain('Revised fixture summary.');
    expect(rendered).not.toContain('Show this command reference (same as --help)');
  });

  it('uses catalog help order and the exact 81-command authority', () => {
    const reordered = structuredClone(COMMAND_SURFACE.commands);
    const help = reordered.find(command => command.name === 'help');
    const list = reordered.find(command => command.name === 'list');
    [help.help.order, list.help.order] = [list.help.order, help.help.order];
    const reorderedSurface = defineCommandSurface(reordered);
    expect(() => cdpTest.renderCliHelp(reorderedSurface)).toThrow(/marker order/i);

    const expanded = structuredClone(COMMAND_SURFACE.commands);
    expanded.push({
      ...structuredClone(expanded[0]),
      name: 'extra-command',
      aliases: [],
      help: { synopsis: 'extra-command', summary: 'Extra.', section: 'discovery', order: 81 },
    });
    expect(() => cdpTest.renderCliHelp(defineCommandSurface(expanded))).toThrow(/exactly 81/i);
  });

  it('fails closed on missing, duplicate, unknown, or reordered help markers', () => {
    const marker = '{{command:help}}';
    expect(() => cdpTest.renderCliHelp(COMMAND_SURFACE, cdpTest.CLI_HELP_TEMPLATE.replace(marker, '')))
      .toThrow(/help marker/i);
    expect(() => cdpTest.renderCliHelp(COMMAND_SURFACE, cdpTest.CLI_HELP_TEMPLATE.replace(marker, `${marker}\n${marker}`)))
      .toThrow(/help marker/i);
    expect(() => cdpTest.renderCliHelp(COMMAND_SURFACE, cdpTest.CLI_HELP_TEMPLATE.replace(marker, '{{command:unknown}}')))
      .toThrow(/unknown.*marker/i);
    const next = '{{command:list}}';
    const reordered = cdpTest.CLI_HELP_TEMPLATE
      .replace(marker, '{{swap}}')
      .replace(next, marker)
      .replace('{{swap}}', next);
    expect(() => cdpTest.renderCliHelp(COMMAND_SURFACE, reordered)).toThrow(/order/i);
    expect(() => cdpTest.renderCliHelp({
      commands: COMMAND_SURFACE.commands,
      resolve: name => COMMAND_SURFACE.resolve(name),
    })).toThrow(/validated command surface/i);
  });

  it('serves catalog-owned MCP tools and resources with exact order and JSON-RPC values', async () => {
    const sent = [];
    const executeCli = vi.fn();
    const handle = createMcpRequestHandler({
      runtimeClient: createRuntimeClient({ executeCli }),
      sendMessage: message => sent.push(message),
    });
    await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    await handle({ jsonrpc: '2.0', id: 2, method: 'resources/list' });
    await handle({ jsonrpc: '2.0', id: 3, method: 'resources/templates/list' });

    expect(sent).toEqual([
      { jsonrpc: '2.0', id: 1, result: { tools: MCP_TOOL_DEFINITIONS } },
      { jsonrpc: '2.0', id: 2, result: { resources: listMcpResources() } },
      {
        jsonrpc: '2.0', id: 3,
        result: { resourceTemplates: MCP_RESOURCE_TEMPLATES.filter(record => record.uriTemplate.includes('{')) },
      },
    ]);
    expect(executeCli).not.toHaveBeenCalled();
  });

  it('resolves every concrete resource command and MIME type from the catalog record', () => {
    for (const fixture of [
      ['chrome-cdp-ex://doctor/status', 'application/json'],
      ['chrome-cdp-ex://session/app/report', 'application/json'],
      ['chrome-cdp-ex://session/app/screenshot/latest', 'text/plain'],
    ]) {
      const resolved = resolveMcpResource(fixture[0]);
      expect(resolved.mimeType).toBe(fixture[1]);
      expect(resolved.record).toMatchObject(MCP_RESOURCE_TEMPLATES.find(record => record.name === resolved.record.name));
    }
  });

  it('imports generated surfaces without stdin, filesystem, browser, or child-process effects', () => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'chrome-cdp-generated-import-'));
    try {
      const moduleUrl = new URL('../skills/chrome-cdp-ex/scripts/mcp-server.mjs', import.meta.url).href;
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import { existsSync } from 'node:fs';
        const before = process.stdin.listenerCount('data');
        await import(${JSON.stringify(moduleUrl)});
        console.log(JSON.stringify({
          before,
          after: process.stdin.listenerCount('data'),
          runtimeCreated: existsSync(process.env.XDG_RUNTIME_DIR + '/cdp'),
        }));
      `], {
        encoding: 'utf8',
        env: { ...process.env, XDG_RUNTIME_DIR: runtimeRoot, NODE_ENV: 'test' },
      });
      expect(child.status, child.stderr).toBe(0);
      expect(JSON.parse(child.stdout)).toEqual({ before: 0, after: 0, runtimeCreated: false });
    } finally {
      rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });
});
