import { describe, expect, it } from 'vitest';

import {
  boundedStream,
  buildFailureFingerprint,
  classifyFailure,
  normalizeFailure,
  redactEvidence,
} from '../scripts/lib/validation-lab.mjs';

describe('validation evidence redaction', () => {
  it('recursively redacts sensitive keys and credential-bearing strings without mutating input', () => {
    const input = {
      password: 'fixture-password',
      auth: 'fixture-auth',
      session: 'fixture-session',
      key: 'fixture-key',
      sessionId: 'fixture-session-id',
      nested: {
        accessToken: 'fixture-access-token',
        headers: {
          authorization: 'Bearer fixture-bearer',
          cookie: 'sid=fixture-cookie',
          'x-api-key': 'fixture-x-api-key',
          'x-access-token': 'fixture-x-access-token',
          'private-token': 'fixture-private-token',
          'x-github-token': 'fixture-github-token',
          xGitHubToken: 'fixture-camel-token',
          apikey: 'fixture-apikey',
          API_KEY: 'fixture-api-underscore-key',
        },
        url: 'http://127.0.0.1:49321/page?token=fixture-query&safe=yes',
      },
      output: [
        'Authorization: Basic Zml4dHVyZTpwYXNz',
        'Set-Cookie: sid=raw-cookie',
        'X-API-Key: raw-api-key',
        'X-Access-Token: raw-access-token',
        'Private-Token: raw-private-token',
        'X-GitHub-Token: raw-github-token',
        'XGitHubToken: raw-camel-token',
        'ApiKey: raw-apikey',
        'API_KEY=raw-api-underscore-key',
        '[debug] X-API-Key: raw-prefixed-api-key',
        'request header X-Access-Token: raw-prefixed-access-token',
        'headers={"Private-Token":"raw-json-private-token"}',
        'Error: githubToken=raw-error-token',
        'config.apiKey=raw-qualified-api-key',
        'process.env.GITHUB_TOKEN=raw-env-token',
        'headers.X-API-Key: raw-qualified-header-key',
        '[debug]X-API-Key: raw-bracket-prefixed-key',
        'serialized={"password":"raw-comma,REMAINDER"}',
        'clientSecret="raw-semi;REMAINDER"',
        'xApiKey="raw-bracket]REMAINDER"',
        'githubToken="raw-hash#REMAINDER"',
        "privateToken='raw-amp&REMAINDER'",
        '--password "raw-cli value,REMAINDER"',
        'password="raw-unterminated-comma,UNTERMINATED_REMAINDER',
        "clientSecret='raw-unterminated-semi;UNTERMINATED_REMAINDER",
        'cmd --password "raw-cli-unterminated value UNTERMINATED_REMAINDER',
        'cmd --cookie sid=raw-cli-cookie trailing-output',
        'cmd --authorization Bearer raw-cli-authorization trailing-output',
        'cmd --auth raw-cli-auth trailing-output',
        'cmd --proxy-authorization Basic raw-cli-proxy trailing-output',
        'cmd --session raw-cli-session trailing-output',
        'cmd --key raw-cli-key trailing-output',
        'password=<redacted>TOPSECRET_PLACEHOLDER',
        'password=<redacted>,TOPSECRET_AFTER_DELIMITER',
      ].join('\n'),
      homePath: '/Users/example/private/work/file.mjs',
      tempPath: '/private/tmp/chrome-cdp-fixture/run.json',
      linuxPath: '/home/alice/private/work/file.mjs',
      windowsPath: 'C:\\Users\\Alice\\private\\work\\file.mjs',
      target: 'targetId=ABCDEF0123456789 port=49321 runId=run-secret-123',
    };
    const before = structuredClone(input);
    const result = redactEvidence(input, {
      homeDir: '/Users/example',
      tempDirs: ['/private/tmp/chrome-cdp-fixture'],
      ports: [49321],
      targetIds: ['ABCDEF0123456789'],
      runIds: ['run-secret-123'],
    });
    const serialized = JSON.stringify(result.value);

    expect(input).toEqual(before);
    for (const secret of [
      'fixture-password', 'fixture-access-token', 'fixture-bearer', 'fixture-cookie',
      'fixture-auth', 'fixture-session', 'fixture-key', 'fixture-session-id',
      'fixture-query', 'Zml4dHVyZTpwYXNz', 'raw-cookie', '/Users/example',
      'fixture-x-api-key', 'raw-api-key',
      'fixture-x-access-token', 'fixture-private-token', 'fixture-github-token',
      'fixture-apikey', 'fixture-api-underscore-key', 'raw-access-token',
      'fixture-camel-token', 'raw-camel-token',
      'raw-private-token', 'raw-github-token', 'raw-apikey', 'raw-api-underscore-key',
      'raw-prefixed-api-key', 'raw-prefixed-access-token', 'raw-json-private-token', 'raw-error-token',
      'raw-qualified-api-key', 'raw-env-token', 'raw-qualified-header-key', 'raw-bracket-prefixed-key',
      'raw-comma', 'raw-semi', 'raw-bracket', 'raw-hash', 'raw-amp', 'raw-cli', 'REMAINDER',
      'raw-unterminated', 'raw-cli-unterminated', 'UNTERMINATED_REMAINDER',
      'raw-cli-cookie', 'raw-cli-authorization', 'raw-cli-auth', 'raw-cli-proxy',
      'raw-cli-session', 'raw-cli-key',
      'TOPSECRET_PLACEHOLDER', 'TOPSECRET_AFTER_DELIMITER',
      '/private/tmp/chrome-cdp-fixture', '49321', 'ABCDEF0123456789', 'run-secret-123',
      '/home/alice', 'C:\\Users\\Alice',
    ]) expect(serialized).not.toContain(secret);
    expect(result.counts.sensitiveKey).toBeGreaterThanOrEqual(2);
    expect(result.counts.credential).toBeGreaterThanOrEqual(3);
    expect(result.counts.path).toBeGreaterThanOrEqual(2);
    expect(result.counts.identifier).toBeGreaterThanOrEqual(3);
    expect(result.value.nested.url).toContain('safe=yes');
  });

  it('does not redact ordinary content that merely mentions authorization concepts', () => {
    const result = redactEvidence({ note: 'Authorization policy is documented', count: 49321 }, {});
    expect(result.value).toEqual({ note: 'Authorization policy is documented', count: 49321 });
    expect(result.counts).toEqual({ credential: 0, identifier: 0, path: 0, sensitiveKey: 0 });
  });
});

