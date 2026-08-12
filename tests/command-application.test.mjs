import { describe, expect, it, vi } from 'vitest';

import {
  classifyRawCdpMethod,
  commandResult,
  createCommandRegistry,
  defineCommandSpec,
  executeCommand,
} from '../skills/chrome-cdp-ex/scripts/lib/command-application.mjs';
import { createCommandDispatcher } from '../skills/chrome-cdp-ex/scripts/lib/command-dispatch.mjs';
import { createDaemonActionHandlers } from '../skills/chrome-cdp-ex/scripts/lib/daemon-action-handlers.mjs';
import { createDaemonReadHandlers } from '../skills/chrome-cdp-ex/scripts/lib/daemon-read-handlers.mjs';
import { __test__ as cdpTest } from '../skills/chrome-cdp-ex/scripts/cdp.mjs';

const ACTION_COMMANDS = Object.freeze([
  'back', 'clickxy', 'clock', 'dismiss-modal', 'fill', 'forward', 'hover', 'jsclick',
  'mock', 'nav', 'press', 'reload', 'scroll', 'select', 'throttle', 'type', 'verify-click',
]);

function spec(overrides = {}) {
  return {
    name: 'perceive',
    aliases: [],
    needsTarget: true,
    mutates: false,
    feedbackPolicy: null,
    outputFormats: ['text', 'json'],
    kind: 'read',
    authorization: 'standard',
    evidencePolicy: 'none',
    ...overrides,
  };
}

function mutationSpec(overrides = {}) {
  return spec({
    name: 'click',
    mutates: true,
    feedbackPolicy: 'settle-diff',
    kind: 'mutation',
    authorization: 'mutation',
    evidencePolicy: 'action-receipt',
    ...overrides,
  });
}

function rawSpec(overrides = {}) {
  return spec({
    name: 'evalraw',
    kind: 'raw-cdp',
    authorization: 'raw-cdp',
    evidencePolicy: 'raw-audit',
    outputFormats: ['text'],
    ...overrides,
  });
}

describe('Phase 4 command specifications', () => {
  it('returns an immutable canonical copy including nested arrays', () => {
    const input = spec({ aliases: ['see'], outputFormats: ['json', 'text'] });
    const actual = defineCommandSpec(input);

    expect(actual).toEqual({ ...input, aliases: ['see'], outputFormats: ['json', 'text'] });
    expect(actual).not.toBe(input);
    expect(Object.isFrozen(actual)).toBe(true);
    expect(Object.isFrozen(actual.aliases)).toBe(true);
    expect(Object.isFrozen(actual.outputFormats)).toBe(true);
    expect(() => actual.aliases.push('other')).toThrow();
  });

  it.each([
    ['extra key', { surprise: true }, 'surprise'],
    ['invalid name', { name: 'Bad Name' }, 'name'],
    ['duplicate alias', { aliases: ['see', 'see'] }, 'aliases'],
    ['canonical alias', { aliases: ['perceive'] }, 'aliases'],
    ['invalid target flag', { needsTarget: 'yes' }, 'needsTarget'],
    ['invalid mutation flag', { mutates: 1 }, 'mutates'],
    ['invalid feedback', { feedbackPolicy: '' }, 'feedbackPolicy'],
    ['duplicate format', { outputFormats: ['text', 'text'] }, 'outputFormats'],
    ['unknown kind', { kind: 'write' }, 'kind'],
    ['unknown authorization', { authorization: 'allow' }, 'authorization'],
    ['unknown evidence', { evidencePolicy: 'full' }, 'evidencePolicy'],
    ['read mutates', { mutates: true }, 'mutates'],
    ['read authorization drift', { authorization: 'mutation' }, 'authorization'],
    ['read evidence drift', { evidencePolicy: 'action-receipt' }, 'evidencePolicy'],
    ['mutation flag drift', { ...mutationSpec(), mutates: false }, 'mutates'],
    ['mutation feedback missing', { ...mutationSpec(), feedbackPolicy: null }, 'feedbackPolicy'],
    ['evidence policy drift', {
      name: 'report', kind: 'evidence', authorization: 'standard', evidencePolicy: 'none',
    }, 'evidencePolicy'],
    ['raw authorization drift', { ...rawSpec(), authorization: 'standard' }, 'authorization'],
    ['raw evidence drift', { ...rawSpec(), evidencePolicy: 'none' }, 'evidencePolicy'],
  ])('rejects %s', (_label, overrides, path) => {
    const input = overrides.name === 'report'
      ? spec({ name: 'report', ...overrides })
      : overrides.kind === 'mutation' || overrides.name === 'click'
        ? { ...mutationSpec(), ...overrides }
        : overrides.kind === 'raw-cdp' || overrides.name === 'evalraw'
          ? { ...rawSpec(), ...overrides }
          : spec(overrides);
    expect(() => defineCommandSpec(input)).toThrow(path);
  });

  it('creates deterministic canonical and alias lookup without collisions', () => {
    const registry = createCommandRegistry([
      mutationSpec({ aliases: ['tap'] }),
      spec({ aliases: ['see'] }),
    ]);

    expect(registry.list().map(entry => entry.name)).toEqual(['click', 'perceive']);
    expect(registry.resolve('tap')).toBe(registry.resolve('click'));
    expect(registry.resolve('see')?.name).toBe('perceive');
    expect(registry.resolve('missing')).toBe(null);
    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.list())).toBe(true);
  });

  it('rejects accessor-backed and symbol-keyed specifications', () => {
    let reads = 0;
    const accessor = spec();
    Object.defineProperty(accessor, 'kind', {
      enumerable: true,
      get() {
        reads += 1;
        return reads === 1 ? 'read' : 'raw-cdp';
      },
    });
    expect(() => defineCommandSpec(accessor)).toThrow(/accessor|data propert/i);

    const symbol = spec();
    symbol[Symbol('authorization')] = 'raw-cdp';
    expect(() => defineCommandSpec(symbol)).toThrow(/symbol|not allowed/i);
  });

  it.each([
    [[spec(), spec()], 'duplicate command'],
    [[spec({ aliases: ['click'] }), mutationSpec()], 'collision'],
    [[spec({ aliases: ['shared'] }), mutationSpec({ aliases: ['shared'] })], 'collision'],
  ])('rejects registry name and alias collisions', (specs, message) => {
    expect(() => createCommandRegistry(specs)).toThrow(message);
  });
});

