import { describe, expect, it } from 'vitest';

import {
  expectInventoryDriftOrReject,
  inventory,
  mcpAdapterSource,
  source,
} from './runtime-v3-table-policy-authority-helpers.mjs';

describe('Runtime v3 table policy authority wiring', { timeout: 60_000 }, () => {
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
    expect(authority.artifactSourceDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(authority.observation).toMatchObject({
      owners: [
        'sampleRootFrameTables',
        'validAriaIdentity',
        'observedTableEntry',
        'tableObservationModel',
        'boundedTableObservationJson',
        'boundedTableObservationText',
        'boundedTableObservationEmissionJson',
        'boundedTableObservationEmissionText',
        'tableObservationStr',
        'emitTargetCommandResponse',
      ],
    });
    for (const key of [
      'sourceDigest', 'bindingDigest', 'samplerSourceDigest', 'extractionSourceDigest',
    ]) {
      expect(authority.observation[key]).toMatch(/^sha256:[a-f0-9]{64}$/);
    }
  });

  it.each([
    () => source.replace(
      'isBatchParallelUnsafeCommand(command.cmd, command.args || [])',
      'isBatchParallelUnsafeCommand(command.cmd)',
    ),
    () => source.replace(
      'daemonRequestMayHaveSideEffects(req)',
      'daemonRequestMayHaveSideEffects({ cmd: req.cmd })',
    ),
    () => source.replace('if (tablePolicyMatches) parseTableArgs(args);', 'if (tablePolicyMatches) Boolean(args);'),
    () => source.replace(
      'authorize: authorizeDaemonApplicationCommand,',
      'authorize: input => authorizeDaemonApplicationCommand({ ...input, args: [] }),',
    ),
    () => source.replace(
      "table: async (request, execution) => request.mode === 'continue'\n      ? JSON.stringify(await tableArtifactStore.readContinuation(request.continuation), null, 2)\n      : request.mode === 'collect'\n        ? tableCollectionStr(cdp, sessionId, request, execution, { store: tableArtifactStore, session: tableCollectorSession })\n        : tableObservationStr(cdp, sessionId, request),",
      "table: async (request, execution) => request.mode === 'continue'\n      ? JSON.stringify(await tableArtifactStore.readContinuation(request.argv[0]), null, 2)\n      : tableObservationStr(cdp, sessionId, request.selector),",
    ),
  ])('rejects or drifts when an argv-aware production binding is rewritten %#', mutation => {
    expect(() => inventory(mutation())).toThrow(/table policy authority/i);
  });

  it.each([
    () => source.replace(
      'function isBatchParallelUnsafeCommand(cmd, args = []) {',
      'function planted() { const isTableCollectArgs = () => false; }\nfunction isBatchParallelUnsafeCommand(cmd, args = []) {',
    ),
    () => source.replace(
      'return isTableCollectArgs(args);',
      'isTableCollectArgs(args);\n    return isTableCollectArgs(args);',
    ),
    () => source.replace(
      'function daemonRequestMayHaveSideEffects(request = {}) {',
      'function daemonRequestMayHaveSideEffects(request = {}) {\n  function parseTableArgs() { return {}; }',
    ),
  ])('rejects shadowed or duplicate table policy helpers %#', mutation => {
    expect(() => inventory(mutation())).toThrow(/table policy authority/i);
  });

  it.each([
    () => source.replace('return isTableCollectArgs(args);', 'return false && isTableCollectArgs(args);'),
    () => source.replace(
      'return isTableCollectArgs(request.args || []);',
      'return false && isTableCollectArgs(request.args || []);',
    ),
    () => source.replace(
      "const tablePolicyMatches = command === 'table' && policy === 'conditional' && mutates === false;",
      "const tablePolicyMatches = false && command === 'table' && policy === 'conditional' && mutates === false;",
    ).replace(
      "['console', 'diff-shot', 'fullshot', 'netlog', 'record', 'shot']",
      "['console', 'diff-shot', 'fullshot', 'netlog', 'record', 'shot', 'table']",
    ),
    () => source.replace(
      'mayHaveSideEffects: daemonRequestMayHaveSideEffects(req),',
      'mayHaveSideEffects: (daemonRequestMayHaveSideEffects(req), false),',
    ),
    () => source.replace(
      'const unsafe = commands.filter(command => isBatchParallelUnsafeCommand(command.cmd, command.args || []));',
      'commands.forEach(command => { if (false) isBatchParallelUnsafeCommand(command.cmd, command.args || []); });\n        const unsafe = [];',
    ),
    () => source.replace(
      'async function runDaemon(targetId, applicationPreflight = preflightDaemonApplication()) {',
      'async function runDaemon(targetId, applicationPreflight = preflightDaemonApplication()) {\n  const isBatchParallelUnsafeCommand = () => false;\n  const authorizeDaemonApplicationCommand = () => ({ allowed: true, code: \'bypass\' });',
    ),
  ])('rejects dead, hardcoded, generic-allowlist, and local-shadow bypasses %#', mutation => {
    expect(() => inventory(mutation())).toThrow(/table policy authority/i);
  });

  it.each([
    () => source.replace(
      'async function runDaemon(targetId, applicationPreflight = preflightDaemonApplication()) {',
      'async function runDaemon(targetId, applicationPreflight = preflightDaemonApplication(), isBatchParallelUnsafeCommand = () => false) {',
    ),
    () => source.replace(
      'async function runDaemon(targetId, applicationPreflight = preflightDaemonApplication()) {',
      "async function runDaemon(targetId, applicationPreflight = preflightDaemonApplication(), authorizeDaemonApplicationCommand = () => ({ allowed: true, code: 'bypass' })) {",
    ),
    () => source.replace(
      'async function runDaemon(targetId, applicationPreflight = preflightDaemonApplication()) {',
      'async function runDaemon(targetId, applicationPreflight = preflightDaemonApplication(), tableObservationStr = () => \'bypass\') {',
    ),
    () => source.replace(
      'function sendCommand(conn, req) {',
      'function sendCommand(conn, req, daemonRequestMayHaveSideEffects = () => false) {',
    ),
  ])('rejects parameter shadows of trusted table policy bindings %#', mutation => {
    expect(() => inventory(mutation())).toThrow(/table policy authority/i);
  });

  it.each([
    () => source.replace(
      'const workflowCapabilities = {',
      'const { isBatchParallelUnsafeCommand } = { isBatchParallelUnsafeCommand: () => false }; const workflowCapabilities = {',
    ),
    () => source.replace(
      'const workflowCapabilities = {',
      'isBatchParallelUnsafeCommand = () => false; const workflowCapabilities = {',
    ),
    () => source.replace(
      'const applicationHandlers = {',
      "authorizeDaemonApplicationCommand = () => ({ allowed: true, code: 'bypass' }); const applicationHandlers = {",
    ),
    () => source.replace(
      'function sendCommand(conn, req) {',
      'function sendCommand(conn, req) { daemonRequestMayHaveSideEffects = () => false;',
    ),
    () => source.replace(
      'const readCapabilities = {',
      "const tableObservationStr = () => 'bypass'; const readCapabilities = {",
    ),
    () => source.replace(
      'const recordActionsBuilder = applicationPreflight.handlerBuilders[\'record-actions\'];',
      "readCapabilities.table = () => 'bypass'; const recordActionsBuilder = applicationPreflight.handlerBuilders['record-actions'];",
    ),
  ])('rejects destructuring, assignment, and post-construction binding bypasses %#', mutation => {
    expect(() => inventory(mutation())).toThrow(/table policy authority/i);
  });

  it.each([
    () => source.replace(
      'const applicationDispatcher = createCommandDispatcher({',
      "applicationHandlers.table = async () => 'bypass'; const applicationDispatcher = createCommandDispatcher({",
    ),
    () => source.replace(
      'const applicationDispatcher = createCommandDispatcher({',
      "Object.defineProperty(readCapabilities, 'table', { value: () => 'bypass' }); const applicationDispatcher = createCommandDispatcher({",
    ),
    () => source.replace(
      'const applicationDispatcher = createCommandDispatcher({',
      "Object.assign(applicationHandlers, { table: async () => 'bypass' }); const applicationDispatcher = createCommandDispatcher({",
    ),
  ])('rejects direct and reflective writes after table wiring construction %#', mutation => {
    expect(() => inventory(mutation())).toThrow(/table policy authority/i);
  });

  it.each([
    () => source.replace(
      'async function runDaemon(targetId, applicationPreflight = preflightDaemonApplication()) {',
      'async function runDaemon(targetId, applicationPreflight = preflightDaemonApplication(), Object = { freeze: value => value }) {',
    ),
    () => source.replace(
      'Object.freeze(readCapabilities);',
      'const Object = { freeze: value => value }; Object.freeze(readCapabilities);',
    ),
    () => source.replace(
      'Object.freeze(readCapabilities);',
      'Object.freeze = value => value; Object.freeze(readCapabilities);',
    ),
  ])('rejects no-op or shadowed Object.freeze protection %#', mutation => {
    expect(() => inventory(mutation())).toThrow(/table policy authority/i);
  });

  it.each([
    () => source.replace(
      'Object.freeze(readCapabilities);',
      "const mutateTable = Object.assign; mutateTable(readCapabilities, { table: () => 'bypass' }); Object.freeze(readCapabilities);",
    ),
    () => source.replace(
      'Object.freeze(applicationHandlers);',
      "const mutateHandlers = Reflect.set; mutateHandlers(applicationHandlers, 'table', async () => 'bypass'); Object.freeze(applicationHandlers);",
    ),
    () => source.replace(
      'Object.freeze(applicationHandlers);',
      "false && Object.freeze(applicationHandlers); const wiringAlias = applicationHandlers; wiringAlias.table = async () => 'bypass';",
    ),
    () => source.replace(
      'Object.freeze(readCapabilities);',
      "Object['assign'](readCapabilities, { table: () => 'bypass' }); Object.freeze(readCapabilities);",
    ),
    () => source.replace(
      'Object.freeze(readCapabilities);',
      "Object['freeze'] = value => value; Object.freeze(readCapabilities);",
    ),
    () => source.replace(
      'Object.freeze(readCapabilities);',
      "globalThis.Object.freeze = value => value; Object.freeze(readCapabilities);",
    ),
    () => source.replace(
      'Object.freeze(readCapabilities);',
      "const leaked = readCapabilities; leaked.table = () => 'bypass'; Object.freeze(readCapabilities);",
    ),
    () => source.replace(
      'mayHaveSideEffects: daemonRequestMayHaveSideEffects(req),',
      "mayHaveSideEffects: daemonRequestMayHaveSideEffects(req), ['mayHaveSideEffects']: false,",
    ),
    () => source.replace(
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
    expectInventoryDriftOrReject(mutation());
  });

  it.each([
    () => mcpAdapterSource.replace(
      "if (command.name === 'table') return parseTableRunCommandArgs(args).request.mode === 'collect';",
      "if (command.name === 'table') return false && parseTableRunCommandArgs(args).request.mode === 'collect';",
    ),
    () => mcpAdapterSource.replace(
      'export function argsRequireConfirm(commandName, args = []) {',
      'export function argsRequireConfirm(commandName, args = []) {\n  const parseTableRunCommandArgs = () => ({ request: { mode: \'observe\' } });',
    ),
  ])('rejects dead or shadowed MCP table parser ownership %#', mutation => {
    expect(() => inventory(source, { mcpAdapterSource: mutation() })).toThrow(/table policy authority/i);
  });

  it('drifts when MCP mutates table argv after the exact confirmation decision', () => {
    const mutation = mcpAdapterSource.replace(
      'if (argsRequireConfirm(commandName, extra)) requireConfirm(args, `run_command ${commandName}`);',
      "if (argsRequireConfirm(commandName, extra)) requireConfirm(args, `run_command ${commandName}`);\n      if (commandName === 'table' && extra[0] !== 'fixture') extra.push('--collect', '--scroll-container', '.v');",
    );
    let mutated;
    try {
      mutated = inventory(source, { mcpAdapterSource: mutation }).tablePolicyAuthority;
    } catch (error) {
      expect(error.message).toMatch(/table policy authority/i);
      return;
    }
    expect(mutated).not.toEqual(inventory().tablePolicyAuthority);
  });

  it('drifts when MCP checks observation argv and restores collect argv after confirmation', () => {
    const mutation = mcpAdapterSource.replace(
      'if (argsRequireConfirm(commandName, extra)) requireConfirm(args, `run_command ${commandName}`);',
      "const collectArgs = [...extra];\n      if (commandName === 'table') extra.splice(0, extra.length, '#orders');\n      if (argsRequireConfirm(commandName, extra)) requireConfirm(args, `run_command ${commandName}`);\n      if (commandName === 'table') extra.splice(0, extra.length, ...collectArgs);",
    );
    let mutated;
    try {
      mutated = inventory(source, { mcpAdapterSource: mutation }).tablePolicyAuthority;
    } catch (error) {
      expect(error.message).toMatch(/table policy authority/i);
      return;
    }
    expect(mutated).not.toEqual(inventory().tablePolicyAuthority);
  });

  it('drifts when the MCP confirmation enforcer is changed to a no-op', () => {
    const mutation = mcpAdapterSource.replace(
      'if (args?.confirm !== true) throw new Error(`${action} requires confirm: true`);',
      'if (false && args?.confirm !== true) throw new Error(`${action} requires confirm: true`);',
    );
    let mutated;
    try {
      mutated = inventory(source, { mcpAdapterSource: mutation }).tablePolicyAuthority;
    } catch (error) {
      expect(error.message).toMatch(/table policy authority/i);
      return;
    }
    expect(mutated).not.toEqual(inventory().tablePolicyAuthority);
  });

  it('drifts when MCP own-data snapshot injects confirmation for table commands', () => {
    const mutation = mcpAdapterSource.replace(
      "export function snapshotMcpData(value, path = 'mcp', state = { nodes: 0, depth: 0 }) {",
      "export function snapshotMcpData(value, path = 'mcp', state = { nodes: 0, depth: 0 }) {\n  if (path === 'mcp.arguments' && value?.command === 'table') return Object.freeze({ ...value, confirm: true });",
    );
    let mutated;
    try {
      mutated = inventory(source, { mcpAdapterSource: mutation }).tablePolicyAuthority;
    } catch (error) {
      expect(error.message).toMatch(/table policy authority/i);
      return;
    }
    expect(mutated).not.toEqual(inventory().tablePolicyAuthority);
  });
});
