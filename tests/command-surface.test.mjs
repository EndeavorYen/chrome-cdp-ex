import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  COMMAND_SURFACE,
  MCP_RESOURCE_TEMPLATES,
  MCP_RUN_COMMAND_ALLOWLIST,
  MCP_TOOL_DEFINITIONS,
  defineCommandSurface,
  defineMcpSurface,
  projectCliCommands,
} from '../skills/chrome-cdp-ex/scripts/lib/command-surface.mjs';
import { createCommandRegistry } from '../skills/chrome-cdp-ex/scripts/lib/command-application.mjs';

function record(overrides = {}) {
  return {
    name: 'inspect',
    aliases: ['look'],
    needsTarget: true,
    mutates: false,
    feedbackPolicy: null,
    outputFormats: ['text', 'json'],
    kind: 'read',
    authorization: 'standard',
    evidencePolicy: 'none',
    domains: ['Runtime'],
    help: {
      synopsis: 'inspect <target>',
      summary: 'Inspect the current target.',
      section: 'observation',
      order: 1,
    },
    mcp: { exposure: 'run-command', toolName: null, mapper: null },
    ...overrides,
  };
}

describe('command surface catalog', () => {
  it('creates an immutable ordered catalog with canonical and alias resolution', () => {
    const input = [record()];
    const surface = defineCommandSurface(input);

    expect(surface.commands).toHaveLength(1);
    expect(surface.resolve('inspect')).toBe(surface.commands[0]);
    expect(surface.resolve('look')).toBe(surface.commands[0]);
    expect(surface.resolve('missing')).toBeNull();
    expect(Object.isFrozen(surface)).toBe(true);
    expect(Object.isFrozen(surface.commands[0].help)).toBe(true);
    expect(Object.isFrozen(surface.commands[0].domains)).toBe(true);

    input[0].aliases[0] = 'changed';
    input[0].help.summary = 'changed';
    expect(surface.resolve('look')?.help.summary).toBe('Inspect the current target.');
    expect(surface.resolve('changed')).toBeNull();
  });

  it('rejects missing/extra keys, accessors, symbols, prototypes, and sparse arrays', () => {
    const missing = record();
    delete missing.help;
    expect(() => defineCommandSurface([missing])).toThrow(/help.*required/);
    expect(() => defineCommandSurface([{ ...record(), extra: true }])).toThrow(/extra.*not allowed/);

    const accessor = record();
    Object.defineProperty(accessor, 'name', { enumerable: true, get: () => 'inspect' });
    expect(() => defineCommandSurface([accessor])).toThrow(/name.*data property/);

    const symbol = record();
    symbol[Symbol('secret')] = true;
    expect(() => defineCommandSurface([symbol])).toThrow(/symbol/);

    expect(() => defineCommandSurface([Object.assign(Object.create({ planted: true }), record())]))
      .toThrow(/plain data object/);

    const sparse = new Array(3);
    sparse[0] = record();
    sparse[2] = record({ name: 'other', aliases: [], help: { ...record().help, synopsis: 'other', order: 2 } });
    expect(() => defineCommandSurface(sparse)).toThrow(/commands\[1\].*own data property/);
  });

  it('rejects bounds, enum drift, duplicate ordering, and name/alias collisions', () => {
    const oversized = [];
    oversized.length = 10000;
    expect(() => defineCommandSurface(oversized)).toThrow(/array limit|1\.\.256/);
    const customRoot = Object.setPrototypeOf([record()], Object.create(Array.prototype));
    expect(() => defineCommandSurface(customRoot)).toThrow(/plain array/);
    const customAliases = record();
    Object.setPrototypeOf(customAliases.aliases, Object.create(Array.prototype));
    expect(() => defineCommandSurface([customAliases])).toThrow(/plain array/);
    expect(() => defineCommandSurface([record({
      aliases: Array.from({ length: 65 }, (_, index) => `alias-${index}`),
    })])).toThrow(/64-item array limit/);
    expect(() => defineCommandSurface([record({ name: 'Bad Name' })])).toThrow(/name/);
    expect(() => defineCommandSurface([record({ outputFormats: [] })])).toThrow(/outputFormats/);
    expect(() => defineCommandSurface([record({ domains: ['Unknown'] })])).toThrow(/domains/);
    expect(() => defineCommandSurface([record({ help: { ...record().help, summary: 'x'.repeat(401) } })]))
      .toThrow(/summary/);
    expect(() => defineCommandSurface([record({ help: { ...record().help, summary: 'line one\nline two' } })]))
      .toThrow(/summary.*single line/);
    expect(() => defineCommandSurface([record({ help: { ...record().help, synopsis: 'inspect {{command:help}}' } })]))
      .toThrow(/synopsis.*marker/);
    for (const injected of ['tab\ttext', 'escape\u001b[2Jtext', 'unicode\u2028line', 'unicode\u2029paragraph']) {
      expect(() => defineCommandSurface([record({ help: { ...record().help, summary: injected } })]))
        .toThrow(/summary.*safe single line/);
    }
    expect(() => defineCommandSurface([record({ mcp: { exposure: 'everything', toolName: null, mapper: null } })]))
      .toThrow(/exposure/);

    const other = record({ name: 'other', aliases: ['inspect'], help: { ...record().help, synopsis: 'other', order: 2 } });
    expect(() => defineCommandSurface([record(), other])).toThrow(/collision.*inspect/);

    const sameOrder = record({ name: 'other', aliases: [], help: { ...record().help, synopsis: 'other' } });
    expect(() => defineCommandSurface([record(), sameOrder])).toThrow(/help order.*1/);
  });

  it('rejects inconsistent policy, help, and MCP records without defaults', () => {
    expect(() => defineCommandSurface([record({ mutates: true })])).toThrow(/mutates.*read/);
    expect(() => defineCommandSurface([record({ authorization: 'mutation' })])).toThrow(/authorization.*read/);
    expect(() => defineCommandSurface([record({ feedbackPolicy: 'settle-diff' })])).toThrow(/feedbackPolicy.*read/);
    expect(() => defineCommandSurface([record({ help: { ...record().help, synopsis: 'other <target>' } })]))
      .toThrow(/synopsis.*canonical/);
    expect(() => defineCommandSurface([record({ mcp: { exposure: 'tool', toolName: null, mapper: null } })]))
      .toThrow(/toolName.*required/);
    expect(() => defineCommandSurface([record({
      mcp: { exposure: 'tool', toolName: 'inspect', mapper: 'definitely-not-an-adapter' },
    })])).toThrow(/registered MCP tool mapper/);
    expect(() => defineCommandSurface([record({ mcp: { exposure: 'none', toolName: 'inspect', mapper: 'inspect' } })]))
      .toThrow(/toolName.*must be null/);
  });

  it('owns all 81 public projections and policy specs without inferred gaps', () => {
    expect(COMMAND_SURFACE.commands).toHaveLength(81);
    expect(projectCliCommands()).toHaveLength(81);
    expect(COMMAND_SURFACE.commands.map(command => command.help.order).sort((left, right) => left - right)).toEqual(
      Array.from({ length: 81 }, (_, index) => index),
    );
    expect(COMMAND_SURFACE.commands.every(command => Object.isFrozen(command.mcp))).toBe(true);
    const registry = createCommandRegistry(COMMAND_SURFACE.commands.map(command => ({
      name: command.name,
      aliases: command.aliases,
      needsTarget: command.needsTarget,
      mutates: command.mutates,
      feedbackPolicy: command.feedbackPolicy,
      outputFormats: command.outputFormats,
      kind: command.kind,
      authorization: command.authorization,
      evidencePolicy: command.evidencePolicy,
    })));
    expect(registry.list()).toHaveLength(81);
    expect(registry.resolve('navigate')?.name).toBe('nav');
    expect(COMMAND_SURFACE.resolve('use')).toMatchObject({ kind: 'protected-mutation', authorization: 'mutation' });
    expect(COMMAND_SURFACE.resolve('tab-group')).toMatchObject({ kind: 'conditional-mutation', authorization: 'conditional' });
    expect(COMMAND_SURFACE.resolve('shot')).toMatchObject({ kind: 'conditional-mutation', authorization: 'conditional' });
    expect(COMMAND_SURFACE.resolve('fullshot')).toMatchObject({ kind: 'conditional-mutation', authorization: 'conditional' });
    expect(COMMAND_SURFACE.resolve('diff-shot')).toMatchObject({ kind: 'conditional-mutation', authorization: 'conditional' });
    expect(COMMAND_SURFACE.resolve('console')).toMatchObject({ kind: 'conditional-mutation', authorization: 'conditional' });
    expect(COMMAND_SURFACE.resolve('netlog')).toMatchObject({ kind: 'conditional-mutation', authorization: 'conditional' });
    expect(COMMAND_SURFACE.resolve('keepalive')).toMatchObject({ kind: 'protected-mutation', authorization: 'mutation' });
    expect(COMMAND_SURFACE.resolve('batch')).toMatchObject({ kind: 'composite', authorization: 'composite' });
    expect(COMMAND_SURFACE.resolve('eval')).toMatchObject({ kind: 'script', authorization: 'raw-script' });
    expect(COMMAND_SURFACE.resolve('cookies')).toMatchObject({ kind: 'sensitive-read', authorization: 'sensitive-read' });
  });
});

