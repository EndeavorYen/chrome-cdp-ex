import { describe, it } from 'vitest';

import {
  expectInventoryDrift,
  INVENTORY_BUILD_TIMEOUT,
  source,
} from './runtime-v3-dispatch-test-helpers.mjs';

describe('Runtime v3 handler wiring characterization A2', () => {
  it.each([
    source.replace(
      'fill: applicationPreflight.handlerBuilders.fill(actionCapabilities),',
      'fill: applicationPreflight.handlerBuilders.select(actionCapabilities),',
    ),
    source.replace(
      "const recordActionsBuilder = applicationPreflight.handlerBuilders['record-actions'];",
      "const recordActionsBuilder = applicationPreflight.handlerBuilders['export-playwright'];",
    ),
    source.replace(
      "const exportPlaywrightBuilder = applicationPreflight.handlerBuilders['export-playwright'];",
      "const exportPlaywrightBuilder = applicationPreflight.handlerBuilders['record-actions'];",
    ),
    source.replace(
      "const dismissModalBuilder = applicationPreflight.handlerBuilders['dismiss-modal'];",
      "const dismissModalBuilder = applicationPreflight.handlerBuilders['verify-click'];",
    ),
    source.replace(
      "const verifyClickBuilder = applicationPreflight.handlerBuilders['verify-click'];",
      "const verifyClickBuilder = applicationPreflight.handlerBuilders['dismiss-modal'];",
    ),
    source.replace(
      'back: applicationPreflight.handlerBuilders.back(actionCapabilities),',
      'back: applicationPreflight.handlerBuilders.forward(actionCapabilities),',
    ),
    source.replace(
      'nav: applicationPreflight.handlerBuilders.nav(actionCapabilities),',
      'nav: applicationPreflight.handlerBuilders.reload(actionCapabilities),',
    ),
  ])('detects handler and capability wiring mutation %#', expectInventoryDrift, INVENTORY_BUILD_TIMEOUT);
});
