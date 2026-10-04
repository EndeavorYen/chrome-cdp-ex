import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const { __test__: T } = await import('../skills/chrome-cdp-ex/scripts/cdp.mjs');
const R = await import('../scripts/usage-report.mjs');

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cdp-532-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const lines = file => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []);

describe('#532 CDP_USAGE_LOG counter', () => {
  it('T1: off by default; on, it records the canonical command and via, never the arguments', () => {
    const file = join(dir, 'usage.jsonl');
    T.recordCommandUsage('ls', { env: {}, file });
    expect(existsSync(file)).toBe(false);
    T.recordCommandUsage('ls', { env: { CDP_USAGE_LOG: '1' }, file, now: () => 1000 });
    T.recordCommandUsage('eval', { env: { CDP_USAGE_LOG: '1' }, file, via: 'mcp', now: () => 2000 });
    expect(lines(file)).toEqual([
      { ts: new Date(1000).toISOString(), command: 'list', via: 'cli' },
      { ts: new Date(2000).toISOString(), command: 'eval', via: 'mcp' },
    ]);
  });

  it('T1: internal and unknown commands are not recorded', () => {
    const file = join(dir, 'usage.jsonl');
    for (const name of ['_daemon', 'definitely-not-a-command', '']) T.recordCommandUsage(name, { env: { CDP_USAGE_LOG: '1' }, file });
    expect(existsSync(file)).toBe(false);
  });

  it('T2: the file is mode 0600 (POSIX) and rotates to usage.jsonl.1 above the cap', () => {
    const file = join(dir, 'usage.jsonl');
    writeFileSync(file, 'x'.repeat(T.USAGE_LOG_MAX_BYTES + 1));
    T.recordCommandUsage('list', { env: { CDP_USAGE_LOG: 'yes' }, file });
    expect(existsSync(`${file}.1`)).toBe(true);
    expect(lines(file)).toHaveLength(1);
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe('#532 usage report parsers', () => {
  it('finds every cdp invocation in a shell command, folding aliases and skipping prose', () => {
    expect(R.commandsFromShellText('node C:/x/skills/chrome-cdp-ex/scripts/cdp.mjs ls && node cdp.mjs eval ABCD "1+1" | tail -1')).toEqual(['list', 'eval']);
    expect(R.commandsFromShellText('CDP_PORT=9333 bin/chrome-cdp nav 1667E1A4 http://x')).toEqual(['nav']);
    expect(R.commandsFromShellText('cdp --verbose shot ABCD')).toEqual(['shot']);
    expect(R.commandsFromShellText('cat skills/cdp/notes.txt; echo cdpfoo list')).toEqual([]);
    expect(R.commandsFromShellText('node cdp.mjs notacommand x')).toEqual([]);
  });

  it('T3: Claude lines: Bash inputs and this server\'s MCP tools, dev split by cwd', () => {
    const line = (cwd, content) => JSON.stringify({ type: 'assistant', cwd, timestamp: '2026-10-01T00:00:00Z', message: { content } });
    expect(R.usageFromClaudeLine(line('C:\\work\\app', [{ type: 'tool_use', name: 'Bash', input: { command: 'node cdp.mjs eval X 1; node cdp.mjs tabs' } }])))
      .toEqual([{ command: 'eval', dev: false, via: 'cli' }, { command: 'list', dev: false, via: 'cli' }]);
    expect(R.usageFromClaudeLine(line('C:\\orca\\chrome-cdp-ex\\wt', [{ type: 'tool_use', name: 'Bash', input: { command: 'node cdp.mjs doctor' } }])))
      .toEqual([{ command: 'doctor', dev: true, via: 'cli' }]);
    expect(R.usageFromClaudeLine(line('/w', [
      { type: 'tool_use', name: 'mcp__chrome-cdp__perceive', input: {} },
      { type: 'tool_use', name: 'mcp__chrome-cdp__run_command', input: { command: 'jsclick ABCD #go' } },
      { type: 'tool_use', name: 'mcp__playwright__browser_click', input: {} },
    ]))).toEqual([{ command: 'perceive', dev: false, via: 'mcp' }, { command: 'jsclick', dev: false, via: 'mcp' }]);
    // tool results (which echo `Next: cdp …`) are never counted
    expect(R.usageFromClaudeLine(JSON.stringify({ type: 'user', cwd: '/w', message: { content: [{ type: 'tool_result', content: 'Next: cdp list' }] } }))).toEqual([]);
  });

  it('T3: Codex lines: shell_command, exec input and MCP end events, cwd from session_meta', () => {
    const state = {};
    R.usageFromCodexLine(JSON.stringify({ type: 'session_meta', payload: { cwd: '/home/me/game' } }), state);
    expect(R.usageFromCodexLine(JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'shell_command', arguments: JSON.stringify({ command: 'node cdp.mjs perceive ABCD' }) } }), state))
      .toEqual([{ command: 'perceive', dev: false, via: 'cli' }]);
    expect(R.usageFromCodexLine(JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input: 'node cdp.mjs viewport ABCD 390x844' } }), state))
      .toEqual([{ command: 'viewport', dev: false, via: 'cli' }]);
    expect(R.usageFromCodexLine(JSON.stringify({ type: 'event_msg', payload: { type: 'mcp_tool_call_end', invocation: { server: 'cdp', tool: 'screenshot', arguments: {} } } }), state))
      .toEqual([{ command: 'shot', dev: false, via: 'mcp' }]);
  });

  it('T3: --since drops older entries', () => {
    const since = Date.parse('2026-10-01');
    const old = JSON.stringify({ type: 'assistant', cwd: '/w', timestamp: '2026-09-01T00:00:00Z', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'node cdp.mjs list' } }] } });
    expect(R.usageFromClaudeLine(old, { since })).toEqual([]);
    expect(R.usageFromCounterLine(JSON.stringify({ ts: '2026-09-30T00:00:00Z', command: 'list' }), { since })).toEqual([]);
    expect(R.usageFromCounterLine(JSON.stringify({ ts: '2026-10-02T00:00:00Z', command: 'tabs', via: 'mcp' }), { since })).toEqual([{ command: 'list', dev: false, via: 'mcp' }]);
  });

  it('T3/T4: the report builds from local dirs, counts only, lists unused commands and prints no transcript text', async () => {
    const claudeDir = join(dir, 'claude');
    const codexDir = join(dir, 'codex');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(claudeDir, 'proj'), { recursive: true });
    mkdirSync(join(codexDir, '2026'), { recursive: true });
    writeFileSync(join(claudeDir, 'proj', 'a.jsonl'), `${JSON.stringify({ type: 'assistant', cwd: '/w', timestamp: '2026-10-01T00:00:00Z', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'node cdp.mjs eval X "SECRET_TEXT"' } }] } })}\n`);
    writeFileSync(join(codexDir, '2026', 'b.jsonl'), `${JSON.stringify({ type: 'response_item', payload: { type: 'function_call', arguments: JSON.stringify({ command: 'node cdp.mjs eval Y 1' }) } })}\n`);
    const usageFile = join(dir, 'usage.jsonl');
    writeFileSync(usageFile, `${JSON.stringify({ ts: '2026-10-02T00:00:00Z', command: 'list', via: 'cli' })}\n`);
    const model = await R.buildUsageReport({ claudeDir, codexDir, usageFile, since: null });
    const evalRow = model.commands.find(row => row.command === 'eval');
    expect(evalRow).toMatchObject({ claude: 1, codex: 1, counter: 0, total: 2 });
    expect(model.commands.find(row => row.command === 'list')).toMatchObject({ counter: 1, total: 1 });
    expect(model.unused).toContain('tab-group');
    expect(model.files).toEqual({ counter: 1, claude: 1, codex: 1 });
    const text = R.formatUsageReport(model);
    expect(text).toMatch(/^eval\s+2\s+0\s+1\s+1/m);
    expect(text).not.toContain('SECRET_TEXT');
    expect(JSON.stringify(model)).not.toContain('SECRET_TEXT');
  });

  it('argument parsing rejects unknown flags and bad dates', () => {
    expect(() => R.parseUsageReportArgs(['--bogus'])).toThrow(/unknown argument/);
    expect(() => R.parseUsageReportArgs(['--since', 'not-a-date'])).toThrow(/--since/);
    expect(R.parseUsageReportArgs(['--format', 'json', '--since', '2026-10-01'])).toMatchObject({ format: 'json', since: Date.parse('2026-10-01') });
  });
});

