import { describe, expect, it, vi } from 'vitest';

import {
  commandResult,
  createCommandRegistry,
  defineCommandSpec,
} from '../skills/chrome-cdp-ex/scripts/lib/command-application.mjs';
import {
  createCommandDispatcher,
  inspectCommandDispatcher,
} from '../skills/chrome-cdp-ex/scripts/lib/command-dispatch.mjs';

function spec(name, { aliases = [], kind = 'read' } = {}) {
  const policy = kind === 'mutation'
    ? { mutates: true, feedbackPolicy: 'settle-diff', authorization: 'mutation', evidencePolicy: 'action-receipt' }
    : { mutates: false, feedbackPolicy: null, authorization: 'standard', evidencePolicy: 'none' };
  return defineCommandSpec({
    name, aliases, needsTarget: true, outputFormats: ['text'], kind, ...policy,
  });
}

function fixture(overrides = {}) {
  const registry = createCommandRegistry([
    spec('legacy', { aliases: ['old'] }),
    spec('perceive', { aliases: ['see'] }),
  ]);
  const handler = vi.fn(async ({ args }) => commandResult(args.join(':'), null));
  const options = {
    registry,
    owners: { legacy: 'legacy', perceive: 'application' },
    handlers: { perceive: handler },
    ...overrides,
  };
  return { registry, handler, options };
}

