const SPEC_KEYS = new Set([
  'name',
  'aliases',
  'needsTarget',
  'mutates',
  'feedbackPolicy',
  'outputFormats',
  'kind',
  'authorization',
  'evidencePolicy',
]);
const REQUEST_KEYS = new Set(['name', 'args', 'targetBound']);
const CONTEXT_KEYS = new Set(['registry', 'handlers', 'authorize', 'execution']);
const EXECUTION_CONTEXT_KEYS = new Set(['signal', 'deadline']);
const DEADLINE_KEYS = new Set(['startedAt', 'pageAt', 'serverAt', 'maxCdpOperationMs', 'now']);
const NAME_RE = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
const CODE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const COMMAND_KINDS = new Set([
  'read', 'mutation', 'protected-mutation', 'conditional-mutation', 'composite',
  'sensitive-read', 'script', 'evidence', 'raw-cdp',
]);
const AUTHORIZATION_POLICIES = new Set([
  'standard', 'mutation', 'conditional', 'composite', 'sensitive-read', 'raw-script', 'raw-cdp',
]);
const EVIDENCE_POLICIES = new Set(['none', 'action-receipt', 'session-report', 'raw-audit']);
const OUTPUT_FORMATS = new Set(['text', 'json']);
const RAW_SIDE_EFFECT_CLASSES = new Set(['read-only', 'potentially-mutating', 'unknown']);
const RAW_READ_ONLY_METHODS = new Set([
  'Accessibility.getFullAXTree',
  'Accessibility.getPartialAXTree',
  'Browser.getBrowserCommandLine',
  'Browser.getVersion',
  'Browser.getWindowBounds',
  'CSS.getComputedStyleForNode',
  'CSS.getMatchedStylesForNode',
  'CSS.getStyleSheetText',
  'DOM.describeNode',
  'DOM.getAttributes',
  'DOM.getBoxModel',
  'DOM.getDocument',
  'DOM.getOuterHTML',
  'DOM.querySelector',
  'DOM.querySelectorAll',
  'Network.getAllCookies',
  'Network.getCookies',
  'Network.getRequestPostData',
  'Network.getResponseBody',
  'Page.getFrameTree',
  'Page.getLayoutMetrics',
  'Performance.getMetrics',
  'Runtime.getIsolateId',
  'Runtime.getProperties',
  'Schema.getDomains',
  'Storage.getCookies',
  'Storage.getUsageAndQuota',
  'SystemInfo.getInfo',
  'SystemInfo.getProcessInfo',
  'Target.getTargetInfo',
  'Target.getTargets',
]);
const RAW_MUTATING_METHODS = new Set(['Runtime.callFunctionOn', 'Runtime.evaluate']);
const RESULT_EVIDENCE_KEYS = Object.freeze({
  'action-receipt': new Set(['kind']),
  'session-report': new Set(['kind']),
  'raw-audit': new Set(['kind', 'method', 'sideEffectClass']),
});
const EXPECTED_POLICY = Object.freeze({
  read: Object.freeze({ mutates: false, authorization: 'standard', evidencePolicy: 'none', feedback: false }),
  mutation: Object.freeze({ mutates: true, authorization: 'mutation', evidencePolicy: 'action-receipt', feedback: true }),
  'protected-mutation': Object.freeze({ mutates: false, authorization: 'mutation', evidencePolicy: 'none', feedback: false }),
  'conditional-mutation': Object.freeze({ mutates: false, authorization: 'conditional', evidencePolicy: 'none', feedback: false }),
  composite: Object.freeze({ mutates: false, authorization: 'composite', evidencePolicy: 'none', feedback: false }),
  'sensitive-read': Object.freeze({ mutates: false, authorization: 'sensitive-read', evidencePolicy: 'none', feedback: false }),
  script: Object.freeze({ mutates: false, authorization: 'raw-script', evidencePolicy: 'none', feedback: false }),
  evidence: Object.freeze({ mutates: false, authorization: 'standard', evidencePolicy: 'session-report', feedback: false }),
  'raw-cdp': Object.freeze({ mutates: false, authorization: 'raw-cdp', evidencePolicy: 'raw-audit', feedback: false }),
});
const COMMAND_RESULTS = new WeakSet();
const COMMAND_REGISTRIES = new WeakSet();
const RAW_CDP_AUTHORIZATIONS = new WeakSet();
const COMMAND_EXECUTION_CONTEXTS = new WeakSet();

