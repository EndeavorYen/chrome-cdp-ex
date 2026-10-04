#!/usr/bin/env node
// #532: count how agents use the cdp.mjs command catalog, from local sources only:
//   1. the opt-in CDP_USAGE_LOG counter (<runtime dir>/usage.jsonl, plus usage.jsonl.1),
//   2. Claude Code transcripts (~/.claude/projects/**/*.jsonl): Bash tool inputs and MCP tool calls,
//   3. Codex sessions (~/.codex/sessions/**/*.jsonl): shell / exec tool inputs and MCP tool calls.
// Prints counts only — never transcript text — and sends nothing anywhere.
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { COMMAND_SURFACE } from '../skills/chrome-cdp-ex/scripts/lib/command-surface.mjs';
import { resolveRuntimeDir } from '../skills/chrome-cdp-ex/scripts/lib/runtime-dir.mjs';

export const SOURCES = Object.freeze(['counter', 'claude', 'codex', 'dev']);

// A sessions working directory inside this repository (or one of its worktrees) is "dev" use.
export function isDevCwd(cwd) {
  return /chrome-cdp-ex/i.test(String(cwd || ''));
}

function canonical(spelling) {
  const command = COMMAND_SURFACE.resolve(String(spelling || '').trim());
  return command && !command.name.startsWith('_') ? command.name : null;
}

// Every `cdp.mjs <cmd>`, `bin/chrome-cdp <cmd>` or bare `cdp <cmd>` invocation in one shell command
// string. Value-less options before the command (`--verbose`) are skipped; a bare `cdp` inside a path or a
// word does not count, and words that are not commands are dropped.
// The option group starts with a word character so each token matches one way only: `[\w-]+` after
// `--?` let `--ab` split two ways and backtracked exponentially on a long run of options (pre-submit).
const SHELL_INVOCATION = /(?:cdp\.mjs|\bchrome-cdp(?:-ex)?|(?<![\w./\\-])cdp)["']?\s+(?:--?\w[\w-]*\s+)*([a-z][\w-]*)/gi;
export function commandsFromShellText(text) {
  const found = [];
  for (const match of String(text || '').matchAll(SHELL_INVOCATION)) {
    const name = canonical(match[1]);
    if (name) found.push(name);
  }
  return found;
}

const MCP_TOOL_OWNERS = new Map(COMMAND_SURFACE.commands
  .filter(command => command.mcp?.toolName)
  .map(command => [command.mcp.toolName, command.name]));

// An MCP call to this server's tools: `mcp__<server>__<tool>` (Claude) or {server, tool} (Codex).
// The server name is the host's choice, so it only has to mention cdp; the tool must be ours.
export function commandFromMcpCall(server, tool, args = {}) {
  if (!/cdp/i.test(String(server || ''))) return null;
  if (tool === 'run_command') {
    const command = Array.isArray(args?.command) ? args.command[0] : String(args?.command || '').trim().split(/\s+/)[0];
    return canonical(command);
  }
  return MCP_TOOL_OWNERS.get(String(tool || '')) || null;
}

function parseJson(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function inWindow(timestamp, since) {
  if (!since) return true;
  const at = Date.parse(timestamp || '');
  return Number.isFinite(at) ? at >= since : true;
}

// One Claude Code transcript line → [{ command, dev, via }].
export function usageFromClaudeLine(line, { since = null } = {}) {
  if (!line.includes('"tool_use"')) return [];
  const entry = parseJson(line);
  if (!entry || entry.type !== 'assistant' || !inWindow(entry.timestamp, since)) return [];
  const dev = isDevCwd(entry.cwd);
  const found = [];
  for (const item of entry.message?.content || []) {
    if (item?.type !== 'tool_use') continue;
    const name = String(item.name || '');
    if (name === 'Bash' || name === 'PowerShell') {
      commandsFromShellText(item.input?.command)
        .forEach((command, n) => found.push({ command, dev, via: 'cli', id: callKey(item.id, n) }));
    } else if (name.startsWith('mcp__')) {
      const [, server, tool] = name.split('__');
      const command = commandFromMcpCall(server, tool, item.input);
      if (command) found.push({ command, dev, via: 'mcp', id: callKey(item.id, 0) });
    }
  }
  return found;
}

// One Codex session line → [{ command, dev, via }]. `state.cwd` carries the session's working directory.
export function usageFromCodexLine(line, state = {}, { since = null } = {}) {
  const entry = parseJson(line);
  if (!entry) return [];
  const payload = entry.payload || {};
  if (entry.type === 'session_meta' || entry.type === 'turn_context') {
    if (payload.cwd) state.cwd = payload.cwd;
    return [];
  }
  if (!inWindow(entry.timestamp, since)) return [];
  const dev = isDevCwd(state.cwd);
  if (payload.type === 'function_call') {
    const args = parseJson(payload.arguments || '') || {};
    // shell_command carries {command}; exec_command carries {cmd}.
    const raw = args.command ?? args.cmd;
    const text = Array.isArray(raw) ? raw.join(' ') : raw;
    return commandsFromShellText(text).map((command, n) => ({ command, dev, via: 'cli', id: callKey(payload.call_id, n) }));
  }
  if (payload.type === 'custom_tool_call' || payload.type === 'local_shell_call') {
    const text = typeof payload.input === 'string' ? payload.input : (payload.action?.command || []).join(' ');
    return commandsFromShellText(text).map((command, n) => ({ command, dev, via: 'cli', id: callKey(payload.call_id, n) }));
  }
  // One record per MCP call: the `_end` event carries the invocation (`_begin` would double count).
  if (payload.type === 'mcp_tool_call_end') {
    const invocation = payload.invocation || {};
    const command = commandFromMcpCall(invocation.server, invocation.tool, invocation.arguments);
    return command ? [{ command, dev, via: 'mcp', id: callKey(payload.call_id, 0) }] : [];
  }
  return [];
}

// A tool call's id plus the invocation's position in it. Codex forks and resumes copy earlier calls into
// new session files, so the same call can be read twice; the report counts each key once.
function callKey(callId, position) {
  return callId ? `${callId}#${position}` : undefined;
}

// One CDP_USAGE_LOG line → [{ command, dev:false, via }].
export function usageFromCounterLine(line, { since = null } = {}) {
  const entry = parseJson(line);
  if (!entry?.command || !inWindow(entry.ts, since)) return [];
  const command = canonical(entry.command);
  return command ? [{ command, dev: false, via: entry.via === 'mcp' ? 'mcp' : 'cli' }] : [];
}

export function emptyUsageReport() {
  const rows = new Map(COMMAND_SURFACE.commands
    .filter(command => !command.name.startsWith('_'))
    .map(command => [command.name, { command: command.name, counter: 0, claude: 0, codex: 0, dev: 0, mcp: 0 }]));
  return { schema: 'chrome-cdp-ex.usage-report.v1', rows, files: { counter: 0, claude: 0, codex: 0 } };
}

export function addUsage(report, source, uses, seen = null) {
  for (const use of uses) {
    const row = report.rows.get(use.command);
    if (!row) continue;
    if (seen && use.id) {
      if (seen.has(use.id)) continue;
      seen.add(use.id);
    }
    if (use.dev && source !== 'counter') row.dev += 1;
    else row[source] += 1;
    if (use.via === 'mcp') row.mcp += 1;
  }
  return report;
}

export function usageReportModel(report) {
  const rows = [...report.rows.values()]
    .map(row => ({ ...row, total: row.counter + row.claude + row.codex }))
    .sort((a, b) => b.total - a.total || b.dev - a.dev || a.command.localeCompare(b.command));
  return {
    schema: report.schema,
    files: report.files,
    commands: rows,
    unused: rows.filter(row => row.total === 0 && row.dev === 0).map(row => row.command),
    devOnly: rows.filter(row => row.total === 0 && row.dev > 0).map(row => row.command),
  };
}

export function formatUsageReport(model) {
  const lines = [
    `Usage report: ${model.files.counter} counter file(s), ${model.files.claude} Claude transcript(s), ${model.files.codex} Codex session(s)`,
    'command               total  counter  claude  codex   mcp   dev',
  ];
  for (const row of model.commands.filter(r => r.total > 0 || r.dev > 0)) {
    lines.push(`${row.command.padEnd(20)}  ${String(row.total).padStart(5)}  ${String(row.counter).padStart(7)}  ${String(row.claude).padStart(6)}  ${String(row.codex).padStart(5)}  ${String(row.mcp).padStart(4)}  ${String(row.dev).padStart(4)}`);
  }
  lines.push(`Unused outside dev (${model.unused.length}): ${model.unused.join(', ') || '(none)'}`);
  if (model.devOnly.length) lines.push(`Used only in this repo's own sessions (${model.devOnly.length}): ${model.devOnly.join(', ')}`);
  lines.push('dev = sessions whose working directory is this repository; it is not part of total. mcp counts calls made through the MCP server.');
  return lines.join('\n');
}

function* jsonlFiles(dir) {
  if (!dir || !existsSync(dir)) return;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) yield path;
    }
  }
}

