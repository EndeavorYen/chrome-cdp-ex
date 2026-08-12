import { executeCdpCli } from '../cdp.mjs';

const RUNTIME_CLIENTS = new WeakSet();

function fail(path, message) {
  throw new Error(`${path}: ${message}`);
}

function snapshotOptions(input) {
  if (input === undefined) return { executeCli: executeCdpCli };
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.getPrototypeOf(input) !== Object.prototype) {
    fail('runtimeClient.options', 'must be a plain object');
  }
  const keys = Reflect.ownKeys(input);
  if (keys.some(key => typeof key === 'symbol')) fail('runtimeClient.options', 'symbol keys are not allowed');
  if (keys.some(key => key !== 'executeCli')) fail('runtimeClient.options', 'contains an unknown key');
  const descriptor = Object.getOwnPropertyDescriptor(input, 'executeCli');
  if (!descriptor) return { executeCli: executeCdpCli };
  if (!Object.hasOwn(descriptor, 'value')) fail('runtimeClient.options.executeCli', 'accessor properties are not allowed');
  if (typeof descriptor.value !== 'function') fail('runtimeClient.options.executeCli', 'must be a function');
  return { executeCli: descriptor.value };
}

function snapshotCommand(input) {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) {
    fail('runtimeClient.command', 'must be a plain array');
  }
  for (const key of Reflect.ownKeys(input)) {
    if (key === 'length') continue;
    if (typeof key === 'symbol' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= input.length) {
      fail('runtimeClient.command', 'contains an unknown key');
    }
  }
  const command = [];
  for (let index = 0; index < input.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      fail(`runtimeClient.command[${index}]`, 'must be an own data value');
    }
    if (typeof descriptor.value !== 'string') fail(`runtimeClient.command[${index}]`, 'must be a string');
    command.push(descriptor.value);
  }
  if (command.length > 0 && !command[0]) fail('runtimeClient.command[0]', 'must not be empty');
  return Object.freeze(command);
}

function normalizeResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || Object.getPrototypeOf(result) !== Object.prototype) {
    fail('runtimeClient.result', 'must be a plain object');
  }
  const values = {};
  const allowed = new Set(['code', 'stdout', 'stderr']);
  for (const key of Reflect.ownKeys(result)) {
    if (typeof key === 'symbol' || !allowed.has(key)) fail('runtimeClient.result', 'contains an unknown key');
    const descriptor = Object.getOwnPropertyDescriptor(result, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail(`runtimeClient.result.${key}`, 'accessor properties are not allowed');
    values[key] = descriptor.value;
  }
  for (const key of allowed) if (!Object.hasOwn(values, key)) fail(`runtimeClient.result.${key}`, 'is required');
  if (!Number.isInteger(values.code) || values.code < 0) fail('runtimeClient.result.code', 'must be a non-negative integer');
  if (typeof values.stdout !== 'string') fail('runtimeClient.result.stdout', 'must be a string');
  if (typeof values.stderr !== 'string') fail('runtimeClient.result.stderr', 'must be a string');
  return Object.freeze(values);
}

export function isRuntimeClient(value) {
  return Boolean(value && RUNTIME_CLIENTS.has(value));
}

export function createRuntimeClient(options) {
  const { executeCli } = snapshotOptions(options);
  const client = {
    async execute(input) {
      const command = snapshotCommand(input);
      return normalizeResult(await executeCli(command));
    },
  };
  Object.freeze(client);
  RUNTIME_CLIENTS.add(client);
  return client;
}
