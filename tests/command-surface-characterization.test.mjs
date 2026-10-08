import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

import { __test__ as cdpTest } from '../skills/chrome-cdp-ex/scripts/cdp.mjs';
import { canonicalizeContract } from '../scripts/check-public-contracts.mjs';
import {
  MCP_RESOURCE_TEMPLATES,
  MCP_RUN_COMMAND_ALLOWLIST,
  MCP_TOOL_DEFINITIONS,
  MCP_TOOLS,
  buildMcpResourceCommand,
  buildMcpToolCommand,
} from '../skills/chrome-cdp-ex/scripts/lib/mcp-adapter.mjs';
import {
  COMMAND_SURFACE,
  COMMAND_SURFACE_IDENTITY,
  MCP_RESOURCE_RECORDS,
  MCP_SURFACE,
  MCP_SURFACE_IDENTITY,
  MCP_TOOL_MAPPER_BY_NAME,
  SURVIVOR_COMMANDS,
} from '../skills/chrome-cdp-ex/scripts/lib/command-surface.mjs';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const packageVersion = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8')).version;
const contract = JSON.parse(readFileSync(
  join(rootDir, `docs/contracts/v${packageVersion}/public-contracts.v1.json`),
  'utf8',
));

function commandProjection(command) {
  const policy = COMMAND_SURFACE.resolve(command.name);
  return {
    aliases: [...command.aliases],
    authorization: policy.authorization,
    evidencePolicy: policy.evidencePolicy,
    feedbackPolicy: command.feedbackPolicy ?? null,
    kind: policy.kind,
    mutates: command.mutates,
    name: command.name,
    needsTarget: command.needsTarget,
    outputFormats: [...command.outputFormats],
  };
}

