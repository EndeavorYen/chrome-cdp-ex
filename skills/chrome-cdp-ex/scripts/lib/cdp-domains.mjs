import { inspectRawCdpAuthorization } from './command-application.mjs';

export const CDP_METHODS = Object.freeze([
  'Accessibility.getFullAXTree',
  'CSS.enable',
  'CSS.getComputedStyleForNode',
  'CSS.getMatchedStylesForNode',
  'CSS.getStyleSheetText',
  'DOM.describeNode',
  'DOM.enable',
  'DOM.getDocument',
  'DOM.getFrameOwner',
  'DOM.pushNodesByBackendIdsToFrontend',
  'DOM.querySelector',
  'DOM.querySelectorAll',
  'DOM.resolveNode',
  'DOM.setFileInputFiles',
  'Emulation.setDeviceMetricsOverride',
  'Emulation.setEmulatedMedia',
  'Fetch.continueRequest',
  'Fetch.disable',
  'Fetch.enable',
  'Fetch.fulfillRequest',
  'Input.dispatchKeyEvent',
  'Input.dispatchMouseEvent',
  'Input.insertText',
  'Network.deleteCookies',
  'Network.emulateNetworkConditions',
  'Network.enable',
  'Network.getCookies',
  'Network.setCookie',
  'Page.addScriptToEvaluateOnNewDocument',
  'Page.captureScreenshot',
  'Page.createIsolatedWorld',
  'Page.enable',
  'Page.getFrameTree',
  'Page.getLayoutMetrics',
  'Page.getNavigationHistory',
  'Page.handleJavaScriptDialog',
  'Page.navigate',
  'Page.navigateToHistoryEntry',
  'Page.reload',
  'Page.removeScriptToEvaluateOnNewDocument',
  'Page.screencastFrameAck',
  'Page.startScreencast',
  'Page.stopScreencast',
  'Performance.enable',
  'Performance.getMetrics',
  'Runtime.callFunctionOn',
  'Runtime.enable',
  'Runtime.evaluate',
  'Target.activateTarget',
  'Target.attachToTarget',
  'Target.closeTarget',
  'Target.createTarget',
  'Target.getTargets',
]);

const TRANSPORT_KEYS = new Set(['send']);
const MAX_PARAM_DEPTH = 64;
const MAX_PARAM_NODES = 10_000;

function fail(path, message) {
  throw new Error(`${path}: ${message}`);
}

function snapshotTransport(input) {
  if (!input || Array.isArray(input) || typeof input !== 'object') {
    fail('transport', 'must be a plain data object');
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    fail('transport.send', 'must be an own data property');
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key === 'symbol') fail('transport', 'symbol keys are not allowed');
    if (!TRANSPORT_KEYS.has(key)) fail(`transport.${key}`, 'is not allowed');
    if (!Object.hasOwn(descriptors[key], 'value')) fail(`transport.${key}`, 'must be an own data property');
  }
  const descriptor = descriptors.send;
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('transport.send', 'must be an own data property');
  if (typeof descriptor.value !== 'function') fail('transport.send', 'must be a function');
  return Object.freeze({ send: descriptor.value });
}

function validateParamValue(value, path, state, depth = 0) {
  state.nodes += 1;
  if (state.nodes > MAX_PARAM_NODES) fail(path, 'exceeds maximum data size');
  if (value === null
    || typeof value === 'string' || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))) return;
  if (typeof value !== 'object') fail(path, 'must contain JSON-compatible data');
  if (depth > MAX_PARAM_DEPTH) fail(path, 'exceeds maximum nesting depth');
  if (state.active.has(value)) fail(path, 'must not contain cycles');
  state.active.add(value);
  try {
    const keys = Reflect.ownKeys(value);
    if (state.nodes + keys.filter(key => key !== 'length').length > MAX_PARAM_NODES) {
      fail(path, 'exceeds maximum data size');
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) fail(path, 'must be a plain data array');
      for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key === 'symbol') fail(path, 'symbol keys are not allowed');
        if (key === 'length') continue;
        if (!/^\d+$/.test(key)) fail(`${path}.${key}`, 'is not allowed');
        if (!Object.hasOwn(descriptors[key], 'value')) fail(`${path}[${key}]`, 'must be a data property');
        if (descriptors[key].enumerable !== true) fail(`${path}[${key}]`, 'must be enumerable JSON data');
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[index];
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail(`${path}[${index}]`, 'must not be sparse');
        validateParamValue(descriptor.value, `${path}[${index}]`, state, depth + 1);
      }
      return;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail(path, 'must be a plain data object');
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key === 'symbol') fail(path, 'symbol keys are not allowed');
      const descriptor = descriptors[key];
      if (!Object.hasOwn(descriptor, 'value')) fail(`${path}.${key}`, 'must be a data property');
      if (descriptor.enumerable !== true) fail(`${path}.${key}`, 'must be enumerable JSON data');
      validateParamValue(descriptor.value, `${path}.${key}`, state, depth + 1);
    }
  } finally {
    state.active.delete(value);
  }
}

function dispatch(send, method, args) {
  if (args.length > 3) fail('arguments', 'must contain at most params, session, and timeout');
  if (args.length > 0) {
    const params = args[0];
    if (!params || Array.isArray(params) || typeof params !== 'object') {
      fail('params', 'must be a plain data object');
    }
    validateParamValue(params, 'params', { active: new WeakSet(), nodes: 0 });
  }
  if (args.length > 1 && args[1] !== undefined && typeof args[1] !== 'string') {
    fail('session', 'must be a string or undefined');
  }
  if (args.length > 2 && args[2] !== undefined
    && (typeof args[2] !== 'number' || !Number.isFinite(args[2]) || args[2] <= 0)) {
    fail('timeout', 'must be a positive finite number or undefined');
  }
  return send(method, ...args);
}

export function bindCdpTransport(input) {
  if (!input || (typeof input !== 'object' && typeof input !== 'function')) {
    fail('cdp', 'must be an object');
  }
  let cursor = input;
  let descriptor = null;
  while (cursor && cursor !== Object.prototype) {
    const candidate = Object.getOwnPropertyDescriptor(cursor, 'send');
    if (candidate) {
      descriptor = candidate;
      break;
    }
    cursor = Object.getPrototypeOf(cursor);
  }
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
    fail('cdp.send', 'must resolve to a data method, not an accessor');
  }
  if (typeof descriptor.value !== 'function') fail('cdp.send', 'must be a function');
  return Object.freeze({ send: descriptor.value.bind(input) });
}

function buildDomains(send) {
  const domains = Object.create(null);
  for (const method of CDP_METHODS) {
    const separator = method.indexOf('.');
    const domain = method.slice(0, separator);
    const operation = method.slice(separator + 1);
    if (!Object.hasOwn(domains, domain)) domains[domain] = Object.create(null);
    Object.defineProperty(domains[domain], operation, {
      value: (...args) => dispatch(send, method, args),
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  for (const domain of Object.values(domains)) Object.freeze(domain);
  return Object.freeze(domains);
}

export function createCdpDomains(transportInput) {
  const { send } = snapshotTransport(transportInput);
  return buildDomains(send);
}

export function createRawCdpGateway(transportInput, authorization) {
  const authority = inspectRawCdpAuthorization(authorization);
  const { send } = snapshotTransport(transportInput);
  return Object.freeze({
    method: authority.method,
    sideEffectClass: authority.sideEffectClass,
    execute: (...args) => dispatch(send, authority.method, args),
  });
}
