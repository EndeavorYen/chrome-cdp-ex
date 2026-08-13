import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';

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
  'row-too-large',
  'control-disappeared',
  'error',
]);
const MAX_NODE_ID_BYTES = 8192;
const MAX_KEY_BYTES = 8192;
const accumulatorStates = new WeakMap();

export const TABLE_EXTRACTION_LIMITS = Object.freeze({
  maxRows: 100000,
  maxArtifactBytes: 16 * 1024 * 1024,
  maxInteractions: 256,
  maxDurationMs: 300000,
  maxNoProgressCycles: 3,
  maxCanonicalRowBytes: 4096,
  maxCellsPerRow: 256,
  maxInlineRows: 20,
  maxInlineBytes: 8192,
  maxResponseBytes: 16384,
});

function invalid(message) {
  throw new TypeError(`Invalid table extraction input: ${message}`);
}

function ownDataRecord(value, name) {
  if (isProxy(value)) invalid(`${name} must not be a proxy`);
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
  assertWellFormedUnicode(value, name);
  if (Buffer.byteLength(value, 'utf8') > maxBytes) invalid(`${name} exceeds its byte bound`);
  return value;
}

function assertWellFormedUnicode(value, name) {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xD800 && codeUnit <= 0xDBFF) {
      const following = value.charCodeAt(index + 1);
      if (!Number.isInteger(following) || following < 0xDC00 || following > 0xDFFF) invalid(`${name} contains an unpaired surrogate`);
      index += 1;
    } else if (codeUnit >= 0xDC00 && codeUnit <= 0xDFFF) {
      invalid(`${name} contains an unpaired surrogate`);
    }
  }
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
  if (isProxy(value)) invalid(`${name} must not be a proxy`);
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) invalid(`${name} must be an array with Array.prototype`);
  if (value.length > TABLE_EXTRACTION_LIMITS.maxCellsPerRow) invalid(`${name} exceeds its item bound`);
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

function sampleArray(value) {
  if (isProxy(value)) invalid('samples must not be a proxy');
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) invalid('samples must be an array with Array.prototype');
  if (Object.getOwnPropertySymbols(value).length !== 0) invalid('samples must not have symbols');
  for (const key of Object.getOwnPropertyNames(value)) {
    if (key === 'length') continue;
    const index = Number(key);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!Number.isSafeInteger(index) || index < 0 || String(index) !== key || index >= value.length) invalid('samples has an invalid property');
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid(`samples[${key}] must be own enumerable data`);
  }
  const samples = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid('samples must be dense own enumerable data');
    samples.push(descriptor.value);
  }
  return samples;
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

function canonicalRows(state) {
  const entries = [...state.rowsByKey.values()];
  if (state.orderingSource === 'aria-rowindex') entries.sort((left, right) => left.key - right.key);
  else entries.sort((left, right) => left.firstObserved - right.firstObserved);
  return entries.map(entry => entry.row);
}

function escapeCell(cell) {
  let escaped = '';
  for (let index = 0; index < cell.length; index += 1) {
    const codeUnit = cell.charCodeAt(index);
    if (codeUnit === 0x5C) escaped += '\\\\';
    else if (codeUnit === 0x09) escaped += '\\t';
    else if (codeUnit === 0x0D) escaped += '\\r';
    else if (codeUnit === 0x0A) escaped += '\\n';
    else if (codeUnit === 0x00) escaped += '\\0';
    else if ((codeUnit >= 0x01 && codeUnit <= 0x08)
      || (codeUnit >= 0x0B && codeUnit <= 0x0C)
      || (codeUnit >= 0x0E && codeUnit <= 0x1F)
      || (codeUnit >= 0x7F && codeUnit <= 0x9F)
      || codeUnit === 0x2028
      || codeUnit === 0x2029) escaped += `\\u${codeUnit.toString(16).toUpperCase().padStart(4, '0')}`;
    else escaped += cell[index];
  }
  return escaped;
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
  if (isProxy(value)) invalid('accumulator must not be a proxy');
  if (value === null || typeof value !== 'object') invalid('accumulator is not a table accumulator');
  const state = accumulatorStates.get(value);
  if (!state) invalid('accumulator is not a table accumulator');
  return state;
}

