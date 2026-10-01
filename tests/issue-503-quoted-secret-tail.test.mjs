import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const { redactSensitiveString, REDACTED_VALUE: R, MAX_QUOTED_VALUE_CHARS } = await import('../skills/chrome-cdp-ex/scripts/lib/redaction.mjs');

// #503: a quoted secret was redacted only up to its first line break or
// escaped quote, so the rest of the secret stayed visible.
const PARTS = ['QZ7', 'XJ3', 'JQ9'];

function expectNoSecret(text) {
  for (const part of PARTS) expect(text, text).not.toContain(part);
}

function timed(fn) {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
}

describe('#503 a quoted secret is redacted through its real closing quote', () => {
  it('redacts a multi-line double-quoted value', () => {
    const out = redactSensitiveString('password: "QZ7X JQ9Z\nXJ3Q next" done');
    expect(out).toBe(`password: "${R}" done`);
  });

  it('redacts a value that spans CRLF and several lines', () => {
    const out = redactSensitiveString('{"client_secret": "QZ7\r\nXJ3\r\nJQ9", "user": "bob"}');
    expect(out).toBe(`{"client_secret": "${R}", "user": "bob"}`);
  });

  it('treats an escaped quote as part of the value', () => {
    expect(redactSensitiveString('{"password":"a\\"QZ7 XJ3"}')).toBe(`{"password":"${R}"}`);
    expect(redactSensitiveString('token="QZ7\\" XJ3 \\"JQ9" ok')).toBe(`token="${R}" ok`);
  });

  it('closes on a quote after an escaped backslash', () => {
    // JSON `"QZ7\\"` is QZ7 plus one backslash; the next quote closes it.
    expect(redactSensitiveString('{"password":"QZ7\\\\","user":"bob"}')).toBe(`{"password":"${R}","user":"bob"}`);
  });

  it('redacts single-quoted values, escaped and multi-line', () => {
    expect(redactSensitiveString("pin: 'QZ7 \\'XJ3\\' JQ9' end")).toBe(`pin: '${R}' end`);
    expect(redactSensitiveString("api_key = 'QZ7\nXJ3\nJQ9'\nnext = 1")).toBe(`api_key = '${R}'\nnext = 1`);
  });

  it('redacts an unterminated quoted value to the end of the text', () => {
    expect(redactSensitiveString('password: "QZ7 XJ3\nJQ9 and more')).toBe(`password: "${R}`);
    expect(redactSensitiveString("secret='QZ7 XJ3 JQ9")).toBe(`secret='${R}`);
  });

  it('redacts an unterminated quoted value up to the bound, not beyond it', () => {
    const body = `QZ7 XJ3\n${'q'.repeat(MAX_QUOTED_VALUE_CHARS)}`;
    const out = redactSensitiveString(`password: "${body} tail`);
    expectNoSecret(out);
    const visible = out.slice(`password: "${R}`.length);
    // Everything up to the bound is gone; only text past it is left.
    expect(out.startsWith(`password: "${R}`)).toBe(true);
    expect(visible.length).toBeLessThan(body.length - MAX_QUOTED_VALUE_CHARS + ' tail'.length + 1);
    expect(visible.endsWith(' tail')).toBe(true);
  });

  it('does not split a surrogate pair at the bound', () => {
    const body = `${'q'.repeat(MAX_QUOTED_VALUE_CHARS - 1)}😀x`;
    const out = redactSensitiveString(`password: "${body}`);
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  it('keeps redacting when a stray quote closes on the next secret\'s opening quote', () => {
    expectNoSecret(redactSensitiveString("token: 'x\npassword: 'QZ7 XJ3 JQ9' done"));
    expectNoSecret(redactSensitiveString('token: "x, password: "QZ7 XJ3 JQ9" done'));
  });

  it('leaves non-secret quoted values and the text after a closed value alone', () => {
    expect(redactSensitiveString('{"password":"a","name":"Ada\\"s"}\nnext: "line"'))
      .toBe(`{"password":"${R}","name":"Ada\\"s"}\nnext: "line"`);
    expect(redactSensitiveString('title: "QZ7\nXJ3"')).toBe('title: "QZ7\nXJ3"');
    expect(redactSensitiveString('password: ""')).toBe(`password: "${R}"`);
  });

  it('still redacts bare and cut-off values as before', () => {
    expect(redactSensitiveString('token=QZ7XJ3 next=1')).toBe(`token=${R} next=1`);
    expect(redactSensitiveString('password: "QZ7 XJ', { truncated: true })).toBe(`password: "${R}`);
  });
});

describe('#503 quoted-value scanning stays linear', () => {
  const SIZE = 64 * 1024;
  const cases = {
    'unterminated quotes': () => 'pin: "'.repeat(SIZE / 6),
    'unterminated single quotes': () => "pin: '".repeat(SIZE / 6),
    'long escape run': () => `pin: "${'\\\\\\"'.repeat(SIZE / 4)}`,
    'escaped quotes only': () => `pin: "${'\\"'.repeat(SIZE / 2)}`,
    'many alternating quotes': () => `pin: "${'"\''.repeat(SIZE / 2)}`,
    'many short secrets': () => "pin:'a' ".repeat(SIZE / 8),
    'chained stray quotes': () => "token: 'x\n".repeat(SIZE / 10),
    'secret keys inside a long value': () => `pin: "${'\npin: \''.repeat(SIZE / 7)}`,
    'long key before each quote': () => ` ${'k'.repeat(60)}pin: "x"`.repeat(SIZE / 69),
  };
  for (const [name, make] of Object.entries(cases)) {
    it(`redacts 64 KB of ${name} in linear time`, () => {
      const text = make();
      const small = text.slice(0, SIZE / 4);
      // Warm up, then compare 16 KB against 64 KB: linear is ~4x, quadratic ~16x.
      redactSensitiveString(small);
      const a = timed(() => redactSensitiveString(small));
      const b = timed(() => redactSensitiveString(text));
      expect(b.ms).toBeLessThan(250);
      expect(b.ms).toBeLessThan(Math.max(20, a.ms * 10));
    });
  }

  it('keeps the #459 long-token cases fast', () => {
    for (const text of ['a.'.repeat(128 * 1024), ` ${'A'.repeat(256 * 1024)}=x`, 'a-'.repeat(128 * 1024)]) {
      const { ms } = timed(() => redactSensitiveString(text));
      expect(ms).toBeLessThan(500);
    }
  });
});
