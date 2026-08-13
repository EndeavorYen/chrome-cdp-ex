import { describe, expect, it } from 'vitest';

import { buildRuntimeDispatchInventory } from '../scripts/runtime-dispatch-inventory.mjs';
import {
  daemonReadHandlersSource,
  mcpAdapterSource,
  source,
} from './runtime-v3-dispatch-test-helpers.mjs';

function inventory(cdpSource = source, overrides = {}) {
  return buildRuntimeDispatchInventory(cdpSource, {
    daemonReadHandlersSource,
    mcpAdapterSource,
    ...overrides,
  });
}

describe('Runtime v3 table policy authority', () => {
  it('binds the exact catalog policy and argv-aware production owners', () => {
    const authority = inventory().tablePolicyAuthority;
    expect(authority).toMatchObject({
      policy: {
        kind: 'conditional-mutation',
        authorization: 'conditional',
        evidencePolicy: 'none',
        mutates: false,
        outputFormats: ['text', 'json'],
      },
      helpers: [
        'authorizeDaemonApplicationCommand',
        'daemonRequestMayHaveSideEffects',
        'isBatchParallelUnsafeCommand',
      ],
    });
    expect(authority.sourceDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(authority.bindingDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it.each([
    source.replace(
      'isBatchParallelUnsafeCommand(command.cmd, command.args || [])',
      'isBatchParallelUnsafeCommand(command.cmd)',
    ),
    source.replace(
      'daemonRequestMayHaveSideEffects(req)',
      'daemonRequestMayHaveSideEffects({ cmd: req.cmd })',
    ),
    source.replace('if (tablePolicyMatches) parseTableArgs(args);', 'if (tablePolicyMatches) Boolean(args);'),
    source.replace(
      'authorize: authorizeDaemonApplicationCommand,',
      'authorize: input => authorizeDaemonApplicationCommand({ ...input, args: [] }),',
    ),
    source.replace(
      'table: request => tableStr(cdp, sessionId, request.selector),',
      'table: request => tableStr(cdp, sessionId, request.argv[0]),',
    ),
  ])('rejects or drifts when an argv-aware production binding is rewritten %#', mutation => {
    expect(() => inventory(mutation)).toThrow(/table policy authority/i);
  });

  it.each([
    source.replace(
      'function isBatchParallelUnsafeCommand(cmd, args = []) {',
      'function planted() { const isTableCollectArgs = () => false; }\nfunction isBatchParallelUnsafeCommand(cmd, args = []) {',
    ),
    source.replace(
      'return isTableCollectArgs(args);',
      'isTableCollectArgs(args);\n    return isTableCollectArgs(args);',
    ),
    source.replace(
      'function daemonRequestMayHaveSideEffects(request = {}) {',
      'function daemonRequestMayHaveSideEffects(request = {}) {\n  function parseTableArgs() { return {}; }',
    ),
  ])('rejects shadowed or duplicate table policy helpers %#', mutation => {
    expect(() => inventory(mutation)).toThrow(/table policy authority/i);
  });

  it.each([
    source.replace('return isTableCollectArgs(args);', 'return false && isTableCollectArgs(args);'),
    source.replace(
      'return isTableCollectArgs(request.args || []);',
      'return false && isTableCollectArgs(request.args || []);',
    ),
    source.replace(
      "const tablePolicyMatches = command === 'table' && policy === 'conditional' && mutates === false;",
      "const tablePolicyMatches = false && command === 'table' && policy === 'conditional' && mutates === false;",
    ).replace(
      "['console', 'diff-shot', 'fullshot', 'netlog', 'record', 'shot']",
      "['console', 'diff-shot', 'fullshot', 'netlog', 'record', 'shot', 'table']",
    ),
    source.replace(
      'mayHaveSideEffects: daemonRequestMayHaveSideEffects(req),',
      'mayHaveSideEffects: (daemonRequestMayHaveSideEffects(req), false),',
    ),
    source.replace(
      'const unsafe = commands.filter(command => isBatchParallelUnsafeCommand(command.cmd, command.args || []));',
      'commands.forEach(command => { if (false) isBatchParallelUnsafeCommand(command.cmd, command.args || []); });\n        const unsafe = [];',
    ),
    source.replace(
      'async function runDaemon(targetId, applicationPreflight = preflightDaemonApplication()) {',
      'async function runDaemon(targetId, applicationPreflight = preflightDaemonApplication()) {\n  const isBatchParallelUnsafeCommand = () => false;\n  const authorizeDaemonApplicationCommand = () => ({ allowed: true, code: \'bypass\' });',
    ),
  ])('rejects dead, hardcoded, generic-allowlist, and local-shadow bypasses %#', mutation => {
    expect(() => inventory(mutation)).toThrow(/table policy authority/i);
  });

  it.each([
    mcpAdapterSource.replace(
      "if (command.name === 'table') return parseTableRunCommandArgs(args).request.mode === 'collect';",
      "if (command.name === 'table') return false && parseTableRunCommandArgs(args).request.mode === 'collect';",
    ),
    mcpAdapterSource.replace(
      'export function argsRequireConfirm(commandName, args = []) {',
      'export function argsRequireConfirm(commandName, args = []) {\n  const parseTableRunCommandArgs = () => ({ request: { mode: \'observe\' } });',
    ),
  ])('rejects dead or shadowed MCP table parser ownership %#', mutation => {
    expect(() => inventory(source, { mcpAdapterSource: mutation })).toThrow(/table policy authority/i);
  });

  it.each([
    daemonReadHandlersSource.replace(
      'export function createDaemonReadHandlers(input) {',
      'export function createDaemonReadHandlers(input) {\n  const parseTableArgs = () => ({ mode: \'observe\', format: \'text\', selector: null });',
    ),
    daemonReadHandlersSource.replace(
      'const request = parseTableArgs(snapshotArgs(context));',
      'const request = false ? parseTableArgs(snapshotArgs(context)) : { mode: \'observe\', format: \'text\', selector: null };',
    ),
  ])('rejects dead or shadowed daemon table parser ownership %#', mutation => {
    expect(() => inventory(source, { daemonReadHandlersSource: mutation })).toThrow(/table policy authority/i);
  });
});
