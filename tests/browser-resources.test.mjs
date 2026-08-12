import { describe, expect, it, vi } from 'vitest';

import {
  createLocatorPlan,
  createResolvedHandle,
  createResourceRef,
  isResolvedHandle,
  resolveLocatorPlan,
} from '../skills/chrome-cdp-ex/scripts/lib/browser-resources.mjs';
import { buildEvidenceBundle } from '../scripts/lib/validation-lab.mjs';

function page(overrides = {}) {
  return {
    schema: 'chrome-cdp-ex.resource-ref.v1',
    kind: 'page',
    id: 'page-app',
    revision: 2,
    capabilities: ['evaluate', 'perceive'],
    links: [{ relation: 'browser', kind: 'browser', id: 'browser-main', revision: 1 }],
    ...overrides,
  };
}

function plan(overrides = {}) {
  return {
    schema: 'chrome-cdp-ex.locator-plan.v1',
    strategy: 'exact-target',
    value: 'TARGET-APP-FULL',
    scope: { kind: 'browser', id: 'browser-main', revision: 1 },
    fallbacks: [],
    ...overrides,
  };
}

function candidate(overrides = {}) {
  return {
    resource: createResourceRef(page()),
    targetId: 'TARGET-APP-FULL',
    aliases: ['app'],
    url: 'http://127.0.0.1:4173/app',
    current: true,
    browser: { kind: 'browser', id: 'browser-main', revision: 1 },
    ...overrides,
  };
}

describe('ResourceRef public contract', () => {
  it('canonicalizes and deeply freezes capabilities and links', () => {
    const resource = createResourceRef(page({
      capabilities: ['perceive', 'evaluate'],
      links: [
        { relation: 'opener', kind: 'page', id: 'page-parent', revision: 3 },
        { relation: 'browser', kind: 'browser', id: 'browser-main', revision: 1 },
      ],
    }));
    expect(resource).toEqual({
      schema: 'chrome-cdp-ex.resource-ref.v1',
      kind: 'page',
      id: 'page-app',
      revision: 2,
      capabilities: ['evaluate', 'perceive'],
      links: [
        { relation: 'browser', kind: 'browser', id: 'browser-main', revision: 1 },
        { relation: 'opener', kind: 'page', id: 'page-parent', revision: 3 },
      ],
    });
    expect(Object.isFrozen(resource)).toBe(true);
    expect(Object.isFrozen(resource.capabilities)).toBe(true);
    expect(Object.isFrozen(resource.links)).toBe(true);
    expect(Object.isFrozen(resource.links[0])).toBe(true);
    expect(() => resource.capabilities.push('mutate')).toThrow();
  });

  it.each([
    ['wrong schema', page({ schema: 'other' }), /schema/],
    ['unknown kind', page({ kind: 'node' }), /kind/],
    ['blank id', page({ id: '' }), /id/],
    ['oversized id', page({ id: 'x'.repeat(257) }), /id/],
    ['negative revision', page({ revision: -1 }), /revision/],
    ['fractional revision', page({ revision: 1.5 }), /revision/],
    ['unknown top-level key', { ...page(), targetId: 'private' }, /targetId.*not allowed/],
    ['secret-like key', { ...page(), token: 'secret' }, /token.*not allowed/],
    ['private handle key', { ...page(), socketPath: '/private/socket' }, /socketPath.*not allowed/],
    ['duplicate capability', page({ capabilities: ['perceive', 'perceive'] }), /duplicate capability/],
    ['too many capabilities', page({ capabilities: Array.from({ length: 65 }, (_, index) => `cap-${index}`) }), /at most 64/],
    ['invalid capability', page({ capabilities: ['Perceive'] }), /capabilities/],
    ['duplicate link', page({ links: [page().links[0], page().links[0]] }), /duplicate link/],
    ['too many links', page({ links: Array.from({ length: 65 }, (_, index) => ({ relation: `rel-${index}`, kind: 'page', id: `page-${index}`, revision: 1 })) }), /at most 64/],
    ['extra link key', page({ links: [{ ...page().links[0], targetId: 'private' }] }), /targetId.*not allowed/],
  ])('rejects %s', (_label, input, expected) => {
    expect(() => createResourceRef(input)).toThrow(expected);
  });

  it('rejects accessors, symbols, prototypes, and cycles before canonicalization', () => {
    const accessor = page();
    Object.defineProperty(accessor, 'id', { enumerable: true, get: () => 'page-accessor' });
    expect(() => createResourceRef(accessor)).toThrow(/accessor/);

    const symbol = page();
    symbol[Symbol('targetId')] = 'private';
    expect(() => createResourceRef(symbol)).toThrow(/symbol/);

    const inherited = Object.assign(Object.create({ token: 'private' }), page());
    expect(() => createResourceRef(inherited)).toThrow(/plain object/);

    const cyclic = page();
    cyclic.links = [cyclic];
    expect(() => createResourceRef(cyclic)).toThrow(/cycle/);

    const accessorArray = page();
    Object.defineProperty(accessorArray.capabilities, '0', { enumerable: true, get: () => 'perceive' });
    expect(() => createResourceRef(accessorArray)).toThrow(/accessor/);
    const symbolArray = page();
    symbolArray.links[Symbol('private')] = 'secret';
    expect(() => createResourceRef(symbolArray)).toThrow(/symbol/);
    const sparse = page({ capabilities: new Array(1) });
    expect(() => createResourceRef(sparse)).toThrow(/sparse/);
  });
});

