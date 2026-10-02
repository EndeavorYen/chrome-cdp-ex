import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const { redactSensitiveString, redactSensitiveValue, redactJsonText, REDACTED_VALUE: R } = await import('../skills/chrome-cdp-ex/scripts/lib/redaction.mjs');
const { redactBodyText } = await import('../skills/chrome-cdp-ex/scripts/lib/netlog.mjs');

const BS = '\\';
const PARTS = ['QZ7', 'XJ3', 'JQ9'];

function expectNoSecret(text) {
  for (const part of PARTS) expect(text, text).not.toContain(part);
}

function timed(fn) {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
}

// #511: JSON that sits inside a JSON string (a console line that logs
// JSON.stringify output, a log record's `msg`) escapes its quotes once more.
describe('#511 an escaped quote opening a value', () => {
  it('redacts a value that opens with \\" inside a JSON string', () => {
    const text = `{"msg":"login password: ${BS}"QZ7 XJ3${BS}""}`;
    expect(redactSensitiveString(text)).toBe(`{"msg":"login password: ${BS}"${R}${BS}""}`);
  });

  it('keeps an inner escaped quote and backslash inside the value', () => {
    // Inner text `password: "a\"QZ7\\" ok`, encoded once more into a JSON string.
    const inner = 'password: "a\\"QZ7 XJ3\\\\" ok';
    const text = JSON.stringify({ msg: inner });
    const out = redactSensitiveString(text);
    expectNoSecret(out);
    expect(out).toBe(JSON.stringify({ msg: `password: "${R}" ok` }));
    expect(() => JSON.parse(out)).not.toThrow();
  });

  it('redacts a multi-line value (encoded \\n) and stops at the end of the outer string', () => {
    const text = JSON.stringify({ msg: 'token: "QZ7\nXJ3', next: 'kept' });
    const out = redactSensitiveString(text);
    expectNoSecret(out);
    // The unterminated inner value ends where the outer string ends.
    expect(out).toBe(`{"msg":"token: ${BS}"${R}","next":"kept"}`);
  });

  it('handles the single-quote form \\\'…\\\'', () => {
    expect(redactSensitiveString(`secret = ${BS}'QZ7 XJ3${BS}' done`)).toBe(`secret = ${BS}'${R}${BS}' done`);
  });
});

describe('#511 JSON embedded in a JSON string', () => {
  it('redacts {\\"password\\":\\"…\\"}', () => {
    const text = JSON.stringify({ msg: JSON.stringify({ password: 'QZ7 XJ3', user: 'bob' }) });
    const out = redactSensitiveString(text);
    expectNoSecret(out);
    expect(out).toBe(JSON.stringify({ msg: JSON.stringify({ password: R, user: 'bob' }) }));
  });

  it('redacts pretty-printed and nested embedded JSON', () => {
    const embedded = JSON.stringify({ config: { api_key: 'QZ7', refresh_token: 'XJ3 JQ9' }, ok: true }, null, 2);
    const out = redactSensitiveString(JSON.stringify({ msg: embedded }));
    expectNoSecret(out);
    expect(JSON.parse(JSON.parse(out).msg)).toEqual({ config: { api_key: R, refresh_token: R }, ok: true });
  });

  it('redacts an embedded number or bare value after an escaped key', () => {
    expectNoSecret(redactSensitiveString(`{"msg":"{${BS}"pin${BS}":7731QZ7}"}`));
  });

  it('leaves non-secret embedded JSON alone', () => {
    const text = JSON.stringify({ msg: JSON.stringify({ user: 'bob', count: 2 }) });
    expect(redactSensitiveString(text)).toBe(text);
  });
});

// #513: netlog bodies that are JSON in all but name.
describe('#513 name/value pairs', () => {
  it('redacts the value of a pair whose name is a secret key', () => {
    const body = JSON.stringify([{ name: 'password', value: 'QZ7' }, { name: 'user', value: 'bob' }]);
    expect(JSON.parse(redactBodyText(body))).toEqual([{ name: 'password', value: R }, { name: 'user', value: 'bob' }]);
  });

  it('accepts key and field as the name, and any value type', () => {
    const { value } = redactSensitiveValue({
      params: [
        { key: 'api_key', value: { id: 'QZ7' } },
        { field: 'csrf_token', value: ['XJ3'] },
        { name: 'Cookie', value: 'sid=JQ9' },
        { name: 'theme', value: 'dark' },
      ],
    });
    expectNoSecret(JSON.stringify(value));
    expect(value.params.map(p => p.value)).toEqual([R, R, R, 'dark']);
  });

  it('redacts HAR-style headers and form fields', () => {
    const har = JSON.stringify({ headers: [{ name: 'Authorization', value: 'Basic QZ7=' }], postData: { params: [{ name: 'pass', value: 'XJ3' }] } });
    expectNoSecret(redactBodyText(har, { mimeType: 'application/json' }));
  });
});