describe('complete command route dispatcher', () => {
  it('requires a branded complete registry and exact owner/handler cardinality', () => {
    const { registry, options } = fixture();
    expect(() => createCommandDispatcher({ ...options, registry: { list: () => [] } })).toThrow(/registry/);
    expect(() => createCommandDispatcher({ ...options, owners: { perceive: 'application' } })).toThrow(/exactly cover/);
    expect(() => createCommandDispatcher({ ...options, owners: { ...options.owners, planted: 'legacy' } })).toThrow(/exactly cover/);
    expect(() => createCommandDispatcher({ ...options, owners: { ...options.owners, legacy: 'unknown' } })).toThrow(/application or legacy/);
    expect(() => createCommandDispatcher({ ...options, handlers: {} })).toThrow(/exactly cover/);
    expect(() => createCommandDispatcher({ ...options, handlers: { perceive: options.handlers.perceive, legacy: vi.fn() } })).toThrow(/exactly cover/);
    expect(createCommandDispatcher(options).list()).toEqual([
      { command: 'legacy', owner: 'legacy' },
      { command: 'perceive', owner: 'application' },
    ]);
    expect(registry.resolve('old').name).toBe('legacy');
  });

  it('rejects top-level option prototypes, accessors, symbols, and extra keys before authority reads', () => {
    const { options } = fixture();
    expect(() => createCommandDispatcher(Object.create({ ...options }))).toThrow(/plain data object/);
    const authorizeRead = vi.fn(() => undefined);
    const accessor = { registry: options.registry, owners: options.owners, handlers: options.handlers };
    Object.defineProperty(accessor, 'authorize', { enumerable: true, get: authorizeRead });
    expect(() => createCommandDispatcher(accessor)).toThrow(/data property/);
    expect(authorizeRead).not.toHaveBeenCalled();
    expect(() => createCommandDispatcher({ ...options, [Symbol('authority')]: true })).toThrow(/symbol/);
    expect(() => createCommandDispatcher({ ...options, planted: true })).toThrow(/not allowed/);
  });

  it.each([
    ['owners', Object.create({ legacy: 'legacy', perceive: 'application' })],
    ['handlers', Object.create({ perceive: () => {} })],
  ])('rejects prototype-backed %s', (key, value) => {
    const { options } = fixture();
    expect(() => createCommandDispatcher({ ...options, [key]: value })).toThrow(/plain data object/);
  });

  it('rejects accessor, symbol, sparse/array, and non-function authority input', () => {
    const { options } = fixture();
    const accessor = { legacy: 'legacy' };
    Object.defineProperty(accessor, 'perceive', { get: () => 'application', enumerable: true });
    expect(() => createCommandDispatcher({ ...options, owners: accessor })).toThrow(/data property/);
    const symbol = { ...options.owners, [Symbol('x')]: 'legacy' };
    expect(() => createCommandDispatcher({ ...options, owners: symbol })).toThrow(/symbol/);
    expect(() => createCommandDispatcher({ ...options, owners: [] })).toThrow(/plain data object/);
    expect(() => createCommandDispatcher({ ...options, handlers: { perceive: true } })).toThrow(/function/);
  });

  it('rejects request accessors and prototype-backed requests before reading command data', async () => {
    const { options } = fixture();
    const dispatcher = createCommandDispatcher(options);
    const accessed = vi.fn(() => 'perceive');
    const accessor = {};
    Object.defineProperty(accessor, 'name', { enumerable: true, get: accessed });
    await expect(dispatcher.execute(accessor)).rejects.toThrow(/data property/);
    expect(accessed).not.toHaveBeenCalled();
    await expect(dispatcher.execute(Object.create({ name: 'perceive' }))).rejects.toThrow(/plain data object/);
    const customArgs = ['x'];
    Object.setPrototypeOf(customArgs, { planted: true });
    await expect(dispatcher.execute({ name: 'legacy', args: customArgs, targetBound: true }))
      .rejects.toThrow(/array prototype/);
  });

  it('canonicalizes aliases and returns legacy routes without handler or authorization', async () => {
    const authorize = vi.fn(async () => ({ allowed: true, code: 'unused' }));
    const { handler, options } = fixture({ authorize });
    const dispatcher = createCommandDispatcher(options);
    expect(dispatcher.route('see')).toEqual({ command: 'perceive', owner: 'application' });
    expect(dispatcher.route('old')).toEqual({ command: 'legacy', owner: 'legacy' });
    await expect(dispatcher.execute({ name: 'old', args: [], targetBound: false })).resolves.toEqual({
      handled: false, command: 'legacy', result: null,
    });
    expect(handler).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
  });

  it('preserves repeated ordered argv for both legacy and application routes', async () => {
    const { handler, options } = fixture();
    const dispatcher = createCommandDispatcher(options);
    const args = ['--selector', 'body', '--exclude', 'body'];
    await expect(dispatcher.execute({ name: 'legacy', args, targetBound: true })).resolves.toEqual({
      handled: false, command: 'legacy', result: null,
    });
    await expect(dispatcher.execute({ name: 'perceive', args, targetBound: true })).resolves.toEqual({
      handled: true, command: 'perceive', result: args.join(':'),
    });
    await expect(dispatcher.execute({ name: 'perceive', args: [''], targetBound: true })).resolves.toEqual({
      handled: true, command: 'perceive', result: '',
    });
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[0][0].args).toEqual(args);
    expect(handler.mock.calls[1][0].args).toEqual(['']);
  });

  it('preserves target, authorization, handler result/error, and exactly-once execution', async () => {
    const mutation = spec('click', { aliases: ['press-it'], kind: 'mutation' });
    const registry = createCommandRegistry([mutation]);
    const handler = vi.fn(async () => commandResult('clicked', { kind: 'action-receipt' }));
    const authorize = vi.fn(async () => ({ allowed: true, code: 'approved' }));
    const dispatcher = createCommandDispatcher({
      registry, owners: { click: 'application' }, handlers: { click: handler }, authorize,
    });
    await expect(dispatcher.execute({ name: 'press-it', args: ['@1'], targetBound: true }))
      .resolves.toEqual({ handled: true, command: 'click', result: 'clicked' });
    expect(authorize).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledOnce();
    await expect(dispatcher.execute({ name: 'click', args: [], targetBound: false })).rejects.toThrow(/target/);
    expect(handler).toHaveBeenCalledOnce();
    const sentinel = new Error('handler sentinel');
    handler.mockRejectedValueOnce(sentinel);
    await expect(dispatcher.execute({ name: 'click', args: [], targetBound: true })).rejects.toBe(sentinel);
  });

  it('isolates concurrent calls and rejects forged dispatchers', async () => {
    const { options } = fixture();
    const dispatcher = createCommandDispatcher(options);
    const values = await Promise.all(Array.from({ length: 25 }, (_, index) => dispatcher.execute({
      name: 'see', args: [String(index)], targetBound: true,
    })));
    expect(values.map(value => value.result)).toEqual(Array.from({ length: 25 }, (_, index) => String(index)));
    expect(inspectCommandDispatcher(dispatcher)).toHaveLength(2);
    expect(() => inspectCommandDispatcher({ list: dispatcher.list })).toThrow(/factory/);
    await expect(dispatcher.execute({ name: 'unknown', args: [], targetBound: true })).rejects.toThrow(/unknown/);
  });

  it('supports a reentrant call through the same dispatcher without sharing request state', async () => {
    const registry = createCommandRegistry([spec('legacy'), spec('perceive')]);
    let dispatcher;
    const perceive = vi.fn(async ({ args }) => {
      const nested = await dispatcher.execute({ name: 'legacy', args: ['nested'], targetBound: true });
      return commandResult(`${args[0]}:${nested.command}:${nested.handled}`, null);
    });
    dispatcher = createCommandDispatcher({
      registry,
      owners: { legacy: 'legacy', perceive: 'application' },
      handlers: { perceive },
    });
    await expect(dispatcher.execute({ name: 'perceive', args: ['outer'], targetBound: true }))
      .resolves.toEqual({ handled: true, command: 'perceive', result: 'outer:legacy:false' });
    expect(perceive).toHaveBeenCalledOnce();
  });
});
