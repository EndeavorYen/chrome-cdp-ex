import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
const { buildMcpToolCommand } = await import('../skills/chrome-cdp-ex/scripts/lib/mcp-adapter.mjs');
const { MCP_TOOL_DEFINITIONS } = await import('../skills/chrome-cdp-ex/scripts/lib/command-surface.mjs');
const S = await import('../skills/chrome-cdp-ex/scripts/lib/secrets.mjs');
const R = await import('../skills/chrome-cdp-ex/scripts/lib/redaction.mjs');
// The daemon's session scrub: value -> <secret:NAME>, values under 4 characters skipped.
const named = entries => new Map(entries.map(([value, name]) => [value, `<secret:${name}>`]));
const SESSION = { minLength: S.MIN_SCRUB_SECRET_CHARS };

const TARGET_ID = '71DF370FDEADBEEF71DF370FDEADBEEF';
const SECRET = 'S3cr3t-Value-469';
const LONG_SECRET = 'sk-live-0123456789abcdefghijklmnopqrstuvwxyz-469';

const dirs = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'cdp-469-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

// One text control whose value follows insertText / the native setter, like the #428 fake page.
function fakeFillPage({ value = '', type = 'text', accept = text => text } = {}) {
  const state = { value, calls: [] };
  const live = () => ({ ok: true, cdpFillLiveValue: true, tag: 'INPUT', type, value: state.value, textContent: '' });
  const cdp = {
    send(method, params = {}) {
      state.calls.push({ method, params });
      if (method === 'Runtime.evaluate') {
        const expr = String(params.expression || '');
        if (expr.includes('cdpFillLiveValue')) return Promise.resolve({ result: { value: live() } });
        const before = state.value;
        if (/el\.value = ''/.test(expr)) state.value = '';
        return Promise.resolve({ result: { value: JSON.stringify({ ok: true, fillable: true, tag: 'INPUT', type, before }) } });
      }
      if (method === 'Input.insertText') {
        state.value = accept(state.value + params.text);
        return Promise.resolve({});
      }
      if (method === 'DOM.getDocument') return Promise.resolve({ root: { nodeId: 1 } });
      if (method === 'DOM.querySelector') return Promise.resolve({ nodeId: 42 });
      if (method === 'DOM.resolveNode') return Promise.resolve({ object: { objectId: 'obj-1' } });
      if (method === 'Runtime.callFunctionOn') {
        const fn = String(params.functionDeclaration || '');
        if (fn.includes('cdpFillLiveValue')) return Promise.resolve({ result: { value: live() } });
        if (params.arguments) {
          state.value = accept(params.arguments[0].value);
          return Promise.resolve({ result: { value: { tag: 'INPUT', value: state.value } } });
        }
        return Promise.resolve({ result: { value: { ok: true, fillable: true, tag: 'INPUT', type } } });
      }
      return Promise.resolve({});
    },
    onEvent() { return () => {}; },
  };
  return { cdp, state };
}

