#!/usr/bin/env node
// #532: count how agents use the cdp.mjs command catalog, from local sources only.
// #544: with no --since, the CLI compares two trailing windows (default 7d and 30d) and prints one hint line. It does not assign a fate or delete a command.
//   1. the opt-in CDP_USAGE_LOG counter (<runtime dir>/usage.jsonl, plus usage.jsonl.1),
//   2. Claude Code transcripts (~/.claude/projects/**/*.jsonl): Bash tool inputs and MCP tool calls,
//   3. Codex sessions (~/.codex/sessions/**/*.jsonl): shell / exec tool inputs and MCP tool calls.
// Prints counts only — never transcript text — and sends nothing anywhere.
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { COMMAND_SURFACE, SURVIVOR_COMMANDS } from '../skills/chrome-cdp-ex/scripts/lib/command-surface.mjs';
import { resolveRuntimeDir } from '../skills/chrome-cdp-ex/scripts/lib/runtime-dir.mjs';

const ON_CARD = new Set(SURVIVOR_COMMANDS);
const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_USAGE_WINDOWS = Object.freeze(['7d', '30d']);
// One line. Principles are recorded here; this report does not assign a fate or delete a command.
export const USAGE_COMPARISON_HINT = 'Hint: zero use in both windows may deprecate; duplicate spellings become aliases once a fold list exists; core card commands stay on the card. This report does not remove commands.';

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
// `chrome-cdp` may follow a path (`bin/chrome-cdp`) but not a word or `-`, so a `--chrome-cdp` option token
// does not start a new scan; a bare `--` before the command (`cdp.mjs -- list`) is allowed.
const SHELL_INVOCATION = /(?:cdp\.mjs|(?<![\w-])chrome-cdp(?:-ex)?|(?<![\w./\\-])cdp)["']?\s+(?:--?\w[\w-]*\s+)*(?:--\s+)?([a-z][\w-]*)/gi;
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
    windowSpecs: null,
    claudeDir: join(homedir(), '.claude', 'projects'),
    codexDir: join(homedir(), '.codex', 'sessions'),
    usageFile: join(resolveRuntimeDir(), 'usage.jsonl'),
  };
  let sawSince = false;
  let sawWindows = false;
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
      sawSince = true;
    } else if (arg === '--windows') {
      opts.windowSpecs = parseWindowSpecs(value());
      sawWindows = true;
    } else if (arg === '--claude-dir') opts.claudeDir = resolve(value());
    else if (arg === '--codex-dir') opts.codexDir = resolve(value());
    else if (arg === '--usage-file') opts.usageFile = resolve(value());
    else throw new Error(`usage-report: unknown argument ${arg}`);
  }
  if (!['text', 'json'].includes(opts.format)) throw new Error('usage-report: --format must be text or json');
  if (sawSince && sawWindows) throw new Error('usage-report: --since and --windows cannot be combined');
  if (sawSince) opts.windowSpecs = null;
  else if (!sawWindows) opts.windowSpecs = [...DEFAULT_USAGE_WINDOWS];
  return opts;
}

async function forEachUsageLine(opts, onLine) {
  const files = { counter: 0, claude: 0, codex: 0 };
  for (const path of [opts.usageFile, `${opts.usageFile}.1`]) {
    if (!path || !existsSync(path) || !statSync(path).isFile()) continue;
    files.counter += 1;
    await eachLine(path, line => onLine('counter', line, null));
  }
  for (const path of jsonlFiles(opts.claudeDir)) {
    files.claude += 1;
    await eachLine(path, line => onLine('claude', line, null));
  }
  for (const path of jsonlFiles(opts.codexDir)) {
    files.codex += 1;
    const state = {};
    await eachLine(path, line => onLine('codex', line, state));
  }
  return files;
}

export async function buildUsageReport(opts) {
  const report = emptyUsageReport();
  const seenClaude = new Set();
  const seenCodex = new Set();
  report.files = await forEachUsageLine(opts, (source, line, state) => {
    if (source === 'counter') addUsage(report, 'counter', usageFromCounterLine(line, opts));
    else if (source === 'claude') addUsage(report, 'claude', usageFromClaudeLine(line, opts), seenClaude);
    else addUsage(report, 'codex', usageFromCodexLine(line, state, opts), seenCodex);
  });
  return usageReportModel(report);
}

