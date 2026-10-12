// #616: a millisecond wait is the standalone wait command and must run inside flow.
// #617: step splits keep quoted text and eval/eval64/call script bodies intact.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');

const SPLIT_RULE = 'A semicolon separates flow steps only outside quotes';
const QUOTE_RULE = 'A quote opens only at the start of a word';
const QUOTED_BODY = "const s = 'a  b';\n\ts";
const SINGLE_QUOTED_BODY = 'const s = "a  b";\n\ts';
const UNQUOTED_BODY = 'const  s = 1;\n\treturn s';

function expressionOf(input) {
  const [step] = T.parseFlowSteps(input);
  return T.parseEvalArgs(step.args).expression;
}

describe('flow millisecond wait (#616)', () => {
  it('runs wait 2000 as the standalone wait command instead of an unknown settle alias', async () => {
    expect(T.parseFlowSteps('wait 2000')).toEqual([
      { kind: 'command', cmd: 'wait', args: ['2000'] },
    ]);
    expect(T.parseFlowSteps('click @1; wait 2000; wait dom stable')).toEqual([
      { kind: 'command', cmd: 'click', args: ['@1'] },
      { kind: 'command', cmd: 'wait', args: ['2000'] },
      { kind: 'wait', what: 'dom stable' },
    ]);

    const seen = [];
    const out = await T.flowStr({
      run: async (step) => {
        seen.push(step);
        return { ok: true, result: step.cmd === 'wait' ? 'Waited 2s' : 'ok' };
      },
      settle: async (what) => {
        throw new Error(`Unknown wait: "${what}". Use "dom stable" or "network idle".`);
      },
    }, 'summary; wait 2000', { format: 'json', targetId: 'ABC123' });
    const parsed = JSON.parse(out);

    expect(seen).toEqual([
      { kind: 'command', cmd: 'summary', args: [] },
      { kind: 'command', cmd: 'wait', args: ['2000'] },
    ]);
    expect(parsed.halted).toBe(false);
    expect(parsed.steps[1]).toMatchObject({
      kind: 'command',
      cmd: 'wait',
      args: ['2000'],
      ok: true,
      resultPreview: 'Waited 2s',
    });
    expect(out).not.toContain('Unknown wait');
  });

  it('passes a one-millisecond flow wait through waitStr', async () => {
    const out = await T.flowStr({
      run: async (step) => ({ ok: true, result: await T.waitStr(step.args[0]) }),
      settle: async () => {
        throw new Error('settle should not run');
      },
    }, 'wait 1');
    expect(out).toContain('Waited 1ms');
    expect(out).not.toContain('Unknown wait');
    expect(out).not.toContain('Flow halted');
  });

  it('reports an invalid millisecond wait with the standalone wait error', async () => {
    const out = await T.flowStr({
      run: async (step) => ({ ok: true, result: await T.waitStr(step.args[0]) }),
      settle: async () => {
        throw new Error('settle should not run');
      },
    }, 'wait 0');
    expect(out).toContain('wait duration must be at least 1ms');
    expect(out).not.toContain('Unknown wait');
  });
});

