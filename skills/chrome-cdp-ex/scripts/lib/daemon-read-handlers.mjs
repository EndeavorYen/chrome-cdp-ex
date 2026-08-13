import { commandResult } from './command-application.mjs';
import { parseTableArgs } from './table-contract.mjs';

const COMMANDS = Object.freeze([
  'cascade', 'checkpoint', 'components', 'console', 'controls', 'cookies', 'diff-shot', 'elshot', 'export-playwright', 'frame', 'fullshot', 'html', 'net', 'overlay',
  'record', 'record-actions', 'scanshot', 'shot', 'snap', 'status', 'styles', 'summary', 'table', 'text',
  'wait', 'waitfor',
]);
const HANDLER_CONTEXT_KEYS = new Set(['args', 'targetBound', 'spec', 'authorization', 'execution']);

function fail(path, message) {
  throw new Error(`${path}: ${message}`);
}

function snapshotObject(value, path) {
  if (!value || Array.isArray(value) || typeof value !== 'object') fail(path, 'must be a plain data object');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(path, 'must be a plain data object');
  const snapshot = Object.create(null);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key === 'symbol') fail(path, 'symbol keys are not allowed');
    if (!Object.hasOwn(descriptors[key], 'value')) fail(`${path}.${key}`, 'must be an own data property');
    Object.defineProperty(snapshot, key, {
      value: descriptors[key].value,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return snapshot;
}

function snapshotArgs(contextInput) {
  const context = snapshotObject(contextInput, 'handler context');
  for (const key of Object.keys(context)) {
    if (!HANDLER_CONTEXT_KEYS.has(key)) fail(`handler context.${key}`, 'is not allowed');
  }
  if (!Object.hasOwn(context, 'args')) fail('handler context.args', 'is required');
  if (!Array.isArray(context.args) || Object.getPrototypeOf(context.args) !== Array.prototype) {
    fail('handler context.args', 'must use the standard array prototype');
  }
  const descriptors = Object.getOwnPropertyDescriptors(context.args);
  const args = [];
  for (let index = 0; index < context.args.length; index += 1) {
    const descriptor = descriptors[index];
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail(`handler context.args[${index}]`, 'must be an own data property');
    if (typeof descriptor.value !== 'string') fail(`handler context.args[${index}]`, 'must be a string');
    args.push(descriptor.value);
  }
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key === 'symbol') fail('handler context.args', 'symbol keys are not allowed');
    if (key !== 'length' && !/^\d+$/.test(key)) fail(`handler context.args.${key}`, 'is not allowed');
    if (key !== 'length' && !Object.hasOwn(descriptors[key], 'value')) fail(`handler context.args[${key}]`, 'must be a data property');
  }
  return Object.freeze(args);
}

function snapshotExecution(contextInput) {
  const context = snapshotObject(contextInput, 'handler context');
  for (const key of Object.keys(context)) {
    if (!HANDLER_CONTEXT_KEYS.has(key)) fail(`handler context.${key}`, 'is not allowed');
  }
  return context.execution ?? null;
}

function snapshotCapabilities(input) {
  const capabilities = snapshotObject(input, 'capabilities');
  const actual = Object.keys(capabilities).sort();
  if (JSON.stringify(actual) !== JSON.stringify(COMMANDS)) {
    fail('capabilities', `must exactly cover ${COMMANDS.join(', ')}`);
  }
  for (const name of COMMANDS) {
    if (typeof capabilities[name] !== 'function') fail(`capabilities.${name}`, 'must be a function');
  }
  return capabilities;
}

export function createDaemonReadHandlers(input) {
  const capabilities = snapshotCapabilities(input);
  const handlers = Object.create(null);
  const implementations = {
    cascade: async context => commandResult(await capabilities.cascade(snapshotArgs(context)), null),
    checkpoint: async context => commandResult(await capabilities.checkpoint(snapshotArgs(context)), null),
    components: async context => commandResult(await capabilities.components(snapshotArgs(context)), null),
    console: async context => commandResult(await capabilities.console(snapshotArgs(context)), null),
    controls: async context => commandResult(await capabilities.controls(snapshotArgs(context)), null),
    cookies: async context => commandResult(await capabilities.cookies(snapshotArgs(context)), null),
    'diff-shot': async context => commandResult(await capabilities['diff-shot'](snapshotArgs(context)), null),
    elshot: async context => commandResult(await capabilities.elshot(snapshotArgs(context)), null),
    'export-playwright': async context => commandResult(await capabilities['export-playwright'](snapshotArgs(context)), null),
    frame: async context => commandResult(await capabilities.frame(snapshotArgs(context)), null),
    fullshot: async context => commandResult(await capabilities.fullshot(snapshotArgs(context)), null),
    html: async context => commandResult(await capabilities.html(snapshotArgs(context)), null),
    net: async context => commandResult(await capabilities.net(snapshotArgs(context)), null),
    overlay: async context => commandResult(await capabilities.overlay(snapshotArgs(context)), null),
    record: async context => commandResult(await capabilities.record(snapshotArgs(context)), null),
    'record-actions': async context => commandResult(await capabilities['record-actions'](snapshotArgs(context)), null),
    scanshot: async context => commandResult(await capabilities.scanshot(snapshotArgs(context)), null),
    shot: async context => commandResult(await capabilities.shot(snapshotArgs(context)), null),
    snap: async context => commandResult(await capabilities.snap(snapshotArgs(context)), null),
    status: async context => commandResult(await capabilities.status(snapshotArgs(context)), null),
    styles: async context => commandResult(await capabilities.styles(snapshotArgs(context)), null),
    summary: async context => commandResult(await capabilities.summary(snapshotArgs(context)), null),
    table: async context => {
      const request = parseTableArgs(snapshotArgs(context));
      if (request.mode === 'collect') {
        const execution = snapshotExecution(context);
        if (!execution) throw new Error('table: collection is unavailable in this v2.16 candidate');
        return commandResult(await capabilities.table(request, execution), null);
      }
      if (request.mode === 'continue') return commandResult(await capabilities.table(request), null);
      return commandResult(await capabilities.table(request), null);
    },
    text: async context => commandResult(await capabilities.text(snapshotArgs(context)), null),
    wait: async context => commandResult(await capabilities.wait(snapshotArgs(context)), null),
    waitfor: async context => commandResult(await capabilities.waitfor(snapshotArgs(context)), null),
  };
  for (const name of COMMANDS) {
    Object.defineProperty(handlers, name, {
      value: Object.freeze(implementations[name]),
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return Object.freeze(handlers);
}
