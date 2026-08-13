const TABLE_SAMPLE_SCHEMA = 'chrome-cdp-ex.table-sample.v1';
const MAX_SELECTOR_BYTES = 1024;
const MAX_SELECTOR_COMPONENTS = 32;
const MAX_SELECTOR_IDENTIFIER_UNITS = 128;
const MAX_SELECTOR_VALUE_BYTES = 256;
const TABLE_TRUNCATION_REASONS = new Set([
  null,
  'row-limit',
  'cell-limit',
  'row-too-large',
  'sample-byte-limit',
  'dom-node-limit',
]);
const PAGE_TRUNCATION_REASONS = new Set([
  null,
  'table-limit',
  'sample-byte-limit',
  'dom-depth-limit',
  'dom-node-limit',
]);

export const TABLE_SAMPLER_LIMITS = Object.freeze({
  maxTables: 10,
  maxDirectRowsPerTable: 128,
  maxCellsPerRow: 256,
  maxCanonicalRowBytes: 4096,
  maxSerializedBytes: 524288,
  maxCaptionBytes: 512,
  maxAttributeBytes: 1024,
  maxCellTextBytes: 4096,
  maxDomNodesPerCell: 4096,
  maxTextNodesPerCell: 4096,
  maxAncestorDepth: 4096,
  maxDirectChildren: 4096,
  maxDocumentNodes: 65536,
});

function selectorInvalid() {
  throw new TypeError('table: bounded table selector is not supported');
}

function selectorWellFormed(value) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xD800 && unit <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return false;
      index += 1;
    } else if (unit >= 0xDC00 && unit <= 0xDFFF) {
      return false;
    }
  }
  return true;
}

function selectorIdentifier(source, offset, attribute = false) {
  const start = offset;
  const first = source.charCodeAt(offset);
  const firstAllowed = (first >= 65 && first <= 90) || (first >= 97 && first <= 122)
    || first === 95 || (attribute && first === 58);
  if (!firstAllowed) selectorInvalid();
  offset += 1;
  while (offset < source.length) {
    const unit = source.charCodeAt(offset);
    const allowed = (unit >= 65 && unit <= 90) || (unit >= 97 && unit <= 122)
      || (unit >= 48 && unit <= 57) || unit === 95 || unit === 45
      || (attribute && (unit === 46 || unit === 58));
    if (!allowed) break;
    offset += 1;
  }
  if (offset - start > MAX_SELECTOR_IDENTIFIER_UNITS) selectorInvalid();
  return { value: source.slice(start, offset), offset };
}

export function parseTableObservationSelector(value) {
  const source = value === null || value === undefined || value === '' ? 'table' : value;
  if (typeof source !== 'string' || !selectorWellFormed(source)
    || Buffer.byteLength(source, 'utf8') > MAX_SELECTOR_BYTES) selectorInvalid();
  let offset = source.startsWith('table') ? 5 : 0;
  let componentCount = 0;
  let id = null;
  const classes = [];
  const attributes = [];
  const seenClasses = new Set();
  const seenAttributes = new Set();
  while (offset < source.length) {
    const marker = source[offset];
    if (marker === '#') {
      if (id !== null) selectorInvalid();
      const parsed = selectorIdentifier(source, offset + 1);
      id = parsed.value;
      offset = parsed.offset;
    } else if (marker === '.') {
      const parsed = selectorIdentifier(source, offset + 1);
      if (seenClasses.has(parsed.value)) selectorInvalid();
      seenClasses.add(parsed.value);
      classes.push(parsed.value);
      offset = parsed.offset;
    } else if (marker === '[') {
      const parsed = selectorIdentifier(source, offset + 1, true);
      if (seenAttributes.has(parsed.value)) selectorInvalid();
      seenAttributes.add(parsed.value);
      offset = parsed.offset;
      let expected = null;
      if (source[offset] === '=') {
        if (source[offset + 1] !== '"') selectorInvalid();
        offset += 2;
        const valueStart = offset;
        while (offset < source.length && source[offset] !== '"') {
          const unit = source.charCodeAt(offset);
          if (unit === 0x5C || unit === 0x0D || unit === 0x0A) selectorInvalid();
          offset += 1;
        }
        if (source[offset] !== '"') selectorInvalid();
        expected = source.slice(valueStart, offset);
        if (Buffer.byteLength(expected, 'utf8') > MAX_SELECTOR_VALUE_BYTES) selectorInvalid();
        offset += 1;
      }
      if (source[offset] !== ']') selectorInvalid();
      offset += 1;
      attributes.push(Object.freeze({ name: parsed.value, expected }));
    } else {
      selectorInvalid();
    }
    componentCount += 1;
    if (componentCount > MAX_SELECTOR_COMPONENTS) selectorInvalid();
  }
  if (offset === 0) selectorInvalid();
  return Object.freeze({
    id,
    classes: Object.freeze(classes),
    attributes: Object.freeze(attributes),
  });
}

