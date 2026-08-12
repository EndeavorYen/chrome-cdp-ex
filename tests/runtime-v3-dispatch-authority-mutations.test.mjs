import { describe, expect, it } from 'vitest';

import { buildRuntimeDispatchInventory } from '../scripts/runtime-dispatch-inventory.mjs';
import {
  expectInventoryDrift,
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
  }, 30_000);

  it('binds the CLI and daemon routing spine', () => {
    for (const mutation of [
      source.replace("cmd === '-h'", "cmd === '--planted-help'"),
      source.replace("if (cmd === '_daemon')", "if (cmd === '_planted-daemon')"),
      source.replace("if (cmd === 'target')", "if (cmd === '_planted-target')"),
      source.replace("if (cmd === 'wait' &&", "if (cmd === '_planted-wait' &&"),
      source.replace('async function handleCommand({ cmd, args }) {\n    resetIdle();', "async function handleCommand({ cmd, args }) {\n    resetIdle();\n    cmd = 'summary';"),
      source.replace("return { ok: true, result: result ?? '' };", "return { ok: true, result: 'planted' };"),
      source.replace('return finish(1);\n  }\n\n  // Canonicalize aliases', 'return finish(0);\n  }\n\n  // Canonicalize aliases'),
      source.replace('cmd = commandMeta(cmd)?.name || cmd;', 'cmd = cmd;'),
      source.replace('const response = await runtimeSupervisor.execute(runtimeHandle, { cmd, args: cmdArgs });', "const response = { ok: true, result: 'planted' };"),
    ]) expectInventoryDrift(mutation);

    const markerCollision = source.replace(
      "return { ok: false, error: e.message || String(e) };\n    }\n  }",
      "return { ok: false, error: e.message || String(e) };\n    }\n    // default: return { ok: false, error: `Unknown command: ${cmd}` };\n  }",
    ).replace("return { ok: true, result: result ?? '' };", "return { ok: true, result: 'planted' };");
    expectInventoryDrift(markerCollision);
  }, 30_000);
});
