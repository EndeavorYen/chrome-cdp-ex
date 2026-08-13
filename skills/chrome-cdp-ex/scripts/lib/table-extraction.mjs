import { createHash } from 'node:crypto';

const LOGICAL_COUNT_SOURCES = new Set(['aria-rowcount', 'none']);
const IDENTITY_SOURCES = new Set(['aria-rowindex', 'row-key-column']);
const ORDERING_SOURCES = new Set(['aria-rowindex', 'row-key-column']);
const TERMINATIONS = new Set([
  'observation',
  'logical-count-reached',
  'row-limit',
  'byte-limit',
  'interaction-limit',
  'time-limit',
  'no-progress-limit',
  'control-disappeared',
  'error',
]);
const MAX_NODE_ID_BYTES = 8192;
const MAX_KEY_BYTES = 8192;
const MAX_CELLS_PER_ROW = 1024;
const accumulators = new WeakSet();

export const TABLE_EXTRACTION_LIMITS = Object.freeze({
  maxRows: 100000,
  maxArtifactBytes: 16 * 1024 * 1024,
  maxInteractions: 256,
  maxDurationMs: 300000,
  maxNoProgressCycles: 3,
  maxInlineRows: 20,
  maxInlineBytes: 8192,
  maxResponseBytes: 16384,
});

function invalid(message) {
  throw new TypeError(`Invalid table extraction input: ${message}`);
}

function ownDataRecord(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(`${name} must be a plain object`);
  if (Object.getPrototypeOf(value) !== Object.prototype) invalid(`${name} must have Object.prototype`);
  if (Object.getOwnPropertySymbols(value).length !== 0) invalid(`${name} must not have symbols`);
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid(`${name}.${key} must be own enumerable data`);
  }
  return value;
}

function ownValue(record, key, name, { required = true } = {}) {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor) {
    if (required) invalid(`${name}.${key} is required`);
    return undefined;
  }
  return descriptor.value;
}

function exactKeys(record, name, allowed) {
  for (const key of Object.getOwnPropertyNames(record)) {
    if (!allowed.has(key)) invalid(`${name}.${key} is not supported`);
  }
}

function boundedString(value, name, maxBytes) {
  if (typeof value !== 'string') invalid(`${name} must be a string`);
  if (Buffer.byteLength(value, 'utf8') > maxBytes) invalid(`${name} exceeds its byte bound`);
  return value;
}

function nonNegativeInteger(value, name, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) invalid(`${name} must be a non-negative safe integer`);
  return value;
}

function enumValue(value, allowed, name) {
  if (typeof value !== 'string' || !allowed.has(value)) invalid(`${name} is not supported`);
  return value;
}

function stringArray(value, name) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) invalid(`${name} must be an array with Array.prototype`);
  if (value.length > MAX_CELLS_PER_ROW) invalid(`${name} exceeds its item bound`);
  if (Object.getOwnPropertySymbols(value).length !== 0) invalid(`${name} must not have symbols`);
  for (const key of Object.getOwnPropertyNames(value)) {
    if (key === 'length') continue;
    const index = Number(key);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!Number.isSafeInteger(index) || index < 0 || String(index) !== key || index >= value.length) invalid(`${name} has an invalid property`);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid(`${name}[${key}] must be own enumerable data`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid(`${name} must be dense own enumerable data`);
    boundedString(descriptor.value, `${name}[${index}]`, TABLE_EXTRACTION_LIMITS.maxArtifactBytes);
  }
  return value;
}

function normalizedLimits(value) {
  if (value === undefined) return TABLE_EXTRACTION_LIMITS;
  const record = ownDataRecord(value, 'limits');
  const limits = {};
  for (const [key, ceiling] of Object.entries(TABLE_EXTRACTION_LIMITS)) {
    const candidate = ownValue(record, key, 'limits', { required: false });
    if (candidate === undefined) {
      limits[key] = ceiling;
      continue;
    }
    nonNegativeInteger(candidate, `limits.${key}`);
    if (candidate > ceiling) invalid(`limits.${key} must not exceed its fixed ceiling`);
    limits[key] = candidate;
  }
  for (const key of Object.getOwnPropertyNames(record)) {
    if (!Object.hasOwn(TABLE_EXTRACTION_LIMITS, key)) invalid(`limits.${key} is not supported`);
  }
  return Object.freeze(limits);
}

