const COMMANDS = Object.freeze([
  'back', 'clickxy', 'dismiss-modal', 'fill', 'forward', 'hover', 'jsclick',
  'nav', 'press', 'reload', 'scroll', 'select', 'type', 'verify-click',
]);
const CONTEXT_KEYS = new Set(['args', 'targetBound', 'spec', 'authorization']);
const MAX_ARGS = 256;
const MAX_ARG_BYTES = 65_536;

function fail(path, message) { throw new Error(`${path}: ${message}`); }

function snapshotObject(value, path) {
  if (!value || Array.isArray(value) || typeof value !== 'object') fail(path, 'must be a plain data object');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(path, 'must be a plain data object');
  const output = Object.create(null);
  for (const key of Reflect.ownKeys(Object.getOwnPropertyDescriptors(value))) {
    if (typeof key === 'symbol') fail(path, 'symbol keys are not allowed');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!Object.hasOwn(descriptor, 'value')) fail(`${path}.${key}`, 'must be an own data property');
    if (descriptor.enumerable !== true) fail(`${path}.${key}`, 'must be enumerable');
    Object.defineProperty(output, key, { value: descriptor.value, enumerable: true, writable: false, configurable: false });
  }
  return output;
}

function snapshotArgs(input) {
  const context = snapshotObject(input, 'handler context');
  for (const key of Object.keys(context)) if (!CONTEXT_KEYS.has(key)) fail(`handler context.${key}`, 'is not allowed');
  if (!Object.hasOwn(context, 'args')) fail('handler context.args', 'is required');
  if (!Array.isArray(context.args) || Object.getPrototypeOf(context.args) !== Array.prototype) {
    fail('handler context.args', 'must use the standard array prototype');
  }
  if (context.args.length > MAX_ARGS) fail('handler context.args', `must contain at most ${MAX_ARGS} entries`);
  const descriptors = Object.getOwnPropertyDescriptors(context.args);
  const args = [];
  for (let index = 0; index < context.args.length; index += 1) {
    const descriptor = descriptors[index];
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail(`handler context.args[${index}]`, 'must be an own data property');
    if (descriptor.enumerable !== true) fail(`handler context.args[${index}]`, 'must be enumerable');
    if (typeof descriptor.value !== 'string') fail(`handler context.args[${index}]`, 'must be a string');
    if (Buffer.byteLength(descriptor.value, 'utf8') > MAX_ARG_BYTES) {
      fail(`handler context.args[${index}]`, `must contain at most ${MAX_ARG_BYTES} bytes`);
    }
    args.push(descriptor.value);
  }
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key === 'symbol') fail('handler context.args', 'symbol keys are not allowed');
    if (key !== 'length' && !/^\d+$/.test(key)) fail(`handler context.args.${key}`, 'is not allowed');
  }
  return Object.freeze(args);
}

function snapshotCapabilities(input) {
  const capabilities = snapshotObject(input, 'capabilities');
  if (JSON.stringify(Object.keys(capabilities).sort()) !== JSON.stringify(COMMANDS)) {
    fail('capabilities', `must exactly cover ${COMMANDS.join(', ')}`);
  }
  for (const name of COMMANDS) if (typeof capabilities[name] !== 'function') fail(`capabilities.${name}`, 'must be a function');
  return capabilities;
}

export function createDaemonActionHandlers(input) {
  const capabilities = snapshotCapabilities(input);
  const handlers = Object.create(null);
  for (const name of COMMANDS) {
    Object.defineProperty(handlers, name, {
      value: Object.freeze(async context => capabilities[name](snapshotArgs(context))),
      enumerable: true, writable: false, configurable: false,
    });
  }
  return Object.freeze(handlers);
}
