const TABLE_SAMPLE_SCHEMA = 'chrome-cdp-ex.table-sample.v1';
const TABLE_TRUNCATION_REASONS = new Set([null, 'row-limit', 'cell-limit', 'row-too-large', 'sample-byte-limit']);
const PAGE_TRUNCATION_REASONS = new Set([null, 'table-limit', 'sample-byte-limit']);

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
  maxMatchedCandidates: 11,
  maxDirectChildren: 4096,
});

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
  if ((headerRows.length < headerRowsSeen || dataRows.length < dataRowsSeen) && !value.truncated) {
    invalid(`${name} row omission requires truncation provenance`);
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
  if (tables.length < tablesSeen && !parsed.truncated) {
    invalid('sample table omission requires truncation provenance');
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
  const selectorLiteral = JSON.stringify(selector || 'table');
  const limits = JSON.stringify(TABLE_SAMPLER_LIMITS);
  return String.raw`(() => {
    'use strict';
    const LIMITS = ${limits};
    const selector = ${selectorLiteral};
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
    const documentProto = Document.prototype;
    const nodeListProto = NodeList.prototype;
    const htmlTableProto = HTMLTableElement.prototype;
    const parentNodeGetter = getOwnPropertyDescriptor(nodeProto, 'parentNode').get;
    const firstChildGetter = getOwnPropertyDescriptor(nodeProto, 'firstChild').get;
    const nextSiblingGetter = getOwnPropertyDescriptor(nodeProto, 'nextSibling').get;
    const nodeTypeGetter = getOwnPropertyDescriptor(nodeProto, 'nodeType').get;
    const nodeValueGetter = getOwnPropertyDescriptor(nodeProto, 'nodeValue').get;
    const localNameGetter = getOwnPropertyDescriptor(elementProto, 'localName').get;
    const getAttribute = getOwnPropertyDescriptor(elementProto, 'getAttribute').value;
    const documentQuerySelectorAll = getOwnPropertyDescriptor(documentProto, 'querySelectorAll').value;
    const nodeListLengthGetter = getOwnPropertyDescriptor(nodeListProto, 'length').get;
    const nodeListItem = getOwnPropertyDescriptor(nodeListProto, 'item').value;
    const arrayPush = getOwnPropertyDescriptor(A.prototype, 'push').value;
    const charCodeAt = getOwnPropertyDescriptor(S.prototype, 'charCodeAt').value;
    const fromCharCode = S.fromCharCode;
    const MAX_SAFE = 9007199254740991;
    const BS = fromCharCode(92);
    const DQ = fromCharCode(34);
    const HEX = '0123456789ABCDEF';
    const apply = (fn, receiver, args) => reflectApply(fn, receiver, args);
    const isTable = value => value !== null
      && typeof value === 'object'
      && apply(isPrototypeOf, htmlTableProto, [value])
      && name(value) === 'table';
    const name = value => apply(localNameGetter, value, []);
    const attribute = (value, key) => apply(getAttribute, value, [key]);
    const hasTableAncestor = value => {
      let parent = apply(parentNodeGetter, value, []);
      let depth = 0;
      while (parent) {
        depth += 1;
        if (depth > LIMITS.maxAncestorDepth) return true;
        if (isTable(parent)) return true;
        parent = apply(parentNodeGetter, parent, []);
      }
      return false;
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
    const utf8Bytes = value => {
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
      }
      return bytes;
    };
    const boundedAttribute = (value, key) => {
      const raw = attribute(value, key);
      if (raw === null) return null;
      const bytes = utf8Bytes(raw);
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
      let current = apply(firstChildGetter, root, []);
      while (current) {
        visited += 1;
        if (visited > LIMITS.maxDomNodesPerCell || visited > LIMITS.maxTextNodesPerCell) {
          return { ok: false, value: '' };
        }
        const type = apply(nodeTypeGetter, current, []);
        if (type === 3) {
          const part = apply(nodeValueGetter, current, []) || '';
          const partBytes = utf8Bytes(part);
          if (partBytes < 0 || bytes + partBytes > byteLimit) return { ok: false, value: '' };
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
      return { ok: true, value };
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
      if (directResult.overflow) return { ok: false, reason: 'row-too-large' };
      const direct = directResult.items;
      let cellCount = 0;
      for (let index = 0; index < direct.length; index += 1) {
        const cellName = name(direct[index]);
        if (cellName !== 'th' && cellName !== 'td') continue;
        cellCount += 1;
        if (cellCount > LIMITS.maxCellsPerRow) return { ok: false, reason: 'cell-limit' };
        const sampledText = text(direct[index], LIMITS.maxCellTextBytes);
        if (!sampledText.ok) return { ok: false, reason: 'row-too-large' };
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
      if (utf8Bytes(encoded) > 8194) return { ok: false, reason: 'row-too-large' };
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
      const bytes = utf8Bytes(value);
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
    const matched = apply(documentQuerySelectorAll, document, [selector]);
    const matchedLength = apply(nodeListLengthGetter, matched, []);
    let tablesSeen = 0;
    let matchedCandidates = 0;
    let pageTruncated = false;
    let pageTruncationReason = null;
    for (let tableIndex = 0; tableIndex < matchedLength
      && matchedCandidates < LIMITS.maxMatchedCandidates
      && tablesSeen <= LIMITS.maxTables; tableIndex += 1) {
      matchedCandidates += 1;
      const candidate = apply(nodeListItem, matched, [tableIndex]);
      if (!isTable(candidate) || hasTableAncestor(candidate)) continue;
      tablesSeen += 1;
      if (tableStrings.length === LIMITS.maxTables) break;
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
      for (let index = 0; index < direct.length; index += 1) {
        const childName = name(direct[index]);
        if (childName === 'caption' && caption === '') {
          const sampledCaption = text(direct[index], LIMITS.maxCaptionBytes);
          if (sampledCaption.ok) caption = sampledCaption.value;
        } else if (childName === 'thead') apply(arrayPush, theads, [direct[index]]);
        else if (childName === 'tbody') apply(arrayPush, directBodies, [direct[index]]);
      }
      state.caption = boundedMetadata(caption || boundedMetadata(boundedAttribute(candidate, 'aria-label')));
      const aggregateBytes = () => {
        let bytes = 0;
        for (let index = 0; index < tableStrings.length; index += 1) bytes += utf8Bytes(tableStrings[index]);
        for (let index = 0; index < state.headerRows.length; index += 1) bytes += utf8Bytes(state.headerRows[index].encoded);
        for (let index = 0; index < state.dataRows.length; index += 1) bytes += utf8Bytes(state.dataRows[index].encoded);
        return bytes;
      };
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
        if (aggregateBytes() + utf8Bytes(candidateEncoded) + 32768 > LIMITS.maxSerializedBytes) {
          state.truncated = true;
          state.truncationReason = 'sample-byte-limit';
          return false;
        }
        apply(arrayPush, destination, [sampled]);
        return true;
      };
      const admitRows = (parents, destination, kind) => {
        for (let parentIndex = 0; parentIndex < parents.length && !state.truncated; parentIndex += 1) {
          const directRowsResult = children(parents[parentIndex]);
          const directRows = directRowsResult.items;
          for (let rowIndex = 0; rowIndex < directRows.length; rowIndex += 1) {
            if (name(directRows[rowIndex]) !== 'tr') continue;
            if (!admit(directRows[rowIndex], destination, kind)) break;
          }
          if (!state.truncated && directRowsResult.overflow) {
            state.truncated = true;
            state.truncationReason = 'row-limit';
          }
        }
      };
      admitRows(theads, state.headerRows, 'header');
      if (!state.truncated && directBodies.length) {
        admitRows(directBodies, state.dataRows, 'data');
      }
      if (!directBodies.length && !state.truncated) {
        for (let index = 0; index < direct.length; index += 1) {
          if (name(direct[index]) !== 'tr') continue;
          if (!admit(direct[index], state.dataRows, 'data')) break;
        }
      }
      if (!state.truncated && directResult.overflow) {
        state.truncated = true;
        state.truncationReason = 'row-limit';
      }
      const encodedTable = encodeTable(state);
      const candidatePage = encodePage(tablesSeen, [encodedTable], false, null);
      let priorBytes = 0;
      for (let index = 0; index < tableStrings.length; index += 1) priorBytes += utf8Bytes(tableStrings[index]) + 1;
      if (priorBytes + utf8Bytes(candidatePage) > LIMITS.maxSerializedBytes) {
        pageTruncated = true;
        pageTruncationReason = 'sample-byte-limit';
        break;
      }
      apply(arrayPush, tableStrings, [encodedTable]);
    }
    const tableLimit = tablesSeen > LIMITS.maxTables;
    if (!pageTruncated && (tableLimit
      || (matchedCandidates >= LIMITS.maxMatchedCandidates && matchedCandidates < matchedLength))) {
      pageTruncated = true;
      pageTruncationReason = 'table-limit';
    }
    let encoded = encodePage(tablesSeen, tableStrings, pageTruncated, pageTruncationReason);
    if (utf8Bytes(encoded) > LIMITS.maxSerializedBytes) {
      encoded = encodePage(tablesSeen, [], true, 'sample-byte-limit');
    }
    return encoded;
  })()`;
}