function canonicalRows(accumulator) {
  const entries = [...accumulator.rowsByKey.values()];
  entries.sort((left, right) => {
    if (typeof left.key === 'number' && typeof right.key === 'number') return left.key - right.key;
    const leftKey = `${typeof left.key}:${left.key}`;
    const rightKey = `${typeof right.key}:${right.key}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  return entries.map(entry => entry.row);
}

function previewForRows(rows, limits, sourceRowCount = rows.length) {
  const included = [];
  let bytes = 0;
  for (const row of rows) {
    if (included.length >= limits.maxInlineRows) break;
    const rowBytes = Buffer.byteLength(row, 'utf8');
    const separatorBytes = included.length === 0 ? 0 : 1;
    if (bytes + separatorBytes + rowBytes > limits.maxInlineBytes) break;
    included.push(row);
    bytes += separatorBytes + rowBytes;
  }
  return Object.freeze({
    rows: Object.freeze(included),
    rowCount: included.length,
    bytes,
    truncated: included.length < sourceRowCount,
  });
}

function boundedPreview(rows, limits, makeResult) {
  let preview = previewForRows(rows, limits, rows.length);
  while (Buffer.byteLength(JSON.stringify(makeResult(preview)), 'utf8') > limits.maxResponseBytes && preview.rowCount > 0) {
    preview = previewForRows(preview.rows.slice(0, -1), limits, rows.length);
  }
  if (Buffer.byteLength(JSON.stringify(makeResult(preview)), 'utf8') > limits.maxResponseBytes) {
    throw new RangeError('Table extraction metadata exceeds the response byte ceiling');
  }
  return preview;
}

function accumulatorState(value) {
  if (value === null || typeof value !== 'object' || !accumulators.has(value)) invalid('accumulator is not a table accumulator');
  return value;
}

function tableResult(accumulator, termination, limits) {
  const rows = canonicalRows(accumulator);
  if (rows.length > limits.maxRows) invalid('collected rows exceed the configured ceiling');
  const body = rows.join('\n');
  const artifactBytes = Buffer.byteLength(body, 'utf8');
  if (artifactBytes > limits.maxArtifactBytes) invalid('canonical artifact exceeds the configured ceiling');
  const complete = accumulator.logicalRows !== null
    && rows.length === accumulator.logicalRows
    && termination === 'logical-count-reached';
  const completeness = accumulator.logicalRows === null ? 'unknown' : complete ? 'complete' : 'incomplete';
  return {
    schema: 'chrome-cdp-ex.table.v1',
    logicalRows: accumulator.logicalRows,
    logicalCountSource: accumulator.logicalCountSource,
    identitySource: accumulator.identitySource,
    orderingSource: accumulator.orderingSource,
    mountedRows: accumulator.mountedNodeIds.size,
    collectedRows: rows.length,
    recycledMountedNodes: accumulator.recycledNodeIds.size,
    completeness: Object.freeze({ state: completeness, termination }),
    rows,
    body,
    artifactBytes,
  };
}

export function canonicalizeTableCells(cells) {
  return stringArray(cells, 'cells')
    .map(cell => cell.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\r/g, '\\r').replace(/\n/g, '\\n'))
    .join('\t');
}

export function createTableAccumulator(options) {
  const record = ownDataRecord(options, 'options');
  exactKeys(record, 'options', new Set(['logicalRows', 'logicalCountSource', 'identitySource', 'orderingSource']));
  const logicalRows = nonNegativeInteger(ownValue(record, 'logicalRows', 'options'), 'options.logicalRows', { nullable: true });
  const logicalCountSource = enumValue(ownValue(record, 'logicalCountSource', 'options'), LOGICAL_COUNT_SOURCES, 'options.logicalCountSource');
  const identitySource = enumValue(ownValue(record, 'identitySource', 'options'), IDENTITY_SOURCES, 'options.identitySource');
  const orderingSource = enumValue(ownValue(record, 'orderingSource', 'options'), ORDERING_SOURCES, 'options.orderingSource');
  if ((logicalRows === null) !== (logicalCountSource === 'none')) invalid('logicalRows and logicalCountSource disagree');

  const accumulator = {
    logicalRows,
    logicalCountSource,
    identitySource,
    orderingSource,
    rowsByKey: new Map(),
    mountedNodeIds: new Set(),
    nodeKeys: new Map(),
    recycledNodeIds: new Set(),
  };
  accumulators.add(accumulator);
  return accumulator;
}

export function addTableSample(accumulator, sample) {
  const state = accumulatorState(accumulator);
  const record = ownDataRecord(sample, 'sample');
  exactKeys(record, 'sample', new Set(['mountedNodeId', 'key', 'cells']));
  const mountedNodeId = boundedString(ownValue(record, 'mountedNodeId', 'sample'), 'sample.mountedNodeId', MAX_NODE_ID_BYTES);
  const key = ownValue(record, 'key', 'sample');
  if (typeof key === 'number') {
    nonNegativeInteger(key, 'sample.key');
    if (state.identitySource === 'aria-rowindex' && key === 0) invalid('sample.key must be a positive aria-rowindex');
  } else {
    boundedString(key, 'sample.key', MAX_KEY_BYTES);
  }
  const row = canonicalizeTableCells(ownValue(record, 'cells', 'sample'));
  const keyId = `${typeof key}:${key}`;
  const prior = state.rowsByKey.get(keyId);
  if (prior !== undefined && prior.row !== row) invalid('sample.key conflicts with a previously collected row');
  const previousKey = state.nodeKeys.get(mountedNodeId);
  if (previousKey !== undefined && previousKey !== keyId) state.recycledNodeIds.add(mountedNodeId);
  if (prior === undefined && state.rowsByKey.size >= TABLE_EXTRACTION_LIMITS.maxRows) invalid('collected rows exceed the fixed ceiling');

  state.rowsByKey.set(keyId, { key, row });
  state.mountedNodeIds.add(mountedNodeId);
  state.nodeKeys.set(mountedNodeId, keyId);
  return accumulator;
}

export function buildInlineTablePreview(rows, limits) {
  return previewForRows(stringArray(rows, 'rows'), normalizedLimits(limits));
}

export function finalizeTableExtraction(accumulator, options) {
  const state = accumulatorState(accumulator);
  const record = ownDataRecord(options, 'finalize options');
  exactKeys(record, 'finalize options', new Set(['termination', 'limits']));
  const termination = enumValue(ownValue(record, 'termination', 'finalize options'), TERMINATIONS, 'termination');
  const limits = normalizedLimits(ownValue(record, 'limits', 'finalize options', { required: false }));
  const table = tableResult(state, termination, limits);
  const withoutInline = ({ rows: _rows, body: _body, artifactBytes: _artifactBytes, ...result }) => result;
  const preview = boundedPreview(table.rows, limits, inline => ({ ...withoutInline(table), inline }));
  return Object.freeze({ ...withoutInline(table), inline: preview });
}

export function buildTableExportManifest(accumulator, options) {
  const state = accumulatorState(accumulator);
  const record = ownDataRecord(options, 'manifest options');
  exactKeys(record, 'manifest options', new Set(['termination', 'limits']));
  const termination = enumValue(ownValue(record, 'termination', 'manifest options'), TERMINATIONS, 'termination');
  const limits = normalizedLimits(ownValue(record, 'limits', 'manifest options', { required: false }));
  const table = tableResult(state, termination, limits);
  const checksum = createHash('sha256').update(Buffer.from(table.body, 'utf8')).digest('hex');
  const base = {
    schema: 'chrome-cdp-ex.table-export.v1',
    logicalRows: table.logicalRows,
    logicalCountSource: table.logicalCountSource,
    identitySource: table.identitySource,
    orderingSource: table.orderingSource,
    mountedRows: table.mountedRows,
    collectedRows: table.collectedRows,
    recycledMountedNodes: table.recycledMountedNodes,
    completeness: table.completeness,
    artifact: Object.freeze({ rows: table.collectedRows, bytes: table.artifactBytes, checksum }),
  };
  const preview = boundedPreview(table.rows, limits, inline => ({ ...base, inline }));
  return Object.freeze({ ...base, inline: preview });
}