describe('LocatorPlan public contract', () => {
  it('canonicalizes an ordered fallback graph and freezes every level', () => {
    const locator = createLocatorPlan(plan({
      fallbacks: [
        plan({ strategy: 'target-prefix', value: 'TARGET-APP', fallbacks: [] }),
        plan({ strategy: 'alias', value: 'app', fallbacks: [] }),
      ],
    }));
    expect(locator.fallbacks.map(item => item.strategy)).toEqual(['target-prefix', 'alias']);
    expect(Object.isFrozen(locator)).toBe(true);
    expect(Object.isFrozen(locator.scope)).toBe(true);
    expect(Object.isFrozen(locator.fallbacks)).toBe(true);
    expect(Object.isFrozen(locator.fallbacks[0])).toBe(true);
  });

  it.each([
    ['wrong schema', plan({ schema: 'other' }), /schema/],
    ['unknown strategy', plan({ strategy: 'magic' }), /strategy/],
    ['missing strategy value', plan({ value: null }), /value/],
    ['invalid alias value', plan({ strategy: 'alias', value: '1 invalid alias' }), /invalid format/],
    ['current page with value', plan({ strategy: 'current-page', value: 'app' }), /value.*null/],
    ['invalid scope kind', plan({ scope: { kind: 'page', id: 'page-app', revision: 1 } }), /scope.kind/],
    ['extra scope key', plan({ scope: { kind: 'browser', id: 'browser-main', revision: 1, port: 9222 } }), /port.*not allowed/],
    ['unknown top-level key', { ...plan(), socketPath: '/private/socket' }, /socketPath.*not allowed/],
    ['duplicate fallback', plan({ fallbacks: [plan(), plan()] }), /duplicate fallback/],
    ['duplicate nested fallback', plan({ fallbacks: [
      plan({ strategy: 'alias', value: 'one', fallbacks: [plan({ strategy: 'current-page', value: null })] }),
      plan({ strategy: 'alias', value: 'two', fallbacks: [plan({ strategy: 'current-page', value: null })] }),
    ] }), /duplicate fallback/],
    ['too many total attempts', plan({ fallbacks: Array.from({ length: 8 }, (_, index) => plan({ strategy: 'alias', value: `app-${index}` })) }), /at most 8 attempts/],
    ['non-loopback URL', plan({ strategy: 'url', value: 'https://example.com/' }), /loopback/],
    ['URL credentials', plan({ strategy: 'url', value: 'http://user:password@127.0.0.1:4173/' }), /credentials/],
    ['URL secret query', plan({ strategy: 'url', value: 'http://127.0.0.1:4173/?token=TOPSECRET' }), /credential-bearing/],
    ['URL secret fragment', plan({ strategy: 'url', value: 'http://127.0.0.1:4173/#/app?clientSecret=TOPSECRET' }), /credential-bearing/],
    ['URL colon secret fragment', plan({ strategy: 'url', value: 'http://127.0.0.1:4173/#token:TOPSECRET' }), /credential-bearing/],
    ['URL JSON secret fragment', plan({ strategy: 'url', value: 'http://127.0.0.1:4173/#%7B%22clientSecret%22%3A%22TOPSECRET%22%7D' }), /credential-bearing/],
    ['URL double-encoded secret query', plan({ strategy: 'url', value: 'http://127.0.0.1:4173/?%2574oken=TOPSECRET' }), /credential-bearing/],
  ])('rejects %s', (_label, input, expected) => {
    expect(() => createLocatorPlan(input)).toThrow(expected);
  });

  it('rejects accessor, symbol, prototype, cycle, and excessive nesting', () => {
    const accessor = plan();
    Object.defineProperty(accessor, 'value', { enumerable: true, get: () => 'TARGET' });
    expect(() => createLocatorPlan(accessor)).toThrow(/accessor/);

    const symbol = plan();
    symbol[Symbol('port')] = 9222;
    expect(() => createLocatorPlan(symbol)).toThrow(/symbol/);

    expect(() => createLocatorPlan(Object.assign(Object.create({ token: 'private' }), plan())))
      .toThrow(/plain object/);

    const cyclic = plan();
    cyclic.fallbacks = [cyclic];
    expect(() => createLocatorPlan(cyclic)).toThrow(/cycle/);

    const arrayCycle = plan();
    arrayCycle.fallbacks = [];
    arrayCycle.fallbacks.push(arrayCycle.fallbacks);
    expect(() => createLocatorPlan(arrayCycle)).toThrow(/cycle/);

    let nested = plan();
    for (let index = 0; index < 9; index++) nested = plan({ fallbacks: [nested] });
    expect(() => createLocatorPlan(nested)).toThrow(/depth|at most 8 attempts/);

    const explosive = (depth) => depth === 0
      ? plan({ strategy: 'alias', value: 'leaf' })
      : plan({ fallbacks: Array.from({ length: 8 }, (_, index) => plan({
        strategy: 'alias',
        value: `branch-${depth}-${index}`,
        fallbacks: depth === 1 ? [] : [explosive(depth - 1)],
      })) });
    expect(() => createLocatorPlan(explosive(3))).toThrow(/at most 8 attempts/);
  });
});