function fail(path, message) {
  throw new Error(`${path}: ${message}`);
}

function assertObject(value, path) {
  if (!value || Array.isArray(value) || typeof value !== 'object') fail(path, 'must be an object');
}

function assertOnlyKeys(value, allowed, path) {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'symbol') fail(path, 'symbol keys are not allowed');
    if (!allowed.has(key)) fail(`${path}.${key}`, 'is not allowed');
  }
}

function assertExactKeys(value, allowed, path) {
  assertOnlyKeys(value, allowed, path);
  for (const key of allowed) if (!Object.hasOwn(value, key)) fail(`${path}.${key}`, 'is required');
}

function snapshotDataObject(value, path) {
  assertObject(value, path);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(path, 'must be a plain data object');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const snapshot = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key === 'symbol') fail(path, 'symbol keys are not allowed');
    const descriptor = descriptors[key];
    if (!Object.hasOwn(descriptor, 'value')) fail(`${path}.${key}`, 'must be an own data property, not an accessor');
    Object.defineProperty(snapshot, key, {
      value: descriptor.value,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return snapshot;
}

function snapshotArray(value, path) {
  if (!Array.isArray(value)) fail(path, 'must be an array');
  if (Object.getPrototypeOf(value) !== Array.prototype) fail(path, 'must use the standard array prototype');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key === 'symbol') fail(path, 'symbol keys are not allowed');
    if (key === 'length') continue;
    if (!/^\d+$/.test(key)) fail(`${path}.${key}`, 'is not allowed');
    if (!Object.hasOwn(descriptors[key], 'value')) fail(`${path}[${key}]`, 'must be a data property, not an accessor');
  }
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[index];
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail(`${path}[${index}]`, 'must be an own data property');
    result.push(descriptor.value);
  }
  return result;
}

function stringArray(value, path, allowed = null) {
  const values = snapshotArray(value, path);
  const seen = new Set();
  return values.map((entry, index) => {
    if (typeof entry !== 'string' || entry === '') fail(`${path}[${index}]`, 'must be a non-empty string');
    if (allowed && !allowed.has(entry)) fail(`${path}[${index}]`, 'is unknown');
    if (seen.has(entry)) fail(path, `contains duplicate ${entry}`);
    seen.add(entry);
    return entry;
  });
}

function commandArgv(value, path) {
  return snapshotArray(value, path).map((entry, index) => {
    if (typeof entry !== 'string') fail(`${path}[${index}]`, 'must be a string');
    return entry;
  });
}

function freezeRecord(value) {
  for (const key of Reflect.ownKeys(value)) {
    const child = value[key];
    if (child && typeof child === 'object' && !Object.isFrozen(child)) freezeRecord(child);
  }
  return Object.freeze(value);
}

