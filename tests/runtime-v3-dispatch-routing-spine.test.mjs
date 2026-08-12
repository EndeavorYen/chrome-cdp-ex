import { describe, it } from 'vitest';

import {
  expectInventoryDrift,
  source,
} from './runtime-v3-dispatch-test-helpers.mjs';

describe('Runtime v3 CLI and daemon routing spine characterization', () => {
  it.each([
    source.replace("cmd === '-h'", "cmd === '--planted-help'"),
    source.replace("if (cmd === '_daemon')", "if (cmd === '_planted-daemon')"),
    source.replace("if (cmd === 'target')", "if (cmd === '_planted-target')"),
    source.replace("if (cmd === 'wait' &&", "if (cmd === '_planted-wait' &&"),
    source.replace('async function handleCommand({ cmd, args }) {\n    resetIdle();', "async function handleCommand({ cmd, args }) {\n    resetIdle();\n    cmd = 'summary';"),
    source.replace("return { ok: true, result: result ?? '' };", "return { ok: true, result: 'planted' };"),
    source.replace('return finish(1);\n  }\n\n  // Canonicalize aliases', 'return finish(0);\n  }\n\n  // Canonicalize aliases'),
    source.replace('cmd = commandMeta(cmd)?.name || cmd;', 'cmd = cmd;'),
    source.replace('const response = await runtimeSupervisor.execute(runtimeHandle, { cmd, args: cmdArgs });', "const response = { ok: true, result: 'planted' };"),
    source.replace(
      "return { ok: false, error: e.message || String(e) };\n    }\n  }",
      "return { ok: false, error: e.message || String(e) };\n    }\n    // default: return { ok: false, error: `Unknown command: ${cmd}` };\n  }",
    ).replace("return { ok: true, result: result ?? '' };", "return { ok: true, result: 'planted' };"),
  ])('detects routing spine mutation %#', expectInventoryDrift, 15_000);
});
