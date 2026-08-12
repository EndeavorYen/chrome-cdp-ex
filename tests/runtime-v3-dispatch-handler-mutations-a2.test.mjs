import { describe, it } from 'vitest';

import {
  expectInventoryDrift,
  source,
} from './runtime-v3-dispatch-test-helpers.mjs';

describe('Runtime v3 handler wiring characterization A2', () => {
  it.each([
    source.replace(
      "? await actionFeedback('fill', () => fillStr(cdp, sessionId, fargs[1], fargs[2], refMap, refState, { react: true })",
      "? await actionFeedback('fill', () => selectStr(cdp, sessionId, fargs[1], fargs[2])",
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
  ])('detects handler and capability wiring mutation %#', expectInventoryDrift, 15_000);
});
