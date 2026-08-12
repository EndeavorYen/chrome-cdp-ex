import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { expect } from 'vitest';

import { buildRuntimeDispatchInventory } from '../scripts/runtime-dispatch-inventory.mjs';

export const rootDir = fileURLToPath(new URL('..', import.meta.url));
export const source = readFileSync(join(rootDir, 'skills/chrome-cdp-ex/scripts/cdp.mjs'), 'utf8');
export const fixture = JSON.parse(readFileSync(
  join(rootDir, 'docs/contracts/v2.15.0/runtime-dispatch.v1.json'),
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
