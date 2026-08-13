import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  addTableSample,
  buildTableExportManifest,
  createTableAccumulator,
  finalizeTableExtraction,
} from '../skills/chrome-cdp-ex/scripts/lib/table-extraction.mjs';

const TOKEN = 'ct1.0123456789abcdef0123456789abcdef.0';
const CHECKSUM = '73e9f36080b8c781e204857ad9c7dcf4ce7ce419b1503d9affd0343f58f964ed';

function loadSchema(name) {
  return JSON.parse(readFileSync(new URL(`../docs/schemas/${name}`, import.meta.url), 'utf8'));
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function matchesType(schemaType, value) {
  const actual = typeOf(value);
  const types = Array.isArray(schemaType) ? schemaType : [schemaType];
  return types.some(type => {
    if (type === 'number') return actual === 'number' || actual === 'integer';
    return type === actual;
  });
}

function validate(schema, value, path = '$') {
  if (schema === true) return;
  if (schema === false) throw new Error(`${path} is rejected`);
  if (Object.hasOwn(schema, 'const') && value !== schema.const) {
    throw new Error(`${path} must equal ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.includes(value)) {
    throw new Error(`${path} is not an allowed enum value`);
  }
  if (schema.type && !matchesType(schema.type, value)) {
    throw new Error(`${path} has the wrong type`);
  }
  if (typeof value === 'string') {
    if (schema.minLength != null && value.length < schema.minLength) throw new Error(`${path} is too short`);
    if (schema.maxLength != null && value.length > schema.maxLength) throw new Error(`${path} is too long`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) throw new Error(`${path} has an invalid format`);
    if (schema.maxUtf8Bytes != null && Buffer.byteLength(value, 'utf8') > schema.maxUtf8Bytes) {
      throw new Error(`${path} exceeds its UTF-8 byte bound`);
    }
  }
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) throw new Error(`${path} is below minimum`);
    if (schema.maximum != null && value > schema.maximum) throw new Error(`${path} is above maximum`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) throw new Error(`${path} has too few items`);
    if (schema.maxItems != null && value.length > schema.maxItems) throw new Error(`${path} has too many items`);
    if (schema.items) {
      value.forEach((item, index) => validate(schema.items, item, `${path}[${index}]`));
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const properties = schema.properties || {};
    for (const key of schema.required || []) {
      if (!Object.hasOwn(value, key)) throw new Error(`${path}.${key} is required`);
    }
    for (const key of Object.keys(value)) {
      if (Object.hasOwn(properties, key)) validate(properties[key], value[key], `${path}.${key}`);
      else if (schema.additionalProperties === false) throw new Error(`${path}.${key} is not allowed`);
      else if (schema.additionalProperties && schema.additionalProperties !== true) {
        validate(schema.additionalProperties, value[key], `${path}.${key}`);
      }
    }
  }
  for (const child of schema.allOf || []) validate(child, value, path);
  if (schema.if) {
    let matched = true;
    try { validate(schema.if, value, path); } catch { matched = false; }
    if (matched && schema.then) validate(schema.then, value, path);
    if (!matched && schema.else) validate(schema.else, value, path);
  }
}

function expectValid(schema, value) {
  expect(() => validate(schema, value)).not.toThrow();
}

function expectInvalid(schema, value, pattern) {
  expect(() => validate(schema, value)).toThrow(pattern);
}

function completeTable(overrides = {}) {
  return {
    schema: 'chrome-cdp-ex.table.v1',
    logicalRows: 2,
    logicalCountSource: 'aria-rowcount',
    identitySource: 'aria-rowindex',
    orderingSource: 'aria-rowindex',
    mountedRows: 2,
    collectedRows: 2,
    recycledMountedNodes: 0,
    completeness: {
      state: 'complete',
      termination: 'logical-count-reached',
      evidenceConflict: false,
    },
    artifact: {
      id: '0123456789abcdef0123456789abcdef',
      rows: 2,
      bytes: 7,
      checksum: CHECKSUM,
      checksumScope: 'canonical-data-rows-tsv-utf8',
    },
    inline: {
      rows: ['a\tb', 'c\td'],
      rowCount: 2,
      bytes: 7,
      truncated: false,
    },
    continuation: {
      token: TOKEN,
      offset: 0,
      rowCount: 2,
      rows: ['a\tb', 'c\td'],
      bytes: 7,
      nextToken: null,
    },
    ...overrides,
  };
}

function exportManifest(overrides = {}) {
  return {
    schema: 'chrome-cdp-ex.table-export.v1',
    logicalRows: 2,
    logicalCountSource: 'aria-rowcount',
    identitySource: 'aria-rowindex',
    orderingSource: 'aria-rowindex',
    mountedRows: 2,
    collectedRows: 2,
    recycledMountedNodes: 0,
    completeness: {
      state: 'complete',
      termination: 'logical-count-reached',
      evidenceConflict: false,
    },
    artifact: {
      rows: 2,
      bytes: 7,
      checksum: CHECKSUM,
      checksumScope: 'canonical-data-rows-tsv-utf8',
    },
    inline: {
      rows: ['a\tb', 'c\td'],
      rowCount: 2,
      bytes: 7,
      truncated: false,
    },
    ...overrides,
  };
}

describe('closed table public schemas', () => {
  it('accepts truthful extraction and export documents and bounds every string/count/list', () => {
    const resultSchema = loadSchema('table-result.v1.json');
    const exportSchema = loadSchema('table-export-manifest.v1.json');
    const accumulator = createTableAccumulator({
      logicalRows: 2,
      logicalCountSource: 'aria-rowcount',
      identitySource: 'aria-rowindex',
      orderingSource: 'aria-rowindex',
    });
    addTableSample(accumulator, { mountedNodeId: 'n1', key: 1, cells: ['a', 'b'] });
    addTableSample(accumulator, { mountedNodeId: 'n2', key: 2, cells: ['c', 'd'] });
    const result = finalizeTableExtraction(accumulator, { termination: 'logical-count-reached' });
    const manifest = buildTableExportManifest(accumulator, { termination: 'logical-count-reached' });

    expect(resultSchema.additionalProperties).toBe(false);
    expect(exportSchema.additionalProperties).toBe(false);
    expectValid(resultSchema, result);
    expectValid(exportSchema, manifest);
    expectValid(resultSchema, completeTable());
    expectValid(exportSchema, exportManifest());
  });

  it('rejects false completeness, leaked absolute paths, oversized tokens, negative counts, missing checksum scope, and unknown provenance', () => {
    const resultSchema = loadSchema('table-result.v1.json');
    const exportSchema = loadSchema('table-export-manifest.v1.json');

    expectInvalid(resultSchema, completeTable({
      logicalRows: null,
      logicalCountSource: 'none',
    }), /logicalRows|aria-rowcount|complete/i);
    expectInvalid(resultSchema, completeTable({
      identitySource: 'row-key-column',
      orderingSource: 'row-key-column',
    }), /aria-rowindex|complete/i);
    expectInvalid(resultSchema, completeTable({
      completeness: { state: 'complete', termination: 'observation', evidenceConflict: false },
    }), /logical-count-reached|complete/i);
    expectInvalid(resultSchema, completeTable({
      artifact: { ...completeTable().artifact, path: '/Users/agent/secret.tsv' },
    }), /not allowed|path/i);
    expectInvalid(resultSchema, completeTable({
      continuation: { ...completeTable().continuation, token: `ct1.${'a'.repeat(80)}.0` },
    }), /format|too long|token/i);
    expectInvalid(resultSchema, completeTable({ collectedRows: -1 }), /minimum|below/i);
    expectInvalid(exportSchema, exportManifest({
      artifact: { rows: 2, bytes: 7, checksum: CHECKSUM },
    }), /checksumScope|required/i);
    expectInvalid(resultSchema, completeTable({ logicalCountSource: 'caption' }), /enum|provenance|logicalCountSource/i);
    expectInvalid(exportSchema, exportManifest({ identitySource: 'row-text' }), /enum|provenance|identitySource/i);
  });
});
