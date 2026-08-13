import { describe, expect, it } from 'vitest';

import { buildRuntimeDispatchInventory } from '../scripts/runtime-dispatch-inventory.mjs';
import { source } from './runtime-v3-dispatch-test-helpers.mjs';

describe('Runtime v3 table policy authority', () => {
  it('binds the exact catalog policy and argv-aware production owners', () => {
    const authority = buildRuntimeDispatchInventory(source).tablePolicyAuthority;
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
    expect(() => buildRuntimeDispatchInventory(mutation)).toThrow(/table policy authority/i);
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
    expect(() => buildRuntimeDispatchInventory(mutation)).toThrow(/table policy authority/i);
  });
});
