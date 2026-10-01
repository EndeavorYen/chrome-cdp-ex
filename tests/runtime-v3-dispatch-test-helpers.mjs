import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { expect } from 'vitest';

import { buildRuntimeDispatchInventory } from '../scripts/runtime-dispatch-inventory.mjs';

export const rootDir = fileURLToPath(new URL('..', import.meta.url));
export const source = readFileSync(join(rootDir, 'skills/chrome-cdp-ex/scripts/cdp.mjs'), 'utf8');
export const mcpAdapterSource = readFileSync(
  join(rootDir, 'skills/chrome-cdp-ex/scripts/lib/mcp-adapter.mjs'),
  'utf8',
);
export const daemonReadHandlersSource = readFileSync(
  join(rootDir, 'skills/chrome-cdp-ex/scripts/lib/daemon-read-handlers.mjs'),
  'utf8',
);
export const tableContractSource = readFileSync(
  join(rootDir, 'skills/chrome-cdp-ex/scripts/lib/table-contract.mjs'),
  'utf8',
);
export const tableArtifactsSource = readFileSync(
  join(rootDir, 'skills/chrome-cdp-ex/scripts/lib/table-artifacts.mjs'),
  'utf8',
);
export const tableExtractionSource = readFileSync(
  join(rootDir, 'skills/chrome-cdp-ex/scripts/lib/table-extraction.mjs'),
  'utf8',
);
export const tableSamplerSource = readFileSync(
  join(rootDir, 'skills/chrome-cdp-ex/scripts/lib/table-sampler.mjs'),
  'utf8',
);
export const commandApplicationSource = readFileSync(
  join(rootDir, 'skills/chrome-cdp-ex/scripts/lib/command-application.mjs'),
  'utf8',
);
export const packageVersion = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8')).version;
export const fixture = JSON.parse(readFileSync(
  join(rootDir, `docs/contracts/v${packageVersion}/runtime-dispatch.v1.json`),
  'utf8',
));
export const scriptPath = join(rootDir, 'scripts/runtime-dispatch-inventory.mjs');

// One buildRuntimeDispatchInventory call runs five ESLint passes over the ~28k-line cdp.mjs
// (3-6 s alone on a developer machine). A mutated source cannot reuse an earlier parse, so
// these budgets are sized for a 2-worker hosted runner (Windows included) with headroom,
// not for an idle laptop.
export const INVENTORY_BUILD_TIMEOUT = 120_000;
export const MULTI_BUILD_TIMEOUT = 300_000;

// The vitest worker reads the runner's RPC replies only when its event loop turns. A file of
// back-to-back synchronous builds starves it past birpc's 60 s call timeout, and vitest then
// reports `Timeout calling "onTaskUpdate"` although every assertion passed. Await this before
// each build so the loop turns between builds (#463).
export function yieldToEventLoop() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

export async function expectInventoryDrift(mutation) {
  await yieldToEventLoop();
  try {
    expect(buildRuntimeDispatchInventory(mutation)).not.toEqual(fixture);
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
  }
}
