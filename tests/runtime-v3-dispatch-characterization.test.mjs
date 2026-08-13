import { spawnSync } from 'child_process';
import { describe, expect, it } from 'vitest';

import { buildRuntimeDispatchInventory } from '../scripts/runtime-dispatch-inventory.mjs';
import { COMMAND_SURFACE } from '../skills/chrome-cdp-ex/scripts/lib/command-surface.mjs';
import {
  fixture,
  rootDir,
  scriptPath,
  source,
} from './runtime-v3-dispatch-test-helpers.mjs';

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
        applicationCommands: 68,
        legacyDaemonCommands: 0,
        daemonGroups: 5,
      },
      applicationCommands: [
        'back', 'batch', 'call', 'cascade', 'checkpoint', 'click', 'clickxy', 'clock', 'closetab', 'components', 'console', 'controls', 'cookiedel', 'cookies', 'cookieset', 'dialog', 'diff-shot', 'dismiss-modal', 'elshot', 'emulate', 'eval', 'eval64', 'evalraw', 'export-playwright', 'fill', 'flow', 'forward', 'frame', 'fullshot', 'hover', 'html', 'inject', 'jsclick', 'keepalive', 'loadall', 'mock', 'nav', 'net', 'netlog',
        'overlay', 'perceive', 'press', 'qa', 'record', 'record-actions', 'reload', 'repeat', 'replay', 'report', 'responsive-audit', 'restore', 'scanshot', 'scroll', 'select', 'shot', 'snap', 'status', 'styles', 'summary',
        'table', 'text', 'throttle', 'type', 'upload', 'verify-click', 'viewport', 'wait', 'waitfor',
      ],
    });
    expect(fixture.targetless.map(command => command.name)).toEqual([
      'help', 'list', 'target', 'tab-group', 'broadcast', 'open', 'doctor',
      'spawn-debug-browser', 'attach', 'use', 'forget', 'current', 'stop',
    ]);
    expect(fixture.deletionAllowlist).toHaveLength(0);
    expect(fixture.deletionAllowlist.map(entry => entry.name)).not.toEqual(
      expect.arrayContaining([
        'back', 'batch', 'call', 'cascade', 'checkpoint', 'click', 'clickxy', 'clock', 'components', 'console', 'controls', 'cookiedel', 'cookies', 'cookieset', 'dialog', 'dismiss-modal', 'emulate', 'eval', 'eval64', 'evalraw', 'export-playwright', 'fill', 'flow', 'forward', 'frame', 'hover', 'html', 'inject', 'jsclick', 'keepalive', 'mock', 'nav', 'net', 'netlog',
        'overlay', 'perceive', 'press', 'record', 'record-actions', 'reload', 'repeat', 'replay', 'report', 'restore', 'scroll', 'select', 'snap', 'status', 'styles', 'summary',
        'table', 'text', 'throttle', 'type', 'upload', 'verify-click', 'viewport', 'wait', 'waitfor',
        'diff-shot', 'elshot', 'fullshot', 'scanshot', 'shot',
        'qa', 'responsive-audit', 'closetab', 'loadall',
      ]),
    );
    expect(fixture.daemonGroups.filter(group => group.owner === 'daemon-protocol').map(group => group.labels))
      .toEqual([['meta'], ['list'], ['list_raw'], ['stop']]);
    expect(fixture.daemonGroups.filter(group => group.owner === 'unknown-command')).toHaveLength(1);
    expect(fixture.daemonGroups.map(group => group.labels)).toEqual([
      ['meta'], ['list'], ['list_raw'], ['stop'], ['<default>'],
    ]);
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
  }, 15_000);

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

  it('fails closed on route and execution cardinality drift', () => {
    expect(buildRuntimeDispatchInventory(source.replace(
      'if (!sameStringArray(builderNames, expectedNames)) {',
      'if (false && !sameStringArray(builderNames, expectedNames)) {',
    ))).not.toEqual(fixture);
    expect(() => buildRuntimeDispatchInventory(source.replace(
      "case 'meta': {",
      "case 'meta': case 'summary': {",
    ))).toThrow(/protocol route mixed/);
    expect(() => buildRuntimeDispatchInventory(source.replace(
      "if (cmd === '_daemon')",
      "if (cmd === 'planted-direct') return finish(0);\n  if (cmd === '_daemon')",
    ))).toThrow(/direct CLI routes/);
    expect(() => buildRuntimeDispatchInventory(source.replace(
      'run: step => handleCommand({ cmd: step.cmd, args: step.args || [] })',
      'run: step => globalThis.handleCommand({ cmd: step.cmd, args: step.args || [] })',
    ))).toThrow(/recursive daemon routes|workflow capability repeat/);
    expect(() => buildRuntimeDispatchInventory(source.replace(
      'const route = await executeDaemonApplicationRoute({',
      'const route = await fakeLegacyRoute({',
    ))).toThrow(/application ownership|general application dispatch/);
    expect(() => buildRuntimeDispatchInventory(source.replace(
      'const runOne = command => handleCommand({',
      "await handleCommand({ cmd: 'summary', args: [] });\n      const runOne = command => handleCommand({",
    ))).toThrow(/workflow capability batch must call handleCommand exactly once/);
    try {
      expect(buildRuntimeDispatchInventory(source.replace(
        "case 'stop': return { ok: true, result: '', stopAfter: true };",
        "case 'report': {\n          const route = await executeDaemonApplicationRoute({ cmd: 'report', args, targetBound: Boolean(targetId) }, applicationDispatcher);\n          result = route.result;\n          break;\n        }\n        case 'stop': return { ok: true, result: '', stopAfter: true };",
      ))).not.toEqual(fixture);
    } catch (error) {
      expect(error.message).toMatch(/duplicate daemon route labels: report/);
    }
    expect(() => buildRuntimeDispatchInventory(source.replace(
      'loadall: capabilities => createDaemonActionHandlers(capabilities).loadall,',
      'planted: capabilities => createDaemonActionHandlers(capabilities).loadall,',
    ))).toThrow(/exactly cover.*68 target commands/);
    expect(() => buildRuntimeDispatchInventory(source.replace(
      'const applicationRoute = applicationDispatcher.route(cmd);',
      "await executeDaemonApplicationRoute({ cmd: 'html', args, targetBound: true }, applicationDispatcher);\n      const applicationRoute = applicationDispatcher.route(cmd);",
    ))).toThrow(/exactly one general application dispatch/);
  }, 45_000);

  it('keeps check mode read-only and rejects stale fixture/source drift', () => {
    const result = spawnSync(process.execPath, [scriptPath, '--check'], {
      cwd: rootDir,
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Runtime dispatch OK: 81 commands, 5 daemon groups');
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