export function parseWindowSpecs(text) {
  const specs = String(text ?? '').split(',').map(part => part.trim()).filter(Boolean);
  if (specs.length !== 2) throw new Error('usage-report: --windows needs two durations, for example 7d,30d');
  for (const spec of specs) {
    if (!/^([1-9]\d*)d$/.test(spec)) throw new Error(`usage-report: window ${spec} must look like 7d`);
  }
  if (specs[0] === specs[1]) throw new Error('usage-report: --windows needs two different durations');
  return specs;
}

export function windowBounds(specs, now) {
  return parseWindowSpecs(specs.join(',')).map(id => {
    const days = Number(id.slice(0, -1));
    return { id, days, since: now - days * DAY_MS };
  });
}

function windowSlice(row) {
  return {
    counter: row.counter,
    claude: row.claude,
    codex: row.codex,
    dev: row.dev,
    mcp: row.mcp,
    total: row.total,
  };
}

export function comparisonFromReports(windows, models, files) {
  const longId = windows[1].id;
  const shortId = windows[0].id;
  const commands = models[0].commands.map(row => ({
    command: row.command,
    onCard: ON_CARD.has(row.command),
    windows: {},
  }));
  const index = new Map(commands.map(row => [row.command, row]));
  windows.forEach((window, i) => {
    for (const row of models[i].commands) index.get(row.command).windows[window.id] = windowSlice(row);
  });
  commands.sort((a, b) => b.windows[longId].total - a.windows[longId].total
    || b.windows[shortId].total - a.windows[shortId].total
    || b.windows[longId].dev - a.windows[longId].dev
    || a.command.localeCompare(b.command));
  const zeroInBoth = commands
    .filter(row => windows.every(window => row.windows[window.id].total === 0 && row.windows[window.id].dev === 0))
    .map(row => row.command);
  return {
    schema: 'chrome-cdp-ex.usage-report.v2',
    files,
    windows,
    commands,
    zeroInBoth,
    hint: USAGE_COMPARISON_HINT,
  };
}

export async function buildUsageComparison(opts) {
  const specs = opts.windowSpecs ?? DEFAULT_USAGE_WINDOWS;
  const now = opts.now ?? Date.now();
  const windows = windowBounds(specs, now);
  const reports = windows.map(() => emptyUsageReport());
  const seen = windows.map(() => ({ claude: new Set(), codex: new Set() }));
  const files = await forEachUsageLine(opts, (source, line, state) => {
    windows.forEach((window, index) => {
      const bounds = { since: window.since };
      if (source === 'counter') addUsage(reports[index], 'counter', usageFromCounterLine(line, bounds));
      else if (source === 'claude') addUsage(reports[index], 'claude', usageFromClaudeLine(line, bounds), seen[index].claude);
      else addUsage(reports[index], 'codex', usageFromCodexLine(line, state, bounds), seen[index].codex);
    });
  });
  return comparisonFromReports(windows, reports.map(usageReportModel), files);
}

export function formatUsageComparison(model) {
  const [left, right] = model.windows;
  const lines = [
    `Usage report: ${left.id} vs ${right.id} — ${model.files.counter} counter file(s), ${model.files.claude} Claude transcript(s), ${model.files.codex} Codex session(s)`,
    `command               ${`${left.id}-total`.padStart(8)}  ${`${right.id}-total`.padStart(9)}  ${`${left.id}-dev`.padStart(6)}  ${`${right.id}-dev`.padStart(7)}  card`,
  ];
  for (const row of model.commands) {
    const a = row.windows[left.id];
    const b = row.windows[right.id];
    if (a.total === 0 && a.dev === 0 && b.total === 0 && b.dev === 0) continue;
    lines.push(`${row.command.padEnd(20)}  ${String(a.total).padStart(8)}  ${String(b.total).padStart(9)}  ${String(a.dev).padStart(6)}  ${String(b.dev).padStart(7)}  ${row.onCard ? 'yes' : 'no'}`);
  }
  lines.push(`Zero in both windows (${model.zeroInBoth.length}): ${model.zeroInBoth.join(', ') || '(none)'}`);
  lines.push(model.hint || USAGE_COMPARISON_HINT);
  return lines.join('\n');
}

async function runCli() {
  try {
    const opts = parseUsageReportArgs(process.argv.slice(2));
    const model = opts.since != null ? await buildUsageReport(opts) : await buildUsageComparison(opts);
    const text = opts.since != null ? formatUsageReport(model) : formatUsageComparison(model);
    console.log(opts.format === 'json' ? JSON.stringify(model, null, 2) : text);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runCli();