export function defineCommandSpec(input) {
  const value = snapshotDataObject(input, 'spec');
  assertExactKeys(value, SPEC_KEYS, 'spec');
  if (typeof value.name !== 'string' || !NAME_RE.test(value.name)) fail('spec.name', 'must be a canonical command name');
  const aliases = stringArray(value.aliases, 'spec.aliases');
  aliases.forEach((alias, index) => {
    if (!NAME_RE.test(alias)) fail(`spec.aliases[${index}]`, 'must be a command name');
    if (alias === value.name) fail('spec.aliases', 'must not contain the canonical name');
  });
  if (typeof value.needsTarget !== 'boolean') fail('spec.needsTarget', 'must be boolean');
  if (typeof value.mutates !== 'boolean') fail('spec.mutates', 'must be boolean');
  if (value.feedbackPolicy !== null
    && (typeof value.feedbackPolicy !== 'string' || !NAME_RE.test(value.feedbackPolicy))) {
    fail('spec.feedbackPolicy', 'must be null or a stable policy name');
  }
  const outputFormats = stringArray(value.outputFormats, 'spec.outputFormats', OUTPUT_FORMATS);
  if (outputFormats.length === 0) fail('spec.outputFormats', 'must not be empty');
  if (!COMMAND_KINDS.has(value.kind)) fail('spec.kind', 'is unknown');
  if (!AUTHORIZATION_POLICIES.has(value.authorization)) fail('spec.authorization', 'is unknown');
  if (!EVIDENCE_POLICIES.has(value.evidencePolicy)) fail('spec.evidencePolicy', 'is unknown');

  const expected = EXPECTED_POLICY[value.kind];
  if (value.mutates !== expected.mutates) fail('spec.mutates', `must be ${expected.mutates} for ${value.kind}`);
  if (value.authorization !== expected.authorization) {
    fail('spec.authorization', `must be ${expected.authorization} for ${value.kind}`);
  }
  if (value.evidencePolicy !== expected.evidencePolicy) {
    fail('spec.evidencePolicy', `must be ${expected.evidencePolicy} for ${value.kind}`);
  }
  if (expected.feedback && value.feedbackPolicy === null) fail('spec.feedbackPolicy', 'is required for mutation');
  if (!expected.feedback && value.feedbackPolicy !== null) fail('spec.feedbackPolicy', `must be null for ${value.kind}`);

  return freezeRecord({
    name: value.name,
    aliases,
    needsTarget: value.needsTarget,
    mutates: value.mutates,
    feedbackPolicy: value.feedbackPolicy,
    outputFormats,
    kind: value.kind,
    authorization: value.authorization,
    evidencePolicy: value.evidencePolicy,
  });
}

export function createCommandRegistry(inputs) {
  const values = snapshotArray(inputs, 'specs');
  if (values.length === 0) fail('specs', 'must be a non-empty array');
  const specs = values.map(defineCommandSpec).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  const lookup = new Map();
  for (const entry of specs) {
    for (const spelling of [entry.name, ...entry.aliases]) {
      if (lookup.has(spelling)) {
        const prior = lookup.get(spelling);
        if (spelling === entry.name && prior.name === entry.name) fail('specs', `duplicate command ${spelling}`);
        fail('specs', `name or alias collision for ${spelling}`);
      }
      lookup.set(spelling, entry);
    }
  }
  const frozenSpecs = Object.freeze(specs);
  const registry = Object.freeze({
    resolve(name) {
      return typeof name === 'string' ? lookup.get(name) || null : null;
    },
    list() {
      return frozenSpecs;
    },
  });
  COMMAND_REGISTRIES.add(registry);
  return registry;
}

export function inspectCommandRegistry(registry) {
  if (!COMMAND_REGISTRIES.has(registry)) fail('registry', 'must be created by createCommandRegistry factory');
  return registry.list();
}

function validateEvidence(evidence) {
  if (evidence === null) return null;
  const value = snapshotDataObject(evidence, 'evidence');
  if (typeof value.kind !== 'string' || !RESULT_EVIDENCE_KEYS[value.kind]) fail('evidence.kind', 'is unknown');
  assertExactKeys(value, RESULT_EVIDENCE_KEYS[value.kind], 'evidence');
  if (value.kind === 'raw-audit') {
    if (typeof value.method !== 'string' || value.method.length > 128
      || !/^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/.test(value.method)) {
      fail('evidence.method', 'must be a bounded CDP method name');
    }
    if (!RAW_SIDE_EFFECT_CLASSES.has(value.sideEffectClass)) fail('evidence.sideEffectClass', 'is unknown');
    return Object.freeze({ kind: value.kind, method: value.method, sideEffectClass: value.sideEffectClass });
  }
  return Object.freeze({ kind: value.kind });
}