describe('Phase 4 specs derived from the public command owner', () => {
  it('derives all 81 deterministic specs with byte-equivalent public metadata', () => {
    const specs = cdpTest.buildPhase4CommandSpecs(cdpTest.COMMANDS);
    expect(specs).toHaveLength(81);
    expect(specs.map(entry => entry.name)).toEqual(
      cdpTest.COMMANDS.map(entry => entry.name).sort(),
    );
    expect(Object.isFrozen(specs)).toBe(true);

    for (const entry of specs) {
      const publicCommand = cdpTest.COMMANDS.find(command => command.name === entry.name);
      expect({
        name: entry.name,
        aliases: entry.aliases,
        needsTarget: entry.needsTarget,
        mutates: entry.mutates,
        feedbackPolicy: entry.feedbackPolicy,
        outputFormats: entry.outputFormats,
      }).toEqual({
        name: publicCommand.name,
        aliases: publicCommand.aliases,
        needsTarget: publicCommand.needsTarget,
        mutates: publicCommand.mutates,
        feedbackPolicy: publicCommand.feedbackPolicy ?? null,
        outputFormats: publicCommand.outputFormats,
      });
    }

    const registry = cdpTest.createPhase4CommandRegistry(cdpTest.COMMANDS);
    expect(registry.list()).toEqual(specs);
    expect(registry.resolve('report')?.kind).toBe('evidence');
    expect(registry.resolve('evalraw')?.authorization).toBe('raw-cdp');
    expect(registry.resolve('navigate')?.name).toBe('nav');
    expect(registry.resolve('open')?.authorization).toBe('mutation');
    expect(JSON.stringify(registry.list())).not.toMatch(/targetId|sessionId|webSocket|handle/i);
  });

  it.each([
    ['name', commands => { commands.find(item => item.name === 'perceive').name = 'perceive-v2'; }, 'unknown command perceive-v2'],
    ['target need', commands => { commands.find(item => item.name === 'perceive').needsTarget = false; }, 'perceive.needsTarget'],
    ['mutation flag', commands => { commands.find(item => item.name === 'click').mutates = false; }, 'click.mutates'],
    ['feedback policy', commands => { commands.find(item => item.name === 'click').feedbackPolicy = 'report-only'; }, 'click.feedbackPolicy'],
    ['alias', commands => { commands.find(item => item.name === 'report').aliases = ['session-report']; }, 'report.aliases'],
    ['output format', commands => { commands.find(item => item.name === 'evalraw').outputFormats = ['text', 'json']; }, 'evalraw.outputFormats'],
  ])('rejects %s drift from COMMANDS authority', (_label, mutate, message) => {
    const commands = structuredClone(cdpTest.COMMANDS);
    mutate(commands);
    expect(() => cdpTest.buildPhase4CommandSpecs(commands)).toThrow(message);
  });

  it('rejects a missing or duplicate slice command', () => {
    const missing = structuredClone(cdpTest.COMMANDS).filter(item => item.name !== 'report');
    expect(() => cdpTest.buildPhase4CommandSpecs(missing)).toThrow(/exactly 81/);
    const duplicate = structuredClone(cdpTest.COMMANDS);
    duplicate[0] = structuredClone(duplicate.find(item => item.name === 'report'));
    expect(() => cdpTest.buildPhase4CommandSpecs(duplicate)).toThrow('help.name');
  });

  it('rejects extra records, extra fields, custom arrays, and oversized projections before registry creation', () => {
    const planted = structuredClone(cdpTest.COMMANDS);
    planted.push({ ...structuredClone(planted[0]), name: 'planted', aliases: [] });
    expect(() => cdpTest.buildPhase4CommandSpecs(planted)).toThrow(/81-item array limit|exactly 81/);

    const extraField = structuredClone(cdpTest.COMMANDS);
    extraField[0].planted = true;
    expect(() => cdpTest.buildPhase4CommandSpecs(extraField)).toThrow(/planted.*not allowed/);

    const customPrototype = structuredClone(cdpTest.COMMANDS);
    Object.setPrototypeOf(customPrototype, Object.create(Array.prototype));
    expect(() => cdpTest.buildPhase4CommandSpecs(customPrototype)).toThrow(/plain array/);

    const oversized = Array.from({ length: 100000 }, () => cdpTest.COMMANDS[0]);
    expect(() => cdpTest.buildPhase4CommandSpecs(oversized)).toThrow(/81-item array limit/);

    for (const value of [null, undefined]) {
      const optionalExtra = structuredClone(cdpTest.COMMANDS);
      optionalExtra.find(command => command.name === 'help').feedbackPolicy = value;
      expect(() => cdpTest.buildPhase4CommandSpecs(optionalExtra)).toThrow(/help\.feedbackPolicy.*not allowed/);
    }

    const nonEnumerable = structuredClone(cdpTest.COMMANDS);
    const help = nonEnumerable.find(command => command.name === 'help');
    Object.defineProperty(help, 'name', { value: 'help', enumerable: false });
    expect(() => cdpTest.buildPhase4CommandSpecs(nonEnumerable)).toThrow(/name.*enumerable/);
  });

  it('rejects accessor, symbol, and prototype-backed command candidates before comparison', () => {
    const accessor = structuredClone(cdpTest.COMMANDS);
    const perceive = accessor.find(item => item.name === 'perceive');
    let reads = 0;
    Object.defineProperty(perceive, 'needsTarget', {
      enumerable: true,
      get() {
        reads += 1;
        return reads === 1;
      },
    });
    expect(() => cdpTest.buildPhase4CommandSpecs(accessor)).toThrow(/accessor|data propert/i);

    const symbol = structuredClone(cdpTest.COMMANDS);
    symbol.find(item => item.name === 'report')[Symbol('aliases')] = ['bypass'];
    expect(() => cdpTest.buildPhase4CommandSpecs(symbol)).toThrow(/symbol|not allowed/i);

    const inherited = structuredClone(cdpTest.COMMANDS);
    const index = inherited.findIndex(item => item.name === 'evalraw');
    inherited[index] = Object.assign(Object.create({ mutates: true }), inherited[index]);
    expect(() => cdpTest.buildPhase4CommandSpecs(inherited)).toThrow(/plain data object|prototype/i);
  });
});

