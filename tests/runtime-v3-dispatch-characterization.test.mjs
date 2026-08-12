import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

import { buildRuntimeDispatchInventory } from '../scripts/runtime-dispatch-inventory.mjs';
import { COMMAND_SURFACE } from '../skills/chrome-cdp-ex/scripts/lib/command-surface.mjs';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const sourcePath = join(rootDir, 'skills/chrome-cdp-ex/scripts/cdp.mjs');
const fixturePath = join(rootDir, 'docs/contracts/v2.15.0/runtime-dispatch.v1.json');
const scriptPath = join(rootDir, 'scripts/runtime-dispatch-inventory.mjs');
const source = readFileSync(sourcePath, 'utf8');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));

describe('Runtime v3 final dispatch characterization', () => {
  it('freezes the exact 81-command daemon/CLI ownership graph and deletion allowlist', () => {
    expect(buildRuntimeDispatchInventory(source)).toEqual(fixture);
    expect(fixture).toMatchObject({
      schema: 'chrome-cdp-ex.runtime-dispatch.v1',
      productVersion: '2.15.0',
      counts: {
        commands: 81,
        aliases: 23,
        targetCommands: 68,
        targetlessCommands: 13,
        applicationCommands: 50,
        legacyDaemonCommands: 18,
        daemonGroups: 27,
      },
      applicationCommands: [
        'back', 'call', 'cascade', 'checkpoint', 'click', 'clickxy', 'clock', 'components', 'controls', 'cookiedel', 'cookies', 'cookieset', 'dialog', 'dismiss-modal', 'emulate', 'eval', 'eval64', 'evalraw', 'export-playwright', 'fill', 'forward', 'frame', 'hover', 'html', 'jsclick', 'keepalive', 'mock', 'nav', 'net', 'netlog',
        'overlay', 'perceive', 'press', 'record-actions', 'reload', 'report', 'scroll', 'select', 'snap', 'status', 'styles', 'summary',
        'table', 'text', 'throttle', 'type', 'verify-click', 'viewport', 'wait', 'waitfor',
      ],
    });
    expect(fixture.targetless.map(command => command.name)).toEqual([
      'help', 'list', 'target', 'tab-group', 'broadcast', 'open', 'doctor',
      'spawn-debug-browser', 'attach', 'use', 'forget', 'current', 'stop',
    ]);
    expect(fixture.deletionAllowlist).toHaveLength(18);
    expect(fixture.deletionAllowlist.map(entry => entry.name)).not.toEqual(
      expect.arrayContaining([
        'back', 'call', 'cascade', 'checkpoint', 'click', 'clickxy', 'clock', 'components', 'controls', 'cookiedel', 'cookies', 'cookieset', 'dialog', 'dismiss-modal', 'emulate', 'eval', 'eval64', 'evalraw', 'export-playwright', 'fill', 'forward', 'frame', 'hover', 'html', 'jsclick', 'keepalive', 'mock', 'nav', 'net', 'netlog',
        'overlay', 'perceive', 'press', 'record-actions', 'reload', 'report', 'scroll', 'select', 'snap', 'status', 'styles', 'summary',
        'table', 'text', 'throttle', 'type', 'verify-click', 'viewport', 'wait', 'waitfor',
      ]),
    );
    expect(fixture.daemonGroups.filter(group => group.owner === 'daemon-protocol').map(group => group.labels))
      .toEqual([['meta'], ['list'], ['list_raw'], ['stop']]);
    expect(fixture.daemonGroups.filter(group => group.owner === 'unknown-command')).toHaveLength(1);
    expect(fixture.recursiveEdges.map(edge => edge.from).sort()).toEqual([
      'batch', 'flow', 'repeat', 'replay',
    ]);
    expect(fixture.mainBranches.flatMap(branch => branch.labels)).toEqual(expect.arrayContaining([
      '<no-command>', 'help', '--help', '-h', '_daemon', 'target', 'wait',
    ]));
    for (const group of fixture.daemonGroups.filter(group => group.commands.length === 1
      && group.owner !== 'daemon-protocol')) {
      const command = COMMAND_SURFACE.resolve(group.commands[0]);
      expect(group.policy).toEqual({
        kind: command.kind,
        authorization: command.authorization,
        evidencePolicy: command.evidencePolicy,
        outputFormats: [...command.outputFormats],
        needsTarget: command.needsTarget,
      });
    }
  });

  it('covers every target command once by canonical owner and every alias by the same branch', () => {
    const daemonGroups = fixture.daemonGroups.filter(group => group.commands.length === 1
      && group.owner !== 'daemon-protocol');
    const byCanonical = Object.groupBy(daemonGroups, group => group.commands[0]);
    const targetCommands = COMMAND_SURFACE.commands.filter(command => command.needsTarget);
    expect([...new Set([...Object.keys(byCanonical), ...fixture.applicationCommands])].sort())
      .toEqual(targetCommands.map(command => command.name).sort());
    for (const command of targetCommands) {
      if (!byCanonical[command.name]) {
        expect(fixture.applicationCommands).toContain(command.name);
        continue;
      }
      const labels = byCanonical[command.name].flatMap(group => group.labels);
      expect(labels, command.name).toEqual(expect.arrayContaining([command.name, ...command.aliases]));
    }
  });

  it('fails closed on an unknown route, duplicate route, missing route, or edited branch', () => {
    expect(() => buildRuntimeDispatchInventory(
      source.replace("case 'console': {", "case 'planted': {"),
    )).toThrow(/unknown route|missing daemon routes/);
    expect(() => buildRuntimeDispatchInventory(
      source.replace("case 'console': {", "case 'console': case 'console': {"),
    )).toThrow(/duplicate daemon route labels/);
    expect(() => buildRuntimeDispatchInventory(
      source.replace("case 'console': {", "case 'planted-console': {"),
    )).toThrow(/unknown route|spellings missing daemon routes/);
    const edited = buildRuntimeDispatchInventory(source.replace(
      "case 'console': {",
      "case 'console': { /* characterized edit */",
    ));
    expect(edited).not.toEqual(fixture);
    expect(() => buildRuntimeDispatchInventory(source.replace(
      "case 'meta': {",
      "case 'meta': case 'summary': {",
    ))).toThrow(/protocol route mixed/);
    expect(() => buildRuntimeDispatchInventory(source.replace(
      "if (cmd === '_daemon')",
      "if (cmd === 'planted-direct') return finish(0);\n  if (cmd === '_daemon')",
    ))).toThrow(/direct CLI routes/);
    expect(() => buildRuntimeDispatchInventory(source.replace(
      'run: (step) => handleCommand({ cmd: step.cmd, args: step.args || [] })',
      'run: (step) => globalThis.handleCommand({ cmd: step.cmd, args: step.args || [] })',
    ))).toThrow(/recursive daemon routes/);
    expect(() => buildRuntimeDispatchInventory(source.replace(
      'const route = await executePhase4DaemonRoute({',
      'const route = await fakeLegacyRoute({',
    ))).toThrow(/application ownership|general application dispatch/);
    expect(() => buildRuntimeDispatchInventory(source.replace(
      'const sub = await handleCommand({ cmd: c.cmd, args: autoActionJsonArgs(c.cmd, c.args || [], autoActionJson) });',
      "await handleCommand({ cmd: 'summary', args: [] });\n            const sub = await handleCommand({ cmd: c.cmd, args: autoActionJsonArgs(c.cmd, c.args || [], autoActionJson) });",
    ))).toThrow(/recursive daemon routes|handleCommand exactly 1 times/);
    expect(() => buildRuntimeDispatchInventory(source.replace(
      "case 'report': {\n          const route = await executePhase4DaemonRoute({",
      "case 'report': {\n          await executePhase4DaemonRoute({ cmd: 'report', args, targetBound: true }, phase4Context);\n          const route = await executePhase4DaemonRoute({",
    ))).toThrow(/application ownership/);
    expect(() => buildRuntimeDispatchInventory(source.replace(
      "'perceive', 'click', 'report', 'evalraw', 'html', 'text', 'table',",
      "'perceive', 'click', 'report', 'evalraw', 'html', 'text', 'planted',",
    ))).toThrow(/unknown commands/);
    expect(() => buildRuntimeDispatchInventory(source.replace(
      'const applicationRoute = phase4Context.route(cmd);',
      "await executePhase4DaemonRoute({ cmd: 'html', args, targetBound: true }, phase4Context);\n      const applicationRoute = phase4Context.route(cmd);",
    ))).toThrow(/exactly one general application dispatch/);
    for (const mutation of [
      source.replace(
        'html: capabilities => createDaemonReadHandlers(capabilities).html,',
        'html: capabilities => createDaemonReadHandlers(capabilities).text,',
      ),
      source.replace(
        'html: args => htmlStr(cdp, sessionId, args),',
        'html: args => textStr(cdp, sessionId, args),',
      ),
      source.replace(
        'html: args => htmlStr(cdp, sessionId, args),',
        'html: async args => { await htmlStr(cdp, sessionId, args); return htmlStr(cdp, sessionId, args); },',
      ),
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
        'eval: async args => commandResult(await callStr(cdp, sessionId, args.join(\' \')), null),\n    plantedEval: async args => {',
      ),
    ]) {
      expect(buildRuntimeDispatchInventory(mutation)).not.toEqual(fixture);
    }
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
      "const dismissModalBuilder = applicationPreflight.handlerBuilders['dismiss-modal'];",
      "if (true) { const dismissModalBuilder = applicationPreflight.handlerBuilders['verify-click']; }\n  const dismissModalBuilder = applicationPreflight.handlerBuilders['dismiss-modal'];",
    ))).toThrow(/direct runDaemon const|exactly once/);
    expect(() => buildRuntimeDispatchInventory(source.replace(
      "const verifyClickBuilder = applicationPreflight.handlerBuilders['verify-click'];",
      "if (true) { const verifyClickBuilder = applicationPreflight.handlerBuilders['dismiss-modal']; }\n  const verifyClickBuilder = applicationPreflight.handlerBuilders['verify-click'];",
    ))).toThrow(/direct runDaemon const|exactly once/);
    for (const mutation of [
      source.replace("cmd === '-h'", "cmd === '--planted-help'"),
      source.replace("if (cmd === '_daemon')", "if (cmd === '_planted-daemon')"),
      source.replace("if (cmd === 'target')", "if (cmd === '_planted-target')"),
      source.replace("if (cmd === 'wait' &&", "if (cmd === '_planted-wait' &&"),
      source.replace('async function handleCommand({ cmd, args }) {\n    resetIdle();', "async function handleCommand({ cmd, args }) {\n    resetIdle();\n    cmd = 'summary';"),
      source.replace("return { ok: true, result: result ?? '' };", "return { ok: true, result: 'planted' };"),
      source.replace('return finish(1);\n  }\n\n  // Canonicalize aliases', 'return finish(0);\n  }\n\n  // Canonicalize aliases'),
      source.replace('cmd = commandMeta(cmd)?.name || cmd;', 'cmd = cmd;'),
      source.replace('const response = await runtimeSupervisor.execute(runtimeHandle, { cmd, args: cmdArgs });', "const response = { ok: true, result: 'planted' };")
    ]) {
      try {
        expect(buildRuntimeDispatchInventory(mutation)).not.toEqual(fixture);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
      }
    }
    const markerCollision = source.replace(
      "return { ok: false, error: e.message || String(e) };\n    }\n  }",
      "return { ok: false, error: e.message || String(e) };\n    }\n    // default: return { ok: false, error: `Unknown command: ${cmd}` };\n  }",
    ).replace("return { ok: true, result: result ?? '' };", "return { ok: true, result: 'planted' };");
    expect(buildRuntimeDispatchInventory(markerCollision)).not.toEqual(fixture);
  }, 30_000);

  it('keeps check mode read-only and rejects stale fixture/source drift', () => {
    const result = spawnSync(process.execPath, [scriptPath, '--check'], {
      cwd: rootDir,
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Runtime dispatch OK: 81 commands, 27 daemon groups');
  });

  it('keeps the complete policy-class distribution visible before deletion', () => {
    expect(Object.fromEntries(Object.entries(Object.groupBy(
      COMMAND_SURFACE.commands,
      command => command.kind,
    )).map(([kind, commands]) => [kind, commands.length]))).toEqual({
      read: 24,
      'conditional-mutation': 7,
      mutation: 32,
      'protected-mutation': 7,
      script: 3,
      evidence: 1,
      'sensitive-read': 3,
      'raw-cdp': 1,
      composite: 3,
    });
  });
});