describe('bounded validation streams', () => {
  it('stores only a UTF-8-safe head/tail preview plus byte metadata', () => {
    const text = `${'前'.repeat(100)}MIDDLE-SECRET${'後'.repeat(100)}`;
    const bounded = boundedStream(text, 96);

    expect(bounded.truncated).toBe(true);
    expect(bounded.bytes).toBe(Buffer.byteLength(text));
    expect(bounded.sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(Buffer.byteLength(bounded.preview)).toBeLessThanOrEqual(96);
    expect(bounded.preview).not.toContain('\uFFFD');
    expect(bounded.preview).not.toContain('MIDDLE-SECRET');
    expect(bounded.omittedBytes).toBeGreaterThan(0);
  });

  it('preserves a short stream exactly', () => {
    expect(boundedStream('ok ✓', 32)).toMatchObject({
      preview: 'ok ✓',
      bytes: 6,
      truncated: false,
      omittedBytes: 0,
    });
  });

  it('rejects non-positive or fractional byte limits', () => {
    for (const value of [0, -1, 1.5, 16]) expect(() => boundedStream('x'.repeat(200), value)).toThrow('maxBytes');
  });
});

describe('failure normalization and fingerprinting', () => {
  const base = {
    scenarioId: 'controlled-failure',
    scenarioDigest: `sha256:${'a'.repeat(64)}`,
    failedPhase: 'assertion',
    failedCheck: 'stdoutIncludes[0]',
    exitCode: 23,
    signal: null,
  };

  it('normalizes volatile paths, timestamps, ports, ids, pids, and stack lines', () => {
    const first = normalizeFailure({
      message: '2026-08-12T04:00:01.123Z failed /Users/alice/work/a.mjs:91:4 port=49321 pid=4242 targetId=ABCDEF012345 UUID 123e4567-e89b-12d3-a456-426614174000',
      homeDir: '/Users/alice',
      tempDirs: ['/private/tmp/run-a'],
    });
    const second = normalizeFailure({
      message: '2026-08-13T09:10:11.999Z failed /Users/bob/work/a.mjs:12:88 port=58888 pid=9999 targetId=FFEEDD009988 UUID 987e6543-e21b-12d3-a456-426614174999',
      homeDir: '/Users/bob',
      tempDirs: ['/private/tmp/run-b'],
    });

    expect(first).toBe(second);
    expect(first).toContain('<home>');
    expect(first).toContain('<port>');
    expect(first).not.toMatch(/49321|4242|ABCDEF012345|123e4567/);
  });

  it('gives the same logical failure the same fingerprint across volatile changes', () => {
    const left = buildFailureFingerprint({ ...base, normalizedFailure: 'failed <home>/x.mjs:<line>:<col> port=<port>' });
    const right = buildFailureFingerprint({ ...base, normalizedFailure: 'failed <home>/x.mjs:<line>:<col> port=<port>' });
    expect(left).toBe(right);
  });

  it('keeps scenario, check, and semantic near-collisions distinct', () => {
    const fingerprint = buildFailureFingerprint({ ...base, normalizedFailure: 'expected alpha' });
    expect(buildFailureFingerprint({ ...base, scenarioId: 'other', normalizedFailure: 'expected alpha' })).not.toBe(fingerprint);
    expect(buildFailureFingerprint({ ...base, failedCheck: 'stderrIncludes[0]', normalizedFailure: 'expected alpha' })).not.toBe(fingerprint);
    expect(buildFailureFingerprint({ ...base, normalizedFailure: 'expected beta' })).not.toBe(fingerprint);
  });

  it('requires the complete stable identity', () => {
    for (const key of ['scenarioId', 'scenarioDigest', 'failedPhase', 'failedCheck', 'normalizedFailure']) {
      const input = { ...base, normalizedFailure: 'failure' };
      delete input[key];
      expect(() => buildFailureFingerprint(input)).toThrow(key);
    }
  });
});

describe('exclusive failure classification', () => {
  function attempt(overrides = {}) {
    return {
      ok: false,
      status: 1,
      signal: null,
      timedOut: false,
      outputOverflow: false,
      spawnError: null,
      cleanupError: null,
      failedPhase: 'assertion',
      failedCheck: 'stdoutIncludes[0]',
      failureMessage: 'expected ready',
      stdout: { preview: 'not ready' },
      stderr: { preview: '' },
      ...overrides,
    };
  }

  const fixtureScenario = { id: 'fixture', classificationHints: ['product'] };

  it.each([
    ['ENOSPC', attempt({ spawnError: 'ENOSPC: no space left', failedPhase: 'execution', failedCheck: 'spawn' }), 'environment'],
    ['EADDRINUSE', attempt({ failureMessage: 'listen EADDRINUSE 127.0.0.1:9334' }), 'environment'],
    ['EMFILE', attempt({ failureMessage: 'EMFILE: too many open files' }), 'environment'],
    ['missing browser', attempt({ failureMessage: 'no supported Chrome browser binary found' }), 'environment'],
    ['live connection failure', attempt({ failureMessage: 'fetch failed: connect ECONNREFUSED 127.0.0.1:9344' }), 'environment'],
    ['policy denial', attempt({ failedPhase: 'policy', failedCheck: 'allowLive', failureMessage: 'live denied' }), 'scenario'],
    ['malformed scenario', attempt({ failedPhase: 'scenario', failedCheck: 'runner.entrypoint', failureMessage: 'invalid registry' }), 'scenario'],
  ])('classifies %s without trusting product hints', (_label, observed, expected) => {
    const result = classifyFailure([observed], fixtureScenario);
    expect(result.classification).toBe(expected);
    expect(['low', 'medium', 'high']).toContain(result.confidence);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it('does not treat browser-free product text containing fetch failed as an environment outage', () => {
    const observed = attempt({ failureMessage: 'fetch failed to return expected application data' });
    expect(classifyFailure([observed, structuredClone(observed)], {
      id: 'browser-free',
      risk: { browser: 'none', network: 'none' },
    }).classification).toBe('product');
  });

  it('classifies an explicit CDP reachability marker as environment evidence', () => {
    expect(classifyFailure([attempt({
      failureMessage: 'CDP_REACHABILITY: fetch failed: connect ECONNREFUSED 127.0.0.1:9344',
    })], { id: 'live', risk: { browser: 'disposable-local', network: 'loopback' } }).classification).toBe('environment');
  });

  it('classifies fail-then-pass as flake', () => {
    const passed = attempt({ ok: true, status: 0, failedPhase: null, failedCheck: null, failureMessage: '', stdout: { preview: 'ready' } });
    expect(classifyFailure([attempt(), passed], fixtureScenario).classification).toBe('flake');
  });

  it('classifies repeatable same-semantic assertion failures as product', () => {
    const result = classifyFailure([
      attempt({ failureMessage: 'expected ready at 2026-08-11T03:00:00Z' }),
      attempt({ failureMessage: 'expected ready at 2026-08-12T04:00:00Z' }),
    ], fixtureScenario);
    expect(result).toMatchObject({ classification: 'product', confidence: 'high' });
  });

  it('keeps an ambiguous first assertion conservative', () => {
    const result = classifyFailure([attempt()], fixtureScenario);
    expect(result).toMatchObject({ classification: 'product', confidence: 'low' });
    expect(result.reasons.join(' ')).toContain('single');
  });

  it('refuses to classify a run with no observed failure', () => {
    expect(() => classifyFailure([{ ...attempt(), ok: true }], fixtureScenario)).toThrow('no failed attempt');
  });
});