describe('Phase 4 command results and execution', () => {
  it('preserves exact legacy bytes and freezes bounded evidence', () => {
    const result = commandResult('{"ok":true}\n', { kind: 'session-report' });
    expect(result.value).toBe('{"ok":true}\n');
    expect(result.evidence).toEqual({ kind: 'session-report' });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.evidence)).toBe(true);
  });

  it('rejects accessor-backed or symbol-keyed evidence', () => {
    const accessor = { kind: 'raw-audit', sideEffectClass: 'read-only' };
    Object.defineProperty(accessor, 'method', {
      enumerable: true,
      get() {
        return Math.random() > -1 ? 'Runtime.evaluate' : 'DOM.getDocument';
      },
    });
    expect(() => commandResult('ok', accessor)).toThrow(/accessor|data propert/i);

    const symbol = {
      kind: 'raw-audit',
      method: 'DOM.getDocument',
      sideEffectClass: 'read-only',
      [Symbol('params')]: { token: 'planted-secret' },
    };
    expect(() => commandResult('ok', symbol)).toThrow(/symbol|not allowed/i);
  });

  it.each([
    [42, null, 'value'],
    ['ok', [], 'evidence'],
    ['ok', { kind: 'unknown' }, 'evidence.kind'],
    ['ok', { kind: 'raw-audit', method: 'Runtime.evaluate', sideEffectClass: 'read-only', params: '{}' }, 'params'],
    ['ok', { kind: 'raw-audit', method: `Runtime.${'x'.repeat(300)}`, sideEffectClass: 'read-only' }, 'method'],
    ['ok', { kind: 'raw-audit', method: 'Runtime.evaluate', sideEffectClass: 'mutation', token: 'secret' }, 'token'],
  ])('rejects invalid result or evidence %#', (value, evidence, message) => {
    expect(() => commandResult(value, evidence)).toThrow(message);
  });

  it('executes a read handler through an alias and preserves the exact result', async () => {
    const registry = createCommandRegistry([spec({ aliases: ['see'] })]);
    const handler = vi.fn(async ({ args, spec: resolved }) => {
      expect(args).toEqual(['--format', 'json']);
      expect(Object.isFrozen(args)).toBe(true);
      expect(resolved.name).toBe('perceive');
      return commandResult('  exact output\n', null);
    });

    const execution = await executeCommand({ name: 'see', args: ['--format', 'json'], targetBound: true }, {
      registry,
      handlers: { perceive: handler },
    });

    expect(handler).toHaveBeenCalledOnce();
    expect(execution).toEqual({
      schema: 'chrome-cdp-ex.command-execution.v1',
      command: 'perceive',
      kind: 'read',
      value: '  exact output\n',
      authorization: { policy: 'standard', allowed: true, code: 'not-required' },
      evidence: null,
    });
    expect(Object.isFrozen(execution)).toBe(true);
    expect(Object.isFrozen(execution.authorization)).toBe(true);
  });

  it('requires a target and registered handler before invocation', async () => {
    const registry = createCommandRegistry([spec()]);
    await expect(executeCommand({ name: 'perceive', args: [], targetBound: false }, {
      registry,
      handlers: { perceive: vi.fn() },
    })).rejects.toThrow('target');
    await expect(executeCommand({ name: 'perceive', args: [], targetBound: true }, {
      registry,
      handlers: {},
    })).rejects.toThrow('handler');
    await expect(executeCommand({ name: 'missing', args: [], targetBound: true }, {
      registry,
      handlers: {},
    })).rejects.toThrow('unknown command');
  });

  it('rejects unbranded registries and inherited or accessor handlers', async () => {
    const request = { name: 'perceive', args: [], targetBound: true };
    const fakeRegistry = {
      resolve: () => mutationSpec({ authorization: 'standard', evidencePolicy: 'none', mutates: false }),
    };
    await expect(executeCommand(request, {
      registry: fakeRegistry,
      handlers: { perceive: async () => commandResult('bypass', null) },
    })).rejects.toThrow(/registry.*factory|registry.*brand/i);

    const registry = createCommandRegistry([spec()]);
    const inherited = Object.create({ perceive: async () => commandResult('inherited', null) });
    await expect(executeCommand(request, { registry, handlers: inherited })).rejects.toThrow(/own|handler/i);

    let getterInvoked = false;
    const accessor = {};
    Object.defineProperty(accessor, 'perceive', {
      enumerable: true,
      get() {
        getterInvoked = true;
        return async () => commandResult('getter', null);
      },
    });
    await expect(executeCommand(request, { registry, handlers: accessor })).rejects.toThrow(/data property|handler/i);
    expect(getterInvoked).toBe(false);

    const constructorRegistry = createCommandRegistry([spec({ name: 'constructor' })]);
    await expect(executeCommand({ name: 'constructor', args: [], targetBound: true }, {
      registry: constructorRegistry,
      handlers: {},
    })).rejects.toThrow(/own|handler/i);

    const polluted = Object.create(null);
    Object.defineProperty(polluted, '__proto__', {
      enumerable: true,
      value: { perceive: async () => commandResult('polluted', null) },
    });
    await expect(executeCommand(request, { registry, handlers: polluted })).rejects.toThrow(/own|handler/i);
  });

  it('rejects accessor-backed requests and authorization decisions', async () => {
    const registry = createCommandRegistry([mutationSpec()]);
    const request = { name: 'click', args: [], targetBound: true };
    Object.defineProperty(request, 'targetBound', {
      enumerable: true,
      get() { return true; },
    });
    await expect(executeCommand(request, {
      registry,
      handlers: { click: async () => commandResult('clicked', { kind: 'action-receipt' }) },
      authorize: () => ({ allowed: true, code: 'legacy-daemon' }),
    })).rejects.toThrow(/accessor|data propert/i);

    const decision = { code: 'legacy-daemon' };
    Object.defineProperty(decision, 'allowed', {
      enumerable: true,
      get() { return true; },
    });
    await expect(executeCommand({ name: 'click', args: [], targetBound: true }, {
      registry,
      handlers: { click: async () => commandResult('clicked', { kind: 'action-receipt' }) },
      authorize: () => decision,
    })).rejects.toThrow(/accessor|data propert/i);
  });

  it('requires positive mutation authorization and never invokes on denial', async () => {
    const registry = createCommandRegistry([mutationSpec()]);
    const handler = vi.fn(async () => commandResult('clicked', { kind: 'action-receipt' }));

    await expect(executeCommand({ name: 'click', args: ['@1'], targetBound: true }, {
      registry,
      handlers: { click: handler },
    })).rejects.toThrow('authorizer');
    await expect(executeCommand({ name: 'click', args: ['@1'], targetBound: true }, {
      registry,
      handlers: { click: handler },
      authorize: () => ({ allowed: false, code: 'policy-denied' }),
    })).rejects.toThrow('authorization denied');
    expect(handler).not.toHaveBeenCalled();

    const execution = await executeCommand({ name: 'click', args: ['@1'], targetBound: true }, {
      registry,
      handlers: { click: handler },
      authorize: decision => {
        expect(decision).toEqual({ command: 'click', policy: 'mutation', mutates: true, targetBound: true });
        return { allowed: true, code: 'legacy-daemon' };
      },
    });
    expect(execution.authorization).toEqual({ policy: 'mutation', allowed: true, code: 'legacy-daemon' });
    expect(handler).toHaveBeenCalledOnce();
  });

  it('emits raw audit metadata without params, expression, target, or private handles', async () => {
    const registry = createCommandRegistry([rawSpec()]);
    const secret = 'Bearer planted-secret';
    const execution = await executeCommand({
      name: 'evalraw',
      args: ['Runtime.evaluate', JSON.stringify({ expression: secret })],
      targetBound: true,
    }, {
      registry,
      handlers: {
        evalraw: async () => commandResult('result\n', {
          kind: 'raw-audit',
          method: 'Runtime.evaluate',
          sideEffectClass: 'potentially-mutating',
        }),
      },
      authorize: () => ({ allowed: true, code: 'legacy-daemon' }),
    });

    expect(execution.evidence).toEqual({
      kind: 'raw-audit',
      method: 'Runtime.evaluate',
      sideEffectClass: 'potentially-mutating',
    });
    const serialized = JSON.stringify(execution);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('expression');
    expect(serialized).not.toContain('target');
    expect(serialized).not.toContain('session');
  });

  it('binds raw audit method and side-effect class to the actual request', async () => {
    expect(classifyRawCdpMethod('DOM.getDocument')).toBe('read-only');
    expect(classifyRawCdpMethod('Runtime.evaluate')).toBe('potentially-mutating');
    expect(classifyRawCdpMethod('Experimental.mystery')).toBe('unknown');
    expect(classifyRawCdpMethod('Page.requestAppBanner')).toBe('unknown');
    expect(classifyRawCdpMethod('Experimental.getAndDeleteEverything')).toBe('unknown');

    const registry = createCommandRegistry([rawSpec()]);
    const run = evidence => executeCommand({
      name: 'evalraw',
      args: ['Runtime.evaluate', '{"expression":"document.body.remove()"}'],
      targetBound: true,
    }, {
      registry,
      handlers: { evalraw: async () => commandResult('result', evidence) },
      authorize: () => ({ allowed: true, code: 'legacy-daemon' }),
    });
    await expect(run({
      kind: 'raw-audit', method: 'DOM.getDocument', sideEffectClass: 'read-only',
    })).rejects.toThrow(/method.*request|audit.*method/i);
    await expect(run({
      kind: 'raw-audit', method: 'Runtime.evaluate', sideEffectClass: 'read-only',
    })).rejects.toThrow(/side-effect|sideEffectClass/i);
  });

  it('rejects invalid handler results and mismatched evidence policies', async () => {
    const registry = createCommandRegistry([spec(), mutationSpec()]);
    await expect(executeCommand({ name: 'perceive', args: [], targetBound: true }, {
      registry,
      handlers: { perceive: async () => 'plain string' },
    })).rejects.toThrow('command result');
    await expect(executeCommand({ name: 'click', args: [], targetBound: true }, {
      registry,
      handlers: { click: async () => commandResult('clicked', null) },
      authorize: () => ({ allowed: true, code: 'legacy-daemon' }),
    })).rejects.toThrow('evidence');
  });

  it('rethrows the exact handler error object', async () => {
    const registry = createCommandRegistry([spec()]);
    const original = new Error('original daemon failure');
    let observed;
    try {
      await executeCommand({ name: 'perceive', args: [], targetBound: true }, {
        registry,
        handlers: { perceive: async () => { throw original; } },
      });
    } catch (error) {
      observed = error;
    }
    expect(observed).toBe(original);
  });
});

