import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { QUARANTINE, quarantined } from './quarantine.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const testsDir = fileURLToPath(new URL('.', import.meta.url));

function assignEnv(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function entryPath(file) {
  return join(root, ...file.split('/'));
}

// Characters inside the quotes, with escapes decoded. Template ${...} stays source
// text: entry.test stores that spelling, including "${name}".
const SIMPLE_ESCAPES = {
  n: '\n',
  r: '\r',
  t: '\t',
  b: '\b',
  f: '\f',
  v: '\v',
  '\\': '\\',
  "'": "'",
  '"': '"',
  '`': '`',
};

function skipWhitespace(text, index) {
  let i = index;
  while (i < text.length && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r')) i += 1;
  return i;
}

function decodeHex(text, start, length) {
  const hex = text.slice(start, start + length);
  if (hex.length !== length || !/^[\da-fA-F]+$/.test(hex)) return null;
  return { value: String.fromCharCode(Number.parseInt(hex, 16)), index: start + length };
}

function decodeUnicode(text, start) {
  if (text[start] !== '{') return decodeHex(text, start, 4);
  const end = text.indexOf('}', start + 1);
  if (end < 0) return null;
  const hex = text.slice(start + 1, end);
  if (hex.length === 0 || hex.length > 6 || !/^[\da-fA-F]+$/.test(hex)) return null;
  const code = Number.parseInt(hex, 16);
  if (code > 0x10FFFF) return null;
  return { value: String.fromCodePoint(code), index: end + 1 };
}

function decodeEscape(text, index) {
  const next = text[index + 1];
  if (next == null) return null;
  if (Object.hasOwn(SIMPLE_ESCAPES, next)) return { value: SIMPLE_ESCAPES[next], index: index + 2 };
  if (next === '0') {
    const after = text[index + 2];
    if (after >= '0' && after <= '9') return null;
    return { value: '\0', index: index + 2 };
  }
  if (next === '\n') return { value: '', index: index + 2 };
  if (next === '\r') return { value: '', index: text[index + 2] === '\n' ? index + 3 : index + 2 };
  if (next === 'x') return decodeHex(text, index + 2, 2);
  if (next === 'u') return decodeUnicode(text, index + 2);
  if (next >= '1' && next <= '9') return null;
  return { value: next, index: index + 2 };
}

function readStringLiteral(text, start) {
  const quote = text[start];
  if (quote !== "'" && quote !== '"' && quote !== '`') return null;
  let index = start + 1;
  let value = '';
  while (index < text.length) {
    const ch = text[index];
    if (ch === '\\') {
      const decoded = decodeEscape(text, index);
      if (decoded == null) return null;
      value += decoded.value;
      index = decoded.index;
      continue;
    }
    if (ch === quote) return { value, index: index + 1 };
    if ((ch === '\n' || ch === '\r') && quote !== '`') return null;
    value += ch;
    index += 1;
  }
  return null;
}

// skipIf(quarantined(N)), then the first argument of the following "(".
function skipCalls(text) {
  const calls = [];
  const re = /skipIf\(\s*quarantined\(\s*(\d+)\s*\)\s*\)/g;
  for (const match of text.matchAll(re)) {
    const issue = Number(match[1]);
    let index = skipWhitespace(text, match.index + match[0].length);
    if (text[index] !== '(') {
      calls.push({ issue, test: null });
      continue;
    }
    index = skipWhitespace(text, index + 1);
    const literal = readStringLiteral(text, index);
    calls.push({ issue, test: literal == null ? null : literal.value });
  }
  return calls;
}

function quotedSkip(issue) {
  return `it.skipIf(quarantined(${issue}))`;
}

function byCall(a, b) {
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  if (a.issue !== b.issue) return a.issue - b.issue;
  if (a.test !== b.test) return a.test < b.test ? -1 : 1;
  return 0;
}

describe('quarantined()', () => {
  const savedCi = process.env.CI;
  const savedFlag = process.env.CDP_RUN_QUARANTINED;

  afterEach(() => {
    assignEnv('CI', savedCi);
    assignEnv('CDP_RUN_QUARANTINED', savedFlag);
  });

  it.each([
    ['no CI', undefined, undefined, false],
    ['empty CI', '', undefined, false],
    ['CI=1', '1', undefined, true],
    ['CI=true', 'true', undefined, true],
    ['CI=0', '0', undefined, true],
    ['CI=1 and CDP_RUN_QUARANTINED=1', '1', '1', false],
    ['CI=true and CDP_RUN_QUARANTINED=1', 'true', '1', false],
    ['CI=1 and CDP_RUN_QUARANTINED=0', '1', '0', true],
    ['CI=1 and CDP_RUN_QUARANTINED empty', '1', '', true],
    ['CI=1 and CDP_RUN_QUARANTINED=true', '1', 'true', true],
    ['only CDP_RUN_QUARANTINED=1', undefined, '1', false],
  ])('%s', (label, ci, flag, expected) => {
    assignEnv('CI', ci);
    assignEnv('CDP_RUN_QUARANTINED', flag);
    expect(quarantined(518), label).toBe(expected);
    expect(quarantined(687), label).toBe(expected);
  });

  it('reads the environment on each call', () => {
    assignEnv('CI', '1');
    assignEnv('CDP_RUN_QUARANTINED', undefined);
    expect(quarantined(518)).toBe(true);
    assignEnv('CDP_RUN_QUARANTINED', '1');
    expect(quarantined(518)).toBe(false);
    assignEnv('CI', undefined);
    assignEnv('CDP_RUN_QUARANTINED', undefined);
    expect(quarantined(687)).toBe(false);
  });

  it('stays false when issue is not a number', () => {
    assignEnv('CI', '1');
    assignEnv('CDP_RUN_QUARANTINED', undefined);
    expect(quarantined(undefined)).toBe(false);
    expect(quarantined('518')).toBe(false);
  });
});

describe('QUARANTINE list', () => {
  it('reads the test-name literal after skipIf(quarantined(issue))', () => {
    const text = [
      quotedSkip(1) + "('alpha', () => {});",
      quotedSkip(2) + '("beta", () => {});',
      quotedSkip(3) + '(`gamma ${name}`, () => {});',
      quotedSkip(4) + '("say \\"hi\\"", () => {});',
      quotedSkip(5) + "(\n  'wrapped',\n  () => {}\n);",
      quotedSkip(6) + '(notALiteral, () => {});',
      "it('alpha', () => {});",
    ].join('\n');
    expect(skipCalls(text)).toEqual([
      { issue: 1, test: 'alpha' },
      { issue: 2, test: 'beta' },
      { issue: 3, test: 'gamma ${name}' },
      { issue: 4, test: 'say "hi"' },
      { issue: 5, test: 'wrapped' },
      { issue: 6, test: null },
    ]);
  });

  it('requires each entry test name to follow skipIf(quarantined(issue)) in its file', () => {
    expect(QUARANTINE.length).toBeGreaterThan(0);
    for (const entry of QUARANTINE) {
      const path = entryPath(entry.file);
      expect(existsSync(path), entry.file).toBe(true);
      const names = skipCalls(readFileSync(path, 'utf8'))
        .filter((call) => call.issue === entry.issue)
        .map((call) => call.test);
      expect(names, `${entry.file} #${entry.issue}`).toContain(entry.test);
    }
  });

  it('lists every skipIf(quarantined) call with the same issue, file, and test name', () => {
    const found = [];
    for (const name of readdirSync(testsDir)) {
      if (!name.endsWith('.test.mjs')) continue;
      const file = `tests/${name}`;
      for (const call of skipCalls(readFileSync(join(testsDir, name), 'utf8'))) {
        expect(call.test, `${file} #${call.issue}`).toEqual(expect.any(String));
        found.push({ issue: call.issue, file, test: call.test });
      }
    }
    const listed = QUARANTINE.map((entry) => ({ issue: entry.issue, file: entry.file, test: entry.test }));
    expect(found.sort(byCall)).toEqual(listed.sort(byCall));
  });
});
