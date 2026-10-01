import { expect } from 'vitest';

import { buildRuntimeDispatchInventory } from '../scripts/runtime-dispatch-inventory.mjs';
import {
  commandApplicationSource,
  daemonReadHandlersSource,
  mcpAdapterSource,
  source,
  tableArtifactsSource,
  tableContractSource,
  tableExtractionSource,
  tableSamplerSource,
  yieldToEventLoop,
} from './runtime-v3-dispatch-test-helpers.mjs';

export {
  commandApplicationSource,
  daemonReadHandlersSource,
  mcpAdapterSource,
  source,
  tableArtifactsSource,
  tableContractSource,
  tableExtractionSource,
  tableSamplerSource,
  yieldToEventLoop,
};

export function inventory(cdpSource = source, overrides = {}) {
  return buildRuntimeDispatchInventory(cdpSource, {
    commandApplicationSource,
    daemonReadHandlersSource,
    mcpAdapterSource,
    tableArtifactsSource,
    tableContractSource,
    tableExtractionSource,
    tableSamplerSource,
    ...overrides,
  });
}

// The unmutated sources never change within a run, so build their authority once instead of
// once per mutation (each build is several seconds of synchronous ESLint work). Read-only.
let baselineAuthority = null;
export function baselineTablePolicyAuthority() {
  baselineAuthority ??= inventory().tablePolicyAuthority;
  return baselineAuthority;
}

export function expectInventoryDriftOrReject(cdpSource) {
  let authority;
  try {
    authority = inventory(cdpSource).tablePolicyAuthority;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/table policy authority/i);
    return;
  }
  expect(authority).not.toEqual(baselineTablePolicyAuthority());
}

export function expectOverrideDriftOrReject(overrides) {
  let authority;
  try {
    authority = inventory(source, overrides).tablePolicyAuthority;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/table policy authority/i);
    return;
  }
  expect(authority).not.toEqual(baselineTablePolicyAuthority());
}

export function mutate(text, before, after) {
  expect(text).toContain(before);
  return text.replace(before, after);
}

export const lifecycleAuthorityOwnerNames = [
  'createDaemonRequestConnection',
  'createDaemonShutdown',
  'emitTargetCommandResponse',
  'isDeterministicTableContinuationResult',
];
