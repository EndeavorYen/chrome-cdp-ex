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

export function expectInventoryDrift(mutation) {
  try {
    expect(buildRuntimeDispatchInventory(mutation)).not.toEqual(fixture);
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
  }
}
