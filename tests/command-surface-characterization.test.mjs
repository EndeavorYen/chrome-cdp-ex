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
  it('freezes all 81 command records, aliases, target flags, mutations, formats, and help bytes', () => {
    expect(createHash('sha256').update(JSON.stringify(COMMAND_SURFACE.commands)).digest('hex'))
      .toBe(COMMAND_SURFACE_IDENTITY);
    expect(cdpTest.COMMANDS.map(commandProjection)).toEqual(contract.commands);
    expect(cdpTest.COMMANDS).toHaveLength(81);
    expect(cdpTest.COMMANDS.flatMap(command => command.aliases)).toHaveLength(23);
    expect(cdpTest.COMMANDS.filter(command => command.needsTarget)).toHaveLength(68);
    expect(cdpTest.COMMANDS.filter(command => command.mutates)).toHaveLength(32);
    const targetSpellings = cdpTest.COMMANDS
      .filter(command => command.needsTarget)
      .flatMap(command => [command.name, ...command.aliases]);
    expect([...cdpTest.NEEDS_TARGET]).toEqual(targetSpellings);
    expect(cdpTest.NEEDS_TARGET).toHaveLength(86);
    for (const command of cdpTest.COMMANDS) {
      for (const spelling of [command.name, ...command.aliases]) {
        expect(cdpTest.commandMeta(spelling), spelling).toBe(command);
      }
    }
    expect(Buffer.byteLength(cdpTest.helpStr())).toBe(24505);
    expect(`sha256:${createHash('sha256').update(cdpTest.helpStr()).digest('hex')}`)
      .toBe('sha256:60c5b75fc359476fab5133d92efcd9aabde98b5d4177d942b0ba72a7e9468ad0');
    expect(cdpTest.helpStr()).toMatch(/\.\n$/);
    expect(cdpTest.helpStr().trim()).toBe(contract.cliCases.find(entry => entry.id === 'help').stdout);
    expect(contract.cliCases.find(entry => entry.id === 'no-args-help').stdout)
      .toBe(cdpTest.helpStr().trim());
    const normalizedHelp = cdpTest.helpStr().replace(/[ \t]+/g, ' ');
    let lastHelpPosition = -1;
    for (const command of [...COMMAND_SURFACE.commands].sort((left, right) => left.help.order - right.help.order)) {
      const synopsisPosition = normalizedHelp.indexOf(command.help.synopsis);
      expect(synopsisPosition, `${command.name} synopsis`).toBeGreaterThan(lastHelpPosition);
      expect(normalizedHelp, `${command.name} summary`).toContain(command.help.summary);
      lastHelpPosition = synopsisPosition;
    }
    expect(COMMAND_SURFACE.resolve('qa').domains).toContain('Emulation');
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'chrome-cdp-p6-help-'));
    try {
      for (const args of [['help'], []]) {
        const result = spawnSync(process.execPath, [
          join(rootDir, 'skills/chrome-cdp-ex/scripts/cdp.mjs'),
          ...args,
        ], {
          env: { ...process.env, XDG_RUNTIME_DIR: runtimeRoot, LOCALAPPDATA: runtimeRoot },
        });
        expect(result.status, args.join(' ') || '<no args>').toBe(0);
        expect(result.stderr).toHaveLength(0);
        expect(result.stdout).toHaveLength(24506);
        expect(result.stdout.subarray(-2)).toEqual(Buffer.from('\n\n'));
        expect(`sha256:${createHash('sha256').update(result.stdout).digest('hex')}`)
          .toBe('sha256:e5b9e8f89577f2b7fe8e4b89f6c9f1a70c2b8cf555c2dc046de9686125b41ca1');
      }
    } finally {
      rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it('freezes every MCP tool, resource, allowlist entry, valid mapping, and invalid boundary', () => {
    expect(createHash('sha256').update(JSON.stringify(MCP_SURFACE)).digest('hex'))
      .toBe(MCP_SURFACE_IDENTITY);
    expect(canonicalizeContract(MCP_TOOL_DEFINITIONS)).toEqual(contract.mcp.tools);
    expect(MCP_TOOL_DEFINITIONS.map(tool => tool.name))
      .toEqual(contract.mcp.tools.map(tool => tool.name));
    expect(MCP_RESOURCE_TEMPLATES).toEqual(contract.mcp.resourceTemplates);
    expect([...MCP_RUN_COMMAND_ALLOWLIST].sort()).toEqual(contract.mcp.runCommandAllowlist);
    expect(digestJson(MCP_TOOL_DEFINITIONS))
      .toBe('sha256:afd65413858df961c530ec797373d66766013bf90de6614c605a9a404c7f44b3');
    expect(digestJson(MCP_RESOURCE_TEMPLATES))
      .toBe('sha256:3b37cd2d5f067d70ecda6570c7d9ca3316610e116962ee547cce0386eda8e37d');
    expect(digestJson(MCP_RUN_COMMAND_ALLOWLIST))
      .toBe('sha256:82bc5511c77a48a44f84c91df1c350bc0a350cf3800d992dca7ce7a0e641a3f2');
    expect(MCP_TOOL_DEFINITIONS).toHaveLength(26);
    expect(MCP_RESOURCE_TEMPLATES).toHaveLength(3);
    expect(MCP_RUN_COMMAND_ALLOWLIST).toHaveLength(83);
    expect(MCP_RESOURCE_RECORDS.map(resource => resource.mapper)).toEqual([
      'doctor-status', 'session-report', 'session-screenshot-latest',
    ]);
    expect(Object.keys(MCP_TOOL_MAPPER_BY_NAME)).toHaveLength(26);
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
    const files = ['README.md', 'docs/reference.md', 'skills/chrome-cdp-ex/references/commands.md'];
    for (const path of files) {
      const text = readFileSync(join(rootDir, path), 'utf8');
      expect(text.match(/chrome-cdp-ex:generated-command-surface:start/g)).toHaveLength(1);
      expect(text.match(/chrome-cdp-ex:generated-command-surface:end/g)).toHaveLength(1);
      expect(digestFile(join(rootDir, path))).toMatch(/^sha256:[a-f0-9]{64}$/);
    }
  });
});
