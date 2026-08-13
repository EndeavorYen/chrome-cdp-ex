import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

import {
  buildPublicContract,
  canonicalize,
  canonicalizeContract,
  diffContracts,
} from '../scripts/check-public-contracts.mjs';
import { validatePackageInventory } from '../scripts/check-release-package.mjs';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const checkerPath = join(rootDir, 'scripts/check-public-contracts.mjs');
const packageVersion = JSON.parse(
  readFileSync(join(rootDir, 'package.json'), 'utf8'),
).version;

describe('public contract baseline', () => {
  it('keeps every published v2.15 fixture byte-identical', () => {
    const expected = {
      'package-entries.v1.json': '279e3e23d154d6ef5f01bb4479be22167b39634bfbdc28b7b27a49558476d3e2',
      'public-contracts.v1.json': '169f2ff562ad05fe38e902de1500429444e3ad646aee1121ddea02dd46809556',
      'runtime-dispatch.v1.json': '43326e9b9216a4c27d7d7beda4265ee86fe32ed99f80297215829ecea10ab062',
    };
    for (const [name, checksum] of Object.entries(expected)) {
      const bytes = readFileSync(join(rootDir, 'docs/contracts/v2.15.0', name));
      expect(createHash('sha256').update(bytes).digest('hex'), name).toBe(checksum);
    }
  });

  it('canonicalizes object keys recursively without reordering arrays', () => {
    expect(canonicalize({ z: 1, a: { y: 2, b: 3 }, list: [{ z: 1, a: 2 }, 'x'] }))
      .toEqual({ a: { b: 3, y: 2 }, list: [{ a: 2, z: 1 }, 'x'], z: 1 });
    expect(canonicalizeContract({
      inputSchema: { required: ['z', 'a'], type: ['string', 'null'] },
      mapping: { type: ['z', 'a'] },
      argv: ['z', 'a'],
    })).toEqual({
      argv: ['z', 'a'],
      inputSchema: { required: ['a', 'z'], type: ['null', 'string'] },
      mapping: { type: ['z', 'a'] },
    });
  });

  it('projects every current command, alias, schema, and MCP surface from source', async () => {
    const contract = await buildPublicContract({ rootDir });
    const aliases = contract.commands.flatMap(command => command.aliases);

    expect(contract.schema).toBe('chrome-cdp-ex.public-contracts.v1');
    expect(contract.productVersion).toBe(packageVersion);
    expect(contract.commands).toHaveLength(81);
    expect(contract.commands.every(command => (
      typeof command.kind === 'string'
      && typeof command.authorization === 'string'
      && typeof command.evidencePolicy === 'string'
    ))).toBe(true);
    expect(new Set(aliases).size).toBe(23);
    expect(contract.schemas).toHaveLength(5);
    expect(contract.schemas.every(schema => schema.id.startsWith('https://'))).toBe(true);
    expect(contract.mcp.tools).toHaveLength(26);
    expect(contract.mcp.runCommandAllowlist).toHaveLength(83);
    expect(contract.mcp.resourceTemplates).toHaveLength(3);
  });

  it('freezes deterministic browser-independent CLI exits and output', async () => {
    const first = await buildPublicContract({ rootDir });
    const second = await buildPublicContract({ rootDir });

    expect(first.cliCases.map(entry => entry.id)).toEqual([
      'no-args-help',
      'help',
      'unknown-command-suggestion',
      'invalid-list-argument',
      'invalid-format',
      'missing-target',
    ]);
    expect(first.cliCases.map(entry => entry.exitCode)).toEqual([0, 0, 1, 1, 1, 1]);
    expect(first.cliCases.slice(2).every(entry => entry.stderr.startsWith('Error:'))).toBe(true);
    expect(first.cliCases).toEqual(second.cliCases);
    expect(JSON.stringify(first.cliCases)).not.toContain(rootDir);
  });

  it('covers every MCP tool plus branching and invalid mapping contracts', async () => {
    const contract = await buildPublicContract({ rootDir });
    const toolNames = contract.mcp.tools.map(tool => tool.name).sort();
    const coveredTools = [...new Set(contract.mcp.mappingCases.map(entry => entry.tool))].sort();
    const commandSpellings = new Set(contract.commands.flatMap(command => [command.name, ...command.aliases]));

    expect(coveredTools).toEqual(toolNames);
    expect(contract.mcp.mappingCases.map(entry => entry.id)).toEqual(expect.arrayContaining([
      'open-new-tab',
      'open-attach-alias',
      'viewport-read',
      'viewport-set',
      'wait-for-text',
      'wait-for-any',
      'wait-for-stable',
      'run-command-read',
      'run-command-mutation',
      'run-command-table-observe',
      'run-command-table-collect',
      'run-command-table-continue',
      'table-observe',
      'table-collect',
      'table-continue',
    ]));
    expect(contract.mcp.mappingCases.every(entry => commandSpellings.has(entry.command[0]))).toBe(true);
    expect(contract.mcp.invalidCases.map(entry => entry.id)).toEqual([
      'mutation-without-confirm',
      'sensitive-read-without-confirm',
      'checkpoint-without-confirm',
      'qa-page-without-confirm',
      'responsive-audit-without-confirm',
      'missing-required-argument',
      'run-command-use-without-confirm',
      'run-command-forget-without-confirm',
      'run-command-tab-group-mutation-without-confirm',
      'run-command-loadall-without-confirm',
      'run-command-record-action-without-confirm',
      'run-command-keepalive-without-confirm',
      'run-command-console-clear-without-confirm',
      'run-command-netlog-clear-without-confirm',
      'run-command-diff-shot-reset-without-confirm',
      'run-command-shot-path-without-confirm',
      'run-command-fullshot-path-without-confirm',
      'run-command-table-collect-without-confirm',
      'run-command-table-malformed',
      'table-collect-without-confirm',
      'table-selector-and-continue',
      'screenshot-path-without-confirm',
      'run-command-not-allowlisted',
      'run-command-newline',
      'unknown-tool',
      'unknown-resource',
    ]);
    expect(contract.mcp.resourceMappings).toHaveLength(3);
  });

  it('reports a bounded path-oriented contract diff', () => {
    const expected = { commands: [{ name: 'help', aliases: [] }] };
    const actual = { commands: [{ name: 'assist', aliases: [] }] };

    expect(diffContracts(expected, actual)).toEqual([
      'commands[0].name: expected "help", received "assist"',
    ]);

    const large = diffContracts(
      { cliCases: [{ stdout: 'a'.repeat(20_000) }] },
      { cliCases: [{ stdout: `${'a'.repeat(19_999)}b` }] },
    );
    expect(large).toHaveLength(1);
    expect(large[0]).toContain('chars omitted');
    expect(large[0].length).toBeLessThanOrEqual(600);
  });

  it('matches the checked-in current-version fixture and detects each protected drift class', async () => {
    const actual = await buildPublicContract({ rootDir });
    const fixture = JSON.parse(readFileSync(
      join(rootDir, 'docs', 'contracts', `v${packageVersion}`, 'public-contracts.v1.json'),
      'utf8',
    ));
    expect(diffContracts(fixture, actual)).toEqual([]);

    const drills = [
      ['command name', 'commands[0].name', contract => { contract.commands[0].name = 'assist'; }],
      ['command alias', 'commands[1].aliases[0]', contract => { contract.commands[1].aliases[0] = 'pages'; }],
      ['feedback policy', 'commands[4].feedbackPolicy', contract => { contract.commands[4].feedbackPolicy = 'settle-diff'; }],
      ['command kind', 'commands[0].kind', contract => { contract.commands[0].kind = 'mutation'; }],
      ['authorization policy', 'commands[0].authorization', contract => { contract.commands[0].authorization = 'mutation'; }],
      ['evidence policy', 'commands[0].evidencePolicy', contract => { contract.commands[0].evidencePolicy = 'action-receipt'; }],
      ['JSON schema', 'schemas[0].document.title', contract => { contract.schemas[0].document.title = 'Changed'; }],
      ['MCP required field', 'mcp.tools[0].inputSchema.required', contract => { contract.mcp.tools[0].inputSchema.required = ['fixture']; }],
      ['MCP mapping', 'mcp.mappingCases[0].command[0]', contract => { contract.mcp.mappingCases[0].command[0] = 'list'; }],
      ['CLI exit code', 'cliCases[0].exitCode', contract => { contract.cliCases[0].exitCode = 1; }],
      ['CLI output', 'cliCases[0].stdout', contract => { contract.cliCases[0].stdout = 'changed'; }],
    ];
    for (const [label, path, mutate] of drills) {
      const changed = structuredClone(actual);
      mutate(changed);
      expect(diffContracts(actual, changed), label).toEqual([
        expect.stringContaining(`${path}: expected`),
      ]);
    }
  });

  it('requires an explicit matching version and never writes by default', () => {
    const missing = spawnSync(process.execPath, [checkerPath], {
      cwd: rootDir,
      encoding: 'utf8',
    });
    const wrong = spawnSync(process.execPath, [checkerPath, '--version', '0.0.0'], {
      cwd: rootDir,
      encoding: 'utf8',
    });

    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain('--version X.Y.Z is required');
    expect(wrong.status).not.toBe(0);
    expect(wrong.stderr).toContain(`must match package version ${packageVersion}`);
  });

  it('rejects missing, extra, and version-mismatched package entries', () => {
    const fixture = {
      schema: 'chrome-cdp-ex.package-entries.v1',
      productVersion: packageVersion,
      entries: ['package/a', 'package/b'],
    };

    expect(validatePackageInventory(['package/a'], fixture, packageVersion)).toEqual([
      'Release package inventory is missing entry: package/b',
    ]);
    expect(validatePackageInventory(['package/a', 'package/b', 'package/c'], fixture, packageVersion)).toEqual([
      'Release package inventory has unexpected entry: package/c',
    ]);
    expect(validatePackageInventory(['package/a', 'package/b'], fixture, '0.0.0')).toEqual([
      `Release package inventory version mismatch: fixture ${packageVersion} != package 0.0.0`,
    ]);
  });
});