describe('Phase 4 report compatibility slice', () => {
  function reportSession() {
    const session = cdpTest.createSessionState({ targetId: 'ABC12345', sessionId: 'session-private' });
    cdpTest.initializeSessionLog(session);
    return session;
  }

  it.each([
    ['default text', [], { format: 'text', lastActions: 20, compact: false, qa: false }],
    ['json', ['--format', 'json'], { format: 'json', lastActions: 20, compact: false, qa: false }],
    ['bounded compact', ['--last', '1', '--compact'], { format: 'text', lastActions: 1, compact: true, qa: false }],
    ['qa json', ['--qa', '--format', 'json'], { format: 'json', lastActions: 20, compact: false, qa: true }],
  ])('preserves %s report bytes through the application facade', async (_label, args, options) => {
    const session = reportSession();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(session.createdAt + 1234);
    try {
      const expected = cdpTest.formatSessionReport(session, options);
      const registry = cdpTest.createPhase4CommandRegistry(cdpTest.COMMANDS);
      const handler = cdpTest.createPhase4ReportHandler(session);
      const actual = await cdpTest.executePhase4CompatibilityCommand({
        name: 'report', args, targetBound: true,
      }, {
        registry,
        handlers: { report: handler },
      });
      expect(actual).toBe(expected);
    } finally {
      clock.mockRestore();
    }
  });

  it('preserves the established report unknown-argument failure', async () => {
    const registry = cdpTest.createPhase4CommandRegistry(cdpTest.COMMANDS);
    await expect(cdpTest.executePhase4CompatibilityCommand({
      name: 'report', args: ['--unknown'], targetBound: true,
    }, {
      registry,
      handlers: { report: cdpTest.createPhase4ReportHandler(reportSession()) },
    })).rejects.toThrow('report: unknown argument --unknown');
  });

  it('invokes exactly one report handler and exposes only its legacy value', async () => {
    const registry = cdpTest.createPhase4CommandRegistry(cdpTest.COMMANDS);
    const handler = vi.fn(async () => commandResult('legacy report\n', { kind: 'session-report' }));
    const actual = await cdpTest.executePhase4CompatibilityCommand({
      name: 'report', args: [], targetBound: true,
    }, { registry, handlers: { report: handler } });
    expect(handler).toHaveBeenCalledOnce();
    expect(actual).toBe('legacy report\n');
    expect(actual).not.toContain('command-execution');
  });
});

