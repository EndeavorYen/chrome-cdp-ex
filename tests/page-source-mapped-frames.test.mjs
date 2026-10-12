import { describe, expect, it, vi } from 'vitest';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
const {
  SOURCE_MAP_LIMITS,
  captureStackFrames,
  createSourceMapResolver,
  decodeDataUrl,
  decodeVlq,
  displaySourcePath,
  extractSourceMappingUrl,
  formatGeneratedFrame,
  lookupOriginalPosition,
  sourceMapBytes,
  parseSourceMap,
  resolveSourceUrl,
} = await import('../skills/chrome-cdp-ex/scripts/lib/source-maps.mjs');

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// Tiny Source Map v3 encoder so fixtures state absolute positions instead of opaque VLQ strings.
function encodeVlq(value) {
  let v = value < 0 ? ((-value) * 2) + 1 : value * 2;
  let out = '';
  do {
    let digit = v % 32;
    v = Math.floor(v / 32);
    if (v > 0) digit += 32;
    out += B64[digit];
  } while (v > 0);
  return out;
}

// lines[generatedLine] = [[genCol, sourceIndex, sourceLine, sourceColumn, nameIndex?] | [genCol], ...]
function encodeMappings(lines) {
  const prev = { source: 0, line: 0, column: 0, name: 0 };
  return lines.map((segments) => {
    let prevCol = 0;
    return segments.map((segment) => {
      const fields = [segment[0] - prevCol];
      prevCol = segment[0];
      if (segment.length >= 4) {
        fields.push(segment[1] - prev.source, segment[2] - prev.line, segment[3] - prev.column);
        prev.source = segment[1];
        prev.line = segment[2];
        prev.column = segment[3];
        if (segment.length >= 5) {
          fields.push(segment[4] - prev.name);
          prev.name = segment[4];
        }
      }
      return fields.map(encodeVlq).join('');
    }).join(',');
  }).join(';');
}

const BUNDLE_URL = 'https://app.example/assets/index-3fa9c2.js';
const BUNDLE_MAP = JSON.stringify({
  version: 3,
  file: 'index-3fa9c2.js',
  sources: ['../../node_modules/react/index.js', '../../src/components/Foo.tsx', '../../src/main.ts'],
  names: ['render', 'boot'],
  mappings: encodeMappings([
    [
      [0, 0, 0, 0],
      [100, 2, 9, 2, 1],
      [48200, 1, 41, 6, 0],
      [48300], // generated-only code (bundler glue)
      [48400, 2, 3, 0],
    ],
    [[0, 2, 20, 4]],
  ]),
});
const BUNDLE_SOURCE = `!function(){/* minified */}();\n//# sourceMappingURL=index-3fa9c2.js.map\n`;

function fakeLoader(resources) {
  return vi.fn(async (url, opts) => {
    const value = resources[url];
    if (typeof value === 'function') return value(url, opts);
    return value ?? null;
  });
}

describe('#470 VLQ decoding against a known map', () => {
  it('decodes signed base64 VLQ segments and rejects malformed input', () => {
    expect(decodeVlq('AAAA')).toEqual([0, 0, 0, 0]);
    expect(decodeVlq('AAgBC')).toEqual([0, 0, 16, 1]);
    expect(decodeVlq('D')).toEqual([-1]);
    expect(decodeVlq('2H')).toEqual([123]);
    expect(decodeVlq('//D')).toEqual([-2047]);
    expect(decodeVlq('+/D')).toEqual([2047]);
    expect(decodeVlq('g')).toBeNull(); // continuation bit with no next digit
    expect(decodeVlq('A!')).toBeNull();
    for (const n of [0, 1, -1, 15, 16, -16, 1000, -48213, 2 ** 30]) {
      expect(decodeVlq(encodeVlq(n))).toEqual([n]);
    }
  });

  it('looks up the spec example map (AAgBC,SAAQ,CAAEA)', () => {
    const map = parseSourceMap(JSON.stringify({
      version: 3,
      file: 'out.js',
      sourceRoot: '',
      sources: ['foo.js', 'bar.js'],
      names: ['src', 'maps', 'are', 'fun'],
      mappings: 'AAgBC,SAAQ,CAAEA',
    }), 'https://cdn.example/js/out.js.map');
    expect(lookupOriginalPosition(map, 0, 0)).toEqual({
      source: 'https://cdn.example/js/foo.js', line: 17, column: 2, name: null,
    });
    expect(lookupOriginalPosition(map, 0, 9)).toMatchObject({ line: 17, column: 10 });
    expect(lookupOriginalPosition(map, 0, 40)).toEqual({
      source: 'https://cdn.example/js/foo.js', line: 17, column: 12, name: 'src',
    });
    expect(lookupOriginalPosition(map, 1, 0)).toBeNull();
  });

  it('finds the greatest segment at or before the column, across lines, and honours generated-only segments', () => {
    const map = parseSourceMap(BUNDLE_MAP, `${BUNDLE_URL}.map`);
    expect(lookupOriginalPosition(map, 0, 48212)).toEqual({
      source: 'https://app.example/src/components/Foo.tsx', line: 42, column: 7, name: 'render',
    });
    expect(lookupOriginalPosition(map, 0, 150)).toMatchObject({ source: 'https://app.example/src/main.ts', line: 10, column: 3 });
    expect(lookupOriginalPosition(map, 0, 48350)).toBeNull();
    expect(lookupOriginalPosition(map, 0, 48401)).toMatchObject({ line: 4, column: 1 });
    expect(lookupOriginalPosition(map, 1, 3)).toMatchObject({ source: 'https://app.example/src/main.ts', line: 21, column: 5 });
    expect(lookupOriginalPosition(map, 7, 0)).toBeNull();
  });

  it('rejects maps it cannot read instead of guessing', () => {
    expect(parseSourceMap('not json')).toBeNull();
    expect(parseSourceMap(JSON.stringify({ version: 2, sources: [], mappings: '' }))).toBeNull();
    expect(parseSourceMap(JSON.stringify({ version: 3, sections: [] }))).toBeNull();
    const broken = parseSourceMap(JSON.stringify({ version: 3, sources: ['a.ts'], names: [], mappings: 'A!AA' }));
    expect(lookupOriginalPosition(broken, 0, 5)).toBeNull();
  });
});