function tableResult(state, termination) {
  const rows = canonicalRows(state);
  const body = rows.join('\n');
  const artifactBytes = Buffer.byteLength(body, 'utf8');
  const complete = state.identitySource === 'aria-rowindex'
    && state.logicalRows !== null
    && rows.length === state.logicalRows
    && termination === 'logical-count-reached'
    && [...state.rowsByKey.values()].every(entry => Number.isInteger(entry.key) && entry.key >= 1 && entry.key <= state.logicalRows)
    && [...state.rowsByKey.values()].every(entry => state.rowsByKey.has(`number:${entry.key}`));
  const completeness = state.logicalRows === null ? 'unknown' : complete ? 'complete' : 'incomplete';
  return {
    schema: 'chrome-cdp-ex.table.v1',
    logicalRows: state.logicalRows,
    logicalCountSource: state.logicalCountSource,
    identitySource: state.identitySource,
    orderingSource: state.orderingSource,
    mountedRows: state.mountedNodeIds.size,
    collectedRows: rows.length,
    recycledMountedNodes: state.recycledNodeIds.size,
    completeness: Object.freeze({ state: completeness, termination }),
    rows,
    body,
    artifactBytes,
  };
}

export function canonicalizeTableCells(cells) {
  return stringArray(cells, 'cells')
    .map(escapeCell)
    .join('\t');
}

export function createTableAccumulator(options) {
  const record = ownDataRecord(options, 'options');
  exactKeys(record, 'options', new Set(['logicalRows', 'logicalCountSource', 'identitySource', 'orderingSource', 'limits']));
  const logicalRows = nonNegativeInteger(ownValue(record, 'logicalRows', 'options'), 'options.logicalRows', { nullable: true });
  const logicalCountSource = enumValue(ownValue(record, 'logicalCountSource', 'options'), LOGICAL_COUNT_SOURCES, 'options.logicalCountSource');
  const identitySource = enumValue(ownValue(record, 'identitySource', 'options'), IDENTITY_SOURCES, 'options.identitySource');
  const orderingSource = enumValue(ownValue(record, 'orderingSource', 'options'), ORDERING_SOURCES, 'options.orderingSource');
  const limits = normalizedLimits(ownValue(record, 'limits', 'options', { required: false }));
  if ((logicalRows === null) !== (logicalCountSource === 'none')) invalid('logicalRows and logicalCountSource disagree');
  if (identitySource !== orderingSource) invalid('identitySource and orderingSource must match');

  const state = {
    logicalRows,
    logicalCountSource,
    identitySource,
    orderingSource,
    rowsByKey: new Map(),
    mountedNodeIds: new Set(),
    nodeKeys: new Map(),
    recycledNodeIds: new Set(),
    nextFirstObserved: 0,
    artifactBytes: 0,
    limits,
  };
  const accumulator = Object.freeze(Object.create(null));
  accumulatorStates.set(accumulator, state);
  return accumulator;
}

export function addTableSample(accumulator, sample) {
  return addTableSampleBatch(accumulator, [sample]);
}

function validatedSample(state, sample) {
  const record = ownDataRecord(sample, 'sample');
  exactKeys(record, 'sample', new Set(['mountedNodeId', 'key', 'cells']));
  const mountedNodeId = boundedString(ownValue(record, 'mountedNodeId', 'sample'), 'sample.mountedNodeId', MAX_NODE_ID_BYTES);
  const key = ownValue(record, 'key', 'sample');
  if (state.identitySource === 'aria-rowindex') {
    if (!Number.isSafeInteger(key) || key < 1) invalid('sample.key must be a positive safe integer for aria-rowindex');
    if (state.logicalRows !== null && key > state.logicalRows) invalid('sample.key must not exceed logicalRows');
  } else if (typeof key === 'number') {
    nonNegativeInteger(key, 'sample.key');
  } else {
    boundedString(key, 'sample.key', MAX_KEY_BYTES);
  }
  const row = canonicalizeTableCells(ownValue(record, 'cells', 'sample'));
  const rowBytes = Buffer.byteLength(row, 'utf8');
  return { mountedNodeId, key, keyId: `${typeof key}:${key}`, row, rowBytes };
}