function invalid(message) {
  throw new TypeError(`Invalid table sampler result: ${message}`);
}

function wellFormed(value, name, maxBytes) {
  if (typeof value !== 'string') invalid(`${name} must be a string`);
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) invalid(`${name} must use well-formed Unicode`);
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      invalid(`${name} must use well-formed Unicode`);
    }
  }
  if (Buffer.byteLength(value, 'utf8') > maxBytes) invalid(`${name} exceeds its byte bound`);
  return value;
}

function exactObject(value, name, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) invalid(`${name} must be a plain object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) invalid(`${name} has missing or extra keys`);
  return value;
}

function boundedInteger(value, name, maximum) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) invalid(`${name} exceeds its bound`);
  return value;
}

function exactArray(value, name, maximum) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) invalid(`${name} must be an array`);
  if (value.length > maximum) invalid(`${name} exceeds its bound`);
  return value;
}

function truncation(value, reason, reasons, name) {
  if (typeof value !== 'boolean' || !reasons.has(reason) || value !== (reason !== null)) {
    invalid(`${name} truncation provenance is invalid`);
  }
}

function parsedRow(value, name) {
  exactObject(value, name, ['rawAriaRowIndex', 'cells']);
  if (value.rawAriaRowIndex !== null
    && (!Number.isSafeInteger(value.rawAriaRowIndex) || value.rawAriaRowIndex < 1)) {
    invalid(`${name}.rawAriaRowIndex is invalid`);
  }
  const cells = exactArray(value.cells, `${name}.cells`, TABLE_SAMPLER_LIMITS.maxCellsPerRow)
    .map((cell, index) => wellFormed(cell, `${name}.cells[${index}]`, TABLE_SAMPLER_LIMITS.maxCellTextBytes));
  let canonicalBytes = Math.max(0, cells.length - 1);
  for (const cell of cells) {
    for (let index = 0; index < cell.length; index += 1) {
      const unit = cell.charCodeAt(index);
      if (unit === 0x5C || unit === 0x09 || unit === 0x0D || unit === 0x0A || unit === 0) canonicalBytes += 2;
      else if ((unit >= 1 && unit <= 8) || (unit >= 11 && unit <= 12)
        || (unit >= 14 && unit <= 31) || (unit >= 127 && unit <= 159)
        || unit === 0x2028 || unit === 0x2029) canonicalBytes += 6;
      else if (unit <= 0x7F) canonicalBytes += 1;
      else if (unit <= 0x7FF) canonicalBytes += 2;
      else if (unit >= 0xD800 && unit <= 0xDBFF) {
        canonicalBytes += 4;
        index += 1;
      } else canonicalBytes += 3;
      if (canonicalBytes > TABLE_SAMPLER_LIMITS.maxCanonicalRowBytes) {
        invalid(`${name} canonical row exceeds 4096 bytes`);
      }
    }
  }
  const encodedRow = `{"rawAriaRowIndex":${value.rawAriaRowIndex === null ? 'null' : value.rawAriaRowIndex},"cells":[${cells
    .map(cell => JSON.stringify(cell).replace(/\u2028|\u2029/g, match => `\\u${match.charCodeAt(0).toString(16).toUpperCase()}`))
    .join(',')}]}`;
  if (Buffer.byteLength(encodedRow, 'utf8') > 8194) {
    invalid(`${name} encoded row exceeds 8194 bytes`);
  }
  return Object.freeze({ rawAriaRowIndex: value.rawAriaRowIndex, cells: Object.freeze(cells) });
}

function parsedTable(value, index) {
  const name = `tables[${index}]`;
  exactObject(value, name, [
    'caption', 'ariaRowCount', 'headerRows', 'dataRows', 'directRowsSeen',
    'headerRowsSeen', 'dataRowsSeen', 'truncated', 'truncationReason',
  ]);
  const caption = wellFormed(value.caption, `${name}.caption`, TABLE_SAMPLER_LIMITS.maxCaptionBytes);
  if (value.ariaRowCount !== null
    && (!Number.isSafeInteger(value.ariaRowCount) || value.ariaRowCount < -1)) {
    invalid(`${name}.ariaRowCount is invalid`);
  }
  const headerRows = exactArray(value.headerRows, `${name}.headerRows`, TABLE_SAMPLER_LIMITS.maxDirectRowsPerTable)
    .map((row, rowIndex) => parsedRow(row, `${name}.headerRows[${rowIndex}]`));
  const dataRows = exactArray(value.dataRows, `${name}.dataRows`, TABLE_SAMPLER_LIMITS.maxDirectRowsPerTable)
    .map((row, rowIndex) => parsedRow(row, `${name}.dataRows[${rowIndex}]`));
  const directRowsSeen = boundedInteger(value.directRowsSeen, `${name}.directRowsSeen`, TABLE_SAMPLER_LIMITS.maxDirectRowsPerTable + 1);
  const headerRowsSeen = boundedInteger(value.headerRowsSeen, `${name}.headerRowsSeen`, TABLE_SAMPLER_LIMITS.maxDirectRowsPerTable + 1);
  const dataRowsSeen = boundedInteger(value.dataRowsSeen, `${name}.dataRowsSeen`, TABLE_SAMPLER_LIMITS.maxDirectRowsPerTable + 1);
  if (headerRows.length + dataRows.length > TABLE_SAMPLER_LIMITS.maxDirectRowsPerTable
    || headerRowsSeen + dataRowsSeen !== directRowsSeen
    || headerRows.length > headerRowsSeen || dataRows.length > dataRowsSeen) {
    invalid(`${name} direct-row counts are inconsistent`);
  }
  truncation(value.truncated, value.truncationReason, TABLE_TRUNCATION_REASONS, name);
  const returnedRows = headerRows.length + dataRows.length;
  const omittedRows = directRowsSeen - returnedRows;
  if (omittedRows > 0 && !value.truncated) {
    invalid(`${name} row omission requires truncation provenance`);
  }
  if (value.truncationReason === 'row-limit'
    && (directRowsSeen !== TABLE_SAMPLER_LIMITS.maxDirectRowsPerTable + 1
      || returnedRows !== TABLE_SAMPLER_LIMITS.maxDirectRowsPerTable)) {
    invalid(`${name} row-limit provenance has inconsistent counters`);
  }
  if ((value.truncationReason === 'cell-limit'
      || value.truncationReason === 'row-too-large'
      || value.truncationReason === 'sample-byte-limit')
    && omittedRows !== 1) {
    invalid(`${name} truncation reason requires exactly one omitted row`);
  }
  if (value.truncationReason !== 'row-limit'
    && directRowsSeen > TABLE_SAMPLER_LIMITS.maxDirectRowsPerTable) {
    invalid(`${name} truncation reason loses precedence to row-limit`);
  }
  if (value.truncationReason === 'dom-node-limit' && omittedRows > 1) {
    invalid(`${name} dom-node-limit provenance has inconsistent counters`);
  }
  if (headerRows.length < headerRowsSeen && (dataRows.length !== 0 || dataRowsSeen !== 0)) {
    invalid(`${name} data rows violate the producer header prefix`);
  }
  return Object.freeze({
    caption,
    ariaRowCount: value.ariaRowCount,
    headerRows: Object.freeze(headerRows),
    dataRows: Object.freeze(dataRows),
    directRowsSeen,
    headerRowsSeen,
    dataRowsSeen,
    truncated: value.truncated,
    truncationReason: value.truncationReason,
  });
}

export function parseTableSamplerResult(value) {
  if (typeof value !== 'string') invalid('CDP value must be a string');
  if (Buffer.byteLength(value, 'utf8') > TABLE_SAMPLER_LIMITS.maxSerializedBytes) {
    invalid('CDP value exceeds 524,288 UTF-8 bytes');
  }
  let parsed;
  try { parsed = JSON.parse(value); } catch { invalid('CDP value must contain JSON'); }
  exactObject(parsed, 'sample', ['schema', 'tablesSeen', 'tables', 'truncated', 'truncationReason']);
  if (parsed.schema !== TABLE_SAMPLE_SCHEMA) invalid('sample.schema is invalid');
  const tablesSeen = boundedInteger(parsed.tablesSeen, 'sample.tablesSeen', TABLE_SAMPLER_LIMITS.maxTables + 1);
  const tables = exactArray(parsed.tables, 'sample.tables', TABLE_SAMPLER_LIMITS.maxTables)
    .map((entry, index) => parsedTable(entry, index));
  if (tables.length > tablesSeen) invalid('sample table counts are inconsistent');
  truncation(parsed.truncated, parsed.truncationReason, PAGE_TRUNCATION_REASONS, 'sample');
  const omittedTables = tablesSeen - tables.length;
  if (omittedTables > 0 && !parsed.truncated) {
    invalid('sample table omission requires truncation provenance');
  }
  if (parsed.truncationReason === 'table-limit'
    && (tablesSeen !== TABLE_SAMPLER_LIMITS.maxTables + 1
      || tables.length !== TABLE_SAMPLER_LIMITS.maxTables)) {
    invalid('sample table-limit provenance has inconsistent counters');
  }
  if (parsed.truncationReason === 'sample-byte-limit' && omittedTables !== 1) {
    invalid('sample sample-byte-limit provenance requires exactly one omitted table');
  }
  if (parsed.truncationReason === 'sample-byte-limit'
    && tablesSeen > TABLE_SAMPLER_LIMITS.maxTables) {
    invalid('sample sample-byte-limit provenance loses precedence to table-limit');
  }
  if ((parsed.truncationReason === 'dom-depth-limit'
      || parsed.truncationReason === 'dom-node-limit')
    && omittedTables !== 0) {
    invalid('sample DOM truncation provenance has inconsistent counters');
  }
  return Object.freeze({
    schema: TABLE_SAMPLE_SCHEMA,
    tablesSeen,
    tables: Object.freeze(tables),
    truncated: parsed.truncated,
    truncationReason: parsed.truncationReason,
  });
}

export function buildTableSamplerExpression(selector = 'table') {
  const selectorSpecLiteral = JSON.stringify(parseTableObservationSelector(selector));
  const limits = JSON.stringify(TABLE_SAMPLER_LIMITS);
  return String.raw`(() => {
    'use strict';
    const LIMITS = ${limits};
    const selectorSpec = ${selectorSpecLiteral};
    const O = Object;
    const A = Array;
    const S = String;
    const R = Reflect;
    const getOwnPropertyDescriptor = O.getOwnPropertyDescriptor;
    const isPrototypeOf = getOwnPropertyDescriptor(O.prototype, 'isPrototypeOf').value;
    const reflectApply = R.apply;
    const nodeProto = Node.prototype;
    const elementProto = Element.prototype;
    const textProto = Text.prototype;
    const htmlTableProto = HTMLTableElement.prototype;
    const parentNodeGetter = getOwnPropertyDescriptor(nodeProto, 'parentNode').get;
    const firstChildGetter = getOwnPropertyDescriptor(nodeProto, 'firstChild').get;
    const nextSiblingGetter = getOwnPropertyDescriptor(nodeProto, 'nextSibling').get;
    const nodeTypeGetter = getOwnPropertyDescriptor(nodeProto, 'nodeType').get;
    const nodeValueGetter = getOwnPropertyDescriptor(nodeProto, 'nodeValue').get;
    const localNameGetter = getOwnPropertyDescriptor(elementProto, 'localName').get;
    const namespaceURIGetter = getOwnPropertyDescriptor(elementProto, 'namespaceURI').get;
    const getAttribute = getOwnPropertyDescriptor(elementProto, 'getAttribute').value;
    const arrayPush = getOwnPropertyDescriptor(A.prototype, 'push').value;
    const charCodeAt = getOwnPropertyDescriptor(S.prototype, 'charCodeAt').value;
    const fromCharCode = S.fromCharCode;
    const MAX_SAFE = 9007199254740991;
    const BS = fromCharCode(92);
    const DQ = fromCharCode(34);
    const HEX = '0123456789ABCDEF';
    const XHTML = 'http://www.w3.org/1999/xhtml';
    const apply = (fn, receiver, args) => reflectApply(fn, receiver, args);
    const isTable = value => value !== null
      && typeof value === 'object'
      && apply(isPrototypeOf, htmlTableProto, [value])
      && apply(namespaceURIGetter, value, []) === XHTML
      && name(value) === 'table';
    const name = value => apply(localNameGetter, value, []);
    const htmlName = value => value !== null
      && typeof value === 'object'
      && apply(isPrototypeOf, elementProto, [value])
      && apply(namespaceURIGetter, value, []) === XHTML
      ? name(value) : '';
    const attribute = (value, key) => apply(getAttribute, value, [key]);
    const asciiSpace = unit => unit === 0x20 || unit === 0x09 || unit === 0x0A
      || unit === 0x0C || unit === 0x0D;
    const sameAsciiToken = (value, start, end, expected) => {
      if (end - start !== expected.length) return false;
      for (let index = 0; index < expected.length; index += 1) {
        if (apply(charCodeAt, value, [start + index]) !== apply(charCodeAt, expected, [index])) return false;
      }
      return true;
    };
    const hasClass = (value, expected) => {
      let offset = 0;
      while (offset < value.length) {
        while (offset < value.length && asciiSpace(apply(charCodeAt, value, [offset]))) offset += 1;
        const start = offset;
        while (offset < value.length && !asciiSpace(apply(charCodeAt, value, [offset]))) offset += 1;
        if (start < offset && sameAsciiToken(value, start, offset, expected)) return true;
      }
      return false;
    };
    const matchesTableSelector = value => {
      if (selectorSpec.id !== null && boundedAttribute(value, 'id') !== selectorSpec.id) return false;
      if (selectorSpec.classes.length > 0) {
        const rawClass = boundedAttribute(value, 'class');
        if (rawClass === null) return false;
        for (let index = 0; index < selectorSpec.classes.length; index += 1) {
          if (!hasClass(rawClass, selectorSpec.classes[index])) return false;
        }
      }
      for (let index = 0; index < selectorSpec.attributes.length; index += 1) {
        const constraint = selectorSpec.attributes[index];
        const raw = boundedAttribute(value, constraint.name);
        if (raw === null || (constraint.expected !== null && raw !== constraint.expected)) return false;
      }
      return true;
    };
    const hasTableAncestor = value => {
      let parent = apply(parentNodeGetter, value, []);
      let depth = 0;
      while (parent) {
        depth += 1;
        if (depth > LIMITS.maxAncestorDepth) return 'overflow';
        if (isTable(parent)) return 'nested';
        parent = apply(parentNodeGetter, parent, []);
      }
      return 'root';
    };
    const children = parent => {
      const result = [];
      let child = apply(firstChildGetter, parent, []);
      let seen = 0;
      while (child) {
        seen += 1;
        if (seen > LIMITS.maxDirectChildren) return { items: result, overflow: true };
        if (apply(nodeTypeGetter, child, []) === 1) apply(arrayPush, result, [child]);
        child = apply(nextSiblingGetter, child, []);
      }
      return { items: result, overflow: false };
    };
    const utf8Bytes = (value, ceiling) => {
      let bytes = 0;
      for (let index = 0; index < value.length; index += 1) {
        const unit = apply(charCodeAt, value, [index]);
        if (unit <= 0x7f) bytes += 1;
        else if (unit <= 0x7ff) bytes += 2;
        else if (unit >= 0xd800 && unit <= 0xdbff) {
          const next = apply(charCodeAt, value, [index + 1]);
          if (!(next >= 0xdc00 && next <= 0xdfff)) return -1;
          bytes += 4;
          index += 1;
        } else if (unit >= 0xdc00 && unit <= 0xdfff) return -1;
        else bytes += 3;
        if (bytes > ceiling) return ceiling + 1;
      }
      return bytes;
    };
    const boundedAttribute = (value, key) => {
      const raw = attribute(value, key);
      if (raw === null) return null;
      const bytes = utf8Bytes(raw, LIMITS.maxAttributeBytes);
      return bytes >= 0 && bytes <= LIMITS.maxAttributeBytes ? raw : null;
    };
    const hex4 = unit => BS + 'u' + HEX[(unit >>> 12) & 15] + HEX[(unit >>> 8) & 15]
      + HEX[(unit >>> 4) & 15] + HEX[unit & 15];
    const quote = value => {
      let output = DQ;
      for (let index = 0; index < value.length; index += 1) {
        const unit = apply(charCodeAt, value, [index]);
        if (unit === 0x22) output += BS + DQ;
        else if (unit === 0x5c) output += BS + BS;
        else if (unit === 8) output += BS + 'b';
        else if (unit === 9) output += BS + 't';
        else if (unit === 10) output += BS + 'n';
        else if (unit === 12) output += BS + 'f';
        else if (unit === 13) output += BS + 'r';
        else if (unit < 0x20 || unit === 0x2028 || unit === 0x2029) output += hex4(unit);
        else output += value[index];
      }
      return output + DQ;
    };
    const text = (root, byteLimit) => {
      let value = '';
      let bytes = 0;
      let visited = 0;
      let textNodes = 0;
      let current = apply(firstChildGetter, root, []);
      while (current) {
        visited += 1;
        if (visited > LIMITS.maxDomNodesPerCell) return { ok: false, value: '', reason: 'dom-node-limit' };
        const type = apply(nodeTypeGetter, current, []);
        if (type === 3) {
          textNodes += 1;
          if (textNodes > LIMITS.maxTextNodesPerCell) {
            return { ok: false, value: '', reason: 'dom-node-limit' };
          }
          const part = apply(nodeValueGetter, current, []) || '';
          const partBytes = utf8Bytes(part, byteLimit - bytes);
          if (partBytes < 0 || bytes + partBytes > byteLimit) {
            return { ok: false, value: '', reason: 'row-too-large' };
          }
          value += part;
          bytes += partBytes;
        }
        const first = type === 1 && !isTable(current)
          ? apply(firstChildGetter, current, []) : null;
        if (first) {
          current = first;
          continue;
        }
        while (current && current !== root) {
          const next = apply(nextSiblingGetter, current, []);
          if (next) { current = next; break; }
          current = apply(parentNodeGetter, current, []);
        }
        if (current === root) current = null;
      }
      return { ok: true, value, reason: null };
    };
    const canonicalBytes = cells => {
      let bytes = cells.length > 0 ? cells.length - 1 : 0;
      for (let cellIndex = 0; cellIndex < cells.length; cellIndex += 1) {
        const cell = cells[cellIndex];
        for (let index = 0; index < cell.length; index += 1) {
          const unit = apply(charCodeAt, cell, [index]);
          if (unit === 0x5c || unit === 0x09 || unit === 0x0d || unit === 0x0a || unit === 0) bytes += 2;
          else if ((unit >= 1 && unit <= 8) || (unit >= 11 && unit <= 12)
            || (unit >= 14 && unit <= 31) || (unit >= 127 && unit <= 159)
            || unit === 0x2028 || unit === 0x2029) bytes += 6;
          else if (unit <= 0x7f) bytes += 1;
          else if (unit <= 0x7ff) bytes += 2;
          else if (unit >= 0xd800 && unit <= 0xdbff) {
            const next = apply(charCodeAt, cell, [index + 1]);
            if (!(next >= 0xdc00 && next <= 0xdfff)) return LIMITS.maxCanonicalRowBytes + 1;
            bytes += 4;
            index += 1;
          } else if (unit >= 0xdc00 && unit <= 0xdfff) return LIMITS.maxCanonicalRowBytes + 1;
          else bytes += 3;
          if (bytes > LIMITS.maxCanonicalRowBytes) return bytes;
        }
      }
      return bytes;
    };
    const decimal = value => {
      if (value === null) return 'null';
      if (value === -1) return '-1';
      if (value === 0) return '0';
      let remaining = value;
      let output = '';
      while (remaining > 0) {
        const digit = remaining % 10;
        output = fromCharCode(48 + digit) + output;
        remaining = (remaining - digit) / 10;
      }
      return output;
    };
    const parseInteger = (raw, allowUnknown) => {
      if (raw === null) return null;
      if (allowUnknown && raw === '-1') return -1;
      if (raw.length === 0 || (raw.length > 1 && raw[0] === '0')) return null;
      let result = 0;
      for (let index = 0; index < raw.length; index += 1) {
        const unit = apply(charCodeAt, raw, [index]);
        if (unit < 48 || unit > 57) return null;
        result = result * 10 + unit - 48;
        if (result > MAX_SAFE) return null;
      }
      if (!allowUnknown && result < 1) return null;
      return result;
    };
    const row = tr => {
      const cells = [];
      const directResult = children(tr);
      if (directResult.overflow) return { ok: false, reason: 'dom-node-limit' };
      const direct = directResult.items;
      let cellCount = 0;
      for (let index = 0; index < direct.length; index += 1) {
        const cellName = htmlName(direct[index]);
        if (cellName !== 'th' && cellName !== 'td') continue;
        cellCount += 1;
        if (cellCount > LIMITS.maxCellsPerRow) return { ok: false, reason: 'cell-limit' };
        const sampledText = text(direct[index], LIMITS.maxCellTextBytes);
        if (!sampledText.ok) return { ok: false, reason: sampledText.reason };
        apply(arrayPush, cells, [sampledText.value]);
        if (canonicalBytes(cells) > LIMITS.maxCanonicalRowBytes) return { ok: false, reason: 'row-too-large' };
      }
      const rawAriaRowIndex = parseInteger(boundedAttribute(tr, 'aria-rowindex'), false);
      let encodedCells = '';
      for (let index = 0; index < cells.length; index += 1) {
        encodedCells += (index === 0 ? '' : ',') + quote(cells[index]);
      }
      const encoded = '{' + quote('rawAriaRowIndex') + ':' + decimal(rawAriaRowIndex)
        + ',' + quote('cells') + ':[' + encodedCells + ']}';
      if (utf8Bytes(encoded, 8194) > 8194) return { ok: false, reason: 'row-too-large' };
      return { ok: true, value: { rawAriaRowIndex, cells }, encoded };
    };
    const encodeRows = rows => {
      let output = '[';
      for (let index = 0; index < rows.length; index += 1) {
        output += (index === 0 ? '' : ',') + rows[index].encoded;
      }
      return output + ']';
    };
    const boundedMetadata = value => {
      if (value === null) return '';
      const bytes = utf8Bytes(value, LIMITS.maxCaptionBytes);
      return bytes >= 0 && bytes <= LIMITS.maxCaptionBytes ? value : '';
    };
    const encodeTable = state => '{'
      + quote('caption') + ':' + quote(state.caption)
      + ',' + quote('ariaRowCount') + ':' + decimal(state.ariaRowCount)
      + ',' + quote('headerRows') + ':' + encodeRows(state.headerRows)
      + ',' + quote('dataRows') + ':' + encodeRows(state.dataRows)
      + ',' + quote('directRowsSeen') + ':' + decimal(state.directRowsSeen)
      + ',' + quote('headerRowsSeen') + ':' + decimal(state.headerRowsSeen)
      + ',' + quote('dataRowsSeen') + ':' + decimal(state.dataRowsSeen)
      + ',' + quote('truncated') + ':' + (state.truncated ? 'true' : 'false')
      + ',' + quote('truncationReason') + ':' + (state.truncationReason === null ? 'null' : quote(state.truncationReason))
      + '}';
    const encodePage = (tablesSeen, tableStrings, truncated, reason) => {
      let encodedTables = '';
      for (let index = 0; index < tableStrings.length; index += 1) {
        encodedTables += (index === 0 ? '' : ',') + tableStrings[index];
      }
      return '{' + quote('schema') + ':' + quote('${TABLE_SAMPLE_SCHEMA}')
        + ',' + quote('tablesSeen') + ':' + decimal(tablesSeen)
        + ',' + quote('tables') + ':[' + encodedTables + ']'
        + ',' + quote('truncated') + ':' + (truncated ? 'true' : 'false')
        + ',' + quote('truncationReason') + ':' + (reason === null ? 'null' : quote(reason))
        + '}';
    };
    const tableStrings = [];
    let retainedTableBytes = 0;
    let tablesSeen = 0;
    let pageTruncated = false;
    let pageTruncationReason = null;
    const sampleTable = candidate => {
      const directResult = children(candidate);
      const direct = directResult.items;
      const state = {
        caption: '',
        ariaRowCount: parseInteger(boundedAttribute(candidate, 'aria-rowcount'), true),
        headerRows: [],
        dataRows: [],
        directRowsSeen: 0,
        headerRowsSeen: 0,
        dataRowsSeen: 0,
        truncated: false,
        truncationReason: null,
      };
      let caption = '';
      const theads = [];
      const directBodies = [];
      if (directResult.overflow) {
        state.truncated = true;
        state.truncationReason = 'dom-node-limit';
      } else {
        for (let index = 0; index < direct.length; index += 1) {
          const childName = htmlName(direct[index]);
          if (childName === 'caption' && caption === '') {
            const sampledCaption = text(direct[index], LIMITS.maxCaptionBytes);
            if (sampledCaption.ok) caption = sampledCaption.value;
            else if (sampledCaption.reason === 'dom-node-limit') {
              state.truncated = true;
              state.truncationReason = 'dom-node-limit';
              break;
            }
          } else if (childName === 'thead') apply(arrayPush, theads, [direct[index]]);
          else if (childName === 'tbody') apply(arrayPush, directBodies, [direct[index]]);
        }
      }
      state.caption = boundedMetadata(caption || boundedMetadata(boundedAttribute(candidate, 'aria-label')));
      let retainedRowBytes = 0;
      const admit = (tr, destination, kind) => {
        if (kind === 'header') state.headerRowsSeen += 1; else state.dataRowsSeen += 1;
        state.directRowsSeen = state.headerRowsSeen + state.dataRowsSeen;
        if (state.directRowsSeen > LIMITS.maxDirectRowsPerTable) {
          state.truncated = true;
          state.truncationReason = 'row-limit';
          return false;
        }
        const sampled = row(tr);
        if (!sampled.ok) {
          state.truncated = true;
          state.truncationReason = sampled.reason;
          return false;
        }
        const candidateEncoded = sampled.encoded;
        const candidateBytes = utf8Bytes(candidateEncoded, 8194);
        if (retainedTableBytes + retainedRowBytes + candidateBytes + 32768
          > LIMITS.maxSerializedBytes) {
          state.truncated = true;
          state.truncationReason = 'sample-byte-limit';
          return false;
        }
        apply(arrayPush, destination, [sampled]);
        retainedRowBytes += candidateBytes;
        return true;
      };
      const admitRows = (parents, destination, kind) => {
        for (let parentIndex = 0; parentIndex < parents.length && !state.truncated; parentIndex += 1) {
          const directRowsResult = children(parents[parentIndex]);
          const directRows = directRowsResult.items;
          for (let rowIndex = 0; rowIndex < directRows.length; rowIndex += 1) {
            if (htmlName(directRows[rowIndex]) !== 'tr') continue;
            if (!admit(directRows[rowIndex], destination, kind)) break;
          }
          if (!state.truncated && directRowsResult.overflow) {
            state.truncated = true;
            state.truncationReason = 'dom-node-limit';
          }
        }
      };
      admitRows(theads, state.headerRows, 'header');
      if (!state.truncated && directBodies.length) {
        admitRows(directBodies, state.dataRows, 'data');
      }
      if (!directBodies.length && !state.truncated && !directResult.overflow) {
        for (let index = 0; index < direct.length; index += 1) {
          if (htmlName(direct[index]) !== 'tr') continue;
          if (!admit(direct[index], state.dataRows, 'data')) break;
        }
      }
      const encodedTable = encodeTable(state);
      const candidateStrings = [];
      for (let index = 0; index < tableStrings.length; index += 1) {
        apply(arrayPush, candidateStrings, [tableStrings[index]]);
      }
      apply(arrayPush, candidateStrings, [encodedTable]);
      const candidatePage = encodePage(tablesSeen, candidateStrings, false, null);
      if (utf8Bytes(candidatePage, LIMITS.maxSerializedBytes) > LIMITS.maxSerializedBytes) {
        pageTruncated = true;
        pageTruncationReason = 'sample-byte-limit';
        return;
      }
      apply(arrayPush, tableStrings, [encodedTable]);
      retainedTableBytes += utf8Bytes(encodedTable, LIMITS.maxSerializedBytes)
        + (tableStrings.length > 1 ? 1 : 0);
    };
    let current = apply(firstChildGetter, document, []);
    let documentNodes = 0;
    while (current && !pageTruncated) {
      if (documentNodes >= LIMITS.maxDocumentNodes) {
        pageTruncated = true;
        pageTruncationReason = 'dom-node-limit';
        break;
      }
      documentNodes += 1;
      const type = apply(nodeTypeGetter, current, []);
      let descend = type === 1;
      if (type === 1) {
        if (isTable(current)) {
          descend = false;
          if (matchesTableSelector(current)) {
            const ancestorStatus = hasTableAncestor(current);
            if (ancestorStatus === 'overflow') {
              pageTruncated = true;
              pageTruncationReason = 'dom-depth-limit';
            } else if (ancestorStatus === 'root') {
              tablesSeen += 1;
              if (tablesSeen > LIMITS.maxTables) {
                pageTruncated = true;
                pageTruncationReason = 'table-limit';
              } else {
                sampleTable(current);
              }
            }
          }
        }
      }
      if (pageTruncated) break;
      const first = descend ? apply(firstChildGetter, current, []) : null;
      if (first) {
        current = first;
      } else {
        let next = null;
        while (current && current !== document) {
          next = apply(nextSiblingGetter, current, []);
          if (next) break;
          current = apply(parentNodeGetter, current, []);
        }
        current = next;
      }
    }
    const encoded = encodePage(tablesSeen, tableStrings, pageTruncated, pageTruncationReason);
    if (utf8Bytes(encoded, LIMITS.maxSerializedBytes) > LIMITS.maxSerializedBytes) {
      throw new TypeError('table sampler serialization invariant');
    }
    return encoded;
  })()`;
}
