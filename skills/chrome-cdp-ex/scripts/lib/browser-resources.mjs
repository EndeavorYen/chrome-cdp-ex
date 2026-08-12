const RESOURCE_SCHEMA = 'chrome-cdp-ex.resource-ref.v1';
const LOCATOR_SCHEMA = 'chrome-cdp-ex.locator-plan.v1';
const RESOURCE_KINDS = new Set(['browser', 'page', 'frame']);
const LOCATOR_STRATEGIES = new Set(['exact-target', 'target-prefix', 'alias', 'current-page', 'url']);
const RESOURCE_KEYS = new Set(['schema', 'kind', 'id', 'revision', 'capabilities', 'links']);
const LINK_KEYS = new Set(['relation', 'kind', 'id', 'revision']);
const LOCATOR_KEYS = new Set(['schema', 'strategy', 'value', 'scope', 'fallbacks']);
const IDENTITY_KEYS = new Set(['kind', 'id', 'revision']);
const CANDIDATE_KEYS = new Set(['resource', 'targetId', 'aliases', 'url', 'current', 'browser']);
const HANDLE_KEYS = new Set(['resource', 'targetId', 'endpoint', 'transport']);
const MAX_ID_LENGTH = 256;
const MAX_LOCATOR_DEPTH = 8;
const MAX_RESOLUTION_ATTEMPTS = 8;
const MAX_RESOURCE_ITEMS = 64;
const MAX_DISCOVERY_ENTRIES = 1024;
const NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;
const ALIAS_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const SENSITIVE_ASSIGNMENT_RE = new RegExp(
  String.raw`(^|[^a-z0-9_-])["']?(?:authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|auth|key|session(?:id)?|[a-z0-9_-]*(?:token|api[-_]?key|secret|password|passwd|passphrase))["']?\s*[:=]`,
  'i',
);
const resolvedHandles = new WeakSet();

function fail(path, message) {
  throw new Error(`${path}: ${message}`);
}

function snapshotDataObject(input, path, allowedKeys, active = new WeakSet()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(path, 'must be a plain object');
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype) fail(path, 'must be a plain object');
  if (active.has(input)) fail(path, 'must not contain a cycle');
  active.add(input);
  const output = Object.create(null);
  try {
    for (const key of Reflect.ownKeys(input)) {
      if (typeof key === 'symbol') fail(path, 'symbol keys are not allowed');
      if (!allowedKeys.has(key)) fail(`${path}.${key}`, 'is not allowed');
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail(`${path}.${key}`, 'accessor properties are not allowed');
      output[key] = descriptor.value;
    }
  } finally {
    active.delete(input);
  }
  return output;
}

function mapDataArray(input, path, active, mapper, { maxLength = MAX_RESOURCE_ITEMS } = {}) {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) fail(path, 'must be a plain array');
  if (input.length > maxLength) fail(path, `must contain at most ${maxLength} entries`);
  if (active.has(input)) fail(path, 'must not contain a cycle');
  active.add(input);
  try {
    const values = new Array(input.length);
    for (const key of Reflect.ownKeys(input)) {
      if (typeof key === 'symbol') fail(path, 'symbol keys are not allowed');
      if (key === 'length') continue;
      if (!/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= input.length) fail(`${path}.${key}`, 'is not an array index');
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail(`${path}[${key}]`, 'accessor properties are not allowed');
      values[Number(key)] = descriptor.value;
    }
    for (let index = 0; index < values.length; index++) {
      if (!Object.hasOwn(values, index)) fail(`${path}[${index}]`, 'must not be sparse');
    }
    return values.map((value, index) => mapper(value, index));
  } finally {
    active.delete(input);
  }
}

function containsControlCharacter(value) {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function boundedString(value, path, { max = MAX_ID_LENGTH, pattern = null } = {}) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || containsControlCharacter(value)) {
    fail(path, `must be a non-empty bounded string (max ${max})`);
  }
  if (pattern && !pattern.test(value)) fail(path, 'has an invalid format');
  return value;
}

function revision(value, path) {
  if (!Number.isSafeInteger(value) || value < 0) fail(path, 'must be a non-negative safe integer');
  return value;
}

function resourceKind(value, path) {
  if (!RESOURCE_KINDS.has(value)) fail(path, 'must be browser, page, or frame');
  return value;
}