function admission(state, admitted, reason = null) {
  return Object.freeze({ admitted, reason, collectedRows: state.rowsByKey.size, artifactBytes: state.artifactBytes });
}

export function addTableSampleBatch(accumulator, samples) {
  const state = accumulatorState(accumulator);
  const validated = sampleArray(samples).map(sample => validatedSample(state, sample));
  const batchKeys = new Set();
  const batchNodeIds = new Set();
  for (const sample of validated) {
    if (batchKeys.has(sample.keyId)) invalid('duplicate stable key within one sample batch');
    if (batchNodeIds.has(sample.mountedNodeId)) invalid('duplicate mountedNodeId within one sample batch');
    batchKeys.add(sample.keyId);
    batchNodeIds.add(sample.mountedNodeId);
    const prior = state.rowsByKey.get(sample.keyId);
    if (prior !== undefined && prior.row !== sample.row) invalid('sample.key conflicts with a previously collected row');
  }
  const newKeys = validated.filter(sample => !state.rowsByKey.has(sample.keyId));
  if (newKeys.some(sample => sample.rowBytes > state.limits.maxCanonicalRowBytes)) return admission(state, false, 'row-too-large');
  if (state.rowsByKey.size + newKeys.length > state.limits.maxRows) return admission(state, false, 'row-limit');
  const addedBytes = newKeys.reduce((total, sample) => total + sample.rowBytes, 0)
    + Math.max(0, newKeys.length - (state.rowsByKey.size === 0 ? 1 : 0));
  if (state.artifactBytes + addedBytes > state.limits.maxArtifactBytes) return admission(state, false, 'byte-limit');
  for (const sample of validated) {
    const prior = state.rowsByKey.get(sample.keyId);
    const previousKey = state.nodeKeys.get(sample.mountedNodeId);
    if (previousKey !== undefined && previousKey !== sample.keyId) state.recycledNodeIds.add(sample.mountedNodeId);
    if (prior === undefined) state.rowsByKey.set(sample.keyId, { key: sample.key, row: sample.row, firstObserved: state.nextFirstObserved++ });
    state.mountedNodeIds.add(sample.mountedNodeId);
    state.nodeKeys.set(sample.mountedNodeId, sample.keyId);
  }
  state.artifactBytes += addedBytes;
  return admission(state, true);
}

export function buildInlineTablePreview(rows, limits) {
  return previewForRows(stringArray(rows, 'rows'), normalizedLimits(limits));
}

export function finalizeTableExtraction(accumulator, options) {
  const state = accumulatorState(accumulator);
  const record = ownDataRecord(options, 'finalize options');
  exactKeys(record, 'finalize options', new Set(['termination']));
  const termination = enumValue(ownValue(record, 'termination', 'finalize options'), TERMINATIONS, 'termination');
  const table = tableResult(state, termination);
  const withoutInline = ({ rows: _rows, body: _body, artifactBytes: _artifactBytes, ...result }) => result;
  const preview = boundedPreview(table.rows, state.limits, inline => ({ ...withoutInline(table), inline }));
  return Object.freeze({ ...withoutInline(table), inline: preview });
}

export function buildTableExportManifest(accumulator, options) {
  const state = accumulatorState(accumulator);
  const record = ownDataRecord(options, 'manifest options');
  exactKeys(record, 'manifest options', new Set(['termination']));
  const termination = enumValue(ownValue(record, 'termination', 'manifest options'), TERMINATIONS, 'termination');
  const table = tableResult(state, termination);
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
  const preview = boundedPreview(table.rows, state.limits, inline => ({ ...base, inline }));
  return Object.freeze({ ...base, inline: preview });
}