describe('#470 sources / sourceRoot resolution', () => {
  it('resolves relative sources against the map URL and prefixes sourceRoot', () => {
    expect(resolveSourceUrl('../../src/components/Foo.tsx', undefined, `${BUNDLE_URL}.map`))
      .toBe('https://app.example/src/components/Foo.tsx');
    expect(resolveSourceUrl('components/Foo.tsx', 'src', `${BUNDLE_URL}.map`))
      .toBe('https://app.example/assets/src/components/Foo.tsx');
    expect(resolveSourceUrl('Foo.tsx', '/src/components/', `${BUNDLE_URL}.map`))
      .toBe('https://app.example/src/components/Foo.tsx');
    expect(resolveSourceUrl('webpack://shop/./src/Cart.tsx', 'ignored/', `${BUNDLE_URL}.map`))
      .toBe('webpack://shop/src/Cart.tsx');
  });

  it('displays a short repository-style path, bounded from the front', () => {
    expect(displaySourcePath('https://app.example/src/components/Foo.tsx')).toBe('src/components/Foo.tsx');
    expect(displaySourcePath('webpack://shop/src/Cart.tsx')).toBe('src/Cart.tsx');
    expect(displaySourcePath('webpack:///./src/Cart.tsx')).toBe('src/Cart.tsx');
    expect(displaySourcePath('http://localhost:5173/src/My%20App.vue')).toBe('src/My App.vue');
    const long = displaySourcePath(`https://app.example/${'deep/'.repeat(40)}Foo.tsx`);
    expect(long.length).toBe(SOURCE_MAP_LIMITS.maxDisplayPath);
    expect(long.startsWith('…')).toBe(true);
    expect(long.endsWith('/Foo.tsx')).toBe(true);
  });

  it('reads only a trailing sourceMappingURL comment and decodes data: maps', () => {
    expect(extractSourceMappingUrl(BUNDLE_SOURCE)).toBe('index-3fa9c2.js.map');
    expect(extractSourceMappingUrl('x()\n//@ sourceMappingURL=old.map')).toBe('old.map');
    expect(extractSourceMappingUrl('x()\n//# sourceMappingURL=a.map\n//# sourceURL=app.js\n')).toBe('a.map');
    expect(extractSourceMappingUrl('const s = "//# sourceMappingURL=fake.map"; run();')).toBeNull();
    expect(extractSourceMappingUrl('no comment')).toBeNull();
    const json = '{"version":3}';
    expect(decodeDataUrl(`data:application/json;charset=utf-8;base64,${Buffer.from(json).toString('base64')}`)).toBe(json);
    expect(decodeDataUrl(`data:application/json,${encodeURIComponent(json)}`)).toBe(json);
    expect(decodeDataUrl(`data:application/json;base64,${'A'.repeat(100)}`, 10)).toBeNull();
  });
});