function freezeArray(items) {
  return Object.freeze(items);
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function resourceIdentity(input, path, active, { browserOnly = false } = {}) {
  const value = snapshotDataObject(input, path, IDENTITY_KEYS, active);
  const kind = resourceKind(value.kind, `${path}.kind`);
  if (browserOnly && kind !== 'browser') fail(`${path}.kind`, 'must be browser');
  return Object.freeze({
    kind,
    id: boundedString(value.id, `${path}.id`),
    revision: revision(value.revision, `${path}.revision`),
  });
}

function createResourceRefInternal(input, path, active) {
  if (active.has(input)) fail(path, 'must not contain a cycle');
  active.add(input);
  try {
    const value = snapshotDataObject(input, path, RESOURCE_KEYS);
    if (value.schema !== RESOURCE_SCHEMA) fail(`${path}.schema`, `must equal ${RESOURCE_SCHEMA}`);
    const kind = resourceKind(value.kind, `${path}.kind`);
    const id = boundedString(value.id, `${path}.id`);
    const normalizedRevision = revision(value.revision, `${path}.revision`);
    const capabilities = mapDataArray(value.capabilities, `${path}.capabilities`, active, (capability, index) =>
      boundedString(capability, `${path}.capabilities[${index}]`, { max: 64, pattern: NAME_RE }));
    if (new Set(capabilities).size !== capabilities.length) fail(`${path}.capabilities`, 'must not contain a duplicate capability');
    capabilities.sort();
    const links = mapDataArray(value.links, `${path}.links`, active, (link, index) => {
      if (active.has(link)) fail(`${path}.links[${index}]`, 'must not contain a cycle');
      active.add(link);
      try {
        const snapshot = snapshotDataObject(link, `${path}.links[${index}]`, LINK_KEYS);
        return Object.freeze({
          relation: boundedString(snapshot.relation, `${path}.links[${index}].relation`, { max: 64, pattern: NAME_RE }),
          kind: resourceKind(snapshot.kind, `${path}.links[${index}].kind`),
          id: boundedString(snapshot.id, `${path}.links[${index}].id`),
          revision: revision(snapshot.revision, `${path}.links[${index}].revision`),
        });
      } finally {
        active.delete(link);
      }
    });
    const linkKeys = links.map(link => `${link.relation}\u0000${link.kind}\u0000${link.id}\u0000${link.revision}`);
    if (new Set(linkKeys).size !== linkKeys.length) fail(`${path}.links`, 'must not contain a duplicate link');
    links.sort((left, right) => (
      compareText(left.relation, right.relation)
      || compareText(left.kind, right.kind)
      || compareText(left.id, right.id)
      || left.revision - right.revision
    ));
    return Object.freeze({
      schema: RESOURCE_SCHEMA,
      kind,
      id,
      revision: normalizedRevision,
      capabilities: freezeArray(capabilities),
      links: freezeArray(links),
    });
  } finally {
    active.delete(input);
  }
}

export function createResourceRef(input) {
  return createResourceRefInternal(input, 'resource', new WeakSet());
}

function isLoopbackUrl(value) {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function isSensitivePublicKey(value) {
  const normalized = String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return ['authorization', 'proxyauthorization', 'cookie', 'setcookie', 'auth', 'key', 'session', 'sessionid']
    .includes(normalized)
    || /(?:token|apikey|secret|password|passwd|passphrase)$/.test(normalized);
}

function decodeRepeated(value, path) {
  let decoded = value;
  for (let count = 0; count < 4; count++) {
    let next;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      fail(path, 'contains invalid percent encoding');
    }
    if (next === decoded) return decoded;
    decoded = next;
  }
  try {
    if (decodeURIComponent(decoded) !== decoded) fail(path, 'is excessively encoded');
  } catch {
    fail(path, 'contains invalid percent encoding');
  }
  return decoded;
}

function assertSecretFreeUrl(value, path) {
  const parsed = new URL(value);
  if (parsed.username || parsed.password) fail(path, 'must not contain URL credentials');
  for (const key of parsed.searchParams.keys()) {
    if (isSensitivePublicKey(decodeRepeated(key, path))) fail(path, 'must not contain credential-bearing query parameters');
  }
  const query = decodeRepeated(parsed.search.slice(1), path);
  if (SENSITIVE_ASSIGNMENT_RE.test(query)) fail(path, 'must not contain credential-bearing query parameters');
  const fragment = decodeRepeated(parsed.hash.slice(1), path);
  if (SENSITIVE_ASSIGNMENT_RE.test(fragment)) fail(path, 'must not contain a credential-bearing fragment');
}

function createLocatorPlanInternal(input, path, active, depth, budget) {
  if (depth > MAX_LOCATOR_DEPTH) fail(path, `exceeds maximum depth ${MAX_LOCATOR_DEPTH}`);
  if (active.has(input)) fail(path, 'must not contain a cycle');
  if (budget.remaining <= 0) fail('locator.fallbacks', `must describe at most ${MAX_RESOLUTION_ATTEMPTS} attempts`);
  budget.remaining -= 1;
  active.add(input);
  try {
    const value = snapshotDataObject(input, path, LOCATOR_KEYS);
    if (value.schema !== LOCATOR_SCHEMA) fail(`${path}.schema`, `must equal ${LOCATOR_SCHEMA}`);
    if (!LOCATOR_STRATEGIES.has(value.strategy)) fail(`${path}.strategy`, 'is unknown');
    let locatorValue = value.value;
    if (value.strategy === 'current-page') {
      if (locatorValue !== null) fail(`${path}.value`, 'must be null for current-page');
    } else {
      locatorValue = boundedString(locatorValue, `${path}.value`);
    }
    if (value.strategy === 'alias') {
      locatorValue = boundedString(locatorValue, `${path}.value`, { max: 64, pattern: ALIAS_RE });
    }
    if (value.strategy === 'url') {
      if (!isLoopbackUrl(locatorValue)) fail(`${path}.value`, 'must be a loopback URL');
      assertSecretFreeUrl(locatorValue, `${path}.value`);
    }
    const scope = value.scope === null
      ? null
      : resourceIdentity(value.scope, `${path}.scope`, active, { browserOnly: true });
    const fallbacks = mapDataArray(
      value.fallbacks,
      `${path}.fallbacks`,
      active,
      (fallback, index) => createLocatorPlanInternal(fallback, `${path}.fallbacks[${index}]`, active, depth + 1, budget),
      { maxLength: MAX_RESOLUTION_ATTEMPTS },
    );
    const keys = fallbacks.map(fallback => JSON.stringify(fallback));
    if (new Set(keys).size !== keys.length) fail(`${path}.fallbacks`, 'must not contain a duplicate fallback');
    return Object.freeze({
      schema: LOCATOR_SCHEMA,
      strategy: value.strategy,
      value: locatorValue,
      scope,
      fallbacks: freezeArray(fallbacks),
    });
  } finally {
    active.delete(input);
  }
}

export function createLocatorPlan(input) {
  const locator = createLocatorPlanInternal(input, 'locator', new WeakSet(), 0, {
    remaining: MAX_RESOLUTION_ATTEMPTS,
  });
  const attempts = flattenPlans(locator);
  if (attempts.length > MAX_RESOLUTION_ATTEMPTS) {
    fail('locator.fallbacks', `must describe at most ${MAX_RESOLUTION_ATTEMPTS} attempts`);
  }
  const keys = attempts.map(attempt => JSON.stringify(attempt));
  if (new Set(keys).size !== keys.length) fail('locator.fallbacks', 'must not contain a duplicate fallback');
  return locator;
}

function sameIdentity(left, right) {
  return left?.kind === right?.kind && left?.id === right?.id && left?.revision === right?.revision;
}

function snapshotCandidate(input, index) {
  const path = `discovery[${index}]`;
  const value = snapshotDataObject(input, path, CANDIDATE_KEYS);
  const resource = createResourceRefInternal(value.resource, `${path}.resource`, new WeakSet());
  if (resource.kind !== 'page') fail(`${path}.resource.kind`, 'must be page');
  const targetId = boundedString(value.targetId, `${path}.targetId`);
  const aliases = mapDataArray(
    value.aliases,
    `${path}.aliases`,
    new WeakSet(),
    (alias, aliasIndex) => boundedString(alias, `${path}.aliases[${aliasIndex}]`, { max: 64, pattern: ALIAS_RE }),
  );
  if (new Set(aliases).size !== aliases.length) fail(`${path}.aliases`, 'must not contain duplicates');
  if (typeof value.url !== 'string' || value.url.length > 2048) fail(`${path}.url`, 'must be a bounded string');
  if (typeof value.current !== 'boolean') fail(`${path}.current`, 'must be boolean');
  const browser = resourceIdentity(value.browser, `${path}.browser`, new WeakSet(), { browserOnly: true });
  const browserLinks = resource.links.filter(link => link.relation === 'browser');
  if (browserLinks.length !== 1) fail(`${path}.resource.links`, 'must contain exactly one browser link');
  if (browserLinks[0].kind !== 'browser') fail(`${path}.resource.links`, 'browser link kind must be browser');
  if (!sameIdentity(browserLinks[0], browser)) {
    fail(`${path}.resource.links`, 'browser link must match the discovery browser');
  }
  return Object.freeze({ resource, targetId, aliases: freezeArray([...aliases]), url: value.url, current: value.current, browser });
}

function flattenPlans(plan, output = []) {
  output.push(plan);
  for (const fallback of plan.fallbacks) flattenPlans(fallback, output);
  return output;
}

function planMatchesCandidate(plan, entry) {
  if (plan.scope && !sameIdentity(plan.scope, entry.browser)) return false;
  if (plan.strategy === 'exact-target') return entry.targetId === plan.value;
  if (plan.strategy === 'target-prefix') return entry.targetId.startsWith(plan.value);
  if (plan.strategy === 'alias') return entry.aliases.includes(plan.value);
  if (plan.strategy === 'current-page') return entry.current;
  if (plan.strategy === 'url') return entry.url === plan.value;
  return false;
}

async function resolveLocatorEntry(input, {
  discover,
  maxAttempts = MAX_RESOLUTION_ATTEMPTS,
} = {}) {
  if (typeof discover !== 'function') fail('discover', 'must be a function');
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0 || maxAttempts > MAX_RESOLUTION_ATTEMPTS) {
    fail('maxAttempts', `must be between 1 and ${MAX_RESOLUTION_ATTEMPTS}`);
  }
  const locator = createLocatorPlan(input);
  const attempts = flattenPlans(locator);
  for (let index = 0; index < attempts.length; index++) {
    if (index >= maxAttempts) fail('locator', `attempt limit ${maxAttempts} exceeded`);
    const discovered = await discover();
    const entries = mapDataArray(
      discovered,
      'discovery',
      new WeakSet(),
      snapshotCandidate,
      { maxLength: MAX_DISCOVERY_ENTRIES },
    );
    const matches = entries.filter(entry => planMatchesCandidate(attempts[index], entry));
    if (matches.length > 1) fail(`locator attempt ${index + 1}`, 'is ambiguous');
    if (matches.length === 1) return matches[0];
  }
  fail('locator', 'resolution exhausted without a unique live resource');
}