describe('flow script and quote splitting (#617)', () => {
  it('keeps an unquoted eval script with semicolons as one expression', () => {
    expect(expressionOf('eval const x = 1; x + 2')).toBe('const x = 1; x + 2');
    expect(T.parseFlowSteps('eval const x = 1; x + 2; summary')).toEqual([
      { kind: 'command', cmd: 'eval', args: ['const x = 1; x + 2'] },
      { kind: 'command', cmd: 'summary', args: [] },
    ]);
  });

  it('keeps a quoted eval script together and continues at the next step', () => {
    expect(expressionOf('eval "const x = 1; x"')).toBe('const x = 1; x');
    expect(expressionOf("eval 'const x = 1; x'")).toBe('const x = 1; x');
    expect(expressionOf('eval `const x = 1; x`')).toBe('const x = 1; x');
    expect(T.parseFlowSteps('click @1; eval "const x = 1; x"; wait 2000; summary').map(step => step.cmd || step.what))
      .toEqual(['click', 'eval', 'wait', 'summary']);
    expect(expressionOf('click @1; eval "const x = 1; x"; summary'.replace(/^click @1; /, ''))).toBe('const x = 1; x');
  });

  it('keeps a command word inside a quoted or escaped script body', () => {
    expect(expressionOf('eval "const text = 1; text"')).toBe('const text = 1; text');
    expect(expressionOf('eval "const key = 1; key"')).toBe('const key = 1; key');
    expect(expressionOf('eval const text = 1\\; text')).toBe('const text = 1; text');
    expect(T.parseFlowSteps('eval const text = 1; text').map(step => step.cmd)).toEqual(['eval', 'text']);
    expect(T.parseFlowSteps('eval const key = 1; key').map(step => step.cmd)).toEqual(['eval', 'key']);
  });

  it('preserves semicolons inside for(;;) and quoted strings', () => {
    expect(expressionOf('eval for(;;){ break }')).toBe('for(;;){ break }');
    expect(expressionOf('eval "const s = \\"a;b\\"; s"')).toBe('const s = "a;b"; s');
    expect(expressionOf('eval "a\\nb"')).toBe('a\\nb');
  });

  it('keeps eval flags and call or eval64 bodies intact', () => {
    expect(T.parseEvalArgs(T.parseFlowSteps('eval --raw "const x = 1; x"; summary')[0].args)).toMatchObject({
      raw: true,
      expression: 'const x = 1; x',
    });
    expect(T.parseEvalArgs(T.parseFlowSteps('eval --fire-and-forget const x = 1; x')[0].args)).toMatchObject({
      fireAndForget: true,
      expression: 'const x = 1; x',
    });
    expect(T.parseFlowSteps('call async () => { const x = 1; return x; }; summary')).toEqual([
      { kind: 'command', cmd: 'call', args: ['async () => { const x = 1; return x; }'] },
      { kind: 'command', cmd: 'summary', args: [] },
    ]);
    expect(T.parseFlowSteps('eval64 "YQ=="; summary')).toEqual([
      { kind: 'command', cmd: 'eval64', args: ['YQ=='] },
      { kind: 'command', cmd: 'summary', args: [] },
    ]);
  });

  it('does not split a quoted semicolon in a non-script step', () => {
    expect(T.parseFlowSteps('fill @1 "a;b"; click @2')).toEqual([
      { kind: 'command', cmd: 'fill', args: ['@1', 'a;b'] },
      { kind: 'command', cmd: 'click', args: ['@2'] },
    ]);
    expect(T.parseFlowSteps('assert text "a;b"; summary')).toEqual([
      { kind: 'assert', condition: { kind: 'text', value: 'a;b' } },
      { kind: 'command', cmd: 'summary', args: [] },
    ]);
    expect(T.parseFlowSteps('assert text `a;b`')).toEqual([
      { kind: 'assert', condition: { kind: 'text', value: 'a;b' } },
    ]);
  });

  it.each([
    { cmd: 'eval', kind: 'double-quoted', body: QUOTED_BODY, source: `"${QUOTED_BODY}"` },
    { cmd: 'eval', kind: 'single-quoted', body: SINGLE_QUOTED_BODY, source: `'${SINGLE_QUOTED_BODY}'` },
    { cmd: 'eval', kind: 'backtick-quoted', body: QUOTED_BODY, source: `\`${QUOTED_BODY}\`` },
    { cmd: 'eval', kind: 'unquoted', body: UNQUOTED_BODY, source: UNQUOTED_BODY },
    { cmd: 'eval64', kind: 'double-quoted', body: QUOTED_BODY, source: `"${QUOTED_BODY}"` },
    { cmd: 'eval64', kind: 'single-quoted', body: SINGLE_QUOTED_BODY, source: `'${SINGLE_QUOTED_BODY}'` },
    { cmd: 'eval64', kind: 'backtick-quoted', body: QUOTED_BODY, source: `\`${QUOTED_BODY}\`` },
    { cmd: 'eval64', kind: 'unquoted', body: UNQUOTED_BODY, source: UNQUOTED_BODY },
    { cmd: 'call', kind: 'double-quoted', body: QUOTED_BODY, source: `"${QUOTED_BODY}"` },
    { cmd: 'call', kind: 'single-quoted', body: SINGLE_QUOTED_BODY, source: `'${SINGLE_QUOTED_BODY}'` },
    { cmd: 'call', kind: 'backtick-quoted', body: QUOTED_BODY, source: `\`${QUOTED_BODY}\`` },
    { cmd: 'call', kind: 'unquoted', body: UNQUOTED_BODY, source: UNQUOTED_BODY },
  ])('$cmd $kind body keeps two spaces, a newline, and a tab', ({ cmd, body, source }) => {
    const [step] = T.parseFlowSteps(`${cmd} ${source}`);
    expect(step).toMatchObject({ kind: 'command', cmd, args: [body] });
    expect(step.args[0]).toBe(body);
    if (cmd === 'eval') expect(T.parseEvalArgs(step.args).expression).toBe(body);
  });

  it('keeps eval flags and passes the flagged script body byte-for-byte', () => {
    const step = T.parseFlowSteps(`eval --raw --fire-and-forget "${QUOTED_BODY}"`)[0];
    expect(step.args).toEqual(['--raw', '--fire-and-forget', QUOTED_BODY]);
    expect(T.parseEvalArgs(step.args)).toMatchObject({
      raw: true,
      fireAndForget: true,
      expression: QUOTED_BODY,
    });
    expect(T.parseFlowSteps('eval --b64 "YQ=="; summary')[0].args).toEqual(['--b64', 'YQ==']);
  });

  it("parses fill #name O'Brien; click @1 as two steps with value O'Brien", () => {
    expect(T.parseFlowSteps("fill #name O'Brien; click @1")).toEqual([
      { kind: 'command', cmd: 'fill', args: ['#name', "O'Brien"] },
      { kind: 'command', cmd: 'click', args: ['@1'] },
    ]);
  });

  it("parses type don't; summary as two steps", () => {
    // Non-script command: an apostrophe inside the word does not open a quote.
    expect(T.parseFlowSteps("type don't; summary")).toEqual([
      { kind: 'command', cmd: 'type', args: ["don't"] },
      { kind: 'command', cmd: 'summary', args: [] },
    ]);
  });

  it("parses eval don't; summary as two steps, and a quoted script as one", () => {
    // Script command, same quote rule: `don't` is one word, so `summary` is the next step.
    // A quote at the start of the body still holds the semicolon, so that form is one eval.
    expect(T.parseFlowSteps("eval don't; summary")).toEqual([
      { kind: 'command', cmd: 'eval', args: ["don't"] },
      { kind: 'command', cmd: 'summary', args: [] },
    ]);
    expect(T.parseFlowSteps(`eval "don't; summary"`)).toEqual([
      { kind: 'command', cmd: 'eval', args: ["don't; summary"] },
    ]);
  });

  it('keeps an empty quoted script body as one argument', () => {
    expect(T.parseFlowSteps('eval ""')).toEqual([
      { kind: 'command', cmd: 'eval', args: [''] },
    ]);
    expect(T.parseFlowSteps("eval ''")).toEqual([
      { kind: 'command', cmd: 'eval', args: [''] },
    ]);
    expect(T.parseFlowSteps('eval ``')).toEqual([
      { kind: 'command', cmd: 'eval', args: [''] },
    ]);
    expect(T.parseFlowSteps('eval --raw ""')).toEqual([
      { kind: 'command', cmd: 'eval', args: ['--raw', ''] },
    ]);
    expect(T.parseFlowSteps('eval --faf ""')).toEqual([
      { kind: 'command', cmd: 'eval', args: ['--faf', ''] },
    ]);
    expect(T.parseFlowSteps('eval --b64 ""')).toEqual([
      { kind: 'command', cmd: 'eval', args: ['--b64', ''] },
    ]);
    expect(T.parseFlowSteps('eval64 ""')).toEqual([
      { kind: 'command', cmd: 'eval64', args: [''] },
    ]);
    expect(T.parseFlowSteps('call ""')).toEqual([
      { kind: 'command', cmd: 'call', args: [''] },
    ]);
    expect(T.parseFlowSteps('eval ""; zznotacommand')).toEqual([
      { kind: 'command', cmd: 'eval', args: [''] },
      { kind: 'command', cmd: 'zznotacommand', args: [] },
    ]);
  });

  it('does not append later text to a script body that is already one quoted string', () => {
    expect(T.parseFlowSteps('eval "const x = 1"; x')).toEqual([
      { kind: 'command', cmd: 'eval', args: ['const x = 1'] },
      { kind: 'command', cmd: 'x', args: [] },
    ]);
    expect(T.parseFlowSteps('eval "const x = 1; x"; zznotacommand')).toEqual([
      { kind: 'command', cmd: 'eval', args: ['const x = 1; x'] },
      { kind: 'command', cmd: 'zznotacommand', args: [] },
    ]);
    expect(T.parseFlowSteps('eval --raw "const x = 1"; x + 2')).toEqual([
      { kind: 'command', cmd: 'eval', args: ['--raw', 'const x = 1'] },
      { kind: 'command', cmd: 'x', args: ['+', '2'] },
    ]);
    expect(T.parseFlowSteps('eval64 "YQ=="; zznotacommand')).toEqual([
      { kind: 'command', cmd: 'eval64', args: ['YQ=='] },
      { kind: 'command', cmd: 'zznotacommand', args: [] },
    ]);
    expect(T.parseFlowSteps('call "async () => 1"; summary')).toEqual([
      { kind: 'command', cmd: 'call', args: ['async () => 1'] },
      { kind: 'command', cmd: 'summary', args: [] },
    ]);
  });

  it('does not let a doubled backslash escape the following semicolon', () => {
    expect(T.parseFlowSteps('eval const x = 1\\\\; summary')).toEqual([
      { kind: 'command', cmd: 'eval', args: ['const x = 1\\\\'] },
      { kind: 'command', cmd: 'summary', args: [] },
    ]);
    expect(T.parseFlowSteps('eval const x = 1\\\\\\; summary')).toEqual([
      { kind: 'command', cmd: 'eval', args: ['const x = 1\\\\; summary'] },
    ]);
    expect(T.parseFlowSteps('fill #p C:\\a\\\\; click @1')).toEqual([
      { kind: 'command', cmd: 'fill', args: ['#p', 'C:\\a\\\\'] },
      { kind: 'command', cmd: 'click', args: ['@1'] },
    ]);
    expect(T.parseFlowSteps('eval "a\\\\;b"; summary')).toEqual([
      { kind: 'command', cmd: 'eval', args: ['a\\;b'] },
      { kind: 'command', cmd: 'summary', args: [] },
    ]);
  });

  it('rejects an unclosed quote before any step runs', () => {
    expect(() => T.parseFlowSteps('eval "const x = 1; x')).toThrow(/unclosed quote/);
    const recovery = T.buildCliErrorRecovery('flow: unclosed quote in steps', { cmd: 'flow' });
    expect(recovery.kind).toBe('usage');
    expect(recovery.run).toBe('cdp help flow');
  });

  it('runs one eval step whose script contains a semicolon', async () => {
    const seen = [];
    const out = await T.flowStr({
      run: async (step) => {
        seen.push(step);
        return { ok: true, result: T.parseEvalArgs(step.args).expression };
      },
      settle: async () => {
        throw new Error('settle should not run');
      },
    }, 'eval const x = 1; x + 2');
    expect(seen).toHaveLength(1);
    expect(out).toContain('const x = 1; x + 2');
    expect(out).not.toContain('Flow halted');
  });
});

describe('flow step rule documentation (#616 #617)', () => {
  it('documents the split rule and millisecond wait in help and docs', () => {
    const help = T.helpTopicStr('flow');
    const commands = readFileSync(new URL('../skills/chrome-cdp-ex/references/commands.md', import.meta.url), 'utf8');
    const reference = readFileSync(new URL('../docs/reference.md', import.meta.url), 'utf8');
    const skill = readFileSync(new URL('../skills/chrome-cdp-ex/SKILL.md', import.meta.url), 'utf8');
    for (const text of [help, T.CATALOG_USAGE, commands, reference, skill]) {
      expect(text).toContain(SPLIT_RULE);
      expect(text).toContain(QUOTE_RULE);
      expect(text).toContain('wait 2000');
    }
    expect(help).toContain('eval, eval64, and call');
    expect(help).toContain('command name, alias, or assert');
    expect(help).toContain('\\;');
  });
});