describe('bounded locator resolution', () => {
  it('resolves exact, prefix, alias, current, and loopback URL strategies', async () => {
    const discovered = [
      candidate(),
      candidate({
        resource: createResourceRef(page({ id: 'page-other', revision: 4 })),
        targetId: 'TARGET-OTHER-FULL',
        aliases: ['other'],
        url: 'http://127.0.0.1:4173/other',
        current: false,
      }),
    ];
    for (const locator of [
      plan(),
      plan({ strategy: 'target-prefix', value: 'TARGET-APP' }),
      plan({ strategy: 'alias', value: 'app' }),
      plan({ strategy: 'current-page', value: null }),
      plan({ strategy: 'url', value: 'http://127.0.0.1:4173/app' }),
    ]) {
      await expect(resolveLocatorPlan(createLocatorPlan(locator), {
        discover: async () => discovered,
      })).resolves.toEqual(discovered[0].resource);
    }
  });

  it('recovers a stale exact target through one ordered unique-prefix fallback', async () => {
    const discover = vi.fn(async () => [candidate({ targetId: 'TARGET-APP-NEW' })]);
    const locator = createLocatorPlan(plan({
      value: 'TARGET-APP-OLD',
      fallbacks: [plan({ strategy: 'target-prefix', value: 'TARGET-APP-', fallbacks: [] })],
    }));
    await expect(resolveLocatorPlan(locator, { discover })).resolves.toEqual(candidate().resource);
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it('fails closed for ambiguity, scope mismatch, exhaustion, and attempt overflow', async () => {
    const ambiguous = [candidate(), candidate({
      resource: createResourceRef(page({ id: 'page-copy' })),
      targetId: 'TARGET-APP-COPY',
      current: false,
    })];
    await expect(resolveLocatorPlan(createLocatorPlan(plan({
      strategy: 'target-prefix', value: 'TARGET-APP',
    })), { discover: async () => ambiguous })).rejects.toThrow(/ambiguous/);

    await expect(resolveLocatorPlan(createLocatorPlan(plan({
      scope: { kind: 'browser', id: 'browser-other', revision: 1 },
    })), { discover: async () => [candidate()] })).rejects.toThrow(/exhausted/);

    await expect(resolveLocatorPlan(createLocatorPlan(plan()), {
      discover: async () => [],
    })).rejects.toThrow(/exhausted/);

    await expect(resolveLocatorPlan(createLocatorPlan(plan()), {
      discover: async () => Array.from({ length: 1025 }, (_, index) => candidate({ targetId: `TARGET-${index}` })),
    })).rejects.toThrow(/at most 1024/);

    const locator = createLocatorPlan(plan({
      fallbacks: [
        plan({ strategy: 'alias', value: 'one' }),
        plan({ strategy: 'alias', value: 'two' }),
      ],
    }));
    const discover = vi.fn(async () => []);
    await expect(resolveLocatorPlan(locator, { discover, maxAttempts: 2 }))
      .rejects.toThrow(/attempt limit/);
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it('rejects untrusted discovery entries and dependency shapes', async () => {
    await expect(resolveLocatorPlan(createLocatorPlan(plan()), {
      discover: { call: async () => [] },
    })).rejects.toThrow(/discover/);
    const entry = candidate();
    Object.defineProperty(entry, 'targetId', { enumerable: true, get: () => 'TARGET-APP-FULL' });
    await expect(resolveLocatorPlan(createLocatorPlan(plan()), {
      discover: async () => [entry],
    })).rejects.toThrow(/accessor/);

    const accessorDiscovery = [];
    Object.defineProperty(accessorDiscovery, '0', { enumerable: true, get: () => candidate() });
    accessorDiscovery.length = 1;
    await expect(resolveLocatorPlan(createLocatorPlan(plan()), {
      discover: async () => accessorDiscovery,
    })).rejects.toThrow(/accessor/);
    await expect(resolveLocatorPlan(createLocatorPlan(plan()), {
      discover: async () => new Array(1),
    })).rejects.toThrow(/sparse/);
    const symbolDiscovery = [candidate()];
    symbolDiscovery[Symbol('private')] = 'secret';
    await expect(resolveLocatorPlan(createLocatorPlan(plan()), {
      discover: async () => symbolDiscovery,
    })).rejects.toThrow(/symbol/);
  });

  it('requires a page resource whose browser link matches discovery scope authority', async () => {
    await expect(resolveLocatorPlan(createLocatorPlan(plan()), {
      discover: async () => [candidate({
        resource: createResourceRef(page({ kind: 'browser', id: 'browser-main', links: [] })),
      })],
    })).rejects.toThrow(/resource.kind.*page/);

    await expect(resolveLocatorPlan(createLocatorPlan(plan()), {
      discover: async () => [candidate({
        resource: createResourceRef(page({
          links: [{ relation: 'browser', kind: 'browser', id: 'browser-other', revision: 1 }],
        })),
      })],
    })).rejects.toThrow(/browser link.*discovery browser/);

    await expect(resolveLocatorPlan(createLocatorPlan(plan()), {
      discover: async () => [candidate({ resource: createResourceRef(page({ links: [] })) })],
    })).rejects.toThrow(/exactly one browser link/);

    await expect(resolveLocatorPlan(createLocatorPlan(plan()), {
      discover: async () => [candidate({
        resource: createResourceRef(page({
          links: [{ relation: 'browser', kind: 'page', id: 'page-other', revision: 1 }],
        })),
      })],
    })).rejects.toThrow(/browser link kind.*browser/);

    await expect(resolveLocatorPlan(createLocatorPlan(plan()), {
      discover: async () => [candidate({
        resource: createResourceRef(page({ links: [
          page().links[0],
          { relation: 'browser', kind: 'page', id: 'page-other', revision: 1 },
        ] })),
      })],
    })).rejects.toThrow(/exactly one browser link/);
  });
});

describe('ResolvedHandle private boundary', () => {
  it('creates a frozen, branded, non-enumerable execution handle', async () => {
    const transport = { request: vi.fn(async request => ({ ok: true, result: request.cmd })) };
    const handle = createResolvedHandle({
      resource: createResourceRef(page()),
      targetId: 'TARGET-APP-FULL',
      endpoint: '/runtime/cdp-TARGET-APP-FULL.sock',
      transport,
    });
    expect(isResolvedHandle(handle)).toBe(true);
    expect(Object.isFrozen(handle)).toBe(true);
    expect(Object.keys(handle)).toEqual([]);
    expect(Reflect.ownKeys(handle).sort()).toEqual(['execute', 'resource', 'toJSON']);
    expect(handle.resource()).toEqual(createResourceRef(page()));
    await expect(handle.execute({ cmd: 'report', args: [] })).resolves.toEqual({ ok: true, result: 'report' });
    expect(transport.request).toHaveBeenCalledWith(
      { cmd: 'report', args: [] },
      { targetId: 'TARGET-APP-FULL', endpoint: '/runtime/cdp-TARGET-APP-FULL.sock' },
    );
  });

  it('cannot be forged, serialized, cloned, mutated, or embedded in a public resource', () => {
    const handle = createResolvedHandle({
      resource: createResourceRef(page()),
      targetId: 'TARGET-APP-FULL',
      endpoint: '/runtime/cdp-TARGET-APP-FULL.sock',
      transport: { request: async () => ({ ok: true }) },
    });
    expect(isResolvedHandle({ execute: handle.execute })).toBe(false);
    expect(() => JSON.stringify(handle)).toThrow(/private ResolvedHandle/);
    expect(() => structuredClone(handle)).toThrow();
    expect(() => { handle.extra = true; }).toThrow();
    expect(() => createResourceRef({ ...page(), links: [handle] })).toThrow();
  });

  it('is rejected when a Phase 3 evidence snapshot attempts to admit it', () => {
    const handle = createResolvedHandle({
      resource: createResourceRef(page()),
      targetId: 'TARGET-APP-FULL',
      endpoint: '/runtime/cdp-TARGET-APP-FULL.sock',
      transport: { request: async () => ({ ok: true }) },
    });
    expect(() => buildEvidenceBundle({
      scenario: {
        id: 'private-handle-probe',
        risk: { maxOutputBytes: 256 },
        planted: handle,
      },
      registryDigest: `sha256:${'a'.repeat(64)}`,
      execution: { ok: true, attempts: [{}] },
    })).toThrow();
  });

  it('rejects private input accessors, symbols, prototypes, and invalid transports', () => {
    const input = {
      resource: createResourceRef(page()),
      targetId: 'TARGET-APP-FULL',
      endpoint: '/runtime/socket',
      transport: { request: async () => ({ ok: true }) },
    };
    const accessor = { ...input };
    Object.defineProperty(accessor, 'endpoint', { enumerable: true, get: () => '/private/socket' });
    expect(() => createResolvedHandle(accessor)).toThrow(/accessor/);
    expect(() => createResolvedHandle(Object.assign(Object.create({ token: 'private' }), input)))
      .toThrow(/plain object/);
    expect(() => createResolvedHandle({ ...input, [Symbol('token')]: 'private' })).toThrow(/symbol/);
    expect(() => createResolvedHandle({ ...input, transport: {} })).toThrow(/transport/);
  });
});