describe('#532 docs', () => {
  it('T5: CDP_USAGE_LOG is documented and the npm script exists', () => {
    for (const path of ['../skills/chrome-cdp-ex/references/commands.md', '../docs/reference.md']) {
      expect(readFileSync(new URL(path, import.meta.url), 'utf8'), path).toMatch(/CDP_USAGE_LOG/);
    }
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(pkg.scripts['usage:report']).toBe('node scripts/usage-report.mjs');
  });
});

describe('#532 pre-submit review fixes', () => {
  it('the invocation regex stays linear on a long run of option-like tokens', () => {
    const text = `cdp ${'--ab '.repeat(40)}"`;
    const started = Date.now();
    expect(R.commandsFromShellText(text)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(200);
  });

  it('Codex exec_command ({cmd}) is counted', () => {
    expect(R.usageFromCodexLine(JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'c1', arguments: JSON.stringify({ cmd: 'node cdp.mjs doctor' }) } }), {}))
      .toEqual([{ command: 'doctor', dev: false, via: 'cli', id: 'c1#0' }]);
  });

  it('a call copied into a forked or resumed session file is counted once', async () => {
    const { mkdirSync } = await import('node:fs');
    const codexDir = join(dir, 'codex');
    mkdirSync(codexDir, { recursive: true });
    const call = `${JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'shell_command', call_id: 'same-call', arguments: JSON.stringify({ command: 'node cdp.mjs list' }) } })}\n`;
    writeFileSync(join(codexDir, 'a.jsonl'), call);
    writeFileSync(join(codexDir, 'b.jsonl'), call);
    const claudeDir = join(dir, 'claude');
    mkdirSync(claudeDir, { recursive: true });
    const use = `${JSON.stringify({ type: 'assistant', cwd: '/w', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'node cdp.mjs eval X 1' } }] } })}\n`;
    writeFileSync(join(claudeDir, 'a.jsonl'), use + use);
    const model = await R.buildUsageReport({ claudeDir, codexDir, usageFile: join(dir, 'none.jsonl'), since: null });
    expect(model.commands.find(row => row.command === 'list').codex).toBe(1);
    expect(model.commands.find(row => row.command === 'eval').claude).toBe(1);
  });
});

describe('#532 regex follow-ups', () => {
  it('a long run of --chrome-cdp tokens stays fast, and `cdp.mjs -- list` counts', () => {
    const started = Date.now();
    expect(R.commandsFromShellText(`cdp ${'--chrome-cdp '.repeat(5000)}`)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(300);
    expect(R.commandsFromShellText('node cdp.mjs -- list')).toEqual(['list']);
  });
});
