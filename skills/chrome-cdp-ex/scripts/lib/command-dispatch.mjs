import {
  defineCommandRequest,
  executeCommand,
  inspectCommandRegistry,
} from './command-application.mjs';

const ROUTE_OWNERS = new Set(['application', 'adapter']);
const DISPATCHERS = new WeakSet();
const OPTION_KEYS = new Set(['registry', 'owners', 'handlers', 'authorize']);

function fail(path, message) {
  throw new Error(`${path}: ${message}`);
}

function snapshotObject(value, path) {
  if (!value || Array.isArray(value) || typeof value !== 'object') fail(path, 'must be a plain data object');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(path, 'must be a plain data object');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const snapshot = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key === 'symbol') fail(path, 'symbol keys are not allowed');
    const descriptor = descriptors[key];
    if (!Object.hasOwn(descriptor, 'value')) fail(`${path}.${key}`, 'must be an own data property');
    Object.defineProperty(snapshot, key, {
      value: descriptor.value,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return snapshot;
}

function snapshotOwners(input, specs) {
  const values = snapshotObject(input, 'owners');
  const expected = specs.map(spec => spec.name).sort();
  const actual = Object.keys(values).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail('owners', `must exactly cover ${expected.length} canonical commands`);
  }
  const owners = Object.create(null);
  for (const name of expected) {
    if (!ROUTE_OWNERS.has(values[name])) fail(`owners.${name}`, 'must be application or adapter');
    Object.defineProperty(owners, name, {
      value: values[name], enumerable: true, configurable: false, writable: false,
    });
  }
  return Object.freeze(owners);
}

function snapshotHandlers(input, owners) {
  const values = snapshotObject(input, 'handlers');
  const expected = Object.keys(owners).filter(name => owners[name] === 'application').sort();
  const actual = Object.keys(values).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail('handlers', `must exactly cover ${expected.length} application commands`);
  }
  const handlers = Object.create(null);
  for (const name of expected) {
    if (typeof values[name] !== 'function') fail(`handlers.${name}`, 'must be a function');
    Object.defineProperty(handlers, name, {
      value: values[name], enumerable: true, configurable: false, writable: false,
    });
  }
  return Object.freeze(handlers);
}

export function createCommandDispatcher(input = {}) {
  const options = snapshotObject(input, 'dispatcher options');
  for (const key of Object.keys(options)) {
    if (!OPTION_KEYS.has(key)) fail(`dispatcher options.${key}`, 'is not allowed');
  }
  for (const key of ['registry', 'owners', 'handlers']) {
    if (!Object.hasOwn(options, key)) fail(`dispatcher options.${key}`, 'is required');
  }
  const { registry, owners, handlers, authorize } = options;
  const specs = inspectCommandRegistry(registry);
  const ownerSnapshot = snapshotOwners(owners, specs);
  const handlerSnapshot = snapshotHandlers(handlers, ownerSnapshot);
  if (authorize !== undefined && typeof authorize !== 'function') fail('authorize', 'must be a function');
  const dispatcher = Object.freeze({
    route(name) {
      const spec = registry.resolve(name);
      if (!spec) return null;
      return Object.freeze({
        command: spec.name,
        owner: ownerSnapshot[spec.name],
      });
    },
    async execute(request) {
      const requestSnapshot = defineCommandRequest(request);
      const spec = registry.resolve(requestSnapshot.name);
      if (!spec) fail('request.name', `unknown command ${requestSnapshot.name}`);
      if (ownerSnapshot[spec.name] === 'adapter') {
        return Object.freeze({ handled: false, command: spec.name, result: null });
      }
      const execution = await executeCommand({
        name: spec.name,
        args: requestSnapshot.args,
        targetBound: requestSnapshot.targetBound,
      }, {
        registry,
        handlers: handlerSnapshot,
        authorize,
      });
      return Object.freeze({ handled: true, command: spec.name, result: execution.value });
    },
    list() {
      return Object.freeze(specs.map(spec => Object.freeze({
        command: spec.name,
        owner: ownerSnapshot[spec.name],
      })));
    },
  });
  DISPATCHERS.add(dispatcher);
  return dispatcher;
}

export function inspectCommandDispatcher(dispatcher) {
  if (!DISPATCHERS.has(dispatcher)) fail('dispatcher', 'must be created by createCommandDispatcher factory');
  return dispatcher.list();
}
