import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
const { isSensitiveFieldText } = await import('../skills/chrome-cdp-ex/scripts/lib/redaction.mjs');

const TARGET_ID = '485F11EEDEADBEEF485F11EEDEADBEEF';
const SECRET = 'sk-live-485-sentinel';

// Fake page for fillStr: one control, plus the attributes a real page would report for it.
function fakeFillPage({ value = '', type = 'text', field = {}, accept = text => text } = {}) {
  const state = { value };
  const live = () => ({
    ok: true,
    cdpFillLiveValue: true,
    tag: 'INPUT',
    type,
    value: state.value,
    textContent: '',
    field: { id: '', name: '', autocomplete: '', ariaLabel: '', placeholder: '', labels: [], ...field },
  });
  const cdp = {
    send(method, params = {}) {
      if (method === 'Runtime.evaluate') {
        const expr = String(params.expression || '');
        if (expr.includes('cdpFillLiveValue')) return Promise.resolve({ result: { value: live() } });
        const before = state.value;
        if (/el\.value = ''/.test(expr)) state.value = '';
        return Promise.resolve({ result: { value: JSON.stringify({ ok: true, fillable: true, tag: 'INPUT', type, before }) } });
      }
      if (method === 'Input.insertText') {
        state.value = accept(String(state.value) + params.text);
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

// Runs one fill the way the daemon does: fillStr records the value state, and the dispatch
// wrapper turns it into receipt state on the action target (success) or marks the target (failure).
async function runFill(selector, text, { format = 'text', page = {}, session = null, observe = null } = {}) {
  const { cdp } = fakeFillPage(page);
  const fillValueState = {};
  const target = {
    targetId: TARGET_ID,
    input: selector,
    resolvedBy: 'selector-or-ref',
    label: selector,
    commandArgs: [selector, text],
  };
  let result = null;
  const out = await T.runActionWithFeedback({
    action: 'fill',
    target,
    dispatch: async () => {
      try {
        const dispatchText = await T.fillStr(cdp, 'sid', selector, text, new Map(), null, { valueState: fillValueState });
        target.dispatchText = dispatchText;
        T.applyFillValueState(target, fillValueState);
        return dispatchText;
      } catch (error) {
        T.markSensitiveFillTarget(target, fillValueState);
        throw error;
      }
    },
    feedbackPolicy: 'settle-diff',
    observe: observe || (async () => '(no changes detected in AX tree)'),
    onActionResult: (actionResult) => { result = actionResult; },
    format,
  }).catch(error => error);
  if (session) T.appendSessionActionLog(session, result);
  return { out, result };
}

function withSession(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'cdp-485-'));
  const logPath = join(dir, 'session.jsonl');
  const session = T.createSessionState({ targetId: TARGET_ID, sessionId: 'sid-485', logPath });
  return Promise.resolve(fn(session, logPath)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

async function surfaces(selector, text, page = {}) {
  return withSession(async (session, logPath) => {
    const { out: textReceipt } = await runFill(selector, text, { page, session });
    const { out: jsonReceipt } = await runFill(selector, text, { page, format: 'json' });
    return {
      textReceipt,
      fill: JSON.parse(jsonReceipt),
      log: readFileSync(logPath, 'utf8'),
      record: T.formatRecordActions(session),
      recordJson: JSON.parse(T.formatRecordActions(session, { format: 'json' })),
    };
  });
}

describe('#485 key classifier for typed-value sensitivity', () => {
  it('splits selectors and field names on _, - and camelCase', () => {
    for (const text of ['#api_token', '[name=client_secret]', '#accessToken', '#apiKey', 'input[name="refresh_token"]',
      '#password', '#user-pin', '#otp', 'API key', 'Client secret']) {
      expect(isSensitiveFieldText(text), text).toBe(true);
    }
  });

  it('treats secret autocomplete values and one-time codes as sensitive', () => {
    for (const text of ['one-time-code', 'cc-number', 'cc-csc', 'cc-exp', 'cc-exp-month', 'current-password',
      'new-password', 'input[autocomplete="one-time-code"]', '#cc-number', '#oneTimeCode', 'Verification code',
      'section-pay billing cc-csc', 'session_id', '#sessionId', 'card_number', 'Card number', 'Credit card',
      'Access code', '#refresh_token', '#access-token']) {
      expect(isSensitiveFieldText(text), text).toBe(true);
    }
  });

  it('keeps ordinary fields readable, including bare words that only mark URL keys secret', () => {
    for (const text of ['#search', '#pinned-note', '[name=q]', 'input[type=text]', '#author', '#max_tokens',
      'cc-name', 'email', 'username', 'Search', '#sidebar-filter', '', 'Session name', '#session-name',
      'Access level', 'Refresh interval (s)', '#cookie-banner-text', '#card-title', '#sid']) {
      expect(isSensitiveFieldText(text), text).toBe(false);
    }
  });
});

describe('#485 fill redacts values typed into secret-named fields', () => {
  for (const selector of ['#api_token', '[name=client_secret]', '#accessToken', 'input[autocomplete="one-time-code"]']) {
    it(`redacts ${selector} in the text receipt, fill.v1, the session log and record-actions`, async () => {
      const s = await surfaces(selector, SECRET);
      expect(s.textReceipt).toContain('<redacted>');
      expect(s.textReceipt).not.toContain(SECRET);
      expect(s.fill.schema).toBe('chrome-cdp-ex.fill.v1');
      expect(s.fill.value).toBe('<redacted>');
      expect(JSON.stringify(s.fill)).not.toContain(SECRET);
      expect(s.log).not.toContain(SECRET);
      expect(s.log).toContain('<redacted>');
      expect(s.record).not.toContain(SECRET);
      expect(s.recordJson.actions[0].command).toEqual(['fill', selector, '<redacted>']);
    });
  }

  it('redacts a field whose element attributes mark it secret even when the selector does not', async () => {
    const cases = [
      { name: 'api_token' },
      { id: 'clientSecret' },
      { autocomplete: 'one-time-code' },
      { autocomplete: 'cc-number' },
      { ariaLabel: 'API key' },
      { labels: ['Access token'] },
    ];
    for (const field of cases) {
      const s = await surfaces('#f1', SECRET, { field });
      const label = JSON.stringify(field);
      expect(s.textReceipt, label).not.toContain(SECRET);
      expect(s.fill.value, label).toBe('<redacted>');
      expect(s.log, label).not.toContain(SECRET);
      expect(s.record, label).not.toContain(SECRET);
      expect(s.recordJson.actions[0].command, label).toEqual(['fill', '#f1', '<redacted>']);
    }
  });

  it('redacts a password-type input reached through a plain selector', async () => {
    const s = await surfaces('#f2', SECRET, { type: 'password' });
    expect(s.textReceipt).not.toContain(SECRET);
    expect(s.fill.value).toBe('<redacted>');
    expect(s.log).not.toContain(SECRET);
    expect(s.record).not.toContain(SECRET);
  });

  it('redacts the value when a secret-named field rejects it', async () => {
    await withSession(async (session, logPath) => {
      const { cdp } = fakeFillPage({ field: { name: 'api_token' }, accept: () => 'x' });
      const fillValueState = {};
      const target = { targetId: TARGET_ID, input: '#f3', resolvedBy: 'selector-or-ref', label: '#f3', commandArgs: ['#f3', SECRET] };
      let result = null;
      const error = await T.runActionWithFeedback({
        action: 'fill',
        target,
        dispatch: async () => {
          try {
            return await T.fillStr(cdp, 'sid', '#f3', SECRET, new Map(), null, { valueState: fillValueState });
          } catch (err) {
            T.markSensitiveFillTarget(target, fillValueState);
            throw err;
          }
        },
        feedbackPolicy: 'settle-diff',
        observe: async () => '(no changes detected in AX tree)',
        onActionResult: (actionResult) => { result = actionResult; },
      }).catch(err => err);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).not.toContain(SECRET);
      T.appendSessionActionLog(session, result);
      expect(readFileSync(logPath, 'utf8')).not.toContain(SECRET);
      expect(T.formatRecordActions(session)).not.toContain(SECRET);
    });
  });

  for (const [selector, text] of [['#search', 'q'], ['#pinned-note', 'x'], ['[name=q]', 'chrome cdp']]) {
    it(`keeps ${selector} readable`, async () => {
      const s = await surfaces(selector, text);
      expect(s.textReceipt).toContain(`with "${text}"`);
      expect(s.fill.value).toBe(text);
      expect(s.log).toContain(text);
      expect(s.recordJson.actions[0].command).toEqual(['fill', selector, text]);
    });
  }
});

// An AX diff the way perceive prints it: a non-password textbox exposes its value.
function axDiff(field, before, after) {
  return [
    '+++ Added (1):',
    `+   [textbox] ${field} = ${JSON.stringify(after)}`,
    '--- Removed (1):',
    `-   [textbox] ${field} = ${JSON.stringify(before)}`,
  ].join('\n');
}

describe('#485 every receipt mode scrubs a sensitive field value', () => {
  const OLD = 'sk-old-485-previous-secret';
  const page = { value: OLD, field: { name: 'api_token' } };
  const observe = async () => axDiff('tok', OLD, SECRET);
  const modes = [
    ['text', 'text'],
    ['--full text', { format: 'text', full: true }],
    ['--compact text', { format: 'text', compact: true }],
    ['json', 'json'],
    ['--compact json', { format: 'json', compact: true }],
    ['--full json', { format: 'json', full: true }],
    ['--qa json', { format: 'json', qa: true }],
  ];
  for (const [label, format] of modes) {
    it(`${label}: neither the typed nor the previous value appears in the AX diff, samples or delta`, async () => {
      await withSession(async (session, logPath) => {
        const { out } = await runFill('#f1', SECRET, { page, format, observe, session });
        expect(out).not.toContain('sk-live-485');
        expect(out).not.toContain('sk-old-485');
        const log = readFileSync(logPath, 'utf8');
        expect(log).not.toContain('sk-live-485');
        expect(log).not.toContain('sk-old-485');
      });
    });
  }

  it('the AX diff really carried both values before scrubbing (the test is not vacuous)', async () => {
    const { result } = await runFill('#f1', SECRET, { page, format: { format: 'json', full: true }, observe });
    expect(result.effects.domDiff).toContain(SECRET);
    expect(result.effects.domDiff).toContain(OLD);
  });

  it('a truncated preview of the secret is scrubbed too', async () => {
    const long = `sk-live-485-${'x'.repeat(300)}`;
    for (const format of [{ format: 'json', full: true }, { format: 'json', compact: true }, 'text']) {
      const { out } = await runFill('#f1', long, {
        page: { field: { name: 'api_token' } },
        format,
        observe: async () => axDiff('tok', '', long),
      });
      expect(out).not.toContain('sk-live-485');
    }
  });

  it('a short PIN is scrubbed where it is quoted without garbling numbers', async () => {
    const { out } = await runFill('#f1', '7', {
      page: { field: { autocomplete: 'one-time-code' } },
      format: { format: 'json', full: true },
      observe: async () => axDiff('code', '', '7'),
    });
    expect(out).not.toContain('= \\"7\\"');
    const parsed = JSON.parse(out);
    expect(parsed.target.commandArgs).toEqual(['#f1', '<redacted>']);
    expect(parsed.effects.domDiff).toContain('[textbox] code = "<redacted>"');
  });

  it('a failed fill --format json redacts effects.failure.target and every other field', async () => {
    const { out } = await runFill('#f3', SECRET, {
      page: { value: OLD, field: { name: 'api_token' }, accept: () => 'x' },
      format: 'json',
    });
    const parsed = JSON.parse(out);
    expect(parsed.dispatch.ok).toBe(false);
    expect(parsed.effects.failure.kind).toBe('fill-value-mismatch');
    expect(parsed.effects.failure.target.commandArgs).toEqual(['#f3', '<redacted>']);
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain(OLD);
  });

  it('the failure Next reads .value.length for a sensitive field, .value otherwise', async () => {
    const secret = await runFill('#f3', SECRET, { page: { field: { name: 'api_token' }, accept: () => 'x' } });
    expect(secret.out).toBeInstanceOf(Error);
    expect(secret.out.message).toContain(`"document.querySelector('#f3')?.value.length"`);
    expect(secret.out.message).not.toContain(SECRET);
    const plain = await runFill('#f4', 'hello', { page: { accept: () => 'x' } });
    expect(plain.out.message).toContain(`"document.querySelector('#f4')?.value"`);
  });

  it('a normal field keeps its value in the AX diff', async () => {
    const { out } = await runFill('#search', 'chrome cdp', {
      format: { format: 'text', full: true },
      observe: async () => axDiff('Search', '', 'chrome cdp'),
    });
    expect(out).toContain('[textbox] Search = "chrome cdp"');
  });
});

describe('#485 JSON receipts are scrubbed before serialization', () => {
  const jsonModes = [
    ['json', 'json'],
    ['--compact json', { format: 'json', compact: true }],
    ['--full json', { format: 'json', full: true }],
    ['--qa json', { format: 'json', qa: true }],
  ];
  // Secrets that collide with JSON keywords, numbers, the action name and the schema text.
  for (const secret of ['null', 'true', 'fill', '1234', 'chrome-cdp-ex']) {
    for (const [label, format] of jsonModes) {
      it(`secret ${JSON.stringify(secret)} in ${label} stays valid JSON with intact structure`, async () => {
        const { out } = await runFill('#f1', secret, {
          page: { field: { autocomplete: 'one-time-code' } },
          format,
          observe: async () => axDiff('code', '', secret),
        });
        const parsed = JSON.parse(out);
        const action = parsed.schema === 'chrome-cdp-ex.qa-summary.v1' || parsed.summary ? parsed.action : parsed;
        if (action.schema === 'chrome-cdp-ex.fill.v1') {
          expect(action.value).toBe('<redacted>');
          expect(action.navigation).toBeNull();
          expect(typeof action.changed).toBe('boolean');
        } else {
          expect(action.schema).toBe('chrome-cdp-ex.action.v1');
          expect(action.action).toBe('fill');
          expect(action.dispatch.ok).toBe(true);
          if (action.settle && 'durationMs' in action.settle) expect(typeof action.settle.durationMs).toBe('number');
          if (action.target?.commandArgs) expect(action.target.commandArgs).toEqual(['#f1', '<redacted>']);
        }
        // No string leaf still holds the secret as a quoted value, and no key was rewritten. The
        // code-generated identifiers (`action: "fill"`, `method: "fill"`) are left alone on purpose.
        const identifiers = new Set(['schema', 'action', 'actionName', 'method', 'kind']);
        const leaves = [];
        const keys = [];
        const walk = (value) => {
          if (typeof value === 'string') leaves.push(value);
          else if (Array.isArray(value)) value.forEach(walk);
          else if (value && typeof value === 'object') {
            for (const [key, entry] of Object.entries(value)) {
              keys.push(key);
              if (!(identifiers.has(key) && typeof entry === 'string')) walk(entry);
            }
          }
        };
        walk(parsed);
        expect(keys.some(key => key.includes('<redacted>'))).toBe(false);
        expect(leaves.filter(leaf => leaf === secret || leaf.includes(`"${secret}"`))).toEqual([]);
      });
    }
  }

  it('a failed fill --format json with a keyword-like secret parses and keeps its numbers', async () => {
    const { out } = await runFill('#f3', 'null', {
      page: { field: { name: 'api_token' }, accept: () => 'x' },
      format: 'json',
    });
    const parsed = JSON.parse(out);
    expect(parsed.schema).toBe('chrome-cdp-ex.action.v1');
    expect(parsed.dispatch.ok).toBe(false);
    expect(typeof parsed.settle.durationMs).toBe('number');
    expect(parsed.effects.failure.kind).toBe('fill-value-mismatch');
    expect(parsed.effects.failure.target.commandArgs).toEqual(['#f3', '<redacted>']);
    expect(parsed.effects.navigation).toBeNull();
  });
});

describe('#485 type prose is not a field name', () => {
  it('only classifies commandArgs[0] for fill', () => {
    const typeTarget = { input: 'current focus', label: 'current focus', commandArgs: ['my session access card notes'] };
    expect(T.isSensitiveActionTarget('type', typeTarget)).toBe(false);
    expect(T.isSensitiveActionTarget('type', { ...typeTarget, commandArgs: ['my password'] })).toBe(false);
    expect(T.isSensitiveActionTarget('fill', { input: '#api_token', label: '#api_token', commandArgs: ['#api_token', 'x'] })).toBe(true);
    expect(T.isSensitiveActionTarget('fill', { input: '#note', label: '#note', commandArgs: ['#note', 'x'] })).toBe(false);
  });
});
