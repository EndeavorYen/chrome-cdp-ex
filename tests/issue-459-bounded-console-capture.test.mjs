import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
const { redactSensitiveString, redactUrl, REDACTED_VALUE } = await import('../skills/chrome-cdp-ex/scripts/lib/redaction.mjs');

// #459: a page that logs a canvas toDataURL() or a big JSON blob must not make
// the daemon keep megabytes per entry, nor make every action receipt redact
// megabytes of text.
const TWO_MB = 2 * 1024 * 1024;
const CAP = T.MAX_CAPTURED_CONSOLE_CHARS;
const WINDOW = T.ACTION_TEXT_REDACT_WINDOW;

function dataUrl(bytes) {
  return `data:image/png;base64,${randomBytes(bytes).toString('base64')}`;
}

function timed(fn) {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
}

function deltaFor(consoleEntries = [], exceptionEntries = []) {
  const consoleBuf = new T.RingBuffer(200);
  const exceptionBuf = new T.RingBuffer(50);
  const baseline = T.createActionObservationBaseline({ consoleBuf, exceptionBuf });
  for (const entry of consoleEntries) consoleBuf.push(entry);
  for (const entry of exceptionEntries) exceptionBuf.push(entry);
  return T.buildActionObservationDelta({ consoleBuf, exceptionBuf }, baseline);
}

function consoleSample(text) {
  return deltaFor([{ level: 'log', text, loc: '' }]).console.entries[0].text;
}

describe('#459 console and exception capture is bounded at capture time', () => {
  it('caps a 2 MB console entry and records the original length', () => {
    const big = dataUrl(1536 * 1024);
    const entry = T.consoleEntryFromEvent({
      type: 'log',
      args: [{ type: 'string', value: 'frame:' }, { type: 'string', value: big }],
      stackTrace: { callFrames: [{ url: 'https://app.test/static/canvas.js', lineNumber: 42 }] },
    });
    expect(entry.level).toBe('log');
    expect(entry.loc).toBe('canvas.js:43:1'); // 1-based line:column since #470
    expect(entry.text.length).toBeLessThanOrEqual(CAP);
    expect(entry.text.startsWith('frame: data:image/png;base64,')).toBe(true);
    expect(entry.truncated).toBe(true);
    expect(entry.originalLength).toBe('frame: '.length + big.length);
  });

  it('keeps short entries unchanged and unmarked', () => {
    const entry = T.consoleEntryFromEvent({ type: 'error', args: [{ value: 'boom' }, { value: 3 }] });
    expect(entry).toMatchObject({ level: 'error', text: 'boom 3', loc: '' });
    expect(entry).not.toHaveProperty('truncated');
    expect(entry).not.toHaveProperty('originalLength');
  });

  it('caps a huge exception description', () => {
    const description = `Error: bad\n${'    at frame (https://app.test/x.js:1:1)\n'.repeat(60000)}`;
    const entry = T.exceptionEntryFromEvent({ exceptionDetails: { text: 'Uncaught', exception: { description } } });
    expect(entry.msg.startsWith('Error: bad')).toBe(true);
    expect(entry.msg.length).toBeLessThanOrEqual(CAP);
    expect(entry.truncated).toBe(true);
    expect(entry.originalLength).toBe(description.length);
  });

  it('does not split a surrogate pair at the cut', () => {
    const text = `${'a'.repeat(CAP - 1)}😀tail`;
    const entry = T.consoleEntryFromEvent({ type: 'log', args: [{ value: text }] });
    expect(entry.text).toBe('a'.repeat(CAP - 1));
    expect(entry.originalLength).toBe(text.length);
  });

  it('keeps nothing after a part that was cut at a surrogate pair', () => {
    const entry = T.consoleEntryFromEvent({ type: 'log', args: [{ value: `${'a'.repeat(CAP - 1)}😀` }, { value: 'b' }] });
    expect(entry.text).toBe('a'.repeat(CAP - 1));
    expect(entry.truncated).toBe(true);
  });
});

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('#459 every cut is surrogate-safe', () => {
  it('sliceAtCodePoint never splits a pair', () => {
    expect(T.sliceAtCodePoint('ab😀c', 3)).toBe('ab');
    expect(T.sliceAtCodePoint('ab😀c', 4)).toBe('ab😀');
    expect(T.sliceAtCodePoint('ab😀c', 2)).toBe('ab');
    expect(T.sliceAtCodePoint('ab', 10)).toBe('ab');
    expect(T.sliceAtCodePoint('ab', 0)).toBe('');
  });

  it('the redaction window cut, the receipt cut and the console line cut keep whole pairs', () => {
    for (let pad = 0; pad < 4; pad++) {
      // Emoji everywhere, so every cut offset can land in the middle of a pair.
      const text = `${'a'.repeat(pad)}${'😀'.repeat(WINDOW)}`;
      const sample = consoleSample(text);
      expect(sample, `pad ${pad}`).not.toMatch(LONE_SURROGATE);
      expect(T.compactActionText(text, 220 + pad)).not.toMatch(LONE_SURROGATE);
      expect(T.boundedConsoleLineText(text, {}, 300 + pad)).not.toMatch(LONE_SURROGATE);
    }
    // Window edge: only one emoji, straddling the 4096 cut.
    // Leading whitespace collapses, so the window edge is visible in the sample.
    const edge = `${' '.repeat(WINDOW - 5)}abcd😀 more`;
    expect(consoleSample(edge)).toBe('abcd…');
  });
});