export function commandResult(value, evidence = null) {
  if (typeof value !== 'string') fail('value', 'must be a string');
  const result = Object.freeze({ value, evidence: validateEvidence(evidence) });
  COMMAND_RESULTS.add(result);
  return result;
}

export function defineCommandRequest(input) {
  const value = snapshotDataObject(input, 'request');
  assertExactKeys(value, REQUEST_KEYS, 'request');
  if (typeof value.name !== 'string' || value.name === '') fail('request.name', 'must be a command name');
  const args = commandArgv(value.args, 'request.args');
  if (typeof value.targetBound !== 'boolean') fail('request.targetBound', 'must be boolean');
  return Object.freeze({ name: value.name, args: Object.freeze(args), targetBound: value.targetBound });
}

function isAbortSignal(value) {
  return value
    && typeof value === 'object'
    && typeof value.aborted === 'boolean'
    && typeof value.addEventListener === 'function'
    && typeof value.removeEventListener === 'function'
    && typeof value.throwIfAborted === 'function';
}

export function createCommandExecutionContext(input) {
  const value = snapshotDataObject(input, 'execution context');
  assertExactKeys(value, EXECUTION_CONTEXT_KEYS, 'execution context');
  if (!isAbortSignal(value.signal)) fail('execution context.signal', 'must be an AbortSignal');
  let deadline = null;
  if (value.deadline !== null) {
    const candidate = snapshotDataObject(value.deadline, 'execution context.deadline');
    assertExactKeys(candidate, DEADLINE_KEYS, 'execution context.deadline');
    for (const key of ['startedAt', 'pageAt', 'serverAt', 'maxCdpOperationMs']) {
      if (!Number.isFinite(candidate[key]) || candidate[key] < 0) {
        fail(`execution context.deadline.${key}`, 'must be a finite non-negative number');
      }
    }
    if (candidate.pageAt < candidate.startedAt) {
      fail('execution context.deadline.pageAt', 'must not precede startedAt');
    }
    if (candidate.serverAt < candidate.pageAt) {
      fail('execution context.deadline.serverAt', 'must not precede pageAt');
    }
    if (candidate.maxCdpOperationMs <= 0) {
      fail('execution context.deadline.maxCdpOperationMs', 'must be greater than zero');
    }
    if (typeof candidate.now !== 'function') fail('execution context.deadline.now', 'must be a function');
    deadline = Object.freeze({
      startedAt: candidate.startedAt,
      pageAt: candidate.pageAt,
      serverAt: candidate.serverAt,
      maxCdpOperationMs: candidate.maxCdpOperationMs,
      now: candidate.now,
    });
  }
  const context = Object.freeze({ signal: value.signal, deadline });
  COMMAND_EXECUTION_CONTEXTS.add(context);
  return context;
}

export function inspectCommandExecutionContext(value) {
  if (!COMMAND_EXECUTION_CONTEXTS.has(value)) fail('execution context', 'must be created by createCommandExecutionContext');
  return value;
}

function validateAuthorizationDecision(input) {
  const value = snapshotDataObject(input, 'authorization');
  assertExactKeys(value, new Set(['allowed', 'code']), 'authorization');
  if (typeof value.allowed !== 'boolean') fail('authorization.allowed', 'must be boolean');
  if (typeof value.code !== 'string' || value.code.length > 64 || !CODE_RE.test(value.code)) {
    fail('authorization.code', 'must be a bounded stable code');
  }
  return Object.freeze({ allowed: value.allowed, code: value.code });
}

export function classifyRawCdpMethod(method) {
  if (typeof method !== 'string' || !/^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/.test(method)) return 'unknown';
  if (RAW_READ_ONLY_METHODS.has(method)) return 'read-only';
  if (RAW_MUTATING_METHODS.has(method)) return 'potentially-mutating';
  const operation = method.slice(method.indexOf('.') + 1).toLowerCase();
  if (/^(?:set|remove|delete|enable|disable|navigate|reload|evaluate|call|dispatch|insert|add|clear|close|create|grant|reset|stop|start|emulate|handle|continue|fulfill|fail|release)/.test(operation)) {
    return 'potentially-mutating';
  }
  return 'unknown';
}

