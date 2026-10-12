import { describe, it } from 'vitest';

import {
  expectInventoryDrift,
  INVENTORY_BUILD_TIMEOUT,
  source,
} from './runtime-v3-dispatch-test-helpers.mjs';

describe('Runtime v3 CLI and daemon routing spine characterization', () => {
  it.each([
    source.replace("cmd === '-h'", "cmd === '--planted-help'"),
    source.replace("if (cmd === '_daemon')", "if (cmd === '_planted-daemon')"),
    source.replace("if (cmd === 'target')", "if (cmd === '_planted-target')"),
    source.replace(
      "if (cmd === 'wait' && /^\\d+$/.test(args[0] || '') && !args[1])",
      "if (cmd === '_planted-wait' && /^\\d+$/.test(args[0] || '') && !args[1])",
    ),
    source.replace(
      'async function handleCommand({ cmd, args, policy, secrets = null }, execution = undefined, { outermost = false, guarded = false, dialogFlagTaken = false } = {}) {\n  await environmentReady;',
      "async function handleCommand({ cmd, args, policy, secrets = null }, execution = undefined, { outermost = false, guarded = false, dialogFlagTaken = false } = {}) {\n  await environmentReady;\n  cmd = 'summary';",
    ),
    source.replace("return { ok: true, result: result ?? '' };", "return { ok: true, result: 'planted' };"),
    source.replace('return finish(1);\n  }\n\n  // Canonicalize aliases', 'return finish(0);\n  }\n\n  // Canonicalize aliases'),
    source.replace('cmd = commandMeta(cmd)?.name || cmd;', 'cmd = cmd;'),
    source.replace(
      'response = await runtimeSupervisor.execute(runtimeHandle, {',
      "response = { ok: true, result: 'planted' }; void runtimeSupervisor.execute(runtimeHandle, {",
    ),
    source.replace(
      "return { ok: false, error: e.message || String(e) };\n    }\n  }",
      "return { ok: false, error: e.message || String(e) };\n    }\n    // default: return { ok: false, error: `Unknown command: ${cmd}` };\n  }",
    ).replace("return { ok: true, result: result ?? '' };", "return { ok: true, result: 'planted' };"),
  ])('detects routing spine mutation %#', expectInventoryDrift, INVENTORY_BUILD_TIMEOUT);
});