describe('#470 resolver: rewrite, fallback, bounds', () => {
  const frame = { url: BUNDLE_URL, line: 0, column: 48212 };

  it('rewrites a frame to src/... and keeps the generated location in parentheses', async () => {
    const loadText = fakeLoader({ [BUNDLE_URL]: BUNDLE_SOURCE, [`${BUNDLE_URL}.map`]: BUNDLE_MAP });
    const resolver = createSourceMapResolver({ loadText });
    await expect(resolver.resolveFrames([frame, { url: BUNDLE_URL, line: 0, column: 120 }])).resolves.toEqual([
      'src/components/Foo.tsx:42:7 (index-3fa9c2.js:1:48213)',
      'src/main.ts:10:3 (index-3fa9c2.js:1:121)',
    ]);
    // cached per script URL: one script read and one map read, however many frames resolve
    await resolver.resolveFrames([frame, frame]);
    expect(loadText.mock.calls.map(([url, opts]) => [url, opts.kind])).toEqual([
      [BUNDLE_URL, 'script'],
      [`${BUNDLE_URL}.map`, 'map'],
    ]);
    // each load may outlive one output's 1.5 s wait, so a slow map lands for the next output
    expect(loadText.mock.calls[1][1]).toMatchObject({ maxBytes: 5 * 1024 * 1024, timeoutMs: 10_000 });
  });

  it('resolves an inline data: map (Vite dev) against the script URL without a second load', async () => {
    const devUrl = 'http://localhost:5173/src/components/Foo.tsx?t=1712';
    const devMap = JSON.stringify({ version: 3, sources: ['Foo.tsx'], names: [], mappings: encodeMappings([[], [[2, 0, 6, 4]]]) });
    const script = `import x from "/x";\nfoo();\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(devMap).toString('base64')}`;
    const loadText = fakeLoader({ [devUrl]: script });
    const resolver = createSourceMapResolver({ loadText });
    await expect(resolver.resolveFrames([{ url: devUrl, line: 1, column: 2 }]))
      .resolves.toEqual(['src/components/Foo.tsx:7:5 (Foo.tsx:2:3)']);
    expect(loadText).toHaveBeenCalledTimes(1);
  });

  it('falls back to the generated frame for a missing, oversized, broken, throwing or non-http map', async () => {
    const cases = {
      'no comment': fakeLoader({ [BUNDLE_URL]: '!function(){}();' }),
      'map 404': fakeLoader({ [BUNDLE_URL]: BUNDLE_SOURCE }),
      'oversized map': fakeLoader({ [BUNDLE_URL]: BUNDLE_SOURCE, [`${BUNDLE_URL}.map`]: `{"version":3,"x":"${'a'.repeat(5 * 1024 * 1024)}"}` }),
      'broken json': fakeLoader({ [BUNDLE_URL]: BUNDLE_SOURCE, [`${BUNDLE_URL}.map`]: '{"version":3,' }),
      'loader throws': vi.fn(async () => { throw new Error('Network.loadNetworkResource failed'); }),
      'unsupported scheme': fakeLoader({ [BUNDLE_URL]: '!0;\n//# sourceMappingURL=chrome-extension://abc/x.map' }),
    };
    for (const [name, loadText] of Object.entries(cases)) {
      const resolver = createSourceMapResolver({ loadText });
      await expect(resolver.resolveFrames([frame]), name).resolves.toEqual(['index-3fa9c2.js:1:48213']);
    }
    const resolver = createSourceMapResolver({ loadText: vi.fn() });
    await expect(resolver.resolveFrames([{ url: 'chrome-extension://abc/x.js', line: 0, column: 0 }]))
      .resolves.toEqual(['x.js:1:1']);
  });

  it('caches a definitive miss but retries after a transient failure', async () => {
    const missing = fakeLoader({ [BUNDLE_URL]: BUNDLE_SOURCE }); // map -> null (HTTP 404)
    const cached = createSourceMapResolver({ loadText: missing });
    await cached.resolveFrames([frame]);
    await cached.resolveFrames([frame]);
    expect(missing).toHaveBeenCalledTimes(2); // one script read + one map read, not repeated

    let attempt = 0;
    const flaky = fakeLoader({
      [BUNDLE_URL]: BUNDLE_SOURCE,
      [`${BUNDLE_URL}.map`]: () => {
        attempt += 1;
        if (attempt === 1) throw new Error('Timeout: Network.loadNetworkResource');
        return BUNDLE_MAP;
      },
    });
    let clock = 1_000;
    const retrying = createSourceMapResolver({ loadText: flaky, now: () => clock });
    await expect(retrying.resolveFrames([frame])).resolves.toEqual(['index-3fa9c2.js:1:48213']);
    // inside the back-off window the script is not loaded again
    clock += 4_000;
    await expect(retrying.resolveFrames([frame])).resolves.toEqual(['index-3fa9c2.js:1:48213']);
    expect(flaky).toHaveBeenCalledTimes(2);
    clock += 1_001;
    await expect(retrying.resolveFrames([frame])).resolves.toEqual(['src/components/Foo.tsx:42:7 (index-3fa9c2.js:1:48213)']);
  });

  it('backs off a map host that keeps failing, doubling up to 60 s', async () => {
    let clock = 0;
    const loadText = fakeLoader({
      [BUNDLE_URL]: BUNDLE_SOURCE,
      [`${BUNDLE_URL}.map`]: () => { throw new Error('net::ERR_CONNECTION_TIMED_OUT'); },
    });
    const resolver = createSourceMapResolver({ loadText, now: () => clock });
    const mapLoads = () => loadText.mock.calls.filter(([, opts]) => opts.kind === 'map').length;
    const retryTimes = [];
    for (let t = 0; t <= 200_000; t += 1_000) {
      clock = t;
      const before = mapLoads();
      await resolver.resolveFrames([frame]);
      if (mapLoads() > before) retryTimes.push(t);
    }
    // 5 s, 10 s, 20 s, 40 s, then 60 s apart
    expect(retryTimes.slice(0, 7)).toEqual([0, 5_000, 15_000, 35_000, 75_000, 135_000, 195_000]);
  });

  it('charges only the first output while a load hangs', async () => {
    const hung = new Promise(() => {});
    const loadText = fakeLoader({ [BUNDLE_URL]: BUNDLE_SOURCE, [`${BUNDLE_URL}.map`]: () => hung });
    const resolver = createSourceMapResolver({ loadText, limits: { ...SOURCE_MAP_LIMITS, budgetMs: 60 } });
    let started = Date.now();
    await expect(resolver.resolveFrames([frame])).resolves.toEqual(['index-3fa9c2.js:1:48213']);
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    started = Date.now();
    for (let i = 0; i < 5; i += 1) {
      await expect(resolver.resolveFrames([frame])).resolves.toEqual(['index-3fa9c2.js:1:48213']);
    }
    expect(Date.now() - started).toBeLessThan(50);
    expect(loadText.mock.calls.filter(([, opts]) => opts.kind === 'map')).toHaveLength(1);
  });

  it('decodes each generated line once and binary-searches it', () => {
    const map = parseSourceMap(BUNDLE_MAP, `${BUNDLE_URL}.map`);
    expect(map.lines.size).toBe(0);
    expect(lookupOriginalPosition(map, 0, 48212)).toMatchObject({ line: 42, column: 7 });
    const afterFirst = sourceMapBytes(map);
    for (const column of [0, 99, 100, 150, 48199, 48200, 48299, 48300, 48399, 48400, 900_000]) {
      lookupOriginalPosition(map, 0, column);
    }
    expect(map.lines.size).toBe(1);
    expect(sourceMapBytes(map)).toBe(afterFirst);
    expect(lookupOriginalPosition(map, 0, 99)).toMatchObject({ source: 'https://app.example/node_modules/react/index.js', line: 1, column: 1 });
    expect(lookupOriginalPosition(map, 0, 48299)).toMatchObject({ line: 42 });
    expect(lookupOriginalPosition(map, 0, 48300)).toBeNull();
    expect(lookupOriginalPosition(map, 1, 0)).toMatchObject({ line: 21, column: 5 });
    expect(map.lines.size).toBe(2);

    // segments out of column order still resolve by greatest column at or before the target
    const unsorted = parseSourceMap(JSON.stringify({
      version: 3, sources: ['a.ts'], names: [],
      mappings: [encodeVlq(50), encodeVlq(0), encodeVlq(4), encodeVlq(0)].join('')
        + ',' + [encodeVlq(-40), encodeVlq(0), encodeVlq(-4), encodeVlq(0)].join(''),
    }), 'https://x.example/a.js.map');
    expect(lookupOriginalPosition(unsorted, 0, 20)).toMatchObject({ line: 1 });
    expect(lookupOriginalPosition(unsorted, 0, 60)).toMatchObject({ line: 5 });

    // a 600k-segment one-line map: one decode, then fast lookups
    const big = [];
    let prevCol = 0;
    let prevSrcCol = 0;
    for (let i = 0; i < 600_000; i += 1) {
      big.push(encodeVlq(i * 5 - prevCol) + 'A' + 'A' + encodeVlq(i - prevSrcCol));
      prevCol = i * 5;
      prevSrcCol = i;
    }
    const bigMap = parseSourceMap(JSON.stringify({ version: 3, sources: ['big.ts'], names: [], mappings: big.join(',') }), 'https://x.example/big.js.map');
    lookupOriginalPosition(bigMap, 0, 0);
    const started = Date.now();
    for (let i = 0; i < 1000; i += 1) {
      const target = (i * 2_999) % 600_000;
      expect(lookupOriginalPosition(bigMap, 0, target * 5 + 2).column).toBe(target + 1);
    }
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('evicts least recently used maps past the memory cap', async () => {
    const urls = ['https://app.example/a.js', 'https://app.example/b.js', 'https://app.example/c.js'];
    const resources = {};
    for (const url of urls) {
      resources[url] = `x();\n//# sourceMappingURL=${url.split('/').pop()}.map`;
      resources[`${url}.map`] = BUNDLE_MAP;
    }
    const loadText = fakeLoader(resources);
    const oneMap = sourceMapBytes(parseSourceMap(BUNDLE_MAP, 'https://app.example/a.js.map'));
    const resolver = createSourceMapResolver({
      loadText,
      limits: { ...SOURCE_MAP_LIMITS, maxCacheBytes: oneMap * 2 + 400 },
    });
    for (const url of urls) {
      await expect(resolver.resolveFrames([{ url, line: 0, column: 48212 }]))
        .resolves.toEqual([`src/components/Foo.tsx:42:7 (${url.split('/').pop()}:1:48213)`]);
    }
    expect(resolver.bytes).toBeLessThanOrEqual(oneMap * 2 + 400);
    expect(resolver.size).toBe(2);
    // the evicted (oldest) map is simply read again on demand
    await resolver.resolveFrames([{ url: urls[0], line: 0, column: 48212 }]);
    expect(loadText.mock.calls.filter(([url]) => url === `${urls[0]}.map`)).toHaveLength(2);
  });

  it('never waits past the time budget, and a late map still serves the next output', async () => {
    let release;
    const slowMap = new Promise((resolve) => { release = resolve; });
    const loadText = fakeLoader({ [BUNDLE_URL]: BUNDLE_SOURCE, [`${BUNDLE_URL}.map`]: () => slowMap });
    const resolver = createSourceMapResolver({ loadText, limits: { ...SOURCE_MAP_LIMITS, budgetMs: 40 } });
    const started = Date.now();
    await expect(resolver.resolveFrames([frame])).resolves.toEqual(['index-3fa9c2.js:1:48213']);
    expect(Date.now() - started).toBeLessThan(1000);
    release(BUNDLE_MAP);
    await new Promise(resolve => setTimeout(resolve, 0)); // the next output comes on a later turn
    await expect(resolver.resolveFrames([frame])).resolves.toEqual(['src/components/Foo.tsx:42:7 (index-3fa9c2.js:1:48213)']);
    expect(loadText).toHaveBeenCalledTimes(2);
  });

  it('bounds captured frames, the cache, and clears on demand', async () => {
    const callFrames = Array.from({ length: 10 }, (_, i) => ({ url: `${BUNDLE_URL}?v=${i}`, lineNumber: 0, columnNumber: i }));
    expect(captureStackFrames({ callFrames })).toHaveLength(3);
    expect(captureStackFrames({ callFrames: [{ url: '', lineNumber: 1 }, ...callFrames] })[0].column).toBe(0);
    expect(captureStackFrames(undefined, { url: BUNDLE_URL, lineNumber: 4, columnNumber: 9 }))
      .toEqual([{ url: BUNDLE_URL, line: 4, column: 9 }]);
    expect(captureStackFrames({ callFrames: [{ url: `https://x.example/${'a'.repeat(5000)}.js` }] })[0].url.length)
      .toBe(SOURCE_MAP_LIMITS.maxFrameUrl);
    expect(formatGeneratedFrame({ url: `${BUNDLE_URL}?token=secret#x`, line: 0, column: 0 })).toBe('index-3fa9c2.js:1:1');

    const loadText = vi.fn(async () => null);
    const resolver = createSourceMapResolver({ loadText, limits: { ...SOURCE_MAP_LIMITS, maxCachedScripts: 2 } });
    await resolver.resolveFrames(callFrames.slice(0, 3).map(f => ({ url: f.url, line: 0, column: 0 })));
    expect(resolver.size).toBe(2);
    resolver.clear();
    expect(resolver.size).toBe(0);
  });
});

describe('#470 daemon integration', () => {
  const minifiedTrace = {
    callFrames: [
      { functionName: 'render', url: BUNDLE_URL, lineNumber: 0, columnNumber: 48212 },
      { functionName: 'boot', url: BUNDLE_URL, lineNumber: 0, columnNumber: 120 },
      { functionName: '', url: BUNDLE_URL, lineNumber: 1, columnNumber: 3 },
      { functionName: 'extra', url: BUNDLE_URL, lineNumber: 1, columnNumber: 9 },
    ],
  };

  function resolverFor() {
    return createSourceMapResolver({
      loadText: fakeLoader({ [BUNDLE_URL]: BUNDLE_SOURCE, [`${BUNDLE_URL}.map`]: BUNDLE_MAP }),
    });
  }

  it('captures up to three frames and a 1-based generated loc, including line 1 of a minified bundle', () => {
    const entry = T.consoleEntryFromEvent({ type: 'error', args: [{ value: 'save failed' }], stackTrace: minifiedTrace }, 5);
    expect(entry).toMatchObject({ level: 'error', text: 'save failed', loc: 'index-3fa9c2.js:1:48213', ts: 5 });
    expect(entry.frames).toHaveLength(3);
    const exception = T.exceptionEntryFromEvent({
      exceptionDetails: {
        text: 'Uncaught',
        url: BUNDLE_URL,
        lineNumber: 0,
        columnNumber: 48212,
        exception: { description: 'TypeError: x is undefined' },
      },
    }, 6);
    expect(exception).toMatchObject({ msg: 'TypeError: x is undefined', loc: 'index-3fa9c2.js:1:48213', ts: 6 });
  });

  it('prints source-mapped frames in console text and JSON without leaking raw frame URLs', async () => {
    const consoleBuf = new T.RingBuffer(10);
    const exceptionBuf = new T.RingBuffer(10);
    consoleBuf.push(T.consoleEntryFromEvent({ type: 'log', args: [{ value: 'hello' }], stackTrace: minifiedTrace }, 1));
    consoleBuf.push(T.consoleEntryFromEvent({ type: 'error', args: [{ value: 'save failed' }], stackTrace: minifiedTrace }, 2));
    exceptionBuf.push(T.exceptionEntryFromEvent({
      exceptionDetails: { exception: { description: 'Error: boom' }, stackTrace: minifiedTrace },
    }, 3));
    const resolver = resolverFor();
    const locate = entries => resolver.locateEntries(entries);

    const text = await T.consoleStr(consoleBuf, exceptionBuf, { console: 0, exception: 0 }, '--all', { locate });
    expect(text).toBe([
      '[log] hello (index-3fa9c2.js:1:48213)',
      '[error] save failed (src/components/Foo.tsx:42:7 (index-3fa9c2.js:1:48213))',
      '    at src/main.ts:10:3 (index-3fa9c2.js:1:121)',
      '    at src/main.ts:21:5 (index-3fa9c2.js:2:4)',
      '--- Uncaught Exceptions ---',
      '[exception] Error: boom at src/components/Foo.tsx:42:7 (index-3fa9c2.js:1:48213)',
      '    at src/main.ts:10:3 (index-3fa9c2.js:1:121)',
      '    at src/main.ts:21:5 (index-3fa9c2.js:2:4)',
    ].join('\n'));

    const located = await T.locateObservedEntries(locate, consoleBuf.all(), exceptionBuf.all());
    const model = T.buildConsoleModel(consoleBuf, exceptionBuf, { console: 0, exception: 0 }, '--all', located);
    expect(model.entries[1]).toEqual({
      level: 'error',
      text: 'save failed',
      loc: 'src/components/Foo.tsx:42:7 (index-3fa9c2.js:1:48213)',
      stack: [
        'src/components/Foo.tsx:42:7 (index-3fa9c2.js:1:48213)',
        'src/main.ts:10:3 (index-3fa9c2.js:1:121)',
        'src/main.ts:21:5 (index-3fa9c2.js:2:4)',
      ],
      ts: 2,
      _seq: 2,
    });
    // an unresolved (log-level) entry still exposes its generated frames, never raw URLs
    expect(model.entries[0]).toMatchObject({ loc: 'index-3fa9c2.js:1:48213', stack: expect.any(Array) });
    expect(model.exceptions[0].loc).toBe('src/components/Foo.tsx:42:7 (index-3fa9c2.js:1:48213)');
    expect(JSON.stringify(model)).not.toContain('https://app.example');
    expect(JSON.stringify(model)).not.toContain('"frames"');

    const status = T.buildStatusModel({
      targetId: 'T1', page: {}, consoleBuf, exceptionBuf, navBuf: new T.RingBuffer(2),
      lastReadSeq: { console: 0, exception: 0 }, located,
    });
    expect(status.console[1].loc).toBe('src/components/Foo.tsx:42:7 (index-3fa9c2.js:1:48213)');
    expect(JSON.stringify(status)).not.toContain('"frames"');
  });

  it('source-maps the action receipt console/exception delta', async () => {
    const consoleBuf = new T.RingBuffer(10);
    const exceptionBuf = new T.RingBuffer(10);
    const netReqBuf = new T.RingBuffer(10);
    const baseline = T.createActionObservationBaseline({ consoleBuf, exceptionBuf, netReqBuf });
    consoleBuf.push(T.consoleEntryFromEvent({ type: 'error', args: [{ value: 'save failed' }], stackTrace: minifiedTrace }, 2));
    exceptionBuf.push(T.exceptionEntryFromEvent({ exceptionDetails: { exception: { description: 'Error: boom' }, stackTrace: minifiedTrace } }, 3));
    const resolver = resolverFor();
    const delta = await T.buildLocatedActionObservationDelta(
      { consoleBuf, exceptionBuf, netReqBuf }, baseline, entries => resolver.locateEntries(entries),
    );
    expect(delta.console.entries[0].loc).toBe('src/components/Foo.tsx:42:7 (index-3fa9c2.js:1:48213)');
    expect(delta.exceptions.entries[0].loc).toBe('src/components/Foo.tsx:42:7 (index-3fa9c2.js:1:48213)');

    const failing = await T.buildLocatedActionObservationDelta(
      { consoleBuf, exceptionBuf, netReqBuf }, baseline, async () => { throw new Error('resolver bug'); },
    );
    expect(failing.console.entries[0].loc).toBe('index-3fa9c2.js:1:48213');
  });

  it('loads scripts from the resource cache and maps through the frame network stack, size-capped', async () => {
    const reads = [Buffer.from('{"version":3,').toString('base64'), '"sources":[]}'];
    const send = vi.fn(async (method, params) => {
      switch (method) {
        case 'Page.getFrameTree': return { frameTree: { frame: { id: 'MAIN' } } };
        case 'Page.getResourceContent': return { content: BUNDLE_SOURCE, base64Encoded: false };
        case 'Network.loadNetworkResource': return { resource: { success: true, httpStatusCode: 200, stream: 'S1' } };
        case 'IO.read': {
          const data = reads.shift();
          return reads.length === 1 ? { data, base64Encoded: true, eof: false } : { data, base64Encoded: false, eof: true };
        }
        case 'IO.close': return {};
        default: throw new Error(`unexpected ${method} ${JSON.stringify(params)}`);
      }
    });
    const cdp = { send };
    await expect(T.loadSourceMapText(cdp, 'SID', BUNDLE_URL, { kind: 'script', maxBytes: 1000, timeoutMs: 1500 }))
      .resolves.toBe(BUNDLE_SOURCE);
    await expect(T.loadSourceMapText(cdp, 'SID', `${BUNDLE_URL}.map`, { kind: 'map', maxBytes: 1000, timeoutMs: 1500 }))
      .resolves.toBe('{"version":3,"sources":[]}');
    expect(send.mock.calls.find(([method]) => method === 'Network.loadNetworkResource')).toEqual([
      'Network.loadNetworkResource',
      { frameId: 'MAIN', url: `${BUNDLE_URL}.map`, options: { disableCache: false, includeCredentials: true } },
      'SID',
      60_000,
    ]);
    expect(send.mock.calls.filter(([method]) => method === 'IO.close')).toHaveLength(1);
    expect(send.mock.calls.some(([method]) => method.startsWith('Debugger.') || method === 'Runtime.evaluate')).toBe(false);

    reads.push('x'.repeat(2000));
    await expect(T.loadSourceMapText(cdp, 'SID', `${BUNDLE_URL}.map`, { kind: 'map', maxBytes: 1000, timeoutMs: 1500 }))
      .resolves.toBeNull();
    expect(send.mock.calls.filter(([method]) => method === 'IO.close')).toHaveLength(2);

    const failed = { send: vi.fn(async (method) => (method === 'Page.getFrameTree'
      ? { frameTree: { frame: { id: 'MAIN' } } }
      : { resource: { success: false, httpStatusCode: 404 } })) };
    await expect(T.loadSourceMapText(failed, 'SID', `${BUNDLE_URL}.map`, { kind: 'map', maxBytes: 1000, timeoutMs: 1500 }))
      .resolves.toBeNull();
    // a network error (navigation abort, server not up) is transient: thrown, so it is not cached
    const aborted = { send: vi.fn(async (method) => (method === 'Page.getFrameTree'
      ? { frameTree: { frame: { id: 'MAIN' } } }
      : { resource: { success: false, netError: -3, netErrorName: 'net::ERR_ABORTED' } })) };
    await expect(T.loadSourceMapText(aborted, 'SID', `${BUNDLE_URL}.map`, { kind: 'map', maxBytes: 1000, timeoutMs: 1500 }))
      .rejects.toThrow('net::ERR_ABORTED');
  });

  it('closes the stream of a loadNetworkResource reply that lands after the timeout', async () => {
    let answer;
    const send = vi.fn((method) => {
      if (method === 'Page.getFrameTree') return Promise.resolve({ frameTree: { frame: { id: 'MAIN' } } });
      if (method === 'Network.loadNetworkResource') return new Promise((resolve) => { answer = resolve; });
      return Promise.resolve({});
    });
    await expect(T.loadSourceMapText({ send }, 'SID', `${BUNDLE_URL}.map`, { kind: 'map', maxBytes: 1000, timeoutMs: 20 }))
      .rejects.toThrow('Timeout: Network.loadNetworkResource');
    expect(send.mock.calls.some(([method]) => method === 'IO.close')).toBe(false);
    answer({ resource: { success: true, httpStatusCode: 200, stream: 'LATE' } });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(send.mock.calls.filter(([method]) => method === 'IO.close')).toEqual([['IO.close', { handle: 'LATE' }, 'SID']]);
  });

  describe('status', () => {
    const pageCdp = () => ({
      send: vi.fn(async method => (method === 'Runtime.evaluate'
        ? { result: { value: JSON.stringify({ title: 'Shop', url: 'https://app.example/' }) } }
        : {})),
    });

    it('prints source-mapped console and exception frames in status text and JSON', async () => {
      const consoleBuf = new T.RingBuffer(10);
      const exceptionBuf = new T.RingBuffer(10);
      consoleBuf.push(T.consoleEntryFromEvent({ type: 'error', args: [{ value: 'save failed' }], stackTrace: minifiedTrace }, 2));
      exceptionBuf.push(T.exceptionEntryFromEvent({ exceptionDetails: { exception: { description: 'Error: boom' }, stackTrace: minifiedTrace } }, 3));
      const resolver = resolverFor();
      const locate = entries => resolver.locateEntries(entries);
      const lastReadSeq = { console: 0, exception: 0 };
      const text = await T.statusStr(pageCdp(), 'SID', consoleBuf, exceptionBuf, new T.RingBuffer(2), lastReadSeq, { locate });
      expect(text).toContain('  [error] save failed (src/components/Foo.tsx:42:7 (index-3fa9c2.js:1:48213))');
      expect(text).toContain('  Error: boom at src/components/Foo.tsx:42:7 (index-3fa9c2.js:1:48213)');
      expect(lastReadSeq).toEqual({ console: 1, exception: 1 });

      const located = await T.locateObservedEntries(locate, consoleBuf.all(), exceptionBuf.all());
      const model = T.buildStatusModel({
        targetId: 'T1', page: {}, consoleBuf, exceptionBuf, navBuf: new T.RingBuffer(2),
        lastReadSeq: { console: 0, exception: 0 }, located,
      });
      expect(model.console[0]).toMatchObject({
        loc: 'src/components/Foo.tsx:42:7 (index-3fa9c2.js:1:48213)',
        stack: [
          'src/components/Foo.tsx:42:7 (index-3fa9c2.js:1:48213)',
          'src/main.ts:10:3 (index-3fa9c2.js:1:121)',
          'src/main.ts:21:5 (index-3fa9c2.js:2:4)',
        ],
      });
      expect(model.exceptions[0].loc).toBe('src/components/Foo.tsx:42:7 (index-3fa9c2.js:1:48213)');
      expect(JSON.stringify(model)).not.toContain('"frames"');
    });

    it('leaves entries logged while source maps load unread for the next status', async () => {
      const consoleBuf = new T.RingBuffer(10);
      const exceptionBuf = new T.RingBuffer(10);
      consoleBuf.push(T.consoleEntryFromEvent({ type: 'error', args: [{ value: 'first' }], stackTrace: minifiedTrace }, 1));
      const locate = async (entries) => {
        // the page logs again while this status waits on map loads
        consoleBuf.push(T.consoleEntryFromEvent({ type: 'error', args: [{ value: 'during locate' }] }, 2));
        exceptionBuf.push(T.exceptionEntryFromEvent({ exceptionDetails: { exception: { description: 'Error: late' } } }, 3));
        return new Map(entries.map(entry => [entry, { loc: 'src/a.ts:1:1 (a.js:1:1)', stack: ['src/a.ts:1:1 (a.js:1:1)'] }]));
      };
      const lastReadSeq = { console: 0, exception: 0 };
      const first = await T.statusStr(pageCdp(), 'SID', consoleBuf, exceptionBuf, new T.RingBuffer(2), lastReadSeq, { locate });
      expect(first).toContain('[error] first (src/a.ts:1:1 (a.js:1:1))');
      expect(first).not.toContain('during locate');
      expect(first).not.toContain('Error: late');
      expect(lastReadSeq).toEqual({ console: 1, exception: 0 });

      const second = await T.statusStr(pageCdp(), 'SID', consoleBuf, exceptionBuf, new T.RingBuffer(2), lastReadSeq);
      expect(second).toContain('Console (1 new):');
      expect(second).toContain('[error] during locate');
      expect(second).toContain('Exceptions (1 new):');
      expect(second).toContain('Error: late');
      expect(lastReadSeq).toEqual({ console: 2, exception: 1 });
    });
  });
});
