import { describe, it } from 'vitest';

import {
  expectInventoryDrift,
  source,
} from './runtime-v3-dispatch-test-helpers.mjs';

describe('Runtime v3 handler wiring characterization B', () => {
  it.each([
    source.replace(
      'clock: applicationPreflight.handlerBuilders.clock(actionCapabilities),',
      'clock: applicationPreflight.handlerBuilders.throttle(actionCapabilities),',
    ),
    source.replace(
      'mock: applicationPreflight.handlerBuilders.mock(actionCapabilities),',
      'mock: applicationPreflight.handlerBuilders.clock(actionCapabilities),',
    ),
    source.replace(
      'emulate: applicationPreflight.handlerBuilders.emulate(actionCapabilities),',
      'emulate: applicationPreflight.handlerBuilders.viewport(actionCapabilities),',
    ),
    source.replace(
      'viewport: applicationPreflight.handlerBuilders.viewport(actionCapabilities),',
      'viewport: applicationPreflight.handlerBuilders.emulate(actionCapabilities),',
    ),
    source.replace(
      'cookieset: applicationPreflight.handlerBuilders.cookieset(actionCapabilities),',
      'cookieset: applicationPreflight.handlerBuilders.cookiedel(actionCapabilities),',
    ),
    source.replace(
      'netlog: applicationPreflight.handlerBuilders.netlog(actionCapabilities),',
      'netlog: applicationPreflight.handlerBuilders.dialog(actionCapabilities),',
    ),
    source.replace(
      'eval: applicationPreflight.handlerBuilders.eval(scriptCapabilities),',
      'eval: applicationPreflight.handlerBuilders.call(scriptCapabilities),',
    ),
  ])('detects handler and capability wiring mutation %#', expectInventoryDrift, 15_000);
});
