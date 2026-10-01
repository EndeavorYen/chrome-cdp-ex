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
    expect(Buffer.byteLength(catalogHelp)).toBe(26648);
    expect(`sha256:${createHash('sha256').update(catalogHelp).digest('hex')}`)
      .toBe('sha256:582ad02419e70ffb514db54f199ba91a1e3cc9ff258742a8bb0d9712891fbdfd');
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
    expect(cdpTest.helpStr().trim()).toBe(contract.cliCases.find(entry => entry.id === 'help').stdout);
    expect(contract.cliCases.find(entry => entry.id === 'no-args-help').stdout)
      .toBe(cdpTest.helpStr().trim());
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
    // The fixture freezes the served tools/list entries: catalog definitions plus derived annotations (#465).
    expect(canonicalizeContract(MCP_TOOLS)).toEqual(contract.mcp.tools);
    expect(MCP_TOOLS.map(({ annotations: _annotations, ...tool }) => tool)).toEqual(MCP_TOOL_DEFINITIONS);
    expect(MCP_TOOL_DEFINITIONS.map(tool => tool.name))
      .toEqual(contract.mcp.tools.map(tool => tool.name));
    expect(MCP_RESOURCE_TEMPLATES).toEqual(contract.mcp.resourceTemplates);
    expect([...MCP_RUN_COMMAND_ALLOWLIST].sort()).toEqual(contract.mcp.runCommandAllowlist);
    expect(digestJson(MCP_TOOL_DEFINITIONS))
      .toBe('sha256:18da89e4ae7c6cbcb6a6caf963da4dfc7a36a66911ebb113b9db96b678150118');
    expect(digestJson(MCP_RESOURCE_TEMPLATES))
      .toBe('sha256:3b37cd2d5f067d70ecda6570c7d9ca3316610e116962ee547cce0386eda8e37d');
    expect(digestJson(MCP_RUN_COMMAND_ALLOWLIST))
      .toBe('sha256:724a7edc2acaaae366f209c41b8e5c7fd3795970ebe864e823a8d45d1be3d828');
    expect(MCP_TOOL_DEFINITIONS).toHaveLength(27);
    expect(MCP_RESOURCE_TEMPLATES).toHaveLength(3);
    expect(MCP_RUN_COMMAND_ALLOWLIST).toHaveLength(84);
    expect(MCP_RESOURCE_RECORDS.map(resource => resource.mapper)).toEqual([
      'doctor-status', 'session-report', 'session-screenshot-latest',
    ]);
    expect(Object.keys(MCP_TOOL_MAPPER_BY_NAME)).toHaveLength(27);
    for (const fixture of contract.mcp.mappingCases) {
      expect(buildMcpToolCommand(fixture.tool, fixture.args), fixture.id).toEqual(fixture.command);
    }
    const mapperIdentities = Object.fromEntries(MCP_TOOL_DEFINITIONS.map(tool => [
      tool.name,
      contract.mcp.mappingCases.filter(fixture => fixture.tool === tool.name).map(fixture => fixture.id),
    ]));
    expect(mapperIdentities).toEqual({
      cascade: ['cascade'],
      click: ['click'],
      components: ['components'],
      controls: ['controls'],
      dismiss_modal: ['dismiss-modal'],
      doctor: ['doctor'],
      drag: ['drag'],
      fill: ['fill'],
      list_tabs: ['list-tabs'],
      navigate: ['navigate'],
      open_or_attach: ['open-attach-alias', 'open-new-tab'],
      overlay: ['overlay'],
      perceive: ['perceive', 'perceive-cards'],
      press: ['press'],
      qa_page: ['qa-page'],
      record_snapshot: ['record-snapshot'],
      report: ['report'],
      responsive_audit: ['responsive-audit'],
      run_command: [
        'run-command-read',
        'run-command-mutation',
        'run-command-table-observe',
        'run-command-table-collect',
        'run-command-table-continue',
      ],
      screenshot: ['screenshot'],
      select_target: ['select-target'],
      session_checkpoint: ['session-checkpoint', 'session-checkpoint-unsafe'],
      spawn_debug_browser: ['spawn-debug-browser'],
      table: ['table-observe', 'table-collect', 'table-continue'],
      verify_click: ['verify-click'],
      viewport: ['viewport-read', 'viewport-set'],
      wait_for: ['wait-for-text', 'wait-for-any', 'wait-for-stable'],
    });
    expect(Object.freeze({
      cascade: 'tool:cascade',
      click: 'tool:click',
      components: 'tool:components',
      controls: 'tool:controls',
      dismiss_modal: 'tool:dismiss-modal',
      doctor: 'tool:doctor',
      drag: 'tool:drag',
      fill: 'tool:fill',
      list_tabs: 'tool:list-tabs',
      navigate: 'tool:navigate',
      open_or_attach: 'tool:open-or-attach',
      overlay: 'tool:overlay',
      perceive: 'tool:perceive',
      press: 'tool:press',
      qa_page: 'tool:qa-page',
      record_snapshot: 'tool:record-snapshot',
      report: 'tool:report',
      responsive_audit: 'tool:responsive-audit',
      run_command: 'tool:run-command',
      screenshot: 'tool:screenshot',
      select_target: 'tool:select-target',
      session_checkpoint: 'tool:session-checkpoint',
      spawn_debug_browser: 'tool:spawn-debug-browser',
      table: 'tool:table',
      verify_click: 'tool:verify-click',
      viewport: 'tool:viewport',
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