describe('Phase 4 perceive compatibility slice', () => {
  function fixture(overrides = {}) {
    const ops = {
      pageInfoModel: vi.fn(async () => ({ title: 'Fixture', url: 'https://fixture.test/' })),
      collectPageHealth: vi.fn(async () => ({ status: 'healthy' })),
      perceiveText: vi.fn(async () => 'line one\nline two'),
      perceiveModel: vi.fn(async () => ({ schema: 'chrome-cdp-ex.perceive.v1', page: { title: 'Fixture' } })),
      perceiveDiffModel: vi.fn(async () => ({ schema: 'chrome-cdp-ex.perceive-diff.v1', changed: true })),
      ...overrides.ops,
    };
    const inputs = {
      cdp: { send: vi.fn() },
      sessionId: 'session-1',
      targetId: 'ABC12345FULL',
      session: { lastAction: { baselineOutput: 'before' } },
      consoleBuf: { all: () => [{ level: 'error' }, { level: 'warn' }] },
      exceptionBuf: { all: () => [{}] },
      netReqBuf: { all: () => [] },
      refMap: new Map(),
      lastPerceiveStore: { value: null },
      refState: { generation: 2 },
      ops,
      ...overrides,
    };
    return { handler: cdpTest.createPhase4PerceiveHandler(inputs), inputs, ops };
  }

  it('preserves text output, max-line truncation, and reference state wiring', async () => {
    const { handler, inputs, ops } = fixture();
    const actual = await handler({ args: ['--max-diff-lines', '1'] });
    expect(actual.value).toBe(cdpTest.truncateTextLines('line one\nline two', 1));
    expect(actual.evidence).toBe(null);
    expect(ops.perceiveText).toHaveBeenCalledOnce();
    const call = ops.perceiveText.mock.calls[0];
    expect(call[6]).toMatchObject({ targetPrefix: 'ABC12345' });
    expect(call[7]).toBe(inputs.refState);
  });

  it('preserves default JSON and since-action diff JSON bytes', async () => {
    const normal = fixture();
    const normalResult = await normal.handler({ args: ['--format', 'json'] });
    expect(normalResult.value).toBe(cdpTest.formatPerceptionJson({
      schema: 'chrome-cdp-ex.perceive.v1', page: { title: 'Fixture' },
    }));

    const diff = fixture();
    const diffResult = await diff.handler({ args: ['--since-action', '--format', 'json'] });
    expect(diffResult.value).toBe(cdpTest.formatJson({
      schema: 'chrome-cdp-ex.perceive-diff.v1', changed: true,
    }));
    expect(diff.ops.perceiveDiffModel.mock.calls[0][6]).toMatchObject({
      sinceAction: true,
      diffBaseline: 'before',
      targetPrefix: 'ABC12345',
    });
  });

  it('preserves QA JSON summary inputs and bounded perception preview', async () => {
    const { handler } = fixture();
    const actual = JSON.parse((await handler({
      args: ['--qa', '--format', 'json', '--max-diff-lines', '1'],
    })).value);
    expect(actual.summary).toMatchObject({ source: 'perceive' });
    expect(actual.summary.page).toMatchObject({ title: 'Fixture', url: 'https://fixture.test/' });
    expect(actual.perceptionPreview).toBe(cdpTest.truncateTextLines('line one\nline two', 1));
  });

  it('rethrows the exact implementation error outside QA mode', async () => {
    const failure = new Error('perceive implementation failed');
    const { handler } = fixture({ ops: { perceiveText: vi.fn(async () => { throw failure; }) } });
    await expect(handler({ args: [] })).rejects.toBe(failure);
  });
});

describe('Phase 4 click compatibility slice', () => {
  it.each([
    ['normal', ['@7', '--format', 'json', '--compact'], '@7', false],
    ['javascript fallback', ['--js', '#save', '--format', 'json'], '#save', true],
  ])('preserves %s routing and legacy value', async (_label, args, selector, javascriptFallback) => {
    const click = vi.fn(async value => `normal:${value}`);
    const jsClick = vi.fn(async value => `js:${value}`);
    const actionFeedback = vi.fn(async (action, dispatch, target, policy, observe, format) => {
      expect(action).toBe('click');
      expect(target).toEqual({
        input: selector,
        resolvedBy: 'selector-or-ref',
        label: selector,
        commandArgs: javascriptFallback ? ['--js', selector] : [selector],
      });
      expect(policy).toBe('settle-diff');
      expect(observe).toBe(null);
      expect(format).toMatchObject({ format: 'json', compact: !javascriptFallback });
      return dispatch();
    });
    const registry = cdpTest.createPhase4CommandRegistry(cdpTest.COMMANDS);
    const handler = cdpTest.createPhase4ClickHandler({ actionFeedback, click, jsClick });
    const actual = await cdpTest.executePhase4CompatibilityCommand({
      name: 'click', args, targetBound: true,
    }, {
      registry,
      handlers: { click: handler },
      authorize: cdpTest.authorizePhase4DaemonCommand,
    });

    expect(actual).toBe(`${javascriptFallback ? 'js' : 'normal'}:${selector}`);
    expect(actionFeedback).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledTimes(javascriptFallback ? 0 : 1);
    expect(jsClick).toHaveBeenCalledTimes(javascriptFallback ? 1 : 0);
  });

  it('fails closed when the compatibility authorizer lacks a bound target', async () => {
    expect(cdpTest.authorizePhase4DaemonCommand({
      command: 'click', policy: 'mutation', mutates: true, targetBound: false,
    })).toEqual({ allowed: false, code: 'target-not-bound' });
    expect(cdpTest.authorizePhase4DaemonCommand({
      command: 'perceive', policy: 'mutation', mutates: true, targetBound: true,
    })).toEqual({ allowed: false, code: 'policy-denied' });
  });
});

