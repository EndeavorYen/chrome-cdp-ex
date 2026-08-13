import { describe, expect, it } from 'vitest';

import { buildRuntimeDispatchInventory } from '../scripts/runtime-dispatch-inventory.mjs';
import {
  commandApplicationSource,
  daemonReadHandlersSource,
  mcpAdapterSource,
  source,
  tableContractSource,
} from './runtime-v3-dispatch-test-helpers.mjs';

function inventory(cdpSource = source, overrides = {}) {
  return buildRuntimeDispatchInventory(cdpSource, {
    commandApplicationSource,
    daemonReadHandlersSource,
    mcpAdapterSource,
    tableContractSource,
    ...overrides,
  });
}

function expectInventoryDriftOrReject(cdpSource) {
  let authority;
  try {
    authority = inventory(cdpSource).tablePolicyAuthority;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/table policy authority/i);
    return;
  }
  expect(authority).not.toEqual(inventory().tablePolicyAuthority);
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
    source.replace(
      'async function runDaemon(targetId, applicationPreflight = preflightDaemonApplication()) {',
      'async function runDaemon(targetId, applicationPreflight = preflightDaemonApplication(), isBatchParallelUnsafeCommand = () => false) {',
    ),
    source.replace(
      'async function runDaemon(targetId, applicationPreflight = preflightDaemonApplication()) {',
      "async function runDaemon(targetId, applicationPreflight = preflightDaemonApplication(), authorizeDaemonApplicationCommand = () => ({ allowed: true, code: 'bypass' })) {",
    ),
    source.replace(
      'async function runDaemon(targetId, applicationPreflight = preflightDaemonApplication()) {',
      'async function runDaemon(targetId, applicationPreflight = preflightDaemonApplication(), tableStr = () => \'bypass\') {',
    ),
    source.replace(
      'function sendCommand(conn, req) {',
      'function sendCommand(conn, req, daemonRequestMayHaveSideEffects = () => false) {',
    ),
  ])('rejects parameter shadows of trusted table policy bindings %#', mutation => {
    expect(() => inventory(mutation)).toThrow(/table policy authority/i);
  });

  it.each([
    source.replace(
      'const workflowCapabilities = {',
      'const { isBatchParallelUnsafeCommand } = { isBatchParallelUnsafeCommand: () => false }; const workflowCapabilities = {',
    ),
    source.replace(
      'const workflowCapabilities = {',
      'isBatchParallelUnsafeCommand = () => false; const workflowCapabilities = {',
    ),
    source.replace(
      'const applicationHandlers = {',
      "authorizeDaemonApplicationCommand = () => ({ allowed: true, code: 'bypass' }); const applicationHandlers = {",
    ),
    source.replace(
      'function sendCommand(conn, req) {',
      'function sendCommand(conn, req) { daemonRequestMayHaveSideEffects = () => false;',
    ),
    source.replace(
      'const readCapabilities = {',
      "const tableStr = () => 'bypass'; const readCapabilities = {",
    ),
    source.replace(
      'const recordActionsBuilder = applicationPreflight.handlerBuilders[\'record-actions\'];',
      "readCapabilities.table = () => 'bypass'; const recordActionsBuilder = applicationPreflight.handlerBuilders['record-actions'];",
    ),
  ])('rejects destructuring, assignment, and post-construction binding bypasses %#', mutation => {
    expect(() => inventory(mutation)).toThrow(/table policy authority/i);
  });

  it.each([
    source.replace(
      'const applicationDispatcher = createCommandDispatcher({',
      "applicationHandlers.table = async () => 'bypass'; const applicationDispatcher = createCommandDispatcher({",
    ),
    source.replace(
      'const applicationDispatcher = createCommandDispatcher({',
      "Object.defineProperty(readCapabilities, 'table', { value: () => 'bypass' }); const applicationDispatcher = createCommandDispatcher({",
    ),
    source.replace(
      'const applicationDispatcher = createCommandDispatcher({',
      "Object.assign(applicationHandlers, { table: async () => 'bypass' }); const applicationDispatcher = createCommandDispatcher({",
    ),
  ])('rejects direct and reflective writes after table wiring construction %#', mutation => {
    expect(() => inventory(mutation)).toThrow(/table policy authority/i);
  });

  it.each([
    source.replace(
      'async function runDaemon(targetId, applicationPreflight = preflightDaemonApplication()) {',
      'async function runDaemon(targetId, applicationPreflight = preflightDaemonApplication(), Object = { freeze: value => value }) {',
    ),
    source.replace(
      'Object.freeze(readCapabilities);',
      'const Object = { freeze: value => value }; Object.freeze(readCapabilities);',
    ),
    source.replace(
      'Object.freeze(readCapabilities);',
      'Object.freeze = value => value; Object.freeze(readCapabilities);',
    ),
  ])('rejects no-op or shadowed Object.freeze protection %#', mutation => {
    expect(() => inventory(mutation)).toThrow(/table policy authority/i);
  });

  it.each([
    source.replace(
      'Object.freeze(readCapabilities);',
      "const mutateTable = Object.assign; mutateTable(readCapabilities, { table: () => 'bypass' }); Object.freeze(readCapabilities);",
    ),
    source.replace(
      'Object.freeze(applicationHandlers);',
      "const mutateHandlers = Reflect.set; mutateHandlers(applicationHandlers, 'table', async () => 'bypass'); Object.freeze(applicationHandlers);",
    ),
    source.replace(
      'Object.freeze(applicationHandlers);',
      "false && Object.freeze(applicationHandlers); const wiringAlias = applicationHandlers; wiringAlias.table = async () => 'bypass';",
    ),
    source.replace(
      'Object.freeze(readCapabilities);',
      "Object['assign'](readCapabilities, { table: () => 'bypass' }); Object.freeze(readCapabilities);",
    ),
    source.replace(
      'Object.freeze(readCapabilities);',
      "Object['freeze'] = value => value; Object.freeze(readCapabilities);",
    ),
    source.replace(
      'Object.freeze(readCapabilities);',
      "globalThis.Object.freeze = value => value; Object.freeze(readCapabilities);",
    ),
    source.replace(
      'Object.freeze(readCapabilities);',
      "const leaked = readCapabilities; leaked.table = () => 'bypass'; Object.freeze(readCapabilities);",
    ),
    source.replace(
      'mayHaveSideEffects: daemonRequestMayHaveSideEffects(req),',
      "mayHaveSideEffects: daemonRequestMayHaveSideEffects(req), ['mayHaveSideEffects']: false,",
    ),
    source.replace(
      "  const applicationDispatcher = createCommandDispatcher({\n    registry: applicationRegistry,",
      "  const applicationDispatcher = createCommandDispatcher({\n    registry: applicationRegistry,",
    ).replace(
      'Object.freeze(applicationHandlers);\n  const applicationDispatcher',
      'const applicationDispatcher',
    ).replace(
      '  // Handle a command',
      '  Object.freeze(applicationHandlers);\n\n  // Handle a command',
    ),
  ])('rejects or drifts for alias, computed, dead, and reordered wiring mutation %#', mutation => {
    expectInventoryDriftOrReject(mutation);
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

  it.each([
    tableContractSource.replace(
      "return parseTableArgs(input).mode === 'collect';",
      "return false && parseTableArgs(input).mode === 'collect';",
    ),
    tableContractSource.replace(
      "return parseTableArgs(input).mode === 'collect';",
      "parseTableArgs(input); return input.includes('--collect');",
    ),
  ])('rejects dead or substituted table-contract collect classification %#', mutation => {
    expect(() => inventory(source, { tableContractSource: mutation })).toThrow(/table policy authority/i);
  });

  it.each([
    commandApplicationSource.replace('args: request.args,', 'args: [],'),
    commandApplicationSource.replace('args: request.args,', ''),
  ])('rejects command-application authorization without exact argv forwarding %#', mutation => {
    expect(() => inventory(source, { commandApplicationSource: mutation })).toThrow(/table policy authority/i);
  });

  it('rejects a swapped catalog table policy before inventory projection', () => {
    const commandSurface = {
      resolve(name) {
        if (name !== 'table') return null;
        return {
          kind: 'read',
          authorization: 'standard',
          evidencePolicy: 'none',
          mutates: false,
          outputFormats: ['text', 'json'],
        };
      },
    };
    expect(() => inventory(source, { commandSurface })).toThrow(/table policy authority/i);
  });

  it.each([
    source.replace(
      'table: capabilities => createDaemonReadHandlers(capabilities).table,',
      'table: capabilities => createDaemonReadHandlers(capabilities).text,',
    ),
    source.replace(
      'table: applicationPreflight.handlerBuilders.table(readCapabilities),',
      'table: applicationPreflight.handlerBuilders.text(readCapabilities),',
    ),
    source.replace(
      'table: request => tableStr(cdp, sessionId, request.selector),',
      'table: request => textStr(cdp, sessionId, request.selector),',
    ),
  ])('rejects substituted table handler and capability wiring %#', mutation => {
    expect(() => inventory(mutation)).toThrow(/table policy authority/i);
  });
});