export async function resolveLocatorPlan(input, options = {}) {
  return (await resolveLocatorEntry(input, options)).resource;
}

export async function resolveLocatorPlanToHandle(input, {
  discover,
  endpointFor,
  transportFor,
  maxAttempts = MAX_RESOLUTION_ATTEMPTS,
} = {}) {
  if (typeof endpointFor !== 'function') fail('endpointFor', 'must be a function');
  if (typeof transportFor !== 'function') fail('transportFor', 'must be a function');
  const entry = await resolveLocatorEntry(input, { discover, maxAttempts });
  const endpoint = endpointFor(entry.targetId, entry.browser);
  boundedString(endpoint, 'endpointFor result', { max: 1024 });
  const transport = transportFor(Object.freeze({
    resource: entry.resource,
    targetId: entry.targetId,
    endpoint,
    browser: entry.browser,
  }));
  return createResolvedHandle({
    resource: entry.resource,
    targetId: entry.targetId,
    endpoint,
    transport,
  });
}

function definePrivateMethod(target, name, value) {
  Object.defineProperty(target, name, {
    value,
    configurable: false,
    enumerable: false,
    writable: false,
  });
}

export function createResolvedHandle(input) {
  const value = snapshotDataObject(input, 'resolvedHandle', HANDLE_KEYS);
  const resource = createResourceRef(value.resource);
  const targetId = boundedString(value.targetId, 'resolvedHandle.targetId');
  const endpoint = boundedString(value.endpoint, 'resolvedHandle.endpoint', { max: 1024 });
  const transport = snapshotDataObject(value.transport, 'resolvedHandle.transport', new Set(['request', 'resource']));
  if (typeof transport.request !== 'function') fail('resolvedHandle.transport.request', 'must be a function');
  if (transport.resource !== undefined && typeof transport.resource !== 'function') fail('resolvedHandle.transport.resource', 'must be a function');

  const target = Object.create(null);
  definePrivateMethod(target, 'resource', () => transport.resource ? createResourceRef(transport.resource()) : resource);
  definePrivateMethod(target, 'execute', request => transport.request.call(value.transport, request, { targetId, endpoint }));
  definePrivateMethod(target, 'toJSON', () => { throw new Error('private ResolvedHandle cannot be serialized'); });
  Object.freeze(target);
  const handle = new Proxy(target, {});
  resolvedHandles.add(handle);
  return handle;
}

export function isResolvedHandle(value) {
  return Boolean(value && typeof value === 'object' && resolvedHandles.has(value));
}