function mintRawCdpAuthorization(method) {
  const authorization = Object.freeze({
    method,
    sideEffectClass: classifyRawCdpMethod(method),
  });
  RAW_CDP_AUTHORIZATIONS.add(authorization);
  return authorization;
}

export function inspectRawCdpAuthorization(value) {
  if (!RAW_CDP_AUTHORIZATIONS.has(value)) fail('authorization', 'must be minted by authorized raw command execution');
  return value;
}

function validateResultPolicy(result, spec, request) {
  if (!COMMAND_RESULTS.has(result)) fail('command result', 'must be created by commandResult');
  const expectedKind = spec.evidencePolicy === 'none' ? null : spec.evidencePolicy;
  const actualKind = result.evidence?.kind || null;
  if (actualKind !== expectedKind) {
    fail('command result.evidence', `must match ${spec.evidencePolicy}`);
  }
  if (spec.evidencePolicy === 'raw-audit') {
    const requestMethod = request.args[0];
    if (result.evidence.method !== requestMethod) fail('command result.evidence.method', 'must match the raw request method');
    const expectedSideEffectClass = classifyRawCdpMethod(requestMethod);
    if (result.evidence.sideEffectClass !== expectedSideEffectClass) {
      fail('command result.evidence.sideEffectClass', `must match trusted side-effect classification ${expectedSideEffectClass}`);
    }
  }
}

export async function executeCommand(requestInput, context = {}) {
  const request = defineCommandRequest(requestInput);
  const contextValue = snapshotDataObject(context, 'context');
  assertOnlyKeys(contextValue, CONTEXT_KEYS, 'context');
  if (!COMMAND_REGISTRIES.has(contextValue.registry)) fail('context.registry', 'must be created by createCommandRegistry factory');
  const spec = contextValue.registry.resolve(request.name);
  if (!spec) fail('request.name', `unknown command ${request.name}`);
  if (spec.needsTarget && !request.targetBound) fail('request.targetBound', `target is required for ${spec.name}`);
  const handlers = snapshotDataObject(contextValue.handlers, 'handlers');
  if (!Object.hasOwn(handlers, spec.name)) fail(`handlers.${spec.name}`, 'own handler data property is required');
  const handler = handlers[spec.name];
  if (typeof handler !== 'function') fail(`handlers.${spec.name}`, 'handler is required');
  const executionContext = contextValue.execution === undefined
    ? null
    : inspectCommandExecutionContext(contextValue.execution);

  let decision;
  if (spec.authorization === 'standard') {
    decision = Object.freeze({ allowed: true, code: 'not-required' });
  } else {
    if (typeof contextValue.authorize !== 'function') fail('context.authorize', `authorizer is required for ${spec.authorization}`);
    decision = validateAuthorizationDecision(await contextValue.authorize(Object.freeze({
      command: spec.name,
      args: request.args,
      policy: spec.authorization,
      mutates: spec.mutates,
      targetBound: request.targetBound,
    })));
    if (!decision.allowed) fail('authorization', `authorization denied for ${spec.name}`);
  }

  const rawAuthorization = spec.authorization === 'raw-cdp'
    ? mintRawCdpAuthorization(request.args[0])
    : null;
  const handlerContext = {
    args: request.args,
    targetBound: request.targetBound,
    spec,
    authorization: rawAuthorization,
    ...(executionContext ? { execution: executionContext } : {}),
  };
  const result = await handler(Object.freeze(handlerContext));
  validateResultPolicy(result, spec, request);
  return freezeRecord({
    schema: 'chrome-cdp-ex.command-execution.v1',
    command: spec.name,
    kind: spec.kind,
    value: result.value,
    authorization: {
      policy: spec.authorization,
      allowed: decision.allowed,
      code: decision.code,
    },
    evidence: result.evidence,
  });
}