describe('#459 compact delta entries truncate before redacting', () => {
  // Inputs that used to cost seconds (or never finish) in one receipt.
  const pathological = {
    'base64 data URL': () => dataUrl(1536 * 1024),
    'dotted run (a.a.a…)': () => 'a.'.repeat(TWO_MB / 2),
    'hyphenated run (a-a-a…)': () => 'a-'.repeat(TWO_MB / 2),
    'long upper-case key': () => ` ${'A'.repeat(TWO_MB)}=x`,
    'repeated pin assignments': () => "pin: 'pin' ".repeat(TWO_MB / 11),
  };

  for (const [name, make] of Object.entries(pathological)) {
    it(`compacts a 2 MB ${name} entry in under 50 ms`, () => {
      const text = make();
      // Stored unbounded on purpose: the compact path must be cheap on its own.
      const { value, ms } = timed(() => deltaFor(
        [{ level: 'log', text, loc: '' }],
        [{ msg: text, loc: '' }],
      ));
      expect(ms).toBeLessThan(50);
      expect(value.console.entries[0].text.length).toBeLessThanOrEqual(220);
      expect(value.console.entries[0].text.endsWith('…')).toBe(true);
      expect(value.exceptions.entries[0].message.length).toBeLessThanOrEqual(220);
    });
  }

  it('still redacts a token= assignment that sits right at the cut point', () => {
    // A long redacted value collapses to `<redacted>`, so whatever sits at the
    // redaction window edge becomes visible in the 220-char sample.
    for (let shift = -24; shift <= 24; shift++) {
      const lead = `token=${'v'.repeat(WINDOW - 40 + shift)} `;
      const text = `${lead}access_token=Xk7Wm4Pq2Zr8 password: "Hn3 Jd6 Lq9" next=1`;
      const sample = consoleSample(text);
      for (const part of ['Xk7', 'Wm4', 'Pq2', 'Zr8', 'Hn3', 'Jd6', 'Lq9']) {
        expect(sample, `shift ${shift}: ${sample}`).not.toContain(part);
      }
      expect(sample.startsWith(`token=${REDACTED_VALUE}`)).toBe(true);
    }
  });

  it('does not leak a quoted value whose closing quote was cut off', () => {
    const lead = `token=${'v'.repeat(WINDOW)} `;
    for (let keep = 1; keep <= 12; keep++) {
      const secret = 'Hn3 Jd6 Lq9';
      // Cut inside the quoted value: the rest of the value is beyond the window.
      const text = `${lead.slice(0, WINDOW - 'password: "'.length - keep)} password: "${secret}" ok=1`;
      const sample = consoleSample(text);
      for (const part of ['Hn', 'Jd', 'Lq']) expect(sample, `keep ${keep}: ${sample}`).not.toContain(part);
    }
  });

  it('does not leak a URL password whose @ was cut off', () => {
    const lead = `token=${'v'.repeat(WINDOW)} `;
    for (let keep = 1; keep <= 8; keep++) {
      const url = 'https://alice:Hn3Jd6Lq9@db.internal/x';
      const head = lead.slice(0, WINDOW - 'https://alice:'.length - keep);
      const sample = consoleSample(`${head} ${url} more`);
      expect(sample, `keep ${keep}: ${sample}`).not.toMatch(/alice:H|Hn|n3|Jd/);
      expect(sample).toContain('https://alice:');
    }
  });

  it('redacts a value cut short by the capture cap', () => {
    // A stored entry the capture cap cut inside a quoted value.
    const entry = { level: 'log', text: 'login session_id: "Hn3 Jd6', loc: '', truncated: true, originalLength: 50000 };
    const sample = deltaFor([entry]).console.entries[0].text;
    expect(sample).not.toContain('Hn3');
    expect(sample).not.toContain('Jd6');
    expect(sample.endsWith('…')).toBe(true);
  });
});