describe('#513 NDJSON, JSONP and BOM bodies', () => {
  it('redacts every line of an NDJSON body and keeps the line breaks', () => {
    const body = `{"token":"QZ7","n":1}\n{"n":2}\r\n\n[{"name":"secret","value":"XJ3"}]\n`;
    expect(redactBodyText(body, { mimeType: 'application/x-ndjson' }))
      .toBe(`{"token":"${R}","n":1}\n{"n":2}\r\n\n[{"name":"secret","value":"${R}"}]\n`);
  });

  it('falls back to the string rules when a line is not JSON', () => {
    const out = redactBodyText('{"a":1}\nnot json token=QZ7\n', { mimeType: 'text/plain' });
    expectNoSecret(out);
    expect(out.startsWith('{"a":1}\n')).toBe(true);
  });

  it('redacts a JSONP body structurally and keeps the callback', () => {
    for (const [head, tail] of [['cb(', ')'], ['cb(', ');'], ['/**/ jQuery123_456(', ');\n'], ['window.app.load (', ')']]) {
      const out = redactBodyText(`${head}{"session":{"id":"QZ7"},"ok":1}${tail}`, { mimeType: 'application/javascript' });
      expect(out).toBe(`${head}{"session":"${R}","ok":1}${tail}`);
    }
  });

  it('redacts BOM-prefixed JSON structurally and keeps the BOM', () => {
    const body = '\uFEFF{"password":{"v":"QZ7"},"ok":1}';
    expect(redactBodyText(body)).toBe(`\uFEFF{"password":"${R}","ok":1}`);
    expect(redactJsonText(body)).toEqual({ text: `\uFEFF{"password":"${R}","ok":1}`, changed: true });
    expect(redactBodyText(`\uFEFF)]}'\n{"token":["QZ7"]}`)).toBe(`\uFEFF)]}'\n{"token":"${R}"}`);
  });

  it('leaves non-secret structured bodies byte-identical', () => {
    for (const body of ['{"a":1}\n{"b":2}\n', 'cb({"a": 1})', '\uFEFF{"a":1}', '[{"name":"theme","value":"dark"}]']) {
      expect(redactBodyText(body)).toBe(body);
    }
  });
});

describe('#511/#513 stay linear', () => {
  const SIZE = 256 * 1024;
  const cases = {
    'escaped-quote values': () => `{"msg":"${`password: ${BS}"a${BS}" `.repeat(SIZE / 16)}"}`,
    'unterminated escaped quotes': () => `pin: ${BS}"`.repeat(SIZE / 7),
    'escaped backslash runs': () => `pin: ${BS}"${`${BS}${BS}`.repeat(SIZE / 2)}`,
    'escaped keys': () => `{${BS}"pin${BS}":${BS}"x${BS}",`.repeat(SIZE / 16),
    'mixed escaped and plain quotes': () => `pin: "${BS}"'${BS}'`.repeat(SIZE / 10),
  };
  for (const [name, make] of Object.entries(cases)) {
    it(`redacts 256 KB of ${name} in linear time`, () => {
      const text = make();
      const small = text.slice(0, text.length / 4);
      redactSensitiveString(small);
      const a = timed(() => redactSensitiveString(small));
      const b = timed(() => redactSensitiveString(text));
      expect(b.ms).toBeLessThan(500);
      expect(b.ms).toBeLessThan(Math.max(40, a.ms * 10));
    });
  }

  it('redacts a 1 MB NDJSON body and a 1 MB JSONP body quickly', () => {
    const line = JSON.stringify({ name: 'password', value: 'x', n: 1 });
    const ndjson = `${line}\n`.repeat(Math.ceil((1024 * 1024) / (line.length + 1)));
    expect(timed(() => redactBodyText(ndjson)).ms).toBeLessThan(2000);
    const jsonp = `cb(${JSON.stringify(Array.from({ length: 20000 }, (_, i) => ({ name: 'token', value: `v${i}` })))})`;
    expect(timed(() => redactBodyText(jsonp)).ms).toBeLessThan(2000);
    const notJsonp = `cb(${' '.repeat(1024 * 1024)}`;
    expect(timed(() => redactBodyText(notJsonp)).ms).toBeLessThan(500);
  });
});