function digestFile(path) {
  const bytes = readFileSync(path);
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function digestJson(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

describe('Phase 6 command-surface characterization', () => {
  it('freezes all 82 command records, aliases, target flags, mutations, formats, and help bytes', () => {
    expect(createHash('sha256').update(JSON.stringify(COMMAND_SURFACE.commands)).digest('hex'))
      .toBe(COMMAND_SURFACE_IDENTITY);
    expect(cdpTest.COMMANDS.map(commandProjection)).toEqual(contract.commands);
    expect(cdpTest.COMMANDS).toHaveLength(82);
    expect(cdpTest.COMMANDS.flatMap(command => command.aliases)).toHaveLength(23);
    expect(cdpTest.COMMANDS.filter(command => command.needsTarget)).toHaveLength(69);
    expect(cdpTest.COMMANDS.filter(command => command.mutates)).toHaveLength(33);
    const targetSpellings = cdpTest.COMMANDS
      .filter(command => command.needsTarget)
      .flatMap(command => [command.name, ...command.aliases]);
    expect([...cdpTest.NEEDS_TARGET]).toEqual(targetSpellings);
    expect(cdpTest.NEEDS_TARGET).toHaveLength(87);
    for (const command of cdpTest.COMMANDS) {
      for (const spelling of [command.name, ...command.aliases]) {
        expect(cdpTest.commandMeta(spelling), spelling).toBe(command);
      }
    }
    const catalogHelp = cdpTest.renderCliHelp(COMMAND_SURFACE);
    expect(Buffer.byteLength(catalogHelp)).toBe(27655);
    expect(`sha256:${createHash('sha256').update(catalogHelp).digest('hex')}`)
      .toBe('sha256:873bcc7e0497721d9002d28f3f2b16ff78d52bfa11c4f65802809084a234e9ae');
    expect(catalogHelp).toMatch(/\.\n$/);
    const normalizedHelp = catalogHelp.replace(/[ \t]+/g, ' ');
    let lastHelpPosition = -1;
    for (const command of [...COMMAND_SURFACE.commands].sort((left, right) => left.help.order - right.help.order)) {
      const synopsisPosition = normalizedHelp.indexOf(command.help.synopsis);
      expect(synopsisPosition, `${command.name} synopsis`).toBeGreaterThan(lastHelpPosition);
      expect(normalizedHelp, `${command.name} summary`).toContain(command.help.summary);
      lastHelpPosition = synopsisPosition;
    }
    expect(cdpTest.helpStr()).toBe(cdpTest.renderCardHelp(COMMAND_SURFACE));
    for (const name of SURVIVOR_COMMANDS) {
      expect(cdpTest.helpStr(), name).toContain(COMMAND_SURFACE.resolve(name).help.synopsis);
    }
    expect(cdpTest.helpStr()).not.toMatch(/\bjsclick\s+</);
    expect(cdpTest.helpStr()).not.toMatch(/\beval64\s+</);
    expect(COMMAND_SURFACE.resolve('qa').domains).toContain('Emulation');
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'chrome-cdp-p6-help-'));
    try {
      const expectedStdout = Buffer.from(`${cdpTest.helpStr()}\n`);
      for (const args of [['help'], []]) {
        const result = spawnSync(process.execPath, [
          join(rootDir, 'skills/chrome-cdp-ex/scripts/cdp.mjs'),
          ...args,
        ], {
          env: { ...process.env, XDG_RUNTIME_DIR: runtimeRoot, LOCALAPPDATA: runtimeRoot },
        });
        expect(result.status, args.join(' ') || '<no args>').toBe(0);
        expect(result.stderr).toHaveLength(0);
        expect(result.stdout).toEqual(expectedStdout);
      }
    } finally {
      rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it('freezes every MCP tool, resource, allowlist entry, valid mapping, and invalid boundary', () => {
    expect(createHash('sha256').update(JSON.stringify(MCP_SURFACE)).digest('hex'))
      .toBe(MCP_SURFACE_IDENTITY);
    // #554: the served tools/list is the survivor card. run_command mappings in the
    // current fixture are the survivor allowlist; published fixtures stay historical.
    expect(MCP_TOOLS.map(({ annotations: _annotations, ...tool }) => tool)).toEqual(MCP_TOOL_DEFINITIONS);
    expect(MCP_TOOL_DEFINITIONS.map(tool => tool.name)).toEqual([
      'doctor', 'list_tabs', 'open_or_attach', 'perceive', 'screenshot', 'click',
      'dismiss_modal', 'fill', 'navigate', 'press', 'wait_for', 'cascade',
      'spawn_debug_browser', 'run_command',
    ]);
    const fixtureTools = Object.fromEntries(contract.mcp.tools.map(tool => [tool.name, tool]));
    for (const tool of MCP_TOOLS) {
      if (tool.name === 'run_command') {
        expect(tool.inputSchema.properties.command.description)
          .toBe(`Allowlisted CLI command name. One of: ${MCP_RUN_COMMAND_ALLOWLIST.join(', ')}`);
        continue;
      }
      expect(canonicalizeContract(tool), tool.name).toEqual(canonicalizeContract(fixtureTools[tool.name]));
    }
    expect(MCP_RESOURCE_TEMPLATES).toEqual(contract.mcp.resourceTemplates);
    expect(digestJson(MCP_TOOL_DEFINITIONS))
      .toBe('sha256:ce342c1006beebae61b6ce3c5d9928da9817611a3460ad0d314b96f84c348636');
    expect(digestJson(MCP_RESOURCE_TEMPLATES))
      .toBe('sha256:3b37cd2d5f067d70ecda6570c7d9ca3316610e116962ee547cce0386eda8e37d');
    expect(digestJson(MCP_RUN_COMMAND_ALLOWLIST))
      .toBe('sha256:bbd2a42dbe7d2c99b5c88abc862ed73b2f3e651e7cdb803ef327a1f7eff9042a');
    expect(MCP_TOOL_DEFINITIONS).toHaveLength(14);
    expect(MCP_RESOURCE_TEMPLATES).toHaveLength(3);
    expect(MCP_RUN_COMMAND_ALLOWLIST).toHaveLength(27);
    expect(MCP_RESOURCE_RECORDS.map(resource => resource.mapper)).toEqual([
      'doctor-status', 'session-report', 'session-screenshot-latest',
    ]);
    expect(Object.keys(MCP_TOOL_MAPPER_BY_NAME)).toHaveLength(27);
    for (const fixture of contract.mcp.mappingCases) {
      if (fixture.tool === 'run_command' && !MCP_RUN_COMMAND_ALLOWLIST.includes(fixture.args?.command)) {
        expect(() => buildMcpToolCommand(fixture.tool, fixture.args), fixture.id).toThrow(/not allowlisted/);
        continue;
      }
      expect(buildMcpToolCommand(fixture.tool, fixture.args), fixture.id).toEqual(fixture.command);
    }
    const mapperIdentities = Object.fromEntries(MCP_TOOL_DEFINITIONS.map(tool => [
      tool.name,
      contract.mcp.mappingCases.filter(fixture => fixture.tool === tool.name).map(fixture => fixture.id),
    ]));
    expect(mapperIdentities).toEqual({
      cascade: ['cascade'],
      click: ['click'],
      dismiss_modal: ['dismiss-modal'],
      doctor: ['doctor'],
      fill: ['fill'],
      list_tabs: ['list-tabs'],
      navigate: ['navigate'],
      open_or_attach: ['open-attach-alias', 'open-new-tab'],
      perceive: ['perceive', 'perceive-cards'],
      press: ['press'],
      run_command: [
        'run-command-read',
        'run-command-mutation',
      ],
      screenshot: ['screenshot'],
      spawn_debug_browser: ['spawn-debug-browser'],
      wait_for: ['wait-for-text', 'wait-for-any', 'wait-for-stable'],
    });
    expect(Object.freeze({
      cascade: 'tool:cascade',
      click: 'tool:click',
      dismiss_modal: 'tool:dismiss-modal',
      doctor: 'tool:doctor',
      fill: 'tool:fill',
      list_tabs: 'tool:list-tabs',
      navigate: 'tool:navigate',
      open_or_attach: 'tool:open-or-attach',
      perceive: 'tool:perceive',
      press: 'tool:press',
      run_command: 'tool:run-command',
      screenshot: 'tool:screenshot',
      spawn_debug_browser: 'tool:spawn-debug-browser',
      wait_for: 'tool:wait-for',
    })).toEqual(Object.fromEntries(MCP_TOOL_DEFINITIONS.map(tool => [
      tool.name,
      `tool:${tool.name.replaceAll('_', '-')}`,
    ])));
    expect(Object.fromEntries(MCP_RESOURCE_TEMPLATES.map(resource => [
      resource.name,
      `resource:${resource.name}`,
    ]))).toEqual({
      'doctor-status': 'resource:doctor-status',
      'session-report': 'resource:session-report',
      'session-screenshot-latest': 'resource:session-screenshot-latest',
    });
    for (const fixture of contract.mcp.resourceMappings) {
      expect(buildMcpResourceCommand(fixture.uri), fixture.id).toEqual(fixture.command);
    }
    for (const fixture of contract.mcp.invalidCases) {
      const invoke = fixture.kind === 'resource'
        ? () => buildMcpResourceCommand(fixture.uri)
        : () => buildMcpToolCommand(fixture.tool, fixture.args);
      const spelling = fixture.args?.command;
      if (fixture.tool === 'run_command' && spelling && !MCP_RUN_COMMAND_ALLOWLIST.includes(spelling)) {
        expect(invoke, fixture.id).toThrow(/not allowlisted/);
        continue;
      }
      expect(invoke, fixture.id).toThrow(fixture.error);
    }
  });

  it('keeps the characterized documentation files and explicit generated-region boundary', () => {
    const files = ['docs/reference.md', 'skills/chrome-cdp-ex/references/commands.md'];
    for (const path of files) {
      const text = readFileSync(join(rootDir, path), 'utf8');
      expect(text.match(/chrome-cdp-ex:generated-command-surface:start/g)).toHaveLength(1);
      expect(text.match(/chrome-cdp-ex:generated-command-surface:end/g)).toHaveLength(1);
      expect(digestFile(join(rootDir, path))).toMatch(/^sha256:[a-f0-9]{64}$/);
    }
  });
});