describe('#459 redaction regexes stay linear on long tokens', () => {
  const SIZE = 256 * 1024;
  const cases = {
    'dotted run': () => 'a.'.repeat(SIZE / 2),
    'hyphenated run': () => 'a-'.repeat(SIZE / 2),
    'upper-case key': () => ` ${'A'.repeat(SIZE)}=x`,
  };
  for (const [name, make] of Object.entries(cases)) {
    it(`redacts a 256 KB ${name} without quadratic backtracking`, () => {
      const text = make();
      const { value, ms } = timed(() => redactSensitiveString(text));
      // Quadratic before #459: ~15 s for this size. Linear: a few ms.
      expect(ms).toBeLessThan(500);
      expect(value.length).toBe(text.length);
    });
  }

  it('redacts a URL with a 256 KB upper-case query key in linear time', () => {
    const url = `https://x.test/?${'A'.repeat(SIZE)}=1&access_token=Xk7`;
    const { value, ms } = timed(() => redactUrl(url));
    expect(ms).toBeLessThan(500);
    expect(value).not.toContain('Xk7');
  });

  it('still redacts userinfo behind a long dotted custom scheme', () => {
    const scheme = 'com.googleusercontent.apps.123456789012-abcdefghijklmnopqrstuvwxyz012345';
    expect(redactSensitiveString(`open ${scheme}://user:Xk7Secret@host/cb`)).not.toContain('Xk7Secret');
  });

  it('redacts userinfo behind a scheme of any length (no length cap)', () => {
    const schemes = [
      'a'.repeat(70),
      `com.example.${'abcdefghij1234567890'.repeat(4)}`,
      'x'.repeat(5000),
    ];
    for (const scheme of schemes) {
      expect(scheme.length).toBeGreaterThanOrEqual(70);
      const text = `see ${scheme}://user:hunter2@host/x`;
      expect(redactSensitiveString(text)).toBe(`see ${scheme}://user:${REDACTED_VALUE}@host/x`);
      expect(redactUrl(`${scheme}://user:hunter2@host/x`)).toBe(`${scheme}://user:${REDACTED_VALUE}@host/x`);
      // Cut-off text whose `@` is gone.
      expect(redactSensitiveString(`see ${scheme}://user:hunt`, { truncated: true })).toBe(`see ${scheme}://user:${REDACTED_VALUE}`);
    }
  });

  it('matches long scheme runs in linear time', () => {
    for (const text of ['a.'.repeat(SIZE / 2), 'a'.repeat(SIZE), `${'a'.repeat(SIZE)}://user:`]) {
      const { ms } = timed(() => redactSensitiveString(text, { truncated: true }));
      expect(ms).toBeLessThan(500);
    }
  });
});