describe('Phase 4 daemon dispatch seam', () => {
  function routeFixture() {
    const registry = cdpTest.createPhase4CommandRegistry(cdpTest.COMMANDS);
    const handlers = {
      perceive: vi.fn(async () => commandResult('perceive-value', null)),
      report: vi.fn(async () => commandResult('report-value', { kind: 'session-report' })),
      click: vi.fn(async () => commandResult('click-value', { kind: 'action-receipt' })),
      evalraw: vi.fn(async ({ args }) => commandResult('evalraw-value', {
        kind: 'raw-audit',
        method: args[0],
        sideEffectClass: classifyRawCdpMethod(args[0]),
      })),
    };
    const owners = Object.fromEntries(registry.list().map(command => [
      command.name,
      Object.hasOwn(handlers, command.name) ? 'application' : 'legacy',
    ]));
    return { registry, handlers, owners };
  }

  it('preflights the complete registry and exact migrated handler ownership without invoking factories', () => {
    const builders = Object.fromEntries(
      cdpTest.MIGRATED_DAEMON_COMMANDS.map(name => [name, vi.fn()]),
    );
    const preflight = cdpTest.preflightDaemonApplication({
      commands: cdpTest.COMMANDS,
      handlerBuilders: builders,
    });
    expect(preflight.registry.list()).toHaveLength(81);
    expect(Object.keys(preflight.routeOwners)).toHaveLength(81);
    expect(Object.values(preflight.routeOwners).filter(owner => owner === 'application')).toHaveLength(40);
    expect(Object.values(preflight.routeOwners).filter(owner => owner === 'legacy')).toHaveLength(41);
    expect(Object.isFrozen(preflight)).toBe(true);
    expect(Object.isFrozen(preflight.handlerBuilders)).toBe(true);
    expect(Object.values(builders).every(builder => builder.mock.calls.length === 0)).toBe(true);

    const missing = { ...builders };
    delete missing.report;
    expect(() => cdpTest.preflightDaemonApplication({ commands: cdpTest.COMMANDS, handlerBuilders: missing }))
      .toThrow(/exactly own/);
    expect(() => cdpTest.preflightDaemonApplication({
      commands: cdpTest.COMMANDS,
      handlerBuilders: { ...builders, planted: vi.fn() },
    })).toThrow(/exactly own/);
    const accessor = { ...builders };
    Object.defineProperty(accessor, 'click', { enumerable: true, get: () => vi.fn() });
    expect(() => cdpTest.preflightDaemonApplication({ commands: cdpTest.COMMANDS, handlerBuilders: accessor }))
      .toThrow(/data property|accessor/);
    expect(Object.values(builders).every(builder => builder.mock.calls.length === 0)).toBe(true);
  });

  it('rejects preflight option and daemon request prototypes/accessors before authority reads', async () => {
    const builders = Object.fromEntries(
      cdpTest.MIGRATED_DAEMON_COMMANDS.map(name => [name, vi.fn()]),
    );
    expect(() => cdpTest.preflightDaemonApplication(Object.create({
      commands: cdpTest.COMMANDS,
      handlerBuilders: builders,
    }))).toThrow(/plain data object/);
    const commandsRead = vi.fn(() => cdpTest.COMMANDS);
    const options = { handlerBuilders: builders };
    Object.defineProperty(options, 'commands', { enumerable: true, get: commandsRead });
    expect(() => cdpTest.preflightDaemonApplication(options)).toThrow(/data property/);
    expect(commandsRead).not.toHaveBeenCalled();

    const context = routeFixture();
    const dispatcher = createCommandDispatcher({
      ...context,
      authorize: cdpTest.authorizePhase4DaemonCommand,
    });
    const cmdRead = vi.fn(() => 'perceive');
    const request = { args: [], targetBound: true };
    Object.defineProperty(request, 'cmd', { enumerable: true, get: cmdRead });
    await expect(cdpTest.executePhase4DaemonRoute(request, dispatcher)).rejects.toThrow(/data property/);
    expect(cmdRead).not.toHaveBeenCalled();
    await expect(cdpTest.executePhase4DaemonRoute(
      Object.create({ cmd: 'perceive', args: [], targetBound: true }),
      dispatcher,
    )).rejects.toThrow(/plain data object/);
  });

  it('routes each direct migrated command exactly once and leaves unknown commands to legacy dispatch', async () => {
    const context = routeFixture();
    const dispatcher = createCommandDispatcher({
      ...context,
      authorize: cdpTest.authorizePhase4DaemonCommand,
    });
    const cases = [
      ['perceive', [], 'perceive-value'],
      ['report', [], 'report-value'],
      ['click', ['#save'], 'click-value'],
      ['evalraw', ['DOM.getDocument', '{}'], 'evalraw-value'],
    ];
    for (const [cmd, args, expected] of cases) {
      await expect(cdpTest.executePhase4DaemonRoute({ cmd, args, targetBound: true }, dispatcher))
        .resolves.toEqual({ handled: true, result: expected });
      expect(context.handlers[cmd]).toHaveBeenCalledOnce();
    }

    await expect(cdpTest.executePhase4DaemonRoute({ cmd: 'summary', args: [], targetBound: true }, dispatcher))
      .resolves.toEqual({ handled: false, result: null });
    expect(Object.values(context.handlers).every(handler => handler.mock.calls.length === 1)).toBe(true);
  });

  it('explicitly leaves every non-migrated catalog command on the legacy route', async () => {
    const context = routeFixture();
    const dispatcher = createCommandDispatcher({
      ...context,
      authorize: cdpTest.authorizePhase4DaemonCommand,
    });
    const migrated = new Set(Object.keys(context.handlers));
    const legacy = cdpTest.COMMANDS.filter(command => !migrated.has(command.name));
    expect(legacy).toHaveLength(77);
    for (const command of legacy) {
      await expect(cdpTest.executePhase4DaemonRoute({
        cmd: command.name,
        args: [],
        targetBound: command.needsTarget,
      }, dispatcher)).resolves.toEqual({ handled: false, result: null });
    }
    expect(Object.values(context.handlers).every(handler => handler.mock.calls.length === 0)).toBe(true);
  });

  it('fails closed at dispatch before invoking a denied mutation handler', async () => {
    const context = routeFixture();
    const dispatcher = createCommandDispatcher({
      ...context,
      authorize: () => ({ allowed: false, code: 'policy-denied' }),
    });
    await expect(cdpTest.executePhase4DaemonRoute(
      { cmd: 'click', args: ['#save'], targetBound: true },
      dispatcher,
    )).rejects.toThrow('authorization denied');
    expect(context.handlers.click).not.toHaveBeenCalled();
  });

  it.each(ACTION_COMMANDS)('binds %s to mutation authorization and a live target', command => {
    const mutates = command !== 'hover';
    expect(cdpTest.authorizePhase4DaemonCommand({
      command, policy: 'mutation', mutates, targetBound: true,
    })).toEqual({ allowed: true, code: 'legacy-daemon' });
    expect(cdpTest.authorizePhase4DaemonCommand({
      command, policy: 'mutation', mutates, targetBound: false,
    })).toEqual({ allowed: false, code: 'target-not-bound' });
    expect(cdpTest.authorizePhase4DaemonCommand({
      command, policy: 'standard', mutates, targetBound: true,
    })).toEqual({ allowed: false, code: 'policy-denied' });
  });

  it('supports the exact request shape used by sequential batch and flow recursion', async () => {
    const context = routeFixture();
    const dispatcher = createCommandDispatcher({
      ...context,
      authorize: cdpTest.authorizePhase4DaemonCommand,
    });
    const route = async step => {
      const routed = await cdpTest.executePhase4DaemonRoute({
        cmd: step.cmd,
        args: step.args || [],
        targetBound: true,
      }, dispatcher);
      return routed.handled ? { ok: true, result: routed.result } : { ok: false, error: 'legacy' };
    };

    const parsed = cdpTest.parseBatchArgs(['perceive --format json | report --format json']);
    for (const command of parsed.commands) expect((await route(command)).ok).toBe(true);
    const flow = await cdpTest.flowStr({
      run: route,
      settle: async () => '',
    }, 'perceive --format json; report --format json');
    expect(flow).toContain('perceive-value');
    expect(flow).toContain('report-value');
    expect(context.handlers.perceive).toHaveBeenCalledTimes(2);
    expect(context.handlers.report).toHaveBeenCalledTimes(2);
  });

  it('routes the accepted read cohorts through the complete dispatcher without legacy fallthrough', async () => {
    expect(cdpTest.MIGRATED_DAEMON_COMMANDS).toEqual([
      'perceive', 'click', 'report', 'evalraw', 'html', 'text', 'table', 'net', 'status', 'summary',
      'snap', 'controls', 'frame', 'overlay', 'styles', 'components', 'record-actions', 'export-playwright',
      'wait', 'waitfor', 'cascade', 'checkpoint', 'cookies',
      'fill', 'hover', 'press', 'scroll', 'select',
      'clickxy', 'dismiss-modal', 'jsclick', 'type', 'verify-click',
      'back', 'forward', 'nav', 'reload',
      'clock', 'mock', 'throttle',
    ]);
    const preflight = cdpTest.preflightDaemonApplication();
    expect(Object.values(preflight.routeOwners).filter(owner => owner === 'application')).toHaveLength(40);
    expect(Object.values(preflight.routeOwners).filter(owner => owner === 'legacy')).toHaveLength(41);
    const readHandlers = createDaemonReadHandlers({
      cascade: async args => `cascade:${args.join('|')}`,
      checkpoint: async args => `checkpoint:${args.join('|')}`,
      components: async args => `components:${args.join('|')}`,
      controls: async args => `controls:${args.join('|')}`,
      cookies: async args => `cookies:${args.join('|')}`,
      'export-playwright': async args => `export-playwright:${args.join('|')}`,
      frame: async args => `frame:${args.join('|')}`,
      html: async args => `html:${args.join('|')}`,
      text: async args => `text:${args.join('|')}`,
      table: async selector => `table:${selector ?? ''}`,
      net: async args => `net:${args.join('|')}`,
      overlay: async args => `overlay:${args.join('|')}`,
      'record-actions': async args => `record-actions:${args.join('|')}`,
      snap: async args => `snap:${args.join('|')}`,
      status: async args => `status:${args.join('|')}`,
      styles: async args => `styles:${args.join('|')}`,
      summary: async args => `summary:${args.join('|')}`,
      wait: async args => `wait:${args.join('|')}`,
      waitfor: async args => `waitfor:${args.join('|')}`,
    });
    const handlers = {
      perceive: async () => commandResult('perceive', null),
      report: async () => commandResult('report', { kind: 'session-report' }),
      click: async () => commandResult('click', { kind: 'action-receipt' }),
      evalraw: async ({ args }) => commandResult('evalraw', {
        kind: 'raw-audit', method: args[0], sideEffectClass: classifyRawCdpMethod(args[0]),
      }),
      ...readHandlers,
      ...createDaemonActionHandlers(Object.fromEntries(
        ACTION_COMMANDS.map(name => [name, async args => commandResult(`${name}:${args.join('|')}`, name === 'hover' ? null : { kind: 'action-receipt' })]),
      )),
    };
    const dispatcher = createCommandDispatcher({
      registry: preflight.registry,
      owners: preflight.routeOwners,
      handlers,
      authorize: cdpTest.authorizePhase4DaemonCommand,
    });
    await expect(cdpTest.executePhase4DaemonRoute({
      cmd: 'html', args: ['main'], targetBound: true,
    }, dispatcher)).resolves.toEqual({ handled: true, result: 'html:main' });
    await expect(cdpTest.executePhase4DaemonRoute({
      cmd: 'text', args: ['--auto'], targetBound: true,
    }, dispatcher)).resolves.toEqual({ handled: true, result: 'text:--auto' });
    await expect(cdpTest.executePhase4DaemonRoute({
      cmd: 'table', args: [], targetBound: true,
    }, dispatcher)).resolves.toEqual({ handled: true, result: 'table:' });
    await expect(cdpTest.executePhase4DaemonRoute({
      cmd: 'network', args: [], targetBound: true,
    }, dispatcher)).resolves.toEqual({ handled: true, result: 'net:' });
    await expect(cdpTest.executePhase4DaemonRoute({
      cmd: 'status', args: ['--format', 'json'], targetBound: true,
    }, dispatcher)).resolves.toEqual({ handled: true, result: 'status:--format|json' });
    await expect(cdpTest.executePhase4DaemonRoute({
      cmd: 'summary', args: [], targetBound: true,
    }, dispatcher)).resolves.toEqual({ handled: true, result: 'summary:' });
    await expect(cdpTest.executePhase4DaemonRoute({
      cmd: 'snapshot', args: ['--full'], targetBound: true,
    }, dispatcher)).resolves.toEqual({ handled: true, result: 'snap:--full' });
    await expect(cdpTest.executePhase4DaemonRoute({
      cmd: 'controls', args: ['--format', 'json'], targetBound: true,
    }, dispatcher)).resolves.toEqual({ handled: true, result: 'controls:--format|json' });
    await expect(cdpTest.executePhase4DaemonRoute({
      cmd: 'frames', args: ['--format', 'json'], targetBound: true,
    }, dispatcher)).resolves.toEqual({ handled: true, result: 'frame:--format|json' });
    await expect(cdpTest.executePhase4DaemonRoute({
      cmd: 'overlays', args: ['--format', 'json'], targetBound: true,
    }, dispatcher)).resolves.toEqual({ handled: true, result: 'overlay:--format|json' });
    await expect(cdpTest.executePhase4DaemonRoute({
      cmd: 'styles', args: ['#auth-panel'], targetBound: true,
    }, dispatcher)).resolves.toEqual({ handled: true, result: 'styles:#auth-panel' });
    await expect(cdpTest.executePhase4DaemonRoute({
      cmd: 'components', args: ['#auth-panel'], targetBound: true,
    }, dispatcher)).resolves.toEqual({ handled: true, result: 'components:#auth-panel' });
    await expect(cdpTest.executePhase4DaemonRoute({
      cmd: 'recordactions', args: ['--format', 'json'], targetBound: true,
    }, dispatcher)).resolves.toEqual({ handled: true, result: 'record-actions:--format|json' });
    await expect(cdpTest.executePhase4DaemonRoute({
      cmd: 'export-pw', args: ['--test-name', 'fixture'], targetBound: true,
    }, dispatcher)).resolves.toEqual({ handled: true, result: 'export-playwright:--test-name|fixture' });
    await expect(cdpTest.executePhase4DaemonRoute({
      cmd: 'wait', args: ['25'], targetBound: true,
    }, dispatcher)).resolves.toEqual({ handled: true, result: 'wait:25' });
    await expect(cdpTest.executePhase4DaemonRoute({
      cmd: 'waitfor', args: ['--text', 'Ready', '500'], targetBound: true,
    }, dispatcher)).resolves.toEqual({ handled: true, result: 'waitfor:--text|Ready|500' });
    await expect(cdpTest.executePhase4DaemonRoute({
      cmd: 'cascade', args: ['#auth-panel', 'color', '--format', 'json'], targetBound: true,
    }, dispatcher)).resolves.toEqual({ handled: true, result: 'cascade:#auth-panel|color|--format|json' });
    await expect(cdpTest.executePhase4DaemonRoute({
      cmd: 'checkpoint', args: ['--format', 'json'], targetBound: true,
    }, dispatcher)).resolves.toEqual({ handled: true, result: 'checkpoint:--format|json' });
    await expect(cdpTest.executePhase4DaemonRoute({
      cmd: 'cookies', args: [], targetBound: true,
    }, dispatcher)).resolves.toEqual({ handled: true, result: 'cookies:' });
    for (const name of ACTION_COMMANDS) {
      await expect(cdpTest.executePhase4DaemonRoute({
        cmd: name, args: ['fixture'], targetBound: true,
      }, dispatcher)).resolves.toEqual({ handled: true, result: `${name}:fixture` });
    }
  });

  it('binds each production extraction builder to exactly its named capability', async () => {
    const capabilities = {
      cascade: vi.fn(async () => 'cascade-only'),
      checkpoint: vi.fn(async () => 'checkpoint-only'),
      components: vi.fn(async () => 'components-only'),
      controls: vi.fn(async () => 'controls-only'),
      cookies: vi.fn(async () => 'cookies-only'),
      'export-playwright': vi.fn(async () => 'export-playwright-only'),
      frame: vi.fn(async () => 'frame-only'),
      html: vi.fn(async () => 'html-only'),
      text: vi.fn(async () => 'text-only'),
      table: vi.fn(async () => 'table-only'),
      net: vi.fn(async () => 'net-only'),
      overlay: vi.fn(async () => 'overlay-only'),
      'record-actions': vi.fn(async () => 'record-actions-only'),
      snap: vi.fn(async () => 'snap-only'),
      status: vi.fn(async () => 'status-only'),
      styles: vi.fn(async () => 'styles-only'),
      summary: vi.fn(async () => 'summary-only'),
      wait: vi.fn(async () => 'wait-only'),
      waitfor: vi.fn(async () => 'waitfor-only'),
    };
    const builders = cdpTest.preflightDaemonApplication().handlerBuilders;
    for (const name of [
      'html', 'text', 'table', 'net', 'status', 'summary', 'snap', 'controls', 'frame',
      'overlay', 'styles', 'components', 'record-actions', 'export-playwright',
      'wait', 'waitfor', 'cascade', 'checkpoint', 'cookies',
    ]) {
      const handler = builders[name](capabilities);
      const result = await handler({ args: name === 'table' ? ['#grid'] : ['main'] });
      expect(result.value).toBe(`${name}-only`);
    }
    expect(capabilities.html).toHaveBeenCalledOnce();
    expect(capabilities.text).toHaveBeenCalledOnce();
    expect(capabilities.table).toHaveBeenCalledExactlyOnceWith('#grid');
    expect(capabilities.net).toHaveBeenCalledOnce();
    expect(capabilities.status).toHaveBeenCalledOnce();
    expect(capabilities.summary).toHaveBeenCalledOnce();
    expect(capabilities.snap).toHaveBeenCalledOnce();
    expect(capabilities.controls).toHaveBeenCalledOnce();
    expect(capabilities.frame).toHaveBeenCalledOnce();
    expect(capabilities.overlay).toHaveBeenCalledOnce();
    expect(capabilities.styles).toHaveBeenCalledOnce();
    expect(capabilities.components).toHaveBeenCalledOnce();
    expect(capabilities['record-actions']).toHaveBeenCalledOnce();
    expect(capabilities['export-playwright']).toHaveBeenCalledOnce();
    expect(capabilities.wait).toHaveBeenCalledOnce();
    expect(capabilities.waitfor).toHaveBeenCalledOnce();
    expect(capabilities.cascade).toHaveBeenCalledOnce();
  });

  it('binds each production action builder to exactly its named capability', async () => {
    const capabilities = Object.fromEntries(ACTION_COMMANDS.map(name => [
      name, vi.fn(async () => commandResult(`${name}-only`, name === 'hover' ? null : { kind: 'action-receipt' })),
    ]));
    const builders = cdpTest.preflightDaemonApplication().handlerBuilders;
    for (const name of Object.keys(capabilities)) {
      await expect(builders[name](capabilities)({ args: ['fixture'] })).resolves.toMatchObject({ value: `${name}-only` });
      expect(capabilities[name]).toHaveBeenCalledExactlyOnceWith(['fixture']);
    }
  });
});

