import { describe, expect, it } from 'vitest';

import {
  isTableCollectArgs,
  parseTableContinuationToken,
  parseTableArgs,
  parseTableRunCommandArgs,
} from '../skills/chrome-cdp-ex/scripts/lib/table-contract.mjs';

const TOKEN = 'ct1.0123456789abcdef0123456789abcdef.20';

function observe(overrides = {}) {
  return {
    schema: 'chrome-cdp-ex.table-request.v1',
    argv: [],
    mode: 'observe',
    selector: null,
    format: 'text',
    scrollContainer: null,
    loadMore: null,
    rowKeyColumn: null,
    continuation: null,
    ...overrides,
  };
}

describe('table request contract', () => {
  it('parses each exact grammar production into one immutable model', () => {
    expect(parseTableArgs([])).toEqual(observe());
    expect(parseTableArgs(['--format', 'json', '#grid'])).toEqual(observe({
      argv: ['--format', 'json', '#grid'],
      selector: '#grid',
      format: 'json',
    }));
    expect(parseTableArgs([
      '--row-key-column', '0', '#grid', '--load-more', '#more', '--collect',
      '--format', 'json', '--scroll-container', '.viewport',
    ])).toEqual(observe({
      argv: [
        '--row-key-column', '0', '#grid', '--load-more', '#more', '--collect',
        '--format', 'json', '--scroll-container', '.viewport',
      ],
      mode: 'collect',
      selector: '#grid',
      format: 'json',
      scrollContainer: '.viewport',
      loadMore: '#more',
      rowKeyColumn: 0,
    }));
    expect(parseTableArgs(['--format', 'json', '--continue', TOKEN])).toEqual(observe({
      argv: ['--format', 'json', '--continue', TOKEN],
      mode: 'continue',
      format: 'json',
      continuation: TOKEN,
    }));
    for (const input of [
      [],
      ['#grid'],
      ['#grid', '--format', 'json'],
      ['#grid', '--collect', '--scroll-container', '.viewport'],
      ['--continue', TOKEN, '--format', 'json'],
    ]) {
      const parsed = parseTableArgs(input);
      expect(Object.isFrozen(parsed), JSON.stringify(input)).toBe(true);
      expect(Object.isFrozen(parsed.argv), JSON.stringify(input)).toBe(true);
    }
  });

  it('recognizes collection only through the same strict parser', () => {
    expect(isTableCollectArgs(['#grid'])).toBe(false);
    expect(isTableCollectArgs(['--continue', TOKEN, '--format', 'json'])).toBe(false);
    expect(isTableCollectArgs(['--scroll-container', '.viewport', '--collect'])).toBe(true);
    expect(() => isTableCollectArgs(['--collect'])).toThrow(/scroll-container/);
  });

  it('strips exactly one run-command target before parsing table argv', () => {
    expect(parseTableRunCommandArgs(['target-1', '--format', 'json', '#grid'])).toEqual({
      target: 'target-1',
      request: observe({ argv: ['--format', 'json', '#grid'], selector: '#grid', format: 'json' }),
    });
    expect(parseTableRunCommandArgs(['target-1', '--collect', '--scroll-container', '.viewport']).request.mode)
      .toBe('collect');
    expect(() => parseTableRunCommandArgs([])).toThrow(/target/);
    expect(() => parseTableRunCommandArgs(['', '#grid'])).toThrow(/target/);
  });

  it.each([
    [['--collect', '--collect', '--scroll-container', '.viewport'], /duplicate.*collect/],
    [['--format', 'text', '--format', 'json'], /duplicate.*format/],
    [['--scroll-container', '.a', '--scroll-container', '.b', '--collect'], /duplicate.*scroll-container/],
    [['--load-more', '.a', '--load-more', '.b', '--collect', '--scroll-container', '.v'], /duplicate.*load-more/],
    [['--row-key-column', '0', '--row-key-column', '1', '--collect', '--scroll-container', '.v'], /duplicate.*row-key-column/],
    [['--continue', TOKEN, '--continue', TOKEN, '--format', 'json'], /duplicate.*continue/],
    [['#one', '#two'], /at most one.*selector/],
  ])('rejects duplicate or ambiguous input %j', (input, expected) => {
    expect(() => parseTableArgs(input)).toThrow(expected);
  });

  it.each([
    [['--unknown'], /unknown flag/],
    [['--format'], /format.*value/],
    [['--format', 'yaml'], /format.*text or json/],
    [['--scroll-container'], /scroll-container.*value/],
    [['--load-more'], /load-more.*value/],
    [['--row-key-column'], /row-key-column.*value/],
    [['--continue'], /continue.*value/],
    [[''], /selector.*non-empty/],
    [['--collect'], /collect.*scroll-container/],
    [['--scroll-container', '.viewport'], /collect-only/],
    [['--load-more', '#more'], /collect-only/],
    [['--row-key-column', '0'], /collect-only/],
  ])('rejects malformed grammar %j', (input, expected) => {
    expect(() => parseTableArgs(input)).toThrow(expected);
  });

  it('enforces exact UTF-8 and Unicode selector bounds', () => {
    const exact = 'é'.repeat(512);
    expect(parseTableArgs([exact]).selector).toBe(exact);
    for (const input of [
      [`${exact}a`],
      ['--collect', '--scroll-container', `${exact}a`],
      ['--collect', '--scroll-container', '.v', '--load-more', `${exact}a`],
    ]) {
      expect(() => parseTableArgs(input), JSON.stringify(input.slice(0, 2))).toThrow(/1,024 UTF-8 bytes/);
    }
    for (const invalid of ['\ud800', '\udc00', `ok\ud800bad`]) {
      expect(() => parseTableArgs([invalid])).toThrow(/well-formed Unicode/);
    }
  });

  it('accepts only canonical zero-based row-key columns 0 through 255', () => {
    for (const [raw, value] of [['0', 0], ['9', 9], ['255', 255]]) {
      expect(parseTableArgs(['--collect', '--scroll-container', '.v', '--row-key-column', raw]).rowKeyColumn)
        .toBe(value);
    }
    for (const raw of ['00', '01', '+1', '-1', '1.0', ' 1', '1 ', '256', '999', '０']) {
      expect(() => parseTableArgs(['--collect', '--scroll-container', '.v', '--row-key-column', raw]), raw)
        .toThrow(/canonical decimal.*0\.\.255/);
    }
  });

  it.each([
    [['--continue', TOKEN], /continue.*explicit.*JSON/],
    [['--continue', TOKEN, '--format', 'text'], /continue.*JSON/],
    [['#grid', '--continue', TOKEN, '--format', 'json'], /continue.*selector/],
    [['--collect', '--scroll-container', '.v', '--continue', TOKEN, '--format', 'json'], /continue.*collect/],
    [['--continue', TOKEN, '--format', 'json', '--load-more', '#more'], /continue.*load-more/],
    [['--continue', 'ct1.bad.0', '--format', 'json'], /continuation token/],
    [['--continue', 'ct1.0123456789abcdef0123456789abcdef.01', '--format', 'json'], /continuation token/],
  ])('enforces immutable continuation grammar %j', (input, expected) => {
    expect(() => parseTableArgs(input)).toThrow(expected);
  });

  it('parses the shared continuation token authority at exact offset boundaries', () => {
    expect(parseTableContinuationToken('ct1.0123456789abcdef0123456789abcdef.0')).toEqual({
      artifactId: '0123456789abcdef0123456789abcdef',
      offset: 0,
      token: 'ct1.0123456789abcdef0123456789abcdef.0',
    });
    expect(parseTableContinuationToken('ct1.ffffffffffffffffffffffffffffffff.99999')).toEqual({
      artifactId: 'ffffffffffffffffffffffffffffffff',
      offset: 99999,
      token: 'ct1.ffffffffffffffffffffffffffffffff.99999',
    });
  });

  it.each([
    'ct1.0123456789abcdef0123456789abcdef.100000',
    'ct1.0123456789abcdef0123456789abcdef.01',
    'ct1.0123456789abcdef0123456789abcdef.+1',
    'ct1.0123456789abcdef0123456789abcdef.-1',
    'ct1.0123456789ABCDEF0123456789ABCDEF.1',
    'ct1.%2e%2e%2f0123456789abcdef01234567.1',
    '../ct1.0123456789abcdef0123456789abcdef.1',
    ' ct1.0123456789abcdef0123456789abcdef.1',
    'ct1.0123456789abcdef0123456789abcdef.1.extra',
  ])('rejects hostile continuation token %s', token => {
    expect(() => parseTableContinuationToken(token)).toThrow(/continuation token/i);
    expect(() => parseTableArgs(['--continue', token, '--format', 'json'])).toThrow(/continuation token/i);
  });

  it('rejects proxies, accessors, custom prototypes, symbols, sparse arrays, and non-enumerable argv', () => {
    expect(() => parseTableArgs(new Proxy([], {}))).toThrow(/proxy/);

    const accessor = [];
    let reads = 0;
    Object.defineProperty(accessor, 0, { enumerable: true, get() { reads += 1; return '#grid'; } });
    accessor.length = 1;
    expect(() => parseTableArgs(accessor)).toThrow(/own enumerable data/);
    expect(reads).toBe(0);

    const custom = ['#grid'];
    Object.setPrototypeOf(custom, null);
    expect(() => parseTableArgs(custom)).toThrow(/standard array prototype/);

    const symbolic = ['#grid'];
    symbolic[Symbol('x')] = true;
    expect(() => parseTableArgs(symbolic)).toThrow(/symbol/);

    const sparse = new Array(1);
    expect(() => parseTableArgs(sparse)).toThrow(/own enumerable data/);

    const hidden = ['#grid'];
    Object.defineProperty(hidden, 0, { value: '#grid', enumerable: false });
    expect(() => parseTableArgs(hidden)).toThrow(/own enumerable data/);

    const embellished = ['#grid'];
    embellished.extra = true;
    expect(() => parseTableArgs(embellished)).toThrow(/not allowed/);
  });
});