describe('#459 console text surfaces report truncation honestly', () => {
  const big = 'z'.repeat(TWO_MB);
  const entry = T.consoleEntryFromEvent({ type: 'error', args: [{ value: big }] });

  it('console --all shows the original length of a truncated entry', async () => {
    const consoleBuf = new T.RingBuffer(200);
    const exceptionBuf = new T.RingBuffer(50);
    consoleBuf.push(entry);
    exceptionBuf.push(T.exceptionEntryFromEvent({ exceptionDetails: { exception: { description: `Error: ${big}` } } }));
    const text = await T.consoleStr(consoleBuf, exceptionBuf, { console: 0, exception: 0 }, '--all');
    const [consoleLine, , exceptionLine] = text.split('\n');
    expect(consoleLine.length).toBeLessThan(400);
    expect(consoleLine).toContain(`[truncated, ${TWO_MB} chars]`);
    expect(exceptionLine).toContain(`[truncated, ${TWO_MB + 'Error: '.length} chars]`);
  });

  it('console --all --format json keeps truncated and originalLength', () => {
    const consoleBuf = new T.RingBuffer(200);
    consoleBuf.push(entry);
    const model = T.buildConsoleModel(consoleBuf, new T.RingBuffer(50), { console: 0, exception: 0 }, '--all');
    expect(model.entries[0]).toMatchObject({ truncated: true, originalLength: TWO_MB });
    expect(model.entries[0].text.length).toBeLessThanOrEqual(CAP);
  });

  it('marks a display cut even when the stored entry was not truncated', async () => {
    const consoleBuf = new T.RingBuffer(200);
    consoleBuf.push(T.consoleEntryFromEvent({ type: 'log', args: [{ value: 'q'.repeat(500) }] }));
    const text = await T.consoleStr(consoleBuf, new T.RingBuffer(50), { console: 0, exception: 0 }, '--all');
    expect(text).toContain('[truncated, 500 chars]');
  });

  it('status console lines are bounded and marked', async () => {
    const cdp = {
      send: (method) => Promise.resolve(method === 'Runtime.evaluate'
        ? { result: { value: JSON.stringify({ title: 'T', url: 'https://example.test/' }) } }
        : {}),
    };
    const consoleBuf = new T.RingBuffer(200);
    consoleBuf.push(entry);
    const out = await T.statusStr(cdp, 'sid1', consoleBuf, new T.RingBuffer(50), new T.RingBuffer(10), { console: 0, exception: 0 });
    const line = out.split('\n').find(l => l.startsWith('  [error]'));
    expect(line.length).toBeLessThan(300);
    expect(line).toContain(`[truncated, ${TWO_MB} chars]`);
  });

  it('record timeline lines are bounded and marked', async () => {
    const listeners = new Map();
    const cdp = {
      onEvent(method, cb) {
        if (!listeners.has(method)) listeners.set(method, new Set());
        listeners.get(method).add(cb);
        return () => listeners.get(method)?.delete(cb);
      },
      emit(method, params) { for (const cb of listeners.get(method) || []) cb(params); },
      send(method) {
        if (method === 'Runtime.enable') {
          queueMicrotask(() => {
            cdp.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ value: big }] });
            cdp.emit('Runtime.exceptionThrown', { exceptionDetails: { exception: { description: `Error: ${big}` } } });
          });
        }
        if (method === 'Runtime.evaluate') return Promise.resolve({ result: { value: JSON.stringify({ totals: {}, labels: [], count: 0 }) } });
        return Promise.resolve({});
      },
    };
    const output = await T.recordStr(cdp, 'sid1', ['100'], new Map());
    const consoleLine = output.split('\n').find(line => line.includes('console.log:'));
    const exceptionLine = output.split('\n').find(line => line.includes('exception: Error:'));
    expect(consoleLine.length).toBeLessThan(400);
    expect(consoleLine).toContain(`[truncated, ${TWO_MB} chars]`);
    expect(exceptionLine.length).toBeLessThan(400);
  });
});
