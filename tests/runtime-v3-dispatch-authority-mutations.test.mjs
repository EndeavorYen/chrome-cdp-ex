import { describe, expect, it } from 'vitest';

import { buildRuntimeDispatchInventory } from '../scripts/runtime-dispatch-inventory.mjs';
import {
  source,
} from './runtime-v3-dispatch-test-helpers.mjs';

describe('Runtime v3 dispatch authority characterization', () => {
  it('rejects shadowed handler and capability authority', () => {
    const builderStart = source.indexOf('const DAEMON_HANDLER_BUILDERS =');
    const builderEnd = source.indexOf('\n\nfunction preflightDaemonApplication', builderStart);
    const originalBuilders = source.slice(builderStart, builderEnd);
    const shadowedAuthority = `${source.replace(
      'html: capabilities => createDaemonReadHandlers(capabilities).html,',
      'html: capabilities => createDaemonReadHandlers(capabilities).text,',
    )}\nfunction plantedAuthority() {\n  ${originalBuilders}\n}\n`;
    expect(() => buildRuntimeDispatchInventory(shadowedAuthority)).toThrow(/top-level|exactly once/);
    expect(() => buildRuntimeDispatchInventory(source.replace(
      'const readCapabilities = {',
      'if (true) { const readCapabilities = {}; }\n  const readCapabilities = {',
    ))).toThrow(/direct runDaemon const|exactly once/);
    expect(() => buildRuntimeDispatchInventory(source.replace(
      'const actionCapabilities = {',
      'if (true) { const actionCapabilities = {}; }\n  const actionCapabilities = {',
    ))).toThrow(/direct runDaemon const|exactly once/);
    expect(() => buildRuntimeDispatchInventory(source.replace(
      'const scriptCapabilities = {',
      'if (true) { const scriptCapabilities = {}; }\n  const scriptCapabilities = {',
    ))).toThrow(/direct runDaemon const|exactly once/);
    expect(() => buildRuntimeDispatchInventory(source.replace(
      'const workflowCapabilities = {',
      'if (true) { const workflowCapabilities = {}; }\n  const workflowCapabilities = {',
    ))).toThrow(/direct runDaemon const|exactly once/);
    expect(() => buildRuntimeDispatchInventory(source.replace(
      "const dismissModalBuilder = applicationPreflight.handlerBuilders['dismiss-modal'];",
      "if (true) { const dismissModalBuilder = applicationPreflight.handlerBuilders['verify-click']; }\n  const dismissModalBuilder = applicationPreflight.handlerBuilders['dismiss-modal'];",
    ))).toThrow(/direct runDaemon const|exactly once/);
    expect(() => buildRuntimeDispatchInventory(source.replace(
      "const verifyClickBuilder = applicationPreflight.handlerBuilders['verify-click'];",
      "if (true) { const verifyClickBuilder = applicationPreflight.handlerBuilders['dismiss-modal']; }\n  const verifyClickBuilder = applicationPreflight.handlerBuilders['verify-click'];",
    ))).toThrow(/direct runDaemon const|exactly once/);
  }, 60_000);

});