describe('Phase 4 evalraw compatibility slice', () => {
  it.each([
    ['DOM.getDocument', '{}', 'read-only'],
    ['Runtime.evaluate', '{"expression":"document.title"}', 'potentially-mutating'],
    ['Experimental.mystery', undefined, 'unknown'],
  ])('preserves %s output while keeping trusted audit metadata internal', async (method, params, sideEffectClass) => {
    const evalRaw = vi.fn(async (actualMethod, actualParams) => `legacy:${actualMethod}:${actualParams ?? ''}\n`);
    const registry = cdpTest.createPhase4CommandRegistry(cdpTest.COMMANDS);
    const handler = cdpTest.createPhase4EvalrawHandler({ evalRaw });
    const actual = await cdpTest.executePhase4CompatibilityCommand({
      name: 'evalraw', args: params === undefined ? [method] : [method, params], targetBound: true,
    }, {
      registry,
      handlers: { evalraw: handler },
      authorize: cdpTest.authorizePhase4DaemonCommand,
    });

    expect(evalRaw).toHaveBeenCalledWith(
      method,
      params,
      expect.objectContaining({ method, sideEffectClass }),
    );
    expect(actual).toBe(`legacy:${method}:${params ?? ''}\n`);
    expect(actual).not.toContain('raw-audit');
    expect(classifyRawCdpMethod(method)).toBe(sideEffectClass);
  });

  it('preserves established missing-method and malformed-params failures', async () => {
    const evalRaw = vi.fn(async (method, params) => {
      if (!method) throw new Error('CDP method required (e.g. "DOM.getDocument")');
      if (params === '{bad') throw new Error('Invalid JSON params: {bad');
      return 'unused';
    });
    const handler = cdpTest.createPhase4EvalrawHandler({ evalRaw });
    await expect(handler({ args: [] })).rejects.toThrow('CDP method required');
    await expect(handler({ args: ['DOM.getDocument', '{bad'] })).rejects.toThrow('Invalid JSON params: {bad');
  });
});
