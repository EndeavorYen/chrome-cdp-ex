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
    source.replace(
      'eval: async args => {',
      "eval: async args => commandResult(await callStr(cdp, sessionId, args.join(' ')), null),\n    plantedEval: async args => {",
    ),
    source.replace(
      'batch: capabilities => async ({ args }) => commandResult(await capabilities.batch(args), null),',
      'batch: capabilities => async ({ args }) => commandResult(await capabilities.flow(args), null),',
    ),
    source.replace(
      'batch: async args => {',
      'batch: async args => workflowCapabilities.flow(args),\n    plantedBatch: async args => {',
    ),
    source.replace(
      'replay: applicationPreflight.handlerBuilders.replay(workflowCapabilities),',
      'replay: applicationPreflight.handlerBuilders.repeat(workflowCapabilities),',
    ),
    source.replace(
      'upload: capabilities => createDaemonActionHandlers(capabilities).upload,',
      'upload: capabilities => createDaemonActionHandlers(capabilities).inject,',
    ),
    source.replace(
      'inject: applicationPreflight.handlerBuilders.inject(actionCapabilities),',
      'inject: applicationPreflight.handlerBuilders.restore(actionCapabilities),',
    ),
    source.replace(
      'restore: async args => {',
      'restore: async args => actionCapabilities.upload(args),\n    plantedRestore: async args => {',
    ),
  ])('detects handler and capability wiring mutation %#', expectInventoryDrift, 15_000);
});