describe('#469 secret sources', () => {
  it('parses a dotenv file: comments, export, quotes, CRLF', () => {
    const parsed = S.parseSecretsFile('# login\r\nPW="S3cr3t-Value-469"\r\n\r\nexport TOKEN=\'abc def\'\nPLAIN = raw=value \n');
    expect(Object.fromEntries(parsed)).toEqual({ PW: SECRET, TOKEN: 'abc def', PLAIN: 'raw=value' });
  });

  it('follows the documented value grammar: inline comments, escapes, literal single quotes', () => {
    const parsed = S.parseSecretsFile([
      'A=hunter2 # prod',
      'B="x y" # c',
      "C='x # not a comment' # c",
      'D="line1\\nline2\\t\\"q\\" \\\\ \\z"',
      "E='a\\nb'",
      'F=a#b',
      'G=#only a comment',
      'H=',
    ].join('\n'));
    expect(Object.fromEntries(parsed)).toEqual({
      A: 'hunter2',
      B: 'x y',
      C: 'x # not a comment',
      D: 'line1\nline2\t"q" \\ \\z',
      E: 'a\\nb',
      F: 'a#b',
      G: '',
      H: '',
    });
    expect(() => S.parseSecretsFile(`A="${SECRET}`)).toThrow(/line 1: unterminated quoted value/);
    expect(() => S.parseSecretsFile(`A="x" ${SECRET}`)).toThrow(/line 1: only a # comment may follow the closing quote/);
    try {
      S.parseSecretsFile(`A="${SECRET}`);
    } catch (error) {
      expect(error.message).not.toContain(SECRET);
    }
  });

  it('reports a malformed line by number without echoing the line', () => {
    expect(() => S.parseSecretsFile(`PW=ok\nlower=${SECRET}\n`, { path: '/x/.secrets' }))
      .toThrow(/^\/x\/\.secrets line 2: expected NAME=VALUE/);
    try {
      S.parseSecretsFile(`lower=${SECRET}`);
    } catch (error) {
      expect(error.message).not.toContain(SECRET);
    }
  });

  it('reads CDP_SECRET_<NAME> and CDP_SECRETS_FILE at call time; the environment wins', () => {
    const dir = tempDir();
    const file = join(dir, 'secrets.env');
    writeFileSync(file, 'PW=from-file\nOTHER=other-value\n', { mode: 0o600 });
    const env = { CDP_SECRETS_FILE: file, CDP_SECRET_PW: SECRET, CDP_SECRET_lower: 'ignored', PATH: '/bin' };
    const secrets = S.loadSecrets({ env });
    expect(Object.fromEntries(secrets)).toEqual({ PW: SECRET, OTHER: 'other-value' });
    writeFileSync(file, 'OTHER=changed\n', { mode: 0o600 });
    expect(S.loadSecrets({ env }).get('OTHER')).toBe('changed');
  });

  it('refuses a secrets file that group or other can read on POSIX, and skips the check on Windows', () => {
    const fs = {
      statSync: () => ({ isFile: () => true, mode: 0o100644 }),
      readFileSync: () => `PW=${SECRET}\n`,
    };
    const env = { CDP_SECRETS_FILE: '/home/u/.cdp-secrets' };
    expect(() => S.loadSecrets({ env, platform: 'linux', fs }))
      .toThrow(/^CDP_SECRETS_FILE \S*\.cdp-secrets is readable or writable by group\/other \(mode 644\); run: chmod 600 /);
    expect(() => S.loadSecrets({ env, platform: 'darwin', fs: { ...fs, statSync: () => ({ isFile: () => true, mode: 0o100604 }) } }))
      .toThrow(/mode 604/);
    expect(S.loadSecrets({ env, platform: 'linux', fs: { ...fs, statSync: () => ({ isFile: () => true, mode: 0o100600 }) } }).get('PW')).toBe(SECRET);
    expect(S.loadSecrets({ env, platform: 'win32', fs: { ...fs, statSync: () => ({ isFile: () => true, mode: 0o100666 }) } }).get('PW')).toBe(SECRET);
  });

  it.skipIf(process.platform === 'win32')('refuses a real world-readable file', () => {
    const file = join(tempDir(), 'secrets.env');
    writeFileSync(file, `PW=${SECRET}\n`);
    chmodSync(file, 0o644);
    expect(() => S.loadSecrets({ env: { CDP_SECRETS_FILE: file } })).toThrow(/readable or writable by group\/other/);
    chmodSync(file, 0o600);
    expect(S.loadSecrets({ env: { CDP_SECRETS_FILE: file } }).get('PW')).toBe(SECRET);
  });

  it('finds names only where the daemon parses --secret as a flag', () => {
    const names = (cmd, args) => T.collectSecretNames(cmd, args, { readFile: () => { throw new Error('no file'); }, cwd: '.' });
    expect(names('fill', ['@3', '--secret', 'PW'])).toEqual(['PW']);
    // A quoted fill text is one argv token: it is typed, not parsed.
    expect(names('fill', ['#q', 'see --secret docs'])).toEqual([]);
    expect(names('batch', ['fill @3 --secret USER | fill @5 --secret PW | click @7'])).toEqual(['USER', 'PW']);
    expect(names('batch', ['[{"cmd":"fill","args":["@3","--secret","PW"]},{"cmd":"fill","args":["#q","see --secret docs"]}]'])).toEqual(['PW']);
    expect(names('flow', ['fill @3 --secret PW; wait dom stable'])).toEqual(['PW']);
    expect(names('repeat', ['2', 'fill', '#pw', '--secret', 'PW'])).toEqual(['PW']);
    expect(names('record', ['--action', 'fill', '#pw', '--secret', 'PW'])).toEqual(['PW']);
    expect(names('eval', ["'--secret PW'"])).toEqual([]);
    // broadcast is not supported: it forwards no secrets, and each tab's fill fails cleanly.
    expect(names('broadcast', ['grp', 'fill', '#pw', '--secret', 'PW'])).toEqual([]);
  });

  it('scrubs whole and truncated values, longest first', () => {
    const known = named([[SECRET, 'PW'], [LONG_SECRET, 'TOKEN']]);
    const scrubbed = R.scrubSecretValues({
      a: `typed ${SECRET} twice ${SECRET}`,
      b: [`preview "${LONG_SECRET.slice(0, 40)}..."`, `${LONG_SECRET.slice(0, 20)}…`],
      n: 3,
    }, known, SESSION);
    expect(scrubbed).toEqual({
      a: 'typed <secret:PW> twice <secret:PW>',
      b: ['preview "<secret:TOKEN>"', '<secret:TOKEN>'],
      n: 3,
    });
  });

  it('scrubs JSON-escaped and double-escaped copies of a value with quotes and backslashes', () => {
    const value = 'Zq"9xLm\\Pw7tR';
    const known = named([[value, 'KEY']]);
    const perceiveLine = `[textbox] API key = ${JSON.stringify(value)}  @1`;
    expect(R.scrubSecretText(perceiveLine, known, SESSION)).toBe('[textbox] API key = "<secret:KEY>"  @1');
    const json = JSON.stringify({ text: perceiveLine, nested: JSON.stringify({ value }) }, null, 2);
    const scrubbed = R.scrubSecretText(json, known, SESSION);
    expect(scrubbed).not.toContain('Zq');
    expect(JSON.parse(scrubbed).text).toBe('[textbox] API key = "<secret:KEY>"  @1');
    expect(scrubbed.split('\n').length).toBe(json.split('\n').length);
  });

  it('leaves JSON keys, identifiers, numbers and short values alone', () => {
    const meta = JSON.stringify({ pid: 4444, startedAt: 1790874921171, ok: true, label: 'abc4444', 4444: 'k', schema: 'x.4444.v1' });
    // A JSON document is only scrubbed inside its string values: keys, numbers and
    // keepKeys identifiers stay, so it always parses back to the same shape.
    const scrubbed = JSON.parse(R.scrubSecretText(meta, named([['4444', 'PIN']]), { ...SESSION, keepKeys: new Set(['schema']) }));
    expect(scrubbed).toEqual({ pid: 4444, startedAt: 1790874921171, ok: true, label: 'abc<secret:PIN>', 4444: 'k', schema: 'x.4444.v1' });
    // Below MIN_SCRUB_SECRET_CHARS the session scrub rewrites nothing.
    expect(S.MIN_SCRUB_SECRET_CHARS).toBe(4);
    expect(R.scrubSecretText('pid 4 of "4"', named([['4', 'PIN']]), SESSION)).toBe('pid 4 of "4"');
    expect(R.scrubSecretValues({ a: 'x4', b: '4' }, named([['4', 'PIN']]), SESSION)).toEqual({ a: 'x4', b: '4' });
  });

  it('is one scrubber: plain values read <redacted>, named ones <secret:NAME>, the first entry wins', () => {
    // #485 rules without a minimum: a short value only as a whole string or quoted.
    expect(R.scrubSecretValues({ a: '4', b: 'pid 4 of "4"' }, ['4'])).toEqual({ a: '<redacted>', b: 'pid 4 of "<redacted>"' });
    expect(R.scrubSecretValues('typed hunter2 and S3cr3t-Value-469', [{ value: SECRET, replacement: '<secret:PW>' }, 'hunter2', SECRET]))
      .toBe('typed <redacted> and <secret:PW>');
  });

  it('keeps CDP_SECRET_* out of the spawned daemon environment', () => {
    expect(S.withoutSecretEnv({ PATH: '/bin', CDP_SECRET_PW: SECRET, CDP_SECRETS_FILE: '/f', CDP_PORT: '9' }))
      .toEqual({ PATH: '/bin', CDP_SECRETS_FILE: '/f', CDP_PORT: '9' });
  });

  it('bounds the secrets a daemon request may carry', () => {
    expect(S.validateRequestSecrets(undefined)).toBeNull();
    expect(S.validateRequestSecrets({ PW: SECRET })).toEqual({ PW: SECRET });
    expect(() => S.validateRequestSecrets({ pw: SECRET })).toThrow(/invalid secret name/);
    expect(() => S.validateRequestSecrets({ PW: 1 })).toThrow(/must be a string/);
    expect(() => S.validateRequestSecrets(['PW'])).toThrow(/must be an object/);
    const request = T.validateDaemonProtocolRequest({ id: 1, cmd: 'fill', args: ['#pw', '--secret', 'PW'], secrets: { PW: SECRET } }).request;
    expect(request.secrets).toEqual({ PW: SECRET });
    expect(request.args).toEqual(['#pw', '--secret', 'PW']);
    expect(() => T.validateDaemonProtocolRequest({ id: 1, cmd: 'fill', args: [], other: 1 })).toThrow(/request\.other: is not allowed/);
  });
});

describe('#469 fill --secret NAME on the CLI', () => {
  it('parses --secret NAME in place of text and keeps it through normalization', () => {
    const parsed = T.parseFillArgs(['#pw', '--secret', 'PW', '--format', 'json']);
    expect(parsed).toMatchObject({ selector: '#pw', text: null, secretName: 'PW', format: 'json' });
    expect(T.fillCliArgError(['#pw', '--secret', 'PW'])).toBeNull();
    expect(T.normalizeTargetCommandArgs('fill', ['#pw', '--secret', 'PW', '--format', 'json']))
      .toEqual(['#pw', '--secret', 'PW', '--format', 'json']);
    expect(T.normalizeTargetCommandArgs('fill', ['--react', '#pw', '--secret', 'PW']))
      .toEqual(['--react', '#pw', '--secret', 'PW']);
    expect(() => T.parseFillArgs(['#pw', 'hello', '--secret', 'PW'])).toThrow(/replaces <text>/);
    expect(() => T.parseFillArgs(['#pw', '--secret'])).toThrow(/--secret requires a NAME/);
    expect(() => T.parseFillArgs(['#pw', '--secret', 'pw'])).toThrow(/must match \[A-Z0-9_\]\+/);
  });

  it('resolves only the referenced names, in the CLI process', () => {
    const env = { CDP_SECRET_PW: SECRET, CDP_SECRET_OTHER: 'not-sent' };
    expect(T.cliRequestSecrets('fill', ['#pw', '--secret', 'PW'], { env })).toEqual({ PW: SECRET });
    expect(T.cliRequestSecrets('fill', ['#pw', 'hello'], { env })).toBeNull();
    expect(T.cliRequestSecrets('fill', ['#q', 'see --secret docs'], { env: {} })).toBeNull();
    expect(T.normalizeTargetCommandArgs('fill', ['#q', 'see --secret docs'])).toEqual(['#q', 'see --secret docs']);
    expect(T.cliRequestSecrets('batch', ['fill #pw --secret PW | click #go'], { env })).toEqual({ PW: SECRET });
    // Only commands that can run a fill look for names: an eval that mentions --secret does not.
    expect(T.cliRequestSecrets('eval', ["document.title + ' --secret NOPE'"], { env: {} })).toBeNull();
  });

  it('fails an unknown name as Kind: usage and lists names only', () => {
    const env = { CDP_SECRET_PW: SECRET, CDP_SECRET_USER: 'alice-469' };
    let error;
    try {
      T.cliRequestSecrets('fill', ['#pw', '--secret', 'NOPE'], { env });
    } catch (e) {
      error = e;
    }
    expect(error.message).toBe('fill: unknown secret NOPE. Available: PW, USER');
    const text = T.formatCliError(error, { cmd: 'fill', targetPrefix: '71DF370F' });
    expect(text).toMatch(/^\s*Kind: usage$/m);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('alice-469');
    const json = T.formatCliError(error, { cmd: 'fill', targetPrefix: '71DF370F', format: 'json' });
    expect(JSON.parse(json).recovery).toMatchObject({ kind: 'usage', run: 'cdp help fill' });
    expect(() => T.cliRequestSecrets('fill', ['#pw', '--secret', 'PW'], { env: {} }))
      .toThrow(/unknown secret PW\. No secrets are set: export CDP_SECRET_PW or point CDP_SECRETS_FILE/);
    expect(() => T.cliRequestSecrets('fill', ['#pw', '--secret', 'PW'], { env: { CDP_SECRET_PW: '' } }))
      .toThrow(/secret PW is empty/);
  });

  it('refuses type --secret instead of typing the flag', () => {
    expect(() => T.cliRequestSecrets('type', ['--secret PW'], { env: { CDP_SECRET_PW: SECRET } }))
      .toThrow(T.TYPE_SECRET_UNSUPPORTED);
  });
});

describe('#469 the value reaches the page and nowhere else', () => {
  // Drives the daemon's real fill capability inside the real request scope (AsyncLocalStorage
  // secrets + response scrub). Only the browser and the generic actionFeedback plumbing are
  // stand-ins: actionFeedback mirrors the daemon's (dispatch, fill value state, observe, log).
  async function secretFill({ selector = '#login', secret = SECRET, args = null, observedDiff = null, type = 'text' } = {}) {
    const dir = tempDir();
    const session = T.createSessionState({ targetId: TARGET_ID, sessionId: 'sid-1', logPath: join(dir, 'cdp.log') });
    T.initializeSessionLog(session);
    const { cdp, state } = fakeFillPage({ type });
    const actionFeedback = (action, dispatch, target, feedbackPolicy, _observe, fopts) => {
      const fillValueState = target.fillValueState;
      delete target.fillValueState;
      return T.runActionWithFeedback({
        action,
        // The same object the daemon mutates: applyFillValueState marks it sensitive (#485).
        target: Object.assign(target, { targetId: TARGET_ID }),
        dispatch: async () => {
          const text = await dispatch();
          target.dispatchText = text;
          T.applyFillValueState(target, fillValueState);
          return text;
        },
        feedbackPolicy: 'settle-diff',
        // A plain text field shows its value, JSON-quoted, in the accessibility diff.
        observe: async () => observedDiff ?? `+++ Added (1)\n+ [textbox] "Login" = ${JSON.stringify(secret)}`,
        onActionResult: result => T.appendSessionActionLog(session, result, { ts: Date.now() }),
        format: fopts.format,
      });
    };
    const fill = T.createDaemonFillCapability({
      session,
      actionFeedback,
      fill: (sel, text, opts) => T.fillStr(cdp, 'sid-1', sel, text, new Map(), null, opts),
    });
    // One daemon request, the way handleCommand runs it.
    const request = (cmd, run, secrets = null) => T.runDaemonRequestScope({ cmd, secrets, session }, run);
    const response = await request('fill', async () => {
      try {
        return { ok: true, result: (await fill(args ?? [selector, '--secret', 'PW', '--format', 'json'])).value };
      } catch (error) {
        return { ok: false, error: error.message };
      }
    }, { PW: secret });
    return { session, state, response, request };
  }

  it('types the value through Input.insertText while stdout, receipt, log, records, and report show <secret:PW>', async () => {
    const { session, state, response } = await secretFill();
    expect(state.value).toBe(SECRET);
    expect(state.calls.some(call => call.method === 'Input.insertText' && call.params.text === SECRET)).toBe(true);

    expect(response.result).not.toContain(SECRET);
    const receipt = JSON.parse(response.result);
    expect(receipt.schema).toBe('chrome-cdp-ex.fill.v1');
    expect(receipt.value).toBe('<secret:PW>');
    expect(JSON.stringify(receipt)).not.toContain(SECRET);

    const log = readFileSync(session.logPath, 'utf8');
    expect(log).not.toContain(SECRET);
    expect(log).toContain('<secret:PW>');

    const records = T.buildRecordActionsModel(session);
    expect(JSON.stringify(records)).not.toContain(SECRET);
    expect(records.actions[0]).toMatchObject({ command: ['fill', '#login', '--secret', 'PW'], replayable: true });
    expect(T.formatRecordActions(session, { format: 'json' })).not.toContain(SECRET);
    expect(T.formatSessionReport(session, { format: 'json' })).not.toContain(SECRET);
    expect(T.formatSessionReport(session, { format: 'text' })).not.toContain(SECRET);

    const spec = T.formatExportPlaywright(session, {});
    expect(spec).toContain("await page.locator(\"#login\").fill(process.env.CDP_SECRET_PW ?? '');");
    expect(spec).not.toContain(SECRET);
  });

  it.each([
    ['a password input', { selector: '#pw', type: 'password' }],
    ['a secret-named field (#485)', { selector: '#client_secret', type: 'text' }],
  ])('a named secret wins over sensitive-field redaction in %s', async (_label, field) => {
    const { response, session, state } = await secretFill(field);
    expect(state.value).toBe(SECRET);
    const receipt = JSON.parse(response.result);
    expect(receipt.value).toBe('<secret:PW>');
    expect(response.result).not.toContain(SECRET);
    const records = T.buildRecordActionsModel(session);
    expect(records.actions[0]).toMatchObject({ command: ['fill', field.selector, '--secret', 'PW'], replayable: true });
    expect(JSON.stringify(records)).not.toContain(SECRET);
    expect(T.formatExportPlaywright(session, {}))
      .toContain(`await page.locator(${JSON.stringify(field.selector)}).fill(process.env.CDP_SECRET_PW ?? '');`);
    const log = readFileSync(session.logPath, 'utf8');
    expect(log).not.toContain(SECRET);
    expect(log).toContain('<secret:PW>');
  });

  it('keeps the name, not <redacted>, when the selector itself looks sensitive', async () => {
    const { session, response } = await secretFill({ selector: '#password' });
    expect(response.result).not.toContain(SECRET);
    const records = T.buildRecordActionsModel(session);
    expect(records.actions[0].command).toEqual(['fill', '#password', '--secret', 'PW']);
    expect(records.actions[0].replayable).toBe(true);
  });

  it('scrubs a long value that a preview truncated', async () => {
    const { session, response } = await secretFill({ secret: LONG_SECRET, observedDiff: `+ [textbox] value="${LONG_SECRET.slice(0, 40)}..."` });
    expect(response.result).not.toContain(LONG_SECRET.slice(0, 20));
    expect(readFileSync(session.logPath, 'utf8')).not.toContain(LONG_SECRET.slice(0, 20));
  });

  it('keeps scrubbing later responses of the same session', async () => {
    const { request } = await secretFill();
    const later = await request('eval', async () => ({ ok: false, error: `eval: input.value is "${SECRET}"` }));
    expect(later.error).toBe('eval: input.value is "<secret:PW>"');
  });

  it('scrubs a value with a quote and a backslash from later perceive text and JSON', async () => {
    const value = 'Zq"9xLm\\Pw7tR';
    const { state, response, request, session } = await secretFill({ secret: value });
    expect(state.value).toBe(value);
    expect(response.ok).toBe(true);
    expect(JSON.parse(response.result).value).toBe('<secret:PW>');
    expect(response.result).not.toContain('Zq');
    const perceiveLine = `[textbox] API key = ${JSON.stringify(value)}  @1`;
    const text = await request('perceive', async () => ({ ok: true, result: perceiveLine }));
    expect(text.result).toBe('[textbox] API key = "<secret:PW>"  @1');
    const json = await request('perceive', async () => ({ ok: true, result: JSON.stringify({ tree: perceiveLine }, null, 2) }));
    expect(json.result).not.toContain('Zq');
    expect(JSON.parse(json.result).tree).toBe('[textbox] API key = "<secret:PW>"  @1');
    expect(readFileSync(session.logPath, 'utf8')).not.toContain('Zq');
  });

  it('a short value still types and masks its receipt, but never rewrites meta or later output', async () => {
    const { state, response, request, session } = await secretFill({ secret: '4' });
    expect(state.value).toBe('4');
    expect(JSON.parse(response.result).value).toBe('<secret:PW>');
    expect(T.buildRecordActionsModel(session).actions[0].command).toEqual(['fill', '#login', '--secret', 'PW']);
    const metaJson = JSON.stringify({ schema: 'chrome-cdp-ex.daemon-metadata.v1', pid: 4444, startedAt: 1790874921171 });
    const meta = await request('meta', async () => ({ ok: true, result: metaJson }));
    expect(meta.result).toBe(metaJson);
    const later = await request('eval', async () => ({ ok: true, result: '2 + 2 = 4' }));
    expect(later.result).toBe('2 + 2 = 4');
  });

  it('never rewrites the daemon protocol replies the CLI parses', async () => {
    const { request } = await secretFill();
    const meta = JSON.stringify({ note: SECRET });
    expect((await request('meta', async () => ({ ok: true, result: meta }))).result).toBe(meta);
    expect((await request('list_raw', async () => ({ ok: true, result: meta }))).result).toBe(meta);
  });

  it('reports an unset name from the daemon as a clean usage error', async () => {
    const { response, state } = await secretFill({ args: ['#login', '--secret', 'OTHER'] });
    expect(response.ok).toBe(false);
    expect(response.error).toMatch(/fill: secret OTHER was not provided with this request/);
    expect(state.calls.some(call => call.method === 'Input.insertText')).toBe(false);
  });

  it('types a fill text that merely mentions --secret', async () => {
    const { state, response } = await secretFill({ args: ['#login', 'see --secret docs'] });
    expect(response.ok).toBe(true);
    expect(state.value).toBe('see --secret docs');
  });

  it('a rejected secret value names the secret, not the value', async () => {
    // The page keeps only the first 4 characters of whatever is typed.
    const { cdp } = fakeFillPage({ accept: text => text.slice(0, 4) });
    let error;
    try {
      await T.fillStr(cdp, 'sid', '#login', SECRET, new Map(), null, { secretName: 'PW' });
    } catch (e) {
      error = e;
    }
    expect(error.message).toContain('did not accept "<secret:PW>"');
    expect(error.message).not.toContain(SECRET);
    expect(JSON.stringify(error.fillValue)).not.toContain(SECRET);
  });

  it('fails cleanly in the daemon when a step names a secret the request did not carry', () => {
    const session = T.createSessionState({ targetId: TARGET_ID, sessionId: 'sid-1', logPath: null });
    expect(() => T.resolveRequestSecret('PW', { store: { secrets: { USER: 'x' }, session } }))
      .toThrow(/fill: secret PW was not provided with this request/);
    expect(() => T.resolveRequestSecret('PW', { store: null })).toThrow(/not provided/);
  });
});

describe('#469 replay re-resolves the name at replay time', () => {
  const artifact = {
    schema: 'chrome-cdp-ex.record-actions.v1',
    actions: [{ index: 1, action: 'fill', command: ['fill', '#login', '--secret', 'PW'], replayable: true, needsInput: [] }],
  };

  it('runs the recorded secret step instead of skipping it as missing text', () => {
    const step = T.replayStepFromAction(artifact.actions[0]);
    expect(step).toMatchObject({ cmd: 'fill', args: ['#login', '--secret', 'PW'] });
    expect(step.skip).toBeUndefined();
  });

  it('resolves the names in an inline or file artifact from the current environment', () => {
    const env = { CDP_SECRET_PW: SECRET };
    expect(T.cliRequestSecrets('replay', ['--json', JSON.stringify(artifact)], { env })).toEqual({ PW: SECRET });
    const dir = tempDir();
    writeFileSync(join(dir, 'flow.json'), JSON.stringify(artifact));
    expect(T.cliRequestSecrets('replay', ['--file', 'flow.json'], { env, cwd: dir })).toEqual({ PW: SECRET });
    expect(() => T.cliRequestSecrets('replay', ['--file', 'flow.json'], { env: {}, cwd: dir })).toThrow(/replay: unknown secret PW/);
  });
});

describe('#469 MCP fill accepts secret instead of text', () => {
  it('maps secret to --secret NAME and refuses text plus secret', () => {
    expect(buildMcpToolCommand('fill', { target: '71DF370F', selector: '#pw', secret: 'PW', confirm: true }))
      .toEqual(['fill', '71DF370F', '#pw', '--secret', 'PW']);
    expect(() => buildMcpToolCommand('fill', { target: '71DF370F', selector: '#pw', secret: 'PW', text: 'x', confirm: true }))
      .toThrow(/text or secret, not both/);
    expect(() => buildMcpToolCommand('fill', { target: '71DF370F', selector: '#pw', confirm: true }))
      .toThrow(/text is required/);
    const tool = MCP_TOOL_DEFINITIONS.find(definition => definition.name === 'fill');
    expect(tool.inputSchema.required).toEqual(['target', 'selector', 'confirm']);
    expect(tool.inputSchema.properties.secret.type).toBe('string');
  });
});
