import { isProxy } from 'node:util/types';

const MAX_ARGV_ITEMS = 16;
const MAX_SELECTOR_BYTES = 1_024;
const CONTINUATION_TOKEN_RE = /^ct1\.[0-9a-f]{32}\.(?:0|[1-9][0-9]{0,5})$/;
const VALUE_FLAGS = new Set([
  '--format',
  '--scroll-container',
  '--load-more',
  '--row-key-column',
  '--continue',
]);
const KNOWN_FLAGS = new Set(['--collect', ...VALUE_FLAGS]);

function fail(message) {
  throw new Error(`table: ${message}`);
}

function snapshotArgv(input, path = 'argv') {
  if (isProxy(input)) fail(`${path} must not be a proxy`);
  if (!Array.isArray(input)) fail(`${path} must be an array`);
  if (Object.getPrototypeOf(input) !== Array.prototype) {
    fail(`${path} must use the standard array prototype`);
  }
  if (!Number.isSafeInteger(input.length) || input.length > MAX_ARGV_ITEMS) {
    fail(`${path} exceeds the ${MAX_ARGV_ITEMS}-item limit`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key === 'symbol') fail(`${path} symbol keys are not allowed`);
    if (key === 'length') continue;
    if (!/^(?:0|[1-9][0-9]*)$/.test(key)) fail(`${path}.${key} is not allowed`);
    const index = Number(key);
    if (!Number.isSafeInteger(index) || index >= input.length) fail(`${path}.${key} is not allowed`);
  }
  const argv = [];
  for (let index = 0; index < input.length; index += 1) {
    const descriptor = descriptors[index];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
      fail(`${path}[${index}] must be an own enumerable data property`);
    }
    if (typeof descriptor.value !== 'string') fail(`${path}[${index}] must be a string`);
    argv.push(descriptor.value);
  }
  return Object.freeze(argv);
}

function isWellFormedUnicode(value) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function selectorValue(value, label) {
  if (value.length === 0) fail(`${label} selector must be non-empty`);
  if (!isWellFormedUnicode(value)) fail(`${label} selector must use well-formed Unicode`);
  if (Buffer.byteLength(value, 'utf8') > MAX_SELECTOR_BYTES) {
    fail(`${label} selector exceeds 1,024 UTF-8 bytes`);
  }
  return value;
}

function requiredFlagValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.length === 0 || value.startsWith('--')) {
    fail(`${flag} requires a value`);
  }
  return value;
}

function canonicalRowKeyColumn(value) {
  if (!/^(?:0|[1-9][0-9]{0,2})$/.test(value)) {
    fail('--row-key-column must be canonical decimal in 0..255');
  }
  const parsed = Number(value);
  if (parsed > 255) fail('--row-key-column must be canonical decimal in 0..255');
  return parsed;
}

function parseSnapshot(argv) {
  const seen = new Set();
  let collect = false;
  let selector = null;
  let format = null;
  let scrollContainer = null;
  let loadMore = null;
  let rowKeyColumn = null;
  let continuation = null;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      if (selector !== null) fail('at most one positional table selector is allowed');
      selector = selectorValue(token, 'table');
      continue;
    }
    if (!KNOWN_FLAGS.has(token)) fail(`unknown flag ${token}`);
    if (seen.has(token)) fail(`duplicate ${token} flag`);
    seen.add(token);
    if (token === '--collect') {
      collect = true;
      continue;
    }
    const value = requiredFlagValue(argv, index, token);
    index += 1;
    if (token === '--format') {
      if (value !== 'text' && value !== 'json') fail('--format value must be text or json');
      format = value;
    } else if (token === '--scroll-container') {
      scrollContainer = selectorValue(value, '--scroll-container');
    } else if (token === '--load-more') {
      loadMore = selectorValue(value, '--load-more');
    } else if (token === '--row-key-column') {
      rowKeyColumn = canonicalRowKeyColumn(value);
    } else if (token === '--continue') {
      continuation = value;
    }
  }

  if (continuation !== null) {
    if (!CONTINUATION_TOKEN_RE.test(continuation)) fail('invalid continuation token');
    if (selector !== null) fail('--continue is mutually exclusive with a selector');
    if (collect) fail('--continue is mutually exclusive with --collect');
    if (scrollContainer !== null) fail('--continue is mutually exclusive with --scroll-container');
    if (loadMore !== null) fail('--continue is mutually exclusive with --load-more');
    if (rowKeyColumn !== null) fail('--continue is mutually exclusive with --row-key-column');
    if (format === null) fail('--continue requires explicit JSON format (--format json)');
    if (format !== 'json') fail('--continue requires JSON format');
  } else if (collect) {
    if (scrollContainer === null) fail('--collect requires --scroll-container');
  } else if (scrollContainer !== null || loadMore !== null || rowKeyColumn !== null) {
    fail('--scroll-container, --load-more, and --row-key-column are collect-only');
  }

  return Object.freeze({
    schema: 'chrome-cdp-ex.table-request.v1',
    argv,
    mode: continuation !== null ? 'continue' : collect ? 'collect' : 'observe',
    selector,
    format: format || 'text',
    scrollContainer,
    loadMore,
    rowKeyColumn,
    continuation,
  });
}

export function parseTableArgs(input) {
  return parseSnapshot(snapshotArgv(input));
}

export function isTableCollectArgs(input) {
  return parseTableArgs(input).mode === 'collect';
}

export function parseTableRunCommandArgs(input) {
  const argv = snapshotArgv(input, 'run_command argv');
  const target = argv[0];
  if (typeof target !== 'string' || target.length === 0) fail('run_command target is required');
  if (!isWellFormedUnicode(target)) fail('run_command target must use well-formed Unicode');
  const request = parseSnapshot(Object.freeze(argv.slice(1)));
  return Object.freeze({ target, request });
}