describe('MCP surface catalog', () => {
  const mcpInput = () => ({
    tools: [{
      name: 'inspect',
      description: 'Inspect a target.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    }],
    resources: [{
      uriTemplate: 'chrome-cdp-ex://fixture/{target}',
      name: 'fixture',
      description: 'Fixture resource.',
      mimeType: 'application/json',
      mapper: 'doctor-status',
    }],
    runCommandAllowlist: ['inspect'],
  });

  it('deeply snapshots and freezes exact MCP tools, resources, schemas, and allowlist order', () => {
    const input = mcpInput();
    const surface = defineMcpSurface(input);
    expect(surface.tools[0].inputSchema).toEqual(input.tools[0].inputSchema);
    expect(Object.isFrozen(surface.tools[0].inputSchema.properties)).toBe(true);
    input.tools[0].inputSchema.properties.planted = { type: 'string' };
    input.resources[0].description = 'changed';
    input.runCommandAllowlist[0] = 'changed';
    expect(surface.tools[0].inputSchema.properties).toEqual({});
    expect(surface.resources[0].description).toBe('Fixture resource.');
    expect(surface.runCommandAllowlist).toEqual(['inspect']);
    expect(Object.isFrozen(surface.resources[0])).toBe(true);
    expect(Object.isFrozen(surface.runCommandAllowlist)).toBe(true);
  });

  it('rejects MCP accessors, symbols, sparse arrays, custom prototypes, extras, and duplicates', () => {
    const accessor = mcpInput();
    Object.defineProperty(accessor.tools[0], 'name', { enumerable: true, get: () => 'inspect' });
    expect(() => defineMcpSurface(accessor)).toThrow(/data property/);
    const symbol = mcpInput();
    symbol.tools[0][Symbol('schema')] = {};
    expect(() => defineMcpSurface(symbol)).toThrow(/symbol/);
    const sparse = mcpInput();
    sparse.resources = new Array(1);
    expect(() => defineMcpSurface(sparse)).toThrow(/resources\[0\].*own data property/);
    const inherited = mcpInput();
    inherited.tools[0].inputSchema = Object.assign(Object.create({ secret: true }), inherited.tools[0].inputSchema);
    expect(() => defineMcpSurface(inherited)).toThrow(/plain data object/);
    const schemaAccessor = mcpInput();
    Object.defineProperty(schemaAccessor.tools[0].inputSchema, 'properties', {
      enumerable: true,
      get: () => ({}),
    });
    expect(() => defineMcpSurface(schemaAccessor)).toThrow(/data property/);
    expect(() => defineMcpSurface({ ...mcpInput(), extra: true })).toThrow(/extra.*not allowed/);
    const duplicate = mcpInput();
    duplicate.tools.push(structuredClone(duplicate.tools[0]));
    expect(() => defineMcpSurface(duplicate)).toThrow(/duplicate tool inspect/);
    const duplicateResource = mcpInput();
    duplicateResource.resources.push(structuredClone(duplicateResource.resources[0]));
    expect(() => defineMcpSurface(duplicateResource)).toThrow(/duplicate resource fixture/);
    const duplicateAllowlist = mcpInput();
    duplicateAllowlist.runCommandAllowlist.push('inspect');
    expect(() => defineMcpSurface(duplicateAllowlist)).toThrow(/duplicate inspect/);
    const nonJson = mcpInput();
    nonJson.tools[0].inputSchema.properties.value = { transform: () => 'secret' };
    expect(() => defineMcpSurface(nonJson)).toThrow(/JSON data/);
    const customTools = mcpInput();
    Object.setPrototypeOf(customTools.tools, Object.create(Array.prototype));
    expect(() => defineMcpSurface(customTools)).toThrow(/plain array/);
    const unknownResourceMapper = mcpInput();
    unknownResourceMapper.resources[0].mapper = 'definitely-not-an-adapter';
    expect(() => defineMcpSurface(unknownResourceMapper)).toThrow(/registered MCP resource mapper/);
    const oversizedSchemaArray = mcpInput();
    oversizedSchemaArray.tools[0].inputSchema.examples = [];
    oversizedSchemaArray.tools[0].inputSchema.examples.length = 2000;
    expect(() => defineMcpSurface(oversizedSchemaArray)).toThrow(/array limit/);
  });

  it('validates the shipped 25-tool, three-resource, ordered 83-spelling surface', () => {
    expect(MCP_TOOL_DEFINITIONS).toHaveLength(25);
    expect(MCP_RESOURCE_TEMPLATES).toHaveLength(3);
    expect(MCP_RUN_COMMAND_ALLOWLIST).toHaveLength(83);
    expect(Object.isFrozen(MCP_TOOL_DEFINITIONS[0].inputSchema)).toBe(true);
    expect(Object.isFrozen(MCP_TOOL_DEFINITIONS[0].inputSchema.properties)).toBe(true);
    expect(Object.isFrozen(MCP_RESOURCE_TEMPLATES[0])).toBe(true);
    expect(MCP_TOOL_DEFINITIONS.filter(tool => tool.name === 'run_command')).toHaveLength(1);
    expect(MCP_TOOL_DEFINITIONS.find(tool => tool.name === 'run_command')
      .inputSchema.properties.confirm.description)
      .toContain('sensitive, raw, composite, or writes to a caller-selected destination');
    expect(COMMAND_SURFACE.commands.filter(command => command.mcp.toolName).map(command => command.mcp.toolName).sort())
      .toEqual(MCP_TOOL_DEFINITIONS.map(tool => tool.name).filter(name => name !== 'run_command').sort());
  });

  it('rejects reviewed catalog drift during import before installing process listeners', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'chrome-cdp-surface-drift-'));
    const copyPath = join(directory, 'command-surface.mjs');
    const source = readFileSync(new URL('../skills/chrome-cdp-ex/scripts/lib/command-surface.mjs', import.meta.url), 'utf8');
    const mutated = source.replace('Show this command reference (same as --help)', 'Show a drifted command reference');
    expect(mutated).not.toBe(source);
    const before = process.stdin.listenerCount('data');
    try {
      writeFileSync(copyPath, mutated);
      await expect(import(`${pathToFileURL(copyPath).href}?drift=1`)).rejects.toThrow(/catalog identity drifted/);
      expect(process.stdin.listenerCount('data')).toBe(before);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