async function eachLine(path, onLine) {
  const lines = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) onLine(line);
}

export function parseUsageReportArgs(argv = []) {
  const opts = {
    format: 'text',
    since: null,
    claudeDir: join(homedir(), '.claude', 'projects'),
    codexDir: join(homedir(), '.codex', 'sessions'),
    usageFile: join(resolveRuntimeDir(), 'usage.jsonl'),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next == null) throw new Error(`usage-report: ${arg} needs a value`);
      return next;
    };
    if (arg === '--format') opts.format = value();
    else if (arg === '--since') {
      const at = Date.parse(value());
      if (!Number.isFinite(at)) throw new Error('usage-report: --since needs a date (YYYY-MM-DD)');
      opts.since = at;
    } else if (arg === '--claude-dir') opts.claudeDir = resolve(value());
    else if (arg === '--codex-dir') opts.codexDir = resolve(value());
    else if (arg === '--usage-file') opts.usageFile = resolve(value());
    else throw new Error(`usage-report: unknown argument ${arg}`);
  }
  if (!['text', 'json'].includes(opts.format)) throw new Error('usage-report: --format must be text or json');
  return opts;
}

export async function buildUsageReport(opts) {
  const report = emptyUsageReport();
  for (const path of [opts.usageFile, `${opts.usageFile}.1`]) {
    if (!path || !existsSync(path) || !statSync(path).isFile()) continue;
    report.files.counter += 1;
    await eachLine(path, line => addUsage(report, 'counter', usageFromCounterLine(line, opts)));
  }
  const seenClaude = new Set();
  for (const path of jsonlFiles(opts.claudeDir)) {
    report.files.claude += 1;
    await eachLine(path, line => addUsage(report, 'claude', usageFromClaudeLine(line, opts), seenClaude));
  }
  const seenCodex = new Set();
  for (const path of jsonlFiles(opts.codexDir)) {
    report.files.codex += 1;
    const state = {};
    await eachLine(path, line => addUsage(report, 'codex', usageFromCodexLine(line, state, opts), seenCodex));
  }
  return usageReportModel(report);
}

async function runCli() {
  try {
    const opts = parseUsageReportArgs(process.argv.slice(2));
    const model = await buildUsageReport(opts);
    console.log(opts.format === 'json' ? JSON.stringify(model, null, 2) : formatUsageReport(model));
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runCli();
