import { describe, it } from 'vitest';

import {
  expectInventoryDrift,
  source,
} from './runtime-v3-dispatch-test-helpers.mjs';

describe('Runtime v3 handler wiring characterization A', () => {
  it.each([
    source.replace(
      'html: capabilities => createDaemonReadHandlers(capabilities).html,',
      'html: capabilities => createDaemonReadHandlers(capabilities).text,',
    ),
    source.replace(
      'html: args => htmlStr(cdp, sessionId, args, { targetPrefix: targetPrefixForDisplay(targetId) }),',
      'html: args => textStr(cdp, sessionId, args),',
    ),
    source.replace(
      'html: args => htmlStr(cdp, sessionId, args, { targetPrefix: targetPrefixForDisplay(targetId) }),',
      'html: async args => { await htmlStr(cdp, sessionId, args); return htmlStr(cdp, sessionId, args); },',
    ),
    source.replace(
      'console: capabilities => createDaemonReadHandlers(capabilities).console,',
      'console: capabilities => createDaemonReadHandlers(capabilities).record,',
    ),
    source.replace(
      'record: capabilities => createDaemonReadHandlers(capabilities).record,',
      'record: capabilities => createDaemonReadHandlers(capabilities).console,',
    ),
    source.replace(
      'console: async args => {',
      'console: async args => recordStr(cdp, sessionId, args, refMap),\n    plantedConsole: async args => {',
    ),
    source.replace(
      'record: args => recordStr(cdp, sessionId, args, refMap),',
      'record: args => consoleStr(consoleBuf, exceptionBuf, lastReadSeq, args[0]),',
    ),
  ])('detects handler and capability wiring mutation %#', expectInventoryDrift, 15_000);
});
