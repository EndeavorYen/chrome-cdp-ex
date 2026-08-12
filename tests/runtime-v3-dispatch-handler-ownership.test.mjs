import { describe, it } from 'vitest';

import {
  expectInventoryDrift,
  source,
} from './runtime-v3-dispatch-test-helpers.mjs';

describe('Runtime v3 handler ownership characterization', () => {
  it.each([
    source.replace(
      'shot: capabilities => createDaemonReadHandlers(capabilities).shot,',
      'shot: capabilities => createDaemonReadHandlers(capabilities).fullshot,',
    ),
    source.replace(
      "'diff-shot': args => diffShotStr(cdp, sessionId, session, parseDiffShotArgs(args)),",
      "'diff-shot': args => scanshotStr(cdp, sessionId, targetId),",
    ),
    source.replace(
      'scanshot: applicationPreflight.handlerBuilders.scanshot(readCapabilities),',
      'scanshot: applicationPreflight.handlerBuilders.fullshot(readCapabilities),',
    ),
    source.replace(
      "const diffShotBuilder = applicationPreflight.handlerBuilders['diff-shot'];",
      "const diffShotBuilder = applicationPreflight.handlerBuilders['record-actions'];",
    ),
    source.replace(
      'qa: capabilities => createDaemonActionHandlers(capabilities).qa,',
      "qa: capabilities => createDaemonActionHandlers(capabilities)['responsive-audit'],",
    ),
    source.replace(
      'qa: applicationPreflight.handlerBuilders.qa(actionCapabilities),',
      'qa: responsiveAuditBuilder(actionCapabilities),',
    ),
    source.replace(
      'closetab: capabilities => createDaemonActionHandlers(capabilities).closetab,',
      'closetab: capabilities => createDaemonActionHandlers(capabilities).loadall,',
    ),
    source.replace(
      'loadall: applicationPreflight.handlerBuilders.loadall(actionCapabilities),',
      'loadall: applicationPreflight.handlerBuilders.closetab(actionCapabilities),',
    ),
    source.replace(
      '  loadall: capabilities => createDaemonActionHandlers(capabilities).loadall,\n',
      '',
    ),
  ])('detects handler ownership mutation %#', expectInventoryDrift, 15_000);
});
